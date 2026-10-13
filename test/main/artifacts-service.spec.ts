import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
