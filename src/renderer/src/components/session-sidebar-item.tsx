import type { SessionStatus } from "@main/sessions/common";
import type { Session } from "@main/sessions/state";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  switchSession,
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { useMobileNavStore } from "@renderer/hooks/use-mobile-nav";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  buildProjectSessionGroups,
  getProjectDisplayName,
  getSessionLastActivityLabel,
  getVisibleSessionIds,
} from "@renderer/services/terminal-session-selectors";
import {
  canSettleSession,
  resolveNextActiveSessionId,
} from "@shared/session-lifecycle";
import { useMutation } from "@tanstack/react-query";
import {
  Check,
  CircleDot,
  Copy,
  EyeOff,
  FileJson,
  Folder,
  GitFork,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestionMark,
  MonitorSmartphone,
  MoreHorizontal,
  Pencil,
  ShieldAlert,
  Square,
  TerminalSquare,
  TrashIcon,
  TriangleAlert,
} from "lucide-react";
import { forwardRef, useCallback } from "react";
import { toast } from "sonner";
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
  "codex-local-terminal": { icon: CodexIcon, label: "Codex" },
  "cursor-agent": { icon: CursorAgentIcon, label: "Cursor Agent" },
  "worktree-setup": { icon: GitFork, label: "Worktree setup" },
};

type SessionMenuActionItem = {
  type: "item";
  key?: string;
  label: string;
  icon?: LucideIcon;
  /** Muted right-aligned column, for a value the label refers to but shouldn't
      repeat (a snooze preset's wake time, say). */
  trailingLabel?: string;
  onSelect: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
};

type SessionMenuSeparator = {
  type: "separator";
  key?: string;
};

type SessionMenuSubmenu = {
  type: "submenu";
  key?: string;
  label: string;
  icon?: LucideIcon;
  items: SessionMenuActionItem[];
};

export type SessionMenuAction =
  | SessionMenuActionItem
  | SessionMenuSeparator
  | SessionMenuSubmenu;

function useMoveSessionToProjectActions(session: Session): SessionMenuAction[] {
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
    return [];
  }

  return [
    {
      type: "submenu",
      key: "move-to-project",
      label: "Move to project",
      icon: Folder,
      items: targets.map((project) => ({
        type: "item",
        key: `move-to-project:${project.path}`,
        label: getProjectDisplayName(project),
        onSelect: () => {
          moveSessionToProjectMutation.mutate({
            sessionId: session.sessionId,
            targetProjectPath: project.path,
          });
        },
      })),
    },
    { type: "separator", key: "after-move-to-project" },
  ];
}

function getSessionInitialPrompt(session: Session): string | undefined {
  if (!("initialPrompt" in session.startupConfig)) {
    return undefined;
  }
  const prompt = session.startupConfig.initialPrompt?.trim();
  return prompt || undefined;
}

/**
 * Fork / remote-control and other type-only menu items. Shared by the project
 * tree and inbox so those extras cannot drift between views. Accepts undefined
 * so callers can keep a "session missing" guard below the hook calls.
 */
export function useTypeSpecificSessionMenuActions(
  session: Session | undefined,
): SessionMenuAction[] {
  const forkClaudeMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      return await orpc.sessions.localClaude.forkSession.call({
        sessionId,
        cols,
        rows,
      });
    },
    onSuccess: (newId) => {
      switchSession(newId);
      useMobileNavStore.getState().closeSidebar();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to fork session",
      );
    },
  });

  const forkCodexMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      return await orpc.sessions.codex.forkSession.call({
        sessionId,
        cols,
        rows,
      });
    },
    onSuccess: ({ sessionId: newId }) => {
      switchSession(newId);
      useMobileNavStore.getState().closeSidebar();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to fork session",
      );
    },
  });

  const isClaude = session?.type === "claude-local-terminal";
  const isRunning = session !== undefined && session.status !== "stopped";
  const isRemote =
    isClaude && session.type === "claude-local-terminal"
      ? (session.startupConfig.remoteControl ?? false)
      : false;

  const toggleRemoteControlMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const nextRemote = !isRemote;
      if (isRunning) {
        await orpc.sessions.localClaude.stopLiveSession.call({ sessionId });
      }
      const { cols, rows } = getTerminalSize();
      await orpc.sessions.localClaude.resumeSession.call({
        sessionId,
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

  if (session?.type === "claude-local-terminal") {
    const verb = isRunning ? "Restart" : "Start";
    const remoteControlLabel = isRemote
      ? `${verb} without remote control`
      : `${verb} with remote control`;

    return [
      {
        type: "item",
        key: "fork-session",
        label: "Fork session",
        icon: GitFork,
        onSelect: () => forkClaudeMutation.mutate(session.sessionId),
        disabled: forkClaudeMutation.isPending,
      },
      {
        type: "item",
        key: "toggle-remote-control",
        label: remoteControlLabel,
        icon: MonitorSmartphone,
        onSelect: () => toggleRemoteControlMutation.mutate(session.sessionId),
        disabled: toggleRemoteControlMutation.isPending,
      },
    ];
  }

  if (session?.type === "codex-local-terminal") {
    return [
      {
        type: "item",
        key: "fork-session",
        label: "Fork session",
        icon: GitFork,
        onSelect: () => forkCodexMutation.mutate(session.sessionId),
        disabled: forkCodexMutation.isPending || !session.codexSessionId,
      },
    ];
  }

  return [];
}

export function useCommonSessionMenuActions(
  session: Session,
): SessionMenuAction[] {
  const openRename = useRenameSessionDialogStore((x) => x.open);
  const openRawState = useRawSessionStateDialogStore((x) => x.open);
  const moveSessionToProjectActions = useMoveSessionToProjectActions(session);
  const initialPrompt = getSessionInitialPrompt(session);

  return [
    ...moveSessionToProjectActions,
    {
      type: "item",
      key: "rename-session",
      label: "Rename session",
      icon: Pencil,
      onSelect: () => {
        openRename({
          sessionId: session.sessionId,
          type: session.type,
          title: session.title,
        });
      },
    },
    {
      type: "item",
      key: "mark-unseen",
      label: "Mark as unseen",
      icon: EyeOff,
      onSelect: () => {
        void orpc.sessions.markUnseen.call({
          sessionId: session.sessionId,
        });
      },
    },
    { type: "separator", key: "after-visibility-actions" },
    {
      type: "item",
      key: "view-raw-json",
      label: "View raw JSON",
      icon: FileJson,
      onSelect: () => {
        openRawState(session);
      },
    },
    {
      type: "item",
      key: "copy-session-id",
      label: "Copy session ID",
      icon: Copy,
      onSelect: () => {
        void navigator.clipboard.writeText(session.sessionId);
        toast.success("Session ID copied");
      },
    },
    {
      type: "item",
      key: "copy-working-directory",
      label: "Copy working directory",
      icon: Copy,
      onSelect: () => {
        void navigator.clipboard.writeText(session.startupConfig.cwd);
        toast.success("Working directory copied");
      },
    },
    ...(initialPrompt
      ? ([
          {
            type: "item",
            key: "copy-initial-prompt",
            label: "Copy initial prompt",
            icon: Copy,
            onSelect: () => {
              void navigator.clipboard.writeText(initialPrompt);
              toast.success("Initial prompt copied");
            },
          },
        ] satisfies SessionMenuAction[])
      : []),
  ];
}

/** Shared item body so the four menu renderings below cannot drift apart. */
function MenuActionItemContent({ item }: { item: SessionMenuActionItem }) {
  const Icon = item.icon;
  return (
    <>
      {Icon ? <Icon className="size-3.5" /> : null}
      {item.label}
      {item.trailingLabel ? (
        <span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">
          {item.trailingLabel}
        </span>
      ) : null}
    </>
  );
}

export function renderContextMenuActions(actions: SessionMenuAction[]) {
  return actions.map((action, index) => {
    const key = action.key ?? `${action.type}:${index}`;

    if (action.type === "separator") {
      return <ContextMenuSeparator key={key} />;
    }

    const Icon = action.icon;

    if (action.type === "submenu") {
      return (
        <ContextMenuSub key={key}>
          <ContextMenuSubTrigger>
            {Icon ? <Icon className="size-3.5" /> : null}
            {action.label}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {action.items.map((item, itemIndex) => (
              <ContextMenuItem
                key={item.key ?? `${key}:item:${itemIndex}`}
                disabled={item.disabled}
                variant={item.variant}
                onClick={item.onSelect}
              >
                <MenuActionItemContent item={item} />
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      );
    }

    return (
      <ContextMenuItem
        key={key}
        disabled={action.disabled}
        variant={action.variant}
        onClick={action.onSelect}
      >
        <MenuActionItemContent item={action} />
      </ContextMenuItem>
    );
  });
}

export function renderDropdownMenuActions(actions: SessionMenuAction[]) {
  return actions.map((action, index) => {
    const key = action.key ?? `${action.type}:${index}`;

    if (action.type === "separator") {
      return <DropdownMenuSeparator key={key} />;
    }

    const Icon = action.icon;

    if (action.type === "submenu") {
      return (
        <DropdownMenuSub key={key}>
          <DropdownMenuSubTrigger>
            {Icon ? <Icon className="size-3.5" /> : null}
            {action.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {action.items.map((item, itemIndex) => (
              <DropdownMenuItem
                key={item.key ?? `${key}:item:${itemIndex}`}
                disabled={item.disabled}
                variant={item.variant}
                onClick={item.onSelect}
              >
                <MenuActionItemContent item={item} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }

    return (
      <DropdownMenuItem
        key={key}
        disabled={action.disabled}
        variant={action.variant}
        onClick={action.onSelect}
      >
        <MenuActionItemContent item={action} />
      </DropdownMenuItem>
    );
  });
}

export const SessionSidebarItemTrigger = forwardRef<
  HTMLLIElement,
  {
    sessionId: string;
    children: React.ReactNode;
    leading?: React.ReactNode;
  } & React.HTMLAttributes<HTMLLIElement>
>(function SessionSidebarItemTrigger(
  { sessionId, children, leading, ...props },
  ref,
) {
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
      {leading ? (
        <span className="absolute inset-y-0 left-1 flex items-center">
          {leading}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => {
          switchSession(sessionId);
          useMobileNavStore.getState().closeSidebar();
        }}
        className={cn(
          "flex w-full items-center justify-start gap-1.5 py-1 pl-5 pr-[3rem] text-sm transition pointer-coarse:py-2 pointer-coarse:pr-[4.75rem]",
          isActive
            ? "bg-white/15 text-white"
            : session.status === "stopped"
              ? "text-zinc-500 hover:bg-white/8 hover:text-zinc-300"
              : "text-zinc-300 hover:bg-white/8 hover:text-zinc-100",
        )}
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
        <span className="min-w-0 flex-1 truncate text-left">
          {session.title}
        </span>
      </button>
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5 transition group-hover/session:opacity-0 group-focus-within/session:opacity-0 pointer-coarse:opacity-0">
        <span className="w-7 text-right text-xs tabular-nums text-zinc-400">
          {getSessionLastActivityLabel(session)}
        </span>
        {sessionTypeIcon[session.type] &&
          (() => {
            const typeMeta = sessionTypeIcon[session.type];
            return (
              <span
                className="inline-flex"
                title={typeMeta.label}
                role="img"
                aria-label={typeMeta.label}
              >
                <typeMeta.icon
                  className="size-3 text-zinc-500"
                  aria-hidden="true"
                />
              </span>
            );
          })()}
      </span>
      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition group-hover/session:opacity-100 group-focus-within/session:opacity-100 pointer-coarse:opacity-100">
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
        size === "sm"
          ? "size-5 rounded pointer-coarse:size-8 pointer-coarse:rounded-md"
          : "size-6 rounded-md pointer-coarse:size-8",
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
      <Icon
        className={cn(
          size === "sm" ? "size-3" : "size-3.5",
          "pointer-coarse:size-4",
        )}
      />
    </button>
  );
});

export function BaseSessionSidebarItem({
  sessionId,
  primaryButton,
  extraMenuActions,
  onDelete,
  deleteDisabled,
  leading,
}: {
  sessionId: string;
  primaryButton: React.ReactNode;
  extraMenuActions?: SessionMenuAction[];
  onDelete: () => void;
  deleteDisabled: boolean;
  leading?: React.ReactNode;
}) {
  const session = useAppState((x) => x.sessions[sessionId]);
  const projects = useAppState((x) => x.projects);
  const sessions = useAppState((x) => x.sessions);
  const activeSessionId = useActiveSessionStore((x) => x.activeSessionId);
  const settleMutation = useMutation(orpc.sessions.settle.mutationOptions());
  const settleable = session !== undefined && canSettleSession(session);

  // Settling the open row must advance focus the same way the inbox does —
  // otherwise the project tree hides the session and leaves you staring at it.
  const handleSettle = useCallback(() => {
    const nextSessionId =
      sessionId === activeSessionId
        ? resolveNextActiveSessionId({
            activeSessionIds: getVisibleSessionIds(
              buildProjectSessionGroups({
                projects,
                sessionsById: sessions,
              }),
            ),
            settledSessionId: sessionId,
          })
        : null;

    settleMutation.mutate({ sessionId });

    if (nextSessionId !== null) {
      switchSession(nextSessionId);
    }
  }, [activeSessionId, projects, sessionId, sessions, settleMutation]);

  const menuActions: SessionMenuAction[] = [
    ...(settleable
      ? ([
          {
            type: "item",
            key: "settle-session",
            label: "Settle session",
            icon: Check,
            onSelect: handleSettle,
            disabled: settleMutation.isPending,
          },
        ] satisfies SessionMenuAction[])
      : []),
    ...(extraMenuActions ?? []),
    ...useCommonSessionMenuActions(session),
    { type: "separator", key: "before-delete-session" },
    {
      type: "item",
      key: "delete-session",
      label: "Delete session",
      icon: TrashIcon,
      onSelect: onDelete,
      disabled: deleteDisabled,
      variant: "destructive",
    },
  ];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SessionSidebarItemTrigger sessionId={sessionId} leading={leading}>
          {primaryButton}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="pointer-events-auto hidden size-8 items-center justify-center rounded-md text-zinc-300 transition hover:bg-white/10 hover:text-white pointer-coarse:flex"
                aria-label="Session actions"
                title="Session actions"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4.5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {renderDropdownMenuActions(menuActions)}
            </DropdownMenuContent>
          </DropdownMenu>
          {settleable ? (
            <SidebarIconButton
              icon={Check}
              label="Settle session"
              disabled={settleMutation.isPending}
              onClick={handleSettle}
              className="pointer-coarse:hidden"
            />
          ) : null}
        </SessionSidebarItemTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {renderContextMenuActions(menuActions)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
