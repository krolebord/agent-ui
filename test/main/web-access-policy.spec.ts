import { describe, expect, it } from "vitest";
import {
  isAllowedHost,
  isAllowedOrigin,
  normalizeAllowedHosts,
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

  it("normalizes bare hosts and URLs, dropping invalid entries and duplicates", () => {
    expect(
      normalizeAllowedHosts([
        " My-Mac.Tailnet.ts.net ",
        "https://my-mac.tailnet.ts.net/some/path",
        "my-mac.tailnet.ts.net:443",
        "http://100.64.0.1:3420",
        "bad/host",
        "ftp://example.com",
        "",
      ]),
    ).toEqual(["my-mac.tailnet.ts.net", "100.64.0.1"]);
  });
});
