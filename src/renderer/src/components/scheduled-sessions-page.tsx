import type { ScheduledSession } from "@main/scheduled-sessions/state";
import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { useNewSessionDialogStore } from "@renderer/components/new-session-dialog";
import {
  describeSchedule,
  formatRunTime,
} from "@renderer/components/schedule-session-controls";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
} from "@renderer/components/session-type-icons";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import {
  CalendarClock,
  Pencil,
  Play,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

const SESSION_TYPE_META = {
  claude: { label: "Claude", icon: ClaudeCodeIcon },
  codex: { label: "Codex", icon: CodexIcon },
  cursorAgent: { label: "Cursor", icon: CursorAgentIcon },
} as const;

function projectLabel(projectPath: string, alias?: string): string {
  if (alias?.trim()) return alias.trim();
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

function entryDisplayName(entry: ScheduledSession): string {
  return (
    entry.name ||
    entry.config.sessionName ||
    entry.config.initialPrompt ||
    "Scheduled session"
  );
}

function entrySortKey(entry: ScheduledSession): number {
  if (entry.enabled && entry.nextRunAt !== undefined) {
    return entry.nextRunAt;
  }
  return Number.MAX_SAFE_INTEGER - entry.createdAt;
}

export function ScheduledSessionsPage() {
  const scheduledSessions = useAppState((state) => state.scheduledSessions);
  const projects = useAppState((state) => state.projects);

  const projectLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const project of projects) {
      labels.set(project.path, projectLabel(project.path, project.alias));
    }
    return labels;
  }, [projects]);

  const entries = useMemo(
    () =>
      Object.values(scheduledSessions).sort(
        (left, right) => entrySortKey(left) - entrySortKey(right),
      ),
    [scheduledSessions],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <CalendarClock className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Scheduled sessions</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">
            Sessions that start automatically, once or on a recurring schedule.
            Schedule one from the new session dialog using the{" "}
            <CalendarClock className="inline size-3" aria-hidden="true" />{" "}
            button. Missed one-time schedules run when the app starts; missed
            recurring runs are skipped.
          </p>

          <div className="rounded-md border border-border/60">
            {entries.length === 0 ? (
              <div className="text-muted-foreground p-6 text-center text-sm">
                No scheduled sessions yet.
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {entries.map((entry) => (
                  <ScheduledSessionRow
                    key={entry.id}
                    entry={entry}
                    projectLabel={
                      projectLabels.get(entry.config.cwd) ??
                      projectLabel(entry.config.cwd)
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScheduledSessionRow({
  entry,
  projectLabel,
}: {
  entry: ScheduledSession;
  projectLabel: string;
}) {
  const typeMeta = SESSION_TYPE_META[entry.config.type];
  const lastRunSession = useAppState((state) =>
    entry.lastRunSessionId
      ? (state.sessions[entry.lastRunSessionId] ?? null)
      : null,
  );

  const setEnabledMutation = useMutation(
    orpc.scheduledSessions.setEnabled.mutationOptions({
      onError: (error) => {
        toast.error(error.message || "Failed to update schedule");
      },
    }),
  );

  const runNowMutation = useMutation(
    orpc.scheduledSessions.runNow.mutationOptions({
      onSuccess: () => {
        toast.success("Session started");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to start session");
      },
    }),
  );

  const deleteMutation = useMutation(
    orpc.scheduledSessions.delete.mutationOptions({
      onError: (error) => {
        toast.error(error.message || "Failed to delete schedule");
      },
    }),
  );

  const handleDelete = () => {
    useConfirmDialogStore.getState().confirm({
      title: "Delete scheduled session",
      description: `Delete "${entryDisplayName(entry)}"? Sessions it already started are kept.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteMutation.mutateAsync({ id: entry.id });
      },
    });
  };

  const openLastRunSession = () => {
    if (!lastRunSession) {
      return;
    }
    useActiveSessionStore
      .getState()
      .setActiveSessionId(lastRunSession.sessionId);
    useMainViewStore.getState().showSessions();
  };

  const isCompletedOneOff =
    entry.schedule.kind === "once" && !entry.enabled && entry.lastRunAt;
  const isAgentCreated = entry.createdBy === "agent";
  const needsApproval = entry.needsApproval === true;

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <typeMeta.icon
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-label={typeMeta.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              !entry.enabled && "text-muted-foreground",
            )}
          >
            {entryDisplayName(entry)}
          </span>
          {entry.schedule.kind === "recurring" ? (
            <Badge variant="outline">Recurring</Badge>
          ) : null}
          {isAgentCreated ? (
            <Badge variant="outline" title="Created by an agent via MCP">
              Agent
            </Badge>
          ) : null}
          {needsApproval ? (
            <Badge variant="secondary" title="Enable to approve this schedule">
              Needs approval
            </Badge>
          ) : null}
          {isCompletedOneOff && !entry.lastError ? (
            <Badge variant="secondary">Completed</Badge>
          ) : null}
        </div>
        <div className="text-muted-foreground mt-1 space-y-0.5 text-xs">
          <div className="truncate">
            {projectLabel} · {describeSchedule(entry.schedule)}
          </div>
          <div className="flex flex-wrap items-center gap-x-2">
            {entry.enabled && entry.nextRunAt !== undefined ? (
              <span>Next run: {formatRunTime(entry.nextRunAt)}</span>
            ) : null}
            {entry.lastRunAt ? (
              <span>Last run: {formatRunTime(entry.lastRunAt)}</span>
            ) : null}
            {lastRunSession ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-foreground/80 underline-offset-2 hover:underline"
                onClick={openLastRunSession}
              >
                <SquareArrowOutUpRight className="size-3" />
                Open session
              </button>
            ) : null}
          </div>
          {entry.lastError ? (
            <div className="text-rose-400">
              Last run failed: {entry.lastError}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-8 px-0"
          aria-label={`Run ${entryDisplayName(entry)} now`}
          title="Run now"
          disabled={runNowMutation.isPending}
          onClick={() => {
            runNowMutation.mutate({ id: entry.id });
          }}
        >
          <Play className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-8 px-0"
          aria-label={`Edit ${entryDisplayName(entry)}`}
          title="Edit"
          onClick={() => {
            useNewSessionDialogStore
              .getState()
              .openScheduledSessionEditor(entry.id);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Switch
          aria-label={`Enable ${entryDisplayName(entry)}`}
          checked={entry.enabled}
          disabled={setEnabledMutation.isPending}
          onCheckedChange={(checked) => {
            setEnabledMutation.mutate({ id: entry.id, enabled: checked });
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-8 px-0 text-destructive hover:text-destructive"
          aria-label={`Delete ${entryDisplayName(entry)}`}
          disabled={deleteMutation.isPending}
          onClick={handleDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}
