import { PointerActivationConstraints } from "@dnd-kit/dom";
import type { DragEndEvent } from "@dnd-kit/react";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { UsagePanel } from "@renderer/components/usage-panel";
import {
  switchSession,
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import type { ProjectSessionGroup } from "@renderer/services/terminal-session-selectors";
import {
  buildProjectSessionGroups,
  getSessionLastActivityLabel,
} from "@renderer/services/terminal-session-selectors";
import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Copy,
  EllipsisVertical,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  GitFork,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestionMark,
  Pencil,
  PlayIcon,
  Plus,
  Repeat,
  Settings,
  ShieldAlert,
  Square,
  SquareIcon,
  TerminalSquare,
  Trash2,
  TrashIcon,
  TriangleAlert,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { SessionStatus } from "src/main/sessions/common";
import type { Session } from "src/main/sessions/state";
import { useNewSessionDialogStore } from "./new-session-dialog";
import { useProjectDefaultsDialogStore } from "./project-defaults-dialog";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
  type SessionTypeIcon,
} from "./session-type-icons";
import { useSettingsStore } from "./settings-dialog";
import { useAppState } from "./sync-state-provider";

const projectDragSensors = [
  PointerSensor.configure({
    activationConstraints: [
      new PointerActivationConstraints.Distance({ value: 5 }),
    ],
  }),
];

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

const sessionTypeIcon: Record<
  string,
  { icon: SessionTypeIcon; label: string }
> = {
  "claude-local-terminal": { icon: ClaudeCodeIcon, label: "Claude Code" },
  "local-terminal": { icon: TerminalSquare, label: "Terminal" },
  "ralph-loop": { icon: Repeat, label: "Ralph Loop" },
  "codex-local-terminal": { icon: CodexIcon, label: "Codex" },
  "cursor-agent": { icon: CursorAgentIcon, label: "Cursor Agent" },
};

type RenamableSessionType = Session["type"];

interface RenameSessionTarget {
  sessionId: string;
  type: RenamableSessionType;
  title: string;
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
    mutationFn: async ({
      path,
      sessions,
    }: {
      path: string;
      sessions: ProjectSessionGroup["sessions"];
    }) => {
      for (const session of sessions) {
        switch (session.type) {
          case "claude-local-terminal":
            await orpc.sessions.localClaude.deleteSession.call({
              sessionId: session.sessionId,
            });
            break;
          case "local-terminal":
            await orpc.sessions.localTerminal.deleteSession.call({
              sessionId: session.sessionId,
            });
            break;
          case "ralph-loop":
            await orpc.sessions.ralphLoop.deleteSession.call({
              sessionId: session.sessionId,
            });
            break;
          case "codex-local-terminal":
            await orpc.sessions.codex.deleteSession.call({
              sessionId: session.sessionId,
            });
            break;
          case "cursor-agent":
            await orpc.sessions.cursorAgent.deleteSession.call({
              sessionId: session.sessionId,
            });
            break;
        }
      }
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
      if (event.canceled || !event.operation.source || !event.operation.target)
        return;
      const fromPath = String(event.operation.source.id);
      const toPath = String(event.operation.target.id);
      if (fromPath === toPath) return;
      reorderProjectsMutation.mutate({ fromPath, toPath });
    },
    [reorderProjectsMutation],
  );

  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (x) => x.setOpenProjectCwd,
  );
  const [renameTarget, setRenameTarget] = useState<RenameSessionTarget | null>(
    null,
  );

  return (
    <aside className="flex h-full w-[304px] shrink-0 flex-col border-r border-border/70 bg-black/35 backdrop-blur-xl">
      <div className="flex h-12 items-center gap-1.5 border-b border-border/70 px-2">
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
                  onOpenSettings={() => setOpenProjectCwd(group.path)}
                  onOpenFolder={() => openFolderMutation.mutate(group.path)}
                  onDelete={() =>
                    deleteProjectMutation.mutate({
                      path: group.path,
                      sessions: group.sessions,
                    })
                  }
                  isDeleting={deleteProjectMutation.isPending}
                  onNewSession={() => setOpenNewSessionDialogCwd(group.path)}
                  onRenameSession={setRenameTarget}
                />
              ))}
          </DragDropProvider>
          {groups
            .filter((g) => !g.fromProjectList)
            .map((group) => (
              <section
                key={group.path}
                className="group/project rounded-lg border border-transparent bg-white/[0.02] p-0.5 transition hover:border-white/10"
              >
                <div className="flex items-center gap-1.5 rounded-md px-0.5 py-0.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-medium text-zinc-100 opacity-90 transition"
                  >
                    <span className="inline-flex w-4 shrink-0" />
                    <FolderOpen className="size-4 shrink-0 text-zinc-300" />
                    <span className="truncate">{group.name}</span>
                  </button>
                </div>
                {!group.collapsed ? (
                  <GroupSessionsList
                    sessions={group.sessions}
                    onRenameSession={setRenameTarget}
                  />
                ) : null}
              </section>
            ))}
        </div>
      </div>
      <UsagePanel />
      <RenameSessionDialog
        renameTarget={renameTarget}
        onRenameTargetChange={setRenameTarget}
      />
    </aside>
  );
}

function SortableProjectGroup({
  group,
  index,
  onToggleCollapsed,
  onOpenSettings,
  onOpenFolder,
  onDelete,
  isDeleting,
  onNewSession,
  onRenameSession,
}: {
  group: ProjectSessionGroup;
  index: number;
  onToggleCollapsed: () => void;
  onOpenSettings: () => void;
  onOpenFolder: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onNewSession: () => void;
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id: group.path,
    index,
  });

  return (
    <section
      ref={ref}
      className={cn(
        "group/project rounded-lg border border-transparent bg-white/[0.02] p-0.5 transition hover:border-white/10",
        isDragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-1.5 rounded-md px-0.5 py-0.5">
        <button
          ref={handleRef}
          type="button"
          onClick={onToggleCollapsed}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-medium text-zinc-100 transition hover:bg-white/5 active:cursor-grabbing"
        >
          {group.collapsed ? (
            <ChevronRight className="size-4 shrink-0 text-zinc-400" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-zinc-400" />
          )}
          {group.collapsed ? (
            <Folder className="size-4 shrink-0 text-zinc-300" />
          ) : (
            <FolderOpen className="size-4 shrink-0 text-zinc-300" />
          )}
          <span className="truncate">{group.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarIconButton
              icon={EllipsisVertical}
              label={`Project menu for ${group.name}`}
              size="md"
              className="opacity-0 focus-visible:opacity-100 group-hover/project:opacity-100"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={onOpenSettings}>
              <Settings className="size-3.5" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenFolder}>
              <FolderOpen className="size-3.5" />
              Open project folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={isDeleting}
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SidebarIconButton
          icon={Plus}
          label={`New session in ${group.name}`}
          size="md"
          className="opacity-0 focus-visible:opacity-100 group-hover/project:opacity-100"
          onClick={onNewSession}
        />
      </div>
      {!group.collapsed ? (
        <GroupSessionsList
          sessions={group.sessions}
          onRenameSession={onRenameSession}
        />
      ) : null}
    </section>
  );
}

function GroupSessionsList({
  sessions,
  onRenameSession,
}: {
  sessions: ProjectSessionGroup["sessions"];
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  return (
    <ul className="space-y-0.5 px-1 pb-1">
      {sessions.length > 0 ? (
        sessions.map((session) => {
          switch (session.type) {
            case "claude-local-terminal":
              return (
                <ClaudeLocalTerminalSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  onRenameSession={onRenameSession}
                />
              );
            case "local-terminal":
              return (
                <LocalTerminalSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  onRenameSession={onRenameSession}
                />
              );
            case "codex-local-terminal":
              return (
                <CodexLocalTerminalSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  onRenameSession={onRenameSession}
                />
              );
            case "cursor-agent":
              return (
                <CursorAgentSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  onRenameSession={onRenameSession}
                />
              );
            case "ralph-loop":
              return (
                <RalphLoopSessionSidebarItem
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  onRenameSession={onRenameSession}
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

function CommonSessionContextMenuItems({
  session,
  onRenameSession,
}: {
  session: Session;
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  return (
    <>
      <ContextMenuItem
        onClick={() => {
          onRenameSession({
            sessionId: session.sessionId,
            type: session.type,
            title: session.title,
          });
        }}
      >
        <Pencil className="size-3.5" />
        Rename session
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          void orpc.sessions.markUnseen.call({
            sessionId: session.sessionId,
          });
        }}
      >
        <EyeOff className="size-3.5" />
        Mark as unseen
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
    </>
  );
}

function ClaudeLocalTerminalSessionSidebarItem({
  sessionId,
  onRenameSession,
}: {
  sessionId: string;
  onRenameSession: (target: RenameSessionTarget) => void;
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
      const { cols, rows } = getTerminalSize();
      return await orpc.sessions.localClaude.forkSession.call({
        sessionId,
        cols,
        rows,
      });
    },
    onSuccess: (newId) => {
      setActiveSessionId(newId);
    },
  });

  const resumeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.localClaude.resumeSession.call({
        sessionId,
        cols,
        rows,
      });
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
            forkSessionMutation.mutate(sessionId);
          }}
          disabled={forkSessionMutation.isPending}
        >
          <GitFork className="size-3.5" />
          Fork session
        </ContextMenuItem>
        <CommonSessionContextMenuItems
          session={session}
          onRenameSession={onRenameSession}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function LocalTerminalSessionSidebarItem({
  sessionId,
  onRenameSession,
}: {
  sessionId: string;
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.localTerminal.resumeSession.call({
        sessionId,
        cols,
        rows,
      });
    },
  });

  const stopSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.localTerminal.stopLiveSession.call({ sessionId });
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
        <CommonSessionContextMenuItems
          session={session}
          onRenameSession={onRenameSession}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CodexLocalTerminalSessionSidebarItem({
  sessionId,
  onRenameSession,
}: {
  sessionId: string;
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.codex.resumeSession.call({ sessionId, cols, rows });
    },
  });

  const stopSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.codex.stopLiveSession.call({ sessionId });
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.codex.deleteSession.call({ sessionId });
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
        <CommonSessionContextMenuItems
          session={session}
          onRenameSession={onRenameSession}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CursorAgentSessionSidebarItem({
  sessionId,
  onRenameSession,
}: {
  sessionId: string;
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);

  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.cursorAgent.resumeSession.call({
        sessionId,
        cols,
        rows,
      });
    },
  });

  const stopSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.cursorAgent.stopLiveSession.call({ sessionId });
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await orpc.sessions.cursorAgent.deleteSession.call({ sessionId });
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
        <CommonSessionContextMenuItems
          session={session}
          onRenameSession={onRenameSession}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RalphLoopSessionSidebarItem({
  sessionId,
  onRenameSession,
}: {
  sessionId: string;
  onRenameSession: (target: RenameSessionTarget) => void;
}) {
  const setActiveSessionId = useActiveSessionStore((x) => x.setActiveSessionId);
  const session = useAppState((x) => x.sessions[sessionId]);

  const resumeLoopMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.ralphLoop.resumeSession.call({
        sessionId,
        cols,
        rows,
      });
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
        <CommonSessionContextMenuItems
          session={session}
          onRenameSession={onRenameSession}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameSessionDialog({
  renameTarget,
  onRenameTargetChange,
}: {
  renameTarget: RenameSessionTarget | null;
  onRenameTargetChange: (target: RenameSessionTarget | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const renameSessionMutation = useMutation({
    mutationFn: async (target: RenameSessionTarget) => {
      switch (target.type) {
        case "claude-local-terminal":
          await orpc.sessions.localClaude.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "local-terminal":
          await orpc.sessions.localTerminal.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "codex-local-terminal":
          await orpc.sessions.codex.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "cursor-agent":
          await orpc.sessions.cursorAgent.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "ralph-loop":
          await orpc.sessions.ralphLoop.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
      }
    },
    onSuccess: () => {
      onRenameTargetChange(null);
    },
    onError: () => {
      toast.error("Failed to rename session");
    },
  });

  useEffect(() => {
    setTitle(renameTarget?.title ?? "");
    setError(null);
  }, [renameTarget]);

  const closeDialog = () => {
    if (renameSessionMutation.isPending) {
      return;
    }
    onRenameTargetChange(null);
  };

  return (
    <Dialog
      open={renameTarget !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>
            Update the title shown in the sidebar.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!renameTarget) {
              return;
            }

            const nextTitle = title.trim();
            if (!nextTitle) {
              setError("Session name cannot be empty");
              return;
            }

            renameSessionMutation.mutate({
              ...renameTarget,
              title: nextTitle,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="rename-session-title">Session name</Label>
            <Input
              id="rename-session-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              autoFocus
              maxLength={120}
              disabled={renameSessionMutation.isPending}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={renameSessionMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={renameSessionMutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SessionSidebarItemTrigger = forwardRef<
  HTMLLIElement,
  {
    sessionId: string;
    children: React.ReactNode;
  } & React.HTMLAttributes<HTMLLIElement>
>(function SessionSidebarItemTrigger({ sessionId, children, ...props }, ref) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const isActive = useActiveSessionStore(
    (x) => x.activeSessionId === sessionId,
  );

  const statusMeta = statusIndicatorMeta[session.status];

  return (
    <li
      ref={ref}
      {...props}
      className={cn("group/session relative", props.className)}
    >
      <button
        type="button"
        onClick={() => switchSession(sessionId)}
        className={cn(
          "flex w-full items-center justify-start gap-1.5 rounded-md px-1.5 py-1 pr-[3rem] text-sm transition",
          isActive
            ? "bg-white/15 text-white"
            : session.status === "stopped"
              ? "text-zinc-500 hover:bg-white/8 hover:text-zinc-300"
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
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5 transition group-hover/session:opacity-0 group-focus-within/session:opacity-0">
        <span className="w-7 text-right text-xs tabular-nums text-zinc-400">
          {getSessionLastActivityLabel(session)}
        </span>
        {sessionTypeIcon[session.type] &&
          (() => {
            const typeMeta = sessionTypeIcon[session.type];
            return (
              <span className="inline-flex" title={typeMeta.label}>
                <typeMeta.icon
                  className="size-3 text-zinc-500"
                  aria-hidden="true"
                />
              </span>
            );
          })()}
      </span>
      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition group-hover/session:opacity-100 group-focus-within/session:opacity-100">
        {children}
      </div>
    </li>
  );
});

const SidebarIconButton = forwardRef<
  HTMLButtonElement,
  {
    icon: LucideIcon;
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    variant?: "default" | "destructive";
    size?: "sm" | "md";
    className?: string;
  }
>(function SidebarIconButton(
  { icon, label, onClick, disabled, variant, size = "sm", className, ...props },
  ref,
) {
  const Icon = icon;
  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "pointer-events-auto inline-flex items-center justify-center text-zinc-300 transition",
        size === "sm" ? "size-5 rounded" : "size-6 rounded-md",
        disabled
          ? "cursor-not-allowed opacity-40"
          : variant === "destructive"
            ? "hover:bg-white/10 hover:text-rose-300"
            : "hover:bg-white/10 hover:text-white",
        className,
      )}
      disabled={disabled}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon className={size === "sm" ? "size-3" : "size-3.5"} />
    </button>
  );
});
