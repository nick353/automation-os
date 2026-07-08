# Automation OS

Automation OS is a local control surface for recurring automation work across Codex, Obsidian, Playwright, and project-specific runners. Its job is to answer three questions quickly: what is running, what is blocked, and what proof exists.

The repository contains the app, server, workflow contracts, docs, and local runner glue. It does not contain live SQLite databases, browser profiles, artifacts, logs, screenshots, API keys, OAuth tokens, or personal execution state.

## Current Shape

- `apps/server` exposes the local API, workflow registry, worker engine, proof gates, Obsidian ingest/export, and runner adapters.
- `apps/web` is the local dashboard for sources, runs, approvals, and actionable next steps.
- `docs` records architecture, roadmap, Codex app parity, local worker rules, and Obsidian export design.
- `scripts` contains local wrappers for development and selected Playwright-based workflow lanes.
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

## Production Safety

Public deployments must be treated as read-mostly control surfaces. When `PORT` is present, the server locks `POST`, `PATCH`, `PUT`, and `DELETE` API calls by default. To deliberately allow production writes, set `AUTOMATION_OS_WRITE_TOKEN` and send it as `x-automation-os-token`. Do not set `AUTOMATION_OS_REQUIRE_WRITE_TOKEN=0` unless the service is private and isolated.

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
AUTOMATION_OS_WRITE_TOKEN=<set in the host secret manager>
```

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

This checks the public JSON APIs and captures desktop/mobile screenshots under `/tmp/automation-os-production-qa-*` when Playwright CLI is available.

## Git Boundary

The following are intentionally ignored:

- `data/`, including SQLite databases, `resume-contract.json`, secret store files, and local run state.
- `artifacts/`, `output/`, `logs/`, `test-results/`, and Playwright session folders.
- `.env` files and private key material.

Before publishing or pushing, run a secret scan against the staged files and verify that only source code, docs, package manifests, and safe templates are included.

## Operating Rules

Generated Obsidian pages and handoff notes are locators, not proof. Before resuming work, read `data/resume-contract.json`, the Obsidian handoff index/current-work notes, then this repository's `STATE.md`, DB rows, and latest workflow artifacts.

Playwright CLI is the primary browser verification lane. Browser Use artifacts are historical or diagnostic unless a workflow explicitly requires them.

Billing, purchase, payment, checkout, paid subscription, invoice, or billing-equivalent screens are the hard stops. Non-billing post, publish, submit, send, save, and in-scope delete actions require workflow-owned evidence and readback rather than a generic approval stop.
