#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.nichikatanaka.automation-os.worker"
DOMAIN="gui/$(id -u)"
SOURCE_PLIST="$REPO_ROOT/ops/launchd/com.nichikatanaka.automation-os-worker.plist"
SOURCE_SCRIPT="$REPO_ROOT/scripts/start-automation-os-worker.sh"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
HELPER_DIR="$HOME/Library/Application Support/Automation OS"
HELPER_SCRIPT="$HELPER_DIR/start-automation-os-worker.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  printf 'Usage: %s {install|status|uninstall|restart}\n' "$0" >&2
}

install_agent() {
  plutil -lint "$SOURCE_PLIST"
  mkdir -p "$TARGET_DIR" "$HELPER_DIR"
  cp "$SOURCE_SCRIPT" "$HELPER_SCRIPT"
  chmod +x "$HELPER_SCRIPT"
  cp "$SOURCE_PLIST" "$TARGET_PLIST"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$DOMAIN" "$TARGET_PLIST" >/dev/null 2>&1; then
    sleep 1
    launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"
  fi
  printf 'installed: %s\n' "$TARGET_PLIST"
  printf '安全確認後にworkerを起動するには: %s restart\n' "$0"
}

status_agent() {
  launchctl print "$DOMAIN/$LABEL" || true
}

uninstall_agent() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$TARGET_PLIST" "$HELPER_SCRIPT"
  printf 'uninstalled: %s\n' "$TARGET_PLIST"
}

case "${1:-}" in
  install) install_agent ;;
  status) status_agent ;;
  uninstall) uninstall_agent ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" ;;
  *) usage; exit 2 ;;
esac
