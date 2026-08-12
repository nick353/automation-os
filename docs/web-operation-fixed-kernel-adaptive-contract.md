# Web operation contract

Automation OS treats every Web operation as two layers under
`automation_os_web_operation_contract.v1`.

## Fixed kernel

- canonical Browser Use CLI only; no Playwright, IAB, extension, direct CDP, or raw browser fallback
- workflow-owned persistent profile, reserved port, process identity, and profile/flow lease
- fresh authority, Company scope, allowed origins, authentication boundary, and current-run idempotency
- same-run provenance, explicit external-effect approval, semantic/business readback, source-of-truth sync, and terminal cleanup
- screenshots are generated inside the active run recording directory; a fixed filename is never an authority
- fail-close on CAPTCHA, OTP, identity verification, assessment, unknown high-impact questions, payment, tax, banking, or ambiguous effects
- secrets, cookies, passwords, tokens, and raw page bodies never enter logs or durable artifacts

## Adaptive layer

- inspect fresh semantic/accessibility state and live targets before acting
- detect route and state for LinkedIn, Easy Apply, external ATS, modal, pagination, nested scroll, and page transitions
- use bounded exploration and reevaluate after every meaningful readback
- autofill only known facts; ask for clarification on unknown safe questions, record the answer through the official knowledge store, and reuse it for equivalent questions
- site playbooks are hints only; fixed CSS selectors, fixed DOM order, and a single site's click sequence are never the source of truth

Effectful accounts are data-driven through
`AUTOMATION_OS_WEB_OPERATION_ROUTES_PATH`. The registry contains only a
non-secret account reference, allowed origins, an AOS automation/stage id, and
a reserved scheduled port. It never contains cookies, passwords, tokens, or a
profile path. A route not present in the registry is a deliberate
`portable_external_web_operation_authority_missing_for_unregistered_origin`
blocker for effects; public single-use rooms remain read-only.

The AOS portable external action plan carries this contract and the bridge
passes its schema to the child runner. A different LLM can consume the same
plan without depending on Codex App. Codex App remains a thin trigger; AOS
scheduler/durable queue remains the execution source of truth.

## Common semantic operation model

All sites use the same intent vocabulary: `read`, `create`, `update`,
`publish`, `submit`, and `delete`. A workflow may provide hints for a site or
route, but those hints never authorize a selector, DOM position, screenshot
filename, or fixed click sequence.

The adaptive path is:

1. Read fresh bounded semantic state and produce candidate controls/targets.
2. Resolve by semantic query or exact target key. Zero candidates means
   `web_operation_target_not_found`; more than one means
   `web_operation_target_ambiguous`.
3. For an effect, require current account/authority, allowed origin, payload
   digest, a fresh target/source-state binding, idempotency key, approval, and
   `readback_required`.
4. Perform a run-owned `automation_os_web_operation_action_plan.v1` using only
   semantic primitives (`open`, `click_target`, `fill_target`, `type`, `keys`,
   `wait`, `scroll`) and reevaluate after navigation, modal,
   pagination, state, authentication, and effect-readback changes.
5. Confirm the same target and payload through the source of truth. An unknown
   effect is reconciled once and never replayed automatically.

This is why a first-time site can be explored without hardcoding it, while a
post/create/update/delete operation still cannot silently act on an ambiguous
or stale target. The machine-readable contract is
`automation_os_web_operation_intent.v1`; its target candidate shape is
`automation_os_semantic_target_candidate.v1`.

## Start-up checklist for a new site

1. Register only the account reference, origin, automation/stage id, and a
   reserved port in a mode `0600` route registry. Copy
   `work/web-operation-route-registry.example.v1.json` and replace the
   placeholders; never put a profile path or credential in it.
2. Run a read-only semantic readback against the same account/origin. Keep the
   returned `semantic_target_candidate_digest` and
   `semantic_target_source_state_digest` as the current target binding. A
   screenshot or an old receipt is not sufficient.
3. Build a run-owned intent with the natural-language target and payload
   digest. Use an action plan made only from the semantic primitives above;
   do not add CSS selectors, XPath, DOM order, or a fixed screenshot name.
4. Obtain the target-bound approval/authority for the exact run, operation,
   payload, and idempotency key. A pending approval, a stale source-state
   digest, a public lane, or an unregistered origin stops before dispatch.
5. After the effect, require source readback and terminal cleanup. If the
   result is `effect_unknown`, reconcile the source of truth and use a new
   idempotency key only after that reconciliation; the same key is never
   replayed.

The deterministic contract and lifecycle checks can be run with:

```sh
npm run test:e2e:web-operation
```

This exercises create/update/publish/submit/delete, approval and origin
boundaries, stale target state, interruption, duplicate idempotency, the
generic business runner, and Browser Use CLI cleanup without requiring a real
external account.
