#!/bin/zsh

set -euo pipefail

# Read-only Remote AOS schedule parity wrapper.  The registered service
# identity is kept inside the child environment and is never printed,
# persisted, passed as an argument, or included in the parity artifact.
script_dir="$(cd "$(dirname "$0")" && pwd)"
service_name="${AUTOMATION_OS_SERVICE_IDENTITY_KEYCHAIN_SERVICE:-Automation OS Zeabur Trigger}"
machine_token="$(security find-generic-password -a "$USER" -s "$service_name" -w 2>/dev/null || true)"
if [[ -z "$machine_token" ]]; then
  print -r -- '{"schema":"aos_codex_app_trigger_parity.v1","status":"blocked","exact_blocker":"aos_trigger_service_identity_missing","external_action_executed":false,"secret_values_read":false}'
  exit 2
fi

export AOS_PARITY_AOS_BASE_URL="https://automation-os.zeabur.app"
export AOS_PARITY_AOS_TOKEN="$machine_token"
unset machine_token

exec /usr/bin/env node "$script_dir/aos-codex-app-trigger-parity-readback.mjs"
