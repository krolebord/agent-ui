import {
  CodexPermissionModeToggleGroup,
  PermissionModeToggleGroup,
} from "@renderer/components/permission-mode-toggle-group";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import { orpc } from "@renderer/orpc-client";
import {
  getProjectDisplayName,
  MODEL_OPTIONS,
} from "@renderer/services/terminal-session-selectors";
import type {
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
  CursorAgentMode,
  CursorAgentPermissionMode,
} from "@shared/claude-types";
import type {
  CodexModelReasoningEffort,
  CodexPermissionMode,
} from "@shared/codex-types";
import { cursorModels } from "@shared/cursor-models";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
} from "./session-type-icons";

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

const CODEX_MODEL_REASONING_EFFORT_OPTIONS: {
  value: CodexModelReasoningEffort;
  label: string;
}[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

const CLAUDE_EFFORT_OPTIONS: { value: ClaudeEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const CURSOR_AGENT_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
  { value: "ask", label: "Ask" },
];

type ProjectDefaultsTab = "claude" | "codex" | "cursor";

const PROJECT_DEFAULTS_TAB_OPTIONS: {
  value: ProjectDefaultsTab;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { value: "claude", label: "Claude", icon: ClaudeCodeIcon },
  { value: "codex", label: "Codex", icon: CodexIcon },
  { value: "cursor", label: "Cursor", icon: CursorAgentIcon },
];

const CURSOR_AUTO_MODEL_VALUE = "auto";

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

  const [claudeDefaultModel, setClaudeDefaultModel] =
    useState<ClaudeModel>("opus");
  const [claudeDefaultEffort, setClaudeDefaultEffort] = useState<
    ClaudeEffort | undefined
  >(undefined);
  const [claudeDefaultPermissionMode, setClaudeDefaultPermissionMode] =
    useState<ClaudePermissionMode>("default");
  const [claudeDefaultHaikuModelOverride, setClaudeDefaultHaikuModelOverride] =
    useState<ClaudeModel | undefined>(undefined);
  const [
    claudeDefaultSubagentModelOverride,
    setClaudeDefaultSubagentModelOverride,
  ] = useState<ClaudeModel | undefined>(undefined);
  const [claudeDefaultSystemPrompt, setClaudeDefaultSystemPrompt] =
    useState<string>("");
  const [codexModel, setCodexModel] = useState("");
  const [codexPermissionMode, setCodexPermissionMode] =
    useState<CodexPermissionMode>("default");
  const [codexModelReasoningEffort, setCodexModelReasoningEffort] =
    useState<CodexModelReasoningEffort>("high");
  const [codexConfigOverrides, setCodexConfigOverrides] = useState("");
  const [cursorModel, setCursorModel] = useState("");
  const [cursorMode, setCursorMode] = useState<CursorAgentMode | undefined>(
    undefined,
  );
  const [cursorPermissionMode, setCursorPermissionMode] =
    useState<CursorAgentPermissionMode>("default");
  const [activeTab, setActiveTab] = useState<ProjectDefaultsTab>("claude");

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
    setClaudeDefaultModel(project.localClaude?.defaultModel ?? "opus");
    setClaudeDefaultEffort(project.localClaude?.defaultEffort);
    setClaudeDefaultPermissionMode(
      project.localClaude?.defaultPermissionMode ?? "default",
    );
    setClaudeDefaultHaikuModelOverride(
      project.localClaude?.defaultHaikuModelOverride,
    );
    setClaudeDefaultSubagentModelOverride(
      project.localClaude?.defaultSubagentModelOverride,
    );
    setClaudeDefaultSystemPrompt(
      project.localClaude?.defaultSystemPrompt ?? "",
    );
    setCodexModel(project.localCodex?.model ?? "");
    setCodexPermissionMode(project.localCodex?.permissionMode ?? "default");
    setCodexModelReasoningEffort(
      project.localCodex?.modelReasoningEffort ?? "high",
    );
    setCodexConfigOverrides(project.localCodex?.configOverrides ?? "");
    setCursorModel(project.localCursor?.model ?? "");
    setCursorMode(project.localCursor?.mode);
    setCursorPermissionMode(project.localCursor?.permissionMode ?? "default");
  }, [project]);

  if (!openProjectCwd || !project) {
    return null;
  }

  const projectPath = project.path;
  const projectName = getProjectDisplayName(project);
  const effectiveClaudePermissionMode =
    claudeDefaultPermissionMode ?? "default";
  const hasCursorModelOption = cursorModels.some(
    (option) => option.value === cursorModel,
  );
  const cursorModelSelectValue =
    cursorModel && hasCursorModelOption ? cursorModel : CURSOR_AUTO_MODEL_VALUE;

  const closeDialog = () => {
    if (saveMutation.isPending) {
      return;
    }
    setActiveTab("claude");
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
              localClaude: {
                defaultModel: claudeDefaultModel,
                defaultEffort: claudeDefaultEffort,
                defaultPermissionMode: claudeDefaultPermissionMode,
                defaultHaikuModelOverride: claudeDefaultHaikuModelOverride,
                defaultSubagentModelOverride:
                  claudeDefaultSubagentModelOverride,
                defaultSystemPrompt: claudeDefaultSystemPrompt || undefined,
              },
              localCodex: {
                model: codexModel || undefined,
                permissionMode: codexPermissionMode,
                modelReasoningEffort: codexModelReasoningEffort,
                configOverrides: codexConfigOverrides || undefined,
              },
              localCursor: {
                model: cursorModel || undefined,
                mode: cursorMode,
                permissionMode: cursorPermissionMode,
              },
            });
          }}
        >
          <ToggleGroup
            type="single"
            variant="outline"
            value={activeTab}
            onValueChange={(value) => {
              if (value) {
                setActiveTab(value as ProjectDefaultsTab);
              }
            }}
          >
            {PROJECT_DEFAULTS_TAB_OPTIONS.map((option) => {
              const isActive = activeTab === option.value;
              return (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  title={isActive ? undefined : option.label}
                  className="gap-1.5"
                >
                  <option.icon className="size-4 shrink-0" />
                  {isActive && (
                    <span className="animate-in fade-in slide-in-from-left-1 duration-150">
                      {option.label}
                    </span>
                  )}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>

          {activeTab === "claude" ? (
            <div key="claude-defaults-tab" className="space-y-4">
              <div className="text-sm font-medium">Claude defaults</div>

              <PermissionModeToggleGroup
                label="Default permission mode"
                permissionMode={effectiveClaudePermissionMode}
                onPermissionModeChange={(value) => {
                  setClaudeDefaultPermissionMode(value);
                }}
              />

              <div className="flex items-end gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label>Default model</Label>
                  <Select
                    value={claudeDefaultModel}
                    onValueChange={(value) => {
                      setClaudeDefaultModel(value as ClaudeModel);
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

                <div className="w-fit shrink-0 space-y-2">
                  <Label className="whitespace-nowrap">Default effort</Label>
                  <Select
                    value={claudeDefaultEffort ?? "no"}
                    onValueChange={(value) => {
                      setClaudeDefaultEffort(
                        value === "no" ? undefined : (value as ClaudeEffort),
                      );
                    }}
                  >
                    <SelectTrigger className="w-auto min-w-24 whitespace-nowrap">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="no" className="whitespace-nowrap">
                        Default
                      </SelectItem>
                      {CLAUDE_EFFORT_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          className="whitespace-nowrap"
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Override haiku model</Label>
                <Select
                  value={claudeDefaultHaikuModelOverride ?? "no"}
                  onValueChange={(value) => {
                    setClaudeDefaultHaikuModelOverride(
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
                  value={claudeDefaultSubagentModelOverride ?? "no"}
                  onValueChange={(value) => {
                    setClaudeDefaultSubagentModelOverride(
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
                <Label htmlFor="project-default-system-prompt">
                  System prompt (optional)
                </Label>
                <Textarea
                  id="project-default-system-prompt"
                  placeholder="Custom system prompt passed via --system-prompt"
                  value={claudeDefaultSystemPrompt}
                  onChange={(event) => {
                    setClaudeDefaultSystemPrompt(event.target.value);
                  }}
                  rows={3}
                />
              </div>
            </div>
          ) : activeTab === "codex" ? (
            <div key="codex-defaults-tab" className="space-y-4">
              <div className="text-sm font-medium">Codex defaults</div>

              <CodexPermissionModeToggleGroup
                label="Default permission mode"
                permissionMode={codexPermissionMode}
                onPermissionModeChange={setCodexPermissionMode}
              />

              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor="project-default-codex-model">
                    Model (optional)
                  </Label>
                  <Input
                    id="project-default-codex-model"
                    placeholder="gpt-5.3-codex"
                    value={codexModel}
                    onChange={(event) => {
                      setCodexModel(event.target.value);
                    }}
                  />
                </div>

                <div className="w-fit shrink-0 space-y-2">
                  <Label className="whitespace-nowrap">Effort</Label>
                  <Select
                    value={codexModelReasoningEffort}
                    onValueChange={(value) => {
                      setCodexModelReasoningEffort(
                        value as CodexModelReasoningEffort,
                      );
                    }}
                  >
                    <SelectTrigger className="w-auto min-w-24 whitespace-nowrap">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CODEX_MODEL_REASONING_EFFORT_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          className="whitespace-nowrap"
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-default-codex-config-overrides">
                  Config overrides (optional)
                </Label>
                <Textarea
                  id="project-default-codex-config-overrides"
                  placeholder="Each line becomes a separate --config argument"
                  value={codexConfigOverrides}
                  onChange={(event) => {
                    setCodexConfigOverrides(event.target.value);
                  }}
                  rows={3}
                />
              </div>
            </div>
          ) : (
            <div key="cursor-defaults-tab" className="space-y-4">
              <div className="text-sm font-medium">Cursor defaults</div>

              <div className="space-y-2">
                <Label>Default permission mode</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={cursorPermissionMode}
                  onValueChange={(value) => {
                    if (value) {
                      setCursorPermissionMode(
                        value as CursorAgentPermissionMode,
                      );
                    }
                  }}
                  className="w-full"
                >
                  <ToggleGroupItem value="default" className="flex-1">
                    Default
                  </ToggleGroupItem>
                  <ToggleGroupItem value="yolo" className="flex-1">
                    YOLO
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label>Default model</Label>
                  <Select
                    value={cursorModelSelectValue}
                    onValueChange={(value) => {
                      setCursorModel(
                        value === CURSOR_AUTO_MODEL_VALUE ? "" : value,
                      );
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {cursorModel &&
                      !hasCursorModelOption &&
                      cursorModel !== CURSOR_AUTO_MODEL_VALUE ? (
                        <SelectItem value={cursorModel}>
                          {`Custom (${cursorModel})`}
                        </SelectItem>
                      ) : null}
                      {cursorModels.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="w-fit shrink-0 space-y-2">
                  <Label className="whitespace-nowrap">Default mode</Label>
                  <Select
                    value={cursorMode ?? "default"}
                    onValueChange={(value) => {
                      setCursorMode(
                        value === "default"
                          ? undefined
                          : (value as CursorAgentMode),
                      );
                    }}
                  >
                    <SelectTrigger className="w-auto min-w-24 whitespace-nowrap">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURSOR_AGENT_MODE_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          className="whitespace-nowrap"
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

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
