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

export const sleepBlockModes = ["off", "working", "always"] as const;
export type SleepBlockMode = (typeof sleepBlockModes)[number];

export const machineStatsPollIntervalSeconds = [15, 30, 60, 300] as const;

const machineStatsPollIntervalSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(300),
]);

export type MachineStatsPollIntervalSeconds = z.infer<
  typeof machineStatsPollIntervalSchema
>;

export interface MachineStatsSettings {
  enabled: boolean;
  cpuMemoryPollIntervalSeconds: MachineStatsPollIntervalSeconds;
  temperaturePollIntervalSeconds: MachineStatsPollIntervalSeconds;
}

export const defaultMachineStatsSettings: MachineStatsSettings = {
  enabled: true,
  cpuMemoryPollIntervalSeconds: 15,
  temperaturePollIntervalSeconds: 30,
};

export const machineStatsSettingsSchema = z
  .object({
    enabled: z.boolean().catch(defaultMachineStatsSettings.enabled),
    cpuMemoryPollIntervalSeconds: machineStatsPollIntervalSchema.catch(
      defaultMachineStatsSettings.cpuMemoryPollIntervalSeconds,
    ),
    temperaturePollIntervalSeconds: machineStatsPollIntervalSchema.catch(
      defaultMachineStatsSettings.temperaturePollIntervalSeconds,
    ),
  })
  .catch(defaultMachineStatsSettings);

export interface AppSettings {
  sleepBlockMode: SleepBlockMode;
  dockBadgeForAttention: boolean;
  dockBounceOnAttention: boolean;
  machineStats: MachineStatsSettings;
  lastSessionOptions: z.infer<typeof lastSessionOptionsSchema>;
  titleGeneration: TitleGenerationSettings;
  promptLibrary: PromptLibraryEntry[];
}

const defaults: AppSettings = {
  sleepBlockMode: "working",
  dockBadgeForAttention: true,
  dockBounceOnAttention: false,
  machineStats: defaultMachineStatsSettings,
  lastSessionOptions: {},
  titleGeneration: defaultTitleGenerationSettings,
  promptLibrary: [],
};

export type AppSettingsState = ReturnType<typeof defineAppSettingsState>;

export function defineAppSettingsState() {
  return defineServiceState({ key: "appSettings" as const, defaults });
}

const sleepBlockModeSchema = z.enum(sleepBlockModes);

const appSettingsPersistenceSchema = z
  .object({
    sleepBlockMode: z
      .union([sleepBlockModeSchema, z.undefined()])
      .catch(undefined),
    preventSleep: z.boolean().optional().catch(undefined),
    dockBadgeForAttention: z.boolean().catch(true),
    dockBounceOnAttention: z.boolean().catch(false),
    machineStats: machineStatsSettingsSchema,
    lastSessionOptions: lastSessionOptionsSchema.catch({}),
    titleGeneration: titleGenerationSettingsSchema.catch(
      defaultTitleGenerationSettings,
    ),
    promptLibrary: promptLibrarySchema,
  })
  .transform(({ preventSleep, sleepBlockMode, ...settings }) => ({
    ...settings,
    sleepBlockMode:
      sleepBlockMode ?? (preventSleep === false ? "off" : "working"),
  }));

export function defineAppSettingsPersistence(state: AppSettingsState) {
  return defineStatePersistence({
    serviceState: state,
    schema: appSettingsPersistenceSchema,
  });
}

export const appSettingsRouter = {
  setSleepBlockMode: procedure
    .input(z.object({ mode: sleepBlockModeSchema }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.sleepBlockMode = input.mode;
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
  setMachineStats: procedure
    .input(machineStatsSettingsSchema)
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.machineStats = input;
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
