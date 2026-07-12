import type { ScheduleSpec } from "@main/scheduled-sessions/state";
import { Button } from "@renderer/components/ui/button";
import { DialogFooter } from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import { Cron } from "croner";
import { CalendarClock } from "lucide-react";

export type RecurringPreset =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export type ScheduleDraft =
  | { kind: "once"; at: string }
  | {
      kind: "recurring";
      preset: RecurringPreset;
      time: string;
      weekday: string;
      cron: string;
    };

const RECURRING_PRESET_OPTIONS: { value: RecurringPreset; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom cron" },
];

const WEEKDAY_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createDefaultScheduleDraft(): ScheduleDraft {
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
  inOneHour.setSeconds(0, 0);
  return { kind: "once", at: toDatetimeLocalValue(inOneHour) };
}

function buildCronFromDraft(
  draft: Extract<ScheduleDraft, { kind: "recurring" }>,
): string {
  if (draft.preset === "custom") {
    return draft.cron.trim();
  }

  const [hourPart = "9", minutePart = "0"] = draft.time.split(":");
  const hour = Number.parseInt(hourPart, 10) || 0;
  const minute = Number.parseInt(minutePart, 10) || 0;

  switch (draft.preset) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${draft.weekday}`;
  }
}

export function buildScheduleSpec(
  draft: ScheduleDraft,
): { schedule: ScheduleSpec } | { error: string } {
  if (draft.kind === "once") {
    const at = new Date(draft.at).getTime();
    if (Number.isNaN(at)) {
      return { error: "Pick a valid date and time." };
    }
    if (at <= Date.now()) {
      return { error: "Scheduled time must be in the future." };
    }
    return { schedule: { kind: "once", at } };
  }

  const cron = buildCronFromDraft(draft);
  if (!cron) {
    return { error: "Cron expression is required." };
  }
  const nextRun = getNextCronRun(cron);
  if (nextRun === null) {
    return { error: "Invalid cron expression." };
  }
  return { schedule: { kind: "recurring", cron } };
}

function getNextCronRun(cron: string): Date | null {
  try {
    return new Cron(cron).nextRun();
  } catch {
    return null;
  }
}

export function formatRunTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function describeSchedule(schedule: ScheduleSpec): string {
  if (schedule.kind === "once") {
    return `Once at ${formatRunTime(schedule.at)}`;
  }
  return `Recurring (${schedule.cron})`;
}

function SchedulePreview({ draft }: { draft: ScheduleDraft }) {
  const result = buildScheduleSpec(draft);
  if ("error" in result) {
    return <p className="text-xs text-destructive">{result.error}</p>;
  }

  const nextRun =
    result.schedule.kind === "once"
      ? new Date(result.schedule.at)
      : getNextCronRun(result.schedule.cron);
  if (!nextRun) {
    return <p className="text-xs text-destructive">Invalid schedule.</p>;
  }

  return (
    <p className="text-xs text-muted-foreground">
      Next run: {formatRunTime(nextRun.getTime())}
    </p>
  );
}

function SchedulePanel({
  draft,
  onChange,
  disabled,
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5" />
          Schedule
        </Label>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={draft.kind}
          onValueChange={(value) => {
            if (!value || value === draft.kind) {
              return;
            }
            onChange(
              value === "once"
                ? createDefaultScheduleDraft()
                : {
                    kind: "recurring",
                    preset: "daily",
                    time: "09:00",
                    weekday: "1",
                    cron: "0 9 * * *",
                  },
            );
          }}
        >
          <ToggleGroupItem value="once">Once</ToggleGroupItem>
          <ToggleGroupItem value="recurring">Recurring</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {draft.kind === "once" ? (
        <div className="space-y-2">
          <Label htmlFor="schedule-once-at">Run at</Label>
          <Input
            id="schedule-once-at"
            type="datetime-local"
            value={draft.at}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, at: event.target.value });
            }}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Label>Repeats</Label>
              <Select
                value={draft.preset}
                disabled={disabled}
                onValueChange={(value) => {
                  onChange({ ...draft, preset: value as RecurringPreset });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRING_PRESET_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {draft.preset === "weekly" ? (
              <div className="w-fit shrink-0 space-y-2">
                <Label>Day</Label>
                <Select
                  value={draft.weekday}
                  disabled={disabled}
                  onValueChange={(value) => {
                    onChange({ ...draft, weekday: value });
                  }}
                >
                  <SelectTrigger className="w-auto min-w-28 whitespace-nowrap">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {draft.preset !== "custom" ? (
              <div className="w-fit shrink-0 space-y-2">
                <Label>{draft.preset === "hourly" ? "At minute" : "At"}</Label>
                <Input
                  type="time"
                  className="w-auto"
                  value={draft.time}
                  disabled={disabled}
                  onChange={(event) => {
                    onChange({ ...draft, time: event.target.value });
                  }}
                />
              </div>
            ) : null}
          </div>

          {draft.preset === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="schedule-cron">Cron expression</Label>
              <Input
                id="schedule-cron"
                placeholder="0 9 * * 1-5"
                className="font-mono"
                value={draft.cron}
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...draft, cron: event.target.value });
                }}
              />
            </div>
          ) : null}
        </div>
      )}

      <SchedulePreview draft={draft} />
    </div>
  );
}

export function SessionFormFooter({
  isPending,
  onClose,
  scheduleDraft,
  setScheduleDraft,
}: {
  isPending: boolean;
  onClose: () => void;
  scheduleDraft: ScheduleDraft | null;
  setScheduleDraft: (draft: ScheduleDraft | null) => void;
}) {
  const isScheduling = scheduleDraft !== null;

  return (
    <>
      {scheduleDraft ? (
        <SchedulePanel
          draft={scheduleDraft}
          onChange={setScheduleDraft}
          disabled={isPending}
        />
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          className={isScheduling ? "text-primary" : undefined}
          aria-label={isScheduling ? "Remove schedule" : "Schedule for later"}
          aria-pressed={isScheduling}
          title={isScheduling ? "Remove schedule" : "Schedule for later"}
          disabled={isPending}
          onClick={() => {
            setScheduleDraft(
              isScheduling ? null : createDefaultScheduleDraft(),
            );
          }}
        >
          <CalendarClock className="size-4" />
        </Button>
        <Button type="submit" disabled={isPending}>
          {isScheduling
            ? isPending
              ? "Scheduling..."
              : "Schedule"
            : isPending
              ? "Starting..."
              : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}
