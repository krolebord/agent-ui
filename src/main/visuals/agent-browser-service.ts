import { defineServiceState } from "@shared/service-state";
import { procedure } from "../orpc";
import type { AgentBrowserStatus } from "./agent-browser";

export type AgentBrowserState =
  | { status: "checking" }
  | { status: "available"; version: string; checkedAt: number }
  | { status: "unavailable"; error: string; checkedAt: number };

export const defineAgentBrowserState = () =>
  defineServiceState({
    key: "agentBrowser",
    defaults: { status: "checking" } as AgentBrowserState,
  });

export class AgentBrowserService {
  private pending: Promise<AgentBrowserState> | null = null;

  constructor(
    readonly state: ReturnType<typeof defineAgentBrowserState>,
    private readonly detect: () => Promise<AgentBrowserStatus>,
  ) {}

  get isUnavailable(): boolean {
    return this.state.state.status === "unavailable";
  }

  refresh(): Promise<AgentBrowserState> {
    this.pending ??= this.detect()
      .then(
        (status): AgentBrowserState =>
          status.available
            ? {
                status: "available",
                version: status.version,
                checkedAt: Date.now(),
              }
            : {
                status: "unavailable",
                error: status.error,
                checkedAt: Date.now(),
              },
        (error: unknown): AgentBrowserState => ({
          status: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        }),
      )
      .then((next) => {
        this.state.updateState(() => next);
        return next;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

export const agentBrowserRouter = {
  refresh: procedure.handler(
    async ({ context }) => await context.agentBrowser.refresh(),
  ),
};
