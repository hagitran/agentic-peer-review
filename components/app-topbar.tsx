"use client";

type AppTab = "overview" | "method" | "evals" | "results";

type AppTopbarProps = {
  activeTab: AppTab;
  onTabChange?: (tab: AppTab) => void;
  onNewPaperClick?: () => void;
  newPaperDisabled?: boolean;
  pastPaperOptions?: Array<{ value: string; label: string }>;
  pastPaperValue?: string;
  onPastPaperSelect?: (projectId: string) => void;
};

const TABS: AppTab[] = ["overview", "method", "evals", "results"];

export function AppTopbar({
  activeTab,
  onTabChange,
  onNewPaperClick,
  newPaperDisabled = false,
  pastPaperOptions = [],
  pastPaperValue = "",
  onPastPaperSelect,
}: AppTopbarProps) {
  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-zinc-500">Review your research</p>
          <h1 className="text-2xl font-medium text-zinc-900">Papers</h1>
        </div>
        <div className="flex items-center gap-2">
          {pastPaperOptions.length > 0 ? (
            <div className="relative min-w-[180px]">
              <select
                aria-label="Past papers"
                className="h-9 w-48 appearance-none truncate cursor-pointer border border-zinc-200 bg-white px-3 pr-9 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-200"
                value={pastPaperValue}
                onChange={(event) => onPastPaperSelect?.(event.target.value)}
              >
                <option value="/">Past papers</option>
                {pastPaperOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
              </svg>
            </div>
          ) : (
            <button className="h-9 border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900">
              Past papers
            </button>
          )}
          <button
            type="button"
            className={`h-9 bg-amber-300 px-3 text-xs cursor-pointer font-semibold text-zinc-900 transition hover:opacity-80 ${onNewPaperClick ? "cursor-pointer" : "cursor-default"
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
              className={`cursor-pointer border-b-2 pb-3 text-center capitalize transition hover:text-zinc-900 ${activeTab === tab ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-400"
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
