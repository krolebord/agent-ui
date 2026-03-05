# Agent UI

Agent UI is a desktop app that brings Claude Code into a clean multi-session workspace.

## What You Can Do

- Work across multiple Claude sessions in one app.
- Organize sessions by project in a focused sidebar.
- Start sessions with an initial prompt, chosen model, and permission mode.
- Set project defaults so new sessions start with your preferred settings.
- See clear live status indicators:
  - running
  - working
  - awaiting approval
  - awaiting user response
  - stopped / error
- Stop, resume, switch, and delete sessions quickly.
- Keep history available when switching between sessions.
- Auto-generate session titles for unnamed conversations.
- View Claude usage metrics from the built-in usage panel.
- Reopen the app and continue from saved projects and sessions.

## Feature Highlights

### Multi-Session Workspace
Run multiple Claude sessions at once, with a single active terminal view to stay focused.

### Project-Centric Navigation
Group sessions by folder, collapse/expand projects, and keep your workspace tidy.

### Fast Session Setup
Create a session with optional:
- Initial prompt
- Session name
- Model (`Opus`, `Sonnet`, `Haiku`)
- Permission mode (`Default`, `Accept edits`, `Plan`, `Yolo`)

### Activity Awareness
Know what Claude is doing at a glance with real-time activity badges and status icons.

### Usage Visibility
Open the usage panel to track key usage buckets and extra usage progress.

## Getting Started

### Requirements

- Node.js 18+
- pnpm
- Claude CLI available in your `PATH`

### Run in Development

```sh
pnpm install
pnpm dev
```

### Build

```sh
pnpm build
```

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
