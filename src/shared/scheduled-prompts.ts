import type { Session } from "@main/sessions/state";
import type { UsageEntry } from "@main/usage-tracking";
import { z } from "zod";
import { usageEntryKey } from "./usage-keys";

const timeScheduleSchemas = [
  z.object({ kind: z.literal("after-turn") }),
  z.object({ kind: z.literal("at"), at: z.number().finite() }),
  z.object({
    kind: z.literal("usage-reset"),
    window: z.enum(["short", "weekly"]),
    at: z.number().finite(),
    usageKey: z.string(),
  }),
] satisfies [z.ZodType, ...z.ZodType[]];
const afterSessionScheduleSchema = z.object({
  kind: z.literal("after-session"),
  sourceSessionId: z.string().min(1),
  sourceTurnId: z.string().min(1),
});
export const promptScheduleSchema = z.discriminatedUnion("kind", [
  ...timeScheduleSchemas,
  afterSessionScheduleSchema,
]);
export type PromptSchedule = z.infer<typeof promptScheduleSchema>;
export const scheduledPromptScheduleSchema = z.discriminatedUnion("kind", [
  ...timeScheduleSchemas,
  afterSessionScheduleSchema.extend({
    sourceTitle: z.string(),
    completed: z.boolean(),
  }),
]);
export type ScheduledPromptSchedule = z.infer<
  typeof scheduledPromptScheduleSchema
>;

export const scheduledPromptInputSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z
    .string()
    .trim()
    .max(100_000)
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const code = character.charCodeAt(0);
          return (
            (code >= 32 && code !== 127) ||
            code === 9 ||
            code === 10 ||
            code === 13
          );
        }),
      "Prompt contains unsupported control characters",
    ),
  schedule: promptScheduleSchema,
});
export type ScheduledPromptInput = z.infer<typeof scheduledPromptInputSchema>;

export function supportsScheduledPrompts(
  session: Session,
): session is Extract<
  Session,
  { type: "claude-local-terminal" | "codex-local-terminal" | "cursor-agent" }
> {
  return (
    session.type === "claude-local-terminal" ||
    session.type === "codex-local-terminal" ||
    session.type === "cursor-agent"
  );
}

export function getPromptUsageKey(session: Session): string | null {
  switch (session.type) {
    case "claude-local-terminal":
      return usageEntryKey("claude", session.startupConfig.accountId ?? null);
    case "codex-local-terminal":
      return usageEntryKey("codex", session.startupConfig.accountId ?? null);
    default:
      return null;
  }
}

export function getPromptUsageWindows(
  entry: UsageEntry | undefined,
  model?: string,
) {
  if (!entry?.data) return [];
  switch (entry.provider) {
    case "claude":
      return [
        entry.data.five_hour,
        entry.data.seven_day,
        model?.includes("sonnet") ? entry.data.seven_day_sonnet : null,
      ].flatMap((window) =>
        window
          ? [{ utilization: window.utilization, resetsAt: window.resets_at }]
          : [],
      );
    case "codex":
      return [entry.data.primaryWindow, entry.data.secondaryWindow].flatMap(
        (window) => (window ? [window] : []),
      );
    default:
      return [];
  }
}

export function getPromptResetAt(
  entry: UsageEntry | undefined,
  window: "short" | "weekly",
): number | null {
  let reset: string | null | undefined;
  if (entry?.provider === "claude") {
    reset =
      window === "short"
        ? entry.data?.five_hour?.resets_at
        : entry.data?.seven_day?.resets_at;
  } else if (entry?.provider === "codex") {
    const duration = window === "short" ? 5 * 60 * 60 : 7 * 24 * 60 * 60;
    reset = [entry.data?.primaryWindow, entry.data?.secondaryWindow].find(
      (item) => item?.windowSeconds === duration,
    )?.resetsAt;
  }
  const at = reset ? Date.parse(reset) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export function getRunningPromptSources(
  sessions: Session[],
  targetSessionId: string,
): Session[] {
  return sessions.filter(
    (session) =>
      session.sessionId !== targetSessionId &&
      supportsScheduledPrompts(session) &&
      session.status === "running" &&
      session.turn?.status === "running",
  );
}

export function describePromptSchedule(
  schedule: PromptSchedule | ScheduledPromptSchedule,
): string {
  if (schedule.kind === "after-turn") return "When current turn finishes";
  if (schedule.kind === "after-session")
    return "sourceTitle" in schedule
      ? `After "${schedule.sourceTitle}" finishes its current turn`
      : "When another session finishes";
  const time = new Date(schedule.at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (schedule.kind === "at") return time;
  return `After ${schedule.window === "short" ? "5-hour" : "weekly"} reset · ${time}`;
}
