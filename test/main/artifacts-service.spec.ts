import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactsService,
  defineArtifactsState,
} from "../../src/main/artifacts-service";

describe("ArtifactsService", () => {
  let tempRoot: string;
  let service: ArtifactsService;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "artifacts-test-"));
    service = new ArtifactsService(defineArtifactsState());
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

    service.remove(artifact.id);

    expect(service.state.state[artifact.id]).toBeUndefined();
  });
});
