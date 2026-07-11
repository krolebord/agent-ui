import type { Dirent, FSWatcher } from "node:fs";
import { watch } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defineServiceState } from "@shared/service-state";
import {
  type SkillEntry,
  type SkillScope,
  skillNameSchema,
  skillScopeSchema,
} from "@shared/skills";
import { z } from "zod";
import log from "./logger";
import { procedure } from "./orpc";
import type { ProjectState } from "./project-service";
import {
  getBoolean,
  getScalar,
  parseSkillMd,
  serializeSkillMd,
} from "./skill-frontmatter";

export const defineSkillsState = () =>
  defineServiceState({
    key: "skills",
    defaults: {} as Record<string, SkillEntry>,
  });

export type SkillsServiceState = ReturnType<typeof defineSkillsState>;

const RESCAN_DEBOUNCE_MS = 200;
const AGENTS_SKILLS_SEGMENTS = [".agents", "skills"] as const;
const CLAUDE_SKILLS_SEGMENTS = [".claude", "skills"] as const;

const OPENAI_POLICY_FILE = path.join("agents", "openai.yaml");
const OPENAI_POLICY_CONTENTS = `policy:
  allow_implicit_invocation: false
`;

interface SkillsRoot {
  /** "global" or the project path. */
  id: string;
  scope: SkillScope;
  /** Canonical skills dir (.agents/skills). */
  agentsSkillsDir: string;
  /** Claude Code skills dir (.claude/skills) that receives symlinks. */
  claudeSkillsDir: string;
  /** Project roots use relative symlinks to keep repos portable. */
  relativeLinks: boolean;
}

interface RootWatchers {
  agents: FSWatcher | null;
  /** Fallback watcher on the project root, waiting for .agents to appear. */
  parent: FSWatcher | null;
}

export interface SkillsServiceOptions {
  state: SkillsServiceState;
  projectsState: ProjectState;
  /** userData/managed-skills — sources of code-defined (builtin) skills. */
  builtinSkillsRoot: string | null;
  /** Overridable for tests. */
  homeDir?: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class SkillsService {
  private readonly state: SkillsServiceState;
  private readonly projectsState: ProjectState;
  private readonly builtinSkillsRoot: string | null;
  private readonly homeDir: string;

  private readonly watchers = new Map<string, RootWatchers>();
  private readonly pendingRescans = new Map<string, NodeJS.Timeout>();
  private unsubscribeProjects: (() => void) | null = null;
  private disposed = false;

  constructor(options: SkillsServiceOptions) {
    this.state = options.state;
    this.projectsState = options.projectsState;
    this.builtinSkillsRoot = options.builtinSkillsRoot;
    this.homeDir = options.homeDir ?? homedir();
  }

  get globalAgentsSkillsDir(): string {
    return path.join(this.homeDir, ...AGENTS_SKILLS_SEGMENTS);
  }

  private globalRoot(): SkillsRoot {
    return {
      id: "global",
      scope: { type: "global" },
      agentsSkillsDir: this.globalAgentsSkillsDir,
      claudeSkillsDir: path.join(this.homeDir, ...CLAUDE_SKILLS_SEGMENTS),
      relativeLinks: false,
    };
  }

  private projectRoot(projectPath: string): SkillsRoot {
    return {
      id: projectPath,
      scope: { type: "project", projectPath },
      agentsSkillsDir: path.join(projectPath, ...AGENTS_SKILLS_SEGMENTS),
      claudeSkillsDir: path.join(projectPath, ...CLAUDE_SKILLS_SEGMENTS),
      relativeLinks: true,
    };
  }

  private currentRoots(): SkillsRoot[] {
    const projectPaths = new Set(this.projectsState.state.map((p) => p.path));
    return [
      this.globalRoot(),
      ...[...projectPaths].map((p) => this.projectRoot(p)),
    ];
  }

  private rootById(id: string): SkillsRoot | null {
    return this.currentRoots().find((root) => root.id === id) ?? null;
  }

  rootForScope(scope: SkillScope): SkillsRoot {
    if (scope.type === "global") return this.globalRoot();
    const known = this.projectsState.state.some(
      (p) => p.path === scope.projectPath,
    );
    if (!known) {
      throw new Error(`Unknown project: ${scope.projectPath}`);
    }
    return this.projectRoot(scope.projectPath);
  }

  async start(): Promise<void> {
    try {
      await mkdir(this.globalAgentsSkillsDir, { recursive: true });
    } catch (err) {
      log.error("Failed to create global skills dir", err);
    }

    const projectsListener = () => {
      this.reconcileWatchedRoots();
    };
    this.projectsState.eventTarget.addEventListener(
      "state-update",
      projectsListener,
    );
    this.unsubscribeProjects = () => {
      this.projectsState.eventTarget.removeEventListener(
        "state-update",
        projectsListener,
      );
    };

    this.reconcileWatchedRoots();
    await this.rescanAll();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeProjects?.();
    this.unsubscribeProjects = null;
    for (const timer of this.pendingRescans.values()) clearTimeout(timer);
    this.pendingRescans.clear();
    for (const [id] of this.watchers) this.closeWatchers(id);
  }

  async rescanAll(): Promise<void> {
    const roots = this.currentRoots();
    const rootIds = new Set(roots.map((r) => r.id));
    this.state.updateState((store) => {
      for (const [key, entry] of Object.entries(store)) {
        const entryRootId =
          entry.scope.type === "global" ? "global" : entry.scope.projectPath;
        if (!rootIds.has(entryRootId)) {
          delete store[key];
        }
      }
    });
    await Promise.all(roots.map((root) => this.rescanRoot(root)));
  }

  // ---------------------------------------------------------------------
  // Watching

  private reconcileWatchedRoots(): void {
    if (this.disposed) return;
    const roots = this.currentRoots();
    const rootIds = new Set(roots.map((r) => r.id));

    for (const id of [...this.watchers.keys()]) {
      if (!rootIds.has(id)) {
        this.closeWatchers(id);
        this.removeRootEntries(id);
      }
    }

    for (const root of roots) {
      if (!this.watchers.has(root.id)) {
        this.attachWatchers(root);
        this.scheduleRescan(root.id);
      }
    }
  }

  private closeWatchers(id: string): void {
    const watchers = this.watchers.get(id);
    if (!watchers) return;
    watchers.agents?.close();
    watchers.parent?.close();
    this.watchers.delete(id);
  }

  private attachWatchers(root: SkillsRoot): void {
    const watchers: RootWatchers = { agents: null, parent: null };
    this.watchers.set(root.id, watchers);
    this.tryWatchAgentsDir(root, watchers);
  }

  private tryWatchAgentsDir(root: SkillsRoot, watchers: RootWatchers): void {
    const agentsDir = path.dirname(root.agentsSkillsDir);
    try {
      watchers.agents = watch(
        agentsDir,
        { recursive: true, persistent: false },
        () => {
          this.scheduleRescan(root.id);
        },
      );
      watchers.agents.on("error", (err) => {
        log.warn("Skills watcher error", { root: root.id, err });
      });
      if (watchers.parent) {
        watchers.parent.close();
        watchers.parent = null;
      }
    } catch {
      // .agents doesn't exist yet — watch the parent dir non-recursively so
      // we notice when it's created (e.g. by an agent), then upgrade.
      this.tryWatchParentDir(root, watchers, path.dirname(agentsDir));
    }
  }

  private tryWatchParentDir(
    root: SkillsRoot,
    watchers: RootWatchers,
    parentDir: string,
  ): void {
    if (watchers.parent) return;
    try {
      watchers.parent = watch(parentDir, { persistent: false }, (_, name) => {
        if (name !== ".agents") return;
        this.tryWatchAgentsDir(root, watchers);
        this.scheduleRescan(root.id);
      });
      watchers.parent.on("error", (err) => {
        log.warn("Skills parent watcher error", { root: root.id, err });
      });
    } catch (err) {
      log.warn("Failed to watch for skills dir creation", {
        root: root.id,
        err,
      });
    }
  }

  private scheduleRescan(rootId: string): void {
    if (this.disposed) return;
    const existing = this.pendingRescans.get(rootId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingRescans.delete(rootId);
      const root = this.rootById(rootId);
      if (!root) return;
      // A rescan may reveal that .agents was created after the fallback
      // watcher fired; retry the recursive watch if needed.
      const watchers = this.watchers.get(rootId);
      if (watchers && !watchers.agents) {
        this.tryWatchAgentsDir(root, watchers);
      }
      void this.rescanRoot(root).catch((err) => {
        log.warn("Skills rescan failed", { root: rootId, err });
      });
    }, RESCAN_DEBOUNCE_MS);
    this.pendingRescans.set(rootId, timer);
  }

  // ---------------------------------------------------------------------
  // Scanning

  async rescanRoot(root: SkillsRoot): Promise<void> {
    const entries = await this.scanRoot(root);
    if (this.disposed) return;

    this.state.updateState((store) => {
      for (const [key, entry] of Object.entries(store)) {
        if (this.entryBelongsToRoot(entry, root)) {
          delete store[key];
        }
      }
      for (const entry of entries) {
        store[entry.dirPath] = entry;
      }
    });

    await this.syncLinks(root, entries);
  }

  private entryBelongsToRoot(entry: SkillEntry, root: SkillsRoot): boolean {
    if (root.scope.type === "global") {
      return entry.scope.type === "global";
    }
    return (
      entry.scope.type === "project" &&
      entry.scope.projectPath === root.scope.projectPath
    );
  }

  private removeRootEntries(rootId: string): void {
    this.state.updateState((store) => {
      for (const [key, entry] of Object.entries(store)) {
        const entryRootId =
          entry.scope.type === "global" ? "global" : entry.scope.projectPath;
        if (entryRootId === rootId) {
          delete store[key];
        }
      }
    });
  }

  private async scanRoot(root: SkillsRoot): Promise<SkillEntry[]> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(root.agentsSkillsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      log.warn("Failed to read skills dir", {
        dir: root.agentsSkillsDir,
        err,
      });
      return [];
    }

    const entries = await Promise.all(
      dirents.map((dirent) =>
        this.parseSkillDir(root, dirent).catch((err) => {
          log.warn("Failed to parse skill", { name: dirent.name, err });
          return null;
        }),
      ),
    );
    return entries.filter((entry) => entry !== null);
  }

  private async parseSkillDir(
    root: SkillsRoot,
    dirent: Dirent,
  ): Promise<SkillEntry | null> {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) return null;
    if (dirent.name.startsWith(".")) return null;

    const dirPath = path.join(root.agentsSkillsDir, dirent.name);
    const skillMdPath = path.join(dirPath, "SKILL.md");

    let stats: Awaited<ReturnType<typeof stat>>;
    let contents: string;
    try {
      [stats, contents] = await Promise.all([
        stat(skillMdPath),
        readFile(skillMdPath, "utf8"),
      ]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    const parsed = parseSkillMd(contents);
    const managedByRaw = getScalar(parsed, "managed-by");
    let managedBy: SkillEntry["managedBy"] =
      managedByRaw === "agent-ui"
        ? "app"
        : managedByRaw === "agent-ui-builtin"
          ? "builtin"
          : null;

    if (managedBy !== "builtin" && this.builtinSkillsRoot) {
      try {
        const dirStats = await lstat(dirPath);
        if (dirStats.isSymbolicLink()) {
          const target = path.resolve(
            root.agentsSkillsDir,
            await readlink(dirPath),
          );
          if (isInside(this.builtinSkillsRoot, target)) {
            managedBy = "builtin";
          }
        }
      } catch {
        // Treat as a regular skill if the link can't be inspected.
      }
    }

    let hasExtraFiles = false;
    try {
      const files = await readdir(dirPath);
      hasExtraFiles = files.some(
        (name) => name !== "SKILL.md" && name !== "agents",
      );
    } catch {
      // Directory disappeared mid-scan; SKILL.md read above already passed.
    }

    return {
      name: dirent.name,
      scope: root.scope,
      description: getScalar(parsed, "description") ?? "",
      body: parsed.body,
      userInvokeOnly: getBoolean(parsed, "disable-model-invocation"),
      managedBy,
      dirPath,
      hasExtraFiles,
      updatedAt: stats.mtimeMs,
    };
  }

  // ---------------------------------------------------------------------
  // Symlink sync (.agents/skills -> .claude/skills)

  private async syncLinks(
    root: SkillsRoot,
    entries: SkillEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      try {
        await this.ensureClaudeLink(root, entry.name);
      } catch (err) {
        log.warn("Failed to link skill into .claude/skills", {
          skill: entry.name,
          root: root.id,
          err,
        });
      }
    }
    await this.pruneClaudeLinks(root);
  }

  private linkTargetFor(root: SkillsRoot, name: string): string {
    const skillDir = path.join(root.agentsSkillsDir, name);
    return root.relativeLinks
      ? path.relative(root.claudeSkillsDir, skillDir)
      : skillDir;
  }

  private async ensureClaudeLink(
    root: SkillsRoot,
    name: string,
  ): Promise<void> {
    const linkPath = path.join(root.claudeSkillsDir, name);
    const target = this.linkTargetFor(root, name);

    try {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) {
        // A real directory/file with this name exists in .claude/skills.
        // Never delete user content — leave it and let it win.
        log.warn("Skipping skill link: non-symlink already exists", {
          linkPath,
        });
        return;
      }
      const existing = await readlink(linkPath);
      if (existing === target) return;
      const resolvedExisting = path.resolve(root.claudeSkillsDir, existing);
      const resolvedTarget = path.resolve(root.claudeSkillsDir, target);
      if (resolvedExisting === resolvedTarget) return;
      // Only replace links that point into this root's .agents/skills —
      // anything else is a user-managed link we shouldn't touch.
      if (!isInside(root.agentsSkillsDir, resolvedExisting)) {
        log.warn("Skipping skill link: foreign symlink already exists", {
          linkPath,
          existing,
        });
        return;
      }
      await unlink(linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    await mkdir(root.claudeSkillsDir, { recursive: true });
    await symlink(target, linkPath, "dir");
  }

  /** Remove dangling symlinks in .claude/skills that point into .agents/skills. */
  private async pruneClaudeLinks(root: SkillsRoot): Promise<void> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(root.claudeSkillsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const dirent of dirents) {
      if (!dirent.isSymbolicLink()) continue;
      const linkPath = path.join(root.claudeSkillsDir, dirent.name);
      try {
        const target = await readlink(linkPath);
        const resolved = path.resolve(root.claudeSkillsDir, target);
        if (!isInside(root.agentsSkillsDir, resolved)) continue;
        if (await pathExists(resolved)) continue;
        await unlink(linkPath);
        log.info("Removed dangling skill link", { linkPath, target });
      } catch (err) {
        log.warn("Failed to inspect skill link", { linkPath, err });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Mutations

  async createSkill(input: {
    scope: SkillScope;
    name: string;
    description: string;
    body: string;
    userInvokeOnly: boolean;
  }): Promise<SkillEntry> {
    const root = this.rootForScope(input.scope);
    const dirPath = path.join(root.agentsSkillsDir, input.name);

    if (await pathExists(dirPath)) {
      throw new Error(`Skill "${input.name}" already exists`);
    }

    await mkdir(dirPath, { recursive: true });
    const contents = serializeSkillMd(
      parseSkillMd(""),
      {
        name: input.name,
        description: input.description,
        "disable-model-invocation": input.userInvokeOnly ? true : null,
        "managed-by": "agent-ui",
      },
      input.body,
    );
    await writeFile(path.join(dirPath, "SKILL.md"), contents, "utf8");
    await this.writeOpenAiPolicy(dirPath, input.userInvokeOnly);

    await this.rescanRoot(root);
    const entry = this.state.state[dirPath];
    if (!entry) {
      throw new Error(`Failed to create skill "${input.name}"`);
    }
    return entry;
  }

  async updateSkill(input: {
    dirPath: string;
    description: string;
    body: string;
    userInvokeOnly: boolean;
  }): Promise<void> {
    const { entry, root } = this.requireEditableSkill(input.dirPath);

    const skillMdPath = path.join(entry.dirPath, "SKILL.md");
    const parsed = parseSkillMd(await readFile(skillMdPath, "utf8"));
    const contents = serializeSkillMd(
      parsed,
      {
        name: entry.name,
        description: input.description,
        "disable-model-invocation": input.userInvokeOnly ? true : null,
      },
      input.body,
    );
    await writeFile(skillMdPath, contents, "utf8");
    await this.writeOpenAiPolicy(entry.dirPath, input.userInvokeOnly);

    await this.rescanRoot(root);
  }

  async deleteSkill(input: { dirPath: string }): Promise<void> {
    const { entry, root } = this.requireEditableSkill(input.dirPath);

    const stats = await lstat(entry.dirPath);
    if (stats.isSymbolicLink()) {
      await unlink(entry.dirPath);
    } else {
      await rm(entry.dirPath, { recursive: true, force: true });
    }

    await this.rescanRoot(root);
  }

  private requireEditableSkill(dirPath: string): {
    entry: SkillEntry;
    root: SkillsRoot;
  } {
    const entry = this.state.state[dirPath];
    if (!entry) {
      throw new Error("Skill not found");
    }
    if (entry.managedBy === "builtin") {
      throw new Error("Built-in skills are managed by the app");
    }
    const root = this.rootForScope(entry.scope);
    if (!isInside(root.agentsSkillsDir, entry.dirPath)) {
      throw new Error("Skill path is outside the skills directory");
    }
    return { entry, root };
  }

  private async writeOpenAiPolicy(
    dirPath: string,
    userInvokeOnly: boolean,
  ): Promise<void> {
    const policyPath = path.join(dirPath, OPENAI_POLICY_FILE);
    if (userInvokeOnly) {
      await mkdir(path.dirname(policyPath), { recursive: true });
      await writeFile(policyPath, OPENAI_POLICY_CONTENTS, "utf8");
      return;
    }
    try {
      const existing = await readFile(policyPath, "utf8");
      // Only remove the file if it's the one we generate — a hand-written
      // agents/openai.yaml may contain other configuration.
      if (existing.includes("allow_implicit_invocation")) {
        await unlink(policyPath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

// -------------------------------------------------------------------------
// oRPC router

export const skillsRouter = {
  create: procedure
    .input(
      z.object({
        scope: skillScopeSchema,
        name: skillNameSchema,
        description: z.string().trim().min(1),
        body: z.string(),
        userInvokeOnly: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      return await context.skillsService.createSkill(input);
    }),
  update: procedure
    .input(
      z.object({
        dirPath: z.string().min(1),
        description: z.string().trim().min(1),
        body: z.string(),
        userInvokeOnly: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      await context.skillsService.updateSkill(input);
    }),
  delete: procedure
    .input(z.object({ dirPath: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      await context.skillsService.deleteSkill(input);
    }),
  rescan: procedure.handler(async ({ context }) => {
    await context.skillsService.rescanAll();
  }),
};
