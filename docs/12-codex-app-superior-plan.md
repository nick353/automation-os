# Automation OS Codex App Superior Plan

Updated: 2026-07-13

This is the working plan for making Automation OS feel like a natural-language execution OS, not a static dashboard. `STATE.md` remains the current proof log. This file records the product gap, target behavior, implementation owner surface, and verification method.

## Product Target

Automation OS should let the user describe work in normal language, then keep a living plan: what is known, what is missing, what can run now, what must stop, what proof will prove completion, and what happened after a button was pressed.

The app should be better than a plain Codex chat for recurring automations because it owns schedule state, run state, proof state, and production readback in one place.

## Codex Server Connection Model

When Automation OS is connected to a Codex server, the practical change is reachability, not authority. The app may be able to use additional server-backed session/execution surfaces and whatever MCP, plugin, and browser capabilities are enabled in that environment, subject to runtime availability and the active executor/connector. That can improve planner handoff, worker pickup, and readback orchestration compared with relying on a single local shell.

What does not change is the project boundary: `STATE.md` and the other project-owned authority files remain the source of truth, locator files are still only locators, and a Codex server connection is not completion proof or permission to skip readback. Chrome browser work still follows the explicit browser-surface rule, so an explicit Chrome request remains on Chrome Extension / Chrome plugin. Dangerous or irreversible actions still require the same explicit approval, and completion still depends on the existing readback, artifact, and done-criteria gates.

The environment-specific capability set can change over time. A configuration file may expose node, browser, or MCP backends, but enabled does not mean always available and does not guarantee success on the next run.

## Capability Matrix

| Surface | Primary use | Probe signal | Completion proof role |
| --- | --- | --- | --- |
| `codex exec` | Local repo work, audits, focused verification, scripted automation | `codex exec --sandbox read-only "echo ready"` returns a clean result | Runner entrypoint, not authority |
| `app-server` | Session history, approvals, streamed events, and remote continuation | session id, approval state, and event stream availability | Coordination layer, not proof |
| `app-server probe` | Read-only Codex App Server inventory refresh | `POST /api/codex/app-server/probe` returns initialize-only readback with `connected=false` | Readback only, not authority |
| `worktree` | Parallel or risky edits isolated from the main checkout | separate worktree path / branch / diff | Isolation layer, not proof |
| `cloud` | Longer background tasks in a separate environment | cloud task id and environment availability | Offload layer, not proof |
| `MCP` / plugin / browser surfaces | External tools, browsers, and connector-backed actions | `codex mcp list` plus connector-specific probes | Capability layer, not proof |
| `Chrome Extension` | Signed-in browser/profile work | explicit Chrome surface + authenticated session | Required lane for identity-bound web work |

Routing rule:

- Use the narrowest verified surface that can still produce the required proof.
- Prefer `codex exec` for local repo tasks.
- Prefer `worktree` or `cloud` for long or parallel work.
- Prefer `Chrome Extension` for signed-in browser work.
- Prefer MCP / plugin surfaces for external tools that have dedicated connectors.
- Treat `configured` as a hint, `enabled` as loadable, `verified` as proven for the current session, and `connected` as ready for action.

## Surface Selection Cheat Sheet

| Surface | Use when | Proof to keep |
| --- | --- | --- |
| `codex exec` | Local repo edits, audits, and bounded verification | command output, diff, test result |
| `Chrome Extension` | Signed-in browser/profile work or extension-gated web actions | bridge readback, browser/proof artifact, exact blocker when unavailable |
| `MCP` / plugin | External tools with dedicated connectors, especially when Codex already supports them | capability readback, probe result, connector-specific artifact |
| `app-server` | Session history, approvals, and state/readback orchestration | API readback, receipt, and dashboard panel |
| `worktree` / `cloud` | Long or parallel work that should stay isolated from the main checkout | branch/worktree id, diff, final readback |

When the surface is uncertain, keep the narrowest verified lane and surface the blocker instead of silently falling back.

## Implementation Policy

The first integration pass should stay backend-first and preserve the current UI contract.

### File-level change map

- `apps/server/src/codex/capabilities.ts`: separate the Automation OS local API server from any future Codex App Server identity; keep capability state as structured reachability instead of a plain boolean.
- `apps/server/src/codex/appServerProbe.ts`: keep the Codex App Server probe read-only, initialize-only, default-off, and TTL-bounded; success refreshes inventory only.
- `apps/server/src/codex/capabilityProbe.ts`: keep MCP probing read-only and TTL-cached; use it only as evidence for `configured / enabled / verified / connected`.
- `apps/server/src/codex/capabilityRouter.ts`: route by authority, proof, and lane, not just by catalog membership; record connected vs runtime vs catalog provenance.
- `apps/server/src/codex/executionRouting.ts`: persist a deterministic `route_decision` at run start and a separate `route_readback` at worker pickup.
- `apps/server/src/runs/workerEngine.ts`: attach routing metadata to runs and steps; keep worker execution behind feature flags so the existing path can remain the default.
- `apps/server/src/runs/approvalGate.ts`: keep approval separate from reachability; dangerous or external actions should still require explicit gate checks.
- `apps/server/src/runs/proofGate.ts`: keep proof evaluation distinct from routing so server success cannot masquerade as completion proof.
- `apps/server/src/runs/runContracts.ts`: define the first thin slice as read-only local repo analysis, with a contract that forbids browser writes and external side effects.
- `apps/server/src/tests/*.test.ts`: add regression tests for route separation, fallback failure, Chrome-only browser gating, and feature-flag off behavior.
- `docs/12-codex-app-superior-plan.md` and `docs/13-project-boundary-standard.md`: keep the policy visible and current as the implementation lands.

### Future target

Not implemented yet:

1. Start a read-only analysis task for a local repository command.
2. Save a capability snapshot and execution routing snapshot.
3. Route the task through App Server only when the feature flag says to do so.
4. Record event progress back into the existing run metadata without changing the UI layout.
5. Treat completion as false until proof, readback, and approval gates all agree.
6. Fail closed with `codex_server_unreachable` when the Codex server is absent.

### What should not change yet

- no UI redesign
- no browser fallback to Playwright or temporary profiles
- no automatic approval of risky actions
- no scheduler rewrite before the read-only slice is stable
- no promotion of Codex server connectivity to source-of-truth status

### Acceptance criteria

- The app can describe which surface it selected and why.
- App Server presence changes reachability, not authority.
- App Server success still reads back as inventory only and keeps `connected=false`.
- Browser tasks remain pinned to Chrome Extension.
- Read-only tasks can flow through App Server behind a flag.
- Completion still requires proof, readback, and project-owned state.
- Turning the flag off restores the current behavior.

## Current Gap Ledger

| Area | Current state | Target state | Verification |
| --- | --- | --- | --- |
| Create chat | Backend planner exists at `/api/create/plan`; local Mac can use Codex CLI, production falls back locally, OpenAI is opt-in only. | Continue improving planner prompts so follow-up questions become specific to each registered workflow and source. | Two-turn Create QA on desktop/mobile; planner API readback; no API billing unless explicitly enabled. |
| Conversation memory | Create draft sessions are persisted locally and in the server-backed default `create_sessions` row: sanitized messages, current draft, selected sources, and command restore after reload/nav-back; unsent input is not stored. | Next durable step is named conversation sessions tied to user/workflow identity, then direct local Codex worker job handoff from the saved conversation. | Verified with Playwright CLI desktop/mobile reload, nav-back, reset, stored JSON checks under `/tmp/automation-os-create-persistence-qa/`, and server-backed restore QA under `/tmp/automation-os-create-session-ui-qa/`. |
| Execution judgment | Planner returns `ask_more`, `save_plan`, `demo_first`, `ready_to_start`, or `ready_to_schedule`; Create now uses that judgment to show the safest next action and explain disabled or risky actions. Run continuation context now changes the plan into a focused repair/retry flow. | Next step is feeding concrete demo/start API result bodies into the same continuation path immediately after those buttons stop. | Local Playwright CLI QA checks incomplete-question, schedule-candidate, and mobile button guidance under `/tmp/automation-os-create-decision-qa/report.json`; run-continuation QA is under `/tmp/automation-os-run-continuation-qa/report.json`. |
| Save /見る /開始 | Save, demo, start, schedule edits, scheduler run-once, and normal action posts now create visible operation receipts with compact connected ids and next action copy. Create start now sends the saved conversation snapshot into run metadata, the Create-owned planner workflow endpoints bypass the production write lock while generic starts stay locked, and Runs detail shows the Create-origin consultation summary without opening internal details. | Extend receipts into per-row summaries and richer blocked/partial report links so every button has a durable follow-up surface; next step is making worker pickup results append back to this same human report. | Local Playwright CLI receipt QA under `/tmp/automation-os-action-receipt-qa/`; Create start handoff QA under `/tmp/automation-os-create-start-qa/`; Create-origin Runs QA under `/tmp/automation-os-create-origin-run-qa/report.json`; API response, notice text, selected run/detail readback, proof rows where relevant. |
| Schedule playback | Global run-once and row-level run buttons call registered workflow APIs. Global no-op tells the user there is no due work, each row shows a safe last-action/result/next-action summary, and summaries with a latest run now open the matching Runs detail. | Next step is adding richer row-level blocked/partial report text once the selected run is open. | Schedule QA on temporary DB confirms desktop/mobile row summaries and no overflow under `/tmp/automation-os-schedule-row-summary-qa/report.json`; deeplink QA confirms desktop/mobile summary click to Runs detail under `/tmp/automation-os-schedule-deeplink-qa/report.json`. |
| Run details | Human report now distinguishes blocked, partial, waiting approval, and receipt-only runs, explains missing proof with safe Japanese labels, exposes immediate follow-up actions, and shows Create-origin title/next action/visible steps for runs started from a saved consultation. Internal data stays in details. | Next step is making retry/resume actions execute category-specific repair entrypoints when each workflow has a safe repair contract. | Local Runs QA on temporary DB confirms desktop/mobile report copy, next-action buttons, proof drawer, refresh receipt, Create prefill, Approvals navigation, Create-origin handoff summary, no overflow, and console warnings/errors 0 under `/tmp/automation-os-run-report-qa/report.json`, `/tmp/automation-os-run-action-qa/report.json`, and `/tmp/automation-os-create-origin-run-qa/report.json`. |
| Proof display | Proof drawer uses the viewer endpoint, hides raw paths, and now shows human proof summaries plus safe JSON/text/image previews. | Next step is real screenshot thumbnails only after a safe thumbnail endpoint exists; current image drawer intentionally shows format/dimensions without raw image body. | Local proof drawer QA with JSON/source and image proofs under `/tmp/automation-os-proof-drawer-qa/report.json`. |
| Error recovery | Existing runs store exact blockers and proof gates. Runs can now send blocked/partial outcomes back into Create as conversation context and immediately update the planner. | Next step is a one-click repair/resume execution when each workflow has a safe repair contract. | Blocked fixture run shows a single clear next action; no raw exactBlocker on normal screen; continuation QA proves Create updates without waiting for the user to re-send text. |
| Mobile UI | Create and Runs have mobile QA proof for current planner/report work. | Extend mobile QA to Schedule, proof drawer, and Approvals. | 390px screenshots and horizontal-overflow checks for all primary routes. |
| Production operation | PostgreSQL production readback works; write guard protects state-changing APIs; planner read-only POST is exempt. `/api/health` and `/api/dashboard` now expose sanitized deployment commit/provider/version/asset readback, and the Dashboard shows a compact `本番` card. The latest Create start handoff deployment was read back from Zeabur at commit `2f8cc16`. | Use this as the normal operator readback for stale asset/deploy diagnosis, and keep adding a post-push readback record after each production change. | `/api/health`, `/api/dashboard`, planner POST, production screenshots, deployment/assets readback after each push. |
| Local Codex worker | `worker:loop` records a safe heartbeat in `system_checks`, `/api/dashboard` exposes sanitized `localWorker`, Dashboard shows a compact `Mac worker` card, and Sources now has a first-screen `Mac実行` panel with the Mac-side production PostgreSQL setup, worker loop, and pickup proof steps. `npm run worker:production-proof` wraps the safe production pickup proof CLI. | Next step is running that proof from a trusted local shell with `DATABASE_URL` or `AUTOMATION_OS_DATABASE_URL` set to the Zeabur PostgreSQL value. | Local loop smoke with `--max-cycles=1`; desktop/mobile Dashboard QA under `/tmp/automation-os-worker-heartbeat-qa/report.json` and `/tmp/automation-os-worker-pickup-qa/report.json`; Sources panel QA under `/tmp/automation-os-worker-setup-panel-qa/report.json`; fail-closed missing-env proof under `/tmp/automation-os-production-worker-pickup-proof-missing-env/summary.json`. |
| Record & Replay / Computer Use | Local Codex now has a user skill and global guidance that make Record & Replay / Computer Use candidates for repeated GUI workflows and screenshot-only verification gaps. Codex app Settings -> Computer Use was opened and showed Google Chrome connected; the installed build contains Computer Use and Record & Replay assets; Plugins was opened, but the `+` path inserted Plugin Creator instead of exposing `Record a skill`, and app menus did not expose a recording command. | First durable workflow to record is Automation OS Dashboard/readback verification once Record a skill appears in this Codex app UI/account. Generated skills must be refined to point back to `STATE.md`, API/DB readback, proof rows, artifacts, exact blockers, and cleanup proof. | Evidence artifact: `/Users/nichikatanaka/.codex/artifacts/record-replay-standard-20260624/implementation-summary.md`; current dashboard recording-ready evidence includes `automation-os-prod-health.json`, `automation-os-prod-dashboard.json`, and `automation-os-prod-dashboard.png`. |

## Implementation Order

1. Keep planner backend and UI contract stable.
2. Remove every "pressed but nothing happened" case by requiring visible notice or selected run/proof after actions. Operation receipts, row-level Schedule summaries, Schedule summary-to-run-detail links, Create start-to-run handoff metadata, and Create-origin Runs summaries are implemented; next step is richer blocked/partial report language after worker pickup.
3. Expand human run reports for all run dispositions. Done for blocked, partial, waiting approval, and receipt-only; immediate proof, refresh, approval, and Create-continuation actions are implemented. Next step is turning each category into a one-click repair/resume execution after safe workflow contracts exist.
4. Persist Create draft sessions. Done locally and as a server-backed default session; next durable step is named sessions after user/workflow identity design.
5. Add proof drawer improvements. Human summary and safe image card are implemented; next thumbnail work needs a safe thumbnail endpoint.
6. Add production readback surface for commit/provider/guard state. API/QA readback and the compact Dashboard `本番` panel are implemented; latest Zeabur readback is recorded for commit `2f8cc16`.
7. Keep browser QA as the release gate: desktop, mobile, console, API, screenshots, and QA JSON.
8. Use the local Mac worker loop for subscription-backed Codex execution: Zeabur owns the control plane and PostgreSQL state; the Mac owns `codex exec`, local browser proof, and cleanup.
9. Use Record & Replay / Computer Use where they add real GUI workflow reuse, but keep Playwright CLI and project-owned readback as the completion proof.
10. Treat production Replay QA recommendations as release guardrails: if `plannerExecutionMode` is `mac_worker_subscription`, the UI/runbook must keep Mac worker heartbeat visible; if `/api/browser/health` shows hosted Playwright/browser tools missing on Zeabur, browser execution remains a Mac worker responsibility.

## Hard Stops

Automation OS work stops only for billing, purchase, payment, checkout, secrets themselves, destructive production data changes, or irreversible external post/apply/send/publish/delete actions outside the current proof-owned workflow. All other blockers should be captured as exact evidence with the next safe action.

## Current Verified Evidence

- Commit `3c90a93`: planner backend and UI implementation.
- Commit `5bc9222`: production readback recorded.
- Commit `f73b136`: schedule feedback production QA recorded.
- Commit `2006e7d`: Create draft session persistence.
- Local run-continuation planner verification: `/tmp/automation-os-run-continuation-qa/report.json`.
- Local Create decision guidance verification: `/tmp/automation-os-create-decision-qa/report.json`.
- Local Create persistence verification: `/tmp/automation-os-create-persistence-qa/report.json`.
- Production Create persistence verification: `/tmp/automation-os-create-persistence-production-qa/report.json`.
- Local server-backed Create session verification: `/tmp/automation-os-create-session-ui-qa/qa.json`.
- Production server-backed Create session verification: `/tmp/automation-os-create-session-production-qa/ui-summary.json`.
- Local Create start-to-worker handoff verification: `/tmp/automation-os-create-start-qa/ui-report.json`.
- Production Create start-to-worker handoff readback: `/tmp/automation-os-create-start-production-qa/production-readback-summary.json`.
- Local Create-origin Runs detail verification: `/tmp/automation-os-create-origin-run-qa/report.json`.
- Production Create-origin Runs detail asset readback: `/tmp/automation-os-create-origin-production-qa/asset-readback.json`.
- Local action receipt verification: `/tmp/automation-os-action-receipt-qa/report.json`.
- Local proof drawer verification: `/tmp/automation-os-proof-drawer-qa/report.json`.
- Local Schedule row summary verification: `/tmp/automation-os-schedule-row-summary-qa/report.json`.
- Local Schedule row summary deeplink verification: `/tmp/automation-os-schedule-deeplink-qa/report.json`.
- Local Runs human report verification: `/tmp/automation-os-run-report-qa/report.json`.
- Local Runs next-action verification: `/tmp/automation-os-run-action-qa/report.json`.
- Local deployment readback verification: `/tmp/automation-os-deployment-readback-qa/summary.json`.
- Production deployment/action receipt readback: `/tmp/automation-os-production-qa-2026-06-23T01-05-30-472Z/summary.json`.
- Production Runs human report asset readback: `/tmp/automation-os-production-qa-2026-06-23T03-27-26-503Z/run-report-asset-readback.json`.
- Production Runs next-action readback: `/tmp/automation-os-run-action-qa/prod-asset-readback.json`.
- Production Create decision guidance readback: `/tmp/automation-os-create-decision-qa/prod-asset-readback.json`.
- Production Run outcome to Create planner readback: `/tmp/automation-os-run-continuation-qa/prod-readback.json`.
- Local Codex worker loop smoke: `AUTOMATION_OS_DB=/tmp/automation-os-worker-loop-smoke.sqlite ... npm run worker:loop -- --max-cycles=1 --interval-ms=1000`.
- Production Local Codex worker loop commit readback: `/tmp/automation-os-production-qa-2026-06-23T05-24-21-577Z/summary.json`.
- Local Codex worker heartbeat UI QA: `/tmp/automation-os-worker-heartbeat-qa/report.json`.
- Production Local Codex worker heartbeat readback: `/tmp/automation-os-worker-heartbeat-qa/prod-readback.json`.
- Local Codex worker pickup QA: `/tmp/automation-os-worker-pickup-qa/report.json`.
- Production Local Codex worker pickup heartbeat readback: `/tmp/automation-os-worker-pickup-qa/prod-health-f2a4eed.json` and `/tmp/automation-os-production-qa-2026-06-23T06-18-43-998Z/summary.json`.
- Production DB worker pickup proof CLI missing-env readback: `/tmp/automation-os-production-worker-pickup-proof-missing-env/summary.json`.
- Production worker pickup proof CLI deployment readback: `/tmp/automation-os-production-qa-2026-06-23T06-35-36-618Z/summary.json`.
- Local Mac worker Sources setup panel QA: `/tmp/automation-os-worker-setup-panel-qa/report.json`.
- Local production readback panel QA: `/tmp/automation-os-deployment-panel-qa/report.json`.
- G003 boundary-accounted / G004-G005 read-only transition: `/Users/nichikatanaka/Documents/Codex/automation-os/work/g004-g005-boundary-accounted-readback-20260702.json`.
- Production QA for G005 readback: `/tmp/automation-os-production-qa-2026-07-02T14-47-42-068Z/summary.json`.
- Production Replay QA for G005 readback: `/tmp/automation-os-production-replay-qa-2026-07-02T14-48-02-164Z/replay-summary.json`; writes were disabled and recommendations confirmed Mac worker planner/browser lane boundaries.
- Full test pass after server-backed Create session work: `npm test` 502/502.
- Full test pass after Create start-to-worker handoff work: `npm test` 503/503.
- Full test pass after production readback panel work: `npm test` 501/501.
- Full test pass after Run outcome to Create planner work: `npm test` 494/494.
- Full test pass after Local Codex worker heartbeat work: `npm test` 498/498.
- Full test pass after Local Codex worker pickup heartbeat work: `npm test` 499/499.
- Full test pass after production worker pickup proof CLI work: `npm test` 500/500.
- Local UI evidence: `/tmp/automation-os-llm-planner-ui-qa/`.
- Production QA evidence: `/tmp/automation-os-production-qa-2026-06-22T23-29-43-670Z/`.
