function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockPattern(tag: string): RegExp {
  const name = escapeRegExp(tag);
  return new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g");
}

export function removeTaggedBlocks(
  text: string,
  tags: readonly string[],
): string {
  let result = text;
  for (const tag of tags) {
    if (result.includes(`<${tag}`)) {
      result = result.replace(blockPattern(tag), "");
    }
  }
  return result;
}

export function extractTagContents(text: string, tag: string): string[] {
  if (!text.includes(`<${tag}`)) {
    return [];
  }
  const name = escapeRegExp(tag);
  const pattern = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
    "g",
  );
  return Array.from(text.matchAll(pattern), (match) => match[1] ?? "");
}

export function tidyText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
