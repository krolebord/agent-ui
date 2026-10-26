import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeProject } from "@shared/claude-types";
import {
  type InboxStatus,
  isSessionSettled,
  isSessionSnoozed,
  resolveInboxStatus,
} from "@shared/session-lifecycle";
import type {
  SessionMemoryAgent,
  SessionMemoryState,
} from "@shared/session-memory";
import type { Services } from "../../create-services";
import log from "../../logger";
import { excerpt } from "../../session-memory/display";
import { SessionMemoryUnavailableError } from "../../session-memory/embedding-pipeline";
import type { SessionMemoryDb } from "../../session-memory/store/database";
import {
  type ConversationRecord,
  findConversationIdsByNativeIds,
} from "../../session-memory/store/queries";
import type { Session } from "../../sessions/state";
import { textResult } from "../define-tool";
import type { McpRequestContext } from "../session-token";

export interface PastSessionsServices {
  sessionMemory: Pick<
    Services["sessionMemory"],
    "isEnabled" | "getState" | "getDatabase" | "searchSessionMemory"
  >;
  projectsState: { state: readonly ClaudeProject[] };
  sessions: { state: { state: Readonly<Record<string, Session>> } };
}

export const SESSION_MEMORY_DISABLED_MESSAGE =
  "Session memory is disabled in Agent UI, so past sessions cannot be " +
  "searched. The user can enable it on the Memory page in Agent UI.";

export function isPastSessionsAvailable(
  services: Pick<PastSessionsServices, "sessionMemory">,
): boolean {
  return services.sessionMemory.isEnabled();
}

export class PastSessionsInputError extends Error {}

export function errorResult(text: string): CallToolResult {
  return { ...textResult(text), isError: true };
}

/** Turns every failure into a text result the agent can act on. */
export async function runPastSessionsTool(
  toolName: string,
  services: Pick<PastSessionsServices, "sessionMemory">,
  run: () => Promise<string>,
): Promise<CallToolResult> {
  if (!services.sessionMemory.isEnabled()) {
    return errorResult(SESSION_MEMORY_DISABLED_MESSAGE);
  }
  try {
    return textResult(await run());
  } catch (error) {
    if (error instanceof PastSessionsInputError) {
      return errorResult(error.message);
    }
    if (error instanceof SessionMemoryUnavailableError) {
      return errorResult(
        `${error.message}. Use list_past_sessions and read_past_session instead.`,
      );
    }
    log.error("Past sessions MCP tool failed", { toolName, error });
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(
      `${toolName} failed: ${message}. Retry once; if it keeps failing, tell the user.`,
    );
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_UNITS_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: DAY_MS,
  w: 7 * DAY_MS,
};
const RELATIVE_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(h|hours?|d|days?|w|weeks?)(?:\s+ago)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export const DATE_FORMATS_HINT =
  "Use YYYY-MM-DD (local day), an ISO datetime such as 2026-10-05T14:00 or " +
  "2026-10-05T14:00Z, today, yesterday, or an age such as 36h, 7d, 2w.";

function localDay(
  year: number,
  month: number,
  day: number,
  bound: "start" | "end",
): number | null {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  if (bound === "end") {
    date.setHours(23, 59, 59, 999);
  }
  return date.getTime();
}

/**
 * Date-only values and datetimes without an offset are read in the server's
 * local timezone. A date-only `end` bound covers that whole day.
 */
export function parseDateBound(
  raw: string,
  bound: "start" | "end",
  now: number,
): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "now") {
    return now;
  }
  if (value === "today" || value === "yesterday") {
    const date = new Date(now);
    if (value === "yesterday") {
      date.setDate(date.getDate() - 1);
    }
    return localDay(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      bound,
    );
  }
  const relative = RELATIVE_PATTERN.exec(value);
  if (relative) {
    const unit = RELATIVE_UNITS_MS[relative[2]?.[0] ?? ""];
    return unit === undefined ? null : now - Number(relative[1]) * unit;
  }
  const date = DATE_PATTERN.exec(value);
  if (date) {
    return localDay(Number(date[1]), Number(date[2]), Number(date[3]), bound);
  }
  const datetime = DATETIME_PATTERN.exec(raw.trim());
  if (!datetime) {
    return null;
  }
  const [, year, month, day, hour, minute, second, millis, zone] = datetime;
  if (zone) {
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}.${(millis ?? "0").padEnd(3, "0")}${zone.toUpperCase()}`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const dayStart = localDay(Number(year), Number(month), Number(day), "start");
  if (dayStart === null || Number(hour) > 23 || Number(minute) > 59) {
    return null;
  }
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
    Number((millis ?? "0").padEnd(3, "0")),
  ).getTime();
}

export interface ActiveWindow {
  activeFrom?: number;
  activeTo?: number;
}

export function resolveActiveWindow(
  input: { after?: string; before?: string },
  now: number,
): ActiveWindow {
  const window: ActiveWindow = {};
  if (input.after !== undefined && input.after.trim() !== "") {
    const parsed = parseDateBound(input.after, "start", now);
    if (parsed === null) {
      throw new PastSessionsInputError(
        `Could not parse after="${input.after}". ${DATE_FORMATS_HINT}`,
      );
    }
    window.activeFrom = parsed;
  }
  if (input.before !== undefined && input.before.trim() !== "") {
    const parsed = parseDateBound(input.before, "end", now);
    if (parsed === null) {
      throw new PastSessionsInputError(
        `Could not parse before="${input.before}". ${DATE_FORMATS_HINT}`,
      );
    }
    window.activeTo = parsed;
  }
  if (
    window.activeFrom !== undefined &&
    window.activeTo !== undefined &&
    window.activeFrom > window.activeTo
  ) {
    throw new PastSessionsInputError(
      `after (${formatLocalTime(window.activeFrom)}) is later than before (${formatLocalTime(window.activeTo)}).`,
    );
  }
  return window;
}

export function describeFilters(
  filters: {
    agent?: string;
    project?: ProjectFilter;
    relation?: string;
    inbox?: string;
  } & ActiveWindow,
): string | null {
  const parts: string[] = [];
  if (filters.agent) parts.push(`agent ${filters.agent}`);
  if (filters.project) parts.push(filters.project.label);
  if (filters.activeFrom !== undefined || filters.activeTo !== undefined) {
    parts.push(
      `active ${filters.activeFrom !== undefined ? formatLocalTime(filters.activeFrom) : "any time"} → ${filters.activeTo !== undefined ? formatLocalTime(filters.activeTo) : "now"}`,
    );
  }
  if (filters.relation) parts.push(filters.relation);
  if (filters.inbox) parts.push(filters.inbox);
  return parts.length > 0 ? `Filters: ${parts.join(" · ")}.` : null;
}

export interface ProjectFilter {
  projectPath?: string;
  cwdPrefix?: string;
  label: string;
}

function projectName(project: ClaudeProject): string {
  return project.alias?.trim() || path.basename(project.path);
}

function filterForProject(
  project: ClaudeProject | undefined,
  dir: string,
): ProjectFilter {
  if (project && !project.worktreeOriginPath) {
    return { projectPath: project.path, label: `project ${project.path}` };
  }
  return { cwdPrefix: dir, label: `cwd under ${dir}` };
}

function isInsideDir(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}${path.sep}`);
}

function findProjectForCwd(
  dir: string,
  projects: readonly ClaudeProject[],
): ClaudeProject | undefined {
  return projects
    .filter((candidate) => isInsideDir(dir, candidate.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** Mirrors how indexed conversations are linked to a project or cwd. */
export function sessionMatchesProjectFilter(
  session: Session,
  filter: ProjectFilter,
  projects: readonly ClaudeProject[],
): boolean {
  const dir = path.resolve(session.startupConfig.cwd);
  if (filter.cwdPrefix !== undefined && !isInsideDir(dir, filter.cwdPrefix)) {
    return false;
  }
  if (filter.projectPath !== undefined) {
    const project = findProjectForCwd(dir, projects);
    return (
      (project?.worktreeOriginPath ?? project?.path) === filter.projectPath
    );
  }
  return true;
}

function resolveCurrentProjectFilter(
  currentCwd: string | null,
  projects: readonly ClaudeProject[],
): ProjectFilter {
  if (!currentCwd) {
    throw new PastSessionsInputError(
      'project "current" only works from an Agent UI session; pass a project name or absolute path instead.',
    );
  }
  const dir = path.resolve(currentCwd);
  const project = findProjectForCwd(dir, projects);
  if (!project) {
    return { cwdPrefix: dir, label: `cwd under ${dir}` };
  }
  const projectPath = project.worktreeOriginPath ?? project.path;
  return { projectPath, label: `current project ${projectPath}` };
}

export function currentSessionCwd(
  sessions: Readonly<Record<string, Session>>,
  context: McpRequestContext,
): string | null {
  const session = context.sessionId ? sessions[context.sessionId] : undefined;
  return session?.startupConfig.cwd ?? null;
}

/**
 * A registered project path (or its name) matches every conversation linked
 * to it, worktrees included; any other path matches by working directory.
 */
export function resolveProjectFilter(
  raw: string,
  projects: readonly ClaudeProject[],
  currentCwd: string | null = null,
): ProjectFilter {
  const value = raw.trim();
  if (value.toLowerCase() === "current") {
    return resolveCurrentProjectFilter(currentCwd, projects);
  }
  const expanded =
    value === "~" || value.startsWith("~/")
      ? path.join(homedir(), value.slice(1))
      : value;
  if (path.isAbsolute(expanded)) {
    const dir = path.resolve(expanded);
    return filterForProject(
      projects.find((project) => project.path === dir),
      dir,
    );
  }
  const name = value.toLowerCase();
  const matches = projects.filter(
    (project) =>
      projectName(project).toLowerCase() === name ||
      path.basename(project.path).toLowerCase() === name,
  );
  const origins = matches.filter((project) => !project.worktreeOriginPath);
  const candidates = origins.length > 0 ? origins : matches;
  if (candidates.length === 1 && candidates[0]) {
    return filterForProject(candidates[0], candidates[0].path);
  }
  if (candidates.length > 1) {
    throw new PastSessionsInputError(
      `Project name "${value}" is ambiguous; pass one of these paths instead: ${candidates.map((project) => project.path).join(", ")}`,
    );
  }
  const known = projects
    .filter((project) => !project.worktreeOriginPath)
    .map(projectName);
  throw new PastSessionsInputError(
    `No Agent UI project is named "${value}". ` +
      (known.length > 0
        ? `Known projects: ${known.slice(0, 30).join(", ")}. `
        : "") +
      "Pass an absolute path to filter by working directory instead.",
  );
}

function nativeIdsOf(
  session: Session,
): { agent: SessionMemoryAgent; nativeIds: string[] } | null {
  switch (session.type) {
    case "claude-local-terminal":
      return { agent: "claude", nativeIds: [session.sessionId] };
    case "codex-local-terminal":
      return {
        agent: "codex",
        nativeIds: [
          ...(session.codexSessionId ? [session.codexSessionId] : []),
          ...Object.keys(session.subagentsByThreadId ?? {}),
        ],
      };
    case "cursor-agent":
      return {
        agent: "cursor",
        nativeIds: session.cursorChatId ? [session.cursorChatId] : [],
      };
    case "local-terminal":
    case "worktree-setup":
      return null;
    default: {
      const exhaustive: never = session;
      return exhaustive;
    }
  }
}

export function sessionMemoryAgentOf(
  session: Session,
): SessionMemoryAgent | null {
  return nativeIdsOf(session)?.agent ?? null;
}

/**
 * The calling agent's live conversation and its subagents. Earlier
 * conversations of the same Agent UI session stay visible: they are past work.
 */
export async function resolveOwnConversationIds(
  db: SessionMemoryDb,
  sessions: Readonly<Record<string, Session>>,
  context: McpRequestContext,
): Promise<number[]> {
  const session = context.sessionId ? sessions[context.sessionId] : undefined;
  const own = session ? nativeIdsOf(session) : null;
  if (!own) {
    return [];
  }
  return await findConversationIdsByNativeIds(db, own.agent, own.nativeIds);
}

export function coverageNote(state: SessionMemoryState): string | null {
  const notes: string[] = [];
  if (state.lastSyncFinishedAt === null) {
    notes.push(
      state.syncStatus === "syncing"
        ? "The first index sync is still running; results are incomplete."
        : "No index sync has finished yet; results may be incomplete.",
    );
  } else if (state.syncStatus === "error" && state.lastError) {
    notes.push(`The last index sync failed (${state.lastError}).`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

export function searchCoverageNote(state: SessionMemoryState): string | null {
  const notes: string[] = [];
  const base = coverageNote(state);
  if (base) {
    notes.push(base);
  }
  const embedding = state.embedding;
  const missing = embedding.chunksTotal - embedding.chunksEmbedded;
  if (missing > 0) {
    notes.push(
      `Embedded ${formatCount(embedding.chunksEmbedded)} / ${formatCount(embedding.chunksTotal)} chunks, newest first; older sessions may be missing (list_past_sessions covers them).`,
    );
  }
  if (embedding.status === "paused") {
    notes.push("Embedding is paused by the user.");
  } else if (embedding.status === "downloading") {
    notes.push("The embedding model is still downloading.");
  } else if (embedding.status === "error") {
    notes.push(
      `Embedding stopped with an error${embedding.lastError ? ` (${embedding.lastError})` : ""}.`,
    );
  }
  return notes.length > 0 ? `Coverage: ${notes.join(" ")}` : null;
}

export function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function formatLocalTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatActiveRange(
  startedAt: number | null,
  updatedAt: number | null,
): string {
  if (startedAt === null && updatedAt === null) {
    return "unknown dates";
  }
  if (startedAt === null || updatedAt === null || startedAt === updatedAt) {
    return formatLocalTime((startedAt ?? updatedAt) as number);
  }
  const start = formatLocalTime(startedAt);
  const end = formatLocalTime(updatedAt);
  return start.slice(0, 10) === end.slice(0, 10)
    ? `${start}–${end.slice(11)}`
    : `${start} → ${end}`;
}

export function timezoneLabel(now: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date(now).getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${zone}, UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatLocation(
  conversation: Pick<ConversationRecord, "cwd" | "projectPath" | "gitBranch">,
): string {
  const parts: string[] = [];
  if (conversation.cwd) {
    parts.push(
      conversation.projectPath && conversation.projectPath !== conversation.cwd
        ? `cwd ${conversation.cwd} (project ${conversation.projectPath})`
        : `cwd ${conversation.cwd}`,
    );
  } else if (conversation.projectPath) {
    parts.push(`project ${conversation.projectPath}`);
  }
  if (conversation.gitBranch) {
    parts.push(`branch ${conversation.gitBranch}`);
  }
  return parts.join(" · ");
}

const INBOX_STATUS_LABELS: Record<InboxStatus, string> = {
  approval: "waiting for approval",
  input: "waiting for input",
  working: "working",
  failed: "failed",
  ready: "ready",
};

export function formatInboxState(session: Session, now: number): string {
  if (isSessionSnoozed(session, now) && session.snoozedUntil !== undefined) {
    return `snoozed until ${formatLocalTime(session.snoozedUntil)}`;
  }
  if (isSessionSettled(session)) {
    return "settled";
  }
  return `active, ${INBOX_STATUS_LABELS[resolveInboxStatus(session)]}`;
}

export function formatAgentUiSession(
  sessionId: string | null,
  sessions: Readonly<Record<string, Session>>,
  now: number,
): string | null {
  if (!sessionId) {
    return null;
  }
  const session = sessions[sessionId];
  if (!session) {
    return `agent-ui session ${sessionId}`;
  }
  const inbox = `inbox: ${formatInboxState(session, now)}`;
  return session.title
    ? `agent-ui session "${excerpt(session.title, 60)}" (${sessionId}) · ${inbox}`
    : `agent-ui session ${sessionId} · ${inbox}`;
}

export function formatRelation(
  conversation: Pick<
    ConversationRecord,
    "relation" | "parentConversationId" | "parentNativeId"
  >,
): string | null {
  if (conversation.relation === "main") {
    return null;
  }
  const parent =
    conversation.parentConversationId !== null
      ? `conversation ${conversation.parentConversationId}`
      : conversation.parentNativeId
        ? conversation.parentNativeId
        : "unknown parent";
  return `${conversation.relation} of ${parent}`;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}
