import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  switchSession,
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  getProjectDisplayName,
  getSessionLastActivityLabel,
} from "@renderer/services/terminal-session-selectors";
import { useMutation } from "@tanstack/react-query";
import {
  CircleDot,
  Copy,
  EyeOff,
  FileJson,
  Folder,
  GitFork,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestionMark,
  Pencil,
  Repeat,
  ShieldAlert,
  Square,
  TerminalSquare,
  TrashIcon,
  TriangleAlert,
} from "lucide-react";
import { forwardRef } from "react";
import { toast } from "sonner";
import type { SessionStatus } from "src/main/sessions/common";
import type { Session } from "src/main/sessions/state";
import { useRawSessionStateDialogStore } from "./raw-session-state-dialog";
import { useRenameSessionDialogStore } from "./rename-session-dialog";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
  type SessionTypeIcon,
} from "./session-type-icons";
import { useAppState } from "./sync-state-provider";

export const statusIndicatorMeta: Record<
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

export const sessionTypeIcon: Record<
  string,
  { icon: SessionTypeIcon; label: string }
> = {
  "claude-local-terminal": { icon: ClaudeCodeIcon, label: "Claude Code" },
  "local-terminal": { icon: TerminalSquare, label: "Terminal" },
  "ralph-loop": { icon: Repeat, label: "Ralph Loop" },
  "codex-local-terminal": { icon: CodexIcon, label: "Codex" },
  "cursor-agent": { icon: CursorAgentIcon, label: "Cursor Agent" },
  "worktree-setup": { icon: GitFork, label: "Worktree setup" },
};

export function MoveSessionToProjectSubmenu({ session }: { session: Session }) {
  const projects = useAppState((s) => s.projects);
  const moveSessionToProjectMutation = useMutation({
    mutationFn: (input: { sessionId: string; targetProjectPath: string }) =>
      orpc.sessions.moveSessionToProject.call(input),
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to move session",
      );
    },
  });

  const cwd = session.startupConfig.cwd.trim();
  const targets = projects.filter(
    (p) =>
      p.path !== cwd &&
      p.interactionDisabled !== true &&
      session.status === "stopped" &&
      session.type !== "worktree-setup",
  );

  if (targets.length === 0) {
    return null;
  }

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Folder className="size-3.5" />
          Move to project
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {targets.map((project) => (
            <ContextMenuItem
              key={project.path}
              onClick={() => {
                moveSessionToProjectMutation.mutate({
                  sessionId: session.sessionId,
                  targetProjectPath: project.path,
                });
              }}
            >
              {getProjectDisplayName(project)}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
    </>
  );
}

export function CommonSessionContextMenuItems({
  session,
}: {
  session: Session;
}) {
  const openRename = useRenameSessionDialogStore((x) => x.open);
  const openRawState = useRawSessionStateDialogStore((x) => x.open);

  return (
    <>
      <MoveSessionToProjectSubmenu session={session} />
      <ContextMenuItem
        onClick={() => {
          openRename({
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
          openRawState(session);
        }}
      >
        <FileJson className="size-3.5" />
        View raw JSON
      </ContextMenuItem>
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

export const SessionSidebarItemTrigger = forwardRef<
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
          "flex w-full items-center justify-start gap-1.5 py-1 pl-5 pr-[3rem] text-sm transition",
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

export const SidebarIconButton = forwardRef<
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

export function BaseSessionSidebarItem({
  sessionId,
  primaryButton,
  extraMenuItems,
  onDelete,
  deleteDisabled,
}: {
  sessionId: string;
  primaryButton: React.ReactNode;
  extraMenuItems?: React.ReactNode;
  onDelete: () => void;
  deleteDisabled: boolean;
}) {
  const session = useAppState((x) => x.sessions[sessionId]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SessionSidebarItemTrigger sessionId={sessionId}>
          {primaryButton}
          <SidebarIconButton
            icon={TrashIcon}
            label="Delete session"
            variant="destructive"
            disabled={deleteDisabled}
            onClick={onDelete}
          />
        </SessionSidebarItemTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {extraMenuItems}
        <CommonSessionContextMenuItems session={session} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
