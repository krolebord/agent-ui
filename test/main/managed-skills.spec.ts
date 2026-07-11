import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureManagedSkills } from "../../src/main/managed-skills";

describe("ensureManagedSkills", () => {
  let tempDir: string;
  let userDataPath: string;
  let homeDir: string;
  let pluginRoot: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `managed-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userDataPath = path.join(tempDir, "user-data");
    homeDir = path.join(tempDir, "home");
    pluginRoot = path.join(userDataPath, "claude-state-plugin");
    await Promise.all([
      mkdir(userDataPath, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      mkdir(pluginRoot, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const agentsSkillsDir = () => path.join(homeDir, ".agents", "skills");

  it("writes builtin sources and links them into ~/.agents/skills", async () => {
    const result = await ensureManagedSkills(userDataPath, pluginRoot, homeDir);

    const source = path.join(result.managedSkillsRoot, "agent-ui-handoff");
    const contents = await readFile(path.join(source, "SKILL.md"), "utf8");
    expect(contents).toContain("managed-by: agent-ui-builtin");
    expect(contents).toContain(result.handoffsDir);

    // Codex ignores disable-model-invocation, so the policy file must ship
    // alongside SKILL.md to keep the skill user-invoke-only there.
    expect(
      await readFile(path.join(source, "agents", "openai.yaml"), "utf8"),
    ).toContain("allow_implicit_invocation: false");

    const linkPath = path.join(agentsSkillsDir(), "agent-ui-handoff");
    expect(await readlink(linkPath)).toBe(source);
    expect(result.warnings).toEqual([]);

    const skillsSource = path.join(result.managedSkillsRoot, "agent-ui-skills");
    const skillsContents = await readFile(
      path.join(skillsSource, "SKILL.md"),
      "utf8",
    );
    expect(skillsContents).toContain("managed-by: agent-ui-builtin");
    expect(skillsContents).toContain(".agents/skills");
    expect(skillsContents).toContain("list_skills");
    expect(skillsContents).toContain("allow_implicit_invocation: false");
    expect(
      await readlink(path.join(agentsSkillsDir(), "agent-ui-skills")),
    ).toBe(skillsSource);
  });

  it("removes legacy links from codex, cursor and plugin skill dirs", async () => {
    const managedSkillsRoot = path.join(userDataPath, "managed-skills");
    const source = path.join(managedSkillsRoot, "agent-ui-handoff");
    await mkdir(source, { recursive: true });

    const legacyDirs = [
      path.join(homeDir, ".codex", "skills"),
      path.join(homeDir, ".cursor", "skills"),
      path.join(pluginRoot, "skills"),
    ];
    for (const dir of legacyDirs) {
      await mkdir(dir, { recursive: true });
      await symlink(source, path.join(dir, "agent-ui-handoff"), "dir");
      // A user's own link should survive.
      await symlink(tempDir, path.join(dir, "user-link"), "dir");
    }

    await ensureManagedSkills(userDataPath, pluginRoot, homeDir);

    for (const dir of legacyDirs) {
      expect(existsSync(path.join(dir, "agent-ui-handoff"))).toBe(false);
      expect((await lstat(path.join(dir, "user-link"))).isSymbolicLink()).toBe(
        true,
      );
    }
  });

  it("does not overwrite a real directory in ~/.agents/skills", async () => {
    const realDir = path.join(agentsSkillsDir(), "agent-ui-handoff");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "SKILL.md"), "user content", "utf8");

    const result = await ensureManagedSkills(userDataPath, pluginRoot, homeDir);

    expect(await readFile(path.join(realDir, "SKILL.md"), "utf8")).toBe(
      "user content",
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
