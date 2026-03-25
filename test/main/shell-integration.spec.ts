import { describe, expect, it, vi } from "vitest";
import {
  ShellIntegrationMonitor,
  stripOsc133,
} from "../../src/main/shell-integration/osc-parser";

const BEL = "\x07";
const ESC = "\x1b";
const OSC_A = `${ESC}]133;A${BEL}`;
const OSC_B = `${ESC}]133;B${BEL}`;
const OSC_C = `${ESC}]133;C${BEL}`;
const OSC_D = `${ESC}]133;D${BEL}`;
const OSC_D_EXIT = `${ESC}]133;D;0${BEL}`;
const OSC_A_ST = `${ESC}]133;A${ESC}\\`;
const _OSC_C_ST = `${ESC}]133;C${ESC}\\`;

describe("ShellIntegrationMonitor", () => {
  function createMonitor() {
    const onChange = vi.fn();
    const monitor = new ShellIntegrationMonitor({
      onActivityChange: onChange,
    });
    return { monitor, onChange };
  }

  describe("state transitions", () => {
    it("starts in idle state", () => {
      const { monitor } = createMonitor();
      expect(monitor.getState()).toBe("idle");
    });

    it("transitions to running on C marker", () => {
      const { monitor, onChange } = createMonitor();
      monitor.processChunk(`before${OSC_C}after`);
      expect(monitor.getState()).toBe("running");
      expect(onChange).toHaveBeenCalledWith("running");
    });

    it("transitions to idle on A marker", () => {
      const { monitor, onChange } = createMonitor();
      monitor.processChunk(OSC_C);
      onChange.mockClear();

      monitor.processChunk(`output${OSC_A}prompt`);
      expect(monitor.getState()).toBe("idle");
      expect(onChange).toHaveBeenCalledWith("idle");
    });

    it("does not fire callback when state unchanged", () => {
      const { monitor, onChange } = createMonitor();
      // Already idle, receiving A should not fire
      monitor.processChunk(OSC_A);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("handles full command lifecycle: A → C → A", () => {
      const { monitor, onChange } = createMonitor();
      monitor.processChunk(OSC_A); // initial prompt
      monitor.processChunk(OSC_C); // command starts
      monitor.processChunk(OSC_A); // command ends, back at prompt

      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenNthCalledWith(1, "running");
      expect(onChange).toHaveBeenNthCalledWith(2, "idle");
      expect(monitor.getState()).toBe("idle");
    });

    it("ignores B and D markers for state", () => {
      const { monitor, onChange } = createMonitor();
      monitor.processChunk(OSC_B);
      monitor.processChunk(OSC_D);
      monitor.processChunk(OSC_D_EXIT);
      expect(onChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");
    });
  });

  describe("output stripping", () => {
    it("strips OSC 133 sequences with BEL terminator", () => {
      const { monitor } = createMonitor();
      const result = monitor.processChunk(`hello${OSC_A}world`);
      expect(result).toBe("helloworld");
    });

    it("strips OSC 133 sequences with ST terminator", () => {
      const { monitor } = createMonitor();
      const result = monitor.processChunk(`hello${OSC_A_ST}world`);
      expect(result).toBe("helloworld");
    });

    it("strips multiple sequences in one chunk", () => {
      const { monitor } = createMonitor();
      const result = monitor.processChunk(
        `${OSC_A}prompt$ ${OSC_C}output${OSC_A}prompt$`,
      );
      expect(result).toBe("prompt$ outputprompt$");
    });

    it("strips D marker with exit code params", () => {
      const { monitor } = createMonitor();
      const result = monitor.processChunk(`before${OSC_D_EXIT}after`);
      expect(result).toBe("beforeafter");
    });

    it("passes through chunks with no ESC unchanged", () => {
      const { monitor } = createMonitor();
      const input = "regular terminal output\r\nwith lines\r\n";
      expect(monitor.processChunk(input)).toBe(input);
    });

    it("passes through non-OSC-133 escape sequences unchanged", () => {
      const { monitor } = createMonitor();
      // ANSI color codes should pass through
      const input = `${ESC}[32mgreen${ESC}[0m`;
      expect(monitor.processChunk(input)).toBe(input);
    });
  });

  describe("split-chunk handling", () => {
    it("handles sequence split across two chunks", () => {
      const { monitor, onChange } = createMonitor();
      // Split "\x1b]133;C\x07" between "]133;" and "C\x07"
      const part1 = `before${ESC}]133;`;
      const part2 = `C${BEL}after`;

      const result1 = monitor.processChunk(part1);
      expect(result1).toBe("before");

      const result2 = monitor.processChunk(part2);
      expect(result2).toBe("after");
      expect(onChange).toHaveBeenCalledWith("running");
    });

    it("handles ESC at end of chunk", () => {
      const { monitor, onChange } = createMonitor();
      const result1 = monitor.processChunk(`text${ESC}`);
      expect(result1).toBe("text");

      const result2 = monitor.processChunk(`]133;C${BEL}more`);
      expect(result2).toBe("more");
      expect(onChange).toHaveBeenCalledWith("running");
    });

    it("handles sequence split into three chunks", () => {
      const { monitor, onChange } = createMonitor();
      const r1 = monitor.processChunk(`x${ESC}]`);
      expect(r1).toBe("x");

      const r2 = monitor.processChunk("133;");
      expect(r2).toBe("");

      const r3 = monitor.processChunk(`C${BEL}y`);
      expect(r3).toBe("y");
      expect(onChange).toHaveBeenCalledWith("running");
    });

    it("flushes pending buffer if it exceeds max size", () => {
      const { monitor } = createMonitor();
      // Create a fake ESC sequence that never terminates and is too long
      const longPayload = `${ESC}]133;${"x".repeat(70)}`;
      const result = monitor.processChunk(longPayload);
      // Should pass through since it exceeded the 64-byte limit
      expect(result).toBe(longPayload);
    });

    it("handles ST terminator split across chunks", () => {
      const { monitor, onChange } = createMonitor();
      // Split "\x1b]133;C\x1b\\" where \x1b\\ is the ST
      const part1 = `${ESC}]133;C${ESC}`;
      const part2 = "\\rest";

      const r1 = monitor.processChunk(part1);
      expect(r1).toBe("");

      const r2 = monitor.processChunk(part2);
      expect(r2).toBe("rest");
      expect(onChange).toHaveBeenCalledWith("running");
    });
  });
});

describe("stripOsc133", () => {
  it("strips all OSC 133 sequences from a string", () => {
    const input = `${OSC_A}prompt$ ${OSC_C}command output\r\n${OSC_D_EXIT}${OSC_A}prompt$`;
    expect(stripOsc133(input)).toBe("prompt$ command output\r\nprompt$");
  });

  it("returns unchanged string with no sequences", () => {
    const input = "regular terminal output";
    expect(stripOsc133(input)).toBe(input);
  });

  it("handles ST terminator", () => {
    expect(stripOsc133(`text${OSC_A_ST}more`)).toBe("textmore");
  });
});
