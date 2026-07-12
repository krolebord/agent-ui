import { defineMcpTool, textResult } from "../define-tool";

export const listScheduledSessionsTool = defineMcpTool({
  name: "list_scheduled_sessions",
  description:
    "Lists all scheduled agent sessions in Agent UI, including disabled " +
    "ones awaiting user approval. Check this before creating a scheduled " +
    "session to avoid duplicates.",
  inputSchema: {},
  handler: async (_input, services) => {
    const entries = services.scheduledSessionsService.list();
    return textResult(
      JSON.stringify(
        {
          scheduledSessions: entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            createdBy: entry.createdBy ?? "user",
            enabled: entry.enabled,
            needsApproval: entry.needsApproval ?? false,
            schedule: entry.schedule,
            sessionType: entry.config.type,
            cwd: entry.config.cwd,
            initialPrompt: entry.config.initialPrompt,
            nextRunAt: entry.nextRunAt,
            lastRunAt: entry.lastRunAt,
            lastError: entry.lastError,
          })),
        },
        null,
        2,
      ),
    );
  },
});
