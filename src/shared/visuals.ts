// Adapted from t3code (https://github.com/pingdotgg/t3code), MIT, Copyright (c) 2026 T3 Tools Inc.

export const HTML_PREVIEW_TOOL_NAME = "html_preview";
export const HTML_RENDER_TOOL_NAME = "html_render";
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
export const HTML_MAX_INPUT_LENGTH = 512_000;
export const HTML_PREVIEW_DEFAULT_WIDTH = 728;
export const HTML_PREVIEW_MIN_WIDTH = 240;
export const HTML_PREVIEW_MAX_WIDTH = 1600;

// Mirrors `:root` in src/renderer/src/index.css; a test keeps them in sync.
export const VISUAL_THEME_VARIABLES: Readonly<Record<string, string>> = {
  "--radius": "0.375rem",
  "--background": "oklch(0.15 0.01 260)",
  "--foreground": "oklch(0.96 0.01 260)",
  "--card": "oklch(0.2 0.01 260)",
  "--card-foreground": "oklch(0.96 0.01 260)",
  "--popover": "oklch(0.2 0.01 260)",
  "--popover-foreground": "oklch(0.96 0.01 260)",
  "--primary": "oklch(0.74 0.1 55)",
  "--primary-foreground": "oklch(0.14 0.02 55)",
  "--secondary": "oklch(0.24 0.01 260)",
  "--secondary-foreground": "oklch(0.94 0.01 260)",
  "--muted": "oklch(0.24 0.005 260)",
  "--muted-foreground": "oklch(0.72 0.01 260)",
  "--accent": "oklch(0.28 0.01 260)",
  "--accent-foreground": "oklch(0.96 0.01 260)",
  "--destructive": "oklch(0.64 0.18 25)",
  "--destructive-foreground": "oklch(0.97 0.01 260)",
  "--border": "oklch(0.34 0.01 260)",
  "--input": "oklch(0.31 0.01 260)",
  "--ring": "oklch(0.7 0.1 55)",
  "--success": "#10b981",
  "--success-foreground": "#34d399",
  "--warning": "#f59e0b",
  "--warning-foreground": "#fbbf24",
  "--info": "#3b82f6",
  "--info-foreground": "#60a5fa",
  "--chart-1": "oklch(0.74 0.1 55)",
  "--chart-2": "#2dd4bf",
  "--chart-3": "#60a5fa",
  "--chart-4": "#c084fc",
  "--chart-5": "#fb7185",
  "--chart-6": "#a3e635",
  "--font-sans":
    '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  "--font-mono":
    '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

export const VISUAL_THEME_GUIDE = [
  "Agent UI injects its dark theme as CSS custom properties on :root (there is no light theme):",
  "--background (the app background around the page), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (brand accent, solid buttons), --accent, --accent-foreground (neutral hover surface),",
  "--destructive, --destructive-foreground, --success, --success-foreground, --warning, --warning-foreground, --info, --info-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background, color, and font from these and body margin to 0; your own CSS overrides it.",
].join(" ");

export const VISUAL_LAYOUT_GUIDE = [
  "The page is shown in the Agent UI Artifacts page preview, in a sandboxed frame on the app's background.",
  "Leave html, body, and the outermost element without a background color; this overrides general style preferences such as a fixed black page background. Use a fluid width, and skip an outer card, border, or banner title.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights, and avoid viewport-based heights such as 100vh or height:100% on html or body.",
  "The frame has an opaque origin, so localStorage, sessionStorage, and cookies throw; keep state in memory.",
  "Links open in the user's browser.",
].join(" ");

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}" +
  "body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ":where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}";

const THEME_CSS = `:root{color-scheme:dark;${Object.entries(
  VISUAL_THEME_VARIABLES,
)
  .map(([name, value]) => `${name}:${value};`)
  .join("")}}${BASE_CSS}`;

const LINK_SCRIPT = `(function(){document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;l.setAttribute("target","_blank");l.setAttribute("rel","noopener");},true);})();`;

const VISUAL_SIZE_MESSAGE_TYPE = "agent-ui-visual-size";

const SIZE_SCRIPT = `(function(){if(window.parent===window)return;var h,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({type:${JSON.stringify(VISUAL_SIZE_MESSAGE_TYPE)},height:v},"*");},o=window.ResizeObserver?new ResizeObserver(z):null;if(o)o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);})();`;

/** The content height a framed visual reports through postMessage. */
export function readVisualContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, height } = data as Record<string, unknown>;
  return type === VISUAL_SIZE_MESSAGE_TYPE &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
    ? height
    : undefined;
}

function bootstrapMarkup(markup: string): string {
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096))
      ? ""
      : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="agent-ui-theme">${THEME_CSS}</style>`,
    `<script>${LINK_SCRIPT}${SIZE_SCRIPT}</script>`,
  ].join("");
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
function blankNonMarkup(html: string): string {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
}

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it and can override it.
 */
export function injectVisualBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
