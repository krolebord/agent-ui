import type { ScheduledPrompt } from "@main/scheduled-prompts/state";
import type { Session } from "@main/sessions/state";
import { switchSession } from "@renderer/hooks/use-active-session-id";
import { scheduleSpecToDraft } from "@renderer/lib/schedule-draft";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  describePromptSchedule,
  getPromptResetAt,
  getPromptUsageKey,
  getRunningPromptSources,
  type PromptSchedule,
  supportsScheduledPrompts,
} from "@shared/scheduled-prompts";
import { useMutation } from "@tanstack/react-query";
import {
  CalendarClock,
  Check,
  Clock,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type PromptSourceSelection,
  RunningSessionPicker,
} from "./running-session-picker";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

type Timing = "after-turn" | "after-session" | "short" | "weekly" | "at";

function localTime(at: number): string {
  const draft = scheduleSpecToDraft({ kind: "once", at });
  return draft.kind === "once" ? draft.at : "";
}

function resetHint(at: number | null, now: number): string {
  if (!at || at <= now)
    return "Reset time unavailable. Refresh usage or choose a specific time.";
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  const duration =
    minutes >= 24 * 60
      ? `${Math.floor(minutes / (24 * 60))}d ${Math.floor(minutes / 60) % 24}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
  return `${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} · in ${duration}`;
}

export function SchedulePromptButton({
  session,
  disabled,
}: {
  session: Session;
  disabled?: boolean;
}) {
  const entries = useAppState((state) => state.scheduledPrompts);
  const count = Object.values(entries).filter(
    (entry) => entry.sessionId === session.sessionId && entry.status !== "sent",
  ).length;
  const [open, setOpen] = useState(false);
  if (!supportsScheduledPrompts(session)) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-7 shrink-0 gap-1 px-1.5",
            count > 0 && "text-primary",
          )}
          aria-label={
            count ? `Scheduled prompts, ${count} pending` : "Schedule prompt"
          }
          title={count ? `Scheduled prompts (${count})` : "Schedule prompt"}
        >
          <CalendarClock className="size-3.5" />
          {count > 0 ? (
            <span className="font-mono text-[11px]">{count}</span>
          ) : null}
        </Button>
      </DialogTrigger>
      {open ? (
        <SchedulePromptDialog
          session={session}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Dialog>
  );
}

function SchedulePromptDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const entries = useAppState((state) => state.scheduledPrompts);
  const usageEntries = useAppState((state) => state.usage.entries);
  const sessions = useAppState((state) => state.sessions);
  const runningSources = getRunningPromptSources(
    Object.values(sessions),
    session.sessionId,
  );
  const usageKey = getPromptUsageKey(session);
  const usage = usageKey ? usageEntries[usageKey] : undefined;
  const [now, setNow] = useState(Date.now);
  const [prompt, setPrompt] = useState("");
  const [timing, setTiming] = useState<Timing>("after-turn");
  const [at, setAt] = useState(() => localTime(Date.now() + 60 * 60_000));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [source, setSource] = useState<PromptSourceSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shortReset =
    usage?.status === "ok" ? getPromptResetAt(usage, "short") : null;
  const weeklyReset =
    usage?.status === "ok" ? getPromptResetAt(usage, "weekly") : null;
  const scheduled = Object.values(entries)
    .filter((entry) => entry.sessionId === session.sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const pending = scheduled.filter((entry) => entry.status !== "sent");
  const sent = scheduled
    .filter((entry) => entry.status === "sent")
    .slice(-5)
    .reverse();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const resetForm = () => {
    setPrompt("");
    setTiming("after-turn");
    setEditingId(null);
    setSource(null);
    setError(null);
  };
  const save = useMutation({
    mutationFn: async (schedule: PromptSchedule) => {
      const input = { sessionId: session.sessionId, prompt, schedule };
      if (editingId)
        await orpc.scheduledPrompts.update.call({ ...input, id: editingId });
      else await orpc.scheduledPrompts.create.call(input);
    },
    onSuccess: resetForm,
    onError: (err) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => orpc.scheduledPrompts.delete.call({ id }),
    onSuccess: (_data, id) => {
      if (editingId === id) resetForm();
    },
    onError: (err) => toast.error(err.message),
  });
  const send = useMutation({
    mutationFn: (id: string) => orpc.scheduledPrompts.sendNow.call({ id }),
    onSuccess: (_data, id) => {
      if (editingId === id) resetForm();
      toast.success("Prompt queued for the next available turn");
    },
    onError: (err) => toast.error(err.message),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      if (usageKey) {
        const result = await orpc.usage.refresh.call({ key: usageKey });
        if (!result.ok)
          throw new Error(result.message ?? "Usage is unavailable");
      }
    },
    onError: (err) => toast.error(err.message),
  });
  const busy = save.isPending || remove.isPending || send.isPending;

  const edit = (entry: ScheduledPrompt) => {
    setEditingId(entry.id);
    setPrompt(entry.prompt);
    setError(null);
    setTiming(
      entry.schedule.kind === "usage-reset"
        ? entry.schedule.window
        : entry.schedule.kind,
    );
    if (entry.schedule.kind === "at") setAt(localTime(entry.schedule.at));
    setSource(
      entry.schedule.kind === "after-session"
        ? {
            sourceSessionId: entry.schedule.sourceSessionId,
            sourceTurnId: entry.schedule.sourceTurnId,
            title: entry.schedule.sourceTitle,
          }
        : null,
    );
  };

  const options: {
    value: Timing;
    label: string;
    hint: string;
    disabled: boolean;
  }[] = [
    {
      value: "after-turn",
      label: "When current turn finishes",
      hint:
        session.status === "idle" || session.status === "awaiting_user_response"
          ? "Session is ready. Sends as soon as usage allows."
          : "Waits until the agent is ready for your next prompt.",
      disabled: false,
    },
    {
      value: "after-session",
      label: "When another session finishes",
      hint: "Wait for the current turn of another running session.",
      disabled: false,
    },
    {
      value: "short",
      label: "After 5-hour limit resets",
      hint: resetHint(shortReset, now),
      disabled: !shortReset || shortReset <= now,
    },
    {
      value: "weekly",
      label: "After weekly limit resets",
      hint: resetHint(weeklyReset, now),
      disabled: !weeklyReset || weeklyReset <= now,
    },
    {
      value: "at",
      label: "At a specific time",
      hint: "Waits for the current turn if the agent is still busy.",
      disabled: false,
    },
  ];

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {editingId ? "Edit scheduled prompt" : "Schedule prompt"}
        </DialogTitle>
        <DialogDescription>
          Continue this conversation when the agent is ready.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          if (!prompt.trim()) {
            setError("Enter a prompt.");
            return;
          }
          if (timing === "after-turn") {
            save.mutate({ kind: "after-turn" });
            return;
          }
          if (timing === "after-session") {
            if (!source) {
              setError("Choose another running session.");
              return;
            }
            const existing = editingId ? entries[editingId] : undefined;
            const schedule = existing?.schedule;
            const keepsDependency =
              existing?.status === "pending" &&
              schedule?.kind === "after-session" &&
              schedule.sourceSessionId === source.sourceSessionId &&
              schedule.sourceTurnId === source.sourceTurnId;
            const currentSource = sessions[source.sourceSessionId];
            if (
              !keepsDependency &&
              (currentSource?.status !== "running" ||
                currentSource.turn?.status !== "running" ||
                currentSource.turn.id !== source.sourceTurnId)
            ) {
              setError(
                "The selected turn is no longer running. Choose another running session.",
              );
              return;
            }
            save.mutate({
              kind: "after-session",
              sourceSessionId: source.sourceSessionId,
              sourceTurnId: source.sourceTurnId,
            });
            return;
          }
          if (timing === "at") {
            const timestamp = new Date(at).getTime();
            if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
              setError("Choose a time in the future.");
              return;
            }
            save.mutate({ kind: "at", at: timestamp });
            return;
          }
          const reset = timing === "short" ? shortReset : weeklyReset;
          if (!usageKey || !reset || reset <= Date.now()) {
            setError(
              "Reset time is unavailable. Refresh usage or choose a specific time.",
            );
            return;
          }
          save.mutate({
            kind: "usage-reset",
            window: timing,
            at: reset,
            usageKey,
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="scheduled-prompt-text">Prompt</Label>
          <Textarea
            id="scheduled-prompt-text"
            autoFocus
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="What should the agent do next?"
            className="min-h-28 max-h-64"
            maxLength={100_000}
          />
        </div>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="sr-only">When to send the prompt</legend>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Send</span>
            {usageKey ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 text-xs text-muted-foreground"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending || usage?.refreshing}
              >
                <RefreshCw
                  className={cn(
                    "size-3",
                    (refresh.isPending || usage?.refreshing) && "animate-spin",
                  )}
                />
                Refresh usage
              </Button>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors",
                  timing === option.value
                    ? "border-primary/60 bg-primary/5"
                    : "border-border hover:bg-muted/40",
                  option.disabled && "cursor-default opacity-50",
                  option.value === "at" && "sm:col-span-2",
                )}
              >
                <input
                  type="radio"
                  name="prompt-timing"
                  value={option.value}
                  checked={timing === option.value}
                  disabled={option.disabled}
                  onChange={() => setTiming(option.value)}
                  className="mt-0.5 accent-primary"
                />
                <span className="min-w-0 space-y-1">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {timing === "after-session" ? (
            <div className="space-y-2 pt-1">
              <Label htmlFor="scheduled-prompt-source">Wait for</Label>
              <RunningSessionPicker
                sessions={runningSources}
                value={source}
                onChange={setSource}
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                {source
                  ? `Send here after "${source.title}" finishes its current turn.`
                  : "Only sessions actively working are listed."}
              </p>
            </div>
          ) : null}
          {timing === "at" ? (
            <div className="space-y-2 pt-1">
              <Label htmlFor="scheduled-prompt-at">Send at</Label>
              <Input
                id="scheduled-prompt-at"
                type="datetime-local"
                value={at}
                min={localTime(now)}
                onChange={(event) => setAt(event.target.value)}
              />
            </div>
          ) : null}
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="max-w-64 text-xs text-muted-foreground">
            Saved across restarts. The app or headless server must be running to
            send.
          </p>
          <div className="flex shrink-0 gap-2">
            {editingId ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={resetForm}
              >
                Cancel edit
              </Button>
            ) : null}
            <Button type="submit" disabled={busy || !prompt.trim()}>
              <CalendarClock className="size-4" />
              {save.isPending ? "Saving..." : editingId ? "Save" : "Schedule"}
            </Button>
          </div>
        </div>
      </form>
      {pending.length ? (
        <section
          className="space-y-2 border-t pt-3"
          aria-label="Pending prompts"
        >
          <p className="text-xs font-medium text-muted-foreground">
            Pending · {pending.length}
          </p>
          {pending.map((entry) => (
            <div key={entry.id} className="rounded-md border p-3">
              <div className="flex items-start gap-2">
                <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">
                    {entry.prompt}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {describePromptSchedule(entry.schedule)}
                  </p>
                  {entry.schedule.kind === "after-session" &&
                  sessions[entry.schedule.sourceSessionId] ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs"
                      onClick={() => {
                        if (entry.schedule.kind !== "after-session") return;
                        switchSession(entry.schedule.sourceSessionId);
                        onClose();
                      }}
                    >
                      View source session
                    </Button>
                  ) : null}
                  {entry.status === "sending" ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Sending, waiting for the agent to start...
                    </p>
                  ) : null}
                  {entry.message ? (
                    <p
                      className={cn(
                        "mt-1 text-xs",
                        entry.status === "failed" ||
                          entry.status === "uncertain"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {entry.message}
                    </p>
                  ) : null}
                </div>
              </div>
              {entry.status !== "sending" ? (
                <div className="mt-2 flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={busy}
                    onClick={() => edit(entry)}
                  >
                    <Pencil className="size-3" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={busy}
                    onClick={() => remove.mutate(entry.id)}
                  >
                    <Trash2 className="size-3" />
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={busy}
                    onClick={() => send.mutate(entry.id)}
                  >
                    <Send className="size-3" />
                    Send now
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {sent.length ? (
        <details className="border-t pt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Recently sent</summary>
          <div className="mt-2 space-y-2">
            {sent.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2">
                <Check className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{entry.prompt}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-6 shrink-0 p-0"
                  aria-label="Remove sent prompt"
                  disabled={busy}
                  onClick={() => remove.mutate(entry.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    </DialogContent>
  );
}
