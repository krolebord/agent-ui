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
import {
  buildScheduleSpec,
  createDefaultScheduleDraft,
  formatRunTime,
  getNextCronRun,
  type RecurringPreset,
  type ScheduleDraft,
} from "@renderer/lib/schedule-draft";
import { CalendarClock } from "lucide-react";

export {
  buildScheduleSpec,
  createDefaultScheduleDraft,
  describeSchedule,
  formatRunTime,
  type RecurringPreset,
  type ScheduleDraft,
  scheduleSpecToDraft,
} from "@renderer/lib/schedule-draft";

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
  mode = "create",
}: {
  isPending: boolean;
  onClose: () => void;
  scheduleDraft: ScheduleDraft | null;
  setScheduleDraft: (draft: ScheduleDraft | null) => void;
  mode?: "create" | "edit";
}) {
  const isScheduling = scheduleDraft !== null;
  const isEditing = mode === "edit";

  const submitLabel = isEditing
    ? isPending
      ? "Saving..."
      : "Save"
    : isScheduling
      ? isPending
        ? "Scheduling..."
        : "Schedule"
      : isPending
        ? "Starting..."
        : "Create";

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
        {!isEditing && (
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
        )}
        <Button type="submit" disabled={isPending}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
