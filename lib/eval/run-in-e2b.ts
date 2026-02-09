import { Sandbox } from "@e2b/code-interpreter";

/**
 * Run code in an e2b sandbox.
 */
export type RunInE2bResult =
  | { success: true; output: string }
  | { success: false; error: string };

export async function runInE2b(
  code: string,
  language?: string
): Promise<RunInE2bResult> {
  console.log("[eval-e2b] runInE2b called.", {
    codeLength: code.length,
    language,
  });

  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    console.error("[eval-e2b] Missing E2B_API_KEY.");
    return {
      success: false,
      error: "E2B_API_KEY is required in .env.local to run code in the sandbox.",
    };
  }

  // Normalize language; for now we mainly support Python.
  const normalizedLanguage = (() => {
    const raw = (language || "python").toLowerCase();
    if (raw.startsWith("py")) return "python";
    return raw;
  })();

  console.log("[eval-e2b] Normalized language.", { normalizedLanguage });

  try {
    const sandbox = await Sandbox.create();
    console.log("[eval-e2b] Sandbox created.", {
      sandboxId: sandbox.sandboxId,
    });

    const execution = await sandbox.runCode(code, {
      language: normalizedLanguage,
      timeoutMs: 60_000,
      requestTimeoutMs: 60_000,
    });

    // If Python raised an error, surface it as a failure.
    if (execution.error) {
      const err = execution.error;
      const traceback = err.traceback ? `\n${err.traceback}` : "";
      console.warn("[eval-e2b] Execution error.", {
        name: err.name,
        value: err.value,
      });
      return {
        success: false,
        error: `Sandbox execution error (${err.name}): ${err.value}${traceback}`,
      };
    }

    // Prefer main text result if present.
    let output = execution.text?.trim();

    // Otherwise fall back to logs.
    if (!output) {
      const stdout = execution.logs?.stdout?.join("") ?? "";
      const stderr = execution.logs?.stderr?.join("") ?? "";
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
      output = combined || "Execution finished with no output.";
    }

    console.log("[eval-e2b] Execution succeeded.", {
      hasTextResult: Boolean(execution.text),
      stdoutLength: execution.logs?.stdout?.join("").length ?? 0,
      stderrLength: execution.logs?.stderr?.join("").length ?? 0,
    });

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[eval-e2b] Failed to run code in sandbox.", { message });
    return {
      success: false,
      error: `Failed to run code in e2b sandbox: ${message}`,
    };
  }
}
