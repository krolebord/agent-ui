import { defineServiceState } from "@shared/service-state";
import { type UsageProvider, usageEntryKey } from "@shared/usage-keys";
import * as z from "zod";
import type { ClaudeAccountsService } from "./claude-accounts";
import {
  type UsageData as ClaudeUsageData,
  claudeUsageDataSchema,
  fetchUsageWithToken,
  getUsage as getClaudeUsage,
} from "./claude-usage";
import type { CodexAccountsService } from "./codex-accounts";
import type { CodexExternalAuthTokens } from "./codex-app-server-tracker";
import {
  type CodexUsageData,
  codexUsageDataSchema,
  getCodexUsage,
} from "./codex-usage";
import {
  type CursorUsageData,
  cursorUsageDataSchema,
  getCursorUsage,
} from "./cursor-usage";
import log from "./logger";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";
import type { CodexSessionsManager } from "./sessions/codex.session";

const REFRESH_INTERVAL_MS = 5 * 60_000;

const RELOGIN_MESSAGE = "Account needs to be logged in again";
const SETUP_TOKEN_MESSAGE =
  "Usage is unavailable for setup-token accounts (missing scope)";

export type UsageEntryStatus = "pending" | "ok" | "error" | "unsupported";

interface UsageEntryBase {
  accountId: string | null;
  status: UsageEntryStatus;
  error: string | null;
  fetchedAt: number | null;
  refreshing: boolean;
}

export interface ClaudeUsageEntry extends UsageEntryBase {
  provider: "claude";
  data: ClaudeUsageData | null;
}

export interface CodexUsageEntry extends UsageEntryBase {
  provider: "codex";
  data: CodexUsageData | null;
}

export interface CursorUsageEntry extends UsageEntryBase {
  provider: "cursor";
  data: CursorUsageData | null;
}

export type UsageEntry = ClaudeUsageEntry | CodexUsageEntry | CursorUsageEntry;

export interface UsageStateShape {
  entries: Record<string, UsageEntry>;
}

export function defineUsageState() {
  return defineServiceState({
    key: "usage" as const,
    defaults: { entries: {} } as UsageStateShape,
  });
}

export type UsageState = ReturnType<typeof defineUsageState>;

function usageEntrySchemaFor<
  TProvider extends UsageProvider,
  TData extends z.ZodTypeAny,
>(provider: TProvider, data: TData) {
  return z.object({
    provider: z.literal(provider),
    accountId: z.string().nullable(),
    status: z.enum(["pending", "ok", "error", "unsupported"]),
    error: z.string().nullable(),
    fetchedAt: z.number().nullable(),
    refreshing: z.boolean(),
    data: data.nullable(),
  });
}

const usagePersistenceSchema = z.object({
  entries: z
    .record(
      z.string(),
      z.discriminatedUnion("provider", [
        usageEntrySchemaFor("claude", claudeUsageDataSchema),
        usageEntrySchemaFor("codex", codexUsageDataSchema),
        usageEntrySchemaFor("cursor", cursorUsageDataSchema),
      ]),
    )
    .catch({}),
});

export function defineUsagePersistence(state: UsageState) {
  return defineStatePersistence({
    serviceState: state,
    schema: usagePersistenceSchema,
    toPersisted: (value: UsageStateShape) => ({
      entries: Object.fromEntries(
        Object.entries(value.entries).map(([key, entry]) => [
          key,
          { ...entry, refreshing: false },
        ]),
      ),
    }),
  });
}

interface UsageTarget {
  key: string;
  provider: UsageProvider;
  accountId: string | null;
  unsupportedReason?: string;
}

type FetchResult = { ok: true; data: unknown } | { ok: false; message: string };

export interface UsageRefreshResult {
  ok: boolean;
  message: string | null;
}

export interface UsageTrackerOptions {
  state: UsageState;
  claudeAccounts: Pick<
    ClaudeAccountsService,
    "publicState" | "getAccount" | "getValidAccessToken"
  >;
  codexAccounts: Pick<CodexAccountsService, "publicState" | "getExternalAuth">;
  codexSessions?: Pick<CodexSessionsManager, "readLiveAccountRateLimits">;
  refreshIntervalMs?: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function toFetchResult(result: {
  ok: boolean;
  usage?: unknown;
  message?: string;
}): FetchResult {
  if (result.ok && result.usage) {
    return { ok: true, data: result.usage };
  }
  return { ok: false, message: result.message ?? "Usage is unavailable" };
}

function createEntry(target: UsageTarget): UsageEntry {
  const base = {
    accountId: target.accountId,
    status: target.unsupportedReason
      ? ("unsupported" as const)
      : ("pending" as const),
    error: target.unsupportedReason ?? null,
    fetchedAt: null,
    refreshing: false,
  };

  switch (target.provider) {
    case "claude":
      return { ...base, provider: "claude", data: null };
    case "codex":
      return { ...base, provider: "codex", data: null };
    case "cursor":
      return { ...base, provider: "cursor", data: null };
  }
}

export class UsageTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private cycleInFlight = false;
  private readonly inFlight = new Set<string>();
  private readonly refreshIntervalMs: number;

  constructor(private readonly options: UsageTrackerOptions) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.options.claudeAccounts.publicState.eventTarget.addEventListener(
      "state-update",
      this.handleAccountsUpdate,
    );
    this.options.codexAccounts.publicState.eventTarget.addEventListener(
      "state-update",
      this.handleAccountsUpdate,
    );

    void this.runCycle();
  }

  dispose(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.disposed = true;

    this.options.claudeAccounts.publicState.eventTarget.removeEventListener(
      "state-update",
      this.handleAccountsUpdate,
    );
    this.options.codexAccounts.publicState.eventTarget.removeEventListener(
      "state-update",
      this.handleAccountsUpdate,
    );
    this.clearTimer();
  }

  async refreshAll(): Promise<void> {
    await this.runCycle();
  }

  async refresh(key: string): Promise<UsageRefreshResult> {
    const target = this.collectTargets().find((entry) => entry.key === key);
    if (!target) {
      return { ok: false, message: "Usage is not tracked for this account" };
    }
    if (target.unsupportedReason) {
      return { ok: false, message: target.unsupportedReason };
    }
    return await this.refreshTarget(target);
  }

  private readonly handleAccountsUpdate = (): void => {
    if (this.disposed) {
      return;
    }
    for (const target of this.syncEntries(this.collectTargets())) {
      void this.refreshTarget(target);
    }
  };

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight || this.disposed) {
      return;
    }
    this.cycleInFlight = true;

    try {
      const targets = this.collectTargets();
      this.syncEntries(targets);

      for (const target of targets) {
        if (this.disposed) {
          return;
        }
        if (target.unsupportedReason) {
          continue;
        }
        await this.refreshTarget(target);
      }
    } catch (error) {
      log.warn("Usage refresh cycle failed", error);
    } finally {
      this.cycleInFlight = false;
      this.scheduleNextCycle();
    }
  }

  private scheduleNextCycle(): void {
    if (this.disposed) {
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private collectTargets(): UsageTarget[] {
    const targets: UsageTarget[] = [
      {
        key: usageEntryKey("claude", null),
        provider: "claude",
        accountId: null,
      },
    ];

    for (const account of this.options.claudeAccounts.publicState.state
      .accounts) {
      targets.push({
        key: usageEntryKey("claude", account.id),
        provider: "claude",
        accountId: account.id,
        unsupportedReason:
          account.type === "setup-token"
            ? SETUP_TOKEN_MESSAGE
            : account.status === "needs-relogin"
              ? RELOGIN_MESSAGE
              : undefined,
      });
    }

    targets.push({
      key: usageEntryKey("codex", null),
      provider: "codex",
      accountId: null,
    });

    for (const account of this.options.codexAccounts.publicState.state
      .accounts) {
      targets.push({
        key: usageEntryKey("codex", account.id),
        provider: "codex",
        accountId: account.id,
        unsupportedReason:
          account.status === "needs-relogin" ? RELOGIN_MESSAGE : undefined,
      });
    }

    targets.push({
      key: usageEntryKey("cursor", null),
      provider: "cursor",
      accountId: null,
    });

    return targets;
  }

  private syncEntries(targets: UsageTarget[]): UsageTarget[] {
    const wantedKeys = new Set(targets.map((target) => target.key));
    const existingEntries = this.options.state.state.entries;
    const needsFetch = targets.filter((target) => {
      if (target.unsupportedReason) {
        return false;
      }
      const entry = existingEntries[target.key];
      return !entry || entry.status === "unsupported";
    });

    this.options.state.updateState((state) => {
      for (const key of Object.keys(state.entries)) {
        if (!wantedKeys.has(key)) {
          delete state.entries[key];
        }
      }

      for (const target of targets) {
        const entry = state.entries[target.key];
        if (!entry) {
          state.entries[target.key] = createEntry(target);
          continue;
        }

        if (target.unsupportedReason) {
          entry.status = "unsupported";
          entry.error = target.unsupportedReason;
          entry.refreshing = false;
          entry.data = null;
        } else if (entry.status === "unsupported") {
          entry.status = "pending";
          entry.error = null;
        }
      }
    });

    return needsFetch;
  }

  private async refreshTarget(
    target: UsageTarget,
  ): Promise<UsageRefreshResult> {
    if (this.inFlight.has(target.key)) {
      return { ok: true, message: null };
    }
    this.inFlight.add(target.key);
    this.setRefreshing(target.key, true);

    try {
      const result = await this.fetchUsage(target);
      this.options.state.updateState((state) => {
        const entry = state.entries[target.key];
        if (!entry) {
          return;
        }
        entry.refreshing = false;
        if (result.ok) {
          entry.status = "ok";
          entry.error = null;
          entry.fetchedAt = Date.now();
          entry.data = result.data as never;
          return;
        }
        entry.status = "error";
        entry.error = result.message;
      });

      return result.ok
        ? { ok: true, message: null }
        : { ok: false, message: result.message };
    } finally {
      this.inFlight.delete(target.key);
    }
  }

  private setRefreshing(key: string, refreshing: boolean): void {
    this.options.state.updateState((state) => {
      const entry = state.entries[key];
      if (entry) {
        entry.refreshing = refreshing;
      }
    });
  }

  private async fetchUsage(target: UsageTarget): Promise<FetchResult> {
    switch (target.provider) {
      case "claude":
        return await this.fetchClaudeUsage(target.accountId);
      case "codex":
        return await this.fetchCodexUsage(target.accountId);
      case "cursor":
        return toFetchResult(await getCursorUsage());
    }
  }

  private async fetchClaudeUsage(
    accountId: string | null,
  ): Promise<FetchResult> {
    if (!accountId) {
      return toFetchResult(await getClaudeUsage());
    }

    const account = this.options.claudeAccounts.getAccount(accountId);
    if (!account) {
      return { ok: false, message: "Claude account not found" };
    }
    if (account.type === "setup-token") {
      return { ok: false, message: SETUP_TOKEN_MESSAGE };
    }

    let accessToken: string;
    try {
      accessToken =
        await this.options.claudeAccounts.getValidAccessToken(accountId);
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error, "Token refresh failed"),
      };
    }

    return toFetchResult(await fetchUsageWithToken(accessToken));
  }

  private async fetchCodexUsage(
    accountId: string | null,
  ): Promise<FetchResult> {
    const codexSessions = this.options.codexSessions;
    const readRateLimits = codexSessions
      ? () => codexSessions.readLiveAccountRateLimits(accountId ?? undefined)
      : undefined;

    if (!accountId) {
      return toFetchResult(await getCodexUsage({ readRateLimits }));
    }

    let externalAuth: CodexExternalAuthTokens;
    try {
      externalAuth =
        await this.options.codexAccounts.getExternalAuth(accountId);
    } catch (error) {
      return {
        ok: false,
        message: errorMessage(error, "Codex account is not available"),
      };
    }

    return toFetchResult(await getCodexUsage({ externalAuth, readRateLimits }));
  }
}

export const usageRouter = {
  refreshAll: procedure.handler(async ({ context }) => {
    await context.usageTracker.refreshAll();
  }),
  refresh: procedure
    .input(z.object({ key: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.usageTracker.refresh(input.key);
    }),
};
