import { PointerActivationConstraints } from "@dnd-kit/dom";
import type { DragEndEvent } from "@dnd-kit/react";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { Session } from "@main/sessions/state";
import { MachineStatsLine } from "@renderer/components/machine-stats-line";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { UsagePanel } from "@renderer/components/usage-panel";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { useIsMobile } from "@renderer/hooks/use-is-mobile";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { useMobileNavStore } from "@renderer/hooks/use-mobile-nav";
import {
  stopSession,
  useSessionLifecycleActions,
} from "@renderer/hooks/use-session-lifecycle-actions";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { hasNativeDesktopShell } from "@renderer/lib/native-shell";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import type { ProjectSessionGroup } from "@renderer/services/terminal-session-selectors";
import {
  buildProjectSessionGroups,
  groupHasAwaitingUserInput,
} from "@renderer/services/terminal-session-selectors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronRight,
  EllipsisVertical,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  ImageIcon,
  MonitorSmartphone,
  PackageOpen,
  PlayIcon,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  SquareIcon,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAddProjectDialogStore } from "./add-project-dialog";
import { useConfirmDialogStore } from "./confirm-dialog";
import { useNewSessionDialogStore } from "./new-session-dialog";
import { useProjectDefaultsDialogStore } from "./project-defaults-dialog";
import { ProjectFavicon } from "./project-favicon";
import { useProjectWorktreeDialogStore } from "./project-worktree-dialog";
import { RawSessionStateDialog } from "./raw-session-state-dialog";
import { RenameSessionDialog } from "./rename-session-dialog";
import {
  BaseSessionSidebarItem,
  type SessionMenuAction,
  SidebarIconButton,
  statusIndicatorMeta,
} from "./session-sidebar-item";
import { useSettingsStore } from "./settings-dialog";
import { SidebarViewToggle } from "./sidebar-view-toggle";
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
  if (session.type === "worktree-setup") {
    return (
      session.status === "running" ||
      session.status === "starting" ||
      session.status === "awaiting_user_response"
    );
  }

  return session.status !== "stopped";
}

function projectHasRunningTerminal(
  projectTerminals: Record<
    string,
    { terminals: Record<string, { status: string }> }
  >,
  projectPath: string,
): boolean {
  const workspace = projectTerminals[projectPath];
  if (!workspace) return false;
  return Object.values(workspace.terminals).some(
    (terminal) => terminal.status === "running",
  );
}

function ProjectActiveSessionsPill({
  projectPath,
  sessions,
}: {
  projectPath: string;
  sessions: Session[];
}) {
  const activeSessionCount = sessions.filter(isSessionActive).length;
  const hasRunningTerminal = useAppState((state) =>
    projectHasRunningTerminal(state.projectTerminals, projectPath),
  );

  if (activeSessionCount === 0 && !hasRunningTerminal) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex min-w-[1.125rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums leading-4",
        hasRunningTerminal
          ? "bg-emerald-500/20 text-emerald-400"
          : "bg-zinc-700/60 text-zinc-400",
      )}
    >
      {activeSessionCount}
    </span>
  );
}

export function SessionSidebar() {
  const projects = useAppState((x) => x.projects);
  const sessions = useAppState((x) => x.sessions);
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);

  const openSettingsDialog = useSettingsStore((x) => x.openSettingsDialog);
  const openAddProjectDialog = useAddProjectDialogStore((x) => x.open);
  const mainView = useMainViewStore((state) => state.view);
  const toggleSkills = useMainViewStore((state) => state.toggleSkills);
  const toggleScheduledSessions = useMainViewStore(
    (state) => state.toggleScheduledSessions,
  );
  const toggleAccounts = useMainViewStore((state) => state.toggleAccounts);
  const toggleArtifacts = useMainViewStore((state) => state.toggleArtifacts);

  const groups: ProjectSessionGroup[] = useMemo(
    () =>
      buildProjectSessionGroups({
        projects,
        sessionsById: sessions,
      }),
    [projects, sessions],
  );
  const visibleProjectGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.fromProjectList && (showHiddenProjects || !group.hidden),
      ),
    [groups, showHiddenProjects],
  );
  const untrackedGroups = useMemo(
    () => groups.filter((group) => !group.fromProjectList),
    [groups],
  );
  const setOpenProjectCwd = useProjectDefaultsDialogStore(
    (x) => x.setOpenProjectCwd,
  );
  const setOpenProjectWorktreePath = useProjectWorktreeDialogStore(
    (x) => x.setOpenProjectPath,
  );
  const openWorktreeDeleteDialog = useWorktreeDeleteDialogStore((x) => x.open);

  const toggleProjectCollapsed = useMutation(
    orpc.projects.setProjectCollapsed.mutationOptions(),
  );
  const toggleProjectHidden = useMutation(
    orpc.projects.setProjectHidden.mutationOptions(),
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
      const fromGroup = visibleProjectGroups[fromIndex];
      const toGroup = visibleProjectGroups[toIndex];
      if (!fromGroup || !toGroup) return;
      if (fromGroup.interactionDisabled || toGroup.interactionDisabled) {
        return;
      }
      reorderProjectsMutation.mutate({
        fromPath: fromGroup.path,
        toPath: toGroup.path,
      });
    },
    [reorderProjectsMutation, visibleProjectGroups],
  );

  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (x) => x.setOpenProjectCwd,
  );

  return (
    <aside className="flex h-full w-full flex-col border-r border-border/70 bg-black/35 backdrop-blur-xl">
      <div className="flex h-9 items-center border-b border-border/70 pl-16 [app-region:drag]">
        <div className="ml-auto flex h-full items-center [app-region:no-drag]">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="flat"
                className={cn(
                  "h-full w-9 shrink-0 px-0",
                  (mainView === "skills" ||
                    mainView === "scheduledSessions" ||
                    mainView === "accounts" ||
                    mainView === "artifacts") &&
                    "text-zinc-100",
                )}
                aria-label="More sidebar actions"
                title="More"
              >
                <EllipsisVertical className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={toggleSkills}>
                <Sparkles className="size-3.5" />
                Skills
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleScheduledSessions}>
                <CalendarClock className="size-3.5" />
                Scheduled sessions
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleAccounts}>
                <Users className="size-3.5" />
                Accounts
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleArtifacts}>
                <PackageOpen className="size-3.5" />
                Artifacts
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setShowHiddenProjects((value) => !value)}
              >
                {showHiddenProjects ? (
                  <Eye className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5" />
                )}
                {showHiddenProjects
                  ? "Hide hidden projects"
                  : "Show hidden projects"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openSettingsDialog}>
                <Settings className="size-3.5" />
                Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarViewToggle />
          <Button
            variant="flat"
            className="h-full w-9 shrink-0 px-0"
            onClick={openAddProjectDialog}
            aria-label="Add new project"
            title="Add new project"
          >
            <FolderPlus className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <DragDropProvider
          sensors={projectDragSensors}
          onDragEnd={handleDragEnd}
        >
          {visibleProjectGroups.map((group, index) => (
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
              onCreateWorktree={() => setOpenProjectWorktreePath(group.path)}
              canCreateWorktree={Boolean(group.gitBranch) && !group.isWorktree}
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
                  sessionCount === 1 ? "1 session" : `${sessionCount} sessions`;

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
              onToggleHidden={() =>
                toggleProjectHidden.mutate({
                  path: group.path,
                  hidden: !group.hidden,
                })
              }
              isTogglingHidden={toggleProjectHidden.isPending}
              onNewSession={() => setOpenNewSessionDialogCwd(group.path)}
            />
          ))}
          {untrackedGroups.map((group) => (
            <section
              key={group.path}
              className="group/project border-b border-border/40"
            >
              <div className="flex items-center">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 px-1.5 py-1 text-left text-sm font-medium text-zinc-100 opacity-90 transition pointer-coarse:py-2"
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
                  <ProjectActiveSessionsPill
                    projectPath={group.path}
                    sessions={group.sessions}
                  />
                </button>
              </div>
              {!group.collapsed ? (
                <GroupSessionsList sessions={group.sessions} />
              ) : null}
            </section>
          ))}
        </DragDropProvider>
      </ScrollArea>
      <UsagePanel />
      <MachineStatsLine />
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
  onToggleHidden,
  isTogglingHidden,
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
  onToggleHidden: () => void;
  isTogglingHidden: boolean;
  onNewSession: () => void;
}) {
  const locked = group.interactionDisabled;
  const isMobile = useIsMobile();
  const { ref, handleRef, isDragging } = useSortable({
    id: group.path,
    index,
    disabled: locked || isMobile,
  });
  const projectMeta = [group.gitBranch];
  if (group.isWorktree && group.worktreeOriginName) {
    projectMeta.push(`from ${group.worktreeOriginName}`);
  }
  const secondaryLine = projectMeta.filter(Boolean).join(" • ");
  const aheadCommits =
    group.gitUpstreamDiffStats && group.gitUpstreamDiffStats.aheadCommits > 0
      ? group.gitUpstreamDiffStats.aheadCommits
      : undefined;
  const behindCommits =
    group.gitUpstreamDiffStats && group.gitUpstreamDiffStats.behindCommits > 0
      ? group.gitUpstreamDiffStats.behindCommits
      : undefined;
  const hasAwaitingUserInput = groupHasAwaitingUserInput(group);
  const activeSessions = group.sessions.filter(isSessionActive);

  const refreshGitMutation = useMutation(
    orpc.projects.refreshProject.mutationOptions(),
  );

  const queryClient = useQueryClient();
  // Discovery is on a long cooldown in main, so this is the escape hatch for
  // "I just added an icon and want to see it now".
  const refreshFaviconMutation = useMutation(
    orpc.projects.refreshFavicon.mutationOptions({
      onSuccess: (_data, variables) =>
        queryClient.invalidateQueries({
          queryKey: orpc.projects.getFavicon.key({
            input: { path: variables.path },
          }),
        }),
    }),
  );

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
        group.hidden && "bg-zinc-950/35",
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
            "flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-[3rem] text-left transition hover:bg-white/8 pointer-coarse:py-2 pointer-coarse:pr-[4.75rem]",
            locked
              ? "cursor-not-allowed"
              : "cursor-grab active:cursor-grabbing",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-sm font-medium text-zinc-100">
              {/* The project's own icon, with no collapsed/expanded variant:
                  whether the sessions are showing says that already. The
                  awaiting-input tint the folder used to carry moves to the
                  name, since an arbitrary image can't be recolored. */}
              <ProjectFavicon
                projectPath={group.path}
                className={cn(
                  "size-3.5",
                  hasAwaitingUserInput ? "text-violet-400" : "text-zinc-400",
                )}
              />
              <span
                className={cn(
                  "truncate",
                  hasAwaitingUserInput && "text-violet-300",
                )}
              >
                {group.displayName}
              </span>
              {group.hidden ? (
                <EyeOff
                  className="size-3 shrink-0 text-zinc-500"
                  aria-hidden="true"
                />
              ) : null}
              <ProjectActiveSessionsPill
                projectPath={group.path}
                sessions={group.sessions}
              />
            </span>
            {secondaryLine ? (
              <span className="mt-0.5 flex items-center gap-1 text-xs text-zinc-400">
                {group.isWorktree ? (
                  <GitFork className="size-3 shrink-0" />
                ) : (
                  <GitBranch className="size-3 shrink-0" />
                )}
                {aheadCommits || behindCommits ? (
                  <span
                    className="shrink-0 font-mono text-[10px] text-zinc-400"
                    title={
                      group.gitUpstreamDiffStats
                        ? `${aheadCommits ?? 0} ahead, ${behindCommits ?? 0} behind ${group.gitUpstreamDiffStats.upstreamBranch}`
                        : undefined
                    }
                  >
                    {aheadCommits ? <span>↑{aheadCommits}</span> : null}
                    {behindCommits ? (
                      <span className={aheadCommits ? "ml-1" : undefined}>
                        ↓{behindCommits}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <span className="truncate">{secondaryLine}</span>
              </span>
            ) : null}
          </span>
        </button>
        <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition group-hover/project:opacity-100 group-focus-within/project:opacity-100 pointer-coarse:opacity-100">
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
              {hasNativeDesktopShell ? (
                <DropdownMenuItem disabled={locked} onClick={onOpenFolder}>
                  <FolderOpen className="size-3.5" />
                  Open project folder
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={locked || refreshGitMutation.isPending}
                onClick={() => refreshGitMutation.mutate({ path: group.path })}
              >
                <RefreshCw className="size-3.5" />
                Refresh git status
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={locked || refreshFaviconMutation.isPending}
                onClick={() =>
                  refreshFaviconMutation.mutate({ path: group.path })
                }
              >
                <ImageIcon className="size-3.5" />
                Refresh project icon
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={locked || isTogglingHidden}
                onClick={onToggleHidden}
              >
                {group.hidden ? (
                  <Eye className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5" />
                )}
                {group.hidden ? "Unhide project" : "Hide project"}
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

function activateSessionAndCloseSidebar(sessionId: string) {
  useActiveSessionStore.getState().setActiveSessionId(sessionId);
  useMobileNavStore.getState().closeSidebar();
}

function ClaudeLocalTerminalSessionSidebarItem({
  sessionId,
}: {
  sessionId: string;
}) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const lifecycle = useSessionLifecycleActions(session);

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
      activateSessionAndCloseSidebar(newId);
    },
  });

  const isRunning = session.status !== "stopped";
  const isRemote =
    session.type === "claude-local-terminal"
      ? (session.startupConfig.remoteControl ?? false)
      : false;

  const toggleRemoteControlMutation = useMutation({
    mutationFn: async (id: string) => {
      const nextRemote = !isRemote;
      if (isRunning) {
        await orpc.sessions.localClaude.stopLiveSession.call({ sessionId: id });
      }
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.localClaude.resumeSession.call({
        sessionId: id,
        cols,
        rows,
        remoteControl: nextRemote,
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to toggle remote control",
      );
    },
  });

  const verb = isRunning ? "Restart" : "Start";
  const remoteControlLabel = isRemote
    ? `${verb} without remote control`
    : `${verb} with remote control`;

  const extraMenuActions: SessionMenuAction[] = [
    {
      type: "item",
      key: "fork-session",
      label: "Fork session",
      icon: GitFork,
      onSelect: () => forkMutation.mutate(sessionId),
      disabled: forkMutation.isPending,
    },
    {
      type: "item",
      key: "toggle-remote-control",
      label: remoteControlLabel,
      icon: MonitorSmartphone,
      onSelect: () => toggleRemoteControlMutation.mutate(sessionId),
      disabled: toggleRemoteControlMutation.isPending,
    },
  ];

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        lifecycle.resume ? (
          <SidebarIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={lifecycle.isResumePending}
            onClick={lifecycle.resume}
          />
        ) : lifecycle.stop ? (
          <SidebarIconButton
            icon={SquareIcon}
            label={lifecycle.stopLabel}
            disabled={lifecycle.isStopPending}
            onClick={lifecycle.stop}
          />
        ) : null
      }
      extraMenuActions={extraMenuActions}
      onDelete={lifecycle.remove}
      deleteDisabled={lifecycle.isRemovePending}
    />
  );
}

function CodexLocalTerminalSessionSidebarItem({
  sessionId,
}: {
  sessionId: string;
}) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const [subagentsCollapsed, setSubagentsCollapsed] = useState(false);
  const lifecycle = useSessionLifecycleActions(session);

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
      activateSessionAndCloseSidebar(newId);
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

  const subagentIds =
    session.subagentOrder ??
    Object.keys(session.subagentsByThreadId ?? {}).sort((a, b) => {
      const left = session.subagentsByThreadId?.[a]?.createdAt ?? 0;
      const right = session.subagentsByThreadId?.[b]?.createdAt ?? 0;
      return left - right;
    });
  const subagents = subagentIds
    .map((id) => session.subagentsByThreadId?.[id])
    .filter((subagent): subagent is NonNullable<typeof subagent> =>
      Boolean(subagent),
    );
  const hasSubagents = subagents.length > 0;
  const extraMenuActions: SessionMenuAction[] = [
    {
      type: "item",
      key: "fork-session",
      label: "Fork session",
      icon: GitFork,
      onSelect: () => forkMutation.mutate(sessionId),
      disabled: forkMutation.isPending || !session.codexSessionId,
    },
  ];

  return (
    <>
      <BaseSessionSidebarItem
        sessionId={sessionId}
        leading={
          hasSubagents ? (
            <button
              type="button"
              aria-label={
                subagentsCollapsed ? "Expand subagents" : "Collapse subagents"
              }
              title={
                subagentsCollapsed ? "Expand subagents" : "Collapse subagents"
              }
              className="pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center rounded text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
              onClick={(event) => {
                event.stopPropagation();
                setSubagentsCollapsed((value) => !value);
              }}
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform",
                  !subagentsCollapsed && "rotate-90",
                )}
              />
            </button>
          ) : undefined
        }
        primaryButton={
          lifecycle.resume ? (
            <SidebarIconButton
              icon={PlayIcon}
              label="Resume session"
              disabled={lifecycle.isResumePending}
              onClick={lifecycle.resume}
            />
          ) : lifecycle.stop ? (
            <SidebarIconButton
              icon={SquareIcon}
              label={lifecycle.stopLabel}
              disabled={lifecycle.isStopPending}
              onClick={lifecycle.stop}
            />
          ) : null
        }
        extraMenuActions={extraMenuActions}
        onDelete={lifecycle.remove}
        deleteDisabled={lifecycle.isRemovePending}
      />
      {hasSubagents && !subagentsCollapsed
        ? subagents.map((subagent) => (
            <CodexSubagentSidebarItem
              key={subagent.threadId}
              subagent={subagent}
            />
          ))
        : null}
    </>
  );
}

function CodexSubagentSidebarItem({
  subagent,
}: {
  subagent: NonNullable<
    NonNullable<
      Extract<Session, { type: "codex-local-terminal" }>["subagentsByThreadId"]
    >[string]
  >;
}) {
  const statusMeta = statusIndicatorMeta[subagent.status];
  const displayName =
    subagent.nickname?.trim() ||
    subagent.role?.trim() ||
    subagent.preview?.trim() ||
    "Subagent";
  const secondary = subagent.nickname?.trim()
    ? subagent.role?.trim()
    : undefined;
  const title = [displayName, secondary, subagent.message]
    .filter(Boolean)
    .join(" - ");

  return (
    <li
      className="flex min-h-6 items-center gap-1.5 py-0.5 pl-10 pr-2 text-xs text-zinc-400 pointer-coarse:min-h-10 pointer-coarse:py-2"
      title={title || undefined}
    >
      <span
        className="inline-flex shrink-0"
        title={statusMeta.label}
        role="img"
        aria-label={statusMeta.label}
      >
        <statusMeta.icon
          className={cn(
            "size-3",
            statusMeta.className,
            statusMeta.animate && "animate-spin",
          )}
          aria-hidden="true"
        />
      </span>
      <GitFork className="size-3 shrink-0 text-zinc-600" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {displayName}
        {secondary ? (
          <span className="ml-1 text-zinc-500">({secondary})</span>
        ) : null}
      </span>
      {subagent.message ? (
        <span className="max-w-20 truncate text-zinc-500">
          {subagent.message}
        </span>
      ) : null}
    </li>
  );
}

function CursorAgentSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const lifecycle = useSessionLifecycleActions(session);

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        lifecycle.resume ? (
          <SidebarIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={lifecycle.isResumePending}
            onClick={lifecycle.resume}
          />
        ) : lifecycle.stop ? (
          <SidebarIconButton
            icon={SquareIcon}
            label={lifecycle.stopLabel}
            disabled={lifecycle.isStopPending}
            onClick={lifecycle.stop}
          />
        ) : null
      }
      onDelete={lifecycle.remove}
      deleteDisabled={lifecycle.isRemovePending}
    />
  );
}

function WorktreeSetupSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const lifecycle = useSessionLifecycleActions(session);

  if (!session || session.type !== "worktree-setup") {
    return null;
  }

  return (
    <BaseSessionSidebarItem
      sessionId={sessionId}
      primaryButton={
        lifecycle.stop ? (
          <SidebarIconButton
            icon={SquareIcon}
            label={lifecycle.stopLabel}
            disabled={lifecycle.isStopPending}
            onClick={lifecycle.stop}
          />
        ) : null
      }
      onDelete={lifecycle.remove}
      deleteDisabled={lifecycle.isRemovePending}
    />
  );
}
