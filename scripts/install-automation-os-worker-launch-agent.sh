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
REMOTE_URL="${AUTOMATION_OS_PORTABLE_REMOTE_URL:-https://automation-os.zeabur.app}"
REMOTE_COMPANY_ID="${AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID:-company_2560580981cedfd106b66245}"
BROWSER_USE_PROJECT_ROOT="${AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT:-$HOME/Documents/New project}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  printf 'Usage: %s {install|status|uninstall|restart}\n' "$0" >&2
}

wait_for_service_release() {
  local attempt
  for attempt in {1..30}; do
    if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'launchd_service_still_loaded: %s\n' "$DOMAIN/$LABEL" >&2
  return 1
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
  plutil -replace 'EnvironmentVariables.HOME' -string "$HOME" "$TARGET_PLIST"
  # Expand the template value before launchd starts the helper. Leaving the
  # placeholder literal makes CODEX_HOME point outside the user's profile and
  # causes auth/capability readback to look missing only in the worker lane.
  plutil -replace 'EnvironmentVariables.CODEX_HOME' -string "$HOME/.codex" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AOS_CHROME_PLUGIN_READBACK_PATH' -string "$HOME/.social-flow/aos-company1-profile2-bridge-readback-v2.json" "$TARGET_PLIST"
  # Keep the worker capability path identical to start-automation-os-worker.sh,
  # the portable runner, and the live Profile 2 bridge. A different
  # install-time path makes the worker report capability_missing even while
  # the bridge is target-scoped ready and has issued its private capability.
  plutil -replace 'EnvironmentVariables.AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH' -string "$HOME/.codex/runtime/aos-chrome-plugin-background-read-only-capability.v1.json" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_WORKER_CONFIG' -string "$PROFILE_CONFIG" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_REMOTE_URL' -string "$REMOTE_URL" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID' -string "$REMOTE_COMPANY_ID" "$TARGET_PLIST"
  # Company 1's hosted AOS is the canonical queue.  Polling both authorities
  # would create two independent idempotency domains and could duplicate a
  # business run when local and remote databases diverge; add local only by an
  # explicit operator override.
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY' -string "${AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY:-remote}" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL' -string "${AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL:-http://127.0.0.1:8787}" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID' -string "${AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID:-$REMOTE_COMPANY_ID}" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT' -string "$REPO_ROOT/data/artifacts/portable-remote-worker" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR' -string "$REPO_ROOT" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT' -string "$BROWSER_USE_PROJECT_ROOT" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION' -string "$BROWSER_USE_PROJECT_ROOT/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI' -string "$REPO_ROOT/scripts/aos-daily-ai-business-runner.mjs" "$TARGET_PLIST"
  plutil -replace 'EnvironmentVariables.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS' -string "$REPO_ROOT/scripts/aos-nisenprints-business-runner.mjs" "$TARGET_PLIST"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  wait_for_service_release
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
