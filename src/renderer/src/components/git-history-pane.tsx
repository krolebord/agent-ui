import type { FileDiffMetadata } from "@pierre/diffs/react";
import { FileDiff } from "@pierre/diffs/react";
import { COMPACT_FILE_DIFF_OPTIONS } from "@renderer/components/diff-pane-styles";
import {
  DiffViewModeToggle,
  useDiffViewMode,
} from "@renderer/components/diff-view-mode";
import { useCopyToClipboard } from "@renderer/hooks/use-copy-to-clipboard";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import type { GitHistoryCommit } from "@shared/claude-types";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  Copy,
  FileMinus,
  FilePlus,
  FileText,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  RefreshCw,
  Tag,
} from "lucide-react";
import { createContext, useContext, useMemo, useRef } from "react";
import { toast } from "sonner";
import { createStore, type ExtractState } from "zustand";
import { combine } from "zustand/middleware";
import { useStore } from "zustand/react";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";

const RELATIVE_TIME_DIVISIONS: Array<{
  amount: number;
  unit: Intl.RelativeTimeFormatUnit;
}> = [
  { amount: 60, unit: "seconds" },
  { amount: 60, unit: "minutes" },
  { amount: 24, unit: "hours" },
  { amount: 7, unit: "days" },
  { amount: 4.34524, unit: "weeks" },
  { amount: 12, unit: "months" },
  { amount: Number.POSITIVE_INFINITY, unit: "years" },
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function formatRelativeTime(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  let duration = (timestamp - Date.now()) / 1000;
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeTimeFormatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "";
}

function formatAbsoluteTime(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return isoDate;
  }
  return new Date(timestamp).toLocaleString();
}

function commitTags(commit: GitHistoryCommit): string[] {
  return commit.refs
    .filter((ref) => ref.startsWith("tag: "))
    .map((ref) => ref.slice("tag: ".length));
}

function fileTypeIcon(file: FileDiffMetadata) {
  if (file.type === "new") return FilePlus;
  if (file.type === "deleted") return FileMinus;
  return FileText;
}

function fileDiffLineStats(file: FileDiffMetadata) {
  return {
    additions: file.hunks.reduce((sum, h) => sum + h.additionLines, 0),
    deletions: file.hunks.reduce((sum, h) => sum + h.deletionLines, 0),
  };
}

function createGitHistoryStore(projectPath: string) {
  return createStore(
    combine(
      {
        projectPath,
        selectedCommitHash: null as string | null,
        selectedFilePath: null as string | null,
        commitsSize: 260 as number | string,
        filesSize: 220 as number | string,
      },
      (set) => ({
        selectCommit: (hash: string) => {
          set({ selectedCommitHash: hash, selectedFilePath: null });
        },
        selectFile: (filePath: string) => {
          set({ selectedFilePath: filePath });
        },
        setCommitsSize: (size: number | string) => {
          set({ commitsSize: size });
        },
        setFilesSize: (size: number | string) => {
          set({ filesSize: size });
        },
      }),
    ),
  );
}

type GitHistoryStore = ReturnType<typeof createGitHistoryStore>;

// biome-ignore lint/style/noNonNullAssertion: initialized by ProjectGitHistoryPane
const gitHistoryPaneContext = createContext<GitHistoryStore>(null!);

export function ProjectGitHistoryPane({ cwd }: { cwd: string }) {
  const storesRef = useRef<Map<string, GitHistoryStore>>(new Map());

  let store = storesRef.current.get(cwd);

  if (!store) {
    store = createGitHistoryStore(cwd);
    storesRef.current.set(cwd, store);
  }

  return (
    <gitHistoryPaneContext.Provider value={store}>
      <ProjectGitHistoryPaneContent />
    </gitHistoryPaneContext.Provider>
  );
}

function useGitHistoryStore<T>(
  selector: (state: ExtractState<GitHistoryStore>) => T,
) {
  const store = useContext(gitHistoryPaneContext);
  if (!store)
    throw new Error(
      "useGitHistoryStore must be used within a ProjectGitHistoryPane",
    );
  return useStore(store, selector);
}

function CommitListItem({
  commit,
  selected,
}: {
  commit: GitHistoryCommit;
  selected: boolean;
}) {
  const selectCommit = useGitHistoryStore((s) => s.selectCommit);
  const tags = commitTags(commit);

  return (
    <div
      role="option"
      tabIndex={-1}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 border-b border-border/40 px-2 py-1.5 text-left transition outline-none",
        selected
          ? "bg-white/12 text-white"
          : "text-zinc-400 hover:bg-white/8 hover:text-zinc-200",
      )}
      onClick={() => selectCommit(commit.hash)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          selectCommit(commit.hash);
        }
      }}
      aria-selected={selected}
      title={commit.body ? `${commit.subject}\n\n${commit.body}` : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-medium",
            selected ? "text-white" : "text-zinc-300",
          )}
        >
          {commit.subject || commit.hash.slice(0, 7)}
        </span>
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex h-4 shrink-0 items-center gap-0.5 rounded-sm bg-sky-500/15 px-1 font-mono text-[10px] text-sky-300"
            title={`Tag: ${tag}`}
          >
            <Tag className="size-2.5" />
            {tag}
          </span>
        ))}
        {commit.unpushed ? (
          <span
            className="flex h-4 shrink-0 items-center rounded-sm bg-amber-500/15 px-1 text-[10px] text-amber-300"
            title="Not pushed to upstream"
          >
            <ArrowUp className="size-2.5" />
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-zinc-500">
        <span className="truncate">{commit.authorName}</span>
        <span className="shrink-0">•</span>
        <span
          className="shrink-0"
          title={formatAbsoluteTime(commit.authorDate)}
        >
          {formatRelativeTime(commit.authorDate)}
        </span>
      </div>
    </div>
  );
}

function CommitFileListItem({
  file,
  selected,
}: {
  file: FileDiffMetadata;
  selected: boolean;
}) {
  const selectFile = useGitHistoryStore((s) => s.selectFile);
  const Icon = fileTypeIcon(file);
  const { additions, deletions } = useMemo(
    () => fileDiffLineStats(file),
    [file],
  );

  const label = file.prevName
    ? `${file.prevName.split("/").pop()} → ${file.name.split("/").pop()}`
    : file.name.split("/").pop();
  const dir = file.name.includes("/")
    ? file.name.slice(0, file.name.lastIndexOf("/"))
    : null;

  return (
    <div
      role="option"
      tabIndex={-1}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left text-sm transition outline-none",
        selected
          ? "bg-white/12 text-white"
          : "text-zinc-400 hover:bg-white/8 hover:text-zinc-200",
      )}
      onClick={() => selectFile(file.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          selectFile(file.name);
        }
      }}
      aria-selected={selected}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          file.type === "new" && "text-emerald-400",
          file.type === "deleted" && "text-rose-400",
          file.type !== "new" &&
            file.type !== "deleted" &&
            "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{label}</div>
        {dir ? (
          <div className="truncate text-[10px] text-zinc-500">{dir}</div>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[10px]">
        {additions > 0 && (
          <span className="text-emerald-400">+{additions}</span>
        )}
        {deletions > 0 && (
          <span
            className={additions > 0 ? "ml-1 text-rose-400" : "text-rose-400"}
          >
            -{deletions}
          </span>
        )}
      </span>
    </div>
  );
}

function CommitDetailsHeader({
  commit,
  files,
}: {
  commit: GitHistoryCommit;
  files: FileDiffMetadata[];
}) {
  const { copied, copy } = useCopyToClipboard();
  const shortHash = commit.hash.slice(0, 7);
  const { additions, deletions } = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      const stats = fileDiffLineStats(file);
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions };
  }, [files]);

  return (
    <header className="flex h-7 shrink-0 items-center gap-2 border-b border-border/70 bg-black/15 px-2">
      <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium"
        title={
          commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject
        }
      >
        {commit.subject}
      </span>
      <span
        className="shrink-0 text-[10px] text-zinc-500"
        title={formatAbsoluteTime(commit.authorDate)}
      >
        {commit.authorName} • {formatRelativeTime(commit.authorDate)}
      </span>
      {additions > 0 || deletions > 0 ? (
        <span className="shrink-0 font-mono text-[10px]">
          {additions > 0 && (
            <span className="text-emerald-400">+{additions}</span>
          )}
          {deletions > 0 && (
            <span
              className={additions > 0 ? "ml-1 text-rose-400" : "text-rose-400"}
            >
              -{deletions}
            </span>
          )}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          "h-5 shrink-0 gap-1 px-1.5 font-mono text-[10px]",
          copied
            ? "text-emerald-400 hover:text-emerald-300"
            : "text-zinc-500 hover:text-zinc-200",
        )}
        onClick={() => {
          void copy(commit.hash);
        }}
        aria-label={copied ? "Copied commit hash" : "Copy commit hash"}
        title={commit.hash}
      >
        {copied ? (
          <Check className="size-2.5" />
        ) : (
          <Copy className="size-2.5" />
        )}
        {shortHash}
      </Button>
      <DiffViewModeToggle />
    </header>
  );
}

function ProjectGitHistoryPaneContent() {
  const projectPath = useGitHistoryStore((state) => state.projectPath);
  const selectedCommitHash = useGitHistoryStore(
    (state) => state.selectedCommitHash,
  );
  const selectedFilePath = useGitHistoryStore(
    (state) => state.selectedFilePath,
  );
  const selectCommit = useGitHistoryStore((state) => state.selectCommit);
  const commitsSize = useGitHistoryStore((state) => state.commitsSize);
  const filesSize = useGitHistoryStore((state) => state.filesSize);
  const setCommitsSize = useGitHistoryStore((state) => state.setCommitsSize);
  const setFilesSize = useGitHistoryStore((state) => state.setFilesSize);

  const queryClient = useQueryClient();
  const historyQuery = useInfiniteQuery(
    orpc.projects.getCommitHistory.infiniteOptions({
      input: (pageParam: string | undefined) => ({
        path: projectPath,
        cursor: pageParam,
      }),
      initialPageParam: undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );

  const activeProject = useAppState((state) =>
    state.projects.find((project) => project.path === projectPath),
  );
  const upstreamStats = activeProject?.gitUpstreamDiffStats;
  const hasUpstream = Boolean(upstreamStats);
  const aheadCommits = upstreamStats?.aheadCommits ?? 0;
  const projectLocked = activeProject?.interactionDisabled === true;

  const pushMutation = useMutation(
    orpc.projects.pushToRemote.mutationOptions({
      onSuccess: () => {
        toast.success(
          upstreamStats
            ? `Pushed to ${upstreamStats.upstreamBranch}`
            : "Branch published to remote",
        );
        void queryClient.invalidateQueries({
          queryKey: orpc.projects.getCommitHistory.key(),
        });
      },
      onError: (error) => {
        toast.error(
          error instanceof Error && error.message.trim()
            ? error.message
            : "Git push failed",
        );
      },
    }),
  );

  const commits = useMemo(
    () => historyQuery.data?.pages.flatMap((page) => page.commits) ?? [],
    [historyQuery.data],
  );

  const { selectedCommit, selectedCommitIndex } = useMemo(() => {
    const foundIndex = commits.findIndex(
      (commit) => commit.hash === selectedCommitHash,
    );
    const selectedCommitIndex = foundIndex >= 0 ? foundIndex : 0;
    return {
      selectedCommit: commits[selectedCommitIndex] ?? null,
      selectedCommitIndex,
    };
  }, [commits, selectedCommitHash]);

  const diffQuery = useQuery(
    orpc.projects.getCommitDiff.queryOptions({
      input: {
        path: projectPath,
        commitHash: selectedCommit?.hash ?? "0000000",
      },
      enabled: Boolean(selectedCommit),
      // A commit's diff is immutable for a given hash
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );

  const files = selectedCommit ? diffQuery.data : undefined;

  const selectedFile = useMemo(() => {
    if (!files?.length) return null;
    return files.find((f) => f.name === selectedFilePath) ?? files[0];
  }, [files, selectedFilePath]);

  const diffViewMode = useDiffViewMode();
  const diffOptions = useMemo(
    () => ({
      ...COMPACT_FILE_DIFF_OPTIONS,
      diffStyle: diffViewMode,
    }),
    [diffViewMode],
  );

  useHotkey(
    "ArrowUp",
    () => {
      if (commits.length === 0) return;
      const previous = commits[Math.max(selectedCommitIndex - 1, 0)];
      if (previous) selectCommit(previous.hash);
    },
    { enabled: commits.length > 0 },
  );
  useHotkey(
    "ArrowDown",
    () => {
      if (commits.length === 0) return;
      const next = commits[selectedCommitIndex + 1];
      if (next) {
        selectCommit(next.hash);
        return;
      }
      if (historyQuery.hasNextPage && !historyQuery.isFetchingNextPage) {
        void historyQuery.fetchNextPage();
      }
    },
    { enabled: commits.length > 0 },
  );

  return (
    <ResizablePanelGroup
      onLayoutChanged={(e) => {
        if ("history-commits" in e) {
          setCommitsSize(`${e["history-commits"]}`);
        }
        if ("history-files" in e) {
          setFilesSize(`${e["history-files"]}`);
        }
      }}
      orientation="horizontal"
      className="h-full min-h-0"
    >
      <ResizablePanel id="history-commits" defaultSize={commitsSize}>
        <aside className="flex h-full flex-col border-r border-border/70 bg-black/15">
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
            <History className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              History
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 shrink-0 text-muted-foreground hover:text-zinc-200"
              disabled={historyQuery.isRefetching}
              onClick={() => void historyQuery.refetch()}
              aria-label="Refresh history"
              title="Refresh history"
            >
              <RefreshCw
                className={cn(
                  "size-3",
                  historyQuery.isRefetching && "animate-spin",
                )}
              />
            </Button>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            role="listbox"
            aria-label="Commit history"
          >
            {historyQuery.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
              </div>
            ) : commits.length ? (
              <>
                {commits.map((commit) => (
                  <CommitListItem
                    key={commit.hash}
                    commit={commit}
                    selected={selectedCommit?.hash === commit.hash}
                  />
                ))}
                {historyQuery.hasNextPage ? (
                  <div className="p-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 w-full px-2 text-[11px]"
                      disabled={historyQuery.isFetchingNextPage}
                      onClick={() => void historyQuery.fetchNextPage()}
                    >
                      {historyQuery.isFetchingNextPage ? (
                        <LoaderCircle className="size-2.5 animate-spin" />
                      ) : null}
                      Load more
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="px-2 py-4 text-xs text-zinc-500">
                {historyQuery.isError
                  ? "Failed to load commit history"
                  : "No commits yet"}
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-border/70 p-1.5">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 w-full px-2 text-xs"
              disabled={
                pushMutation.isPending ||
                projectLocked ||
                commits.length === 0 ||
                (hasUpstream && aheadCommits === 0)
              }
              onClick={() => pushMutation.mutate({ path: projectPath })}
              title={
                upstreamStats
                  ? `Push to ${upstreamStats.upstreamBranch}`
                  : "Publish the current branch to origin"
              }
            >
              {pushMutation.isPending ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <ArrowUp className="size-3" />
              )}
              {hasUpstream
                ? `Push${aheadCommits > 0 ? ` (${aheadCommits})` : ""}`
                : "Publish branch"}
            </Button>
          </div>
        </aside>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel>
        <main className="flex h-full min-w-0 flex-col bg-black/10">
          {selectedCommit ? (
            <>
              <CommitDetailsHeader
                commit={selectedCommit}
                files={files ?? []}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                {diffQuery.isLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <LoaderCircle className="text-muted-foreground size-6 animate-spin" />
                  </div>
                ) : selectedFile ? (
                  <FileDiff fileDiff={selectedFile} options={diffOptions} />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-muted-foreground text-sm">
                      {diffQuery.isError
                        ? "Failed to load commit diff"
                        : "No changes in this commit"}
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground text-sm">
                Select a commit to view its changes
              </p>
            </div>
          )}
        </main>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel id="history-files" defaultSize={filesSize}>
        <aside className="flex h-full flex-col border-l border-border/70 bg-black/15">
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {files
                ? `${files.length} changed file${files.length === 1 ? "" : "s"}`
                : "Changed files"}
            </span>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto py-1"
            role="listbox"
            aria-label="Files changed in commit"
          >
            {!selectedCommit || diffQuery.isLoading ? (
              diffQuery.isLoading ? (
                <div className="flex h-full items-center justify-center">
                  <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : null
            ) : files?.length ? (
              files.map((file) => (
                <CommitFileListItem
                  key={file.name}
                  file={file}
                  selected={!!selectedFile && selectedFile.name === file.name}
                />
              ))
            ) : (
              <p className="px-2 py-4 text-xs text-zinc-500">No changes</p>
            )}
          </div>
        </aside>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
