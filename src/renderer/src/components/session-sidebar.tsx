import { UsagePanel } from "@renderer/components/usage-panel";
import { cn } from "@renderer/lib/utils";
import type {
  ProjectSessionGroup,
  SessionSidebarIndicatorState,
} from "@renderer/services/terminal-session-selectors";
import {
  buildProjectSessionGroups,
  getSessionLastActivityLabel,
  getSessionSidebarIndicatorState,
} from "@renderer/services/terminal-session-selectors";
import {
  useActiveSessionId,
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { useMemo } from "react";
import {
  CircleDot,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  GitFork,
  LoaderCircle,
  MessageCircleQuestionMark,
  Play,
  Plus,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useAppState } from "./sync-state-provider";
import { useSettingsStore } from "./settings-dialog";
import { useProjectDefaultsDialogStore } from "./project-defaults-dialog";
import { useMutation } from "@tanstack/react-query";
import { orpc } from "@renderer/orpc-client";
import { useNewSessionDialogStore } from "./new-session-dialog";

const statusIndicatorMeta: Record<
  SessionSidebarIndicatorState,
  {
    icon: LucideIcon;
    label: string;
    className: string;
    animate?: boolean;
  }
> = {
  idle: {
    icon: CircleDot,
    label: "Idle",
    className: "text-zinc-500",
  },
  loading: {
    icon: LoaderCircle,
    label: "Loading",
    className: "text-zinc-400",
    animate: true,
  },
  pending: {
    icon: LoaderCircle,
    label: "Pending",
    className: "text-sky-400",
    animate: true,
  },
  stopping: {
    icon: LoaderCircle,
    label: "Stopping",
    className: "text-amber-300",
    animate: true,
  },
  running: {
    icon: Play,
    label: "Running",
    className: "text-emerald-400",
  },
  awaiting_approval: {
    icon: ShieldAlert,
    label: "Awaiting approval",
    className: "text-amber-400",
  },
  awaiting_user_response: {
    icon: MessageCircleQuestionMark,
    label: "Awaiting user response",
    className: "text-violet-400",
  },
  stopped: {
    icon: Square,
    label: "Stopped",
    className: "text-zinc-500",
  },
  error: {
    icon: TriangleAlert,
    label: "Error",
    className: "text-rose-400",
  },
};

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
    mutationFn: async (path: string) => {
      await orpc.projects.deleteProject.call({ path });
    },
  });

  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (x) => x.setOpenProjectCwd,
  );

  return (
    <aside className="flex h-full w-[304px] shrink-0 flex-col border-r border-border/70 bg-black/35 backdrop-blur-xl">
      <div className="flex items-center gap-1.5 border-b border-border/70 p-2">
        <button
          type="button"
          onClick={openSettingsDialog}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-zinc-300 transition hover:bg-white/10 hover:text-white"
          aria-label="Settings"
        >
          <Settings className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => createProjectMutation.mutate()}
          disabled={createProjectMutation.isPending}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FolderPlus className="size-3.5" />
          {createProjectMutation.isPending
            ? "Selecting project..."
            : "Add new project"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-1.5">
          {groups.map((group) => (
            <section
              key={group.path}
              className="group/project rounded-lg border border-transparent bg-white/[0.02] p-0.5 transition hover:border-white/10"
            >
              <div className="flex items-center gap-1.5 rounded-md px-0.5 py-0.5">
                <button
                  type="button"
                  onClick={() => {
                    if (group.fromProjectList) {
                      toggleProjectCollapsed.mutate({
                        path: group.path,
                        collapsed: !group.collapsed,
                      });
                    }
                  }}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-medium text-zinc-100 transition",
                    group.fromProjectList
                      ? "hover:bg-white/5"
                      : "cursor-default opacity-90",
                  )}
                >
                  {group.fromProjectList ? (
                    group.collapsed ? (
                      <ChevronRight className="size-4 shrink-0 text-zinc-400" />
                    ) : (
                      <ChevronDown className="size-4 shrink-0 text-zinc-400" />
                    )
                  ) : (
                    <span className="inline-flex w-4 shrink-0" />
                  )}
                  {group.collapsed ? (
                    <Folder className="size-4 shrink-0 text-zinc-300" />
                  ) : (
                    <FolderOpen className="size-4 shrink-0 text-zinc-300" />
                  )}
                  <span className="truncate">{group.name}</span>
                </button>

                {group.fromProjectList ? (
                  <>
                    {group.sessions.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          deleteProjectMutation.mutate(group.path);
                        }}
                        className="inline-flex size-6 items-center justify-center rounded-md text-zinc-300 opacity-0 transition hover:bg-white/10 hover:text-rose-300 focus-visible:opacity-100 group-hover/project:opacity-100"
                        aria-label={`Delete project ${group.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setOpenProjectCwd(group.path);
                      }}
                      className="inline-flex size-6 items-center justify-center rounded-md text-zinc-300 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover/project:opacity-100"
                      aria-label={`Project defaults for ${group.name}`}
                    >
                      <Settings className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenNewSessionDialogCwd(group.path);
                      }}
                      className="inline-flex size-6 items-center justify-center rounded-md text-zinc-300 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover/project:opacity-100"
                      aria-label={`New session in ${group.name}`}
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </>
                ) : null}
              </div>

              {!group.collapsed ? (
                <ul className="space-y-0.5 px-1 pb-1">
                  {group.sessions.length > 0 ? (
                    group.sessions.map((session) => (
                      <SessionSidebarItem
                        key={session.sessionId}
                        sessionId={session.sessionId}
                      />
                    ))
                  ) : (
                    <li className="px-1.5 py-1 text-xs text-zinc-500">
                      No sessions yet
                    </li>
                  )}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      </div>
      <UsagePanel />
    </aside>
  );
}

function SessionSidebarItem({ sessionId }: { sessionId: string }) {
  const activeSessionId = useActiveSessionId();
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const session = useAppState((x) => x.sessions[sessionId]);

  const isActive = activeSessionId === sessionId;

  const statusState = getSessionSidebarIndicatorState(session);
  const statusMeta = statusIndicatorMeta[statusState];
  const StatusIcon = statusMeta.icon;
  const lastActivity = getSessionLastActivityLabel(session);
  const ariaLabel = `${session.title} (${statusMeta.label})`;
  const canStop =
    session.terminal.status === "starting" ||
    session.terminal.status === "running";
  const canResume = session.terminal.status === "stopped";
  const canControl = canStop || canResume;
  const canFork =
    session.terminal.status === "running" ||
    session.terminal.status === "stopped" ||
    session.terminal.status === "starting";
  const ControlIcon = canResume ? Play : Square;
  const controlTitle =
    session.terminal.status === "stopping"
      ? "Stopping session"
      : canResume
        ? "Resume session"
        : "Stop session";
  const controlAriaLabel =
    session.terminal.status === "stopping"
      ? `${session.title} is stopping`
      : canResume
        ? `Resume ${session.title}`
        : `Stop ${session.title}`;

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.deleteSession.call({ sessionId });
    },
  });

  return (
    <li className="group/session relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <button
              type="button"
              onClick={() => {
                setActiveSessionId(sessionId);
              }}
              className={cn(
                "flex w-full items-center justify-start gap-1.5 rounded-md px-1.5 py-1 pr-[3rem] text-sm transition",
                isActive
                  ? "bg-white/15 text-white"
                  : "text-zinc-300 hover:bg-white/8 hover:text-zinc-100",
              )}
              aria-label={ariaLabel}
            >
              <span className="inline-flex shrink-0" title={statusMeta.label}>
                <StatusIcon
                  className={cn(
                    "size-3",
                    statusMeta.className,
                    statusMeta.animate && "animate-spin",
                  )}
                  aria-hidden="true"
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-left">
                {session.title}
              </span>
            </button>
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs tabular-nums text-zinc-400 transition group-hover/session:opacity-0 group-focus-within/session:opacity-0">
              {lastActivity}
            </span>
            <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition group-hover/session:opacity-100 group-focus-within/session:opacity-100">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (canResume) {
                    void orpc.sessions.resumeSession
                      .call({ sessionId })
                      .then((newId) => {
                        setActiveSessionId(newId);
                      });
                  } else {
                    void orpc.sessions.stopLiveSession.call({ sessionId });
                  }
                }}
                className={cn(
                  "pointer-events-auto inline-flex size-5 items-center justify-center rounded text-zinc-300 transition",
                  canControl
                    ? "hover:bg-white/10 hover:text-white"
                    : "cursor-not-allowed opacity-40",
                )}
                aria-label={controlAriaLabel}
                title={controlTitle}
                disabled={!canControl}
              >
                <ControlIcon className="size-3" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  const wasActive = activeSessionId === sessionId;
                  void orpc.sessions.deleteSession
                    .call({ sessionId })
                    .then(() => {
                      if (wasActive) {
                        setActiveSessionId(null);
                      }
                    });
                }}
                disabled={deleteSessionMutation.isPending}
                className={cn(
                  "pointer-events-auto inline-flex size-5 items-center justify-center rounded text-zinc-300 transition",
                  deleteSessionMutation.isPending
                    ? "cursor-not-allowed opacity-40"
                    : "hover:bg-white/10 hover:text-rose-300",
                )}
                aria-label={`Delete ${session.title}`}
                title="Delete session"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {canFork ? (
            <ContextMenuItem
              onClick={() => {
                void orpc.sessions.forkSession
                  .call({ sessionId })
                  .then((newId) => {
                    setActiveSessionId(newId);
                  });
              }}
            >
              <GitFork className="size-3.5" />
              Fork session
            </ContextMenuItem>
          ) : null}
          {canControl || canFork ? <ContextMenuSeparator /> : null}
          <ContextMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(session.sessionId);
              toast.success("Session ID copied");
            }}
          >
            <Copy className="size-3.5" />
            Copy session ID
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(session.startupConfig.cwd);
              toast.success("Working directory copied");
            }}
          >
            <Copy className="size-3.5" />
            Copy working directory
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              deleteSessionMutation.mutate(sessionId, {
                onSuccess: () => {
                  if (activeSessionId === sessionId) {
                    setActiveSessionId(null);
                  }
                },
              });
            }}
          >
            <Trash2 className="size-3.5" />
            Delete session
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
