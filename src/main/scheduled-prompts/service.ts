import { randomUUID } from "node:crypto";
import {
  getPromptResetAt,
  getPromptUsageKey,
  getPromptUsageWindows,
  type ScheduledPromptInput,
  scheduledPromptInputSchema,
  supportsScheduledPrompts,
} from "@shared/scheduled-prompts";
import { createDisposable } from "@shared/utils";
import log from "../logger";
import type { Session, SessionServiceState } from "../sessions/state";
import type { UsageState } from "../usage-tracking";
import type { ScheduledPrompt, ScheduledPromptsState } from "./state";

const SETTLE_MS = 5_000;

interface Options {
  state: ScheduledPromptsState;
  sessions: SessionServiceState;
  usage: UsageState;
  deliver: (session: Session, prompt: string) => Promise<void>;
  refreshUsage: (key: string) => Promise<unknown>;
  now?: () => number;
}

export class ScheduledPromptsService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly active = new Map<
    string,
    { id: string; startedAt: number; observedWork: boolean }
  >();
  private readonly refreshedAt = new Map<string, number>();
  private readonly readySince = new Map<string, number>();
  private readonly now: () => number;
  private started = false;
  private disposed = false;
  private ticking = false;
  private wakeRequested = false;
  private readonly disposable = createDisposable({
    onError: (error) => log.error("Scheduled prompts teardown failed", error),
  });

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.state.updateState((entries) => {
      for (const entry of Object.values(entries)) {
        if (entry.status === "sending") {
          entry.status = "uncertain";
          entry.message =
            "The app stopped while sending. Check the conversation before sending again.";
        }
      }
    });
    for (const entry of Object.values(this.options.state.state)) {
      if (entry.status === "uncertain")
        this.active.set(entry.sessionId, {
          id: entry.id,
          startedAt: this.now(),
          observedWork: false,
        });
    }
    this.updateDependencies();
    this.updateReadiness(0);
    const onSessions = () => {
      this.updateDependencies();
      this.updateReadiness(this.now());
      for (const [sessionId, active] of this.active) {
        const session = this.options.sessions.state[sessionId];
        if (!session) {
          this.active.delete(sessionId);
          continue;
        }
        if (
          session.status === "running" ||
          session.status === "awaiting_approval"
        ) {
          active.observedWork = true;
          this.options.state.updateState((entries) => {
            if (entries[active.id]?.status === "sending")
              delete entries[active.id];
          });
        } else if (
          active.observedWork &&
          session.status !== "starting" &&
          session.status !== "stopping"
        ) {
          this.active.delete(sessionId);
        }
      }
      this.wake();
    };
    const onUsage = () => this.wake();
    this.options.sessions.eventTarget.addEventListener(
      "state-update",
      onSessions,
    );
    this.options.usage.eventTarget.addEventListener("state-update", onUsage);
    this.disposable.addDisposable(() =>
      this.options.sessions.eventTarget.removeEventListener(
        "state-update",
        onSessions,
      ),
    );
    this.disposable.addDisposable(() =>
      this.options.usage.eventTarget.removeEventListener(
        "state-update",
        onUsage,
      ),
    );
    this.disposable.addDisposable(() => {
      if (this.timer) clearTimeout(this.timer);
    });
    this.wake();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposable.dispose();
  }

  private validate(
    input: ScheduledPromptInput,
    existing?: ScheduledPrompt,
  ): Pick<ScheduledPrompt, "sessionId" | "prompt" | "schedule"> {
    const parsed = scheduledPromptInputSchema.parse(input);
    const session = this.options.sessions.state[parsed.sessionId];
    if (!session || !supportsScheduledPrompts(session))
      throw new Error("This session cannot receive scheduled prompts.");
    if (parsed.schedule.kind === "after-session") {
      if (parsed.schedule.sourceSessionId === parsed.sessionId)
        throw new Error("Choose another running session.");
      const previous = existing?.schedule;
      if (
        existing?.status === "pending" &&
        previous?.kind === "after-session" &&
        previous.sourceSessionId === parsed.schedule.sourceSessionId &&
        previous.sourceTurnId === parsed.schedule.sourceTurnId
      ) {
        return { ...parsed, schedule: previous };
      }
      const source =
        this.options.sessions.state[parsed.schedule.sourceSessionId];
      if (
        !source ||
        !supportsScheduledPrompts(source) ||
        source.status !== "running" ||
        source.turn?.status !== "running" ||
        source.turn.id !== parsed.schedule.sourceTurnId
      )
        throw new Error(
          "The selected turn is no longer running. Choose another running session.",
        );
      return {
        ...parsed,
        schedule: {
          ...parsed.schedule,
          sourceTitle: source.title,
          completed: false,
        },
      };
    }
    if (parsed.schedule.kind === "usage-reset") {
      const key = getPromptUsageKey(session);
      const entry = key ? this.options.usage.state.entries[key] : undefined;
      const at = getPromptResetAt(entry, parsed.schedule.window);
      if (!key || entry?.status !== "ok" || !at || at <= this.now()) {
        throw new Error(
          "Reset time is unavailable. Refresh usage or choose a specific time.",
        );
      }
      parsed.schedule = { ...parsed.schedule, usageKey: key, at };
    } else if (
      parsed.schedule.kind === "at" &&
      parsed.schedule.at <= this.now()
    ) {
      throw new Error("Choose a time in the future.");
    }
    return { ...parsed, schedule: parsed.schedule };
  }

  create(input: ScheduledPromptInput): ScheduledPrompt {
    const entry: ScheduledPrompt = {
      ...this.validate(input),
      id: randomUUID(),
      createdAt: this.now(),
      status: "pending",
    };
    this.options.state.updateState((entries) => {
      entries[entry.id] = entry;
    });
    this.wake();
    return entry;
  }

  update(input: ScheduledPromptInput & { id: string }): void {
    const existing = this.options.state.state[input.id];
    if (!existing || existing.status === "sending")
      throw new Error("This prompt can no longer be edited.");
    if (existing.sessionId !== input.sessionId)
      throw new Error("A scheduled prompt cannot move to another session.");
    const parsed = this.validate(input, existing);
    if (this.active.get(existing.sessionId)?.id === input.id)
      this.active.delete(existing.sessionId);
    this.options.state.updateState((entries) => {
      entries[input.id] = {
        ...parsed,
        id: input.id,
        createdAt: existing.createdAt,
        status: "pending",
      };
    });
    this.wake();
  }

  delete(id: string): void {
    if (this.options.state.state[id]?.status === "sending")
      throw new Error("This prompt is already being sent.");
    const entry = this.options.state.state[id];
    if (
      (entry?.status === "failed" || entry?.status === "uncertain") &&
      this.active.get(entry.sessionId)?.id === id
    )
      this.active.delete(entry.sessionId);
    this.options.state.updateState((entries) => {
      delete entries[id];
    });
    this.wake();
  }

  sendNow(id: string): void {
    const entry = this.options.state.state[id];
    if (!entry || entry.status === "sending")
      throw new Error("This prompt cannot be sent again.");
    if (this.active.get(entry.sessionId)?.id === id)
      this.active.delete(entry.sessionId);
    this.options.state.updateState((entries) => {
      const current = entries[id];
      current.status = "pending";
      current.schedule = { kind: "after-turn" };
      delete current.message;
    });
    this.wake();
  }

  private wake(delay = 0): void {
    if (!this.started || this.disposed) return;
    if (this.ticking) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private setMessage(
    id: string,
    message: string | undefined,
    status?: "failed" | "uncertain",
  ): void {
    this.options.state.updateState((entries) => {
      const entry = entries[id];
      if (!entry) return;
      entry.message = message;
      if (status) entry.status = status;
    });
  }

  private updateReadiness(since: number): void {
    const sessions = this.options.sessions.state;
    for (const sessionId of this.readySince.keys()) {
      if (!sessions[sessionId]) this.readySince.delete(sessionId);
    }
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (
        session.status !== "idle" &&
        session.status !== "awaiting_user_response"
      )
        this.readySince.delete(sessionId);
      else if (!this.readySince.has(sessionId))
        this.readySince.set(sessionId, since);
    }
  }

  private settlesAt(sessionId: string): number {
    return (this.readySince.get(sessionId) ?? -SETTLE_MS) + SETTLE_MS;
  }

  private updateDependencies(): void {
    this.options.state.updateState((entries) => {
      for (const entry of Object.values(entries)) {
        const schedule = entry.schedule;
        if (
          entry.status !== "pending" ||
          schedule.kind !== "after-session" ||
          schedule.completed
        )
          continue;
        const source = this.options.sessions.state[schedule.sourceSessionId];
        if (
          source?.turn?.id === schedule.sourceTurnId &&
          source.turn.status === "completed"
        ) {
          schedule.completed = true;
          delete entry.message;
        } else if (
          !source ||
          source.turn?.id !== schedule.sourceTurnId ||
          source.turn.status === "interrupted" ||
          source.status === "stopping" ||
          source.status === "stopped" ||
          source.status === "error"
        ) {
          entry.status = "failed";
          entry.message = !source
            ? "The selected session was deleted. Edit this prompt to choose another running session."
            : "The selected turn stopped or failed before completion. Edit this prompt to choose another running session.";
        } else {
          entry.message =
            source.status === "awaiting_approval"
              ? `Waiting for you to answer "${schedule.sourceTitle}" before its turn can finish.`
              : `Waiting for "${schedule.sourceTitle}" to finish its current turn.`;
        }
      }
    });
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      for (const active of this.active.values()) {
        if (
          !active.observedWork &&
          this.options.state.state[active.id]?.status === "sending" &&
          this.now() - active.startedAt >= 60_000
        ) {
          this.setMessage(
            active.id,
            "Could not confirm the prompt started. Check the conversation before sending again.",
            "uncertain",
          );
        }
      }
      const entries = Object.values(this.options.state.state).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      for (const entry of entries) {
        if (this.disposed) break;
        if (entry.status !== "pending") continue;
        const session = this.options.sessions.state[entry.sessionId];
        if (!session || !supportsScheduledPrompts(session)) {
          this.setMessage(entry.id, "Session no longer exists.", "failed");
          continue;
        }
        if (
          (entry.schedule.kind === "at" ||
            entry.schedule.kind === "usage-reset") &&
          entry.schedule.at > this.now()
        )
          continue;
        if (
          entry.schedule.kind === "after-session" &&
          !entry.schedule.completed
        )
          continue;
        if (this.active.has(entry.sessionId)) {
          this.setMessage(
            entry.id,
            "Waiting for the previous scheduled prompt to finish.",
          );
          continue;
        }
        if (session.status === "awaiting_approval") {
          this.setMessage(
            entry.id,
            "Waiting for you to answer the agent's request.",
          );
          continue;
        }
        if (
          session.status === "running" ||
          session.status === "starting" ||
          session.status === "stopping"
        ) {
          this.setMessage(entry.id, "Waiting for the current turn to finish.");
          continue;
        }
        if (session.status === "error") {
          this.setMessage(
            entry.id,
            "Resolve the session error before this prompt can run.",
          );
          continue;
        }
        if (this.settlesAt(entry.sessionId) > this.now()) {
          this.setMessage(entry.id, "Waiting for the session to settle.");
          continue;
        }
        const key = getPromptUsageKey(session);
        if (
          entry.schedule.kind === "usage-reset" &&
          entry.schedule.usageKey !== key
        ) {
          this.setMessage(
            entry.id,
            "The session account changed. Edit this prompt to choose a new reset time.",
            "failed",
          );
          continue;
        }
        let usage = key ? this.options.usage.state.entries[key] : undefined;
        const shouldRefresh =
          entry.schedule.kind === "usage-reset" ||
          getPromptUsageWindows(usage, session.startupConfig.model).some(
            (window) => window.utilization >= 100,
          );
        if (
          key &&
          shouldRefresh &&
          this.now() - (this.refreshedAt.get(key) ?? 0) >= 30_000
        ) {
          this.refreshedAt.set(key, this.now());
          await this.options
            .refreshUsage(key)
            .catch((error) =>
              log.warn("Scheduled prompt usage refresh failed", error),
            );
          usage = this.options.usage.state.entries[key];
        }
        if (
          entry.schedule.kind === "usage-reset" &&
          (usage?.status !== "ok" ||
            !usage.fetchedAt ||
            usage.fetchedAt < entry.schedule.at)
        ) {
          this.setMessage(
            entry.id,
            "Waiting for updated usage after the reset.",
          );
          continue;
        }
        const blocked = getPromptUsageWindows(
          usage,
          session.startupConfig.model,
        ).filter((window) => window.utilization >= 100);
        if (blocked.length) {
          const reset = Math.max(
            ...blocked.map((window) =>
              window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN,
            ),
          );
          this.setMessage(
            entry.id,
            Number.isFinite(reset) && reset > this.now()
              ? `Waiting for usage limits to reset at ${new Date(reset).toLocaleString()}.`
              : "Waiting for usage limits to refresh.",
          );
          continue;
        }
        // Usage refresh can take time while the session or queue changes.
        const current = this.options.state.state[entry.id];
        const latest = this.options.sessions.state[entry.sessionId];
        if (this.disposed || current !== entry || latest !== session) continue;
        this.active.set(entry.sessionId, {
          id: entry.id,
          startedAt: this.now(),
          observedWork: false,
        });
        this.options.state.updateState((state) => {
          state[entry.id].status = "sending";
          delete state[entry.id].message;
        });
        try {
          await this.options.deliver(session, entry.prompt);
          this.options.sessions.updateState((sessions) => {
            const current = sessions[entry.sessionId];
            if (!current) return;
            delete current.settledAt;
            delete current.settledOverride;
            delete current.snoozedAt;
            delete current.snoozedUntil;
            current.lastActivityAt = this.now();
          });
        } catch (error) {
          this.active.delete(entry.sessionId);
          this.setMessage(
            entry.id,
            error instanceof Error ? error.message : "Failed to send prompt.",
            "failed",
          );
        }
      }
    } catch (error) {
      log.error("Scheduled prompt processing failed", error);
    } finally {
      this.ticking = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake();
      } else {
        const waiting = Object.values(this.options.state.state).filter(
          (entry) => entry.status === "pending" || entry.status === "sending",
        );
        if (waiting.length) {
          let delay = 30_000;
          for (const entry of waiting) {
            if (
              (entry.schedule.kind === "at" ||
                entry.schedule.kind === "usage-reset") &&
              entry.schedule.at > this.now()
            )
              delay = Math.min(delay, entry.schedule.at - this.now());
            const settlesAt = this.settlesAt(entry.sessionId);
            if (entry.status === "pending" && settlesAt > this.now())
              delay = Math.min(delay, settlesAt - this.now());
          }
          this.wake(delay);
        }
      }
    }
  }
}
