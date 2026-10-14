import type { ScheduledPrompt } from "@main/scheduled-prompts/state";
import type { Session } from "@main/sessions/state";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { scheduleSpecToDraft } from "@renderer/lib/schedule-draft";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  getPromptResetAt,
  getPromptUsageKey,
  getRunningPromptSources,
  type PromptSchedule,
} from "@shared/scheduled-prompts";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, Clock, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import {
  type PromptSourceSelection,
  RunningSessionPicker,
} from "./running-session-picker";
import { SessionPromptBox } from "./session-prompt-box";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";

type Timing = "after-turn" | "after-session" | "short" | "weekly" | "at";

export const useScheduledPromptComposerStore = create(
  combine(
    {
      target: null as {
        sessionId: string;
        entryId: string | null;
        nonce: number;
      } | null,
    },
    (set) => ({
      open: (sessionId: string, entryId: string | null = null) => {
        set({ target: { sessionId, entryId, nonce: Date.now() } });
      },
      close: () => {
        set({ target: null });
      },
    }),
  ),
);

export function ScheduledPromptText({ prompt }: { prompt: string }) {
  return prompt ? (
    prompt
  ) : (
    <span className="italic text-muted-foreground">
      Submit current composer
    </span>
  );
}

function localTime(at: number): string {
  const draft = scheduleSpecToDraft({ kind: "once", at });
  return draft.kind === "once" ? draft.at : "";
}

function formatWhen(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Date(at).toLocaleString(undefined, {
    weekday: sameDay ? undefined : "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function resetHint(at: number | null, now: number): string {
  if (!at || at <= now) return "Reset time unavailable";
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  const duration =
    minutes >= 24 * 60
      ? `${Math.floor(minutes / (24 * 60))}d ${Math.floor(minutes / 60) % 24}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
  return `${formatWhen(at, now)} · in ${duration}`;
}

function getEntryTiming(entry: ScheduledPrompt): Timing {
  return entry.schedule.kind === "usage-reset"
    ? entry.schedule.window
    : entry.schedule.kind;
}

function getEntrySource(entry: ScheduledPrompt): PromptSourceSelection | null {
  return entry.schedule.kind === "after-session"
    ? {
        sourceSessionId: entry.schedule.sourceSessionId,
        sourceTurnId: entry.schedule.sourceTurnId,
        title: entry.schedule.sourceTitle,
      }
    : null;
}

export function ScheduledPromptComposer({
  session,
  entry,
  disabled,
  onDone,
}: {
  session: Session;
  entry: ScheduledPrompt | null;
  disabled: boolean;
  onDone: () => void;
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
  const [prompt, setPrompt] = useState(entry?.prompt ?? "");
  const [timing, setTiming] = useState<Timing>(
    entry ? getEntryTiming(entry) : "after-turn",
  );
  const [at, setAt] = useState(() =>
    localTime(
      entry?.schedule.kind === "at"
        ? entry.schedule.at
        : Date.now() + 60 * 60_000,
    ),
  );
  const [source, setSource] = useState<PromptSourceSelection | null>(
    entry ? getEntrySource(entry) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const shortReset =
    usage?.status === "ok" ? getPromptResetAt(usage, "short") : null;
  const weeklyReset =
    usage?.status === "ok" ? getPromptResetAt(usage, "weekly") : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const save = useMutation({
    mutationFn: async (schedule: PromptSchedule) => {
      const input = { sessionId: session.sessionId, prompt, schedule };
      if (entry)
        await orpc.scheduledPrompts.update.call({ ...input, id: entry.id });
      else await orpc.scheduledPrompts.create.call(input);
    },
    onSuccess: onDone,
    onError: (err) => setError(err.message),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      if (!usageKey) return;
      const result = await orpc.usage.refresh.call({ key: usageKey });
      if (!result.ok) throw new Error(result.message ?? "Usage is unavailable");
    },
    onError: (err) => toast.error(err.message),
  });
  const busy = disabled || save.isPending;

  const submit = () => {
    if (busy) return;
    setError(null);
    if (timing === "after-turn") {
      save.mutate({ kind: "after-turn" });
      return;
    }
    if (timing === "after-session") {
      if (!source) {
        setError("Choose another running session.");
        return;
      }
      const existing = entry ? entries[entry.id] : undefined;
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
    save.mutate({ kind: "usage-reset", window: timing, at: reset, usageKey });
  };

  const atTimestamp = new Date(at).getTime();
  const options: {
    value: Timing;
    label: string;
    chip: string;
    hint: string;
    disabled: boolean;
  }[] = [
    {
      value: "after-turn",
      label: "When current turn finishes",
      chip: "After turn",
      hint:
        session.status === "idle" || session.status === "awaiting_user_response"
          ? "Session is ready, sends as soon as usage allows"
          : "Waits until the agent is ready",
      disabled: false,
    },
    {
      value: "after-session",
      label: "When another session finishes",
      chip: source ? `After ${source.title}` : "After session…",
      hint: "Waits for another running session's turn",
      disabled: false,
    },
    {
      value: "short",
      label: "After 5-hour limit resets",
      chip:
        shortReset && shortReset > now
          ? `5h reset · ${formatWhen(shortReset, now)}`
          : "5h reset",
      hint: resetHint(shortReset, now),
      disabled: !shortReset || shortReset <= now,
    },
    {
      value: "weekly",
      label: "After weekly limit resets",
      chip:
        weeklyReset && weeklyReset > now
          ? `Weekly reset · ${formatWhen(weeklyReset, now)}`
          : "Weekly reset",
      hint: resetHint(weeklyReset, now),
      disabled: !weeklyReset || weeklyReset <= now,
    },
    {
      value: "at",
      label: "At a specific time",
      chip: Number.isFinite(atTimestamp)
        ? formatWhen(atTimestamp, now)
        : "At time…",
      hint: "Waits for the current turn if the agent is busy",
      disabled: false,
    },
  ];
  const selected = options.find((option) => option.value === timing);

  return (
    <div className="flex flex-col gap-1.5">
      <SessionPromptBox
        id={entry ? `scheduled-prompt-${entry.id}` : "scheduled-prompt-new"}
        autoFocus={shouldAutoFocus()}
        placeholder="What should the agent do next? Empty submits the composer"
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        onCancel={onDone}
        handoffControl={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full border border-primary/50 bg-primary/15 px-2 text-[11px] text-foreground transition hover:bg-primary/25 disabled:opacity-50"
              >
                <Clock className="size-3 shrink-0" />
                <span className="truncate">{selected?.chip}</span>
                <ChevronDown className="size-3 shrink-0 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {options.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  disabled={option.disabled}
                  className="items-start gap-2"
                  onSelect={() => {
                    setTiming(option.value);
                    setError(null);
                  }}
                >
                  <Check
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      timing !== option.value && "invisible",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs">{option.label}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {option.hint}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
              {usageKey ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="gap-2 text-xs"
                    disabled={refresh.isPending || usage?.refreshing}
                    onSelect={(event) => {
                      event.preventDefault();
                      refresh.mutate();
                    }}
                  >
                    <RefreshCw
                      className={cn(
                        "size-3.5",
                        (refresh.isPending || usage?.refreshing) &&
                          "animate-spin",
                      )}
                    />
                    Refresh usage
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        }
        modeControl={
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="flat"
              className="size-6 px-0 text-muted-foreground"
              aria-label="Cancel"
              title="Cancel (Esc)"
              onClick={onDone}
            >
              <X className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              className="size-6 rounded-full px-0"
              disabled={busy}
              aria-label={entry ? "Save scheduled prompt" : "Schedule prompt"}
              title={entry ? "Save" : "Schedule"}
              onClick={submit}
            >
              <ArrowUp className="size-3.5" />
            </Button>
          </div>
        }
      />
      {timing === "after-session" ? (
        <RunningSessionPicker
          sessions={runningSources}
          value={source}
          onChange={setSource}
          disabled={busy}
          className="h-7 text-xs"
        />
      ) : null}
      {timing === "at" ? (
        <Input
          type="datetime-local"
          aria-label="Send at"
          className="h-7 text-xs"
          value={at}
          min={localTime(now)}
          disabled={busy}
          onChange={(event) => setAt(event.target.value)}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
