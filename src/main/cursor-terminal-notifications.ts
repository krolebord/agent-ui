const OSC_99_PREFIX = "\u001b]99;";
const MAX_BUFFER_SIZE = 16 * 1024;

export interface CursorTerminalNotification {
  kind: "title" | "body" | "unknown";
  message: string;
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function parseNotification(
  sequence: string,
): CursorTerminalNotification | null {
  const separatorIndex = sequence.lastIndexOf(";");
  if (separatorIndex < 0) {
    return null;
  }

  const params = sequence.slice(0, separatorIndex);
  const message = decodeBase64(sequence.slice(separatorIndex + 1));
  if (message === null) {
    return null;
  }

  const kind = params.includes("p=title")
    ? "title"
    : params.includes("p=body")
      ? "body"
      : "unknown";
  return { kind, message };
}

export class CursorTerminalNotificationParser {
  private buffer = "";

  push(chunk: string): CursorTerminalNotification[] {
    this.buffer += chunk;
    const notifications: CursorTerminalNotification[] = [];

    while (true) {
      const startIndex = this.buffer.indexOf(OSC_99_PREFIX);
      if (startIndex < 0) {
        this.buffer = this.buffer.slice(-(OSC_99_PREFIX.length - 1));
        break;
      }

      if (startIndex > 0) {
        this.buffer = this.buffer.slice(startIndex);
      }

      const contentStart = OSC_99_PREFIX.length;
      const bellIndex = this.buffer.indexOf("\u0007", contentStart);
      const stringTerminatorIndex = this.buffer.indexOf(
        "\u001b\\",
        contentStart,
      );
      const terminatorIndex =
        bellIndex < 0
          ? stringTerminatorIndex
          : stringTerminatorIndex < 0
            ? bellIndex
            : Math.min(bellIndex, stringTerminatorIndex);
      if (terminatorIndex < 0) {
        if (this.buffer.length > MAX_BUFFER_SIZE) {
          this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
        }
        break;
      }

      const notification = parseNotification(
        this.buffer.slice(contentStart, terminatorIndex),
      );
      if (notification) {
        notifications.push(notification);
      }

      const terminatorLength =
        this.buffer[terminatorIndex] === "\u0007" ? 1 : 2;
      this.buffer = this.buffer.slice(terminatorIndex + terminatorLength);
    }

    return notifications;
  }
}

export function isCursorApprovalNotification(
  notification: CursorTerminalNotification,
): boolean {
  if (notification.kind !== "body") {
    return false;
  }

  return (
    notification.message === "Cursor needs your input" ||
    notification.message.startsWith("Approve command:")
  );
}
