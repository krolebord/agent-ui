import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ManagedCodexOauthCredentials } from "./codex-account-oauth";
import {
  CODEX_TOKEN_FALLBACK_LIFETIME_MS,
  decodeCodexTokenClaims,
} from "./codex-account-tokens";
import type { CodexAccountsService } from "./codex-accounts";
import log from "./logger";
import type { TerminalManager } from "./terminal-manager";

const AUTH_FILE = "auth.json";
const POLL_INTERVAL_MS = 1_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

const harvestedAuthSchema = z.object({
  tokens: z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    id_token: z.string().optional(),
    account_id: z.string().optional(),
  }),
});

interface ActiveLogin {
  loginId: string;
  terminalId: string;
  codexHome: string;
  reloginAccountId?: string;
  watcher: FSWatcher | null;
  pollTimer: NodeJS.Timeout;
  timeoutTimer: NodeJS.Timeout;
  settled: boolean;
  checking: boolean;
}

export class CodexAccountLoginService {
  private active: ActiveLogin | null = null;

  constructor(
    private readonly options: {
      userDataPath: string;
      terminalManager: TerminalManager;
      accounts: CodexAccountsService;
    },
  ) {}

  async begin(input: {
    reloginAccountId?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ loginId: string; terminalId: string }> {
    await this.cancel();

    const loginId = randomUUID();
    const terminalId = `codex-account-login:${loginId}`;
    const codexHome = path.join(
      this.options.userDataPath,
      "codex-accounts",
      loginId,
      "login-home",
    );
    await mkdir(codexHome, { recursive: true });

    const { terminalManager, accounts } = this.options;
    terminalManager.registerTerminal(terminalId);
    await terminalManager.startTerminal({
      terminalId,
      launch: {
        cwd: homedir(),
        cols: input.cols,
        rows: input.rows,
        runWithShell: true,
        file: "codex",
        args: ["login", "--device-auth"],
        env: {
          CODEX_HOME: codexHome,
        },
      },
      onExit: () => {
        void this.checkForCredentials().then((found) => {
          if (!found) {
            this.fail("Codex exited before completing login.");
          }
        });
      },
    });

    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(codexHome, () => {
        void this.checkForCredentials();
      });
    } catch (error) {
      log.warn("Codex login: fs.watch failed, relying on polling", { error });
    }

    this.active = {
      loginId,
      terminalId,
      codexHome,
      reloginAccountId: input.reloginAccountId,
      watcher,
      pollTimer: setInterval(() => {
        void this.checkForCredentials();
      }, POLL_INTERVAL_MS),
      timeoutTimer: setTimeout(() => {
        this.fail("Login timed out.");
      }, LOGIN_TIMEOUT_MS),
      settled: false,
      checking: false,
    };

    accounts.setLoginFlow({
      loginId,
      terminalId,
      status: "waiting",
      reloginAccountId: input.reloginAccountId,
    });

    return { loginId, terminalId };
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    this.teardown(active);
    this.options.accounts.setLoginFlow(null);
    await this.cleanup(active);
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  private async checkForCredentials(): Promise<boolean> {
    const active = this.active;
    if (!active || active.settled || active.checking) {
      return false;
    }

    active.checking = true;
    let harvested: HarvestedCodexCredentials | null = null;
    try {
      harvested = await readHarvestedCredentials(active.codexHome);
    } finally {
      active.checking = false;
    }
    if (!harvested || this.active !== active || active.settled) {
      return false;
    }

    active.settled = true;
    this.active = null;
    this.teardown(active);

    const accountId = this.options.accounts.upsertManagedAccount({
      reloginAccountId: active.reloginAccountId,
      label: harvested.email ?? "Codex account",
      email: harvested.email,
      planType: harvested.planType,
      chatgptAccountId: harvested.chatgptAccountId,
      oauth: harvested.oauth,
    });
    this.options.accounts.setLoginFlow({
      loginId: active.loginId,
      terminalId: active.terminalId,
      status: "success",
      reloginAccountId: active.reloginAccountId,
      accountId,
    });
    log.info("Codex login: harvested managed account credentials", {
      accountId,
    });

    await this.cleanup(active);
    return true;
  }

  private fail(message: string): void {
    const active = this.active;
    if (!active || active.settled) {
      return;
    }
    active.settled = true;
    this.active = null;
    this.teardown(active);
    this.options.accounts.setLoginFlow({
      loginId: active.loginId,
      terminalId: active.terminalId,
      status: "error",
      reloginAccountId: active.reloginAccountId,
      error: message,
    });
    void this.cleanup(active);
  }

  private teardown(active: ActiveLogin): void {
    clearInterval(active.pollTimer);
    clearTimeout(active.timeoutTimer);
    active.watcher?.close();
  }

  private async cleanup(active: ActiveLogin): Promise<void> {
    await this.options.terminalManager.unregisterTerminal(active.terminalId);
    await rm(path.dirname(active.codexHome), {
      recursive: true,
      force: true,
    }).catch((error) => {
      log.warn("Codex login: failed to remove throwaway CODEX_HOME", { error });
    });
  }
}

interface HarvestedCodexCredentials {
  oauth: ManagedCodexOauthCredentials;
  chatgptAccountId: string;
  email?: string;
  planType?: string;
}

async function readHarvestedCredentials(
  codexHome: string,
): Promise<HarvestedCodexCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(codexHome, AUTH_FILE), "utf8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = harvestedAuthSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const tokens = parsed.data.tokens;
  const claims = decodeCodexTokenClaims(tokens.access_token);
  const chatgptAccountId = tokens.account_id ?? claims?.chatgptAccountId;
  if (!chatgptAccountId) {
    log.warn("Codex login: auth.json carried no workspace id");
    return null;
  }

  return {
    oauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt:
        claims?.expiresAt ?? Date.now() + CODEX_TOKEN_FALLBACK_LIFETIME_MS,
    },
    chatgptAccountId,
    email: claims?.email,
    planType: claims?.planType,
  };
}
