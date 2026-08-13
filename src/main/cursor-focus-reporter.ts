export const CURSOR_FOCUS_IN = "\u001b[I";
export const CURSOR_FOCUS_OUT = "\u001b[O";
export const CURSOR_FOCUS_REPORTING_ENABLED = "\u001b[?1004h";
export const CURSOR_FOCUS_SUBMIT_LATCH_MS = 400;

function isIdleLikeStatus(status: string): boolean {
  return status === "idle" || status === "awaiting_user_response";
}

/**
 * Cursor CLI only emits OSC 99 notifications while it thinks the terminal is
 * unfocused, and only draws an input caret while it thinks the terminal is
 * focused. This reporter keeps Cursor "unfocused" except when the user is
 * actually at a prompt (idle-like status + xterm pane focused), and writes
 * focus-out immediately on Enter so the first approval notification is not
 * lost to hook-file latency.
 */
export class CursorFocusReporter {
  private paneFocused = false;
  private reportingEnabled = false;
  private cursorThinksFocused = false;
  private needsInitialReport = false;
  private status = "starting";
  private submitLatch = false;
  private submitLatchTimer: ReturnType<typeof setTimeout> | undefined;
  private inputTail = "";
  private outputTail = "";
  private readonly write: (data: string) => void;

  constructor(options: { write: (data: string) => void }) {
    this.write = options.write;
  }

  handleOutput(chunk: string): void {
    const output = this.outputTail + chunk;
    if (output.includes(CURSOR_FOCUS_REPORTING_ENABLED)) {
      this.reportingEnabled = true;
      this.needsInitialReport = true;
      this.flush();
    }
    this.outputTail = output.slice(
      -(CURSOR_FOCUS_REPORTING_ENABLED.length - 1),
    );
  }

  transformInput(data: string): string {
    const rest = this.stripFocusEvents(data);
    if (rest.includes("\r")) {
      this.armSubmitLatch();
    }
    return this.takePendingFocusSequence() + rest;
  }

  setStatus(status: string): void {
    this.status = status;
    if (!isIdleLikeStatus(status)) {
      this.clearSubmitLatch();
    }
    this.flush();
  }

  dispose(): void {
    this.clearSubmitLatch();
  }

  private shouldReportFocused(): boolean {
    return (
      this.reportingEnabled &&
      this.paneFocused &&
      !this.submitLatch &&
      isIdleLikeStatus(this.status)
    );
  }

  private takePendingFocusSequence(): string {
    if (!this.reportingEnabled) {
      return "";
    }

    const desired = this.shouldReportFocused();
    if (!this.needsInitialReport && desired === this.cursorThinksFocused) {
      return "";
    }

    this.needsInitialReport = false;
    this.cursorThinksFocused = desired;
    return desired ? CURSOR_FOCUS_IN : CURSOR_FOCUS_OUT;
  }

  private flush(): void {
    const sequence = this.takePendingFocusSequence();
    if (sequence) {
      this.write(sequence);
    }
  }

  private armSubmitLatch(): void {
    this.submitLatch = true;
    this.clearSubmitLatchTimer();
    this.submitLatchTimer = setTimeout(() => {
      this.submitLatchTimer = undefined;
      this.submitLatch = false;
      this.flush();
    }, CURSOR_FOCUS_SUBMIT_LATCH_MS);
    this.submitLatchTimer.unref?.();
  }

  private clearSubmitLatch(): void {
    this.submitLatch = false;
    this.clearSubmitLatchTimer();
  }

  private clearSubmitLatchTimer(): void {
    if (this.submitLatchTimer !== undefined) {
      clearTimeout(this.submitLatchTimer);
      this.submitLatchTimer = undefined;
    }
  }

  private stripFocusEvents(data: string): string {
    const input = this.inputTail + data;
    this.inputTail = "";
    let output = "";

    for (let i = 0; i < input.length; i++) {
      if (input[i] !== "\u001b") {
        output += input[i];
        continue;
      }

      const rest = input.slice(i);
      if (rest === "\u001b" || rest === "\u001b[") {
        this.inputTail = rest;
        break;
      }
      if (rest.startsWith(CURSOR_FOCUS_IN)) {
        this.paneFocused = true;
        i += CURSOR_FOCUS_IN.length - 1;
        continue;
      }
      if (rest.startsWith(CURSOR_FOCUS_OUT)) {
        this.paneFocused = false;
        i += CURSOR_FOCUS_OUT.length - 1;
        continue;
      }

      output += input[i];
    }

    return output;
  }
}
