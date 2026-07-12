import { ScheduledSessionsService } from "@main/scheduled-sessions/scheduler";
import {
  defineScheduledSessionsState,
  type ScheduledSession,
  type ScheduledSessionConfig,
} from "@main/scheduled-sessions/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

const claudeConfig: ScheduledSessionConfig = {
  type: "claude",
  cwd: "/tmp/project",
  model: "opus",
  permissionMode: "default",
  initialPrompt: "do the thing",
  sessionName: undefined,
};

function makeEntry(overrides: Partial<ScheduledSession>): ScheduledSession {
  return {
    id: "entry-1",
    name: undefined,
    createdAt: BASE_TIME.getTime(),
    enabled: true,
    schedule: { kind: "once", at: BASE_TIME.getTime() + 1000 },
    config: claudeConfig,
    ...overrides,
  };
}

function createService(options?: {
  runSession?: (config: ScheduledSessionConfig) => Promise<string>;
  validateRun?: (config: ScheduledSessionConfig) => Promise<string | null>;
}) {
  const state = defineScheduledSessionsState();
  const runSession = vi.fn(options?.runSession ?? (async () => "session-id-1"));
  const validateRun = vi.fn(options?.validateRun ?? (async () => null));
  const service = new ScheduledSessionsService({
    state,
    runSession,
    validateRun,
  });
  return { state, service, runSession, validateRun };
}

describe("ScheduledSessionsService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("create", () => {
    it("rejects one-time schedules in the past", () => {
      const { service } = createService();
      expect(() =>
        service.create({
          schedule: { kind: "once", at: BASE_TIME.getTime() - 1 },
          config: claudeConfig,
        }),
      ).toThrow(/future/);
    });

    it("rejects invalid cron expressions", () => {
      const { service } = createService();
      expect(() =>
        service.create({
          schedule: { kind: "recurring", cron: "not a cron" },
          config: claudeConfig,
        }),
      ).toThrow(/Invalid cron expression/);
    });

    it("stores the entry with a computed next run", () => {
      const { service, state } = createService();
      const entry = service.create({
        name: "Nightly",
        schedule: { kind: "recurring", cron: "0 3 * * *" },
        config: claudeConfig,
      });

      const stored = state.state[entry.id];
      expect(stored?.enabled).toBe(true);
      expect(stored?.nextRunAt).toBeGreaterThan(BASE_TIME.getTime());
    });
  });

  describe("update", () => {
    it("updates name, schedule, and config, recomputing the next run", () => {
      const { service, state } = createService();
      const entry = service.create({
        name: "Nightly",
        schedule: { kind: "recurring", cron: "0 3 * * *" },
        config: claudeConfig,
      });

      service.update({
        id: entry.id,
        name: "Hourly",
        schedule: { kind: "recurring", cron: "0 * * * *" },
        config: { ...claudeConfig, initialPrompt: "do the other thing" },
      });

      const stored = state.state[entry.id];
      expect(stored?.name).toBe("Hourly");
      expect(stored?.schedule).toEqual({
        kind: "recurring",
        cron: "0 * * * *",
      });
      expect(
        stored?.config.type === "claude" && stored.config.initialPrompt,
      ).toBe("do the other thing");
      expect(stored?.nextRunAt).toBe(BASE_TIME.getTime() + 60 * 60_000);

      service.dispose();
    });

    it("replaces the config with a different session type", () => {
      const { service, state } = createService();
      const entry = service.create({
        schedule: { kind: "recurring", cron: "0 3 * * *" },
        config: claudeConfig,
      });

      service.update({
        id: entry.id,
        schedule: { kind: "recurring", cron: "0 3 * * *" },
        config: {
          type: "codex",
          cwd: claudeConfig.cwd,
          sessionName: undefined,
          modelReasoningEffort: "high",
          fastMode: "default",
          permissionMode: "default",
          initialPrompt: "do the thing",
        },
      });

      expect(state.state[entry.id]?.config.type).toBe("codex");

      service.dispose();
    });

    it("re-enables a completed one-time schedule", async () => {
      const { service, state, runSession } = createService();
      const entry = service.create({
        schedule: { kind: "once", at: BASE_TIME.getTime() + 1_000 },
        config: claudeConfig,
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.state[entry.id]?.enabled).toBe(false);

      service.update({
        id: entry.id,
        schedule: { kind: "once", at: Date.now() + 60_000 },
        config: claudeConfig,
      });

      expect(state.state[entry.id]?.enabled).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(runSession).toHaveBeenCalledTimes(2);

      service.dispose();
    });

    it("rejects invalid schedules", () => {
      const { service } = createService();
      const entry = service.create({
        schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
        config: claudeConfig,
      });

      expect(() =>
        service.update({
          id: entry.id,
          schedule: { kind: "once", at: BASE_TIME.getTime() - 1 },
          config: claudeConfig,
        }),
      ).toThrow(/future/);
      expect(() =>
        service.update({
          id: entry.id,
          schedule: { kind: "recurring", cron: "not a cron" },
          config: claudeConfig,
        }),
      ).toThrow(/Invalid cron expression/);

      service.dispose();
    });

    it("throws for unknown entries", () => {
      const { service } = createService();
      expect(() =>
        service.update({
          id: "missing",
          schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
          config: claudeConfig,
        }),
      ).toThrow(/not found/);
    });
  });

  it("runs a one-time schedule at its time and disables it", async () => {
    const { service, state, runSession } = createService();
    service.create({
      schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
      config: claudeConfig,
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(runSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(runSession).toHaveBeenCalledExactlyOnceWith(claudeConfig, {
      createdBy: "user",
    });

    const entry = Object.values(state.state)[0];
    expect(entry?.enabled).toBe(false);
    expect(entry?.nextRunAt).toBeUndefined();
    expect(entry?.lastRunSessionId).toBe("session-id-1");
    expect(entry?.lastError).toBeUndefined();

    service.dispose();
  });

  it("runs a recurring schedule and advances to the next occurrence", async () => {
    const { service, state, runSession } = createService();
    const entry = service.create({
      schedule: { kind: "recurring", cron: "*/5 * * * *" },
      config: claudeConfig,
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    expect(runSession).toHaveBeenCalledTimes(1);

    const stored = state.state[entry.id];
    expect(stored?.enabled).toBe(true);
    expect(stored?.nextRunAt).toBeGreaterThan(Date.now());

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runSession).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  describe("start", () => {
    it("catches up missed one-time schedules", async () => {
      const { service, state, runSession } = createService();
      state.updateState((entries) => {
        entries["entry-1"] = makeEntry({
          schedule: { kind: "once", at: BASE_TIME.getTime() - 60_000 },
        });
      });

      service.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(runSession).toHaveBeenCalledExactlyOnceWith(claudeConfig, {
        createdBy: "user",
      });
      expect(state.state["entry-1"]?.enabled).toBe(false);

      service.dispose();
    });

    it("skips missed recurring occurrences", async () => {
      const { service, state, runSession } = createService();
      state.updateState((entries) => {
        entries["entry-1"] = makeEntry({
          schedule: { kind: "recurring", cron: "0 3 * * *" },
          // Stale next-run from a previous app run.
          nextRunAt: BASE_TIME.getTime() - 60_000,
        });
      });

      service.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(runSession).not.toHaveBeenCalled();
      expect(state.state["entry-1"]?.nextRunAt).toBeGreaterThan(
        BASE_TIME.getTime(),
      );

      service.dispose();
    });
  });

  it("records a validation error instead of starting the session", async () => {
    const { service, state, runSession } = createService({
      validateRun: async () => "Project folder not found: /tmp/project",
    });
    const entry = service.create({
      schedule: { kind: "once", at: BASE_TIME.getTime() + 1_000 },
      config: claudeConfig,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(runSession).not.toHaveBeenCalled();
    expect(state.state[entry.id]?.lastError).toBe(
      "Project folder not found: /tmp/project",
    );

    service.dispose();
  });

  it("records run failures as lastError", async () => {
    const { service, state } = createService({
      runSession: async () => {
        throw new Error("spawn failed");
      },
    });
    const entry = service.create({
      schedule: { kind: "once", at: BASE_TIME.getTime() + 1_000 },
      config: claudeConfig,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(state.state[entry.id]?.lastError).toBe("spawn failed");

    service.dispose();
  });

  it("does not fire disabled schedules", async () => {
    const { service, state, runSession } = createService();
    const entry = service.create({
      schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
      config: claudeConfig,
    });

    service.setEnabled(entry.id, false);
    expect(state.state[entry.id]?.nextRunAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runSession).not.toHaveBeenCalled();

    service.dispose();
  });

  it("re-enabling a recurring schedule recomputes the next run", () => {
    const { service, state } = createService();
    const entry = service.create({
      schedule: { kind: "recurring", cron: "0 3 * * *" },
      config: claudeConfig,
    });

    service.setEnabled(entry.id, false);
    service.setEnabled(entry.id, true);

    expect(state.state[entry.id]?.nextRunAt).toBeGreaterThan(
      BASE_TIME.getTime(),
    );

    service.dispose();
  });

  it("runNow starts the session without disabling a one-time schedule", async () => {
    const { service, state, runSession } = createService();
    const entry = service.create({
      schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
      config: claudeConfig,
    });

    await service.runNow(entry.id);

    expect(runSession).toHaveBeenCalledExactlyOnceWith(claudeConfig, {
      createdBy: "user",
    });
    expect(state.state[entry.id]?.enabled).toBe(true);
    expect(state.state[entry.id]?.lastRunSessionId).toBe("session-id-1");

    service.dispose();
  });

  describe("agent-created entries", () => {
    it("creates disabled entries that allow a past one-time schedule", async () => {
      const { service, state, runSession } = createService();
      const entry = service.create({
        schedule: { kind: "once", at: BASE_TIME.getTime() - 1 },
        config: claudeConfig,
        createdBy: "agent",
        enabled: false,
      });

      const stored = state.state[entry.id];
      expect(stored?.createdBy).toBe("agent");
      expect(stored?.enabled).toBe(false);
      expect(stored?.needsApproval).toBe(true);
      expect(stored?.nextRunAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(runSession).not.toHaveBeenCalled();

      service.dispose();
    });

    it("still rejects past one-time schedules for enabled entries", () => {
      const { service } = createService();
      expect(() =>
        service.create({
          schedule: { kind: "once", at: BASE_TIME.getTime() - 1 },
          config: claudeConfig,
          createdBy: "agent",
        }),
      ).toThrow(/future/);
    });

    it("runs a pending immediate entry once the user enables it", async () => {
      const { service, state, runSession } = createService();
      const entry = service.create({
        schedule: { kind: "once", at: BASE_TIME.getTime() },
        config: claudeConfig,
        createdBy: "agent",
        enabled: false,
      });

      service.setEnabled(entry.id, true);
      expect(state.state[entry.id]?.needsApproval).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);

      expect(runSession).toHaveBeenCalledExactlyOnceWith(claudeConfig, {
        createdBy: "agent",
      });
      expect(state.state[entry.id]?.enabled).toBe(false);

      service.dispose();
    });

    it("agent edits disable the entry and flag it for re-approval", async () => {
      const { service, state, runSession } = createService();
      const entry = service.create({
        schedule: { kind: "recurring", cron: "0 3 * * *" },
        config: claudeConfig,
        createdBy: "agent",
        enabled: false,
      });
      service.setEnabled(entry.id, true);

      service.update({
        id: entry.id,
        name: "Retimed",
        schedule: { kind: "recurring", cron: "0 4 * * *" },
        config: claudeConfig,
        editedBy: "agent",
      });

      const stored = state.state[entry.id];
      expect(stored?.enabled).toBe(false);
      expect(stored?.needsApproval).toBe(true);
      expect(stored?.nextRunAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(runSession).not.toHaveBeenCalled();

      service.dispose();
    });

    it("agent edits may carry a past one-time schedule", () => {
      const { service, state } = createService();
      const entry = service.create({
        schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
        config: claudeConfig,
        createdBy: "agent",
        enabled: false,
      });

      service.update({
        id: entry.id,
        schedule: { kind: "once", at: BASE_TIME.getTime() - 1 },
        config: claudeConfig,
        editedBy: "agent",
      });

      expect(state.state[entry.id]?.enabled).toBe(false);
      expect(state.state[entry.id]?.needsApproval).toBe(true);

      service.dispose();
    });

    it("user edits re-arm the entry and clear the approval flag", () => {
      const { service, state } = createService();
      const entry = service.create({
        schedule: { kind: "recurring", cron: "0 3 * * *" },
        config: claudeConfig,
        createdBy: "agent",
        enabled: false,
      });

      service.update({
        id: entry.id,
        schedule: { kind: "recurring", cron: "0 4 * * *" },
        config: claudeConfig,
      });

      const stored = state.state[entry.id];
      expect(stored?.enabled).toBe(true);
      expect(stored?.needsApproval).toBeUndefined();
      expect(stored?.nextRunAt).toBeGreaterThan(BASE_TIME.getTime());

      service.dispose();
    });
  });

  it("stops firing after dispose", async () => {
    const { service, runSession } = createService();
    service.create({
      schedule: { kind: "once", at: BASE_TIME.getTime() + 60_000 },
      config: claudeConfig,
    });

    service.dispose();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(runSession).not.toHaveBeenCalled();
  });
});
