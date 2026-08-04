import { describe, expect, it } from "vitest";
import { expandLoggedErrors } from "../../src/main/logger";

describe("expandLoggedErrors", () => {
  it("expands the cause chain of a wrapped error", () => {
    const root = new Error(
      "corrupted migrations: 0002_create_sessions missing",
    );
    const wrapped = new Error("Failed to migrate the Agent UI database", {
      cause: root,
    });

    const [entry] = expandLoggedErrors([{ error: wrapped }]) as [
      { error: Record<string, unknown> },
    ];

    expect(entry.error).toMatchObject({
      name: "Error",
      message: "Failed to migrate the Agent UI database",
      cause: {
        name: "Error",
        message: "corrupted migrations: 0002_create_sessions missing",
      },
    });
    expect(entry.error.stack).toContain("Failed to migrate");
    expect((entry.error.cause as Record<string, unknown>).stack).toContain(
      "corrupted migrations",
    );
  });

  it("keeps own properties such as system error codes", () => {
    const error = Object.assign(new Error("open failed"), {
      code: "ENOENT",
      path: "/tmp/missing",
    });

    const [serialized] = expandLoggedErrors([error]) as [
      Record<string, unknown>,
    ];

    expect(serialized).toMatchObject({
      message: "open failed",
      code: "ENOENT",
      path: "/tmp/missing",
    });
  });

  it("expands the members of an AggregateError", () => {
    const aggregate = new AggregateError(
      [new Error("first"), new Error("second")],
      "all failed",
    );

    const [serialized] = expandLoggedErrors([aggregate]) as [
      { errors: Record<string, unknown>[] },
    ];

    expect(serialized.errors.map((child) => child.message)).toEqual([
      "first",
      "second",
    ]);
  });

  it("truncates a cause chain that exceeds the depth limit", () => {
    let error = new Error("depth-0");
    for (let index = 1; index <= 8; index += 1) {
      error = new Error(`depth-${index}`, { cause: error });
    }

    const serialized = JSON.stringify(expandLoggedErrors([error]));

    expect(serialized).toContain("[cause chain truncated]");
    expect(serialized).not.toContain("depth-0");
  });

  it("does not loop on a self-referencing cause", () => {
    const error = new Error("self");
    Object.defineProperty(error, "cause", { value: error, enumerable: false });

    expect(() => expandLoggedErrors([error])).not.toThrow();
  });

  it("leaves non-error values untouched", () => {
    const date = new Date("2026-08-04T00:00:00.000Z");
    const data = [
      "text",
      42,
      null,
      undefined,
      date,
      { nested: { value: true } },
    ];

    expect(expandLoggedErrors(data)).toEqual([
      "text",
      42,
      null,
      undefined,
      date,
      { nested: { value: true } },
    ]);
  });
});
