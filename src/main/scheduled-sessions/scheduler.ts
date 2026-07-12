import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Cron } from "croner";
import log from "../logger";
import type {
  ScheduledSession,
  ScheduledSessionConfig,
  ScheduledSessionsState,
  ScheduleSpec,
} from "./state";

// Ticks are capped so a machine waking from sleep re-checks due schedules
// quickly instead of trusting a long-running setTimeout.
const MAX_TICK_DELAY_MS = 30_000;

export type ScheduledSessionRunner = (
  config: ScheduledSessionConfig,
  meta: { createdBy: "user" | "agent" },
) => Promise<string>;

export type ScheduledSessionRunValidator = (
  config: ScheduledSessionConfig,
) => Promise<string | null>;

interface ScheduledSessionsServiceOptions {
  state: ScheduledSessionsState;
  runSession: ScheduledSessionRunner;
  validateRun?: ScheduledSessionRunValidator;
  now?: () => number;
  maxTickDelayMs?: number;
}

export interface CreateScheduledSessionInput {
  name?: string;
  schedule: ScheduleSpec;
  config: ScheduledSessionConfig;
  /** Defaults to "user". Agent-created entries spawn sessions whose MCP
   * token cannot schedule further sessions. */
  createdBy?: "user" | "agent";
  /** Defaults to true. Agent-created entries start disabled so the user
   * approves them before anything runs. */
  enabled?: boolean;
}

export interface UpdateScheduledSessionInput {
  id: string;
  name?: string;
  schedule: ScheduleSpec;
  config: ScheduledSessionConfig;
  /** Defaults to "user". A user edit re-arms the schedule; an agent edit
   * disables it and flags it for re-approval, so approved content can never
   * be swapped out from under the user. */
  editedBy?: "user" | "agent";
}

export function getNextCronRunAt(cron: string, fromMs: number): number | null {
  const parsed = new Cron(cron);
  const next = parsed.nextRun(new Date(fromMs));
  return next ? next.getTime() : null;
}

export function assertValidCronExpression(cron: string): void {
  try {
    new Cron(cron);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid cron expression "${cron}": ${detail}`);
  }
}

async function defaultValidateRun(
  config: ScheduledSessionConfig,
): Promise<string | null> {
  try {
    const stats = await fs.stat(config.cwd);
    if (!stats.isDirectory()) {
      return `Project path is not a directory: ${config.cwd}`;
    }
    return null;
  } catch {
    return `Project folder not found: ${config.cwd}`;
  }
}

export class ScheduledSessionsService {
  private readonly state: ScheduledSessionsState;
  private readonly runSession: ScheduledSessionRunner;
  private readonly validateRun: ScheduledSessionRunValidator;
  private readonly now: () => number;
  private readonly maxTickDelayMs: number;

  private readonly runningIds = new Set<string>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: ScheduledSessionsServiceOptions) {
    this.state = options.state;
    this.runSession = options.runSession;
    this.validateRun = options.validateRun ?? defaultValidateRun;
    this.now = options.now ?? Date.now;
    this.maxTickDelayMs = options.maxTickDelayMs ?? MAX_TICK_DELAY_MS;
  }

  start(): void {
    const now = this.now();

    // Repair next-run times on boot. One-time schedules keep their original
    // time so a missed run fires immediately (catch-up); recurring schedules
    // skip missed occurrences and resume from the next one.
    this.state.updateState((entries) => {
      for (const entry of Object.values(entries)) {
        if (!entry.enabled) {
          entry.nextRunAt = undefined;
          continue;
        }
        entry.nextRunAt = computeNextRunAt(entry.schedule, now);
      }
    });

    void this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  list(): ScheduledSession[] {
    return Object.values(this.state.state);
  }

  get(id: string): ScheduledSession | undefined {
    return this.state.state[id];
  }

  create(input: CreateScheduledSessionInput): ScheduledSession {
    const now = this.now();
    const enabled = input.enabled ?? true;
    // A disabled entry may carry a past one-time schedule: it fires as a
    // catch-up run the moment the user enables (approves) it.
    assertScheduleIsRunnable(input.schedule, now, {
      allowPastOnce: !enabled,
    });

    const entry: ScheduledSession = {
      id: randomUUID(),
      name: input.name?.trim() || undefined,
      createdAt: now,
      createdBy: input.createdBy ?? "user",
      needsApproval: input.createdBy === "agent" && !enabled ? true : undefined,
      enabled,
      schedule: input.schedule,
      config: input.config,
      nextRunAt: enabled ? computeNextRunAt(input.schedule, now) : undefined,
    };

    this.state.updateState((entries) => {
      entries[entry.id] = entry;
    });
    this.scheduleTick();

    return entry;
  }

  update(input: UpdateScheduledSessionInput): ScheduledSession {
    const now = this.now();
    const existing = this.state.state[input.id];
    if (!existing) {
      throw new Error(`Scheduled session ${input.id} not found`);
    }
    // A user edit re-arms the schedule, so a completed one-off moved to a new
    // time runs again instead of staying disabled. An agent edit is only a
    // proposal: the entry is disabled until the user re-approves it, and may
    // carry a past one-time schedule that fires as a catch-up on approval.
    const enabled = input.editedBy !== "agent";
    assertScheduleIsRunnable(input.schedule, now, {
      allowPastOnce: !enabled,
    });

    this.state.updateState((entries) => {
      const entry = entries[input.id];
      if (!entry) {
        return;
      }
      entry.name = input.name?.trim() || undefined;
      entry.schedule = input.schedule;
      entry.config = input.config;
      entry.enabled = enabled;
      entry.needsApproval = enabled ? undefined : true;
      entry.nextRunAt = enabled
        ? computeNextRunAt(input.schedule, now)
        : undefined;
    });
    this.scheduleTick();

    const updated = this.state.state[input.id];
    if (!updated) {
      throw new Error(`Scheduled session ${input.id} not found`);
    }
    return updated;
  }

  delete(id: string): void {
    this.state.updateState((entries) => {
      delete entries[id];
    });
    this.scheduleTick();
  }

  setEnabled(id: string, enabled: boolean): void {
    const now = this.now();
    this.state.updateState((entries) => {
      const entry = entries[id];
      if (!entry) {
        return;
      }
      entry.enabled = enabled;
      if (enabled) {
        entry.needsApproval = undefined;
      }
      entry.nextRunAt = enabled
        ? computeNextRunAt(entry.schedule, now)
        : undefined;
    });
    this.scheduleTick();
  }

  async runNow(id: string): Promise<void> {
    const entry = this.state.state[id];
    if (!entry) {
      throw new Error(`Scheduled session ${id} not found`);
    }
    await this.runEntry(entry.id, { manual: true });
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (this.disposed) {
      return;
    }
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    const now = this.now();
    let earliest: number | null = null;
    for (const entry of Object.values(this.state.state)) {
      if (!entry.enabled || entry.nextRunAt === undefined) {
        continue;
      }
      if (earliest === null || entry.nextRunAt < earliest) {
        earliest = entry.nextRunAt;
      }
    }

    if (earliest === null) {
      return;
    }

    const delay = Math.min(Math.max(0, earliest - now), this.maxTickDelayMs);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.tick();
    }, delay);
    if (typeof this.tickTimer === "object" && "unref" in this.tickTimer) {
      this.tickTimer.unref();
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const now = this.now();
    const dueIds = Object.values(this.state.state)
      .filter(
        (entry) =>
          entry.enabled &&
          entry.nextRunAt !== undefined &&
          entry.nextRunAt <= now,
      )
      .map((entry) => entry.id);

    for (const id of dueIds) {
      await this.runEntry(id);
    }

    this.scheduleTick();
  }

  private async runEntry(
    id: string,
    opts?: { manual?: boolean },
  ): Promise<void> {
    if (this.runningIds.has(id)) {
      return;
    }

    const entry = this.state.state[id];
    if (!entry) {
      return;
    }

    const now = this.now();
    const config = entry.config;

    // Advance the schedule before running so a slow or failing run can't
    // cause the same occurrence to fire twice.
    this.state.updateState((entries) => {
      const draft = entries[id];
      if (!draft) {
        return;
      }
      draft.lastRunAt = now;
      if (draft.schedule.kind === "once") {
        if (!opts?.manual) {
          draft.enabled = false;
        }
        draft.nextRunAt = undefined;
      } else {
        draft.nextRunAt =
          getNextCronRunAt(draft.schedule.cron, now) ?? undefined;
      }
    });

    this.runningIds.add(id);
    try {
      const validationError = await this.validateRun(config);
      if (validationError) {
        this.recordRunResult(id, { error: validationError });
        return;
      }

      const sessionId = await this.runSession(config, {
        createdBy: entry.createdBy ?? "user",
      });
      this.recordRunResult(id, { sessionId });
    } catch (error) {
      log.error(`Scheduled session ${id} failed to start`, error);
      this.recordRunResult(id, {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start scheduled session.",
      });
    } finally {
      this.runningIds.delete(id);
    }
  }

  private recordRunResult(
    id: string,
    result: { sessionId?: string; error?: string },
  ): void {
    this.state.updateState((entries) => {
      const entry = entries[id];
      if (!entry) {
        return;
      }
      if (result.error) {
        entry.lastError = result.error;
      } else {
        entry.lastError = undefined;
        entry.lastRunSessionId = result.sessionId;
      }
    });
  }
}

function assertScheduleIsRunnable(
  schedule: ScheduleSpec,
  now: number,
  opts?: { allowPastOnce?: boolean },
): void {
  if (schedule.kind === "recurring") {
    assertValidCronExpression(schedule.cron);
    if (getNextCronRunAt(schedule.cron, now) === null) {
      throw new Error(
        `Cron expression "${schedule.cron}" never matches a future time.`,
      );
    }
  } else if (schedule.at <= now && !opts?.allowPastOnce) {
    throw new Error("Scheduled time must be in the future.");
  }
}

function computeNextRunAt(
  schedule: ScheduleSpec,
  fromMs: number,
): number | undefined {
  if (schedule.kind === "once") {
    return schedule.at;
  }

  try {
    return getNextCronRunAt(schedule.cron, fromMs) ?? undefined;
  } catch {
    return undefined;
  }
}
