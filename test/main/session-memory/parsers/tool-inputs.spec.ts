import { describe, expect, it } from "vitest";
import {
  codexExecCommands,
  commandFromArgv,
  patchFilePaths,
  readJsStringLiteral,
} from "../../../../src/main/session-memory/parsers/tool-inputs";

describe("codexExecCommands", () => {
  it("reads cmd literals in every quoting style", () => {
    const source = [
      "const results = await Promise.allSettled([",
      '  tools.exec_command({"cmd":"git status --short","max_output_tokens":2000}),',
      "  tools.exec_command({cmd:'sed -n \\'1,20p\\' a.ts', workdir:\"/w\"}),",
      "  tools.exec_command({",
      "    cmd: `gh run view 42`,",
      "  }),",
      '  tools.exec_command({cmd:"printf \\"a\\\\nb\\" \\u0041"}),',
      "  tools.exec_command({cmd: built}),",
      "]);",
    ].join("\n");
    expect(codexExecCommands(source)).toEqual([
      "git status --short",
      "sed -n '1,20p' a.ts",
      "gh run view 42",
      'printf "a\\nb" A',
    ]);
  });

  it("does not read cmd keys nested inside an earlier command", () => {
    expect(
      codexExecCommands('tools.exec_command({cmd:"echo {cmd:\\"inner\\"}"})'),
    ).toEqual(['echo {cmd:"inner"}']);
  });
});

describe("patchFilePaths", () => {
  it("reads headers from raw patches and JS string literals", () => {
    expect(
      patchFilePaths(
        "*** Begin Patch\n*** Update File: /w/a.ts\n*** Move to: /w/b.ts\n@@\n*** Delete File: /w/c.ts\n*** End Patch",
      ),
    ).toEqual(["/w/a.ts", "/w/b.ts", "/w/c.ts"]);
    expect(
      patchFilePaths(
        'const patch = "*** Begin Patch\\n*** Add File: /w/new file.ts\\n+x\\n*** End Patch";',
      ),
    ).toEqual(["/w/new file.ts"]);
  });
});

describe("readJsStringLiteral", () => {
  it("rejects unterminated literals", () => {
    expect(readJsStringLiteral('"abc', 0)).toBeNull();
    expect(readJsStringLiteral("x", 0)).toBeNull();
  });
});

describe("commandFromArgv", () => {
  it("unwraps shell -lc invocations", () => {
    expect(commandFromArgv(["bash", "-lc", "ls -la"])).toBe("ls -la");
    expect(commandFromArgv(["git", "status"])).toBe("git status");
    expect(commandFromArgv([1, 2])).toBeNull();
  });
});
