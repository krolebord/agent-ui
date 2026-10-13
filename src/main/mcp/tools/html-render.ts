import {
  HTML_PREVIEW_TOOL_NAME,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_TOOL_NAME,
  VISUAL_LAYOUT_GUIDE,
  VISUAL_THEME_GUIDE,
} from "@shared/visuals";
import { z } from "zod";
import { buildVisualPage } from "../../visuals/build-visual-page";
import { defineMcpTool, errorResult, textResult } from "../define-tool";
import {
  knownPageErrorResult,
  PAGE_RULES,
  PAGE_SOURCE,
  pageInputShape,
  readPageSource,
} from "./html-page";

export const htmlRenderTool = defineMcpTool({
  name: HTML_RENDER_TOOL_NAME,
  description: `Use this when a chart, table, diagram, image collage, or mockup would say more than prose: build a self-contained HTML page, check it with ${HTML_PREVIEW_TOOL_NAME} when that tool is available, then publish it here before your final reply. The page appears on Agent UI's Artifacts page, where the user previews it, and the user is notified. Your reply should not describe the page or restate it; add only what the page doesn't say. ${PAGE_SOURCE} ${PAGE_RULES} ${VISUAL_LAYOUT_GUIDE} ${VISUAL_THEME_GUIDE}`,
  inputSchema: {
    ...pageInputShape,
    title: z
      .string()
      .trim()
      .min(1)
      .max(HTML_RENDER_MAX_TITLE_LENGTH)
      .describe("Short name for the page."),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional one-line description of the page"),
  },
  annotations: {
    title: "Render HTML",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (input, services, context) => {
    if (!context.sessionId) {
      return errorResult(
        "Publishing HTML pages requires a managed Agent UI session",
      );
    }
    try {
      const page = await buildVisualPage(
        await readPageSource(input, context.cwd),
      );
      if (page.missingImages.length > 0) {
        return errorResult(
          `These local images could not be read: ${page.missingImages.join(", ")}. Use absolute paths to existing image files, or remove them.`,
        );
      }
      const artifact = await services.artifactsService.publishVisual({
        sessionId: context.sessionId,
        html: page.html,
        title: input.title,
        description: input.description,
      });
      return textResult(
        JSON.stringify({
          artifactId: artifact.id,
          name: artifact.name,
          message:
            "Published to Agent UI. The user has been notified and can open it from the Artifacts page. Don't describe the page or restate it in your reply; add only what it doesn't already say.",
        }),
      );
    } catch (error) {
      const result = knownPageErrorResult(error);
      if (result) return result;
      throw error;
    }
  },
});
