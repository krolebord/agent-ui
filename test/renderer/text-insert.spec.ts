import { insertAtSelection } from "@renderer/lib/text-insert";
import { describe, expect, it } from "vitest";

describe("insertAtSelection", () => {
  it("inserts into an empty prompt with a trailing space", () => {
    expect(insertAtSelection("", 0, 0, "/tmp/a.png")).toEqual({
      value: "/tmp/a.png ",
      caret: 11,
    });
  });

  it("separates the text from words on either side", () => {
    expect(insertAtSelection("look atthis", 7, 7, "/tmp/a.png")).toEqual({
      value: "look at /tmp/a.png this",
      caret: 19,
    });
  });

  it("does not double existing whitespace", () => {
    expect(insertAtSelection("see \nnext", 4, 4, "/tmp/a.png")).toEqual({
      value: "see /tmp/a.png\nnext",
      caret: 14,
    });
  });

  it("replaces the selected text", () => {
    expect(insertAtSelection("use FILE here", 4, 8, "/tmp/a.png")).toEqual({
      value: "use /tmp/a.png here",
      caret: 14,
    });
  });
});
