# AOS Chrome Companion adapter

`scripts/aos-chrome-companion-adapter.mjs` is the Automation OS thin adapter
for the independently owned AOS Chrome Companion surface.

It is deliberately separate from the official
`signed_chrome_extension_profile2` compatibility lane. A Companion receipt
always reports `execution_surface=aos_chrome_companion_profile_instance`; it
must never be promoted to an official-Extension `get() -> openTabs()` receipt.

The run-start router is Companion-first. Normal and read-only Chrome work is
routed to Companion automatically. An explicit official-surface requirement
routes to the official Extension. Until a workflow has a Companion effectful
adapter, the router may select its existing official effect adapter before the
run starts and records `route_reason=official_effect_adapter_compatibility`.
That route is frozen for one attempt. A separate
`aos.safe_extension_surface_handoff.v1` transition may start one official
Extension attempt after a terminal Companion read-only failure only when the
receipt proves zero mutation dispatches, no external effect, no reconciliation
requirement, and complete session/lease cleanup. It is a new target-scoped
attempt, not a replay and not same-tab ownership transfer.

The read-only adapter stage is fail-closed:

- one connected Companion profile instance, or an explicit instance ID;
- one AOS run/task-bound logical session;
- one exact allowlisted tab;
- one Companion exact-tab lease;
- a bounded semantic snapshot;
- a screenshot from the same leased tab on every read, even when the semantic
  snapshot appears complete;
- a semantic/visual target match before readback can be verified;
- visual-first confirmation for ordinary operation controls: inspect the fresh
  screenshot and use one signed `visualProof`-bound AI cursor action;
- iframe controls retain their exact `frameId`; semantic operations execute in
  that frame only and require its origin in the authorized allowlist, while
  trusted physical coordinates are never guessed from frame-local geometry;
- no page body in the receipt, only its SHA-256, length, and control count;
- no screenshot bytes in the receipt, only SHA-256, length, media type, target,
  and restoration state;
- session close and lease release on every terminal path;
- no mutation, navigation, activation, submit, upload, or external effect.

Status from other Codex tasks is visibility, not a profile-wide lock. A
foreign task's session, lease, retained tab, or pending operation is never
adopted or cleaned up, but it does not stop a distinct target-scoped attempt.
Only an exact broker conflict for the same target or a serialized
profile-global operation blocks the current attempt.

The one-way handoff is blocked for authentication, CAPTCHA/OTP, identity or
payment prompts, target/origin ambiguity, foreign ownership, visual/semantic
conflict, unknown effect, or reconciliation-required state. The official
Extension must perform fresh semantic and screenshot readback and close only
the tab it created before the combined receipt can complete.

Authorized mode preserves the AOS run/task/idempotency/intent/capsule and tab
reuse/retention fields when it calls the signed Companion transaction. It
still does not certify business completion: the provider receipt remains
untrusted until the workflow validates it, syncs the source of truth,
reconciles the result, and verifies terminal cleanup. Closing the authorized
session uses `taskTerminal=true` and records terminal task-tab cleanup.

## AOS-local execution context

Every run and Companion receipt carries one bounded
`automation_os_execution_context.v1` record. It contains only the run/task,
owner, generation, selected route, effect state, reconciliation state, and
handoff state. The record is stored in the AOS run metadata and its digest is
recomputed on readback. `source=aos_local` and `app_dependency=false` make the
boundary explicit: Codex App is a view/trigger surface, not the normal
execution authority. Same-owner work proceeds directly through Companion;
owner transfer, pending reconciliation, or unknown effect remains a separate
signed transition and is never bypassed by this context.

Dropdown selection is a two-step contract. The read-only inspection returns a
screenshot and a signed `visualProof` bound to the exact session, lease, task,
profile generation, tab, URL, and locator. Authorized `page.selectOption`
rejects a missing, expired, or mismatched proof before dispatch.

For ordinary operation controls such as buttons, tabs, menus, toggles, hover
targets, and scrolling, the preferred interaction is
`companion_inspect_visual_target` (or `companion_inspect_visual_point` when no
stable semantic locator exists), followed by exactly one `visual.*` action in
the authorized transaction and a same-target semantic plus screenshot
readback. The blue cursor is an in-page visual marker; it does not move the
user's macOS pointer. Text entry keeps the existing semantic/native path,
because it has been more reliable. Dropdowns and visible submit controls keep
their signed `selectOption` and one-exact-semantic-click contracts respectively;
they must not be converted into guessed coordinate clicks.

Rich-text editors use `page.selectText` to bind one exact visible substring
inside a contenteditable target before a semantic formatting-toolbar click.
Repeated text requires an explicit zero-based occurrence; absent or ambiguous
ranges stop before the toolbar mutation. The transaction's final semantic and
screenshot readback remains the formatting proof, with physical drag reserved
only for a future explicitly verified no-effect fallback rather than a guessed
selection.

Clear-and-replace text input uses the common semantic-first recovery policy.
The effect executor sends `page.type` with
`physicalFallback=on_verified_no_effect`. Companion captures a semantic target
and exact-tab screenshot, applies the native value setter plus `input` and
`change`, and verifies the requested value after a bounded wait. It performs
one trusted physical clear-and-type only when the field is exactly back at its
original value and the page instance, URL, viewport, rectangle, and target
point are unchanged. Partial values, target movement, navigation, permission
failure, or an unknown effect block without retry. Click, submit, upload,
navigation, and dropdown selection never inherit this automatic fallback.
For a visible form submission control the caller dispatches one exact semantic
`page.click`; it must not send `page.submit` first and then retry with a click,
or switch in the opposite direction. When the immediate exact-tab readback
shows no observable transition after a submission dispatch, the broker returns
`operation_effect_unknown`; the caller retains the exact reconciliation tab
and performs signed/provider readback instead of resubmitting.
If that retained tab later exposes visible provider-success evidence, the
caller performs `companion_inspect_reconciliation`, visually checks the
same-page screenshot, passes its signed proof unchanged to
`companion_complete_reconciliation`, and then closes the terminal session.
This changes the capsule/tab from `reconciliation_required` to
`completed/cleanup`; it never replays the provider operation and does not trust
a caller-supplied success string without exact-tab semantic evidence. Completion
also recaptures the exact tab and requires the fresh screenshot digest to match
the signed inspection proof before the retained tab becomes cleanup-ready.

The ordinary read-only command is:

```bash
AOS_CHROME_COMPANION_ROOT=/installed/aos-chrome-companion \
  npm run chrome:companion:read < request.json
```

The signed product installer supplies the installed root. Until then the
development checkout is passed explicitly. A workflow remains
`entrypoint_only` for effects until its own adapter adds provider receipt,
source sync, reconciliation, and business-completion proof; a generic
authorized browser transaction alone does not promote that workflow to
`effectful`.

## Parallel target lane and audit evidence

Target-scoped operations are admitted through a per-profile FIFO lane. Three
distinct task-owned tabs may run concurrently by default; the profile-global
and foreground lane remains serial. `AOS_COMPANION_TARGET_CONCURRENCY` (1–8)
and `AOS_COMPANION_TARGET_QUEUE_DEPTH` (1–256) provide staged tuning without
changing ownership or idempotency rules. A full lane returns
`target_operation_backpressure` rather than dropping or replaying work. The
broker status exposes `targetLanePolicy` and per-profile
`targetLaneMetrics` (active/queued/maxActive/admitted/completed/rejected and
queue-wait totals) so a canary can distinguish contention from a target or
transport failure.

The deterministic, no-browser canary is
`npm run canary:parallel:readonly` in the Companion checkout. It uses a fake
Extension relay over the real broker protocol, exercises four independent
read-only targets (three concurrent plus one queued) and three profile-global
foreground requests, and verifies that all sessions and leases are released.
It is safe to run while user tabs or reconciliation tabs are present. The
existing `canary:live` remains an effectful localhost capability test and must
be treated as opt-in; it is not the hourly scheduler's health gate.

The hourly audit keeps the full operator artifact, but writes a bounded
`aos-hourly-companion-audit.verifier.v1.json` projection (32 KiB maximum) for
independent verification. It removes tool metadata/base64 noise, excludes the
audit task's own session, and classifies OTP/CAPTCHA as a human gate only when
an observed visible/waiting/required action is present. Instruction text or a
"no visible widget" statement cannot stop a task.

## Supported runtime refresh boundary

When source and installed artifacts differ, the controller waits for an idle
profile boundary (no pending operation, lease, timeout, queue, active session,
executing task tab, or unresolved reconciliation). It may then perform one
supported local install and call the Companion MCP tool
`companion_refresh_extension`. The tool signs one profile-global
`extension.reload`, polls `status.get`, and returns `result=reflected` only
when the same profile reconnects with the expected build and a different
generation. `deferred` and `unknown` receipts preserve the baton and never
repeat the reload. A reflected result invalidates all old session/lease/tab
handles; the next step must open a new session and reacquire exact targets.
