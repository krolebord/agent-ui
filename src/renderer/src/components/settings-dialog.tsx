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
import { SHORTCUT_DEFINITIONS } from "@renderer/hooks/use-app-shortcuts";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { FolderOpen, Keyboard, LoaderCircle } from "lucide-react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

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

        <div className="space-y-4">
          <OpenLogFolder />
          <OpenStatePluginFolder />
          <OpenSessionFilesFolder />

          <div className="rounded-lg border border-white/10 px-4 py-3">
            <div className="mb-3 flex items-center gap-2">
              <Keyboard className="size-4 text-muted-foreground" />
              <div className="text-sm font-medium">Keyboard shortcuts</div>
            </div>
            <div className="space-y-2">
              {SHORTCUT_DEFINITIONS.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="flex items-center justify-between"
                >
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
          </div>
        </div>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
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
    <div className="flex items-center justify-between rounded-lg border border-white/10 px-4 py-3">
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
