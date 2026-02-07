"use client";

import { useState } from "react";

type ProcessingStatus = "queued" | "extracting" | "ready" | "failed";

type ParsedPage = {
  pageNumber: number;
  text: string;
  lines: Array<{ y: number; text: string }>;
  segments: Array<{ x: number; y: number; text: string }>;
};

type SelectedPaper = {
  key: string;
  file: File;
  status: ProcessingStatus;
  pageCount?: number;
  extractedText?: string;
  pages?: ParsedPage[];
  extractionId?: string;
  error?: string;
};

type AppTab = "overview" | "method" | "evals" | "results";
type FeasibilityStatus = "yes" | "no" | "unclear";

type FeasibilityResult = {
  feasible: FeasibilityStatus;
  reason: string;
  blockers: string[];
  confidence: number;
  evidence_snippets: string[];
};

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

function getFileKey(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export default function Home() {
  const [selectedFiles, setSelectedFiles] = useState<SelectedPaper[]>([]);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("overview");
  const [feasibilityLoading, setFeasibilityLoading] = useState(false);
  const [feasibilityError, setFeasibilityError] = useState<string | null>(null);
  const [feasibilityResult, setFeasibilityResult] = useState<FeasibilityResult | null>(null);
  const [feasibilityExtractionId, setFeasibilityExtractionId] = useState<string | null>(null);
  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  };
  const previewPaper =
    previewKey ? selectedFiles.find((item) => item.key === previewKey) ?? null : null;
  const latestReadyPaper = [...selectedFiles]
    .reverse()
    .find((paper) => paper.status === "ready" && paper.extractionId);
  const latestReadyExtractionId = latestReadyPaper?.extractionId ?? null;
  const isCurrentFeasibilityResult =
    Boolean(feasibilityResult) && feasibilityExtractionId === latestReadyExtractionId;
  const hasFeasibilityPass =
    isCurrentFeasibilityResult && feasibilityResult?.feasible === "yes";

  const onExtract = async (paperKey: string) => {
    const selectedPaper = selectedFiles.find((item) => item.key === paperKey);
    if (
      !selectedPaper ||
      (selectedPaper.status !== "queued" && selectedPaper.status !== "failed")
    ) {
      return;
    }

    setSelectedFiles((prev) =>
      prev.map((item) =>
        item.key === paperKey
          ? { ...item, status: "extracting", error: undefined }
          : item
      )
    );

    try {
      const formData = new FormData();
      formData.append("file", selectedPaper.file);
      formData.append("lastModified", String(selectedPaper.file.lastModified));

      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });
      const raw = await response.text();
      let payload: {
        success?: boolean;
        error?: string;
        id?: string;
        text?: string;
        pageCount?: number;
        pages?: ParsedPage[];
      } | null = null;

      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.success) {
        const fallback =
          raw.trim().startsWith("<")
            ? "Extraction endpoint returned HTML instead of JSON. Check server logs and DATABASE_URL."
            : raw;
        throw new Error(payload?.error || fallback || "Extraction failed.");
      }

      setSelectedFiles((prev) =>
        prev.map((item) =>
          item.key === paperKey
            ? {
              ...item,
              status: "ready",
              extractionId: payload.id,
              extractedText: payload.text,
              pageCount: payload.pageCount,
              pages: payload.pages,
              error: undefined,
            }
            : item
        )
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to extract text.";
      setSelectedFiles((prev) =>
        prev.map((item) =>
          item.key === paperKey
            ? { ...item, status: "failed", error: message }
            : item
        )
      );
    }
  };

  const onCheckFeasibility = async () => {
    if (!latestReadyExtractionId) return;

    setFeasibilityLoading(true);
    setFeasibilityError(null);

    try {
      const response = await fetch("/api/feasibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ extractionId: latestReadyExtractionId }),
      });

      const raw = await response.text();
      let payload: {
        success?: boolean;
        error?: string;
        result?: FeasibilityResult;
      } | null = null;

      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.success || !payload.result) {
        throw new Error(payload?.error || "Feasibility check failed.");
      }

      setFeasibilityExtractionId(latestReadyExtractionId);
      setFeasibilityResult(payload.result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Feasibility check failed.";
      setFeasibilityError(message);
    } finally {
      setFeasibilityLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-500">
              Review your research
            </p>
            <h1 className="text-2xl font-medium text-zinc-900">Papers</h1>
          </div>
          <div className="flex items-center gap-2">
            <button className="border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900">
              Past papers
            </button>
            <button className="bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 cursor-pointer">
              New paper
            </button>
          </div>
        </header>

        <div className="mt-6 border-b border-zinc-200">
          <nav className="flex flex-wrap gap-6 text-xs font-medium text-zinc-500">
            <button
              type="button"
              className={`cursor-pointer pb-3 transition hover:text-zinc-900 ${activeTab === "overview"
                ? "border-b-2 border-zinc-900 text-zinc-900"
                : ""
                }`}
              onClick={() => setActiveTab("overview")}
            >
              Overview
            </button>
            <button
              type="button"
              className={`cursor-pointer pb-3 transition hover:text-zinc-900 ${activeTab === "method"
                ? "border-b-2 border-zinc-900 text-zinc-900"
                : ""
                }`}
              onClick={() => setActiveTab("method")}
            >
              Method
            </button>
            <button
              type="button"
              className={`cursor-pointer pb-3 transition hover:text-zinc-900 ${activeTab === "evals"
                ? "border-b-2 border-zinc-900 text-zinc-900"
                : ""
                }`}
              onClick={() => setActiveTab("evals")}
            >
              Evals
            </button>
            <button
              type="button"
              className={`cursor-pointer pb-3 transition hover:text-zinc-900 ${activeTab === "results"
                ? "border-b-2 border-zinc-900 text-zinc-900"
                : ""
                }`}
              onClick={() => setActiveTab("results")}
            >
              Results
            </button>
          </nav>
        </div>

        <section className="mt-10 flex justify-center">
          {activeTab === "overview" && (
            <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
              <div className="flex items-center justify-between gap-4 border-b border-zinc-200 pb-4">
                <div className="flex items-center gap-2 text-md font-medium text-zinc-900">
                  <span className="flex h-4 w-4 items-center justify-center text-zinc-600">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      className="h-4 w-4"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 5v14m7-7H5"
                      />
                    </svg>
                  </span>
                  Select papers to upload
                </div>
                <button
                  type="button"
                  className="text-zinc-500 transition hover:text-zinc-700"
                  aria-label="Collapse"
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
                    <path strokeLinecap="round" strokeLinejoin="round" d="m6 15 6-6 6 6" />
                  </svg>
                </button>
              </div>

              <div className="mt-6 flex w-full flex-col gap-4">
                {selectedFiles.length > 0 && (
                  <div>
                    {selectedFiles.map((paper, index) => {
                      const fileType = paper.file.type
                        ? paper.file.type.replace("application/", "").toUpperCase()
                        : paper.file.name.split(".").pop()?.toUpperCase() ?? "PDF";
                      const modifiedAt = new Date(paper.file.lastModified).toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric", year: "numeric" }
                      );
                      return (
                        <div
                          key={paper.key}
                          className="flex items-start justify-between gap-4 border-b border-zinc-200 py-4 text-sm text-zinc-700 last:border-b-0"
                        >
                          <div className="min-w-0 flex flex-1 items-start gap-2">
                            <span className="shrink-0 font-mono text-sm text-zinc-500">
                              {index + 1}.
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-zinc-900">
                                {paper.file.name}
                              </p>
                              <div className="mt-1 flex items-center gap-2 text-xs">
                                <p className="min-w-0 truncate text-zinc-500">
                                  {fileType} of size {formatFileSize(paper.file.size)} uploaded {modifiedAt}
                                  {paper.pageCount ? ` has ${paper.pageCount} pages` : ""}
                                </p>
                                {paper.status === "ready" && (
                                  <span className="inline-flex shrink-0 items-center gap-1 text-emerald-700">
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
                                {paper.status === "failed" && (
                                  <span className="inline-flex max-w-[220px] shrink-0 items-center gap-1 truncate text-red-700">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      className="h-3.5 w-3.5 shrink-0"
                                      aria-hidden="true"
                                    >
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4" />
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 17h.01" />
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                                      />
                                    </svg>
                                    Failed{paper.error ? `: ${paper.error}` : ""}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            {(paper.status === "queued" ||
                              paper.status === "extracting" ||
                              paper.status === "failed") && (
                                <button
                                  type="button"
                                  className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                                  onClick={() => onExtract(paper.key)}
                                  disabled={paper.status === "extracting"}
                                >
                                  {paper.status === "extracting"
                                    ? "Extracting..."
                                    : paper.status === "failed"
                                      ? "Try again"
                                      : "Extract text"}
                                </button>
                              )}
                            {paper.status === "ready" && paper.extractedText && (
                              <button
                                type="button"
                                className="cursor-pointer px-1 py-0.5 text-xs font-medium text-zinc-500 underline-offset-4 transition hover:text-zinc-900 hover:underline"
                                onClick={() => setPreviewKey(paper.key)}
                              >
                                Preview text
                              </button>
                            )}
                            <button
                              type="button"
                              className="cursor-pointer rounded p-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                              aria-label={`Delete ${paper.file.name}`}
                              onClick={() => {
                                const shouldDelete = window.confirm(
                                  "Are you sure you want to delete this paper?"
                                );
                                if (!shouldDelete) return;

                                setSelectedFiles((prev) =>
                                  prev.filter((item) => item.key !== paper.key)
                                );
                                setPreviewKey((prev) => (prev === paper.key ? null : prev));
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
                  htmlFor="paper-pdf"
                  className="flex min-h-56 w-full cursor-pointer flex-col items-center justify-center gap-3 border border-zinc-200 bg-zinc-50 text-center text-sm text-zinc-500"
                >
                  <div className="flex h-6 w-6 items-center justify-center bg-zinc-50 text-zinc-400">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-8 w-8"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 16v-7m0 0 3 3m-3-3-3 3M5 17.5v1.75A1.75 1.75 0 0 0 6.75 21h10.5A1.75 1.75 0 0 0 19 19.25V17.5"
                      />
                    </svg>
                  </div>
                  <p className="text-md text-zinc-500">
                    Drop in a paper or click to select.
                  </p>
                  <input
                    id="paper-pdf"
                    name="paper-pdf"
                    type="file"
                    accept="application/pdf"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (!files.length) return;
                      setSelectedFiles((prev) => {
                        const existing = new Set(prev.map((paper) => paper.key));
                        const next = files.filter(
                          (file) => !existing.has(getFileKey(file))
                        );
                        const mapped = next.map((file) => {
                          const status: ProcessingStatus =
                            file.size > MAX_FILE_SIZE_BYTES ? "failed" : "queued";
                          return {
                            key: getFileKey(file),
                            file,
                            status,
                            error:
                              status === "failed"
                                ? "File exceeds 10MB limit."
                                : undefined,
                          };
                        });
                        return prev.concat(mapped);
                      });
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div className="text-xs">
                  <p className="text-zinc-500">
                    Upload paper as a PDF, it should be no more than 10MB.
                  </p>
                  {feasibilityLoading && (
                    <p className="mt-1 text-amber-700">Checking feasibility...</p>
                  )}
                  {!feasibilityLoading && feasibilityError && (
                    <p className="mt-1 text-red-700">Failed: {feasibilityError}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {hasFeasibilityPass && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-700 px-2">
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
                      Looks feasible to me
                    </span>
                  )}
                  <button
                    type="button"
                    className="cursor-pointer bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      if (hasFeasibilityPass) {
                        setActiveTab("method");
                        return;
                      }
                      void onCheckFeasibility();
                    }}
                    disabled={!latestReadyExtractionId || feasibilityLoading}
                  >
                    {hasFeasibilityPass ? "Continue to method" : "Check feasibility"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "method" && (
            <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
              <div className="border-b border-zinc-200 pb-4 text-md font-medium text-zinc-900">
                # Methodology
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <p className="text-sm text-zinc-700 sm:col-span-2">
                  To reconstruct the methodology for this paper we present a
                  few assumptions we synthesized.
                </p>
                {["Ceteris paribus", "Hello Jonah", "Hi Hagi how are you?", "I am good and you?", "I am good too, thanks for asking!", "This art was done by Hagi"].map((assumption, index) => (
                  <p
                    key={assumption}
                    className="w-full border bg-zinc-50 border-zinc-200 px-4 py-2 text-left text-xs text-zinc-700"
                  >
                    {index + 1}. {assumption}
                  </p>
                ))}
              </div>
            </div>
          )}

          {(activeTab === "evals" || activeTab === "results") && (
            <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
              <div className="border-b border-zinc-200 pb-4 text-md font-medium text-zinc-900">
                {activeTab === "evals" ? "% Evals" : "& Results"}
              </div>
              <p className="mt-6 text-sm text-zinc-500">
                This panel is ready for the next step.
              </p>
            </div>
          )}
        </section>
      </main>

      {previewPaper && (
        <>
          <button
            type="button"
            aria-label="Close preview"
            className="fixed inset-0 z-20 bg-black/30"
            onClick={() => setPreviewKey(null)}
          />
          <aside className="fixed right-0 top-0 z-30 flex h-screen w-full max-w-2xl flex-col border-l border-zinc-200 bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900">
                  {previewPaper.file.name}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {previewPaper.pageCount ?? 0} pages extracted
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 cursor-pointer px-1 py-0.5 text-xs font-medium text-zinc-500 underline-offset-4 transition hover:text-zinc-900 hover:underline"
                onClick={() => setPreviewKey(null)}
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <pre className="whitespace-pre-wrap wrap-break-word text-xs leading-5 text-zinc-700">
                {previewPaper.extractedText}
              </pre>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
