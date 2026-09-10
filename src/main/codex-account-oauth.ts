import { z } from "zod";
import {
  CODEX_TOKEN_FALLBACK_LIFETIME_MS,
  decodeCodexTokenClaims,
} from "./codex-account-tokens";
import log from "./logger";

export const CODEX_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const CODEX_CLI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const EXPIRY_MARGIN_MS = 60 * 60_000;
const TRANSIENT_BACKOFF_MS = 30_000;

export interface ManagedCodexOauthCredentials {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
}

const refreshResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export class CodexOauthRefreshError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = "CodexOauthRefreshError";
  }
}

interface CodexAccountOAuthOptions {
  getCredentials: (
    accountId: string,
  ) => (ManagedCodexOauthCredentials & { blocked?: boolean }) | null;
  setCredentials: (
    accountId: string,
    credentials: ManagedCodexOauthCredentials,
  ) => void;
  onInvalidGrant: (accountId: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class CodexAccountOAuth {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly options: CodexAccountOAuthOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(options: CodexAccountOAuthOptions) {
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
      throw new CodexOauthRefreshError(
        `No managed credentials for account ${accountId}`,
        true,
      );
    }
    if (credentials.blocked) {
      throw new CodexOauthRefreshError(
        "Account needs a fresh Codex login",
        true,
      );
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
      throw new CodexOauthRefreshError(
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
    credentials: ManagedCodexOauthCredentials,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(CODEX_OAUTH_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_CLI_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        }),
      });
    } catch (error) {
      this.backoffUntil.set(accountId, this.now() + TRANSIENT_BACKOFF_MS);
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Codex account token refresh request failed", {
        accountId,
        message,
      });
      throw new CodexOauthRefreshError(
        `Token refresh failed: ${message}`,
        false,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (isInvalidGrant(response.status, body)) {
        log.warn("Codex account refresh token is invalid; login required", {
          accountId,
        });
        this.options.onInvalidGrant(accountId);
        throw new CodexOauthRefreshError(
          "Refresh token was rejected; account needs a fresh Codex login",
          true,
        );
      }
      this.backoffUntil.set(accountId, this.now() + TRANSIENT_BACKOFF_MS);
      log.warn("Codex account token refresh returned an error", {
        accountId,
        status: response.status,
      });
      throw new CodexOauthRefreshError(
        `Token refresh failed with status ${response.status}`,
        false,
      );
    }

    const parsed = refreshResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      this.backoffUntil.set(accountId, this.now() + TRANSIENT_BACKOFF_MS);
      throw new CodexOauthRefreshError(
        "Token refresh response has unexpected format",
        false,
      );
    }

    const rotated: ManagedCodexOauthCredentials = {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? credentials.refreshToken,
      idToken: parsed.data.id_token ?? credentials.idToken,
      expiresAt: this.resolveExpiry(
        parsed.data.access_token,
        parsed.data.expires_in,
      ),
    };
    this.options.setCredentials(accountId, rotated);
    this.backoffUntil.delete(accountId);
    log.info("Codex account access token refreshed", { accountId });
    return rotated.accessToken;
  }

  private resolveExpiry(accessToken: string, expiresIn?: number): number {
    const claimed = decodeCodexTokenClaims(accessToken)?.expiresAt;
    if (claimed != null) {
      return claimed;
    }
    if (expiresIn != null) {
      return this.now() + expiresIn * 1_000;
    }
    return this.now() + CODEX_TOKEN_FALLBACK_LIFETIME_MS;
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
