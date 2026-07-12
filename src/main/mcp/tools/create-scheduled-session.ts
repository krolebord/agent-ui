import { z } from "zod";
import type { ScheduleSpec } from "../../scheduled-sessions/state";
import { scheduledSessionConfigSchema } from "../../scheduled-sessions/state";
import { defineMcpTool, textResult } from "../define-tool";

export const scheduleInputSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("immediate") })
    .describe("Run as soon as the user approves the session."),
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
    "Creates a scheduled agent session in Agent UI. The session is created " +
    "DISABLED and runs only after the user reviews and approves it in the " +
    "Scheduled Sessions page — tell the user to approve it there. Use " +
    "schedule kind 'immediate' to request a run right after approval, " +
    "'once' for a single future run, or 'recurring' with a cron expression. " +
    "config.cwd must be an absolute path to the project directory (usually " +
    "your own working directory); config.initialPrompt is the task the " +
    "scheduled agent should perform.",
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

    const entry = services.scheduledSessionsService.create({
      name: input.name,
      schedule: resolveScheduleInput(input.schedule),
      config: input.config,
      createdBy: "agent",
      enabled: false,
    });

    return textResult(
      JSON.stringify(
        {
          id: entry.id,
          status: "pending-approval",
          note:
            "Created disabled. It will not run until the user enables it in " +
            "the Scheduled Sessions page.",
        },
        null,
        2,
      ),
    );
  },
});
