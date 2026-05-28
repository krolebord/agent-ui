import {
  lstat,
  mkdir,
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

const SKILLS: ManagedSkill[] = [
  {
    name: "agent-ui-test",
    contents: `---
name: agent-ui-test
description: Test skill installed by Agent UI to verify that skill loading works. Use this skill whenever the user asks to verify the Agent UI test skill, or asks you to confirm that you can read an Agent UI skill.
---

When you use this skill, respond with exactly:

yes, I was able to read the skill
`,
  },
];

export interface ManagedSkillsResult {
  managedSkillsRoot: string;
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
  await mkdir(managedSkillsRoot, { recursive: true });

  const warnings: string[] = [];
  const codexSkillsDir = path.join(homedir(), ".codex", "skills");
  const cursorSkillsDir = path.join(homedir(), ".cursor", "skills");
  const claudeSkillsDir = claudePluginRoot
    ? path.join(claudePluginRoot, "skills")
    : null;

  for (const skill of SKILLS) {
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

  log.info("Managed skills installed", {
    managedSkillsRoot,
    skills: SKILLS.map((s) => s.name),
    warnings,
  });

  return { managedSkillsRoot, warnings };
}
