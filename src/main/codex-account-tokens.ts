import { z } from "zod";

export const CODEX_TOKEN_FALLBACK_LIFETIME_MS = 8 * 24 * 60 * 60_000;

const accessTokenClaimsSchema = z.object({
  exp: z.number().optional(),
  "https://api.openai.com/auth": z
    .object({
      chatgpt_account_id: z.string().optional(),
      chatgpt_plan_type: z.string().optional(),
    })
    .optional(),
  "https://api.openai.com/profile": z
    .object({
      email: z.string().optional(),
    })
    .optional(),
});

export interface CodexTokenClaims {
  chatgptAccountId?: string;
  planType?: string;
  email?: string;
  expiresAt?: number;
}

export function decodeCodexTokenClaims(token: string): CodexTokenClaims | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const parsed = accessTokenClaimsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const auth = parsed.data["https://api.openai.com/auth"];
  const profile = parsed.data["https://api.openai.com/profile"];
  return {
    chatgptAccountId: auth?.chatgpt_account_id,
    planType: auth?.chatgpt_plan_type,
    email: profile?.email,
    expiresAt: parsed.data.exp != null ? parsed.data.exp * 1_000 : undefined,
  };
}
