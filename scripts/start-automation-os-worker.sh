#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${AUTOMATION_OS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AUTOMATION_OS_DATABASE_MODE="${AUTOMATION_OS_DATABASE_MODE:-auto}"
export AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS="${AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS:-30000}"
export AUTOMATION_OS_WORKER_ROLE="${AUTOMATION_OS_WORKER_ROLE:-mac}"
export AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER="${AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER:-1}"
# The Mac worker is the resident durable-queue owner in the local deployment.
# Keep the server default unchanged so a server-owned deployment remains
# possible, but make the worker launch path explicit and fail-closed against
# an accidental scheduler gap when the API server is stopped.
export AUTOMATION_OS_DURABLE_SCHEDULER_OWNER="${AUTOMATION_OS_DURABLE_SCHEDULER_OWNER:-worker}"
# The service identity is provisioned per AOS company and must come from the
# LaunchAgent/environment.  Never invent a fallback identity: an unset value
# must reach the worker's explicit fail-closed admission check.
export AUTOMATION_OS_DURABLE_SERVICE_USER_ID="${AUTOMATION_OS_DURABLE_SERVICE_USER_ID:-}"
export AUTOMATION_OS_PORTABLE_WORKER_MODE="${AUTOMATION_OS_PORTABLE_WORKER_MODE:-external}"
# Keep the AOS runner resolver in control.  Do not pin the read-only adapter
# here: effects-enabled, approved runs must be able to select the
# provider-neutral business boundary instead.
unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER
export AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR="${AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR:-$REPO_ROOT}"
export AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS="${AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS:-3600000}"
export AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS="${AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS:-read_only}"
# Workflow-specific business bindings are explicit startup configuration, not
# a hidden fallback in the generic runner.  They are still fail-closed unless
# external effects, approval, fresh authority, input bundle, and same-run
# receipt gates all pass.
export AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT="${AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT:-/Users/nichikatanaka/Documents/New project}"
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
# remains the Browser Use CLI worker and must use the AOS API boundary instead
# of assuming that its local stored PostgreSQL is the Zeabur database.
if [[ -n "${AUTOMATION_OS_PORTABLE_REMOTE_URL:-}" ]]; then
  exec /usr/local/bin/node "$REPO_ROOT/scripts/aos-portable-remote-worker.mjs"
fi

if [[ ! -f "$REPO_ROOT/apps/server/dist/cli/workerProductionFromStoredSecret.js" ]]; then
  npm run build:server
fi

if [[ "$AUTOMATION_OS_DATABASE_MODE" == "sqlite" ]]; then
  unset AUTOMATION_OS_DATABASE_URL DATABASE_URL
  exec npm run worker:loop
fi

exec npm run worker:loop:stored
