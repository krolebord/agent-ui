import { describe, expect, it } from "vitest";
import { StringRingBuffer } from "../../src/shared/string-ring-buffer";

describe("StringRingBuffer", () => {
  it("appends pushed values and returns full content", () => {
    const buffer = new StringRingBuffer({ maxTotalSize: 20 });

    buffer.push("hello");
    buffer.push(" ");
    buffer.push("world");

    expect(buffer.getFullContent()).toBe("hello world");
    expect(buffer.getContent()).toBe("hello world");
    expect(buffer.getTotalSize()).toBe(11);
  });

  it("trims only the needed oldest prefix when overflowing", () => {
    const buffer = new StringRingBuffer({ maxTotalSize: 10 });

    buffer.push("abcdef");
    buffer.push("ghij");
    buffer.push("k");

    expect(buffer.getFullContent()).toBe("bcdefghijk");
    expect(buffer.getTotalSize()).toBe(10);
  });

  it("keeps the newest suffix when a single push exceeds maxTotalSize", () => {
    const buffer = new StringRingBuffer({ maxTotalSize: 5 });

    buffer.push("ab");
    buffer.push("1234567");

    expect(buffer.getFullContent()).toBe("34567");
    expect(buffer.getTotalSize()).toBe(5);
  });

  it("clears buffered content", () => {
    const buffer = new StringRingBuffer({ maxTotalSize: 5 });

    buffer.push("hello");
    buffer.clear();

    expect(buffer.getFullContent()).toBe("");
    expect(buffer.getTotalSize()).toBe(0);
  });

  it("throws for invalid maxTotalSize", () => {
    expect(() => new StringRingBuffer({ maxTotalSize: 0 })).toThrow();
    expect(() => new StringRingBuffer({ maxTotalSize: -1 })).toThrow();
    expect(() => new StringRingBuffer({ maxTotalSize: 1.5 })).toThrow();
  });
});
