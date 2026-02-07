import { NextResponse } from "next/server";

import { createAdminClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

type MethodResult = {
  method_steps: Array<{
    text: string;
    important: boolean;
  }>;
  assumptions: string[];
  insights: string[];
};

type ResponsesPayload = {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      json?: unknown;
    }>;
  }>;
  status?: string;
  incomplete_details?: { reason?: string };
};

function cleanText(raw: string) {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[^\x09\x0A\x20-\x7E]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function runMethodSynthesis(cleanedText: string): Promise<MethodResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required in project root .env.local.");
  }

  const model = process.env.METHOD_MODEL || "gpt-4.1-mini";
  const snippet = cleanedText.slice(0, 120_000);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Extract concise assumptions and intended methodology. Return strict JSON only.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "From the paper text, produce:\n" +
                "- method_steps: actionable implementation steps only (not theory)\n" +
                "- assumptions: explicit assumptions required for the method\n" +
                "- insights: non-procedural observations/implications\n" +
                "Rules:\n" +
                "- Each item must be one sentence.\n" +
                "- Keep items concise and concrete.\n" +
                "- For method_steps, begin with an action label and colon, e.g. 'Partition input: ...'\n" +
                "- Every method_steps item must include exactly one label prefix before a colon.\n" +
                "- Exclude generic statements and background info from method_steps.\n\n" +
                "- Prefer fewer, high-signal items over coverage. Do not pad lists.\n" +
                "- If confidence is low for assumptions/insights, return fewer items or [].\n" +
                "- Do not include obvious, tautological, or pedantic statements.\n" +
                "- Keep only assumptions/insights that materially affect feasibility, outcomes, or interpretation.\n" +
                "- Stop once the strongest non-overlapping assumptions/insights are listed.\n" +
                "- Mark only particularly important steps with important=true (critical dependencies, irreversible decisions, or bottlenecks).\n\n" +
                `Paper text:\n${snippet}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "method_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              assumptions: {
                type: "array",
                maxItems: 5,
                items: { type: "string", maxLength: 160 },
              },
              method_steps: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    text: { type: "string", maxLength: 180, pattern: "^[^:]{2,60}:\\s.+" },
                    important: { type: "boolean" },
                  },
                  required: ["text", "important"],
                },
              },
              insights: {
                type: "array",
                maxItems: 5,
                items: { type: "string", maxLength: 180 },
              },
            },
            required: ["method_steps", "assumptions", "insights"],
          },
        },
      },
    }),
  });

  const payload = (await response.json()) as ResponsesPayload;
  if (!response.ok) {
    throw new Error(
      (((payload as unknown as { error?: { message?: string } })?.error?.message) ??
        "Method generation request failed.")
    );
  }

  const outputCandidates: string[] = [];
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    outputCandidates.push(payload.output_text.trim());
  }
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim()) {
        outputCandidates.push(content.text.trim());
      }
      if (content.json && typeof content.json === "object") {
        outputCandidates.push(JSON.stringify(content.json));
      }
    }
  }

  const firstJsonCandidate = outputCandidates.find((candidate) => {
    const t = candidate.trim();
    return t.startsWith("{") && t.endsWith("}");
  });

  if (!firstJsonCandidate) {
    const incompleteReason =
      payload.status === "incomplete" ? payload.incomplete_details?.reason : undefined;
    throw new Error(
      incompleteReason
        ? `Method response incomplete (${incompleteReason}).`
        : "Method response did not include JSON output."
    );
  }

  const parsed = JSON.parse(firstJsonCandidate) as MethodResult;
  return {
    method_steps: (parsed.method_steps ?? [])
      .map((item) => ({
        text: item.text.trim(),
        important: Boolean(item.important),
      }))
      .filter((item) => item.text.length > 0)
      .slice(0, 8),
    assumptions: (parsed.assumptions ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 5),
    insights: (parsed.insights ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 5),
  };
}

export async function POST(request: Request) {
  let projectId: string | null = null;
  try {
    const supabase = createAdminClient();
    const body = (await request.json()) as { projectId?: string };
    projectId = body?.projectId?.trim() ?? null;

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: "projectId is required." },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();
    const { error: startError } = await supabase
      .from("projects")
      .update({ method_status: "running", method_error: null, updated_at: nowIso })
      .eq("id", projectId);

    if (startError) {
      throw new Error(startError.message || "Failed to start method generation.");
    }

    const { data: primary, error: primaryError } = await supabase
      .from("project_files")
      .select("extracted_text, processing_status")
      .eq("project_id", projectId)
      .eq("is_primary", true)
      .limit(1)
      .single();
    const primaryRow = primary as { extracted_text: string; processing_status: string } | null;

    if (primaryError || !primaryRow || primaryRow.processing_status !== "ready") {
      throw new Error("Primary file extraction is not ready.");
    }

    const result = await runMethodSynthesis(cleanText(primaryRow.extracted_text));

    const { error: completeError } = await supabase
      .from("projects")
      .update({
        method_status: "ready",
        method_error: null,
        method_result_json: result,
        updated_at: nowIso,
      })
      .eq("id", projectId);

    if (completeError) {
      throw new Error(completeError.message || "Failed to save method output.");
    }

    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Method generation failed.";
    if (projectId) {
      const supabase = createAdminClient();
      await supabase
        .from("projects")
        .update({ method_status: "failed", method_error: message, updated_at: new Date().toISOString() })
        .eq("id", projectId);
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
