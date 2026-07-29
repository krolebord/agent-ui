import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import spawn from "nano-spawn";
import * as z from "zod";
import log from "./logger";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const CredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string(),
      expiresAt: z.number(),
    })
    .passthrough(),
});

const UsageBucketSchema = z
  .object({
    utilization: z.number(),
    resets_at: z.string().nullable(),
  })
  .nullable();

const ExtraUsageSchema = z
  .object({
    is_enabled: z.boolean(),
    monthly_limit: z.number().nullable(),
    used_credits: z.number().nullable(),
    utilization: z.number().nullable(),
  })
  .nullable();

const UsageResponseSchema = z.object({
  five_hour: UsageBucketSchema,
  seven_day: UsageBucketSchema,
  seven_day_sonnet: UsageBucketSchema,
  extra_usage: ExtraUsageSchema,
});

export type UsageData = z.infer<typeof UsageResponseSchema>;

async function readCredentialsFile(
  filePath: string,
): Promise<string | undefined> {
  try {
    const value = await readFile(filePath, "utf8");
    return value.trim() || undefined;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      log.warn("Usage: failed to read Claude credentials file", {
        filePath,
        message: err.message,
        code: err.code,
      });
    }
    return undefined;
  }
}

async function readCredentialsFromKeychain(): Promise<string | undefined> {
  try {
    const { output } = await spawn(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: 5_000, stdin: "ignore" },
    );
    return output.trim() || undefined;
  } catch (error) {
    const err = error as { message?: string; exitCode?: number };
    log.warn("Usage: failed to read credentials from keychain", {
      message: err.message,
      exitCode: err.exitCode,
    });
    return undefined;
  }
}

async function readCredentialsPayload(): Promise<
  { source: string; rawJson: string } | undefined
> {
  if (process.platform === "darwin") {
    const keychainValue = await readCredentialsFromKeychain();
    if (keychainValue) {
      return {
        source: `keychain:${CLAUDE_KEYCHAIN_SERVICE}`,
        rawJson: keychainValue,
      };
    }
  }

  const configuredDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir =
    configuredDir && configuredDir !== "undefined"
      ? configuredDir
      : path.join(homedir(), ".claude");
  const filePath = path.join(configDir, ".credentials.json");
  const fileValue = await readCredentialsFile(filePath);
  if (fileValue) {
    return { source: filePath, rawJson: fileValue };
  }

  return undefined;
}

function expiresAtMilliseconds(expiresAt: number): number {
  return expiresAt < 1_000_000_000_000 ? expiresAt * 1_000 : expiresAt;
}

function usesApiBilling(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
      process.env.CLAUDE_CODE_USE_FOUNDRY === "1",
  );
}

export async function getUsage() {
  if (usesApiBilling()) {
    return {
      ok: false,
      message: "Claude plan usage is unavailable with API billing",
    };
  }

  const credentialsPayload = await readCredentialsPayload();
  if (!credentialsPayload) {
    return { ok: false, message: "Claude auth credentials were not found" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsPayload.rawJson);
  } catch {
    log.error("Usage: credentials are not valid JSON", {
      source: credentialsPayload.source,
    });
    return { ok: false, message: "Credentials are not valid JSON" };
  }

  const credentialsResult = CredentialsSchema.safeParse(parsed);
  if (!credentialsResult.success) {
    log.error("Usage: credentials schema validation failed", {
      issues: credentialsResult.error.issues,
    });
    return { ok: false, message: "Credentials have unexpected format" };
  }

  const { accessToken, expiresAt } = credentialsResult.data.claudeAiOauth;

  if (expiresAtMilliseconds(expiresAt) <= Date.now()) {
    log.warn("Usage: access token has expired");
    return { ok: false, message: "Claude access token has expired" };
  }

  return await fetchUsageWithToken(accessToken);
}

export async function fetchUsageWithToken(accessToken: string) {
  let responseJson: unknown;
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!response.ok) {
      log.error("Usage: API request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return {
        ok: false,
        message: `Usage API returned ${response.status} ${response.statusText}`,
      };
    }
    responseJson = await response.json();
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.error("Usage: fetch failed", { message: err.message });
    return { ok: false, message: "Failed to fetch usage data" };
  }

  const usageResult = UsageResponseSchema.safeParse(responseJson);
  if (!usageResult.success) {
    log.error("Usage: response schema validation failed", {
      message: usageResult.error.message,
      issues: usageResult.error.issues,
      responseJson,
    });
    return { ok: false, message: "Usage response has unexpected format" };
  }

  log.info("Usage: fetched successfully");
  return { ok: true, usage: usageResult.data };
}
