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
import { OPENAI_POLICY_CONTENTS, OPENAI_POLICY_FILE } from "./skills-service";

interface ManagedSkill {
  name: string;
  /** Relative path within the skill dir -> file contents. */
  files: Record<string, string>;
}

interface ManagedSkillContext {
  handoffsDir: string;
}

function buildSkills(ctx: ManagedSkillContext): ManagedSkill[] {
  return [
    {
      name: "agent-ui-handoff",
      files: {
        // disable-model-invocation only covers Claude Code; the openai.yaml
        // policy file is what keeps Codex from auto-invoking the skill.
        [OPENAI_POLICY_FILE]: OPENAI_POLICY_CONTENTS,
        "SKILL.md": `---
name: agent-ui-handoff
description: Summarize the current session into a handoff document that Agent UI can use to start a fresh session continuing this work. Use whenever the user asks to hand off, save state, pause for a new session, or finish a session.
disable-model-invocation: true
managed-by: agent-ui-builtin
---

When the user asks to hand off the session, write a handoff document to this directory:

  ${ctx.handoffsDir}

Use a filename of the form \`YYYY-MM-DDTHH-mm-ss-<short-slug>.md\`, where the timestamp is the current UTC time and the slug describes the work in a few words. The timestamp prefix keeps handoffs sortable.

The body is up to you. Think about what a fresh agent — one with zero memory of this conversation — would need in order to pick up where you left off. Choose whichever sections, ordering, and level of detail serve that purpose; there is no required template.
`,
      },
    },
    {
      name: "agent-ui-skills",
      files: {
        "SKILL.md": `---
name: agent-ui-skills
description: How to create, edit, or delete skills (reusable instructions loaded into future agent sessions) on this machine. Use whenever the user asks to save a workflow or knowledge as a skill, create a new skill, or change or remove an existing one.
managed-by: agent-ui-builtin
---

Skills on this machine are managed by Agent UI. A skill is a directory containing a \`SKILL.md\`; you create and edit these files directly with your file tools.

## Where skills live

Always work in the canonical \`.agents/skills\` directories:

- Project skills (specific to one repository): \`<project root>/.agents/skills/<skill-name>/SKILL.md\`
- Global skills (useful everywhere): \`~/.agents/skills/<skill-name>/SKILL.md\`

Never create or edit anything under \`.claude/skills\` — those are symlinks that Agent UI generates from \`.agents/skills\`. Prefer project scope unless the skill is clearly useful across all projects.

## SKILL.md format

\`\`\`markdown
---
name: <skill-name>               # must match the directory name
description: <when to use this skill — what agents read when deciding to load it>
disable-model-invocation: true   # optional: only the user can invoke it; omit to let agents load it automatically
---

Instructions for the agent...
\`\`\`

Supporting files (scripts, reference docs) can live next to \`SKILL.md\` in the same directory; reference them from the body by relative path.

\`disable-model-invocation: true\` is honored by Claude Code only. Codex ignores it — to make a skill user-invoke-only there as well, also create \`agents/openai.yaml\` inside the skill directory:

\`\`\`yaml
policy:
  allow_implicit_invocation: false
\`\`\`

Always create both when the user wants a skill they alone can trigger; omit both for skills agents may load automatically.

## After creating or editing

Call the \`list_skills\` tool on the \`agent-ui\` MCP server. Besides listing skills, it registers your changes: Agent UI rescans the skills directories, links new skills into \`.claude/skills\`, and shows them in its UI. Also call it before creating a skill, to check whether a similar one already exists — its output includes each skill's directory path.

## Rules

- New or edited skills take effect in future sessions, not the current one — don't try to invoke a skill you just wrote.
- To delete a skill, remove its directory; Agent UI cleans up the links on its next rescan.
- Don't edit skills whose frontmatter says \`managed-by: agent-ui-builtin\` — they are owned by Agent UI and your changes would be overwritten.
`,
      },
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
  // Sources live under userData and are fully app-owned; a clean rewrite
  // keeps them exactly matching the definition (no stale extra files).
  await rm(dir, { recursive: true, force: true });
  for (const [relPath, contents] of Object.entries(skill.files)) {
    const filePath = path.join(dir, relPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
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
