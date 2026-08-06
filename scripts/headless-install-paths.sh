#!/usr/bin/env bash
# Shared path helpers for headless install/release layout.
#
# Install tree (isolated from the git checkout build outputs):
#   $INSTALL_ROOT/releases/<id>/{dist,dist-headless,node_modules,...}
#   $INSTALL_ROOT/current -> releases/<id>
#
# Override the root with AGENT_UI_INSTALL_DIR. Otherwise uses
# $XDG_DATA_HOME/agent-ui (defaulting to ~/.local/share/agent-ui).

agent_ui_headless_install_root() {
  if [ -n "${AGENT_UI_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$AGENT_UI_INSTALL_DIR"
    return
  fi
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s\n' "$XDG_DATA_HOME/agent-ui"
    return
  fi
  printf '%s\n' "${HOME}/.local/share/agent-ui"
}

agent_ui_headless_current_dir() {
  printf '%s\n' "$(agent_ui_headless_install_root)/current"
}

agent_ui_headless_releases_dir() {
  printf '%s\n' "$(agent_ui_headless_install_root)/releases"
}
