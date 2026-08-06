import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EditableFileConflictError,
  readEditableFileSnapshot,
  readGitFileContents,
  saveEditableFileSnapshot,
  UnsupportedEditableFileError,
} from "../../src/main/project-file-edit";

const execFileAsync = promisify(execFile);

describe("project file editing", () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(tmpdir(), "agent-ui-file-edit-"));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it("reads and saves a UTF-8 file when its revision still matches", async () => {
    const filePath = path.join(projectPath, "example.ts");
    await writeFile(filePath, "export const before = true;\n");

    const snapshot = await readEditableFileSnapshot(projectPath, "example.ts");
    const result = await saveEditableFileSnapshot(projectPath, {
      filePath: "example.ts",
      contents: "export const after = true;\n",
      expectedRevision: snapshot.revision,
    });

    expect(await readFile(filePath, "utf8")).toBe(
      "export const after = true;\n",
    );
    expect(result.revision).not.toBe(snapshot.revision);
  });

  it("refuses to overwrite a file that changed after it was read", async () => {
    const filePath = path.join(projectPath, "example.ts");
    await writeFile(filePath, "first\n");
    const snapshot = await readEditableFileSnapshot(projectPath, "example.ts");
    await writeFile(filePath, "agent change\n");

    await expect(
      saveEditableFileSnapshot(projectPath, {
        filePath: "example.ts",
        contents: "reviewer change\n",
        expectedRevision: snapshot.revision,
      }),
    ).rejects.toBeInstanceOf(EditableFileConflictError);
    expect(await readFile(filePath, "utf8")).toBe("agent change\n");
  });

  it("reports a conflict when the file was deleted after it was read", async () => {
    const filePath = path.join(projectPath, "example.ts");
    await writeFile(filePath, "first\n");
    const snapshot = await readEditableFileSnapshot(projectPath, "example.ts");
    await rm(filePath);

    await expect(
      saveEditableFileSnapshot(projectPath, {
        filePath: "example.ts",
        contents: "reviewer change\n",
        expectedRevision: snapshot.revision,
      }),
    ).rejects.toBeInstanceOf(EditableFileConflictError);
  });

  it("rejects paths outside the project and symbolic links", async () => {
    const outsidePath = path.join(projectPath, "..", "outside.txt");
    await writeFile(outsidePath, "outside\n");
    await symlink(outsidePath, path.join(projectPath, "linked.txt"));

    await expect(
      readEditableFileSnapshot(projectPath, "../outside.txt"),
    ).rejects.toThrow("File path must stay within the project");
    await expect(
      readEditableFileSnapshot(projectPath, "linked.txt"),
    ).rejects.toBeInstanceOf(UnsupportedEditableFileError);

    await rm(outsidePath, { force: true });
  });

  it("rejects binary content", async () => {
    await writeFile(
      path.join(projectPath, "binary.dat"),
      Buffer.from([1, 0, 2]),
    );

    await expect(
      readEditableFileSnapshot(projectPath, "binary.dat"),
    ).rejects.toThrow("Binary files cannot be edited");
  });

  it("reads the committed side of a diff without using the working tree", async () => {
    const filePath = path.join(projectPath, "example.ts");
    await execFileAsync("git", ["init", "-q"], { cwd: projectPath });
    await execFileAsync("git", ["config", "user.name", "Agent UI Tests"], {
      cwd: projectPath,
    });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], {
      cwd: projectPath,
    });
    await writeFile(filePath, "committed\n");
    await execFileAsync("git", ["add", "example.ts"], { cwd: projectPath });
    await execFileAsync("git", ["commit", "-qm", "initial"], {
      cwd: projectPath,
    });
    await writeFile(filePath, "working tree\n");

    await expect(
      readGitFileContents(projectPath, { filePath: "example.ts" }),
    ).resolves.toBe("committed\n");
  });
});

import { execFile } from "node:child_process";
