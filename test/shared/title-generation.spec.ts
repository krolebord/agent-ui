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
});
