"use client";

import { useParams } from "next/navigation";
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

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function renderHighlightedLine(text: string) {
  const antiWidow = (value: string) => {
    const trimmed = value.trim();
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace <= 0) return trimmed;
    return `${trimmed.slice(0, lastSpace)}\u00A0${trimmed.slice(lastSpace + 1)}`;
  };

  const [label, ...rest] = text.split(":");
  if (rest.length === 0) return <span>{antiWidow(text)}</span>;
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

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const subPdfInputRef = useRef<HTMLInputElement | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AppTab>("overview");
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deletedMethodSteps, setDeletedMethodSteps] = useState<Record<string, boolean>>({});

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feasibility check failed.");
    } finally {
      setBusy(null);
    }
  };

  const runMethod = async () => {
    setBusy("method");

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
      setBusy(null);
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
  const toggleDeletedMethodStep = (key: string) => {
    setDeletedMethodSteps((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const handleTabChange = (tab: AppTab) => {
    setActiveTab(tab);
    if (tab === "method" && hasLgtm && project.method_status === "idle" && busy !== "method") {
      void runMethod();
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <AppTopbar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onNewPaperClick={() => replaceInputRef.current?.click()}
          newPaperDisabled={Boolean(busy)}
        />
        <input
          ref={replaceInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            void uploadFile(file, "replace_primary");
            event.currentTarget.value = "";
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

              <div className="mt-4 flex items-center justify-between gap-4">
                <div className="text-xs">
                  <p className="text-zinc-500">Upload other relevant documents like datasets, up to 10MB.</p>
                  {busy === "method" && <p className="mt-1 text-amber-700">Generating method...</p>}
                  {error && <p className="mt-1 text-red-700">Failed: {error}</p>}
                </div>
                <div className="flex items-center gap-3">
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
                    disabled={!primaryFile || busy === "feasibility" || busy === "method"}
                  >
                    {busy === "feasibility"
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
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 pb-5">
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
                    Method
                  </div>
                  <p className="pl-6 text-xs text-zinc-500">Generated from your primary PDF after feasibility.</p>
                </div>
                <button
                  type="button"
                  className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void runMethod()}
                  disabled={!hasLgtm || busy === "method" || project.method_status === "running"}
                >
                  {busy === "method" || project.method_status === "running"
                    ? "Generating method..."
                    : project.method_status === "ready"
                      ? "Regenerate method"
                      : "Generate methodology"}
                </button>
              </div>

              <div className="space-y-5">
                {project.method_status === "running" && (
                  <p className="text-sm text-zinc-500">Generating method...</p>
                )}
                {project.method_status === "failed" && (
                  <p className="text-sm text-red-700">
                    Failed: {project.method_error || "Method generation failed."}
                  </p>
                )}
                {project.method_status === "idle" && (
                  <p className="text-sm text-zinc-500">
                    {hasLgtm ? "Generating method..." : "Feasibility must pass before method synthesis."}
                  </p>
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

                    <div className={`grid gap-5 ${methodData.insights.length > 0 ? "md:grid-cols-2" : ""}`}>
                      <section>
                        <div className="mt-6 mb-2 flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-zinc-700">
                            Assumptions
                          </div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                            {methodData.assumptions.length} items
                          </div>
                        </div>
                        <ol className="divide-y divide-zinc-200 border-y border-zinc-200 text-sm">
                          {methodData.assumptions.length === 0 && (
                            <li className="py-2.5 text-zinc-500">No assumptions were extracted.</li>
                          )}
                          {methodData.assumptions.map((assumption, index) => (
                            <li key={`${assumption}-${index}`} className="flex items-baseline gap-3 py-2.5">
                              <span className="font-mono text-xs text-zinc-500">{index + 1}.</span>
                              <span className="block min-w-0 leading-6">{renderHighlightedLine(assumption)}</span>
                            </li>
                          ))}
                        </ol>
                      </section>

                      {methodData.insights.length > 0 && (
                        <section className="md:border-l md:border-zinc-200 md:pl-5">
                          <div className="mt-6 mb-2 flex items-center justify-between gap-3">
                            <div className="text-sm font-medium text-zinc-700">
                              Insights
                            </div>
                            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                              {methodData.insights.length} items
                            </div>
                          </div>
                          <ol className="divide-y divide-zinc-200 border-y border-zinc-200 text-sm">
                            {methodData.insights.map((insight, index) => (
                              <li key={`${insight}-${index}`} className="flex items-baseline gap-3 py-2.5">
                                <span className="font-mono text-xs text-zinc-500">{index + 1}.</span>
                                <span className="block min-w-0 leading-6">{renderHighlightedLine(insight)}</span>
                              </li>
                            ))}
                          </ol>
                        </section>
                      )}
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
              <p className="mt-6 text-sm text-zinc-500">This panel is ready for the next step.</p>
            </div>
          )}
        </section>
      </main>

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
