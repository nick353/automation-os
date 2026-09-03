# Hookless Codex project state and session handoff

## Outcome

Codex tasks remain visible execution surfaces; they are never archived or
deleted by this service. An independent background sync reads the local Codex
thread database, rollout files, and project-owned authority files. It does not
receive, import, or depend on a Codex hook event.

The bounded project ledger is written to:

`~/.codex/project-state-ledger/ledger.v1.json`

Prepared handoff packets are written with mode `0600` under:

`~/.codex/project-state-ledger/handoff-packets/<source-thread-id>/`

Each packet keeps the logical objective, formal Goal readback when available,
the complete `update_plan` snapshot and every status, decisions, completed and
unfinished work, blockers and unknowns, authority/evidence pointers,
external-effect state, one next action, and a stop condition. It does not copy
the raw transcript.

## Trigger and safety boundary

A task becomes a handoff candidate only at a detected safe terminal boundary
and only when at least one pressure signal is present:

- long task duration;
- large rollout size;
- high current-context ratio from Codex `token_count` events; or
- high cumulative task token use.

The current task, an active turn, a pinned/protected task, an ambiguous project,
an incomplete plan, a task with no unfinished work, and pre-activation history
are excluded. Unknown or ambiguous external-effect state is preserved in the
packet and blocks automatic destination creation until reconciliation.

The invariant is permanent:

`source_task_retention = keep_visible_never_archive`

There is no `thread/archive` call, archive CLI option, or direct Codex SQLite
write in the executable service. The installer rejects an executable archive
marker or a policy that does not say `archive_tasks=false`.

## Destination contract

The destination implementation is hook-independent and uses the official
app-server protocol only:

1. acquire one source-bound O_EXCL claim;
2. call `thread/start` once;
3. read back zero inherited turns;
4. set the title;
5. rehydrate and read back the formal Goal when present;
6. dispatch one continuation turn that points to the immutable packet; and
7. retain a receipt for reconciliation instead of creating a second task.

It deliberately does not call `thread/fork`. The source task remains visible.
If `thread/start` was dispatched but the response is lost, the claim stays
`reconciliation_required`; the service does not guess or retry into a duplicate.

## Current rollout mode

The checked-in policy is `automatic`, with two rollout guards:

- the task that installed the service is permanently protected; and
- only tasks updated after `activation_not_before` are considered.

Packet generation remains the first stage. Destination creation happens only
when the packet has a complete plan, a safe terminal boundary, an available or
absent (not unreadable) formal Goal, and no unresolved external-effect state.
Otherwise the service stops at the packet/candidate state without creating a
task.

## Install and inspect

Install the independent LaunchAgent:

```sh
/Users/nichikatanaka/Documents/Codex/automation-os/scripts/install-codex-project-state-sync-launch-agent.sh
```

It runs every five minutes. Manual dry-run (no ledger or packet write, except
the bounded status readback) is:

```sh
node scripts/codex-project-state-sync.mjs \
  --policy data/codex-project-state-policy.json \
  --current-thread-id "$CODEX_SESSION_ID" \
  --dry-run
```

Manual prepare sync is:

```sh
node scripts/codex-project-state-sync.mjs \
  --policy data/codex-project-state-policy.json \
  --current-thread-id "$CODEX_SESSION_ID"
```

The ledger is a bounded resume index. The destination must fresh-read the listed
authority and evidence files; current project files and same-run readback remain
authoritative for implementation and external effects.

## Returning a handoff to its source

When a Job handoff must remain in the original task, use the signed
`codex_source_resume_authority.v1` transition. The source owner, destination
identity, generation, authority digest, and one resume idempotency key are
checked while the local receipt is locked. A successful transition is:

`reconciliation_required → return_requested → returned_to_source`

The gate then derives `source_status=source_resume_ready` and
`implementation_allowed=true`; it is never edited directly. The destination
is not contacted, the source task is never archived, and a repeated key is a
no-op. Only after a fresh readback proves `unknown_effect=false`, ownership
matches, and reconciliation is clear may the shared resume controller perform
one owner-only cleanup, one fresh session, and one same-thread continuation.

This source-return gate is not the authority for an ordinary Job application.
The normal `direct_application` lane stays in the current Companion-owned
source thread and does not require a Codex handoff signature. A stale
`handoff_completed`/`implementation_allowed=false` field is retained as
diagnostic context only. The signed source-resume receipt is selected only
when the caller explicitly requests `source_return`; unknown effect, foreign
ownership, active reconciliation, authentication, and provider gates still
block either lane.

For a bounded read-only decision, run:

```sh
node scripts/resume-current-task.mjs --input /path/to/fresh-readback.json --task-type job
```

The command emits a plan only. It does not send a turn or perform any browser,
credential, provider, or external action.
