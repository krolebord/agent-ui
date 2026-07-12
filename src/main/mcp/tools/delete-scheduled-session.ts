import { z } from "zod";
import { defineMcpTool, textResult } from "../define-tool";

export const deleteScheduledSessionTool = defineMcpTool({
  name: "delete_scheduled_session",
  description:
    "Deletes a scheduled session that was created by an agent and is still " +
    "awaiting user approval (never enabled, never ran). Use this to clean " +
    "up a schedule you created by mistake before proposing a replacement. " +
    "Approved or user-created schedules can only be deleted by the user.",
  inputSchema: {
    id: z.string().describe("Id of the scheduled session to delete."),
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
    if (
      (entry.createdBy ?? "user") !== "agent" ||
      entry.enabled ||
      entry.lastRunAt !== undefined
    ) {
      return {
        ...textResult(
          "Only agent-created scheduled sessions that were never approved " +
            "or run can be deleted via MCP. Ask the user to delete this one " +
            "in the Scheduled Sessions page.",
        ),
        isError: true,
      };
    }

    services.scheduledSessionsService.delete(input.id);
    return textResult(JSON.stringify({ id: input.id, status: "deleted" }));
  },
});
