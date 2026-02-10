import { NextResponse } from "next/server";

export const runtime = "nodejs";

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: "OPENAI_API_KEY is required." },
      { status: 500 }
    );
  }

  let body: {
    paperText?: string;
    methodAssumptions?: string[];
    methodInsights?: string[];
    methodSteps?: string[];
    replicationOutput?: string;
    model?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const replicationOutput = body.replicationOutput?.trim();
  if (!replicationOutput) {
    return NextResponse.json(
      { success: false, error: "replicationOutput is required." },
      { status: 400 }
    );
  }

  const paperText = (body.paperText ?? "").trim();
  const methodAssumptions = Array.isArray(body.methodAssumptions)
    ? body.methodAssumptions.map(String).filter(Boolean).slice(0, 60)
    : [];
  const methodInsights = Array.isArray(body.methodInsights)
    ? body.methodInsights.map(String).filter(Boolean).slice(0, 60)
    : [];
  const methodSteps = Array.isArray(body.methodSteps)
    ? body.methodSteps.map(String).filter(Boolean).slice(0, 80)
    : [];

  const model = body.model || process.env.EVAL_MODEL || "gpt-5.2-2025-12-11";

  const prompt = [
    "You are comparing a paper's major claims to reproduced experimental outputs.",
    "",
    "Goal:",
    "- Be concise, human-readable, and to the point.",
    "- We only need to assess whether the MAJOR claims are supported in general by the reproduced outputs.",
    "- Do NOT demand perfect replication of every appendix detail.",
    "- Do NOT provide an overall verdict for the entire paper; focus on claim-by-claim support.",
    "",
    "Task:",
    "- Extract the paper's major claims/conclusions that are testable from the available information.",
    "- Summarize what the reproduction actually ran and what numeric results it printed.",
    "- For each claim, decide one of: Supported / Contradicted / Unclear (missing info).",
    "- Always cite 1-3 concrete numbers from the reproduction output as evidence (or explicitly say 'no numeric evidence found').",
    "- If comparison is not possible, say exactly what is missing (e.g. paper baseline numbers, claim definition, units).",
    "",
    "Output format:",
    "- Return plain text ONLY.",
    "- Use this exact structure (keep it short):",
    "",
    "CLAIMS CHECK",
    "- Claim 1: <one sentence>",
    "  - Reproduction evidence: <numbers + brief context>",
    "  - Assessment: Supported | Contradicted | Unclear",
    "- Claim 2: ...",
    "",
    "NOTES (only if needed)",
    "- Missing info: <1-5 bullets, specific>",
    "- Next experiments/logging: <1-5 bullets, specific>",
    "",
    "Length limits:",
    "- Max 8 claims.",
    "- Max ~200 lines total; prefer much less.",
  ].join("\n");

  const inputText = [
    paperText
      ? `Paper text excerpt:\n${truncate(paperText, 30_000)}`
      : "Paper text excerpt: (not provided)",
    "",
    methodSteps.length ? `Method steps (from earlier stage):\n- ${methodSteps.join("\n- ")}` : "",
    methodAssumptions.length
      ? `\nAssumptions (from earlier stage):\n- ${methodAssumptions.join("\n- ")}`
      : "",
    methodInsights.length
      ? `\nInsights (from earlier stage):\n- ${methodInsights.join("\n- ")}`
      : "",
    "",
    `Reproduction program output (stdout/stderr):\n${truncate(replicationOutput, 40_000)}`,
  ]
    .filter(Boolean)
    .join("\n");

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
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: inputText }],
        },
      ],
    }),
  });

  const payload = (await response.json()) as {
    output_text?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    return NextResponse.json(
      { success: false, error: payload?.error?.message || "Analysis request failed." },
      { status: 500 }
    );
  }

  const analysis = payload.output_text?.trim();
  if (!analysis) {
    return NextResponse.json(
      { success: false, error: "Empty analysis output." },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, analysis }, { status: 200 });
}

