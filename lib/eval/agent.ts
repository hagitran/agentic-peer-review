import { runInE2b, type RunInE2bResult } from "./run-in-e2b";

type CodeSuggestion = {
  code: string;
  language?: string;
  explanation?: string;
};

type OutputAssessment = {
  sufficient: boolean;
  missing: string[];
  rationale: string;
  requested_changes: string[];
};

export type EvalAgentStep = {
  iteration: number;
  suggestion: CodeSuggestion;
  runResult: RunInE2bResult;
  outputAssessment?: OutputAssessment;
};

export type EvalAgentResult =
  | {
      success: true;
      steps: EvalAgentStep[];
      finalOutput: string;
      finalAssessment?: OutputAssessment;
    }
  | {
      success: false;
      steps: EvalAgentStep[];
      lastError: string;
    };

const MAX_PAPER_CHARS = 60_000;
const MAX_OUTPUT_CHARS_FOR_JUDGE = 20_000;
const MAX_CONTEXT_CHARS_FOR_JUDGE = 30_000;
const MAX_LOG_CHARS = 4_000;

function toLogSnippet(value: string, maxChars = MAX_LOG_CHARS) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function buildSystemPrompt() {
  return [
    "You are a research code replication agent.",
    "Your job is to reconstruct, as faithfully as possible, the code used in an academic paper so that its results and conclusions can be re-checked.",
    "",
    "Rules:",
    "- Prioritize reproducing the paper's methods, algorithms, data processing, and hyperparameters as described in the text.",
    "- When details are underspecified, make the smallest, most conservative assumptions needed to get a working implementation and clearly document them in your explanation string (not in the code).",
    "- Prefer Python scripts that can be executed as-is (e.g. `python script.py`) and that print their key quantitative outputs to stdout.",
    "- The script should be self-contained as far as possible (define all functions/classes you use, import required libraries, and include any data-generation or toy-data logic if real data access is not available).",
    "- Do not invent entirely new algorithms or evaluation procedures; stay close to what the paper describes.",
    "- Do not include explanations or markdown inside the code itself; explanations go only in the JSON `explanation` field.",
    "",
    "Critical: The script output must be sufficient for a third party to judge replicability from the logs alone.",
    "Output requirements (print all of these):",
    "- A clear 'REPLICATION REPORT' section header.",
    "- Exact parameter values / hyperparameters used (including any defaults you assume).",
    "- Random seed(s) and a note on determinism/stochasticity.",
    "- Environment details: Python version and key package versions used (at minimum: numpy, scipy, pandas, matplotlib, torch/sklearn if used).",
    "- The key metrics/tables/figures needed to evaluate whether the paper's conclusions hold (print numeric values, not just plots).",
    "- If comparing against claims in the paper, restate the claim and print your computed value side-by-side.",
    "- A final machine-readable JSON line prefixed with 'REPLICATION_JSON:' that includes: parameters, metrics, and a short verdict string.",
  ].join("\n");
}

function buildUserPrompt(params: {
  task: string;
  paperText?: string;
  methodText?: string;
  previousSuggestion?: CodeSuggestion | null;
  lastError?: string | null;
  iteration: number;
}) {
  const { task, paperText, methodText, previousSuggestion, lastError, iteration } = params;

  const contextLines: string[] = [];
  contextLines.push(
    "Replication objective:",
    task,
    "",
    "Your goal is to recreate the Python code that implements the paper's method/experiments so we can rerun it and check whether the same conclusions hold."
  );

  if (paperText) {
    const snippet =
      paperText.length > MAX_PAPER_CHARS
        ? `${paperText.slice(0, MAX_PAPER_CHARS)}\n...[truncated]`
        : paperText;
    contextLines.push(
      "",
      "Paper context (source of truth for the method; follow it closely):",
      snippet
    );
  }

  if (methodText) {
    contextLines.push(
      "",
      "Structured methodology summary (high-signal guide; if there is a conflict, the original paper text above is the source of truth):",
      methodText
    );
  }

  if (iteration === 0) {
    contextLines.push(
      "",
      "This is the first attempt. Propose the best possible implementation."
    );
  } else {
    contextLines.push(
      "",
      `This is refinement iteration ${iteration}. Improve the previous code to fix the error.`
    );
  }

  if (previousSuggestion) {
    contextLines.push(
      "",
      "Previous code (for reference, you may reuse or change it):",
      "```",
      previousSuggestion.code,
      "```"
    );
  }

  if (lastError) {
    contextLines.push(
      "",
      "Last execution error/output (analyze and fix the root cause):",
      lastError
    );
  }

  contextLines.push(
    "",
    "Return a JSON object ONLY, with this shape:",
    '{ "code": "<full script>", "language": "python", "explanation": "<short reasoning>"}'
  );

  return contextLines.join("\n");
}

type SuggestionResponsePayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      json?: unknown;
    }>;
  }>;
};

type CodeSuggestionJson = {
  code: string;
  language?: string;
  explanation?: string;
};

function extractFirstJsonCandidate(payload: SuggestionResponsePayload): string | null {
  const candidates: string[] = [];

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    candidates.push(payload.output_text.trim());
  }

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim()) {
        candidates.push(content.text.trim());
      }
      if (content.json && typeof content.json === "object") {
        candidates.push(JSON.stringify(content.json));
      }
    }
  }

  const firstJson = candidates.find((candidate) => {
    const t = candidate.trim();
    return t.startsWith("{") && t.endsWith("}");
  });

  return firstJson ?? null;
}

async function getCodeSuggestion(params: {
  task: string;
  paperText?: string;
  methodText?: string;
  previousSuggestion?: CodeSuggestion | null;
  lastError?: string | null;
  iteration: number;
  model?: string;
}): Promise<CodeSuggestion> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required in project root .env.local.");
  }

  const model = params.model || process.env.EVAL_MODEL || "gpt-5.2-2025-12-11";

  const promptText = buildUserPrompt(params);
  const startedAt = Date.now();
  console.log("[eval-agent] OpenAI code generation starting.", {
    iteration: params.iteration,
    model,
    promptChars: promptText.length,
    hasPaperText: Boolean(params.paperText),
    hasMethodText: Boolean(params.methodText),
    hasLastError: Boolean(params.lastError),
  });

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
              text: buildSystemPrompt(),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: promptText,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "code_suggestion",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              language: { type: "string" },
              explanation: { type: "string" },
            },
            // With strict schemas, OpenAI requires `required` to include every property key.
            required: ["code", "language", "explanation"],
          },
        },
      },
    }),
  });

  console.log("[eval-agent] OpenAI code generation response received.", {
    iteration: params.iteration,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
  });

  const payload = (await response.json()) as SuggestionResponsePayload & {
    error?: { message?: string };
  };

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      `Code suggestion request failed with status ${response.status}.`;
    console.error("[eval-agent] OpenAI error during code suggestion.", {
      status: response.status,
      message: payload?.error?.message,
    });
    throw new Error(errorMessage);
  }

  const jsonString = extractFirstJsonCandidate(payload);
  if (!jsonString) {
    throw new Error("Code suggestion response did not include JSON output.");
  }

  const parsed = JSON.parse(jsonString) as CodeSuggestionJson;
  if (!parsed.code || typeof parsed.code !== "string") {
    throw new Error("Code suggestion JSON did not include a valid 'code' field.");
  }

  return {
    code: parsed.code,
    language:
      typeof parsed.language === "string" && parsed.language.trim().length > 0
        ? parsed.language.trim()
        : undefined,
    explanation:
      typeof parsed.explanation === "string" && parsed.explanation.trim().length > 0
        ? parsed.explanation.trim()
        : undefined,
  };
}

async function assessOutputSufficiency(params: {
  task: string;
  paperText?: string;
  methodText?: string;
  stdout: string;
  model?: string;
}): Promise<OutputAssessment> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required in project root .env.local.");
  }

  const judgeModel = params.model || process.env.EVAL_JUDGE_MODEL || "gpt-5.2-2025-12-11";

  const startedAt = Date.now();
  console.log("[eval-agent] Output sufficiency check starting.", {
    model: judgeModel,
    stdoutChars: params.stdout.length,
    hasPaperText: Boolean(params.paperText),
    hasMethodText: Boolean(params.methodText),
  });

  const paperSnippet = params.paperText
    ? truncateText(params.paperText, MAX_CONTEXT_CHARS_FOR_JUDGE)
    : undefined;
  const stdoutSnippet = truncateText(params.stdout, MAX_OUTPUT_CHARS_FOR_JUDGE);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: judgeModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are a strict reproducibility judge. Decide whether the provided run output is sufficient to judge whether the paper is replicable (from output alone). " +
                "If insufficient, list exactly what is missing and what the code should print next time.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Task:\n${params.task}\n\n` +
                (params.methodText ? `Method summary:\n${params.methodText}\n\n` : "") +
                (paperSnippet ? `Paper excerpt:\n${paperSnippet}\n\n` : "") +
                `Program output (stdout/stderr combined):\n${stdoutSnippet}\n\n` +
                "Return JSON only.",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "output_assessment",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              sufficient: { type: "boolean" },
              missing: { type: "array", items: { type: "string" } },
              rationale: { type: "string" },
              requested_changes: { type: "array", items: { type: "string" } },
            },
            required: ["sufficient", "missing", "rationale", "requested_changes"],
          },
        },
      },
    }),
  });

  console.log("[eval-agent] Output sufficiency check response received.", {
    status: response.status,
    elapsedMs: Date.now() - startedAt,
  });

  const payload = (await response.json()) as SuggestionResponsePayload & {
    error?: { message?: string };
  };

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      `Output assessment request failed with status ${response.status}.`;
    console.error("[eval-agent] OpenAI error during output assessment.", {
      status: response.status,
      message: payload?.error?.message,
    });
    throw new Error(errorMessage);
  }

  const jsonString = extractFirstJsonCandidate(payload);
  if (!jsonString) {
    throw new Error("Output assessment response did not include JSON output.");
  }

  const parsed = JSON.parse(jsonString) as OutputAssessment;
  return {
    sufficient: Boolean(parsed?.sufficient),
    missing: Array.isArray(parsed?.missing)
      ? parsed.missing.map((x) => String(x)).filter(Boolean).slice(0, 20)
      : [],
    rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "",
    requested_changes: Array.isArray(parsed?.requested_changes)
      ? parsed.requested_changes.map((x) => String(x)).filter(Boolean).slice(0, 20)
      : [],
  };
}

export async function runEvalAgent(params: {
  task: string;
  paperText?: string;
  methodText?: string;
  maxIterations?: number;
  defaultLanguage?: string;
  model?: string;
  requireSufficientOutput?: boolean;
}): Promise<EvalAgentResult> {
  const {
    task,
    paperText,
    methodText,
    maxIterations = 5,
    defaultLanguage = "python3",
    model,
    requireSufficientOutput = true,
  } = params;

  console.log("[eval-agent] Starting eval agent.", {
    taskPreview: task.slice(0, 160),
    hasPaperText: Boolean(paperText),
    hasMethodText: Boolean(methodText),
    maxIterations,
    defaultLanguage,
    model,
    requireSufficientOutput,
  });

  const steps: EvalAgentStep[] = [];
  let previousSuggestion: CodeSuggestion | null = null;
  let lastError: string | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    console.log("[eval-agent] Iteration: requesting code suggestion.", {
      iteration,
      hasPreviousSuggestion: Boolean(previousSuggestion),
      hasLastError: Boolean(lastError),
    });

    const suggestion = await getCodeSuggestion({
      task,
      paperText,
      methodText,
      previousSuggestion,
      lastError,
      iteration,
      model,
    });

    const language = suggestion.language || defaultLanguage;
    console.log("[eval-agent] Iteration: received suggestion.", {
      iteration,
      language,
      codeLength: suggestion.code.length,
      explanationPreview: suggestion.explanation?.slice(0, 160),
    });

    console.log("[eval-agent] Iteration: running code in e2b.", {
      iteration,
      language,
    });
    const runResult = await runInE2b(suggestion.code, language);

    console.log("[eval-agent] Iteration: e2b run completed.", {
      iteration,
      success: runResult.success,
      outputPreview: runResult.success ? toLogSnippet(runResult.output, 800) : undefined,
      errorPreview: !runResult.success ? toLogSnippet(runResult.error, 800) : undefined,
    });

    const step: EvalAgentStep = { iteration, suggestion, runResult };

    if (runResult.success) {
      if (requireSufficientOutput) {
        const assessment = await assessOutputSufficiency({
          task,
          paperText,
          methodText,
          stdout: runResult.output,
        });
        step.outputAssessment = assessment;
        steps.push(step);

        console.log("[eval-agent] Output sufficiency result.", {
          iteration,
          sufficient: assessment.sufficient,
          missingCount: assessment.missing.length,
          missing: assessment.missing,
          requestedChanges: assessment.requested_changes,
          rationalePreview: toLogSnippet(assessment.rationale || "", 800),
        });

        if (!assessment.sufficient) {
          previousSuggestion = suggestion;
          lastError =
            "Execution succeeded but output was insufficient to judge replicability.\n" +
            `Judge rationale: ${assessment.rationale?.trim() || "(no rationale)"}\n` +
            `Missing: ${assessment.missing.join("; ") || "(none listed)"}\n` +
            `Requested changes: ${assessment.requested_changes.join("; ") || "(none listed)"}\n\n` +
            "Output snippet:\n" +
            toLogSnippet(runResult.output, 2_000);
          console.warn("[eval-agent] Retrying due to insufficient output.", {
            iteration,
            missingCount: assessment.missing.length,
            requestedChangesCount: assessment.requested_changes.length,
          });
          continue;
        }

        console.log("[eval-agent] Succeeded with sufficient output.", {
          iteration,
          totalSteps: steps.length,
        });

        return {
          success: true,
          steps,
          finalOutput: runResult.output,
          finalAssessment: assessment,
        };
      }

      steps.push(step);
      console.log("[eval-agent] Succeeded.", {
        iteration,
        totalSteps: steps.length,
      });
      return {
        success: true,
        steps,
        finalOutput: runResult.output,
      };
    }

    steps.push(step);
    previousSuggestion = suggestion;
    lastError = runResult.error;
    console.warn("[eval-agent] Retrying due to execution failure.", {
      iteration,
      errorPreview: toLogSnippet(runResult.error, 1_200),
    });
  }

  console.warn("[eval-agent] Failed to converge.", {
    maxIterations,
    finalError: lastError,
  });

  return {
    success: false,
    steps,
    lastError: lastError ?? "Max iterations reached without a successful run.",
  };
}

