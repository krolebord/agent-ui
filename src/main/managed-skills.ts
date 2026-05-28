import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import log from "./logger";

interface ManagedSkill {
  name: string;
  contents: string;
}

interface ManagedSkillContext {
  handoffsDir: string;
}

function buildSkills(ctx: ManagedSkillContext): ManagedSkill[] {
  return [
    {
      name: "agent-ui-handoff",
      contents: `---
name: agent-ui-handoff
description: Summarize the current session into a handoff document that Agent UI can use to start a fresh session continuing this work. Use whenever the user asks to hand off, save state, pause for a new session, or finish a session.
---

When the user asks to hand off the session, write a handoff document to this directory:

  ${ctx.handoffsDir}

Use a filename of the form \`YYYY-MM-DDTHH-mm-ss-<short-slug>.md\`, where the timestamp is the current UTC time and the slug describes the work in a few words. The timestamp prefix keeps handoffs sortable.

The body is up to you. Think about what a fresh agent — one with zero memory of this conversation — would need in order to pick up where you left off. Choose whichever sections, ordering, and level of detail serve that purpose; there is no required template.
`,
    },
  ];
}

export interface ManagedSkillsResult {
  managedSkillsRoot: string;
  handoffsDir: string;
  warnings: string[];
}

async function ensureSymlink(target: string, linkPath: string): Promise<void> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = await readlink(linkPath);
      if (existing === target) return;
      await unlink(linkPath);
    } else if (stat.isDirectory()) {
      await rm(linkPath, { recursive: true, force: true });
    } else {
      await unlink(linkPath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, "dir");
}

async function writeSkillSource(
  managedSkillsRoot: string,
  skill: ManagedSkill,
): Promise<string> {
  const dir = path.join(managedSkillsRoot, skill.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), skill.contents, "utf8");
  return dir;
}

async function pruneStaleLinks(
  destDir: string,
  validNames: Set<string>,
  managedSkillsRoot: string,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(destDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    if (validNames.has(entry.name)) continue;
    const linkPath = path.join(destDir, entry.name);
    try {
      const target = await readlink(linkPath);
      if (!target.startsWith(`${managedSkillsRoot}${path.sep}`)) continue;
      await unlink(linkPath);
      log.info("Removed stale managed-skill link", { linkPath, target });
    } catch (err) {
      log.warn("Failed to inspect or remove stale skill link", {
        linkPath,
        err,
      });
    }
  }
}

async function pruneStaleSources(
  managedSkillsRoot: string,
  validNames: Set<string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(managedSkillsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (validNames.has(entry.name)) continue;
    const stalePath = path.join(managedSkillsRoot, entry.name);
    await rm(stalePath, { recursive: true, force: true });
    log.info("Removed stale managed-skill source", { stalePath });
  }
}

async function linkSkillInto(
  source: string,
  destDir: string,
  linkName: string,
  scope: string,
  warnings: string[],
): Promise<void> {
  try {
    await mkdir(destDir, { recursive: true });
    await ensureSymlink(source, path.join(destDir, linkName));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to link managed skill into ${scope}`, {
      skill: linkName,
      destDir,
      error: message,
    });
    warnings.push(`Failed to link "${linkName}" into ${scope}: ${message}`);
  }
}

export async function ensureManagedSkills(
  userDataPath: string,
  claudePluginRoot: string | null,
): Promise<ManagedSkillsResult> {
  const managedSkillsRoot = path.join(userDataPath, "managed-skills");
  const handoffsDir = path.join(userDataPath, "handoffs");
  await Promise.all([
    mkdir(managedSkillsRoot, { recursive: true }),
    mkdir(handoffsDir, { recursive: true }),
  ]);

  const skills = buildSkills({ handoffsDir });

  const warnings: string[] = [];
  const codexSkillsDir = path.join(homedir(), ".codex", "skills");
  const cursorSkillsDir = path.join(homedir(), ".cursor", "skills");
  const claudeSkillsDir = claudePluginRoot
    ? path.join(claudePluginRoot, "skills")
    : null;

  for (const skill of skills) {
    const source = await writeSkillSource(managedSkillsRoot, skill);

    if (claudeSkillsDir) {
      await linkSkillInto(
        source,
        claudeSkillsDir,
        skill.name,
        "Claude plugin",
        warnings,
      );
    }
    await linkSkillInto(
      source,
      codexSkillsDir,
      skill.name,
      "Codex global skills",
      warnings,
    );
    await linkSkillInto(
      source,
      cursorSkillsDir,
      skill.name,
      "Cursor global skills",
      warnings,
    );
  }

  const validNames = new Set(skills.map((s) => s.name));
  await pruneStaleSources(managedSkillsRoot, validNames);
  if (claudeSkillsDir) {
    await pruneStaleLinks(claudeSkillsDir, validNames, managedSkillsRoot);
  }
  await pruneStaleLinks(codexSkillsDir, validNames, managedSkillsRoot);
  await pruneStaleLinks(cursorSkillsDir, validNames, managedSkillsRoot);

  log.info("Managed skills installed", {
    managedSkillsRoot,
    handoffsDir,
    skills: skills.map((s) => s.name),
    warnings,
  });

  return { managedSkillsRoot, handoffsDir, warnings };
}
