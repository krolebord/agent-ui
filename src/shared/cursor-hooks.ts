import * as z from "zod";

export const cursorHookEventSchema = z.object({
  timestamp: z.string(),
  hook_event_name: z.string(),
  conversation_id: z.string().optional(),
  session_id: z.string().optional(),
  generation_id: z.string().optional(),
  tool_name: z.string().optional(),
  failure_type: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  final_status: z.string().optional(),
  permission: z.string().optional(),
  decision: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  composer_mode: z.string().optional(),
  is_background_agent: z.boolean().optional(),
});

export type CursorHookEvent = z.infer<typeof cursorHookEventSchema>;
