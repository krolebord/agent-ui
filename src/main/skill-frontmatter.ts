/**
 * Minimal YAML-ish frontmatter handling for SKILL.md files.
 *
 * Skill frontmatter is a flat map of scalar keys (name, description,
 * disable-model-invocation, managed-by, ...). We avoid a full YAML parser and
 * instead parse `key: value` blocks, preserving unknown keys verbatim so that
 * updating a skill authored elsewhere never destroys metadata we don't know
 * about.
 */

interface FrontmatterBlock {
  key: string | null;
  lines: string[];
}

export interface ParsedSkillMd {
  hasFrontmatter: boolean;
  blocks: FrontmatterBlock[];
  body: string;
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(.*)$/;

export function parseSkillMd(contents: string): ParsedSkillMd {
  const normalized = contents.replace(/^﻿/, "");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { hasFrontmatter: false, blocks: [], body: normalized };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { hasFrontmatter: false, blocks: [], body: normalized };
  }

  const blocks: FrontmatterBlock[] = [];
  for (const line of lines.slice(1, end)) {
    const match = line.match(KEY_LINE);
    if (match?.[1]) {
      blocks.push({ key: match[1], lines: [line] });
    } else {
      const last = blocks[blocks.length - 1];
      if (last) {
        last.lines.push(line);
      } else {
        blocks.push({ key: null, lines: [line] });
      }
    }
  }

  return {
    hasFrontmatter: true,
    blocks,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\n/, ""),
  };
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"')
      ? inner.replace(/\\(["\\])/g, "$1")
      : inner.replace(/''/g, "'");
  }
  return trimmed;
}

export function getScalar(parsed: ParsedSkillMd, key: string): string | null {
  const block = parsed.blocks.find((b) => b.key === key);
  if (!block) return null;
  const firstLine = block.lines[0] ?? "";
  const match = firstLine.match(KEY_LINE);
  const inline = match?.[2] ?? "";

  // Folded/literal block scalars (`key: >-` / `key: |`): join continuation lines.
  if (/^\s*[|>][+-]?\s*$/.test(inline)) {
    return block.lines
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  }
  return unquote(inline);
}

export function getBoolean(parsed: ParsedSkillMd, key: string): boolean {
  return getScalar(parsed, key) === "true";
}

function formatScalar(value: string): string {
  if (value === "") return '""';
  const needsQuoting =
    /[:#{}[\],&*!|>'"%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(?:true|false|null|~|-)/i.test(value) ||
    value.includes("\n");
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

export type FrontmatterUpdates = Record<string, string | boolean | null>;

/**
 * Serialize a SKILL.md, applying `updates` to the frontmatter. Keys set to
 * null are removed; keys not present in the parsed input are appended.
 * Unknown existing keys are kept verbatim.
 */
export function serializeSkillMd(
  parsed: ParsedSkillMd,
  updates: FrontmatterUpdates,
  body: string,
): string {
  const pending = new Map(Object.entries(updates));
  const lines: string[] = ["---"];

  for (const block of parsed.blocks) {
    if (block.key !== null && pending.has(block.key)) {
      const value = pending.get(block.key);
      pending.delete(block.key);
      if (value === null || value === undefined) continue;
      lines.push(formatEntry(block.key, value));
    } else {
      lines.push(...block.lines);
    }
  }

  for (const [key, value] of pending) {
    if (value === null || value === undefined) continue;
    lines.push(formatEntry(key, value));
  }

  lines.push("---", "");
  const trimmedBody = body.replace(/^\n+/, "");
  return `${lines.join("\n")}\n${trimmedBody}${trimmedBody.endsWith("\n") || trimmedBody === "" ? "" : "\n"}`;
}

function formatEntry(key: string, value: string | boolean): string {
  if (typeof value === "boolean") {
    return `${key}: ${value ? "true" : "false"}`;
  }
  return `${key}: ${formatScalar(value)}`;
}
