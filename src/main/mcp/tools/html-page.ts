import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HTML_MAX_INPUT_LENGTH } from "@shared/visuals";
import { z } from "zod";
import { AgentBrowserError } from "../../visuals/agent-browser";
import { HtmlPreviewUnavailableError } from "../../visuals/html-preview";
import {
  VisualImageTooLargeError,
  VisualPageTooLargeError,
} from "../../visuals/prepare-visual";
import { errorResult } from "../define-tool";

export const pageInputShape = {
  html: z
    .string()
    .min(1)
    .max(HTML_MAX_INPUT_LENGTH)
    .optional()
    .describe("A complete, self-contained HTML document. Pass this or path."),
  path: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Path to an .html file holding the page, absolute or relative to the session working directory. Pass this or html.",
    ),
};

export const PAGE_SOURCE =
  "Pass the page inline as html, or write it to an .html file and pass its path, which lets you fix a page with small edits between calls.";

class PageSourceError extends Error {}

// UTF-8 needs at most 4 bytes per character.
const MAX_PAGE_FILE_BYTES = HTML_MAX_INPUT_LENGTH * 4;

export async function readPageSource(
  input: { html?: string; path?: string },
  cwd: string | null,
): Promise<string> {
  if ((input.html === undefined) === (input.path === undefined)) {
    throw new PageSourceError("Pass exactly one of html or path.");
  }
  if (input.html !== undefined) return input.html;

  const inputPath = input.path ?? "";
  if (!cwd && !path.isAbsolute(inputPath)) {
    throw new PageSourceError(
      `${inputPath} is relative and there is no session working directory; use an absolute path.`,
    );
  }
  const filePath = path.resolve(cwd ?? "/", inputPath);
  if (!/\.html?$/i.test(filePath)) {
    throw new PageSourceError(`${filePath} is not an .html or .htm file.`);
  }
  const stats = await stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    throw new PageSourceError(`${filePath} does not exist or is not a file.`);
  }
  if (stats.size > MAX_PAGE_FILE_BYTES) {
    throw new PageSourceError(
      `${filePath} is too large; a page can be at most ${HTML_MAX_INPUT_LENGTH} characters.`,
    );
  }
  const html = await readFile(filePath, "utf8");
  if (html.length === 0 || html.length > HTML_MAX_INPUT_LENGTH) {
    throw new PageSourceError(
      `${filePath} must hold between 1 and ${HTML_MAX_INPUT_LENGTH} characters.`,
    );
  }
  return html;
}

export const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.';

export function knownPageErrorResult(error: unknown): CallToolResult | null {
  if (
    error instanceof PageSourceError ||
    error instanceof VisualImageTooLargeError ||
    error instanceof VisualPageTooLargeError ||
    error instanceof HtmlPreviewUnavailableError ||
    error instanceof AgentBrowserError
  ) {
    return errorResult(error.message);
  }
  return null;
}
