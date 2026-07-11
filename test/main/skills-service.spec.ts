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
import { defineProjectState } from "../../src/main/project-service";
import {
  defineSkillsState,
  SkillsService,
} from "../../src/main/skills-service";

async function writeSkill(
  skillsDir: string,
  name: string,
  frontmatter: string,
  body = "Do the thing.\n",
): Promise<string> {
  const dir = path.join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body}`,
    "utf8",
  );
  return dir;
}

describe("SkillsService", () => {
  let tempDir: string;
  let homeDir: string;
  let projectDir: string;
  let builtinRoot: string;
  let state: ReturnType<typeof defineSkillsState>;
  let projectsState: ReturnType<typeof defineProjectState>;
  let service: SkillsService;

  const globalAgentsSkills = () => path.join(homeDir, ".agents", "skills");
  const globalClaudeSkills = () => path.join(homeDir, ".claude", "skills");
  const projectAgentsSkills = () => path.join(projectDir, ".agents", "skills");
  const projectClaudeSkills = () => path.join(projectDir, ".claude", "skills");

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `skills-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    homeDir = path.join(tempDir, "home");
    projectDir = path.join(tempDir, "project");
    builtinRoot = path.join(tempDir, "user-data", "managed-skills");
    await Promise.all([
      mkdir(globalAgentsSkills(), { recursive: true }),
      mkdir(projectDir, { recursive: true }),
      mkdir(builtinRoot, { recursive: true }),
    ]);

    state = defineSkillsState();
    projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: projectDir, collapsed: false });
    });
    service = new SkillsService({
      state,
      projectsState,
      builtinSkillsRoot: builtinRoot,
      homeDir,
    });
  });

  afterEach(async () => {
    service.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("discovers global and project skills with metadata", async () => {
    await writeSkill(
      globalAgentsSkills(),
      "review",
      `name: review\ndescription: Reviews code\nmanaged-by: agent-ui\ndisable-model-invocation: true`,
    );
    await writeSkill(
      projectAgentsSkills(),
      "deploy",
      `name: deploy\ndescription: Deploys the app`,
    );

    await service.rescanAll();

    const entries = Object.values(state.state);
    expect(entries).toHaveLength(2);

    const review = entries.find((e) => e.name === "review");
    expect(review).toMatchObject({
      scope: { type: "global" },
      description: "Reviews code",
      userInvokeOnly: true,
      managedBy: "app",
      body: "Do the thing.\n",
    });

    const deploy = entries.find((e) => e.name === "deploy");
    expect(deploy).toMatchObject({
      scope: { type: "project", projectPath: projectDir },
      description: "Deploys the app",
      userInvokeOnly: false,
      managedBy: null,
    });
  });

  it("links skills into .claude/skills (absolute for global, relative for projects)", async () => {
    const globalSkillDir = await writeSkill(
      globalAgentsSkills(),
      "review",
      `name: review\ndescription: d`,
    );
    await writeSkill(
      projectAgentsSkills(),
      "deploy",
      `name: deploy\ndescription: d`,
    );

    await service.rescanAll();

    const globalLink = path.join(globalClaudeSkills(), "review");
    expect(await readlink(globalLink)).toBe(globalSkillDir);

    const projectLink = path.join(projectClaudeSkills(), "deploy");
    const target = await readlink(projectLink);
    expect(path.isAbsolute(target)).toBe(false);
    expect(path.resolve(projectClaudeSkills(), target)).toBe(
      path.join(projectAgentsSkills(), "deploy"),
    );
  });

  it("never replaces a real directory in .claude/skills", async () => {
    await writeSkill(globalAgentsSkills(), "review", `name: review`);
    const realDir = path.join(globalClaudeSkills(), "review");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "SKILL.md"), "user content", "utf8");

    await service.rescanAll();

    const stats = await lstat(realDir);
    expect(stats.isDirectory()).toBe(true);
    expect(await readFile(path.join(realDir, "SKILL.md"), "utf8")).toBe(
      "user content",
    );
  });

  it("leaves foreign symlinks in .claude/skills alone", async () => {
    const foreignTarget = path.join(tempDir, "elsewhere", "review");
    await mkdir(foreignTarget, { recursive: true });
    await mkdir(globalClaudeSkills(), { recursive: true });
    const linkPath = path.join(globalClaudeSkills(), "review");
    await symlink(foreignTarget, linkPath, "dir");

    await writeSkill(globalAgentsSkills(), "review", `name: review`);
    await service.rescanAll();

    expect(await readlink(linkPath)).toBe(foreignTarget);
  });

  it("prunes dangling links into .agents/skills but keeps others", async () => {
    await mkdir(globalClaudeSkills(), { recursive: true });
    const dangling = path.join(globalClaudeSkills(), "removed-skill");
    await symlink(
      path.join(globalAgentsSkills(), "removed-skill"),
      dangling,
      "dir",
    );
    const foreignDangling = path.join(globalClaudeSkills(), "foreign");
    await symlink(path.join(tempDir, "gone"), foreignDangling, "dir");

    await service.rescanAll();

    expect(existsSync(dangling)).toBe(false);
    expect((await lstat(foreignDangling)).isSymbolicLink()).toBe(true);
  });

  it("creates skills with frontmatter, marker and openai policy", async () => {
    const entry = await service.createSkill({
      scope: { type: "project", projectPath: projectDir },
      name: "release",
      description: "Cuts a release",
      body: "Steps here.\n",
      userInvokeOnly: true,
    });

    expect(entry.managedBy).toBe("app");
    expect(entry.userInvokeOnly).toBe(true);

    const skillMd = await readFile(
      path.join(projectAgentsSkills(), "release", "SKILL.md"),
      "utf8",
    );
    expect(skillMd).toContain("name: release");
    expect(skillMd).toContain("description: Cuts a release");
    expect(skillMd).toContain("managed-by: agent-ui");
    expect(skillMd).toContain("disable-model-invocation: true");

    const policy = await readFile(
      path.join(projectAgentsSkills(), "release", "agents", "openai.yaml"),
      "utf8",
    );
    expect(policy).toContain("allow_implicit_invocation: false");

    expect(existsSync(path.join(projectClaudeSkills(), "release"))).toBe(true);
  });

  it("rejects creating a skill that already exists", async () => {
    await writeSkill(globalAgentsSkills(), "review", `name: review`);
    await expect(
      service.createSkill({
        scope: { type: "global" },
        name: "review",
        description: "d",
        body: "",
        userInvokeOnly: false,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("updates skills while preserving unknown frontmatter keys", async () => {
    const dir = await writeSkill(
      globalAgentsSkills(),
      "review",
      `name: review\ndescription: Old\nlicense: MIT`,
    );
    await service.rescanAll();

    await service.updateSkill({
      dirPath: dir,
      description: "New",
      body: "Updated body.\n",
      userInvokeOnly: false,
    });

    const skillMd = await readFile(path.join(dir, "SKILL.md"), "utf8");
    expect(skillMd).toContain("description: New");
    expect(skillMd).toContain("license: MIT");
    expect(skillMd).toContain("Updated body.");
    expect(state.state[dir]?.description).toBe("New");
  });

  it("removes the generated openai policy when user-invoke-only is turned off", async () => {
    const entry = await service.createSkill({
      scope: { type: "global" },
      name: "manual",
      description: "d",
      body: "",
      userInvokeOnly: true,
    });
    const policyPath = path.join(entry.dirPath, "agents", "openai.yaml");
    expect(existsSync(policyPath)).toBe(true);

    await service.updateSkill({
      dirPath: entry.dirPath,
      description: "d",
      body: "",
      userInvokeOnly: false,
    });
    expect(existsSync(policyPath)).toBe(false);
  });

  it("deletes skills and prunes their links", async () => {
    const entry = await service.createSkill({
      scope: { type: "global" },
      name: "temp",
      description: "d",
      body: "",
      userInvokeOnly: false,
    });
    const linkPath = path.join(globalClaudeSkills(), "temp");
    expect(existsSync(linkPath)).toBe(true);

    await service.deleteSkill({ dirPath: entry.dirPath });

    expect(existsSync(entry.dirPath)).toBe(false);
    expect(existsSync(linkPath)).toBe(false);
    expect(state.state[entry.dirPath]).toBeUndefined();
  });

  it("marks symlinks into the builtin root as builtin and protects them", async () => {
    const source = path.join(builtinRoot, "agent-ui-handoff");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: agent-ui-handoff\ndescription: Handoff\n---\n\nBody\n",
      "utf8",
    );
    const linkPath = path.join(globalAgentsSkills(), "agent-ui-handoff");
    await symlink(source, linkPath, "dir");

    await service.rescanAll();

    const entry = state.state[linkPath];
    expect(entry?.managedBy).toBe("builtin");

    await expect(service.deleteSkill({ dirPath: linkPath })).rejects.toThrow(
      /Built-in/,
    );
    await expect(
      service.updateSkill({
        dirPath: linkPath,
        description: "x",
        body: "",
        userInvokeOnly: false,
      }),
    ).rejects.toThrow(/Built-in/);
  });

  it("drops entries when a project is removed", async () => {
    await writeSkill(projectAgentsSkills(), "deploy", `name: deploy`);
    await service.rescanAll();
    expect(Object.values(state.state).some((e) => e.name === "deploy")).toBe(
      true,
    );

    projectsState.updateState((projects) => {
      projects.length = 0;
    });
    await service.rescanAll();

    expect(Object.values(state.state).some((e) => e.name === "deploy")).toBe(
      false,
    );
  });

  it("ensureFreshForPath syncs the global root and the project containing cwd", async () => {
    await writeSkill(globalAgentsSkills(), "review", `name: review`);
    await writeSkill(projectAgentsSkills(), "deploy", `name: deploy`);

    await service.ensureFreshForPath(path.join(projectDir, "src", "nested"));

    expect(existsSync(path.join(globalClaudeSkills(), "review"))).toBe(true);
    expect(existsSync(path.join(projectClaudeSkills(), "deploy"))).toBe(true);
    expect(Object.values(state.state)).toHaveLength(2);
  });

  it("ensureFreshForPath ignores paths outside tracked projects", async () => {
    await writeSkill(projectAgentsSkills(), "deploy", `name: deploy`);

    await service.ensureFreshForPath(path.join(tempDir, "untracked"));

    expect(existsSync(path.join(projectClaudeSkills(), "deploy"))).toBe(false);
  });

  it("refresh runs immediately on the leading edge and throttles follow-ups", async () => {
    const skillDir = await writeSkill(
      globalAgentsSkills(),
      "review",
      `name: review`,
    );

    await service.refresh();
    expect(state.state[skillDir]).toBeDefined();

    // Within the throttle window a second refresh must not run synchronously;
    // the deletion is only picked up by the (cancelled-on-dispose) trailing run.
    await rm(skillDir, { recursive: true, force: true });
    void service.refresh();
    expect(state.state[skillDir]).toBeDefined();
  });
});
