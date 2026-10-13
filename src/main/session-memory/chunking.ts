import { createHash } from "node:crypto";
import {
  DEFAULT_EMBEDDING_MAX_TOKENS,
  formatDocumentPrompt,
} from "./embedding/embedder";

export const CHUNKER_VERSION = 1;

export interface ChunkerOptions {
  /** Hard limit for a whole document prompt, BOS and EOS included. */
  maxTokens: number;
  /** Chunks kept from the start of an oversized turn; its last chunk is always kept too. */
  maxHeadChunks: number;
  userPrefixChars: number;
  /** Headroom for label tokens and estimate error when packing. */
  reserveTokens: number;
  maxSplitDepth: number;
}

export const defaultChunkerOptions: ChunkerOptions = {
  maxTokens: DEFAULT_EMBEDDING_MAX_TOKENS,
  maxHeadChunks: 4,
  userPrefixChars: 200,
  reserveTokens: 40,
  maxSplitDepth: 4,
};

export interface TurnChunkInput {
  title: string | null;
  userText: string;
  assistantText: string;
}

export interface PlannedChunk {
  index: number;
  text: string;
  tokenCount: number;
  embedHash: string;
}

export type CountTokens = (texts: string[]) => Promise<number[]>;

type Role = "user" | "assistant";

interface Segment {
  /** Position in the whole turn, used to tell continuation chunks apart. */
  index: number;
  role: Role;
  text: string;
  /** Joins this segment to the previous one when both land in one chunk. */
  sep: string;
  firstOfRole: boolean;
  tokens: number;
}

const ROLE_LABELS: Record<Role, string> = {
  user: "User",
  assistant: "Assistant",
};

export function embedHash(title: string | null, text: string): string {
  return createHash("sha256")
    .update(formatDocumentPrompt({ title, text }))
    .digest("hex");
}

export function renderTurnText(userText: string, assistantText: string) {
  const parts: string[] = [];
  if (userText.trim()) parts.push(`User: ${userText.trim()}`);
  if (assistantText.trim()) parts.push(`Assistant: ${assistantText.trim()}`);
  return parts.join("\n\n");
}

export function userTextPrefix(userText: string, maxChars: number): string {
  const collapsed = userText.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const cut = collapsed.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const space = rest.lastIndexOf(" ", maxChars);
    if (space > maxChars * 0.8) cut = space + 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function splitParagraph(
  paragraph: string,
  maxTokens: number,
  tokensPerChar: number,
): Array<{ text: string; sep: string }> {
  const estimate = (text: string) => Math.ceil(text.length * tokensPerChar);
  if (estimate(paragraph) <= maxTokens) return [{ text: paragraph, sep: "" }];
  const maxChars = Math.max(1, Math.floor(maxTokens / tokensPerChar));
  const pieces: Array<{ text: string; sep: string }> = [];
  let current = "";
  const flush = () => {
    if (current) pieces.push({ text: current, sep: "\n" });
    current = "";
  };
  for (const line of paragraph.split("\n")) {
    if (estimate(line) > maxTokens) {
      flush();
      hardSplit(line, maxChars).forEach((text, index) => {
        pieces.push({ text, sep: index === 0 ? "\n" : "" });
      });
    } else if (current && estimate(`${current}\n${line}`) > maxTokens) {
      flush();
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  flush();
  return pieces;
}

function segmentTurn(
  input: TurnChunkInput,
  maxSegmentTokens: number,
  tokensPerChar: number,
): Segment[] {
  const segments: Segment[] = [];
  for (const role of ["user", "assistant"] as const) {
    const text = (
      role === "user" ? input.userText : input.assistantText
    ).trim();
    if (!text) continue;
    let firstOfRole = true;
    for (const paragraph of text.split(/\n[ \t]*\n\s*/)) {
      if (!paragraph.trim()) continue;
      for (const [pieceIndex, piece] of splitParagraph(
        paragraph,
        maxSegmentTokens,
        tokensPerChar,
      ).entries()) {
        segments.push({
          index: segments.length,
          role,
          text: piece.text,
          sep: pieceIndex === 0 ? "\n\n" : piece.sep,
          firstOfRole,
          tokens: Math.ceil(piece.text.length * tokensPerChar),
        });
        firstOfRole = false;
      }
    }
  }
  return segments;
}

function renderChunk(segments: Segment[], userPrefix: string | null): string {
  const parts: string[] = [];
  if (userPrefix && segments[0] && segments[0].index > 0) {
    parts.push(`User: ${userPrefix}`);
  }
  let group: { label: string; text: string } | null = null;
  let role: Role | null = null;
  for (const segment of segments) {
    if (group && segment.role === role) {
      group.text += segment.sep + segment.text;
      continue;
    }
    if (group) parts.push(`${group.label}: ${group.text}`);
    role = segment.role;
    group = {
      label: segment.firstOfRole
        ? ROLE_LABELS[segment.role]
        : `${ROLE_LABELS[segment.role]} (continued)`,
      text: segment.text,
    };
  }
  if (group) parts.push(`${group.label}: ${group.text}`);
  return parts.join("\n\n");
}

/**
 * Greedy packing toward an even split: each chunk aims at the tokens still
 * left divided by the chunks still planned, and never exceeds `budget`.
 */
function packSegments(segments: Segment[], budget: number): Segment[][] {
  let remaining = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  let chunksLeft = Math.max(1, Math.ceil(remaining / budget));
  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let currentTokens = 0;
  for (const segment of segments) {
    const target = remaining / chunksLeft;
    const withSegment = currentTokens + segment.tokens;
    if (
      current.length > 0 &&
      (withSegment > budget ||
        (chunksLeft > 1 &&
          Math.abs(withSegment - target) > Math.abs(currentTokens - target)))
    ) {
      chunks.push(current);
      remaining -= currentTokens;
      chunksLeft = Math.max(1, chunksLeft - 1);
      current = [];
      currentTokens = 0;
    }
    current.push(segment);
    currentTokens += segment.tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function halve(segments: Segment[]): [Segment[], Segment[]] | null {
  if (segments.length > 1) {
    const total = segments.reduce((sum, segment) => sum + segment.tokens, 0);
    let running = 0;
    let cut = 1;
    for (; cut < segments.length - 1; cut++) {
      running += segments[cut - 1].tokens;
      if (running >= total / 2) break;
    }
    return [segments.slice(0, cut), segments.slice(cut)];
  }
  const [segment] = segments;
  if (!segment || segment.text.length < 2) return null;
  const [head, ...rest] = hardSplit(
    segment.text,
    Math.ceil(segment.text.length / 2),
  );
  const tail = rest.join("");
  if (!tail) return null;
  const share = (text: string) =>
    Math.ceil((segment.tokens * text.length) / segment.text.length);
  return [
    [{ ...segment, text: head, tokens: share(head) }],
    [
      {
        ...segment,
        index: segment.index + 0.5,
        text: tail,
        sep: "",
        firstOfRole: false,
        tokens: share(tail),
      },
    ],
  ];
}

function capChunks<T>(chunks: T[], maxHeadChunks: number): T[] {
  if (chunks.length <= maxHeadChunks + 1) return chunks;
  return [...chunks.slice(0, maxHeadChunks), chunks[chunks.length - 1]];
}

/**
 * One chunk per turn when the whole prompt fits `maxTokens`. Larger turns are
 * split on paragraph, then line, then character boundaries into balanced
 * chunks; continuation chunks repeat the start of the user text, and only the
 * first `maxHeadChunks` plus the last chunk are kept.
 *
 * Token counts come from the real tokenizer: one call for the whole turn, one
 * to validate the final chunks, and one per re-split of a chunk that the
 * per-turn chars-to-tokens estimate got wrong.
 */
export async function planTurnChunks(
  input: TurnChunkInput,
  countTokens: CountTokens,
  options: ChunkerOptions = defaultChunkerOptions,
): Promise<PlannedChunk[]> {
  const { title } = input;
  const body = renderTurnText(input.userText, input.assistantText);
  if (!body) return [];

  const userPrefix = input.userText.trim()
    ? userTextPrefix(input.userText, options.userPrefixChars)
    : null;
  const [fullTokens, emptyTokens, prefixTokens] = await countTokens([
    formatDocumentPrompt({ title, text: body }),
    formatDocumentPrompt({ title, text: "" }),
    userPrefix ? `User: ${userPrefix}\n\n` : "",
  ]);
  if (fullTokens <= options.maxTokens) {
    return [
      {
        index: 0,
        text: body,
        tokenCount: fullTokens,
        embedHash: embedHash(title, body),
      },
    ];
  }

  const tokensPerChar = Math.max(
    (fullTokens - emptyTokens) / body.length,
    1 / 16,
  );
  const budget = Math.max(
    16,
    options.maxTokens -
      emptyTokens -
      (userPrefix ? prefixTokens : 0) -
      options.reserveTokens,
  );
  // Small segments let the packer balance chunks and keep a short question
  // together with the start of a long answer.
  const segments = segmentTurn(
    input,
    Math.max(8, Math.floor(budget / 4)),
    tokensPerChar,
  );
  let pending = capChunks(
    packSegments(segments, budget),
    options.maxHeadChunks,
  );

  const done = new Map<Segment[], number>();
  for (let depth = 0; depth <= options.maxSplitDepth; depth++) {
    const unchecked = pending.filter((segments) => !done.has(segments));
    if (unchecked.length === 0) break;
    const counts = await countTokens(
      unchecked.map((segments) =>
        formatDocumentPrompt({
          title,
          text: renderChunk(segments, userPrefix),
        }),
      ),
    );
    const next: Segment[][] = [];
    for (const segments of pending) {
      const checked = unchecked.indexOf(segments);
      const count = checked === -1 ? done.get(segments) : counts[checked];
      if (count === undefined) continue;
      const halves =
        count > options.maxTokens && depth < options.maxSplitDepth
          ? halve(segments)
          : null;
      if (halves) {
        next.push(...halves);
      } else {
        done.set(segments, count);
        next.push(segments);
      }
    }
    pending = capChunks(next, options.maxHeadChunks);
  }

  return pending.map((segments, index) => {
    const text = renderChunk(segments, userPrefix);
    return {
      index,
      text,
      tokenCount: done.get(segments) ?? 0,
      embedHash: embedHash(title, text),
    };
  });
}
