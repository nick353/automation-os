#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${AUTOMATION_OS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AUTOMATION_OS_PORT="${AUTOMATION_OS_PORT:-8787}"
export AUTOMATION_OS_REQUIRE_API_TOKEN="${AUTOMATION_OS_REQUIRE_API_TOKEN:-0}"
export AUTOMATION_OS_DATABASE_MODE="${AUTOMATION_OS_DATABASE_MODE:-auto}"
# Browser work is admitted only through the canonical Browser Use CLI.  Keep
# the old auto-CDP toggle out of the server environment so a stale shell
# setting cannot re-enable a retired launch path.
export AUTOMATION_OS_BROWSER_NO_FALLBACK="1"
export AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS="${AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS:-60000}"
export AUTOMATION_OS_PORTABLE_WORKER_MODE="${AUTOMATION_OS_PORTABLE_WORKER_MODE:-external}"
# Leave runner selection to the AOS-owned resolver.  It selects the
# read-only Browser Use CLI adapter by default and switches to the business
# adapter only when the explicit external-effect gate is enabled.  A fixed
# runner here would silently defeat that boundary.
unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER
export AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR="${AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR:-$REPO_ROOT}"
export AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS="${AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS:-read_only}"
export AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT="${AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT:-1}"
export AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS="${AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS:-1800000}"
export AUTOMATION_OS_ALLOW_SQLITE_FALLBACK="${AUTOMATION_OS_ALLOW_SQLITE_FALLBACK:-0}"
export AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER="${AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER:-1}"

case "${AUTOMATION_OS_ENV_ROLE:-}" in
  ""|production|recovery) ;;
  *)
    printf 'automation_os_startup_blocked:automation_os_env_role_invalid\n' >&2
    exit 2
    ;;
esac

case "$AUTOMATION_OS_DATABASE_MODE" in
  auto|sqlite|postgres) ;;
  *)
    printf 'automation_os_startup_blocked:automation_os_database_mode_invalid\n' >&2
    exit 2
    ;;
esac

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

if [[ "$AUTOMATION_OS_DATABASE_MODE" == "sqlite" ]]; then
  unset AUTOMATION_OS_DATABASE_URL DATABASE_URL
elif [[ "$AUTOMATION_OS_DATABASE_MODE" == "postgres" ]]; then
  if [[ -z "${AUTOMATION_OS_DATABASE_URL:-}" && -z "${DATABASE_URL:-}" ]]; then
    if [[ ! -f "$REPO_ROOT/apps/server/dist/cli/readStoredPostgresSecret.js" ]]; then
      printf 'missing built secret reader: %s\n' "$REPO_ROOT/apps/server/dist/cli/readStoredPostgresSecret.js" >&2
      exit 1
    fi
    stored_database_url="$(node apps/server/dist/cli/readStoredPostgresSecret.js 2>/dev/null || true)"
    if [[ -n "$stored_database_url" ]]; then
      export AUTOMATION_OS_DATABASE_URL="$stored_database_url"
      export AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA="${AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA:-1}"
    else
      printf 'automation_os_startup_blocked:postgres_database_configuration_missing\n' >&2
      exit 2
    fi
  fi
else
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
    if [[ -n "${AUTOMATION_OS_DATABASE_URL:-}" || -n "${DATABASE_URL:-}" ]]; then
      printf 'stored Postgres connection unavailable; preserving direct database configuration.\n' >&2
    elif [[ "${AUTOMATION_OS_ENV_ROLE:-}" == "production" ]]; then
      printf 'automation_os_startup_blocked:production_postgres_configuration_unavailable\n' >&2
      exit 2
    elif [[ "$AUTOMATION_OS_ALLOW_SQLITE_FALLBACK" == "1" ]]; then
      printf 'stored Postgres connection unavailable; falling back to local sqlite because AUTOMATION_OS_ALLOW_SQLITE_FALLBACK=1.\n' >&2
    else
      printf 'stored Postgres connection unavailable; refusing to start Automation OS UI/API to avoid DB split.\n' >&2
      exit 2
    fi
  fi
fi

if command -v npm >/dev/null 2>&1; then
  exec npm run start:server
fi

exec node "$REPO_ROOT/apps/server/dist/index.js"
