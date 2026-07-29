import { z } from "zod";
import log from "./logger";

// Undocumented endpoint + public client ID used by the Claude CLI's own OAuth
// flow. Both have moved before — keep them in one place so breakage is a
// one-line fix.
export const CLAUDE_OAUTH_TOKEN_ENDPOINT =
  "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CODE_OAUTH_CLIENT_ID =
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Refresh when the access token has less than this much lifetime left. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** After a transient refresh failure, don't retry until this much time passed. */
const TRANSIENT_BACKOFF_MS = 30_000;

export interface ManagedOauthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

const refreshResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number(),
  })
  .passthrough();

export class OauthRefreshError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = "OauthRefreshError";
  }
}

interface ClaudeAccountOAuthOptions {
  /** Read the current credentials for an account, or null if unknown. */
  getCredentials: (
    accountId: string,
  ) => (ManagedOauthCredentials & { blocked?: boolean }) | null;
  /** Persist a rotated credential pair. */
  setCredentials: (
    accountId: string,
    credentials: ManagedOauthCredentials,
  ) => void;
  /** Mark an account as needing a fresh login (refresh token is dead). */
  onInvalidGrant: (accountId: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Owns access-token refresh for managed accounts. The app has exclusive
 * custody of these refresh tokens (they rotate on every refresh), so this is
 * the only place that may call the refresh endpoint — and it must never be
 * pointed at the user's default `~/.claude` login, which the CLI owns.
 */
export class ClaudeAccountOAuth {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly options: ClaudeAccountOAuthOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(options: ClaudeAccountOAuthOptions) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getValidAccessToken(
    accountId: string,
    options: { minRemainingMs?: number } = {},
  ): Promise<string> {
    const credentials = this.options.getCredentials(accountId);
    if (!credentials) {
      throw new OauthRefreshError(
        `No managed credentials for account ${accountId}`,
        true,
      );
    }
    if (credentials.blocked) {
      throw new OauthRefreshError("Account needs a fresh Claude login", true);
    }
    const margin = options.minRemainingMs ?? EXPIRY_MARGIN_MS;
    if (credentials.expiresAt - margin > this.now()) {
      return credentials.accessToken;
    }

    const inflight = this.inflight.get(accountId);
    if (inflight) {
      return await inflight;
    }

    const backoffUntil = this.backoffUntil.get(accountId) ?? 0;
    if (backoffUntil > this.now()) {
      throw new OauthRefreshError(
        "Token refresh failed recently; backing off",
        false,
      );
    }

    const refreshPromise = this.refresh(accountId, credentials).finally(() => {
      this.inflight.delete(accountId);
    });
    this.inflight.set(accountId, refreshPromise);
    return await refreshPromise;
  }

  private async refresh(
    accountId: string,
    credentials: ManagedOauthCredentials,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
        }).toString(),
      });
    } catch (error) {
      this.backoffUntil.set(accountId, this.now() + TRANSIENT_BACKOFF_MS);
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Claude account token refresh request failed", {
        accountId,
        message,
      });
      throw new OauthRefreshError(`Token refresh failed: ${message}`, false);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (isInvalidGrant(response.status, body)) {
        log.warn("Claude account refresh token is invalid; login required", {
          accountId,
        });
        this.options.onInvalidGrant(accountId);
        throw new OauthRefreshError(
          "Refresh token was rejected; account needs a fresh Claude login",
          true,
        );
      }
      this.backoffUntil.set(accountId, this.now() + TRANSIENT_BACKOFF_MS);
      log.warn("Claude account token refresh returned an error", {
        accountId,
        status: response.status,
      });
      throw new OauthRefreshError(
        `Token refresh failed with status ${response.status}`,
        false,
      );
    }

    const parsed = refreshResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      this.backoffUntil.set(accountId, this.now() + TRANSIENT_BACKOFF_MS);
      throw new OauthRefreshError(
        "Token refresh response has unexpected format",
        false,
      );
    }

    const rotated: ManagedOauthCredentials = {
      accessToken: parsed.data.access_token,
      // The endpoint usually rotates the refresh token; keep the old one only
      // if no replacement was issued.
      refreshToken: parsed.data.refresh_token ?? credentials.refreshToken,
      expiresAt: this.now() + parsed.data.expires_in * 1_000,
      scopes: credentials.scopes,
    };
    this.options.setCredentials(accountId, rotated);
    this.backoffUntil.delete(accountId);
    log.info("Claude account access token refreshed", { accountId });
    return rotated.accessToken;
  }
}

function isInvalidGrant(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return parsed.error === "invalid_grant";
  } catch {
    return body.includes("invalid_grant");
  }
}
