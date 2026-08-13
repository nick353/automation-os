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
PROFILE_SCRIPT="$REPO_ROOT/scripts/portable-worker-profile.mjs"
PROFILE_CONFIG="${AUTOMATION_OS_WORKER_CONFIG:-$HELPER_DIR/worker-profile.json}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  printf 'Usage: %s {install|status|uninstall|restart}\n' "$0" >&2
}

install_agent() {
  plutil -lint "$SOURCE_PLIST"
  mkdir -p "$TARGET_DIR" "$HELPER_DIR"
  if [[ ! -f "$PROFILE_CONFIG" ]]; then
    node "$PROFILE_SCRIPT" init --output "$PROFILE_CONFIG"
  else
    node "$PROFILE_SCRIPT" validate --config "$PROFILE_CONFIG" >/dev/null
  fi
  cp "$SOURCE_SCRIPT" "$HELPER_SCRIPT"
  cp "$PROFILE_SCRIPT" "$HELPER_DIR/portable-worker-profile.mjs"
  chmod +x "$HELPER_SCRIPT"
  cp "$SOURCE_PLIST" "$TARGET_PLIST"
  plutil -replace 'ProgramArguments.0' -string "$HELPER_SCRIPT" "$TARGET_PLIST"
  # plutil inserts an array item for this key path on some macOS releases;
  # remove the template item so launchd receives exactly one executable arg.
  plutil -remove 'ProgramArguments.1' "$TARGET_PLIST" >/dev/null 2>&1 || true
  plutil -replace 'WorkingDirectory' -string "$REPO_ROOT" "$TARGET_PLIST"
  plutil -replace 'StandardOutPath' -string "$REPO_ROOT/data/logs/automation-os-worker-launchd.out.log" "$TARGET_PLIST"
  plutil -replace 'StandardErrorPath' -string "$REPO_ROOT/data/logs/automation-os-worker-launchd.err.log" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_REPO_ROOT' -string "$REPO_ROOT" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_WORKER_CONFIG' -string "$PROFILE_CONFIG" "$TARGET_PLIST"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  local bootstrapped=0
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$TARGET_PLIST" >/dev/null 2>&1; then
      bootstrapped=1
      break
    fi
    sleep 1
  done
  if (( bootstrapped != 1 )); then
    printf 'launchd_bootstrap_failed: %s\n' "$TARGET_PLIST" >&2
    return 1
  fi
  printf 'installed: %s\n' "$TARGET_PLIST"
  printf 'profile: %s\n' "$PROFILE_CONFIG"
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
