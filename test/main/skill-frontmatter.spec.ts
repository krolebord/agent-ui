import { describe, expect, it } from "vitest";
import {
  getBoolean,
  getScalar,
  parseSkillMd,
  serializeSkillMd,
} from "../../src/main/skill-frontmatter";

describe("parseSkillMd", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseSkillMd(`---
name: my-skill
description: Does things. Use when asked.
disable-model-invocation: true
---

Body line one.
`);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(getScalar(parsed, "name")).toBe("my-skill");
    expect(getScalar(parsed, "description")).toBe(
      "Does things. Use when asked.",
    );
    expect(getBoolean(parsed, "disable-model-invocation")).toBe(true);
    expect(parsed.body).toBe("Body line one.\n");
  });

  it("handles files without frontmatter", () => {
    const parsed = parseSkillMd("Just a body\n");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe("Just a body\n");
    expect(getScalar(parsed, "name")).toBeNull();
  });

  it("unquotes quoted values", () => {
    const parsed = parseSkillMd(`---
description: "Handles: colons, and #hashes"
other: 'single ''quoted'''
---
`);
    expect(getScalar(parsed, "description")).toBe(
      "Handles: colons, and #hashes",
    );
    expect(getScalar(parsed, "other")).toBe("single 'quoted'");
  });

  it("joins folded block scalars", () => {
    const parsed = parseSkillMd(`---
description: >-
  A long description
  spanning lines
name: x
---
`);
    expect(getScalar(parsed, "description")).toBe(
      "A long description spanning lines",
    );
    expect(getScalar(parsed, "name")).toBe("x");
  });
});

describe("serializeSkillMd", () => {
  it("round-trips unknown keys while updating known ones", () => {
    const parsed = parseSkillMd(`---
name: my-skill
description: Old description
license: MIT
allowed-tools: Bash(git:*)
---

Old body
`);
    const result = serializeSkillMd(
      parsed,
      { description: "New description", "disable-model-invocation": true },
      "New body\n",
    );
    expect(result).toBe(`---
name: my-skill
description: New description
license: MIT
allowed-tools: Bash(git:*)
disable-model-invocation: true
---

New body
`);
  });

  it("removes keys set to null", () => {
    const parsed = parseSkillMd(`---
name: a
disable-model-invocation: true
---
body
`);
    const result = serializeSkillMd(
      parsed,
      { "disable-model-invocation": null },
      "body\n",
    );
    expect(result).not.toContain("disable-model-invocation");
    expect(result).toContain("name: a");
  });

  it("builds a document from scratch", () => {
    const result = serializeSkillMd(
      parseSkillMd(""),
      {
        name: "fresh",
        description: "Plain description",
        "managed-by": "agent-ui",
      },
      "Instructions.",
    );
    expect(result).toBe(`---
name: fresh
description: Plain description
managed-by: agent-ui
---

Instructions.
`);
  });

  it("quotes values that need quoting", () => {
    const result = serializeSkillMd(
      parseSkillMd(""),
      { description: "Use when: things happen" },
      "",
    );
    expect(result).toContain(`description: "Use when: things happen"`);
    const reparsed = parseSkillMd(result);
    expect(getScalar(reparsed, "description")).toBe("Use when: things happen");
  });
});
