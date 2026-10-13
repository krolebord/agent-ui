import {
  defaultSessionMemoryEmbeddingState,
  type SessionMemoryEmbeddingState,
} from "@shared/session-memory";
import { describe, expect, it } from "vitest";
import {
  conversationLabel,
  conversationProjectName,
  describeClearIndexWarning,
  describeEmbeddingProgress,
  describeForgetWarning,
  describeSearchCoverage,
  describeSemanticSearchFailure,
  describeTurnMatch,
  formatActivityDate,
  formatDuration,
  formatMegabytes,
  progressPercent,
  projectFilterOptions,
  resolveSearchMode,
  semanticSearchUnavailableReason,
} from "../../src/renderer/src/lib/session-memory-view";

function embedding(
  overrides: Partial<SessionMemoryEmbeddingState>,
): SessionMemoryEmbeddingState {
  return { ...defaultSessionMemoryEmbeddingState, ...overrides };
}

describe("session memory view helpers", () => {
  it("clamps progress and handles an empty total", () => {
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(25, 100)).toBe(25);
    expect(progressPercent(120, 100)).toBe(100);
  });

  it("formats durations and sizes", () => {
    expect(formatDuration(20_000)).toBe("under a minute");
    expect(formatDuration(14 * 60_000)).toBe("14 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
    expect(formatDuration(95 * 60_000)).toBe("1 h 35 min");
    expect(formatMegabytes(346_390_603)).toBe("346 MB");
  });

  it("describes embedding progress with rate and ETA", () => {
    expect(
      describeEmbeddingProgress(
        embedding({
          chunksEmbedded: 1_250,
          chunksTotal: 5_000,
          chunksPerMinute: 31.6,
          tokensPerSecond: 402.4,
          etaMs: 119 * 60_000,
        }),
      ),
    ).toEqual({
      percent: 25,
      countLabel: "1,250 of ~5,000 chunks",
      rateLabel: "32 chunks/min · 402 tokens/s",
      etaLabel: "about 1 h 59 min left",
    });
    expect(
      describeEmbeddingProgress(
        embedding({ chunksEmbedded: 0, chunksTotal: 0, chunksPerMinute: 4.25 }),
      ),
    ).toMatchObject({
      percent: 0,
      rateLabel: "4.3 chunks/min",
      etaLabel: null,
    });
  });
  it("labels conversations by title, then opening message", () => {
    expect(
      conversationLabel({ title: " Fix  login ", firstUserText: "x" }),
    ).toBe("Fix login");
    expect(
      conversationLabel({ title: null, firstUserText: "why\n\ndoes it fail" }),
    ).toBe("why does it fail");
    expect(conversationLabel({ title: "  ", firstUserText: null })).toBe(
      "Untitled conversation",
    );
  });

  it("names the project by its last path segment", () => {
    expect(
      conversationProjectName({ projectPath: "/p/agent-ui/", cwd: "/p/x" }),
    ).toBe("agent-ui");
    expect(
      conversationProjectName({ projectPath: null, cwd: "/p/app/web" }),
    ).toBe("web");
    expect(
      conversationProjectName({ projectPath: null, cwd: null }),
    ).toBeNull();
  });

  it("formats activity dates with the year only when it differs", () => {
    const now = new Date(2026, 9, 12).getTime();
    expect(formatActivityDate(new Date(2026, 2, 3).getTime(), now)).toBe(
      "Mar 3",
    );
    expect(formatActivityDate(new Date(2025, 11, 31).getTime(), now)).toBe(
      "Dec 31, 2025",
    );
    expect(formatActivityDate(null, now)).toBeNull();
  });

  it("mentions subagents when forgetting a main conversation", () => {
    expect(describeForgetWarning({ relation: "main" })).toContain(
      "its subagent conversations",
    );
    expect(describeForgetWarning({ relation: "subagent" })).not.toContain(
      "its subagent conversations",
    );
  });

  it("warns how many conversations a clear loses for good", () => {
    const enabled = describeClearIndexWarning(
      { conversations: 10, conversationsWithoutTranscript: 3 },
      true,
    );
    expect(enabled).toContain("rebuilt from the transcripts still on disk");
    expect(enabled).toContain(
      "3 conversations whose transcripts were deleted will be lost permanently.",
    );
    expect(enabled).toContain("Forgotten conversations stay forgotten.");
    expect(
      describeClearIndexWarning(
        { conversations: 1, conversationsWithoutTranscript: 1 },
        false,
      ),
    ).toContain("1 conversation whose transcript was deleted");
    expect(
      describeClearIndexWarning(
        { conversations: 4, conversationsWithoutTranscript: 0 },
        true,
      ),
    ).toContain("nothing is lost permanently");
  });

  it("explains when semantic search cannot run", () => {
    const ready = embedding({
      status: "idle",
      model: { ...embedding({}).model, status: "ready" },
      chunksEmbedded: 5,
    });
    expect(semanticSearchUnavailableReason(ready)).toBeNull();
    expect(
      semanticSearchUnavailableReason({ ...ready, status: "paused" }),
    ).toBeNull();
    expect(
      semanticSearchUnavailableReason({ ...ready, status: "unsupported" }),
    ).toBe("Semantic search is not available in this build.");
    expect(
      semanticSearchUnavailableReason({
        ...ready,
        model: { ...ready.model, status: "downloading" },
      }),
    ).toContain("finishes downloading");
    expect(
      semanticSearchUnavailableReason({
        ...ready,
        model: { ...ready.model, status: "error" },
      }),
    ).toContain("could not be downloaded");
    expect(
      semanticSearchUnavailableReason({ ...ready, chunksEmbedded: 0 }),
    ).toContain("first conversations are embedded");
  });

  it("defaults to semantic search and falls back to text", () => {
    expect(resolveSearchMode(null, true)).toBe("semantic");
    expect(resolveSearchMode("text", true)).toBe("text");
    expect(resolveSearchMode("semantic", false)).toBe("text");
    expect(resolveSearchMode(null, false)).toBe("text");
    expect(
      describeSemanticSearchFailure(
        "The embedding model is not downloaded yet",
      ),
    ).toBe(
      "The embedding model is not downloaded yet. Showing text matches instead.",
    );
    expect(describeSemanticSearchFailure(" ")).toBe(
      "Semantic search failed. Showing text matches instead.",
    );
  });

  it("notes missing embeddings only while coverage is incomplete", () => {
    expect(
      describeSearchCoverage({ chunksEmbedded: 2_300, chunksTotal: 4_888 }),
    ).toBe(
      "Embedded 2,300 / 4,888 chunks; older conversations may be missing.",
    );
    expect(
      describeSearchCoverage({ chunksEmbedded: 10, chunksTotal: 10 }),
    ).toBeNull();
  });

  it("describes the matching turn with its position, time and relevance", () => {
    const now = new Date(2026, 9, 12).getTime();
    expect(
      describeTurnMatch(
        {
          ordinal: 2,
          startedAt: new Date(2026, 9, 3, 14, 5).getTime(),
          relevance: 0.6234,
        },
        12,
        now,
      ),
    ).toBe("Turn 3 of 12 · Oct 3, 14:05 · relevance 0.62");
    expect(
      describeTurnMatch(
        { ordinal: 0, startedAt: null, relevance: 0.5 },
        1,
        now,
      ),
    ).toBe("Turn 1 of 1 · relevance 0.50");
  });

  it("offers registered projects without worktrees, sorted by label", () => {
    expect(
      projectFilterOptions([
        { path: "/p/zeta" },
        { path: "/p/app", alias: " Main app " },
        { path: "/p/app-wt", worktreeOriginPath: "/p/app" },
        { path: "/p/beta/" },
      ]),
    ).toEqual([
      { path: "/p/beta/", label: "beta" },
      { path: "/p/app", label: "Main app" },
      { path: "/p/zeta", label: "zeta" },
    ]);
  });
});
