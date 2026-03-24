import { PointerActivationConstraints } from "@dnd-kit/dom";
import type { DragEndEvent } from "@dnd-kit/react";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { Button } from "@renderer/components/ui/button";
import { ContextMenuItem } from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { UsagePanel } from "@renderer/components/usage-panel";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import type { ProjectSessionGroup } from "@renderer/services/terminal-session-selectors";
import {
  buildProjectSessionGroups,
  groupHasAwaitingUserInput,
} from "@renderer/services/terminal-session-selectors";
import { useMutation } from "@tanstack/react-query";
import {
  EllipsisVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  LoaderCircle,
  PlayIcon,
  Plus,
  Settings,
  SquareIcon,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { Session } from "src/main/sessions/state";
import { useConfirmDialogStore } from "./confirm-dialog";
import { useNewSessionDialogStore } from "./new-session-dialog";
import { useProjectDefaultsDialogStore } from "./project-defaults-dialog";
import { useProjectWorktreeDialogStore } from "./project-worktree-dialog";
import { RawSessionStateDialog } from "./raw-session-state-dialog";
import { RenameSessionDialog } from "./rename-session-dialog";
import {
  BaseSessionSidebarItem,
  SidebarIconButton,
} from "./session-sidebar-item";
import { useSettingsStore } from "./settings-dialog";
import { useAppState } from "./sync-state-provider";
import { useWorktreeDeleteDialogStore } from "./worktree-delete-dialog";

const projectDragSensors = [
  PointerSensor.configure({
    activationConstraints: [
      new PointerActivationConstraints.Distance({ value: 5 }),
    ],
  }),
];

function isSessionActive(session: Session): boolean {
  if (session.type === "ralph-loop") {
    return session.loopState.autonomousEnabled || session.status !== "stopped";
  }

  if (session.type === "worktree-setup") {
    return (
      session.status === "running" ||
      session.status === "starting" ||
      session.status === "awaiting_user_response"
    );
  }

  return session.status !== "stopped";
}

async function stopSession(session: Session): Promise<void> {
  switch (session.type) {
    case "claude-local-terminal":
      await orpc.sessions.localClaude.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "local-terminal":
      await orpc.sessions.localTerminal.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "ralph-loop":
      await orpc.sessions.ralphLoop.stopLoop.call({
        sessionId: session.sessionId,
      });
      return;
    case "codex-local-terminal":
      await orpc.sessions.codex.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "cursor-agent":
      await orpc.sessions.cursorAgent.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "worktree-setup":
      await orpc.sessions.worktreeSetup.cancelSetup.call({
        sessionId: session.sessionId,
      });
      return;
    default: {
      const exhaustiveCheck = session satisfies never;
      return exhaustiveCheck;
    }
  }
}

export function SessionSidebar() {
  const projects = useAppState((x) => x.projects);
  const sessions = useAppState((x) => x.sessions);

  const openSettingsDialog = useSettingsStore((x) => x.openSettingsDialog);

  const groups: ProjectSessionGroup[] = useMemo(
    () =>
      buildProjectSessionGroups({
        projects,
        sessionsById: sessions,
      }),
    [projects, sessions],
  );
  const setOpenProjectCwd = useProjectDefaultsDialogStore(
    (x) => x.setOpenProjectCwd,
  );
  const setOpenProjectWorktreePath = useProjectWorktreeDialogStore(
    (x) => x.setOpenProjectPath,
  );
  const openWorktreeDeleteDialog = useWorktreeDeleteDialogStore((x) => x.open);

  const createProjectMutation = useMutation({
    mutationFn: async () => {
      const cwd = await orpc.fs.selectFolder.call();
      if (!cwd) return;
      const { path } = await orpc.projects.addProject.call({ path: cwd });
      setOpenProjectCwd(path);
    },
  });

  const toggleProjectCollapsed = useMutation(
    orpc.projects.setProjectCollapsed.mutationOptions(),
  );

  const deleteProjectMutation = useMutation({
    mutationFn: async ({ path }: { path: string }) => {
      await orpc.projects.deleteProject.call({ path });
    },
  });

  const openFolderMutation = useMutation({
    mutationFn: async (path: string) => {
      await orpc.fs.openFolder.call({ path });
    },
  });

  const reorderProjectsMutation = useMutation({
    mutationFn: async ({
      fromPath,
      toPath,
    }: {
      fromPath: string;
      toPath: string;
    }) => {
      await orpc.projects.reorderProjects.call({ fromPath, toPath });
    },
  });

  const handleDragEnd = useCallback(
    (event: Parameters<DragEndEvent>[0]) => {
      if (event.canceled || !event.operation.source) return;
      const { source } = event.operation;

      if (!isSortable(source)) return;
      const fromIndex = source.sortable.initialIndex;
      const toIndex = source.sortable.index;
      if (fromIndex === toIndex) return;
      const projectGroups = groups.filter((g) => g.fromProjectList);
      const fromGroup = projectGroups[fromIndex];
      const toGroup = projectGroups[toIndex];
      if (!fromGroup || !toGroup) return;
      if (fromGroup.interactionDisabled || toGroup.interactionDisabled) {
        return;
      }
      reorderProjectsMutation.mutate({
        fromPath: fromGroup.path,
        toPath: toGroup.path,
      });
    },
    [groups, reorderProjectsMutation],
  );

  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (x) => x.setOpenProjectCwd,
  );

  return (
    <aside className="flex h-full w-full flex-col border-r border-border/70 bg-black/35 backdrop-blur-xl">
      <div className="flex h-9 items-center border-b border-border/70 pl-16 [app-region:drag]">
        <div className="ml-auto flex h-full items-center [app-region:no-drag]">
          <Button
            variant="flat"
            className="h-full w-9 shrink-0 px-0"
            onClick={openSettingsDialog}
            aria-label="Settings"
            title="Settings"
          >
            <Settings className="size-3.5" />
          </Button>
          <Button
            variant="flat"
            className="h-full w-9 shrink-0 px-0"
            onClick={() => createProjectMutation.mutate()}
            disabled={createProjectMutation.isPending}
            aria-label="Add new project"
            title={
              createProjectMutation.isPending
                ? "Selecting project..."
                : "Add new project"
            }
          >
            {createProjectMutation.isPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <FolderPlus className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div>
          <DragDropProvider
            sensors={projectDragSensors}
            onDragEnd={handleDragEnd}
          >
            {groups
              .filter((g) => g.fromProjectList)
              .map((group, index) => (
                <SortableProjectGroup
                  key={group.path}
                  group={group}
                  index={index}
                  onToggleCollapsed={() =>
                    toggleProjectCollapsed.mutate({
                      path: group.path,
                      collapsed: !group.collapsed,
                    })
                  }
                  onCreateWorktree={() =>
                    setOpenProjectWorktreePath(group.path)
                  }
                  canCreateWorktree={
                    Boolean(group.gitBranch) && !group.isWorktree
                  }
                  onOpenSettings={() => setOpenProjectCwd(group.path)}
                  onOpenFolder={() => openFolderMutation.mutate(group.path)}
                  onDelete={() => {
                    if (group.isWorktree) {
                      openWorktreeDeleteDialog({
                        path: group.path,
                        displayName: group.displayName,
                        gitBranch: group.gitBranch,
                      });
                      return;
                    }

                    const sessionCount = group.sessions.length;
                    const sessionLabel =
                      sessionCount === 1
                        ? "1 session"
                        : `${sessionCount} sessions`;

                    useConfirmDialogStore.getState().confirm({
                      title: "Delete project",
                      description:
                        sessionCount > 0
                          ? `Delete "${group.displayName}" and its ${sessionLabel}? This will also delete the project's sessions from Agent UI.`
                          : `Delete "${group.displayName}" from Agent UI? This cannot be undone.`,
                      confirmLabel: "Delete",
                      onConfirm: async () => {
                        await deleteProjectMutation.mutateAsync({
                          path: group.path,
                        });
                      },
                    });
                  }}
                  isDeleting={deleteProjectMutation.isPending}
                  onNewSession={() => setOpenNewSessionDialogCwd(group.path)}
                />
              ))}
            {groups
              .filter((g) => !g.fromProjectList)
              .map((group) => (
                <section
                  key={group.path}
                  className="group/project border-b border-border/40"
                >
                  <div className="flex items-center">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 px-1.5 py-1 text-left text-sm font-medium text-zinc-100 opacity-90 transition"
                    >
                      <span className="inline-flex w-4 shrink-0" />
                      <FolderOpen
                        className={cn(
                          "size-4 shrink-0",
                          groupHasAwaitingUserInput(group)
                            ? "text-violet-400"
                            : "text-zinc-300",
                        )}
                      />
                      <span className="truncate">{group.displayName}</span>
                    </button>
                  </div>
                  {!group.collapsed ? (
                    <GroupSessionsList sessions={group.sessions} />
                  ) : null}
                </section>
              ))}
          </DragDropProvider>
        </div>
      </div>
      <UsagePanel />
      <RenameSessionDialog />
      <RawSessionStateDialog />
    </aside>
  );
}

function SortableProjectGroup({
  group,
  index,
  onToggleCollapsed,
  onCreateWorktree,
  canCreateWorktree,
  onOpenSettings,
  onOpenFolder,
  onDelete,
  isDeleting,
  onNewSession,
}: {
  group: ProjectSessionGroup;
  index: number;
  onToggleCollapsed: () => void;
  onCreateWorktree: () => void;
  canCreateWorktree: boolean;
  onOpenSettings: () => void;
  onOpenFolder: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onNewSession: () => void;
}) {
  const locked = group.interactionDisabled;
  const { ref, handleRef, isDragging } = useSortable({
    id: group.path,
    index,
    disabled: locked,
  });
  const projectMeta = [group.gitBranch];
  if (group.isWorktree && group.worktreeOriginName) {
    projectMeta.push(`from ${group.worktreeOriginName}`);
  }
  const secondaryLine = projectMeta.filter(Boolean).join(" • ");
  const hasAwaitingUserInput = groupHasAwaitingUserInput(group);
  const activeSessions = group.sessions.filter(isSessionActive);

  const stopAllActiveSessionsMutation = useMutation({
    mutationFn: async (sessionsToStop: Session[]) => {
      const stopResults = await Promise.allSettled(
        sessionsToStop.map((session) => stopSession(session)),
      );
      const failedCount = stopResults.filter(
        (result) => result.status === "rejected",
      ).length;
      if (failedCount > 0) {
        throw new Error(
          `Failed to stop ${failedCount} session${failedCount === 1 ? "" : "s"}.`,
        );
      }
    },
    onSuccess: (_, sessionsToStop) => {
      if (sessionsToStop.length === 0) {
        return;
      }
      toast.success(
        `Stopped ${sessionsToStop.length} active session${sessionsToStop.length === 1 ? "" : "s"}.`,
      );
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to stop active sessions",
      );
    },
  });

  return (
    <section
      ref={ref}
      className={cn(
        "group/project border-b border-border/40",
        isDragging && "opacity-50",
        locked && "opacity-60",
      )}
    >
      <div className="relative flex">
        <button
          ref={handleRef}
          type="button"
          onClick={() => {
            if (!locked) {
              onToggleCollapsed();
            }
          }}
          disabled={locked}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 pl-1.5 pr-[3rem] py-1 text-left transition hover:bg-white/8",
            locked
              ? "cursor-not-allowed"
              : "cursor-grab active:cursor-grabbing",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-sm font-medium text-zinc-100">
              {group.collapsed ? (
                <Folder
                  className={cn(
                    "size-3 shrink-0",
                    hasAwaitingUserInput ? "text-violet-400" : "text-zinc-400",
                  )}
                />
              ) : (
                <FolderOpen
                  className={cn(
                    "size-3 shrink-0",
                    hasAwaitingUserInput ? "text-violet-400" : "text-zinc-400",
                  )}
                />
              )}
              <span className="truncate">{group.displayName}</span>
            </span>
            {secondaryLine ? (
              <span className="mt-0.5 flex items-center gap-1 text-xs text-zinc-400">
                {group.isWorktree ? (
                  <GitFork className="size-3 shrink-0" />
                ) : (
                  <GitBranch className="size-3 shrink-0" />
                )}
                <span className="truncate">{secondaryLine}</span>
              </span>
            ) : null}
          </span>
        </button>
        <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition group-hover/project:opacity-100 group-focus-within/project:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarIconButton
                icon={EllipsisVertical}
                label={`Project menu for ${group.displayName}`}
                disabled={locked}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {canCreateWorktree ? (
                <DropdownMenuItem disabled={locked} onClick={onCreateWorktree}>
                  <GitFork className="size-3.5" />
                  Create worktree project
                </DropdownMenuItem>
              ) : null}
              {canCreateWorktree ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={
                  locked ||
                  stopAllActiveSessionsMutation.isPending ||
                  activeSessions.length === 0
                }
                onClick={() => {
                  stopAllActiveSessionsMutation.mutate(activeSessions);
                }}
              >
                <SquareIcon className="size-3.5" />
                Stop all active sessions
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={locked} onClick={onOpenSettings}>
                <Settings className="size-3.5" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem disabled={locked} onClick={onOpenFolder}>
                <FolderOpen className="size-3.5" />
                Open project folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={locked || isDeleting}
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarIconButton
            icon={Plus}
            label={`New session in ${group.displayName}`}
            onClick={onNewSession}
            disabled={locked}
          />
        </div>
      </div>
      {!group.collapsed ? (
        <div
          className={cn(locked && "pointer-events-none select-none opacity-50")}
        >
          <GroupSessionsList sessions={group.sessions} />
        </div>
      ) : null}
    </section>
  );
}

function GroupSessionsList({
  sessions,
}: {
  sessions: ProjectSessionGroup["sessions"];
}) {
  return (
    <ul className="space-y-0.5">
      {sessions.length > 0 ? (
        sessions.map((session) => {
          switch (session.type) {
            case "claude-local-terminal":
              return (
                <ClaudeLocalTerminalSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                />
              );
            case "local-terminal":
              return null;
            case "codex-local-terminal":
              return (
                <CodexLocalTerminalSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                />
              );
            case "cursor-agent":
              return (
                <CursorAgentSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                />
              );
            case "ralph-loop":
              return (
                <RalphLoopSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                />
              );
            case "worktree-setup":
              return (
                <WorktreeSetupSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                />
              );
            default:
              return null;
          }
        })
      ) : (
        <li className="px-1.5 py-1 text-xs text-zinc-500">No sessions yet</li>
      )}
    </ul>
  );
}

function navigateAwayIfActive(sessionId: string) {
  if (useActiveSessionStore.getState().activeSessionId === sessionId) {
    useActiveSessionStore.getState().setActiveSessionId(null);
  }
}

function ClaudeLocalTerminalSessionSidebarItem({
  sessionId,
}: {
  sessionId: string;
}) {
  const session = useAppState((x) => x.sessions[sessionId]);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.localClaude.deleteSession.call({ sessionId: id });
    },
    onSuccess: () => navigateAwayIfActive(sessionId),
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.localClaude.resumeSession.call({
        sessionId: id,
        cols,
        rows,
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.localClaude.stopLiveSession.call({ sessionId: id });
    },
  });

  const forkMutation = useMutation({
    mutationFn: async (id: string) => {
      const { cols, rows } = getTerminalSize();
      return await orpc.sessions.localClaude.forkSession.call({
        sessionId: id,
        cols,
        rows,
      });
    },
    onSuccess: (newId) => {
      useActiveSessionStore.getState().setActiveSessionId(newId);
    },
  });

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        session.status === "stopped" ? (
          <SidebarIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={resumeMutation.isPending}
            onClick={() => resumeMutation.mutate(sessionId)}
          />
        ) : (
          <SidebarIconButton
            icon={SquareIcon}
            label="Stop session"
            disabled={stopMutation.isPending}
            onClick={() => stopMutation.mutate(sessionId)}
          />
        )
      }
      extraMenuItems={
        <ContextMenuItem
          onClick={() => forkMutation.mutate(sessionId)}
          disabled={forkMutation.isPending}
        >
          <GitFork className="size-3.5" />
          Fork session
        </ContextMenuItem>
      }
      onDelete={() => deleteMutation.mutate(sessionId)}
      deleteDisabled={deleteMutation.isPending}
    />
  );
}

function CodexLocalTerminalSessionSidebarItem({
  sessionId,
}: {
  sessionId: string;
}) {
  const session = useAppState((x) => x.sessions[sessionId]);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.codex.deleteSession.call({ sessionId: id });
    },
    onSuccess: () => navigateAwayIfActive(sessionId),
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.codex.resumeSession.call({
        sessionId: id,
        cols,
        rows,
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.codex.stopLiveSession.call({ sessionId: id });
    },
  });

  const forkMutation = useMutation({
    mutationFn: async (id: string) => {
      const { cols, rows } = getTerminalSize();
      return await orpc.sessions.codex.forkSession.call({
        sessionId: id,
        cols,
        rows,
      });
    },
    onSuccess: ({ sessionId: newId }) => {
      useActiveSessionStore.getState().setActiveSessionId(newId);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to fork session",
      );
    },
  });

  if (!session || session.type !== "codex-local-terminal") {
    return null;
  }

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        session.status === "stopped" ? (
          <SidebarIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={resumeMutation.isPending}
            onClick={() => resumeMutation.mutate(sessionId)}
          />
        ) : (
          <SidebarIconButton
            icon={SquareIcon}
            label="Stop session"
            disabled={stopMutation.isPending}
            onClick={() => stopMutation.mutate(sessionId)}
          />
        )
      }
      extraMenuItems={
        <ContextMenuItem
          onClick={() => forkMutation.mutate(sessionId)}
          disabled={forkMutation.isPending || !session.codexSessionId}
        >
          <GitFork className="size-3.5" />
          Fork session
        </ContextMenuItem>
      }
      onDelete={() => deleteMutation.mutate(sessionId)}
      deleteDisabled={deleteMutation.isPending}
    />
  );
}

function CursorAgentSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const session = useAppState((x) => x.sessions[sessionId]);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.cursorAgent.deleteSession.call({ sessionId: id });
    },
    onSuccess: () => navigateAwayIfActive(sessionId),
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.cursorAgent.resumeSession.call({
        sessionId: id,
        cols,
        rows,
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.cursorAgent.stopLiveSession.call({ sessionId: id });
    },
  });

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        session.status === "stopped" ? (
          <SidebarIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={resumeMutation.isPending}
            onClick={() => resumeMutation.mutate(sessionId)}
          />
        ) : (
          <SidebarIconButton
            icon={SquareIcon}
            label="Stop session"
            disabled={stopMutation.isPending}
            onClick={() => stopMutation.mutate(sessionId)}
          />
        )
      }
      onDelete={() => deleteMutation.mutate(sessionId)}
      deleteDisabled={deleteMutation.isPending}
    />
  );
}

function WorktreeSetupSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const session = useAppState((x) => x.sessions[sessionId]);

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.worktreeSetup.cancelSetup.call({ sessionId: id });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.worktreeSetup.deleteSession.call({ sessionId: id });
    },
    onSuccess: () => navigateAwayIfActive(sessionId),
  });

  if (!session || session.type !== "worktree-setup") {
    return null;
  }

  const isRunning =
    session.status === "running" || session.status === "starting";

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        isRunning ? (
          <SidebarIconButton
            icon={SquareIcon}
            label="Cancel setup"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate(sessionId)}
          />
        ) : null
      }
      onDelete={() => deleteMutation.mutate(sessionId)}
      deleteDisabled={deleteMutation.isPending}
    />
  );
}

function RalphLoopSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.ralphLoop.resumeSession.call({
        sessionId: id,
        cols,
        rows,
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.ralphLoop.stopLoop.call({ sessionId: id });
    },
  });

  const runSingleMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.ralphLoop.runSingleIteration.call({ sessionId: id });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await orpc.sessions.ralphLoop.deleteSession.call({ sessionId: id });
    },
    onSuccess: () => navigateAwayIfActive(sessionId),
  });

  if (!session || session.type !== "ralph-loop") {
    return null;
  }

  const resumeDisabled =
    resumeMutation.isPending ||
    session.loopState.completion === "done" ||
    session.loopState.completion === "max_iterations";

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        session.loopState.autonomousEnabled ? (
          <SidebarIconButton
            icon={SquareIcon}
            label="Stop loop"
            disabled={stopMutation.isPending}
            onClick={() => stopMutation.mutate(sessionId)}
          />
        ) : (
          <SidebarIconButton
            icon={PlayIcon}
            label="Resume loop"
            disabled={resumeDisabled}
            onClick={() => resumeMutation.mutate(sessionId)}
          />
        )
      }
      extraMenuItems={
        <ContextMenuItem
          onClick={() => runSingleMutation.mutate(sessionId)}
          disabled={runSingleMutation.isPending}
        >
          <PlayIcon className="size-3.5" />
          Run single iteration
        </ContextMenuItem>
      }
      onDelete={() => deleteMutation.mutate(sessionId)}
      deleteDisabled={deleteMutation.isPending}
    />
  );
}
