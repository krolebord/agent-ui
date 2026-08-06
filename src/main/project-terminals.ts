import path from "node:path";
import type { ResolvedProjectCommand } from "@shared/project-commands";
import type { TerminalEvent } from "@shared/terminal-types";
import { z } from "zod";
import { defineServiceState } from "../shared/service-state";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";
import { assertProjectPathInteractionAllowed } from "./project-service";
import {
  PROJECT_SETTINGS_RELATIVE_PATH,
  readProjectCommands,
} from "./project-settings-file";
import {
  generateUniqueSessionId,
  sessionStatusSchema,
} from "./sessions/common";
import { ShellIntegrationMonitor } from "./shell-integration/osc-parser";
import {
  type ManagedTerminalRuntime,
  TerminalManager,
} from "./terminal-manager";

export const projectTerminalInstanceSchema = z.object({
  terminalId: z.string(),
  title: z.string().catch("Terminal"),
  cwd: z.string(),
  createdAt: z.number().default(Date.now()),
  lastActivityAt: z.number().default(Date.now()),
  status: sessionStatusSchema.catch("stopped"),
  errorMessage: z.string().optional(),
  /** Set when the tab was opened from a `.agent-ui` command preset. */
  commandId: z.string().optional().catch(undefined),
  /**
   * Absolute directory the PTY was spawned in. Only differs from the workspace
   * cwd when a preset declares its own `cwd`.
   */
  launchCwd: z.string().optional().catch(undefined),
});
export type ProjectTerminalInstanceData = z.infer<
  typeof projectTerminalInstanceSchema
>;

export const projectTerminalWorkspaceSchema = z.object({
  cwd: z.string(),
  selectedTerminalId: z.string().nullable().catch(null),
  nextTerminalOrdinal: z.number().int().positive().catch(1),
  order: z.array(z.string()).catch([]),
  terminals: z.record(z.string(), projectTerminalInstanceSchema).catch({}),
});
export type ProjectTerminalWorkspaceData = z.infer<
  typeof projectTerminalWorkspaceSchema
>;

function normalizeWorkspace(
  workspace: ProjectTerminalWorkspaceData,
): ProjectTerminalWorkspaceData {
  const terminals: Record<string, ProjectTerminalInstanceData> = {};
  const seen = new Set<string>();
  const order: string[] = [];

  for (const terminalId of workspace.order) {
    const terminal = workspace.terminals[terminalId];
    if (!terminal || seen.has(terminalId)) {
      continue;
    }
    seen.add(terminalId);
    order.push(terminalId);
    terminals[terminalId] = {
      ...terminal,
      terminalId,
      cwd: workspace.cwd,
    };
  }

  for (const [terminalId, terminal] of Object.entries(workspace.terminals)) {
    if (seen.has(terminalId)) {
      continue;
    }
    seen.add(terminalId);
    order.push(terminalId);
    terminals[terminalId] = {
      ...terminal,
      terminalId,
      cwd: workspace.cwd,
    };
  }

  const selectedTerminalId =
    workspace.selectedTerminalId && terminals[workspace.selectedTerminalId]
      ? workspace.selectedTerminalId
      : (order[0] ?? null);

  return {
    cwd: workspace.cwd,
    selectedTerminalId,
    nextTerminalOrdinal: Math.max(1, Math.floor(workspace.nextTerminalOrdinal)),
    order,
    terminals,
  };
}

const projectTerminalStateSchema = z
  .record(z.string(), projectTerminalWorkspaceSchema)
  .transform((workspaces) => {
    const normalized: Record<string, ProjectTerminalWorkspaceData> = {};
    for (const [cwd, workspace] of Object.entries(workspaces)) {
      normalized[cwd] = normalizeWorkspace({
        ...workspace,
        cwd,
      });
    }
    return normalized;
  });

export const defineProjectTerminalsState = () =>
  defineServiceState({
    key: "projectTerminals" as const,
    defaults: {} as Record<string, ProjectTerminalWorkspaceData>,
  });

export type ProjectTerminalsState = ReturnType<
  typeof defineProjectTerminalsState
>;

export const defineProjectTerminalsPersistence = (
  state: ProjectTerminalsState,
) =>
  defineStatePersistence({
    serviceState: state,
    schema: projectTerminalStateSchema,
  });

interface LiveProjectTerminal {
  token: object;
  cwd: string;
  terminalId: string;
  terminal: ManagedTerminalRuntime;
  shellMonitor: ShellIntegrationMonitor;
  /** Command text waiting for the shell to reach a prompt. */
  pendingInput: string | null;
  pendingInputTimer: ReturnType<typeof setTimeout> | null;
  promptSeen: boolean;
  promptWaiters: Set<(seen: boolean) => void>;
  stopPromise: Promise<void> | null;
}

interface StartLiveTerminalOptions {
  cwd: string;
  terminalId: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/**
 * How long to wait for an OSC 133 prompt marker before typing anyway. Shells
 * without our integration (fish, plain sh) never send one, and typing early is
 * better than never running the command.
 */
const PROMPT_WAIT_TIMEOUT_MS = 1500;

/**
 * The precmd marker arrives just before the shell paints its prompt. Typing in
 * that gap echoes the command above the prompt and then again inside it, so
 * hold back briefly and let the prompt land first.
 */
const PROMPT_PAINT_DELAY_MS = 120;
const RERUN_INTERRUPT_TIMEOUT_MS = 3000;

/**
 * Resolves a preset's project-relative `cwd`, refusing anything that escapes
 * the project the preset was read from.
 */
function resolveCommandCwd(projectPath: string, relativePath?: string): string {
  if (!relativePath) {
    return projectPath;
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("Command cwd must be a project-relative path.");
  }
  const absolutePath = path.resolve(projectPath, relativePath);
  const relative = path.relative(projectPath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Command cwd must stay inside the project.");
  }
  return absolutePath;
}

function selectAdjacentTerminalId(
  order: string[],
  selectedTerminalId: string | null,
  terminalId: string,
): string | null {
  if (selectedTerminalId !== terminalId) {
    return selectedTerminalId;
  }

  const currentIndex = order.indexOf(terminalId);
  if (currentIndex === -1) {
    return order[0] ?? null;
  }

  return order[currentIndex + 1] ?? order[currentIndex - 1] ?? null;
}

export const projectTerminalsRouter = {
  ensureWorkspace: procedure
    .input(
      z.object({
        cwd: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.cwd, context);
      await context.projectTerminalsManager.ensureWorkspace(input);
    }),
  createTerminal: procedure
    .input(
      z.object({
        cwd: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.cwd, context);
      return await context.projectTerminalsManager.createTerminal(input);
    }),
  runCommand: procedure
    .input(
      z.object({
        cwd: z.string(),
        commandId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.cwd, context);
      return context.projectTerminalsManager.runCommand(input);
    }),
  rerunCommand: procedure
    .input(
      z.object({
        cwd: z.string(),
        terminalId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.cwd, context);
      return context.projectTerminalsManager.rerunCommand(input);
    }),
  selectTerminal: procedure
    .input(
      z.object({
        cwd: z.string(),
        terminalId: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.cwd, context);
      await context.projectTerminalsManager.selectTerminal(input);
    }),
  closeTerminal: procedure
    .input(
      z.object({
        cwd: z.string(),
        terminalId: z.string(),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.cwd, context);
      await context.projectTerminalsManager.closeTerminal(input);
    }),
  subscribeToTerminal: procedure
    .input(z.object({ terminalId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const cwd = context.projectTerminalsManager.resolveTerminalWorkspaceCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(cwd, context);

      const { snapshot, stream, isLive } =
        await context.projectTerminalsManager.subscribeToTerminalEvents(
          input.terminalId,
          signal,
        );

      if (isLive) {
        yield { type: "clear" } as TerminalEvent;
        if (snapshot) {
          yield { type: "data", data: snapshot } as TerminalEvent;
        }
      }

      for await (const event of stream) {
        yield event as TerminalEvent;
      }
    }),
  writeToTerminal: procedure
    .input(z.object({ terminalId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      const cwd = context.projectTerminalsManager.resolveTerminalWorkspaceCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(cwd, context);
      context.projectTerminalsManager.writeToTerminal(input);
    }),
  resizeTerminal: procedure
    .input(
      z.object({
        terminalId: z.string(),
        cols: z.number(),
        rows: z.number(),
      }),
    )
    .handler(async ({ input, context }) => {
      const cwd = context.projectTerminalsManager.resolveTerminalWorkspaceCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(cwd, context);
      context.projectTerminalsManager.resizeTerminal(input);
    }),
};

export class ProjectTerminalsManager {
  readonly liveTerminals = new Map<string, LiveProjectTerminal>();
  private readonly pendingStarts = new Map<string, Promise<void>>();

  constructor(
    private readonly state: ProjectTerminalsState,
    private readonly shellIntegrationEnv: Record<string, string> = {},
    private readonly terminalManager: TerminalManager = new TerminalManager(),
    /**
     * Maps a worktree cwd back to its main checkout, which is what command
     * presets see as `$PROJECT_ROOT`.
     */
    private readonly resolveProjectRoot: (
      cwd: string,
    ) => string | undefined = () => undefined,
  ) {
    for (const workspace of Object.values(this.state.state)) {
      for (const terminalId of Object.keys(workspace.terminals)) {
        this.terminalManager.registerTerminal(terminalId, {
          interactionCwd: workspace.cwd,
        });
      }
    }
  }

  async ensureWorkspace({
    cwd,
    cols,
    rows,
  }: {
    cwd: string;
    cols?: number;
    rows?: number;
  }) {
    const existing = this.state.state[cwd];
    if (!existing) {
      await this.createTerminal({ cwd, cols, rows });
      return;
    }

    if (!existing.selectedTerminalId) {
      return;
    }

    await this.startLiveTerminal({
      cwd,
      terminalId: existing.selectedTerminalId,
      cols,
      rows,
    });
  }

  async createTerminal({
    cwd,
    cols,
    rows,
    title,
    commandId,
    launchCwd,
    env,
  }: {
    cwd: string;
    cols?: number;
    rows?: number;
    title?: string;
    commandId?: string;
    launchCwd?: string;
    env?: Record<string, string>;
  }) {
    const terminalId = generateUniqueSessionId();
    const now = Date.now();
    this.terminalManager.registerTerminal(terminalId, {
      interactionCwd: cwd,
    });

    this.state.updateState((state) => {
      const workspace = state[cwd] ?? {
        cwd,
        selectedTerminalId: null,
        nextTerminalOrdinal: 1,
        order: [],
        terminals: {},
      };
      const ordinal = workspace.nextTerminalOrdinal;

      workspace.terminals[terminalId] = {
        terminalId,
        title: title ?? `Terminal ${ordinal}`,
        cwd,
        createdAt: now,
        lastActivityAt: now,
        status: "stopped",
        commandId,
        launchCwd: launchCwd && launchCwd !== cwd ? launchCwd : undefined,
      };
      workspace.order.push(terminalId);
      workspace.selectedTerminalId = terminalId;
      workspace.nextTerminalOrdinal = ordinal + 1;
      state[cwd] = workspace;
    });

    await this.startLiveTerminal({ cwd, terminalId, cols, rows, env });

    return { terminalId };
  }

  /**
   * Opens (or focuses) a terminal running a `.agent-ui` command preset. The
   * preset is resolved from disk here rather than trusted from the renderer, so
   * a stale dropdown can never launch a command the file no longer defines.
   */
  async runCommand({
    cwd,
    commandId,
    cols,
    rows,
  }: {
    cwd: string;
    commandId: string;
    cols?: number;
    rows?: number;
  }) {
    const command = await this.resolveCommand(cwd, commandId);
    const launchCwd = resolveCommandCwd(cwd, command.cwd);
    const env = this.buildCommandEnv(cwd, command);

    const workspace = this.state.state[cwd];
    const existingTerminalId = command.singleton
      ? workspace?.order.find(
          (terminalId) =>
            workspace.terminals[terminalId]?.commandId === command.id,
        )
      : undefined;

    if (existingTerminalId) {
      this.state.updateState((state) => {
        const draftWorkspace = state[cwd];
        const terminal = draftWorkspace?.terminals[existingTerminalId];
        if (!draftWorkspace || !terminal) {
          return;
        }
        terminal.title = command.name;
        terminal.launchCwd = launchCwd !== cwd ? launchCwd : undefined;
        draftWorkspace.selectedTerminalId = existingTerminalId;
      });
      await this.startLiveTerminal({
        cwd,
        terminalId: existingTerminalId,
        cols,
        rows,
        env,
      });

      // Something is already running in that shell — a dev server, most
      // likely. Focus it instead of stacking a second copy on top.
      const live = this.liveTerminals.get(existingTerminalId);
      if (live?.shellMonitor.getState() === "running") {
        return { terminalId: existingTerminalId, started: false };
      }

      this.queueCommandInput(existingTerminalId, command.run);
      return { terminalId: existingTerminalId, started: true };
    }

    const { terminalId } = await this.createTerminal({
      cwd,
      cols,
      rows,
      title: command.name,
      commandId: command.id,
      launchCwd,
      env,
    });
    this.queueCommandInput(terminalId, command.run);
    return { terminalId, started: true };
  }

  /**
   * Re-runs the preset behind an existing tab. A shell that is busy gets an
   * interrupt first, which is what makes this a restart for dev servers.
   */
  async rerunCommand({
    cwd,
    terminalId,
    cols,
    rows,
  }: {
    cwd: string;
    terminalId: string;
    cols?: number;
    rows?: number;
  }) {
    const terminalState = this.state.state[cwd]?.terminals[terminalId];
    if (!terminalState?.commandId) {
      throw new Error("This terminal was not started from a command.");
    }

    const command = await this.resolveCommand(cwd, terminalState.commandId);
    const launchCwd = resolveCommandCwd(cwd, command.cwd);
    const env = this.buildCommandEnv(cwd, command);

    this.state.updateState((state) => {
      const draftWorkspace = state[cwd];
      const terminal = draftWorkspace?.terminals[terminalId];
      if (!draftWorkspace || !terminal) {
        return;
      }
      terminal.title = command.name;
      terminal.launchCwd = launchCwd !== cwd ? launchCwd : undefined;
      draftWorkspace.selectedTerminalId = terminalId;
    });

    await this.startLiveTerminal({ cwd, terminalId, cols, rows, env });

    let live = this.liveTerminals.get(terminalId);
    if (live?.shellMonitor.getState() === "running") {
      this.terminalManager.writeToTerminal(terminalId, "\x03");
      const promptReturned = await this.waitForNextPrompt(
        live,
        RERUN_INTERRUPT_TIMEOUT_MS,
      );
      if (!promptReturned) {
        await this.stopLiveTerminal(terminalId);
        await this.startLiveTerminal({ cwd, terminalId, cols, rows, env });
        live = this.liveTerminals.get(terminalId);
      }
    }

    if (!live) {
      throw new Error("Failed to restart terminal for command rerun.");
    }
    this.queueCommandInput(terminalId, command.run);
    return { terminalId };
  }

  async selectTerminal({
    cwd,
    terminalId,
  }: {
    cwd: string;
    terminalId: string;
  }) {
    const workspace = this.state.state[cwd];
    if (!workspace?.terminals[terminalId]) {
      return;
    }

    this.state.updateState((state) => {
      const draftWorkspace = state[cwd];
      if (!draftWorkspace?.terminals[terminalId]) {
        return;
      }
      draftWorkspace.selectedTerminalId = terminalId;
    });

    await this.startLiveTerminal({ cwd, terminalId });
  }

  async closeTerminal({
    cwd,
    terminalId,
  }: {
    cwd: string;
    terminalId: string;
  }) {
    await this.stopLiveTerminal(terminalId);
    await this.terminalManager.unregisterTerminal(terminalId);

    this.state.updateState((state) => {
      const workspace = state[cwd];
      if (!workspace?.terminals[terminalId]) {
        return;
      }

      const nextOrder = workspace.order.filter((id) => id !== terminalId);
      const nextSelectedTerminalId = selectAdjacentTerminalId(
        nextOrder,
        workspace.selectedTerminalId,
        terminalId,
      );

      delete workspace.terminals[terminalId];
      workspace.order = nextOrder;
      workspace.selectedTerminalId = nextSelectedTerminalId;
    });
  }

  resolveTerminalWorkspaceCwd(terminalId: string): string | undefined {
    return (
      this.liveTerminals.get(terminalId)?.cwd ??
      this.findTerminalState(terminalId)?.cwd
    );
  }

  async deleteWorkspace(cwd: string) {
    const workspace = this.state.state[cwd];
    if (!workspace) {
      return;
    }

    await Promise.all(
      Object.keys(workspace.terminals).map(async (terminalId) => {
        await this.stopLiveTerminal(terminalId);
        await this.terminalManager.unregisterTerminal(terminalId);
      }),
    );

    this.state.updateState((state) => {
      delete state[cwd];
    });
  }

  writeToTerminal({ terminalId, data }: { terminalId: string; data: string }) {
    this.terminalManager.writeToTerminal(terminalId, data);
  }

  resizeTerminal({
    terminalId,
    cols,
    rows,
  }: {
    terminalId: string;
    cols: number;
    rows: number;
  }) {
    this.terminalManager.resizeTerminal(terminalId, cols, rows);
  }

  subscribeToTerminalEvents(terminalId: string, signal?: AbortSignal) {
    return this.terminalManager.subscribeToTerminalEvents(terminalId, signal);
  }

  async dispose(): Promise<void> {
    const terminalIds = [...this.liveTerminals.keys()];
    await Promise.allSettled(
      terminalIds.map(async (terminalId) => {
        await this.stopLiveTerminal(terminalId);
      }),
    );
  }

  /**
   * Reads the preset from the worktree's own settings file, falling back to the
   * main checkout for worktrees that predate the file being added.
   */
  private async resolveCommand(
    cwd: string,
    commandId: string,
  ): Promise<ResolvedProjectCommand> {
    let commands = await readProjectCommands(cwd);
    const projectRoot = this.resolveProjectRoot(cwd);
    if (commands.length === 0 && projectRoot && projectRoot !== cwd) {
      commands = await readProjectCommands(projectRoot);
    }

    const command = commands.find((entry) => entry.id === commandId);
    if (!command) {
      throw new Error(
        `Command "${commandId}" is no longer defined in ${PROJECT_SETTINGS_RELATIVE_PATH}.`,
      );
    }
    return command;
  }

  private buildCommandEnv(cwd: string, command: ResolvedProjectCommand) {
    return {
      ...this.shellIntegrationEnv,
      PROJECT_ROOT: this.resolveProjectRoot(cwd) ?? cwd,
      WORKTREE_ROOT: cwd,
      ...command.env,
    };
  }

  /**
   * Types a command into the shell rather than launching it as the PTY program:
   * interrupting it then leaves a usable shell in the right directory instead of
   * closing the tab.
   */
  private queueCommandInput(terminalId: string, run: string) {
    const live = this.liveTerminals.get(terminalId);
    if (!live) {
      return;
    }

    live.pendingInput = `${run}\n`;

    // A shell already sitting at a prompt won't announce another one, so there
    // is nothing to wait for beyond the paint delay.
    this.scheduleFlush(
      terminalId,
      live.promptSeen && live.shellMonitor.getState() === "idle"
        ? PROMPT_PAINT_DELAY_MS
        : PROMPT_WAIT_TIMEOUT_MS,
    );
  }

  private scheduleFlush(terminalId: string, delayMs: number) {
    const live = this.liveTerminals.get(terminalId);
    if (!live?.pendingInput) {
      return;
    }

    if (live.pendingInputTimer) {
      clearTimeout(live.pendingInputTimer);
    }
    live.pendingInputTimer = setTimeout(() => {
      this.flushPendingInput(terminalId);
    }, delayMs);
    live.pendingInputTimer.unref?.();
  }

  private flushPendingInput(terminalId: string) {
    const live = this.liveTerminals.get(terminalId);
    if (!live?.pendingInput) {
      return;
    }

    const data = live.pendingInput;
    live.pendingInput = null;
    if (live.pendingInputTimer) {
      clearTimeout(live.pendingInputTimer);
      live.pendingInputTimer = null;
    }
    this.terminalManager.writeToTerminal(terminalId, data);
  }

  private async startLiveTerminal(
    options: StartLiveTerminalOptions,
  ): Promise<void> {
    const pendingStart = this.pendingStarts.get(options.terminalId);
    if (pendingStart) {
      await pendingStart;
      return;
    }

    const startPromise = this.startLiveTerminalOnce(options);
    this.pendingStarts.set(options.terminalId, startPromise);
    try {
      await startPromise;
    } finally {
      if (this.pendingStarts.get(options.terminalId) === startPromise) {
        this.pendingStarts.delete(options.terminalId);
      }
    }
  }

  private async startLiveTerminalOnce({
    cwd,
    terminalId,
    cols,
    rows,
    env,
  }: StartLiveTerminalOptions): Promise<void> {
    const existingLiveTerminal = this.liveTerminals.get(terminalId);
    if (existingLiveTerminal) {
      if (existingLiveTerminal.terminal.status !== "stopping") {
        return;
      }
      await this.stopLiveTerminal(terminalId);
    }

    const workspace = this.state.state[cwd];
    const terminalState = workspace?.terminals[terminalId];
    if (!terminalState) {
      return;
    }

    const token = {};
    let lifecycleActive = true;

    const shellMonitor = new ShellIntegrationMonitor({
      onActivityChange: (activity) => {
        if (!lifecycleActive) return;
        const live = this.liveTerminals.get(terminalId);
        if (!live || live.token !== token || live.terminal.status !== "running")
          return;
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          terminal.status = activity === "running" ? "running" : "idle";
        });
      },
      onPrompt: () => {
        if (!lifecycleActive) return;
        const live = this.liveTerminals.get(terminalId);
        if (!live || live.token !== token) return;
        live.promptSeen = true;
        for (const resolve of live.promptWaiters) {
          resolve(true);
        }
        live.promptWaiters.clear();
        this.scheduleFlush(terminalId, PROMPT_PAINT_DELAY_MS);
      },
    });

    const terminal = await this.terminalManager.startTerminal({
      terminalId,
      access: {
        interactionCwd: cwd,
      },
      launch: {
        runWithShell: true,
        cwd: terminalState.launchCwd ?? cwd,
        cols,
        rows,
        env: env ?? this.shellIntegrationEnv,
      },
      transformOutputChunk: (chunk) => shellMonitor.processChunk(chunk),
      onData: () => {
        if (!lifecycleActive) return;
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          terminal.lastActivityAt = Date.now();
        });
      },
      onStatusChange: (status) => {
        if (!lifecycleActive) return;
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          if (status === "running") {
            terminal.status =
              shellMonitor.getState() === "running" ? "running" : "idle";
          } else {
            terminal.status = status;
          }
          if (status !== "error") {
            terminal.errorMessage = undefined;
          }
        });
      },
      onExit: (payload) => {
        const live = this.liveTerminals.get(terminalId);
        if (live?.token === token) {
          this.cleanupLiveTerminal(live);
        }
        lifecycleActive = false;
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          terminal.status = payload.errorMessage ? "error" : "stopped";
          terminal.errorMessage = payload.errorMessage;
        });
      },
    });

    // A synchronous spawn failure can complete before startTerminal resolves.
    if (this.terminalManager.getRuntime(terminalId) !== terminal) {
      return;
    }

    const liveTerminal: LiveProjectTerminal = {
      token,
      cwd,
      terminalId,
      terminal,
      shellMonitor,
      pendingInput: null,
      pendingInputTimer: null,
      promptSeen: false,
      promptWaiters: new Set(),
      stopPromise: null,
    };
    this.liveTerminals.set(terminalId, liveTerminal);
  }

  private async stopLiveTerminal(terminalId: string) {
    const liveTerminal = this.liveTerminals.get(terminalId);
    if (!liveTerminal) {
      return;
    }

    if (liveTerminal.stopPromise) {
      await liveTerminal.stopPromise;
      return;
    }

    liveTerminal.stopPromise = (async () => {
      await liveTerminal.terminal.stop();
      this.cleanupLiveTerminal(liveTerminal);
    })();
    await liveTerminal.stopPromise;
  }

  private cleanupLiveTerminal(liveTerminal: LiveProjectTerminal) {
    if (liveTerminal.pendingInputTimer) {
      clearTimeout(liveTerminal.pendingInputTimer);
      liveTerminal.pendingInputTimer = null;
    }
    for (const resolve of liveTerminal.promptWaiters) {
      resolve(false);
    }
    liveTerminal.promptWaiters.clear();
    if (this.liveTerminals.get(liveTerminal.terminalId) === liveTerminal) {
      this.liveTerminals.delete(liveTerminal.terminalId);
    }
  }

  private waitForNextPrompt(
    liveTerminal: LiveProjectTerminal,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (seen: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        liveTerminal.promptWaiters.delete(finish);
        resolve(seen);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref?.();
      liveTerminal.promptWaiters.add(finish);
    });
  }

  private findTerminalState(terminalId: string) {
    for (const workspace of Object.values(this.state.state)) {
      const terminal = workspace.terminals[terminalId];
      if (terminal) {
        return terminal;
      }
    }

    return null;
  }

  private updateTerminalState(
    cwd: string,
    terminalId: string,
    updater: (terminal: ProjectTerminalInstanceData) => void,
  ) {
    this.state.updateState((state) => {
      const terminal = state[cwd]?.terminals[terminalId];
      if (!terminal) {
        return;
      }
      updater(terminal);
    });
  }
}
