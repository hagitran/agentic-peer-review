import { NextResponse } from "next/server";
import type { Sql } from "postgres";

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

function truncateSentence(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const firstSentence = normalized.match(/.*?[.!?](\s|$)/)?.[0]?.trim() ?? normalized;
  if (firstSentence.length <= maxChars) return firstSentence;
  return firstSentence.slice(0, maxChars).trim();
}

function truncateText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trim()}…`;
}

function compactFeasibilityResult(result: FeasibilityResult): FeasibilityResult {
  const reasonBase = truncateSentence(result.reason, 180).replace(/\.{3,}\s*$/, ".").trim();
  const reason =
    reasonBase.length > 0 && /[.!?]$/.test(reasonBase) ? reasonBase : `${reasonBase}.`;
  const blockers = (result.blockers ?? [])
    .map((item) => truncateSentence(item, 96))
    .filter(Boolean)
    .slice(0, 3);
  const feasibilitySignal =
    /\b(software|code|implementation|simulate|simulation|hardware|lab|device|sensor|equipment|dataset|private|proprietary|infrastructure|gpu|cpu|compute|experiment|human)\b/i;
  const evidenceSnippets = (result.evidence_snippets ?? [])
    .map((item) => truncateText(item, 200))
    .filter((item) => item.length > 0 && feasibilitySignal.test(item))
    .slice(0, 3);

  return {
    feasible: result.feasible,
    reason,
    blockers,
    confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0)),
    evidence_snippets: evidenceSnippets,
  };
}

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
  return {
    cleanedText: text,
    wasReferencesCut: referencesHeadingIndex >= 0,
  };
}

async function ensureSchema(sql: Sql) {
  await sql`create extension if not exists pgcrypto`;
  await sql`
    create table if not exists paper_extractions (
      id uuid primary key default gen_random_uuid(),
      original_filename text not null,
      size_bytes bigint not null,
      mime_type text not null,
      client_last_modified timestamptz,
      uploaded_at timestamptz not null default now(),
      page_count integer not null default 0,
      extracted_text text not null default '',
      pages_json jsonb,
      processing_status text not null default 'queued',
      processing_error text
    )
  `;
  await sql`
    alter table paper_extractions
    add column if not exists feasibility_status text
  `;
  await sql`
    alter table paper_extractions
    add column if not exists feasibility_result_json jsonb
  `;
}

async function runFeasibilityCheck(cleanedText: string): Promise<FeasibilityResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required in project root .env.local for feasibility checks."
    );
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
              "You are checking paper feasibility. Focus on methodology/setup requirements only. Return strict JSON. Be maximally concise.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Determine whether this paper is feasible with software-only resources.\n" +
              "If not feasible, identify blockers such as special hardware, physical experiments, wet lab needs, private/proprietary inaccessible dependencies, human-subject requirements, or unavailable infrastructure.\n\n" +
              "Output rules:\n" +
              "- reason must be one short sentence only.\n" +
              "- blockers must be empty if feasible is yes.\n" +
              "- evidence_snippets must ONLY include direct snippets about required resources, constraints, hardware, datasets, or setup feasibility.\n" +
              "- if no direct feasibility snippet exists, return evidence_snippets as an empty array.\n" +
              "- do not include generic theory/results/evaluation snippets.\n\n" +
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
            feasible: {
              type: "string",
              enum: ["yes", "no", "unclear"],
            },
            reason: {
              type: "string",
              maxLength: 180,
            },
            blockers: {
              type: "array",
              maxItems: 3,
              items: { type: "string", maxLength: 120 },
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            evidence_snippets: {
              type: "array",
              maxItems: 3,
              items: { type: "string", maxLength: 180 },
            },
          },
          required: [
            "feasible",
            "reason",
            "blockers",
            "confidence",
            "evidence_snippets",
          ],
        },
      },
    },
  };

  let payload: Record<string, unknown> | null = null;
  let lastErrorMessage = "Feasibility model request failed.";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const requestId =
      response.headers.get("x-request-id") ||
      response.headers.get("request-id");
    const parsedPayload = (await response.json()) as Record<string, unknown>;

    if (response.ok) {
      payload = parsedPayload;
      break;
    }

    const errorMessage =
      ((parsedPayload?.error as { message?: string } | undefined)?.message ??
        "Feasibility model request failed.") +
      (requestId ? ` (request_id: ${requestId})` : "");

    lastErrorMessage = `${errorMessage} (status: ${response.status})`;
    const shouldRetry = response.status >= 500 || response.status === 429;

    if (!shouldRetry || attempt === 2) {
      throw new Error(lastErrorMessage);
    }

    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }

  if (!payload) {
    throw new Error(lastErrorMessage);
  }

  const outputText = extractResponseText(payload);
  if (typeof outputText !== "string" || outputText.trim().length === 0) {
    throw new Error(
      "Feasibility response did not include JSON output. Check model compatibility or prompt/schema settings."
    );
  }

  let parsed: FeasibilityResult;
  try {
    parsed = JSON.parse(outputText) as FeasibilityResult;
  } catch {
    throw new Error("Feasibility response JSON could not be parsed.");
  }

  return compactFeasibilityResult(parsed);
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

      // Common Responses API shape: { type: "output_text", text: "..." }
      if (
        typed.type === "output_text" &&
        typeof typed.text === "string" &&
        typed.text.trim().length > 0
      ) {
        parts.push(typed.text);
      }

      // Some SDK/runtime shapes may nest under output_text
      const outputText = typed.output_text;
      if (typeof outputText === "string" && outputText.trim().length > 0) {
        parts.push(outputText);
      }
    }
  }

  return parts.length ? parts.join("\n") : null;
}

export async function POST(request: Request) {
  try {
    const sql = getSql();
    await ensureSchema(sql);

    const body = (await request.json()) as { extractionId?: string };
    const extractionId = body?.extractionId?.trim();

    if (!extractionId) {
      return NextResponse.json(
        { success: false, error: "extractionId is required." },
        { status: 400 }
      );
    }

    const rows = await sql<{
      id: string;
      extracted_text: string;
      processing_status: string;
    }[]>`
      select id, extracted_text, processing_status
      from paper_extractions
      where id = ${extractionId}
      limit 1
    `;

    const extraction = rows[0];
    if (!extraction) {
      return NextResponse.json(
        { success: false, error: "Extraction not found." },
        { status: 404 }
      );
    }

    if (extraction.processing_status !== "ready") {
      return NextResponse.json(
        { success: false, error: "Extraction is not ready yet." },
        { status: 400 }
      );
    }

    if (!extraction.extracted_text?.trim()) {
      return NextResponse.json(
        { success: false, error: "No extracted text available." },
        { status: 400 }
      );
    }

    const cleaned = cleanForFeasibility(extraction.extracted_text);
    const result = await runFeasibilityCheck(cleaned.cleanedText);

    await sql`
      update paper_extractions
      set
        feasibility_status = ${result.feasible},
        feasibility_result_json = ${sql.json({
          ...result,
          cleaned_char_count: cleaned.cleanedText.length,
          references_cut: cleaned.wasReferencesCut,
        })}
      where id = ${extractionId}
    `;

    return NextResponse.json({
      success: true,
      result,
      cleanedCharCount: cleaned.cleanedText.length,
      referencesCut: cleaned.wasReferencesCut,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Feasibility check failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
