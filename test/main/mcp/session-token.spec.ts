import { describe, expect, it } from "vitest";
import { McpSessionTokens } from "../../../src/main/mcp/session-token";

describe("McpSessionTokens", () => {
  it("round-trips a cwd", () => {
    const tokens = new McpSessionTokens();
    const token = tokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    expect(tokens.verify(token)).toEqual({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
  });

  it("round-trips a null cwd", () => {
    const tokens = new McpSessionTokens();
    const token = tokens.sign({ cwd: null, canScheduleSessions: true });
    expect(tokens.verify(token)).toEqual({
      cwd: null,
      canScheduleSessions: true,
    });
  });

  it("round-trips a blocked canScheduleSessions flag", () => {
    const tokens = new McpSessionTokens();
    const token = tokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: false,
    });
    expect(tokens.verify(token)).toEqual({
      cwd: "/home/user/project",
      canScheduleSessions: false,
    });
  });

  it("rejects missing and malformed tokens", () => {
    const tokens = new McpSessionTokens();
    expect(tokens.verify(null)).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
    expect(tokens.verify("")).toBeNull();
    expect(tokens.verify("no-separator")).toBeNull();
    expect(tokens.verify("garbage.garbage")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const tokens = new McpSessionTokens();
    const token = tokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: false,
    });
    const [, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ cwd: "/somewhere/else", canScheduleSessions: true }),
    ).toString("base64url");
    expect(tokens.verify(`${forgedPayload}.${mac}`)).toBeNull();
  });

  it("rejects tokens signed by another instance", () => {
    const tokens = new McpSessionTokens();
    const other = new McpSessionTokens();
    const token = other.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    expect(tokens.verify(token)).toBeNull();
  });
});
