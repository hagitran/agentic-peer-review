import { NextResponse } from "next/server";

import { createAdminClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

type ResponsesPayload = {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

function readOutputText(payload: ResponsesPayload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  for (const item of payload.output ?? []) {
    for (const block of item.content ?? []) {
      if (typeof block.text === "string" && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return "";
}

function clampReply(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No signal.";
  return compact;
}

function cleanText(raw: string) {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[^\x09\x0A\x20-\x7E]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { projectId?: string; prompt?: string };
    const projectId = body?.projectId?.trim();
    const prompt = body?.prompt?.trim();
    if (!projectId) {
      return NextResponse.json({ success: false, error: "projectId is required." }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ success: false, error: "prompt is required." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "OPENAI_API_KEY is required in project root .env.local." },
        { status: 500 }
      );
    }

    const supabase = createAdminClient();
    const [{ data: primary, error: primaryError }, { data: project, error: projectError }] =
      await Promise.all([
        supabase
          .from("project_files")
          .select("extracted_text")
          .eq("project_id", projectId)
          .eq("is_primary", true)
          .limit(1)
          .single(),
        supabase.from("projects").select("method_result_json").eq("id", projectId).limit(1).single(),
      ]);
    const primaryRow = primary as { extracted_text: string } | null;
    const projectRow = project as { method_result_json: unknown } | null;

    if (primaryError || !primaryRow || projectError || !projectRow) {
      return NextResponse.json({ success: false, error: "Primary file not found." }, { status: 404 });
    }

    const model = process.env.METHOD_TERMINAL_MODEL || "gpt-4.1-mini";
    const methodJson =
      projectRow.method_result_json && typeof projectRow.method_result_json === "object"
        ? JSON.stringify(projectRow.method_result_json).slice(0, 1400)
        : "";
    const paperSnippet = cleanText(primaryRow.extracted_text).slice(0, 4500);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_output_tokens: 120,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You are a terse method copilot. Reply in one short line only. No markdown.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  `User prompt: ${prompt}\n\n` +
                  `Known method summary JSON: ${methodJson || "none"}\n\n` +
                  `Paper context:\n${paperSnippet}`,
              },
            ],
          },
        ],
      }),
    });

    const payload = (await response.json()) as ResponsesPayload;
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: payload.error?.message || "Terminal request failed." },
        { status: 500 }
      );
    }

    const reply = clampReply(readOutputText(payload));
    return NextResponse.json({ success: true, reply });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Terminal request failed." },
      { status: 500 }
    );
  }
}
