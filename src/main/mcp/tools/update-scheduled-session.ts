import { z } from "zod";
import { scheduledSessionConfigSchema } from "../../scheduled-sessions/state";
import { defineMcpTool, textResult } from "../define-tool";
import {
  resolveScheduleInput,
  scheduleInputSchema,
} from "./create-scheduled-session";

export const updateScheduledSessionTool = defineMcpTool({
  name: "update_scheduled_session",
  description:
    "Replaces the name, schedule, and config of a scheduled session that " +
    "was previously created by an agent (see list_scheduled_sessions). The " +
    "edit is a proposal: the entry is disabled again and runs only after " +
    "the user re-approves it in the Scheduled Sessions page. User-created " +
    "schedules cannot be edited; ask the user to change those instead.",
  inputSchema: {
    id: z.string().describe("Id of the scheduled session to update."),
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
          "This session is not allowed to modify scheduled sessions: it was " +
            "itself started from an agent-created schedule. Ask the user to " +
            "make the change instead.",
        ),
        isError: true,
      };
    }

    const entry = services.scheduledSessionsService.get(input.id);
    if (!entry) {
      return {
        ...textResult(`Scheduled session ${input.id} not found.`),
        isError: true,
      };
    }
    if ((entry.createdBy ?? "user") !== "agent") {
      return {
        ...textResult(
          "Only agent-created scheduled sessions can be edited via MCP. " +
            "This one was created by the user; ask them to edit it in the " +
            "Scheduled Sessions page.",
        ),
        isError: true,
      };
    }

    services.scheduledSessionsService.update({
      id: input.id,
      name: input.name,
      schedule: resolveScheduleInput(input.schedule),
      config: input.config,
      editedBy: "agent",
    });

    return textResult(
      JSON.stringify(
        {
          id: input.id,
          status: "pending-approval",
          note:
            "Updated and disabled. It will not run until the user re-enables " +
            "it in the Scheduled Sessions page.",
        },
        null,
        2,
      ),
    );
  },
});
