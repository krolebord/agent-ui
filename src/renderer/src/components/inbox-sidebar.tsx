import type { Session } from "@main/sessions/state";
import { MachineStatsLine } from "@renderer/components/machine-stats-line";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
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
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { UsagePanel } from "@renderer/components/usage-panel";
import {
  switchSession,
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { useMobileNavStore } from "@renderer/hooks/use-mobile-nav";
import { useSessionLifecycleActions } from "@renderer/hooks/use-session-lifecycle-actions";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import {
  resolveSnoozePresets,
  type SnoozePreset,
  snoozeWakeDescription,
  snoozeWakeLabel,
} from "@renderer/lib/snooze-presets";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  buildProjectTree,
  getProjectDisplayName,
  getProjectNameFromPath,
  getSessionLastActivityLabel,
  getWorktreeDisplayName,
  type ProjectTreeNode,
  projectTreeNodeHoldsSelection,
  resolveProjectSelectionDisplay,
} from "@renderer/services/terminal-session-selectors";
import {
  canSettleSession,
  canSnoozeSession,
  type InboxStatus,
  inboxRowNeedsAttention,
  partitionInboxSessions,
  resolveInboxStatus,
  resolveNextActiveSessionId,
  resolveNextSnoozeWakeAt,
  resolveSettledTimestamp,
  resolveSnoozeWakeTimestamp,
  sessionWokeFromSnooze,
} from "@shared/session-lifecycle";
import { useMutation } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  AlarmClockOff,
  Check,
  ChevronDown,
  EllipsisVertical,
  Folder,
  FolderPlus,
  GitBranch,
  GitFork,
  MoreHorizontal,
  PlayIcon,
  Plus,
  SquareIcon,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAddProjectDialogStore } from "./add-project-dialog";
import { useNewSessionDialogStore } from "./new-session-dialog";
import { ProjectFavicon } from "./project-favicon";
import { useProjectWorktreeDialogStore } from "./project-worktree-dialog";
import {
  renderContextMenuActions,
  renderDropdownMenuActions,
  type SessionMenuAction,
  sessionTypeIcon,
  statusIndicatorMeta,
  useCommonSessionMenuActions,
  useTypeSpecificSessionMenuActions,
} from "./session-sidebar-item";
import {
  PinnedNavButtons,
  SidebarNavMenuItems,
  SidebarViewToggle,
  sidebarHeaderClassName,
  useUnpinnedNavPageActive,
} from "./sidebar-view-toggle";
import { useAppState } from "./sync-state-provider";

interface ProjectScope {
  path: string;
  includeWorktrees: boolean;
}

const SETTLED_INITIAL_COUNT = 10;
const SETTLED_PAGE_COUNT = 25;

const INBOX_STATUS_LABEL: Record<Exclude<InboxStatus, "ready">, string> = {
  approval: "Approval",
  input: "Needs you",
  working: "Working",
  failed: "Failed",
};

function InboxRowGitLine({
  projectPath,
  dimmed,
}: {
  projectPath: string;
  dimmed: boolean;
}) {
  const project = useAppState((x) =>
    x.projects.find((candidate) => candidate.path === projectPath),
  );
  if (!project?.gitBranch) {
    return null;
  }
  const isWorktree = Boolean(project.worktreeOriginPath);
  const BranchIcon = isWorktree ? GitFork : GitBranch;
  const aheadCommits = project.gitUpstreamDiffStats?.aheadCommits || undefined;
  const behindCommits =
    project.gitUpstreamDiffStats?.behindCommits || undefined;
  const addedLines = project.gitDiffStats?.addedLines || undefined;
  const deletedLines = project.gitDiffStats?.deletedLines || undefined;

  return (
    <span
      className={cn(
        "mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-[10px]",
        dimmed ? "text-zinc-600" : "text-zinc-500",
      )}
    >
      <BranchIcon className="size-3 shrink-0" aria-hidden="true" />
      {aheadCommits || behindCommits ? (
        <span
          className="shrink-0 font-mono"
          title={
            project.gitUpstreamDiffStats
              ? `${aheadCommits ?? 0} ahead, ${behindCommits ?? 0} behind ${project.gitUpstreamDiffStats.upstreamBranch}`
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
      <span className="min-w-0 truncate" title={project.gitBranch}>
        {project.gitBranch}
      </span>
      {addedLines || deletedLines ? (
        <span
          className="ml-auto shrink-0 font-mono"
          title={`${addedLines ?? 0} added, ${deletedLines ?? 0} deleted (uncommitted)`}
        >
          {addedLines ? (
            <span className={dimmed ? "text-emerald-700" : "text-emerald-500"}>
              +{addedLines}
            </span>
          ) : null}
          {deletedLines ? (
            <span
              className={cn(
                addedLines && "ml-1",
                dimmed ? "text-rose-800" : "text-rose-500",
              )}
            >
              -{deletedLines}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function relativeLabelAt(session: Session, timestamp: number): string {
  return getSessionLastActivityLabel({ ...session, lastActivityAt: timestamp });
}

function InboxStatusOrTime({
  session,
  timestamp,
  woke,
}: {
  session: Session;
  timestamp: number;
  woke: boolean;
}) {
  const status = resolveInboxStatus(session);
  if (status === "ready") {
    if (woke) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-100">
          <AlarmClock className="size-3 shrink-0" aria-hidden="true" />
          <output>Woke</output>
        </span>
      );
    }
    return (
      <span className="text-xs tabular-nums text-zinc-500">
        {relativeLabelAt(session, timestamp)}
      </span>
    );
  }

  const meta = statusIndicatorMeta[session.status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        meta.className,
      )}
    >
      <meta.icon
        className={cn("size-3 shrink-0", meta.animate && "animate-spin")}
        aria-hidden="true"
      />
      <output>{INBOX_STATUS_LABEL[status]}</output>
    </span>
  );
}

const ROW_ICON_BUTTON_CLASS =
  "pointer-events-auto inline-flex h-full cursor-pointer items-center rounded-md px-1.5 text-zinc-400 opacity-0 transition hover:text-zinc-100 focus-visible:opacity-100 disabled:cursor-default disabled:opacity-40 group-hover/inbox-row:opacity-100 pointer-coarse:size-8 pointer-coarse:justify-center pointer-coarse:px-0 pointer-coarse:opacity-100";

function RowIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(ROW_ICON_BUTTON_CLASS, className)}
    >
      <Icon className="size-3.5 pointer-coarse:size-4" />
    </button>
  );
}

function RowSnoozeButton({
  presets,
  onSnooze,
}: {
  presets: SnoozePreset[];
  onSnooze: (snoozedUntil: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Snooze session"
          title="Snooze session"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            ROW_ICON_BUTTON_CLASS,
            "data-[state=open]:text-zinc-100 data-[state=open]:opacity-100 pointer-coarse:hidden",
          )}
        >
          <AlarmClock className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {presets.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onClick={() => onSnooze(preset.snoozedUntil)}
          >
            <AlarmClock className="size-3.5" />
            {preset.label}
            <span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">
              {preset.whenLabel}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenuButton({ actions }: { actions: SessionMenuAction[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Session actions"
          title="Session actions"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          className="pointer-events-auto hidden size-8 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 pointer-coarse:flex"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {renderDropdownMenuActions(actions)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InboxRow({
  session,
  variant,
  projectLabel,
  now,
  onSettle,
  onUnsettle,
  onSnooze,
  onUnsnooze,
}: {
  session: Session;
  variant: "card" | "settled" | "snoozed";
  projectLabel: string;
  now: number;
  onSettle: (sessionId: string) => void;
  onUnsettle: (sessionId: string) => void;
  onSnooze: (sessionId: string, snoozedUntil: number) => void;
  onUnsnooze: (sessionId: string) => void;
}) {
  const isActive = useActiveSessionStore(
    (x) => x.activeSessionId === session.sessionId,
  );
  const lifecycle = useSessionLifecycleActions(session);
  const typeSpecificActions = useTypeSpecificSessionMenuActions(session);
  const commonActions = useCommonSessionMenuActions(session);
  const typeMeta = sessionTypeIcon[session.type];
  const isSnoozed = variant === "snoozed";
  const isSettled = variant === "settled";
  const isShelfRow = isSnoozed || isSettled;
  const woke = !isShelfRow && sessionWokeFromSnooze(session, now);
  const needsAttention = inboxRowNeedsAttention(session) || woke;
  const settleable = canSettleSession(session);
  const snoozeable = canSnoozeSession(session);
  const snoozePresets = resolveSnoozePresets(now);

  const open = useCallback(() => {
    switchSession(session.sessionId);
    useMobileNavStore.getState().closeSidebar();
  }, [session.sessionId]);

  const rowClassName = cn(
    "w-full cursor-pointer select-none rounded-md px-2.5 text-left transition",
    isActive
      ? "bg-white/15 text-white"
      : needsAttention
        ? "text-zinc-100 hover:bg-white/8"
        : session.status === "stopped"
          ? "text-zinc-500 hover:bg-white/8 hover:text-zinc-300"
          : "text-zinc-300 hover:bg-white/8 hover:text-zinc-100",
  );

  const menuActions: SessionMenuAction[] = [
    ...(isSnoozed
      ? ([
          {
            type: "item",
            key: "unsnooze-session",
            label: "Wake now",
            icon: AlarmClockOff,
            onSelect: () => onUnsnooze(session.sessionId),
          },
        ] satisfies SessionMenuAction[])
      : []),
    ...(snoozeable
      ? ([
          {
            type: "submenu",
            key: "snooze-session",
            label: isSnoozed ? "Snooze again" : "Snooze",
            icon: AlarmClock,
            items: snoozePresets.map((preset) => ({
              type: "item" as const,
              key: `snooze-preset:${preset.id}`,
              label: preset.label,
              trailingLabel: preset.whenLabel,
              onSelect: () => onSnooze(session.sessionId, preset.snoozedUntil),
            })),
          },
        ] satisfies SessionMenuAction[])
      : []),
    ...(isSettled
      ? ([
          {
            type: "item",
            key: "unsettle-session",
            label: "Un-settle session",
            icon: Undo2,
            onSelect: () => onUnsettle(session.sessionId),
          },
        ] satisfies SessionMenuAction[])
      : settleable
        ? ([
            {
              type: "item",
              key: "settle-session",
              label: "Settle session",
              icon: Check,
              onSelect: () => onSettle(session.sessionId),
            },
          ] satisfies SessionMenuAction[])
        : []),
    ...(lifecycle.resume
      ? ([
          {
            type: "item",
            key: "resume-session",
            label: "Resume session",
            icon: PlayIcon,
            onSelect: lifecycle.resume,
            disabled: lifecycle.isResumePending,
          },
        ] satisfies SessionMenuAction[])
      : []),
    ...(lifecycle.stop
      ? ([
          {
            type: "item",
            key: "stop-session",
            label: lifecycle.stopLabel,
            icon: SquareIcon,
            onSelect: lifecycle.stop,
            disabled: lifecycle.isStopPending,
          },
        ] satisfies SessionMenuAction[])
      : []),
    { type: "separator", key: "after-lifecycle" },
    ...typeSpecificActions,
    ...commonActions,
    { type: "separator", key: "before-delete-session" },
    {
      type: "item",
      key: "delete-session",
      label: "Delete session",
      icon: Trash2,
      onSelect: lifecycle.remove,
      disabled: lifecycle.isRemovePending,
      variant: "destructive",
    },
  ];

  const menu = (
    <ContextMenuContent>
      {renderContextMenuActions(menuActions)}
    </ContextMenuContent>
  );

  if (isShelfRow) {
    return (
      <li className="group/inbox-row relative list-none">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={open}
              className={cn(
                rowClassName,
                "flex h-8 items-center gap-2 pointer-coarse:h-11 pointer-coarse:pr-[4.75rem]",
              )}
            >
              <ProjectFavicon
                projectPath={session.startupConfig.cwd}
                className={cn(
                  "transition",
                  isActive
                    ? "text-zinc-300"
                    : "text-zinc-600 group-hover/inbox-row:text-zinc-400",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {session.title}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 transition pointer-fine:group-hover/inbox-row:opacity-0">
                <span
                  className="min-w-8 text-right text-xs tabular-nums text-zinc-500"
                  title={
                    isSnoozed
                      ? `Wakes ${snoozeWakeDescription(
                          resolveSnoozeWakeTimestamp(session),
                          now,
                        )}`
                      : undefined
                  }
                >
                  {isSnoozed
                    ? snoozeWakeLabel(resolveSnoozeWakeTimestamp(session), now)
                    : relativeLabelAt(
                        session,
                        resolveSettledTimestamp(session),
                      )}
                </span>
                {typeMeta ? (
                  <typeMeta.icon
                    className="size-3 shrink-0 text-zinc-600"
                    aria-hidden="true"
                  />
                ) : null}
              </span>
            </button>
          </ContextMenuTrigger>
          {menu}
        </ContextMenu>
        <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5">
          {isSnoozed ? (
            <RowIconButton
              icon={AlarmClockOff}
              label="Wake now"
              onClick={() => onUnsnooze(session.sessionId)}
            />
          ) : (
            <RowIconButton
              icon={Undo2}
              label="Un-settle session"
              onClick={() => onUnsettle(session.sessionId)}
            />
          )}
          <RowMenuButton actions={menuActions} />
        </span>
      </li>
    );
  }

  return (
    <li className="group/inbox-row relative list-none py-px">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={open}
            className={cn(
              rowClassName,
              "py-2 pointer-coarse:py-2.5 pointer-coarse:pr-[4.75rem]",
            )}
          >
            <span className="flex h-4 min-w-0 items-center gap-1.5">
              <ProjectFavicon
                projectPath={session.startupConfig.cwd}
                className={cn(
                  "size-3.5",
                  session.status === "stopped"
                    ? "text-zinc-600"
                    : "text-zinc-500",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  session.status === "stopped"
                    ? "text-zinc-600"
                    : "text-zinc-500",
                )}
              >
                {projectLabel}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 transition pointer-fine:group-hover/inbox-row:opacity-0">
                <span className="flex min-w-8 justify-end">
                  <InboxStatusOrTime
                    session={session}
                    timestamp={session.lastActivityAt}
                    woke={woke}
                  />
                </span>
                {typeMeta ? (
                  <span
                    className="inline-flex shrink-0"
                    title={typeMeta.label}
                    role="img"
                    aria-label={typeMeta.label}
                  >
                    <typeMeta.icon
                      className={cn(
                        "size-3",
                        session.status === "stopped"
                          ? "text-zinc-600"
                          : "text-zinc-500",
                      )}
                      aria-hidden="true"
                    />
                  </span>
                ) : null}
              </span>
            </span>
            <span
              className={cn(
                "mt-1 block min-w-0 truncate text-sm",
                needsAttention ? "font-medium" : "font-normal",
              )}
            >
              {session.title}
            </span>
            <InboxRowGitLine
              projectPath={session.startupConfig.cwd}
              dimmed={session.status === "stopped"}
            />
          </button>
        </ContextMenuTrigger>
        {menu}
      </ContextMenu>
      <span className="pointer-events-none absolute right-1 top-2 flex h-4 items-center pointer-coarse:top-0 pointer-coarse:bottom-0 pointer-coarse:h-auto pointer-coarse:gap-0.5">
        {snoozeable ? (
          <RowSnoozeButton
            presets={snoozePresets}
            onSnooze={(snoozedUntil) =>
              onSnooze(session.sessionId, snoozedUntil)
            }
          />
        ) : null}
        {settleable ? (
          <RowIconButton
            icon={Check}
            label="Settle session"
            onClick={() => onSettle(session.sessionId)}
          />
        ) : null}
        {lifecycle.resume ? (
          <RowIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={lifecycle.isResumePending}
            onClick={lifecycle.resume}
            className="pointer-coarse:hidden"
          />
        ) : lifecycle.stop ? (
          <RowIconButton
            icon={SquareIcon}
            label={lifecycle.stopLabel}
            disabled={lifecycle.isStopPending}
            onClick={lifecycle.stop}
            className="pointer-coarse:hidden"
          />
        ) : null}
        <RowMenuButton actions={menuActions} />
      </span>
    </li>
  );
}

function ShelfHeader({
  label,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left pointer-coarse:min-h-10"
      >
        <span className="text-xs font-medium text-zinc-500">
          {expanded ? label : `${label} (${count})`}
        </span>
        <span className="h-px flex-1 bg-border/70" />
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3 text-zinc-500 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
    </li>
  );
}

function ScopeCheck({ selected }: { selected: boolean }) {
  return (
    <Check
      className={cn("size-3 shrink-0", selected ? "opacity-100" : "opacity-0")}
    />
  );
}

function ProjectScopeMenuEntry({
  node,
  scope,
  onSelect,
  onCreateWorktree,
}: {
  node: ProjectTreeNode;
  scope: ProjectScope | null;
  onSelect: (scope: ProjectScope) => void;
  onCreateWorktree: (originPath: string) => void;
}) {
  const isRootSelected =
    scope?.path === node.path &&
    !(scope.includeWorktrees && node.worktrees.length > 0);
  const isTreeSelected =
    scope?.path === node.path &&
    scope.includeWorktrees &&
    node.worktrees.length > 0;
  const holdsSelection =
    scope != null &&
    projectTreeNodeHoldsSelection(node, { kind: "project", path: scope.path });

  const label = (
    <>
      <ProjectFavicon projectPath={node.path} className="size-3.5" />
      <span className="min-w-0 truncate">{node.label}</span>
      {node.hidden || node.unlisted ? (
        <span className="shrink-0 text-xs text-zinc-500">
          {node.hidden ? "hidden" : "unlisted"}
        </span>
      ) : null}
    </>
  );

  const selectTree = () => {
    onSelect({ path: node.path, includeWorktrees: true });
  };

  if (!node.canCreateWorktree && node.worktrees.length === 0) {
    return (
      <DropdownMenuItem
        title={node.path}
        className="gap-1.5"
        onSelect={selectTree}
      >
        <ScopeCheck selected={isRootSelected} />
        {label}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub defaultOpen={holdsSelection && !isTreeSelected}>
      <DropdownMenuSubTrigger
        title={node.path}
        className={cn("gap-1.5", holdsSelection && "bg-accent/50")}
        onClick={selectTree}
      >
        <ScopeCheck selected={isTreeSelected} />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-52">
        {node.worktrees.length > 0 ? (
          <DropdownMenuItem className="gap-1.5" onSelect={selectTree}>
            <ScopeCheck selected={isTreeSelected} />
            <span className="truncate">Project and worktrees</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="gap-1.5"
          onSelect={() => {
            onSelect({ path: node.path, includeWorktrees: false });
          }}
        >
          <ScopeCheck selected={isRootSelected} />
          <span className="truncate">Default</span>
          {node.branch ? (
            <span className="ml-auto truncate text-xs text-zinc-500">
              {node.branch}
            </span>
          ) : null}
        </DropdownMenuItem>

        {node.worktrees.length > 0 ? <DropdownMenuSeparator /> : null}
        {node.worktrees.map((worktree) => (
          <DropdownMenuItem
            key={worktree.path}
            title={worktree.path}
            className="gap-1.5"
            onSelect={() => {
              onSelect({ path: worktree.path, includeWorktrees: false });
            }}
          >
            <ScopeCheck selected={scope?.path === worktree.path} />
            <GitFork className="size-3.5 text-zinc-500" />
            <span className="min-w-0 truncate">{worktree.label}</span>
          </DropdownMenuItem>
        ))}

        {node.canCreateWorktree ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-1.5"
              onSelect={() => onCreateWorktree(node.path)}
            >
              <ScopeCheck selected={false} />
              <Plus className="size-3.5 text-zinc-500" />
              <span className="truncate">New worktree…</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function InboxSidebar() {
  const projects = useAppState((x) => x.projects);
  const sessions = useAppState((x) => x.sessions);
  const activeSessionId = useActiveSessionStore((x) => x.activeSessionId);
  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (x) => x.setOpenProjectCwd,
  );
  const openAddProjectDialog = useAddProjectDialogStore((x) => x.open);
  const setOpenProjectWorktreePath = useProjectWorktreeDialogStore(
    (x) => x.setOpenProjectPath,
  );
  const unpinnedNavPageActive = useUnpinnedNavPageActive();

  const settleMutation = useMutation(orpc.sessions.settle.mutationOptions());
  const unsettleMutation = useMutation(
    orpc.sessions.unsettle.mutationOptions(),
  );
  const snoozeMutation = useMutation(orpc.sessions.snooze.mutationOptions());
  const unsnoozeMutation = useMutation(
    orpc.sessions.unsnooze.mutationOptions(),
  );

  const [projectScope, setProjectScope] = useState<ProjectScope | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectScopePath = projectScope?.path ?? null;

  const projectLabelByPath = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.path,
          project.worktreeOriginPath
            ? getWorktreeDisplayName(project)
            : getProjectDisplayName(project),
        ]),
      ),
    [projects],
  );

  const scopePaths = useMemo(() => {
    if (projectScope === null) {
      return null;
    }
    const paths = new Set([projectScope.path]);
    if (projectScope.includeWorktrees) {
      for (const project of projects) {
        if (project.worktreeOriginPath === projectScope.path) {
          paths.add(project.path);
        }
      }
    }
    return paths;
  }, [projectScope, projects]);

  const scopedSessions = useMemo(() => {
    const all = Object.values(sessions).filter(
      (session) => session.type !== "local-terminal",
    );
    if (scopePaths === null) {
      return all;
    }
    return all.filter((session) => scopePaths.has(session.startupConfig.cwd));
  }, [scopePaths, sessions]);

  const [wakeTick, setWakeTick] = useState(0);

  const { active, snoozed, settled, now } = useMemo(() => {
    void wakeTick;
    const now = Date.now();
    return { ...partitionInboxSessions(scopedSessions, now), now };
  }, [scopedSessions, wakeTick]);

  useEffect(() => {
    const nextWakeAt = resolveNextSnoozeWakeAt(snoozed, now);
    if (nextWakeAt === null) {
      return;
    }
    const delayMs = Math.min(
      Math.max(0, nextWakeAt - Date.now()) + 50,
      2_147_483_647,
    );
    const timer = window.setTimeout(() => {
      setWakeTick((tick) => tick + 1);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [now, snoozed]);

  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_INITIAL_COUNT,
  );
  const scopeKey = projectScope
    ? `${projectScope.path}:${projectScope.includeWorktrees}`
    : null;
  const [settledScopeKey, setSettledScopeKey] = useState(scopeKey);
  if (settledScopeKey !== scopeKey) {
    setSettledScopeKey(scopeKey);
    setSettledVisibleCount(SETTLED_INITIAL_COUNT);
  }

  const [settledExpanded, setSettledExpanded] = useState(false);
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);

  const visibleSnoozed = useMemo(() => {
    if (snoozedExpanded) {
      return snoozed;
    }
    const openSnoozed = snoozed.find(
      (session) => session.sessionId === activeSessionId,
    );
    return openSnoozed ? [openSnoozed] : [];
  }, [activeSessionId, snoozed, snoozedExpanded]);

  const visibleSettled = useMemo(() => {
    if (!settledExpanded) {
      const openSettled = settled.find(
        (session) => session.sessionId === activeSessionId,
      );
      return openSettled ? [openSettled] : [];
    }
    if (settled.length <= settledVisibleCount) {
      return settled;
    }
    const visible = settled.slice(0, settledVisibleCount);
    const openSettled = settled
      .slice(settledVisibleCount)
      .find((session) => session.sessionId === activeSessionId);
    return openSettled ? [...visible, openSettled] : visible;
  }, [activeSessionId, settled, settledExpanded, settledVisibleCount]);

  const hiddenSettledCount = settled.length - visibleSettled.length;

  const handleSettle = useCallback(
    (sessionId: string) => {
      const nextSessionId =
        sessionId === activeSessionId
          ? resolveNextActiveSessionId({
              activeSessionIds: active.map((session) => session.sessionId),
              settledSessionId: sessionId,
            })
          : null;

      settleMutation.mutate({ sessionId });

      if (nextSessionId !== null) {
        switchSession(nextSessionId);
      }
    },
    [active, activeSessionId, settleMutation],
  );

  const handleUnsettle = useCallback(
    (sessionId: string) => {
      const { cols, rows } = getTerminalSize();
      unsettleMutation.mutate({ sessionId, cols, rows });
    },
    [unsettleMutation],
  );

  const handleSnooze = useCallback(
    (sessionId: string, snoozedUntil: number) => {
      const nextSessionId =
        sessionId === activeSessionId
          ? resolveNextActiveSessionId({
              activeSessionIds: active.map((session) => session.sessionId),
              settledSessionId: sessionId,
            })
          : null;

      snoozeMutation.mutate({ sessionId, snoozedUntil });

      if (nextSessionId !== null) {
        switchSession(nextSessionId);
      }
    },
    [active, activeSessionId, snoozeMutation],
  );

  const handleUnsnooze = useCallback(
    (sessionId: string) => {
      unsnoozeMutation.mutate({ sessionId });
    },
    [unsnoozeMutation],
  );

  const labelForPath = useCallback(
    (path: string) =>
      projectLabelByPath.get(path) ?? getProjectNameFromPath(path),
    [projectLabelByPath],
  );

  const scopeLabel =
    projectScopePath === null
      ? projects.length === 0
        ? "No projects"
        : "All projects"
      : labelForPath(projectScopePath);

  const projectNodes = useMemo(
    () => buildProjectTree({ projects, selectedPath: projectScopePath ?? "" }),
    [projects, projectScopePath],
  );

  const scopeDisplay =
    projectScopePath === null
      ? null
      : resolveProjectSelectionDisplay(projectNodes, {
          kind: "project",
          path: projectScopePath,
        });

  const scopeSpansWorktrees =
    projectScope?.includeWorktrees === true &&
    projectNodes.some(
      (node) => node.path === projectScope.path && node.worktrees.length > 0,
    );

  const selectScope = useCallback((scope: ProjectScope | null) => {
    setProjectScope(scope);
    setProjectMenuOpen(false);
  }, []);

  const createWorktree = useCallback(
    (originPath: string) => {
      setProjectMenuOpen(false);
      setOpenProjectWorktreePath(originPath);
    },
    [setOpenProjectWorktreePath],
  );

  const newSessionCwd =
    [
      activeSessionId === null
        ? null
        : (sessions[activeSessionId]?.startupConfig.cwd ?? null),
      projectScopePath,
      projects[0]?.path ?? null,
    ].find(
      (cwd): cwd is string =>
        cwd !== null &&
        projects.find((project) => project.path === cwd)
          ?.interactionDisabled !== true,
    ) ?? null;

  return (
    <aside className="flex h-full w-full flex-col border-r border-border/70 bg-black/35 backdrop-blur-xl">
      <div className={sidebarHeaderClassName}>
        <div className="ml-auto flex h-full items-center [app-region:no-drag]">
          <PinnedNavButtons />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="flat"
                className={cn(
                  "h-full w-9 shrink-0 px-0",
                  unpinnedNavPageActive && "text-zinc-100",
                )}
                aria-label="More sidebar actions"
                title="More"
              >
                <EllipsisVertical className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <SidebarNavMenuItems />
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarViewToggle />
          <Button
            variant="flat"
            className="h-full w-9 shrink-0 px-0"
            disabled={newSessionCwd === null}
            onClick={() => setOpenNewSessionDialogCwd(newSessionCwd)}
            aria-label="New session"
            title={
              newSessionCwd === null
                ? "New session"
                : `New session in ${labelForPath(newSessionCwd)}`
            }
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="border-b border-border/70 px-1.5 py-1.5">
        <DropdownMenu
          modal
          open={projectMenuOpen}
          onOpenChange={setProjectMenuOpen}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="flat"
              className="h-7 w-full justify-start gap-1.5 px-1.5 text-xs text-zinc-300 pointer-coarse:h-10 pointer-coarse:px-2 pointer-coarse:text-sm"
              aria-label="Filter sessions by project"
              title={projectScopePath ?? undefined}
            >
              {projectScopePath === null ? (
                <Folder className="size-3.5 shrink-0" />
              ) : (
                <ProjectFavicon
                  projectPath={scopeDisplay?.faviconPath ?? projectScopePath}
                />
              )}
              <span className="min-w-0 truncate text-left">
                {scopeDisplay?.label ?? scopeLabel}
              </span>
              {scopeDisplay?.detail ? (
                <>
                  <span className="shrink-0 text-zinc-600">/</span>
                  <span className="min-w-0 truncate text-left text-zinc-400">
                    {scopeDisplay.detail}
                  </span>
                </>
              ) : null}
              {scopeSpansWorktrees ? (
                <span className="shrink-0 text-zinc-500">+ worktrees</span>
              ) : null}
              <ChevronDown className="ml-auto size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-72 min-w-56">
            {projectNodes.length > 0 ? (
              <>
                <DropdownMenuItem onSelect={() => selectScope(null)}>
                  <ScopeCheck selected={projectScope === null} />
                  All projects
                </DropdownMenuItem>
                {projectNodes.map((node) => (
                  <ProjectScopeMenuEntry
                    key={node.path}
                    node={node}
                    scope={projectScope}
                    onSelect={selectScope}
                    onCreateWorktree={createWorktree}
                  />
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onClick={openAddProjectDialog}>
              <FolderPlus className="size-3.5" />
              Add project…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-px px-1.5 py-1.5">
          {active.map((session) => (
            <InboxRow
              key={session.sessionId}
              session={session}
              variant="card"
              now={now}
              projectLabel={
                projectLabelByPath.get(session.startupConfig.cwd) ??
                getProjectNameFromPath(session.startupConfig.cwd)
              }
              onSettle={handleSettle}
              onUnsettle={handleUnsettle}
              onSnooze={handleSnooze}
              onUnsnooze={handleUnsnooze}
            />
          ))}

          {snoozed.length > 0 ? (
            <ShelfHeader
              label="Snoozed"
              count={snoozed.length}
              expanded={snoozedExpanded}
              onToggle={() => setSnoozedExpanded((value) => !value)}
            />
          ) : null}

          {visibleSnoozed.map((session) => (
            <InboxRow
              key={session.sessionId}
              session={session}
              variant="snoozed"
              now={now}
              projectLabel={
                projectLabelByPath.get(session.startupConfig.cwd) ??
                getProjectNameFromPath(session.startupConfig.cwd)
              }
              onSettle={handleSettle}
              onUnsettle={handleUnsettle}
              onSnooze={handleSnooze}
              onUnsnooze={handleUnsnooze}
            />
          ))}

          {settled.length > 0 ? (
            <ShelfHeader
              label="Settled"
              count={settled.length}
              expanded={settledExpanded}
              onToggle={() => setSettledExpanded((value) => !value)}
            />
          ) : null}

          {visibleSettled.map((session) => (
            <InboxRow
              key={session.sessionId}
              session={session}
              variant="settled"
              now={now}
              projectLabel={
                projectLabelByPath.get(session.startupConfig.cwd) ??
                getProjectNameFromPath(session.startupConfig.cwd)
              }
              onSettle={handleSettle}
              onUnsettle={handleUnsettle}
              onSnooze={handleSnooze}
              onUnsnooze={handleUnsnooze}
            />
          ))}

          {settledExpanded && hiddenSettledCount > 0 ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() =>
                  setSettledVisibleCount((count) => count + SETTLED_PAGE_COUNT)
                }
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200 pointer-coarse:h-11"
              >
                <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                Show {Math.min(hiddenSettledCount, SETTLED_PAGE_COUNT)} more
              </button>
            </li>
          ) : null}
        </ul>

        {active.length === 0 && snoozed.length === 0 && settled.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-zinc-500">
            {projects.length === 0 ? (
              <>
                <span>No projects yet</span>
                <button
                  type="button"
                  onClick={openAddProjectDialog}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 font-medium text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100 pointer-coarse:min-h-10 pointer-coarse:px-3 pointer-coarse:text-sm"
                >
                  <FolderPlus className="size-3" />
                  Add project
                </button>
              </>
            ) : projectScopePath !== null ? (
              `No sessions in ${scopeLabel} yet`
            ) : (
              "No sessions yet"
            )}
          </div>
        ) : null}
      </ScrollArea>
      <UsagePanel />
      <MachineStatsLine />
    </aside>
  );
}
