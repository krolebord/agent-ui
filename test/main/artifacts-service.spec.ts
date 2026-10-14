import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactsService,
  artifactSchema,
  defineArtifactsState,
} from "../../src/main/artifacts-service";

describe("ArtifactsService", () => {
  let tempRoot: string;
  let service: ArtifactsService;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "artifacts-test-"));
    service = new ArtifactsService(defineArtifactsState(), {
      visualsDir: path.join(tempRoot, "visuals"),
      screenshotDir: path.join(tempRoot, "visual-previews"),
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("publishes a relative file with session attribution and metadata", async () => {
    const filePath = path.join(tempRoot, "report.json");
    await writeFile(filePath, '{"ok":true}');

    const artifact = await service.publish({
      sessionId: "session-123",
      cwd: tempRoot,
      filePath: "report.json",
      name: "Results",
      description: "Generated report",
    });

    expect(artifact).toMatchObject({
      sessionId: "session-123",
      path: filePath,
      name: "Results",
      description: "Generated report",
      size: 11,
      mimeType: "application/json",
      available: true,
    });
    expect(service.state.state[artifact.id]).toEqual(artifact);
  });

  it("allows files outside the session working directory", async () => {
    const outsidePath = path.join(tempRoot, "outside.txt");
    await writeFile(outsidePath, "download me");

    const artifact = await service.publish({
      sessionId: "session-123",
      cwd: path.join(tempRoot, "unrelated"),
      filePath: outsidePath,
    });

    expect(artifact.path).toBe(outsidePath);
    expect(artifact.name).toBe("outside.txt");
  });

  it("updates the existing artifact when a session republishes a file", async () => {
    const filePath = path.join(tempRoot, "report.md");
    await writeFile(filePath, "draft");
    const first = await service.publish({
      sessionId: "session-123",
      cwd: tempRoot,
      filePath: "report.md",
      name: "Report",
      description: "Draft",
    });

    await writeFile(filePath, "final version");
    const second = await service.publish({
      sessionId: "session-123",
      cwd: tempRoot,
      filePath,
    });

    expect(second).toMatchObject({
      id: first.id,
      name: "Report",
      description: "Draft",
      size: 13,
    });
    expect(Object.keys(service.state.state)).toEqual([first.id]);

    const other = await service.publish({
      sessionId: "session-456",
      cwd: tempRoot,
      filePath,
    });
    expect(other.id).not.toBe(first.id);
  });

  it("marks artifacts missing without removing their metadata", async () => {
    const filePath = path.join(tempRoot, "temporary.pdf");
    await writeFile(filePath, "pdf");
    const artifact = await service.publish({
      sessionId: "session-123",
      cwd: tempRoot,
      filePath,
    });

    await rm(filePath);
    await service.refreshAvailability();

    expect(service.state.state[artifact.id]?.available).toBe(false);
  });

  it("rejects directories", async () => {
    const directory = path.join(tempRoot, "folder");
    await mkdir(directory);

    await expect(
      service.publish({
        sessionId: "session-123",
        cwd: tempRoot,
        filePath: directory,
      }),
    ).rejects.toThrow("Only regular files");
  });

  it("removes only the artifact record", async () => {
    const filePath = path.join(tempRoot, "keep.txt");
    await writeFile(filePath, "keep");
    const artifact = await service.publish({
      sessionId: "session-123",
      cwd: tempRoot,
      filePath,
    });

    await service.remove(artifact.id);

    expect(service.state.state[artifact.id]).toBeUndefined();
    await expect(readFile(filePath, "utf8")).resolves.toBe("keep");
  });

  it("stores a visual page in the visuals directory", async () => {
    const html = "<!doctype html><p>café</p>";
    const artifact = await service.publishVisual({
      sessionId: "session-123",
      html,
      title: `  ${"T".repeat(250)}  `,
      description: " Weekly chart ",
    });

    expect(artifact).toMatchObject({
      kind: "visual",
      sessionId: "session-123",
      path: path.join(tempRoot, "visuals", `${artifact.id}.html`),
      name: "T".repeat(200),
      description: "Weekly chart",
      size: Buffer.byteLength(html),
      mimeType: "text/html",
      available: true,
    });
    await expect(readFile(artifact.path, "utf8")).resolves.toBe(html);
    expect(service.state.state[artifact.id]).toEqual(artifact);
  });

  it("deletes a visual's stored page when removing it", async () => {
    const artifact = await service.publishVisual({
      sessionId: "session-123",
      html: "<p>chart</p>",
      title: "Chart",
    });

    await service.remove(artifact.id);

    expect(service.state.state[artifact.id]).toBeUndefined();
    await expect(stat(artifact.path)).rejects.toThrow();
  });

  it("never deletes a visual's file outside the visuals directory", async () => {
    const outsidePath = path.join(tempRoot, "outside.html");
    await writeFile(outsidePath, "keep");
    service.state.updateState((artifacts) => {
      artifacts.tampered = {
        id: "tampered",
        kind: "visual",
        sessionId: "session-123",
        path: outsidePath,
        name: "Tampered",
        size: 4,
        mimeType: "text/html",
        createdAt: 1,
        available: true,
      };
    });

    await service.remove("tampered");

    expect(service.state.state.tampered).toBeUndefined();
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("keep");
  });

  it("defaults persisted artifacts without a kind to files", () => {
    expect(
      artifactSchema.parse({
        id: "a",
        sessionId: "s",
        path: "/tmp/a.txt",
        name: "a.txt",
        size: 1,
        createdAt: 1,
      }).kind,
    ).toBe("file");
  });

  describe("cleanup", () => {
    const NOW = Date.parse("2026-10-14T12:00:00Z");
    let projectDir: string;
    let trashFile: ReturnType<
      typeof vi.fn<(filePath: string) => Promise<void>>
    >;

    function git(...args: string[]) {
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { cwd: projectDir, stdio: "ignore" },
      );
    }

    async function publishFile(filePath: string, contents = "data") {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
      return service.publish({ sessionId: "s", cwd: tempRoot, filePath });
    }

    beforeEach(async () => {
      projectDir = path.join(tempRoot, "project");
      await mkdir(projectDir, { recursive: true });
      git("init", "-q");
      await writeFile(path.join(projectDir, "tracked.md"), "tracked");
      git("add", "tracked.md");
      git("commit", "-q", "-m", "init");
      trashFile = vi.fn(async (filePath: string) => {
        await rm(filePath);
      });
      service = new ArtifactsService(defineArtifactsState(), {
        visualsDir: path.join(tempRoot, "visuals"),
        screenshotDir: path.join(tempRoot, "visual-previews"),
        getProjectPaths: () => [projectDir],
        trashFile,
        now: () => NOW,
      });
    });

    it("tells app storage, tracked and untracked project files, and other paths apart", async () => {
      const visual = await service.publishVisual({
        sessionId: "s",
        html: "<p>chart</p>",
        title: "Chart",
      });
      const tracked = await service.publish({
        sessionId: "s",
        cwd: projectDir,
        filePath: "tracked.md",
      });
      const untracked = await publishFile(
        path.join(projectDir, "out", "report.pdf"),
      );
      const elsewhere = await publishFile(path.join(tempRoot, "tmp", "a.txt"));

      await expect(
        service.inspect([visual.id, tracked.id, untracked.id, elsewhere.id]),
      ).resolves.toEqual({
        [visual.id]: { kind: "app" },
        [tracked.id]: {
          kind: "project",
          projectPath: projectDir,
          tracked: true,
        },
        [untracked.id]: {
          kind: "project",
          projectPath: projectDir,
          tracked: false,
        },
        [elsewhere.id]: { kind: "elsewhere" },
      });
    });

    it("removes artifacts with missing files and only old preview screenshots", async () => {
      const kept = await publishFile(path.join(tempRoot, "kept.txt"));
      const gone = await publishFile(path.join(tempRoot, "gone.txt"));
      await rm(gone.path);
      const screenshots = path.join(tempRoot, "visual-previews");
      await mkdir(screenshots, { recursive: true });
      const oldShot = path.join(screenshots, "old.png");
      const recentShot = path.join(screenshots, "recent.png");
      await writeFile(oldShot, "png");
      await writeFile(recentShot, "png");
      const twoHoursAgo = new Date(NOW - 2 * 60 * 60_000);
      await utimes(oldShot, twoHoursAgo, twoHoursAgo);
      const tenMinutesAgo = new Date(NOW - 10 * 60_000);
      await utimes(recentShot, tenMinutesAgo, tenMinutesAgo);

      await expect(service.cleanup()).resolves.toEqual({
        removedArtifacts: 1,
        removedScreenshots: 1,
      });
      expect(Object.keys(service.state.state)).toEqual([kept.id]);
      await expect(stat(oldShot)).rejects.toThrow();
      await expect(stat(recentShot)).resolves.toBeTruthy();
    });

    it("deletes untracked files and visuals but never tracked files or symlinks", async () => {
      const visual = await service.publishVisual({
        sessionId: "s",
        html: "<p>chart</p>",
        title: "Chart",
      });
      const tracked = await service.publish({
        sessionId: "s",
        cwd: projectDir,
        filePath: "tracked.md",
      });
      const untracked = await publishFile(path.join(projectDir, "report.pdf"));
      const target = path.join(tempRoot, "target.txt");
      await writeFile(target, "target");
      const link = path.join(tempRoot, "link.txt");
      await symlink(target, link);
      const linked = await service.publish({
        sessionId: "s",
        cwd: tempRoot,
        filePath: link,
      });

      await expect(
        service.deleteFiles([visual.id, tracked.id, untracked.id, linked.id]),
      ).resolves.toEqual({ deleted: 2, skipped: 2 });

      expect(trashFile).toHaveBeenCalledExactlyOnceWith(untracked.path);
      await expect(stat(visual.path)).rejects.toThrow();
      await expect(stat(untracked.path)).rejects.toThrow();
      await expect(readFile(tracked.path, "utf8")).resolves.toBe("tracked");
      await expect(readFile(target, "utf8")).resolves.toBe("target");
      expect(Object.keys(service.state.state).sort()).toEqual(
        [tracked.id, linked.id].sort(),
      );
    });

    it("marks other artifacts for the same file missing after deleting it", async () => {
      const first = await publishFile(path.join(tempRoot, "shared.txt"));
      const second = await service.publish({
        sessionId: "other",
        cwd: tempRoot,
        filePath: first.path,
      });

      await service.deleteFiles([first.id]);

      expect(service.state.state[first.id]).toBeUndefined();
      expect(service.state.state[second.id]?.available).toBe(false);
    });
  });
});
