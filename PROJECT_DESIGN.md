# Automation OS Project Design

Updated: 2026-08-08

## Desired future state

Automation OS is an owner-operated SaaS for managing automation work for multiple client companies. The current visual shell remains familiar, but every Project represents a real client company and every visible value or action is truthful.

Within a company, the owner can define automations, schedules, tasks, runs, approvals, artifacts, integrations, memory, and performance. All records are company-scoped. Read views show persisted data with provenance and freshness. Write controls cause a durable state transition, return a stable receipt, and survive reload. Controls with no production outcome are removed. Actions that can post, send, apply, publish, delete external data, spend money, or cross an authentication boundary remain explicit human gates.

The hosted API and PostgreSQL form the control plane and source of truth. AOS itself owns manual triggers, recurring schedules, run IDs, durable queue materialization, leases, receipts, and readback. A Mac worker performs bounded execution using leased jobs and writes results and proof back to the control plane. Codex App Server or Codex CLI may be plugged in as one provider adapter, but the Codex App is only a thin trigger/readback client and never becomes the authority for company identity, approval, job ownership, scheduling, or completion.

## Success targets

1. Every visible interactive element is classified as `real_read`, `real_action`, `justified_human_gate`, or `remove`; no unclassified control ships.
2. No seed, mock, static chart, placeholder artifact, or local receipt is presented as live operational data.
3. Company switching is API-backed and all automation, schedule, run, approval, artifact, integration, memory, and metric reads are company-scoped.
4. Every mutation has validation, authorization, idempotency or optimistic concurrency where applicable, audit data, a stable receipt, and persisted readback after reload.
5. Scheduler and workers use durable database claims/leases, prevent duplicate execution, and expose heartbeat, attempt, blocker, proof, and cleanup state.
6. Approval binds the exact company, action, target account, payload hash, expiry, and version; a decision is one-time and auditable.
7. Charts use typed event aggregations with an explicit date range and last-updated time, and show a clear empty/error state when data is unavailable.
8. Daily AI, Job Application Manager, and NisenPrints each complete a reference path from definition to schedule/run, approval boundary, worker result, and proof without weakening workflow-owned safety rules.
9. Automated contract, API, tenancy-isolation, and UI outcome tests report zero unexplained failures or skips for surviving controls.
10. Production promotion requires clean-SHA build/test evidence plus authenticated Browser Use CLI authority/profile/port/readback; deployment and external actions remain separately approved stages.
11. Manual and scheduled AOS triggers use the same idempotent durable-run entrypoint and return a persisted run/job receipt; a Codex App trigger cannot bypass that path.
12. LLM execution is behind a provider-neutral adapter contract. Codex, Claude, another hosted model, or a deterministic no-LLM worker may be selected without moving company scope, approvals, leases, or completion authority into the provider.
13. AOS control-plane/no-effect runs remain schedulable and verifiable when every LLM provider is unavailable. Provider capability is read back as a dependency status, not treated as execution success.

## Operational trigger contract (2026-08-08)

The first usable recurring lane is AOS-owned: the server owns schedules and
durable queue materialization, the worker owns leased pickup, and the caller is
only a trigger/readback client. Codex App is therefore a replaceable caller,
not a required execution host. The canonical manual and external caller is:

```text
POST /api/v1/companies/{companyId}/automations/{automationId}/trigger
Authorization: Bearer <one AOS write token, when API auth is enabled>
Idempotency-Key: <caller-generated stable key>
```

The request is admitted as `preflight_no_effect` with
`external_action_allowed=false`. AOS validates company membership and the
automation identity before creating the durable job. A later workflow adapter
may choose Codex, Claude, another LLM, or no LLM, but it cannot bypass AOS
scope, approval, lease, receipt, cleanup, or external-effect gates.

Do not attach a different secret to every recurring automation. Use one ingress
write token stored outside source/prompts/artifacts (for example a 0600 token
file referenced by `--token-file`), then bind each invocation with the company
ID, AOS automation ID, and idempotency key. This keeps provider migration and
Codex App replacement local to the caller while preserving a single audit and
revocation boundary.

## Browser runtime lifecycle and parallelism (2026-08-08)

Browser work is isolated by lifecycle, profile, port, room, and run owner. A
one-shot public/read-only flow uses the `single-use` profile and port range;
an authenticated recurring workflow uses its own `scheduled` profile and
reserved port; an explicitly authorized short-lived handoff uses `temporary`
only when its owner/task lease permits it. These ranges are non-overlapping.

The AOS lane allocator owns this split automatically. Registered recurring
workflows use reserved slots (Job Application Manager `19881`, Daily AI
`19882`, NisenPrints `19884`); one-shot and temporary runs derive a fresh
profile, session, port, and lock from the current run owner. A persisted lane
snapshot is readback only and never overrides a fresh binding. Every browser
lane is `browser_use_cli`; the allocator rejects a profile, port, lock, or
surface outside its lifecycle range before a worker starts.

An active room owned by another task is never killed, reclaimed, inspected, or
reused. Parallel work starts a fresh room with the correct lifecycle, profile,
port, authority, and recording directory, then binds every command and
readback to that run. Finalizing a recording does not imply closing an
intentionally user-held login handoff; that room remains owner-bound until the
same owner requests or performs terminal cleanup.

## Strategic thesis

Keep the current route-page design and make it truthful from the inside out. First remove misleading controls and static data, then establish the company boundary, then complete one durable automation-to-proof vertical slice, and only then expand integrations, analytics, and multi-user access.

The first vertical slice is scheduler-first: AOS materializes due occurrences and manual requests into the same durable queue, while provider adapters are replaceable execution ports below that boundary. This keeps the product useful for deterministic/control-plane work even when Codex is unavailable and prevents a provider-specific desktop client from becoming a hidden control plane.

This avoids rebuilding the interface before its operating contracts are sound. It also preserves the current owner workflow while making later client logins and role-based access possible without another data migration.

## Baseline at design start (superseded by STATE.md)

The facts and gaps below describe the starting baseline used to plan Waves 1–6. They are retained for design history and are not current status. Current implementation and remaining promotion gates are maintained in `STATE.md` and `work/company-saas-wave6-verification-20260715.md`.

### Facts

- The current product is a strong local/private operator console, not yet a multi-company SaaS.
- Project A-D are currently frontend constants; B-D are placeholders. The persisted state is not the authority for company navigation.
- Runs, steps, proofs, worker events, registered workflow readback, feedback, draft automation writes, and approvals have meaningful persisted backend support.
- Several visible controls call missing endpoints or only change a local receipt. The most serious example is Chat planning, which converts any planner failure into a client-side success response.
- Performance charts, lanes, recovery, artifacts, parts of plugins/security/production status, and several row actions contain static or mock data.
- Authentication is a shared operator token. The schema has no company membership or RBAC model, and existing execution records are not consistently company-scoped.
- Worker pickup and scheduler exclusion are not durable multi-worker leases. Duplicate execution is possible under concurrency.
- Existing workflow approval, proof, and external-action stop conditions are valuable and must remain stricter than generic UI affordances.
- Codex connectivity is capability evidence only. It does not grant execution permission and is not completion proof.

### Gaps to close

- Canonical company, membership, role, connection-account, job lease, artifact, audit, and idempotency models.
- Company-scoped repositories and cross-company isolation tests.
- Truthful empty/loading/error states and removal of fake success fallbacks.
- Complete API contracts for planner, automation lifecycle, memory, account references, artifacts, metrics, and safe execution requests.
- Durable scheduling, worker claim/heartbeat/fencing, retries, cancellation, and recovery.
- Action-bound approvals and object-backed proof/artifact storage.
- Outcome-based component/browser QA instead of source-regex or click-count-only checks.

## Key decisions

1. A Project is a client company in the current UI. Internally, the canonical entity is `company`; compatibility fields may temporarily keep the name `project_id` while migration is explicit.
2. The initial product has one human role: Owner. The schema and API must still carry actor and company identifiers so client users and RBAC can be added later.
3. Preserve the current navigation and visual character. Remove duplicate, decorative, or nonfunctional controls instead of redesigning the product.
4. Hosted API/PostgreSQL is the control plane. The Mac worker is an executor. Browser/Codex surfaces are capabilities behind the worker, not alternate authorities.
5. A UI success message requires durable readback. Network failure never becomes a generated success response.
6. External post/send/apply/publish/delete, payment, CAPTCHA/OTP, identity, permission, and deployment remain human-controlled boundaries.
7. Analytics is derived from typed run/proof events. Static demonstration charts are not allowed in the operational UI.
8. Admin diagnostics such as raw worker events, local paths, ports, browser profiles, bridge internals, and exact internal blockers do not appear on normal company pages.
9. AOS scheduler is the source of truth for due work. The Codex App may request a trigger or read status, but it cannot own a schedule, lease, run completion, or business receipt.
10. Provider adapters expose capability and bounded execution/readback only. They do not define company scope, approval state, queue ownership, or terminal success.
11. External actions remain behind workflow-specific approval, target/payload binding, provider receipt, cleanup, and reconciliation gates even after the provider adapter boundary is introduced.

## Deferred decisions

- Final identity provider and client invitation flow.
- Object-storage provider and artifact retention tiers.
- Billing model and subscription enforcement.
- Fine-grained client roles beyond Owner, Admin, Operator, Approver, and Viewer.
- Whether integrations are shared across companies or always company-exclusive; default implementation should be company-exclusive.
- Priority ordering of workflow families after the three reference workflows are complete.

## Constraints

- Preserve unrelated dirty worktree changes.
- Do not restore the obsolete pre-route-page UI.
- Do not deploy, push, mutate production, or execute external workflows without a separately authorized stage.
- Do not automate human-only authentication, payment, identity, or approval boundaries.
- Completion requires API/DB readback and proof; screenshots alone are insufficient.
