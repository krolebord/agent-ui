import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import log from "../logger";

/**
 * The managed .zshrc sources the user's real config, then installs
 * OSC 133 hooks via add-zsh-hook for shell integration.
 *
 * ZDOTDIR is temporarily overridden to point to our managed directory.
 * The script restores the original ZDOTDIR before sourcing the user's .zshrc
 * so that any ZDOTDIR-dependent logic in their config still works.
 */
const ZSH_INTEGRATION_SCRIPT = `\
# Agent UI shell integration — do not edit, this file is regenerated on launch.

# Restore the real ZDOTDIR so the user's config sees the original value.
if [ -n "\${_AGENT_UI_ORIGINAL_ZDOTDIR+x}" ]; then
  ZDOTDIR="$_AGENT_UI_ORIGINAL_ZDOTDIR"
  unset _AGENT_UI_ORIGINAL_ZDOTDIR
else
  unset ZDOTDIR
fi

# Source the user's .zshrc from the real ZDOTDIR (or $HOME).
_agent_ui_real_zshrc="\${ZDOTDIR:-$HOME}/.zshrc"
if [ -f "$_agent_ui_real_zshrc" ]; then
  source "$_agent_ui_real_zshrc"
fi
unset _agent_ui_real_zshrc

# Install OSC 133 shell integration hooks.
autoload -Uz add-zsh-hook

_agent_ui_precmd() {
  builtin printf '\\033]133;A\\007'
}

_agent_ui_preexec() {
  builtin printf '\\033]133;C\\007'
}

add-zsh-hook precmd _agent_ui_precmd
add-zsh-hook preexec _agent_ui_preexec
`;

export interface ShellIntegrationScripts {
  env: Record<string, string>;
}

export async function ensureShellIntegrationScripts(
  userDataPath: string,
): Promise<ShellIntegrationScripts> {
  const shellIntegrationDir = path.join(userDataPath, "shell-integration");
  const zshDir = path.join(shellIntegrationDir, "zsh");

  await mkdir(zshDir, { recursive: true });
  await writeFile(path.join(zshDir, ".zshrc"), ZSH_INTEGRATION_SCRIPT, "utf8");

  log.info("Shell integration scripts written", { zshDir });

  const env: Record<string, string> = {
    ZDOTDIR: zshDir,
  };

  // Preserve the user's real ZDOTDIR so our .zshrc can restore it.
  if (process.env.ZDOTDIR) {
    env._AGENT_UI_ORIGINAL_ZDOTDIR = process.env.ZDOTDIR;
  }

  return { env };
}
