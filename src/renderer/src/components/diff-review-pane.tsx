import type { Editor, EditorOptions } from "@pierre/diffs/edit";
import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileContents,
  FileDiffMetadata,
  FileDiffProps,
  LineAnnotation,
} from "@pierre/diffs/react";
import { EditProvider, FileDiff } from "@pierre/diffs/react";
import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
import {
  AddCommentGutterButton,
  DiffCommentAnnotation,
  type DiffReviewAnnotationMetadata,
  getCommentDraftLineAnnotations,
  useDiffCommentStore,
} from "@renderer/components/diff-comment";
import { COMPACT_FILE_DIFF_OPTIONS } from "@renderer/components/diff-pane-styles";
import { useDiffReviewCommitDialogStore } from "@renderer/components/diff-review-commit-dialog";
import {
  DiffViewModeToggle,
  useDiffViewMode,
} from "@renderer/components/diff-view-mode";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useIsMobile } from "@renderer/hooks/use-is-mobile";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  FileDiff as FileDiffIcon,
  FileMinus,
  FilePlus,
  FileText,
  GitCommitHorizontal,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
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

export type BottomPaneView = "terminals" | "diff" | "history";

type EditableDiffDraft = {
  sourceSignature: string;
  fileDiff: FileDiffMetadata;
  revision: string;
  initialContents: string;
  contents: string;
  lineAnnotations: DiffLineAnnotation<DiffReviewAnnotationMetadata>[];
  dirty: boolean;
  conflict: boolean;
  error: string | null;
};

function getBottomPaneViewForProject(
  viewsByProject: Record<string, BottomPaneView>,
  projectPath: string,
): BottomPaneView {
  return viewsByProject[projectPath] ?? "terminals";
}

function getFileDiffSignature(file: FileDiffMetadata) {
  if (file.prevObjectId || file.newObjectId) {
    return `${file.prevObjectId ?? "0000000"}..${file.newObjectId ?? "0000000"}`;
  }
  return file.hunks.map((hunk) => hunk.hunkSpecs ?? "").join("\n");
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
        const nextView: BottomPaneView =
          current === "terminals"
            ? "diff"
            : current === "diff"
              ? "history"
              : "terminals";
        set((state) => ({
          bottomPaneViewByProject: {
            ...state.bottomPaneViewByProject,
            [projectPath]: nextView,
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
        editableDrafts: {} as Record<string, EditableDiffDraft>,
        editorFocusedFilePath: null as string | null,
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
        initializeEditableDraft: (
          filePath: string,
          draft: EditableDiffDraft,
        ) => {
          set((state) => {
            const current = state.editableDrafts[filePath];
            if (
              current?.dirty ||
              current?.sourceSignature === draft.sourceSignature
            ) {
              return state;
            }
            return {
              editableDrafts: {
                ...state.editableDrafts,
                [filePath]: draft,
              },
            };
          });
        },
        updateEditableDraft: (
          filePath: string,
          patch: Partial<EditableDiffDraft>,
        ) => {
          set((state) => {
            const current = state.editableDrafts[filePath];
            if (!current) return state;
            return {
              editableDrafts: {
                ...state.editableDrafts,
                [filePath]: { ...current, ...patch },
              },
            };
          });
        },
        removeEditableDraft: (filePath: string) => {
          set((state) => {
            if (!state.editableDrafts[filePath]) return state;
            const nextDrafts = { ...state.editableDrafts };
            delete nextDrafts[filePath];
            return { editableDrafts: nextDrafts };
          });
        },
        removeEditableDrafts: (filePaths?: string[]) => {
          set((state) => {
            if (!filePaths) return { editableDrafts: {} };
            const nextDrafts = { ...state.editableDrafts };
            for (const filePath of filePaths) delete nextDrafts[filePath];
            return { editableDrafts: nextDrafts };
          });
        },
        setEditorFocusedFilePath: (filePath: string | null) => {
          set({ editorFocusedFilePath: filePath });
        },
      }),
    ),
  );
}

// biome-ignore lint/style/noNonNullAssertion: initialized by ProjectDiffPane
const projectDiffPaneContext = createContext<ProjectDiffStore>(null!);

type ProjectDiffStore = ReturnType<typeof createProjectDiffStore>;

const projectDiffStores = new Map<string, ProjectDiffStore>();

function getProjectDiffStore(cwd: string): ProjectDiffStore {
  let store = projectDiffStores.get(cwd);
  if (!store) {
    store = createProjectDiffStore(cwd);
    projectDiffStores.set(cwd, store);
  }
  return store;
}

export function ProjectDiffPane({ cwd }: { cwd: string }) {
  const store = getProjectDiffStore(cwd);
  const [createEditor, setCreateEditor] = useState<
    | ((
        options: EditorOptions<DiffReviewAnnotationMetadata>,
      ) => Editor<DiffReviewAnnotationMetadata>)
    | null
  >(null);
  const [editorLoadError, setEditorLoadError] = useState(false);
  const editorLoaderMounted = useRef(false);

  const loadEditor = useCallback(() => {
    setEditorLoadError(false);
    void import("@pierre/diffs/edit")
      .then(({ Editor: DiffsEditor }) => {
        if (!editorLoaderMounted.current) return;
        const factory = (
          options: EditorOptions<DiffReviewAnnotationMetadata>,
        ) => new DiffsEditor(options);
        setCreateEditor(() => factory);
      })
      .catch(() => {
        if (editorLoaderMounted.current) setEditorLoadError(true);
      });
  }, []);

  useEffect(() => {
    editorLoaderMounted.current = true;
    loadEditor();
    return () => {
      editorLoaderMounted.current = false;
    };
  }, [loadEditor]);

  if (!createEditor) {
    return (
      <div className="flex h-full items-center justify-center bg-black/10">
        {editorLoadError ? (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Failed to load the diff editor.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={loadEditor}
            >
              Retry
            </Button>
          </div>
        ) : (
          <LoaderCircle className="size-5 animate-spin text-zinc-500" />
        )}
      </div>
    );
  }

  return (
    <projectDiffPaneContext.Provider value={store}>
      <EditProvider createEditor={createEditor}>
        <ProjectDiffPaneContent />
      </EditProvider>
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

function getDiffErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Failed to read uncommitted changes.";
}

function mergeEditableAnnotations(
  edited: DiffLineAnnotation<DiffReviewAnnotationMetadata>[],
  current: DiffLineAnnotation<DiffReviewAnnotationMetadata>[],
) {
  return current.map((annotation) => {
    const match = edited.find(
      (candidate) => candidate.metadata.type === annotation.metadata.type,
    );
    return match
      ? { ...annotation, side: match.side, lineNumber: match.lineNumber }
      : annotation;
  });
}

function supportsDiffEditing(file: FileDiffMetadata | null): boolean {
  return Boolean(
    file &&
      (file.type === "change" ||
        file.type === "rename-changed" ||
        file.type === "new") &&
      file.mode !== "120000" &&
      file.prevMode !== "120000",
  );
}

function DiffLoadErrorState({
  message,
  isRetrying,
  onRetry,
}: {
  message: string;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <TriangleAlert className="size-5 text-amber-400" />
      <p className="text-sm font-medium">Couldn't read changes</p>
      <p className="max-w-md text-xs break-words text-muted-foreground">
        {message}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-1 h-7 px-2 text-xs pointer-coarse:h-11"
        disabled={isRetrying}
        onClick={onRetry}
      >
        {isRetrying ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        Retry
      </Button>
    </div>
  );
}

function getFileBasename(filePath: string) {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

function joinProjectFilePath(projectPath: string, relativePath: string) {
  const separator = projectPath.includes("\\") ? "\\" : "/";
  const normalizedProject = projectPath.replace(/[\\/]+$/, "");
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator);
  return `${normalizedProject}${separator}${normalizedRelative}`;
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

function useFileListItemDiscardActions(file: FileDiffMetadata) {
  const store = useContext(projectDiffPaneContext);
  const projectPath = useProjectDiffStore((s) => s.projectPath);
  const hasSelectedFiles = useProjectDiffStore(
    (s) => s.confirmedFiles.length > 0,
  );
  const clearConfirmations = useProjectDiffStore((s) => s.clearConfirmations);
  const removeEditableDrafts = useProjectDiffStore(
    (s) => s.removeEditableDrafts,
  );
  const queryClient = useQueryClient();
  const confirm = useConfirmDialogStore((s) => s.confirm);
  const discardMutation = useMutation(
    orpc.projects.discardChanges.mutationOptions(),
  );

  const requestDiscard = () => {
    const filePaths = file.prevName ? [file.prevName, file.name] : [file.name];
    const description =
      file.type === "new"
        ? `"${file.name}" is a new file and will be permanently deleted. This cannot be undone.`
        : file.type === "deleted"
          ? `"${file.name}" will be restored to its last committed version. This cannot be undone.`
          : `Changes to "${file.name}" will be reverted to the last commit. This cannot be undone.`;
    confirm({
      title: "Discard changes?",
      description,
      confirmLabel: "Discard",
      onConfirm: async () => {
        await discardMutation.mutateAsync({ path: projectPath, filePaths });
        removeEditableDrafts([file.name]);
        await queryClient.invalidateQueries({
          queryKey: orpc.projects.getUncommittedDiff.queryKey({
            input: { path: projectPath },
          }),
        });
      },
    });
  };

  const requestDiscardSelected = () => {
    const { confirmedFiles } = store.getState();
    const files = queryClient.getQueryData(
      orpc.projects.getUncommittedDiff.queryKey({
        input: { path: projectPath },
      }),
    );
    if (!files) return;
    const selectedFileCount = files.filter((f) =>
      confirmedFiles.includes(f.name),
    ).length;
    if (selectedFileCount === 0) return;
    const filePaths = gitPathsForConfirmedFiles(files, confirmedFiles);
    confirm({
      title: "Discard changes in selected files?",
      description: `All changes in ${selectedFileCount} selected file${selectedFileCount === 1 ? "" : "s"} will be discarded. New files will be permanently deleted. Modified files will be reverted to the last commit. This cannot be undone.`,
      confirmLabel: "Discard",
      onConfirm: async () => {
        await discardMutation.mutateAsync({ path: projectPath, filePaths });
        removeEditableDrafts(confirmedFiles);
        clearConfirmations();
        await queryClient.invalidateQueries({
          queryKey: orpc.projects.getUncommittedDiff.queryKey({
            input: { path: projectPath },
          }),
        });
      },
    });
  };

  return {
    requestDiscard,
    requestDiscardSelected,
    isDiscardPending: discardMutation.isPending,
    hasSelectedFiles,
  };
}

function FileDiscardMenuItems({
  requestDiscard,
  requestDiscardSelected,
  isDiscardPending,
  hasSelectedFiles,
  showDiscardSelected = true,
}: {
  requestDiscard: () => void;
  requestDiscardSelected: () => void;
  isDiscardPending: boolean;
  hasSelectedFiles: boolean;
  showDiscardSelected?: boolean;
}) {
  return (
    <>
      <ContextMenuItem
        variant="destructive"
        onSelect={requestDiscard}
        disabled={isDiscardPending}
      >
        <Trash2 className="size-3.5" />
        Discard changes
      </ContextMenuItem>
      {showDiscardSelected ? (
        <ContextMenuItem
          variant="destructive"
          onSelect={requestDiscardSelected}
          disabled={!hasSelectedFiles || isDiscardPending}
        >
          <Trash2 className="size-3.5" />
          Discard selected files
        </ContextMenuItem>
      ) : null}
    </>
  );
}

function FileDiscardDropdownItems({
  requestDiscard,
  requestDiscardSelected,
  isDiscardPending,
  hasSelectedFiles,
  showDiscardSelected = true,
}: {
  requestDiscard: () => void;
  requestDiscardSelected: () => void;
  isDiscardPending: boolean;
  hasSelectedFiles: boolean;
  showDiscardSelected?: boolean;
}) {
  return (
    <>
      <DropdownMenuItem
        variant="destructive"
        onSelect={requestDiscard}
        disabled={isDiscardPending}
      >
        <Trash2 className="size-3.5" />
        Discard changes
      </DropdownMenuItem>
      {showDiscardSelected ? (
        <DropdownMenuItem
          variant="destructive"
          onSelect={requestDiscardSelected}
          disabled={!hasSelectedFiles || isDiscardPending}
        >
          <Trash2 className="size-3.5" />
          Discard selected files
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function FileListItem({
  file,
  selected,
  showMobileMenu = false,
  onOpenFile,
}: {
  file: FileDiffMetadata;
  selected: boolean;
  showMobileMenu?: boolean;
  onOpenFile?: () => void;
}) {
  const projectPath = useProjectDiffStore((s) => s.projectPath);
  const selectFile = useProjectDiffStore((s) => s.selectFile);
  const toggleFileConfirmation = useProjectDiffStore(
    (s) => s.toggleFileConfirmation,
  );
  const confirmed = useProjectDiffStore((s) =>
    s.confirmedFiles.includes(file.name),
  );
  const editDraft = useProjectDiffStore((s) => s.editableDrafts[file.name]);
  const {
    requestDiscard,
    requestDiscardSelected,
    isDiscardPending,
    hasSelectedFiles,
  } = useFileListItemDiscardActions(file);

  const Icon = fileTypeIcon(file);
  const { additions, deletions } = useMemo(
    () => ({
      additions: file.hunks.reduce((sum, h) => sum + h.additionLines, 0),
      deletions: file.hunks.reduce((sum, h) => sum + h.deletionLines, 0),
    }),
    [file.hunks],
  );

  const fileBasename = getFileBasename(file.name);
  const fileAbsolutePath = joinProjectFilePath(projectPath, file.name);
  const label = file.prevName
    ? `${getFileBasename(file.prevName)} → ${fileBasename}`
    : fileBasename;
  const dir = file.name.includes("/")
    ? file.name.slice(0, file.name.lastIndexOf("/"))
    : null;

  const copyFileName = () => {
    void navigator.clipboard.writeText(fileBasename);
    toast.success("File name copied");
  };
  const copyFilePath = () => {
    void navigator.clipboard.writeText(fileAbsolutePath);
    toast.success("File path copied");
  };

  const handleRowActivate = () => {
    selectFile(file.name);
    onOpenFile?.();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          tabIndex={-1}
          className={cn(
            "flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left text-sm transition outline-none pointer-coarse:min-h-11 pointer-coarse:py-2",
            selected
              ? "bg-white/12 text-white"
              : "text-zinc-400 hover:bg-white/8 hover:text-zinc-200",
          )}
          onClick={handleRowActivate}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleRowActivate();
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
          {editDraft?.dirty ? (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full bg-amber-400",
                editDraft.conflict && "bg-rose-400",
              )}
              title={
                editDraft.conflict
                  ? "Unsaved edit conflicts with the file on disk"
                  : "Unsaved edit"
              }
              role="img"
              aria-label="Unsaved edit"
            />
          ) : null}
          <span className="shrink-0 font-mono text-[10px]">
            {additions > 0 && (
              <span className="text-emerald-400">+{additions}</span>
            )}
            {deletions > 0 && (
              <span
                className={
                  additions > 0 ? "ml-1 text-rose-400" : "text-rose-400"
                }
              >
                -{deletions}
              </span>
            )}
          </span>
          {showMobileMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-zinc-200"
                  aria-label="File actions"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={copyFileName}>
                  <Copy className="size-3.5" />
                  Copy name
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={copyFilePath}>
                  <Copy className="size-3.5" />
                  Copy path
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <FileDiscardDropdownItems
                  requestDiscard={requestDiscard}
                  requestDiscardSelected={requestDiscardSelected}
                  isDiscardPending={isDiscardPending}
                  hasSelectedFiles={hasSelectedFiles}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={copyFileName}>
          <Copy className="size-3.5" />
          Copy name
        </ContextMenuItem>
        <ContextMenuItem onSelect={copyFilePath}>
          <Copy className="size-3.5" />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <FileDiscardMenuItems
          requestDiscard={requestDiscard}
          requestDiscardSelected={requestDiscardSelected}
          isDiscardPending={isDiscardPending}
          hasSelectedFiles={hasSelectedFiles}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

type DiffViewerPanelProps = {
  isLoading: boolean;
  selectedFile: FileDiffMetadata | null;
  renderedFile: FileDiffMetadata | null;
  diffOptions: FileDiffProps<DiffReviewAnnotationMetadata>["options"];
  editorOptions: EditorOptions<DiffReviewAnnotationMetadata>;
  lineAnnotations: DiffLineAnnotation<DiffReviewAnnotationMetadata>[];
  editDraft: EditableDiffDraft | null;
  editUnavailableReason: string | null;
  isPreparingEditor: boolean;
  isSavingEdit: boolean;
  projectPath: string;
  selectFile: (filePath: string) => void;
  onSaveEdit: () => void;
  onReloadEdit: () => void;
  onCopyEdit: () => void;
  startCommentDraft: (args: {
    projectPath: string;
    filePath: string;
    side: AnnotationSide;
    lineNumber: number;
    commitHash?: string;
  }) => void;
};

type DiffEditHeaderControlsProps = {
  editDraft: EditableDiffDraft | null;
  editUnavailableReason: string | null;
  isPreparingEditor: boolean;
  isSavingEdit: boolean;
  onSaveEdit: () => void;
  onReloadEdit: () => void;
  onCopyEdit: () => void;
};

function DiffEditHeaderControls({
  editDraft,
  editUnavailableReason,
  isPreparingEditor,
  isSavingEdit,
  onSaveEdit,
  onReloadEdit,
  onCopyEdit,
}: DiffEditHeaderControlsProps) {
  if (editDraft?.conflict) {
    return (
      <div className="flex min-w-0 items-center gap-1 text-rose-300">
        <TriangleAlert className="size-3 shrink-0" />
        <span
          className="max-w-28 truncate text-[10px]"
          title="File changed on disk. Reload it or copy your unsaved version."
        >
          Changed on disk
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 rounded-sm text-rose-300 hover:bg-rose-400/15 hover:text-rose-200"
          onClick={(event) => {
            event.stopPropagation();
            onCopyEdit();
          }}
          aria-label="Copy unsaved edits"
          title="Copy unsaved edits"
        >
          <Copy className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 rounded-sm text-rose-300 hover:bg-rose-400/15 hover:text-rose-200"
          onClick={(event) => {
            event.stopPropagation();
            onReloadEdit();
          }}
          aria-label="Reload file from disk"
          title="Reload file from disk"
        >
          <RotateCcw className="size-3" />
        </Button>
      </div>
    );
  }

  const saveTitle = editUnavailableReason
    ? editUnavailableReason
    : editDraft?.error
      ? `${editDraft.error} Retry save (Cmd/Ctrl+S)`
      : editDraft?.dirty
        ? "Save changes (Cmd/Ctrl+S)"
        : "No unsaved changes";

  return (
    <div className="flex min-w-0 items-center gap-1">
      {editDraft?.error ? (
        <span
          className="max-w-24 truncate text-[10px] text-rose-300"
          title={editDraft.error}
        >
          Save failed
        </span>
      ) : editUnavailableReason ? (
        <span
          className="max-w-24 truncate text-[10px] text-zinc-500"
          title={editUnavailableReason}
        >
          Read-only
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "size-5 rounded-sm",
          editDraft?.dirty
            ? "bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 hover:text-amber-200"
            : "text-zinc-500 hover:text-zinc-300",
        )}
        disabled={
          !editDraft?.dirty ||
          isSavingEdit ||
          isPreparingEditor ||
          Boolean(editUnavailableReason)
        }
        onClick={(event) => {
          event.stopPropagation();
          onSaveEdit();
        }}
        aria-label="Save changes"
        title={saveTitle}
      >
        {isSavingEdit || isPreparingEditor ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <Save className="size-3" />
        )}
      </Button>
    </div>
  );
}

function DiffViewerPanel({
  isLoading,
  selectedFile,
  renderedFile,
  diffOptions,
  editorOptions,
  lineAnnotations,
  editDraft,
  editUnavailableReason,
  isPreparingEditor,
  isSavingEdit,
  projectPath,
  selectFile,
  onSaveEdit,
  onReloadEdit,
  onCopyEdit,
  startCommentDraft,
}: DiffViewerPanelProps) {
  return (
    <main className="h-full min-w-0 overflow-auto bg-black/10">
      {isLoading ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="text-muted-foreground size-6 animate-spin" />
        </div>
      ) : selectedFile ? (
        <FileDiff<DiffReviewAnnotationMetadata>
          key={editDraft?.revision ?? getFileDiffSignature(selectedFile)}
          fileDiff={renderedFile ?? selectedFile}
          options={diffOptions}
          edit={Boolean(editDraft)}
          editorOptions={editorOptions}
          lineAnnotations={lineAnnotations}
          renderHeaderMetadata={() =>
            supportsDiffEditing(selectedFile) ? (
              <DiffEditHeaderControls
                editDraft={editDraft}
                editUnavailableReason={editUnavailableReason}
                isPreparingEditor={isPreparingEditor}
                isSavingEdit={isSavingEdit}
                onSaveEdit={onSaveEdit}
                onReloadEdit={onReloadEdit}
                onCopyEdit={onCopyEdit}
              />
            ) : null
          }
          renderAnnotation={() => (
            <DiffCommentAnnotation projectPath={projectPath} />
          )}
          renderGutterUtility={(getHoveredLine) => (
            <AddCommentGutterButton
              onClick={() => {
                const hoveredLine = getHoveredLine();
                if (!selectedFile || !hoveredLine) return;
                selectFile(selectedFile.name);
                startCommentDraft({
                  projectPath,
                  filePath: selectedFile.name,
                  side: hoveredLine.side,
                  lineNumber: hoveredLine.lineNumber,
                });
              }}
            />
          )}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="text-muted-foreground text-sm">
            No uncommitted changes
          </p>
        </div>
      )}
    </main>
  );
}

type DiffFilesSidebarProps = {
  files: FileDiffMetadata[];
  isLoading: boolean;
  selectedFile: FileDiffMetadata | null;
  allFilesConfirmed: boolean;
  someFilesConfirmed: boolean;
  isRefreshing: boolean;
  refreshErrorMessage: string | null;
  canCommit: boolean;
  hasUnsavedEdits: boolean;
  showDiffViewModeToggle: boolean;
  showMobileMenu: boolean;
  requestDiscardAll: () => void;
  isDiscardAllPending: boolean;
  onRefresh: () => void;
  onToggleAllFilesConfirmation: () => void;
  onCommit: () => void;
  onOpenFile?: () => void;
  containerClassName?: string;
  headerClassName?: string;
};

function DiffFilesSidebar({
  files,
  isLoading,
  selectedFile,
  allFilesConfirmed,
  someFilesConfirmed,
  isRefreshing,
  refreshErrorMessage,
  canCommit,
  hasUnsavedEdits,
  showDiffViewModeToggle,
  showMobileMenu,
  requestDiscardAll,
  isDiscardAllPending,
  onRefresh,
  onToggleAllFilesConfirmation,
  onCommit,
  onOpenFile,
  containerClassName,
  headerClassName,
}: DiffFilesSidebarProps) {
  return (
    <div className={cn("flex h-full flex-col bg-black/15", containerClassName)}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 px-2 pointer-coarse:h-11",
                headerClassName,
              )}
            >
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
                onCheckedChange={onToggleAllFilesConfirmation}
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
              {showDiffViewModeToggle ? <DiffViewModeToggle /> : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5 shrink-0 text-muted-foreground hover:text-zinc-200 pointer-coarse:size-8"
                disabled={isRefreshing}
                onClick={onRefresh}
                aria-label="Refresh diff"
                title="Refresh diff"
              >
                <RefreshCw
                  className={cn(
                    "size-3 pointer-coarse:size-4",
                    isRefreshing && "animate-spin",
                  )}
                />
              </Button>
              {showMobileMenu ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-zinc-200"
                      aria-label="Sidebar actions"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={requestDiscardAll}
                      disabled={!files.length || isDiscardAllPending}
                    >
                      <Trash2 className="size-3.5" />
                      Discard all pending changes
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>

            {refreshErrorMessage ? (
              <div
                role="alert"
                className="flex shrink-0 items-start gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200"
              >
                <TriangleAlert className="mt-px size-3 shrink-0" />
                <span className="min-w-0 break-words">
                  Showing the last loaded diff — refresh failed:{" "}
                  {refreshErrorMessage}
                </span>
              </div>
            ) : null}

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
                    showMobileMenu={showMobileMenu}
                    onOpenFile={onOpenFile}
                  />
                ))
              ) : (
                <p className="px-2 py-4 text-xs text-zinc-500">No changes</p>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            variant="destructive"
            onSelect={requestDiscardAll}
            disabled={!files.length || isDiscardAllPending}
          >
            <Trash2 className="size-3.5" />
            Discard all pending changes
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div className="shrink-0 space-y-1 border-t border-border/70 p-1.5 pointer-coarse:p-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 w-full px-2 text-xs pointer-coarse:h-11 pointer-coarse:text-sm"
          disabled={!canCommit}
          onClick={onCommit}
          title={
            hasUnsavedEdits
              ? "Save your diff edits before committing"
              : undefined
          }
        >
          <GitCommitHorizontal className="size-3" />
          Commit
        </Button>
      </div>
    </div>
  );
}

function MobileDiffDetailHeader({
  selectedFile,
  canGoPrev,
  canGoNext,
  onBack,
  onPrev,
  onNext,
}: {
  selectedFile: FileDiffMetadata;
  canGoPrev: boolean;
  canGoNext: boolean;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { requestDiscard, isDiscardPending } =
    useFileListItemDiscardActions(selectedFile);

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 px-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground hover:text-zinc-200"
        onClick={onBack}
        aria-label="Back to file list"
      >
        <ArrowLeft className="size-4" />
      </Button>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {selectedFile.name}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground hover:text-zinc-200"
        disabled={!canGoPrev}
        onClick={onPrev}
        aria-label="Previous file"
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground hover:text-zinc-200"
        disabled={!canGoNext}
        onClick={onNext}
        aria-label="Next file"
      >
        <ChevronDown className="size-4" />
      </Button>
      <DiffViewModeToggle />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground hover:text-zinc-200"
            aria-label="File actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onSelect={requestDiscard}
            disabled={isDiscardPending}
          >
            <Trash2 className="size-3.5" />
            Discard changes
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ProjectDiffPaneContent() {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const projectPath = useProjectDiffStore((state) => state.projectPath);
  const {
    data: files,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery(
    orpc.projects.getUncommittedDiff.queryOptions({
      input: { path: projectPath },
      staleTime: 0,
    }),
  );
  const refreshProjectMutation = useMutation(
    orpc.projects.refreshProject.mutationOptions(),
  );
  const confirm = useConfirmDialogStore((s) => s.confirm);
  const discardAllMutation = useMutation(
    orpc.projects.discardChanges.mutationOptions(),
  );
  const saveEditMutation = useMutation(
    orpc.projects.saveEditableDiffFile.mutationOptions(),
  );
  const isRefreshing = refreshProjectMutation.isPending || isFetching;
  const refreshProjectDiff = () => {
    refreshProjectMutation.mutate(
      { path: projectPath },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: orpc.projects.getUncommittedDiff.queryKey({
              input: { path: projectPath },
            }),
          });
        },
      },
    );
  };

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
  const editableDrafts = useProjectDiffStore((state) => state.editableDrafts);
  const hasUnsavedEdits = Object.values(editableDrafts).some(
    (draft) => draft.dirty,
  );
  const initializeEditableDraft = useProjectDiffStore(
    (state) => state.initializeEditableDraft,
  );
  const updateEditableDraft = useProjectDiffStore(
    (state) => state.updateEditableDraft,
  );
  const removeEditableDraft = useProjectDiffStore(
    (state) => state.removeEditableDraft,
  );
  const removeEditableDrafts = useProjectDiffStore(
    (state) => state.removeEditableDrafts,
  );
  const editorFocusedFilePath = useProjectDiffStore(
    (state) => state.editorFocusedFilePath,
  );
  const setEditorFocusedFilePath = useProjectDiffStore(
    (state) => state.setEditorFocusedFilePath,
  );
  const commentDraft = useDiffCommentStore(
    (state) => state.commentDraftByProject[projectPath] ?? null,
  );
  const startCommentDraft = useDiffCommentStore(
    (state) => state.startCommentDraft,
  );
  const cancelCommentDraft = useDiffCommentStore(
    (state) => state.cancelCommentDraft,
  );
  const applyEditedAnnotationPositions = useDiffCommentStore(
    (state) => state.applyEditedAnnotationPositions,
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

  const editableFileQuery = useQuery({
    ...orpc.projects.getEditableDiffFile.queryOptions({
      input: {
        path: projectPath,
        filePath: selectedFile?.name ?? "__no_selected_file__",
      },
    }),
    enabled: supportsDiffEditing(selectedFile),
    staleTime: 0,
  });
  const refetchEditableFile = editableFileQuery.refetch;

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
  const canCommit = pathsToCommit.length > 0 && !hasUnsavedEdits;
  const selectedFileCount = useMemo(
    () => files?.filter((f) => confirmedFiles.includes(f.name)).length ?? 0,
    [files, confirmedFiles],
  );
  const lineAnnotations = useMemo(
    () =>
      selectedFile
        ? getCommentDraftLineAnnotations(commentDraft, selectedFile.name)
        : [],
    [commentDraft, selectedFile],
  );
  const commentEditorOpen = Boolean(commentDraft && !commentDraft.commitHash);
  const selectedFileSourceSignature = selectedFile
    ? getFileDiffSignature(selectedFile)
    : null;
  const editDraft = selectedFile
    ? (editableDrafts[selectedFile.name] ?? null)
    : null;
  const editableFileResult = editableFileQuery.data;

  useEffect(() => {
    if (
      selectedFileSourceSignature &&
      editableFileResult?.status === "ready" &&
      editableFileResult.sourceSignature !== selectedFileSourceSignature
    ) {
      void queryClient.invalidateQueries({
        queryKey: orpc.projects.getUncommittedDiff.queryKey({
          input: { path: projectPath },
        }),
      });
      void refetchEditableFile();
      return;
    }
    if (
      !selectedFile ||
      !selectedFileSourceSignature ||
      editableFileResult?.status !== "ready" ||
      editableFileResult.sourceSignature !== selectedFileSourceSignature
    ) {
      return;
    }
    initializeEditableDraft(selectedFile.name, {
      sourceSignature: selectedFileSourceSignature,
      fileDiff: editableFileResult.fileDiff,
      revision: editableFileResult.revision,
      initialContents: editableFileResult.contents,
      contents: editableFileResult.contents,
      lineAnnotations,
      dirty: false,
      conflict: false,
      error: null,
    });
  }, [
    editableFileResult,
    initializeEditableDraft,
    lineAnnotations,
    projectPath,
    queryClient,
    refetchEditableFile,
    selectedFile,
    selectedFileSourceSignature,
  ]);

  const effectiveLineAnnotations = useMemo(
    () =>
      editDraft
        ? mergeEditableAnnotations(editDraft.lineAnnotations, lineAnnotations)
        : lineAnnotations,
    [editDraft, lineAnnotations],
  );

  const handleEditorChange: NonNullable<
    EditorOptions<DiffReviewAnnotationMetadata>["onChange"]
  > = useCallback(
    (
      file: FileContents,
      nextAnnotations?:
        | DiffLineAnnotation<DiffReviewAnnotationMetadata>[]
        | LineAnnotation<DiffReviewAnnotationMetadata>[],
    ) => {
      if (!selectedFile || !editDraft) return;
      const nextDiffAnnotations = nextAnnotations?.filter(
        (annotation) => "side" in annotation,
      ) as DiffLineAnnotation<DiffReviewAnnotationMetadata>[] | undefined;
      updateEditableDraft(selectedFile.name, {
        contents: file.contents,
        lineAnnotations: nextDiffAnnotations ?? effectiveLineAnnotations,
        dirty: file.contents !== editDraft.initialContents,
        error: null,
      });
    },
    [editDraft, effectiveLineAnnotations, selectedFile, updateEditableDraft],
  );

  const editorOptions = useMemo(
    () => ({
      onChange: handleEditorChange,
      onFocus: () => setEditorFocusedFilePath(selectedFile?.name ?? null),
      onBlur: () => setEditorFocusedFilePath(null),
    }),
    [handleEditorChange, selectedFile?.name, setEditorFocusedFilePath],
  );

  const saveCurrentEdit = useCallback(() => {
    if (!selectedFile || !editDraft?.dirty || saveEditMutation.isPending) {
      return;
    }
    saveEditMutation.mutate(
      {
        path: projectPath,
        filePath: selectedFile.name,
        contents: editDraft.contents,
        expectedRevision: editDraft.revision,
      },
      {
        onSuccess: (result) => {
          if (result.status === "conflict") {
            updateEditableDraft(selectedFile.name, {
              conflict: true,
              error: null,
            });
            return;
          }
          applyEditedAnnotationPositions(
            projectPath,
            selectedFile.name,
            effectiveLineAnnotations,
          );
          removeEditableDraft(selectedFile.name);
          setEditorFocusedFilePath(null);
          void queryClient.invalidateQueries({
            queryKey: orpc.projects.getUncommittedDiff.queryKey({
              input: { path: projectPath },
            }),
          });
          void refetchEditableFile();
          toast.success("Changes saved");
        },
        onError: (error) => {
          const message = getDiffErrorMessage(error);
          updateEditableDraft(selectedFile.name, { error: message });
          toast.error(message);
        },
      },
    );
  }, [
    applyEditedAnnotationPositions,
    editDraft,
    effectiveLineAnnotations,
    projectPath,
    queryClient,
    refetchEditableFile,
    removeEditableDraft,
    saveEditMutation,
    selectedFile,
    setEditorFocusedFilePath,
    updateEditableDraft,
  ]);

  const reloadCurrentEdit = () => {
    if (!selectedFile || !editDraft) return;
    confirm({
      title: "Reload file from disk?",
      description:
        "Your unsaved edits in this file will be discarded and replaced with the latest version on disk.",
      confirmLabel: "Reload",
      onConfirm: async () => {
        removeEditableDraft(selectedFile.name);
        setEditorFocusedFilePath(null);
        await refetchEditableFile();
      },
    });
  };

  const copyCurrentEdit = () => {
    if (!editDraft) return;
    void navigator.clipboard.writeText(editDraft.contents);
    toast.success("Unsaved edits copied");
  };

  const editUnavailableReason =
    editableFileResult?.status === "unavailable"
      ? editableFileResult.reason
      : editableFileQuery.isError
        ? getDiffErrorMessage(editableFileQuery.error)
        : null;
  const isPreparingEditor =
    supportsDiffEditing(selectedFile) &&
    !editDraft &&
    !editUnavailableReason &&
    editableFileQuery.isFetching;
  const requestDiscardAll = () => {
    if (!files || files.length === 0) return;
    const filePaths = gitPathsForConfirmedFiles(
      files,
      files.map((file) => file.name),
    );
    confirm({
      title: "Discard all pending changes?",
      description: `All changes in ${files.length} changed file${files.length === 1 ? "" : "s"} will be discarded. New files will be permanently deleted. Modified files will be reverted to the last commit. This cannot be undone.`,
      confirmLabel: "Discard all",
      onConfirm: async () => {
        await discardAllMutation.mutateAsync({ path: projectPath, filePaths });
        clearConfirmations();
        removeEditableDrafts();
        cancelCommentDraft(projectPath);
        await queryClient.invalidateQueries({
          queryKey: orpc.projects.getUncommittedDiff.queryKey({
            input: { path: projectPath },
          }),
        });
      },
    });
  };
  const diffViewMode = useDiffViewMode();
  const diffOptions = useMemo(
    () => ({
      ...COMPACT_FILE_DIFF_OPTIONS,
      diffStyle: diffViewMode,
      enableGutterUtility: true,
      lineHoverHighlight: "both" as const,
      onLineNumberClick: ({
        annotationSide,
        lineNumber,
      }: {
        annotationSide: AnnotationSide;
        lineNumber: number;
      }) => {
        if (!selectedFile) return;
        selectFile(selectedFile.name);
        startCommentDraft({
          projectPath,
          filePath: selectedFile.name,
          side: annotationSide,
          lineNumber,
        });
      },
    }),
    [diffViewMode, projectPath, selectFile, selectedFile, startCommentDraft],
  );

  useEffect(() => {
    if (!isMobile) {
      setMobileDetailOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile || !mobileDetailOpen) return;
    if (
      !files?.length ||
      !selectedFilePath ||
      !files.some((file) => file.name === selectedFilePath)
    ) {
      setMobileDetailOpen(false);
    }
  }, [isMobile, mobileDetailOpen, files, selectedFilePath]);

  const canGoPrev = Boolean(files && selectedFileIndex > 0);
  const canGoNext = Boolean(files && selectedFileIndex < files.length - 1);
  const goToPrevFile = () => {
    if (!files || !canGoPrev) return;
    selectFile(files[selectedFileIndex - 1].name);
  };
  const goToNextFile = () => {
    if (!files || !canGoNext) return;
    selectFile(files[selectedFileIndex + 1].name);
  };

  useHotkey("Mod+S", saveCurrentEdit, {
    enabled: Boolean(editDraft?.dirty && !editDraft.conflict),
    ignoreInputs: false,
  });

  useHotkey(
    "ArrowUp",
    () => {
      if (!files || files.length === 0) return;
      const newIndex = (selectedFileIndex - 1 + files.length) % files.length;
      selectFile(files[newIndex].name);
    },
    {
      enabled:
        !commitDialogOpen && !commentEditorOpen && !editorFocusedFilePath,
    },
  );
  useHotkey(
    "ArrowDown",
    () => {
      if (!files || files.length === 0) return;
      const newIndex = (selectedFileIndex + 1) % files.length;
      selectFile(files[newIndex].name);
    },
    {
      enabled:
        !commitDialogOpen && !commentEditorOpen && !editorFocusedFilePath,
    },
  );
  useHotkey(
    "Space",
    () => {
      if (!files?.length || !selectedFile) return;
      toggleFileConfirmation(selectedFile.name);
    },
    {
      enabled: Boolean(
        !commitDialogOpen &&
          !commentEditorOpen &&
          !editorFocusedFilePath &&
          files?.length &&
          selectedFile,
      ),
    },
  );

  if (isError && !files) {
    return (
      <DiffLoadErrorState
        message={getDiffErrorMessage(error)}
        isRetrying={isRefreshing}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!files) return null;

  const sidebarProps = {
    files,
    isLoading,
    selectedFile,
    allFilesConfirmed,
    someFilesConfirmed,
    isRefreshing,
    refreshErrorMessage: isError ? getDiffErrorMessage(error) : null,
    canCommit,
    hasUnsavedEdits,
    requestDiscardAll,
    isDiscardAllPending: discardAllMutation.isPending,
    onRefresh: refreshProjectDiff,
    onToggleAllFilesConfirmation: () =>
      toggleAllFilesConfirmation(files.map((file) => file.name)),
    onCommit: () =>
      openCommitDialog({
        projectPath,
        pathsToCommit,
        selectedFileCount,
        onCommitted: clearConfirmations,
      }),
  };

  const diffViewerProps = {
    isLoading,
    selectedFile,
    renderedFile: editDraft?.fileDiff ?? selectedFile,
    diffOptions,
    editorOptions,
    lineAnnotations: effectiveLineAnnotations,
    editDraft,
    editUnavailableReason,
    isPreparingEditor,
    isSavingEdit: saveEditMutation.isPending,
    projectPath,
    selectFile,
    onSaveEdit: saveCurrentEdit,
    onReloadEdit: reloadCurrentEdit,
    onCopyEdit: copyCurrentEdit,
    startCommentDraft,
  };

  if (isMobile) {
    if (mobileDetailOpen && selectedFile) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <MobileDiffDetailHeader
            selectedFile={selectedFile}
            canGoPrev={canGoPrev}
            canGoNext={canGoNext}
            onBack={() => setMobileDetailOpen(false)}
            onPrev={goToPrevFile}
            onNext={goToNextFile}
          />
          <div className="min-h-0 flex-1">
            <DiffViewerPanel {...diffViewerProps} />
          </div>
        </div>
      );
    }

    return (
      <DiffFilesSidebar
        {...sidebarProps}
        showDiffViewModeToggle
        showMobileMenu
        onOpenFile={() => setMobileDetailOpen(true)}
      />
    );
  }

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
        <DiffViewerPanel {...diffViewerProps} />
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel id="files-sidebar" defaultSize={sidebarSize}>
        <aside className="flex h-full flex-col border-l border-border/70 bg-black/15">
          <DiffFilesSidebar
            {...sidebarProps}
            showDiffViewModeToggle
            showMobileMenu={false}
          />
        </aside>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
