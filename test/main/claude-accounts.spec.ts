import { describe, expect, it, vi } from "vitest";
import {
  ClaudeAccountsService,
  defineClaudeAccountsInternalState,
  defineClaudeAccountsPersistence,
  defineClaudeAccountsPublicState,
} from "../../src/main/claude-accounts";
import {
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createMemoryStore(
  initial: Record<string, unknown> = {},
): PersistenceStore {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => data.get(key),
    set: (key, value) => data.set(key, value),
  };
}

function createService() {
  const internalState = defineClaudeAccountsInternalState();
  const publicState = defineClaudeAccountsPublicState();
  const service = new ClaudeAccountsService({ internalState, publicState });
  return { internalState, publicState, service };
}

const managedOauth = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 123,
  scopes: ["user:inference"],
};

describe("claude accounts persistence", () => {
  it("hydrates legacy accounts without a type as setup-token accounts", () => {
    const store = createMemoryStore({
      claudeAccounts: {
        accounts: [
          {
            id: "legacy-1",
            label: "Work",
            token: "sk-ant-oat01-work",
            createdAt: 100,
          },
        ],
      },
    });
    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 1,
      store,
    });
    const internalState = defineClaudeAccountsInternalState();
    orchestrator.registerAndHydrate(
      defineClaudeAccountsPersistence(internalState),
    );

    expect(internalState.state.accounts).toEqual([
      {
        id: "legacy-1",
        type: "setup-token",
        label: "Work",
        token: "sk-ant-oat01-work",
        createdAt: 100,
      },
    ]);
  });

  it("round-trips managed accounts", () => {
    const store = createMemoryStore();
    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 1,
      store,
    });
    const internalState = defineClaudeAccountsInternalState();
    orchestrator.registerAndHydrate(
      defineClaudeAccountsPersistence(internalState),
    );
    internalState.updateState((state) => {
      state.accounts.push({
        id: "m1",
        type: "managed",
        label: "Personal",
        email: "me@example.com",
        planType: "max",
        createdAt: 200,
        status: "ok",
        oauth: managedOauth,
      });
    });
    orchestrator.flushAll();

    const rehydrated = defineClaudeAccountsInternalState();
    const orchestrator2 = new PersistenceOrchestrator({
      schemaVersion: 1,
      store,
    });
    orchestrator2.registerAndHydrate(
      defineClaudeAccountsPersistence(rehydrated),
    );
    expect(rehydrated.state.accounts).toEqual(internalState.state.accounts);
  });
});

describe("ClaudeAccountsService", () => {
  it("mirrors a redacted view without secrets to the public state", () => {
    const { publicState, service } = createService();

    const setupId = service.addSetupTokenAccount({
      label: "Work",
      token: "sk-ant-oat01-secret",
    });
    const managedId = service.upsertManagedAccount({
      label: "Personal",
      email: "me@example.com",
      planType: "max",
      oauth: managedOauth,
    });

    expect(publicState.state.accounts).toHaveLength(2);
    const [setupPublic, managedPublic] = publicState.state.accounts;
    expect(setupPublic).toMatchObject({
      id: setupId,
      type: "setup-token",
      label: "Work",
      status: "ok",
    });
    expect(managedPublic).toMatchObject({
      id: managedId,
      type: "managed",
      label: "Personal",
      email: "me@example.com",
      planType: "max",
      status: "ok",
    });
    const serialized = JSON.stringify(publicState.state);
    expect(serialized).not.toContain("sk-ant-oat01-secret");
    expect(serialized).not.toContain("refresh-1");
    expect(serialized).not.toContain("access-1");
  });

  it("re-login replaces the credential pair under the same account id", () => {
    const { service, internalState } = createService();
    const accountId = service.upsertManagedAccount({
      label: "Personal",
      oauth: managedOauth,
    });
    service.markNeedsRelogin(accountId);
    expect(service.getAccount(accountId)).toMatchObject({
      status: "needs-relogin",
    });

    const newOauth = {
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 456,
      scopes: ["user:inference"],
    };
    const resultId = service.upsertManagedAccount({
      reloginAccountId: accountId,
      label: "ignored",
      email: "new@example.com",
      oauth: newOauth,
    });

    expect(resultId).toBe(accountId);
    expect(internalState.state.accounts).toHaveLength(1);
    expect(service.getAccount(accountId)).toMatchObject({
      status: "ok",
      email: "new@example.com",
      oauth: newOauth,
      // The user's chosen label survives re-login.
      label: "Personal",
    });
  });

  it("deduplicates managed accounts by email on repeat logins", () => {
    const { service, internalState } = createService();
    const firstId = service.upsertManagedAccount({
      label: "Personal",
      email: "me@example.com",
      oauth: managedOauth,
    });

    const secondId = service.upsertManagedAccount({
      label: "Claude account",
      email: "me@example.com",
      oauth: {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 456,
        scopes: ["user:inference"],
      },
    });

    expect(secondId).toBe(firstId);
    expect(internalState.state.accounts).toHaveLength(1);
    expect(service.getAccount(firstId)).toMatchObject({
      label: "Personal",
      oauth: { refreshToken: "refresh-2" },
    });

    // Different email still creates a separate account.
    const otherId = service.upsertManagedAccount({
      label: "Work",
      email: "other@example.com",
      oauth: managedOauth,
    });
    expect(otherId).not.toBe(firstId);
    expect(internalState.state.accounts).toHaveLength(2);
  });

  it("only replaces setup tokens when a new token is provided", () => {
    const { service } = createService();
    const id = service.addSetupTokenAccount({
      label: "Work",
      token: "token-1",
    });

    service.updateAccount({ id, label: "Renamed" });
    expect(service.getAccount(id)).toMatchObject({
      label: "Renamed",
      token: "token-1",
    });

    service.updateAccount({ id, label: "Renamed", token: "token-2" });
    expect(service.getAccount(id)).toMatchObject({ token: "token-2" });
  });
});
