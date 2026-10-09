import { cursorModelFamilies } from "@shared/cursor-models";
import { describe, expect, it } from "vitest";
import {
  formatCursorDisplayLabel,
  formatCursorFamilyLabel,
  formatCursorVariantLabel,
  groupCursorModels,
  splitCursorModelId,
} from "../../scripts/cursor-model-families";

describe("splitCursorModelId", () => {
  it("strips thinking, effort, and fast suffixes from the end", () => {
    expect(splitCursorModelId("claude-fable-5-1-thinking-high")).toEqual({
      familyId: "claude-fable-5-1",
      variantTokens: ["thinking", "high"],
    });
    expect(splitCursorModelId("gpt-5.5-extra-high-fast")).toEqual({
      familyId: "gpt-5.5",
      variantTokens: ["extra-high", "fast"],
    });
    expect(splitCursorModelId("claude-4.6-sonnet-medium-thinking")).toEqual({
      familyId: "claude-4.6-sonnet",
      variantTokens: ["medium", "thinking"],
    });
  });

  it("keeps models without variant suffixes as their own family", () => {
    expect(splitCursorModelId("kimi-k2.7-code")).toEqual({
      familyId: "kimi-k2.7-code",
      variantTokens: [],
    });
    expect(splitCursorModelId("auto")).toEqual({
      familyId: "auto",
      variantTokens: [],
    });
  });
});

describe("cursor model labels", () => {
  it("turns dotted and hyphenated versions into readable family names", () => {
    expect(formatCursorFamilyLabel("claude-fable-5-1")).toBe(
      "Claude Fable 5.1",
    );
    expect(formatCursorFamilyLabel("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(formatCursorFamilyLabel("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(formatCursorFamilyLabel("glm-5.2")).toBe("GLM 5.2");
    expect(formatCursorFamilyLabel("kimi-k2.7-code")).toBe("Kimi K2.7 Code");
  });

  it("joins variant tokens for the expanded row and the trigger", () => {
    expect(formatCursorVariantLabel([])).toBe("Default");
    expect(formatCursorVariantLabel(["thinking", "xhigh"])).toBe(
      "Thinking · Extra high",
    );
    expect(
      formatCursorDisplayLabel("Claude Fable 5.1", ["thinking", "high"]),
    ).toBe("Claude Fable 5.1 · Thinking · High");
    expect(formatCursorDisplayLabel("Composer 2.5", [])).toBe("Composer 2.5");
  });
});

describe("groupCursorModels", () => {
  const modelIds = cursorModelFamilies.flatMap((family) =>
    family.variants.map((variant) => variant.value),
  );
  const families = groupCursorModels(modelIds);
  const familyById = new Map(families.map((family) => [family.id, family]));

  it("collapses the catalog into one row per family", () => {
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(families).toEqual(cursorModelFamilies);
    expect(new Set(families.map((family) => family.id)).size).toBe(
      families.length,
    );
  });

  it("keeps large variant sets under one family and leaves singletons alone", () => {
    expect(familyById.get("claude-fable-5-1")?.variants).toHaveLength(10);
    expect(familyById.get("claude-opus-4-8")?.variants).toHaveLength(20);
    expect(familyById.get("glm-5.2")?.variants).toHaveLength(2);
    expect(familyById.get("kimi-k2.7-code")?.variants).toHaveLength(1);
  });

  it("sorts variants as default, then effort, then thinking, then fast", () => {
    expect(
      familyById.get("composer-2.5")?.variants.map((variant) => variant.value),
    ).toEqual(["composer-2.5", "composer-2.5-fast"]);
    expect(
      familyById
        .get("claude-fable-5-1")
        ?.variants.map((variant) => variant.variantLabel),
    ).toEqual([
      "Max",
      "Extra high",
      "High",
      "Medium",
      "Low",
      "Thinking · Max",
      "Thinking · Extra high",
      "Thinking · High",
      "Thinking · Medium",
      "Thinking · Low",
    ]);
  });

  it("groups raw IDs without losing variants or changing their values", () => {
    expect(
      groupCursorModels(["composer-2.5-fast", "glm-5.2-high", "composer-2.5"]),
    ).toEqual([
      {
        id: "composer-2.5",
        label: "Composer 2.5",
        variants: [
          {
            value: "composer-2.5",
            variantLabel: "Default",
            displayLabel: "Composer 2.5",
          },
          {
            value: "composer-2.5-fast",
            variantLabel: "Fast",
            displayLabel: "Composer 2.5 · Fast",
          },
        ],
      },
      {
        id: "glm-5.2",
        label: "GLM 5.2",
        variants: [
          {
            value: "glm-5.2-high",
            variantLabel: "High",
            displayLabel: "GLM 5.2 · High",
          },
        ],
      },
    ]);
  });
});
