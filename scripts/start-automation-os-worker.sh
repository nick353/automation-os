#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME:-/Users/nichikatanaka}"
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME"

# The profile is deliberately non-secret.  It carries only paths, company
# scope, and a worker label; AOS credentials remain in Keychain or a
# protected token file.  Loading it here is what makes the same worker code
# relocatable across Macs and lets CODEX_HOME select a different Codex account.
PROFILE_REPO_ROOT="${AUTOMATION_OS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AUTOMATION_OS_WORKER_CONFIG="${AUTOMATION_OS_WORKER_CONFIG:-$HOME/Library/Application Support/Automation OS/worker-profile.json}"
PROFILE_LOADER="$PROFILE_REPO_ROOT/scripts/portable-worker-profile.mjs"
if [[ ! -f "$PROFILE_LOADER" && -f "$SCRIPT_DIR/portable-worker-profile.mjs" ]]; then
  PROFILE_LOADER="$SCRIPT_DIR/portable-worker-profile.mjs"
fi
if [[ -f "$AUTOMATION_OS_WORKER_CONFIG" && -f "$PROFILE_LOADER" ]]; then
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || { print -u2 "portable_worker_node_missing"; exit 1; }
  PROFILE_ENV="$("$NODE_BIN" "$PROFILE_LOADER" shell-env --config "$AUTOMATION_OS_WORKER_CONFIG")"
  eval "$PROFILE_ENV"
fi

REPO_ROOT="${AUTOMATION_OS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

export AUTOMATION_OS_DATABASE_MODE="${AUTOMATION_OS_DATABASE_MODE:-auto}"
export AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS="${AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS:-30000}"
export AUTOMATION_OS_WORKER_ROLE="${AUTOMATION_OS_WORKER_ROLE:-mac}"
export AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER="${AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER:-1}"
# The Mac worker is the resident durable-queue owner in the local deployment.
# Keep the server default unchanged so a server-owned deployment remains
# possible, but make the worker launch path explicit and fail-closed against
# an accidental scheduler gap when the API server is stopped.
export AUTOMATION_OS_DURABLE_SCHEDULER_OWNER="${AUTOMATION_OS_DURABLE_SCHEDULER_OWNER:-server}"
# The service identity is provisioned per AOS company and must come from the
# LaunchAgent/environment.  Never invent a fallback identity: an unset value
# must reach the worker's explicit fail-closed admission check.
export AUTOMATION_OS_DURABLE_SERVICE_USER_ID="${AUTOMATION_OS_DURABLE_SERVICE_USER_ID:-}"
export AUTOMATION_OS_PORTABLE_WORKER_MODE="${AUTOMATION_OS_PORTABLE_WORKER_MODE:-external}"
# Company 1 Remote AOS is the business control plane. Keep the resident
# worker on that durable queue by default; a local UI queue may be added only
# through the explicit AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY override. Each
# target keeps its own auth boundary and the remote token is never sent to
# loopback.
export AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY="${AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY:-remote}"
export AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL="${AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL:-http://127.0.0.1:8787}"
export AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID="${AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID:-${AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID:-}}"
# Keep the AOS runner resolver in control. Browser Use CLI is the canonical
# unattended registered-workflow lane. A legacy claim may still explicitly
# select Chrome Plugin/Profile 2; no implicit cross-surface fallback is used.
unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER
export AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR="${AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR:-$REPO_ROOT}"
export AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS="${AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS:-3600000}"
export AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS="${AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS:-enabled}"
export AOS_WEB_OPERATION_BACKEND="${AOS_WEB_OPERATION_BACKEND:-browser_use_cli}"
export AUTOMATION_OS_CHROME_PLUGIN_PROJECT_ROOT="${AUTOMATION_OS_CHROME_PLUGIN_PROJECT_ROOT:-$HOME/Documents/New project}"
export AOS_CHROME_PROFILE_ID="${AOS_CHROME_PROFILE_ID:-profile2}"
export AOS_CHROME_PROFILE_NAME="${AOS_CHROME_PROFILE_NAME:-Profile 2}"
export AOS_CHROME_PROFILE_DIRECTORY="${AOS_CHROME_PROFILE_DIRECTORY:-Profile 2}"
export AOS_CHROME_PROFILE_SURFACE="${AOS_CHROME_PROFILE_SURFACE:-signed_chrome_extension_profile2}"
# Keep the AOS worker's owned bridge endpoint separate from another Codex
# thread's legacy/default bridge.  The runner validates this as a loopback
# endpoint and binds the fresh port to the same readback instance; no external
# host or implicit browser fallback is accepted.
export AOS_CHROME_PLUGIN_BRIDGE_PORT="${AOS_CHROME_PLUGIN_BRIDGE_PORT:-58744}"
export AOS_CHROME_PLUGIN_READBACK_PATH="${AOS_CHROME_PLUGIN_READBACK_PATH:-$HOME/.social-flow/aos-company1-profile2-bridge-readback-v2.json}"
# The trusted bridge and the portable runner publish/read the private
# capability under CODEX_HOME. Keep the worker on that canonical path; the
# old .social-flow v2 path could be absent while the bridge was healthy.
export AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH="${AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH:-$CODEX_HOME/runtime/aos-chrome-plugin-background-read-only-capability.v1.json}"
# Workflow-specific business bindings are explicit startup configuration, not
# a hidden fallback in the generic runner.  They are still fail-closed unless
# external effects, approval, fresh authority, input bundle, and same-run
# receipt gates all pass.
export AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT="${AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT:-$HOME/Documents/New project}"
export BROWSER_USE_HOME="${BROWSER_USE_HOME:-$HOME/.browser-use-cli}"
export BROWSER_USE_RUNTIME_CONFIG="${BROWSER_USE_RUNTIME_CONFIG:-$BROWSER_USE_HOME/browser-use-runtime.toml}"
export BROWSER_USE_CLI_HELPER="${BROWSER_USE_CLI_HELPER:-${AUTOMATION_OS_BROWSER_USE_CLI_HELPER:-$HOME/.local/bin/codex-browser-use}}"
export AUTOMATION_OS_BROWSER_USE_CLI_HELPER="${AUTOMATION_OS_BROWSER_USE_CLI_HELPER:-$BROWSER_USE_CLI_HELPER}"
export AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION="${AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION:-$AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs}"
export AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI="${AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI:-$REPO_ROOT/scripts/aos-daily-ai-business-runner.mjs}"
export AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS="${AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS:-$REPO_ROOT/scripts/aos-nisenprints-business-runner.mjs}"

cd "$REPO_ROOT"
mkdir -p "$REPO_ROOT/data/logs"

# The resident remote worker is intentionally quiet while the queue is idle.
# Bound launchd logs anyway so a transient error or verbose child cannot fill
# the Mac disk.  Keep one recoverable rotated copy and never expose secrets in
# the rotation receipt.
rotate_log() {
  local log_path="$1"
  local max_bytes=10485760
  if [[ -f "$log_path" ]] && (( $(stat -f '%z' "$log_path" 2>/dev/null || echo 0) > max_bytes )); then
    local rotated_path="${log_path}.1"
    rm -f -- "$rotated_path"
    mv -- "$log_path" "$rotated_path"
    : > "$log_path"
    chmod 600 "$log_path" "$rotated_path"
  fi
}

rotate_log "$REPO_ROOT/data/logs/automation-os-worker-launchd.out.log"
rotate_log "$REPO_ROOT/data/logs/automation-os-worker-launchd.err.log"

# Zeabur owns the durable queue when the remote URL is configured.  The Mac
# worker uses the AOS API boundary instead of assuming that its local stored
# PostgreSQL is the Zeabur database.
if [[ -n "${AUTOMATION_OS_PORTABLE_REMOTE_URL:-}" ]]; then
  exec "$(command -v node)" "$REPO_ROOT/scripts/aos-portable-remote-worker.mjs"
fi

if [[ ! -f "$REPO_ROOT/apps/server/dist/cli/workerProductionFromStoredSecret.js" ]]; then
  npm run build:server
fi

if [[ "$AUTOMATION_OS_DATABASE_MODE" == "sqlite" ]]; then
  unset AUTOMATION_OS_DATABASE_URL DATABASE_URL
  exec npm run worker:loop
fi

exec npm run worker:loop:stored
