import { describe, expect, it, vi } from "vitest";
import {
  CODEX_CLI_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  CodexAccountOAuth,
  CodexOauthRefreshError,
  type ManagedCodexOauthCredentials,
} from "../../src/main/codex-account-oauth";
import { makeCodexAccessToken } from "./codex-token-fixture";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60_000;

function makeCredentials(
  overrides: Partial<ManagedCodexOauthCredentials> = {},
): ManagedCodexOauthCredentials {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    idToken: "id-old",
    expiresAt: 0,
    ...overrides,
  };
}

function refreshResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createOAuth(options: {
  credentials: ManagedCodexOauthCredentials | null;
  fetchFn: typeof fetch;
  now?: () => number;
}) {
  const setCredentials = vi.fn();
  const onInvalidGrant = vi.fn();
  const store = { credentials: options.credentials, blocked: false };
  const oauth = new CodexAccountOAuth({
    getCredentials: () =>
      store.credentials
        ? { ...store.credentials, blocked: store.blocked }
        : null,
    setCredentials: (accountId, credentials) => {
      store.credentials = credentials;
      setCredentials(accountId, credentials);
    },
    onInvalidGrant: (accountId) => {
      store.blocked = true;
      onInvalidGrant(accountId);
    },
    fetchFn: options.fetchFn,
    now: options.now ?? (() => NOW),
  });
  return { oauth, setCredentials, onInvalidGrant, store };
}

async function captureError(promise: Promise<unknown>) {
  return await promise.then(
    () => {
      throw new Error("expected the refresh to reject");
    },
    (error: unknown) => error as CodexOauthRefreshError,
  );
}

describe("CodexAccountOAuth", () => {
  it("returns the stored token while it has more runway than the margin", async () => {
    const fetchFn = vi.fn();
    const { oauth } = createOAuth({
      credentials: makeCredentials({ expiresAt: NOW + 2 * HOUR_MS }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-old");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refreshes within the expiry margin and persists the rotated pair", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      refreshResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        id_token: "id-new",
        expires_in: 3600,
      }),
    );
    const { oauth, setCredentials, store } = createOAuth({
      credentials: makeCredentials({ expiresAt: NOW + 30 * 60_000 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-new");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CODEX_OAUTH_TOKEN_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: CODEX_CLI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
    });

    expect(setCredentials).toHaveBeenCalledTimes(1);
    expect(store.credentials).toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      idToken: "id-new",
      expiresAt: NOW + 3600 * 1_000,
    });
  });

  it("keeps the old refresh and id tokens when the response does not rotate them", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        refreshResponse({ access_token: "access-new", expires_in: 3600 }),
      );
    const { oauth, store } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await oauth.getValidAccessToken("a1");
    expect(store.credentials).toMatchObject({
      refreshToken: "refresh-old",
      idToken: "id-old",
    });
  });

  it("single-flights concurrent refreshes", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchFn = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { oauth } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const first = oauth.getValidAccessToken("a1");
    const second = oauth.getValidAccessToken("a1");
    resolveFetch(
      refreshResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      }),
    );

    await expect(first).resolves.toBe("access-new");
    await expect(second).resolves.toBe("access-new");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("takes the expiry from the new token's exp claim over expires_in", async () => {
    const expSeconds = Math.floor((NOW + 10 * 24 * HOUR_MS) / 1_000);
    const fetchFn = vi.fn().mockResolvedValue(
      refreshResponse({
        access_token: makeCodexAccessToken({ expSeconds }),
        expires_in: 3600,
      }),
    );
    const { oauth, store } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await oauth.getValidAccessToken("a1");
    expect(store.credentials?.expiresAt).toBe(expSeconds * 1_000);
  });

  it("marks the account on invalid_grant and never retries over the network", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      }),
    );
    const { oauth, onInvalidGrant } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const error = await captureError(oauth.getValidAccessToken("a1"));
    expect(error).toBeInstanceOf(CodexOauthRefreshError);
    expect(error.terminal).toBe(true);
    expect(error.message).toMatch(/needs a fresh Codex login/);
    expect(onInvalidGrant).toHaveBeenCalledWith("a1");

    const blocked = await captureError(oauth.getValidAccessToken("a1"));
    expect(blocked.terminal).toBe(true);
    expect(blocked.message).toMatch(/needs a fresh Codex login/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("backs off after a network failure instead of hammering the endpoint", async () => {
    let now = NOW;
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(
        refreshResponse({ access_token: "access-new", expires_in: 3600 }),
      );
    const { oauth, onInvalidGrant } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });

    const error = await captureError(oauth.getValidAccessToken("a1"));
    expect(error.terminal).toBe(false);
    expect(error.message).toMatch(/socket hang up/);

    const backedOff = await captureError(oauth.getValidAccessToken("a1"));
    expect(backedOff.terminal).toBe(false);
    expect(backedOff.message).toMatch(/backing off/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onInvalidGrant).not.toHaveBeenCalled();

    now += 60_000;
    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-new");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("backs off after a server error instead of hammering the endpoint", async () => {
    let now = NOW;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValue(
        refreshResponse({ access_token: "access-new", expires_in: 3600 }),
      );
    const { oauth, onInvalidGrant } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });

    const error = await captureError(oauth.getValidAccessToken("a1"));
    expect(error.terminal).toBe(false);
    expect(error.message).toMatch(/status 500/);

    await expect(oauth.getValidAccessToken("a1")).rejects.toThrow(
      /backing off/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onInvalidGrant).not.toHaveBeenCalled();

    now += 60_000;
    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-new");
  });

  it("treats a malformed refresh response as a transient failure", async () => {
    let now = NOW;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(refreshResponse({ token: "wrong-shape" }))
      .mockResolvedValue(
        refreshResponse({ access_token: "access-new", expires_in: 3600 }),
      );
    const { oauth, setCredentials, onInvalidGrant } = createOAuth({
      credentials: makeCredentials(),
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });

    const error = await captureError(oauth.getValidAccessToken("a1"));
    expect(error.terminal).toBe(false);
    expect(error.message).toMatch(/unexpected format/);
    expect(setCredentials).not.toHaveBeenCalled();
    expect(onInvalidGrant).not.toHaveBeenCalled();

    await expect(oauth.getValidAccessToken("a1")).rejects.toThrow(
      /backing off/,
    );

    now += 60_000;
    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-new");
  });
});
