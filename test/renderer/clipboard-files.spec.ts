import { getPastedFile } from "@renderer/lib/clipboard-files";
import { describe, expect, it } from "vitest";

function clipboard(text: string, files: (File | null)[]) {
  return {
    getData: (format: string) => (format === "text/plain" ? text : ""),
    items: files.map((file) => ({
      kind: "file",
      getAsFile: () => file,
    })) as unknown as DataTransferItemList,
  };
}

describe("getPastedFile", () => {
  const image = new File(["png"], "image.png", { type: "image/png" });

  it("returns the pasted file", () => {
    expect(getPastedFile(clipboard("", [null, image]))).toBe(image);
  });

  it("prefers plain text so copied text still pastes as text", () => {
    expect(getPastedFile(clipboard("A1\tB1", [image]))).toBeNull();
  });

  it("ignores empty clipboards", () => {
    expect(getPastedFile(null)).toBeNull();
    expect(getPastedFile(clipboard("", []))).toBeNull();
  });
});
