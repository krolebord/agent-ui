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

// GetCreditGrantsBalance response shape is not officially documented; parse a
// few plausible balance fields defensively and convert cents -> dollars.
const RawCreditsBalanceSchema = z
  .object({
    balance: z.number().optional(),
    totalBalance: z.number().optional(),
    availableBalance: z.number().optional(),
    grantedBalance: z.number().optional(),
    remainingBalance: z.number().optional(),
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

async function readCursorAccessToken(): Promise<string | null> {
  const token = await querySqlite("cursorAuth/accessToken");
  if (!token) {
    log.error("Cursor usage: access token is empty");
  }
  return token;
}

async function readCursorMembershipType(): Promise<string | null> {
  const value = await querySqlite("cursorAuth/stripeMembershipType");
  if (!value) {
    return null;
  }
  // Values are usually stored plain (e.g. `pro`), but strip JSON quoting if present.
  return value.replace(/^"|"$/g, "").trim() || null;
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

  const cents =
    parsed.data.balance ??
    parsed.data.totalBalance ??
    parsed.data.availableBalance ??
    parsed.data.grantedBalance ??
    parsed.data.remainingBalance;
  if (cents == null) {
    log.info("Cursor usage: no recognizable credits balance field", {
      responseJson,
    });
    return null;
  }

  return cents / 100;
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
    readCursorMembershipType(),
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
