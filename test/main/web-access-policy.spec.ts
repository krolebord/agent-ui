import { describe, expect, it } from "vitest";
import {
  isAllowedHost,
  isAllowedOrigin,
  parseAllowedHosts,
} from "../../src/main/web-access-policy";

const allowedHosts = parseAllowedHosts(" Agent.Example.COM. ,,bad/host");

describe("web access policy", () => {
  it.each([
    ["localhost:3420", true],
    ["127.0.0.1", true],
    ["[::1]:3420", true],
    ["agent.example.com:443", true],
    ["evil.com", false],
    ["agent.example.com.evil.com", false],
    ["sub.agent.example.com", false],
    ["localhost.evil.com", false],
    ["evil.com@localhost", false],
    [undefined, false],
  ])("Host %s → %s", (host, allowed) => {
    expect(isAllowedHost(host, allowedHosts)).toBe(allowed);
  });

  it.each([
    [undefined, true],
    ["https://agent.example.com", true],
    ["http://localhost:5173", true],
    ["https://evil.com", false],
    ["https://other.ts.net", false],
    ["null", false],
    ["file://", false],
    ["chrome-extension://localhost", false],
  ])("Origin %s → %s", (origin, allowed) => {
    expect(isAllowedOrigin(origin, allowedHosts)).toBe(allowed);
  });
});
