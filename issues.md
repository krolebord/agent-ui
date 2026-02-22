## Review Issues

### [P2] ~~Wait for hook watcher before starting Cursor process~~ ✅ Fixed
- File: `src/main/sessions/cursor-agent.session.ts:493`
- Fix: Made `CursorActivityMonitor.startMonitoring()` async and awaited it in `startLiveSession` before `terminal.start()`. The watcher now fully initializes (file ensured, EOF offset recorded) before the Cursor process can write hook events, eliminating the race condition.

### [P2] ~~Preserve permission metadata in normalized hook events~~ ✅ Fixed
- File: `src/main/cursor-state-hooks.ts:204`
- Fix: Added `permission` and `decision` field extraction to `normalizeEvent()` in the hook script template. These fields are now preserved through the ndjson pipeline, allowing `CursorActivityMonitor.reduceState` to correctly detect `permission === "ask"` and report `awaiting_approval` status.

### [P2] ~~Use Cursor title generator for Cursor session manager~~ ✅ Fixed
- File: `src/main/create-services.ts:157`
- Fix: Removed the explicit `titleManager: new SessionTitleManager()` override passed to `CursorAgentSessionsManager`. The constructor already defaults to `generateCursorSessionTitle` when no `titleManager` is provided, so the explicit default-Claude override was simply masking the correct built-in behavior.
