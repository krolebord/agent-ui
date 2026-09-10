import { readFileSync, writeFileSync } from "node:fs";
import { groupCursorModels } from "./cursor-model-families.ts";

const target = process.argv[2];
if (!target) {
  throw new Error("Expected the output file path");
}
const models = [
  ...new Set(readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean)),
];
if (
  models.length === 0 ||
  models.some((model) => !/^[a-z0-9][a-z0-9.-]*$/.test(model))
) {
  throw new Error("Expected one Cursor model ID per line");
}
const families = groupCursorModels(models);
writeFileSync(
  target,
  `import type { CursorModelFamily } from "./cursor-model-types";

export const cursorModelFamilies: CursorModelFamily[] = ${JSON.stringify(families, null, 2)};
`,
);
