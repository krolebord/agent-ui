import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_FOCUS_IN,
  CURSOR_FOCUS_OUT,
  CURSOR_FOCUS_REPORTING_ENABLED,
  CURSOR_FOCUS_SUBMIT_LATCH_MS,
  CursorFocusReporter,
} from "../../src/main/cursor-focus-reporter";

describe("CursorFocusReporter", () => {
  let writes: string[];
  let reporter: CursorFocusReporter;

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    reporter = new CursorFocusReporter({
      write: (data) => {
        writes.push(data);
      },
    });
  });

  afterEach(() => {
    reporter.dispose();
    vi.useRealTimers();
  });

  function enableReporting(): void {
    reporter.handleOutput(CURSOR_FOCUS_REPORTING_ENABLED);
  }

  it("sends focus-out when Cursor enables focus reporting", () => {
    enableReporting();
    expect(writes).toEqual([CURSOR_FOCUS_OUT]);
  });

  it("detects focus reporting enabled across chunk boundaries", () => {
    reporter.handleOutput(CURSOR_FOCUS_REPORTING_ENABLED.slice(0, 4));
    expect(writes).toEqual([]);
    reporter.handleOutput(CURSOR_FOCUS_REPORTING_ENABLED.slice(4));
    expect(writes).toEqual([CURSOR_FOCUS_OUT]);
  });

  it("strips xterm focus-in from input before reporting is enabled", () => {
    expect(reporter.transformInput(`a${CURSOR_FOCUS_IN}b`)).toBe("ab");
    expect(writes).toEqual([]);
  });

  it("does not claim focus while the session is not idle-like", () => {
    enableReporting();
    writes = [];
    expect(reporter.transformInput(CURSOR_FOCUS_IN)).toBe("");
    expect(writes).toEqual([]);
  });

  it("claims focus when the pane is focused and status is idle", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    writes = [];
    reporter.setStatus("idle");
    expect(writes).toEqual([CURSOR_FOCUS_IN]);
  });

  it("claims focus for awaiting_user_response", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    writes = [];
    reporter.setStatus("awaiting_user_response");
    expect(writes).toEqual([CURSOR_FOCUS_IN]);
  });

  it("does not claim focus for awaiting_approval", () => {
    enableReporting();
    reporter.setStatus("idle");
    reporter.transformInput(CURSOR_FOCUS_IN);
    writes = [];
    reporter.setStatus("awaiting_approval");
    expect(writes).toEqual([CURSOR_FOCUS_OUT]);
  });

  it("drops focus when the agent starts working", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    writes = [];
    reporter.setStatus("running");
    expect(writes).toEqual([CURSOR_FOCUS_OUT]);
  });

  it("drops focus when xterm reports focus-out", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    writes = [];
    expect(reporter.transformInput(`x${CURSOR_FOCUS_OUT}`)).toBe(
      `${CURSOR_FOCUS_OUT}x`,
    );
    expect(writes).toEqual([]);
  });

  it("prepends focus-out to Enter so Cursor is unfocused before submit", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    writes = [];
    expect(reporter.transformInput("hello\r")).toBe(
      `${CURSOR_FOCUS_OUT}hello\r`,
    );
  });

  it("keeps Cursor unfocused after Enter until the submit latch expires", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    reporter.transformInput("\r");
    writes = [];
    expect(reporter.transformInput("a")).toBe("a");
    expect(writes).toEqual([]);

    vi.advanceTimersByTime(CURSOR_FOCUS_SUBMIT_LATCH_MS - 1);
    expect(writes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(writes).toEqual([CURSOR_FOCUS_IN]);
  });

  it("does not restore focus after Enter once the session leaves idle", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    reporter.transformInput("\r");
    reporter.setStatus("running");
    writes = [];
    vi.advanceTimersByTime(CURSOR_FOCUS_SUBMIT_LATCH_MS);
    expect(writes).toEqual([]);
  });

  it("restores focus when work finishes if the pane is still focused", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    reporter.setStatus("running");
    writes = [];
    reporter.setStatus("awaiting_user_response");
    expect(writes).toEqual([CURSOR_FOCUS_IN]);
  });

  it("passes arrow keys through without treating them as focus events", () => {
    enableReporting();
    reporter.setStatus("idle");
    expect(reporter.transformInput("\u001b[A")).toBe("\u001b[A");
  });

  it("reassembles a focus-in sequence split across writes", () => {
    enableReporting();
    reporter.setStatus("idle");
    writes = [];
    expect(reporter.transformInput("\u001b")).toBe("");
    expect(reporter.transformInput("[I")).toBe(CURSOR_FOCUS_IN);
    expect(writes).toEqual([]);
  });

  it("does not emit a duplicate report when already in the desired state", () => {
    enableReporting();
    reporter.transformInput(CURSOR_FOCUS_IN);
    reporter.setStatus("idle");
    writes = [];
    reporter.setStatus("idle");
    expect(writes).toEqual([]);
  });
});
