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
managed-by: agent-ui-builtin
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

async function ensureSymlink(
  target: string,
  linkPath: string,
  warnings: string[],
): Promise<void> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = await readlink(linkPath);
      if (existing === target) return;
      await unlink(linkPath);
    } else {
      // A real file/directory exists where the link should go. It isn't
      // ours — leave it alone rather than destroy user content.
      const message = `Not overwriting existing path with managed skill link: ${linkPath}`;
      log.warn(message);
      warnings.push(message);
      return;
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

async function pruneManagedLinks(
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

/**
 * Installs code-defined (builtin) skills.
 *
 * Sources are written to <userData>/managed-skills/<name> (their contents
 * embed machine-specific paths) and symlinked into ~/.agents/skills — the
 * canonical skills directory. From there the SkillsService picks them up
 * like any other skill and links them into ~/.claude/skills.
 *
 * Also removes legacy links this app used to create in ~/.codex/skills,
 * ~/.cursor/skills and the managed Claude plugin's skills dir (Codex and
 * Cursor read .agents/skills and .claude/skills directly now).
 */
export async function ensureManagedSkills(
  userDataPath: string,
  claudePluginRoot: string | null,
  homeDirOverride?: string,
): Promise<ManagedSkillsResult> {
  const home = homeDirOverride ?? homedir();
  const managedSkillsRoot = path.join(userDataPath, "managed-skills");
  const handoffsDir = path.join(userDataPath, "handoffs");
  await Promise.all([
    mkdir(managedSkillsRoot, { recursive: true }),
    mkdir(handoffsDir, { recursive: true }),
  ]);

  const skills = buildSkills({ handoffsDir });

  const warnings: string[] = [];
  const agentsSkillsDir = path.join(home, ".agents", "skills");

  for (const skill of skills) {
    const source = await writeSkillSource(managedSkillsRoot, skill);
    try {
      await ensureSymlink(
        source,
        path.join(agentsSkillsDir, skill.name),
        warnings,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to link managed skill into .agents/skills", {
        skill: skill.name,
        error: message,
      });
      warnings.push(`Failed to link "${skill.name}": ${message}`);
    }
  }

  const validNames = new Set(skills.map((s) => s.name));
  await pruneStaleSources(managedSkillsRoot, validNames);
  await pruneManagedLinks(agentsSkillsDir, validNames, managedSkillsRoot);

  // Legacy destinations — remove every link that points at our sources.
  const legacyDirs = [
    path.join(home, ".codex", "skills"),
    path.join(home, ".cursor", "skills"),
    ...(claudePluginRoot ? [path.join(claudePluginRoot, "skills")] : []),
  ];
  for (const legacyDir of legacyDirs) {
    try {
      await pruneManagedLinks(legacyDir, new Set(), managedSkillsRoot);
    } catch (err) {
      log.warn("Failed to clean up legacy managed-skill links", {
        legacyDir,
        err,
      });
    }
  }

  log.info("Managed skills installed", {
    managedSkillsRoot,
    handoffsDir,
    skills: skills.map((s) => s.name),
    warnings,
  });

  return { managedSkillsRoot, handoffsDir, warnings };
}
