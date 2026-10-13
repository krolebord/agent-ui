# Pending changes: searchable session memory

**Branch:** `feat/session-memory`  
**Working tree:** nothing is staged. All of this is unstaged edits plus untracked trees.

This branch adds an optional index of **past Claude, Codex, and Cursor sessions** so the app (and MCP tools) can search them by meaning, not by scraping a live PTY.

It is a large, self-contained feature sitting next to existing session managers. Usage history still owns token/cost parsing; session memory owns discovery, linking, chunking, and embeddings.

---

## What it does

When enabled, the main process discovers transcript files on disk, parses them into conversations and turns, links related sessions (main / subagent / fork), stores the index in SQLite, then embeds chunks with a local ONNX model. Search is cosine distance over `sqlite-vec`.

Agents covered: `claude`, `codex`, `cursor` (`src/shared/session-memory.ts`).

---

## Architecture

### Transcript discovery and parsing

`src/main/agent-transcripts/` is the shared I/O layer: roots (`~/.claude/projects`, `~/.codex/sessions`, `~/.cursor/projects` + `chats`), JSON/JSONL helpers, file listing, Codex session-meta (including fork detection).

`src/main/session-memory/parsers/` walks those roots, versions the parser, and turns files into turns plus generated text. Per-agent parsers live next to `discovery.ts` / `read.ts`. Claude forks are a dedicated pass (`claude-forks.ts`).

### SQLite + vectors

A separate DB: `<userData>/session-memory.sqlite3` (`store/database.ts`). Kysely + better-sqlite3, numbered migrations (`0001_create_index`, `0002_create_chunks`). `sqlite-vec` is loaded when possible; if it is not, the text index still works and vector search reports unsupported.

### Sync pipeline

`SessionMemoryService` (`service.ts`) is started from `create-services.ts`, registered in `serviceStates`, and disposed on shutdown.

Sync (`sync.ts`) is periodic (first run after 30s, then every 10 minutes) and can be requested immediately. It discovers sources, skips unchanged files, writes parse outcomes, marks missing sources, then relinks conversations.

### Linking

`linking.ts` classifies conversations as `main`, `subagent`, or `fork`, using git dir inspection (repo vs worktree) plus agent-native IDs and live session state. That relation is a first-class search filter.

### Chunking and embedding

Turns are split into embeddable documents (`chunking.ts`, `CHUNKER_VERSION = 1`) with token limits from the embedder.

The embedding stack:

- `embedding/embedder.ts` — interface
- `embedding/runtime.ts` — `onnxruntime-node` + `@huggingface/tokenizers`
- `embedding/model-files.ts` — download/cache under userData
- `embedding/worker.ts` + `ipc.ts` — child-process worker
- `embedding/embedding-host.ts` — host that forks the worker
- `embedding-pipeline.ts` — progress, pause, retry, settling window

Headless Vite emits a second entry `embedding-worker.js` (`vite.headless.config.ts`). In `create-services.ts`, the real `EmbeddingHost` is wired **only when `host.mode === "headless"`**. Electron currently omits the pipeline, so search can report `unsupported` there.

### Search

`store/search.ts` + `store/queries.ts`. Hits include chunk text, turn ordinal, conversation metadata (agent, native id, cwd, project, git branch, relation, optional agent-ui session id). Filters: agent, project path, cwd prefix, activity window, relation, exclude conversation ids. Optional `groupBy: conversation` keeps the best chunk per conversation.

---

## Settings (off by default)

Persisted under `appSettings.sessionMemory`:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | No sync / no search until the user turns it on |
| `embeddingPaused` | `false` | Index can still sync; embedding work stops |

Live UI state is a separate `sessionMemory` service state: sync status, counts by source status and agent, embedding progress (download, chunks/min, ETA, pending vs settling turns).

---

## Surfaces

**Memory sidebar page** — new nav id `"memory"` (`sidebar-nav.ts`), `memory-page.tsx`, toggle in the sidebar, session page wiring. View helpers in `session-memory-view.ts`.

**oRPC** (`sessionMemoryRouter` on `orpc-router.ts`):

- `setEnabled`
- `syncNow`
- `setEmbeddingPaused`
- `retryEmbedding`
- `search`

**MCP tools** (gated on enabled):

- `search_past_sessions`
- `list_past_sessions`
- `read_past_session`

Shared formatting/filter helpers live in `mcp/tools/past-sessions.ts`. `define-tool.ts` and the MCP server tests were updated for the new tools.

---

## Refactor: usage-history

`usage-history/transcripts.ts` and `transcript-reader.ts` now import from `agent-transcripts` (roots, JSON helpers, Codex session-meta) instead of keeping a private copy. Behavior should be the same; tests in `transcript-reader.spec.ts` were adjusted for the new imports.

---

## Tests

Untracked specs cover parsers (Claude / Codex / Cursor / discovery / text / tool inputs), store (database, queries, search), sync, linking, chunking, embedding host/IPC/runtime/model-files/pipeline, MCP past-sessions, agent-transcript helpers, and the renderer view helper. MCP `server.spec.ts` gained coverage for the new tools.

---

## Key new trees

```
src/main/agent-transcripts/     shared transcript I/O
src/main/session-memory/        service, parsers, store, linking, chunking, embedding
src/main/mcp/tools/             search / list / read past sessions
src/renderer/src/components/memory-page.tsx
src/shared/session-memory.ts
test/main/{agent-transcripts,session-memory,mcp/tools}/
```

**Deps added:** `onnxruntime-node`, `sqlite-vec`, `@huggingface/tokenizers`.

**Modified glue:** `package.json` / lockfile, `app-settings.ts`, `create-services.ts`, `orpc-router.ts`, MCP tool index, sidebar + session page, `vite.headless.config.ts`.
