import type { FileDiffMetadata } from "@pierre/diffs/react";
import { FileDiff } from "@pierre/diffs/react";
import { COMPACT_FILE_DIFF_OPTIONS } from "@renderer/components/diff-pane-styles";
import { useDiffReviewCommitDialogStore } from "@renderer/components/diff-review-commit-dialog";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import {
  FileDiff as FileDiffIcon,
  FileMinus,
  FilePlus,
  FileText,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import { createContext, useContext, useMemo, useRef } from "react";
import { create, createStore, type ExtractState } from "zustand";
import { combine } from "zustand/middleware";
import { useStore } from "zustand/react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";

export type BottomPaneView = "terminals" | "diff";

function getBottomPaneViewForProject(
  viewsByProject: Record<string, BottomPaneView>,
  projectPath: string,
): BottomPaneView {
  return viewsByProject[projectPath] ?? "terminals";
}

export const useDiffReviewStore = create(
  combine(
    {
      bottomPaneViewByProject: {} as Record<string, BottomPaneView>,
    },
    (set, get) => ({
      setBottomPaneView: (
        projectPath: string,
        bottomPaneView: BottomPaneView,
      ) => {
        set((state) => ({
          bottomPaneViewByProject: {
            ...state.bottomPaneViewByProject,
            [projectPath]: bottomPaneView,
          },
        }));
      },
      openProjectDiff: (projectPath: string) => {
        set((state) => ({
          bottomPaneViewByProject: {
            ...state.bottomPaneViewByProject,
            [projectPath]: "diff",
          },
        }));
      },
      closeProjectDiff: (projectPath: string) => {
        set((state) => ({
          bottomPaneViewByProject: {
            ...state.bottomPaneViewByProject,
            [projectPath]: "terminals",
          },
        }));
      },
      toggleBottomPaneView: (projectPath: string) => {
        const current = getBottomPaneViewForProject(
          get().bottomPaneViewByProject,
          projectPath,
        );
        set((state) => ({
          bottomPaneViewByProject: {
            ...state.bottomPaneViewByProject,
            [projectPath]: current === "diff" ? "terminals" : "diff",
          },
        }));
      },
    }),
  ),
);

export function useProjectBottomPaneView(
  projectPath: string | null,
): BottomPaneView {
  return useDiffReviewStore((state) =>
    projectPath
      ? getBottomPaneViewForProject(state.bottomPaneViewByProject, projectPath)
      : "terminals",
  );
}

function createProjectDiffStore(projectPath: string) {
  return createStore(
    combine(
      {
        projectPath,
        selectedFilePath: null as string | null,
        confirmedFiles: [] as string[],
        sidebarSize: 220 as number | string,
      },
      (set) => ({
        selectFile: (filePath: string) => {
          set({ selectedFilePath: filePath });
        },
        toggleFileConfirmation: (filePath: string) => {
          set((state) => ({
            confirmedFiles: state.confirmedFiles.includes(filePath)
              ? state.confirmedFiles.filter((f) => f !== filePath)
              : [...state.confirmedFiles, filePath],
          }));
        },
        toggleAllFilesConfirmation: (paths: string[]) => {
          set((state) => {
            if (paths.length === 0) return state;
            const pathSet = new Set(paths);
            const allIncluded = paths.every((p) =>
              state.confirmedFiles.includes(p),
            );
            if (allIncluded) {
              return {
                confirmedFiles: state.confirmedFiles.filter(
                  (f) => !pathSet.has(f),
                ),
              };
            }
            return {
              confirmedFiles: [...new Set([...state.confirmedFiles, ...paths])],
            };
          });
        },
        clearConfirmations: () => {
          set({ confirmedFiles: [] });
        },
        setSidebarSize: (size: number | string) => {
          set({ sidebarSize: size });
        },
      }),
    ),
  );
}

// biome-ignore lint/style/noNonNullAssertion: initialized by ProjectDiffPane
const projectDiffPaneContext = createContext<ProjectDiffStore>(null!);

type ProjectDiffStore = ReturnType<typeof createProjectDiffStore>;

export function ProjectDiffPane({ cwd }: { cwd: string }) {
  const storesRef = useRef<Map<string, ProjectDiffStore>>(new Map());

  let store = storesRef.current.get(cwd);

  if (!store) {
    store = createProjectDiffStore(cwd);
    storesRef.current.set(cwd, store);
  }

  return (
    <projectDiffPaneContext.Provider value={store}>
      <ProjectDiffPaneContent />
    </projectDiffPaneContext.Provider>
  );
}

function useProjectDiffStore<T>(
  selector: (state: ExtractState<ProjectDiffStore>) => T,
) {
  const store = useContext(projectDiffPaneContext);
  if (!store)
    throw new Error(
      "useProjectDiffStore must be used within a ProjectDiffPane",
    );
  return useStore(store, selector);
}

function fileTypeIcon(file: FileDiffMetadata) {
  if (file.type === "new") return FilePlus;
  if (file.type === "deleted") return FileMinus;
  return FileText;
}

function gitPathsForConfirmedFiles(
  files: FileDiffMetadata[],
  confirmedFiles: string[],
): string[] {
  const confirmed = new Set(confirmedFiles);
  const out = new Set<string>();
  for (const f of files) {
    if (!confirmed.has(f.name)) continue;
    if (f.prevName) {
      out.add(f.prevName);
    }
    out.add(f.name);
  }
  return [...out];
}

function FileListItem({
  file,
  selected,
}: {
  file: FileDiffMetadata;
  selected: boolean;
}) {
  const confirmed = useProjectDiffStore((s) =>
    s.confirmedFiles.includes(file.name),
  );
  const selectFile = useProjectDiffStore((s) => s.selectFile);
  const toggleFileConfirmation = useProjectDiffStore(
    (s) => s.toggleFileConfirmation,
  );

  const Icon = fileTypeIcon(file);
  const { additions, deletions } = useMemo(
    () => ({
      additions: file.hunks.reduce((sum, h) => sum + h.additionLines, 0),
      deletions: file.hunks.reduce((sum, h) => sum + h.deletionLines, 0),
    }),
    [file.hunks],
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
      <Checkbox
        checked={confirmed}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => toggleFileConfirmation(file.name)}
        className="shrink-0"
        aria-label={
          confirmed
            ? "Included in commit — press Space to exclude"
            : "Excluded from commit — press Space to include"
        }
      />
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

function ProjectDiffPaneContent() {
  const closeDiffPane = useDiffReviewStore((state) => state.closeProjectDiff);

  const projectPath = useProjectDiffStore((state) => state.projectPath);
  const { data: files, isLoading } = useQuery(
    orpc.projects.getUncommittedDiff.queryOptions({
      input: { path: projectPath },
      staleTime: 0,
    }),
  );

  const selectedFilePath = useProjectDiffStore(
    (state) => state.selectedFilePath,
  );
  const confirmedFiles = useProjectDiffStore((state) => state.confirmedFiles);
  const selectFile = useProjectDiffStore((state) => state.selectFile);
  const toggleFileConfirmation = useProjectDiffStore(
    (state) => state.toggleFileConfirmation,
  );
  const toggleAllFilesConfirmation = useProjectDiffStore(
    (state) => state.toggleAllFilesConfirmation,
  );
  const clearConfirmations = useProjectDiffStore(
    (state) => state.clearConfirmations,
  );
  const openCommitDialog = useDiffReviewCommitDialogStore((s) => s.open);
  const commitDialogOpen = useDiffReviewCommitDialogStore(
    (s) => s.payload !== null,
  );

  const { selectedFile, selectedFileIndex } = useMemo(() => {
    if (!files) return { selectedFile: null, selectedFileIndex: 0 };

    const foundIndex = files?.findIndex((f) => f.name === selectedFilePath);

    const selectedFileIndex = foundIndex >= 0 ? foundIndex : 0;
    return {
      selectedFile: files?.[selectedFileIndex] ?? null,
      selectedFileIndex: selectedFileIndex,
    };
  }, [files, selectedFilePath]);

  const { allFilesConfirmed, someFilesConfirmed } = useMemo(() => {
    if (!files?.length) {
      return { allFilesConfirmed: false, someFilesConfirmed: false };
    }
    const included = files.filter((f) => confirmedFiles.includes(f.name));
    return {
      allFilesConfirmed: included.length === files.length,
      someFilesConfirmed: included.length > 0 && included.length < files.length,
    };
  }, [files, confirmedFiles]);
  const sidebarSize = useProjectDiffStore((state) => state.sidebarSize);
  const setSidebarSize = useProjectDiffStore((state) => state.setSidebarSize);

  const pathsToCommit = useMemo(
    () => (files ? gitPathsForConfirmedFiles(files, confirmedFiles) : []),
    [files, confirmedFiles],
  );
  const canCommit = pathsToCommit.length > 0;
  const selectedFileCount = useMemo(
    () => files?.filter((f) => confirmedFiles.includes(f.name)).length ?? 0,
    [files, confirmedFiles],
  );

  useHotkey("Escape", () => closeDiffPane(projectPath), {
    enabled: !commitDialogOpen,
  });
  useHotkey(
    "ArrowUp",
    () => {
      if (!files || files.length === 0) return;
      const newIndex = (selectedFileIndex - 1 + files.length) % files.length;
      selectFile(files[newIndex].name);
    },
    { enabled: !commitDialogOpen },
  );
  useHotkey(
    "ArrowDown",
    () => {
      if (!files || files.length === 0) return;
      const newIndex = (selectedFileIndex + 1) % files.length;
      selectFile(files[newIndex].name);
    },
    { enabled: !commitDialogOpen },
  );
  useHotkey(
    "Space",
    () => {
      if (!files?.length || !selectedFile) return;
      toggleFileConfirmation(selectedFile.name);
    },
    {
      enabled: Boolean(!commitDialogOpen && files?.length && selectedFile),
    },
  );

  if (!files) return null;

  return (
    <ResizablePanelGroup
      onLayoutChanged={(e) => {
        if ("files-sidebar" in e) {
          setSidebarSize(`${e["files-sidebar"]}`);
        }
      }}
      orientation="horizontal"
      className="h-full min-h-0"
    >
      <ResizablePanel>
        <main className="h-full min-w-0 overflow-auto bg-black/10">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <LoaderCircle className="text-muted-foreground size-6 animate-spin" />
            </div>
          ) : selectedFile ? (
            <FileDiff
              fileDiff={selectedFile}
              options={COMPACT_FILE_DIFF_OPTIONS}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground text-sm">
                No uncommitted changes
              </p>
            </div>
          )}
        </main>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel id="files-sidebar" defaultSize={sidebarSize}>
        <aside className="flex h-full flex-col border-l border-border/70 bg-black/15">
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
            <Checkbox
              id="all-files-checkbox"
              checked={
                allFilesConfirmed
                  ? true
                  : someFilesConfirmed
                    ? "indeterminate"
                    : false
              }
              disabled={!files.length}
              onCheckedChange={() =>
                toggleAllFilesConfirmation(files.map((f) => f.name))
              }
              className="shrink-0"
              aria-label={
                allFilesConfirmed
                  ? "Exclude all changed files from commit"
                  : "Include all changed files in commit"
              }
            />
            <FileDiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <label
              htmlFor="all-files-checkbox"
              className="min-w-0 flex-1 truncate text-xs font-medium"
            >
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </label>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto py-1"
            role="listbox"
            aria-label="Changed files"
          >
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
              </div>
            ) : files.length ? (
              files.map((file) => (
                <FileListItem
                  key={file.name}
                  file={file}
                  selected={!!selectedFile && selectedFile.name === file.name}
                />
              ))
            ) : (
              <p className="px-2 py-4 text-xs text-zinc-500">No changes</p>
            )}
          </div>

          <div className="shrink-0 border-t border-border/70 p-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 w-full px-2 text-xs"
              disabled={!canCommit}
              onClick={() =>
                openCommitDialog({
                  projectPath,
                  pathsToCommit,
                  selectedFileCount,
                  onCommitted: clearConfirmations,
                })
              }
            >
              <GitCommitHorizontal className="size-3" />
              Commit
            </Button>
          </div>
        </aside>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
