## Commands

```bash
pnpm dev              # Start dev server with hot reload
pnpm build            # TypeScript check + Vite build
pnpm test             # Run all tests (Vitest)
pnpm exec vitest run test/main/session-service.spec.ts  # Run single test file
pnpm exec vitest --watch   # Watch mode
pnpm format           # Lint and format with Biome
pnpm typecheck        # TypeScript validation only
pnpm app:dist:mac     # Build and package macOS DMG/ZIP
```

## Architecture

Electron app for managing Claude CLI sessions. Three process layers: **main** (Node/Electron), **preload** (secure bridge), **renderer** (React).

### IPC: oRPC over MessageChannel

Instead of Electron's built-in IPC, the app uses **oRPC** (`@orpc/server` + `@orpc/client`) over a `MessageChannel` port pair. The preload script forwards the server port from renderer to main — no Node APIs are exposed to the renderer.

- **Main**: `src/main/orpc.ts` defines typed procedures with a `Services` context. `src/main/orpc-router.ts` composes sub-routers from service modules (sessions, projects, fs, stateSync).
- **Renderer**: `src/renderer/src/orpc-client.ts` creates the client and wraps it with `createTanstackQueryUtils` for TanStack Query integration.
- Calling RPCs: `orpc.sessions.startSession.call({ ... })`. Event streams use `consumeEventIterator`.

### State Sync: Immer patches → Event streams → Zustand

State flows from main to renderer via JSON Patches:

1. `defineServiceState()` (`src/shared/service-state.ts`) creates Immer-based state containers that emit typed patch events on update.
2. `StateOrchestrator` (`src/main/state-orchestrator.ts`) aggregates service states, scopes patches by service key, tracks versions, and exposes an async iterator for subscribers.
3. `state-sync-client.ts` (renderer) bootstraps by fetching a full snapshot, then applies incremental patches to a Zustand store with version gating and re-sync fallback.
4. Components consume state via `useAppState(selector)` from the `SyncStateProvider` context.

### Persistence

`PersistenceOrchestrator` registers `ServiceState` instances with Zod schemas, debounces writes (75ms default) to `electron-store`, and hydrates state on boot.

### Services Lifecycle

`create-services.ts` initializes all services (plugin, session state file manager, persistence, project/session states, state orchestrator) and returns a services object with a `shutdown()` hook. Shutdown flushes pending persistence and aborts subscriptions via `disposeSignal`.

### Terminal

xterm.js in the renderer with `node-pty` spawning in main. `TerminalSession` wraps PTY with input/output handling and activity monitoring.

## Key Conventions

- **Biome** for linting/formatting (no ESLint). 2-space indents.
- **Zod 4** for runtime validation schemas (`src/shared/claude-schemas.ts`).
- **Path aliases**: `@renderer` → `src/renderer/src`, `@shared` → `src/shared`.
- **shadcn/ui** components in `src/renderer/src/components/ui/`.
- **Tailwind CSS 4** for styling (via Vite plugin).
- Tests live in `test/` mirroring `src/` structure. Tests use `vi.hoisted()` for module-level mocks.
- **Lefthook** for git pre-commit hooks.
