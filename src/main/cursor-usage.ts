import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import spawn from "nano-spawn";
import * as z from "zod";
import log from "./logger";

function cursorVscdbPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

const CURSOR_DASHBOARD_BASE =
  "https://api2.cursor.sh/aiserver.v1.DashboardService";

const CursorAuthSchema = z.object({
  accessToken: z.string().min(1),
});

// --- Raw wire schemas (api2.cursor.sh Connect/gRPC-JSON, camelCase) ---

const RawPlanUsageSchema = z.object({
  totalSpend: z.number().optional(),
  includedSpend: z.number().optional(),
  bonusSpend: z.number().optional(),
  remaining: z.number().optional(),
  // Free/individual payloads may omit `limit`; team payloads always include it.
  limit: z.number().optional(),
  totalPercentUsed: z.number().optional(),
  autoPercentUsed: z.number().optional(),
  apiPercentUsed: z.number().optional(),
});

const RawSpendLimitSchema = z.object({
  individualLimit: z.number().optional(),
  individualUsed: z.number().optional(),
  pooledLimit: z.number().optional(),
  pooledUsed: z.number().optional(),
});

const RawCurrentPeriodUsageSchema = z.object({
  billingCycleStart: z.string().optional(),
  billingCycleEnd: z.string(),
  planUsage: RawPlanUsageSchema,
  spendLimitUsage: RawSpendLimitSchema.optional(),
});

const IntegerSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return value;
}, z.number().finite());

// These fields mirror Cursor Agent's bundled DashboardService protobuf.
const RawCreditsBalanceSchema = z
  .object({
    hasCreditGrants: z.boolean().optional(),
    creditBalanceCents: IntegerSchema.optional(),
    totalCents: IntegerSchema.optional(),
    usedCents: IntegerSchema.optional(),
  })
  .passthrough();

const RawPlanInfoSchema = z
  .object({
    planInfo: z
      .object({
        planName: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

// --- Normalized output (consumed by the renderer) ---

const SpendLimitUsageSchema = z.object({
  individualLimit: z.number().nullable(),
  individualUsed: z.number().nullable(),
  pooledLimit: z.number().nullable(),
  pooledUsed: z.number().nullable(),
});

const PlanUsageSchema = z.object({
  includedSpend: z.number(),
  limit: z.number().nullable(),
  totalPercentUsed: z.number(),
  autoPercentUsed: z.number().nullable(),
  apiPercentUsed: z.number().nullable(),
  totalSpend: z.number().nullable(),
  bonusSpend: z.number().nullable(),
});

const UsageDataSchema = z.object({
  billingCycleStart: z.string().nullable(),
  billingCycleEnd: z.string(),
  membershipType: z.string().nullable(),
  planUsage: PlanUsageSchema,
  spendLimitUsage: SpendLimitUsageSchema.nullable(),
  credits: z.object({ balance: z.number() }).nullable(),
});

export type CursorUsageData = z.infer<typeof UsageDataSchema>;

async function querySqlite(key: string): Promise<string | null> {
  try {
    const { output } = await spawn(
      "sqlite3",
      [cursorVscdbPath(), `SELECT value FROM ItemTable WHERE key = '${key}'`],
      { timeout: 5_000, stdin: "ignore" },
    );
    const value = output.trim();
    return value || null;
  } catch (e: unknown) {
    const err = e as { message?: string; exitCode?: number };
    log.error("Cursor usage: failed to read state.vscdb", {
      key,
      message: err.message,
      exitCode: err.exitCode,
    });
    return null;
  }
}

function cursorAgentAuthPath(): string {
  if (process.platform === "darwin") {
    return join(homedir(), ".cursor", "auth.json");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return join(
      appData && appData !== "undefined"
        ? appData
        : join(homedir(), "AppData", "Roaming"),
      "Cursor",
      "auth.json",
    );
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(
    xdgConfigHome && xdgConfigHome !== "undefined"
      ? xdgConfigHome
      : join(homedir(), ".config"),
    "cursor",
    "auth.json",
  );
}

async function readCursorAgentAccessToken(): Promise<string | null> {
  const filePath = cursorAgentAuthPath();
  let rawJson: string;
  try {
    rawJson = await readFile(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      log.warn("Cursor usage: failed to read Cursor Agent credentials", {
        filePath,
        message: err.message,
        code: err.code,
      });
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    log.warn("Cursor usage: Cursor Agent credentials are not valid JSON", {
      filePath,
    });
    return null;
  }

  const result = CursorAuthSchema.safeParse(parsed);
  if (!result.success) {
    log.warn("Cursor usage: Cursor Agent credentials have unexpected format", {
      filePath,
      issues: result.error.issues,
    });
    return null;
  }

  return result.data.accessToken;
}

async function readCursorAgentAccessTokenFromKeychain(): Promise<
  string | null
> {
  try {
    const { output } = await spawn(
      "security",
      [
        "find-generic-password",
        "-a",
        "cursor-user",
        "-s",
        "cursor-access-token",
        "-w",
      ],
      { timeout: 5_000, stdin: "ignore" },
    );
    return output.trim() || null;
  } catch (error) {
    const err = error as { message?: string; exitCode?: number };
    log.warn("Cursor usage: failed to read Cursor Agent Keychain token", {
      message: err.message,
      exitCode: err.exitCode,
    });
    return null;
  }
}

async function readCursorAccessToken(): Promise<string | null> {
  const agentToken = await readCursorAgentAccessToken();
  if (agentToken) {
    return agentToken;
  }

  if (process.platform === "darwin") {
    const keychainToken = await readCursorAgentAccessTokenFromKeychain();
    if (keychainToken) {
      return keychainToken;
    }
  }

  const token =
    process.platform === "darwin"
      ? await querySqlite("cursorAuth/accessToken")
      : null;
  if (!token) {
    log.error("Cursor usage: access token is empty");
  }
  return token;
}

async function fetchDashboard(
  method: string,
  accessToken: string,
): Promise<unknown> {
  const response = await fetch(`${CURSOR_DASHBOARD_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(
      `${method} returned ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

async function fetchCredits(accessToken: string): Promise<number | null> {
  // Best-effort enrichment: never fails the overall usage fetch.
  let responseJson: unknown;
  try {
    responseJson = await fetchDashboard("GetCreditGrantsBalance", accessToken);
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.warn("Cursor usage: credits request failed", { message: err.message });
    return null;
  }

  const parsed = RawCreditsBalanceSchema.safeParse(responseJson);
  if (!parsed.success) {
    log.warn("Cursor usage: credits response has unexpected shape", {
      responseJson,
    });
    return null;
  }

  if (!parsed.data.hasCreditGrants) {
    return null;
  }

  return parsed.data.creditBalanceCents != null
    ? parsed.data.creditBalanceCents / 100
    : null;
}

async function fetchMembershipType(
  accessToken: string,
): Promise<string | null> {
  let responseJson: unknown;
  try {
    responseJson = await fetchDashboard("GetPlanInfo", accessToken);
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.warn("Cursor usage: plan info request failed", {
      message: err.message,
    });
    return null;
  }

  const parsed = RawPlanInfoSchema.safeParse(responseJson);
  if (!parsed.success) {
    log.warn("Cursor usage: plan info response has unexpected shape", {
      responseJson,
    });
    return null;
  }

  return parsed.data.planInfo?.planName?.trim() || null;
}

function normalizeUsage(
  raw: z.infer<typeof RawCurrentPeriodUsageSchema>,
  membershipType: string | null,
  creditsBalance: number | null,
): CursorUsageData {
  const plan = raw.planUsage;
  const limit = plan.limit ?? null;
  const includedSpend =
    plan.includedSpend ??
    (limit != null ? Math.max(limit - (plan.remaining ?? 0), 0) : 0);
  const totalPercentUsed =
    plan.totalPercentUsed ??
    (limit != null && limit > 0 ? (includedSpend / limit) * 100 : 0);

  const sl = raw.spendLimitUsage;
  const spendLimitUsage = sl
    ? {
        individualLimit: sl.individualLimit ?? null,
        individualUsed: sl.individualUsed ?? null,
        pooledLimit: sl.pooledLimit ?? null,
        pooledUsed: sl.pooledUsed ?? null,
      }
    : null;

  return {
    billingCycleStart: raw.billingCycleStart ?? null,
    billingCycleEnd: raw.billingCycleEnd,
    membershipType,
    planUsage: {
      includedSpend,
      limit,
      totalPercentUsed,
      autoPercentUsed: plan.autoPercentUsed ?? null,
      apiPercentUsed: plan.apiPercentUsed ?? null,
      totalSpend: plan.totalSpend ?? null,
      bonusSpend: plan.bonusSpend ?? null,
    },
    spendLimitUsage,
    credits: creditsBalance != null ? { balance: creditsBalance } : null,
  };
}

export async function getCursorUsage() {
  if (process.env.CURSOR_API_KEY?.trim()) {
    return {
      ok: false,
      message: "Cursor plan usage is unavailable with API key authentication",
    };
  }

  const accessToken = await readCursorAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      message: "Failed to read Cursor access token",
    };
  }

  let usageJson: unknown;
  try {
    usageJson = await fetchDashboard("GetCurrentPeriodUsage", accessToken);
  } catch (e: unknown) {
    const err = e as { message?: string };
    log.error("Cursor usage: fetch failed", { message: err.message });
    return {
      ok: false,
      message: err.message?.startsWith("GetCurrentPeriodUsage returned")
        ? `Cursor usage API ${err.message.slice("GetCurrentPeriodUsage ".length)}`
        : "Failed to fetch Cursor usage data",
    };
  }

  const usageResult = RawCurrentPeriodUsageSchema.safeParse(usageJson);
  if (!usageResult.success) {
    log.error("Cursor usage: response schema validation failed", {
      message: usageResult.error.message,
      issues: usageResult.error.issues,
      responseJson: usageJson,
    });
    return {
      ok: false,
      message: "Cursor usage response has unexpected format",
    };
  }

  // Enrichment runs in parallel and degrades gracefully on failure.
  const [membershipType, creditsBalance] = await Promise.all([
    fetchMembershipType(accessToken),
    fetchCredits(accessToken),
  ]);

  const usage = normalizeUsage(
    usageResult.data,
    membershipType,
    creditsBalance,
  );
  UsageDataSchema.parse(usage);

  log.info("Cursor usage: fetched successfully");
  return { ok: true, usage };
}
