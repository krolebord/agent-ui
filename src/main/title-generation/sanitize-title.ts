export function sanitizeGeneratedTitle(raw: string): string | null {
  const line =
    raw
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";

  const unquoted = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  return unquoted || null;
}
