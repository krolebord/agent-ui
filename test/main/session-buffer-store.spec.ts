import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../../src/main/database/database-service";
import {
  createInMemorySessionBufferStore,
  type SessionBufferStore,
  SqliteSessionBufferStore,
} from "../../src/main/database/session-buffer-store";

describe("session buffer stores", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  async function createSqliteStore() {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-buffers-"),
    );
    const database = await DatabaseService.create(userDataPath);
    cleanups.push(async () => {
      await database.close();
      await rm(userDataPath, { recursive: true, force: true });
    });

    return new SqliteSessionBufferStore(database.db);
  }

  // Hold both implementations to the same contract; drift between them would
  // only show up in production.
  const implementations: Array<[string, () => Promise<SessionBufferStore>]> = [
    ["SqliteSessionBufferStore", () => createSqliteStore()],
    [
      "createInMemorySessionBufferStore",
      async () => createInMemorySessionBufferStore(),
    ],
  ];

  for (const [name, create] of implementations) {
    describe(name, () => {
      it("returns undefined for an unknown session", async () => {
        const store = await create();
        await expect(store.get("missing")).resolves.toBeUndefined();
      });

      it("round-trips a buffer and overwrites it on the next stop", async () => {
        const store = await create();

        await store.set("session-1", "first run");
        await expect(store.get("session-1")).resolves.toBe("first run");

        await store.set("session-1", "second run");
        await expect(store.get("session-1")).resolves.toBe("second run");
      });

      it("deletes a buffer", async () => {
        const store = await create();
        await store.set("session-1", "output");

        await store.delete("session-1");

        await expect(store.get("session-1")).resolves.toBeUndefined();
        await expect(store.delete("session-1")).resolves.toBeUndefined();
      });

      it("drops buffers whose session is gone", async () => {
        const store = await create();
        await store.set("keep", "kept output");
        await store.set("orphan-1", "gone");
        await store.set("orphan-2", "gone");

        await expect(store.deleteOrphans(["keep"])).resolves.toBe(2);
        await expect(store.get("keep")).resolves.toBe("kept output");
        await expect(store.get("orphan-1")).resolves.toBeUndefined();
      });

      it("refuses to treat an empty session list as a full wipe", async () => {
        const store = await create();
        await store.set("session-1", "output");

        await expect(store.deleteOrphans([])).resolves.toBe(0);
        await expect(store.get("session-1")).resolves.toBe("output");
      });

      it("preserves large buffers with control characters intact", async () => {
        const store = await create();
        const buffer = `[2J${"x".repeat(300_000)}[?25h`;

        await store.set("session-1", buffer);

        await expect(store.get("session-1")).resolves.toBe(buffer);
      });
    });
  }

  it("survives a database reopen", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-buffers-"),
    );
    cleanups.push(() => rm(userDataPath, { recursive: true, force: true }));

    const first = await DatabaseService.create(userDataPath);
    await new SqliteSessionBufferStore(first.db).set("session-1", "output");
    await first.close();

    const second = await DatabaseService.create(userDataPath);
    cleanups.push(() => second.close());

    await expect(
      new SqliteSessionBufferStore(second.db).get("session-1"),
    ).resolves.toBe("output");
  });
});
