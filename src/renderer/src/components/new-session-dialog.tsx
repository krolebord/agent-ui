import { PermissionModeToggleGroup } from "@renderer/components/permission-mode-toggle-group";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { orpc } from "@renderer/orpc-client";
import {
  MODEL_OPTIONS,
  getProjectNameFromPath,
} from "@renderer/services/terminal-session-selectors";
import type { ClaudeModel, ClaudePermissionMode } from "@shared/claude-types";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useNewSessionDialogStore = create(
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

export function NewSessionDialog() {
  const openProjectCwd = useNewSessionDialogStore((s) => s.openProjectCwd);
  const setOpenProjectCwd = useNewSessionDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const project = useAppState((state) => {
    if (!openProjectCwd) {
      return null;
    }
    return state.projects.find((item) => item.path === openProjectCwd) ?? null;
  });

  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);

  const [initialPrompt, setInitialPrompt] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [model, setModel] = useState<ClaudeModel>("opus");
  const [permissionMode, setPermissionMode] =
    useState<ClaudePermissionMode>("default");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ensureProject = useMutation(orpc.projects.addProject.mutationOptions());
  const startSession = useMutation(
    orpc.sessions.startSession.mutationOptions(),
  );

  useEffect(() => {
    if (!openProjectCwd) {
      return;
    }

    setInitialPrompt("");
    setSessionName("");
    setModel(project?.defaultModel ?? "opus");
    setPermissionMode(project?.defaultPermissionMode ?? "default");
    setErrorMessage(null);
  }, [openProjectCwd, project]);

  if (!openProjectCwd) {
    return null;
  }

  const projectPath = project?.path ?? openProjectCwd;
  const projectName = getProjectNameFromPath(projectPath);

  const isPending = ensureProject.isPending || startSession.isPending;

  const closeDialog = () => {
    if (isPending) {
      return;
    }
    setErrorMessage(null);
    setOpenProjectCwd(null);
  };

  const handleSubmit = () => {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    setErrorMessage(null);

    void ensureProject
      .mutateAsync({ path: normalizedProjectPath })
      .then(async () => {
        const sessionId = await startSession.mutateAsync({
          cwd: normalizedProjectPath,
          cols: 80,
          rows: 24,
          initialPrompt: initialPrompt || undefined,
          sessionName: sessionName || undefined,
          model,
          permissionMode,
        });

        setActiveSessionId(sessionId);
        closeDialog();
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.trim()) {
          setErrorMessage(error.message);
          return;
        }
        setErrorMessage("Failed to start session.");
      });
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
          <DialogTitle>Start new session</DialogTitle>
          <DialogDescription>
            Project: <span className="text-foreground">{projectName}</span>
            <br />
            <span className="text-xs text-muted-foreground">{projectPath}</span>
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-session-initial-prompt">
              Initial prompt (optional)
            </Label>
            <Textarea
              id="new-session-initial-prompt"
              autoFocus
              placeholder="What would you like Claude to do?"
              value={initialPrompt}
              onChange={(event) => {
                setInitialPrompt(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSubmit();
                }
              }}
              rows={3}
            />
          </div>

          <PermissionModeToggleGroup
            label="Permission mode"
            permissionMode={permissionMode}
            onPermissionModeChange={(value) => {
              setPermissionMode(value);
            }}
          />

          <div className="space-y-2">
            <Label htmlFor="new-session-name">Session name (optional)</Label>
            <Input
              id="new-session-name"
              placeholder="Leave blank for generated name"
              value={sessionName}
              onChange={(event) => {
                setSessionName(event.target.value);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>Model</Label>
            <Select
              value={model}
              onValueChange={(value) => {
                setModel(value as ClaudeModel);
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

          {errorMessage ? (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Starting..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
