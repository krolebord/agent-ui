import { EffortToggleGroup } from "@renderer/components/effort-toggle-group";
import { PermissionModeToggleGroup } from "@renderer/components/permission-mode-toggle-group";
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
import { Kbd } from "@renderer/components/ui/kbd";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { orpc } from "@renderer/orpc-client";
import {
  MODEL_OPTIONS,
  getProjectNameFromPath,
} from "@renderer/services/terminal-session-selectors";
import type {
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
} from "@shared/claude-types";
import {
  formatForDisplay,
  Hotkey,
  useHotkey,
} from "@tanstack/react-hotkeys";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
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

type SessionType = "claude" | "ralphLoop" | "terminal";

const SESSION_TYPE_OPTIONS: { value: SessionType; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "ralphLoop", label: "Ralph Loop" },
  { value: "terminal", label: "Terminal" },
];

const DEFAULT_RALPH_LOOP_OBJECTIVE_PROMPT = [
  "Iteration: {iteration}",
  "Objective:",
  "1. Pick random task from @plan.md",
  "2. Summarize your progress and reason why you picked that task into progress.md",
  "3. Output text associated with the task",
  "",
  "Instructions:",
  "- If all tasks are complete, just output {complete_marker}",
  "- Work autonomously in small, verifiable iterations to complete the requested task.",
  "- Make concrete progress in the repository.",
  "- If blocked, explain the blocker clearly. Use AskUserQuestion. Only use it if you can't proceed.",
  "- Use @progress.md and @prd.md as primary context and keep them updated as work progresses.",
  "- At the end of each iteration, summarize progress and mark task as complete if its done.",
].join("\n");

const switchSessionTypeHotkey: Hotkey = "Alt+Tab";

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

  const [sessionType, setSessionType] = useState<SessionType>("claude");

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
  const projectName = getProjectNameFromPath(projectPath);

  const closeDialog = () => {
    setSessionType("claude");
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
              setSessionType(value as SessionType);
            }
          }}
          className="w-full"
        >
          {SESSION_TYPE_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="flex-1"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {sessionType === "claude" ? (
          <LocalClaudeSessionForm key={`claude-${openProjectCwd}`} />
        ) : sessionType === "ralphLoop" ? (
          <RalphLoopSessionForm key={`ralph-loop-${openProjectCwd}`} />
        ) : (
          <LocalTerminalSessionForm key={`terminal-${openProjectCwd}`} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LocalClaudeSessionForm() {
  const openProjectCwd = useNewSessionDialogStore((s) => s.openProjectCwd)!;
  const setOpenProjectCwd = useNewSessionDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const project = useAppState(
    (state) =>
      state.projects.find((item) => item.path === openProjectCwd) ?? null,
  );
  const projectPath = project?.path ?? openProjectCwd;
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);

  const [initialPrompt, setInitialPrompt] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [model, setModel] = useState<ClaudeModel>(
    project?.defaultModel ?? "opus",
  );
  const [effort, setEffort] = useState<ClaudeEffort | undefined>(
    project?.defaultEffort,
  );
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>(
    project?.defaultPermissionMode ?? "default",
  );
  const [haikuModelOverride, setHaikuModelOverride] = useState<
    ClaudeModel | undefined
  >(project?.defaultHaikuModelOverride);
  const [subagentModelOverride, setSubagentModelOverride] = useState<
    ClaudeModel | undefined
  >(project?.defaultSubagentModelOverride);
  const [systemPrompt, setSystemPrompt] = useState(
    project?.defaultSystemPrompt ?? "",
  );
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
        setOpenProjectCwd(null);
      },
      onError: handleError,
    }),
  );

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        startSession.mutate({
          cwd: projectPath,
          cols: 80,
          rows: 24,
          initialPrompt: initialPrompt || undefined,
          sessionName: sessionName || undefined,
          model,
          effort,
          haikuModelOverride,
          subagentModelOverride,
          systemPrompt: systemPrompt || undefined,
          permissionMode,
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
        permissionMode={permissionMode}
        onPermissionModeChange={(value) => {
          setPermissionMode(value);
        }}
      />

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
          <EffortToggleGroup
            label="Effort"
            effort={effort}
            onEffortChange={setEffort}
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

          <div className="space-y-2">
            <Label>Override haiku model</Label>
            <Select
              value={haikuModelOverride ?? "no"}
              onValueChange={(value) => {
                setHaikuModelOverride(
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
              value={subagentModelOverride ?? "no"}
              onValueChange={(value) => {
                setSubagentModelOverride(
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
            <Label htmlFor="new-session-system-prompt">
              System prompt (optional)
            </Label>
            <Textarea
              id="new-session-system-prompt"
              placeholder="Custom system prompt passed via --system-prompt"
              value={systemPrompt}
              onChange={(event) => {
                setSystemPrompt(event.target.value);
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
          onClick={() => setOpenProjectCwd(null)}
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

function RalphLoopSessionForm() {
  const openProjectCwd = useNewSessionDialogStore((s) => s.openProjectCwd)!;
  const setOpenProjectCwd = useNewSessionDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const project = useAppState(
    (state) =>
      state.projects.find((item) => item.path === openProjectCwd) ?? null,
  );
  const projectPath = project?.path ?? openProjectCwd;
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);

  const [objectivePrompt, setObjectivePrompt] = useState(
    DEFAULT_RALPH_LOOP_OBJECTIVE_PROMPT,
  );
  const [sessionName, setSessionName] = useState("");
  const [model, setModel] = useState<ClaudeModel>(
    project?.defaultModel ?? "opus",
  );
  const [effort, setEffort] = useState<ClaudeEffort | undefined>(
    project?.defaultEffort,
  );
  const [permissionMode, setPermissionMode] =
    useState<ClaudePermissionMode>("yolo");
  const [systemPrompt, setSystemPrompt] = useState(
    project?.defaultSystemPrompt ?? "",
  );
  const [maxIterations, setMaxIterations] = useState("20");
  const [maxConsecutiveFailures, setMaxConsecutiveFailures] = useState("3");
  const [backoffInitialMs, setBackoffInitialMs] = useState("3000");
  const [backoffMaxMs, setBackoffMaxMs] = useState("60000");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const toOptionalPositiveInt = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  };

  const toOptionalNonNegativeInt = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  };

  const handleError = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) {
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage("Failed to start ralph-loop session.");
  };

  const startSession = useMutation(
    orpc.sessions.ralphLoop.startSession.mutationOptions({
      onSuccess: (result) => {
        setActiveSessionId(result.sessionId);
        setOpenProjectCwd(null);
      },
      onError: handleError,
    }),
  );

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        startSession.mutate({
          cwd: projectPath,
          cols: 80,
          rows: 24,
          objectivePrompt: objectivePrompt.trim(),
          sessionName: sessionName.trim() || undefined,
          model,
          effort,
          permissionMode,
          systemPrompt: systemPrompt.trim() || undefined,
          maxIterations: toOptionalPositiveInt(maxIterations) ?? undefined,
          maxConsecutiveFailures:
            toOptionalNonNegativeInt(maxConsecutiveFailures) ?? undefined,
          backoffInitialMs:
            toOptionalPositiveInt(backoffInitialMs) ?? undefined,
          backoffMaxMs: toOptionalPositiveInt(backoffMaxMs) ?? undefined,
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

    if (!objectivePrompt.trim()) {
      setErrorMessage("Objective prompt is required.");
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
        <Label htmlFor="new-ralph-loop-objective">Objective prompt</Label>
        <Textarea
          id="new-ralph-loop-objective"
          autoFocus
          placeholder="Describe the objective for autonomous iterations"
          value={objectivePrompt}
          onChange={(event) => {
            setObjectivePrompt(event.target.value);
          }}
          rows={4}
        />
      </div>

      <PermissionModeToggleGroup
        label="Permission mode"
        permissionMode={permissionMode}
        onPermissionModeChange={(value) => {
          setPermissionMode(value);
        }}
      />

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
          <EffortToggleGroup
            label="Effort"
            effort={effort}
            onEffortChange={setEffort}
          />

          <div className="space-y-2">
            <Label htmlFor="new-ralph-loop-name">Session name (optional)</Label>
            <Input
              id="new-ralph-loop-name"
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

          <div className="space-y-2">
            <Label htmlFor="new-ralph-loop-system-prompt">
              System prompt (optional)
            </Label>
            <Textarea
              id="new-ralph-loop-system-prompt"
              placeholder="Custom system prompt passed via --system-prompt"
              value={systemPrompt}
              onChange={(event) => {
                setSystemPrompt(event.target.value);
              }}
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="new-ralph-loop-max-iterations">
                Max iterations
              </Label>
              <Input
                id="new-ralph-loop-max-iterations"
                value={maxIterations}
                onChange={(event) => {
                  setMaxIterations(event.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-ralph-loop-max-failures">
                Max consecutive failures
              </Label>
              <Input
                id="new-ralph-loop-max-failures"
                value={maxConsecutiveFailures}
                onChange={(event) => {
                  setMaxConsecutiveFailures(event.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-ralph-loop-backoff-initial">
                Initial backoff (ms)
              </Label>
              <Input
                id="new-ralph-loop-backoff-initial"
                value={backoffInitialMs}
                onChange={(event) => {
                  setBackoffInitialMs(event.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-ralph-loop-backoff-max">
                Max backoff (ms)
              </Label>
              <Input
                id="new-ralph-loop-backoff-max"
                value={backoffMaxMs}
                onChange={(event) => {
                  setBackoffMaxMs(event.target.value);
                }}
              />
            </div>
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
          onClick={() => setOpenProjectCwd(null)}
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

function LocalTerminalSessionForm() {
  const openProjectCwd = useNewSessionDialogStore((s) => s.openProjectCwd)!;
  const setOpenProjectCwd = useNewSessionDialogStore(
    (s) => s.setOpenProjectCwd,
  );
  const project = useAppState(
    (state) =>
      state.projects.find((item) => item.path === openProjectCwd) ?? null,
  );
  const projectPath = project?.path ?? openProjectCwd;
  const setActiveSessionId = useActiveSessionStore((s) => s.setActiveSessionId);

  const [sessionName, setSessionName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleError = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) {
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage("Failed to start session.");
  };

  const startSession = useMutation(
    orpc.sessions.localTerminal.startSession.mutationOptions({
      onSuccess: (result) => {
        setActiveSessionId(result.sessionId);
        setOpenProjectCwd(null);
      },
      onError: handleError,
    }),
  );

  const ensureProject = useMutation(
    orpc.projects.addProject.mutationOptions({
      onSuccess: () => {
        startSession.mutate({
          cwd: projectPath,
          sessionName: sessionName || undefined,
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
        <Label htmlFor="new-terminal-session-name">
          Session name (optional)
        </Label>
        <Input
          id="new-terminal-session-name"
          autoFocus
          placeholder="Leave blank for generated name"
          value={sessionName}
          onChange={(event) => {
            setSessionName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
            }
          }}
        />
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
          onClick={() => setOpenProjectCwd(null)}
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
