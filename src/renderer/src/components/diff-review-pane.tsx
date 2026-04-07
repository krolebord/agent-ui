import type { FileDiffMetadata } from "@pierre/diffs/react";
import { FileDiff } from "@pierre/diffs/react";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import { FileMinus, FilePlus, FileText, LoaderCircle, X } from "lucide-react";
import { createContext, useContext, useMemo, useRef } from "react";
import { create, createStore, type ExtractState } from "zustand";
import { combine } from "zustand/middleware";
import { useStore } from "zustand/react";
import { Button } from "./ui/button";
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

function FileListItem({
  file,
  selected,
  onClick,
}: {
  file: FileDiffMetadata;
  selected: boolean;
  onClick: () => void;
}) {
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
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onClick={onClick}
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
    </button>
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

  const { selectedFile, selectedFileIndex } = useMemo(() => {
    if (!files) return { selectedFile: null, selectedFileIndex: 0 };

    const foundIndex = files?.findIndex((f) => f.name === selectedFilePath);

    const selectedFileIndex = foundIndex >= 0 ? foundIndex : 0;
    return {
      selectedFile: files?.[selectedFileIndex] ?? null,
      selectedFileIndex: selectedFileIndex,
    };
  }, [files, selectedFilePath]);
  const selectFile = useProjectDiffStore((state) => state.selectFile);

  const sidebarSize = useProjectDiffStore((state) => state.sidebarSize);
  const setSidebarSize = useProjectDiffStore((state) => state.setSidebarSize);

  useHotkey("Escape", () => closeDiffPane());
  useHotkey("ArrowUp", () => {
    if (!files || files.length === 0) return;
    const newIndex = (selectedFileIndex - 1 + files.length) % files.length;
    selectFile(files[newIndex].name);
  });
  useHotkey("ArrowDown", () => {
    if (!files || files.length === 0) return;
    const newIndex = (selectedFileIndex + 1) % files.length;
    selectFile(files[newIndex].name);
  });

  if (!files) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 pl-20 pr-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Uncommitted Changes</div>
          <div className="truncate text-xs text-muted-foreground">
            {projectPath}
          </div>
        </div>
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
            <div className="border-b border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {files
                ? `${files.length} changed file${files.length === 1 ? "" : "s"}`
                : "Files"}
            </div>
            <div className="flex-1 overflow-y-auto py-1">
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
                    onClick={() => selectFile(file.name)}
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
