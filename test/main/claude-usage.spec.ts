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

import { getUsage } from "../../src/main/claude-usage";

const fetchMock = vi.fn();

function buildCredentials(expiresAt = Date.now() + 60_000) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-access-token",
      refreshToken: "claude-refresh-token",
      expiresAt,
    },
  });
}

function buildUsageResponse() {
  return JSON.stringify({
    five_hour: { utilization: 25, resets_at: "2026-07-10T15:00:00Z" },
    seven_day: { utilization: 10, resets_at: "2026-07-14T00:00:00Z" },
    seven_day_sonnet: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
    },
  });
}

function setPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

describe("getUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "");
    vi.stubEnv("CLAUDE_CODE_USE_FOUNDRY", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    homedirMock.mockReturnValue("/home/tester");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(buildUsageResponse(), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads Linux credentials from ~/.claude", async () => {
    setPlatform("linux");
    readFileMock.mockResolvedValue(buildCredentials());

    const result = await getUsage();

    expect(readFileMock).toHaveBeenCalledWith(
      "/home/tester/.claude/.credentials.json",
      "utf8",
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      usage: { five_hour: { utilization: 25 } },
    });
  });

  it("honors CLAUDE_CONFIG_DIR on Linux", async () => {
    setPlatform("linux");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/custom/claude");
    readFileMock.mockResolvedValue(buildCredentials());

    await getUsage();

    expect(readFileMock).toHaveBeenCalledWith(
      "/custom/claude/.credentials.json",
      "utf8",
    );
  });

  it("prefers the macOS Keychain", async () => {
    setPlatform("darwin");
    spawnMock.mockResolvedValue({ output: buildCredentials() });

    const result = await getUsage();

    expect(spawnMock).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5_000, stdin: "ignore" },
    );
    expect(readFileMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });

  it("falls back to the credentials file when Keychain is unavailable", async () => {
    setPlatform("darwin");
    spawnMock.mockRejectedValue(new Error("not found"));
    readFileMock.mockResolvedValue(buildCredentials());

    const result = await getUsage();

    expect(readFileMock).toHaveBeenCalledWith(
      "/home/tester/.claude/.credentials.json",
      "utf8",
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("treats expiresAt as milliseconds", async () => {
    setPlatform("linux");
    readFileMock.mockResolvedValue(buildCredentials(Date.now() - 1));

    const result = await getUsage();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: "Claude access token has expired",
    });
  });

  it("accepts legacy second-based expiresAt values", async () => {
    setPlatform("linux");
    readFileMock.mockResolvedValue(
      buildCredentials(Math.floor(Date.now() / 1_000) + 60),
    );

    const result = await getUsage();

    expect(result).toMatchObject({ ok: true });
  });

  it("does not show subscription usage when API billing is active", async () => {
    setPlatform("linux");
    vi.stubEnv("ANTHROPIC_API_KEY", "api-key");

    const result = await getUsage();

    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: "Claude plan usage is unavailable with API billing",
    });
  });
});
