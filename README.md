# Automation OS

Automation OS is a local control surface for recurring automation work across Codex, Obsidian, the canonical Browser Use CLI, and project-specific connectors. Its job is to answer three questions quickly: what is running, what is blocked, and what proof exists.

The repository contains the app, server, workflow contracts, docs, and local runner glue. It does not contain live SQLite databases, browser profiles, artifacts, logs, screenshots, API keys, OAuth tokens, or personal execution state.

## Current Shape

- `apps/server` exposes the local API, workflow registry, worker engine, proof gates, Obsidian ingest/export, and runner adapters.
- `apps/web` is the local dashboard for sources, runs, approvals, and actionable next steps.
- `docs` records architecture, roadmap, Codex app parity, local worker rules, and Obsidian export design.
- `scripts` contains local wrappers for development, the canonical Browser Use CLI boundary, and connector-only workflows.
- `STATE.md` is the human-readable project state. Runtime truth lives in the configured database, plus workflow-owned artifacts.

## Local Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
npm run dev
```

The default server port is `8787`. The dev script starts the local server and web UI together.

### Codex App Server Probe

`AUTOMATION_OS_CODEX_APP_SERVER_PROBE_ENABLED` defaults to `0`. When set to `1`, `POST /api/codex/app-server/probe` performs a bounded stdio initialize-only read-only probe.

Tune the probe with:

```bash
AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND=codex
AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TIMEOUT_MS=1500
AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TTL_MS=30000
```

A successful probe only refreshes capability inventory. It still leaves `appServer.state.connected=false`, and it is not authority, external action, or completion proof.

## Production Safety

Public deployments must be treated as private operator control surfaces. All `/api/*` routes except `/api/health` require `AUTOMATION_OS_WRITE_TOKEN` by default, even when `PORT` is absent; the same token also protects state-changing calls. Send it as `x-automation-os-token`. Only the loopback-only local launcher sets `AUTOMATION_OS_REQUIRE_API_TOKEN=0`. Do not disable either guard on a publicly reachable service.

PostgreSQL is the preferred production database. Create a PostgreSQL service in the host, then set one of these variables on the Automation OS service:

```bash
DATABASE_URL=<postgres connection string>
# or
AUTOMATION_OS_DATABASE_URL=<postgres connection string>
```

On Zeabur, add a Database -> PostgreSQL service, then set `DATABASE_URL=${POSTGRES_URI}` in the Automation OS service Variables tab.

The Create chat uses `/api/create/plan` as its planner backend. By default, local Mac runs use the installed Codex CLI subscription path, while production-like hosts fall back to the local planner so the app can boot, test, and deploy without OpenAI API billing. Set `AUTOMATION_OS_CREATE_PLANNER_PROVIDER=openai` only when API billing is acceptable; then `OPENAI_API_KEY` and optional `OPENAI_PLANNER_MODEL` are used.

When either variable is set, Automation OS initializes and uses PostgreSQL. When neither is set, it falls back to SQLite. For a temporary SQLite production fallback, use an explicit persistent database path:

```bash
AUTOMATION_OS_DB=/data/automation-os.sqlite
AUTOMATION_OS_REQUIRE_WRITE_TOKEN=1
AUTOMATION_OS_REQUIRE_API_TOKEN=1
AUTOMATION_OS_WRITE_TOKEN=<set in the host secret manager>
# Set one read-only token in the host secret manager for authenticated QA/replay
# readback. The value must never be committed or pasted into chat.
AUTOMATION_OS_READ_TOKEN=<set in the host secret manager>
```

`npm run qa:production` and `npm run qa:production:replay` look for
`AUTOMATION_OS_READ_TOKEN`, `AUTOMATION_OS_QA_READ_TOKEN`, then
`AUTOMATION_OS_REPLAY_READ_TOKEN`. If none is injected into the QA process,
the exact blocker is `production_read_token_missing`; the tools do not guess a
write token or bypass the protected API.

To copy an existing SQLite database into an empty PostgreSQL database, run this from a trusted local shell. The confirmation variable is intentional because the target PostgreSQL tables are replaced:

```bash
AUTOMATION_OS_SQLITE_SOURCE=./data/automation-os.sqlite \
DATABASE_URL=<postgres connection string> \
AUTOMATION_OS_CONFIRM_POSTGRES_MIGRATION=1 \
npm run db:migrate:postgres
```

Rollback is configuration-only: remove `DATABASE_URL` / `AUTOMATION_OS_DATABASE_URL` from the Automation OS service and redeploy to return to SQLite. If rolling back after a PostgreSQL write window, export or inspect the PostgreSQL rows first so new production state is not silently abandoned.

After every deployment, run:

```bash
npm run qa:production -- https://automation-os.zeabur.app
```

This checks the public JSON APIs. Browser/UI QA must use a fresh, same-run canonical Browser Use CLI authority/profile/port and recording proof; if that surface is unavailable, QA stops with an exact blocker rather than falling back to Playwright, direct Chrome, CDP, or the Codex in-app browser.

## Git Boundary

The following are intentionally ignored:

- `data/`, including SQLite databases, `resume-contract.json`, secret store files, and local run state.
- `artifacts/`, `output/`, `logs/`, `test-results/`, and browser session folders.
- `.env` files and private key material.

Before publishing or pushing, run a secret scan against the staged files and verify that only source code, docs, package manifests, and safe templates are included.

`lint_not_configured`: there is no dedicated repo lint script. Use `npm run build`, `npm run typecheck:web`, and `npm test` as the maintained verification set.

`dedicated_secret_scanner unavailable`: use a bounded grep-based secret scan against the changed files instead of a missing workspace scanner.

## Operating Rules

Generated Obsidian pages and handoff notes are locators, not proof. Before resuming work, read `data/resume-contract.json`, the Obsidian handoff index/current-work notes, then this repository's `STATE.md`, DB rows, and latest workflow artifacts.

Browser Use CLI is the only permitted Automation OS browser surface. Every browser-backed adapter must either call the canonical helper through the shared flow adapter with fresh authority/profile/port, same-session readback, and cleanup proof, or fail closed with `browser_use_cli_required` / `browser_use_cli_workflow_adapter_missing`. Playwright, direct Chrome, direct CDP, extension-backed browser lanes, and Codex in-app browser fallbacks are retired from registered automation execution.

Billing, purchase, payment, checkout, paid subscription, invoice, or billing-equivalent screens are the hard stops. Non-billing post, publish, submit, send, save, and in-scope delete actions require workflow-owned evidence and readback rather than a generic approval stop.
