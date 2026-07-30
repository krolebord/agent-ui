import type { Session } from "@main/sessions/state";
import { MachineStatsLine } from "@renderer/components/machine-stats-line";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  getProjectDisplayName,
  getProjectNameFromPath,
  getSessionLastActivityLabel,
} from "@renderer/services/terminal-session-selectors";
import {
  canSettleSession,
  type InboxStatus,
  inboxRowNeedsAttention,
  partitionInboxSessions,
  resolveInboxStatus,
  resolveNextActiveSessionId,
  resolveSettledTimestamp,
} from "@shared/session-lifecycle";
import { useMutation } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  ChevronDown,
  EllipsisVertical,
  Folder,
  FolderPlus,
  PlayIcon,
  Plus,
  SquareIcon,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAddProjectDialogStore } from "./add-project-dialog";
import { useNewSessionDialogStore } from "./new-session-dialog";
import { ProjectFavicon } from "./project-favicon";
import {
  CommonSessionContextMenuItems,
  sessionTypeIcon,
  statusIndicatorMeta,
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
}: {
  session: Session;
  timestamp: number;
}) {
  const status = resolveInboxStatus(session);
  if (status === "ready") {
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
 * native <button>, so a nested button would be invalid markup. The wrapper
 * positions these over the time/status slot, which fades out on hover.
 */
function RowIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
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
      className="pointer-events-auto inline-flex h-full cursor-pointer items-center rounded-md px-1.5 text-zinc-400 opacity-0 transition hover:text-zinc-100 focus-visible:opacity-100 disabled:cursor-default disabled:opacity-40 group-hover/inbox-row:opacity-100 pointer-coarse:opacity-100"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function InboxRow({
  session,
  variant,
  projectLabel,
  onSettle,
  onUnsettle,
}: {
  session: Session;
  variant: "card" | "slim";
  projectLabel: string;
  onSettle: (sessionId: string) => void;
  onUnsettle: (sessionId: string) => void;
}) {
  const isActive = useActiveSessionStore(
    (x) => x.activeSessionId === session.sessionId,
  );
  const lifecycle = useSessionLifecycleActions(session);
  const typeMeta = sessionTypeIcon[session.type];
  const needsAttention = inboxRowNeedsAttention(session);
  const settleable = canSettleSession(session);
  const isSettled = variant === "slim";

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

  const menu = (
    <ContextMenuContent>
      {lifecycle.resume ? (
        <ContextMenuItem
          onClick={lifecycle.resume}
          disabled={lifecycle.isResumePending}
        >
          <PlayIcon className="size-3.5" />
          Resume session
        </ContextMenuItem>
      ) : null}
      {lifecycle.stop ? (
        <ContextMenuItem
          onClick={lifecycle.stop}
          disabled={lifecycle.isStopPending}
        >
          <SquareIcon className="size-3.5" />
          {lifecycle.stopLabel}
        </ContextMenuItem>
      ) : null}
      {isSettled ? (
        <ContextMenuItem onClick={() => onUnsettle(session.sessionId)}>
          <Undo2 className="size-3.5" />
          Un-settle session
        </ContextMenuItem>
      ) : settleable ? (
        <ContextMenuItem onClick={() => onSettle(session.sessionId)}>
          <Check className="size-3.5" />
          Settle session
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <CommonSessionContextMenuItems session={session} />
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={lifecycle.remove}
        disabled={lifecycle.isRemovePending}
      >
        <Trash2 className="size-3.5" />
        Delete session
      </ContextMenuItem>
    </ContextMenuContent>
  );

  if (isSettled) {
    return (
      <li className="group/inbox-row relative list-none">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={open}
              className={cn(rowClassName, "flex h-8 items-center gap-2")}
            >
              {typeMeta ? (
                <typeMeta.icon
                  className={cn(
                    "size-3 shrink-0 transition",
                    isActive
                      ? "text-zinc-300"
                      : "text-zinc-600 group-hover/inbox-row:text-zinc-400",
                  )}
                  aria-hidden="true"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm">
                {session.title}
              </span>
              <span className="ml-auto min-w-8 shrink-0 text-right text-xs tabular-nums text-zinc-500 transition group-hover/inbox-row:opacity-0 pointer-coarse:opacity-0">
                {relativeLabelAt(session, resolveSettledTimestamp(session))}
              </span>
            </button>
          </ContextMenuTrigger>
          {menu}
        </ContextMenu>
        <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center">
          <RowIconButton
            icon={Undo2}
            label="Un-settle session"
            onClick={() => onUnsettle(session.sessionId)}
          />
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
            className={cn(rowClassName, "py-2")}
          >
            {/* Phrasing content only: the row is a <button>, so the lines are
                spans made block/flex rather than divs. */}
            <span className="flex h-4 min-w-0 items-center gap-1.5">
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
                      // Steps down with the title so the project line stays
                      // secondary rather than matching a greyed-out title.
                      session.status === "stopped"
                        ? "text-zinc-600"
                        : "text-zinc-500",
                    )}
                    aria-hidden="true"
                  />
                </span>
              ) : null}
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
              <span className="ml-auto flex min-w-8 shrink-0 justify-end transition group-hover/inbox-row:opacity-0 pointer-coarse:opacity-0">
                <InboxStatusOrTime
                  session={session}
                  timestamp={session.lastActivityAt}
                />
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
          </button>
        </ContextMenuTrigger>
        {menu}
      </ContextMenu>
      <span className="pointer-events-none absolute right-1 top-2 flex h-4 items-center">
        {lifecycle.resume ? (
          <RowIconButton
            icon={PlayIcon}
            label="Resume session"
            disabled={lifecycle.isResumePending}
            onClick={lifecycle.resume}
          />
        ) : lifecycle.stop ? (
          <RowIconButton
            icon={SquareIcon}
            label={lifecycle.stopLabel}
            disabled={lifecycle.isStopPending}
            onClick={lifecycle.stop}
          />
        ) : null}
        {settleable ? (
          <RowIconButton
            icon={Check}
            label="Settle session"
            onClick={() => onSettle(session.sessionId)}
          />
        ) : null}
      </span>
    </li>
  );
}

function ShelfHeader({
  count,
  expanded,
  onToggle,
}: {
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
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
      >
        <span className="text-xs font-medium text-zinc-500">
          {expanded ? "Settled" : `Settled (${count})`}
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

  const { active, settled } = useMemo(
    () => partitionInboxSessions(scopedSessions),
    [scopedSessions],
  );

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
      unsettleMutation.mutate({ sessionId });
    },
    [unsettleMutation],
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
              className="h-7 w-full justify-start gap-1.5 px-1.5 text-xs text-zinc-300"
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
              projectLabel={
                projectLabelByPath.get(session.startupConfig.cwd) ??
                getProjectNameFromPath(session.startupConfig.cwd)
              }
              onSettle={handleSettle}
              onUnsettle={handleUnsettle}
            />
          ))}

          {settled.length > 0 ? (
            <ShelfHeader
              count={settled.length}
              expanded={settledExpanded}
              onToggle={() => setSettledExpanded((value) => !value)}
            />
          ) : null}

          {visibleSettled.map((session) => (
            <InboxRow
              key={session.sessionId}
              session={session}
              variant="slim"
              projectLabel={
                projectLabelByPath.get(session.startupConfig.cwd) ??
                getProjectNameFromPath(session.startupConfig.cwd)
              }
              onSettle={handleSettle}
              onUnsettle={handleUnsettle}
            />
          ))}

          {settledExpanded && hiddenSettledCount > 0 ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() =>
                  setSettledVisibleCount((count) => count + SETTLED_PAGE_COUNT)
                }
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200"
              >
                <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                Show {Math.min(hiddenSettledCount, SETTLED_PAGE_COUNT)} more
              </button>
            </li>
          ) : null}
        </ul>

        {active.length === 0 && settled.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-zinc-500">
            {projects.length === 0 ? (
              <>
                <span>No projects yet</span>
                <button
                  type="button"
                  onClick={openAddProjectDialog}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 font-medium text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100"
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
