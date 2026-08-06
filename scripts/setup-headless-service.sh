#!/usr/bin/env bash
# Set up agent-ui as a systemd user service on this machine.
#
# Creates/updates:
#   ~/.config/systemd/user/agent-ui.service
#   ~/bin/agent-ui-deploy.sh   (build + promote + restart helper)
#   ~/.bash_aliases            (agent-ui-* aliases, idempotent block)
#
# The service runs from an isolated install tree (not the git checkout):
#   ${AGENT_UI_INSTALL_DIR:-${XDG_DATA_HOME:-~/.local/share}/agent-ui}/current
# so workspace builds cannot overwrite the client assets a live server is
# serving. Run agent-ui-deploy to build, promote into that tree, and restart.
#
# Safe to re-run: regenerates all three from the current paths.
# Does NOT start or restart the service — see the printed cutover steps.
set -euo pipefail

if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "error: this script requires systemd with user sessions (Linux)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=headless-install-paths.sh
source "$SCRIPT_DIR/headless-install-paths.sh"

PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_ROOT="$(agent_ui_headless_install_root)"
CURRENT_DIR="$(agent_ui_headless_current_dir)"
NODE_BIN="$(command -v node)" || { echo "error: node not found in PATH." >&2; exit 1; }
UNIT_FILE="$HOME/.config/systemd/user/agent-ui.service"
DEPLOY_SCRIPT="$HOME/bin/agent-ui-deploy.sh"
ALIASES_FILE="$HOME/.bash_aliases"

mkdir -p "$HOME/.config/systemd/user" "$HOME/bin" "$INSTALL_ROOT"

# --- systemd unit ---
# WorkingDirectory is the promoted install symlink, not the git checkout.
# Launch via a login shell so the server sees the user's full environment
# (PATH from nvm/profile, etc.), matching a manual headless start.
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Agent UI headless server

[Service]
WorkingDirectory=$CURRENT_DIR
ExecStart=/bin/bash -lc 'exec $NODE_BIN dist-headless/index.js'
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
echo "wrote $UNIT_FILE"
echo "  WorkingDirectory=$CURRENT_DIR"

# --- deploy script ---
cat > "$DEPLOY_SCRIPT" <<EOF
#!/usr/bin/env bash
# Build a new headless version, promote it into the isolated install tree,
# then restart the systemd user service.
# Build + promote run first so a failed build never takes down the running
# server; the live process keeps serving the previous release until restart.
set -euo pipefail

export AGENT_UI_INSTALL_DIR='$INSTALL_ROOT'

cd $PROJECT_DIR

pnpm build:headless
bash scripts/promote-headless-release.sh

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
  agent-ui-deploy   build, promote to install tree, restart server
  agent-ui-start    start the server
  agent-ui-stop     stop the server
  agent-ui-restart  restart the server (no rebuild/promote)
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

Setup complete. The service was NOT started or restarted.

Install root: $INSTALL_ROOT
Runtime symlink: $CURRENT_DIR
  (releases live under $INSTALL_ROOT/releases/)

Workspace builds write to $PROJECT_DIR/dist and do not affect a server
that is already running from the install tree.

Next steps (from a plain SSH session, not an agent-ui terminal):
  1. If a headless server is already running from the git checkout, stop it:
       pgrep -af dist-headless   # find its PID, then kill it
       # or: systemctl --user stop agent-ui
  2. Build, promote into the install tree, and start/restart:
       $DEPLOY_SCRIPT
  3. Load the aliases in your current shell:
       source ~/.bash_aliases

Do not run agent-ui-restart until a release has been promoted at least once
(otherwise $CURRENT_DIR will be missing).

Day to day: run 'agent-ui-deploy' to ship a new version.
EOF
