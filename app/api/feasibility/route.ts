import { NextResponse } from "next/server";

import { getSql } from "@/lib/db";

export const runtime = "nodejs";

type FeasibilityStatus = "yes" | "no" | "unclear";

type FeasibilityResult = {
  feasible: FeasibilityStatus;
  reason: string;
  blockers: string[];
  confidence: number;
  evidence_snippets: string[];
};

function cleanForFeasibility(rawText: string) {
  let text = rawText.replace(/\r\n?/g, "\n");
  text = text.replace(/[^\x09\x0A\x20-\x7E]/g, " ");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  let lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\s*\d+\s*$/.test(line.trim()));

  const referencesHeadingIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 40) return false;
    return /^(?:\d+\.?\s*)?(references|bibliography)\s*$/i.test(trimmed);
  });

  if (referencesHeadingIndex >= 0) {
    lines = lines.slice(0, referencesHeadingIndex);
  }

  text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

function compactReason(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "Unable to determine feasibility.";
  const sentence = normalized.match(/.*?[.!?](\s|$)/)?.[0]?.trim() ?? normalized;
  const trimmed = sentence.slice(0, 180).replace(/\.{3,}\s*$/, ".").trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function compactResult(result: FeasibilityResult): FeasibilityResult {
  const signal =
    /\b(software|code|implementation|simulate|simulation|hardware|lab|device|sensor|equipment|dataset|private|proprietary|infrastructure|gpu|cpu|compute|experiment|human)\b/i;
  return {
    feasible: result.feasible,
    reason: compactReason(result.reason),
    blockers: (result.blockers ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 3),
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    evidence_snippets: (result.evidence_snippets ?? [])
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length > 0 && signal.test(x))
      .slice(0, 3),
  };
}

function extractResponseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (typeof obj.output_text === "string" && obj.output_text.trim().length > 0) {
    return obj.output_text;
  }

  const output = obj.output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typed = block as Record<string, unknown>;
      if (
        typed.type === "output_text" &&
        typeof typed.text === "string" &&
        typed.text.trim().length > 0
      ) {
        parts.push(typed.text);
      }
    }
  }

  return parts.length ? parts.join("\n") : null;
}

async function runFeasibilityCheck(cleanedText: string): Promise<FeasibilityResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required in project root .env.local.");
  }

  const model = process.env.FEASIBILITY_MODEL || "gpt-4.1-mini";
  const snippet = cleanedText.slice(0, 120_000);

  const requestBody = {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Assess feasibility of reproducing the methodology with software-only resources. Return strict JSON only.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Focus only on methodology/setup requirements.\n" +
              "Return feasibility as yes/no/unclear.\n" +
              "Reason must be one short sentence.\n" +
              "Blockers empty if feasible is yes.\n" +
              "Evidence snippets must directly mention feasibility/resource constraints. Otherwise return empty array.\n\n" +
              `Paper text:\n${snippet}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "feasibility_result",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            feasible: { type: "string", enum: ["yes", "no", "unclear"] },
            reason: { type: "string", maxLength: 180 },
            blockers: { type: "array", maxItems: 3, items: { type: "string", maxLength: 120 } },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            evidence_snippets: {
              type: "array",
              maxItems: 3,
              items: { type: "string", maxLength: 180 },
            },
          },
          required: ["feasible", "reason", "blockers", "confidence", "evidence_snippets"],
        },
      },
    },
  };

  let payload: Record<string, unknown> | null = null;
  let lastError = "Feasibility model request failed.";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    const parsedPayload = (await response.json()) as Record<string, unknown>;

    if (response.ok) {
      payload = parsedPayload;
      break;
    }

    const message =
      ((parsedPayload?.error as { message?: string } | undefined)?.message ??
        "Feasibility model request failed.") +
      (requestId ? ` (request_id: ${requestId})` : "");
    lastError = `${message} (status: ${response.status})`;

    const shouldRetry = response.status >= 500 || response.status === 429;
    if (!shouldRetry || attempt === 2) throw new Error(lastError);

    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }

  if (!payload) throw new Error(lastError);

  const outputText = extractResponseText(payload);
  if (!outputText) throw new Error("Feasibility response did not include JSON output.");

  let parsed: FeasibilityResult;
  try {
    parsed = JSON.parse(outputText) as FeasibilityResult;
  } catch {
    throw new Error("Feasibility response JSON could not be parsed.");
  }

  return compactResult(parsed);
}

export async function POST(request: Request) {
  try {
    const sql = getSql();
    const body = (await request.json()) as { projectId?: string };
    const projectId = body?.projectId?.trim();

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: "projectId is required." },
        { status: 400 }
      );
    }

    const rows = await sql<{
      id: string;
      extracted_text: string;
      processing_status: string;
    }[]>`
      select pf.id, pf.extracted_text, pf.processing_status
      from project_files pf
      where pf.project_id = ${projectId} and pf.is_primary = true
      limit 1
    `;

    const primary = rows[0];
    if (!primary) {
      return NextResponse.json(
        { success: false, error: "Primary file not found." },
        { status: 404 }
      );
    }
    if (primary.processing_status !== "ready") {
      return NextResponse.json(
        { success: false, error: "Primary extraction is not ready." },
        { status: 400 }
      );
    }

    const cleanedText = cleanForFeasibility(primary.extracted_text);
    const result = await runFeasibilityCheck(cleanedText);

    await sql`
      update projects
      set
        feasibility_status = ${result.feasible},
        feasibility_result_json = ${sql.json(result)},
        updated_at = now()
      where id = ${projectId}
    `;

    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Feasibility check failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
