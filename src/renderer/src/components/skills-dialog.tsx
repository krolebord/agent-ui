import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Badge } from "@renderer/components/ui/badge";
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
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { SKILL_NAME_PATTERN, type SkillEntry } from "@shared/skills";
import { useMutation } from "@tanstack/react-query";
import {
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";

type EditorTarget = { mode: "create" } | { mode: "edit"; entry: SkillEntry };

export const useSkillsDialogStore = create(
  combine({ isOpen: false }, (set) => ({
    open: () => {
      set({ isOpen: true });
    },
    close: () => {
      set({ isOpen: false });
    },
  })),
);

const GLOBAL_SCOPE = "global" as const;

function scopeKey(entry: SkillEntry): string {
  return entry.scope.type === "global" ? GLOBAL_SCOPE : entry.scope.projectPath;
}

function projectLabel(projectPath: string, alias?: string): string {
  if (alias?.trim()) return alias.trim();
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

interface SkillGroup {
  key: string;
  label: string;
  entries: SkillEntry[];
}

export function SkillsDialog() {
  const { isOpen, close } = useSkillsDialogStore();
  const skills = useAppState((state) => state.skills);
  const projects = useAppState((state) => state.projects);

  const projectLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const project of projects) {
      labels.set(project.path, projectLabel(project.path, project.alias));
    }
    return labels;
  }, [projects]);

  const groups = useMemo<SkillGroup[]>(() => {
    const byScope = new Map<string, SkillEntry[]>();
    for (const entry of Object.values(skills)) {
      const key = scopeKey(entry);
      const list = byScope.get(key) ?? [];
      list.push(entry);
      byScope.set(key, list);
    }
    const result: SkillGroup[] = [];
    for (const [key, entries] of byScope) {
      entries.sort((left, right) => left.name.localeCompare(right.name));
      result.push({
        key,
        label:
          key === GLOBAL_SCOPE
            ? "Global"
            : (projectLabels.get(key) ?? projectLabel(key)),
        entries,
      });
    }
    result.sort((left, right) => {
      if (left.key === GLOBAL_SCOPE) return -1;
      if (right.key === GLOBAL_SCOPE) return 1;
      return left.label.localeCompare(right.label);
    });
    return result;
  }, [skills, projectLabels]);

  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);

  const rescanMutation = useMutation(orpc.skills.rescan.mutationOptions());
  const { mutate: rescan } = rescanMutation;

  // Skills state is pulled, not watched: refresh when the dialog opens and
  // when the app regains focus (rescans are throttled in the main process).
  useEffect(() => {
    if (!isOpen) {
      setEditorTarget(null);
      return;
    }
    rescan(undefined);
  }, [isOpen, rescan]);

  useEffect(() => {
    let wasBlurred = false;
    const handleBlur = () => {
      wasBlurred = true;
    };
    const handleFocus = () => {
      if (!wasBlurred) return;
      wasBlurred = false;
      rescan(undefined);
    };
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, [rescan]);

  const deleteMutation = useMutation(
    orpc.skills.delete.mutationOptions({
      onSuccess: () => {
        toast.success("Skill deleted");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to delete skill");
      },
    }),
  );

  const openFolderMutation = useMutation(
    orpc.fs.openFolder.mutationOptions({
      onError: (error) => {
        toast.error(error.message || "Failed to open folder");
      },
    }),
  );

  const handleDelete = (entry: SkillEntry) => {
    useConfirmDialogStore.getState().confirm({
      title: "Delete skill",
      description: `Delete "${entry.name}"? This removes ${entry.dirPath} and cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteMutation.mutateAsync({ dirPath: entry.dirPath });
        if (
          editorTarget?.mode === "edit" &&
          editorTarget.entry.dirPath === entry.dirPath
        ) {
          setEditorTarget(null);
        }
      },
    });
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Reusable agent skills stored in <code>.agents/skills</code> and
            linked into <code>.claude/skills</code>. Changes apply to newly
            started sessions.
          </DialogDescription>
        </DialogHeader>

        {editorTarget ? (
          <SkillEditor
            target={editorTarget}
            onDone={() => {
              setEditorTarget(null);
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="size-8 px-0"
                aria-label="Refresh skills"
                title="Refresh skills"
                disabled={rescanMutation.isPending}
                onClick={() => {
                  rescan(undefined);
                }}
              >
                <RefreshCw
                  className={cn(
                    "size-3.5",
                    rescanMutation.isPending && "animate-spin",
                  )}
                />
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditorTarget({ mode: "create" });
                }}
              >
                <Plus className="mr-1.5 size-3.5" />
                Add skill
              </Button>
            </div>
            <div className="max-h-[min(460px,55vh)] overflow-y-auto rounded-md border border-border/60">
              {groups.length === 0 ? (
                <div className="text-muted-foreground p-6 text-center text-sm">
                  No skills yet.
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.key}>
                    <div className="bg-muted/50 text-muted-foreground sticky top-0 px-3 py-1.5 text-xs font-medium">
                      {group.label}
                    </div>
                    <ul className="divide-y divide-border/40">
                      {group.entries.map((entry) => (
                        <li
                          key={entry.dirPath}
                          className="flex items-start gap-2 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">
                                {entry.name}
                              </span>
                              {entry.managedBy === "builtin" ? (
                                <Badge variant="secondary">Built-in</Badge>
                              ) : null}
                              {entry.userInvokeOnly ? (
                                <Badge variant="outline">Manual</Badge>
                              ) : null}
                              {entry.hasExtraFiles ? (
                                <Badge variant="outline">Files</Badge>
                              ) : null}
                            </div>
                            {entry.description ? (
                              <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                                {entry.description}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="size-8 px-0"
                              aria-label={`Open folder for ${entry.name}`}
                              title="Open skill folder"
                              onClick={() => {
                                openFolderMutation.mutate({
                                  path: entry.dirPath,
                                });
                              }}
                            >
                              <FolderOpen className="size-3.5" />
                            </Button>
                            {entry.managedBy !== "builtin" ? (
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="size-8 px-0"
                                  aria-label={`Edit ${entry.name}`}
                                  onClick={() => {
                                    setEditorTarget({ mode: "edit", entry });
                                  }}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="size-8 px-0 text-destructive hover:text-destructive"
                                  aria-label={`Delete ${entry.name}`}
                                  disabled={deleteMutation.isPending}
                                  onClick={() => {
                                    handleDelete(entry);
                                  }}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SkillEditor({
  target,
  onDone,
}: {
  target: EditorTarget;
  onDone: () => void;
}) {
  const projects = useAppState((state) => state.projects);

  const [scope, setScope] = useState<string>(() =>
    target.mode === "edit" ? scopeKey(target.entry) : GLOBAL_SCOPE,
  );
  const [name, setName] = useState(
    target.mode === "edit" ? target.entry.name : "",
  );
  const [description, setDescription] = useState(
    target.mode === "edit" ? target.entry.description : "",
  );
  const [body, setBody] = useState(
    target.mode === "edit" ? target.entry.body : "",
  );
  const [userInvokeOnly, setUserInvokeOnly] = useState(
    target.mode === "edit" ? target.entry.userInvokeOnly : false,
  );
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation(
    orpc.skills.create.mutationOptions({
      onSuccess: () => {
        toast.success("Skill created");
        onDone();
      },
      onError: (err) => {
        toast.error(err.message || "Failed to create skill");
      },
    }),
  );

  const updateMutation = useMutation(
    orpc.skills.update.mutationOptions({
      onSuccess: () => {
        toast.success("Skill updated");
        onDone();
      },
      onError: (err) => {
        toast.error(err.message || "Failed to update skill");
      },
    }),
  );

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const handleSave = () => {
    const nextDescription = description.trim();
    if (!nextDescription) {
      setError(
        "Description is required — it's how agents decide to use the skill",
      );
      return;
    }

    if (target.mode === "edit") {
      updateMutation.mutate({
        dirPath: target.entry.dirPath,
        description: nextDescription,
        body,
        userInvokeOnly,
      });
      return;
    }

    const nextName = name.trim();
    if (!SKILL_NAME_PATTERN.test(nextName)) {
      setError(
        "Name must use lowercase letters, numbers, hyphens or underscores",
      );
      return;
    }
    createMutation.mutate({
      scope:
        scope === GLOBAL_SCOPE
          ? { type: "global" }
          : { type: "project", projectPath: scope },
      name: nextName,
      description: nextDescription,
      body,
      userInvokeOnly,
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSave();
      }}
    >
      {target.mode === "create" ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="my-skill"
              autoFocus={shouldAutoFocus()}
              maxLength={64}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-scope">Scope</Label>
            <Select value={scope} onValueChange={setScope} disabled={isSaving}>
              <SelectTrigger id="skill-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL_SCOPE}>Global</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.path} value={project.path}>
                    {projectLabel(project.path, project.alias)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground text-xs">
          Editing <span className="font-medium">{target.entry.name}</span> at{" "}
          {target.entry.dirPath}
          {target.entry.hasExtraFiles
            ? " — this skill has extra files (scripts, references, ...), which are left untouched."
            : ""}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="skill-description">Description</Label>
        <Input
          id="skill-description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            setError(null);
          }}
          placeholder="What it does and when agents should use it"
          disabled={isSaving}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="skill-body">Instructions</Label>
        <Textarea
          id="skill-body"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          rows={10}
          className="font-mono text-xs"
          disabled={isSaving}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="skill-user-invoke-only">User invoke only</Label>
          <p className="text-muted-foreground text-xs">
            Agents won't trigger this skill on their own — only /
            {name || "skill"}
          </p>
        </div>
        <Switch
          id="skill-user-invoke-only"
          checked={userInvokeOnly}
          onCheckedChange={setUserInvokeOnly}
          disabled={isSaving}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <DialogFooter className="gap-2 sm:justify-between">
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={onDone}
        >
          Back
        </Button>
        <Button type="submit" disabled={isSaving}>
          {target.mode === "edit" ? "Save changes" : "Create skill"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function SkillsSettingsItem() {
  const openDialog = useSkillsDialogStore((state) => state.open);
  const skillCount = useAppState((state) => Object.keys(state.skills).length);

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Skills</div>
        <div className="text-xs text-muted-foreground">
          {skillCount === 0
            ? "No skills yet"
            : `${skillCount} skill${skillCount === 1 ? "" : "s"}`}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={openDialog}>
        Manage
      </Button>
    </div>
  );
}

export function SidebarSkillsButton() {
  const openDialog = useSkillsDialogStore((state) => state.open);
  return (
    <Button
      type="button"
      variant="flat"
      className="h-full w-9 shrink-0 px-0"
      aria-label="Skills"
      title="Skills"
      onClick={openDialog}
    >
      <Sparkles className="size-3.5" />
    </Button>
  );
}
