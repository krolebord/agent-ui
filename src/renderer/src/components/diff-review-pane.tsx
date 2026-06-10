import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
} from "@pierre/diffs/react";
import { FileDiff } from "@pierre/diffs/react";
import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
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
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useCopyToClipboard } from "@renderer/hooks/use-copy-to-clipboard";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  FileDiff as FileDiffIcon,
  FileMinus,
  FilePlus,
  FileText,
  GitCommitHorizontal,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
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
import { Textarea } from "./ui/textarea";

export type BottomPaneView = "terminals" | "diff" | "history";

type DiffReviewComment = {
  id: string;
  filePath: string;
  side: AnnotationSide;
  lineNumber: number;
  fileSignature: string;
  body: string;
  createdAt: number;
  stale: boolean;
};

type DiffReviewCommentDraft = {
  filePath: string;
  side: AnnotationSide;
  lineNumber: number;
  body: string;
};

type DiffReviewCommentEditDraft = {
  commentId: string;
  body: string;
};

type DiffReviewAnnotationMetadata =
  | {
      type: "comment";
      commentId: string;
    }
  | {
      type: "draft";
    };

function createCommentId() {
  return `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_COMMENTS: DiffReviewComment[] = [];

function getBottomPaneViewForProject(
  viewsByProject: Record<string, BottomPaneView>,
  projectPath: string,
): BottomPaneView {
  return viewsByProject[projectPath] ?? "terminals";
}

function getCommentsForProject(
  commentsByProject: Record<string, DiffReviewComment[]>,
  projectPath: string,
) {
  return commentsByProject[projectPath] ?? EMPTY_COMMENTS;
}

function getFileDiffSignature(file: FileDiffMetadata) {
  if (file.prevObjectId || file.newObjectId) {
    return `${file.prevObjectId ?? "0000000"}..${file.newObjectId ?? "0000000"}`;
  }
  return file.hunks.map((hunk) => hunk.hunkSpecs ?? "").join("\n");
}

function formatReviewCommentsForCopy(comments: DiffReviewComment[]) {
  return [...comments]
    .sort((a, b) => {
      const pathCompare = a.filePath.localeCompare(b.filePath);
      if (pathCompare !== 0) return pathCompare;
      if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
      return a.createdAt - b.createdAt;
    })
    .map((comment) => {
      const sideLabel = comment.side === "additions" ? "New" : "Old";
      const staleLabel = comment.stale ? " (outdated)" : "";
      return `- ${comment.filePath} (${sideLabel} line ${comment.lineNumber})${staleLabel}\n${comment.body}`;
    })
    .join("\n\n");
}

export const useDiffReviewStore = create(
  combine(
    {
      bottomPaneViewByProject: {} as Record<string, BottomPaneView>,
      commentsByProject: {} as Record<string, DiffReviewComment[]>,
      commentDraftByProject: {} as Record<
        string,
        DiffReviewCommentDraft | null
      >,
      editingCommentByProject: {} as Record<
        string,
        DiffReviewCommentEditDraft | null
      >,
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
      startCommentDraft: (
        projectPath: string,
        filePath: string,
        side: AnnotationSide,
        lineNumber: number,
      ) => {
        const current = get().commentDraftByProject[projectPath];
        set((state) => ({
          editingCommentByProject: {
            ...state.editingCommentByProject,
            [projectPath]: null,
          },
          commentDraftByProject: {
            ...state.commentDraftByProject,
            [projectPath]:
              current &&
              current.filePath === filePath &&
              current.side === side &&
              current.lineNumber === lineNumber
                ? current
                : { filePath, side, lineNumber, body: "" },
          },
        }));
      },
      updateCommentDraft: (projectPath: string, body: string) => {
        set((state) => {
          const draft = state.commentDraftByProject[projectPath];
          return {
            commentDraftByProject: {
              ...state.commentDraftByProject,
              [projectPath]: draft ? { ...draft, body } : draft,
            },
          };
        });
      },
      cancelCommentDraft: (projectPath: string) => {
        set((state) => ({
          commentDraftByProject: {
            ...state.commentDraftByProject,
            [projectPath]: null,
          },
        }));
      },
      submitCommentDraft: (projectPath: string, fileSignature: string) => {
        const draft = get().commentDraftByProject[projectPath];
        const body = draft?.body.trim();
        if (!draft || !body) return;
        set((state) => ({
          commentsByProject: {
            ...state.commentsByProject,
            [projectPath]: [
              ...getCommentsForProject(state.commentsByProject, projectPath),
              {
                id: createCommentId(),
                filePath: draft.filePath,
                side: draft.side,
                lineNumber: draft.lineNumber,
                fileSignature,
                body,
                createdAt: Date.now(),
                stale: false,
              },
            ],
          },
          commentDraftByProject: {
            ...state.commentDraftByProject,
            [projectPath]: null,
          },
        }));
      },
      startEditComment: (projectPath: string, commentId: string) => {
        const comment = getCommentsForProject(
          get().commentsByProject,
          projectPath,
        ).find((item) => item.id === commentId);
        if (!comment) return;
        set((state) => ({
          commentDraftByProject: {
            ...state.commentDraftByProject,
            [projectPath]: null,
          },
          editingCommentByProject: {
            ...state.editingCommentByProject,
            [projectPath]: {
              commentId,
              body: comment.body,
            },
          },
        }));
      },
      updateEditCommentDraft: (projectPath: string, body: string) => {
        set((state) => {
          const edit = state.editingCommentByProject[projectPath];
          return {
            editingCommentByProject: {
              ...state.editingCommentByProject,
              [projectPath]: edit ? { ...edit, body } : edit,
            },
          };
        });
      },
      cancelEditComment: (projectPath: string) => {
        set((state) => ({
          editingCommentByProject: {
            ...state.editingCommentByProject,
            [projectPath]: null,
          },
        }));
      },
      submitEditComment: (projectPath: string) => {
        const edit = get().editingCommentByProject[projectPath];
        const body = edit?.body.trim();
        if (!edit || !body) return;
        set((state) => ({
          commentsByProject: {
            ...state.commentsByProject,
            [projectPath]: getCommentsForProject(
              state.commentsByProject,
              projectPath,
            ).map((comment) =>
              comment.id === edit.commentId ? { ...comment, body } : comment,
            ),
          },
          editingCommentByProject: {
            ...state.editingCommentByProject,
            [projectPath]: null,
          },
        }));
      },
      deleteComment: (projectPath: string, commentId: string) => {
        set((state) => ({
          commentsByProject: {
            ...state.commentsByProject,
            [projectPath]: getCommentsForProject(
              state.commentsByProject,
              projectPath,
            ).filter((comment) => comment.id !== commentId),
          },
          editingCommentByProject: {
            ...state.editingCommentByProject,
            [projectPath]:
              state.editingCommentByProject[projectPath]?.commentId ===
              commentId
                ? null
                : state.editingCommentByProject[projectPath],
          },
        }));
      },
      refreshStaleComments: (
        projectPath: string,
        files: FileDiffMetadata[],
      ) => {
        const signatureByPath = new Map(
          files.map((file) => [file.name, getFileDiffSignature(file)]),
        );
        const comments = getCommentsForProject(
          get().commentsByProject,
          projectPath,
        );
        const nextComments = comments.map((comment) => {
          const fileSignature = signatureByPath.get(comment.filePath);
          const stale =
            !fileSignature || fileSignature !== comment.fileSignature;
          return comment.stale === stale ? comment : { ...comment, stale };
        });
        if (
          nextComments.every((comment, index) => comment === comments[index])
        ) {
          return;
        }

        set((state) => ({
          commentsByProject: {
            ...state.commentsByProject,
            [projectPath]: nextComments,
          },
        }));
      },
      discardReview: (projectPath: string) => {
        set((state) => ({
          commentsByProject: {
            ...state.commentsByProject,
            [projectPath]: [],
          },
          commentDraftByProject: {
            ...state.commentDraftByProject,
            [projectPath]: null,
          },
          editingCommentByProject: {
            ...state.editingCommentByProject,
            [projectPath]: null,
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
  commentCount,
}: {
  file: FileDiffMetadata;
  selected: boolean;
  commentCount: number;
}) {
  const store = useContext(projectDiffPaneContext);
  const confirmed = useProjectDiffStore((s) =>
    s.confirmedFiles.includes(file.name),
  );
  const hasSelectedFiles = useProjectDiffStore(
    (s) => s.confirmedFiles.length > 0,
  );
  const projectPath = useProjectDiffStore((s) => s.projectPath);
  const selectFile = useProjectDiffStore((s) => s.selectFile);
  const toggleFileConfirmation = useProjectDiffStore(
    (s) => s.toggleFileConfirmation,
  );
  const clearConfirmations = useProjectDiffStore((s) => s.clearConfirmations);

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
        clearConfirmations();
        await queryClient.invalidateQueries({
          queryKey: orpc.projects.getUncommittedDiff.queryKey({
            input: { path: projectPath },
          }),
        });
      },
    });
  };

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
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
                className={
                  additions > 0 ? "ml-1 text-rose-400" : "text-rose-400"
                }
              >
                -{deletions}
              </span>
            )}
          </span>
          {commentCount > 0 ? (
            <span
              className="flex h-4 shrink-0 items-center gap-0.5 rounded-sm bg-sky-500/15 px-1 text-[10px] text-sky-300"
              title={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
            >
              <MessageSquare className="size-2.5" />
              {commentCount}
            </span>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          variant="destructive"
          onSelect={requestDiscard}
          disabled={discardMutation.isPending}
        >
          <Trash2 className="size-3.5" />
          Discard changes
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={requestDiscardSelected}
          disabled={!hasSelectedFiles || discardMutation.isPending}
        >
          <Trash2 className="size-3.5" />
          Discard selected files
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CommentDraftForm({
  body,
  onBodyChange,
  onCancel,
  onSubmit,
  submitLabel,
  placeholder,
}: {
  body: string;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  placeholder: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const initialSelectionEndRef = useRef(body.length);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        initialSelectionEndRef.current,
        initialSelectionEndRef.current,
      );
    });
    return () => window.cancelAnimationFrame(handle);
  }, []);

  return (
    <form
      className="mx-2 my-1 max-w-3xl rounded-md border border-sky-500/40 bg-zinc-950/95 p-2 shadow-lg"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => onBodyChange(event.currentTarget.value)}
        placeholder={placeholder}
        className="min-h-20 resize-y border-zinc-700 bg-zinc-900/80 text-xs"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!body.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function CommentActions({
  projectPath,
  comment,
}: {
  projectPath: string;
  comment: DiffReviewComment;
}) {
  const startEditComment = useDiffReviewStore(
    (state) => state.startEditComment,
  );
  const deleteComment = useDiffReviewStore((state) => state.deleteComment);
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 text-zinc-500 hover:text-zinc-100"
        onClick={() => startEditComment(projectPath, comment.id)}
        aria-label="Edit comment"
      >
        <Pencil className="size-3" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "size-6",
          copied
            ? "text-emerald-400 hover:text-emerald-300"
            : "text-zinc-500 hover:text-zinc-100",
        )}
        onClick={() => {
          void copy(comment.body);
        }}
        aria-label={copied ? "Copied" : "Copy comment"}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 text-zinc-500 hover:text-rose-300"
        onClick={() => deleteComment(projectPath, comment.id)}
        aria-label="Delete comment"
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}

function CommentAnnotation({
  annotation,
  selectedFile,
}: {
  annotation: DiffLineAnnotation<DiffReviewAnnotationMetadata>;
  selectedFile: FileDiffMetadata;
}) {
  const metadata = annotation.metadata;
  const projectPath = useProjectDiffStore((state) => state.projectPath);
  const comments = useDiffReviewStore((state) =>
    getCommentsForProject(state.commentsByProject, projectPath),
  );
  const draft = useDiffReviewStore(
    (state) => state.commentDraftByProject[projectPath] ?? null,
  );
  const editingComment = useDiffReviewStore(
    (state) => state.editingCommentByProject[projectPath] ?? null,
  );
  const updateCommentDraft = useDiffReviewStore(
    (state) => state.updateCommentDraft,
  );
  const cancelCommentDraft = useDiffReviewStore(
    (state) => state.cancelCommentDraft,
  );
  const submitCommentDraft = useDiffReviewStore(
    (state) => state.submitCommentDraft,
  );
  const updateEditCommentDraft = useDiffReviewStore(
    (state) => state.updateEditCommentDraft,
  );
  const cancelEditComment = useDiffReviewStore(
    (state) => state.cancelEditComment,
  );
  const submitEditComment = useDiffReviewStore(
    (state) => state.submitEditComment,
  );

  if (metadata.type === "draft") {
    if (!draft) return null;
    const submitDraft = () => {
      submitCommentDraft(projectPath, getFileDiffSignature(selectedFile));
    };
    return (
      <CommentDraftForm
        body={draft.body}
        onBodyChange={(body) => updateCommentDraft(projectPath, body)}
        onCancel={() => cancelCommentDraft(projectPath)}
        onSubmit={submitDraft}
        submitLabel="Comment"
        placeholder="Leave a comment"
      />
    );
  }

  const comment = comments.find((item) => item.id === metadata.commentId);
  if (!comment) return null;

  if (editingComment?.commentId === comment.id) {
    return (
      <CommentDraftForm
        body={editingComment.body}
        onBodyChange={(body) => updateEditCommentDraft(projectPath, body)}
        onCancel={() => cancelEditComment(projectPath)}
        onSubmit={() => submitEditComment(projectPath)}
        submitLabel="Save"
        placeholder="Edit comment"
      />
    );
  }

  return (
    <div className="mx-2 my-1 max-w-3xl rounded-md border border-border/80 bg-zinc-950/95 p-2 shadow-lg">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-400">
          <MessageSquare className="size-3 text-sky-300" />
          <span className="truncate">
            {comment.side === "additions" ? "New" : "Old"} line{" "}
            {comment.lineNumber}
          </span>
        </div>
        <CommentActions projectPath={projectPath} comment={comment} />
      </div>
      <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-100">
        {comment.body}
      </p>
    </div>
  );
}

function StaleCommentsSection({ comments }: { comments: DiffReviewComment[] }) {
  const projectPath = useProjectDiffStore((state) => state.projectPath);
  const editingComment = useDiffReviewStore(
    (state) => state.editingCommentByProject[projectPath] ?? null,
  );
  const updateEditCommentDraft = useDiffReviewStore(
    (state) => state.updateEditCommentDraft,
  );
  const cancelEditComment = useDiffReviewStore(
    (state) => state.cancelEditComment,
  );
  const submitEditComment = useDiffReviewStore(
    (state) => state.submitEditComment,
  );

  if (comments.length === 0) return null;

  return (
    <section className="border-b border-border/70 bg-zinc-950/80 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
        <MessageSquare className="size-3 text-zinc-500" />
        Outdated comments
      </div>
      <div className="space-y-1.5">
        {comments.map((comment) =>
          editingComment?.commentId === comment.id ? (
            <CommentDraftForm
              key={comment.id}
              body={editingComment.body}
              onBodyChange={(body) => updateEditCommentDraft(projectPath, body)}
              onCancel={() => cancelEditComment(projectPath)}
              onSubmit={() => submitEditComment(projectPath)}
              submitLabel="Save"
              placeholder="Edit comment"
            />
          ) : (
            <div
              key={comment.id}
              className="rounded-md border border-zinc-800 bg-zinc-950/95 p-2"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="min-w-0 text-[11px] text-zinc-500">
                  <span className="truncate">
                    {comment.side === "additions" ? "New" : "Old"} line{" "}
                    {comment.lineNumber}
                  </span>
                </div>
                <CommentActions projectPath={projectPath} comment={comment} />
              </div>
              <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-200">
                {comment.body}
              </p>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function AddCommentGutterButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="relative z-20 ml-6 flex size-5 items-center justify-center rounded-sm border border-sky-300/70 bg-sky-600 text-white shadow-lg ring-1 ring-black/70 hover:bg-sky-500"
      aria-label="Add comment"
      title="Add comment"
      onClick={onClick}
    >
      <MessageSquarePlus className="size-3" />
    </button>
  );
}

function ProjectDiffPaneContent() {
  const queryClient = useQueryClient();

  const projectPath = useProjectDiffStore((state) => state.projectPath);
  const {
    data: files,
    isLoading,
    isFetching,
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
  const comments = useDiffReviewStore((state) =>
    getCommentsForProject(state.commentsByProject, projectPath),
  );
  const commentDraft = useDiffReviewStore(
    (state) => state.commentDraftByProject[projectPath] ?? null,
  );
  const editingComment = useDiffReviewStore(
    (state) => state.editingCommentByProject[projectPath] ?? null,
  );
  const startCommentDraft = useDiffReviewStore(
    (state) => state.startCommentDraft,
  );
  const refreshStaleComments = useDiffReviewStore(
    (state) => state.refreshStaleComments,
  );
  const discardReview = useDiffReviewStore((state) => state.discardReview);
  const { copied: reviewCopied, copy: copyReview } = useCopyToClipboard();
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
  const hasReviewComments = comments.length > 0;
  const selectedFileCount = useMemo(
    () => files?.filter((f) => confirmedFiles.includes(f.name)).length ?? 0,
    [files, confirmedFiles],
  );
  const commentCountsByFile = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const comment of comments) {
      counts[comment.filePath] = (counts[comment.filePath] ?? 0) + 1;
    }
    return counts;
  }, [comments]);
  const lineAnnotations = useMemo(() => {
    if (!selectedFile) return [];
    const annotations: DiffLineAnnotation<DiffReviewAnnotationMetadata>[] =
      comments
        .filter(
          (comment) => comment.filePath === selectedFile.name && !comment.stale,
        )
        .map((comment) => ({
          side: comment.side,
          lineNumber: comment.lineNumber,
          metadata: { type: "comment", commentId: comment.id },
        }));

    if (commentDraft?.filePath === selectedFile.name) {
      annotations.push({
        side: commentDraft.side,
        lineNumber: commentDraft.lineNumber,
        metadata: { type: "draft" },
      });
    }

    return annotations;
  }, [comments, commentDraft, selectedFile]);
  const staleCommentsForSelectedFile = useMemo(() => {
    if (!selectedFile) return [];
    return comments.filter(
      (comment) => comment.filePath === selectedFile.name && comment.stale,
    );
  }, [comments, selectedFile]);
  const commentEditorOpen = Boolean(commentDraft || editingComment);
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
        discardReview(projectPath);
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
        startCommentDraft(
          projectPath,
          selectedFile.name,
          annotationSide,
          lineNumber,
        );
      },
    }),
    [diffViewMode, projectPath, selectFile, selectedFile, startCommentDraft],
  );

  useEffect(() => {
    if (isLoading || !files) return;
    refreshStaleComments(projectPath, files);
  }, [files, isLoading, projectPath, refreshStaleComments]);

  useHotkey(
    "ArrowUp",
    () => {
      if (!files || files.length === 0) return;
      const newIndex = (selectedFileIndex - 1 + files.length) % files.length;
      selectFile(files[newIndex].name);
    },
    { enabled: !commitDialogOpen && !commentEditorOpen },
  );
  useHotkey(
    "ArrowDown",
    () => {
      if (!files || files.length === 0) return;
      const newIndex = (selectedFileIndex + 1) % files.length;
      selectFile(files[newIndex].name);
    },
    { enabled: !commitDialogOpen && !commentEditorOpen },
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
          files?.length &&
          selectedFile,
      ),
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
            <>
              <StaleCommentsSection comments={staleCommentsForSelectedFile} />
              <FileDiff
                fileDiff={selectedFile}
                options={diffOptions}
                lineAnnotations={lineAnnotations}
                renderAnnotation={(annotation) => (
                  <CommentAnnotation
                    annotation={annotation}
                    selectedFile={selectedFile}
                  />
                )}
                renderGutterUtility={(getHoveredLine) => (
                  <AddCommentGutterButton
                    onClick={() => {
                      const hoveredLine = getHoveredLine();
                      if (!selectedFile || !hoveredLine) return;
                      selectFile(selectedFile.name);
                      startCommentDraft(
                        projectPath,
                        selectedFile.name,
                        hoveredLine.side,
                        hoveredLine.lineNumber,
                      );
                    }}
                  />
                )}
              />
            </>
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
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex min-h-0 flex-1 flex-col">
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
                  <DiffViewModeToggle />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0 text-muted-foreground hover:text-zinc-200"
                    disabled={isRefreshing}
                    onClick={refreshProjectDiff}
                    aria-label="Refresh diff"
                    title="Refresh diff"
                  >
                    <RefreshCw
                      className={cn("size-3", isRefreshing && "animate-spin")}
                    />
                  </Button>
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
                        selected={
                          !!selectedFile && selectedFile.name === file.name
                        }
                        commentCount={commentCountsByFile[file.name] ?? 0}
                      />
                    ))
                  ) : (
                    <p className="px-2 py-4 text-xs text-zinc-500">
                      No changes
                    </p>
                  )}
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                variant="destructive"
                onSelect={requestDiscardAll}
                disabled={!files.length || discardAllMutation.isPending}
              >
                <Trash2 className="size-3.5" />
                Discard all pending changes
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          <div className="shrink-0 space-y-1 border-t border-border/70 p-1.5">
            {hasReviewComments ? (
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-6 min-w-0 flex-1 basis-[calc(50%-0.125rem)] gap-1 px-1 py-1 text-[11px] whitespace-normal"
                  onClick={() => discardReview(projectPath)}
                >
                  <Trash2 className="size-2.5 shrink-0" />
                  Discard review
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-auto min-h-6 min-w-0 flex-1 basis-[calc(50%-0.125rem)] gap-1 px-1 py-1 text-[11px] whitespace-normal",
                    reviewCopied && "border-emerald-500/40 text-emerald-400",
                  )}
                  onClick={() => {
                    void copyReview(formatReviewCommentsForCopy(comments));
                  }}
                >
                  {reviewCopied ? (
                    <Check className="size-2.5 shrink-0" />
                  ) : (
                    <Copy className="size-2.5 shrink-0" />
                  )}
                  Copy review
                </Button>
              </div>
            ) : null}
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
