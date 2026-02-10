"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppTopbar } from "@/components/app-topbar";

type AppTab = "overview" | "method" | "evals" | "results";
type FeasibilityStatus = "yes" | "no" | "unclear";

type FeasibilityResult = {
  feasible: FeasibilityStatus;
  reason: string;
  blockers: string[];
  confidence: number;
  evidence_snippets: string[];
};

type MethodResult = {
  method_steps: Array<{
    text: string;
    important: boolean;
  }>;
  assumptions: string[];
  insights: string[];
};

type ProjectFile = {
  id: string;
  is_primary: boolean;
  original_filename: string;
  size_bytes: number;
  uploaded_at: string;
  page_count: number;
  extracted_text: string;
  processing_status: string;
};

type Project = {
  id: string;
  title: string;
  feasibility_status: FeasibilityStatus | null;
  feasibility_result_json: FeasibilityResult | null;
  method_status: "idle" | "running" | "ready" | "failed";
  method_error: string | null;
  method_result_json: MethodResult | null;
  files: ProjectFile[];
};

const RECENT_PROJECTS_COOKIE = "apr_recent_projects";
const RECENT_PROJECTS_LIMIT = 12;
const ASCII_FRAMES = ["[·  ]", "[·· ]", "[···]", "[ ··]", "[  ·]"];

type RecentProject = {
  projectId: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  fileHash: string;
};

type TerminalMessage = {
  role: "assistant" | "user";
  text: string;
};

type EvalRunResult =
  | { success: true; output: string }
  | { success: false; error: string };

type OutputAssessment = {
  sufficient: boolean;
  missing: string[];
  rationale: string;
  requested_changes: string[];
};

type EvalAgentStep = {
  iteration: number;
  suggestion: { code: string; language?: string; explanation?: string };
  runResult: EvalRunResult;
  outputAssessment?: OutputAssessment;
};

type EvalAgentResult =
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

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function truncateFilename(value: string, max = 44) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getCookieValue(name: string) {
  if (typeof document === "undefined") return null;
  const cookie = document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${name}=`));
  if (!cookie) return null;
  return decodeURIComponent(cookie.split("=")[1] ?? "");
}

function readRecentProjectsCookie() {
  const raw = getCookieValue(RECENT_PROJECTS_COOKIE);
  if (!raw) return [] as RecentProject[];
  try {
    const parsed = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.projectId === "string" &&
          typeof item.filename === "string" &&
          typeof item.sizeBytes === "number" &&
          typeof item.uploadedAt === "string" &&
          typeof item.fileHash === "string"
      )
      .slice(0, RECENT_PROJECTS_LIMIT);
  } catch {
    return [];
  }
}

function renderHighlightedLine(text: string) {
  const antiWidow = (value: string) => {
    const trimmed = value.trim();
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace <= 0) return trimmed;
    return `${trimmed.slice(0, lastSpace)}\u00A0${trimmed.slice(lastSpace + 1)}`;
  };

  const [label, ...rest] = text.split(":");
  if (rest.length === 0) return <span className="leading-6 text-zinc-700">{antiWidow(text)}</span>;
  const detail = antiWidow(rest.join(":"));
  return (
    <span className="leading-6">
      <span className="font-medium text-zinc-900 decoration-amber-300 decoration-2 underline-offset-3 underline">
        {label.trim()}:
      </span>{" "}
      <span className="text-zinc-700">{detail}</span>
    </span>
  );
}

function assistantMessageTag(text: string) {
  const value = text.toLowerCase();
  if (/\b(error|failed|unable|cannot|invalid)\b/.test(value)) return "[err]";
  if (/\bmethod flow|summary\b/.test(value)) return "[sum]";
  if (/\bshould|try|use|run|set|check|next\b/.test(value)) return "[act]";
  return "[ans]";
}

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;
  const subPdfInputRef = useRef<HTMLInputElement | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AppTab>("overview");
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deletedMethodSteps, setDeletedMethodSteps] = useState<Record<string, boolean>>({});
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [asciiFrameIndex, setAsciiFrameIndex] = useState(0);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalMessages, setTerminalMessages] = useState<TerminalMessage[]>([]);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);
  const terminalScrollRef = useRef<HTMLDivElement | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [lastEvalResult, setLastEvalResult] = useState<EvalAgentResult | null>(null);
  const [resultsAnalysis, setResultsAnalysis] = useState<string | null>(null);
  const [resultsAnalysisBusy, setResultsAnalysisBusy] = useState(false);

  const previewFile = useMemo(
    () => project?.files.find((file) => file.id === previewFileId) ?? null,
    [project, previewFileId]
  );

  const primaryFile = useMemo(
    () => project?.files.find((file) => file.is_primary) ?? null,
    [project]
  );
  const methodData = useMemo(() => {
    const raw = project?.method_result_json as
      | {
        method_steps?: Array<{ text?: string; important?: boolean } | string>;
        assumptions?: string[];
        insights?: string[];
        intended_method?: string[];
      }
      | null
      | undefined;

    const normalizedMethodSteps = (raw?.method_steps ?? raw?.intended_method ?? [])
      .map((entry) => {
        if (typeof entry === "string") {
          return { text: entry, important: false };
        }
        return {
          text: (entry?.text ?? "").trim(),
          important: Boolean(entry?.important),
        };
      })
      .filter((entry) => entry.text.length > 0);

    return {
      methodSteps: normalizedMethodSteps,
      assumptions: (raw?.assumptions ?? []).filter(Boolean),
      insights: (raw?.insights ?? []).filter(Boolean),
    };
  }, [project?.method_result_json]);

  const recentOptions = useMemo(
    () =>
      recentProjects.map((entry) => ({
        value: entry.projectId,
        label: `${truncateFilename(entry.filename)} • ${formatFileSize(entry.sizeBytes)} • ${new Date(entry.uploadedAt).toLocaleDateString()}`,
      })),
    [recentProjects]
  );

  const loadProject = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        success?: boolean;
        error?: string;
        project?: Project;
      };

      if (!response.ok || !payload?.success || !payload.project) {
        throw new Error(payload?.error || "Failed to load project.");
      }

      setProject(payload.project);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load project.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setRecentProjects(readRecentProjectsCookie());
  }, []);

  useEffect(() => {
    const isRunning = busy === "feasibility" || busy === "method" || project?.method_status === "running";
    if (!isRunning) return;
    const intervalId = window.setInterval(() => {
      setAsciiFrameIndex((prev) => (prev + 1) % ASCII_FRAMES.length);
    }, 130);
    return () => window.clearInterval(intervalId);
  }, [busy, project?.method_status]);

  useEffect(() => {
    if (project?.method_status === "ready") return;
    setTerminalDrawerOpen(false);
    setTerminalInput("");
    setTerminalMessages([]);
  }, [project?.method_status]);

  useEffect(() => {
    if (!terminalDrawerOpen) return;
    const container = terminalScrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [terminalDrawerOpen, terminalMessages, terminalBusy]);

  const uploadFile = async (file: File, action: "replace_primary" | "add_subpdf") => {
    setBusy(action);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("lastModified", String(file.lastModified));
      formData.append("action", action);
      formData.append("projectId", projectId);

      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };

      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "Upload failed.");
      }

      await loadProject();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(null);
    }
  };

  const deleteSubFile = async (fileId: string) => {
    setBusy("delete");
    setError(null);
    try {
      const response = await fetch(`/api/project-files/${fileId}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "Delete failed.");
      }
      await loadProject();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(null);
    }
  };

  const runMethod = async (options?: { manageBusy?: boolean }) => {
    const manageBusy = options?.manageBusy ?? true;
    if (manageBusy) setBusy("method");

    try {
      const response = await fetch("/api/method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const payload = (await response.json()) as { success?: boolean; error?: string };

      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "Method generation failed.");
      }

      setDeletedMethodSteps({});
      await loadProject();
    } catch {
      await loadProject();
    } finally {
      if (manageBusy) setBusy(null);
    }
  };

  const runFeasibility = async () => {
    setBusy("feasibility");
    setError(null);

    try {
      const response = await fetch("/api/feasibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        error?: string;
        result?: FeasibilityResult;
      };

      if (!response.ok || !payload?.success || !payload.result) {
        throw new Error(payload?.error || "Feasibility check failed.");
      }

      await loadProject();
      if (payload.result.feasible === "yes") {
        setBusy("method");
        await runMethod({ manageBusy: false });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feasibility check failed.");
    } finally {
      setBusy(null);
    }
  };

  const runTerminal = async () => {
    const prompt = terminalInput.trim();
    if (!prompt || terminalBusy) return;
    setTerminalBusy(true);
    setTerminalMessages((prev) => [...prev, { role: "user", text: prompt }]);
    setTerminalInput("");
    try {
      const response = await fetch("/api/method-terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt }),
      });
      const payload = (await response.json()) as { success?: boolean; reply?: string; error?: string };
      const reply = payload?.reply?.trim();
      if (!response.ok || !payload?.success || !reply) {
        throw new Error(payload?.error || "Terminal request failed.");
      }
      setTerminalMessages((prev) => [...prev, { role: "assistant", text: reply }]);
    } catch (e) {
      setTerminalMessages((prev) => [
        ...prev,
        { role: "assistant", text: e instanceof Error ? e.message : "Terminal request failed." },
      ]);
    } finally {
      setTerminalBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-10 text-md text-zinc-500">
        Loading project...
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-10 text-sm text-red-700">
        Failed to load project.
      </div>
    );
  }

  const hasLgtm = project.feasibility_status === "yes";
  const feasibilityReason = project.feasibility_result_json?.reason?.trim();
  const feasibilityStatusMessage =
    project.feasibility_status === "no"
      ? `Feasibility failed: ${feasibilityReason || "This does not look like a research paper."}`
      : project.feasibility_status === "unclear"
        ? `Feasibility unclear: ${feasibilityReason || "Could not confidently assess this paper."}`
        : null;
  const showInsightsColumn = methodData.insights.length > 0;
  const assumptionsScore =
    methodData.assumptions.reduce((total, item) => total + item.length, 0) +
    methodData.assumptions.length * 24;
  const insightsScore =
    methodData.insights.reduce((total, item) => total + item.length, 0) +
    methodData.insights.length * 24;
  const showAssumptionsDeadzone =
    showInsightsColumn && assumptionsScore < insightsScore;
  const showInsightsDeadzone =
    showInsightsColumn && insightsScore < assumptionsScore;
  const isFeasibilityRunning = busy === "feasibility";
  const isMethodRunning = busy === "method" || project.method_status === "running";
  const isPipelineRunning = isFeasibilityRunning || isMethodRunning;
  const pipelineStateText = isFeasibilityRunning
    ? "checking feasibility"
    : isMethodRunning
      ? "generating method"
      : project.method_status === "ready"
        ? "method ready for evals"
        : hasLgtm
          ? "ready to generate method"
          : "awaiting feasibility";
  const pipelinePrefix = isPipelineRunning
    ? ASCII_FRAMES[asciiFrameIndex]
    : project.method_status === "ready"
      ? "[ready]"
      : hasLgtm
        ? "[next]"
        : "[wait]";
  const methodSummaryLine = (() => {
    if (project.method_status !== "ready") return pipelineStateText;
    const stepLabels = methodData.methodSteps
      .map((step) => step.text.split(":")[0]?.trim())
      .filter((label): label is string => Boolean(label && label.length > 0));

    if (stepLabels.length > 0) {
      const head = stepLabels.slice(0, 3).join(" -> ");
      const verifier =
        stepLabels.find((label) => /\bverify|validate|check|test\b/i.test(label)) ??
        stepLabels[stepLabels.length - 1];
      const summary = `${head}${verifier && verifier !== stepLabels[2] ? ` -> ${verifier}` : ""}.`;
      return summary;
    }

    const allText = [
      ...methodData.methodSteps.map((step) => step.text),
      ...methodData.assumptions,
      ...methodData.insights,
    ].join(" ");
    const hasChannelRates = /(33%|66%|99%|channel|corruption|reliability)/i.test(allText);
    const hasPartitioning = /(partition|leaf size|leaf|merkle)/i.test(allText);
    const hasOptimization = /(optimal|optimi[sz]|minimi[sz])/i.test(allText);

    if (hasChannelRates && hasPartitioning && hasOptimization) {
      return "Find optimal partitions across 33%, 66%, and 99% channel reliability.";
    }
    if (hasPartitioning && hasOptimization) {
      return "Optimize partition size to minimize end-to-end verification time.";
    }
    if (hasOptimization) {
      return "Method is ready: optimize for lower verification overhead.";
    }
    return "Method extracted and ready for evaluation.";
  })();
  const toggleDeletedMethodStep = (key: string) => {
    setDeletedMethodSteps((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const handleTabChange = (tab: AppTab) => {
    setActiveTab(tab);
    if (tab === "method" && hasLgtm && project.method_status === "idle" && busy !== "method") {
      void runMethod();
    }
  };

  const buildMethodTextForEval = () => {
    const lines: string[] = [];

    if (methodData.methodSteps.length > 0) {
      lines.push("Method steps:");
      methodData.methodSteps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.text}`);
      });
      lines.push("");
    }

    if (methodData.assumptions.length > 0) {
      lines.push("Assumptions:");
      methodData.assumptions.forEach((assumption, index) => {
        lines.push(`- ${assumption}`);
      });
      lines.push("");
    }

    if (methodData.insights.length > 0) {
      lines.push("Insights:");
      methodData.insights.forEach((insight, index) => {
        lines.push(`- ${insight}`);
      });
    }

    return lines.join("\n").trim();
  };

  const runEvalPipeline = async () => {
    if (!primaryFile) {
      console.warn("[eval-ui] Primary PDF is required to run evals.");
      return;
    }
    if (project.method_status !== "ready") {
      console.warn("[eval-ui] Methodology must be generated before running evals.");
      return;
    }

    setEvalBusy(true);
    setResultsAnalysis(null);

    try {
      const paperText = primaryFile.extracted_text;
      const methodText = buildMethodTextForEval();

      const response = await fetch("/api/eval/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task:
            "Recreate the Python code that implements the paper's main method and experiments, and run it to check whether the same conclusions hold.",
          paperText,
          methodText: methodText || undefined,
          maxIterations: 5,
          defaultLanguage: "python3",
          requireSufficientOutput: true,
        }),
      });

      const payload = (await response.json()) as {
        success?: boolean;
        error?: string;
        result?: EvalAgentResult;
      };

      if (!response.ok || !payload?.success || !payload.result) {
        throw new Error(payload?.error || "Eval pipeline failed.");
      }

      setLastEvalResult(payload.result);
      console.log("[eval-ui] Eval agent result:", payload.result);
    } catch (e) {
      console.error(
        "[eval-ui] Eval pipeline failed:",
        e instanceof Error ? e.message : "Eval pipeline failed."
      );
    } finally {
      setEvalBusy(false);
    }
  };

  const runResultsAnalysis = async () => {
    if (!primaryFile || !lastEvalResult) return;
    const replicationOutput =
      lastEvalResult.success ? lastEvalResult.finalOutput : lastEvalResult.lastError;

    setResultsAnalysisBusy(true);
    setResultsAnalysis(null);
    try {
      const response = await fetch("/api/eval/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paperText: primaryFile.extracted_text,
          methodAssumptions: methodData.assumptions,
          methodInsights: methodData.insights,
          methodSteps: methodData.methodSteps.map((s) => s.text),
          replicationOutput,
        }),
      });

      const payload = (await response.json()) as {
        success?: boolean;
        error?: string;
        analysis?: string;
      };

      if (!response.ok || !payload?.success || !payload.analysis) {
        throw new Error(payload?.error || "Results analysis failed.");
      }

      setResultsAnalysis(payload.analysis);
    } catch (e) {
      setResultsAnalysis(e instanceof Error ? e.message : "Results analysis failed.");
    } finally {
      setResultsAnalysisBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <AppTopbar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onNewPaperClick={() => router.push("/")}
          newPaperDisabled={Boolean(busy)}
          pastPaperOptions={recentOptions}
          pastPaperValue={projectId ?? ""}
          onPastPaperSelect={(nextProjectId) => {
            if (!nextProjectId) return;
            router.push(`/${nextProjectId}`);
          }}
        />

        <section className="mt-20 flex justify-center">
          {activeTab === "overview" && (
            <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
              <div className="flex justify-between gap-4 border-b border-zinc-200 pb-6">
                <div>
                  <div className="flex items-center gap-2 text-md font-medium text-zinc-900">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4 text-zinc-600"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
                    </svg>
                    Select papers to upload
                  </div>
                  <p className="pl-6 text-xs text-zinc-500">Start with one primary PDF, you can add more later.</p>
                </div>
                <button
                  type="button"
                  className="h-max rounded cursor-pointer border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
                  aria-label="Upload paper"
                  onClick={() => subPdfInputRef.current?.click()}
                >
                  Upload paper
                </button>
              </div>

              <div className="mt-2 flex w-full flex-col gap-4">
                {project.files.length > 0 && (
                  <div>
                    {project.files.map((file, index) => {
                      const modifiedAt = new Date(file.uploaded_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      });
                      return (
                        <div
                          key={file.id}
                          className="flex items-start justify-between gap-4 border-b border-zinc-200 py-4 text-sm text-zinc-700 last:border-b-0"
                        >
                          <div className="min-w-0 flex flex-1 items-start gap-2">
                            <span className="shrink-0 font-mono text-sm text-zinc-500">{index + 1}.</span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-zinc-900">{file.original_filename}</p>
                              <div className="mt-1 flex items-center gap-2 text-xs">
                                <p className="min-w-0 truncate text-zinc-500">
                                  PDF of size {formatFileSize(file.size_bytes)} uploaded {modifiedAt}
                                  {file.page_count ? ` has ${file.page_count} pages` : ""}
                                </p>
                                {file.processing_status === "ready" && (
                                  <span className="inline-flex items-center gap-1 text-emerald-700">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M5 12l5 5L19 7"
                                      />
                                    </svg>
                                    Ready
                                  </span>
                                )}
                                {file.processing_status === "failed" && (
                                  <span className="text-red-700">Failed</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            <button
                              type="button"
                              className="cursor-pointer px-1 py-0.5 text-xs font-medium text-zinc-500 underline-offset-4 transition hover:text-zinc-900 hover:underline"
                              onClick={() => setPreviewFileId(file.id)}
                            >
                              Preview text
                            </button>
                            <button
                              type="button"
                              className="cursor-pointer rounded p-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label={`Delete ${file.original_filename}`}
                              disabled={file.is_primary || busy === "delete"}
                              onClick={() => {
                                if (file.is_primary) return;
                                const shouldDelete = window.confirm(
                                  "Are you sure you want to delete this paper?"
                                );
                                if (!shouldDelete) return;
                                void deleteSubFile(file.id);
                              }}
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="h-4 w-4"
                                aria-hidden="true"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 6V4h8v2" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 6l-1 14H6L5 6" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14 11v6" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <label
                  htmlFor="subpdf-upload"
                  className="flex min-h-48 w-full cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-zinc-300 bg-white text-center text-sm text-zinc-500 transition hover:bg-zinc-50/30"
                >
                  <div className="flex h-6 w-6 items-center justify-center text-zinc-400">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-6 w-6"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 16v-7m0 0 3 3m-3-3-3 3M5 17.5v1.75A1.75 1.75 0 0 0 6.75 21h10.5A1.75 1.75 0 0 0 19 19.25V17.5"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-base font-medium text-zinc-700">Drop in a paper or click to select.</div>
                    <p className="text-sm text-zinc-500">PDF only, up to 10MB.</p>
                  </div>
                  <input
                    ref={subPdfInputRef}
                    id="subpdf-upload"
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    disabled={Boolean(busy)}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (!file) return;
                      void uploadFile(file, "add_subpdf");
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 max-w-[72ch] flex-1 text-xs">
                  <p className="text-zinc-500">Upload other relevant documents like datasets, up to 10MB.</p>
                  {busy === "method" && <p className="mt-1 text-amber-700">Generating method...</p>}
                  {feasibilityStatusMessage && (
                    <p
                      className={`mt-1 ${project.feasibility_status === "no" ? "text-red-700" : "text-amber-700"
                        }`}
                    >
                      {feasibilityStatusMessage}
                    </p>
                  )}
                  {error && <p className="mt-1 text-red-700">Failed: {error}</p>}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-3">
                  {hasLgtm && (
                    <p className="inline-flex items-center gap-1 text-xs font-medium text-zinc-800 px-2">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L19 7" />
                      </svg>
                      Looks feasible to me.
                    </p>
                  )}
                  <button
                    type="button"
                    className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      if (hasLgtm) {
                        setActiveTab("method");
                        if (project.method_status === "idle" && busy !== "method") {
                          void runMethod();
                        }
                        return;
                      }
                      void runFeasibility();
                    }}
                    disabled={!primaryFile || Boolean(busy)}
                  >
                    {busy === "method"
                      ? "Generating method..."
                      : busy === "feasibility"
                        ? "Checking feasibility..."
                        : hasLgtm
                          ? "Continue to method"
                          : "Check feasibility"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "method" && (
            <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 pb-4">
                <div>
                  <div className="flex items-center gap-2 text-md font-medium text-zinc-900">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4 text-zinc-600"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6h11" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h11" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 18h11" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h.01" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h.01" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 18h.01" />
                    </svg>
                    Methodology
                  </div>
                  <p className="pl-6 text-xs text-zinc-500">Generated from your primary PDF&apos;s method.</p>
                </div>
                <button
                  type="button"
                  className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void runMethod()}
                  disabled={!hasLgtm || Boolean(busy) || project.method_status === "running"}
                >
                  {busy === "method" || project.method_status === "running"
                    ? "Generating method..."
                    : project.method_status === "ready"
                      ? "Regenerate method"
                      : "Generate methodology"}
                </button>
              </div>

              <div className="mt-4 space-y-4">
                <form
                  className="flex h-10 items-center gap-3 border border-zinc-200 bg-zinc-50 px-2 font-mono text-xs"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runTerminal();
                  }}
                >
                  <span
                    className={`${isPipelineRunning || project.method_status === "ready"
                      ? "bg-amber-300 text-zinc-900"
                      : "text-zinc-500"
                      }`}
                  >
                    {pipelinePrefix}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-zinc-600">
                    {methodSummaryLine}
                  </span>
                  {project.method_status === "ready" && (
                    <button
                      type="button"
                      className="cursor-pointer rounded border border-zinc-200 bg-white px-2 py-1 text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
                      onClick={() => {
                        setTerminalDrawerOpen(true);
                        setTerminalMessages((prev) =>
                          prev.length > 0 ? prev : [{ role: "assistant", text: methodSummaryLine }]
                        );
                      }}
                    >
                      Ask
                    </button>
                  )}
                </form>
                {project.method_status === "failed" && (
                  <p className="text-sm text-red-700">
                    Failed: {project.method_error || "Method generation failed."}
                  </p>
                )}
                {project.method_status === "idle" && (
                  hasLgtm ? null : (
                    <div className="flex flex-col flex-wrap gap-3">
                      <p className="text-sm text-zinc-500">Feasibility must pass before method synthesis.</p>
                      <button
                        type="button"
                        className="cursor-pointer bg-amber-300 w-max px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void runFeasibility()}
                        disabled={!primaryFile || busy === "feasibility" || busy === "method"}
                      >
                        {busy === "feasibility" ? "Checking feasibility..." : "Check feasibility"}
                      </button>
                    </div>
                  )
                )}
                {project.method_status === "ready" && (
                  <div className="">
                    <section>
                      <ol className="divide-y divide-zinc-200 border-b border-zinc-200 text-sm">
                        {methodData.methodSteps.length === 0 && (
                          <li className="py-2.5 text-zinc-500">No actionable steps were extracted.</li>
                        )}
                        {methodData.methodSteps.map((step, index) => {
                          const itemKey = `method-${index}-${step.text}`;
                          if (deletedMethodSteps[itemKey]) return null;
                          return (
                            <li key={itemKey} className="group relative py-2.5">
                              <div className="flex min-w-0 items-baseline gap-3">
                                <span className="font-mono text-xs text-zinc-500">{index + 1}.</span>
                                <span className="block min-w-0 leading-7">{renderHighlightedLine(step.text)}</span>
                              </div>
                              <button
                                type="button"
                                className="pointer-events-none cursor-pointer absolute right-0 top-2 rounded border border-zinc-200 bg-white/70 hover:bg-white/90 px-2.5 py-1 text-xs font-medium text-zinc-600 opacity-0 transition hover:border-zinc-300 hover:text-zinc-900 group-hover:pointer-events-auto group-hover:opacity-100"
                                onClick={() => toggleDeletedMethodStep(itemKey)}
                              >
                                Delete step
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    </section>

                    <div className={`mt-6 grid gap-0 border border-zinc-200 ${showInsightsColumn ? "md:grid-cols-2" : ""}`}>
                      <section className="flex h-full flex-col md:border-r md:border-zinc-200">
                        <div className="flex items-center justify-between gap-3 p-4">
                          <div>
                            <div className="text-sm font-medium text-zinc-700">Assumptions</div>
                            <p className="mt-0.5 text-xs text-zinc-500">
                              Conditions assumed to be true.
                            </p>
                          </div>
                          <div className="text-xs font-medium tracking-wide text-zinc-500">
                            {methodData.assumptions.length} items
                          </div>
                        </div>
                        <ol className="divide-y divide-zinc-200 border-t border-zinc-200 text-sm">
                          {methodData.assumptions.length === 0 && (
                            <li className="px-4 py-2.5 text-zinc-500">No assumptions were extracted.</li>
                          )}
                          {methodData.assumptions.map((assumption, index) => (
                            <li key={`${assumption}-${index}`} className="flex items-baseline gap-3 bg-white px-4 py-2.5">
                              <span className="font-mono text-xs text-zinc-500">{index + 1}.</span>
                              <span className="block min-w-0 leading-6">{renderHighlightedLine(assumption)}</span>
                            </li>
                          ))}
                        </ol>
                        {showAssumptionsDeadzone && (
                          <div
                            className="flex-1 border-t border-zinc-200 bg-zinc-50"
                            style={{
                              backgroundImage:
                                "repeating-linear-gradient(135deg, rgba(228,228,231,1) 0, rgba(228,228,231,1) 1px, transparent 1px, transparent 18px)",
                            }}
                          />
                        )}
                      </section>

                      {showInsightsColumn && (
                        <section className="flex h-full flex-col">
                          <div className="flex items-center justify-between gap-3 p-4">
                            <div>
                              <div className="text-sm font-medium text-zinc-700">Insights</div>
                              <p className="mt-0.5 text-xs text-zinc-500">
                                Things worth noting.
                              </p>
                            </div>
                            <div className="text-xs font-medium tracking-wide text-zinc-500">
                              {methodData.insights.length} items
                            </div>
                          </div>
                          <ol className="divide-y divide-zinc-200 border-t border-zinc-200 text-sm">
                            {methodData.insights.map((insight, index) => (
                              <li key={`${insight}-${index}`} className="flex items-baseline gap-3 bg-white px-4 py-2.5">
                                <span className="font-mono text-xs text-zinc-500">{index + 1}.</span>
                                <span className="block min-w-0 leading-6">{renderHighlightedLine(insight)}</span>
                              </li>
                            ))}
                          </ol>
                          {showInsightsDeadzone && (
                            <div
                              className="flex-1 border-t border-zinc-200 bg-zinc-50"
                              style={{
                                backgroundImage:
                                  "repeating-linear-gradient(135deg, rgba(228,228,231,1) 0, rgba(228,228,231,1) 1px, transparent 1px, transparent 18px)",
                              }}
                            />
                          )}
                        </section>
                      )}
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 mt-4"
                        onClick={() => setActiveTab("evals")}
                      >
                        Continue to evals
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {(activeTab === "evals" || activeTab === "results") && (
            <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
              <div className="border-b border-zinc-200 pb-4 text-sm font-medium text-zinc-900">
                {activeTab === "evals" ? "Evals" : "Results"}
              </div>

              {activeTab === "evals" && (
                <div className="mt-6 space-y-4 text-sm">
                  <p className="text-zinc-500">
                    Run the replication agent to generate Python code from the paper and methodology,
                    execute it in a sandbox, and capture the results.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void runEvalPipeline()}
                      disabled={
                        evalBusy ||
                        !primaryFile ||
                        project.method_status !== "ready" ||
                        busy !== null
                      }
                    >
                      {evalBusy ? "Running replication agent..." : "Run replication agent"}
                    </button>
                    {!evalBusy && lastEvalResult !== null && (
                      <button
                        type="button"
                        className="cursor-pointer border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                        onClick={() => setActiveTab("results")}
                      >
                        Go to results
                      </button>
                    )}
                  </div>
                  {project.method_status !== "ready" && (
                    <p className="text-xs text-zinc-500">
                      Generate methodology first, then run evals.
                    </p>
                  )}
                </div>
              )}

              {activeTab === "results" && (
                <div className="mt-6 space-y-4">
                  {!lastEvalResult && (
                    <p className="text-sm text-zinc-500">
                      No eval run yet. Run the replication agent in the Evals tab to generate and execute code.
                    </p>
                  )}

                  {lastEvalResult && (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          className="cursor-pointer border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => setActiveTab("evals")}
                        >
                          Back to evals
                        </button>
                        <button
                          type="button"
                          className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => void runResultsAnalysis()}
                          disabled={resultsAnalysisBusy || evalBusy || busy !== null}
                        >
                          {resultsAnalysisBusy ? "Analyzing..." : "Analyze alignment"}
                        </button>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium text-zinc-900">Replication output</p>
                        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-800">
                          {lastEvalResult.success
                            ? lastEvalResult.finalOutput
                            : lastEvalResult.lastError}
                        </pre>
                      </div>

                      {resultsAnalysis && (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-zinc-900">LLM comparison</p>
                          <pre className="whitespace-pre-wrap break-words border border-zinc-200 bg-white p-3 text-xs leading-5 text-zinc-700">
                            {resultsAnalysis}
                          </pre>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {terminalDrawerOpen && (
        <>
          <button
            type="button"
            aria-label="Close ask drawer"
            className="fixed inset-0 z-20 bg-black/30"
            onClick={() => {
              setTerminalDrawerOpen(false);
              setTerminalInput("");
            }}
          />
          <aside className="fixed right-0 top-0 z-30 flex h-screen w-full max-w-lg flex-col border-l border-zinc-200 bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900">Ask about method</p>
                <p className="mt-1 text-xs text-zinc-500">Short answers, with history.</p>
              </div>
              <button
                type="button"
                className="cursor-pointer px-1 py-0.5 text-xs font-medium text-zinc-500 underline-offset-4 hover:text-zinc-900 hover:underline"
                onClick={() => {
                  setTerminalDrawerOpen(false);
                  setTerminalInput("");
                }}
              >
                Close
              </button>
            </div>
            <div
              ref={terminalScrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-zinc-50 px-5 py-4"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(135deg, rgba(228,228,231,1) 0, rgba(228,228,231,1) 1px, transparent 1px, transparent 18px)",
              }}
            >
              {terminalMessages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={message.role === "user" ? "flex justify-end" : ""}>
                  <div
                    className={`max-w-[82%] border px-3 py-2 font-mono text-xs ${
                      message.role === "assistant"
                        ? "border-zinc-200 bg-white text-zinc-700"
                        : "border-zinc-300 bg-white text-zinc-900"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">
                      <span className="mr-2 text-zinc-500">
                        {message.role === "assistant" ? assistantMessageTag(message.text) : "[q]"}
                      </span>
                      {message.text}
                    </p>
                  </div>
                </div>
              ))}
              {terminalBusy && (
                <div className="border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-700">
                  <span className="mr-2 bg-amber-300 text-zinc-900">[run]</span>
                  thinking...
                </div>
              )}
            </div>
            <form
              className="mt-auto border-t border-zinc-200 px-5 py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void runTerminal();
              }}
            >
              <label className="flex h-10 items-center gap-2 border border-zinc-200 bg-white px-2 font-mono text-xs">
                <span className="text-zinc-500">&gt;</span>
                <input
                  value={terminalInput}
                  onChange={(event) => setTerminalInput(event.target.value)}
                  placeholder="Ask anything"
                  className="w-full min-w-0 bg-transparent text-zinc-700 outline-none placeholder:text-zinc-400"
                  maxLength={140}
                  disabled={terminalBusy}
                  autoFocus
                />
              </label>
            </form>
          </aside>
        </>
      )}

      {previewFile && (
        <>
          <button
            type="button"
            aria-label="Close preview"
            className="fixed inset-0 z-20 bg-black/30"
            onClick={() => setPreviewFileId(null)}
          />
          <aside className="fixed right-0 top-0 z-30 flex h-screen w-full max-w-2xl flex-col border-l border-zinc-200 bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900">{previewFile.original_filename}</p>
                <p className="mt-1 text-xs text-zinc-500">{previewFile.page_count} pages extracted</p>
              </div>
              <button
                type="button"
                className="cursor-pointer px-1 py-0.5 text-xs font-medium text-zinc-500 underline-offset-4 hover:text-zinc-900 hover:underline"
                onClick={() => setPreviewFileId(null)}
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-zinc-700">
                {previewFile.extracted_text}
              </pre>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
