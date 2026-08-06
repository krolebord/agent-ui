import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";

const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{4,64}$/i;

export class EditableFileConflictError extends Error {
  constructor() {
    super("The file changed on disk after editing began.");
    this.name = "EditableFileConflictError";
  }
}

export class UnsupportedEditableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEditableFileError";
  }
}

export type EditableFileSnapshot = {
  contents: string;
  revision: string;
};

function hashContents(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function decodeTextFile(contents: Uint8Array): string {
  if (contents.includes(0)) {
    throw new UnsupportedEditableFileError(
      "Binary files cannot be edited in the diff pane.",
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new UnsupportedEditableFileError(
      "This file is not valid UTF-8 and cannot be edited in the diff pane.",
    );
  }
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveEditableFilePath(
  projectPath: string,
  filePath: string,
): Promise<string> {
  if (
    !filePath.trim() ||
    filePath.includes("\0") ||
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath)
  ) {
    throw new Error("File path must be project-relative.");
  }

  const projectRoot = await realpath(projectPath);
  const candidatePath = path.resolve(projectRoot, filePath);
  if (!isPathWithin(projectRoot, candidatePath)) {
    throw new Error("File path must stay within the project.");
  }

  const fileStats = await lstat(candidatePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new UnsupportedEditableFileError(
      "Only regular text files can be edited in the diff pane.",
    );
  }

  const resolvedPath = await realpath(candidatePath);
  if (!isPathWithin(projectRoot, resolvedPath)) {
    throw new Error("File path must stay within the project.");
  }

  return resolvedPath;
}

export async function readEditableFileSnapshot(
  projectPath: string,
  filePath: string,
): Promise<EditableFileSnapshot> {
  const resolvedPath = await resolveEditableFilePath(projectPath, filePath);
  const bytes = await readFile(resolvedPath);
  return {
    contents: decodeTextFile(bytes),
    revision: hashContents(bytes),
  };
}

export async function readGitFileContents(
  projectPath: string,
  input: { objectId?: string; filePath: string },
): Promise<string> {
  const gitEnvironment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  delete gitEnvironment.PAGER;
  delete gitEnvironment.GIT_PAGER;
  const git = simpleGit(projectPath).env({
    ...gitEnvironment,
  });
  const objectId = input.objectId?.trim();
  const contents = objectId
    ? GIT_OBJECT_ID_PATTERN.test(objectId)
      ? await git.raw(["cat-file", "blob", objectId])
      : (() => {
          throw new Error("Invalid Git object ID.");
        })()
    : await git.raw([
        "show",
        `HEAD:${input.filePath.split(path.sep).join("/")}`,
      ]);

  return decodeTextFile(Buffer.from(contents));
}

export async function saveEditableFileSnapshot(
  projectPath: string,
  input: { filePath: string; contents: string; expectedRevision: string },
): Promise<{ revision: string }> {
  let resolvedPath: string;
  try {
    resolvedPath = await resolveEditableFilePath(projectPath, input.filePath);
  } catch (error) {
    if (
      error instanceof UnsupportedEditableFileError ||
      (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      throw new EditableFileConflictError();
    }
    throw error;
  }
  const currentBytes = await readFile(resolvedPath);
  if (hashContents(currentBytes) !== input.expectedRevision) {
    throw new EditableFileConflictError();
  }

  const nextBytes = Buffer.from(input.contents, "utf8");
  await writeFile(resolvedPath, nextBytes);
  return { revision: hashContents(nextBytes) };
}
