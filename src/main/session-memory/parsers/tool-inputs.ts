import {
  asRecord,
  asString,
  parseJsonRecord,
} from "../../agent-transcripts/json";

const PATCH_HEADER =
  /\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*(?=\\n|\\r|\n|\r|"|`|$)/g;

/** File paths named by `*** Add/Update/Delete File:` headers, raw or inside a JS string literal. */
export function patchFilePaths(text: string): string[] {
  if (!text.includes("*** ")) {
    return [];
  }
  return Array.from(text.matchAll(PATCH_HEADER), (match) => match[1] ?? "");
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/** Decodes the JS string literal opening at `start`; `end` is the index after its closing quote. */
export function readJsStringLiteral(
  source: string,
  start: number,
): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) {
      return { value, end: index + 1 };
    }
    if (char === "\n" && quote !== "`") {
      return null;
    }
    if (char !== "\\") {
      value += char;
      continue;
    }
    index += 1;
    const escaped = source[index];
    if (escaped === undefined) {
      return null;
    }
    if (escaped === "u" || escaped === "x") {
      const braced = escaped === "u" && source[index + 1] === "{";
      const end = braced
        ? source.indexOf("}", index)
        : index + (escaped === "u" ? 4 : 2);
      const hex = braced
        ? source.slice(index + 2, end)
        : source.slice(index + 1, end + 1);
      const code = Number.parseInt(hex, 16);
      if (end < 0 || Number.isNaN(code) || code > 0x10ffff) {
        return null;
      }
      value += String.fromCodePoint(code);
      index = end;
      continue;
    }
    if (escaped === "\n") {
      continue;
    }
    value += SIMPLE_ESCAPES[escaped] ?? escaped;
  }
  return null;
}

const CMD_KEY = /(?:^|[{,\s])"?cmd"?\s*:\s*(?=["'`])/g;

/** Shell commands passed as `cmd` string literals in Codex `exec` tool JavaScript. */
export function codexExecCommands(source: string): string[] {
  if (!source.includes("cmd")) {
    return [];
  }
  const commands: string[] = [];
  const pattern = new RegExp(CMD_KEY);
  for (
    let match = pattern.exec(source);
    match !== null;
    match = pattern.exec(source)
  ) {
    const literal = readJsStringLiteral(source, match.index + match[0].length);
    if (literal !== null) {
      commands.push(literal.value);
      pattern.lastIndex = literal.end;
    }
  }
  return commands;
}

const SHELL_BINARIES = new Set([
  "bash",
  "sh",
  "zsh",
  "/bin/bash",
  "/bin/sh",
  "/bin/zsh",
]);

export function commandFromArgv(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    !Array.isArray(value) ||
    !value.every((part) => typeof part === "string")
  ) {
    return null;
  }
  const argv = value as string[];
  if (
    argv.length === 3 &&
    SHELL_BINARIES.has(argv[0] ?? "") &&
    (argv[1] === "-lc" || argv[1] === "-c")
  ) {
    return argv[2] ?? null;
  }
  return argv.join(" ");
}

/** Tool inputs arrive as objects or as JSON-encoded strings. */
export function toolInputRecord(
  value: unknown,
): Record<string, unknown> | null {
  const text = asString(value);
  return text === null ? asRecord(value) : parseJsonRecord(text);
}
