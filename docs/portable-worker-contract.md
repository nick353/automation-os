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

The scheduler-level canary runs the same contract for all three portable
workflows with `source_trigger: automation_os_scheduler`:

```sh
npm run portable:scheduler-canary
```

It must report `checked: 3`, `completed: 3`, and
`external_action_executed: false`. This proves the scheduler-to-worker
contract is independent of the App; it does not claim that any live provider
action is ready.

## Verification

```sh
npm run portable:canary -- --workflow=job-application-manager --trigger=automation_os_scheduler
```

This is only a portability proof. It is not proof that a job was submitted,
mail was sent, or a product was published. Those stages need a separately
authorized worker adapter, provider readback, and the existing approval and
cleanup contracts.

## Migration order

1. Keep the current App schedules until the corresponding OS worker has a
   same-run canary and readback.
2. Register one OS schedule and run it in no-effect mode.
3. Quarantine legacy queued rows and let the worker claim only
   `execution_source=automation-os AND quarantined=0`.
4. Connect Browser Use CLI and connector adapters behind the same run manifest.
5. Enable external effects only with an explicit approval policy and provider
   readback.
6. Stop the matching App schedule only after the previous step has produced
   durable proof. Do not use App identity or a forged receipt as a workaround.
