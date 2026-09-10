import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountLoginService } from "../../src/main/codex-account-login";
import {
  CodexAccountsService,
  defineCodexAccountsInternalState,
  defineCodexAccountsPublicState,
} from "../../src/main/codex-accounts";
import type { TerminalManager } from "../../src/main/terminal-manager";
import { makeCodexAccessToken } from "./codex-token-fixture";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    watch: () => ({ close: () => {} }),
  };
});

const EXP_SECONDS = Math.floor((Date.now() + 10 * 24 * 60 * 60_000) / 1_000);

type StartTerminalCall = {
  terminalId: string;
  launch: {
    file?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  onExit?: (payload: {
    exitCode: number | null;
    stoppedByUser: boolean;
  }) => void;
};

function createStubTerminalManager() {
  return {
    registerTerminal: vi.fn(),
    startTerminal: vi.fn(),
    unregisterTerminal: vi.fn().mockResolvedValue(undefined),
  } as unknown as TerminalManager & {
    registerTerminal: ReturnType<typeof vi.fn>;
    startTerminal: ReturnType<typeof vi.fn>;
    unregisterTerminal: ReturnType<typeof vi.fn>;
  };
}

async function exists(target: string): Promise<boolean> {
  return await stat(target).then(
    () => true,
    () => false,
  );
}

describe("CodexAccountLoginService", () => {
  let userDataPath: string;
  let accounts: CodexAccountsService;
  let terminalManager: ReturnType<typeof createStubTerminalManager>;
  let service: CodexAccountLoginService;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(tmpdir(), "agent-ui-codex-login-"));
    accounts = new CodexAccountsService({
      internalState: defineCodexAccountsInternalState(),
      publicState: defineCodexAccountsPublicState(),
    });
    terminalManager = createStubTerminalManager();
    service = new CodexAccountLoginService({
      userDataPath,
      terminalManager,
      accounts,
    });
  });

  afterEach(async () => {
    await service.dispose();
  });

  function startTerminalOptions(): StartTerminalCall {
    return terminalManager.startTerminal.mock.calls[0][0] as StartTerminalCall;
  }

  async function codexHome() {
    const loginsRoot = path.join(userDataPath, "codex-accounts");
    const [loginId] = await readdir(loginsRoot);
    return path.join(loginsRoot, loginId, "login-home");
  }

  async function writeAuthJson(tokens: Record<string, unknown>) {
    await writeFile(
      path.join(await codexHome(), "auth.json"),
      JSON.stringify({ tokens }),
      "utf8",
    );
  }

  const check = () =>
    (
      service as unknown as {
        checkForCredentials: () => Promise<boolean>;
      }
    ).checkForCredentials();

  it("runs codex login --device-auth against a throwaway CODEX_HOME", async () => {
    const { loginId, terminalId } = await service.begin({
      cols: 100,
      rows: 30,
    });

    expect(terminalId).toBe(`codex-account-login:${loginId}`);
    expect(terminalManager.registerTerminal).toHaveBeenCalledWith(terminalId);

    const options = startTerminalOptions();
    const home = await codexHome();
    expect(options.terminalId).toBe(terminalId);
    expect(options.launch).toMatchObject({
      file: "codex",
      args: ["login", "--device-auth"],
      runWithShell: true,
      cols: 100,
      rows: 30,
      env: { CODEX_HOME: home },
    });
    expect(home.startsWith(path.join(userDataPath, "codex-accounts"))).toBe(
      true,
    );
    await expect(exists(home)).resolves.toBe(true);

    expect(accounts.getLoginFlow()).toEqual({
      loginId,
      terminalId,
      status: "waiting",
      reloginAccountId: undefined,
    });
  });

  it("creates the account from the access token claims once auth.json appears", async () => {
    const { loginId, terminalId } = await service.begin({});
    const home = await codexHome();
    await writeAuthJson({
      access_token: makeCodexAccessToken({
        expSeconds: EXP_SECONDS,
        chatgptAccountId: "workspace-1",
        planType: "team",
        email: "me@example.com",
      }),
      refresh_token: "refresh-1",
      id_token: "id-1",
    });

    await expect(check()).resolves.toBe(true);

    expect(accounts.internalState.state.accounts).toHaveLength(1);
    expect(accounts.internalState.state.accounts[0]).toMatchObject({
      type: "managed",
      label: "me@example.com",
      email: "me@example.com",
      planType: "team",
      chatgptAccountId: "workspace-1",
      status: "ok",
      oauth: {
        refreshToken: "refresh-1",
        idToken: "id-1",
        expiresAt: EXP_SECONDS * 1_000,
      },
    });
    expect(accounts.getLoginFlow()).toMatchObject({
      loginId,
      terminalId,
      status: "success",
      accountId: accounts.internalState.state.accounts[0].id,
    });

    expect(terminalManager.unregisterTerminal).toHaveBeenCalledWith(terminalId);
    await expect(exists(path.dirname(home))).resolves.toBe(false);
  });

  it("adds exactly one account when credential checks race", async () => {
    await service.begin({});
    await writeAuthJson({
      access_token: makeCodexAccessToken({
        chatgptAccountId: "workspace-1",
        email: "me@example.com",
      }),
      refresh_token: "refresh-1",
    });

    const results = await Promise.all([check(), check(), check(), check()]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(accounts.internalState.state.accounts).toHaveLength(1);
  });

  it("does not create an account when auth.json carries no workspace id", async () => {
    await service.begin({});
    await writeAuthJson({
      access_token: makeCodexAccessToken({ email: "me@example.com" }),
      refresh_token: "refresh-1",
    });

    await expect(check()).resolves.toBe(false);
    expect(accounts.internalState.state.accounts).toEqual([]);
    expect(accounts.getLoginFlow()).toMatchObject({ status: "waiting" });
  });

  it("fails the flow when the PTY exits before auth.json appears", async () => {
    const { loginId, terminalId } = await service.begin({});

    startTerminalOptions().onExit?.({ exitCode: 1, stoppedByUser: false });

    await vi.waitFor(() => {
      expect(accounts.getLoginFlow()).toMatchObject({
        loginId,
        terminalId,
        status: "error",
        error: "Codex exited before completing login.",
      });
    });
    expect(accounts.internalState.state.accounts).toEqual([]);
  });

  it("cancel tears down the terminal and deletes the throwaway home", async () => {
    const { terminalId } = await service.begin({});
    const home = await codexHome();

    await service.cancel();

    expect(terminalManager.unregisterTerminal).toHaveBeenCalledWith(terminalId);
    expect(accounts.getLoginFlow()).toBeNull();
    await expect(exists(path.dirname(home))).resolves.toBe(false);
  });
});
