# Automation OS recovery runbook

This is the restart point when the current Mac, AOS host, or Codex account is
replaced. The durable source of truth is the AOS GitHub repository plus the
same production PostgreSQL database. Host secrets, Codex authentication,
Browser Use sessions, and provider sessions are intentionally not stored in
GitHub.

## Recovery order

1. Recover the AOS control plane on Zeabur or another server.
2. Point it at the existing PostgreSQL database and restore host-managed API
   tokens. Do not start with a new empty SQLite database.
3. Recover the optional Codex App Server and connect it through a private
   service route or authenticated `wss://` endpoint.
4. Recover one Browser Use CLI worker on any available Mac, then let AOS claim
   queued work. Do not run Browser Use inside the AOS or Codex Server host.
5. Run readiness, Codex read-only canary, worker heartbeat, and one AOS
   no-effect canary. Enable external effects only after workflow-specific
   approval and provider readback gates pass.

The AOS database, run IDs, registered-root admission, leases, receipts, and
reconciliation remain server-side. A worker or Codex account is an execution
capability, not the owner of the AOS history.

## AOS host recovery

Use a checked-out GitHub ref. The current branch is recorded by the GitHub
publish result; use the repository default branch after the change is merged.

```sh
export AOS_ROOT=/srv/automation-os
git clone --branch '<published-aos-ref>' https://github.com/nick353/automation-os.git "$AOS_ROOT"
cd "$AOS_ROOT"
npm ci
node scripts/recovery-preflight.mjs
npm run build
```

Inject these values through the new server's secret manager, not through Git or
chat:

```text
AUTOMATION_OS_ENV_ROLE=production
DATABASE_URL=<same production PostgreSQL URL>
AUTOMATION_OS_REQUIRE_API_TOKEN=1
AUTOMATION_OS_REQUIRE_WRITE_TOKEN=1
AUTOMATION_OS_READ_TOKEN=<read-only host secret>
AUTOMATION_OS_WRITE_TOKEN=<write host secret>
AUTOMATION_OS_RUNTIME_ROLE=control_plane
AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED=0
```

Start the AOS service using the host's process manager, then verify:

```sh
curl -fsS https://<aos-host>/readyz
npm run qa:production -- https://<aos-host>
```

The readback must show the same PostgreSQL-backed control plane. A healthy
`/readyz` alone is not proof that workers, Codex, or Browser Use are ready.

## Codex App Server recovery and connection

Codex App Server is optional. Local stdio remains the supported fallback. When
the dedicated server is needed, build from the repository's fixed service
source:

```sh
npm run codex:server:source-preflight
npm run codex:server:stage -- --output /absolute/path/to/codex-app-server-stage
```

Deploy `Dockerfile` from that staging directory to a dedicated service. Give
the service:

- a persistent volume mounted at `CODEX_HOME` (`/data/codex` in the template);
- a secret-manager file at `/run/secrets/codex-app-server-token`, mode `0400`;
- `CODEX_APP_SERVER_TOKEN_FILE` pointing to that file;
- loopback binding unless the host has an approved private ingress and TLS.

The Codex account must be authenticated inside that persistent `CODEX_HOME`
using the official Codex login flow. Do not copy `auth.json`, cookies, or a
token into the image, GitHub, ordinary environment readback, or logs.

For AOS and Codex App Server in the same Zeabur project, set these only on the
AOS service:

```text
AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL=ws://codex-app-server.zeabur.internal:8080/
AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS=1
AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN_FILE=/run/secrets/aos-codex-app-server-token
AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_CWD=/app
```

For a different host, use an authenticated TLS endpoint instead:

```text
AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL=wss://<private-codex-host>/
AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN_FILE=/run/secrets/aos-codex-app-server-token
AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_CWD=/app
```

Never put the Zeabur internal hostname or the Codex App Server token in the
Mac worker profile. After configuration, run the AOS readiness/probe and a
read-only `initialize` → `account/read` → ephemeral `thread/start` →
read-only `turn/start` canary. The remote WebSocket transport remains an
experimental promotion boundary; a successful canary does not move Browser
Use, local files, Obsidian, or provider cookies to the server.

## Browser Use worker recovery

On any available Mac:

```sh
export AOS_ROOT=/Users/<operator>/Documents/Codex/automation-os
cd "$AOS_ROOT"
npm ci
node scripts/portable-worker-profile.mjs init \
  --output "$HOME/Library/Application Support/Automation OS/worker-profile.json" \
  --repo-root "$AOS_ROOT" \
  --company-id '<aos-company-id>' \
  --worker-id "mac-$(hostname -s)" \
  --codex-home "$HOME/.codex" \
  --codex-account-ref 'recovery-worker'
codex login
zsh scripts/install-automation-os-worker-launch-agent.sh install
```

Register the AOS worker token in Keychain using the profile's `token_service`,
or provide a separate owner-only token file. Then verify the local canonical
Browser Use runtime and worker heartbeat. Browser cookies, MCP connector
authorization, CAPTCHA/OTP, and provider sessions require fresh human login.

When replacing a Mac, start the new worker first, confirm `heartbeat_status=ok`,
then stop the old worker. AOS leases prevent the same queued run from being
claimed twice. No AOS database migration or Codex account migration is needed.

## Stop conditions

Stop and record the exact blocker if PostgreSQL is unavailable, API secrets are
missing, Codex login is absent, the Codex remote transport is not approved, the
canonical Browser Use CLI is missing, or a provider requires human
authentication. Do not substitute SQLite, the Codex App browser, Playwright,
direct CDP, or a forged receipt.
