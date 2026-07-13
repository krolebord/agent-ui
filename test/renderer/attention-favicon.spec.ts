import { describe, expect, it, vi } from "vitest";
import {
  createAttentionFaviconDataUrl,
  formatAttentionFaviconCount,
  restoreAttentionFavicon,
  updateAttentionFavicon,
} from "../../src/renderer/src/services/attention-favicon";

function createCanvasDocument(faviconLinks: HTMLLinkElement[] = []) {
  const context = {
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    fillStyle: "",
    font: "",
    lineWidth: 0,
    strokeStyle: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  const canvas = {
    getContext: vi.fn(() => context),
    toDataURL: vi.fn(() => "data:image/png;base64,favicon"),
    width: 0,
    height: 0,
  };
  const documentRef = {
    createElement: vi.fn(() => canvas),
    querySelectorAll: vi.fn(() => faviconLinks),
  } as unknown as Document;

  return { canvas, context, documentRef };
}

function createFaviconLink(attributes: Record<string, string>) {
  const values = new Map(Object.entries(attributes));
  const link = {
    getAttribute: vi.fn((name: string) => values.get(name) ?? null),
    remove: vi.fn(),
    removeAttribute: vi.fn((name: string) => values.delete(name)),
    setAttribute: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
  } as unknown as HTMLLinkElement;

  return { link, values };
}

describe("attention favicon", () => {
  it("keeps readable counts within the favicon", () => {
    expect(formatAttentionFaviconCount(1)).toBe("1");
    expect(formatAttentionFaviconCount(12)).toBe("12");
    expect(formatAttentionFaviconCount(100)).toBe("99+");
  });

  it("draws a centered count with an orange border", () => {
    const { canvas, context, documentRef } = createCanvasDocument();

    expect(createAttentionFaviconDataUrl(12, documentRef)).toBe(
      "data:image/png;base64,favicon",
    );
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(64);
    expect(context.roundRect).toHaveBeenCalledWith(4, 4, 56, 56, 11);
    expect(context.strokeStyle).toBe("#f57c21");
    expect(context.fillText).toHaveBeenCalledWith("12", 32, 33);
  });

  it("restores the static favicon when attention clears", () => {
    const { link, values } = createFaviconLink({
      href: "/favicon-32x32.png",
      sizes: "32x32",
      type: "image/png",
    });
    const { documentRef } = createCanvasDocument([link]);

    updateAttentionFavicon(3, documentRef);
    expect(values.get("href")).toBe("data:image/png;base64,favicon");
    expect(values.get("sizes")).toBe("64x64");

    restoreAttentionFavicon(documentRef);
    expect(values.get("href")).toBe("/favicon-32x32.png");
    expect(values.get("sizes")).toBe("32x32");
    expect(values.get("type")).toBe("image/png");
  });
});
