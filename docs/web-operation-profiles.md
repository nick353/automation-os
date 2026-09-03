# AOS web operation profiles

Automation OS uses two execution profiles so that a one-off visible browser
task does not inherit the full audit burden of an unattended business run.
The profile changes the amount of evidence and orchestration, not the browser
surface selection or the safety boundary.

## UX-TRY: one-off visible operation

Use this profile for a single, user-visible task such as checking one page,
filling one form, applying to one job, sending one message, or publishing one
explicitly chosen item.

Minimum path:

1. Read the current page and confirm the exact target, account, and destination.
2. Use the currently selected AOS web backend. Do not use a generic implicit
   fallback. The sole automatic cross-extension transition is the signed
   one-way Companion-to-official handoff described below.
3. Enter only the requested, known facts and perform the one requested action.
4. Immediately verify the site's visible result with a screenshot as well as
   semantic readback (success state, sent state, or equivalent). When they
   disagree, treat completion as unresolved instead of trusting readback.
5. Close only tabs created or replaced by the operation. Leave the browser and
   pre-existing user tabs open.

Do not automatically add a Goal, broad UI audit, full-suite E2E, old-receipt
reconciliation, or a new durable workflow for a UX-TRY. A compact action-time
confirmation is still required immediately before an external effect, and
personal contact data must be confirmed before it is entered into a third-party
form.

Stop with an exact blocker when the target is not unique, the account or
destination changes, a CAPTCHA/OTP/security code/identity verification is
shown, an unknown required question appears, or the effect cannot be
distinguished from an ambiguous result. Do not replay the same action key.

## RELEASE: registered or durable operation

Use this profile for registered automations, scheduled runs, unattended or
replayable work, multi-item work, recovery/reconciliation, or any request that
explicitly asks for same-run business proof. Keep the existing lifecycle:

- fresh target/account/payload/audience/authority/approval/idempotency;
- provider receipt and source-of-truth readback;
- source sync and reconciliation;
- terminal cleanup of owned tabs/groups only.

Queued, dry-run, preflight, a click, or a visible modal alone is not business
completion in RELEASE. If an effect is unknown, reconcile once and do not
replay it automatically.

## Profile selection

The request and execution context decide the profile:

| Request shape | Profile | Completion evidence |
| --- | --- | --- |
| “画面を見て1件だけ”, one-off visible action | `UX-TRY` | fresh visible result + exact target + cleanup |
| registered/scheduled/replayable workflow | `RELEASE` | same-run receipt + source sync + reconciliation + cleanup |
| user explicitly asks for full audit or durable proof | `RELEASE` | requested audit scope and workflow proof |

This document does not weaken browser-policy requirements for CAPTCHA, OTP,
identity verification, sensitive-data transmission, or other human approval
boundaries. It only prevents optional audit machinery from being added to a
clearly bounded one-off operation.

## AOS Chrome Companion v0.3.2 operational boundary

When the selected route is the AOS Chrome Companion, keep the runtime small:

1. Do not restart Chrome or the Codex App as a recovery action inside an
   existing task, and do not resend a stale Companion `status` request from
   that task.
2. Read fresh Companion status, then create a task-scoped logical session and
   bind the target by `task/session/lease/generation/pageInstance/window/frame`.
   The normal sequence is `status` → session → target readback → one bounded
   operation → result readback → `close_session`.
3. Every exact-page read captures both semantic state and a screenshot. If a
   terminal read-only Companion attempt proves zero mutation dispatches, no
   effect, no reconciliation requirement, and complete cleanup, AOS may start
   exactly one new target-scoped official Extension attempt. The official
   attempt must re-identify the page visually and semantically and close only
   its own created tab. It never takes over a Companion tab and never hands
   back in the same attempt.
4. Do not fall back to Browser Use, Playwright, IAB, raw CDP, or OS automation.
   Do not cross surfaces for authentication/CAPTCHA/OTP/identity/payment,
   target/origin ambiguity, foreign ownership, visual/semantic conflict,
   unknown effect, or reconciliation-required state.
5. Never close tabs indiscriminately. Official Extension tabs, user-owned
   tabs, and other-task tabs are not cleanup targets. Only a task-owned tab
   whose ownership and cleanup token are freshly read back may be cleaned up.
6. Local UI operations (navigation, input, click, selection, and visual input)
   do not enter external-effect reconciliation. An ownerless external
   `unknown_effect` is terminalized as retained ledger evidence; it is never
   replayed. Independent safe work may continue.

7. Cleanup preserves only a live or explicitly pinned task tab, an unsupported
   browser surface, or a freshly owned tab needed for restart. Stale tracked
   tabs are closed after owner readback; untracked user tabs are untouched.

This boundary supplements, and does not relax, the `UX-TRY` and `RELEASE`
proof requirements above.
