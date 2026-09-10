import { describe, expect, it, vi } from "vitest";
import {
  CodexAccountsService,
  defineCodexAccountsInternalState,
  defineCodexAccountsPersistence,
  defineCodexAccountsPublicState,
} from "../../src/main/codex-accounts";
import {
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const FAR_FUTURE = Date.now() + 10 * 24 * 60 * 60_000;

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
  const internalState = defineCodexAccountsInternalState();
  const publicState = defineCodexAccountsPublicState();
  const fetchFn = vi.fn();
  const service = new CodexAccountsService({
    internalState,
    publicState,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { internalState, publicState, service, fetchFn };
}

const managedOauth = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  idToken: "id-1",
  expiresAt: FAR_FUTURE,
};

describe("codex accounts persistence", () => {
  it("round-trips a stored managed account", () => {
    const store = createMemoryStore();
    const internalState = defineCodexAccountsInternalState();
    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 1,
      store,
    });
    orchestrator.registerAndHydrate(
      defineCodexAccountsPersistence(internalState),
    );
    internalState.updateState((state) => {
      state.accounts.push({
        id: "m1",
        type: "managed",
        label: "Personal",
        email: "me@example.com",
        planType: "team",
        chatgptAccountId: "workspace-1",
        createdAt: 200,
        status: "ok",
        oauth: managedOauth,
      });
    });
    orchestrator.flushAll();

    const rehydrated = defineCodexAccountsInternalState();
    const orchestrator2 = new PersistenceOrchestrator({
      schemaVersion: 1,
      store,
    });
    orchestrator2.registerAndHydrate(
      defineCodexAccountsPersistence(rehydrated),
    );
    expect(rehydrated.state.accounts).toEqual(internalState.state.accounts);
  });

  it("drops malformed stored accounts instead of hydrating them", () => {
    const store = createMemoryStore({
      codexAccounts: {
        accounts: [
          {
            id: "broken-1",
            type: "managed",
            label: "Broken",
            chatgptAccountId: "workspace-1",
            createdAt: 100,
            status: "ok",
            oauth: { accessToken: "access-1", expiresAt: 1 },
          },
        ],
      },
    });
    const internalState = defineCodexAccountsInternalState();
    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 1,
      store,
    });
    orchestrator.registerAndHydrate(
      defineCodexAccountsPersistence(internalState),
    );

    expect(internalState.state.accounts).toEqual([]);
  });
});

describe("CodexAccountsService", () => {
  it("mirrors a redacted view without secrets to the public state", () => {
    const { publicState, service } = createService();

    const accountId = service.upsertManagedAccount({
      label: "Personal",
      email: "me@example.com",
      planType: "team",
      chatgptAccountId: "workspace-1",
      oauth: managedOauth,
    });

    expect(publicState.state.accounts).toEqual([
      {
        id: accountId,
        type: "managed",
        label: "Personal",
        email: "me@example.com",
        planType: "team",
        createdAt: expect.any(Number),
        status: "ok",
      },
    ]);
    const serialized = JSON.stringify(publicState.state);
    expect(serialized).not.toContain("access-1");
    expect(serialized).not.toContain("refresh-1");
    expect(serialized).not.toContain("id-1");
  });

  it("updates the public mirror when the internal state changes", () => {
    const { publicState, service } = createService();
    const accountId = service.upsertManagedAccount({
      label: "Personal",
      chatgptAccountId: "workspace-1",
      oauth: managedOauth,
    });

    service.updateAccount({ id: accountId, label: "Renamed" });
    expect(publicState.state.accounts[0]).toMatchObject({ label: "Renamed" });

    service.markNeedsRelogin(accountId);
    expect(publicState.state.accounts[0]).toMatchObject({
      status: "needs-relogin",
    });

    service.removeAccount(accountId);
    expect(publicState.state.accounts).toEqual([]);
  });

  it("replaces the credentials in place on a repeat login for the same workspace", () => {
    const { service, internalState } = createService();
    const firstId = service.upsertManagedAccount({
      label: "Personal",
      email: "me@example.com",
      planType: "plus",
      chatgptAccountId: "workspace-1",
      oauth: managedOauth,
    });
    expect(internalState.state.accounts).toHaveLength(1);

    const secondId = service.upsertManagedAccount({
      label: "Codex account",
      email: "me@example.com",
      planType: "team",
      chatgptAccountId: "workspace-1",
      oauth: {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: FAR_FUTURE,
      },
    });

    expect(secondId).toBe(firstId);
    expect(internalState.state.accounts).toHaveLength(1);
    expect(service.getAccount(firstId)).toMatchObject({
      label: "Personal",
      planType: "team",
      oauth: { accessToken: "access-2", refreshToken: "refresh-2" },
    });
  });

  it("keeps the same login under a second workspace as its own account", () => {
    const { service, internalState } = createService();
    const firstId = service.upsertManagedAccount({
      label: "Personal",
      email: "me@example.com",
      chatgptAccountId: "workspace-1",
      oauth: managedOauth,
    });
    const secondId = service.upsertManagedAccount({
      label: "Work",
      email: "me@example.com",
      chatgptAccountId: "workspace-2",
      oauth: managedOauth,
    });

    expect(secondId).not.toBe(firstId);
    expect(internalState.state.accounts).toHaveLength(2);
  });

  it("re-login replaces the credential pair under the same account id and clears needs-relogin", () => {
    const { service, internalState } = createService();
    const accountId = service.upsertManagedAccount({
      label: "Personal",
      chatgptAccountId: "workspace-1",
      oauth: managedOauth,
    });
    service.markNeedsRelogin(accountId);
    expect(service.getAccount(accountId)).toMatchObject({
      status: "needs-relogin",
    });

    const newOauth = {
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: FAR_FUTURE,
    };
    const resultId = service.upsertManagedAccount({
      reloginAccountId: accountId,
      label: "ignored",
      email: "new@example.com",
      chatgptAccountId: "workspace-1",
      oauth: newOauth,
    });

    expect(resultId).toBe(accountId);
    expect(internalState.state.accounts).toHaveLength(1);
    expect(service.getAccount(accountId)).toMatchObject({
      status: "ok",
      email: "new@example.com",
      oauth: newOauth,
      label: "Personal",
    });
  });

  it("returns the external auth payload for an account", async () => {
    const { service, fetchFn } = createService();
    const accountId = service.upsertManagedAccount({
      label: "Personal",
      planType: "team",
      chatgptAccountId: "workspace-1",
      oauth: managedOauth,
    });

    await expect(service.getExternalAuth(accountId)).resolves.toEqual({
      accessToken: "access-1",
      chatgptAccountId: "workspace-1",
      chatgptPlanType: "team",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when asked for the external auth of an unknown account", async () => {
    const { service, fetchFn } = createService();

    await expect(service.getExternalAuth("nope")).rejects.toThrow(
      /Codex account nope was not found/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
