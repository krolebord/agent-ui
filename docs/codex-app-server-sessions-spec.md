# Codex App Server Sessions Spec

## Goal
Add a third session type, `codex-app-server`, that runs Codex via `codex app-server` (JSON-RPC) while preserving the current app architecture:
- main process owns process/network access
- renderer uses typed oRPC methods and state-sync patches
- sessions remain grouped by project path and persisted across restarts

## Scope
In scope:
- Start/resume/stop Codex threads
- Stream Codex turn/item events into session state and UI
- Handle server-initiated approval and user-input requests
- Persist Codex session metadata

Out of scope (phase 1):
- Rich Codex UI timeline (planned for phase 2)
- Session fork UX/behavior
- Cross-device thread sync
- Non-stdio transports (WS)

## Current Architecture Constraints
- Session types are a discriminated union in `src/main/sessions/state.ts`.
- Session routes are exposed under `orpc.sessions.*` in `src/main/orpc-router.ts`.
- UI behavior branches on `session.type` in:
  - `src/renderer/src/components/new-session-dialog.tsx`
  - `src/renderer/src/components/session-page.tsx`
  - `src/renderer/src/components/session-sidebar.tsx`
  - `src/renderer/src/hooks/use-app-shortcuts.ts`
- Session persistence is schema-validated and versioned in `src/main/create-services.ts`.

## Proposed Design

### 1) Main-process Codex App Server client
Add `src/main/codex-app-server-client.ts`:
- Lazily spawn one shared background process when first Codex session/action is requested:
  - `codex app-server --listen stdio://`
- Implement JSON-RPC 2.0 request/response handling:
  - `initialize` request
  - `initialized` notification
  - request id correlation map
  - server notifications fan-out by `threadId`
  - server-initiated requests (approval/input/tool call) that require renderer responses
- Auto-restart strategy on unexpected process exit:
  - mark active Codex sessions as `error`
  - allow explicit resume after restart
- Log protocol method names and errors with redaction.

Implementation note:
- Generate protocol types from installed CLI during development (`codex app-server generate-ts`) and commit a narrowed type surface into `src/main/codex-protocol/` to reduce drift risk.

### 2) Codex session manager and router
Add `src/main/sessions/codex.session.ts`:
- `codexSessionSchema = commonSessionSchema.extend({ ... })`
- `CodexSessionsManager` with:
  - `startSession`
  - `resumeSession`
  - `startTurn`
  - `interruptTurn` (maps to `turn/interrupt`; keep compatibility shim for `turn/cancel` if needed)
  - `steerTurn` (maps to `turn/steer`)
  - `enqueuePrompt` (default while running)
  - `deleteSession`
  - `subscribeToSessionEvents` (same async iterator pattern as existing sessions)
  - `respondToServerRequest` (approval / input answers)

Suggested stored shape:
- `type: "codex-app-server"`
- `startupConfig`: `{ cwd, model?, approvalPolicy?, sandboxMode?, reasoningEffort?, systemPrompt? }`
- `runtime`: `{ threadId, activeTurnId?, lastTokenUsage?, pendingRequest?, queuedPrompts? }`
- `bufferedOutput`: line-oriented JSON event log for phase-1 renderer

### 3) Session-state union and service wiring
Changes:
- `src/main/sessions/state.ts`: include `codexSessionSchema` in discriminated union.
- `src/main/create-services.ts`:
  - instantiate `CodexAppServerClient`
  - instantiate `CodexSessionsManager`
  - include it under returned `sessions`
  - dispose/flush on shutdown
- `src/main/orpc-router.ts`: add `sessions.codex`.

### 4) Renderer integration
Phase 1 UI path (lowest risk):
- Use a simple Codex session panel that renders plain JSON event lines.
- No terminal emulation for Codex in phase 1.
- Add case branches for `codex-app-server` in:
  - `src/renderer/src/components/new-session-dialog.tsx`
  - `src/renderer/src/components/session-page.tsx`
  - `src/renderer/src/components/session-sidebar.tsx`
  - `src/renderer/src/hooks/use-app-shortcuts.ts`

Also add:
- Approval/input modal driven by `pendingRequest` state.
- oRPC mutation to answer pending request.
- Prompt controls:
  - If turn is running, submit action defaults to `queue`.
  - Provide explicit secondary action to `send now (steer)`.

### 5) Mapping protocol events to app status
Suggested mapping:
- `turn/started` -> `running`
- `turn/completed` with success -> `idle`
- server request `item/*/requestApproval` -> `awaiting_approval`
- server request `item/tool/requestUserInput` -> `awaiting_user_response`
- `error` notification or failed turn -> `error`
- explicit interrupt / no active turn -> `idle`

Buffered output projection:
- append JSON line per incoming app-server event/notification
- include minimal local metadata (timestamp/sessionId) for readability

### 6) Auth strategy
Support initially:
- Managed auth mode (default Codex behavior): rely on local Codex auth state.
- Block starting/resuming Codex sessions when:
  - `codex` binary is not installed / not executable
  - `account/read` indicates unauthenticated or `requiresOpenaiAuth`
- Startup check with `account/read` and expose:
  - authenticated state
  - `requiresOpenaiAuth`

Deferred (phase 2+):
- Explicit login/logout flows (`account/login/start`, `account/logout`), ChatGPT token injection, and full external-auth mode UX.

### 7) Project defaults and model selection
Current project defaults are Claude-specific enums. Add parallel Codex defaults:
- `codexModel?: string`
- `codexApprovalPolicy?: "untrusted" | "on-request" | "on-failure" | "never"`
- `codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access"`
- `codexReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"`

Model source:
- Use `model/list` for dynamic options instead of static enum.
- Create-session UI for phase 1 exposes only `reasoningEffort` (other Codex settings deferred).

### 8) Persistence and migration
- Keep `STORAGE_SCHEMA_VERSION` unchanged.
- Ensure old sessions remain readable.
- Add schema-level catches for missing optional Codex fields.

### 9) Testing plan
Main tests:
- JSON-RPC transport: initialize handshake, request correlation, server request/response, reconnect behavior.
- Codex session manager: start/resume, turn lifecycle, queue/steer behavior, status transitions, pending approvals.

Renderer tests:
- session selectors grouping with mixed session types
- shortcut delete dispatch for `codex-app-server`
- approval modal state and response mutation

Integration tests:
- Fake app-server fixture process emitting deterministic notifications and server requests.

## Rollout Plan
1. Protocol client with lazy process init + minimal codex session start/turn stream.
2. Wire session type into sidebar/page/create dialog with plain JSON event rendering.
3. Add approvals + request_user_input flow and allow/deny actions.
4. Add queue-by-default prompt flow with optional steer-now action.
5. Add auth/install gating and reasoning-effort option in create session.
6. Optional phase 2: richer structured Codex UI timeline.

## Risks and Mitigations
- Protocol drift (`turn/cancel` vs `turn/interrupt`): gate by generated types and runtime feature detection.
- Server request deadlocks: add per-request timeout + clear cancel semantics.
- Multi-session concurrency on shared app-server: serialize per-thread mutations and isolate turn state by `threadId`.
- Large buffered output: reuse existing truncation strategy.
- Unsupported server requests (for example `item/tool/call`): ignore and log.

## Locked Decisions
1. Phase 1 Codex UI is plain JSON event output with simple prompt/approval controls; rich UI is phase 2.
2. One shared `codex app-server` process, lazy-initialized.
3. While running, prompt submission queues by default, with explicit steer-now action.
4. Approval default close behavior is `decline`.
5. Approval choices in phase 1 are only allow/deny (no allow-for-session).
6. Session fork is not implemented in phase 1.
7. Project defaults include Codex fields with `codex`-prefixed property names.
8. No auto-resume on app restart.
9. Do not start Codex sessions when unauthenticated or when Codex is not installed.
10. Use currently installed Codex version (no min-version enforcement in app logic).
11. Phase-1 create-session UI exposes only reasoning effort.
12. Unsupported server requests are ignored and logged.
