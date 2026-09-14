import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Label } from "@renderer/components/ui/label";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  buildWorktreeManagerRows,
  getProjectDisplayName,
  type WorktreeManagerRow,
} from "@renderer/services/terminal-session-selectors";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GitFork, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useWorktreeManagerDialogStore = create(
  combine(
    {
      originPath: null as string | null,
      selectedPath: null as string | null,
    },
    (set) => ({
      open: (input: { originPath: string; selectedPath?: string | null }) => {
        set({
          originPath: input.originPath,
          selectedPath: input.selectedPath ?? null,
        });
      },
      select: (selectedPath: string | null) => {
        set({ selectedPath });
      },
      close: () => {
        set({ originPath: null, selectedPath: null });
      },
    }),
  ),
);

interface WorktreeStatus {
  branch: string | null;
  upstreamBranch: string | null;
  merged: boolean;
}

function formatChanges(row: WorktreeManagerRow): string {
  if (!row.addedLines && !row.deletedLines) {
    return "No uncommitted changes";
  }

  return `+${row.addedLines} −${row.deletedLines} uncommitted`;
}

function formatPushState(row: WorktreeManagerRow): string {
  if (!row.upstreamBranch) {
    return "Never pushed";
  }
  if (!row.aheadCommits && !row.behindCommits) {
    return `Up to date with ${row.upstreamBranch}`;
  }

  const parts: string[] = [];
  if (row.aheadCommits) {
    parts.push(`${row.aheadCommits} unpushed`);
  }
  if (row.behindCommits) {
    parts.push(`${row.behindCommits} behind`);
  }

  return `${parts.join(", ")} vs ${row.upstreamBranch}`;
}

function formatSessions(row: WorktreeManagerRow): string {
  if (row.activeSessionCount === 0) {
    return "No active sessions";
  }

  return row.activeSessionCount === 1
    ? "1 active session"
    : `${row.activeSessionCount} active sessions`;
}

function formatMergeState(
  status: WorktreeStatus | undefined,
  originBranch: string | null,
): string {
  if (!originBranch) {
    return "Merge state unknown";
  }

  return status?.merged
    ? `Merged into ${originBranch}`
    : `Not merged into ${originBranch}`;
}

export function WorktreeManagerDialog() {
  const originPath = useWorktreeManagerDialogStore((s) => s.originPath);

  return originPath ? (
    <WorktreeManagerDialogBody originPath={originPath} />
  ) : null;
}

function WorktreeManagerDialogBody({ originPath }: { originPath: string }) {
  const selectedPath = useWorktreeManagerDialogStore((s) => s.selectedPath);
  const select = useWorktreeManagerDialogStore((s) => s.select);
  const close = useWorktreeManagerDialogStore((s) => s.close);

  const projects = useAppState((state) => state.projects);
  const sessions = useAppState((state) => state.sessions);

  const originProject = projects.find((project) => project.path === originPath);
  const rows = useMemo(
    () =>
      buildWorktreeManagerRows({
        projects,
        sessionsById: sessions,
        originPath,
      }),
    [projects, sessions, originPath],
  );

  const statusesQuery = useQuery(
    orpc.projects.getWorktreeStatuses.queryOptions({ input: { originPath } }),
  );

  const statusByPath = useMemo(() => {
    const map = new Map<string, WorktreeStatus>();
    for (const status of statusesQuery.data?.statuses ?? []) {
      map.set(status.path, status);
    }
    return map;
  }, [statusesQuery.data]);

  const selectedRow =
    rows.find((row) => row.path === selectedPath) ?? rows[0] ?? null;

  useEffect(() => {
    if (selectedRow && selectedRow.path !== selectedPath) {
      select(selectedRow.path);
    }
  }, [selectedRow, selectedPath, select]);

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          close();
        }
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Worktrees</DialogTitle>
          <DialogDescription>
            Worktrees of{" "}
            {originProject
              ? getProjectDisplayName(originProject)
              : originPath.split("/").pop()}
            .
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            This project has no worktrees.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_1fr]">
            <ul className="max-h-72 space-y-0.5 overflow-y-auto sm:max-h-[24rem]">
              {rows.map((row) => (
                <li key={row.path}>
                  <button
                    type="button"
                    onClick={() => {
                      select(row.path);
                    }}
                    className={cn(
                      "hover:bg-accent/60 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm",
                      row.path === selectedRow?.path && "bg-accent",
                    )}
                  >
                    <GitFork className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">{row.label}</span>
                    {row.removing ? (
                      <LoaderCircle className="text-muted-foreground ml-auto size-3.5 shrink-0 animate-spin" />
                    ) : row.activeSessionCount > 0 ? (
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                        {row.activeSessionCount}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>

            {selectedRow ? (
              <WorktreeDetail
                key={selectedRow.path}
                row={selectedRow}
                status={statusByPath.get(selectedRow.path)}
                originBranch={statusesQuery.data?.originBranch ?? null}
                onDeleted={() => {
                  void statusesQuery.refetch();
                }}
              />
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorktreeDetail({
  row,
  status,
  originBranch,
  onDeleted,
}: {
  row: WorktreeManagerRow;
  status: WorktreeStatus | undefined;
  originBranch: string | null;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [discardChanges, setDiscardChanges] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDirty = row.addedLines > 0 || row.deletedLines > 0;
  const isUnpushed = !row.upstreamBranch || row.aheadCommits > 0;
  const isMerged = status?.merged === true;

  const deleteMutation = useMutation({
    mutationFn: async () =>
      orpc.projects.deleteWorktreeProject.call({
        path: row.path,
        deleteFolder: true,
        deleteBranch: deleteBranch && Boolean(row.branch),
        forceDeleteFolder: discardChanges || isDirty,
        forceDeleteBranch: deleteBranch && !isMerged,
      }),
    onSuccess: (result) => {
      if ("requiresForce" in result && result.requiresForce) {
        setDiscardChanges(true);
        setErrorMessage(
          "This worktree has uncommitted or untracked files. Confirm discarding them to continue.",
        );
        return;
      }

      setConfirming(false);
      toast.info(`Removing ${row.label}...`);
      onDeleted();
    },
    onError: (error) => {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Failed to delete worktree.",
      );
    },
  });

  const warnings = [
    row.activeSessionCount > 0
      ? `${formatSessions(row)} will be closed.`
      : null,
    isDirty ? `${formatChanges(row)} will be discarded.` : null,
    isUnpushed && row.aheadCommits > 0
      ? `${row.aheadCommits} commit(s) have not been pushed.`
      : null,
    !row.upstreamBranch ? "This branch was never pushed." : null,
    deleteBranch && row.branch && !isMerged
      ? `Branch ${row.branch} is not merged into ${originBranch ?? "the origin branch"}.`
      : null,
  ].filter((warning) => warning !== null);

  return (
    <div className="border-border/60 flex min-w-0 flex-col gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.label}</div>
        <div
          className="text-muted-foreground truncate text-xs"
          title={row.path}
        >
          {row.path}
        </div>
      </div>

      <dl className="grid gap-1.5 text-xs sm:grid-cols-2">
        <MetadataItem label="Branch" value={row.branch ?? "No branch"} />
        <MetadataItem label="Sessions" value={formatSessions(row)} />
        <MetadataItem label="Changes" value={formatChanges(row)} />
        <MetadataItem label="Remote" value={formatPushState(row)} />
        <MetadataItem
          label="Merge"
          value={formatMergeState(status, originBranch)}
        />
      </dl>

      {row.removing ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <LoaderCircle className="size-3.5 animate-spin" />
          Removing this worktree...
        </p>
      ) : confirming ? (
        <div className="border-border/60 space-y-3 rounded-md border p-3">
          <p className="text-sm">Delete this worktree?</p>
          {warnings.length > 0 ? (
            <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">
              Nothing will be lost. The folder and branch are safe to remove.
            </p>
          )}

          {row.branch ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="worktree-manager-delete-branch"
                checked={deleteBranch}
                disabled={deleteMutation.isPending}
                onCheckedChange={(checked) => {
                  setDeleteBranch(checked === true);
                }}
              />
              <Label
                htmlFor="worktree-manager-delete-branch"
                className="text-xs font-normal"
              >
                Also delete branch {row.branch}
              </Label>
            </div>
          ) : null}

          {errorMessage ? (
            <p className="text-destructive text-xs">{errorMessage}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => {
                setConfirming(false);
                setErrorMessage(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => {
                setErrorMessage(null);
                deleteMutation.mutate();
              }}
            >
              {deleteMutation.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Delete worktree
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={() => {
              setDeleteBranch(Boolean(row.branch));
              setDiscardChanges(false);
              setErrorMessage(null);
              setConfirming(true);
            }}
          >
            <Trash2 className="size-3.5" />
            Delete worktree
          </Button>
        </div>
      )}
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}
