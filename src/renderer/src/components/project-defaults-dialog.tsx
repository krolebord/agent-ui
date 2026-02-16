import { EffortToggleGroup } from "@renderer/components/effort-toggle-group";
import { PermissionModeToggleGroup } from "@renderer/components/permission-mode-toggle-group";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Label } from "@renderer/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import {
  MODEL_OPTIONS,
  getProjectNameFromPath,
} from "@renderer/services/terminal-session-selectors";
import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import type {
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
} from "@shared/claude-types";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useProjectDefaultsDialogStore = create(
  combine(
    {
      openProjectCwd: null as string | null,
    },
    (set) => ({
      setOpenProjectCwd: (openProjectCwd: string | null) => {
        set({ openProjectCwd });
      },
    }),
  ),
);

export function ProjectDefaultsDialog() {
  const openProjectCwd = useProjectDefaultsDialogStore((s) => s.openProjectCwd);
  const setOpenProjectCwd = useProjectDefaultsDialogStore(
    (s) => s.setOpenProjectCwd,
  );

  const project = useAppState((state) => {
    if (!openProjectCwd) {
      return null;
    }
    return state.projects.find((item) => item.path === openProjectCwd) ?? null;
  });

  const [defaultModel, setDefaultModel] = useState<ClaudeModel>("opus");
  const [defaultEffort, setDefaultEffort] = useState<ClaudeEffort | undefined>(
    undefined,
  );
  const [defaultPermissionMode, setDefaultPermissionMode] =
    useState<ClaudePermissionMode>("default");
  const [defaultHaikuModelOverride, setDefaultHaikuModelOverride] = useState<
    ClaudeModel | undefined
  >(undefined);
  const [defaultSubagentModelOverride, setDefaultSubagentModelOverride] =
    useState<ClaudeModel | undefined>(undefined);

  const saveMutation = useMutation(
    orpc.projects.setProjectDefaults.mutationOptions({
      onSuccess: () => {
        setOpenProjectCwd(null);
      },
    }),
  );

  useEffect(() => {
    if (!project) {
      return;
    }
    setDefaultModel(project.defaultModel ?? "opus");
    setDefaultEffort(project.defaultEffort);
    setDefaultPermissionMode(project.defaultPermissionMode ?? "default");
    setDefaultHaikuModelOverride(project.defaultHaikuModelOverride);
    setDefaultSubagentModelOverride(project.defaultSubagentModelOverride);
  }, [project]);

  if (!openProjectCwd || !project) {
    return null;
  }

  const projectPath = project.path;
  const projectName = getProjectNameFromPath(projectPath);
  const effectivePermissionMode = defaultPermissionMode ?? "default";

  const closeDialog = () => {
    if (saveMutation.isPending) {
      return;
    }
    setOpenProjectCwd(null);
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Project defaults</DialogTitle>
          <DialogDescription>
            Set default session options for{" "}
            <span className="text-foreground">{projectName}</span>
            <br />
            <span className="text-xs text-muted-foreground">{projectPath}</span>
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate({
              path: projectPath,
              defaultModel,
              defaultEffort,
              defaultPermissionMode,
              defaultHaikuModelOverride,
              defaultSubagentModelOverride,
            });
          }}
        >
          <div className="space-y-2">
            <Label>Default model</Label>
            <Select
              value={defaultModel}
              onValueChange={(value) => {
                setDefaultModel(value as ClaudeModel);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <PermissionModeToggleGroup
            label="Default permission mode"
            permissionMode={effectivePermissionMode}
            onPermissionModeChange={(value) => {
              setDefaultPermissionMode(value);
            }}
          />

          <EffortToggleGroup
            label="Default effort"
            effort={defaultEffort}
            onEffortChange={setDefaultEffort}
          />

          <div className="space-y-2">
            <Label>Override haiku model</Label>
            <Select
              value={defaultHaikuModelOverride ?? "no"}
              onValueChange={(value) => {
                setDefaultHaikuModelOverride(
                  value === "no" ? undefined : (value as ClaudeModel),
                );
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">Default</SelectItem>
                {MODEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Override subagent model</Label>
            <Select
              value={defaultSubagentModelOverride ?? "no"}
              onValueChange={(value) => {
                setDefaultSubagentModelOverride(
                  value === "no" ? undefined : (value as ClaudeModel),
                );
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">Default</SelectItem>
                {MODEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {saveMutation.error ? (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              <AlertCircle className="size-4 shrink-0" />
              <span>{saveMutation.error.message}</span>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
