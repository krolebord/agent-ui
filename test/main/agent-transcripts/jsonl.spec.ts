import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forEachLine } from "../../../src/main/agent-transcripts/jsonl";

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), "jsonl-lines-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("forEachLine", () => {
  it("numbers lines from 1 across CRLF endings", async () => {
    const filePath = path.join(root, "a.jsonl");
    await fsp.writeFile(filePath, '{"a":1}\r\n\r\n{"b":2}', "utf8");

    const seen: [string, number][] = [];
    await forEachLine(filePath, (line, lineNumber) => {
      seen.push([line, lineNumber]);
    });
    expect(seen).toEqual([
      ['{"a":1}', 1],
      ["", 2],
      ['{"b":2}', 3],
    ]);
  });

  it("rejects when the file cannot be read", async () => {
    await expect(
      forEachLine(path.join(root, "missing.jsonl"), () => {}),
    ).rejects.toThrow();
  });
});
