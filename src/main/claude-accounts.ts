import { randomUUID } from "node:crypto";
import z from "zod";
import { defineServiceState } from "../shared/service-state";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export interface ClaudeAccount {
  id: string;
  label: string;
  token: string;
  createdAt: number;
}

export interface ClaudeAccountsSettings {
  accounts: ClaudeAccount[];
}

const defaults: ClaudeAccountsSettings = {
  accounts: [],
};

export type ClaudeAccountsState = ReturnType<typeof defineClaudeAccountsState>;

export function defineClaudeAccountsState() {
  return defineServiceState({ key: "claudeAccounts" as const, defaults });
}

const claudeAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  token: z.string(),
  createdAt: z.number(),
});

const claudeAccountsPersistenceSchema = z.object({
  accounts: z.array(claudeAccountSchema).catch([]),
});

export function defineClaudeAccountsPersistence(state: ClaudeAccountsState) {
  return defineStatePersistence({
    serviceState: state,
    schema: claudeAccountsPersistenceSchema,
  });
}

export function getClaudeAccountToken(
  state: ClaudeAccountsState,
  accountId: string,
): string | null {
  const account = state.state.accounts.find((entry) => entry.id === accountId);
  return account?.token ?? null;
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
      const account: ClaudeAccount = {
        id: randomUUID(),
        label: input.label,
        token: input.token,
        createdAt: Date.now(),
      };
      context.claudeAccountsState.updateState((state) => {
        state.accounts.push(account);
      });
      return account.id;
    }),
  updateAccount: procedure
    .input(
      z.object({
        id: z.string(),
        label: z.string().trim().min(1),
        token: z.string().trim().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      context.claudeAccountsState.updateState((state) => {
        const account = state.accounts.find((entry) => entry.id === input.id);
        if (!account) {
          return;
        }
        account.label = input.label;
        account.token = input.token;
      });
    }),
  removeAccount: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      context.claudeAccountsState.updateState((state) => {
        state.accounts = state.accounts.filter(
          (entry) => entry.id !== input.id,
        );
      });
    }),
};
