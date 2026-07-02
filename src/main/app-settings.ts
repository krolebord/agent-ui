import { randomUUID } from "node:crypto";
import z from "zod";
import { lastSessionOptionsSchema } from "../shared/last-session-options";
import {
  type PromptLibraryEntry,
  promptLibrarySchema,
} from "../shared/prompt-library";
import { defineServiceState } from "../shared/service-state";
import {
  defaultTitleGenerationSettings,
  type TitleGenerationSettings,
  titleGenerationProviders,
  titleGenerationSettingsSchema,
} from "../shared/title-generation";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export interface AppSettings {
  preventSleep: boolean;
  dockBadgeForAttention: boolean;
  dockBounceOnAttention: boolean;
  lastSessionOptions: z.infer<typeof lastSessionOptionsSchema>;
  titleGeneration: TitleGenerationSettings;
  promptLibrary: PromptLibraryEntry[];
}

const defaults: AppSettings = {
  preventSleep: true,
  dockBadgeForAttention: true,
  dockBounceOnAttention: false,
  lastSessionOptions: {},
  titleGeneration: defaultTitleGenerationSettings,
  promptLibrary: [],
};

export type AppSettingsState = ReturnType<typeof defineAppSettingsState>;

export function defineAppSettingsState() {
  return defineServiceState({ key: "appSettings" as const, defaults });
}

const appSettingsPersistenceSchema = z.object({
  preventSleep: z.boolean().catch(true),
  dockBadgeForAttention: z.boolean().catch(true),
  dockBounceOnAttention: z.boolean().catch(false),
  lastSessionOptions: lastSessionOptionsSchema.catch({}),
  titleGeneration: titleGenerationSettingsSchema.catch(
    defaultTitleGenerationSettings,
  ),
  promptLibrary: promptLibrarySchema,
});

export function defineAppSettingsPersistence(state: AppSettingsState) {
  return defineStatePersistence({
    serviceState: state,
    schema: appSettingsPersistenceSchema,
  });
}

export const appSettingsRouter = {
  setPreventSleep: procedure
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.preventSleep = input.enabled;
      });
    }),
  setDockBadgeForAttention: procedure
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.dockBadgeForAttention = input.enabled;
      });
    }),
  setDockBounceOnAttention: procedure
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.dockBounceOnAttention = input.enabled;
      });
    }),
  setLastSessionOptions: procedure
    .input(lastSessionOptionsSchema)
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.lastSessionOptions = input;
      });
    }),
  setTitleGeneration: procedure
    .input(
      z.object({
        provider: z.enum(titleGenerationProviders),
        model: z.string().trim().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.titleGeneration = input;
      });
    }),
  createPromptLibraryEntry: procedure
    .input(
      z.object({
        name: z.string().trim().min(1),
        body: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      const now = Date.now();
      const entry: PromptLibraryEntry = {
        id: randomUUID(),
        name: input.name,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      };
      context.appSettingsState.updateState((state) => {
        state.promptLibrary.push(entry);
      });
      return entry;
    }),
  updatePromptLibraryEntry: procedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1),
        body: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        const entry = state.promptLibrary.find((item) => item.id === input.id);
        if (!entry) {
          throw new Error("Prompt not found");
        }
        entry.name = input.name;
        entry.body = input.body;
        entry.updatedAt = Date.now();
      });
    }),
  deletePromptLibraryEntry: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        const index = state.promptLibrary.findIndex(
          (item) => item.id === input.id,
        );
        if (index === -1) {
          throw new Error("Prompt not found");
        }
        state.promptLibrary.splice(index, 1);
      });
    }),
};
