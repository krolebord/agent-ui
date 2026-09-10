import { randomUUID } from "node:crypto";
import z from "zod";
import { defineServiceState } from "../shared/service-state";
import {
  CodexAccountOAuth,
  type ManagedCodexOauthCredentials,
} from "./codex-account-oauth";
import type { CodexExternalAuthTokens } from "./codex-app-server-tracker";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export type CodexAccountStatus = "ok" | "needs-relogin";

export interface ManagedCodexAccount {
  id: string;
  type: "managed";
  label: string;
  email?: string;
  planType?: string;
  chatgptAccountId: string;
  createdAt: number;
  status: CodexAccountStatus;
  oauth: ManagedCodexOauthCredentials;
}

export type CodexAccountRecord = ManagedCodexAccount;

interface CodexAccountsInternalStateShape {
  accounts: CodexAccountRecord[];
}

export interface PublicCodexAccount {
  id: string;
  type: CodexAccountRecord["type"];
  label: string;
  email?: string;
  planType?: string;
  createdAt: number;
  status: CodexAccountStatus;
}

export type CodexLoginFlowStatus = "waiting" | "success" | "error";

export interface CodexLoginFlowState {
  loginId: string;
  terminalId: string;
  status: CodexLoginFlowStatus;
  reloginAccountId?: string;
  accountId?: string;
  error?: string;
}

interface CodexAccountsPublicStateShape {
  accounts: PublicCodexAccount[];
  loginFlow: CodexLoginFlowState | null;
}

export type CodexAccountsInternalState = ReturnType<
  typeof defineCodexAccountsInternalState
>;
export type CodexAccountsPublicState = ReturnType<
  typeof defineCodexAccountsPublicState
>;

export function defineCodexAccountsInternalState() {
  return defineServiceState({
    key: "codexAccounts" as const,
    defaults: { accounts: [] } as CodexAccountsInternalStateShape,
  });
}

export function defineCodexAccountsPublicState() {
  return defineServiceState({
    key: "codexAccounts" as const,
    defaults: {
      accounts: [],
      loginFlow: null,
    } as CodexAccountsPublicStateShape,
  });
}

const oauthCredentialsSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string().optional(),
  expiresAt: z.number(),
});

const managedAccountSchema = z.object({
  id: z.string(),
  type: z.literal("managed"),
  label: z.string(),
  email: z.string().optional(),
  planType: z.string().optional(),
  chatgptAccountId: z.string(),
  createdAt: z.number(),
  status: z.enum(["ok", "needs-relogin"]),
  oauth: oauthCredentialsSchema,
});

const codexAccountsPersistenceSchema = z.object({
  accounts: z.array(managedAccountSchema).catch([]),
});

export function defineCodexAccountsPersistence(
  state: CodexAccountsInternalState,
) {
  return defineStatePersistence({
    serviceState: state,
    schema: codexAccountsPersistenceSchema,
  });
}

function toPublicAccount(account: CodexAccountRecord): PublicCodexAccount {
  return {
    id: account.id,
    type: account.type,
    label: account.label,
    email: account.email,
    planType: account.planType,
    createdAt: account.createdAt,
    status: account.status,
  };
}

export interface CodexAccountsServiceOptions {
  internalState: CodexAccountsInternalState;
  publicState: CodexAccountsPublicState;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class CodexAccountsService {
  readonly internalState: CodexAccountsInternalState;
  readonly publicState: CodexAccountsPublicState;
  private readonly oauth: CodexAccountOAuth;

  constructor(options: CodexAccountsServiceOptions) {
    this.internalState = options.internalState;
    this.publicState = options.publicState;

    this.oauth = new CodexAccountOAuth({
      getCredentials: (accountId) => {
        const account = this.getAccount(accountId);
        if (!account) {
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

  getAccount(accountId: string): CodexAccountRecord | null {
    return (
      this.internalState.state.accounts.find(
        (account) => account.id === accountId,
      ) ?? null
    );
  }

  updateAccount(input: { id: string; label: string }): void {
    this.internalState.updateState((state) => {
      const account = state.accounts.find((entry) => entry.id === input.id);
      if (!account) {
        return;
      }
      account.label = input.label;
    });
  }

  removeAccount(accountId: string): void {
    this.internalState.updateState((state) => {
      state.accounts = state.accounts.filter((entry) => entry.id !== accountId);
    });
  }

  upsertManagedAccount(input: {
    reloginAccountId?: string;
    label: string;
    email?: string;
    planType?: string;
    chatgptAccountId: string;
    oauth: ManagedCodexOauthCredentials;
  }): string {
    const targetId =
      input.reloginAccountId ??
      this.internalState.state.accounts.find(
        (entry) =>
          entry.chatgptAccountId === input.chatgptAccountId &&
          (!input.email || entry.email === input.email),
      )?.id;

    if (targetId && this.getAccount(targetId)) {
      this.internalState.updateState((state) => {
        const account = state.accounts.find((entry) => entry.id === targetId);
        if (!account) {
          return;
        }
        account.oauth = input.oauth;
        account.status = "ok";
        account.chatgptAccountId = input.chatgptAccountId;
        if (input.email) {
          account.email = input.email;
        }
        if (input.planType) {
          account.planType = input.planType;
        }
      });
      return targetId;
    }

    const account: ManagedCodexAccount = {
      id: randomUUID(),
      type: "managed",
      label: input.label,
      email: input.email,
      planType: input.planType,
      chatgptAccountId: input.chatgptAccountId,
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
    credentials: ManagedCodexOauthCredentials,
  ): void {
    this.internalState.updateState((state) => {
      const account = state.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return;
      }
      account.oauth = credentials;
    });
  }

  markNeedsRelogin(accountId: string): void {
    this.internalState.updateState((state) => {
      const account = state.accounts.find((entry) => entry.id === accountId);
      if (!account) {
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

  async getExternalAuth(
    accountId: string,
    options: { minRemainingMs?: number } = {},
  ): Promise<CodexExternalAuthTokens> {
    const account = this.getAccount(accountId);
    if (!account) {
      throw new Error(`Codex account ${accountId} was not found`);
    }
    const accessToken = await this.getValidAccessToken(accountId, options);
    return {
      accessToken,
      chatgptAccountId: account.chatgptAccountId,
      chatgptPlanType: account.planType,
    };
  }

  setLoginFlow(flow: CodexLoginFlowState | null): void {
    this.publicState.updateState((draft) => {
      draft.loginFlow = flow;
    });
  }

  getLoginFlow(): CodexLoginFlowState | null {
    return this.publicState.state.loginFlow;
  }
}

export const codexAccountsRouter = {
  updateAccount: procedure
    .input(
      z.object({
        id: z.string(),
        label: z.string().trim().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      context.codexAccounts.updateAccount(input);
    }),
  removeAccount: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      context.codexAccounts.removeAccount(input.id);
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
      return await context.codexAccountLogin.begin(input);
    }),
  cancelManagedLogin: procedure.handler(async ({ context }) => {
    await context.codexAccountLogin.cancel();
  }),
};
