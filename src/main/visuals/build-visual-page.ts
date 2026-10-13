import { injectVisualBootstrap } from "@shared/visuals";
import { inlineLocalImages } from "./prepare-visual";

const DOCTYPE_PATTERN = /^\s*<!doctype\s/i;

export async function buildVisualPage(
  html: string,
  limits?: Parameters<typeof inlineLocalImages>[1],
): Promise<{ html: string; missingImages: string[] }> {
  // Without a doctype the page renders in quirks mode, where the root is at
  // least as tall as the viewport.
  const document = DOCTYPE_PATTERN.test(html) ? html : `<!doctype html>${html}`;
  return await inlineLocalImages(injectVisualBootstrap(document), limits);
}
