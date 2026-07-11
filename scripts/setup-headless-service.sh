#!/usr/bin/env bash
# Set up agent-ui as a systemd user service on this machine.
#
# Creates/updates:
#   ~/.config/systemd/user/agent-ui.service
#   ~/bin/agent-ui-deploy.sh   (build + restart helper)
#   ~/.bash_aliases            (agent-ui-* aliases, idempotent block)
#
# Safe to re-run: regenerates all three from the current paths.
# Does NOT start or restart the service — see the printed cutover steps.
set -euo pipefail

if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "error: this script requires systemd with user sessions (Linux)." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)" || { echo "error: node not found in PATH." >&2; exit 1; }
UNIT_FILE="$HOME/.config/systemd/user/agent-ui.service"
DEPLOY_SCRIPT="$HOME/bin/agent-ui-deploy.sh"
ALIASES_FILE="$HOME/.bash_aliases"

mkdir -p "$HOME/.config/systemd/user" "$HOME/bin"

# --- systemd unit ---
# Launch via a login shell so the server sees the user's full environment
# (PATH from nvm/profile, etc.), matching a manual `pnpm start:headless`.
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Agent UI headless server

[Service]
WorkingDirectory=$PROJECT_DIR
ExecStart=/bin/bash -lc 'exec $NODE_BIN dist-headless/index.js'
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
echo "wrote $UNIT_FILE"

# --- deploy script ---
cat > "$DEPLOY_SCRIPT" <<EOF
#!/usr/bin/env bash
# Build a new headless version and restart the systemd user service.
# Build runs first so a failed build never takes down the running server.
set -euo pipefail

cd $PROJECT_DIR

pnpm build:headless

# Detach the restart from this terminal: if this script runs inside an
# agent-ui hosted terminal, the restart kills our own session — issuing it
# via systemd-run ensures it completes anyway.
systemd-run --user --collect systemctl --user restart agent-ui

sleep 3
systemctl --user status agent-ui --no-pager || true
EOF
chmod +x "$DEPLOY_SCRIPT"
echo "wrote $DEPLOY_SCRIPT"

# --- aliases (replace existing block if present) ---
BEGIN_MARK="# >>> agent-ui aliases >>>"
END_MARK="# <<< agent-ui aliases <<<"
touch "$ALIASES_FILE"
if grep -qF "$BEGIN_MARK" "$ALIASES_FILE"; then
  sed -i "/^$BEGIN_MARK\$/,/^$END_MARK\$/d" "$ALIASES_FILE"
fi
cat >> "$ALIASES_FILE" <<EOF
$BEGIN_MARK
alias agent-ui-deploy='$DEPLOY_SCRIPT'
alias agent-ui-start='systemctl --user start agent-ui'
alias agent-ui-stop='systemctl --user stop agent-ui'
alias agent-ui-restart='systemctl --user restart agent-ui'
alias agent-ui-status='systemctl --user status agent-ui --no-pager'
alias agent-ui-logs='journalctl --user -u agent-ui -f'
alias agent-ui-help='echo "agent-ui aliases:
  agent-ui-deploy   build new version and restart the server
  agent-ui-start    start the server
  agent-ui-stop     stop the server
  agent-ui-restart  restart the server (no rebuild)
  agent-ui-status   show service status
  agent-ui-logs     tail server logs
  agent-ui-help     show this help"'
$END_MARK
EOF
echo "updated $ALIASES_FILE"

# --- enable service (without starting it) ---
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable agent-ui
echo "service enabled, lingering on"

cat <<EOF

Setup complete. The service was NOT started.

Next steps (from a plain SSH session, not an agent-ui terminal):
  1. If a headless server is already running manually, stop it:
       pgrep -af dist-headless   # find its PID, then kill it
  2. Build and start:
       $DEPLOY_SCRIPT
  3. Load the aliases in your current shell:
       source ~/.bash_aliases

Day to day: run 'agent-ui-deploy' to ship a new version.
EOF
