import z from "zod";
import { lastSessionOptionsSchema } from "../shared/last-session-options";
import { defineServiceState } from "../shared/service-state";
import {
  defaultPinnedItems,
  normalizePinnedItems,
  type PinnableItemId,
  pinnableItemIds,
} from "../shared/sidebar-nav";
import {
  defaultTitleGenerationSettings,
  type TitleGenerationSettings,
  titleGenerationSettingsSchema,
} from "../shared/title-generation";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export const sleepBlockModes = ["off", "working", "always"] as const;
export type SleepBlockMode = (typeof sleepBlockModes)[number];

export const sidebarViews = ["projects", "inbox"] as const;
export type SidebarView = (typeof sidebarViews)[number];

export const machineStatsPollIntervalSeconds = [5, 15, 30, 60, 300] as const;

const machineStatsPollIntervalSchema = z.union([
  z.literal(5),
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
  diskPollIntervalSeconds: MachineStatsPollIntervalSeconds;
}

export const defaultMachineStatsSettings: MachineStatsSettings = {
  enabled: true,
  cpuMemoryPollIntervalSeconds: 15,
  diskPollIntervalSeconds: 60,
};

export const machineStatsSettingsSchema = z
  .object({
    enabled: z.boolean().catch(defaultMachineStatsSettings.enabled),
    cpuMemoryPollIntervalSeconds: machineStatsPollIntervalSchema.catch(
      defaultMachineStatsSettings.cpuMemoryPollIntervalSeconds,
    ),
    diskPollIntervalSeconds: machineStatsPollIntervalSchema.catch(
      defaultMachineStatsSettings.diskPollIntervalSeconds,
    ),
  })
  .catch(defaultMachineStatsSettings);

export interface AppSettings {
  sidebarView: SidebarView;
  pinnedHeaderItems: PinnableItemId[];
  sleepBlockMode: SleepBlockMode;
  dockBadgeForAttention: boolean;
  dockBounceOnAttention: boolean;
  machineStats: MachineStatsSettings;
  lastSessionOptions: z.infer<typeof lastSessionOptionsSchema>;
  titleGeneration: TitleGenerationSettings;
}

const defaults: AppSettings = {
  sidebarView: "projects",
  pinnedHeaderItems: [...defaultPinnedItems],
  sleepBlockMode: "working",
  dockBadgeForAttention: true,
  dockBounceOnAttention: false,
  machineStats: defaultMachineStatsSettings,
  lastSessionOptions: {},
  titleGeneration: defaultTitleGenerationSettings,
};

export type AppSettingsState = ReturnType<typeof defineAppSettingsState>;

export function defineAppSettingsState() {
  return defineServiceState({ key: "appSettings" as const, defaults });
}

const sleepBlockModeSchema = z.enum(sleepBlockModes);

const appSettingsPersistenceSchema = z
  .object({
    sidebarView: z.enum(sidebarViews).catch(defaults.sidebarView),
    pinnedHeaderItems: z
      .array(z.string())
      .catch(defaultPinnedItems)
      .transform(normalizePinnedItems),
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
  setSidebarView: procedure
    .input(z.object({ view: z.enum(sidebarViews) }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.sidebarView = input.view;
      });
    }),
  setHeaderItemPinned: procedure
    .input(z.object({ item: z.enum(pinnableItemIds), pinned: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.pinnedHeaderItems = normalizePinnedItems(
          input.pinned
            ? [...state.pinnedHeaderItems, input.item]
            : state.pinnedHeaderItems.filter((item) => item !== input.item),
        );
      });
    }),
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
    .input(titleGenerationSettingsSchema)
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.titleGeneration = input;
      });
    }),
};
