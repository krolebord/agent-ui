import { UsagePanel } from "@renderer/components/usage-panel";
import { cn } from "@renderer/lib/utils";
import type { ProjectSessionGroup } from "@renderer/services/terminal-session-selectors";
import {
  buildProjectSessionGroups,
  getSessionLastActivityLabel,
} from "@renderer/services/terminal-session-selectors";
import {
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { forwardRef, useMemo } from "react";
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
  Plus,
  Settings,
  Square,
  Trash2,
  TriangleAlert,
  type LucideIcon,
  SquareIcon,
  PlayIcon,
  TrashIcon,
  ShieldAlert,
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
import type { SessionStatus } from "src/main/sessions/common";

const statusIndicatorMeta: Record<
  SessionStatus,
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
  starting: {
    icon: LoaderCircle,
    label: "Loading",
    className: "text-zinc-400",
    animate: true,
  },
  running: {
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
  awaiting_user_response: {
    icon: MessageCircleQuestionMark,
    label: "Awaiting user response",
    className: "text-violet-400",
  },
  awaiting_approval: {
    icon: ShieldAlert,
    label: "Awaiting approval",
    className: "text-amber-400",
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
                    group.sessions.map((session) => {
                      switch (session.type) {
                        case "claude-local-terminal":
                          return (
                            <ClaudeLocalTerminalSessionSidebarItem
                              key={session.sessionId}
                              sessionId={session.sessionId}
                            />
                          );
                        case "local-terminal":
                          return (
                            <LocalTerminalSessionSidebarItem
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
                        default:
                          return null;
                      }
                    })
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

function ClaudeLocalTerminalSessionSidebarItem({
  sessionId,
}: {
  sessionId: string;
}) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const session = useAppState((x) => x.sessions[sessionId]);

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localClaude.deleteSession.call({ sessionId });
    },
    onSuccess: () => {
      if (useActiveSessionStore.getState().activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
  });

  const forkSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      return await orpc.sessions.localClaude.forkSession.call({ sessionId });
    },
    onSuccess: (newId) => {
      setActiveSessionId(newId);
    },
  });

  const resumeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localClaude.resumeSession.call({ sessionId });
    },
  });

  const stopSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localClaude.stopLiveSession.call({ sessionId });
    },
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SessionSidebarItemTrigger
          sessionId={sessionId}
          onSessionSelect={() => {
            orpc.sessions.localClaude.markSeen.call({ sessionId });
          }}
        >
          {session.status === "stopped" ? (
            <SidebarIconButton
              icon={PlayIcon}
              label="Resume session"
              disabled={resumeSessionMutation.isPending}
              onClick={() => {
                resumeSessionMutation.mutate(sessionId);
              }}
            />
          ) : (
            <SidebarIconButton
              icon={SquareIcon}
              label="Stop session"
              disabled={stopSessionMutation.isPending}
              onClick={() => {
                stopSessionMutation.mutate(sessionId);
              }}
            />
          )}
          <SidebarIconButton
            icon={TrashIcon}
            label="Delete session"
            variant="destructive"
            disabled={deleteSessionMutation.isPending}
            onClick={() => {
              deleteSessionMutation.mutate(sessionId);
            }}
          />
        </SessionSidebarItemTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            forkSessionMutation.mutate(sessionId);
          }}
          disabled={forkSessionMutation.isPending}
        >
          <GitFork className="size-3.5" />
          Fork session
        </ContextMenuItem>
        <ContextMenuSeparator />
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
      </ContextMenuContent>
    </ContextMenu>
  );
}

function LocalTerminalSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localTerminal.resumeSession.call({ sessionId });
    },
  });

  const stopSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localTerminal.stopLiveSession.call({ sessionId });
    },
    onSuccess: () => {
      if (useActiveSessionStore.getState().activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localTerminal.deleteSession.call({ sessionId });
    },
    onSuccess: () => {
      if (useActiveSessionStore.getState().activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SessionSidebarItemTrigger sessionId={sessionId}>
          {session.status === "stopped" ? (
            <SidebarIconButton
              icon={PlayIcon}
              label="Resume session"
              disabled={resumeSessionMutation.isPending}
              onClick={() => {
                resumeSessionMutation.mutate(sessionId);
              }}
            />
          ) : (
            <SidebarIconButton
              icon={SquareIcon}
              label="Stop session"
              disabled={stopSessionMutation.isPending}
              onClick={() => {
                stopSessionMutation.mutate(sessionId);
              }}
            />
          )}
          <SidebarIconButton
            icon={TrashIcon}
            label="Delete session"
            variant="destructive"
            disabled={deleteSessionMutation.isPending}
            onClick={() => {
              deleteSessionMutation.mutate(sessionId);
            }}
          />
        </SessionSidebarItemTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
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
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RalphLoopSessionSidebarItem({ sessionId }: { sessionId: string }) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);
  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeLoopMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.ralphLoop.resumeSession.call({ sessionId });
    },
  });

  const stopLoopMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.ralphLoop.stopLoop.call({ sessionId });
    },
  });

  const runSingleMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.ralphLoop.runSingleIteration.call({ sessionId });
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.ralphLoop.deleteSession.call({ sessionId });
    },
    onSuccess: () => {
      if (useActiveSessionStore.getState().activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
  });

  if (!session || session.type !== "ralph-loop") {
    return null;
  }

  const resumeDisabled =
    resumeLoopMutation.isPending ||
    session.loopState.completion === "done" ||
    session.loopState.completion === "max_iterations";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SessionSidebarItemTrigger sessionId={sessionId}>
          {session.loopState.autonomousEnabled ? (
            <SidebarIconButton
              icon={SquareIcon}
              label="Stop loop"
              disabled={stopLoopMutation.isPending}
              onClick={() => {
                stopLoopMutation.mutate(sessionId);
              }}
            />
          ) : (
            <SidebarIconButton
              icon={PlayIcon}
              label="Resume loop"
              disabled={resumeDisabled}
              onClick={() => {
                resumeLoopMutation.mutate(sessionId);
              }}
            />
          )}
          <SidebarIconButton
            icon={TrashIcon}
            label="Delete session"
            variant="destructive"
            disabled={deleteSessionMutation.isPending}
            onClick={() => {
              deleteSessionMutation.mutate(sessionId);
            }}
          />
        </SessionSidebarItemTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            runSingleMutation.mutate(sessionId);
          }}
          disabled={runSingleMutation.isPending}
        >
          <PlayIcon className="size-3.5" />
          Run single iteration
        </ContextMenuItem>
        <ContextMenuSeparator />
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
      </ContextMenuContent>
    </ContextMenu>
  );
}

const SessionSidebarItemTrigger = forwardRef<
  HTMLLIElement,
  {
    sessionId: string;
    children: React.ReactNode;
    onSessionSelect?: () => void;
  } & React.HTMLAttributes<HTMLLIElement>
>(function SessionSidebarItemTrigger(
  { sessionId, children, onSessionSelect, ...props },
  ref,
) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const isActive = useActiveSessionStore(
    (x) => x.activeSessionId === sessionId,
  );

  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const statusMeta = statusIndicatorMeta[session.status];

  return (
    <li
      ref={ref}
      {...props}
      className={cn("group/session relative", props.className)}
    >
      <button
        type="button"
        onClick={() => {
          setActiveSessionId(sessionId);
          onSessionSelect?.();
        }}
        className={cn(
          "flex w-full items-center justify-start gap-1.5 rounded-md px-1.5 py-1 pr-[3rem] text-sm transition",
          isActive
            ? "bg-white/15 text-white"
            : "text-zinc-300 hover:bg-white/8 hover:text-zinc-100",
        )}
      >
        <span className="inline-flex shrink-0" title={statusMeta.label}>
          <statusMeta.icon
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
        {getSessionLastActivityLabel(session)}
      </span>
      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition group-hover/session:opacity-100 group-focus-within/session:opacity-100">
        {children}
      </div>
    </li>
  );
});

function SidebarIconButton({
  icon,
  label,
  onClick,
  disabled,
  variant,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
}) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "pointer-events-auto inline-flex size-5 items-center justify-center rounded text-zinc-300 transition",
        disabled
          ? "cursor-not-allowed opacity-40"
          : variant === "destructive"
            ? "hover:bg-white/10 hover:text-rose-300"
            : "hover:bg-white/10 hover:text-white",
      )}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3" />
    </button>
  );
}
