import { describe, expect, it } from "vitest";
import {
  classifyChangedFile,
  summarizeDiffByKind,
} from "../../src/shared/changed-file-kind";

describe("classifyChangedFile", () => {
  it.each([
    ["src/main/index.ts", "code"],
    ["src/latest.ts", "code"],
    ["src/Latest.java", "code"],
    ["src/contest.py", "code"],
    ["src/mockingbird.ts", "code"],
    ["src/testimonials/List.tsx", "code"],
    ["src/testUtils.ts", "code"],
    ["src/evaluate.ts", "code"],
    ["requirements.txt", "code"],
    ["test/main/session-service.spec.ts", "tests"],
    ["src/foo.test.tsx", "tests"],
    ["pkg/server_test.go", "tests"],
    ["tests/test_api.py", "tests"],
    ["conftest.py", "tests"],
    ["src/HTTPTest.java", "tests"],
    ["Sources/URLTests.swift", "tests"],
    ["src\\__tests__\\app.ts", "tests"],
    ["evals/summarize/cases.json", "evals"],
    ["src/agent.eval.ts", "evals"],
    ["pkg/ranking_eval.py", "evals"],
    ["eval_retrieval.py", "evals"],
    ["src/__mocks__/fs.ts", "mocks"],
    ["test/fixtures/pr.json", "mocks"],
    ["src/__snapshots__/view.test.ts.snap", "mocks"],
    ["src/mockServer.ts", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["src/routeTree.gen.ts", "generated"],
    ["dist/app.min.js", "generated"],
    ["README.md", "docs"],
    ["docs/guide.mdx", "docs"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});

describe("summarizeDiffByKind", () => {
  it("sums line counts per kind", () => {
    const breakdown = summarizeDiffByKind([
      { path: "src/a.ts", addedLines: 10, deletedLines: 2 },
      { path: "src/b.ts", addedLines: 5, deletedLines: 1 },
      { path: "src/a.test.ts", addedLines: 40, deletedLines: 0 },
      { path: "pnpm-lock.yaml", addedLines: 300, deletedLines: 120 },
    ]);

    expect(breakdown).toEqual({
      code: { addedLines: 15, deletedLines: 3 },
      tests: { addedLines: 40, deletedLines: 0 },
      evals: { addedLines: 0, deletedLines: 0 },
      mocks: { addedLines: 0, deletedLines: 0 },
      generated: { addedLines: 300, deletedLines: 120 },
      docs: { addedLines: 0, deletedLines: 0 },
    });
  });
});
