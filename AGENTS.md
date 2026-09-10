## Commands

```bash
pnpm dev              # Vite + Electron (macOS only)
pnpm build            # tsc --noEmit + Vite build
pnpm typecheck
pnpm format           # biome check --write .
pnpm test             # Vitest
pnpm build:headless && pnpm start:headless   # Node server, macOS + Linux
pnpm test:headless    # boots the real headless bundle; not part of pnpm test
pnpm exec vitest run test/main/session-service.spec.ts
```

Packaging and model-extraction scripts are in `package.json`.

Electron is macOS-only (`src/main/index.ts` throws elsewhere), so on Linux run headless. Headless binds `127.0.0.1` from port 3420 upward; `AGENT_UI_WEB_PORT` and `AGENT_UI_DATA_DIR` override. Typecheck and build use the native TypeScript 7 compiler.

## Hosts

`startAppRuntime()` (`app-runtime.ts`) owns the Node side for both entry points, Electron (`main/index.ts`) and headless (`headless/index.ts`). It takes an `AppHost` carrying the data paths and an optional `desktop` for dialogs and "open in app". Headless passes `desktop: null`, so code in `src/main/` has to tolerate that unless `tsconfig.headless.json` excludes it. The headless smoke test asserts the bundle never imports `electron`.

## RPC

`orpc-router.ts` composes one router. `procedure` from `orpc.ts` pins `Services` as the handler context. The same router is served over two transports: MessagePort in Electron, where preload forwards the port and the renderer gets no Node APIs, and a WebSocket at `/rpc` for browsers. `orpc-client.ts` picks by user agent. Streaming procedures are async generators, consumed with `consumeEventIterator`.

For a new endpoint, export a router from the service module and mount it in `orpc-router.ts`. The same HTTP server also serves `/mcp`, artifact downloads, and the static renderer.

## State sync

`defineServiceState()` (`shared/service-state.ts`) wraps state in Immer and emits patches. `StateOrchestrator` scopes each patch by state key and versions it; the renderer applies patch N+1 or falls back to re-fetching the snapshot, and reloads when the process `appVersion` changes. Components read it with `useAppState(selector)`.

State reaches the renderer only if it is in the `serviceStates` map in `create-services.ts`.

## Persistence

JSON through `conf` (not electron-store) at `<userData>/agent-ui.json`. Register a `ServiceState` plus a Zod schema with `PersistenceOrchestrator`; it hydrates by shallow-merging over defaults and debounces writes by 100ms. Persisted data that fails validation reports to `onError` and leaves defaults in place instead of throwing.

SQLite at `<userData>/agent-ui.sqlite3` through better-sqlite3 and Kysely. Types live in `database/schema.ts`, numbered migrations in `database/migrations/` run on boot. It holds terminal scrollback for stopped sessions, global instructions, and app metadata.

## Sessions

`sessions/state.ts` holds a `type`-discriminated union in a flat record. Each type owns a module exporting its schema, a manager for the live processes, and a router: `session-service.ts` for Claude, `sessions/*.session.ts` for Codex, Cursor Agent, plain terminals, and worktree setup.

Operations that span types (`settle`, `snooze`, `moveSessionToProject`) live on `sessionsRouter` and switch on `session.type` with a `never` check, so adding a type breaks the build everywhere it needs handling.

## Agent integrations

Session state comes from hooks and state files rather than scraping terminal output: a managed Claude plugin that writes NDJSON, merged Cursor hook config, the Codex app server, and generated zsh scripts that emit OSC 133 for plain terminals. Follow that when adding an integration instead of parsing PTY text.

Model lists in `shared/*-models.ts` are generated. Edit `scripts/extract-*-models.sh`, not the output.

## Conventions

- Biome for lint and format, 2-space indents, no ESLint.
- Zod 4 for anything that crosses a process or hits disk.
- The `@main`, `@renderer`, `@shared` aliases are declared in `tsconfig.json`, `vitest.config.ts`, and three Vite configs, so a new one means editing all five.
- Tailwind 4, shadcn primitives in `components/ui/`.
- Use `createDisposable` for teardown and register it in `create-services.ts` so shutdown covers it.
- Lefthook pre-commit runs Biome on staged files plus a full typecheck.

## Tests

`test/` mirrors `src/`. No DOM environment is configured, so renderer tests cover pure logic instead of rendering. Module-level mocks use `vi.hoisted()`. Managers take injectable dependencies such as an in-memory buffer store or a fake `TerminalManager`; follow that when adding a service.

## Agent rules:

- Don't do end-to-end verification, don't run app in dev mode, don't try to open it in browser or through `agent-browser` cli
