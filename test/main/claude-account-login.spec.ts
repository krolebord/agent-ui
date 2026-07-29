import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountLoginService } from "../../src/main/claude-account-login";
import {
  ClaudeAccountsService,
  defineClaudeAccountsInternalState,
  defineClaudeAccountsPublicState,
} from "../../src/main/claude-accounts";
import type { TerminalManager } from "../../src/main/terminal-manager";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Disable fs.watch so the harvest is driven only by the explicit
// checkForCredentials calls below, keeping the race deterministic.
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    watch: () => ({ close: () => {} }),
  };
});

const credentialsJson = JSON.stringify({
  claudeAiOauth: {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3600_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  },
});

function createStubTerminalManager() {
  return {
    registerTerminal: vi.fn(),
    startTerminal: vi.fn(),
    unregisterTerminal: vi.fn().mockResolvedValue(undefined),
  } as unknown as TerminalManager;
}

describe("ClaudeAccountLoginService", () => {
  let userDataPath: string;
  let accounts: ClaudeAccountsService;
  let service: ClaudeAccountLoginService;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(tmpdir(), "agent-ui-login-"));
    accounts = new ClaudeAccountsService({
      internalState: defineClaudeAccountsInternalState(),
      publicState: defineClaudeAccountsPublicState(),
    });
    service = new ClaudeAccountLoginService({
      userDataPath,
      terminalManager: createStubTerminalManager(),
      accounts,
    });
  });

  afterEach(async () => {
    await service.dispose();
  });

  async function loginConfigDir() {
    const loginsRoot = path.join(userDataPath, "claude-accounts");
    const [loginId] = await readdir(loginsRoot);
    return path.join(loginsRoot, loginId, "login-config-dir");
  }

  async function writeClaudeJson(email: string) {
    await writeFile(
      path.join(await loginConfigDir(), ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
      "utf8",
    );
  }

  async function writeCredentials(email?: string) {
    await writeFile(
      path.join(await loginConfigDir(), ".credentials.json"),
      credentialsJson,
      "utf8",
    );
    if (email) {
      await writeClaudeJson(email);
    }
  }

  const check = () =>
    (
      service as unknown as {
        checkForCredentials: () => Promise<boolean>;
      }
    ).checkForCredentials();

  it("adds exactly one account when credential checks race", async () => {
    await service.begin({});
    await writeCredentials("me@example.com");

    // fs.watch fires in bursts alongside the poll timer; concurrent checks
    // must not each harvest the file.
    const results = await Promise.all([check(), check(), check(), check()]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(accounts.internalState.state.accounts).toHaveLength(1);
    expect(accounts.internalState.state.accounts[0]).toMatchObject({
      type: "managed",
      email: "me@example.com",
      planType: "max",
      oauth: { refreshToken: "refresh-1" },
    });
    expect(accounts.getLoginFlow()).toMatchObject({ status: "success" });
  });

  it("waits for the email to appear in .claude.json after credentials", async () => {
    service = new ClaudeAccountLoginService({
      userDataPath,
      terminalManager: createStubTerminalManager(),
      accounts,
      emailPollIntervalMs: 10,
      emailWaitTimeoutMs: 1_000,
    });
    await service.begin({});
    await writeCredentials();

    const pending = check();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeClaudeJson("late@example.com");

    await expect(pending).resolves.toBe(true);
    expect(accounts.internalState.state.accounts[0]).toMatchObject({
      type: "managed",
      email: "late@example.com",
      label: "late@example.com",
    });
  });

  it("still creates the account when the email never appears", async () => {
    service = new ClaudeAccountLoginService({
      userDataPath,
      terminalManager: createStubTerminalManager(),
      accounts,
      emailPollIntervalMs: 10,
      emailWaitTimeoutMs: 50,
    });
    await service.begin({});
    await writeCredentials();

    await expect(check()).resolves.toBe(true);
    expect(accounts.internalState.state.accounts[0]).toMatchObject({
      type: "managed",
      email: undefined,
      label: "Claude account",
    });
    expect(accounts.getLoginFlow()).toMatchObject({ status: "success" });
  });
});
