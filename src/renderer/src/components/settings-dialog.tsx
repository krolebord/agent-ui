import {
  addRecentCursorModel,
  CursorModelPicker,
} from "@renderer/components/cursor-model-picker";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@renderer/components/ui/accordion";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd";
import { Label } from "@renderer/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { SHORTCUT_DEFINITIONS } from "@renderer/hooks/use-app-shortcuts";
import { hasNativeDesktopShell } from "@renderer/lib/native-shell";
import { orpc } from "@renderer/orpc-client";
import { titleGenerationProviders } from "@shared/title-generation";
import { useMutation } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bug,
  FolderOpen,
  Keyboard,
  LoaderCircle,
  Settings,
  Sparkles,
} from "lucide-react";
import type * as React from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { SkillsSettingsItem } from "./skills-dialog";
import { useAppState } from "./sync-state-provider";

export const useSettingsStore = create(
  combine(
    {
      isOpen: false,
    },
    (set) => ({
      openSettingsDialog: () => {
        set({ isOpen: true });
      },
      closeSettingsDialog: () => {
        set({ isOpen: false });
      },
    }),
  ),
);

export function SettingsDialog() {
  const { isOpen, closeSettingsDialog } = useSettingsStore();

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) closeSettingsDialog();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Application settings</DialogDescription>
        </DialogHeader>

        <Accordion type="multiple" className="-mx-1">
          {hasNativeDesktopShell ? (
            <AccordionItem value="general">
              <SettingsSectionTrigger icon={Settings}>
                General
              </SettingsSectionTrigger>
              <AccordionContent className="divide-y divide-border/40">
                <SleepBlockModeSelect />
                <DockBadgeForAttentionToggle />
                <DockBounceOnAttentionToggle />
              </AccordionContent>
            </AccordionItem>
          ) : null}

          <AccordionItem value="sidebar">
            <SettingsSectionTrigger icon={Activity}>
              Sidebar
            </SettingsSectionTrigger>
            <AccordionContent>
              <MachineStatsSettings />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="ai-prompts">
            <SettingsSectionTrigger icon={Sparkles}>
              AI & skills
            </SettingsSectionTrigger>
            <AccordionContent className="divide-y divide-border/40">
              <TitleGenerationSettings />
              <SkillsSettingsItem />
            </AccordionContent>
          </AccordionItem>

          {hasNativeDesktopShell ? (
            <AccordionItem value="files-folders">
              <SettingsSectionTrigger icon={FolderOpen}>
                Files & folders
              </SettingsSectionTrigger>
              <AccordionContent className="divide-y divide-border/40">
                <OpenLogFolder />
                <OpenStatePluginFolder />
                <OpenSessionFilesFolder />
                <OpenHandoffsFolder />
              </AccordionContent>
            </AccordionItem>
          ) : null}

          <AccordionItem value="keyboard-shortcuts">
            <SettingsSectionTrigger icon={Keyboard}>
              Keyboard shortcuts
            </SettingsSectionTrigger>
            <AccordionContent>
              <KeyboardShortcutsSettings />
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <DialogFooter className="sm:justify-between" showCloseButton>
          <div className="flex items-center gap-2 self-center">
            <span className="text-xs text-muted-foreground">
              v{__APP_VERSION__}
            </span>
            {hasNativeDesktopShell ? <OpenDevToolsButton /> : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsSectionTrigger({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <AccordionTrigger className="py-3 hover:no-underline">
      <span className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        {children}
      </span>
    </AccordionTrigger>
  );
}

function KeyboardShortcutsSettings() {
  return (
    <div className="space-y-1.5">
      {SHORTCUT_DEFINITIONS.map((shortcut) => (
        <div key={shortcut.id} className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {shortcut.label}
          </span>
          <KbdGroup>
            <Kbd>&#8984;</Kbd>
            <Kbd>{shortcut.key}</Kbd>
          </KbdGroup>
        </div>
      ))}
    </div>
  );
}

function OpenFolderItem({
  label,
  description,
  isPending,
  onOpen,
}: {
  label: string;
  description: string;
  isPending: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={onOpen}
      >
        {isPending ? (
          <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
        ) : (
          <FolderOpen className="mr-1.5 size-3.5" />
        )}
        Open
      </Button>
    </div>
  );
}

function OpenLogFolder() {
  const { mutate, isPending } = useMutation(
    orpc.fs.openLogFolder.mutationOptions(),
  );
  return (
    <OpenFolderItem
      label="Log files"
      description="Open the folder containing application logs"
      isPending={isPending}
      onOpen={() => mutate(undefined)}
    />
  );
}

function OpenStatePluginFolder() {
  const { mutate, isPending } = useMutation(
    orpc.fs.openStatePluginFolder.mutationOptions(),
  );
  return (
    <OpenFolderItem
      label="State plugin"
      description="Open the managed Claude hook plugin folder"
      isPending={isPending}
      onOpen={() => mutate(undefined)}
    />
  );
}

function OpenSessionFilesFolder() {
  const { mutate, isPending } = useMutation(
    orpc.fs.openSessionFilesFolder.mutationOptions(),
  );
  return (
    <OpenFolderItem
      label="Session files"
      description="Open the folder containing session state files"
      isPending={isPending}
      onOpen={() => mutate(undefined)}
    />
  );
}

function OpenHandoffsFolder() {
  const { mutate, isPending } = useMutation(
    orpc.fs.openHandoffsFolder.mutationOptions(),
  );
  return (
    <OpenFolderItem
      label="Handoffs"
      description="Open the folder containing session handoff documents"
      isPending={isPending}
      onOpen={() => mutate(undefined)}
    />
  );
}

function OpenDevToolsButton() {
  const { mutate } = useMutation(orpc.fs.openDevTools.mutationOptions());
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs text-muted-foreground"
      onClick={() => mutate(undefined)}
    >
      <Bug className="mr-1 size-3" />
      DevTools
    </Button>
  );
}

const sleepBlockModeLabels: Record<SleepBlockMode, string> = {
  off: "Off",
  working: "While sessions run",
  always: "Always",
};

type SleepBlockMode = "off" | "working" | "always";

function SleepBlockModeSelect() {
  const sleepBlockMode = useAppState((s) => s.appSettings.sleepBlockMode);
  const { mutate } = useMutation(
    orpc.appSettings.setSleepBlockMode.mutationOptions(),
  );

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Prevent sleep</div>
        <div className="text-xs text-muted-foreground">
          Control when the app keeps the display awake
        </div>
      </div>
      <Select
        value={sleepBlockMode}
        onValueChange={(mode) => mutate({ mode: mode as SleepBlockMode })}
      >
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(sleepBlockModeLabels).map(([mode, label]) => (
            <SelectItem key={mode} value={mode}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DockBadgeForAttentionToggle() {
  const enabled = useAppState((s) => s.appSettings.dockBadgeForAttention);
  const { mutate } = useMutation(
    orpc.appSettings.setDockBadgeForAttention.mutationOptions(),
  );

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Dock badge for attention</div>
        <div className="text-xs text-muted-foreground">
          Show a count on the Dock icon when sessions need input or approval
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => mutate({ enabled: checked })}
      />
    </div>
  );
}

const machineStatsIntervalOptions = [15, 30, 60, 300] as const;

type MachineStatsIntervalSeconds = (typeof machineStatsIntervalOptions)[number];

function formatInterval(seconds: MachineStatsIntervalSeconds): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${seconds / 60}m`;
}

function MachineStatsSettings() {
  const settings = useAppState((s) => s.appSettings.machineStats);
  const { mutate } = useMutation(
    orpc.appSettings.setMachineStats.mutationOptions(),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Show sidebar status</div>
          <div className="text-xs text-muted-foreground">
            Display CPU, temperature, and memory usage in the sidebar
          </div>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(enabled) => mutate({ ...settings, enabled })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-sm font-medium">CPU and memory</Label>
          <Select
            value={`${settings.cpuMemoryPollIntervalSeconds}`}
            disabled={!settings.enabled}
            onValueChange={(value) =>
              mutate({
                ...settings,
                cpuMemoryPollIntervalSeconds: Number(
                  value,
                ) as MachineStatsIntervalSeconds,
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {machineStatsIntervalOptions.map((seconds) => (
                <SelectItem key={seconds} value={`${seconds}`}>
                  {formatInterval(seconds)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">Temperature</Label>
          <Select
            value={`${settings.temperaturePollIntervalSeconds}`}
            disabled={!settings.enabled}
            onValueChange={(value) =>
              mutate({
                ...settings,
                temperaturePollIntervalSeconds: Number(
                  value,
                ) as MachineStatsIntervalSeconds,
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {machineStatsIntervalOptions.map((seconds) => (
                <SelectItem key={seconds} value={`${seconds}`}>
                  {formatInterval(seconds)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

const titleGenerationProviderLabels: Record<
  (typeof titleGenerationProviders)[number],
  string
> = {
  cursor: "Cursor",
};

function TitleGenerationSettings() {
  const titleGeneration = useAppState((s) => s.appSettings.titleGeneration);
  const lastSessionOptions = useAppState(
    (s) => s.appSettings.lastSessionOptions,
  );
  const setTitleGeneration = useMutation(
    orpc.appSettings.setTitleGeneration.mutationOptions(),
  );
  const setLastSessionOptions = useMutation(
    orpc.appSettings.setLastSessionOptions.mutationOptions(),
  );
  const recentCursorModels = lastSessionOptions.cursor?.recentModels ?? [];

  return (
    <div className="space-y-3 py-2.5">
      <div className="space-y-2">
        <Label className="text-sm font-medium">LLM provider</Label>
        <Select
          value={titleGeneration.provider}
          onValueChange={(value) => {
            setTitleGeneration.mutate({
              provider: value as typeof titleGeneration.provider,
              model: titleGeneration.model,
            });
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {titleGenerationProviders.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {titleGenerationProviderLabels[provider]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used to autogenerate session titles and commit messages.
        </p>
      </div>
      <div className="space-y-2">
        <Label className="text-sm font-medium">Model</Label>
        <CursorModelPicker
          value={titleGeneration.model}
          recentModels={recentCursorModels}
          includeAuto
          onChange={(model) => {
            setTitleGeneration.mutate({
              provider: titleGeneration.provider,
              model,
            });
            setLastSessionOptions.mutate({
              ...lastSessionOptions,
              cursor: {
                ...lastSessionOptions.cursor,
                permissionMode:
                  lastSessionOptions.cursor?.permissionMode ?? "default",
                recentModels: addRecentCursorModel(recentCursorModels, model),
              },
            });
          }}
        />
      </div>
    </div>
  );
}

function DockBounceOnAttentionToggle() {
  const enabled = useAppState((s) => s.appSettings.dockBounceOnAttention);
  const { mutate } = useMutation(
    orpc.appSettings.setDockBounceOnAttention.mutationOptions(),
  );

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Dock bounce on attention</div>
        <div className="text-xs text-muted-foreground">
          After 2 seconds, bounce the Dock if the session still needs input and
          the app is not focused
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => mutate({ enabled: checked })}
      />
    </div>
  );
}
