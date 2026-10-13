import { normalizeWhitespace } from "./parsers/text";
import type { SessionMemoryDb } from "./store/database";
import { type ConversationRecord, getOpeningUserTexts } from "./store/queries";

export const DISPLAY_TITLE_CHARS = 140;
/** Enough opening text for a display title after whitespace is collapsed. */
export const DISPLAY_TITLE_SOURCE_CHARS = DISPLAY_TITLE_CHARS * 3;

export function excerpt(text: string, maxChars: number): string {
  const collapsed = normalizeWhitespace(text);
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  const cut = collapsed.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function formatDisplayTitle(
  title: string | null,
  openingUserText: string | null | undefined,
): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return excerpt(trimmed, DISPLAY_TITLE_CHARS);
  }
  return openingUserText
    ? `“${excerpt(openingUserText, DISPLAY_TITLE_CHARS)}”`
    : "(untitled)";
}

export async function loadDisplayTitles(
  db: SessionMemoryDb,
  conversations: Array<Pick<ConversationRecord, "id" | "title">>,
): Promise<Map<number, string>> {
  const untitled = conversations
    .filter((conversation) => !conversation.title?.trim())
    .map((conversation) => conversation.id);
  const opening = await getOpeningUserTexts(
    db,
    untitled,
    DISPLAY_TITLE_SOURCE_CHARS,
  );
  return new Map(
    conversations.map((conversation) => [
      conversation.id,
      formatDisplayTitle(conversation.title, opening.get(conversation.id)),
    ]),
  );
}
