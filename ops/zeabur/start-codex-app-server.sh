#!/bin/sh
set -eu

port="${PORT:-${CODEX_APP_SERVER_PORT:-4500}}"
bind_host="${CODEX_APP_SERVER_BIND_HOST:-127.0.0.1}"
token_file="${CODEX_APP_SERVER_TOKEN_FILE:-}"
if [ -z "$token_file" ] || [ ! -f "$token_file" ] || [ -L "$token_file" ] || [ ! -r "$token_file" ]; then
  echo "CODEX_APP_SERVER_TOKEN_FILE must point to a readable host-secret file" >&2
  exit 78
fi

case "$bind_host" in
  127.0.0.1|localhost|::1)
    ;;
  *)
    if [ "${CODEX_APP_SERVER_NON_LOOPBACK_APPROVED:-0}" != "1" ] || [ "${CODEX_APP_SERVER_TLS_TERMINATED:-0}" != "1" ]; then
      echo "non-loopback App Server binding requires explicit private-ingress and TLS approval" >&2
      exit 78
    fi
    ;;
esac

if [ "$(wc -c < "$token_file")" -le 0 ]; then
  echo "CODEX_APP_SERVER_TOKEN_FILE is empty" >&2
  exit 78
fi

codex_home="${CODEX_HOME:-/data/codex}"
mkdir -p "$codex_home"
export CODEX_HOME="$codex_home"

# The token-file form keeps the bearer out of argv and the long-lived process
# environment. Keep the file mounted by the host secret manager and private.
# Zeabur must terminate TLS on the approved private ingress and forward only
# WebSocket upgrades to this listener.

exec codex app-server \
  --listen "ws://${bind_host}:${port}" \
  --ws-auth capability-token \
  --ws-token-file "$token_file"
