import { describe, expect, it } from "vitest";
import {
  deriveProvisionalTitleFromPrompt,
  isAutoManagedSessionTitle,
  provisionalSessionTitleMaxLength,
} from "../../../src/shared/title-generation";

describe("deriveProvisionalTitleFromPrompt", () => {
  it("returns trimmed prompt when within max length", () => {
    expect(deriveProvisionalTitleFromPrompt("  Hello world  ")).toBe(
      "Hello world",
    );
  });

  it("truncates long prompts with ellipsis", () => {
    const prompt = "a".repeat(provisionalSessionTitleMaxLength + 1);
    expect(deriveProvisionalTitleFromPrompt(prompt)).toBe(
      `${"a".repeat(provisionalSessionTitleMaxLength)}...`,
    );
  });

  it("does not add ellipsis when prompt is exactly max length", () => {
    const prompt = "a".repeat(provisionalSessionTitleMaxLength);
    expect(deriveProvisionalTitleFromPrompt(prompt)).toBe(prompt);
  });

  it("returns null for empty prompts", () => {
    expect(deriveProvisionalTitleFromPrompt("   ")).toBeNull();
  });
});

describe("isAutoManagedSessionTitle", () => {
  const defaultTitle = "Codex Session";

  it("returns true for the default title", () => {
    expect(isAutoManagedSessionTitle(defaultTitle, defaultTitle, "Hello")).toBe(
      true,
    );
  });

  it("returns true for the provisional title derived from the prompt", () => {
    expect(
      isAutoManagedSessionTitle("Hello world", defaultTitle, "Hello world"),
    ).toBe(true);
  });

  it("returns false for manually renamed titles", () => {
    expect(
      isAutoManagedSessionTitle("Custom name", defaultTitle, "Hello world"),
    ).toBe(false);
  });

  it("returns true while a prior provisional title is still showing", () => {
    expect(
      isAutoManagedSessionTitle(
        "Earlier prompt text",
        defaultTitle,
        "Different prompt",
        "Earlier prompt text",
      ),
    ).toBe(true);
  });
});
