import { type SessionStatus, setSessionStatus } from "@main/sessions/common";
import { describe, expect, it } from "vitest";

function makeSession(): Parameters<typeof setSessionStatus>[0] {
  return { status: "idle" };
}

describe("session turn tracking", () => {
  it("keeps one identity while working and awaiting approval, then starts a new identity on the next turn", () => {
    const session = makeSession();
    setSessionStatus(session, "running");
    const id = session.turn?.id;
    expect(id).toBeTruthy();
    setSessionStatus(session, "running");
    setSessionStatus(session, "awaiting_approval");
    setSessionStatus(session, "running");
    expect(session.turn).toEqual({ id, status: "running" });
    setSessionStatus(session, "awaiting_user_response");
    expect(session.turn).toEqual({ id, status: "completed" });
    setSessionStatus(session, "idle");
    setSessionStatus(session, "stopped");
    expect(session.turn).toEqual({ id, status: "completed" });
    setSessionStatus(session, "running");
    expect(session.turn?.id).not.toBe(id);
  });

  it.each([
    "idle",
    "stopped",
    "stopping",
    "starting",
    "error",
  ] satisfies SessionStatus[])(
    "marks an active turn interrupted on %s and never completes it from a later idle signal",
    (status) => {
      const session = makeSession();
      setSessionStatus(session, "running");
      const id = session.turn?.id;
      setSessionStatus(session, status);
      setSessionStatus(session, "awaiting_user_response");
      expect(session.turn).toEqual({ id, status: "interrupted" });
      setSessionStatus(session, "running");
      expect(session.turn?.id).not.toBe(id);
    },
  );

  it("does not invent a completed turn when a session starts idle", () => {
    const session = makeSession();
    setSessionStatus(session, "starting");
    setSessionStatus(session, "idle");
    setSessionStatus(session, "awaiting_user_response");
    expect(session.turn).toBeUndefined();
  });
});
