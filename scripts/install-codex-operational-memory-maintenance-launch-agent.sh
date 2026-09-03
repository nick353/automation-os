#!/bin/zsh
set -euo pipefail

label="com.nichikatanaka.codex-operational-memory-maintenance"
source_plist="/Users/nichikatanaka/Documents/Codex/automation-os/ops/launchd/${label}.plist"
target_plist="/Users/nichikatanaka/Library/LaunchAgents/${label}.plist"
runtime_script="/Users/nichikatanaka/.codex/runtime/operational-memory/codex-operational-memory-maintenance.mjs"
log_dir="/Users/nichikatanaka/.codex/log"
node_path="$(command -v node)"

if [[ ! -x "$node_path" ]]; then
  print -r -- '{"ok":false,"exact_blocker":"node_runtime_unavailable"}'
  exit 1
fi

if [[ ! -f "$runtime_script" || -L "$runtime_script" ]]; then
  print -r -- '{"ok":false,"exact_blocker":"operational_memory_runtime_unavailable"}'
  exit 1
fi

if /usr/bin/grep -Eq '/\.codex/hooks|hooks\.json|UserPromptSubmit|PostToolUse|SessionEnd' "$source_plist" "$runtime_script"; then
  print -r -- '{"ok":false,"exact_blocker":"operational_memory_launchagent_not_hookless"}'
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

print -r -- "{\"ok\":true,\"label\":\"${label}\",\"plist\":\"${target_plist}\",\"node\":\"${node_path}\",\"hookless\":true,\"interval_seconds\":3600}"
