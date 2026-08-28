import type { ScheduledSession } from "@main/scheduled-sessions/state";
import {
  addRecentClaudeModel,
  CLAUDE_DEFAULT_MODEL_VALUE,
  ClaudeModelPicker,
} from "@renderer/components/claude-model-picker";
import {
  addRecentCodexModel,
  CODEX_DEFAULT_MODEL_VALUE,
  CodexModelPicker,
} from "@renderer/components/codex-model-picker";
import {
  addRecentCursorModel,
  CursorModelPicker,
} from "@renderer/components/cursor-model-picker";
import {
  type HandoffEntryDisplay,
  HandoffPicker,
  useHandoffSelection,
} from "@renderer/components/handoff-picker";
import {
  CodexPermissionModeToggleGroup,
  PermissionModeToggleGroup,
} from "@renderer/components/permission-mode-toggle-group";
import { ProjectPicker } from "@renderer/components/project-picker";
import {
  buildScheduleSpec,
  type ScheduleDraft,
  SessionFormFooter,
  scheduleSpecToDraft,
} from "@renderer/components/schedule-session-controls";
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
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { isCoarsePointer } from "@renderer/lib/pointer";
import { orpc } from "@renderer/orpc-client";
import { claudeCatalogModels } from "@shared/claude-models";
import type { ClaudeEffort } from "@shared/claude-types";
import { codexModels } from "@shared/codex-models";
import type {
  CodexFastMode,
  CodexModelReasoningEffort,
} from "@shared/codex-types";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
      editScheduledSessionId: null as string | null,
    },
    (set) => ({
      setOpenProjectCwd: (openProjectCwd: string | null) => {
        set({ openProjectCwd, editScheduledSessionId: null });
      },
      openScheduledSessionEditor: (editScheduledSessionId: string | null) => {
        set({ editScheduledSessionId, openProjectCwd: null });
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
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

const CODEX_FAST_MODE_OPTIONS: { value: CodexFastMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "fast", label: "Fast" },
  { value: "off", label: "Off" },
];

function getCodexSupportedReasoningEfforts(
  modelValue: string | undefined,
): CodexModelReasoningEffort[] {
  const selectedModel = modelValue
    ? codexModels.find((model) => model.value === modelValue)
    : undefined;

  if (selectedModel?.supportedReasoningEfforts.length) {
    return selectedModel.supportedReasoningEfforts;
  }

  const catalogEfforts = new Set(
    codexModels.flatMap((model) => model.supportedReasoningEfforts),
  );
  const orderedCatalogEfforts = CODEX_MODEL_REASONING_EFFORT_OPTIONS.map(
    (option) => option.value,
  ).filter((effort) => catalogEfforts.has(effort));

  return orderedCatalogEfforts.length
    ? orderedCatalogEfforts
    : CODEX_MODEL_REASONING_EFFORT_OPTIONS.map((option) => option.value);
}

const CLAUDE_EFFORT_OPTIONS: { value: ClaudeEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

function getClaudeSupportedEfforts(modelValue: string): ClaudeEffort[] {
  const selectedModel = claudeCatalogModels.find(
    (model) => model.value === modelValue,
  );

  if (selectedModel?.supportedEfforts.length) {
    return selectedModel.supportedEfforts;
  }

  return CLAUDE_EFFORT_OPTIONS.map((option) => option.value);
}

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

function claudeConfigToOptions(
  config: Extract<ScheduledSession["config"], { type: "claude" }>,
  stored: LastClaudeSessionOptions,
): LastClaudeSessionOptions {
  return {
    ...stored,
    model: config.model ?? "opus",
    effort: config.effort,
    permissionMode: config.permissionMode ?? "default",
    haikuModelOverride: config.haikuModelOverride,
    subagentModelOverride: config.subagentModelOverride,
    systemPrompt: config.systemPrompt,
    remoteControl: config.remoteControl,
    mcpEnabled: config.mcpEnabled,
    accountId: config.accountId,
  };
}

function codexConfigToOptions(
  config: Extract<ScheduledSession["config"], { type: "codex" }>,
  stored: LastCodexSessionOptions,
): LastCodexSessionOptions {
  return {
    ...stored,
    model: config.model,
    modelReasoningEffort: config.modelReasoningEffort,
    fastMode: config.fastMode,
    permissionMode: config.permissionMode,
    configOverrides: config.configOverrides,
    mcpEnabled: config.mcpEnabled,
  };
}

function cursorConfigToOptions(
  config: Extract<ScheduledSession["config"], { type: "cursorAgent" }>,
  stored: LastCursorSessionOptions,
): LastCursorSessionOptions {
  return {
    ...stored,
    model: config.model,
    mode: config.mode,
    permissionMode: config.permissionMode,
  };
}

export function NewSessionDialog() {
  const openProjectCwd = useNewSessionDialogStore((s) => s.openProjectCwd);
  const setOpenProjectCwd = useNewSessionDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const editScheduledSessionId = useNewSessionDialogStore(
    (s) => s.editScheduledSessionId,
  );
  const openScheduledSessionEditor = useNewSessionDialogStore(
    (s) => s.openScheduledSessionEditor,
  );
  const editEntry = useAppState((state) =>
    editScheduledSessionId
      ? (state.scheduledSessions[editScheduledSessionId] ?? null)
      : null,
  );
  const storedLastSessionOptions = useAppState(
    (state) => state.appSettings.lastSessionOptions,
  );
  const lookupCwd = openProjectCwd ?? editEntry?.config.cwd ?? null;
  const project = useAppState((state) => {
    if (!lookupCwd) {
      return null;
    }
    return state.projects.find((item) => item.path === lookupCwd) ?? null;
  });

  useEffect(() => {
    if (openProjectCwd && project?.interactionDisabled) {
      setOpenProjectCwd(null);
    }
  }, [openProjectCwd, project?.interactionDisabled, setOpenProjectCwd]);

  const [sessionType, setSessionType] = useState<LastSessionType>("claude");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [selectedHandoff, setSelectedHandoff] =
    useState<HandoffEntryDisplay | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(
    null,
  );
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
  const isOpen = openProjectCwd !== null || editEntry !== null;

  // The project the dialog was opened for is only the starting point; the picker
  // can retarget it. Reset happens during render rather than in an effect so
  // reopening the dialog can never paint a stale project for a frame.
  const [pickedProjectPath, setPickedProjectPath] = useState<string | null>(
    null,
  );
  const [pickedProjectKey, setPickedProjectKey] = useState(lookupCwd);
  if (pickedProjectKey !== lookupCwd) {
    setPickedProjectKey(lookupCwd);
    setPickedProjectPath(null);
  }

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;

    setSelectedHandoff(null);
    const resolvedClaude = resolveClaudeSessionOptions(
      storedLastSessionOptions.claude,
    );
    const resolvedCodex = resolveCodexSessionOptions(
      storedLastSessionOptions.codex,
    );
    const resolvedCursor = resolveCursorSessionOptions(
      storedLastSessionOptions.cursor,
    );

    if (editEntry) {
      const config = editEntry.config;
      setSessionType(config.type);
      setInitialPrompt(config.initialPrompt ?? "");
      setSessionName(config.sessionName ?? editEntry.name ?? "");
      setScheduleDraft(scheduleSpecToDraft(editEntry.schedule));
      setClaudeOptions(
        config.type === "claude"
          ? claudeConfigToOptions(config, resolvedClaude)
          : resolvedClaude,
      );
      setCodexOptions(
        config.type === "codex"
          ? codexConfigToOptions(config, resolvedCodex)
          : resolvedCodex,
      );
      setCursorOptions(
        config.type === "cursorAgent"
          ? cursorConfigToOptions(config, resolvedCursor)
          : resolvedCursor,
      );
      return;
    }

    setSessionType(storedLastSessionOptions.lastSessionType ?? "claude");
    setInitialPrompt("");
    setSessionName("");
    setScheduleDraft(null);
    setClaudeOptions(resolvedClaude);
    setCodexOptions(resolvedCodex);
    setCursorOptions(resolvedCursor);
  }, [isOpen, editEntry, storedLastSessionOptions]);

  const persistLastSessionOptions = useMutation(
    orpc.appSettings.setLastSessionOptions.mutationOptions(),
  );

  const persistAndClose = useCallback(() => {
    if (editScheduledSessionId) {
      // Edited values describe one schedule, not the user's preferred
      // defaults for new sessions — close without persisting them.
      openScheduledSessionEditor(null);
      return;
    }
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
    editScheduledSessionId,
    openScheduledSessionEditor,
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
    { enabled: isOpen, ignoreInputs: false },
  );

  if (!isOpen) {
    return null;
  }

  const projectPath = pickedProjectPath ?? project?.path ?? lookupCwd ?? "";
  const isEditing = editEntry !== null;

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
          <DialogTitle className="hidden">
            {isEditing ? "Edit scheduled session" : "Start new session"}
          </DialogTitle>
          <div className="flex items-start justify-between gap-2">
            <DialogDescription className="min-w-0">
              {isEditing ? (
                <>
                  <span className="text-foreground">
                    Edit scheduled session
                  </span>
                  <br />
                </>
              ) : null}
              <span className="inline-flex max-w-full items-center gap-0.5">
                Project:
                <ProjectPicker
                  id="new-session-project"
                  value={projectPath}
                  onChange={setPickedProjectPath}
                />
              </span>
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
            selectedHandoff={selectedHandoff}
            setSelectedHandoff={setSelectedHandoff}
            scheduleDraft={scheduleDraft}
            setScheduleDraft={setScheduleDraft}
            options={claudeOptions}
            setOptions={setClaudeOptions}
            onClose={persistAndClose}
            editScheduledSessionId={editEntry?.id ?? null}
          />
        ) : sessionType === "codex" ? (
          <CodexSessionForm
            projectPath={projectPath}
            initialPrompt={initialPrompt}
            setInitialPrompt={setInitialPrompt}
            sessionName={sessionName}
            setSessionName={setSessionName}
            selectedHandoff={selectedHandoff}
            setSelectedHandoff={setSelectedHandoff}
            scheduleDraft={scheduleDraft}
            setScheduleDraft={setScheduleDraft}
            options={codexOptions}
            setOptions={setCodexOptions}
            onClose={persistAndClose}
            editScheduledSessionId={editEntry?.id ?? null}
          />
        ) : (
          <CursorAgentSessionForm
            projectPath={projectPath}
            initialPrompt={initialPrompt}
            setInitialPrompt={setInitialPrompt}
            sessionName={sessionName}
            setSessionName={setSessionName}
            selectedHandoff={selectedHandoff}
            setSelectedHandoff={setSelectedHandoff}
            scheduleDraft={scheduleDraft}
            setScheduleDraft={setScheduleDraft}
            options={cursorOptions}
            setOptions={setCursorOptions}
            onClose={persistAndClose}
            editScheduledSessionId={editEntry?.id ?? null}
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
  selectedHandoff: HandoffEntryDisplay | null;
  setSelectedHandoff: (value: HandoffEntryDisplay | null) => void;
  scheduleDraft: ScheduleDraft | null;
  setScheduleDraft: (value: ScheduleDraft | null) => void;
  options: TOptions;
  setOptions: (value: TOptions | ((current: TOptions) => TOptions)) => void;
  onClose: () => void;
  editScheduledSessionId: string | null;
}

function LocalClaudeSessionForm({
  projectPath,
  initialPrompt,
  setInitialPrompt,
  sessionName,
  setSessionName,
  selectedHandoff,
  setSelectedHandoff,
  scheduleDraft,
  setScheduleDraft,
  options,
  setOptions,
  onClose,
  editScheduledSessionId,
}: SessionFormProps<LastClaudeSessionOptions>) {
  const onHandoffChange = useHandoffSelection({
    initialPrompt,
    setInitialPrompt,
    selectedHandoff,
    setSelectedHandoff,
  });
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const supportedClaudeEfforts = useMemo(
    () => getClaudeSupportedEfforts(options.model),
    [options.model],
  );
  const claudeEffortOptions = useMemo(
    () =>
      CLAUDE_EFFORT_OPTIONS.filter((option) =>
        supportedClaudeEfforts.includes(option.value),
      ),
    [supportedClaudeEfforts],
  );

  useEffect(() => {
    if (!options.effort || supportedClaudeEfforts.includes(options.effort)) {
      return;
    }
    setOptions((current) => ({ ...current, effort: undefined }));
  }, [options.effort, setOptions, supportedClaudeEfforts]);

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

  const scheduleSession = useMutation(
    orpc.scheduledSessions.create.mutationOptions({
      onSuccess: () => {
        toast.success("Session scheduled");
        onClose();
      },
      onError: handleError,
    }),
  );

  const updateScheduledSession = useMutation(
    orpc.scheduledSessions.update.mutationOptions({
      onSuccess: () => {
        toast.success("Schedule updated");
        onClose();
      },
      onError: handleError,
    }),
  );

  const claudeAccounts = useAppState((s) => s.claudeAccounts.accounts);
  const selectedAccountId =
    options.accountId &&
    claudeAccounts.some((account) => account.id === options.accountId)
      ? options.accountId
      : undefined;

  const buildSessionConfig = () => ({
    cwd: projectPath,
    initialPrompt: initialPrompt || undefined,
    sessionName: sessionName || undefined,
    model: options.model,
    effort: options.effort,
    haikuModelOverride: options.haikuModelOverride,
    subagentModelOverride: options.subagentModelOverride,
    systemPrompt: options.systemPrompt || undefined,
    remoteControl: options.remoteControl || undefined,
    mcpEnabled: options.mcpEnabled,
    permissionMode: options.permissionMode,
    accountId: selectedAccountId,
  });

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        const sessionConfig = buildSessionConfig();

        if (scheduleDraft) {
          const result = buildScheduleSpec(scheduleDraft);
          if ("error" in result) {
            setErrorMessage(result.error);
            return;
          }
          scheduleSession.mutate({
            name: sessionName || undefined,
            schedule: result.schedule,
            config: { type: "claude", ...sessionConfig },
          });
          return;
        }

        const { cols, rows } = getTerminalSize();
        startSession.mutate({ ...sessionConfig, cols, rows });
      },
      onError: handleError,
    }),
  );

  const isPending =
    ensureProject.isPending ||
    startSession.isPending ||
    scheduleSession.isPending ||
    updateScheduledSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    if (editScheduledSessionId) {
      if (!scheduleDraft) {
        setErrorMessage("Schedule is required.");
        return;
      }
      const result = buildScheduleSpec(scheduleDraft);
      if ("error" in result) {
        setErrorMessage(result.error);
        return;
      }
      updateScheduledSession.mutate({
        id: editScheduledSessionId,
        name: sessionName || undefined,
        schedule: result.schedule,
        config: { type: "claude", ...buildSessionConfig() },
      });
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
          autoFocus={shouldAutoFocus()}
          placeholder="What would you like Claude to do?"
          value={initialPrompt}
          onChange={(event) => {
            setInitialPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isCoarsePointer()
            ) {
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

      {!editScheduledSessionId && (
        <div className="space-y-2">
          <Label>Continue from handoff (optional)</Label>
          <HandoffPicker
            value={selectedHandoff}
            onChange={onHandoffChange}
            disabled={isPending}
          />
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="new-session-claude-model">Model</Label>
          <ClaudeModelPicker
            id="new-session-claude-model"
            value={options.model}
            recentModels={options.recentModels}
            onChange={(value) => {
              setOptions((current) => ({
                ...current,
                model: value,
                recentModels: addRecentClaudeModel(current.recentModels, value),
              }));
            }}
          />
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
              {claudeEffortOptions.map((option) => (
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

      {claudeAccounts.length > 0 && (
        <div className="space-y-2">
          <Label>Account</Label>
          <Select
            value={selectedAccountId ?? "default"}
            onValueChange={(value) => {
              setOptions((current) => ({
                ...current,
                accountId: value === "default" ? undefined : value,
              }));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default account</SelectItem>
              {claudeAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="new-session-mcp">Agent UI MCP</Label>
          <p className="text-xs text-muted-foreground">
            Let this session use Agent UI tools over MCP
          </p>
        </div>
        <Switch
          id="new-session-mcp"
          checked={options.mcpEnabled ?? true}
          onCheckedChange={(checked) => {
            setOptions((current) => ({
              ...current,
              mcpEnabled: checked ? undefined : false,
            }));
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="new-session-remote-control">Remote control</Label>
          <p className="text-xs text-muted-foreground">
            Control this session from claude.ai or the mobile app
          </p>
        </div>
        <Switch
          id="new-session-remote-control"
          checked={options.remoteControl ?? false}
          onCheckedChange={(checked) => {
            setOptions((current) => ({
              ...current,
              remoteControl: checked || undefined,
            }));
          }}
        />
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
            <Label htmlFor="new-session-claude-haiku-override">
              Override haiku model
            </Label>
            <ClaudeModelPicker
              id="new-session-claude-haiku-override"
              includeDefault
              value={options.haikuModelOverride ?? CLAUDE_DEFAULT_MODEL_VALUE}
              recentModels={options.recentModels}
              onChange={(value) => {
                setOptions((current) => ({
                  ...current,
                  haikuModelOverride:
                    value === CLAUDE_DEFAULT_MODEL_VALUE ? undefined : value,
                }));
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-session-claude-subagent-override">
              Override subagent model
            </Label>
            <ClaudeModelPicker
              id="new-session-claude-subagent-override"
              includeDefault
              value={
                options.subagentModelOverride ?? CLAUDE_DEFAULT_MODEL_VALUE
              }
              recentModels={options.recentModels}
              onChange={(value) => {
                setOptions((current) => ({
                  ...current,
                  subagentModelOverride:
                    value === CLAUDE_DEFAULT_MODEL_VALUE ? undefined : value,
                }));
              }}
            />
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

      <SessionFormFooter
        isPending={isPending}
        onClose={onClose}
        scheduleDraft={scheduleDraft}
        setScheduleDraft={setScheduleDraft}
        mode={editScheduledSessionId ? "edit" : "create"}
      />
    </form>
  );
}

function CodexSessionForm({
  projectPath,
  initialPrompt,
  setInitialPrompt,
  sessionName,
  setSessionName,
  selectedHandoff,
  setSelectedHandoff,
  scheduleDraft,
  setScheduleDraft,
  options,
  setOptions,
  onClose,
  editScheduledSessionId,
}: SessionFormProps<LastCodexSessionOptions>) {
  const onHandoffChange = useHandoffSelection({
    initialPrompt,
    setInitialPrompt,
    selectedHandoff,
    setSelectedHandoff,
  });
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const selectedCodexModel = useMemo(
    () =>
      options.model
        ? codexModels.find((model) => model.value === options.model)
        : undefined,
    [options.model],
  );
  const supportedCodexReasoningEfforts = useMemo(
    () => getCodexSupportedReasoningEfforts(options.model),
    [options.model],
  );
  const codexEffortOptions = useMemo(
    () =>
      CODEX_MODEL_REASONING_EFFORT_OPTIONS.filter((option) =>
        supportedCodexReasoningEfforts.includes(option.value),
      ),
    [supportedCodexReasoningEfforts],
  );
  const codexModelOptions = useMemo(
    () =>
      options.model &&
      !codexModels.some((model) => model.value === options.model)
        ? [
            ...codexModels,
            {
              label: options.model,
              value: options.model,
              supportedReasoningEfforts: [],
              supportsFastMode: false,
            },
          ]
        : codexModels,
    [options.model],
  );

  useEffect(() => {
    if (supportedCodexReasoningEfforts.includes(options.modelReasoningEffort)) {
      return;
    }

    const defaultEffort = selectedCodexModel?.defaultReasoningEffort;
    const nextEffort =
      defaultEffort && supportedCodexReasoningEfforts.includes(defaultEffort)
        ? defaultEffort
        : (supportedCodexReasoningEfforts[0] ?? "high");

    setOptions((current) =>
      current.modelReasoningEffort === nextEffort
        ? current
        : { ...current, modelReasoningEffort: nextEffort },
    );
  }, [
    options.modelReasoningEffort,
    selectedCodexModel?.defaultReasoningEffort,
    setOptions,
    supportedCodexReasoningEfforts,
  ]);

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

  const scheduleSession = useMutation(
    orpc.scheduledSessions.create.mutationOptions({
      onSuccess: () => {
        toast.success("Session scheduled");
        onClose();
      },
      onError: handleError,
    }),
  );

  const updateScheduledSession = useMutation(
    orpc.scheduledSessions.update.mutationOptions({
      onSuccess: () => {
        toast.success("Schedule updated");
        onClose();
      },
      onError: handleError,
    }),
  );

  const buildSessionConfig = () => ({
    cwd: projectPath,
    sessionName: sessionName || undefined,
    model: options.model || undefined,
    modelReasoningEffort: options.modelReasoningEffort,
    fastMode: options.fastMode,
    permissionMode: options.permissionMode,
    initialPrompt: initialPrompt || undefined,
    configOverrides: options.configOverrides || undefined,
    mcpEnabled: options.mcpEnabled,
  });

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        const sessionConfig = buildSessionConfig();

        if (scheduleDraft) {
          const result = buildScheduleSpec(scheduleDraft);
          if ("error" in result) {
            setErrorMessage(result.error);
            return;
          }
          scheduleSession.mutate({
            name: sessionName || undefined,
            schedule: result.schedule,
            config: { type: "codex", ...sessionConfig },
          });
          return;
        }

        const { cols, rows } = getTerminalSize();
        startSession.mutate({ ...sessionConfig, cols, rows });
      },
      onError: handleError,
    }),
  );

  const isPending =
    ensureProject.isPending ||
    startSession.isPending ||
    scheduleSession.isPending ||
    updateScheduledSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    if (editScheduledSessionId) {
      if (!scheduleDraft) {
        setErrorMessage("Schedule is required.");
        return;
      }
      const result = buildScheduleSpec(scheduleDraft);
      if ("error" in result) {
        setErrorMessage(result.error);
        return;
      }
      updateScheduledSession.mutate({
        id: editScheduledSessionId,
        name: sessionName || undefined,
        schedule: result.schedule,
        config: { type: "codex", ...buildSessionConfig() },
      });
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
          autoFocus={shouldAutoFocus()}
          placeholder="What would you like Codex to do? (prefix with /plan for plan mode)"
          value={initialPrompt}
          onChange={(event) => {
            setInitialPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isCoarsePointer()
            ) {
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

      {!editScheduledSessionId && (
        <div className="space-y-2">
          <Label>Continue from handoff (optional)</Label>
          <HandoffPicker
            value={selectedHandoff}
            onChange={onHandoffChange}
            disabled={isPending}
          />
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="new-codex-model">Model (optional)</Label>
          <CodexModelPicker
            id="new-codex-model"
            value={options.model ?? CODEX_DEFAULT_MODEL_VALUE}
            models={codexModelOptions}
            recentModels={options.recentModels}
            onChange={(value) => {
              setOptions((current) => ({
                ...current,
                model: value === CODEX_DEFAULT_MODEL_VALUE ? undefined : value,
                recentModels: addRecentCodexModel(
                  current.recentModels,
                  value === CODEX_DEFAULT_MODEL_VALUE ? undefined : value,
                ),
              }));
            }}
            disabled={isPending}
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
              {codexEffortOptions.map((option) => (
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

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="new-codex-mcp">Agent UI MCP</Label>
          <p className="text-xs text-muted-foreground">
            Let this session use Agent UI tools over MCP
          </p>
        </div>
        <Switch
          id="new-codex-mcp"
          checked={options.mcpEnabled ?? true}
          onCheckedChange={(checked) => {
            setOptions((current) => ({
              ...current,
              mcpEnabled: checked ? undefined : false,
            }));
          }}
        />
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

      <SessionFormFooter
        isPending={isPending}
        onClose={onClose}
        scheduleDraft={scheduleDraft}
        setScheduleDraft={setScheduleDraft}
        mode={editScheduledSessionId ? "edit" : "create"}
      />
    </form>
  );
}

function CursorAgentSessionForm({
  projectPath,
  initialPrompt,
  setInitialPrompt,
  sessionName,
  setSessionName,
  selectedHandoff,
  setSelectedHandoff,
  scheduleDraft,
  setScheduleDraft,
  options,
  setOptions,
  onClose,
  editScheduledSessionId,
}: SessionFormProps<LastCursorSessionOptions>) {
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mode = toCursorAgentMode(options.mode);
  const onHandoffChange = useHandoffSelection({
    initialPrompt,
    setInitialPrompt,
    selectedHandoff,
    setSelectedHandoff,
  });

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

  const scheduleSession = useMutation(
    orpc.scheduledSessions.create.mutationOptions({
      onSuccess: () => {
        toast.success("Session scheduled");
        onClose();
      },
      onError: handleError,
    }),
  );

  const updateScheduledSession = useMutation(
    orpc.scheduledSessions.update.mutationOptions({
      onSuccess: () => {
        toast.success("Schedule updated");
        onClose();
      },
      onError: handleError,
    }),
  );

  const buildSessionConfig = () => ({
    cwd: projectPath,
    sessionName: sessionName || undefined,
    model: options.model || undefined,
    mode: options.mode,
    permissionMode: options.permissionMode,
    initialPrompt: initialPrompt || undefined,
  });

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        const sessionConfig = buildSessionConfig();

        if (scheduleDraft) {
          const result = buildScheduleSpec(scheduleDraft);
          if ("error" in result) {
            setErrorMessage(result.error);
            return;
          }
          scheduleSession.mutate({
            name: sessionName || undefined,
            schedule: result.schedule,
            config: { type: "cursorAgent", ...sessionConfig },
          });
          return;
        }

        const { cols, rows } = getTerminalSize();
        startSession.mutate({ ...sessionConfig, cols, rows });
      },
      onError: handleError,
    }),
  );

  const isPending =
    ensureProject.isPending ||
    startSession.isPending ||
    scheduleSession.isPending ||
    updateScheduledSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      setErrorMessage("Project path is required.");
      return;
    }

    if (editScheduledSessionId) {
      if (!scheduleDraft) {
        setErrorMessage("Schedule is required.");
        return;
      }
      const result = buildScheduleSpec(scheduleDraft);
      if ("error" in result) {
        setErrorMessage(result.error);
        return;
      }
      updateScheduledSession.mutate({
        id: editScheduledSessionId,
        name: sessionName || undefined,
        schedule: result.schedule,
        config: { type: "cursorAgent", ...buildSessionConfig() },
      });
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
          autoFocus={shouldAutoFocus()}
          placeholder="What would you like Cursor Agent to do?"
          value={initialPrompt}
          onChange={(event) => {
            setInitialPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isCoarsePointer()
            ) {
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

      {!editScheduledSessionId && (
        <div className="space-y-2">
          <Label>Continue from handoff (optional)</Label>
          <HandoffPicker
            value={selectedHandoff}
            onChange={onHandoffChange}
            disabled={isPending}
          />
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label>Model (optional)</Label>
          <CursorModelPicker
            includeAuto
            value={options.model || "auto"}
            recentModels={options.recentModels}
            onChange={(value) => {
              setOptions((current) => ({
                ...current,
                model: value === "auto" ? undefined : value,
                recentModels: addRecentCursorModel(
                  current.recentModels,
                  value === "auto" ? undefined : value,
                ),
              }));
            }}
            disabled={isPending}
          />
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

      <SessionFormFooter
        isPending={isPending}
        onClose={onClose}
        scheduleDraft={scheduleDraft}
        setScheduleDraft={setScheduleDraft}
        mode={editScheduledSessionId ? "edit" : "create"}
      />
    </form>
  );
}
