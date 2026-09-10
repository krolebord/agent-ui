import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface McpRequestContext {
  sessionId?: string | null;
  cwd: string | null;
  canScheduleSessions: boolean;
}

const payloadSchema = z.object({
  sessionId: z.string().nullable().optional(),
  cwd: z.string().nullable(),
  canScheduleSessions: z.boolean(),
});

export class McpSessionTokens {
  private readonly secret = randomBytes(32);

  sign(context: McpRequestContext): string {
    const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }

  verify(token: string | null | undefined): McpRequestContext | null {
    if (!token) return null;
    const separator = token.lastIndexOf(".");
    if (separator === -1) return null;
    const payload = token.slice(0, separator);
    const mac = Buffer.from(token.slice(separator + 1), "base64url");
    const expected = Buffer.from(this.mac(payload), "base64url");
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
      return null;
    }
    try {
      return payloadSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }
}
