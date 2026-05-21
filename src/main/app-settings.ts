import z from "zod";
import { lastSessionOptionsSchema } from "../shared/last-session-options";
import { defineServiceState } from "../shared/service-state";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export interface AppSettings {
  preventSleep: boolean;
  dockBadgeForAttention: boolean;
  dockBounceOnAttention: boolean;
  lastSessionOptions: z.infer<typeof lastSessionOptionsSchema>;
}

const defaults: AppSettings = {
  preventSleep: true,
  dockBadgeForAttention: true,
  dockBounceOnAttention: false,
  lastSessionOptions: {},
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
};
