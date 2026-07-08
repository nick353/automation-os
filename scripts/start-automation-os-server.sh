#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${AUTOMATION_OS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AUTOMATION_OS_PORT="${AUTOMATION_OS_PORT:-8787}"
export AUTOMATION_OS_BROWSER_USE_AUTO_CDP="${AUTOMATION_OS_BROWSER_USE_AUTO_CDP:-0}"
export AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS="${AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS:-0}"
export AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS="${AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS:-0}"
export AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER="${AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER:-1}"

cd "$REPO_ROOT"
mkdir -p "$REPO_ROOT/data/logs"

needs_build=0
if [[ "${AUTOMATION_OS_SKIP_BUILD_CHECK:-0}" == "1" ]]; then
  if [[ ! -f "$REPO_ROOT/apps/server/dist/index.js" ]]; then
    printf 'missing built server: %s\n' "$REPO_ROOT/apps/server/dist/index.js" >&2
    exit 1
  fi
  if [[ -f "$REPO_ROOT/data/secrets/secret_postgres_api_key.json" && ! -f "$REPO_ROOT/apps/server/dist/cli/readStoredPostgresSecret.js" ]]; then
    printf 'missing built secret reader: %s\n' "$REPO_ROOT/apps/server/dist/cli/readStoredPostgresSecret.js" >&2
    exit 1
  fi
elif [[ ! -f "$REPO_ROOT/apps/server/dist/index.js" ]]; then
  needs_build=1
elif find "$REPO_ROOT/apps/server/src" "$REPO_ROOT/apps/server/tsconfig.json" "$REPO_ROOT/package.json" -newer "$REPO_ROOT/apps/server/dist/index.js" -print -quit | grep -q .; then
  needs_build=1
fi

if [[ "$needs_build" == "1" ]]; then
  npm run build:server
fi

has_postgres_secret=0
if [[ -f "$REPO_ROOT/data/secrets/secret_postgres_api_key.json" ]]; then
  has_postgres_secret=1
fi
if [[ "$has_postgres_secret" == "1" && ! -f "$REPO_ROOT/apps/server/dist/cli/readStoredPostgresSecret.js" ]]; then
  printf 'missing built secret reader: %s\n' "$REPO_ROOT/apps/server/dist/cli/readStoredPostgresSecret.js" >&2
  exit 1
fi
if stored_database_url="$(node apps/server/dist/cli/readStoredPostgresSecret.js 2>/dev/null)"; then
  if [[ -n "$stored_database_url" ]]; then
    export AUTOMATION_OS_DATABASE_URL="$stored_database_url"
    export AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA="${AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA:-1}"
  fi
elif [[ "$has_postgres_secret" == "1" ]]; then
  printf 'stored Postgres connection unavailable; refusing to start Automation OS UI/API to avoid DB split.\n' >&2
  exit 2
fi

if command -v npm >/dev/null 2>&1; then
  exec npm run start:server
fi

exec node "$REPO_ROOT/apps/server/dist/index.js"
