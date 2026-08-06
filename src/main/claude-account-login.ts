import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ManagedOauthCredentials } from "./claude-account-oauth";
import type { ClaudeAccountsService } from "./claude-accounts";
import log from "./logger";
import type { TerminalManager } from "./terminal-manager";

const CREDENTIALS_FILE = ".credentials.json";
const POLL_INTERVAL_MS = 1_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const EMAIL_POLL_INTERVAL_MS = 250;
const EMAIL_WAIT_TIMEOUT_MS = 10_000;

const harvestedCredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string(),
      expiresAt: z.number(),
      scopes: z.array(z.string()).catch([]),
      subscriptionType: z.string().optional().catch(undefined),
    })
    .passthrough(),
});

const claudeJsonSchema = z
  .object({
    oauthAccount: z
      .object({
        emailAddress: z.string().optional(),
        organizationName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

interface ActiveLogin {
  loginId: string;
  terminalId: string;
  configDir: string;
  reloginAccountId?: string;
  watcher: FSWatcher | null;
  pollTimer: NodeJS.Timeout;
  timeoutTimer: NodeJS.Timeout;
  settled: boolean;
  checking: boolean;
}

/**
 * Runs `claude` against a throwaway CLAUDE_CONFIG_DIR so the user can log in
 * interactively, then harvests the OAuth credential pair from
 * `.credentials.json`. The CLI never runs against that dir again, which is
 * what makes app-side refresh-token rotation safe. The dir (containing a
 * credentials copy) is deleted as soon as the pair is extracted.
 */
export class ClaudeAccountLoginService {
  private active: ActiveLogin | null = null;

  constructor(
    private readonly options: {
      userDataPath: string;
      terminalManager: TerminalManager;
      accounts: ClaudeAccountsService;
      emailWaitTimeoutMs?: number;
      emailPollIntervalMs?: number;
    },
  ) {}

  async begin(input: {
    reloginAccountId?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ loginId: string; terminalId: string }> {
    await this.cancel();

    const loginId = randomUUID();
    const terminalId = `claude-account-login:${loginId}`;
    const configDir = path.join(
      this.options.userDataPath,
      "claude-accounts",
      loginId,
      "login-config-dir",
    );
    await mkdir(configDir, { recursive: true });

    const { terminalManager, accounts } = this.options;
    terminalManager.registerTerminal(terminalId);
    await terminalManager.startTerminal({
      terminalId,
      launch: {
        cwd: homedir(),
        cols: input.cols,
        rows: input.rows,
        // A fresh config dir sends the CLI straight into onboarding/login.
        runWithShell: true,
        file: "claude",
        env: {
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "true",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
        },
      },
      onExit: () => {
        // The PTY exiting before credentials appeared means the user quit or
        // login failed. A final check catches credentials written right
        // before exit.
        void this.checkForCredentials().then((found) => {
          if (!found) {
            this.fail("Claude exited before completing login.");
          }
        });
      },
    });

    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(configDir, () => {
        void this.checkForCredentials();
      });
    } catch (error) {
      // fs.watch can fail on some filesystems; polling below still covers us.
      log.warn("Claude login: fs.watch failed, relying on polling", { error });
    }

    this.active = {
      loginId,
      terminalId,
      configDir,
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
    // `checking` is set before any await: fs.watch fires in bursts alongside
    // the poll timer, and overlapping async checks would each harvest the
    // same credentials file and create duplicate accounts.
    if (!active || active.settled || active.checking) {
      return false;
    }

    active.checking = true;
    let credentials: HarvestedCredentials | null = null;
    try {
      credentials = await readHarvestedCredentials(active.configDir);
    } finally {
      active.checking = false;
    }
    // The flow may have been cancelled or settled while reading the file.
    if (!credentials || this.active !== active || active.settled) {
      return false;
    }

    active.settled = true;
    this.active = null;
    this.teardown(active);

    const email = await this.waitForAccountEmail(active.configDir);
    const accountId = this.options.accounts.upsertManagedAccount({
      reloginAccountId: active.reloginAccountId,
      label: email ?? "Claude account",
      email,
      planType: credentials.subscriptionType,
      oauth: credentials.oauth,
    });
    this.options.accounts.setLoginFlow({
      loginId: active.loginId,
      terminalId: active.terminalId,
      status: "success",
      reloginAccountId: active.reloginAccountId,
      accountId,
    });
    log.info("Claude login: harvested managed account credentials", {
      accountId,
    });

    await this.cleanup(active);
    return true;
  }

  // The CLI writes `oauthAccount` into `.claude.json` on its own schedule,
  // often after `.credentials.json` appears, so a single immediate read
  // misses the email. Poll briefly; give up rather than fail the login.
  private async waitForAccountEmail(
    configDir: string,
  ): Promise<string | undefined> {
    const timeoutMs = this.options.emailWaitTimeoutMs ?? EMAIL_WAIT_TIMEOUT_MS;
    const intervalMs =
      this.options.emailPollIntervalMs ?? EMAIL_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const email = await readAccountEmail(configDir);
      if (email) {
        return email;
      }
      if (Date.now() >= deadline) {
        log.warn("Claude login: account email never appeared in .claude.json");
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
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
    // Remove the whole per-login dir: it holds a copy of the credentials.
    await rm(path.dirname(active.configDir), {
      recursive: true,
      force: true,
    }).catch((error) => {
      log.warn("Claude login: failed to remove throwaway config dir", {
        error,
      });
    });
  }
}

interface HarvestedCredentials {
  oauth: ManagedOauthCredentials;
  /** Plan the account is on, e.g. "max" or "pro". */
  subscriptionType?: string;
}

async function readHarvestedCredentials(
  configDir: string,
): Promise<HarvestedCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(configDir, CREDENTIALS_FILE), "utf8");
  } catch {
    return null;
  }

  // The CLI may still be mid-write; unparseable content is retried by the
  // next poll tick rather than treated as failure.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = harvestedCredentialsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const oauth = parsed.data.claudeAiOauth;
  return {
    oauth: {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt:
        oauth.expiresAt < 1_000_000_000_000
          ? oauth.expiresAt * 1_000
          : oauth.expiresAt,
      scopes: oauth.scopes,
    },
    subscriptionType: oauth.subscriptionType?.trim() || undefined,
  };
}

async function readAccountEmail(
  configDir: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(configDir, ".claude.json"), "utf8");
    const parsed = claudeJsonSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? parsed.data.oauthAccount?.emailAddress?.trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}
