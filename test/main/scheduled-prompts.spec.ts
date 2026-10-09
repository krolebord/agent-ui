import { PersistenceOrchestrator } from "@main/persistence-orchestrator";
import { ScheduledPromptsService } from "@main/scheduled-prompts/service";
import {
  defineScheduledPromptsPersistence,
  defineScheduledPromptsState,
} from "@main/scheduled-prompts/state";
import { claudeLocalTerminalSessionSchema } from "@main/session-service";
import { type SessionStatus, setSessionStatus } from "@main/sessions/common";
import { defineSessionServiceState } from "@main/sessions/state";
import { defineUsageState } from "@main/usage-tracking";
import type { PromptSchedule } from "@shared/scheduled-prompts";
import { usageEntryKey } from "@shared/usage-keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const KEY = usageEntryKey("claude", "account-a");
const services: ScheduledPromptsService[] = [];

function setup(status: SessionStatus = "running") {
  const state = defineScheduledPromptsState();
  const sessions = defineSessionServiceState();
  const usage = defineUsageState();
  sessions.updateState((entries) => {
    entries.session = claudeLocalTerminalSessionSchema.parse({
      type: "claude-local-terminal",
      sessionId: "session",
      title: "Work",
      createdAt: NOW,
      lastActivityAt: NOW,
      status,
      startupConfig: {
        cwd: "/var/tmp/project",
        model: "opus",
        permissionMode: "default",
        accountId: "account-a",
      },
    });
  });
  const deliver = vi.fn(async () => {});
  const refreshUsage = vi.fn(async () => {});
  const service = new ScheduledPromptsService({
    state,
    sessions,
    usage,
    deliver,
    refreshUsage,
  });
  services.push(service);
  const setStatus = (next: SessionStatus) =>
    sessions.updateState((entries) => {
      setSessionStatus(entries.session, next);
    });
  const addSource = (status: SessionStatus = "running") =>
    sessions.updateState((entries) => {
      entries.source = claudeLocalTerminalSessionSchema.parse({
        ...entries.session,
        sessionId: "source",
        title: "Source work",
        status: "idle",
        turn: undefined,
        startupConfig: {
          ...entries.session.startupConfig,
          cwd: "/var/tmp/other-project",
        },
      });
      setSessionStatus(entries.source, status);
    });
  const setSourceStatus = (status: SessionStatus) =>
    sessions.updateState((entries) => setSessionStatus(entries.source, status));
  const sourceSchedule = (): PromptSchedule => ({
    kind: "after-session",
    sourceSessionId: "source",
    sourceTurnId: sessions.state.source?.turn?.id ?? "missing-turn",
  });
  const create = (
    schedule: PromptSchedule = { kind: "after-turn" },
    prompt = "Continue working",
  ) => service.create({ sessionId: "session", prompt, schedule });
  const setUsage = (
    shortPercent = 10,
    weeklyPercent = 20,
    shortReset = NOW + 60_000,
    weeklyReset = NOW + 120_000,
  ) =>
    usage.updateState((state) => {
      state.entries[KEY] = {
        provider: "claude",
        accountId: "account-a",
        status: "ok",
        error: null,
        fetchedAt: Date.now(),
        refreshing: false,
        data: {
          five_hour: {
            utilization: shortPercent,
            resets_at: new Date(shortReset).toISOString(),
          },
          seven_day: {
            utilization: weeklyPercent,
            resets_at: new Date(weeklyReset).toISOString(),
          },
          seven_day_sonnet: null,
          extra_usage: null,
        },
      };
    });
  return {
    state,
    sessions,
    usage,
    deliver,
    refreshUsage,
    service,
    setStatus,
    create,
    setUsage,
    addSource,
    setSourceStatus,
    sourceSchedule,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  vi.useRealTimers();
});

describe("scheduled prompts", () => {
  it("waits for the current turn and confirms delivery from a work signal", async () => {
    const { service, state, create, deliver, setStatus } = setup();
    service.start();
    const entry = create();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
    setStatus("awaiting_user_response");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledOnce();
    expect(state.state[entry.id].status).toBe("sending");
    setStatus("running");
    expect(state.state[entry.id].status).toBe("sent");
    setStatus("idle");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each([
    "starting",
    "stopping",
    "awaiting_approval",
    "error",
  ] satisfies SessionStatus[])(
    "does not send while %s, including Send now",
    async (status) => {
      const { service, create, deliver } = setup(status);
      service.start();
      const entry = create({ kind: "at", at: NOW + 3_600_000 });
      service.sendNow(entry.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it("runs multiple prompts one at a time and ignores idle updates before the first prompt starts", async () => {
    const { service, create, deliver, setStatus, state } = setup("idle");
    service.start();
    create(undefined, "First");
    const second = create(undefined, "Second");
    await vi.advanceTimersByTimeAsync(0);
    setStatus("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledOnce();
    expect(state.state[second.id].message).toContain(
      "previous scheduled prompt",
    );
    setStatus("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledOnce();
    setStatus("awaiting_user_response");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]).toEqual([
      expect.objectContaining({ sessionId: "session" }),
      "Second",
    ]);
  });

  it("sends a timed prompt once due, after an overlapping turn finishes", async () => {
    const { service, create, deliver, setStatus } = setup("running");
    service.start();
    create({ kind: "at", at: NOW + 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).not.toHaveBeenCalled();
    setStatus("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("resolves reset timing on the server for the session's account and refreshes usage after reset", async () => {
    const { service, create, setUsage, refreshUsage, state, deliver } =
      setup("idle");
    setUsage();
    service.start();
    const entry = create({
      kind: "usage-reset",
      window: "short",
      at: NOW + 1,
      usageKey: "wrong-account",
    });
    expect(state.state[entry.id].schedule).toEqual({
      kind: "usage-reset",
      window: "short",
      at: NOW + 60_000,
      usageKey: KEY,
    });
    refreshUsage.mockImplementation(async () => {
      setUsage(0, 20, NOW + 18_060_000);
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshUsage).toHaveBeenCalledWith(KEY);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("waits for a blocking weekly limit even after the short window resets", async () => {
    const { service, create, setUsage, refreshUsage, state, deliver } =
      setup("idle");
    setUsage(100, 100);
    service.start();
    const entry = create({
      kind: "usage-reset",
      window: "short",
      at: NOW + 1,
      usageKey: KEY,
    });
    refreshUsage.mockImplementation(async () => {
      setUsage(0, Date.now() >= NOW + 120_000 ? 0 : 100);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(state.state[entry.id].message).toContain("usage limits");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("leaves reset prompts pending when usage cannot be refreshed", async () => {
    const { service, create, setUsage, state, deliver } = setup("idle");
    setUsage();
    service.start();
    const entry = create({
      kind: "usage-reset",
      window: "weekly",
      at: NOW + 1,
      usageKey: KEY,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(state.state[entry.id].message).toContain("updated usage");
  });

  it("does not send a reset prompt after the session switches account", async () => {
    const { service, create, setUsage, sessions, state, deliver } =
      setup("idle");
    setUsage();
    service.start();
    const entry = create({
      kind: "usage-reset",
      window: "short",
      at: NOW + 1,
      usageKey: KEY,
    });
    sessions.updateState((entries) => {
      const session = entries.session;
      if (session.type === "claude-local-terminal")
        session.startupConfig.accountId = "account-b";
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(state.state[entry.id].status).toBe("failed");
  });

  it("rechecks cancellation after an asynchronous usage refresh", async () => {
    const { service, create, setUsage, refreshUsage, deliver } = setup("idle");
    let finish: (() => void) | undefined;
    refreshUsage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    setUsage(100);
    service.start();
    const entry = create();
    await vi.advanceTimersByTimeAsync(0);
    service.delete(entry.id);
    setUsage(0);
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rechecks session readiness after an asynchronous usage refresh", async () => {
    const { service, create, setUsage, refreshUsage, deliver, setStatus } =
      setup("idle");
    let finish: (() => void) | undefined;
    refreshUsage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    setUsage(100);
    service.start();
    create();
    await vi.advanceTimersByTimeAsync(0);
    setUsage(0);
    setStatus("awaiting_approval");
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("persists prompts and sends an overdue prompt after restart in its original session", async () => {
    const saved = new Map<string, unknown>();
    const persistence = new PersistenceOrchestrator({
      schemaVersion: 1,
      store: {
        get: (key) => saved.get(key),
        set: (key, value) => {
          saved.set(key, value);
        },
      },
    });
    const first = setup("stopped");
    persistence.registerAndHydrate(
      defineScheduledPromptsPersistence(first.state),
    );
    const entry = first.create({ kind: "at", at: NOW + 60_000 });
    await vi.advanceTimersByTimeAsync(100);
    persistence.dispose();
    const second = setup("stopped");
    persistence.registerAndHydrate(
      defineScheduledPromptsPersistence(second.state),
    );
    expect(second.state.state[entry.id]).toMatchObject({
      sessionId: "session",
      status: "pending",
    });
    vi.setSystemTime(NOW + 120_000);
    second.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session", status: "stopped" }),
      "Continue working",
    );
    persistence.dispose();
  });

  it("does not retry uncertain deliveries on restart", async () => {
    const { service, create, state, deliver } = setup("idle");
    const entry = create();
    state.updateState((entries) => {
      entries[entry.id].status = "sending";
    });
    service.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(state.state[entry.id]).toMatchObject({
      status: "uncertain",
      message: expect.stringContaining("Check the conversation"),
    });
  });

  it("holds subsequent prompts across restarts when an earlier delivery is uncertain", async () => {
    const { service, create, state, deliver } = setup("idle");
    const first = create();
    create(undefined, "Second");
    state.updateState((entries) => {
      entries[first.id].status = "sending";
    });
    service.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).not.toHaveBeenCalled();
    service.delete(first.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("shows delivery errors without retrying automatically", async () => {
    const { service, create, state, deliver } = setup("idle");
    deliver.mockRejectedValue(new Error("Terminal missing"));
    service.start();
    const entry = create();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledOnce();
    expect(state.state[entry.id]).toMatchObject({
      status: "failed",
      message: "Terminal missing",
    });
  });

  it("holds the next prompt when delivery cannot be confirmed, until the user acts", async () => {
    const { service, create, state, deliver } = setup("idle");
    service.start();
    const first = create();
    create(undefined, "Second");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledOnce();
    expect(state.state[first.id].status).toBe("uncertain");
    service.delete(first.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("edits and cancels pending prompts and rejects invalid schedules", async () => {
    const { service, create, state } = setup("running");
    const entry = create();
    service.update({
      id: entry.id,
      sessionId: "session",
      prompt: "New task",
      schedule: { kind: "at", at: NOW + 60_000 },
    });
    expect(state.state[entry.id].prompt).toBe("New task");
    expect(() => create({ kind: "at", at: NOW })).toThrow("future");
    expect(() => create(undefined, " \n ")).toThrow();
    expect(() => create(undefined, "text\x1b[201~")).toThrow(
      "control characters",
    );
    expect(() =>
      create({
        kind: "usage-reset",
        window: "short",
        at: NOW + 1,
        usageKey: KEY,
      }),
    ).toThrow("unavailable");
    service.delete(entry.id);
    expect(state.state[entry.id]).toBeUndefined();
  });

  it("marks prompts for deleted sessions as failed and stops processing on disposal", async () => {
    const { service, create, state, sessions, deliver } = setup("idle");
    const entry = create();
    sessions.updateState((entries) => {
      delete entries.session;
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.state[entry.id]).toMatchObject({
      status: "failed",
      message: "Session no longer exists.",
    });
    await service.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  describe("after another session", () => {
    it.each([
      "idle",
      "starting",
      "stopping",
      "awaiting_user_response",
      "awaiting_approval",
      "stopped",
      "error",
    ] satisfies SessionStatus[])("rejects a source that is %s", (status) => {
      const { addSource, create, sourceSchedule } = setup("idle");
      addSource(status);
      expect(() => create(sourceSchedule())).toThrow("no longer running");
    });

    it("rejects the target itself and turns that finished or changed before saving", () => {
      const {
        addSource,
        create,
        sourceSchedule,
        setSourceStatus,
        setStatus,
        sessions,
      } = setup("idle");
      setStatus("running");
      expect(() =>
        create({
          kind: "after-session",
          sourceSessionId: "session",
          sourceTurnId: sessions.state.session.turn?.id ?? "missing-turn",
        }),
      ).toThrow("another running session");
      addSource();
      const selected = sourceSchedule();
      setSourceStatus("awaiting_user_response");
      expect(() => create(selected)).toThrow("no longer running");
      setSourceStatus("running");
      expect(() => create(selected)).toThrow("no longer running");
    });

    it("waits for the selected turn and then for the target to be ready", async () => {
      const {
        service,
        addSource,
        create,
        sourceSchedule,
        setSourceStatus,
        setStatus,
        deliver,
        state,
      } = setup("running");
      addSource();
      service.start();
      const entry = create(sourceSchedule());
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      setSourceStatus("awaiting_user_response");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(state.state[entry.id].schedule).toMatchObject({
        kind: "after-session",
        completed: true,
        sourceTitle: "Source work",
      });
      setStatus("idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session" }),
        "Continue working",
      );
    });

    it("keeps the selected turn through an approval pause", async () => {
      const {
        service,
        addSource,
        create,
        sourceSchedule,
        setSourceStatus,
        deliver,
        state,
      } = setup("idle");
      addSource();
      service.start();
      const entry = create(sourceSchedule());
      setSourceStatus("awaiting_approval");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(state.state[entry.id].message).toContain("answer");
      setSourceStatus("running");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      setSourceStatus("awaiting_user_response");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledOnce();
    });

    it("remembers completion even when the source immediately starts another turn", async () => {
      const {
        service,
        addSource,
        create,
        sourceSchedule,
        setSourceStatus,
        deliver,
      } = setup("idle");
      addSource();
      service.start();
      create(sourceSchedule());
      setSourceStatus("awaiting_user_response");
      setSourceStatus("running");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledOnce();
    });

    it.each(["stopping", "stopped", "error", "idle"] satisfies SessionStatus[])(
      "does not trigger when the selected turn ends as %s",
      async (status) => {
        const {
          service,
          addSource,
          create,
          sourceSchedule,
          setSourceStatus,
          deliver,
          state,
        } = setup("idle");
        addSource();
        service.start();
        const entry = create(sourceSchedule());
        setSourceStatus(status);
        setSourceStatus("running");
        setSourceStatus("awaiting_user_response");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(deliver).not.toHaveBeenCalled();
        expect(state.state[entry.id]).toMatchObject({
          status: "failed",
          message: expect.stringContaining("stopped or failed"),
        });
      },
    );

    it("does not trigger when the source is deleted", async () => {
      const {
        service,
        addSource,
        create,
        sourceSchedule,
        sessions,
        deliver,
        state,
      } = setup("idle");
      addSource();
      service.start();
      const entry = create(sourceSchedule());
      sessions.updateState((entries) => {
        delete entries.source;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(state.state[entry.id]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("deleted"),
      });
    });

    it("still respects target usage limits after the source completes", async () => {
      const {
        service,
        addSource,
        create,
        sourceSchedule,
        setSourceStatus,
        deliver,
        setUsage,
      } = setup("idle");
      setUsage(100);
      addSource();
      service.start();
      create(sourceSchedule());
      setSourceStatus("awaiting_user_response");
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      setUsage(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledOnce();
    });

    it("allows editing a bound prompt while its source awaits approval or has completed", () => {
      const {
        service,
        addSource,
        create,
        sourceSchedule,
        setSourceStatus,
        state,
      } = setup("running");
      addSource();
      service.start();
      const schedule = sourceSchedule();
      const entry = create(schedule);
      setSourceStatus("awaiting_approval");
      service.update({
        id: entry.id,
        sessionId: "session",
        prompt: "Updated task",
        schedule,
      });
      setSourceStatus("running");
      setSourceStatus("awaiting_user_response");
      service.update({
        id: entry.id,
        sessionId: "session",
        prompt: "Final task",
        schedule,
      });
      expect(state.state[entry.id]).toMatchObject({
        prompt: "Final task",
        schedule: { completed: true },
      });
    });

    it("Send now removes the dependency and cancellation prevents delivery", async () => {
      const { service, addSource, create, sourceSchedule, deliver, state } =
        setup("idle");
      addSource();
      service.start();
      const cancelled = create(sourceSchedule());
      const immediate = create(sourceSchedule());
      service.delete(cancelled.id);
      service.sendNow(immediate.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledOnce();
      expect(state.state[cancelled.id]).toBeUndefined();
      expect(state.state[immediate.id].schedule).toEqual({
        kind: "after-turn",
      });
    });

    it("restores confirmed completion across restarts", async () => {
      const first = setup("running");
      first.addSource();
      first.service.start();
      const entry = first.create(first.sourceSchedule());
      first.setSourceStatus("awaiting_user_response");
      const snapshot = structuredClone(first.state.state[entry.id]);
      await first.service.dispose();
      const second = setup("idle");
      second.state.updateState((entries) => {
        entries[entry.id] = snapshot;
      });
      second.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(second.deliver).toHaveBeenCalledOnce();
    });

    it("does not treat an interrupted source after restart as completion", async () => {
      const first = setup("idle");
      first.addSource();
      const entry = first.create(first.sourceSchedule());
      const snapshot = structuredClone(first.state.state[entry.id]);
      const source = structuredClone(first.sessions.state.source);
      const second = setup("idle");
      second.sessions.updateState((entries) => {
        entries.source = source;
        setSessionStatus(entries.source, "stopped");
      });
      second.state.updateState((entries) => {
        entries[entry.id] = snapshot;
      });
      second.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(second.deliver).not.toHaveBeenCalled();
      expect(second.state.state[entry.id].status).toBe("failed");
    });
  });
});
