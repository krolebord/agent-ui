import * as z from "zod";

export const claudeHookEventSchema = z.object({
  timestamp: z.string(),
  session_id: z.string(),
  hook_event_name: z.string(),
  cwd: z.string().optional(),
  prompt: z.string().optional(),
  transcript_path: z.string().optional(),
  notification_type: z.string().optional(),
  tool_name: z.string().optional(),
  reason: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  agent_id: z.string().optional(),
  background_tasks: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
});
