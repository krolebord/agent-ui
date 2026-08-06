#!/usr/bin/env bash
# Promote the workspace headless build into an isolated install tree.
#
# Copies dist + dist-headless out of the git checkout, installs production
# dependencies into a new release directory, then atomically flips the
# `current` symlink. A running server that already uses `current` keeps
# serving its previous release until it is restarted.
#
# Prerequisites: run `pnpm build:headless` first (or let agent-ui-deploy do it).
#
# Env:
#   AGENT_UI_INSTALL_DIR  override install root
#   AGENT_UI_KEEP_RELEASES  how many old releases to keep (default: 3)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=headless-install-paths.sh
source "$SCRIPT_DIR/headless-install-paths.sh"

PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_ROOT="$(agent_ui_headless_install_root)"
RELEASES_DIR="$(agent_ui_headless_releases_dir)"
CURRENT_LINK="$(agent_ui_headless_current_dir)"
KEEP_RELEASES="${AGENT_UI_KEEP_RELEASES:-3}"

if ! [[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] || [ "$KEEP_RELEASES" -lt 1 ]; then
  echo "error: AGENT_UI_KEEP_RELEASES must be a positive integer" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/dist/index.html" ]; then
  echo "error: missing $PROJECT_DIR/dist/index.html — run pnpm build:headless first" >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/dist-headless/index.js" ]; then
  echo "error: missing $PROJECT_DIR/dist-headless/index.js — run pnpm build:headless first" >&2
  exit 1
fi

command -v pnpm >/dev/null || {
  echo "error: pnpm not found in PATH" >&2
  exit 1
}

VERSION="$(
  node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" \
    "$PROJECT_DIR/package.json" 2>/dev/null || echo unknown
)"
RELEASE_ID="${VERSION}-$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"

echo "promoting headless release $RELEASE_ID"
echo "  from: $PROJECT_DIR"
echo "  to:   $RELEASE_DIR"

mkdir -p "$RELEASES_DIR"
mkdir -p "$RELEASE_DIR"

cp -a "$PROJECT_DIR/dist" "$RELEASE_DIR/dist"
cp -a "$PROJECT_DIR/dist-headless" "$RELEASE_DIR/dist-headless"
cp -a "$PROJECT_DIR/package.json" "$RELEASE_DIR/package.json"
cp -a "$PROJECT_DIR/pnpm-lock.yaml" "$RELEASE_DIR/pnpm-lock.yaml"
if [ -f "$PROJECT_DIR/.npmrc" ]; then
  cp -a "$PROJECT_DIR/.npmrc" "$RELEASE_DIR/.npmrc"
fi

# Production deps only — keeps electron and other build tooling out of the
# runtime tree. Uses the local pnpm store when packages are already cached.
echo "installing production dependencies into release..."
pnpm install --prod --frozen-lockfile --dir "$RELEASE_DIR"

if [ ! -f "$RELEASE_DIR/dist/index.html" ] || [ ! -f "$RELEASE_DIR/dist-headless/index.js" ]; then
  echo "error: release looks incomplete; not switching current" >&2
  rm -rf "$RELEASE_DIR"
  exit 1
fi

# Atomic symlink flip: write a temp link, then replace `current`.
tmp_link="$INSTALL_ROOT/current.new.$$"
ln -s "releases/$RELEASE_ID" "$tmp_link"
mv -Tf "$tmp_link" "$CURRENT_LINK"

echo "current -> releases/$RELEASE_ID"

# Prune older releases. Always retain `current`, then fill up to
# KEEP_RELEASES with the newest remaining releases.
current_target="$(readlink "$CURRENT_LINK" || true)"
current_name="${current_target##*/}"
mapfile -t all_releases < <(ls -1 "$RELEASES_DIR" | sort -r)
keep_names=()
if [ -n "$current_name" ]; then
  keep_names+=("$current_name")
fi
for name in "${all_releases[@]}"; do
  if [ "${#keep_names[@]}" -ge "$KEEP_RELEASES" ]; then
    break
  fi
  already=0
  for kept in "${keep_names[@]}"; do
    if [ "$kept" = "$name" ]; then
      already=1
      break
    fi
  done
  if [ "$already" -eq 0 ]; then
    keep_names+=("$name")
  fi
done
for name in "${all_releases[@]}"; do
  should_keep=0
  for kept in "${keep_names[@]}"; do
    if [ "$kept" = "$name" ]; then
      should_keep=1
      break
    fi
  done
  if [ "$should_keep" -eq 0 ]; then
    echo "pruning old release $name"
    rm -rf "$RELEASES_DIR/$name"
  fi
done

echo "promote complete: $CURRENT_LINK"
