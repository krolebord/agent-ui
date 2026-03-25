export type ShellActivityState = "idle" | "running";

interface ShellIntegrationMonitorOptions {
  onActivityChange: (state: ShellActivityState) => void;
}

const ESC = "\x1b";
const BEL = "\x07";
const OSC_START = `${ESC}]133;`;

/**
 * Regex matching complete OSC 133 sequences with either BEL or ST terminator.
 * Captures the marker letter (A/B/C/D) and optional params.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal escape sequences
const OSC_133_RE = /\x1b\]133;([A-D])[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const MAX_PENDING_SIZE = 64;

/**
 * Stateless strip of all OSC 133 sequences from a string.
 * Used for cleaning buffered output that may contain shell integration markers.
 */
export function stripOsc133(text: string): string {
  return text.replace(OSC_133_RE, "");
}

/**
 * Stateful parser that strips OSC 133 sequences from PTY output chunks
 * and fires activity state changes based on precmd (A) and preexec (C) markers.
 *
 * Handles sequences split across chunk boundaries by buffering partial sequences.
 */
export class ShellIntegrationMonitor {
  private state: ShellActivityState = "idle";
  private pending = "";
  private readonly onActivityChange: (state: ShellActivityState) => void;

  constructor(options: ShellIntegrationMonitorOptions) {
    this.onActivityChange = options.onActivityChange;
  }

  getState(): ShellActivityState {
    return this.state;
  }

  /**
   * Process a PTY output chunk:
   * 1. Strip any OSC 133 sequences
   * 2. Fire state changes for A (idle) and C (running) markers
   * 3. Buffer partial sequences split across chunks
   *
   * Returns the cleaned chunk with OSC 133 sequences removed.
   */
  processChunk(chunk: string): string {
    let input: string;
    if (this.pending) {
      input = this.pending + chunk;
      this.pending = "";
    } else {
      input = chunk;
    }

    // Fast path: no ESC in the input means no possible OSC sequences
    if (!input.includes(ESC)) {
      return input;
    }

    let cleaned = "";
    let lastIndex = 0;

    for (let i = 0; i < input.length; i++) {
      if (input[i] !== ESC) continue;

      // Check if this could be the start of \x1b]133;
      const remaining = input.length - i;

      // Need at least ESC + ] + 1 + 3 + 3 + ; = "\x1b]133;" (6 chars)
      if (remaining < 6) {
        // Could be a partial OSC 133 — check prefix
        const tail = input.slice(i);
        if (OSC_START.startsWith(tail)) {
          // Partial match — buffer it
          cleaned += input.slice(lastIndex, i);
          this.pending = tail;
          return cleaned;
        }
        continue;
      }

      if (input.slice(i, i + 6) !== OSC_START) continue;

      // We have "\x1b]133;" — now find the terminator
      let terminated = false;
      let endIndex = i + 6;

      for (let j = i + 6; j < input.length; j++) {
        if (input[j] === BEL) {
          endIndex = j + 1;
          terminated = true;
          break;
        }
        if (input[j] === ESC && j + 1 < input.length && input[j + 1] === "\\") {
          endIndex = j + 2;
          terminated = true;
          break;
        }
      }

      if (!terminated) {
        // Sequence started but not terminated — buffer it
        const partial = input.slice(i);
        if (partial.length > MAX_PENDING_SIZE) {
          // Too long — not a real OSC 133 sequence, pass through
          continue;
        }
        cleaned += input.slice(lastIndex, i);
        this.pending = partial;
        return cleaned;
      }

      // Complete sequence found — extract the marker letter
      const marker = input[i + 6];
      this.handleMarker(marker);

      cleaned += input.slice(lastIndex, i);
      lastIndex = endIndex;
      i = endIndex - 1; // -1 because loop will i++
    }

    cleaned += input.slice(lastIndex);
    return cleaned;
  }

  private handleMarker(marker: string) {
    let newState: ShellActivityState | null = null;

    if (marker === "C") {
      newState = "running";
    } else if (marker === "A") {
      newState = "idle";
    }
    // B and D are stripped but don't change state

    if (newState && newState !== this.state) {
      this.state = newState;
      this.onActivityChange(newState);
    }
  }
}
