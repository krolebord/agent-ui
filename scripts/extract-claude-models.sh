#!/usr/bin/env bash
set -euo pipefail

# Extract the model catalog embedded in the installed Claude Code binary.
#
# Claude Code has no `models list` command, so there is nothing to shell out to
# the way scripts/extract-codex-models.sh does. The catalog does ship inside the
# binary as a JS object literal, which is what this script pulls out.
#
# Usage:
#   bash scripts/extract-claude-models.sh [path-to-claude-binary]
#   CLAUDE_BIN=/path/to/claude bash scripts/extract-claude-models.sh
node - "$@" <<'NODE'
const { closeSync, openSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { execFileSync, execSync } = require("node:child_process");
const path = require("node:path");

const START_MARKER = 'models:[{id:"claude';
const ALIASES_MARKER = ",aliases:{";
/**
 * The CLI validates `--model` aliases against a flat array that also carries the
 * `[1m]` variants and `opusplan`, none of which appear in the catalog itself.
 * `opusplan` is the last entry, so the array is found by scanning back from it.
 */
const ALIAS_LIST_MARKER = '"opusplan"]';
const CHUNK_SIZE = 8 * 1024 * 1024;
/** The models array is ~12KB today; read well past it so the scan can balance. */
const WINDOW_SIZE = 1024 * 1024;

function resolveIfFile(candidate) {
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function nativeInstallCandidates() {
  const versionsDir = path.join(homedir(), ".local", "share", "claude", "versions");
  let entries;
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return [];
  }
  return entries
    .map((entry) => path.join(versionsDir, entry))
    .filter((candidate) => resolveIfFile(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function candidatePaths(explicit) {
  if (explicit) {
    const resolved = resolveIfFile(explicit);
    if (!resolved) {
      throw new Error(`Not a readable file: ${explicit}`);
    }
    return [resolved];
  }

  const candidates = [];
  try {
    const onPath = execSync("command -v claude", {
      encoding: "utf8",
      shell: "/bin/bash",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const resolved = onPath && resolveIfFile(onPath);
    if (resolved) {
      candidates.push(resolved);
    }
  } catch {
    // `claude` is not on PATH; fall back to the native install directory.
  }
  candidates.push(...nativeInstallCandidates());
  return [...new Set(candidates)];
}

/** Streams the file so a 300MB+ binary never lands in memory all at once. */
function findMarkerOffset(filePath, marker) {
  const needle = Buffer.from(marker, "latin1");
  const overlap = needle.length - 1;
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE + overlap);
  const fd = openSync(filePath, "r");
  try {
    let filePosition = 0;
    let carried = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, carried, CHUNK_SIZE, filePosition);
      if (bytesRead === 0) {
        return -1;
      }
      const searchable = buffer.subarray(0, carried + bytesRead);
      const index = searchable.indexOf(needle);
      if (index !== -1) {
        return filePosition - carried + index;
      }
      filePosition += bytesRead;
      carried = Math.min(overlap, searchable.length);
      searchable.subarray(searchable.length - carried).copy(buffer, 0);
    }
  } finally {
    closeSync(fd);
  }
}

function readWindow(filePath, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

function readBalanced(text, startIndex) {
  const open = text[startIndex];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let quote = "";
  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  throw new Error(
    `Could not find the end of the ${open}...${close} literal within ${text.length} bytes.`,
  );
}

/** The catalog is a JS object literal (bare keys, `!0`, `1e6`), not JSON. */
function evaluateLiteral(source) {
  return new Function(`return (${source});`)();
}

function extractCatalog(filePath) {
  const offset = findMarkerOffset(filePath, START_MARKER);
  if (offset === -1) {
    return null;
  }

  const window = readWindow(filePath, offset, WINDOW_SIZE);
  const models = evaluateLiteral(
    readBalanced(window, window.indexOf("[")),
  );

  const aliasesIndex = window.indexOf(ALIASES_MARKER);
  const aliases =
    aliasesIndex === -1
      ? {}
      : evaluateLiteral(
          readBalanced(window, aliasesIndex + ALIASES_MARKER.length - 1),
        );

  return { models, aliases, aliasList: extractAliasList(filePath) };
}

function extractAliasList(filePath) {
  const offset = findMarkerOffset(filePath, ALIAS_LIST_MARKER);
  if (offset === -1) {
    console.warn(
      `Could not find the CLI alias list (marker '${ALIAS_LIST_MARKER}'); falling back to the catalog aliases.`,
    );
    return null;
  }

  // Every element is a quoted string, so `["` opens the array. Matching on the
  // quote too skips the `[` inside alias names like `sonnet[1m]`.
  const lead = readWindow(filePath, Math.max(0, offset - 512), 512 + ALIAS_LIST_MARKER.length);
  const openIndex = lead.lastIndexOf('["');
  if (openIndex === -1) {
    return null;
  }

  return evaluateLiteral(readBalanced(lead, openIndex));
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const FAMILY_ORDER = ["opus", "sonnet", "haiku", "fable"];

function supportedEfforts(capabilities) {
  if (!capabilities.includes("effort")) {
    return [];
  }
  const efforts = ["low", "medium", "high"];
  if (capabilities.includes("xhigh_effort")) {
    efforts.push("xhigh");
  }
  if (capabilities.includes("max_effort")) {
    efforts.push("max");
  }
  return efforts;
}

function compareModels(a, b) {
  const familyDelta =
    (FAMILY_ORDER.indexOf(a.family) + 1 || FAMILY_ORDER.length + 1) -
    (FAMILY_ORDER.indexOf(b.family) + 1 || FAMILY_ORDER.length + 1);
  if (familyDelta !== 0) {
    return familyDelta;
  }
  // Within a family the catalog runs oldest to newest; show newest first.
  return b.catalogIndex - a.catalogIndex;
}

const explicit = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? process.env.CLAUDE_BIN;
const candidates = candidatePaths(explicit);
if (candidates.length === 0) {
  throw new Error(
    "Could not find a Claude Code binary. Pass one explicitly: bash scripts/extract-claude-models.sh /path/to/claude",
  );
}

let catalog = null;
let source = null;
for (const candidate of candidates) {
  catalog = extractCatalog(candidate);
  if (catalog) {
    source = candidate;
    break;
  }
  console.warn(`No embedded model catalog in ${candidate}; trying the next candidate.`);
}

if (!catalog) {
  throw new Error(
    `No embedded model catalog found in: ${candidates.join(", ")}. The marker '${START_MARKER}' may have changed in a newer Claude Code build.`,
  );
}

let version = "unknown";
try {
  version = execFileSync(source, ["--version"], { encoding: "utf8" }).trim();
} catch {
  version = path.basename(source);
}

// Claude Code exposes an alias per user-selectable family (opus, sonnet, haiku,
// fable). Families with no alias, currently just Mythos, are internal.
const aliasedFamilies = new Set(Object.keys(catalog.aliases));

const models = catalog.models
  .map((model, catalogIndex) => ({ ...model, catalogIndex }))
  // A missing knowledge cutoff marks the legacy 3.x entries, which the CLI
  // keeps for id resolution but does not offer in the model picker.
  .filter(
    (model) =>
      model?.id &&
      model.provider_ids?.first_party &&
      model.knowledge_cutoff &&
      aliasedFamilies.has(model.family),
  )
  .sort(compareModels)
  .map((model) => ({
    label: model.display_name || model.id,
    value: model.id,
    knowledgeCutoff: model.knowledge_cutoff,
    supportedEfforts: supportedEfforts(model.capabilities ?? []),
  }));

if (models.length === 0) {
  throw new Error("The extracted catalog contained no selectable models.");
}

const ALIAS_LABEL_OVERRIDES = {
  best: "Best available",
  opusplan: "Opus for planning, Sonnet for execution",
};

function aliasLabel(alias) {
  const override = ALIAS_LABEL_OVERRIDES[alias];
  if (override) {
    return override;
  }
  const family = alias.replace(/\[1m\]$/, "");
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return alias === family ? `${name} (latest)` : `${name} (latest, 1M context)`;
}

function aliasRank(alias) {
  const family = alias.replace(/\[1m\]$/, "");
  const familyRank = FAMILY_ORDER.indexOf(family);
  if (familyRank === -1) {
    return [2, 0, alias];
  }
  return [alias === family ? 0 : 1, familyRank, alias];
}

const aliasNames = catalog.aliasList ?? Object.keys(catalog.aliases);
const aliases = aliasNames
  .filter((alias) => typeof alias === "string" && alias.length > 0)
  .sort((a, b) => {
    const [groupA, familyA, nameA] = aliasRank(a);
    const [groupB, familyB, nameB] = aliasRank(b);
    return groupA - groupB || familyA - familyB || nameA.localeCompare(nameB);
  })
  .map((alias) => ({ label: aliasLabel(alias), value: alias }));

const efforts = EFFORT_ORDER.filter((effort) =>
  models.some((model) => model.supportedEfforts.includes(effort)),
);

const target = "src/shared/claude-models.ts";
const body = [
  "// Auto-generated by scripts/extract-claude-models.sh",
  "// Run: bash scripts/extract-claude-models.sh",
  `// Source: model catalog embedded in ${version}`,
  "",
  `export type ClaudeCatalogEffort = ${efforts.map((effort) => `"${effort}"`).join(" | ")};`,
  "",
  "export interface ClaudeCatalogModel {",
  "  label: string;",
  "  value: string;",
  "  knowledgeCutoff: string;",
  "  /** Empty for models that predate `--effort`. */",
  "  supportedEfforts: ClaudeCatalogEffort[];",
  "}",
  "",
  "export interface ClaudeModelAlias {",
  "  label: string;",
  "  value: string;",
  "}",
  "",
  "/** Newest first within each family. */",
  `export const claudeCatalogModels: ClaudeCatalogModel[] = ${JSON.stringify(models, null, 2)};`,
  "",
  `export const claudeModelAliases: ClaudeModelAlias[] = ${JSON.stringify(aliases, null, 2)};`,
  "",
].join("\n");

writeFileSync(target, body);
console.log(
  `Generated ${target} with ${models.length} models and ${aliases.length} aliases from ${source} (${version})`,
);
NODE
