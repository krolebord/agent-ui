import * as z from "zod";
import { CodexAppServerProcess } from "./codex-app-server-runtime";
import { CodexAppServerTracker } from "./codex-app-server-tracker";
import log from "./logger";

const usageWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number(),
  resetsAt: z.number(),
});

const creditsBalanceSchema = z.preprocess((value) => {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }
  return Number(trimmed);
}, z.number().finite().nullable());

const rateLimitSnapshotSchema = z.object({
  limitId: z.string().optional(),
  limitName: z.string().nullable().optional(),
  primary: usageWindowSchema.nullable(),
  secondary: usageWindowSchema.nullable().optional(),
  planType: z.string().nullable().optional(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: creditsBalanceSchema,
    })
    .nullable()
    .optional(),
});

const rateLimitsResponseSchema = z.object({
  rateLimits: rateLimitSnapshotSchema.nullable(),
  rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshotSchema).optional(),
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
  const date = new Date(unixSeconds * 1_000);
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
    utilization: window.usedPercent,
    resetsAt: toIsoDate(window.resetsAt),
    windowSeconds: window.windowDurationMins * 60,
  };
}

function selectRateLimitsSnapshot(
  response: z.infer<typeof rateLimitsResponseSchema>,
): z.infer<typeof rateLimitSnapshotSchema> | null {
  if (response.rateLimits) {
    return response.rateLimits;
  }

  const byLimitId = response.rateLimitsByLimitId;
  if (!byLimitId) {
    return null;
  }

  const base = byLimitId.codex ?? Object.values(byLimitId)[0];
  if (!base) {
    return null;
  }

  // Newer app-server versions split the 5-hour and weekly limits into
  // separate buckets, each carrying only a `primary` window. Merge windows
  // from every bucket so the weekly limit isn't dropped.
  if (base.secondary) {
    return base;
  }

  const buckets = Object.values(byLimitId);
  const allWindows = buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].filter(
      (window): window is z.infer<typeof usageWindowSchema> => window != null,
    ),
  );

  const primaryDurationMins = base.primary?.windowDurationMins ?? 0;
  const secondary = allWindows
    .filter((window) => window.windowDurationMins > primaryDurationMins)
    .reduce<z.infer<typeof usageWindowSchema> | null>(
      (longest, window) =>
        !longest || window.windowDurationMins > longest.windowDurationMins
          ? window
          : longest,
      null,
    );

  return {
    ...base,
    secondary,
    planType:
      base.planType ??
      buckets.find((bucket) => bucket.planType != null)?.planType ??
      null,
    credits:
      base.credits ??
      buckets.find((bucket) => bucket.credits != null)?.credits ??
      null,
  };
}

async function readRateLimitsFromAppServer(): Promise<unknown> {
  const appServer = new CodexAppServerProcess({ sessionId: "usage" });
  let tracker: CodexAppServerTracker | null = null;

  try {
    await appServer.start();
    tracker = new CodexAppServerTracker({
      sessionId: "usage",
      wsUrl: appServer.wsUrl,
    });
    await tracker.start();
    return await tracker.readAccountRateLimits();
  } finally {
    await tracker?.stop();
    await appServer.stop();
  }
}

export async function getCodexUsage() {
  let responseJson: unknown;
  try {
    responseJson = await readRateLimitsFromAppServer();
  } catch (error) {
    const err = error as { message?: string };
    log.error("CodexUsage: app-server request failed", {
      message: err.message,
    });
    return {
      ok: false,
      message: "Failed to fetch Codex usage data",
    };
  }

  const responseResult = rateLimitsResponseSchema.safeParse(responseJson);
  if (!responseResult.success) {
    log.error("CodexUsage: app-server response schema validation failed", {
      issues: responseResult.error.issues,
      responseJson,
    });
    return {
      ok: false,
      message: "Codex usage response has unexpected format",
    };
  }

  const snapshot = selectRateLimitsSnapshot(responseResult.data);
  if (!snapshot) {
    return {
      ok: false,
      message: "Codex plan usage is unavailable for this login method",
    };
  }

  const normalizedCredits =
    snapshot.credits?.hasCredits &&
    (snapshot.credits.unlimited || typeof snapshot.credits.balance === "number")
      ? {
          hasCredits: true,
          unlimited: snapshot.credits.unlimited,
          balance: snapshot.credits.balance ?? 0,
        }
      : undefined;

  const usage: CodexUsageData = {
    planType: snapshot.planType,
    primaryWindow: normalizeUsageWindow(snapshot.primary),
    secondaryWindow: normalizeUsageWindow(snapshot.secondary),
    credits: normalizedCredits,
  };
  codexUsageDataSchema.parse(usage);

  return { ok: true, usage };
}
