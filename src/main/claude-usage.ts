import spawn from "nano-spawn";
import * as z from "zod";
import log from "./logger";

const CredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    scopes: z.array(z.string()),
    subscriptionType: z.string(),
  }),
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
    monthly_limit: z.number(),
    used_credits: z.number(),
    utilization: z.number(),
  })
  .nullable();

const UsageResponseSchema = z.object({
  five_hour: UsageBucketSchema,
  seven_day: UsageBucketSchema,
  seven_day_sonnet: UsageBucketSchema,
  extra_usage: ExtraUsageSchema,
});

export type UsageData = z.infer<typeof UsageResponseSchema>;

export async function getUsage() {
  let credentialsJson: string;
  try {
    const { output } = await spawn(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5_000, stdin: "ignore" },
    );
    credentialsJson = output.trim();
  } catch (e: unknown) {
    const err = e as { message?: string; exitCode?: number };
    log.error("Usage: failed to read credentials from keychain", {
      message: err.message,
      exitCode: err.exitCode,
    });
    return { ok: false, message: "Failed to read credentials from keychain" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsJson);
  } catch {
    log.error("Usage: credentials are not valid JSON");
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

  if (expiresAt * 1000 <= Date.now()) {
    log.warn("Usage: access token has expired");
    return { ok: false, message: "Claude access token has expired" };
  }

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
