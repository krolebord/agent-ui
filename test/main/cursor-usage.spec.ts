import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
const homedirMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
}));

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

vi.mock("../../src/main/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getCursorUsage } from "../../src/main/cursor-usage";

const fetchMock = vi.fn();

function makeEnoentError() {
  const error = new Error("not found") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function setPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getCursorUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CURSOR_API_KEY", "");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    homedirMock.mockReturnValue("/home/tester");
    readFileMock.mockResolvedValue(
      JSON.stringify({
        accessToken: "cursor-access-token",
        refreshToken: "cursor-refresh-token",
      }),
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/GetCurrentPeriodUsage")) {
        return jsonResponse({
          billingCycleStart: "1782977854000",
          billingCycleEnd: "1785656254000",
          planUsage: {
            includedSpend: 1_825,
            limit: 2_000,
            autoPercentUsed: 12.5,
            apiPercentUsed: 3,
            totalPercentUsed: 9.5,
          },
          spendLimitUsage: {
            individualLimit: 10_000,
            individualUsed: 2_500,
          },
        });
      }
      if (url.endsWith("/GetPlanInfo")) {
        return jsonResponse({
          planInfo: { planName: "Pro", includedAmountCents: 2_000 },
        });
      }
      if (url.endsWith("/GetCreditGrantsBalance")) {
        return jsonResponse({
          hasCreditGrants: true,
          creditBalanceCents: "1234",
          totalCents: "2000",
          usedCents: "766",
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads Cursor Agent credentials from the Linux config directory", async () => {
    setPlatform("linux");

    const result = await getCursorUsage();

    expect(readFileMock).toHaveBeenCalledWith(
      "/home/tester/.config/cursor/auth.json",
      "utf8",
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      usage: {
        membershipType: "Pro",
        planUsage: {
          autoPercentUsed: 12.5,
          apiPercentUsed: 3,
        },
        credits: { balance: 12.34 },
      },
    });
  });

  it("honors XDG_CONFIG_HOME", async () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");

    await getCursorUsage();

    expect(readFileMock).toHaveBeenCalledWith("/xdg/cursor/auth.json", "utf8");
  });

  it("prefers Cursor Agent credentials on macOS", async () => {
    setPlatform("darwin");

    const result = await getCursorUsage();

    expect(readFileMock).toHaveBeenCalledWith(
      "/home/tester/.cursor/auth.json",
      "utf8",
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });

  it("reads the default Cursor Agent macOS Keychain token", async () => {
    setPlatform("darwin");
    readFileMock.mockRejectedValue(makeEnoentError());
    spawnMock.mockResolvedValue({ output: "keychain-access-token" });

    const result = await getCursorUsage();

    expect(spawnMock).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-a",
        "cursor-user",
        "-s",
        "cursor-access-token",
        "-w",
      ],
      { timeout: 5_000, stdin: "ignore" },
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true });
  });

  it("falls back to Cursor Desktop state on macOS", async () => {
    setPlatform("darwin");
    readFileMock.mockRejectedValue(makeEnoentError());
    spawnMock
      .mockRejectedValueOnce(new Error("keychain token not found"))
      .mockResolvedValueOnce({ output: "desktop-access-token" });

    const result = await getCursorUsage();

    expect(spawnMock).toHaveBeenCalledWith(
      "sqlite3",
      [
        "/home/tester/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
      ],
      { timeout: 5_000, stdin: "ignore" },
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true });
  });

  it("does not run the macOS SQLite fallback on Linux", async () => {
    setPlatform("linux");
    readFileMock.mockRejectedValue(makeEnoentError());

    const result = await getCursorUsage();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: "Failed to read Cursor access token",
    });
  });

  it("degrades gracefully when plan and credit enrichment fail", async () => {
    setPlatform("linux");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/GetCurrentPeriodUsage")) {
        return jsonResponse({
          billingCycleEnd: "1785656254000",
          planUsage: { limit: 2_000, remaining: 500 },
        });
      }
      return new Response("failed", { status: 500, statusText: "Failed" });
    });

    const result = await getCursorUsage();

    expect(result).toMatchObject({
      ok: true,
      usage: {
        membershipType: null,
        credits: null,
        planUsage: {
          includedSpend: 1_500,
          totalPercentUsed: 75,
        },
      },
    });
  });

  it("does not show account-plan usage for CURSOR_API_KEY authentication", async () => {
    setPlatform("linux");
    vi.stubEnv("CURSOR_API_KEY", "cursor-api-key");

    const result = await getCursorUsage();

    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: "Cursor plan usage is unavailable with API key authentication",
    });
  });
});
