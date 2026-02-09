import { NextResponse } from "next/server";

import { runEvalAgent } from "@/lib/eval/agent";

export const runtime = "nodejs";

export async function POST(request: Request) {
  console.log("[eval-route] POST /api/eval/agent received.");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[eval-route] Missing OPENAI_API_KEY.");
    return NextResponse.json(
      { success: false, error: "OPENAI_API_KEY is required." },
      { status: 500 }
    );
  }

  let body: {
    task?: string;
    paperText?: string;
    methodText?: string;
    maxIterations?: number;
    defaultLanguage?: string;
    model?: string;
    requireSufficientOutput?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    console.error("[eval-route] Failed to parse JSON body.");
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const task = body.task?.trim();
  if (!task) {
    console.warn("[eval-route] Missing task in request body.");
    return NextResponse.json(
      { success: false, error: "task is required." },
      { status: 400 }
    );
  }

  try {
    console.log("[eval-route] Starting eval agent run.", {
      taskPreview: task.slice(0, 120),
      hasPaperText: Boolean(body.paperText),
      hasMethodText: Boolean(body.methodText),
      maxIterations: body.maxIterations,
      defaultLanguage: body.defaultLanguage,
    });

    const result = await runEvalAgent({
      task,
      paperText: body.paperText,
      methodText: body.methodText,
      maxIterations: body.maxIterations,
      defaultLanguage: body.defaultLanguage,
      model: body.model,
      requireSufficientOutput: body.requireSufficientOutput,
    });

    console.log("[eval-route] Eval agent completed.", {
      success: result.success,
      stepCount: result.steps.length,
    });

    return NextResponse.json(
      {
        success: result.success,
        result,
      },
      { status: 200 }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Eval agent execution failed.";

    console.error("[eval-route] Eval agent threw error.", { message });

    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
