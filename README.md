# Agent UI

Agent UI is a desktop app that orchestrates multiple CLI coding agents — Claude Code, Codex, Cursor Agent, and plain terminals — in one clean, project-centric workspace.

## What You Can Do

- Run many agent sessions at once and switch between them instantly.
- Mix session types in a single workspace:
  - **Claude Code** — the Claude CLI with live activity tracking
  - **Codex** — the Codex CLI agent
  - **Cursor Agent** — the Cursor CLI agent
  - **Terminal** — a plain shell session
- Organize sessions by project in a focused sidebar, with collapse/expand groups.
- Start a session with an initial prompt, name, model, and permission mode.
- Set per-project defaults (including worktree setup commands) so new sessions start the way you like.
- See clear live status indicators:
  - running
  - working
  - awaiting approval
  - awaiting user response
  - stopped / error
- Stop, resume, switch, and delete sessions quickly.
- Auto-generate session titles for unnamed conversations.
- Review changes in the built-in git history and diff panes, with inline comments.
- Generate commit messages automatically.
- Track agent usage (Claude / Codex / Cursor) from the built-in usage panel.
- Open a project in external apps (Cursor, Finder, GitHub Desktop, Terminal).
- Reopen the app and continue from saved projects and sessions.

## Feature Highlights

### Multi-Agent Workspace
Run Claude Code, Codex, Cursor Agent, and plain terminal sessions side by side, with a single active terminal view to stay focused.

### Project-Centric Navigation
Group sessions by folder, collapse/expand projects, drag sessions between projects, and keep your workspace tidy. Projects can have custom aliases and shared default startup settings.

### Git & Diff Review
- Browse commit history in an infinite-scroll history pane (navigable with arrow keys).
- Inspect file-level diffs and add inline, side-aware comments in the diff review pane.
- See ahead/behind counts against upstream and which commits are unpushed.
- Generate commit messages automatically.

### Activity Awareness
Know what each agent is doing at a glance with real-time activity badges and status icons. Per-project badges surface how many sessions are active or awaiting you.

### Usage Visibility
Open the usage panel to track usage buckets, reset times, and extra-usage / credit balances across Claude, Codex, and Cursor.

## Getting Started

### Requirements

- Node.js 22+
- pnpm
- The CLI for each agent you want to use, available in your `PATH` (e.g. Claude CLI, Codex, Cursor Agent)

### TypeScript Tooling

- `pnpm typecheck` and `pnpm build` use `tsgo` from `@typescript/native-preview`.
- The repo still keeps `typescript` installed for tool compatibility, but `tsc` is not the default checker.
- In VS Code and Cursor, install the recommended `TypeScriptTeam.native-preview` extension. The committed workspace setting enables `tsgo` automatically.

### Run in Development

```sh
pnpm install
pnpm dev
```

### Build

```sh
pnpm build
```

This runs `tsgo --noEmit` before the Vite build.

### Package macOS App

```sh
pnpm app:dist:mac
```

### Install macOS App Bundle

```sh
pnpm app:install
```

## Quality Checks

```sh
pnpm typecheck
pnpm format
pnpm test
```

## License

MIT
