import {
  HTML_PREVIEW_DEFAULT_WIDTH,
  HTML_PREVIEW_MAX_WIDTH,
  HTML_PREVIEW_MIN_WIDTH,
  HTML_PREVIEW_TOOL_NAME,
  HTML_RENDER_TOOL_NAME,
} from "@shared/visuals";
import { z } from "zod";
import { buildVisualPage } from "../../visuals/build-visual-page";
import { defineMcpTool } from "../define-tool";
import {
  knownPageErrorResult,
  PAGE_RULES,
  PAGE_SOURCE,
  pageInputShape,
  readPageSource,
} from "./html-page";

export const htmlPreviewTool = defineMcpTool({
  name: HTML_PREVIEW_TOOL_NAME,
  description: `Render an HTML page in Agent UI's headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), its console output (log, info, warning, error), and uncaught errors with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before ${HTML_RENDER_TOOL_NAME}. ${PAGE_SOURCE} ${PAGE_RULES} The page gets the theme variables and layout described in ${HTML_RENDER_TOOL_NAME}.`,
  inputSchema: {
    ...pageInputShape,
    width: z
      .number()
      .int()
      .optional()
      .describe(
        `Viewport width in CSS pixels, ${HTML_PREVIEW_MIN_WIDTH}-${HTML_PREVIEW_MAX_WIDTH}. Defaults to ${HTML_PREVIEW_DEFAULT_WIDTH}; use about 390 to check phones.`,
      ),
  },
  annotations: {
    title: "Preview HTML",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  isAvailable: (services) => !services.agentBrowser.isUnavailable,
  handler: async (input, services, context) => {
    const width = Math.min(
      HTML_PREVIEW_MAX_WIDTH,
      Math.max(
        HTML_PREVIEW_MIN_WIDTH,
        input.width ?? HTML_PREVIEW_DEFAULT_WIDTH,
      ),
    );
    try {
      const page = await buildVisualPage(
        await readPageSource(input, context.cwd),
      );
      const { screenshotBase64, ...preview } =
        await services.htmlPreviewer.preview({ html: page.html, width });
      return {
        content: [
          { type: "image", data: screenshotBase64, mimeType: "image/png" },
          {
            type: "text",
            text: JSON.stringify({
              width: preview.width,
              contentHeight: preview.contentHeight,
              capturedHeight: preview.capturedHeight,
              consoleMessages: preview.consoleMessages,
              errors: preview.errors,
              ...(page.missingImages.length > 0
                ? { missingImages: page.missingImages }
                : {}),
              screenshotPath: preview.screenshotPath,
            }),
          },
        ],
      };
    } catch (error) {
      const result = knownPageErrorResult(error);
      if (result) return result;
      throw error;
    }
  },
});
