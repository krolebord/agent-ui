#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

APP_BUNDLE=$(
  find "$ROOT_DIR/release" -type d -name "*.app" 2>/dev/null \
    | grep "/mac" \
    | while IFS= read -r path; do
        mtime=$(stat -f "%m" "$path" 2>/dev/null || echo 0)
        printf "%s\t%s\n" "$mtime" "$path"
      done \
    | sort -nr \
    | head -n 1 \
    | cut -f2-
)

if [ -z "${APP_BUNDLE:-}" ] || [ ! -d "$APP_BUNDLE" ]; then
  echo "No macOS .app bundle found under release/."
  echo "Run: pnpm app:dist:mac:dir"
  exit 1
fi

APP_NAME=$(basename "$APP_BUNDLE")
DEST_ROOT=${AGENT_UI_INSTALL_DIR:-/Applications}

if [ ! -w "$DEST_ROOT" ]; then
  DEST_ROOT="$HOME/Applications"
  mkdir -p "$DEST_ROOT"
  echo "No write access to /Applications; installing to $DEST_ROOT instead."
fi

DEST_APP="$DEST_ROOT/$APP_NAME"

# Remove old bundle first so outdated files do not survive updates.
rm -rf "$DEST_APP"
ditto "$APP_BUNDLE" "$DEST_APP"

echo "Installed $APP_NAME -> $DEST_APP"
