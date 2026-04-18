import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { z } from "zod";
import { defineServiceState } from "../shared/service-state";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";
import { assertProjectPathInteractionAllowed } from "./project-service";
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
  bufferedOutput: z.string().optional(),
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
  cwd: string;
  terminalId: string;
  terminal: ManagedTerminalRuntime;
  shellMonitor: ShellIntegrationMonitor;
  dispose: () => Promise<void>;
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
      context.projectTerminalsManager.ensureWorkspace(input);
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
      return context.projectTerminalsManager.createTerminal(input);
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
      context.projectTerminalsManager.selectTerminal(input);
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

  constructor(
    private readonly state: ProjectTerminalsState,
    private readonly shellIntegrationEnv: Record<string, string> = {},
    private readonly terminalManager: TerminalManager = new TerminalManager(),
  ) {
    for (const workspace of Object.values(this.state.state)) {
      for (const terminalId of Object.keys(workspace.terminals)) {
        this.terminalManager.registerTerminal(terminalId, {
          interactionCwd: workspace.cwd,
        });
      }
    }
  }

  ensureWorkspace({
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
      this.createTerminal({ cwd, cols, rows });
      return;
    }

    if (!existing.selectedTerminalId) {
      return;
    }

    this.startLiveTerminal({
      cwd,
      terminalId: existing.selectedTerminalId,
      cols,
      rows,
    });
  }

  createTerminal({
    cwd,
    cols,
    rows,
  }: {
    cwd: string;
    cols?: number;
    rows?: number;
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
        title: `Terminal ${ordinal}`,
        cwd,
        createdAt: now,
        lastActivityAt: now,
        status: "stopped",
      };
      workspace.order.push(terminalId);
      workspace.selectedTerminalId = terminalId;
      workspace.nextTerminalOrdinal = ordinal + 1;
      state[cwd] = workspace;
    });

    this.startLiveTerminal({ cwd, terminalId, cols, rows });

    return { terminalId };
  }

  selectTerminal({ cwd, terminalId }: { cwd: string; terminalId: string }) {
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

    this.startLiveTerminal({ cwd, terminalId });
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

  private startLiveTerminal({
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
    if (this.liveTerminals.has(terminalId)) {
      return;
    }

    const workspace = this.state.state[cwd];
    const terminalState = workspace?.terminals[terminalId];
    if (!terminalState) {
      return;
    }

    const disposable = createDisposable({
      onError: () => {},
    });

    const shellMonitor = new ShellIntegrationMonitor({
      onActivityChange: (activity) => {
        const live = this.liveTerminals.get(terminalId);
        if (!live || live.terminal.status !== "running") return;
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          terminal.status = activity === "running" ? "running" : "idle";
        });
      },
    });

    const terminal = this.terminalManager.startTerminal({
      terminalId,
      access: {
        interactionCwd: cwd,
      },
      launch: {
        runWithShell: true,
        cwd,
        cols,
        rows,
        env: this.shellIntegrationEnv,
      },
      transformOutputChunk: (chunk) => shellMonitor.processChunk(chunk),
      onData: () => {
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          terminal.lastActivityAt = Date.now();
        });
      },
      onStatusChange: (status) => {
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
        this.liveTerminals.delete(terminalId);
        this.updateTerminalState(cwd, terminalId, (terminal) => {
          terminal.status = payload.errorMessage ? "error" : "stopped";
          terminal.errorMessage = payload.errorMessage;
        });
      },
    });

    disposable.addDisposable(() => terminal.stop());

    this.liveTerminals.set(terminalId, {
      cwd,
      terminalId,
      terminal,
      shellMonitor,
      dispose: disposable.dispose,
    });
    disposable.addDisposable(() => this.liveTerminals.delete(terminalId));

    if (!this.terminalManager.getRuntime(terminalId)) {
      void disposable.dispose();
    }
  }

  private async stopLiveTerminal(terminalId: string) {
    const liveTerminal = this.liveTerminals.get(terminalId);
    if (!liveTerminal) {
      return;
    }

    await liveTerminal.dispose();
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
