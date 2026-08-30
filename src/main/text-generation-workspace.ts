import path from "node:path";

const textGenerationWorkspaceDirectoryName = "text-generation-workspace";

export function getTextGenerationWorkingDirectory(
  userDataPath: string,
): string {
  return path.join(userDataPath, textGenerationWorkspaceDirectoryName);
}
