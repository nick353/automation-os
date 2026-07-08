#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${AUTOMATION_OS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS="${AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS:-30000}"
export AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER="${AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER:-1}"

cd "$REPO_ROOT"
mkdir -p "$REPO_ROOT/data/logs"

if [[ ! -f "$REPO_ROOT/apps/server/dist/cli/workerProductionFromStoredSecret.js" ]]; then
  npm run build:server
fi

exec npm run worker:loop:stored
