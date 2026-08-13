# Portable worker contract

The Automation OS schedule is the source of truth for execution. Codex App may
remain a UI or trigger bridge, but a run must not require a Codex App thread,
controller identity, first-class root, or App-owned session.

## Contract

`apps/server/src/runs/portableWorkflowContract.ts` defines the versioned
workflow and run manifests. Every portable workflow uses:

- `automation_os_worker` as the execution backend
- the canonical `browser_use_cli` surface for browser work
- the `mcp` gateway for connector work such as Gmail
- `app_dependency: false`
- an explicit idempotency key

The canary always sets `external_action_allowed: false`. It validates the
binding and writes a receipt without starting Browser Use, calling a connector,
or producing an external effect.

The scheduler-level canary runs the same contract for all six fixed registered
workflows with `source_trigger: automation_os_scheduler`:

```sh
npm run portable:scheduler-canary
```

It must report `checked: 6`, `completed: 6`, and
`external_action_executed: false`. This proves the scheduler-to-worker
contract is independent of the App; it does not claim that any live provider
action is ready.

When the local server and stored-secret worker are explicitly in
`AUTOMATION_OS_PORTABLE_WORKER_MODE=canary`, the registered scheduler also
admits the six fixed global workflows without a global service identity. The
admission is limited to the no-effect canary and writes a portable admission
marker to the run. With the variable unset, existing legacy scheduler behavior
is preserved; the UI's AOS manual endpoint still uses the portable canary
contract by default.

To enable a real external worker, configure both sides explicitly:

```sh
AUTOMATION_OS_PORTABLE_WORKER_MODE=external
AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER=/absolute/path/to/portable-runner
AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR=/absolute/path/to/worker-workdir
```

The repository includes the common Mac-side dispatcher at
`scripts/portable-external-runner.mjs`. Its workflow authorities,
Browser Use CLI paths, project roots, and Codex home are resolved from the
portable worker profile rather than from a specific user's home directory.
It starts a non-App `codex exec` process with the workflow-specific authority
packet and requires the canonical Browser Use CLI/MCP contract in its prompt.
The default is read-only; configure the Mac worker as follows before starting
the stored-secret loop:

```sh
export AUTOMATION_OS_PORTABLE_WORKER_MODE=external
export AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER="$PWD/scripts/portable-external-runner.mjs"
export AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR="$PWD"
export AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=read_only
npm run worker:loop:stored
```

The six workflow IDs are dispatched by the same runner. `read_only` performs
preflight/discovery and returns `external_action_executed=false`. Only after
the workflow's current authority and provider readback have been verified may
the operator explicitly set `AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=enabled`.
That setting is not required on the Zeabur server; it belongs to the Mac worker
that owns Browser Use CLI and MCP credentials.

The runner is invoked without a shell and receives `--workflow-id`, `--run-id`,
`--step-id`, `--source-trigger`, and `--idempotency-key`. It must print one
final JSON receipt such as `{"status":"complete","external_action_executed":false}`
or a blocked receipt with `exact_blocker`. The runner is the place to call the
canonical Browser Use CLI and the Codex Server/MCP plugin gateway; Codex App is
not part of this process. If the runner is absent, the run stops with the exact
blocker `portable_external_adapter_not_configured`.

## Worker relocation and Codex account switching

The AOS company, run IDs, registered-root admission, durable receipts, and
effect authority are server-side. A worker machine is only a bounded adapter.
The AOS worker credential is company-scoped and is not a Codex account token.
Keep it in macOS Keychain under the configured `token_service`, or in a
0600-or-stricter `token_file`; never put the token in the profile or commit it.

Create a machine-local, non-secret profile once on each worker:

```sh
node scripts/portable-worker-profile.mjs init \
  --output "$HOME/Library/Application Support/Automation OS/worker-profile.json" \
  --repo-root "$PWD" \
  --company-id '<aos-company-id>' \
  --worker-id "mac-$(hostname -s)" \
  --codex-home "$HOME/.codex" \
  --codex-account-ref 'primary'
zsh scripts/install-automation-os-worker-launch-agent.sh install
```

To switch the local Codex account, use a separate `CODEX_HOME`, authenticate
that profile with the official Codex login flow, then update only the profile
and restart the worker:

```sh
export CODEX_HOME="$HOME/.codex-secondary"
codex login
node scripts/portable-worker-profile.mjs init \
  --output "$HOME/Library/Application Support/Automation OS/worker-profile.json" \
  --repo-root "$PWD" \
  --company-id '<same-aos-company-id>' \
  --worker-id "mac-$(hostname -s)" \
  --codex-home "$CODEX_HOME" \
  --codex-account-ref 'secondary' \
  --force
zsh scripts/install-automation-os-worker-launch-agent.sh install
```

To move to another Mac, repeat the same bootstrap with that Mac's repository,
Browser Use CLI helper/runtime, project roots, and Keychain/token-file setup.
Run the canonical Browser Use CLI `runtime-readback` and one AOS no-effect
canary before enabling any effectful workflow. Browser cookies, provider
sessions, connector authorization, CAPTCHA/OTP, and Codex login are local
capabilities and must be re-authenticated on the new machine/account; they are
not silently migrated by AOS.

The same run contract can be started by the Automation OS UI, its scheduler,
launchd, GitHub Actions, or the legacy App bridge through the shared entrypoint:

```sh
npm run portable:worker-start -- \
  --workflow=daily-ai-research-publish-run \
  --trigger=automation_os_scheduler \
  --idempotency-key=example-run-2026-08-03
```

The entrypoint is idempotent for the workflow, trigger, and key tuple and only
creates an Automation OS run. The worker owns execution and readback; the
canary worker stops before Browser Use CLI, MCP, or any external action.

The AOS UI exposes the same contract for every fixed registered workflow:

- `POST /api/portable-workflows/:id/run` queues a manual run from the UI with
  `source_trigger: automation_os_ui` and an idempotency key. This endpoint is
  served by Automation OS and does not require a Codex App controller identity.
- `POST /api/registered-workflows/:id/pause` and `/resume` control the AOS
  schedule from the UI.
- The run response reports `runId`, `workerProtocol`, execution mode, and
  `external_action_executed`; it never treats queueing as business completion.

## Verification

```sh
npm run portable:canary -- --workflow=job-application-manager --trigger=automation_os_scheduler
```

This is only a portability proof. It is not proof that a job was submitted,
mail was sent, or a product was published. Those stages need a separately
authorized worker adapter, provider readback, and the existing approval and
cleanup contracts.

## Migration order

1. Keep the current App schedules paused until the corresponding OS worker has a
   same-run canary and readback.
2. Register one OS schedule and run it in no-effect mode.
3. Quarantine legacy queued rows and let the worker claim only
   `execution_source=automation-os AND quarantined=0`.
4. Connect Browser Use CLI and connector adapters behind the same run manifest.
5. Enable external effects only with an explicit approval policy and provider
   readback.
6. Stop the matching App schedule only after the previous step has produced
   durable proof. Do not use App identity or a forged receipt as a workaround.
