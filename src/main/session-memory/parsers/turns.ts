import type { ParsedTurn } from "./types";

const MAX_COMMAND_CHARS = 300;

export interface TurnPosition {
  startedAtMs: number | null;
  line: number | null;
  eventId: string | null;
}

interface DraftTurn {
  position: TurnPosition;
  userText: string;
  assistantParts: string[];
  filePaths: Set<string>;
  commands: Set<string>;
}

/** Groups events into turns: each real user message opens one. */
export class TurnCollector {
  private readonly drafts: DraftTurn[] = [];
  private current: DraftTurn | null = null;

  startTurn(userText: string, position: TurnPosition): void {
    this.open(userText, position);
  }

  addAssistantText(text: string, position: TurnPosition): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      this.ensureTurn(position).assistantParts.push(trimmed);
    }
  }

  addFilePath(filePath: string | null, position: TurnPosition): void {
    const trimmed = filePath?.trim();
    if (trimmed) {
      this.ensureTurn(position).filePaths.add(trimmed);
    }
  }

  addCommand(command: string | null, position: TurnPosition): void {
    const trimmed = command?.trim();
    if (trimmed) {
      this.ensureTurn(position).commands.add(
        trimmed.slice(0, MAX_COMMAND_CHARS),
      );
    }
  }

  dropLastTurns(count: number): void {
    if (count <= 0) {
      return;
    }
    this.drafts.splice(Math.max(0, this.drafts.length - count));
    this.current = this.drafts.at(-1) ?? null;
  }

  finish(): ParsedTurn[] {
    const turns: ParsedTurn[] = [];
    for (const draft of this.drafts) {
      const userText = draft.userText.trim();
      const assistantText = draft.assistantParts.join("\n\n");
      if (userText.length === 0 && assistantText.length === 0) {
        continue;
      }
      turns.push({
        ordinal: turns.length,
        startedAtMs: draft.position.startedAtMs,
        userText,
        assistantText,
        filePaths: [...draft.filePaths],
        commands: [...draft.commands],
        sourceRef: {
          line: draft.position.line,
          eventId: draft.position.eventId,
        },
      });
    }
    return turns;
  }

  private open(userText: string, position: TurnPosition): DraftTurn {
    const draft: DraftTurn = {
      position,
      userText,
      assistantParts: [],
      filePaths: new Set(),
      commands: new Set(),
    };
    this.drafts.push(draft);
    this.current = draft;
    return draft;
  }

  private ensureTurn(position: TurnPosition): DraftTurn {
    return this.current ?? this.open("", position);
  }
}
