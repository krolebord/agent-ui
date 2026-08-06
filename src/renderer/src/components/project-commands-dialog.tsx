import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
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
import { Textarea } from "@renderer/components/ui/textarea";
import { orpc } from "@renderer/orpc-client";
import { getProjectDisplayName } from "@renderer/services/terminal-session-selectors";
import {
  formatCommandEnv,
  PROJECT_COMMANDS_LIMIT,
  type ProjectCommandWrite,
  parseCommandEnv,
  type ResolvedProjectCommand,
} from "@shared/project-commands";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useProjectCommandsDialogStore = create(
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

/** Editor row state. `sourceIndex` is absent for commands added in the dialog. */
interface CommandDraft {
  key: string;
  sourceIndex?: number;
  explicitId?: string;
  name: string;
  run: string;
  cwd: string;
  env: string;
  singleton: boolean;
}

function toDraft(command: ResolvedProjectCommand): CommandDraft {
  return {
    key: `${command.sourceIndex}:${command.id}`,
    sourceIndex: command.sourceIndex,
    explicitId: command.explicitId,
    name: command.name,
    run: command.run,
    cwd: command.cwd ?? "",
    env: formatCommandEnv(command.env),
    singleton: command.singleton ?? false,
  };
}

function toWrite(draft: CommandDraft): ProjectCommandWrite {
  return {
    // Only round-trip an id the file spells out, so derived ids don't leak
    // into the repository on save.
    id: draft.explicitId,
    name: draft.name.trim(),
    run: draft.run.trim(),
    cwd: draft.cwd.trim() || undefined,
    env: parseCommandEnv(draft.env),
    singleton: draft.singleton || undefined,
    sourceIndex: draft.sourceIndex,
  };
}

function CommandDraftFields({
  draft,
  onChange,
  onRemove,
}: {
  draft: CommandDraft;
  onChange: (next: CommandDraft) => void;
  onRemove: () => void;
}) {
  const fieldId = useId();

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-black/15 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`${fieldId}-name`} className="text-xs">
            Name
          </Label>
          <Input
            id={`${fieldId}-name`}
            value={draft.name}
            placeholder="Dev server"
            onChange={(event) => {
              onChange({ ...draft, name: event.target.value });
            }}
          />
        </div>
        <Button
          type="button"
          variant="flat"
          className="mt-5 size-9 shrink-0 px-0 text-muted-foreground hover:text-rose-300"
          onClick={onRemove}
          aria-label={`Remove ${draft.name || "command"}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${fieldId}-run`} className="text-xs">
          Command
        </Label>
        <Textarea
          id={`${fieldId}-run`}
          value={draft.run}
          placeholder="ssh vps -t 'cd /srv/app && just dev'"
          rows={2}
          onChange={(event) => {
            onChange({ ...draft, run: event.target.value });
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-cwd`} className="text-xs">
            Working directory
          </Label>
          <Input
            id={`${fieldId}-cwd`}
            value={draft.cwd}
            placeholder="Project root"
            onChange={(event) => {
              onChange({ ...draft, cwd: event.target.value });
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-env`} className="text-xs">
            Environment
          </Label>
          <Textarea
            id={`${fieldId}-env`}
            value={draft.env}
            placeholder="PORT=3000"
            rows={1}
            onChange={(event) => {
              onChange({ ...draft, env: event.target.value });
            }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={`${fieldId}-singleton`}
          checked={draft.singleton}
          onCheckedChange={(checked) => {
            onChange({ ...draft, singleton: checked === true });
          }}
        />
        <Label
          htmlFor={`${fieldId}-singleton`}
          className="text-xs font-normal text-muted-foreground"
        >
          Reuse one terminal instead of opening a new one each time
        </Label>
      </div>
    </div>
  );
}

export function ProjectCommandsDialog() {
  const openProjectCwd = useProjectCommandsDialogStore((s) => s.openProjectCwd);
  const setOpenProjectCwd = useProjectCommandsDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const queryClient = useQueryClient();

  const project = useAppState((state) => {
    if (!openProjectCwd) {
      return null;
    }
    return state.projects.find((item) => item.path === openProjectCwd) ?? null;
  });

  const commandsQuery = useQuery({
    ...orpc.projects.listCommands.queryOptions({
      input: { path: openProjectCwd ?? "" },
    }),
    enabled: Boolean(openProjectCwd),
    staleTime: 0,
  });

  const [drafts, setDrafts] = useState<CommandDraft[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const loadedCommands = commandsQuery.data?.commands;
  const scriptCount = commandsQuery.data?.scripts.length ?? 0;

  useEffect(() => {
    if (!loadedCommands) {
      return;
    }
    setDrafts(loadedCommands.map(toDraft));
    setValidationError(null);
  }, [loadedCommands]);

  useEffect(() => {
    if (openProjectCwd && project?.interactionDisabled) {
      setOpenProjectCwd(null);
    }
  }, [openProjectCwd, project?.interactionDisabled, setOpenProjectCwd]);

  const saveMutation = useMutation(
    orpc.projects.setCommands.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: orpc.projects.listCommands.key(),
        });
        setOpenProjectCwd(null);
      },
    }),
  );

  if (!openProjectCwd || !project) {
    return null;
  }

  const projectPath = project.path;
  const projectName = getProjectDisplayName(project);
  const isBusy = saveMutation.isPending;

  const closeDialog = () => {
    if (isBusy) {
      return;
    }
    setOpenProjectCwd(null);
  };

  const handleSave = () => {
    const incomplete = drafts.find(
      (draft) => !draft.name.trim() || !draft.run.trim(),
    );
    if (incomplete) {
      setValidationError("Every command needs a name and a command to run.");
      return;
    }
    setValidationError(null);
    saveMutation.mutate({
      path: projectPath,
      commands: drafts.map(toWrite),
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
      <DialogContent showCloseButton={false} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Project commands</DialogTitle>
          <DialogDescription>
            Presets you can launch as terminals in{" "}
            <span className="text-foreground">{projectName}</span>. They never
            run on their own.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {commandsQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : drafts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-sm text-muted-foreground">
              No commands yet. Add the ones you never remember.
            </p>
          ) : (
            drafts.map((draft, index) => (
              <CommandDraftFields
                key={draft.key}
                draft={draft}
                onChange={(next) => {
                  setDrafts((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? next : item,
                    ),
                  );
                }}
                onRemove={() => {
                  setDrafts((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  );
                }}
              />
            ))
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={isBusy || drafts.length >= PROJECT_COMMANDS_LIMIT}
          onClick={() => {
            setDrafts((current) => [
              ...current,
              {
                key: `new-${Date.now()}-${current.length}`,
                name: "",
                run: "",
                cwd: "",
                env: "",
                singleton: false,
              },
            ]);
          }}
        >
          <Plus className="size-4" />
          Add command
        </Button>

        {scriptCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            The commands menu also lists {scriptCount}{" "}
            {scriptCount === 1 ? "script" : "scripts"} found in{" "}
            <code>package.json</code>. They are not editable here — set{" "}
            <code>"discoverCommands": false</code> in the settings file to hide
            them.
          </p>
        ) : null}

        {validationError || saveMutation.error || commandsQuery.error ? (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            <AlertCircle className="size-4 shrink-0" />
            <span>
              {validationError ??
                saveMutation.error?.message ??
                commandsQuery.error?.message}
            </span>
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Saved to <code>.agent-ui/settings.jsonc</code>, which is usually
            committed and shared with the project.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={isBusy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={isBusy}>
              {isBusy ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
