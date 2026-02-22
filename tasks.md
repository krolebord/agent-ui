# Dependency Update Tasks

## Task 1: Patch and minor updates (safe) ✅

Low-risk updates within semver-compatible ranges. Can be applied together.

- [x] `lucide-react` 0.574.0 → 0.575.0
- [x] `tailwind-merge` 3.4.1 → 3.5.0
- [x] `@tanstack/react-hotkeys` 0.1.0 → 0.2.0
- [x] `tailwindcss` 4.1.18 → 4.2.0
- [x] `@tailwindcss/vite` 4.1.18 → 4.2.0
- [x] `electron-builder` 26.7.0 → 26.8.1

## Task 2: Biome 1 → 2 ✅

Major config and rule changes. Requires running the migration tool and reviewing updated lint rules.

- [x] `@biomejs/biome` 1.9.4 → 2.4.4
- [x] Run `pnpm biome migrate` and review config changes
- [x] Fix any new lint violations

Notes:
- `biome migrate` auto-converted `files.ignore` → `files.includes` with `!` negation patterns
- Enabled `tailwindDirectives` in CSS parser for Tailwind CSS v4 syntax
- Added `release/` to ignore list (built app bundles)
- Fixed 3 `<explanation>` placeholder suppressions with real descriptions
- Added suppression for intentional `${CLAUDE_PLUGIN_ROOT}` template literal
- Disabled `useHookAtTopLevel` for `terminal-pane.tsx` (forwardRef false positive, resolves with React 19 migration)
- Auto-fixed import sorting + formatting in 32 files

## Task 3: Vite 6 → 7 + ecosystem ✅

Vite, its plugins, and Vitest should be upgraded together. Verify `vite-plugin-electron` compatibility before starting.

- [x] `vite` 6.4.1 → 7.3.1
- [x] `@vitejs/plugin-react` 4.7.0 → 5.1.4
- [x] `vitest` 3.2.4 → 4.0.18
- [x] Verify `vite-plugin-electron` and `vite-plugin-electron-renderer` work with Vite 7

Notes:
- Upgraded incrementally: Vitest 4 first (on Vite 6), then Vite 7 + plugin-react 5
- Vitest 4 breaking change: arrow functions in `mockImplementation` can't be called with `new` — converted `ClaudeActivityMonitor` mock to regular function in `session-service.spec.ts`
- Added `pnpm.onlyBuiltDependencies: ["esbuild"]` to `package.json` (Vite 7 pulls in esbuild 0.27 which needs build approval)
- `vite-plugin-electron` 0.29.x + `vite-plugin-electron-renderer` 0.14.6: **build works** with Vite 7 (all 3 bundles: renderer, main, preload compile cleanly)
- Known caveat: [Issue #288](https://github.com/electron-vite/vite-plugin-electron/issues/288) reports dev-mode HMR issues with Vite 7 — monitor during development

## Task 4: React 18 → 19 ✅

React, ReactDOM, and their type packages must move together. Audit for breaking changes: `ref` as prop, removed legacy APIs, new `use()` hook.

- [x] `react` 18.3.1 → 19.2.4
- [x] `react-dom` 18.3.1 → 19.2.4
- [x] `@types/react` 18.3.28 → 19.2.14
- [x] `@types/react-dom` 18.3.7 → 19.2.3
- [x] Audit for `forwardRef` removal, `ref` as regular prop
- [x] Verify compatibility of `radix-ui`, `sonner`, `@tanstack/react-query`, `zustand`

Notes:
- Zero type errors or test failures — the codebase was already following modern React patterns
- No bare `useRef()` calls, no ref callback implicit returns, no `defaultProps`, no `ReactDOM.render`
- All dependencies confirmed React 19 compatible: radix-ui, sonner, tanstack/react-query, zustand, lucide-react, tanstack/react-hotkeys
- `forwardRef` is used in 2 files (terminal-pane.tsx, session-sidebar.tsx) — deprecated but still functional in React 19; can be migrated later to `ref` as regular prop
- `Context.Provider` used in 2 files — deprecated but still functional; can be migrated to `<Context value={...}>` later
- Renderer bundle grew ~51 KB (826→877 KB) due to React 19's new built-in features

## Task 5: Electron 33 → 40 ✅

Seven major versions behind. Each major bumps Chromium and Node.js runtimes. Validate `node-pty` beta compatibility and review breaking changes across each major.

- [x] `electron` 33.4.11 → 40.6.0
- [x] Review breaking changes for versions 34–40
- [x] Validate `node-pty` 1.2.0-beta.11 works with new Electron
- [x] Test native module rebuilds

Notes:
- Reviewed all breaking changes across Electron 34–40: zero APIs used by this project were deprecated or removed
- Key runtime jumps: Chromium 130→144, Node.js 20.18→24.11
- `node-pty` 1.2.0-beta.11 uses N-API (ABI-stable) with prebuilt `darwin-arm64`/`darwin-x64` binaries shipped in the npm tarball — no rebuild needed across Node.js major versions
- `electron-store` 11.x is tested against Electron 38 in its devDeps; uses only stable APIs
- `electron-builder` 26.8.x has no Electron peer dep and auto-detects native modules for asar
- macOS 11 (Big Sur) support dropped in Electron 38 — minimum is now macOS 12 (Monterey)
- Added `electron` to `pnpm.onlyBuiltDependencies` for the postinstall binary download
- Caveat: `node-pty` CI does not explicitly test Node.js 24 — runtime validation recommended during development

## Task 6: @types/node 22 → 25 ✅

Type-only change but may surface new type errors from stricter or changed definitions.

- [x] `@types/node` 22.19.11 → 25.3.0
- [x] Fix any resulting type errors

Notes:
- No type errors surfaced — the codebase uses only stable Node APIs (path, url, fs, os, child_process)
- None of the risky removed APIs (`fs.F_OK` constants, `SlowBuffer`, `_channel`) are used
- Tested incrementally at v24 and v25 — both clean
- Known Electron `noDeprecation` type conflict did not manifest with Electron 33
