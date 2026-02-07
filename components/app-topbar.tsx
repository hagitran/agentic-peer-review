"use client";

type AppTab = "overview" | "method" | "evals" | "results";

type AppTopbarProps = {
  activeTab: AppTab;
  onTabChange?: (tab: AppTab) => void;
  onNewPaperClick?: () => void;
  newPaperDisabled?: boolean;
};

const TABS: AppTab[] = ["overview", "method", "evals", "results"];

export function AppTopbar({
  activeTab,
  onTabChange,
  onNewPaperClick,
  newPaperDisabled = false,
}: AppTopbarProps) {
  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-zinc-500">Review your research</p>
          <h1 className="text-2xl font-medium text-zinc-900">Papers</h1>
        </div>
        <div className="flex items-center gap-2">
          <button className="border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900">
            Past papers
          </button>
          <button
            type="button"
            className={`bg-amber-300 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:opacity-80 ${
              onNewPaperClick ? "cursor-pointer" : "cursor-default"
            } ${newPaperDisabled ? "cursor-not-allowed opacity-50" : ""}`}
            onClick={onNewPaperClick}
            disabled={newPaperDisabled}
          >
            New paper
          </button>
        </div>
      </header>

      <div className="mt-6 border-b border-zinc-200">
        <nav className="grid grid-cols-4 text-xs font-medium text-zinc-500">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`cursor-pointer border-b-2 pb-3 text-center capitalize transition hover:text-zinc-900 ${
                activeTab === tab ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-400"
              }`}
              onClick={() => onTabChange?.(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}
