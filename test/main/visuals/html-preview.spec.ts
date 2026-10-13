import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentBrowserCommandResult,
  AgentBrowserError,
  type AgentBrowserRunner,
} from "../../../src/main/visuals/agent-browser";
import {
  BLOCKED_URL_PATTERNS,
  createHtmlPreviewer,
  HtmlPreviewUnavailableError,
  PREVIEW_PAGE_URL,
} from "../../../src/main/visuals/html-preview";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

interface PageBehavior {
  contentHeight?: number;
  consoleMessages?: Array<{ type: string; text: string }>;
  errors?: Array<{ text: string }>;
  failOpen?: string;
  failNetworkIdle?: boolean;
  throwOnLoad?: Error;
}

function ok(
  command: string[],
  result: unknown = {},
): AgentBrowserCommandResult {
  return { command, success: true, error: null, result };
}

function createFakeRunner(page: PageBehavior = {}) {
  const batches: Array<{ session: string; commands: string[][] }> = [];
  const closed: string[] = [];
  let openSessions = 0;
  let maxOpenSessions = 0;
  const sessions = new Set<string>();
  const runner: AgentBrowserRunner = {
    async batch(session, commands) {
      if (!sessions.has(session)) {
        sessions.add(session);
        openSessions += 1;
        maxOpenSessions = Math.max(maxOpenSessions, openSessions);
      }
      batches.push({ session, commands });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (page.throwOnLoad && commands.some(([name]) => name === "open")) {
        throw page.throwOnLoad;
      }
      const results: AgentBrowserCommandResult[] = [];
      for (const command of commands) {
        const [name, ...args] = command;
        if (name === "open" && page.failOpen) {
          results.push({
            command,
            success: false,
            error: page.failOpen,
            result: null,
          });
          break;
        }
        if (name === "wait" && args[0] === "--load" && page.failNetworkIdle) {
          results.push({
            command,
            success: false,
            error: "Operation timed out.",
            result: null,
          });
          break;
        }
        if (name === "eval") {
          results.push(ok(command, { result: page.contentHeight ?? 640 }));
        } else if (name === "console") {
          results.push(ok(command, { messages: page.consoleMessages ?? [] }));
        } else if (name === "errors") {
          results.push(ok(command, { errors: page.errors ?? [] }));
        } else if (name === "screenshot") {
          await writeFile(args[0] ?? "", PNG_BYTES);
          results.push(ok(command, { path: args[0] }));
        } else {
          results.push(ok(command));
        }
      }
      return results;
    },
    async close(session) {
      closed.push(session);
      if (sessions.delete(session)) openSessions -= 1;
    },
  };
  return {
    runner,
    batches,
    closed,
    maxOpenSessions: () => maxOpenSessions,
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

describe("createHtmlPreviewer", () => {
  let screenshotDir: string;

  beforeEach(async () => {
    screenshotDir = await mkdtemp(path.join(os.tmpdir(), "html-preview-"));
  });

  afterEach(async () => {
    await rm(screenshotDir, { recursive: true, force: true });
  });

  it("loads the page behind local-network blocks, measures, and captures it", async () => {
    const fake = createFakeRunner({
      contentHeight: 912.4,
      consoleMessages: [
        { type: "log", text: "ready" },
        { type: "warning", text: "careful" },
        { type: "error", text: `failed at ${PREVIEW_PAGE_URL}:3:9` },
        { type: "info", text: "fyi" },
        { type: "debug", text: "verbose" },
      ],
      errors: [{ text: `ReferenceError: x\n    at ${PREVIEW_PAGE_URL}:4:2` }],
    });
    const previewer = createHtmlPreviewer({
      runner: fake.runner,
      screenshotDir,
    });

    const result = await previewer.preview({ html: "<h1>Hi</h1>", width: 728 });

    const [load, inspect, capture] = fake.batches;
    const session = load?.session ?? "";
    expect(session).toMatch(/^agent-ui-preview-/);
    expect(fake.batches.every((batch) => batch.session === session)).toBe(true);
    expect(load?.commands[0]).toEqual(["set", "viewport", "728", "800"]);
    for (const pattern of BLOCKED_URL_PATTERNS) {
      expect(load?.commands).toContainEqual([
        "network",
        "route",
        pattern,
        "--abort",
      ]);
    }
    expect(load?.commands.slice(-3)).toEqual([
      ["network", "route", PREVIEW_PAGE_URL, "--body", "<h1>Hi</h1>"],
      ["open", PREVIEW_PAGE_URL],
      ["wait", "--load", "networkidle", "--timeout", "5000"],
    ]);
    expect(inspect?.commands.map(([name]) => name)).toEqual([
      "wait",
      "eval",
      "console",
      "errors",
    ]);
    expect(capture?.commands).toEqual([
      ["set", "viewport", "728", "913"],
      ["screenshot", result.screenshotPath],
    ]);
    expect(path.dirname(result.screenshotPath)).toBe(screenshotDir);
    expect(result).toMatchObject({
      width: 728,
      contentHeight: 913,
      capturedHeight: 913,
      consoleMessages: [
        { level: "log", text: "ready" },
        { level: "warning", text: "careful" },
        { level: "error", text: "failed at page.html:3:9" },
        { level: "info", text: "fyi" },
        { level: "log", text: "verbose" },
      ],
      errors: ["ReferenceError: x\n    at page.html:4:2"],
      screenshotBase64: PNG_BYTES.toString("base64"),
    });
    expect(fake.closed).toEqual([session]);
  });

  it("blocks loopback and private hosts but never its own page", () => {
    const blocks = (url: string) =>
      BLOCKED_URL_PATTERNS.some((pattern) => globToRegExp(pattern).test(url));

    expect(blocks(PREVIEW_PAGE_URL)).toBe(false);
    expect(blocks("https://cdn.jsdelivr.net/npm/chart.js")).toBe(false);
    for (const url of [
      "http://localhost:3420/rpc",
      "http://app.localhost/",
      "http://127.0.0.1:8080/",
      "https://10.0.0.5/",
      "http://172.20.1.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.101.102.103/",
      "https://box.tail1234.ts.net/",
      "http://[::1]:3420/",
      "http://[fd12::1]/",
    ]) {
      expect(blocks(url), url).toBe(true);
    }
  });

  it("previews a page whose network never goes idle", async () => {
    const fake = createFakeRunner({ failNetworkIdle: true });
    const previewer = createHtmlPreviewer({
      runner: fake.runner,
      screenshotDir,
    });

    await expect(
      previewer.preview({ html: "<p>busy</p>", width: 400 }),
    ).resolves.toMatchObject({ contentHeight: 640 });
  });

  it("clamps the captured height", async () => {
    const tall = createFakeRunner({ contentHeight: 5_000 });
    const short = createFakeRunner({ contentHeight: 12 });

    const tallResult = await createHtmlPreviewer({
      runner: tall.runner,
      screenshotDir,
    }).preview({ html: "x", width: 728 });
    const shortResult = await createHtmlPreviewer({
      runner: short.runner,
      screenshotDir,
    }).preview({ html: "x", width: 728 });

    expect(tallResult).toMatchObject({
      contentHeight: 5_000,
      capturedHeight: 2_000,
    });
    expect(shortResult).toMatchObject({
      contentHeight: 12,
      capturedHeight: 80,
    });
  });

  it("caps console messages and errors", async () => {
    const fake = createFakeRunner({
      consoleMessages: Array.from({ length: 30 }, (_, index) => ({
        type: "log",
        text: index === 0 ? "a".repeat(600) : `message ${index}`,
      })),
      errors: Array.from({ length: 25 }, () => ({ text: "e".repeat(1_200) })),
    });

    const result = await createHtmlPreviewer({
      runner: fake.runner,
      screenshotDir,
    }).preview({ html: "x", width: 728 });

    expect(result.consoleMessages).toHaveLength(20);
    expect(result.consoleMessages[0]?.text).toBe(`${"a".repeat(500)}…`);
    expect(result.errors).toHaveLength(20);
    expect(result.errors[0]).toBe(`${"e".repeat(1_000)}…`);
  });

  it("reports a page that fails to open and still closes the session", async () => {
    const fake = createFakeRunner({ failOpen: "net::ERR_FAILED" });
    const previewer = createHtmlPreviewer({
      runner: fake.runner,
      screenshotDir,
    });

    const preview = previewer.preview({ html: "x", width: 728 });
    await expect(preview).rejects.toBeInstanceOf(HtmlPreviewUnavailableError);
    await expect(preview).rejects.toThrow("net::ERR_FAILED");
    expect(fake.closed).toHaveLength(1);
  });

  it("explains how to fix a Chrome sandbox that can't start", async () => {
    const fake = createFakeRunner({
      throwOnLoad: new AgentBrowserError(
        "Auto-launch failed: FATAL: No usable sandbox! Try --no-sandbox",
      ),
    });
    const previewer = createHtmlPreviewer({
      runner: fake.runner,
      screenshotDir,
    });

    const preview = previewer.preview({ html: "x", width: 728 });
    await expect(preview).rejects.toBeInstanceOf(HtmlPreviewUnavailableError);
    await expect(preview).rejects.toThrow(
      '{"args": "--no-sandbox"} to ~/.agent-browser/config.json',
    );
    expect(fake.closed).toHaveLength(1);
  });

  it("runs at most maxConcurrent previews at once", async () => {
    const fake = createFakeRunner();
    const previewer = createHtmlPreviewer({
      runner: fake.runner,
      screenshotDir,
      maxConcurrent: 2,
    });

    await Promise.all(
      Array.from({ length: 5 }, () =>
        previewer.preview({ html: "x", width: 728 }),
      ),
    );

    expect(fake.maxOpenSessions()).toBe(2);
    expect(fake.closed).toHaveLength(5);
  });

  it("prunes screenshots older than a day", async () => {
    const now = Date.now();
    const stale = path.join(screenshotDir, "stale.png");
    const fresh = path.join(screenshotDir, "fresh.png");
    await writeFile(stale, PNG_BYTES);
    await writeFile(fresh, PNG_BYTES);
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);

    const result = await createHtmlPreviewer({
      runner: createFakeRunner().runner,
      screenshotDir,
      now: () => now,
    }).preview({ html: "x", width: 728 });

    expect((await readdir(screenshotDir)).sort()).toEqual(
      ["fresh.png", path.basename(result.screenshotPath)].sort(),
    );
  });
});
