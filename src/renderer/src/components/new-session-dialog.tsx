import {
  CodexPermissionModeToggleGroup,
  PermissionModeToggleGroup,
} from "@renderer/components/permission-mode-toggle-group";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Kbd } from "@renderer/components/ui/kbd";
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
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { orpc } from "@renderer/orpc-client";
import {
  getProjectDisplayName,
  MODEL_OPTIONS,
} from "@renderer/services/terminal-session-selectors";
import type { ClaudeEffort, ClaudeModel } from "@shared/claude-types";
import type {
  CodexFastMode,
  CodexModelReasoningEffort,
} from "@shared/codex-types";
import { cursorModels } from "@shared/cursor-models";
import {
  type LastClaudeSessionOptions,
  type LastCodexSessionOptions,
  type LastCursorSessionOptions,
  type LastSessionOptions,
  type LastSessionType,
  resolveClaudeSessionOptions,
  resolveCodexSessionOptions,
  resolveCursorSessionOptions,
} from "@shared/last-session-options";
import {
  formatForDisplay,
  type Hotkey,
  useHotkey,
} from "@tanstack/react-hotkeys";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, ChevronsUpDown } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
} from "./session-type-icons";

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

const SESSION_TYPE_OPTIONS: {
  value: LastSessionType;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { value: "claude", label: "Claude", icon: ClaudeCodeIcon },
  { value: "codex", label: "Codex", icon: CodexIcon },
  { value: "cursorAgent", label: "Cursor", icon: CursorAgentIcon },
];

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

const CODEX_FAST_MODE_OPTIONS: { value: CodexFastMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "fast", label: "Fast" },
  { value: "off", label: "Off" },
];

const CLAUDE_EFFORT_OPTIONS: { value: ClaudeEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const switchSessionTypeHotkey: Hotkey = "Alt+Tab";

type CursorAgentMode = "default" | "plan" | "ask";

const CURSOR_AGENT_MODE_OPTIONS: {
  value: CursorAgentMode;
  label: string;
}[] = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
  { value: "ask", label: "Ask" },
];

function cycleCursorAgentMode(current: CursorAgentMode): CursorAgentMode {
  const index = CURSOR_AGENT_MODE_OPTIONS.findIndex(
    (option) => option.value === current,
  );
  return (
    CURSOR_AGENT_MODE_OPTIONS[(index + 1) % CURSOR_AGENT_MODE_OPTIONS.length]
      ?.value ?? "default"
  );
}

const cycleCursorModeHotkey: Hotkey = "Shift+Tab";

function toStoredCursorMode(
  mode: CursorAgentMode,
): LastCursorSessionOptions["mode"] {
  return mode === "default" ? undefined : mode;
}

function toCursorAgentMode(
  mode: LastCursorSessionOptions["mode"],
): CursorAgentMode {
  return mode ?? "default";
}

function buildLastSessionOptions(input: {
  sessionType: LastSessionType;
  claude: LastClaudeSessionOptions;
  codex: LastCodexSessionOptions;
  cursor: LastCursorSessionOptions;
}): LastSessionOptions {
  return {
    lastSessionType: input.sessionType,
    claude: {
      ...input.claude,
      systemPrompt: input.claude.systemPrompt?.trim() || undefined,
    },
    codex: {
      ...input.codex,
      model: input.codex.model?.trim() || undefined,
      configOverrides: input.codex.configOverrides?.trim() || undefined,
    },
    cursor: {
      ...input.cursor,
      model: input.cursor.model?.trim() || undefined,
    },
  };
}

export function NewSessionDialog() {
  const openProjectCwd = useNewSessionDialogStore((s) => s.openProjectCwd);
  const setOpenProjectCwd = useNewSessionDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const storedLastSessionOptions = useAppState(
    (state) => state.appSettings.lastSessionOptions,
  );
  const project = useAppState((state) => {
    if (!openProjectCwd) {
      return null;
    }
    return state.projects.find((item) => item.path === openProjectCwd) ?? null;
  });

  useEffect(() => {
    if (openProjectCwd && project?.interactionDisabled) {
      setOpenProjectCwd(null);
    }
  }, [openProjectCwd, project?.interactionDisabled, setOpenProjectCwd]);

  const [sessionType, setSessionType] = useState<LastSessionType>("claude");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [claudeOptions, setClaudeOptions] = useState<LastClaudeSessionOptions>(
    resolveClaudeSessionOptions(undefined),
  );
  const [codexOptions, setCodexOptions] = useState<LastCodexSessionOptions>(
    resolveCodexSessionOptions(undefined),
  );
  const [cursorOptions, setCursorOptions] = useState<LastCursorSessionOptions>(
    resolveCursorSessionOptions(undefined),
  );

  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!openProjectCwd) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;

    setSessionType(storedLastSessionOptions.lastSessionType ?? "claude");
    setInitialPrompt("");
    setSessionName("");
    setClaudeOptions(
      resolveClaudeSessionOptions(storedLastSessionOptions.claude),
    );
    setCodexOptions(resolveCodexSessionOptions(storedLastSessionOptions.codex));
    setCursorOptions(
      resolveCursorSessionOptions(storedLastSessionOptions.cursor),
    );
  }, [openProjectCwd, storedLastSessionOptions]);

  const persistLastSessionOptions = useMutation(
    orpc.appSettings.setLastSessionOptions.mutationOptions(),
  );

  const persistAndClose = useCallback(() => {
    persistLastSessionOptions.mutate(
      buildLastSessionOptions({
        sessionType,
        claude: claudeOptions,
        codex: codexOptions,
        cursor: cursorOptions,
      }),
    );
    setOpenProjectCwd(null);
  }, [
    claudeOptions,
    codexOptions,
    cursorOptions,
    persistLastSessionOptions,
    sessionType,
    setOpenProjectCwd,
  ]);

  useHotkey(
    switchSessionTypeHotkey,
    () => {
      setSessionType((current) => {
        const currentIndex = SESSION_TYPE_OPTIONS.findIndex(
          (option) => option.value === current,
        );
        const nextIndex =
          currentIndex < 0
            ? 0
            : (currentIndex + 1) % SESSION_TYPE_OPTIONS.length;
        return SESSION_TYPE_OPTIONS[nextIndex]?.value ?? "claude";
      });
    },
    { enabled: Boolean(openProjectCwd), ignoreInputs: false },
  );

  if (!openProjectCwd) {
    return null;
  }

  const projectPath = project?.path ?? openProjectCwd;
  const projectName = project ? getProjectDisplayName(project) : projectPath;

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          persistAndClose();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="hidden">Start new session</DialogTitle>
          <div className="flex items-start justify-between gap-2">
            <DialogDescription>
              Project: <span className="text-foreground">{projectName}</span>
              <br />
              <span className="text-xs text-muted-foreground">
                {projectPath}
              </span>
            </DialogDescription>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Kbd>{formatForDisplay(switchSessionTypeHotkey)}</Kbd>
            </span>
          </div>
        </DialogHeader>

        <ToggleGroup
          type="single"
          variant="outline"
          value={sessionType}
          onValueChange={(value) => {
            if (value) {
              setSessionType(value as LastSessionType);
            }
          }}
        >
          {SESSION_TYPE_OPTIONS.map((option) => {
            const isActive = sessionType === option.value;
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

        {sessionType === "claude" ? (
          <LocalClaudeSessionForm
            projectPath={projectPath}
            initialPrompt={initialPrompt}
            setInitialPrompt={setInitialPrompt}
            sessionName={sessionName}
            setSessionName={setSessionName}
            options={claudeOptions}
            setOptions={setClaudeOptions}
            onClose={persistAndClose}
          />
        ) : sessionType === "codex" ? (
          <CodexSessionForm
            projectPath={projectPath}
            initialPrompt={initialPrompt}
            setInitialPrompt={setInitialPrompt}
            sessionName={sessionName}
            setSessionName={setSessionName}
            options={codexOptions}
            setOptions={setCodexOptions}
            onClose={persistAndClose}
          />
        ) : (
          <CursorAgentSessionForm
            projectPath={projectPath}
            initialPrompt={initialPrompt}
            setInitialPrompt={setInitialPrompt}
            sessionName={sessionName}
            setSessionName={setSessionName}
            options={cursorOptions}
            setOptions={setCursorOptions}
            onClose={persistAndClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface SessionFormProps<TOptions> {
  projectPath: string;
  initialPrompt: string;
  setInitialPrompt: (value: string) => void;
  sessionName: string;
  setSessionName: (value: string) => void;
  options: TOptions;
  setOptions: (value: TOptions | ((current: TOptions) => TOptions)) => void;
  onClose: () => void;
}

function LocalClaudeSessionForm({
  projectPath,
  initialPrompt,
  setInitialPrompt,
  sessionName,
  setSessionName,
  options,
  setOptions,
  onClose,
}: SessionFormProps<LastClaudeSessionOptions>) {
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleError = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) {
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage("Failed to start session.");
  };

  const startSession = useMutation(
    orpc.sessions.localClaude.startSession.mutationOptions({
      onSuccess: (sessionId) => {
        setActiveSessionId(sessionId);
        onClose();
      },
      onError: handleError,
    }),
  );

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        const { cols, rows } = getTerminalSize();
        startSession.mutate({
          cwd: projectPath,
          cols,
          rows,
          initialPrompt: initialPrompt || undefined,
          sessionName: sessionName || undefined,
          model: options.model,
          effort: options.effort,
          haikuModelOverride: options.haikuModelOverride,
          subagentModelOverride: options.subagentModelOverride,
          systemPrompt: options.systemPrompt || undefined,
          permissionMode: options.permissionMode,
        });
      },
      onError: handleError,
    }),
  );

  const isPending = ensureProject.isPending || startSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    ensureProject.mutate({ path: normalizedPath });
  };

  return (
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
        permissionMode={options.permissionMode}
        onPermissionModeChange={(value) => {
          setOptions((current) => ({ ...current, permissionMode: value }));
        }}
      />

      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label>Model</Label>
          <Select
            value={options.model}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                model: value as ClaudeModel,
              }));
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
          <Label className="whitespace-nowrap">Effort</Label>
          <Select
            value={options.effort ?? "no"}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                effort: value === "no" ? undefined : (value as ClaudeEffort),
              }));
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

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex w-full items-center justify-between px-2"
          >
            <span className="text-sm font-medium">Advanced settings</span>
            <ChevronsUpDown className="size-4" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
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
            <Label>Override haiku model</Label>
            <Select
              value={options.haikuModelOverride ?? "no"}
              onValueChange={(value) => {
                setOptions((current) => ({
                  ...current,
                  haikuModelOverride:
                    value === "no" ? undefined : (value as ClaudeModel),
                }));
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
              value={options.subagentModelOverride ?? "no"}
              onValueChange={(value) => {
                setOptions((current) => ({
                  ...current,
                  subagentModelOverride:
                    value === "no" ? undefined : (value as ClaudeModel),
                }));
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
            <Label htmlFor="new-session-system-prompt">
              System prompt (optional)
            </Label>
            <Textarea
              id="new-session-system-prompt"
              placeholder="Custom system prompt passed via --system-prompt"
              value={options.systemPrompt ?? ""}
              onChange={(event) => {
                setOptions((current) => ({
                  ...current,
                  systemPrompt: event.target.value,
                }));
              }}
              rows={3}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

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
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Starting..." : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CodexSessionForm({
  projectPath,
  initialPrompt,
  setInitialPrompt,
  sessionName,
  setSessionName,
  options,
  setOptions,
  onClose,
}: SessionFormProps<LastCodexSessionOptions>) {
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleError = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) {
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage("Failed to start Codex session.");
  };

  const startSession = useMutation(
    orpc.sessions.codex.startSession.mutationOptions({
      onSuccess: (result) => {
        setActiveSessionId(result.sessionId);
        onClose();
      },
      onError: handleError,
    }),
  );

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        const { cols, rows } = getTerminalSize();
        startSession.mutate({
          cwd: projectPath,
          cols,
          rows,
          sessionName: sessionName || undefined,
          model: options.model || undefined,
          modelReasoningEffort: options.modelReasoningEffort,
          fastMode: options.fastMode,
          permissionMode: options.permissionMode,
          initialPrompt: initialPrompt || undefined,
          configOverrides: options.configOverrides || undefined,
        });
      },
      onError: handleError,
    }),
  );

  const isPending = ensureProject.isPending || startSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    ensureProject.mutate({ path: normalizedPath });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="new-codex-initial-prompt">
          Initial prompt (optional)
        </Label>
        <Textarea
          id="new-codex-initial-prompt"
          autoFocus
          placeholder="What would you like Codex to do? (prefix with /plan for plan mode)"
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

      <CodexPermissionModeToggleGroup
        label="Permission mode"
        permissionMode={options.permissionMode}
        onPermissionModeChange={(value) => {
          setOptions((current) => ({ ...current, permissionMode: value }));
        }}
      />

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="new-codex-model">Model (optional)</Label>
          <Input
            id="new-codex-model"
            placeholder="gpt-5.3-codex"
            value={options.model ?? ""}
            onChange={(event) => {
              setOptions((current) => ({
                ...current,
                model: event.target.value,
              }));
            }}
          />
        </div>

        <div className="w-fit shrink-0 space-y-2">
          <Label className="whitespace-nowrap">Effort</Label>
          <Select
            value={options.modelReasoningEffort}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                modelReasoningEffort: value as CodexModelReasoningEffort,
              }));
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

        <div className="w-fit shrink-0 space-y-2">
          <Label className="whitespace-nowrap">Fast mode</Label>
          <Select
            value={options.fastMode}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                fastMode: value as CodexFastMode,
              }));
            }}
          >
            <SelectTrigger className="w-auto min-w-24 whitespace-nowrap">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODEX_FAST_MODE_OPTIONS.map((option) => (
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

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex w-full items-center justify-between px-2"
          >
            <span className="text-sm font-medium">Advanced settings</span>
            <ChevronsUpDown className="size-4" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="new-codex-session-name">
              Session name (optional)
            </Label>
            <Input
              id="new-codex-session-name"
              placeholder="Leave blank for generated name"
              value={sessionName}
              onChange={(event) => {
                setSessionName(event.target.value);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-codex-config-overrides">
              Config overrides (optional)
            </Label>
            <Textarea
              id="new-codex-config-overrides"
              placeholder="Each line becomes a separate --config argument"
              value={options.configOverrides ?? ""}
              onChange={(event) => {
                setOptions((current) => ({
                  ...current,
                  configOverrides: event.target.value,
                }));
              }}
              rows={3}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

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
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Starting..." : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CursorAgentSessionForm({
  projectPath,
  initialPrompt,
  setInitialPrompt,
  sessionName,
  setSessionName,
  options,
  setOptions,
  onClose,
}: SessionFormProps<LastCursorSessionOptions>) {
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mode = toCursorAgentMode(options.mode);

  useHotkey(
    cycleCursorModeHotkey,
    () => {
      setOptions((current) => ({
        ...current,
        mode: toStoredCursorMode(
          cycleCursorAgentMode(toCursorAgentMode(current.mode)),
        ),
      }));
    },
    {
      ignoreInputs: false,
    },
  );

  const handleError = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) {
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage("Failed to start Cursor Agent session.");
  };

  const startSession = useMutation(
    orpc.sessions.cursorAgent.startSession.mutationOptions({
      onSuccess: (result) => {
        setActiveSessionId(result.sessionId);
        onClose();
      },
      onError: handleError,
    }),
  );

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        const { cols, rows } = getTerminalSize();
        startSession.mutate({
          cwd: projectPath,
          cols,
          rows,
          sessionName: sessionName || undefined,
          model: options.model || undefined,
          mode: options.mode,
          permissionMode: options.permissionMode,
          initialPrompt: initialPrompt || undefined,
        });
      },
      onError: handleError,
    }),
  );

  const isPending = ensureProject.isPending || startSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    ensureProject.mutate({ path: normalizedPath });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="new-cursor-agent-initial-prompt">
          Initial prompt (optional)
        </Label>
        <Textarea
          id="new-cursor-agent-initial-prompt"
          autoFocus
          placeholder="What would you like Cursor Agent to do?"
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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Mode</Label>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>{formatForDisplay(cycleCursorModeHotkey)}</Kbd>
          </span>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(value) => {
            if (value) {
              setOptions((current) => ({
                ...current,
                mode: toStoredCursorMode(value as CursorAgentMode),
              }));
            }
          }}
          className="w-full"
        >
          {CURSOR_AGENT_MODE_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="flex-1"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label>Model (optional)</Label>
          <Select
            value={options.model || "auto"}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                model: value === "auto" ? undefined : value,
              }));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {cursorModels.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-fit shrink-0 space-y-2">
          <Label className="whitespace-nowrap">Permission mode</Label>
          <Select
            value={options.permissionMode}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                permissionMode:
                  value as LastCursorSessionOptions["permissionMode"],
              }));
            }}
          >
            <SelectTrigger className="w-auto min-w-28 whitespace-nowrap">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default" className="whitespace-nowrap">
                Default
              </SelectItem>
              <SelectItem value="yolo" className="whitespace-nowrap">
                YOLO
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex w-full items-center justify-between px-2"
          >
            <span className="text-sm font-medium">Advanced settings</span>
            <ChevronsUpDown className="size-4" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="new-cursor-agent-session-name">
              Session name (optional)
            </Label>
            <Input
              id="new-cursor-agent-session-name"
              placeholder="Leave blank for generated name"
              value={sessionName}
              onChange={(event) => {
                setSessionName(event.target.value);
              }}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

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
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Starting..." : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
