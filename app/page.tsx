"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppTopbar } from "@/components/app-topbar";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const RECENT_PROJECTS_COOKIE = "apr_recent_projects";
const RECENT_PROJECTS_LIMIT = 12;

type RecentProject = {
  projectId: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  fileHash: string;
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

function persistRecentProjectsCookie(projects: RecentProject[]) {
  if (typeof document === "undefined") return;
  const trimmed = projects.slice(0, RECENT_PROJECTS_LIMIT);
  document.cookie = `${RECENT_PROJECTS_COOKIE}=${encodeURIComponent(JSON.stringify(trimmed))}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

async function hashFile(file: File) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function Home() {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [selectedRecentProjectId, setSelectedRecentProjectId] = useState("");

  useEffect(() => {
    setRecentProjects(readRecentProjectsCookie());
  }, []);

  const recentOptions = useMemo(
    () =>
      recentProjects.map((project) => ({
        ...project,
        label: `${truncateFilename(project.filename)} • ${formatFileSize(project.sizeBytes)} • ${new Date(project.uploadedAt).toLocaleDateString()}`,
      })),
    [recentProjects]
  );

  const upsertRecentProject = (entry: RecentProject) => {
    setRecentProjects((previous) => {
      const deduped = previous.filter(
        (item) => item.projectId !== entry.projectId && item.fileHash !== entry.fileHash
      );
      const next = [entry, ...deduped].slice(0, RECENT_PROJECTS_LIMIT);
      persistRecentProjectsCookie(next);
      return next;
    });
  };

  const onCreateProject = async (file: File) => {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError("File exceeds 10MB limit.");
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const fileHash = await hashFile(file);
      const existing = recentProjects.find(
        (item) =>
          item.filename === file.name &&
          item.sizeBytes === file.size &&
          item.fileHash === fileHash
      );

      if (existing?.projectId) {
        router.push(`/${existing.projectId}`);
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("lastModified", String(file.lastModified));
      formData.append("action", "create_project");

      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        success?: boolean;
        error?: string;
        projectId?: string;
      };

      if (!response.ok || !payload?.success || !payload.projectId) {
        throw new Error(payload?.error || "Failed to create project.");
      }

      upsertRecentProject({
        projectId: payload.projectId,
        filename: file.name,
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
        fileHash,
      });

      router.push(`/${payload.projectId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <AppTopbar
          activeTab="overview"
          pastPaperOptions={recentOptions.map((project) => ({
            value: project.projectId,
            label: project.label,
          }))}
          pastPaperValue={selectedRecentProjectId}
          onPastPaperSelect={(nextId) => {
            setSelectedRecentProjectId(nextId);
            if (!nextId) return;
            router.push(`/${nextId}`);
          }}
        />

        <section className="mt-24 flex justify-center">
          <div className="w-full max-w-3xl border border-zinc-200 bg-white px-6 py-6">
            <div className="flex justify-between gap-4 border-b border-zinc-200 pb-6">
              <div className="">
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
                  Select a paper to review
                </div>
                <p className="pl-6 text-xs text-zinc-500">Start with one primary PDF, you can add more later.</p>
              </div>
              <button
                type="button"
                className="rounded cursor-pointer border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 h-max"
                aria-label="Upload paper"
                onClick={() => document.getElementById("project-pdf")?.click()}
              >
                Upload paper
              </button>
            </div>

            <div className="mt-6 flex w-full flex-col gap-4">
              <label
                htmlFor="project-pdf"
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
                  <div className="text-base font-medium text-zinc-700">
                    {uploading ? "Creating project..." : "Drop in a paper or click to select."}
                  </div>
                  <p className="text-sm text-zinc-500">PDF only, up to 10MB.</p>
                </div>
                <input
                  id="project-pdf"
                  name="project-pdf"
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    void onCreateProject(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
            {error && (
              <div className="mt-5 text-xs">
                <p className="text-red-700">Failed: {error}</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
