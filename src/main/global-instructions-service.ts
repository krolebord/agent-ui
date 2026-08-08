import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  composeInstructionFile,
  type GlobalInstructionHarness,
  type GlobalInstructionHarnessInfo,
  type GlobalInstructionSlot,
  type GlobalInstructionsSaveInput,
  type GlobalInstructionsSnapshot,
  globalInstructionsSaveInputSchema,
} from "@shared/global-instructions";
import type { Kysely } from "kysely";
import type { AgentUiDatabase } from "./database/schema";
import { procedure } from "./orpc";

const HARNESSES: GlobalInstructionHarness[] = ["claude", "codex"];
const SLOTS: GlobalInstructionSlot[] = ["common", "claude", "codex"];

export interface GlobalInstructionsStore {
  get(slot: GlobalInstructionSlot): Promise<{
    content: string;
    updatedAt: number;
    lastPushedAt: number | null;
  } | null>;
  set(
    slot: GlobalInstructionSlot,
    content: string,
    lastPushedAt: number | null,
  ): Promise<{ updatedAt: number; lastPushedAt: number | null }>;
}

export class SqliteGlobalInstructionsStore implements GlobalInstructionsStore {
  constructor(private readonly db: Kysely<AgentUiDatabase>) {}

  async get(slot: GlobalInstructionSlot) {
    const row = await this.db
      .selectFrom("global_instructions")
      .select(["content", "updated_at", "last_pushed_at"])
      .where("target", "=", slot)
      .executeTakeFirst();

    if (!row) return null;
    return {
      content: row.content,
      updatedAt: row.updated_at,
      lastPushedAt: row.last_pushed_at,
    };
  }

  async set(
    slot: GlobalInstructionSlot,
    content: string,
    lastPushedAt: number | null,
  ) {
    const updatedAt = Date.now();
    await this.db
      .insertInto("global_instructions")
      .values({
        target: slot,
        content,
        updated_at: updatedAt,
        last_pushed_at: lastPushedAt,
      })
      .onConflict((conflict) =>
        conflict.column("target").doUpdateSet({
          content,
          updated_at: updatedAt,
          last_pushed_at: lastPushedAt,
        }),
      )
      .execute();
    return { updatedAt, lastPushedAt };
  }
}

export function resolveGlobalInstructionPaths(
  target: GlobalInstructionHarness,
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): { absolutePath: string; directoryPath: string; displayPath: string } {
  if (target === "claude") {
    const directoryPath =
      env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
    const absolutePath = path.join(directoryPath, "CLAUDE.md");
    return {
      absolutePath,
      directoryPath,
      displayPath: toDisplayPath(absolutePath, homeDir),
    };
  }

  const directoryPath = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  const absolutePath = path.join(directoryPath, "AGENTS.md");
  return {
    absolutePath,
    directoryPath,
    displayPath: toDisplayPath(absolutePath, homeDir),
  };
}

function toDisplayPath(absolutePath: string, homeDir: string): string {
  const prefix = homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`;
  if (absolutePath === homeDir) return "~";
  if (absolutePath.startsWith(prefix)) {
    return `~/${absolutePath.slice(prefix.length).split(path.sep).join("/")}`;
  }
  return absolutePath;
}

export interface GlobalInstructionsServiceOptions {
  store: GlobalInstructionsStore;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
}

export class GlobalInstructionsService {
  private readonly store: GlobalInstructionsStore;
  private readonly homeDir: string;
  private readonly env: Record<string, string | undefined>;
  private readonly writeFile: typeof writeFile;
  private readonly mkdir: typeof mkdir;

  constructor(options: GlobalInstructionsServiceOptions) {
    this.store = options.store;
    this.homeDir = options.homeDir ?? homedir();
    this.env = options.env ?? process.env;
    this.writeFile = options.writeFile ?? writeFile;
    this.mkdir = options.mkdir ?? mkdir;
  }

  async getSnapshot(): Promise<GlobalInstructionsSnapshot> {
    const rows = await Promise.all(SLOTS.map((slot) => this.store.get(slot)));
    const bySlot = Object.fromEntries(
      SLOTS.map((slot, index) => [slot, rows[index]]),
    ) as Record<
      GlobalInstructionSlot,
      Awaited<ReturnType<GlobalInstructionsStore["get"]>>
    >;

    const updatedAt = SLOTS.reduce<number | null>((latest, slot) => {
      const value = bySlot[slot]?.updatedAt ?? null;
      if (value == null) return latest;
      if (latest == null) return value;
      return Math.max(latest, value);
    }, null);

    const harnesses = await Promise.all(
      HARNESSES.map((target) => this.getHarnessInfo(target)),
    );

    return {
      common: bySlot.common?.content ?? "",
      overrides: {
        claude: bySlot.claude?.content ?? "",
        codex: bySlot.codex?.content ?? "",
      },
      updatedAt,
      harnesses,
    };
  }

  async save(
    input: GlobalInstructionsSaveInput,
  ): Promise<GlobalInstructionsSnapshot> {
    const pushedAt = Date.now();

    await this.store.set("common", input.common, null);
    for (const target of HARNESSES) {
      const paths = resolveGlobalInstructionPaths(
        target,
        this.homeDir,
        this.env,
      );
      const composed = composeInstructionFile(
        input.common,
        input.overrides[target],
      );
      await this.mkdir(paths.directoryPath, { recursive: true });
      await this.writeFile(paths.absolutePath, composed, "utf8");
      await this.store.set(target, input.overrides[target], pushedAt);
    }

    return await this.getSnapshot();
  }

  private async getHarnessInfo(
    target: GlobalInstructionHarness,
  ): Promise<GlobalInstructionHarnessInfo> {
    const paths = resolveGlobalInstructionPaths(target, this.homeDir, this.env);
    const row = await this.store.get(target);
    return {
      target,
      absolutePath: paths.absolutePath,
      directoryPath: paths.directoryPath,
      displayPath: paths.displayPath,
      lastPushedAt: row?.lastPushedAt ?? null,
    };
  }
}

export const globalInstructionsRouter = {
  get: procedure.handler(async ({ context }) => {
    return await context.globalInstructionsService.getSnapshot();
  }),
  save: procedure
    .input(globalInstructionsSaveInputSchema)
    .handler(async ({ input, context }) => {
      return await context.globalInstructionsService.save(input);
    }),
};
