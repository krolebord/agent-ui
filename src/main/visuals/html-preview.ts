import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type AgentBrowserCommandResult,
  AgentBrowserError,
  type AgentBrowserRunner,
} from "./agent-browser";

export interface HtmlPreviewConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}

export interface HtmlPreviewResult {
  width: number;
  contentHeight: number;
  capturedHeight: number;
  consoleMessages: HtmlPreviewConsoleMessage[];
  errors: string[];
  screenshotPath: string;
  screenshotBase64: string;
}

export interface HtmlPreviewer {
  preview(input: { html: string; width: number }): Promise<HtmlPreviewResult>;
}

export class HtmlPreviewUnavailableError extends Error {
  override name = "HtmlPreviewUnavailableError";
}

// A made-up origin served by a mocked route, so the page never loads from
// file:// and cannot embed local files. It must not match BLOCKED_URL_PATTERNS.
export const PREVIEW_PAGE_URL = "http://agent-ui-visual.invalid/page.html";
const PAGE_NAME = "page.html";

const BLOCKED_HOSTS = [
  "localhost",
  "*.localhost",
  "127.*",
  "0.0.0.0",
  "10.*",
  ...Array.from({ length: 16 }, (_, index) => `172.${16 + index}.*`),
  "192.168.*",
  "169.254.*",
  "100.*",
  "*.ts.net",
  "[::1]",
  "[::ffff:*",
  "[fc*",
  "[fd*",
  "[fe80:*",
];

export const BLOCKED_URL_PATTERNS = ["http", "https"].flatMap((scheme) =>
  BLOCKED_HOSTS.map((host) => `${scheme}://${host}*`),
);

const VIEWPORT_HEIGHT = 800;
const MIN_CAPTURE_HEIGHT = 80;
const MAX_CAPTURE_HEIGHT = 2_000;
const NETWORK_IDLE_TIMEOUT_MS = 5_000;
const SETTLE_MS = 300;
const LOAD_BATCH_TIMEOUT_MS = 45_000;
const INSPECT_BATCH_TIMEOUT_MS = 15_000;
const CAPTURE_BATCH_TIMEOUT_MS = 20_000;
const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const MAX_ERRORS = 20;
const MAX_ERROR_TEXT_CHARS = 1_000;
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CONTENT_HEIGHT_SCRIPT =
  "(() => { const root = document.documentElement; return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height); })()";

const evalResultSchema = z.object({ result: z.number() });
const consoleResultSchema = z.object({
  messages: z.array(z.object({ type: z.string(), text: z.string() })),
});
const errorsResultSchema = z.object({
  errors: z.array(z.object({ text: z.string() })),
});

const SANDBOX_MESSAGE =
  "The preview browser could not start because Chrome's sandbox can't run on this host. " +
  'Fix it by adding {"args": "--no-sandbox"} to ~/.agent-browser/config.json, or by installing an AppArmor profile for agent-browser\'s Chrome. ' +
  "html_render still works without a preview.";

function unavailable(detail: string): HtmlPreviewUnavailableError {
  if (detail.includes("No usable sandbox")) {
    return new HtmlPreviewUnavailableError(SANDBOX_MESSAGE);
  }
  return new HtmlPreviewUnavailableError(
    `The preview browser failed: ${detail.slice(0, 1_000)}`,
  );
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function namePage(text: string): string {
  return text.replaceAll(PREVIEW_PAGE_URL, PAGE_NAME);
}

function consoleLevel(type: string): HtmlPreviewConsoleMessage["level"] {
  if (type === "warning" || type === "warn") return "warning";
  if (type === "error" || type === "assert") return "error";
  if (type === "info") return "info";
  return "log";
}

function requireSuccess(results: AgentBrowserCommandResult[]): void {
  const failed = results.find((result) => !result.success);
  if (failed) {
    throw unavailable(
      `${failed.command.slice(0, 2).join(" ")}: ${failed.error ?? "failed"}`,
    );
  }
}

function resultOf<T>(
  results: AgentBrowserCommandResult[],
  name: string,
  schema: z.ZodType<T>,
): T {
  const entry = results.find((result) => result.command[0] === name);
  const parsed = schema.safeParse(entry?.result);
  if (!parsed.success) {
    throw unavailable(`unexpected ${name} output from agent-browser`);
  }
  return parsed.data;
}

async function pruneScreenshots(directory: string, now: number) {
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".png"))
      .map(async (entry) => {
        const filePath = path.join(directory, entry);
        const stats = await stat(filePath).catch(() => null);
        if (stats && now - stats.mtimeMs > SCREENSHOT_MAX_AGE_MS) {
          await rm(filePath, { force: true }).catch(() => undefined);
        }
      }),
  );
}

function createLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export function createHtmlPreviewer(options: {
  runner: AgentBrowserRunner;
  screenshotDir: string;
  maxConcurrent?: number;
  now?: () => number;
}): HtmlPreviewer {
  const { runner, screenshotDir } = options;
  const now = options.now ?? Date.now;
  const limit = createLimiter(options.maxConcurrent ?? 2);

  async function batch(
    session: string,
    commands: string[][],
    timeoutMs: number,
  ): Promise<AgentBrowserCommandResult[]> {
    try {
      return await runner.batch(session, commands, { timeoutMs });
    } catch (error) {
      if (error instanceof AgentBrowserError) throw unavailable(error.message);
      throw error;
    }
  }

  async function runPreview(input: {
    html: string;
    width: number;
  }): Promise<HtmlPreviewResult> {
    const id = randomUUID();
    const session = `agent-ui-preview-${id}`;
    const width = Math.round(input.width);
    await mkdir(screenshotDir, { recursive: true });
    await pruneScreenshots(screenshotDir, now());

    try {
      const loaded = await batch(
        session,
        [
          ["set", "viewport", String(width), String(VIEWPORT_HEIGHT)],
          ...BLOCKED_URL_PATTERNS.map((pattern) => [
            "network",
            "route",
            pattern,
            "--abort",
          ]),
          ["network", "route", PREVIEW_PAGE_URL, "--body", input.html],
          ["open", PREVIEW_PAGE_URL],
          [
            "wait",
            "--load",
            "networkidle",
            "--timeout",
            String(NETWORK_IDLE_TIMEOUT_MS),
          ],
        ],
        LOAD_BATCH_TIMEOUT_MS,
      );
      // A page that keeps the network busy still gets previewed.
      requireSuccess(loaded.filter((result) => result.command[0] !== "wait"));

      const inspected = await batch(
        session,
        [
          ["wait", String(SETTLE_MS)],
          ["eval", CONTENT_HEIGHT_SCRIPT],
          ["console"],
          ["errors"],
        ],
        INSPECT_BATCH_TIMEOUT_MS,
      );
      requireSuccess(inspected);
      const contentHeight = Math.max(
        1,
        Math.ceil(resultOf(inspected, "eval", evalResultSchema).result),
      );
      const consoleMessages = resultOf(
        inspected,
        "console",
        consoleResultSchema,
      )
        .messages.slice(0, MAX_CONSOLE_MESSAGES)
        .map((message) => ({
          level: consoleLevel(message.type),
          text: truncate(namePage(message.text), MAX_CONSOLE_TEXT_CHARS),
        }));
      const errors = resultOf(inspected, "errors", errorsResultSchema)
        .errors.slice(0, MAX_ERRORS)
        .map((error) => truncate(namePage(error.text), MAX_ERROR_TEXT_CHARS));

      const capturedHeight = Math.min(
        MAX_CAPTURE_HEIGHT,
        Math.max(MIN_CAPTURE_HEIGHT, contentHeight),
      );
      const screenshotPath = path.join(screenshotDir, `${id}.png`);
      const captured = await batch(
        session,
        [
          ["set", "viewport", String(width), String(capturedHeight)],
          ["screenshot", screenshotPath],
        ],
        CAPTURE_BATCH_TIMEOUT_MS,
      );
      requireSuccess(captured);
      const screenshot = await readFile(screenshotPath);

      return {
        width,
        contentHeight,
        capturedHeight,
        consoleMessages,
        errors,
        screenshotPath,
        screenshotBase64: screenshot.toString("base64"),
      };
    } finally {
      await runner.close(session);
    }
  }

  return {
    preview: (input) => limit(() => runPreview(input)),
  };
}
