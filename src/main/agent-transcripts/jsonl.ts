import { createReadStream } from "node:fs";
import readline from "node:readline";

/**
 * Streams a file line by line; `visit` returning false stops early. Line
 * numbers are 1-based; I/O errors reject.
 */
export async function forEachLine(
  filePath: string,
  visit: (line: string, lineNumber: number) => unknown,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (visit(line, lineNumber) === false) {
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
