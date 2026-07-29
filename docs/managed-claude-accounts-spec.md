# Managed Claude Accounts

Support running sessions under multiple Claude accounts with full-fidelity auth:
app-managed OAuth logins with automatic token refresh, in addition to the
existing `claude setup-token` accounts. Managed accounts get long-lived auth
(no yearly token expiry), mid-session token rotation, and working usage
tracking (their tokens carry the `user:profile` scope the usage API requires,
which setup tokens lack).

Out of scope for now: Windows support and the macOS keychain (on macOS the CLI
may store credentials in the keychain instead of `$CLAUDE_CONFIG_DIR/.credentials.json`;
the acquisition flow below assumes file-based credentials, i.e. Linux).

## Background

Verified empirically and via CodexBar's implementation
(`Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/`):

- Refresh endpoint: `POST https://platform.claude.com/v1/oauth/token`,
  form-urlencoded `grant_type=refresh_token`, `refresh_token`, `client_id`.
  Client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's public OAuth
  client ID, not a secret). Response: `{ access_token, refresh_token?,
  expires_in, token_type }`.
- **Refresh tokens rotate.** Whoever refreshes owns the credential pair; a
  second party refreshing with the same refresh token invalidates the first
  party's copy. Therefore the app must have *exclusive* ownership of managed
  account credentials, and must never refresh the user's default `~/.claude`
  login (the CLI owns that lifecycle).
- Login access tokens are short-lived (hours). `CLAUDE_CODE_OAUTH_TOKEN` is
  snapshotted into the env at spawn and the CLI cannot refresh env-provided
  tokens, so long sessions need a different delivery mechanism: `apiKeyHelper`,
  which the CLI re-executes on HTTP 401 and after
  `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`.
- The usage API (`api.anthropic.com/api/oauth/usage`) returns 403 for
  setup tokens (`user:profile` scope missing) and 200 for login tokens.
- `invalid_grant` from the refresh endpoint is terminal: the refresh token is
  dead and the account needs re-login. Other failures are transient and should
  back off, not hammer the endpoint.

## Account types

`claudeAccounts` state becomes a discriminated union on `type`:

- `setup-token` (existing behavior): `{ id, type, label, token, createdAt }`.
  Injected as `CLAUDE_CODE_OAUTH_TOKEN` at spawn. No refresh, no usage.
- `managed` (new): `{ id, type, label, email?, createdAt, oauth }` where
  `oauth = { accessToken, refreshToken, expiresAt, scopes }` and a status field
  for `ok | needs-relogin`. Refresh tokens are sensitive: encrypt the `oauth`
  blob at rest with Electron `safeStorage` before it hits electron-store.

Persistence migration: existing stored accounts have no `type`; hydrate them as
`setup-token` via schema default/transform.

The renderer state sync must not ship refresh tokens to the renderer. Sync a
redacted view (id, type, label, email, createdAt, status); token editing for
setup-token accounts can move to dedicated RPCs that don't round-trip through
synced state.

## Acquisition flow (add managed account)

1. User picks "Claude login" in the add-account UI. The app creates a throwaway
   config dir, e.g. `<userData>/claude-accounts/<id>/login-config-dir/`.
2. A terminal (dialog with an embedded xterm, reusing `TerminalSession`) runs
   `claude` with `CLAUDE_CONFIG_DIR=<that dir>`. The user walks through
   onboarding/login in it, including the browser OAuth handoff.
3. The main process watches the dir for `.credentials.json` (fs.watch plus a
   polling fallback). When it appears with a parseable `claudeAiOauth` block:
   - kill the PTY and close the dialog,
   - read `oauthAccount` (email/org) from the dir's `.claude.json` to pre-fill
     the account label,
   - extract `{ accessToken, refreshToken, expiresAt, scopes }` into the
     account record,
   - delete the throwaway dir (it contains a credentials copy).
4. Failure paths: user closes the dialog (cancel → cleanup dir), PTY exits
   without credentials (show error, offer retry), timeout.

The CLI never runs against that config dir again — that is what makes rotation
safe. The same dialog is reused for re-login when an account hits
`needs-relogin`; on success the new pair replaces the old one under the same
account id.

## Token refresh (main process only)

A `ClaudeAccountOAuth` module owns refresh:

- `getValidAccessToken(accountId)`: returns the stored token if
  `expiresAt - margin` (margin ~5 min) is in the future; otherwise refreshes.
- Single-flight per account: concurrent callers await one in-flight refresh.
- On success: persist the rotated pair atomically (new refresh token replaces
  old), update `expiresAt` from `expires_in`.
- On `invalid_grant`: set account status `needs-relogin`, surface in settings
  UI, block further attempts until re-login (terminal failure gate).
- On other errors: transient backoff (don't retry in a tight loop).
- Endpoint + client ID live in one constants module — they are undocumented
  and have moved before; breakage should be a one-line fix.

The default account is never refreshed by the app. The usage tracker keeps
reading `~/.claude` credentials as-is; every real session the app spawns keeps
that login fresh via the CLI itself.

## Token delivery to sessions (env at spawn)

**apiKeyHelper is ruled out** — verified against the CLI (v2.1.220): when
`apiKeyHelper` is configured, the CLI classifies the session as API-key auth
and sends the helper's output as an `x-api-key` header (`if(aN())return{key:…,
source:"apiKeyHelper"}`, then `if(r)return{headers:{"x-api-key":r}}`), never
taking the OAuth branch (`Authorization: Bearer` + `anthropic-beta:
oauth-2025-04-20`). An OAuth access token sent that way is rejected, and the
CLI reports "Invalid API key · Fix external API key" — selected precisely
because the key source is the helper.

So managed accounts use the same delivery as setup tokens:

- Session spawn calls `getValidAccessToken(accountId, { minRemainingMs: 30min })`
  and puts the result in `CLAUDE_CODE_OAUTH_TOKEN`. The wide margin maximizes
  the session's runway.
- Refresh tokens never leave the main process; sessions only ever see
  short-lived access tokens.
- **Known caveat:** the env is a snapshot and the CLI cannot refresh a token
  handed to it this way, so a session outliving its access token (hours) must
  be restarted. The CLI's own 401 recovery re-reads `CLAUDE_CODE_OAUTH_TOKEN`
  from its own process env, which we cannot mutate after spawn.
- If a managed account cannot produce a token (dead refresh token,
  `needs-relogin`), the start **fails** rather than silently falling back to the
  user's default account.

The alternative if the caveat becomes painful is a persistent per-account
`CLAUDE_CONFIG_DIR` with the CLI owning refresh (what t3code does). Costs:
account becomes part of session identity (transcripts are per-dir, so
resume/fork are pinned to one account), user-scope config/skills/memory/agents
don't apply, per-dir onboarding and trust prompts, and credential custody
inverts (the CLI rotates the refresh token, so this module's refresh logic goes
away). On macOS the keychain entry is namespaced per config dir
(`Claude Code-credentials-<sha256(configDir)[0..8]>`), so isolation does work
there, but harvesting into a planted `.credentials.json` is Linux-shaped.

`accountId` already flows through `startupConfig`, so resume/fork/scheduled
sessions inherit the account with no extra work.

## Usage tracker

`getUsage` gains `accountId?`:

- managed account → `getValidAccessToken` and call the usage API (works: full
  scopes),
- setup-token account → short-circuit to "usage unavailable with setup tokens"
  without a doomed API call,
- no account → current global-credentials path.

Skip the `usesApiBilling()` env guard when an explicit account is queried.

## Verification

1. **apiKeyHelper accepts OAuth access tokens** — **answered: no.** See "Token
   delivery" above. Delivery is `CLAUDE_CODE_OAUTH_TOKEN` at spawn, with the
   session-length caveat.
2. Refresh endpoint round-trip with a harvested refresh token: rotation
   observed, old refresh token invalidated, scopes preserved. *(Still worth
   confirming end to end with a real account.)*

## Implementation order

1. ~~Account `type` union + persistence migration + redacted renderer sync +
   accounts UI (setup-token form vs "Claude login" button).~~ Done.
2. ~~`ClaudeAccountOAuth` refresh module (+ tests: single-flight, rotation
   persistence, invalid_grant gate, expiry margin).~~ Done.
3. ~~Login-harvest dialog + folder watch + cleanup + re-login path.~~ Done.
4. ~~Session-spawn wiring: refresh at spawn into `CLAUDE_CODE_OAUTH_TOKEN`.~~
   Done.
5. ~~Usage tracker `accountId` support + per-account display in usage panel.~~
   Done.
6. `safeStorage` encryption for stored oauth blobs (and ideally the existing
   setup tokens too). **Not done** — refresh tokens are currently plaintext in
   electron-store.
7. Platform gate for macOS (login harvest assumes file-based credentials).
   **Not done.**

## Risks

- Undocumented endpoint + client ID: may change or be restricted; ToS-gray.
  Contained in one module; accounts degrade to `needs-relogin`.
- Refresh-token custody raises the sensitivity of our persistence; safeStorage
  is part of this work, not a follow-up.
- macOS keychain behavior intentionally unaddressed; managed accounts are
  Linux-only until that's designed (acquisition may silently fail or touch the
  user's real keychain entry on macOS — gate the feature by platform).
