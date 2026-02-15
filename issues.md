# Pending Changes Summary

## Overview

Major architectural refactor: **IPC + Valtio** replaced with **oRPC + Immer patches + Zustand**. Net result: **-6,100 lines** across 49 files. The entire communication layer between main and renderer has been rewritten.

---

## What Changed

### 1. IPC Layer → oRPC

**Removed:**
- `CLAUDE_IPC_CHANNELS` constant map (20+ hand-wired channel strings)
- Manual `ipcMain.handle` / `ipcRenderer.invoke` wiring in `index.ts` and `preload/index.ts`
- `window.claude` preload bridge with typed `invoke/send/on` wrappers
- `src/renderer/src/lib/ipc.ts` (claudeIpc helper)

**Added:**
- `src/main/orpc.ts` — oRPC server procedure factory with `Services` context
- `src/main/orpc-router.ts` — Centralized router composing `getUsage`, `projects`, `fs`, `stateSync`, `sessions` sub-routers
- `src/renderer/src/orpc-client.ts` — MessageChannel-based oRPC client with TanStack Query integration
- `src/preload/index.ts` — Simplified to forward MessagePort from renderer to main (no more typed bridge)

Each service now co-locates its own router procedures (e.g., `claudeSessionsRouter` in `session-service.ts`, `projectsRouter` in `project-service.ts`, `stateSyncRouter` in `state-orchestrator.ts`).

### 2. State Management: Valtio → Immer + Zustand

**Removed:**
- Valtio `proxy()` / `snapshot()` / `subscribe()` pattern
- Custom op-based state sync (`ClaudeStateOp`, path-based resolve/apply)
- `getServiceStateSnapshot()` helper
- `src/renderer/src/services/session-store.ts` (manual IPC-driven store)
- `src/renderer/src/services/use-terminal-session.ts` (useSyncExternalStore binding)
- `src/renderer/src/services/terminal-session-actions.ts` (action dispatch layer)

**Added:**
- `src/shared/service-state.ts` — Immer `produceWithPatches` for state updates, typed event dispatch
- `src/shared/typed-event-target.ts` — Type-safe EventTarget wrapper for service events
- `src/renderer/src/services/state-sync-client.ts` — Zustand store bootstrapped from oRPC snapshot, applies Immer patches from event stream with version gating and resync fallback
- `src/renderer/src/components/sync-state-provider.tsx` — React Context providing `useAppState(selector)` hook

State updates now flow: service `updateState()` → Immer patch → `StateOrchestrator` → oRPC event stream → renderer Zustand store.

### 3. Session Orchestrator → Domain Services

**Removed:**
- `src/main/session-orchestrator.ts` (871 lines — monolithic session lifecycle manager)
- `src/main/claude-session.ts` (377 lines — PTY wrapper with shell/args logic)
- `src/main/claude-project-store.ts`, `claude-session-projects.ts`, `claude-session-snapshot-store.ts`, `claude-session-snapshot-utils.ts`, `claude-usage-service.ts`

**Added:**
- `src/main/session-service.ts` — `SessionsServiceNew` class owning session lifecycle, terminal creation, activity monitoring, title generation, and snapshot state
- `src/main/terminal-session.ts` — Functional PTY wrapper using `createTerminalSession()` factory, with `StringRingBuffer` for output buffering and deferred-promise-based graceful shutdown
- `src/main/project-service.ts` — Project CRUD as standalone service with own state + router
- `src/main/session-state-file-manager.ts` — NDJSON state file create/cleanup
- `src/main/session-title-manager.ts` — One-shot title generation with deduplication
- `src/main/create-services.ts` — Composition root wiring all services together
- `src/main/debounce-runner.ts` — Reusable debounce utility for persistence
- `src/main/claude-usage.ts` — Usage data fetcher (extracted from service class)
- `src/main/fs.router.ts` — File system operations (folder select, open log/plugin/session folders)

### 4. Shared Utilities

**Added:**
- `src/shared/string-ring-buffer.ts` — Chunked circular buffer (replaces `SessionOutputRingBuffer` that was renderer-only)
- `src/shared/utils.ts` — `DeferredPromise`, `tryCatch`, `shellQuote` helpers
- `src/shared/typed-event-target.ts` — Generic typed event dispatch

**Removed:**
- `src/renderer/src/services/session-output-ring-buffer.ts` (moved to shared)
- `src/shared/claude-schemas.ts` (Zod schemas inlined into `claude-types.ts`)

### 5. Renderer Components

- **session-sidebar.tsx** — Rewired from `useTerminalSession()` to `useAppState()` + `useMutation` for oRPC calls. Added `stopping` indicator state.
- **session-page.tsx** — Uses oRPC for session write/resize/stop instead of IPC bridge.
- **new-session-dialog.tsx** — Uses oRPC mutations + Zustand dialog store.
- **settings-dialog.tsx** — Uses oRPC for folder operations + Zustand store.
- **project-defaults-dialog.tsx** — Uses oRPC mutations.
- **usage-panel.tsx** — Uses oRPC query instead of IPC.
- **App.tsx** — Wraps app in `SyncStateProvider` + `QueryClientProvider`.
- **main.tsx** — Bootstraps oRPC client and sync state store before React render.

### 6. Keyboard Shortcuts

**Removed:**
- `src/renderer/src/hooks/use-keyboard-shortcuts.ts` (monolithic hook)

**Added:**
- `src/renderer/src/hooks/use-keyboard-shortcut.ts` — Single-shortcut hook (reusable primitive)
- `src/renderer/src/hooks/use-app-shortcuts.ts` — App-level shortcuts (Cmd+N, Cmd+J, Cmd+Backspace) with smart session-switching algorithm (tiered by activity state + cwd proximity)

### 7. Types

- `src/shared/claude-types.ts` — Reduced from ~220 lines to ~46. Removed all IPC channel constants, state key maps, op types, and snapshot interfaces. Now just Zod enum schemas for `ClaudeSessionStatus`, `ClaudeActivityState`, `ClaudeModel`, `ClaudePermissionMode`.
- Session snapshot shape now lives in `session-service.ts` as the service's internal state type.

### 8. Build & Dependencies

- `package.json` — Added `@orpc/client`, `@orpc/server`, `@orpc/client/message-port`, `@tanstack/react-query`, `immer`. Removed `valtio`.
- `vite.config.ts` — Added `@shared` alias to main and preload builds (was renderer-only).

### 9. Tests

**Removed (with deleted source):**
- `test/main/claude-activity-monitor.spec.ts`
- `test/main/claude-session.spec.ts`
- `test/main/claude-session-snapshot-store.spec.ts`
- `test/main/session-orchestrator.spec.ts`
- `test/renderer/session-output-ring-buffer.spec.ts`
- `test/renderer/session-store.spec.ts`

**Added:**
- `test/main/session-service.spec.ts` — Session lifecycle, title gen, fork, state file ordering
- `test/main/session-state-file-manager.spec.ts` — File create/cleanup
- `test/main/session-title-manager.spec.ts` — One-shot trigger, forget, error resilience
- `test/main/persistence-orchestrator.spec.ts` — Hydration, schema merge, debounced writes
- `test/shared/string-ring-buffer.spec.ts` — Buffer overflow, clear, validation

**Modified:**
- `test/main/state-orchestrator.spec.ts` — Adapted to new Immer-based state updates
- `test/renderer/state-sync-client.spec.ts` — Rewritten for Zustand + oRPC event stream
- `test/renderer/terminal-session-selectors.spec.ts` — Updated for new state shape

---

## Potential Issues to Verify

1. **CLAUDE.md is stale** — Still references deleted files (`session-store.ts`, `use-terminal-session.ts`, `claude-session.ts`, old IPC architecture). Needs full update to match new architecture.
2. **Test coverage gaps** — No tests for `create-services.ts` composition, `orpc-router.ts` integration, `fs.router.ts`, `project-service.ts`, or `use-app-shortcuts.ts` smart switching logic.
3. **`stopping` status** — New terminal status added to sidebar indicators but verify it propagates correctly through `TerminalSession` → `SessionService` → state sync → renderer.
4. **MessageChannel lifecycle** — oRPC client uses `window.postMessage` with transferable port. Verify this works reliably across window reload during dev.
5. **Immer patch versioning** — Renderer uses sequential version gating with resync fallback. Verify no race conditions when multiple rapid state updates arrive.
6. **Ring buffer moved to shared** — `StringRingBuffer` is now in shared but only used in main process (`terminal-session.ts`). Verify no renderer import of old path remains.
7. **Session snapshot shape** — No longer in shared types. Renderer relies on inferred types from oRPC router. Verify type safety across the boundary.
8. **`docs/wouter.md` deleted** — Confirm wouter is still a dependency and the doc removal is intentional.
9. **`test/screenshots/e2e.png` deleted** — Confirm no E2E tests reference this file.
10. **Graceful shutdown** — `terminal-session.ts` has SIGTERM → SIGKILL escalation with timeouts. Verify the `DeferredPromise` timeout + disposable cleanup doesn't leak in edge cases.
