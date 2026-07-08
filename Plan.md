# Automation OS Remaining Plan

## 2026-07-07 Ideal Automation OS Plan

Goal: Automation OSを「安全なMVP」から、Codex Appの上位版として会社単位で複数プロジェクト・複数PC・複数外部サービスを管理し、ユーザーが押した操作の結果を必ず理解できる状態へ近づける。

Current truth:

- Production URL is `https://automation-os.zeabur.app`.
- Chrome plugin inspection found the new Automation OS UI, not the legacy UI.
- Current visible blocker is `mac_worker_heartbeat_stale`; runs are queued but the durable local worker lane is not production-fresh.
- Home and Project A buttons do react, but many reactions are only top-bar receipts, so the user experience feels like "nothing happened".
- Feedback currently has open user-reported issues; "押しても分からない / 操作反応" remains a real product problem.
- Project A currently has exactly three registered automations: Daily AI, NisenPrints, and Codex Job Manager.
- Current production operations monitor is pass-with-blockers / not operations-ready, not full ready.

Definition of ideal:

- Every visible button either performs a clear safe action, opens a clear detail panel, or shows a clear disabled/blocker state before click.
- After every click, the user can see: what happened, whether anything was actually executed, exact blocker, next human action, proof/readback, and whether external action happened.
- Company/project/workflow/account boundaries are explicit: training vs production account, project A/B/C/D, workflow owner, PC/worker lane, and approval lane are never mixed.
- Web execution runs from the user's Mac/Chrome lane when needed, with durable worker heartbeat, queue pickup, local cleanup, and artifact proof.
- External actions stop before post/publish/submit/delete/payment/CAPTCHA/OTP/security-code/identity/admin/assessment unless a specific safe approval and proof lane exists.
- Feedback can be sent in one or two clicks with screenshot fallback, and Codex can triage/fix from `/api/mvp/feedback` without a separate feedback management UI.

### Phase 0: Current-State Capture

Purpose: stop guessing. Capture exactly what the user sees and what each page currently does.

Work:

1. Use Chrome plugin on production URL and keep a handoff tab open.
2. Capture screenshot, DOM summary, console errors, URL, visible worker state, feedback count, queued count, and asset URL.
3. Save a Chrome-audit artifact under `work/` or `artifacts/chrome-production-qa/`.
4. Read `/api/health`, `/api/mvp/state`, `/api/mvp/feedback`, `/api/mvp/registered-automations?project_id=project-a`.
5. Compare user-visible text with API state.

Done when:

- One artifact lists visible state, source-of-truth API state, and exact mismatches.
- No screenshot-only conclusion is used.

### Phase 1: Full Click Behavior Audit

Purpose: identify every "押したのに分からない" surface.

Work:

1. For each route, list all buttons, links, inputs, menus, tabs, icon buttons, and row actions.
2. Click every safe control in Chrome plugin.
3. For each click, record expected result, actual URL change, DOM/text change, API change, console errors, screenshot, and whether external action happened.
4. Mark actions as `pass`, `weak_feedback`, `silent_noop`, `blocked_correctly`, `unsafe_available`, or `needs_human`.
5. Do not execute post/publish/submit/delete/payment/CAPTCHA/OTP/security-code/identity/admin/assessment.

Routes to cover:

1. Home
2. Chat
3. Project A Automations
4. Project A Memory / Security / Lane / Performance / Artifacts
5. Project B/C/D tabs
6. Runs
7. Approvals
8. Templates
9. Plugins / MCP
10. Production Status
11. PC Status
12. Feedback modal
13. Mobile viewport for the same critical flows

Done when:

- Every visible safe control has a recorded result.
- All "silent_noop" and "weak_feedback" items become implementation tickets.

### Phase 2: Interaction Feedback Repair

Purpose: make every click obviously meaningful.

Work:

1. Add a persistent action receipt panel near the clicked context, not only in the top bar.
2. For row actions, show inline receipt inside the row: `readback`, `external_action=false`, blocker, next action, proof URI.
3. For disabled actions, show why disabled and how to unlock.
4. For dangerous actions like delete, keep them disabled until a scoped approval + proof lane exists; if implemented later, require explicit confirmation, soft-delete/recovery semantics, and readback proof before any irreversible action.
5. For mock/readiness-only plugins, label buttons as `readiness check` rather than `実行候補` if no live action will run.
6. For Home live execution icons, replace unlabeled icon-only ambiguity with tooltip + inline result.
7. Add "last action" history visible on each page.

Done when:

- A user can explain what happened after each click without reading dev artifacts.
- Chrome re-audit finds no `silent_noop` and no major `weak_feedback`.

### Phase 3: Durable Mac Worker / Local Execution Lane

Purpose: make "実行" actually run safe local work from the user's Mac/Chrome lane.

Work:

1. Fix durable heartbeat so production `/api/mvp/state` reports fresh heartbeat continuously.
2. Align the local worker state store with the Zeabur production Postgres source-of-truth for worker heartbeat, queue, run, proof, and secret availability/readback only; raw secrets must stay in the local secret lane or an approved secret manager, never in ordinary Postgres rows.
3. Add a worker lane status card: running/stale/missing, last heartbeat, queue age, next command.
4. Implement safe queue pickup for non-external preflight jobs only.
5. Add worker-run proof: run id, picked step, exit status, artifact path, cleanup proof.
6. Keep risky external side-effect jobs blocked with exact human boundary.
7. Add a one-click local worker diagnostic that never processes queues, only verifies heartbeat/readback.

Done when:

- `mac_worker_heartbeat_stale` is gone.
- Pressing a safe run action creates a visible run/proof or exact blocker.
- Pressing risky workflows stops before external action with clear proof.

### Phase 4: Project A Workflow Usability

Purpose: make Daily AI, NisenPrints, and Job Manager feel like real managed workflows.

Daily AI:

1. Show current status, last run, duplicate guard, target accounts, posting boundary, and proof links.
2. Allow research/draft/preflight runs.
3. Stop before external posting unless explicitly approved with account proof.

NisenPrints:

1. Show current product candidate, Canva/Printify/Etsy/Pinterest state, duplicate guard, and existing IDs.
2. Allow read-only/preflight and artifact review.
3. Stop before product creation, publish, listing update, pin post, delete, checkout, or payment unless a scoped approval/proof lane exists.

Job Manager:

1. Show candidate company, URL, form state, duplicate application guard, and submit boundary.
2. Allow research/pre-fill/readback where safe.
3. Stop before submit, assessment/test, OTP/security-code, identity, or account setting changes.

Done when:

- Each workflow has a usable detail page.
- Each workflow has an obvious "safe preview/preflight" path.
- Each workflow has a blocked external path with exact next human action.

### Phase 5: Chat As Command Center

Purpose: Chat should behave closer to Codex App, but with company/project/workflow boundaries.

Work:

1. Keep Enter as newline and button-only send.
2. Show current mode: answer-only, plan draft, save-only, schedule change, run preflight, external-boundary.
3. Make "do not run", "reason only", "save only", and "draft only" impossible to override by old context.
4. Let the user ask natural questions about any workflow and get API/artifact-backed answers.
5. Let the user create/update automations from chat, but require explicit review before schedule/run/write actions.
6. Display LLM source: hosted OpenAI, Mac worker, fallback, or blocked.
7. Show queued LLM jobs and worker status inside chat.

Done when:

- Chrome QA confirms natural Japanese commands, reset, long text, ambiguous instructions, and "do not run" behave correctly.
- Chat output is backed by readback, not hallucinated status.

### Phase 6: Feedback Loop as Product QA Engine

Purpose: make user-reported problems easy to send and easy for Codex to fix.

Work:

1. Keep bottom-right Feedback always visible.
2. Improve screenshot fallback when capture fails.
3. Include route, viewport, asset URL, user agent, console errors, last action, DOM excerpt, and comment.
4. Store to `/api/mvp/feedback` and optional Supabase sink.
5. Add triage categories: silent click, weak feedback, wrong page, old UI/cache, worker blocker, auth blocker, visual issue, mobile issue.
6. Add a Codex recovery workflow with explicit stages: fetch open feedback, reproduce in Chrome plugin, patch locally, verify, deploy only with scoped proof/readback, then PATCH feedback to `triaged` only after the fix is proven. Do not make deploy or triage update an unreviewed automatic side effect.

Done when:

- Feedback submission works from every route.
- New feedback can be fixed without the user recording videos manually.

### Phase 7: Company / Team / Scale Model

Purpose: evolve from personal MVP to company-grade Automation OS.

Work:

1. Add company, workspace, project, role, and environment model.
2. Separate training/sandbox/production accounts.
3. Add account inventory with status: connected, expired, training-only, production-approved, unknown.
4. Add RBAC: owner/admin/operator/viewer.
5. Add audit log for every action and attempted action.
6. Add approval policies per workflow and per external service.
7. Add team-safe secrets model: never expose raw secret, only scoped availability/readback.

Done when:

- Company-level dashboard can answer who can run what, against which account, from which PC, with what proof.

### Phase 8: Production / Deploy / Monitoring

Purpose: stop old UI/cache/deploy confusion and know which version is live.

Work:

1. Show production commit, deployment id, JS asset hash, API state source, and build time in UI.
2. Add "old asset/cache detected" warning if Chrome serves stale JS.
3. Keep `/api/health`, `/api/mvp/state`, `/api/mvp/feedback`, Project A registered automation smoke running.
4. Add rollback readback proof without executing rollback.
5. Add CI or scheduled monitor for production operations.
6. Keep legacy endpoints clearly marked as non-source-of-truth.

Done when:

- User and Codex can immediately tell whether they are seeing the new UI, old UI, local UI, or production UI.

### Phase 9: Visual / Mobile / Operator Quality

Purpose: make it feel professional, not a prototype.

Work:

1. Test desktop and mobile widths.
2. Eliminate clipped Japanese, tiny icon-only ambiguity, and card overflow.
3. Replace placeholder metrics with clearly marked placeholder/readback states.
4. Make status labels human-readable but precise.
5. Use consistent row actions, tooltips, panels, and receipts.
6. Record screen/video proof for critical flows.

Done when:

- A non-technical user can operate core flows without asking "did it work?"

### Phase 10: Verification Gates

Purpose: never hand over untested UI again.

Required checks before handoff:

1. `npm run build`
2. `git diff --check`
3. `npm run monitor:production-operations`
4. `npm run verify:all-page-buttons -- https://automation-os.zeabur.app`
5. Chrome plugin manual operation on critical flows.
6. Screenshot or video proof for click flows.
7. API readback for health/state/feedback/registered automations.
8. Codex read-only review after code changes.
9. Feedback open items checked and triaged.
10. STATE/Plan updated with current blockers and proof URIs.

Hand-off criteria:

- No silent safe button.
- No misleading enabled dangerous button.
- No old UI/cache confusion.
- Worker state and run state are understandable.
- External actions remain blocked with exact next human action.
- The user can touch the app without becoming the QA department.

### Execution Order

1. Full Chrome click audit and artifact creation.
2. Fix silent/weak-feedback buttons first.
3. Define the minimum company/project/account/worker-lane boundary model before enabling queue pickup.
4. Fix durable worker heartbeat and safe queue pickup within that boundary model.
5. Rebuild Project A workflow detail pages.
6. Harden Chat as command center.
7. Improve feedback capture and Codex triage flow.
8. Expand the company/team/account model beyond the minimum boundary.
9. Add production version/cache/deploy clarity.
10. Run full verification gates.
11. Update STATE/Plan and hand off only with proof.

Current exact blockers:

- `mac_worker_heartbeat_stale`
- `real_auth_and_external_action_evidence_not_yet_captured`
- Open feedback items still require reproduction/fix/triage.
- Full company-grade model is not implemented yet.

## 2026-07-03 Comprehensive Risk Closure Plan

Current recommendation: close the secret-handling lane and deploy-scope lane first. These two gates reduce the largest future failures: unsafe credential handling, unclear production/local behavior, accidental external actions, and not knowing whether a workflow actually completed.

Current execution update: Priority 1 is implemented, deployed, and production-readback verified. Secret-only messages can be stored without starting runs, service account JSON keeps its value encrypted outside the DB and redacted in chat, and summaries expose only non-secret state/routing fields. Priority 2 is complete for the scoped commit `f42ecefc3a722ef7e9d6cfe6da282050f3f78f81`: production QA and Replay QA passed with writes disabled. Priority 3 Create/LLM production readback confirmed `/api/create/plan/jobs` queues Mac worker subscription planning while `/api/runs/start` remains protected by `401 production_write_token_required`. Full execution artifact: `/Users/nichikatanaka/Documents/Codex/automation-os/work/comprehensive-plan-execution-readback-20260703.json`.

2026-07-06 update: all currently safe UI/feedback/Project A QA candidates were executed on the new `automation-os-new` production surface. Deployed commit `b21187f162ff87fdd34302bc01c002a78df0e4af` added the all-page button QA runner and redacted feedback state projection. Production all-page QA passed with `clicked=147`, `skipped=110`, `failed=0`, stable state unchanged, no console/page errors, and video evidence at `/Users/nichikatanaka/Documents/Codex/automation-os/work/automation-os-new-deploy-repo/output/playwright/all-page-button-qa-20260706134605/videos/page@a5c703e344baebd083438cdbc884f286.webm`. Chrome plugin closeout QA passed at `/Users/nichikatanaka/Documents/Codex/automation-os/work/automation-os-new-deploy-repo/artifacts/chrome-production-qa/20260706-next-actions-closeout/summary.json`. Feedback is currently `open=0 / triaged=14`; production `/api/mvp/feedback` is the source for this count, not local fallback feedback readbacks. Project A has exactly Daily AI, Job Application Manager, and NisenPrints registered via `/api/mvp/registered-automations?project_id=project-a`; legacy `/api/dashboard` and `/api/registered-workflows` are not the source for this MVP closeout. Latest production operations monitor is pass-with-blockers / not operations-ready with `production_operations_ready=false`: `/Users/nichikatanaka/Documents/Codex/automation-os/work/automation-os-new-deploy-repo/artifacts/production-operations-monitor/20260706172339/summary.json`. Remaining work is now boundary-driven, not generic UI button repair.

### 2026-07-06 Remaining Candidate List

1. Keep running all-page production QA after every UI/deploy change with `npm run verify:all-page-buttons -- https://automation-os.zeabur.app`.
2. Keep feedback intake through `/api/mvp/feedback`; open items should be triaged into concrete code/UI fixes, then PATCHed to `triaged`.
3. Add a periodic CI/Zeabur smoke job for `/api/health`, `/api/mvp/state`, `/api/mvp/feedback`, and Project A registered automations.
4. Decide product direction for Project detail tabs: keep the current registered-automation-list UX, or restore fuller old Project detail tabs with real editing behavior.
5. Implement worker heartbeat freshness repair so `worker=idle` but stale heartbeat becomes an exact next action rather than a vague warning.
6. Do not run NisenPrints/Daily AI/Job external actions until duplicate guards, target account, and per-action proof are fresh-read; stop on payment, checkout, CAPTCHA, OTP, identity, admin/macOS permission, or assessment/test.
7. Clean or archive pre-existing dirty QA artifacts separately; do not mix them into deploy commits unless explicitly scoped.

### Priority 0: Non-negotiable boundaries

- Do not auto-pass billing, purchase, payment, checkout, CAPTCHA, OTP, security code, identity verification, assessments/tests, admin prompts, or macOS permission prompts.
- Do not treat screenshots, Obsidian notes, or generated handoffs as completion proof by themselves.
- Do not promote training-account SNS proof into production proof.
- Do not rerun external post/publish/submit/send/save flows without duplicate checks, account confirmation, run id, URL/DOM/API readback, artifact receipt, and cleanup proof.
- Do not deploy from the current dirty worktree until the intended file set is scoped.

### Priority 1: Secret and credential lane

Goal: chat-pasted secrets can be accepted only as secret material, stored safely, redacted everywhere else, and routed to the correct workflow without starting the workflow accidentally.

Work items:

- Define secret intake states: `detected`, `store_only`, `stored`, `available_to_runner`, `expired`, `rotation_required`, `blocked`.
- Add/verify redaction for passwords, API keys, service account JSON, private keys, cookies, session tokens, OAuth tokens, phone/email verification codes, and recovery codes.
- Ensure secret-only chat messages never become workflow titles, replies, Plan entries, STATE entries, Obsidian text, screenshots, or artifacts with raw values.
- Preserve JSON/private key newlines for `GOOGLE_SERVICE_ACCOUNT_JSON`.
- Attach every stored secret to an explicit workflow/purpose/account label, for example `prompt-transfer-ukiyoe/google-service-account` or `sns-training/x-profile`.
- Require a separate user intent before using a newly stored secret for external writes.
- Show whether the runner can actually see the secret, without printing the value.
- Add stale-secret and token-expiry blockers with exact next action.

Verification:

- API tests for secret-only messages, multiline JSON, private key redaction, and store-only/no-run behavior.
- UI test that title/reply/knowledge/Plan/STATE do not leak secret snippets.
- Runner readback that reports presence and target workflow only.

### Priority 2: Deploy scope and production parity

Goal: local fixes are promoted to production without unrelated dirty-worktree changes, and production is proven to behave like local.

Work items:

- Classify `git status` into `deploy_now`, `hold_local`, `pre_existing_dirty`, and `unknown`.
- Make a scoped commit only for Create/LLM lane, planner hardening, tests, and required docs.
- Push and wait for Zeabur commit/asset readback.
- Re-run production `/api/health`, `/api/create/plan`, `/api/create/plan/jobs`, `/api/dashboard`, `/api/registered-workflows`.
- Confirm `/api/create/plan/jobs` is allowed while `/api/runs/start` remains guarded.
- Confirm production asset is fresh, not cached old JS.

Verification:

- `rtk npm run build:server`
- `rtk npm run typecheck:web`
- focused server tests for Create/secret/write guard
- `rtk npm run build:web`
- `rtk git diff --check`
- production QA and Replay QA with write disabled

Current blocker: `deploy_scope_unclear_dirty_worktree`.

### Priority 3: Create chat and LLM reliability

Goal: Create chat remains flexible with Mac worker Codex CLI when hosted OpenAI API is unavailable, while simple questions stay immediate.

Work items:

- Keep immediate answer lane separate from Mac worker LLM lane.
- Keep UI labels explicit: `即時: ...` and `LLM: ...`.
- Ensure `answer_question` does not queue planner jobs.
- Ensure complex planning queues Mac worker jobs when immediate planner is `local_fallback/openai_api_key_missing`.
- Add worker heartbeat and queue age visibility for planner jobs.
- Add exact blocker when `LLM: Mac worker待ち` appears but worker is not running.
- Prevent old chat context from overriding the latest "do not run", "reason only", "save only", or "draft only" instruction.
- Keep multi-workflow requests separated by target workflow.

Verification:

- Natural-language tests for "do not run", "what can you do", "reason only", "save only", "schedule change", and multi-workflow input.
- Playwright QA with OpenAI env unset.
- API readback for queued/completed/blocked planner jobs.

### Priority 4: Source-of-truth and completion semantics

Goal: the UI and docs clearly distinguish strict success, reconciled success, accepted partial, blocked, and training evidence.

Work items:

- Standardize labels: `strict_complete`, `reconciled_complete`, `accepted_partial`, `training_partial`, `blocked_exact`, `human_input_required`.
- Show source-of-truth order in UI/diagnostics: DB/API, workflow-owned artifact, then Obsidian locator.
- Add run/proof identity checks so artifacts must match run id, workflow id, external URL/account, and timestamp.
- Keep old run ids visible only as history, not current state.
- Require cleanup proof for complete runs that launch local browser/process lanes.
- Mark NisenPrints as accepted partial unless strict network proof appears.
- Mark Daily AI and Job as reconciled complete, not strict registered-runner success.

Verification:

- Dashboard sanitizer tests.
- API readback for `/api/dashboard`, `/api/registered-workflows`, run detail, and proof rows.
- Artifact identity tests for each reconciliation CLI.

### Priority 5: External account and SNS safety

Goal: production posting only happens to an explicitly chosen account/platform set, with duplicate prevention and per-platform proof.

Work items:

- Add account labels: `training`, `production`, `unknown`, `do_not_use_for_proof`.
- Keep `@nichika2000823` as training-only until user changes it.
- Require intended account and platform scope before SNS rerun.
- Add duplicate detection for caption, media hash, URL, listing id, pin id, and prior run id.
- Require per-platform readback for X, Instagram, Threads, Facebook, Pinterest.
- Stop on CAPTCHA/OTP/security code/identity verification.
- Do not delete/edit/repost automatically.

Verification:

- CDP login lane readback.
- Per-platform URL/DOM/screenshot/API proof where available.
- No duplicate post proof before any posting run.

### Priority 6: Prompt Transfer and Google Sheets

Goal: row `B16:D16` commit can resume only when credentials are valid, scoped, and read back from Sheets.

Work items:

- Wait for approved `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`.
- Validate service account JSON shape without printing secrets.
- Confirm target spreadsheet permission.
- Re-read latest apply-plan before commit so stale Docs/Sheets changes do not apply.
- Commit only planned range unless user explicitly changes range.
- Capture `commit.json` and same-range Sheets readback.
- Keep "do not commit" / "reason only" as answer-only behavior.

Verification:

- Dry-run/readback before write.
- Commit artifact.
- Same range post-write readback.
- Secret redaction tests.

### Priority 7: NisenPrints strict gap

Goal: avoid duplicates while keeping public-local proof and strict-runner proof clearly separate.

Work items:

- Keep existing Printify product `6a3e124c8b3f02d155080dbc`, Etsy listing `4528244402`, Pinterest pin `982347737607048291`.
- Search only for legitimate original `printify_publish/attempt-1/network.jsonl`; do not infer it from other runs.
- If strict rerun is ever required, preserve existing IDs and stop before duplicate product/listing/pin creation.
- Keep accepted partial label until strict observation and runner exit proof exist.

Verification:

- Manifest/proof identity check.
- Duplicate product/listing/pin guard.
- Strict proof gate remains false unless the exact missing proof appears.

### Priority 8: Daily AI safety

Goal: avoid duplicate posts while preserving reconciled completion and future strict-runner hardening.

Work items:

- Do not rerun publish/engagement unless fresh audit shows regression or user explicitly requests a new run.
- Keep duplicate skip keyed by post URL, content id, caption, and media.
- Keep buffer replenishment bounded.
- Ensure Sheets sync, engagement, feed study, publish, and cleanup are represented separately.
- Keep partial historical runs from overriding current reconciled completion.

Verification:

- Project-owned run summary readback.
- Automation OS DB/API readback.
- Cleanup process proof.
- No new external post proof unless explicitly authorized.

### Priority 9: Job application safety

Goal: never cross application submit, assessment, identity, or personal-data boundaries without explicit stop/readback.

Work items:

- Preserve company name, job URL, input contents, and confirmation screen before submit boundary.
- Keep Japan and overseas/global counts separate.
- Prevent duplicate applications.
- Stop for login, email verification, identity, assessment/test, or submit confirmation.
- Do not treat aggregate counts as split-target success.
- Keep reconciliation complete separate from strict runner success.

Verification:

- Job audit artifacts.
- Split-count readback.
- Duplicate application guard.
- No-submit proof for future dry-runs.

### Priority 10: Worker, browser, and process hygiene

Goal: Mac worker, CDP browser lanes, and local processes are observable, recoverable, and do not operate on the wrong profile.

Work items:

- Show Mac worker heartbeat, queue pickup, current job, and last error.
- Add queue age and stuck-job detection.
- Verify CDP port/profile/account before browser actions.
- Prevent profile mixups between training and production accounts.
- Record cleanup proof for Chrome, Playwright, worker, and child processes.
- Add restart/resume instructions for Mac reboot.
- Keep local browser automation responsibility separate from Zeabur control plane.

Verification:

- `/api/health` and `/api/dashboard` worker readback.
- Process cleanup proof.
- CDP URL/profile/account readback.
- Replay QA route readback.

### Priority 11: UI and operator experience

Goal: the operator can always tell what is safe, what is pending, what needs them, and what is already proven.

Work items:

- Make Save, Demo, Start, Schedule, Commit, Publish, Submit, and Read-only states visually distinct.
- Add account labels and proof type labels near external actions.
- Keep exact blocker visible without leaking internals or secrets.
- Keep mobile layout readable with no horizontal overflow.
- Avoid internal jargon in primary UI; keep diagnostics behind details.
- Ensure buttons cannot imply backend success before API readback.
- Add stale data labels when readback is old.

Verification:

- Desktop/mobile Playwright screenshots.
- DOM/body text checks.
- Console error checks.
- API/state readback after button actions.

### Priority 12: Evidence, QA, and test reliability

Goal: no workflow is called complete without durable, matching, recent proof.

Work items:

- Require URL, DOM/body, API/DB readback, artifact receipt, proof gate, and cleanup proof as appropriate.
- Mark screenshot-only evidence as supplemental.
- Add proof redaction checks for secrets and personal data.
- Stabilize full `npm test` or split slow suites into reliable focused gates.
- Keep Codex review as a gate when code changes are made; record exact blocker if review cannot connect.
- Keep production QA read-only unless a specific write window is approved.

Verification:

- focused tests
- full test or documented focused substitute
- `git diff --check`
- production QA
- production Replay QA
- Codex read-only review for code changes

### Priority 13: Legal, policy, and content risk

Goal: avoid irreversible or policy-sensitive actions being automated silently.

Work items:

- Keep automatic stop for payment, checkout, purchases, ads, subscriptions, refunds, and seller billing settings.
- Stop before job assessment/test or identity verification.
- Check generated images/product text for brand, trademark, and copyright concerns before product posting.
- Preserve platform policy boundaries for SNS automation and job applications.
- Avoid scraping or bypassing access controls.
- Keep AI-generated content disclosure requirements as a future review item where relevant.

Verification:

- Human boundary labels in workflow plans.
- Pre-publish/pre-submit checklist.
- Artifact showing no restricted boundary crossed.

### Current execution order

1. Scope deployable files for Create/LLM/secret hardening and separate unrelated dirty changes.
2. Add/verify secret intake redaction and store-only behavior before accepting real credentials through chat.
3. Deploy the scoped Create/LLM fixes and run production read-only QA.
4. Add worker stuck-job/heartbeat visibility for Mac worker planner jobs.
5. Update completion semantics in UI/readback for strict/reconciled/accepted-partial/training/blocked.
6. Resume Prompt Transfer only after approved Google credential lane exists.
7. Resume SNS only after intended production account and platform scope are chosen.
8. Keep X lane blocked until trusted authenticated callable surface exists.
9. Keep NisenPrints accepted partial unless legitimate strict proof appears or a non-duplicate strict rerun is explicitly planned.
10. Continue G004/G005 read-only hardening and Replay QA guardrails.

### User actions needed

- Decide whether to allow a scoped deploy for the already-local Create/LLM fixes.
- Provide Google service account credentials only through the approved secret lane once it exists or is confirmed safe.
- Decide future SNS production account and platform scope; keep training account separate.
- Handle any OTP/security code/identity/CAPTCHA prompts personally.
- Decide whether NisenPrints strict completion is worth a non-duplicate rerun, or accepted partial is enough.

## 2026-07-03 Create Chat LLM Lane Fix

Current result: Create/chat now exposes the planner lane clearly and can queue Mac worker LLM planning when hosted OpenAI API is unavailable.

- Immediate production chat can still be `local_fallback` if `OPENAI_API_KEY` is absent; that is the simple planner, not the flexible LLM.
- Flexible planning lane is Mac worker subscription planning via Codex CLI (`local_codex` / `Mac worker / Codex CLI`).
- UI now shows `即時: ...` separately from `LLM: ...`.
- UI no longer blocks `/api/create/plan/jobs` just because production write guard is token-required.
- Server explicitly lets `/api/create/plan/jobs` bypass production write guard because it only queues Mac worker planning; `/api/runs/start` remains guarded.
- Verification passed: `build:server`, `typecheck:web`, focused tests `92/92`, `build:web`, `git diff --check`, and local Playwright Create QA with OpenAI env unset.
- Evidence: `/tmp/automation-os-create-llm-queue-qa-20260702T1650Z/summary.json` and screenshot in the same directory.

Remaining: production still needs a scoped deploy. Do not deploy from the current dirty worktree until the intended deploy file set is confirmed; blocker `deploy_scope_unclear_dirty_worktree`.

## 2026-07-03 Create Chat Natural-Language Hardening

Current result: Create/chat is not claimed perfect, but the newly found human-like natural-language failures are fixed and locally verified.

- Fixed correction after wrong assumption so "今は動かさないで / 何ができるかだけ" answers capabilities without planning a run.
- Fixed job-submit boundary copy to explicitly preserve company name, job URL, input contents, and confirmation screen before stopping.
- Fixed Prompt Transfer "理由だけ / Sheetsには書かないで" to answer the Google credential blocker and avoid Sheets writes.
- Fixed Google service-account secret-only wording so secret snippets do not leak into title/reply.
- Verification passed: `build:server`, focused `apiRunsStart.test.js` 20/20, `git diff --check`, and Codex review with no major findings.
- Remaining: production still needs the normal deploy/push path before these local fixes appear on `https://automation-os.zeabur.app`.

## 2026-07-03 Safe Candidate Closeout

Current result: all safe next-action candidates are closed out. G003 stays `boundary-accounted`; it is not strict-complete.

- Verification passed: `build:server`, focused tests `182/182`, full `npm test` `533/533`.
- Production QA passed at `/tmp/automation-os-production-qa-2026-07-02T15-48-43-000Z` with `failures=[]`.
- Production Replay QA passed at `/tmp/automation-os-production-replay-qa-2026-07-02T15-48-44-007Z` with `ok=true`, `allowWrite=false`, write guard `401 production_write_token_required`, all 6 workflows active/connected, clean desktop/mobile route readback, and Create answer-only video.
- Daily AI and Job remain reconciled complete.
- NisenPrints remains accepted partial because the Hollyhock target-run `printify_publish/attempt-1/network.jsonl` is missing.
- Prompt Transfer remains blocked by missing Google service-account credentials.
- SNS CDP `9339` is reachable, but this is still training-lane only; no final SNS account or production completion proof is chosen.
- No external write, post, send, submit, Sheets commit, production schedule mutation, or registered workflow start was performed.

Next safe action: continue G004/G005 read-only/local hardening, or resume exactly one blocked workflow only after the user supplies its prerequisite: approved Google service-account secret lane, future SNS intended account/platform scope, trusted X callable surface, or legitimate NisenPrints target strict proof.

## 2026-07-03 Training Lane Fixed / G004-G005 QA Refreshed

Current result: `@nichika2000823` is now explicitly treated as a practice/training SNS lane. The visible X post remains useful as training-lane readback but is not production SNS completion proof.

G004/G005 read-only QA was refreshed after this clarification. Production QA passed at `/tmp/automation-os-production-qa-2026-07-02T15-35-39-156Z` with `failures=[]`. Production Replay QA passed at `/tmp/automation-os-production-replay-qa-2026-07-02T15-35-39-610Z` with `ok=true`, `allowWrite=false`, write guard `401 production_write_token_required`, all 6 workflows active/connected, desktop/mobile UI readback clean, and Create answer-only replay video present.

Next safe action: continue G004/G005 read-only/local-test hardening or wait for a future explicit SNS intended-account decision. Do not rerun the X post command, do not promote the training post to production proof, and do not perform production schedule mutations or registered workflow starts without an explicit write-run window.

## 2026-07-03 SNS/X Partial Readback

Current result: SNS login lane is now available on CDP `http://127.0.0.1:9339`, and X readback found a visible post at `https://x.com/nichika2000823/status/2072701049161593116` for run `run_mqtbe1ex_711rcx`.

Important boundary: this is not full SNS Multi Poster completion. The runner only exercised the X/CDP path in this resume, still returned `sns_multi_poster_post_confirmation_unverified`, and the observed X account is `@nichika2000823` while the fixed Ukiyoe SNS target in the skill is `@Nisenprints`.

User clarification: `@nichika2000823` is a practice/training account, and the final account may change later. Treat the current post as training-lane evidence only; do not use it as production SNS completion proof.

Next safe action: do not rerun the X post command. Keep SNS workflow partial until a future intended account and per-platform scope are explicitly chosen. If strict SNS completion is required later, implement/verify per-platform readback for Instagram/Threads/Facebook/Pinterest/X without duplicate posting.

Evidence:
- `/Users/nichikatanaka/Documents/Codex/automation-os/work/sns-x-post-readback-20260703.json`
- `/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/sns-multi-poster-ukiyoe/artifacts/runs/run_mqtbe1ex_711rcx/x-compose.png`
- `/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/sns-multi-poster-ukiyoe/prepared-media/2026-06-24-020158-b4c0-fuji-yuzu-steam-onsen-cream-white-cat-x-2048.jpg`

## 2026-07-02 Goal Refresh

Current Goal: Automation OS の G003 残件を boundary-accounted として固定し、G004 schedule persistence と G005 production Replay QA を read-only 証跡で前進させる。

2026-07-02 latest update:

- G003 is now boundary-accounted, not strict-complete. Daily AI and Job are reconciled complete, NisenPrints is accepted partial, and Prompt Transfer/SNS/X are exact human/tooling boundaries. Fresh artifact: `/Users/nichikatanaka/Documents/Codex/automation-os/work/g004-g005-boundary-accounted-readback-20260702.json`.
- G004 schedule persistence was verified through `rtk npm run build:server` and focused tests `rtk node --test --test-concurrency=1 apps/server/dist/tests/apiRunsStart.test.js apps/server/dist/tests/apiFirstStageCompat.test.js`, passing 85/85. No production schedule mutation or registered workflow start was performed.
- G005 production QA and Replay QA passed with write disabled. Production QA output: `/tmp/automation-os-production-qa-2026-07-02T14-47-42-068Z`, `failures=[]`, deployment commit `657194667a77fde28e94ead42025bd1744382fc8`. Replay QA output: `/tmp/automation-os-production-replay-qa-2026-07-02T14-48-02-164Z`, `ok=true`, `allowWrite=false`, write guard `401 production_write_token_required`, all 6 registered workflows active/connected, no desktop/mobile horizontal overflow, console errors `0`, and Create answer-only replay video present.
- G005 hardening follow-up: production Replay QA recommendations are now treated as runbook guardrails. Replay summaries should carry source readback for `plannerExecutionMode`, Mac worker planner lane, and hosted browser-tool absence, so future resumes know Zeabur is the control plane and Mac worker owns subscription-backed planning/browser proof capture.
- G005 recommendation hardening is implemented in `/Users/nichikatanaka/Documents/Codex/automation-os/work/g005-replay-recommendation-hardening-20260702.json`. New verification passed: `build:server`, focused `dashboardSanitizer.test.js` 71/71, production QA `/tmp/automation-os-production-qa-2026-07-02T15-01-31-757Z/summary.json`, and production Replay QA `/tmp/automation-os-production-replay-qa-2026-07-02T15-01-51-462Z/replay-summary.json` with `sourceReadback` on `planner-lane` and `browser-lane`.
- Daily AI was resumed after explicit user approval. The externally active run `2026-07-02T13-29-38-909Z` published to X and LinkedIn, completed 13 engagement actions, synced Sheets, restored buffer `3/3`, then failed strict completion on `feed_study_insufficient:25/26`.
- Resume run `2026-07-02T13-41-45-654Z` skipped duplicate publish, merged the prior 13 engagement receipts, synced 459 rows, kept buffer `3/3`, cleaned up Chrome/processes, and evaluates `complete` with `evaluateDailyAiRegisteredSummary`.
- Automation OS recorded this as `run_daily_ai_completion_mr3k7yde_67x0rp` / proof `proof_daily_ai_completion_mr3k7yde_jnxxfl` using `daily_ai_completion_reconciliation_readback`. This is completion reconciliation proof, not a strict registered-runner success claim, because the resume summary has empty `automation_os_run_id`.
- Dashboard and registered workflow API readbacks now show Daily AI `needs_check=false`, `last_result_label=完了記録あり`, and `last_run_id=run_daily_ai_completion_mr3k7yde_67x0rp`.
- G003 audit is refreshed at `/Users/nichikatanaka/Documents/Codex/automation-os/work/g003-completion-audit-20260702.json`: all 6 workflows are accounted, complete count is `2` (Job + Daily AI), `g003_complete=false`, and `remaining_executable_without_external_approval=[]`.
- Remaining unfinished lanes were rechecked in `/Users/nichikatanaka/Documents/Codex/automation-os/work/g003-unfinished-boundary-recheck-20260702.json`: Prompt Transfer still lacks Google credentials, SNS CDP `9339` is unreachable, X callable surface is still missing, and NisenPrints still lacks the historical `printify_publish/attempt-1/network.jsonl`. No external writes/posts were attempted, and there is no additional safe executable work without human/tooling input.

Source-of-truth order:

1. Automation OS DB/API/readback: `/Users/nichikatanaka/Documents/Codex/automation-os/data/automation-os.sqlite`, `/api/dashboard`, `/api/registered-workflows`, run detail/proof rows.
2. Workflow-owned project state/artifacts: each workflow's `STATE.md`, registered automation state, latest run summary, source-of-truth export, proof, cleanup.
3. Obsidian generated notes and `resume-contract.json`: locator only, never completion proof.

Current correction:

- Phase 1-3 are accepted in `GOAL.md`; do not restart from Create planner work unless a fresh readback shows regression.
- Active Automation OS milestone is G003 / Phase 4: registered workflows can start, fail with exact blocker, be repaired, rerun from latest definitions, and complete or stop only at a real human boundary.
- Automation OS DB still points to 2026-06-25 runs for several workflows. Some workflow-owned project states are newer, especially Job Application Manager on 2026-07-02. When they differ, fresh-read the workflow-owned state/artifact and then reconcile Automation OS DB/UI readback.
- Machine audit `/Users/nichikatanaka/Documents/Codex/automation-os/work/g003-completion-audit-20260702.json` says all 6 workflows are accounted, complete count is `2`, and `g003_complete=false`; Daily AI and Job are reconciled complete, NisenPrints is accepted partial, and remaining open items are exact human/tooling boundaries.
- NisenPrints strict-gap recheck `/Users/nichikatanaka/Documents/Codex/automation-os/work/nisenprints-strict-gap-readback-20260702.json` reconfirms `completion_ok=true`, but strict completion still fails only on `stage_observation_missing:printify_publish/attempt-1/network.jsonl`; keep accepted-partial accounting and do not infer or recreate that missing observation.
- Obsidian `Resume Current Work.md` now includes a `Current Action Queue` section sourced from `selectActionQueueRuns`, while preserving the single `Resume candidate`. Use it as a locator for the four current action runs, then read workflow-owned STATE/artifacts and the G003 audit for exact blocker details. The section intentionally omits run metadata details so stale Daily AI DB text such as `ship_now_buffer_below_target:2/3` does not override the current local buffer-restored proof.

Current G003 workflow table:

| Workflow | Automation OS DB latest | Workflow-owned latest | Current state | Next safe action |
|---|---|---|---|---|
| `daily-ai-research-publish-run` | Latest Automation OS readback is `run_daily_ai_completion_mr3k7yde_67x0rp` complete with proof `daily_ai_completion_reconciliation_readback`; older partial/blocker reconciliation runs and historical runner run `run_mqtbe1ef_p0tjpw` remain preserved | Approved resume produced two project-owned summaries: `2026-07-02T13-29-38-909Z` performed X/LinkedIn publish plus 13 engagement actions and failed only on `feed_study_insufficient:25/26`; `2026-07-02T13-41-45-654Z` skipped duplicate publish, merged prior engagement receipts, synced 459 rows, kept buffer `3/3`, cleaned up Chrome/processes, and evaluates complete | Current accounting state is reconciled complete. This is not a strict registered-runner success claim because the resume summary has empty `automation_os_run_id`; DB metadata keeps `strict_registered_success_claimed=false`, `external_actions_performed=false`, and `additional_posts_published=false` for the reconciliation row. Dashboard/registered workflow readback now points to `run_daily_ai_completion_mr3k7yde_67x0rp` with `needs_check=false` | Treat Daily AI as complete for G003 reconciliation/readback. Do not rerun or repost Daily AI unless a fresh source-of-truth audit shows regression or the user explicitly requests a new run |
| `nisenprints-daily-product-canva-printify-etsy-pinterest` | Latest reconciliation run `run_nisenprints_reconcile_mr3hd4p9_a7wkj4` partial with proof `nisenprints_completion_reconciliation_readback`; historical runner run `run_mqtbe1en_dvqg94` and older reconciliation run `run_nisenprints_reconcile_mr3epl8c_guy4he` remain preserved | Etsy Hollyhock manifest shows public-local completion observed: Printify product `6a3e124c8b3f02d155080dbc`, Etsy listing `4528244402`, Pinterest pin `982347737607048291`; strict proof has `completion_ok=true` but `strict_stage_observations_ok=false`; fresh strict-gap readback narrows the missing observation to `printify_publish/attempt-1/network.jsonl` | Current strict state is partial, not complete. DB metadata records `accepted_partial=true`, `accepted_partial_reason=historical_strict_runner_proof_gap`, `strict_registered_success_claimed=false`, and proof gate missing `strict_stage_observation` plus `nisenprints_runner_exit_0` | Treat as accepted partial for G003 accounting; do not create duplicate product/listing/pin. Only accept strict registered success if a legitimate original network observation proof appears or a fresh non-duplicate registered rerun preserves existing IDs |
| `job-application-manager` | New reconciliation run `run_job_reconcile_mr3dq6cp_unhiob` complete with proof `job_completion_reconciliation_readback`; historical runner run `run_mqu3doqb_9n1c6a` remains blocked | New Project run `codex-app-job-application-manager-20260702-153200` proves Japan `21/20`, overseas/global `20/20`; `user-action-normalization-receipt.json` is `ok:true` with 14 security/auth items preserved and 36 non-user-action artifacts resolved; `completion-audit-after-user-action-normalization.json` is the full-target audit artifact that reads `ok:true` | Job DB/UI reconciliation is now proof-backed in Automation OS readback without mutating the old blocked run or submitting more applications. This is reconciliation proof, not a strict claim that the historical registered runner execution succeeded | Treat Job as reconciled for G003 accounting; do not submit more applications unless a fresh audit disproves the counts. Daily AI is also reconciled complete; remaining G003 work is Prompt Transfer/SNS/X human/tooling evidence and NisenPrints strict stage observation/runner proof repair without duplicate product/listing/pin creation |
| `prompt-transfer-ukiyoe` | New blocker reconciliation run `run_prompt_transfer_reconcile_mr3f6oop_kk52b2` blocked with proof `prompt_transfer_blocker_reconciliation_readback`; historical runner run `run_mqtbe1ep_vgi2ex` remains blocked | Skill/runner/artifact fresh-read confirms extract and apply-plan succeeded, row `B16:D16` is planned, `committed=false`, `retry_from_stage=commit`; current shell has no `GOOGLE_SERVICE_ACCOUNT_JSON` | Current state is an exact credential blocker, not a runner mystery. Automation OS UI/readback now points to `google_service_account_json_missing`; no Google Sheets write was attempted or claimed | Keep blocked until approved `GOOGLE_SERVICE_ACCOUNT_JSON` secret lane is available; then rerun commit path and capture `commit/commit.json` plus same-range Sheets readback |
| `sns-multi-poster-ukiyoe` | latest `run_mqtbe1ex_711rcx` runner summary remains blocked at `sns_multi_poster_post_confirmation_unverified`; read-only artifact `work/sns-x-post-readback-20260703.json` found X post URL `https://x.com/nichika2000823/status/2072701049161593116` | Persistent CDP lane `http://127.0.0.1:9339` is logged in. Current runner path exercised X/CDP only, not all 5 SNS platforms. Observed X account `@nichika2000823` is user-confirmed as a practice/training account; final target account may change later | Training-lane partial confirmation only: X post is visible, but it is not production SNS completion proof and not full SNS coverage | Do not rerun the X post command. Keep partial until the future intended account and platform scope are explicitly chosen; strict SNS completion also needs per-platform readback without duplicate posting |
| `x-authenticated-browser-lane` | latest real X lane run `run_mqtbe1ey_b2ji4z` blocked, `x_authenticated_browser_lane_human_input_required_with_evidence`; callable surface not connected | Artifact fresh-read confirms `dryRun=true`, `externalActionExecuted=false`, and command display says the runner callable surface is not connected | Human/tooling boundary: trusted authenticated browser callable surface is missing | Connect/authorize a trusted X browser callable surface, then capture URL/screenshot/DOM/exact blocker or approved save proof before rerun |

Execution order from here:

1. Produce a fresh G003 audit artifact under `work/` from Automation OS DB plus workflow-owned latest states.
   - Latest: `/Users/nichikatanaka/Documents/Codex/automation-os/work/g003-completion-audit-20260702.json`, `all_workflows_accounted=true`, complete count `2`, `g003_complete=false`.
2. Update `GOAL.md` G003 integration ledger with the refreshed 2026-07-02 workflow table.
3. Job Application Manager reconciliation receipt now exists at `/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/job-application-manager/reconciliation-latest/job-completion-reconciliation-receipt.json`; committed reconciliation run `run_job_reconcile_mr3dq6cp_unhiob` is visible through `/api/runs`, `/api/dashboard`, and `/api/registered-workflows`.
4. Daily AI completion reconciliation receipt exists at `/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/daily-ai-research-publish-run/completion-reconciliation-latest/daily-ai-completion-reconciliation-receipt.json`; committed run `run_daily_ai_completion_mr3k7yde_67x0rp` and proof `proof_daily_ai_completion_mr3k7yde_jnxxfl` are visible through `/api/runs`, `/api/dashboard`, and `/api/registered-workflows`. The older blocker, partial ingest, and local buffer restoration artifacts remain preserved as history. Current API readbacks are under `work/daily-ai-completion-*-20260702.json`.
5. Prompt Transfer blocker reconciliation receipt now exists at `/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/prompt-transfer-ukiyoe/reconciliation-latest/prompt-transfer-blocker-reconciliation-receipt.json`; committed blocker readback run `run_prompt_transfer_reconcile_mr3f6oop_kk52b2` is visible through `/api/runs`, `/api/dashboard`, and `/api/registered-workflows`.
6. NisenPrints accepted-partial receipt now exists at `/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/nisenprints/reconciliation-accepted-partial-20260702-v2/nisenprints-completion-reconciliation-receipt.json`; committed run `run_nisenprints_reconcile_mr3hd4p9_a7wkj4` records `accepted_partial_reason=historical_strict_runner_proof_gap` without claiming strict registered success or creating a duplicate listing/pin.
   - Latest strict-gap readback: `/Users/nichikatanaka/Documents/Codex/automation-os/work/nisenprints-strict-gap-readback-20260702.json`; exact missing file is `stage_observation_missing:printify_publish/attempt-1/network.jsonl`.
7. Do not submit more Job applications unless a fresh audit disproves the split counts. A future strict registered Job runner rerun is optional for runner-hardening, not required to resolve the stale DB/UI mismatch.
8. Run focused tests for any audit/reconciliation code changed.
9. Re-read `/api/dashboard`, `/api/registered-workflows`, and relevant run detail/proof rows locally or production as appropriate.
10. Remaining workflows are exact-blocked, accepted-partial, or strict-proof-gapped: Prompt Transfer needs approved Google service account credential; SNS/X has training-lane partial evidence only and needs a future intended account plus full per-platform readback without duplicate posting; the separate X authenticated browser lane needs trusted callable/authenticated browser surface; NisenPrints is accepted partial unless strict registered success is explicitly required. Fresh recheck artifact confirms `remaining_executable_without_external_approval=[]`.
11. Keep Obsidian resume surfaces aligned with this accounting: `Resume Current Work.md` must show the current action queue without stale metadata details. Treat `Automation OS User Action Queue.md` as a broader legacy locator that may lag the generated resume brief.
12. G003 now has current exact human-boundary blockers/accepted-partial accounting, so continue G004/G005 from read-only/local-test proof. Do not set `AUTOMATION_OS_REPLAY_ALLOW_WRITE=1`, do not perform production schedule mutations, and do not start registered workflows from CLI unless the user provides the required trusted write/auth lane and the action has workflow-owned proof plus cleanup proof.
13. Keep G005 recommendations actionable in the artifact itself: Replay QA must show the source readback behind Mac worker planner/browser lane recommendations, not only a prose recommendation.
14. After any Replay QA recommendation/code hardening, run Codex read-only review, Obsidian export, and `git diff --check` before closing the turn.

Stop rules:

- Stop for billing, purchase, payment, checkout.
- Do not bypass CAPTCHA, OTP/security-code, identity verification, assessments/tests, admin/macOS permission prompts, or unknown personal facts.
- Non-billing publish/send/submit/save/delete actions require explicit human approval, scoped approval lane, workflow-owned source-of-truth proof, exact evidence, and cleanup proof; without all of these, record exact blocker and stop before the external action.

## 結論

Automation OS の次の主目標は、Zeabur を「画面・DB・キュー・状態管理」に固定し、Mac worker を「Codex サブスクで考えて実行する本体」にすることです。

最優先は、Create チャットの重い計画生成を Zeabur 内の OpenAI API ではなく、Postgres queue 経由で Mac worker の Codex 実行へ渡すことです。その後、登録済み workflow は read-only / preflight / local test / proof readback に限定して `定期実行候補 -> 失敗 -> 修正 -> 最新定義で安全再確認 -> proof` のループで確認します。

## 現在の前提

- 本番 URL: `https://automation-os.zeabur.app`
- Zeabur は Postgres / UI / API / write guard / schedule readback を担当する。
- OpenAI API キーなしの場合、本番 health は `plannerExecutionMode: "mac_worker_subscription"` を正ルートとして扱う。
- Mac worker は Codex CLI / Codex app の ChatGPT サブスクログインで処理する。
- 課金、購入、支払い、checkout、CAPTCHA、OTP、security code、本人確認、応募確定、投稿確定は自動操作しない。
- 外部確定操作は、直前で止めて URL、画面、入力内容、run 証跡を残す。

## 完了条件

- Create チャットが、質問、相談、修正、実行依頼、定期化、失敗修正を自然に分類できる。
- OpenAI API キーなしでも、Mac worker 経由で Codex サブスク実行できる。
- 登録済み workflow が本番画面から read-only / preflight / dry-run / 履歴確認でき、定期化は write guard または明示承認下でだけ扱える。
- 失敗時に exact blocker が残り、修正後に最新登録定義で安全な preflight/readback を再実行できる。
- 本番 URL で Record & Replay を通し、desktop/mobile で横スクロール、文字切れ、console error がない。
- `npm test`、focused tests、本番 Replay QA が通る。
- 残る blocker は、人間ログイン、CAPTCHA、OTP、外部サービス権限、支払い、応募/投稿確定など明確な人間境界だけになる。

## 停止条件

- 支払い、購入、checkout が必要になった。
- CAPTCHA、OTP、security code、本人確認が出た。
- 外部投稿、応募、送信、公開の最終確定が必要になった。
- Google service account、SNS CDP、Canva connector など、ユーザー側の権限準備が必要になった。
- Mac worker の Codex ログインが切れていて、こちらから復旧できない。

停止した場合は、exact blocker、対象 URL、画面状態、必要な人間操作、再開コマンドを残す。

## Phase 1: Mac worker を本物の実行レーンにする

### やること

- Mac 側で `codex login status` を確認する。
- ChatGPT/Codex サブスク認証で `codex exec` が動くことを確認する。
- `OPENAI_API_KEY` なしでも worker が動くことを確認する。
- worker heartbeat を本番画面で常時確認できるようにする。
- worker 停止時に、復旧に必要な操作を画面に短く出す。
- worker が本番 Postgres の queued run を拾えることを確認するのは、read-only / preflight / local test / dry-run / readback-only job、または explicit human/scoped approval + proof lane があるjobに限定する。

### 完了条件

- 本番 health が `plannerExecutionMode: "mac_worker_subscription"` で blocker なし。
- Dashboard の Mac worker が `待機中` または `処理中` として読める。
- `npm run worker:loop` または production worker 起動コマンドで、安全条件を満たす queued run だけを拾える。

### 検証方法

- `/api/health` readback
- `/api/dashboard` readback
- Mac worker heartbeat readback
- 本番 Sources 画面 screenshot
- worker loop の処理ログ

## Phase 2: Create チャットを Mac worker へ非同期委譲する

### やること

- `/api/create/plan` の即時応答と非同期 worker 計画を分ける。
- 「何ができますか？」などの単純質問は即時回答のままにする。
- 難しい相談、長い計画、修正依頼、登録 workflow 調整は planner job として Postgres に保存する。
- Mac worker が planner job を Codex サブスクで処理する。
- worker 結果を DB に戻す。
- Create 画面に `worker待ち`、`考え中`、`完了`、`失敗理由あり` を表示する。
- 失敗した planner job は exact blocker つきで再開できるようにする。

### 完了条件

- OpenAI API キーなしで、Create チャットの重い相談が Mac worker に渡る。
- worker が Codex で作った計画を Create 画面に反映できる。
- worker が止まっている時は、ユーザーに「Mac worker待ち」と分かる。
- 即時回答すべき質問は、無駄に queue に送られない。

### 検証方法

- API test: simple question は immediate answer
- API test: complex planning は planner job queued
- worker test: queued planner job を処理して result 保存
- UI test: Create 画面に pending/result/blocker 表示
- Replay QA: 本番 URL で Create 送信から結果表示まで録画

## Phase 3: チャット品質を Codex app 寄りにする

### やること

- 質問、相談、修正、実行、定期化、失敗確認、秘密情報保存を分類する。
- 「違います」「もっと具体的に」「全部やって」「あと何をする？」の会話を継続理解する。
- 前の下書き、直前の相談、実行履歴、登録 workflow 状態を必要に応じて参照する。
- 固定テンプレの繰り返しを減らす。
- 不足質問は最大 1-3 個に絞る。
- 「できること」を聞かれたら、計画化せず機能一覧を返す。
- 秘密情報は、明示承認 + scoped secret lane + redacted readback/proof がある場合だけ保存し、保存後も実行しない。

### 完了条件

- 「このチャットは何ができますか？」に機能一覧で答える。
- 「新しい自動化を作って」では不足質問を出す。
- 「毎朝9時に価格確認、投稿や購入はしない」では read-only 自動化計画になる。
- 「応募ボタン直前で止める」では不要な定期質問を出さない。
- API key や DATABASE_URL 入力は secret-only として扱い、永続保存は明示承認 + scoped secret lane + redacted readback/proof がある場合だけ行う。

### 検証方法

- Create planner API replay cases
- UI replay with real messages
- snapshot / screenshot / DOM readback
- regression tests for repeated template drift

## Phase 4: 登録済み workflow の E2E 成功確認

対象 workflow:

- `daily-ai-research-publish-run`
- `nisenprints-daily-product-canva-printify-etsy-pinterest`
- `job-application-manager`
- `prompt-transfer-ukiyoe`
- `sns-multi-poster-ukiyoe`
- `x-authenticated-browser-lane`

### 共通フロー

1. 登録定義を読む。
2. 現在の schedule と runner status を読む。
3. 本番画面から開始できるのは read-only / preflight / draft / local test / proof readback のみとする。
4. Mac worker が拾うのは non-external preflight または local/readback job に限定する。
5. 失敗したら exact blocker を保存する。
6. 原因を修正する。
7. 登録されている最新定義で再実行するのは安全な preflight/readback 範囲だけにする。
8. post/publish/submit/save/delete/payment/checkout/CAPTCHA/OTP/security-code/identity/admin/assessment に近づいたら停止し、scoped approval と proof lane がない限り繰り返さない。
9. 成功 proof、画面、URL、ログ、cleanup を保存する。

### 完了条件

- 各 workflow が最新登録定義から開始できる。
- 失敗時に blocker が Runs で見える。
- 修正後に同じ workflow id で安全な preflight/readback を再実行できる。
- 成功時に proof gate が通る。

### 検証方法

- `/api/registered-workflows` readback
- `/api/runs/:id` readback
- worker events readback
- proof viewer readback
- Record & Replay video

## Phase 5: 定期実行の確認

### やること

- Schedule 保存 API は local test / dry-run / write guard 下、または scoped approval + proof lane がある時だけ検証する。
- 次回実行予定を readback する。
- scheduler が due workflow を queue に入れることは dry-run/readback-only で確認する。
- Mac worker が queue を拾うことは non-external preflight / local test / readback-only job に限定して確認する。
- 失敗時の retry 条件を記録する。
- schedule 変更後の永続化確認は local/dry-run または明示承認済みの scoped proof lane でのみ行う。

### 完了条件

- Schedule 画面で登録済み workflow の時刻が分かる。
- 保存した schedule が DB に残る。
- Runs に queued/running/complete/blocked が反映される。
- 再起動後も schedule override が残る。

### 検証方法

- Schedule API test
- registered workflow refresh test
- scheduler test
- production readback
- Replay QA

## Phase 6: Record & Replay 検証

### 対象画面

- Home
- Create
- Schedule
- Runs
- Sources
- Mac worker panel
- Run detail
- Proof drawer
- Approvals

### 確認すること

- desktop/mobile で横スクロールがない。
- 文字切れがない。
- 見出しと本文が不自然にズレない。
- console error がない。
- 主要ボタンが押せる。
- 実行後の結果が画面に戻る。
- screenshot だけでなく DOM/API/readback も保存する。

### 完了条件

- 本番 URL で Replay QA が `ok: true`。
- 動画 artifact が保存される。
- `failures: []`。
- 残る blocker が人間境界だけ。

## Phase 7: Mac worker 実行ログの見える化

### やること

- いま処理中の run を表示する。
- 最後に処理した run を表示する。
- Codex の成功/失敗を表示する。
- exact blocker をユーザー向けに短く表示する。
- 内部 path、pid、secret、raw JSON は通常画面に出さない。
- 詳細は診断内に隠す。

### 完了条件

- Runs で `Mac worker処理中`、`Mac workerが処理しました`、`Mac workerが途中で止まりました` が分かる。
- Sources で worker heartbeat が分かる。
- 復旧コマンドが短く表示される。

## Phase 8: 自動修正ループ

### やること

- failed/blocked run を検出する。
- exact blocker と proof gate を読む。
- Codex worker が修正案を作る。
- コード修正が必要な場合は scoped patch を作る。
- focused test を回す。
- 全体 test を回す。
- 最新登録 workflow で再実行するのは non-external preflight / local tests / readback-only jobs に限定する。
- 外部確定操作に入らない範囲で成功まで繰り返す。

### 停止条件

- 人間ログインが必要。
- 外部確定操作が必要。
- 支払い/購入が必要。
- CAPTCHA/OTP/security code が必要。
- 仕様判断が必要。

### 完了条件

- `失敗 -> 修正 -> 最新定義で再実行 -> 成功` が 1 workflow 以上で実証される。
- その手順が他 workflow に再利用できる。

## Phase 9: UI/UX 全面改善

### やること

- 文字サイズを整理する。
- 日本語の折り返しを自然にする。
- 長い英単語や URL が崩れないようにする。
- 内部用語を通常画面から減らす。
- 「Mac worker」「本番」「確認」「履歴」の意味を初心者にも分かる表示にする。
- カード内カードを避ける。
- モバイルでボタンやラベルが詰まらないようにする。
- 詳細情報は details/drawer に逃がす。

### 完了条件

- Home/Create/Schedule/Runs/Sources が違和感なく読める。
- mobile 390px で横スクロールなし。
- 選択中の要素、見出し、キャプションの揃いが自然。
- ユーザーが「次に何を押すか」迷いにくい。

## Phase 10: 公開前品質チェック

### チェック項目

- `npm test`
- focused API tests
- focused UI sanitizer tests
- local Replay QA
- production Replay QA
- `/api/health`
- `/api/dashboard`
- `/api/registered-workflows`
- production write guard
- Mac worker heartbeat
- proof viewer
- cleanup/no residual process

### 完了条件

- 本番 commit が最新。
- 本番 Replay QA が `ok: true`。
- 本番 Postgres readback が成功。
- write guard が token なしで state-changing API を止める。
- worker heartbeat が本番画面で読める。

## Phase 11: 1000万人規模へ向けた設計

### やること

- ユーザーごとの worker 分離。
- workspace/team 単位の権限管理。
- secrets 管理。
- queue 優先度。
- rate limit。
- audit log。
- billing 設計。
- template marketplace。
- onboarding 改善。
- support diagnostic pack 自動生成。
- workflow template の安全審査。
- 外部操作の human approval model。

### 完了条件

- 個人利用から team/workspace 利用へ拡張できる設計メモがある。
- セキュリティ境界と課金境界が明確。
- 外部確定操作の責任分界が明確。

## 次に実行する順番

1. Mac worker の Codex サブスクログインと worker heartbeat を確認する。
2. Create planner job queue を作る。
3. Mac worker が planner job を Codex で処理して DB に戻す。
4. Create 画面に worker pending/result/blocker を表示する。
5. focused tests を追加する。
6. local Replay QA を回す。
7. `npm test` を通す。
8. commit/push する。
9. Zeabur 反映を待つ。
10. production Replay QA を回す。

## 検証コマンド

```bash
npm run build:server
node --test --test-concurrency=1 apps/server/dist/tests/apiRunsStart.test.js apps/server/dist/tests/dashboardSanitizer.test.js
npm test
npm run qa:production:replay -- http://127.0.0.1:8799
npm run qa:production:replay -- https://automation-os.zeabur.app
```

## 本番で残りうる blocker

- `write_actions_disabled_for_replay_qa`
- `browser_use_callable_surface_missing` on Zeabur
- `mac_worker_heartbeat_missing`
- `codex_login_required`
- `external_auth_required`
- `captcha_or_otp_required`
- `human_confirmation_required`

これらは失敗ではなく、人間入力または Mac worker が必要な境界として扱う。
