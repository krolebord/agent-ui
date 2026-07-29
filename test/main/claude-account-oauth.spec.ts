import { describe, expect, it, vi } from "vitest";
import {
  ClaudeAccountOAuth,
  type ManagedOauthCredentials,
} from "../../src/main/claude-account-oauth";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeCredentials(
  overrides: Partial<ManagedOauthCredentials> = {},
): ManagedOauthCredentials {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: 0,
    scopes: ["user:inference", "user:profile"],
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
  credentials: ManagedOauthCredentials | null;
  blocked?: boolean;
  fetchFn: typeof fetch;
  now?: () => number;
}) {
  const setCredentials = vi.fn();
  const onInvalidGrant = vi.fn();
  const store = { credentials: options.credentials };
  const oauth = new ClaudeAccountOAuth({
    getCredentials: () =>
      store.credentials
        ? { ...store.credentials, blocked: options.blocked }
        : null,
    setCredentials: (_accountId, credentials) => {
      store.credentials = credentials;
      setCredentials(_accountId, credentials);
    },
    onInvalidGrant,
    fetchFn: options.fetchFn,
    now: options.now ?? (() => 1_000_000),
  });
  return { oauth, setCredentials, onInvalidGrant, store };
}

describe("ClaudeAccountOAuth", () => {
  it("returns the stored token while it is fresh", async () => {
    const fetchFn = vi.fn();
    const { oauth } = createOAuth({
      // Expires 10 minutes from "now" — outside the 5-minute margin.
      credentials: makeCredentials({ expiresAt: 1_000_000 + 10 * 60_000 }),
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
        expires_in: 3600,
      }),
    );
    const { oauth, setCredentials, store } = createOAuth({
      // Expires 1 minute from "now" — inside the 5-minute margin.
      credentials: makeCredentials({ expiresAt: 1_000_000 + 60_000 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-new");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-old");

    expect(setCredentials).toHaveBeenCalledTimes(1);
    expect(store.credentials).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: 1_000_000 + 3600 * 1_000,
      scopes: ["user:inference", "user:profile"],
    });
  });

  it("keeps the old refresh token when the response does not rotate it", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        refreshResponse({ access_token: "access-new", expires_in: 3600 }),
      );
    const { oauth, store } = createOAuth({
      credentials: makeCredentials({ expiresAt: 0 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await oauth.getValidAccessToken("a1");
    expect(store.credentials?.refreshToken).toBe("refresh-old");
  });

  it("single-flights concurrent refreshes", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchFn = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { oauth } = createOAuth({
      credentials: makeCredentials({ expiresAt: 0 }),
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

  it("marks the account on invalid_grant and blocks further refreshes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      }),
    );
    const options = {
      credentials: makeCredentials({ expiresAt: 0 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    };
    const { oauth, onInvalidGrant } = createOAuth(options);

    await expect(oauth.getValidAccessToken("a1")).rejects.toThrow(
      /needs a fresh Claude login/,
    );
    expect(onInvalidGrant).toHaveBeenCalledWith("a1");

    // Simulate the account now being flagged: refreshes are gated.
    options.credentials = makeCredentials({ expiresAt: 0 });
    const gated = createOAuth({ ...options, blocked: true });
    await expect(gated.oauth.getValidAccessToken("a1")).rejects.toThrow(
      /needs a fresh Claude login/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("backs off after a transient failure instead of hammering the endpoint", async () => {
    let now = 1_000_000;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValue(
        refreshResponse({ access_token: "access-new", expires_in: 3600 }),
      );
    const { oauth } = createOAuth({
      credentials: makeCredentials({ expiresAt: 0 }),
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });

    await expect(oauth.getValidAccessToken("a1")).rejects.toThrow(/status 500/);
    await expect(oauth.getValidAccessToken("a1")).rejects.toThrow(
      /backing off/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 60_000;
    await expect(oauth.getValidAccessToken("a1")).resolves.toBe("access-new");
  });
});
