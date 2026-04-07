import type { FileDiffMetadata } from "@pierre/diffs/react";
import { FileDiff } from "@pierre/diffs/react";
import { useDiffReviewCommitDialogStore } from "@renderer/components/diff-review-commit-dialog";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import {
  FileMinus,
  FilePlus,
  FileText,
  GitCommitHorizontal,
  LoaderCircle,
  X,
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

export const useDiffReviewStore = create(
  combine(
    {
      openedProjectPath: null as string | null,
    },
    (set) => ({
      openProjectDiff: (projectPath: string) => {
        set({ openedProjectPath: projectPath });
      },
      closeProjectDiff: () => {
        set({ openedProjectPath: null });
      },
    }),
  ),
);

function createProjectDiffStore(projectPath: string) {
  return createStore(
    combine(
      {
        projectPath,
        selectedFilePath: null as string | null,
        confirmedFiles: [] as string[],
        sidebarSize: 192 as number | string,
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

export function ProjectDiffPane() {
  const openedProjectPath = useDiffReviewStore(
    (state) => state.openedProjectPath,
  );

  const storesRef = useRef<Map<string, ProjectDiffStore>>(new Map());

  if (!openedProjectPath) return null;

  let store = storesRef.current.get(openedProjectPath);

  if (!store) {
    store = createProjectDiffStore(openedProjectPath);
    storesRef.current.set(openedProjectPath, store);
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
        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors outline-none",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
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
        <div className="truncate text-xs font-medium">{label}</div>
        {dir && (
          <div className="truncate text-xs text-muted-foreground">{dir}</div>
        )}
      </div>
      <span className="shrink-0 font-mono text-xs">
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

  useHotkey("Escape", () => closeDiffPane(), {
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
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 pl-20 pr-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Uncommitted Changes</div>
          <div className="truncate text-xs text-muted-foreground">
            {projectPath}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="default"
            size="sm"
            className="shrink-0"
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
            <GitCommitHorizontal className="size-4" />
            Commit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={closeDiffPane}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </header>

      {/* Body */}
      <ResizablePanelGroup
        onLayoutChanged={(e) => {
          if ("sidebar" in e) {
            setSidebarSize(`${e.sidebar}`);
          }
        }}
        orientation="horizontal"
        className="min-h-0 flex-1"
      >
        {/* Sidebar */}
        <ResizablePanel
          id="sidebar"
          defaultSize={sidebarSize}
          minSize={30}
          maxSize={600}
        >
          <aside className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
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
              <label
                htmlFor="all-files-checkbox"
                className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
              >
                {files.length} changed file{files.length === 1 ? "" : "s"}
              </label>
            </div>
            <div
              className="flex-1 overflow-y-auto py-1"
              role="listbox"
              aria-label="Changed files"
            >
              {isLoading ? (
                <div className="flex h-full items-center justify-center">
                  <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : files?.length ? (
                files.map((file) => (
                  <FileListItem
                    key={file.name}
                    file={file}
                    selected={!!selectedFile && selectedFile.name === file.name}
                  />
                ))
              ) : (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  No changes
                </p>
              )}
            </div>
          </aside>
        </ResizablePanel>

        <ResizableHandle />

        {/* Diff pane */}
        <ResizablePanel>
          <main className="h-full overflow-auto">
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <LoaderCircle className="text-muted-foreground size-6 animate-spin" />
              </div>
            ) : selectedFile ? (
              <FileDiff fileDiff={selectedFile} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-muted-foreground text-sm">
                  No uncommitted changes
                </p>
              </div>
            )}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
