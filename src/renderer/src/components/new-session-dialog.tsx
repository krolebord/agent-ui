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
  ProjectPicker,
  type ProjectSelection,
} from "@renderer/components/project-picker";
import {
  buildScheduleSpec,
  type ScheduleDraft,
  SessionFormFooter,
  scheduleSpecToDraft,
} from "@renderer/components/schedule-session-controls";
import {
  optionPillClassName,
  type SessionOption,
  SessionOptionSelect,
  SessionOptionToggle,
} from "@renderer/components/session-option-select";
import { SessionPromptBox } from "@renderer/components/session-prompt-box";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { Kbd } from "@renderer/components/ui/kbd";
import { Label } from "@renderer/components/ui/label";
import { Textarea } from "@renderer/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import { useAccountUsagePercent } from "@renderer/hooks/use-account-usage";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import {
  type SessionTargetStatus,
  useSessionProjectTarget,
} from "@renderer/hooks/use-session-project-target";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { claudeCatalogModels } from "@shared/claude-models";
import type { ClaudeEffort, ClaudePermissionMode } from "@shared/claude-types";
import { codexModels } from "@shared/codex-models";
import type {
  CodexFastMode,
  CodexModelReasoningEffort,
  CodexPermissionMode,
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
import {
  AlertCircle,
  ChevronDown,
  ChevronsUpDown,
  LoaderCircle,
  Plug,
  ShieldCheck,
  Smartphone,
  User,
} from "lucide-react";
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

const cyclePermissionModeHotkey: Hotkey = "Shift+Tab";

const CLAUDE_PERMISSION_MODE_OPTIONS: SessionOption<ClaudePermissionMode>[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept edits", tone: "caution" },
  { value: "plan", label: "Plan", tone: "notice" },
  { value: "yolo", label: "Yolo", tone: "danger" },
];

const CODEX_PERMISSION_MODE_OPTIONS: SessionOption<CodexPermissionMode>[] = [
  { value: "default", label: "Default" },
  { value: "full-auto", label: "Full Auto", tone: "caution" },
  { value: "yolo", label: "Yolo", tone: "danger" },
];

const CURSOR_PERMISSION_MODE_OPTIONS: SessionOption<"default" | "yolo">[] = [
  { value: "default", label: "Default" },
  { value: "yolo", label: "YOLO", tone: "danger" },
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

const DEFAULT_EFFORT_VALUE = "default";

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

const CURSOR_AGENT_MODE_OPTIONS: SessionOption<CursorAgentMode>[] = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan", tone: "notice" },
  { value: "ask", label: "Ask", tone: "notice" },
];

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
    accountId: config.accountId,
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

function AccountUsagePercent({
  percent,
  className,
}: {
  percent: number | null;
  className?: string;
}) {
  if (percent == null) {
    return null;
  }

  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        percent >= 100 ? "text-[#DE7356]" : "text-muted-foreground",
        className,
      )}
    >
      {percent}%
    </span>
  );
}

function HotkeyHints() {
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <Kbd>{formatForDisplay(switchSessionTypeHotkey)}</Kbd>
        agent
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>{formatForDisplay(cyclePermissionModeHotkey)}</Kbd>
        mode
      </span>
    </>
  );
}

const DEFAULT_ACCOUNT_VALUE = "default";

function AccountSelect({
  kind,
  accountId,
  onAccountIdChange,
}: {
  kind: "claude" | "codex";
  accountId: string | undefined;
  onAccountIdChange: (accountId: string | undefined) => void;
}) {
  const accounts = useAppState((state) =>
    kind === "claude"
      ? state.claudeAccounts.accounts
      : state.codexAccounts.accounts,
  );
  const accountUsagePercent = useAccountUsagePercent(kind);

  if (accounts.length === 0) {
    return null;
  }

  const selected = accounts.find((account) => account.id === accountId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label="Account"
          className={cn(optionPillClassName, "text-muted-foreground min-w-0")}
        >
          <User className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">
            {selected?.label ?? "Default account"}
          </span>
          <AccountUsagePercent
            percent={accountUsagePercent(selected?.id ?? null)}
          />
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-56">
        <DropdownMenuRadioGroup
          value={selected?.id ?? DEFAULT_ACCOUNT_VALUE}
          onValueChange={(value) => {
            onAccountIdChange(
              value === DEFAULT_ACCOUNT_VALUE ? undefined : value,
            );
          }}
        >
          <DropdownMenuRadioItem value={DEFAULT_ACCOUNT_VALUE}>
            Default account
            <AccountUsagePercent
              percent={accountUsagePercent(null)}
              className="ml-auto"
            />
          </DropdownMenuRadioItem>
          {accounts.map((account) => (
            <DropdownMenuRadioItem key={account.id} value={account.id}>
              {account.label}
              <AccountUsagePercent
                percent={accountUsagePercent(account.id)}
                className="ml-auto"
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

  const [selectionOverride, setSelectionOverride] =
    useState<ProjectSelection | null>(null);
  const [worktreeName, setWorktreeName] = useState("");
  const [pickedProjectKey, setPickedProjectKey] = useState(lookupCwd);
  if (pickedProjectKey !== lookupCwd) {
    setPickedProjectKey(lookupCwd);
    setSelectionOverride(null);
    setWorktreeName("");
  }

  const selection: ProjectSelection = selectionOverride ?? {
    kind: "project",
    path: project?.path ?? lookupCwd ?? "",
  };
  const projectTarget = useSessionProjectTarget(selection, worktreeName);
  const resetProjectTarget = projectTarget.reset;

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
    setSelectionOverride(null);
    setWorktreeName("");
    resetProjectTarget();
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
  }, [isOpen, editEntry, storedLastSessionOptions, resetProjectTarget]);

  const persistLastSessionOptions = useMutation(
    orpc.appSettings.setLastSessionOptions.mutationOptions(),
  );

  const persistAndClose = useCallback(() => {
    if (editScheduledSessionId) {
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

  const projectPath =
    selection.kind === "project" ? selection.path : selection.originPath;
  const isEditing = editEntry !== null;
  const sessionFormTarget = {
    projectPath,
    resolveSessionCwd: projectTarget.resolve,
    targetStatus: projectTarget.status,
  };

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
        <DialogHeader className="gap-1.5">
          <DialogTitle className="sr-only">
            {isEditing ? "Edit scheduled session" : "Start new session"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure and start an agent session in {projectPath}.
          </DialogDescription>
          {isEditing ? (
            <span className="text-sm">Edit scheduled session</span>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1.5">
            <ProjectPicker
              id="new-session-project"
              value={selection}
              onChange={setSelectionOverride}
            />
            {selection.kind === "new-worktree" ? (
              <Input
                id="new-session-worktree-name"
                aria-label="Worktree name"
                className="h-8"
                placeholder="Worktree name (optional)"
                value={worktreeName}
                onChange={(event) => {
                  setWorktreeName(event.target.value);
                }}
              />
            ) : null}
          </div>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={sessionType}
            onValueChange={(value) => {
              if (value) {
                setSessionType(value as LastSessionType);
              }
            }}
            className="shrink-0"
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
            <AccountSelect
              kind="claude"
              accountId={claudeOptions.accountId}
              onAccountIdChange={(accountId) => {
                setClaudeOptions((current) => ({ ...current, accountId }));
              }}
            />
          ) : sessionType === "codex" ? (
            <AccountSelect
              kind="codex"
              accountId={codexOptions.accountId}
              onAccountIdChange={(accountId) => {
                setCodexOptions((current) => ({ ...current, accountId }));
              }}
            />
          ) : null}
        </div>

        {sessionType === "claude" ? (
          <LocalClaudeSessionForm
            {...sessionFormTarget}
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
            {...sessionFormTarget}
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
            {...sessionFormTarget}
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

function SessionTargetStatusLine({ status }: { status: SessionTargetStatus }) {
  if (status === "idle") {
    return null;
  }

  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <LoaderCircle className="size-3.5 animate-spin" />
      <span>
        {status === "creating"
          ? "Creating worktree..."
          : "Running worktree setup..."}
      </span>
    </div>
  );
}

interface SessionFormProps<TOptions> {
  projectPath: string;
  resolveSessionCwd: () => Promise<string>;
  targetStatus: SessionTargetStatus;
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
  resolveSessionCwd,
  targetStatus,
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
  const claudeEffortSelectOptions = useMemo<
    SessionOption<ClaudeEffort | typeof DEFAULT_EFFORT_VALUE>[]
  >(
    () => [
      { value: DEFAULT_EFFORT_VALUE, label: "Default" },
      ...CLAUDE_EFFORT_OPTIONS.filter((option) =>
        supportedClaudeEfforts.includes(option.value),
      ),
    ],
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
    }),
  );

  const scheduleSession = useMutation(
    orpc.scheduledSessions.create.mutationOptions({
      onSuccess: () => {
        toast.success("Session scheduled");
        onClose();
      },
    }),
  );

  const updateScheduledSession = useMutation(
    orpc.scheduledSessions.update.mutationOptions({
      onSuccess: () => {
        toast.success("Schedule updated");
        onClose();
      },
    }),
  );

  const claudeAccounts = useAppState((s) => s.claudeAccounts.accounts);
  const selectedAccountId =
    options.accountId &&
    claudeAccounts.some((account) => account.id === options.accountId)
      ? options.accountId
      : undefined;

  const buildSessionConfig = (cwd: string) => ({
    cwd,
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

  const ensureProject = useMutation(orpc.projects.addProject.mutationOptions());

  const isPending =
    targetStatus !== "idle" ||
    ensureProject.isPending ||
    startSession.isPending ||
    scheduleSession.isPending ||
    updateScheduledSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    if (!projectPath.trim()) {
      setErrorMessage("Project path is required.");
      return;
    }

    const schedule = scheduleDraft ? buildScheduleSpec(scheduleDraft) : null;
    if (schedule && "error" in schedule) {
      setErrorMessage(schedule.error);
      return;
    }

    void (async () => {
      try {
        const cwd = await resolveSessionCwd();
        const sessionConfig = buildSessionConfig(cwd);

        if (editScheduledSessionId) {
          if (!schedule) {
            setErrorMessage("Schedule is required.");
            return;
          }
          await updateScheduledSession.mutateAsync({
            id: editScheduledSessionId,
            name: sessionName || undefined,
            schedule: schedule.schedule,
            config: { type: "claude", ...sessionConfig },
          });
          return;
        }

        await ensureProject.mutateAsync({ path: cwd });

        if (schedule) {
          await scheduleSession.mutateAsync({
            name: sessionName || undefined,
            schedule: schedule.schedule,
            config: { type: "claude", ...sessionConfig },
          });
          return;
        }

        const { cols, rows } = getTerminalSize();
        await startSession.mutateAsync({ ...sessionConfig, cols, rows });
      } catch (error) {
        handleError(error);
      }
    })();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <SessionPromptBox
        id="new-session-initial-prompt"
        autoFocus={shouldAutoFocus()}
        placeholder="What would you like Claude to do?"
        value={initialPrompt}
        onChange={setInitialPrompt}
        onSubmit={handleSubmit}
        handoffControl={
          editScheduledSessionId ? null : (
            <HandoffPicker
              variant="chip"
              value={selectedHandoff}
              onChange={onHandoffChange}
              disabled={isPending}
            />
          )
        }
        modeControl={
          <SessionOptionSelect
            value={options.permissionMode}
            onChange={(value) => {
              setOptions((current) => ({ ...current, permissionMode: value }));
            }}
            options={CLAUDE_PERMISSION_MODE_OPTIONS}
            ariaLabel="Permission mode"
            icon={<ShieldCheck className="size-3.5 shrink-0" />}
            cycleHotkey={cyclePermissionModeHotkey}
          />
        }
      />

      <div className="flex items-center gap-1.5">
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
          triggerClassName={cn(optionPillClassName, "min-w-0 flex-1")}
        />
        <SessionOptionSelect
          value={options.effort ?? DEFAULT_EFFORT_VALUE}
          onChange={(value) => {
            setOptions((current) => ({
              ...current,
              effort: value === DEFAULT_EFFORT_VALUE ? undefined : value,
            }));
          }}
          options={claudeEffortSelectOptions}
          ariaLabel="Effort"
          label="Effort"
        />
      </div>

      <Collapsible>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <SessionOptionToggle
              pressed={options.mcpEnabled ?? true}
              onPressedChange={(pressed) => {
                setOptions((current) => ({
                  ...current,
                  mcpEnabled: pressed ? undefined : false,
                }));
              }}
              label="MCP"
              description="Let this session use Agent UI tools over MCP"
              icon={<Plug className="size-3.5 shrink-0" />}
            />
            <SessionOptionToggle
              pressed={options.remoteControl ?? false}
              onPressedChange={(pressed) => {
                setOptions((current) => ({
                  ...current,
                  remoteControl: pressed || undefined,
                }));
              }}
              label="Remote"
              description="Control this session from claude.ai or the mobile app"
              icon={<Smartphone className="size-3.5 shrink-0" />}
            />
          </div>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className={cn(optionPillClassName, "text-muted-foreground")}
            >
              Advanced
              <ChevronsUpDown className="size-3.5" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-4 pt-3">
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

      <SessionTargetStatusLine status={targetStatus} />

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
        hints={<HotkeyHints />}
      />
    </form>
  );
}

function CodexSessionForm({
  projectPath,
  resolveSessionCwd,
  targetStatus,
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
    }),
  );

  const scheduleSession = useMutation(
    orpc.scheduledSessions.create.mutationOptions({
      onSuccess: () => {
        toast.success("Session scheduled");
        onClose();
      },
    }),
  );

  const updateScheduledSession = useMutation(
    orpc.scheduledSessions.update.mutationOptions({
      onSuccess: () => {
        toast.success("Schedule updated");
        onClose();
      },
    }),
  );

  const codexAccounts = useAppState((s) => s.codexAccounts.accounts);
  const selectedAccountId =
    options.accountId &&
    codexAccounts.some((account) => account.id === options.accountId)
      ? options.accountId
      : undefined;

  const buildSessionConfig = (cwd: string) => ({
    cwd,
    sessionName: sessionName || undefined,
    model: options.model || undefined,
    modelReasoningEffort: options.modelReasoningEffort,
    fastMode: options.fastMode,
    permissionMode: options.permissionMode,
    initialPrompt: initialPrompt || undefined,
    configOverrides: options.configOverrides || undefined,
    mcpEnabled: options.mcpEnabled,
    accountId: selectedAccountId,
  });

  const ensureProject = useMutation(orpc.projects.addProject.mutationOptions());

  const isPending =
    targetStatus !== "idle" ||
    ensureProject.isPending ||
    startSession.isPending ||
    scheduleSession.isPending ||
    updateScheduledSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    if (!projectPath.trim()) {
      setErrorMessage("Project path is required.");
      return;
    }

    const schedule = scheduleDraft ? buildScheduleSpec(scheduleDraft) : null;
    if (schedule && "error" in schedule) {
      setErrorMessage(schedule.error);
      return;
    }

    void (async () => {
      try {
        const cwd = await resolveSessionCwd();
        const sessionConfig = buildSessionConfig(cwd);

        if (editScheduledSessionId) {
          if (!schedule) {
            setErrorMessage("Schedule is required.");
            return;
          }
          await updateScheduledSession.mutateAsync({
            id: editScheduledSessionId,
            name: sessionName || undefined,
            schedule: schedule.schedule,
            config: { type: "codex", ...sessionConfig },
          });
          return;
        }

        await ensureProject.mutateAsync({ path: cwd });

        if (schedule) {
          await scheduleSession.mutateAsync({
            name: sessionName || undefined,
            schedule: schedule.schedule,
            config: { type: "codex", ...sessionConfig },
          });
          return;
        }

        const { cols, rows } = getTerminalSize();
        await startSession.mutateAsync({ ...sessionConfig, cols, rows });
      } catch (error) {
        handleError(error);
      }
    })();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <SessionPromptBox
        id="new-codex-initial-prompt"
        autoFocus={shouldAutoFocus()}
        placeholder="What would you like Codex to do? (prefix with /plan for plan mode)"
        value={initialPrompt}
        onChange={setInitialPrompt}
        onSubmit={handleSubmit}
        handoffControl={
          editScheduledSessionId ? null : (
            <HandoffPicker
              variant="chip"
              value={selectedHandoff}
              onChange={onHandoffChange}
              disabled={isPending}
            />
          )
        }
        modeControl={
          <SessionOptionSelect
            value={options.permissionMode}
            onChange={(value) => {
              setOptions((current) => ({ ...current, permissionMode: value }));
            }}
            options={CODEX_PERMISSION_MODE_OPTIONS}
            ariaLabel="Permission mode"
            icon={<ShieldCheck className="size-3.5 shrink-0" />}
            cycleHotkey={cyclePermissionModeHotkey}
          />
        }
      />

      <div className="flex items-center gap-1.5">
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
          triggerClassName={cn(optionPillClassName, "min-w-0 flex-1")}
        />
        <SessionOptionSelect
          value={options.modelReasoningEffort}
          onChange={(value) => {
            setOptions((current) => ({
              ...current,
              modelReasoningEffort: value,
            }));
          }}
          options={codexEffortOptions}
          ariaLabel="Reasoning effort"
          label="Effort"
          disabled={isPending}
        />
        <SessionOptionSelect
          value={options.fastMode}
          onChange={(value) => {
            setOptions((current) => ({ ...current, fastMode: value }));
          }}
          options={CODEX_FAST_MODE_OPTIONS}
          ariaLabel="Fast mode"
          label="Fast"
          disabled={isPending}
        />
      </div>

      <Collapsible>
        <div className="flex items-center justify-between gap-2">
          <SessionOptionToggle
            pressed={options.mcpEnabled ?? true}
            onPressedChange={(pressed) => {
              setOptions((current) => ({
                ...current,
                mcpEnabled: pressed ? undefined : false,
              }));
            }}
            label="MCP"
            description="Let this session use Agent UI tools over MCP"
            icon={<Plug className="size-3.5 shrink-0" />}
          />
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className={cn(optionPillClassName, "text-muted-foreground")}
            >
              Advanced
              <ChevronsUpDown className="size-3.5" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-4 pt-3">
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

      <SessionTargetStatusLine status={targetStatus} />

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
        hints={<HotkeyHints />}
      />
    </form>
  );
}

function CursorAgentSessionForm({
  projectPath,
  resolveSessionCwd,
  targetStatus,
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
    }),
  );

  const scheduleSession = useMutation(
    orpc.scheduledSessions.create.mutationOptions({
      onSuccess: () => {
        toast.success("Session scheduled");
        onClose();
      },
    }),
  );

  const updateScheduledSession = useMutation(
    orpc.scheduledSessions.update.mutationOptions({
      onSuccess: () => {
        toast.success("Schedule updated");
        onClose();
      },
    }),
  );

  const buildSessionConfig = (cwd: string) => ({
    cwd,
    sessionName: sessionName || undefined,
    model: options.model || undefined,
    mode: options.mode,
    permissionMode: options.permissionMode,
    initialPrompt: initialPrompt || undefined,
  });

  const ensureProject = useMutation(orpc.projects.addProject.mutationOptions());

  const isPending =
    targetStatus !== "idle" ||
    ensureProject.isPending ||
    startSession.isPending ||
    scheduleSession.isPending ||
    updateScheduledSession.isPending;

  const handleSubmit = () => {
    setErrorMessage(null);

    if (!projectPath.trim()) {
      setErrorMessage("Project path is required.");
      return;
    }

    const schedule = scheduleDraft ? buildScheduleSpec(scheduleDraft) : null;
    if (schedule && "error" in schedule) {
      setErrorMessage(schedule.error);
      return;
    }

    void (async () => {
      try {
        const cwd = await resolveSessionCwd();
        const sessionConfig = buildSessionConfig(cwd);

        if (editScheduledSessionId) {
          if (!schedule) {
            setErrorMessage("Schedule is required.");
            return;
          }
          await updateScheduledSession.mutateAsync({
            id: editScheduledSessionId,
            name: sessionName || undefined,
            schedule: schedule.schedule,
            config: { type: "cursorAgent", ...sessionConfig },
          });
          return;
        }

        await ensureProject.mutateAsync({ path: cwd });

        if (schedule) {
          await scheduleSession.mutateAsync({
            name: sessionName || undefined,
            schedule: schedule.schedule,
            config: { type: "cursorAgent", ...sessionConfig },
          });
          return;
        }

        const { cols, rows } = getTerminalSize();
        await startSession.mutateAsync({ ...sessionConfig, cols, rows });
      } catch (error) {
        handleError(error);
      }
    })();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <SessionPromptBox
        id="new-cursor-agent-initial-prompt"
        autoFocus={shouldAutoFocus()}
        placeholder="What would you like Cursor Agent to do?"
        value={initialPrompt}
        onChange={setInitialPrompt}
        onSubmit={handleSubmit}
        handoffControl={
          editScheduledSessionId ? null : (
            <HandoffPicker
              variant="chip"
              value={selectedHandoff}
              onChange={onHandoffChange}
              disabled={isPending}
            />
          )
        }
        modeControl={
          <SessionOptionSelect
            value={mode}
            onChange={(value) => {
              setOptions((current) => ({
                ...current,
                mode: toStoredCursorMode(value),
              }));
            }}
            options={CURSOR_AGENT_MODE_OPTIONS}
            ariaLabel="Mode"
            label="Mode"
            cycleHotkey={cyclePermissionModeHotkey}
          />
        }
      />

      <div className="flex items-center gap-1.5">
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
          triggerClassName={cn(optionPillClassName, "min-w-0 flex-1")}
        />
        <SessionOptionSelect
          value={options.permissionMode}
          onChange={(value) => {
            setOptions((current) => ({ ...current, permissionMode: value }));
          }}
          options={CURSOR_PERMISSION_MODE_OPTIONS}
          ariaLabel="Permission mode"
          icon={<ShieldCheck className="size-3.5 shrink-0" />}
          disabled={isPending}
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

      <SessionTargetStatusLine status={targetStatus} />

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
        hints={<HotkeyHints />}
      />
    </form>
  );
}
