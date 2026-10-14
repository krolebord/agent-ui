import { z } from "zod";
import type { SessionBufferStore } from "../database/session-buffer-store";
import type { PersistenceStore } from "../persistence-orchestrator";

const legacySessionSchema = z.looseObject({
  startupConfig: z.looseObject({
    initialPrompt: z.string().optional(),
  }),
});

export async function migrateSessionInitialPrompts({
  store,
  sessionBuffers,
}: {
  store: PersistenceStore;
  sessionBuffers: SessionBufferStore;
}): Promise<number> {
  const parsed = z
    .record(z.string(), z.unknown())
    .safeParse(store.get("sessions"));
  if (!parsed.success) {
    return 0;
  }

  let migrated = 0;
  const sessions = { ...parsed.data };

  for (const [sessionId, value] of Object.entries(parsed.data)) {
    const parsedSession = legacySessionSchema.safeParse(value);
    if (!parsedSession.success) {
      continue;
    }
    const session = parsedSession.data;
    const { initialPrompt: prompt, ...startupConfig } = session.startupConfig;
    if (prompt !== undefined) {
      const hasInitialPrompt = !!prompt.trim();
      if (hasInitialPrompt) {
        await sessionBuffers.setInitialPrompt(sessionId, prompt);
      }
      sessions[sessionId] = {
        ...session,
        startupConfig,
        hasInitialPrompt,
      };
      migrated++;
    }
  }

  if (migrated > 0) {
    store.set("sessions", sessions);
  }

  return migrated;
}
