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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
  getProjectDisplayName,
  getProjectNameFromPath,
  getSessionLastActivityLabel,
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
import {
  renderContextMenuActions,
  renderDropdownMenuActions,
  type SessionMenuAction,
  sessionTypeIcon,
  statusIndicatorMeta,
  useCommonSessionMenuActions,
  useTypeSpecificSessionMenuActions,
} from "./session-sidebar-item";
import { SidebarNavMenuItems, SidebarViewToggle } from "./sidebar-view-toggle";
import { useAppState } from "./sync-state-provider";

// History shouldn't dominate the sidebar and the common lookups are recent, so
// the settled tail pages instead of rendering whole.
const SETTLED_INITIAL_COUNT = 10;
const SETTLED_PAGE_COUNT = 25;

/**
 * Short row labels. The icon and color come straight from the tree sidebar's
 * `statusIndicatorMeta` so a session reads the same in both views; only the text
 * is shortened to survive a narrow row.
 */
const INBOX_STATUS_LABEL: Record<Exclude<InboxStatus, "ready">, string> = {
  approval: "Approval",
  input: "Needs you",
  working: "Working",
  failed: "Failed",
};

/**
 * Branch and diff line for a card row. The project is looked up here rather than
 * threaded down with `projectLabel` because only this one variant needs it, and
 * the state slice is a stable object reference between patches.
 *
 * Git state is per-folder, so two sessions sharing a cwd read the same numbers —
 * correct for the worktree-per-session flow this mostly serves, and no more
 * wrong than the project tree already is for the rest.
 */
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
    // Stays visible on hover, unlike the status cluster above it, so the action
    // buttons never cover the branch.
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
        // Right-aligned so the churn numbers line up down the list instead of
        // drifting with branch name length.
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

/**
 * Relative label for an arbitrary session timestamp. Settled rows read "how long
 * ago did this get parked", which is a different anchor than the tree's last
 * activity, so the timestamp is swapped in before formatting rather than
 * duplicating the formatter.
 */
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
    // A session that wakes into a real status already announces its return
    // through that label, so the marker is only needed for the quiet case: the
    // sort is static, so a timer-woken idle row would otherwise slide back in
    // with nothing at all to distinguish it.
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
      {/* <output> carries an implicit live region, so a status change is
          announced without the icon or the row having to be re-read. */}
      <output>{INBOX_STATUS_LABEL[status]}</output>
    </span>
  );
}

/**
 * Rendered as a sibling of the row button, never a child: the row itself is a
 * native <button>, so a nested button would be invalid markup. On a fine
 * pointer the wrapper positions these over the time/status slot, which fades
 * out on hover; on a coarse pointer there is no hover to reveal them, so they
 * are always visible, grow to a 32px target and the row reserves width for them
 * instead of letting them overlap.
 */
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

/**
 * Snooze needs a menu rather than a single click, so its hover button owns a
 * dropdown. `data-[state=open]` keeps the trigger lit while the menu is open:
 * without it the anchor fades out the moment the pointer leaves the row for the
 * menu portal, since visibility is driven by the row's `group-hover`.
 *
 * Hidden on coarse pointers, where the row only has space for two permanent
 * buttons and the `⋯` menu carries the same presets.
 */
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

/**
 * Touch has no right-click, so the row's context menu is unreachable without a
 * visible trigger. Mirrors the project tree's coarse-pointer session menu: same
 * actions, same 32px button, hidden wherever a real context menu exists.
 */
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
  // Only meaningful on an active row: a shelf row is by definition still parked.
  const woke = !isShelfRow && sessionWokeFromSnooze(session, now);
  const needsAttention = inboxRowNeedsAttention(session) || woke;
  const settleable = canSettleSession(session);
  const snoozeable = canSnoozeSession(session);
  // Recomputed per render rather than memoized: the boundaries move with the
  // clock, and a stale "This evening" would resolve to a time the router
  // rejects.
  const snoozePresets = resolveSnoozePresets(now);

  const open = useCallback(() => {
    switchSession(session.sessionId);
    useMobileNavStore.getState().closeSidebar();
  }, [session.sessionId]);

  // Three tiers. "Live but quiet" and "not running at all" are both `ready` in
  // the status model — that axis describes what the agent is doing, not whether
  // a process exists — so aliveness is carried by the font color instead, using
  // the same zinc-500/zinc-300 split the project tree already uses.
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

  // One action list, two renderings: the right-click context menu and, on touch,
  // the row's `⋯` button. Snooze first, then settle (status-dependent), then
  // start/stop (always available for a session), matching the row button order.
  const menuActions: SessionMenuAction[] = [
    // A snoozed row keeps both: waking is the primary action, but re-snoozing
    // to a later time without a round trip through the active list is the
    // natural follow-up when you look and decide it can still wait.
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
                // Coarse: taller row, and width reserved for the always-visible
                // buttons so they never sit on the timestamp (wake/un-settle +
                // menu).
                "flex h-8 items-center gap-2 pointer-coarse:h-11 pointer-coarse:pr-[4.75rem]",
              )}
            >
              {/* No project line to lean on here, so the icon is the only thing
                  saying which project this parked session came from. */}
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
              {/* The fade only exists to clear room for the hover-revealed
                  buttons, so it is scoped to pointers that can hover — on touch
                  the timestamp has its own reserved space and stays put. */}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 transition pointer-fine:group-hover/inbox-row:opacity-0">
                <span
                  className="min-w-8 text-right text-xs tabular-nums text-zinc-500"
                  // The countdown is coarse ("in 2d"), so the exact wake time
                  // stays available without spending row width on it.
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
            {/* Phrasing content only: the row is a <button>, so the lines are
                spans made block/flex rather than divs. */}
            <span className="flex h-4 min-w-0 items-center gap-1.5">
              {/* The line names the project, so it leads with the project's own
                  icon; the agent type moved beside the timestamp, where the
                  project tree's session rows already keep it. */}
              <ProjectFavicon
                projectPath={session.startupConfig.cwd}
                className={cn(
                  "size-3.5",
                  // Steps down with the title so the project line stays
                  // secondary rather than matching a greyed-out title.
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
              {/* Status is the point of this view, so on touch it keeps its own
                  space rather than being traded away for the action buttons. */}
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
      {/* Pinned to the status line on a fine pointer, where it replaces the
          status text on hover; centred over the whole card on touch, where the
          buttons are permanent. */}
      <span className="pointer-events-none absolute right-1 top-2 flex h-4 items-center pointer-coarse:top-0 pointer-coarse:bottom-0 pointer-coarse:h-auto pointer-coarse:gap-0.5">
        {/* Snooze and settle are the two "not now" verbs, so they group; the
            three buttons together reach a little past where the status text sat
            and clip the project label on hover, which is an acceptable trade
            for keeping snooze one click away. Start/stop stays next to the
            menu. On touch start/stop stays hidden — the two slots go to
            Settle and the menu, which carries start/stop anyway. */}
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

export function InboxSidebar() {
  const projects = useAppState((x) => x.projects);
  const sessions = useAppState((x) => x.sessions);
  const activeSessionId = useActiveSessionStore((x) => x.activeSessionId);
  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (x) => x.setOpenProjectCwd,
  );
  const openAddProjectDialog = useAddProjectDialogStore((x) => x.open);

  const settleMutation = useMutation(orpc.sessions.settle.mutationOptions());
  const unsettleMutation = useMutation(
    orpc.sessions.unsettle.mutationOptions(),
  );
  const snoozeMutation = useMutation(orpc.sessions.snooze.mutationOptions());
  const unsnoozeMutation = useMutation(
    orpc.sessions.unsnooze.mutationOptions(),
  );

  // Scoping filters the flat list without making the header depend on the
  // number or length of project names. Project management stays in the tree.
  const [projectScopePath, setProjectScopePath] = useState<string | null>(null);

  const projectLabelByPath = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.path,
          getProjectDisplayName(project),
        ]),
      ),
    [projects],
  );

  const scopedSessions = useMemo(() => {
    // Legacy local-terminal sessions are hidden here for the same reason the
    // tree renders null for them: they are pruned on boot and have no row.
    const all = Object.values(sessions).filter(
      (session) => session.type !== "local-terminal",
    );
    if (projectScopePath === null) {
      return all;
    }
    return all.filter(
      (session) => session.startupConfig.cwd === projectScopePath,
    );
  }, [projectScopePath, sessions]);

  // A snooze expiring is the only thing in the inbox that changes the list
  // without a state patch to react to, so it needs a clock. The tick is bumped
  // exactly at the next wake boundary (armed below, once the partition knows
  // where that is) rather than polled on an interval.
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
    // setTimeout delays are signed 32-bit, so a far-future wake would overflow
    // and fire immediately, turning the re-arm into a tight loop. Clamped, the
    // timer simply re-arms every ~24.8 days until the wake is in range. The
    // small margin past the boundary keeps the re-render on the awake side of
    // the comparison.
    const delayMs = Math.min(
      Math.max(0, nextWakeAt - Date.now()) + 50,
      2_147_483_647,
    );
    const timer = window.setTimeout(() => {
      setWakeTick((tick) => tick + 1);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [now, snoozed]);

  // Paging resets when the scope changes so a filter flip never inherits a deep
  // page state.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_INITIAL_COUNT,
  );
  const [settledScopeKey, setSettledScopeKey] = useState(projectScopePath);
  if (settledScopeKey !== projectScopePath) {
    setSettledScopeKey(projectScopePath);
    setSettledVisibleCount(SETTLED_INITIAL_COUNT);
  }

  const [settledExpanded, setSettledExpanded] = useState(false);
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);

  // The snoozed shelf doesn't page: it drains on its own as wake times pass, so
  // it stays short in a way the settled shelf never does.
  const visibleSnoozed = useMemo(() => {
    if (snoozedExpanded) {
      return snoozed;
    }
    // Same exception as the settled shelf: the open session must never vanish
    // behind a collapsed header.
    const openSnoozed = snoozed.find(
      (session) => session.sessionId === activeSessionId,
    );
    return openSnoozed ? [openSnoozed] : [];
  }, [activeSessionId, snoozed, snoozedExpanded]);

  const visibleSettled = useMemo(() => {
    if (!settledExpanded) {
      // The open session must never vanish behind a collapsed shelf.
      const openSettled = settled.find(
        (session) => session.sessionId === activeSessionId,
      );
      return openSettled ? [openSettled] : [];
    }
    if (settled.length <= settledVisibleCount) {
      return settled;
    }
    const visible = settled.slice(0, settledVisibleCount);
    // Same exception for a session paged out of the tail: navigating into it
    // must keep its row, highlight and un-settle affordance reachable.
    const openSettled = settled
      .slice(settledVisibleCount)
      .find((session) => session.sessionId === activeSessionId);
    return openSettled ? [...visible, openSettled] : visible;
  }, [activeSessionId, settled, settledExpanded, settledVisibleCount]);

  const hiddenSettledCount = settled.length - visibleSettled.length;

  const handleSettle = useCallback(
    (sessionId: string) => {
      // Parking the session you are looking at moves you forward, so settling
      // from the inbox drains it without leaving you on a hidden row. The plan
      // is taken before the mutation mutates the partition.
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
      // Same forward navigation as settle: parking the row you are looking at
      // must not leave you sitting on a hidden session.
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

  // New sessions follow the session you are looking at, matching Mod+N. The
  // fallbacks only matter before anything is selected: the scoped project, then
  // the first project, then there is nothing to create in. A project whose
  // interaction is locked is skipped rather than opening a dialog that would
  // immediately close itself.
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
      <div className="flex h-9 items-center border-b border-border/70 pl-16 [app-region:drag]">
        <div className="ml-auto flex h-full items-center [app-region:no-drag]">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="flat"
                className="h-full w-9 shrink-0 px-0"
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
            // The dialog's project picker can retarget this, but naming the
            // default up front saves opening it just to check.
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

      {/* Always rendered, even with no projects at all: this menu is the only
          place project concerns live in the inbox, so hiding it would hide the
          way to add the first one. */}
      <div className="border-b border-border/70 px-1.5 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="flat"
              className="h-7 w-full justify-start gap-1.5 px-1.5 text-xs text-zinc-300 pointer-coarse:h-10 pointer-coarse:px-2 pointer-coarse:text-sm"
              aria-label="Filter sessions by project"
            >
              {/* Scoped to one project, the trigger is the only place its
                  identity shows, so it carries that project's icon. */}
              {projectScopePath === null ? (
                <Folder className="size-3.5 shrink-0" />
              ) : (
                <ProjectFavicon projectPath={projectScopePath} />
              )}
              <span className="min-w-0 flex-1 truncate text-left">
                {scopeLabel}
              </span>
              <ChevronDown className="size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-72">
            {projects.length > 0 ? (
              <>
                <DropdownMenuRadioGroup
                  value={projectScopePath ?? "all"}
                  onValueChange={(value) => {
                    setProjectScopePath(value === "all" ? null : value);
                  }}
                >
                  <DropdownMenuRadioItem value="all">
                    All projects
                  </DropdownMenuRadioItem>
                  {projects.map((project) => (
                    <DropdownMenuRadioItem
                      key={project.path}
                      value={project.path}
                    >
                      <ProjectFavicon projectPath={project.path} />
                      <span className="min-w-0 truncate">
                        {getProjectDisplayName(project)}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
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

          {/* Snoozed sits between the inbox and Settled: it is "coming back",
              which belongs nearer the live list than history does. */}
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
