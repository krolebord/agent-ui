import z from "zod";
import { defineServiceState } from "../shared/service-state";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export interface AppSettings {
  preventSleep: boolean;
}

const defaults: AppSettings = {
  preventSleep: true,
};

export type AppSettingsState = ReturnType<typeof defineAppSettingsState>;

export function defineAppSettingsState() {
  return defineServiceState({ key: "appSettings" as const, defaults });
}

const appSettingsPersistenceSchema = z.object({
  preventSleep: z.boolean().catch(true),
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
};
