#!/bin/zsh
set -euo pipefail

label="com.nichikatanaka.codex-project-state-sync"
source_plist="/Users/nichikatanaka/Documents/Codex/automation-os/ops/launchd/${label}.plist"
target_plist="/Users/nichikatanaka/Library/LaunchAgents/${label}.plist"
log_dir="/Users/nichikatanaka/.codex/log"
node_path="$(command -v node)"
sync_script="/Users/nichikatanaka/Documents/Codex/automation-os/scripts/codex-project-state-sync.mjs"
sync_lib="/Users/nichikatanaka/Documents/Codex/automation-os/scripts/lib/codex-project-state.mjs"
policy_path="/Users/nichikatanaka/Documents/Codex/automation-os/data/codex-project-state-policy.json"

if [[ ! -x "$node_path" ]]; then
  print -r -- '{"ok":false,"exact_blocker":"node_runtime_unavailable"}'
  exit 1
fi

if /usr/bin/grep -Eq 'thread/archive|--archive' "$sync_script" "$sync_lib" "$source_plist"; then
  print -r -- '{"ok":false,"exact_blocker":"codex_project_state_archive_capability_present"}'
  exit 1
fi

if ! "$node_path" --input-type=module -e '
  import fs from "node:fs";
  const policy = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (policy.archive?.enabled === true || policy.task_retention?.archive_tasks !== false) process.exit(1);
  const mode = policy.handoff?.mode;
  const automatic = policy.handoff?.automatic_thread_creation === true;
  if (!["prepare_only", "automatic"].includes(mode)) process.exit(1);
  if ((mode === "automatic") !== automatic) process.exit(1);
  if (mode === "automatic" && (!Date.parse(policy.handoff?.activation_not_before || "") || !(policy.handoff?.protected_thread_ids || []).length)) process.exit(1);
' "$policy_path"; then
  print -r -- '{"ok":false,"exact_blocker":"codex_project_state_handoff_policy_invalid"}'
  exit 1
fi

mkdir -p "/Users/nichikatanaka/Library/LaunchAgents" "$log_dir"
sed "s#<string>/usr/local/bin/node</string>#<string>${node_path}</string>#" "$source_plist" > "${target_plist}.tmp"
plutil -lint "${target_plist}.tmp" >/dev/null
chmod 600 "${target_plist}.tmp"
mv "${target_plist}.tmp" "$target_plist"

launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$target_plist"
launchctl kickstart -k "gui/$(id -u)/${label}"

print -r -- "{\"ok\":true,\"label\":\"${label}\",\"plist\":\"${target_plist}\",\"node\":\"${node_path}\",\"mode\":\"automatic\",\"automatic_thread_creation\":true,\"source_tasks_archived\":0}"
