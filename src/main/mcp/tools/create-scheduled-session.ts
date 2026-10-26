import { z } from "zod";
import type { ScheduleSpec } from "../../scheduled-sessions/state";
import { scheduledSessionConfigSchema } from "../../scheduled-sessions/state";
import { defineMcpTool, textResult } from "../define-tool";

export const scheduleInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("immediate") }).describe("Run right away."),
  z.object({
    kind: z.literal("once"),
    at: z.number().describe("Unix epoch milliseconds."),
  }),
  z.object({
    kind: z.literal("recurring"),
    cron: z.string().describe("Standard cron expression, e.g. '0 9 * * 1-5'."),
  }),
]);

export function resolveScheduleInput(
  schedule: z.output<typeof scheduleInputSchema>,
): ScheduleSpec {
  return schedule.kind === "immediate"
    ? { kind: "once", at: Date.now() }
    : schedule;
}

export const createScheduledSessionTool = defineMcpTool({
  name: "create_scheduled_session",
  description:
    "Creates a scheduled agent session in Agent UI. Schedule kind " +
    "'immediate' starts the session right away and 'once' runs it a single " +
    "time at a future moment; both take effect without user approval. " +
    "'recurring' (cron expression) is created DISABLED and runs only after " +
    "the user reviews and approves it in the Scheduled Sessions page — tell " +
    "the user to approve it there. config.cwd must be an absolute path to " +
    "the project directory (usually your own working directory); " +
    "config.initialPrompt is the task the scheduled agent should perform.",
  inputSchema: {
    name: z
      .string()
      .optional()
      .describe("Short human-readable name shown in the UI."),
    schedule: scheduleInputSchema,
    config: scheduledSessionConfigSchema,
  },
  handler: async (input, services, context) => {
    if (!context.canScheduleSessions) {
      return {
        ...textResult(
          "This session is not allowed to schedule sessions: it was itself " +
            "started from an agent-created schedule. Ask the user to create " +
            "the schedule instead.",
        ),
        isError: true,
      };
    }

    const needsApproval = input.schedule.kind === "recurring";
    const entry = services.scheduledSessionsService.create({
      name: input.name,
      schedule: resolveScheduleInput(input.schedule),
      config: input.config,
      createdBy: "agent",
      enabled: !needsApproval,
      allowPastOnce: input.schedule.kind === "immediate",
    });

    return textResult(
      JSON.stringify(
        needsApproval
          ? {
              id: entry.id,
              status: "pending-approval",
              note:
                "Created disabled. It will not run until the user enables " +
                "it in the Scheduled Sessions page.",
            }
          : { id: entry.id, status: "scheduled", nextRunAt: entry.nextRunAt },
        null,
        2,
      ),
    );
  },
});
