import { randomUUID } from "node:crypto";
import z from "zod";
import { defineServiceState } from "../shared/service-state";
import {
  ClaudeAccountOAuth,
  type ManagedOauthCredentials,
} from "./claude-account-oauth";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export type ClaudeAccountStatus = "ok" | "needs-relogin";

export interface SetupTokenClaudeAccount {
  id: string;
  type: "setup-token";
  label: string;
  token: string;
  createdAt: number;
}

export interface ManagedClaudeAccount {
  id: string;
  type: "managed";
  label: string;
  email?: string;
  /** Plan the account is on at login time, e.g. "max" or "pro". */
  planType?: string;
  createdAt: number;
  status: ClaudeAccountStatus;
  oauth: ManagedOauthCredentials;
}

export type ClaudeAccountRecord =
  | SetupTokenClaudeAccount
  | ManagedClaudeAccount;

interface ClaudeAccountsInternalStateShape {
  accounts: ClaudeAccountRecord[];
}

/**
 * Redacted view synced to the renderer. Tokens and refresh credentials must
 * never leave the main process; the renderer only needs display metadata.
 */
export interface PublicClaudeAccount {
  id: string;
  type: ClaudeAccountRecord["type"];
  label: string;
  email?: string;
  planType?: string;
  createdAt: number;
  status: ClaudeAccountStatus;
}

export type ClaudeLoginFlowStatus = "waiting" | "success" | "error";

export interface ClaudeLoginFlowState {
  loginId: string;
  terminalId: string;
  status: ClaudeLoginFlowStatus;
  /** Set when this flow re-authenticates an existing account. */
  reloginAccountId?: string;
  /** Set once the flow succeeded. */
  accountId?: string;
  error?: string;
}

interface ClaudeAccountsPublicStateShape {
  accounts: PublicClaudeAccount[];
  loginFlow: ClaudeLoginFlowState | null;
}

export type ClaudeAccountsInternalState = ReturnType<
  typeof defineClaudeAccountsInternalState
>;
export type ClaudeAccountsPublicState = ReturnType<
  typeof defineClaudeAccountsPublicState
>;

/**
 * Full account records including secrets. Persisted (under the pre-existing
 * "claudeAccounts" store key) but never registered with the state
 * orchestrator, so nothing here reaches the renderer.
 */
export function defineClaudeAccountsInternalState() {
  return defineServiceState({
    key: "claudeAccounts" as const,
    defaults: { accounts: [] } as ClaudeAccountsInternalStateShape,
  });
}

/** Redacted mirror registered with the state orchestrator. Not persisted. */
export function defineClaudeAccountsPublicState() {
  return defineServiceState({
    key: "claudeAccounts" as const,
    defaults: {
      accounts: [],
      loginFlow: null,
    } as ClaudeAccountsPublicStateShape,
  });
}

const oauthCredentialsSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});

const setupTokenAccountSchema = z.object({
  id: z.string(),
  type: z.literal("setup-token"),
  label: z.string(),
  token: z.string(),
  createdAt: z.number(),
});

const managedAccountSchema = z.object({
  id: z.string(),
  type: z.literal("managed"),
  label: z.string(),
  email: z.string().optional(),
  planType: z.string().optional(),
  createdAt: z.number(),
  status: z.enum(["ok", "needs-relogin"]),
  oauth: oauthCredentialsSchema,
});

// Accounts stored before the type split have no `type` field; hydrate them as
// setup-token accounts.
const legacyAccountSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    token: z.string(),
    createdAt: z.number(),
  })
  .transform((account) => ({ ...account, type: "setup-token" as const }));

const claudeAccountsPersistenceSchema = z.object({
  accounts: z
    .array(
      z.union([
        setupTokenAccountSchema,
        managedAccountSchema,
        legacyAccountSchema,
      ]),
    )
    .catch([]),
});

export function defineClaudeAccountsPersistence(
  state: ClaudeAccountsInternalState,
) {
  return defineStatePersistence({
    serviceState: state,
    schema: claudeAccountsPersistenceSchema,
  });
}

function toPublicAccount(account: ClaudeAccountRecord): PublicClaudeAccount {
  return {
    id: account.id,
    type: account.type,
    label: account.label,
    email: account.type === "managed" ? account.email : undefined,
    planType: account.type === "managed" ? account.planType : undefined,
    createdAt: account.createdAt,
    status: account.type === "managed" ? account.status : "ok",
  };
}

export interface ClaudeAccountsServiceOptions {
  internalState: ClaudeAccountsInternalState;
  publicState: ClaudeAccountsPublicState;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class ClaudeAccountsService {
  readonly internalState: ClaudeAccountsInternalState;
  readonly publicState: ClaudeAccountsPublicState;
  private readonly oauth: ClaudeAccountOAuth;

  constructor(options: ClaudeAccountsServiceOptions) {
    this.internalState = options.internalState;
    this.publicState = options.publicState;

    this.oauth = new ClaudeAccountOAuth({
      getCredentials: (accountId) => {
        const account = this.getAccount(accountId);
        if (account?.type !== "managed") {
          return null;
        }
        return {
          ...account.oauth,
          blocked: account.status === "needs-relogin",
        };
      },
      setCredentials: (accountId, credentials) => {
        this.setManagedCredentials(accountId, credentials);
      },
      onInvalidGrant: (accountId) => {
        this.markNeedsRelogin(accountId);
      },
      fetchFn: options.fetchFn,
      now: options.now,
    });

    this.internalState.eventTarget.addEventListener("state-update", () => {
      this.mirrorPublicAccounts();
    });
    this.mirrorPublicAccounts();
  }

  private mirrorPublicAccounts(): void {
    const publicAccounts =
      this.internalState.state.accounts.map(toPublicAccount);
    this.publicState.updateState((draft) => {
      draft.accounts = publicAccounts;
    });
  }

  getAccount(accountId: string): ClaudeAccountRecord | null {
    return (
      this.internalState.state.accounts.find(
        (account) => account.id === accountId,
      ) ?? null
    );
  }

  addSetupTokenAccount(input: { label: string; token: string }): string {
    const account: SetupTokenClaudeAccount = {
      id: randomUUID(),
      type: "setup-token",
      label: input.label,
      token: input.token,
      createdAt: Date.now(),
    };
    this.internalState.updateState((state) => {
      state.accounts.push(account);
    });
    return account.id;
  }

  updateAccount(input: { id: string; label: string; token?: string }): void {
    this.internalState.updateState((state) => {
      const account = state.accounts.find((entry) => entry.id === input.id);
      if (!account) {
        return;
      }
      account.label = input.label;
      if (account.type === "setup-token" && input.token) {
        account.token = input.token;
      }
    });
  }

  removeAccount(accountId: string): void {
    this.internalState.updateState((state) => {
      state.accounts = state.accounts.filter((entry) => entry.id !== accountId);
    });
  }

  /**
   * Store harvested login credentials. When `reloginAccountId` points at an
   * existing managed account the new pair replaces the old one; otherwise a
   * new account is created.
   */
  upsertManagedAccount(input: {
    reloginAccountId?: string;
    label: string;
    email?: string;
    planType?: string;
    oauth: ManagedOauthCredentials;
  }): string {
    // Logging into an already-added account replaces its credentials instead
    // of creating a duplicate entry.
    const targetId =
      input.reloginAccountId ??
      (input.email
        ? this.internalState.state.accounts.find(
            (entry) => entry.type === "managed" && entry.email === input.email,
          )?.id
        : undefined);

    if (targetId) {
      const existing = this.getAccount(targetId);
      if (existing?.type === "managed") {
        this.internalState.updateState((state) => {
          const account = state.accounts.find((entry) => entry.id === targetId);
          if (account?.type !== "managed") {
            return;
          }
          account.oauth = input.oauth;
          account.status = "ok";
          if (input.email) {
            account.email = input.email;
          }
          if (input.planType) {
            account.planType = input.planType;
          }
        });
        return targetId;
      }
    }

    const account: ManagedClaudeAccount = {
      id: randomUUID(),
      type: "managed",
      label: input.label,
      email: input.email,
      planType: input.planType,
      createdAt: Date.now(),
      status: "ok",
      oauth: input.oauth,
    };
    this.internalState.updateState((state) => {
      state.accounts.push(account);
    });
    return account.id;
  }

  setManagedCredentials(
    accountId: string,
    credentials: ManagedOauthCredentials,
  ): void {
    this.internalState.updateState((state) => {
      const account = state.accounts.find((entry) => entry.id === accountId);
      if (account?.type !== "managed") {
        return;
      }
      account.oauth = credentials;
    });
  }

  markNeedsRelogin(accountId: string): void {
    this.internalState.updateState((state) => {
      const account = state.accounts.find((entry) => entry.id === accountId);
      if (account?.type !== "managed") {
        return;
      }
      account.status = "needs-relogin";
    });
  }

  async getValidAccessToken(
    accountId: string,
    options: { minRemainingMs?: number } = {},
  ): Promise<string> {
    return await this.oauth.getValidAccessToken(accountId, options);
  }

  setLoginFlow(flow: ClaudeLoginFlowState | null): void {
    this.publicState.updateState((draft) => {
      draft.loginFlow = flow;
    });
  }

  getLoginFlow(): ClaudeLoginFlowState | null {
    return this.publicState.state.loginFlow;
  }
}

export const claudeAccountsRouter = {
  addAccount: procedure
    .input(
      z.object({
        label: z.string().trim().min(1),
        token: z.string().trim().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      return context.claudeAccounts.addSetupTokenAccount(input);
    }),
  updateAccount: procedure
    .input(
      z.object({
        id: z.string(),
        label: z.string().trim().min(1),
        token: z.string().trim().min(1).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      context.claudeAccounts.updateAccount(input);
    }),
  removeAccount: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      context.claudeAccounts.removeAccount(input.id);
    }),
  beginManagedLogin: procedure
    .input(
      z.object({
        reloginAccountId: z.string().optional(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      return await context.claudeAccountLogin.begin(input);
    }),
  cancelManagedLogin: procedure.handler(async ({ context }) => {
    await context.claudeAccountLogin.cancel();
  }),
};
