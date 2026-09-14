import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectGitService } from "../../src/main/project-git-service";
import { defineProjectState } from "../../src/main/project-service";

describe("selected changes with real Git", () => {
  let repo: string;
  let git: ReturnType<typeof simpleGit>;
  let service: ProjectGitService;

  beforeEach(async () => {
    vi.stubEnv("GIT_EDITOR", undefined);
    vi.stubEnv("PAGER", undefined);
    vi.stubEnv("GIT_PAGER", undefined);
    repo = await mkdtemp("/var/tmp/agent-ui-git-");
    git = simpleGit({
      baseDir: repo,
      unsafe: { allowUnsafeHooksPath: true },
    });
    await git.init();
    await git.addConfig("user.name", "Test");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("commit.gpgsign", "false");
    await git.addConfig("core.hooksPath", "/dev/null");
    for (const name of [
      "removed file.md",
      "unstaged.md",
      "modified.md",
      "unrelated.md",
    ]) {
      await writeFile(path.join(repo, name), `original ${name}\n`);
    }
    await git.add(".");
    await git.commit("Initial files");
    service = new ProjectGitService(defineProjectState());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(repo, { recursive: true, force: true });
  });

  it.each([false, true])("commits a deletion, staged=%s", async (staged) => {
    await rm(path.join(repo, "removed file.md"));
    if (staged) await git.add(["removed file.md"]);
    const indexBefore = await readFile(path.join(repo, ".git/index"));

    const diff = await service.getSelectedChangesDiff(repo, [
      "removed file.md",
    ]);
    expect(diff).toContain("deleted file mode");
    expect(await readFile(path.join(repo, ".git/index"))).toEqual(indexBefore);

    await service.commitSelectedChanges(repo, {
      paths: ["removed file.md"],
      subject: "Delete file",
    });
    expect(await git.raw(["show", "--format=", "--name-status", "HEAD"])).toBe(
      "D\tremoved file.md\n",
    );
    expect((await git.status()).isClean()).toBe(true);
  });

  it("commits mixed selections and preserves unrelated staged changes", async () => {
    await rm(path.join(repo, "removed file.md"));
    await writeFile(path.join(repo, "unrelated.md"), "unrelated staged edit\n");
    await git.add(["removed file.md", "unrelated.md"]);
    await rm(path.join(repo, "unstaged.md"));
    await writeFile(path.join(repo, "modified.md"), "selected edit\n");
    await writeFile(path.join(repo, "new.md"), "selected new file\n");
    const paths = ["removed file.md", "unstaged.md", "modified.md", "new.md"];
    const indexBefore = await readFile(path.join(repo, ".git/index"));

    const diff = await service.getSelectedChangesDiff(repo, paths);
    for (const name of paths) expect(diff).toContain(name);
    expect(diff).not.toContain("unrelated.md");
    expect(await readFile(path.join(repo, ".git/index"))).toEqual(indexBefore);

    await service.commitSelectedChanges(repo, {
      paths,
      subject: "Selected changes",
    });
    expect(await git.raw(["show", "--format=", "--name-status", "HEAD"])).toBe(
      "M\tmodified.md\nA\tnew.md\nD\tremoved file.md\nD\tunstaged.md\n",
    );
    expect(await git.raw(["diff", "--cached", "--name-only"])).toBe(
      "unrelated.md\n",
    );
    expect(await git.raw(["show", "HEAD:unrelated.md"])).toBe(
      "original unrelated.md\n",
    );
  });

  it("stages a file recreated after its deletion was staged", async () => {
    await rm(path.join(repo, "removed file.md"));
    await git.add(["removed file.md"]);
    await writeFile(
      path.join(repo, "removed file.md"),
      "replacement contents\n",
    );

    const diff = await service.getSelectedChangesDiff(repo, [
      "removed file.md",
    ]);
    expect(diff).toContain("+replacement contents");
    expect(diff).not.toContain("deleted file mode");
    await service.commitSelectedChanges(repo, {
      paths: ["removed file.md"],
      subject: "Replace file",
    });
    expect(await git.raw(["show", "HEAD:removed file.md"])).toBe(
      "replacement contents\n",
    );
    expect((await git.status()).isClean()).toBe(true);
  });

  it("commits a staged rename with further working-tree edits", async () => {
    await git.mv("removed file.md", "renamed.md");
    await writeFile(
      path.join(repo, "renamed.md"),
      "updated renamed contents\n",
    );
    const paths = ["removed file.md", "renamed.md"];

    const diff = await service.getSelectedChangesDiff(repo, paths);
    expect(diff).toContain("+updated renamed contents");
    await service.commitSelectedChanges(repo, {
      paths,
      subject: "Rename and edit",
    });
    expect(await git.raw(["show", "HEAD:renamed.md"])).toBe(
      "updated renamed contents\n",
    );
    expect(await git.raw(["ls-tree", "--name-only", "HEAD"])).not.toContain(
      "removed file.md",
    );
    expect((await git.status()).isClean()).toBe(true);
  });
});

describe("session worktrees with real Git", () => {
  let repo: string;
  let git: ReturnType<typeof simpleGit>;
  let projectsState: ReturnType<typeof defineProjectState>;
  let service: ProjectGitService;

  beforeEach(async () => {
    vi.stubEnv("GIT_EDITOR", undefined);
    vi.stubEnv("PAGER", undefined);
    vi.stubEnv("GIT_PAGER", undefined);
    repo = await mkdtemp("/var/tmp/agent-ui-worktree-");
    git = simpleGit({
      baseDir: repo,
      unsafe: { allowUnsafeHooksPath: true },
    });
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Test");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("commit.gpgsign", "false");
    await git.addConfig("core.hooksPath", "/dev/null");
    await writeFile(path.join(repo, "readme.md"), "hello\n");
    await git.add(".");
    await git.commit("Initial commit");

    projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: repo, collapsed: false });
    });
    service = new ProjectGitService(projectsState);
  });

  afterEach(async () => {
    await service?.dispose();
    vi.unstubAllEnvs();
    await rm(repo, { recursive: true, force: true });
    await rm(`${repo}-fix-login`, { recursive: true, force: true });
    await rm(`${repo}-fix-login-2`, { recursive: true, force: true });
    for (const name of [
      "merged-work",
      "pending-work",
      "pushed-work",
      "unmerged-work",
    ]) {
      await rm(`${repo}-${name}`, { recursive: true, force: true });
    }
  });

  const findProject = (projectPath: string) =>
    projectsState.state.find((project) => project.path === projectPath);

  it("creates a named worktree branch under the agent-ui prefix", async () => {
    const result = await service.createSessionWorktree({
      sourcePath: repo,
      name: "Fix Login!",
    });

    expect(result.path).toBe(`${repo}-fix-login`);
    expect(findProject(result.path)).toMatchObject({
      worktreeOriginPath: repo,
      worktreePlaceholder: undefined,
      gitBranch: "agent-ui/fix-login",
    });
  });

  it("suffixes the name when the branch is already taken", async () => {
    await service.createSessionWorktree({
      sourcePath: repo,
      name: "fix-login",
    });
    const second = await service.createSessionWorktree({
      sourcePath: repo,
      name: "fix-login",
    });

    expect(second.path).toBe(`${repo}-fix-login-2`);
    expect(findProject(second.path)?.gitBranch).toBe("agent-ui/fix-login-2");
  });

  it("generates a placeholder branch when no name is given", async () => {
    const result = await service.createSessionWorktree({ sourcePath: repo });
    const project = findProject(result.path);

    expect(project?.worktreePlaceholder).toBe(true);
    expect(project?.gitBranch).toMatch(/^agent-ui\/[0-9a-f]{8}$/);

    await rm(result.path, { recursive: true, force: true });
  });

  it("renames the placeholder branch and aliases the project from a title", async () => {
    const result = await service.createSessionWorktree({ sourcePath: repo });

    await service.renamePlaceholderWorktree({
      worktreePath: result.path,
      title: "Fix login redirect",
    });

    expect(findProject(result.path)).toMatchObject({
      alias: "Fix login redirect",
      gitBranch: "agent-ui/fix-login-redirect",
      worktreePlaceholder: undefined,
    });
    expect(
      await simpleGit({ baseDir: result.path }).branchLocal(),
    ).toMatchObject({ current: "agent-ui/fix-login-redirect" });

    await rm(result.path, { recursive: true, force: true });
  });

  it("leaves a renamed worktree alone on later titles", async () => {
    const result = await service.createSessionWorktree({ sourcePath: repo });
    await service.renamePlaceholderWorktree({
      worktreePath: result.path,
      title: "First title",
    });
    await service.renamePlaceholderWorktree({
      worktreePath: result.path,
      title: "Second title",
    });

    expect(findProject(result.path)).toMatchObject({
      alias: "First title",
      gitBranch: "agent-ui/first-title",
    });

    await rm(result.path, { recursive: true, force: true });
  });

  it("keeps the branch when it already has an upstream", async () => {
    const remote = await mkdtemp("/var/tmp/agent-ui-worktree-remote-");
    await simpleGit({ baseDir: remote }).init(["--bare"]);
    await git.addRemote("origin", remote);

    const result = await service.createSessionWorktree({ sourcePath: repo });
    const worktreeGit = simpleGit({ baseDir: result.path });
    const placeholderBranch = (await worktreeGit.branchLocal()).current;
    await worktreeGit.push(["-u", "origin", placeholderBranch]);

    await service.renamePlaceholderWorktree({
      worktreePath: result.path,
      title: "Fix login redirect",
    });

    expect((await worktreeGit.branchLocal()).current).toBe(placeholderBranch);
    expect(findProject(result.path)).toMatchObject({
      alias: "Fix login redirect",
      worktreePlaceholder: undefined,
    });

    await rm(result.path, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });

  it("reports branch, merge and upstream state for each worktree", async () => {
    const merged = await service.createSessionWorktree({
      sourcePath: repo,
      name: "merged-work",
    });
    const pending = await service.createSessionWorktree({
      sourcePath: repo,
      name: "pending-work",
    });

    await writeFile(path.join(merged.path, "merged.md"), "merged\n");
    const mergedGit = simpleGit({ baseDir: merged.path });
    await mergedGit.add(".");
    await mergedGit.commit("Merged work");
    await git.raw(["merge", "--no-edit", "agent-ui/merged-work"]);

    await writeFile(path.join(pending.path, "pending.md"), "pending\n");
    const pendingGit = simpleGit({ baseDir: pending.path });
    await pendingGit.add(".");
    await pendingGit.commit("Pending work");

    const overview = await service.getWorktreeStatuses(repo);

    expect(overview.originBranch).toBe("main");
    expect(overview.statuses).toEqual([
      {
        path: merged.path,
        branch: "agent-ui/merged-work",
        upstreamBranch: null,
        merged: true,
      },
      {
        path: pending.path,
        branch: "agent-ui/pending-work",
        upstreamBranch: null,
        merged: false,
      },
    ]);

    await rm(merged.path, { recursive: true, force: true });
    await rm(pending.path, { recursive: true, force: true });
  });

  it("reports the upstream branch once a worktree is pushed", async () => {
    const remote = await mkdtemp("/var/tmp/agent-ui-worktree-remote-");
    await simpleGit({ baseDir: remote }).init(["--bare"]);
    await git.addRemote("origin", remote);

    const worktree = await service.createSessionWorktree({
      sourcePath: repo,
      name: "pushed-work",
    });
    await simpleGit({ baseDir: worktree.path }).push([
      "-u",
      "origin",
      "agent-ui/pushed-work",
    ]);

    const overview = await service.getWorktreeStatuses(repo);

    expect(overview.statuses[0]).toMatchObject({
      path: worktree.path,
      upstreamBranch: "origin/agent-ui/pushed-work",
    });

    await rm(worktree.path, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });

  it("force deletes an unmerged branch with its worktree", async () => {
    const worktree = await service.createSessionWorktree({
      sourcePath: repo,
      name: "unmerged-work",
    });
    await writeFile(path.join(worktree.path, "unmerged.md"), "unmerged\n");
    const worktreeGit = simpleGit({ baseDir: worktree.path });
    await worktreeGit.add(".");
    await worktreeGit.commit("Unmerged work");

    const result = await service.performDeleteWorktreeFolderAndBranch({
      path: worktree.path,
      deleteFolder: true,
      deleteBranch: true,
      forceDeleteFolder: false,
      forceDeleteBranch: true,
    });

    expect(result.warning).toBeUndefined();
    expect((await git.branchLocal()).all).not.toContain(
      "agent-ui/unmerged-work",
    );
  });

  it("refuses to branch off a worktree project", async () => {
    const result = await service.createSessionWorktree({
      sourcePath: repo,
      name: "fix-login",
    });

    await expect(
      service.createSessionWorktree({ sourcePath: result.path }),
    ).rejects.toThrow("itself a worktree");
  });
});
