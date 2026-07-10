import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureShellIntegrationScripts } from "../../src/main/shell-integration/scripts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ensureShellIntegrationScripts", () => {
  it("writes managed zsh and Bash configurations", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-shell-integration-"),
    );
    temporaryDirectories.push(userDataPath);

    const result = await ensureShellIntegrationScripts(userDataPath);
    const zshRcFile = path.join(
      userDataPath,
      "shell-integration",
      "zsh",
      ".zshrc",
    );
    const bashRcFile = path.join(
      userDataPath,
      "shell-integration",
      "bash",
      ".bashrc",
    );

    expect(result.env).toMatchObject({
      AGENT_UI_BASH_RCFILE: bashRcFile,
      ZDOTDIR: path.dirname(zshRcFile),
    });
    await expect(readFile(zshRcFile, "utf8")).resolves.toContain(
      "add-zsh-hook preexec _agent_ui_preexec",
    );
    await expect(readFile(bashRcFile, "utf8")).resolves.toContain(
      "PS0=$'\\033]133;C\\007'",
    );
  });
});
