import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  injectVisualBootstrap,
  readVisualContentHeight,
  VISUAL_THEME_VARIABLES,
} from "../../src/shared/visuals";

const THEME_STYLE = '<style id="agent-ui-theme">';

describe("injectVisualBootstrap", () => {
  it("inserts the bootstrap at the start of an existing head", () => {
    const html =
      "<!doctype html><html><head><style>p{color:red}</style></head><body><p>Hi</p></body></html>";
    const result = injectVisualBootstrap(html);

    expect(result.startsWith("<!doctype html><html><head><meta")).toBe(true);
    expect(result.indexOf(THEME_STYLE)).toBeLessThan(
      result.indexOf("<style>p{color:red}"),
    );
    expect(result).toContain('<meta charset="utf-8">');
    expect(result).toContain('<meta name="viewport"');
    expect(result.endsWith("<body><p>Hi</p></body></html>")).toBe(true);
  });

  it("adds a head after the html tag when there is none", () => {
    const result = injectVisualBootstrap(
      '<html lang="en"><body>x</body></html>',
    );

    expect(result.startsWith('<html lang="en"><head><meta')).toBe(true);
    expect(result).toContain(`</head><body>x</body></html>`);
  });

  it("adds a head after a doctype when there is no html tag", () => {
    const result = injectVisualBootstrap("<!DOCTYPE html><p>x</p>");

    expect(result.startsWith("<!DOCTYPE html><head><meta")).toBe(true);
    expect(result.endsWith("</head><p>x</p>")).toBe(true);
  });

  it("wraps a bare fragment in a document", () => {
    const result = injectVisualBootstrap("<p>x</p>");

    expect(result.startsWith("<!doctype html><head><meta")).toBe(true);
    expect(result.endsWith("</head><p>x</p>")).toBe(true);
  });

  it("ignores head tags inside scripts, comments, and templates", () => {
    const html =
      '<!-- <head> --><script>const s = "<head>";</script><template><head></template><html><head></head><body></body></html>';
    const result = injectVisualBootstrap(html);

    expect(result.indexOf(THEME_STYLE)).toBeGreaterThan(
      result.indexOf("<html><head>"),
    );
    expect(result.split(THEME_STYLE)).toHaveLength(2);
    expect(result).toContain(
      '<!-- <head> --><script>const s = "<head>";</script>',
    );
  });

  it("keeps existing charset and viewport meta tags", () => {
    const html =
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=500"></head></html>';
    const result = injectVisualBootstrap(html);

    expect(result.match(/<meta\s[^>]*charset/gi)).toHaveLength(1);
    expect(result.match(/name="viewport"/g)).toHaveLength(1);
    expect(result).toContain(THEME_STYLE);
  });

  it("injects every theme variable on :root", () => {
    const result = injectVisualBootstrap("<p>x</p>");

    expect(result).toContain(":root{color-scheme:dark;");
    for (const [name, value] of Object.entries(VISUAL_THEME_VARIABLES)) {
      expect(result).toContain(`${name}:${value};`);
    }
  });
});

describe("VISUAL_THEME_VARIABLES", () => {
  it("matches the renderer's :root variables", () => {
    const css = readFileSync(
      path.join(__dirname, "../../src/renderer/src/index.css"),
      "utf8",
    );
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(root).toBeDefined();
    const declarations = [
      ...(root ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g),
    ].map((match) => [match[1], match[2]?.trim()]);

    expect(declarations.length).toBeGreaterThan(0);
    for (const [name, value] of declarations) {
      expect(VISUAL_THEME_VARIABLES[name as string], name).toBe(value);
    }
  });
});

describe("readVisualContentHeight", () => {
  it("reads the height a framed visual reports", () => {
    expect(
      readVisualContentHeight({ type: "agent-ui-visual-size", height: 249 }),
    ).toBe(249);
  });

  it.each([
    null,
    "agent-ui-visual-size",
    { type: "other", height: 249 },
    { type: "agent-ui-visual-size", height: "249" },
    { type: "agent-ui-visual-size", height: 0 },
    { type: "agent-ui-visual-size", height: Number.POSITIVE_INFINITY },
  ])("ignores %j", (data) => {
    expect(readVisualContentHeight(data)).toBeUndefined();
  });

  it("is posted by the injected bootstrap", () => {
    expect(injectVisualBootstrap("<p>x</p>")).toContain(
      '"agent-ui-visual-size"',
    );
  });
});
