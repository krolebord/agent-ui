export type ShellActivityState = "idle" | "running";

interface ShellIntegrationMonitorOptions {
  onActivityChange: (state: ShellActivityState) => void;
  onPrompt?: () => void;
}

const ESC = "\x1b";
const BEL = "\x07";
const OSC_START = `${ESC}]133;`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal escape sequences
const OSC_133_RE = /\x1b\]133;([A-D])[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const MAX_PENDING_SIZE = 64;

export function stripOsc133(text: string): string {
  return text.replace(OSC_133_RE, "");
}

export class ShellIntegrationMonitor {
  private state: ShellActivityState = "idle";
  private pending = "";
  private readonly onActivityChange: (state: ShellActivityState) => void;
  private readonly onPrompt?: () => void;

  constructor(options: ShellIntegrationMonitorOptions) {
    this.onActivityChange = options.onActivityChange;
    this.onPrompt = options.onPrompt;
  }

  getState(): ShellActivityState {
    return this.state;
  }

  processChunk(chunk: string): string {
    let input: string;
    if (this.pending) {
      input = this.pending + chunk;
      this.pending = "";
    } else {
      input = chunk;
    }

    if (!input.includes(ESC)) {
      return input;
    }

    let cleaned = "";
    let lastIndex = 0;

    for (let i = 0; i < input.length; i++) {
      if (input[i] !== ESC) continue;

      const remaining = input.length - i;

      if (remaining < 6) {
        const tail = input.slice(i);
        if (OSC_START.startsWith(tail)) {
          cleaned += input.slice(lastIndex, i);
          this.pending = tail;
          return cleaned;
        }
        continue;
      }

      if (input.slice(i, i + 6) !== OSC_START) continue;

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
        const partial = input.slice(i);
        if (partial.length > MAX_PENDING_SIZE) {
          continue;
        }
        cleaned += input.slice(lastIndex, i);
        this.pending = partial;
        return cleaned;
      }

      const marker = input[i + 6];
      this.handleMarker(marker);

      cleaned += input.slice(lastIndex, i);
      lastIndex = endIndex;
      i = endIndex - 1;
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
      this.onPrompt?.();
    }

    if (newState && newState !== this.state) {
      this.state = newState;
      this.onActivityChange(newState);
    }
  }
}
