# Hookless Codex runtime

## Current owners

Codex lifecycle hooks are intentionally not used. Each retained function has
one explicit owner:

- Long-task detection and historyless handoff: the independent
  `com.nichikatanaka.codex-project-state-sync` LaunchAgent. It runs every five
  minutes, creates at most one destination per pass at a safe terminal
  boundary, transfers the complete plan/Goal/decisions/evidence packet, and
  never archives the source task. Its bounded App Server child stays alive
  until the destination emits `turn/completed`; the receipt records both the
  destination task and continuation turn. A partial launch is reconciled
  against that existing destination and never creates a second task. Once a
  destination is claimed, the source receipt changes to
  `source_status=reconciliation_only` and `implementation_allowed=false`;
  after destination readiness it changes to `source_status=handoff_completed`.
  The source stays visible but cannot be selected for a second handoff.
- Explicit planned handoff: the `planned-session-handoff` Skill imports
  `/Users/nichikatanaka/.codex/runtime/session-handoff/` directly.
- Operational-memory lookup and outcome recording: the
  `codex-operational-memory` Skill invokes the hookless runtime CLI directly.
- Operational-memory compaction and Obsidian review export:
  `com.nichikatanaka.codex-operational-memory-maintenance`, hourly with an
  internal due-time lock.
- Secret-free completed-turn observation: the same five-minute project-state
  sync writes bounded `event=turn` candidates and one idempotent private
  `codex_operational_turn_outcome.v1` receipt per newly observed terminal turn.
  The first run only establishes watermarks, so removed hooks do not cause
  historical replay. Receipts contain counts and provenance, never raw prompt,
  transcript, or plan text, and never assert business completion, permission,
  or same-run verification.
- Automation activation safety: official Codex automation API lifecycle,
  `global-automation-manager.mjs` preflight, and
  `/Users/nichikatanaka/.local/bin/audit-codex-automations`.
- Browser and external-effect safety: the selected Browser Skill, registered
  runner receipts, Automation Kernel admission, project `AGENTS.md`, and
  `/Users/nichikatanaka/.codex/execution-policy.md`.
- Project/Obsidian context collection: the project-owned
  `/Users/nichikatanaka/Documents/Codex/automation-os/scripts/project-handoff-collector.mjs`.

## Former hook intent and hookless replacement

| Former lifecycle intent | Current hookless owner | Automatic now | Boundary |
| --- | --- | --- | --- |
| Long/context-heavy task handoff | Five-minute project-state sync + App Server | Yes, at a safe terminal boundary | Never interrupts an active turn; never archives the source |
| Preserve Goal, complete plan/statuses, decisions, evidence, blockers, external-effect state, next action | Immutable handoff packet + destination Goal readback | Yes | Incomplete plans and ambiguous external effects fail closed |
| Stop duplicate source execution | Claim/receipt state machine exposed in the ledger | Yes | Source becomes reconciliation-only after destination claim |
| Prompt-time project/operational context | Project `AGENTS.md`/authority files + explicit operational-memory lookup rule | Yes for runtime instructions; lookup is task-entry owned | No hidden prompt injection and no permission inference |
| Pre-tool safety | Selected Skill, runner, Automation Kernel admission, current-turn metadata issuer | Yes on supported workflow entrypoints | There is no universal native pre-tool interception without hooks |
| Post-tool result capture | Workflow receipt and same-run readback; asynchronous terminal-turn outcome receipt | Yes for registered workflow proof and generic terminal observation | Generic arbitrary-tool success is never guessed |
| Repeated-failure observation | Secret-free completed-turn observer + hourly memory maintenance | Yes, asynchronously | Candidate only; not proof of completion or external effect |
| Automation activation guard | Official automation API lifecycle + global manager/audit | Yes | Direct TOML/SQLite activation remains unsupported |

The former automatic prompt injection and universal per-tool command
interception are intentionally not recreated as a hidden hook substitute.
Their safe functions are owned by explicit runtime instructions, workflow
preflight/receipts, and the bounded asynchronous observer. The generic outcome
receipt proves only that a terminal turn was observed; it does not promote the
turn to business completion. A custom App Server client could intercept only
the turns and tools it exclusively owns; it cannot intercept every native
Desktop tool call while the normal Desktop client remains the caller.

## Safe-terminal reconstruction

Each scan fingerprints both rollout size and mtime, so a rollout change
invalidates a cached projection even when the thread database timestamp has
not advanced. The latest `task_complete.last_agent_message`, current-turn
`update_plan`, user intent, blocker section, and next-action list are then read
as one terminal segment. A current-turn plan wins. If it is absent, numbered
next actions rebuild pending steps while only already-completed steps are kept
from the prior plan; stale unfinished statuses and stale blockers are not
silently reused. When the terminal segment cannot reconcile a complete plan,
automatic handoff remains blocked.

External-effect classification also uses only the latest turn. An explicit
terminal declaration remains authoritative. Without one, a fully observed
turn is classified `observed_false` only when every recorded tool is
mechanically read-only (or no tool ran). A non-read-only hint, unknown tool, or
truncated observation remains `unknown`, which requires reconciliation and
forbids replay.

## Automatic handoff pressure

The five-minute sync evaluates pressure but elapsed time alone never triggers a
handoff. A safe-terminal task becomes pressure-eligible when any normal signal
is reached: context usage at least 72%, total tokens at least 250,000, or
rollout size at least 4 MiB. The time-based fallback requires both at least 120
minutes elapsed and context usage at least 50%. Project assignment, a complete
plan, unfinished work, and all source/destination safety gates are still
required before a new task is created. The scanner may inspect up to 50
candidates per pass to find one execution-eligible packet; an earlier blocked
candidate is recorded and skipped instead of starving later safe candidates.

## Definition of hookless

- no live `hooks.json` in the primary or supported alternate `CODEX_HOME`;
- the Codex `features.hooks` switch is explicitly disabled;
- no `[hooks]` or `[hooks.state]` table in the active Codex config;
- no supported executable imports or runs a file under `~/.codex/hooks`;
- no supported command generates a hook manifest;
- `~/.codex/hooks` does not exist after the migration;
- downloaded package test folders, inactive historical artifacts, and the
  protected restoration backup are not runtime registrations.

## Rollback

The pre-removal snapshot is
`/Users/nichikatanaka/.codex/backups/hookless-removal-20260825T142900Z`.
Its `manifest.sha256` covers the previous hooks, registration, config and
feature state. Restore only after stopping both hookless LaunchAgents, and only
if a verified regression cannot be repaired in the hookless owner. Restoring
the backup re-enables old code only after Codex re-reads the restored config;
it does not authorize archiving, external effects, or replay.

## Current-task resume controller

Resume no longer depends on a hidden lifecycle hook or on a destination task.
The shared `resume_current_task` controller is used by both manual recovery and
the hourly Companion audit. It accepts one fresh status/identity/ownership
readback and chooses exactly one blocker in this order:

`unknown_effect → foreign_owner → active_reconciliation → human_auth_required → provider_inactive → handoff_gate_active → stale_owner_recoverable → ready`

Only `ready` is eligible for the bounded sequence
`owner-only cleanup → fresh owner session → one same-thread continuation`.
The sequence is keyed by `taskId + generation + lastTerminalTurnId +
resumeIntent`; a repeated key is a no-op. Job tasks are explicitly
`source_thread_only`, so they do not create or continue a destination task.
The normal Job lane is `direct_application`: it uses the current Companion
owner run and treats old Codex handoff fields as diagnostic context only. The
signed `aos.job.source_resume_receipt.v1` is required only when the caller
explicitly selects the `source_return` lane (or requests a source-resume
receipt); it is an admission to continue in the source thread, never an
application-submission proof. Unknown effect, foreign ownership, active
reconciliation, authentication, and provider gates still apply to both lanes.
Heavy, Auth, and Note use their own adapter boundaries and retain provider or
human-only stops.

The scheduler-facing read-only plan can be inspected with:

```sh
node scripts/resume-current-task.mjs --input /path/to/fresh-readback.json --task-type job
```

This command never opens Chrome, sends a turn, enters credentials, or performs
an external effect. A trusted owner runtime must perform its own fresh
authority/readback and inject the three callbacks into
`scripts/lib/resume-controller.mjs` before executing the sequence.

## 2026-08-31 simplified control loop

The recurring audit has one source of truth: fresh Companion status plus the
latest user-session tail. A session is classified as `live_candidate`,
`paused`, or `history`; an old timestamp alone is not a stall signal. Only a
live candidate with an observed Companion or restart signal receives one
bounded repair attempt followed by a fresh readback. Interrupted work is
paused with its checkpoint, not silently duplicated.

The Companion runtime distinguishes local UI effects from external effects.
Local UI timeouts do not create reconciliation work. An ownerless stale
external record is closed into a ledger-only terminal record with its evidence
preserved; it is not replayed. Cleanup keeps only live, pinned, unsupported,
or freshly owned restart tabs and closes stale tracked tabs, while leaving
untracked user tabs alone. When the fingerprint is unchanged the scheduler
emits a heartbeat-only result instead of inventing work. In short:

`fresh readback → classify → one bounded action → readback → cleanup`

This is the hookless control path; it does not add a hidden lifecycle hook,
universal validator, or implicit browser-surface fallback.
