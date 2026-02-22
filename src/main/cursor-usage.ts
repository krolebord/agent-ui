import { homedir } from "node:os";
import { join } from "node:path";
import spawn from "nano-spawn";
import * as z from "zod";
import log from "./logger";

const CURSOR_VSCDB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);

const PlanUsageSchema = z.object({
  includedSpend: z.number(),
  limit: z.number(),
  totalPercentUsed: z.number(),
});

const SpendLimitUsageSchema = z.object({
  individualLimit: z.number().optional(),
  individualUsed: z.number().optional(),
});

const UsageResponseSchema = z.object({
  billingCycleEnd: z.string(),
  planUsage: PlanUsageSchema,
  spendLimitUsage: SpendLimitUsageSchema.optional(),
});

export type CursorUsageData = z.infer<typeof UsageResponseSchema>;

async function readCursorAccessToken(): Promise<string | null> {
  try {
    const { output } = await spawn(
      "sqlite3",
      [
        CURSOR_VSCDB_PATH,
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
      ],
      { timeout: 5_000, stdin: "ignore" },
    );
    const token = output.trim();
    if (!token) {
      log.error("Cursor usage: access token is empty");
      return null;
    }
    return token;
  } catch (e: unknown) {
    const err = e as { message?: string; exitCode?: number };
    log.error("Cursor usage: failed to read access token from state.vscdb", {
      message: err.message,
      exitCode: err.exitCode,
    });
    return null;
  }
}

export async function getCursorUsage() {
  const accessToken = await readCursorAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      message: "Failed to read Cursor access token",
    };
  }

  let responseJson: unknown;
  try {
    const response = await fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
      },
    );
    if (!response.ok) {
      log.error("Cursor usage: API request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return {
        ok: false,
        message: `Cursor usage API returned ${response.status} ${response.statusText}`,
      };
    }
    responseJson = await response.json();
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.error("Cursor usage: fetch failed", { message: err.message });
    return { ok: false, message: "Failed to fetch Cursor usage data" };
  }

  const usageResult = UsageResponseSchema.safeParse(responseJson);
  if (!usageResult.success) {
    log.error("Cursor usage: response schema validation failed", {
      message: usageResult.error.message,
      issues: usageResult.error.issues,
      responseJson,
    });
    return {
      ok: false,
      message: "Cursor usage response has unexpected format",
    };
  }

  log.info("Cursor usage: fetched successfully");
  return { ok: true, usage: usageResult.data };
}
