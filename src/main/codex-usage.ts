import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import spawn from "nano-spawn";
import * as z from "zod";
import log from "./logger";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_KEYCHAIN_SERVICE = "Codex Auth";

const codexAuthSchema = z.object({
  OPENAI_API_KEY: z.string().nullable().optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    id_token: z.string().optional(),
    account_id: z.string().optional(),
  }),
  last_refresh: z.string().optional(),
});

const usageWindowSchema = z.object({
  used_percent: z.number(),
  reset_at: z.number(),
  limit_window_seconds: z.number(),
});

const usageRateLimitSchema = z.object({
  allowed: z.boolean().optional(),
  limit_reached: z.boolean().optional(),
  primary_window: usageWindowSchema.nullable(),
  secondary_window: usageWindowSchema.nullable().optional(),
});

const creditsBalanceSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }
  return Number(trimmed);
}, z.number().finite());

const codexUsageResponseSchema = z.object({
  plan_type: z.string().nullable().optional(),
  rate_limit: usageRateLimitSchema,
  code_review_rate_limit: usageRateLimitSchema.nullable().optional(),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: creditsBalanceSchema,
    })
    .nullable()
    .optional(),
});

const codexUsageWindowSchema = z.object({
  utilization: z.number(),
  resetsAt: z.string().nullable(),
  windowSeconds: z.number(),
});

const codexUsageDataSchema = z.object({
  planType: z.string().nullable().optional(),
  primaryWindow: codexUsageWindowSchema.nullable(),
  secondaryWindow: codexUsageWindowSchema.nullable(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.number(),
    })
    .optional(),
});

export type CodexUsageData = z.infer<typeof codexUsageDataSchema>;

function toIsoDate(unixSeconds: number): string | null {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function normalizeUsageWindow(
  window: z.infer<typeof usageWindowSchema> | null | undefined,
): z.infer<typeof codexUsageWindowSchema> | null {
  if (!window) {
    return null;
  }

  return {
    utilization: window.used_percent,
    resetsAt: toIsoDate(window.reset_at),
    windowSeconds: window.limit_window_seconds,
  };
}

async function readCodexAuthFromFile(
  filePath: string,
): Promise<string | undefined> {
  try {
    const value = await readFile(filePath, "utf8");
    const trimmed = value.trim();
    return trimmed || undefined;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    log.warn("CodexUsage: failed reading auth file", {
      filePath,
      message: err.message,
      code: err.code,
    });
    return undefined;
  }
}

async function readCodexAuthFromKeychain(): Promise<string | undefined> {
  try {
    const { output } = await spawn(
      "security",
      ["find-generic-password", "-s", CODEX_KEYCHAIN_SERVICE, "-w"],
      { timeout: 5_000, stdin: "ignore" },
    );
    const trimmed = output.trim();
    return trimmed || undefined;
  } catch (error) {
    const err = error as { message?: string; exitCode?: number };
    log.warn("CodexUsage: failed reading keychain credentials", {
      message: err.message,
      exitCode: err.exitCode,
    });
    return undefined;
  }
}

async function readCodexAuthPayload(): Promise<
  { source: string; rawJson: string } | undefined
> {
  const codeHome = process.env.CODEX_HOME?.trim();
  const candidates: string[] = [];

  if (codeHome && codeHome !== "undefined") {
    candidates.push(path.join(codeHome, "auth.json"));
  }

  const homeDir = homedir();
  candidates.push(path.join(homeDir, ".config", "codex", "auth.json"));
  candidates.push(path.join(homeDir, ".codex", "auth.json"));

  for (const filePath of candidates) {
    const raw = await readCodexAuthFromFile(filePath);
    if (!raw) {
      continue;
    }
    return { source: filePath, rawJson: raw };
  }

  const keychainRaw = await readCodexAuthFromKeychain();
  if (keychainRaw) {
    return {
      source: `keychain:${CODEX_KEYCHAIN_SERVICE}`,
      rawJson: keychainRaw,
    };
  }

  return undefined;
}

function normalizeCodexUsage(
  usage: z.infer<typeof codexUsageResponseSchema>,
): CodexUsageData {
  const primaryWindow =
    usage.rate_limit.primary_window ??
    usage.code_review_rate_limit?.primary_window;
  const secondaryWindow =
    usage.rate_limit.secondary_window ??
    usage.code_review_rate_limit?.secondary_window;

  return {
    planType: usage.plan_type,
    primaryWindow: normalizeUsageWindow(primaryWindow),
    secondaryWindow: normalizeUsageWindow(secondaryWindow),
    credits: usage.credits
      ? {
          hasCredits: usage.credits.has_credits,
          unlimited: usage.credits.unlimited,
          balance: usage.credits.balance,
        }
      : undefined,
  };
}

export async function getCodexUsage() {
  const authPayload = await readCodexAuthPayload();
  if (!authPayload) {
    return { ok: false, message: "Codex auth credentials were not found" };
  }

  let parsedAuth: unknown;
  try {
    parsedAuth = JSON.parse(authPayload.rawJson);
  } catch {
    log.error("CodexUsage: auth payload is not valid JSON", {
      source: authPayload.source,
    });
    return { ok: false, message: "Codex auth credentials are not valid JSON" };
  }

  const authResult = codexAuthSchema.safeParse(parsedAuth);
  if (!authResult.success) {
    log.error("CodexUsage: auth payload schema validation failed", {
      source: authPayload.source,
      issues: authResult.error.issues,
    });
    return {
      ok: false,
      message: "Codex auth credentials have unexpected format",
    };
  }

  const accessToken = authResult.data.tokens.access_token;
  const accountId = authResult.data.tokens.account_id;

  let responseJson: unknown;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (accountId?.trim()) {
      headers["ChatGPT-Account-Id"] = accountId.trim();
    }

    const response = await fetch(CODEX_USAGE_URL, { headers });
    if (!response.ok) {
      log.error("CodexUsage: API request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return {
        ok: false,
        message: `Codex usage API returned ${response.status} ${response.statusText}`,
      };
    }

    responseJson = await response.json();
  } catch (error) {
    const err = error as { message?: string };
    log.error("CodexUsage: request failed", { message: err.message });
    return { ok: false, message: "Failed to fetch Codex usage data" };
  }

  const usageResult = codexUsageResponseSchema.safeParse(responseJson);
  if (!usageResult.success) {
    log.error("CodexUsage: response schema validation failed", {
      issues: usageResult.error.issues,
      responseJson,
    });
    return {
      ok: false,
      message: "Codex usage response has unexpected format",
    };
  }

  const usage = normalizeCodexUsage(usageResult.data);
  codexUsageDataSchema.parse(usage);

  return { ok: true, usage };
}
