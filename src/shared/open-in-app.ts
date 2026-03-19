import { z } from "zod";

export const openInAppTargetSchema = z.enum([
  "cursor",
  "finder",
  "github-desktop",
  "terminal",
]);

export type OpenInAppTarget = z.infer<typeof openInAppTargetSchema>;

export const openInAppTargetLabels: Record<OpenInAppTarget, string> = {
  cursor: "Cursor",
  finder: "Finder",
  "github-desktop": "GitHub Desktop",
  terminal: "Terminal",
};
