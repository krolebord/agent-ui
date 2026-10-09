import { describe, expect, it } from "vitest";
import {
  defaultTitleGenerationSettings,
  titleGenerationSettingsSchema,
} from "../../src/shared/title-generation";

describe("titleGenerationSettingsSchema", () => {
  it("defaults to Codex Luna", () => {
    expect(titleGenerationSettingsSchema.parse(undefined)).toEqual(
      defaultTitleGenerationSettings,
    );
  });

  it("preserves Cursor as a selectable provider", () => {
    expect(
      titleGenerationSettingsSchema.parse({
        provider: "cursor",
        model: "composer-2.5",
      }),
    ).toEqual({ provider: "cursor", model: "composer-2.5" });
  });

  it.each(["gpt-6-luna", "gpt-6.1-sol", "future-model"])(
    "preserves the selected Codex model %s",
    (model) => {
      expect(
        titleGenerationSettingsSchema.parse({ provider: "codex", model }),
      ).toEqual({ provider: "codex", model });
    },
  );

  it("trims the selected Codex model", () => {
    expect(
      titleGenerationSettingsSchema.parse({
        provider: "codex",
        model: " gpt-6-luna ",
      }),
    ).toEqual({ provider: "codex", model: "gpt-6-luna" });
  });

  it.each([undefined, null, 123, "", "   "])(
    "falls back to the default for invalid Codex model %s",
    (model) => {
      expect(
        titleGenerationSettingsSchema.parse({ provider: "codex", model }),
      ).toEqual(defaultTitleGenerationSettings);
    },
  );
});
