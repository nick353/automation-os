#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.nichikatanaka.automation-os"
DOMAIN="gui/$(id -u)"
SOURCE_PLIST="$REPO_ROOT/ops/launchd/$LABEL.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
HELPER_DIR="$HOME/Library/Application Support/Automation OS"
HELPER_SCRIPT="$HELPER_DIR/start-automation-os-server.sh"
PORT="${AUTOMATION_OS_PORT:-8787}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  printf 'Usage: %s {install|status|uninstall|restart}\n' "$0" >&2
}

health_readback() {
  local url="http://127.0.0.1:$PORT/api/health"
  local attempt
  for attempt in {1..20}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      printf 'health ok: %s\n' "$url"
      return 0
    fi
    sleep 1
  done
  printf 'health blocked: %s\n' "$url" >&2
  return 1
}

print_status() {
  launchctl print "$DOMAIN/$LABEL" || true
  health_readback || true
}

install_agent() {
  plutil -lint "$SOURCE_PLIST"
  mkdir -p "$TARGET_DIR"
  mkdir -p "$HELPER_DIR"
  cp "$REPO_ROOT/scripts/start-automation-os-server.sh" "$HELPER_SCRIPT"
  chmod +x "$HELPER_SCRIPT"
  cp "$SOURCE_PLIST" "$TARGET_PLIST"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  health_readback
}

uninstall_agent() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$TARGET_PLIST"
  rm -f "$HELPER_SCRIPT"
  rmdir "$HELPER_DIR" >/dev/null 2>&1 || true
  printf 'uninstalled: %s\n' "$TARGET_PLIST"
}

case "${1:-}" in
  install)
    install_agent
    ;;
  status)
    print_status
    ;;
  uninstall)
    uninstall_agent
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    health_readback
    ;;
  *)
    usage
    exit 2
    ;;
esac
