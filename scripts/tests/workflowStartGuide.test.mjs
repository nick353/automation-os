import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const sourcePath = resolve("apps/web/src/workflowStartGuide.ts");
const bundled = await build({
  entryPoints: [sourcePath],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  logLevel: "silent"
});
const module = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(
  createRequire(sourcePath), module, module.exports
);
const { buildWorkflowStartGuide } = module.exports;

const companyId = "company_2560580981cedfd106b66245";
const base = {
  companyId,
  companyLabel: "Company 1",
  auth: { verified: true },
  worker: { heartbeatFresh: true },
  automations: [
    { id: "gmail-1", name: "メール確認・返信管理", company_id: companyId },
    { id: "daily-1", canonicalWorkflowId: "daily-ai-research-publish-run", company_id: companyId, binding_status: "not_claimed" },
    { id: "nisen-1", canonicalWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest", company_id: companyId, binding_status: "bound", latest_proof: { same_run_receipt: true } },
    { id: "backup-1", name: "日次バックアップ スナップショット確認", company_id: companyId },
    { id: "obsidian-1", name: "Obsidianプロジェクト記憶 週次監査", company_id: companyId }
  ]
};

test("builds the fixed five-workflow guide without external effects", () => {
  const guide = buildWorkflowStartGuide(base);
  assert.equal(guide.items.length, 5);
  assert.equal(guide.externalActionExecuted, false);
  assert.deepEqual(guide.executionGate, { status: "unknown", canRun: false, canPreflight: false, exactBlocker: null });
  assert.equal(guide.items.find((item) => item.id === "email-review-reply").state, "needs_readback");
  assert.equal(guide.items.find((item) => item.id === "daily-ai-research-publish-run").state, "needs_binding");
  assert.equal(guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").state, "ready");
  const daily = guide.items.find((item) => item.id === "daily-ai-research-publish-run");
  assert.equal(daily.companyEvidence, "company_scope_match");
  assert.equal(daily.accountEvidence, "account_unknown");
  assert.match(daily.approvalRequirement, /承認/);
  assert.equal(daily.exactBlocker, "browser_use_live_resource_unregistered");
  assert.equal(guide.items.find((item) => item.id === "email-review-reply").exactBlocker, "unknown_readback");
});

test("maps ready registration gates to ready and preflight-only execution", () => {
  const runnable = buildWorkflowStartGuide({
    ...base,
    executionGate: { status: "ready", canRun: true, canPreflight: true, exactBlocker: null }
  });
  assert.deepEqual(runnable.executionGate, { status: "ready", canRun: true, canPreflight: true, exactBlocker: null });

  const preflightOnly = buildWorkflowStartGuide({
    ...base,
    executionGate: { status: "ready", canRun: false, canPreflight: true, exactBlocker: "external_action_blocked" }
  });
  assert.deepEqual(preflightOnly.executionGate, { status: "preflight_only", canRun: false, canPreflight: true, exactBlocker: "external_action_blocked" });
});

test("blocks ready registration gates without run or preflight permission", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    executionGate: { status: "ready", canRun: false, canPreflight: false, exactBlocker: "registered_readback_blocked" }
  });
  assert.deepEqual(guide.executionGate, { status: "blocked", canRun: false, canPreflight: false, exactBlocker: "registered_readback_blocked" });
});

test("keeps loading and error registration gates unknown while retaining blockers", () => {
  const loading = buildWorkflowStartGuide({
    ...base,
    executionGate: { status: "loading", canRun: true, canPreflight: true, exactBlocker: "readback_loading" }
  });
  assert.deepEqual(loading.executionGate, { status: "unknown", canRun: false, canPreflight: false, exactBlocker: "readback_loading" });

  const error = buildWorkflowStartGuide({
    ...base,
    executionGate: { status: "error", canRun: true, canPreflight: true, exactBlocker: "registered_readback_error" }
  });
  assert.deepEqual(error.executionGate, { status: "unknown", canRun: false, canPreflight: false, exactBlocker: "registered_readback_error" });
});

test("fails closed on auth and company scope mismatch", () => {
  const unauthenticated = buildWorkflowStartGuide({ ...base, auth: { verified: false, exactBlocker: "owner_sso_required" } });
  assert.ok(unauthenticated.items.every((item) => item.state === "needs_auth"));

  const mismatched = buildWorkflowStartGuide({
    ...base,
    automations: [{ id: "daily-1", canonicalWorkflowId: "daily-ai-research-publish-run", company_id: "other-company" }]
  });
  assert.equal(mismatched.items.find((item) => item.id === "daily-ai-research-publish-run").state, "company_mismatch");
});

test("matches canonical IDs nested in adopted automation builder specs", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [
      { id: "automation_1", name: "求人応募管理（AOS Identity対応）", company_id: companyId, builder_spec: { canonicalWorkflowId: "job-application-manager" } },
      { id: "automation_2", name: "メール確認・返信管理（AOS approval対応）", company_id: companyId, builder_spec: { canonicalWorkflowId: "email-review-reply" } },
      { id: "automation_3", name: "日次バックアップ スナップショット確認", company_id: companyId, builder_spec: { canonicalWorkflowId: "daily-backup-safety-check" } },
      { id: "automation_4", name: "Obsidianプロジェクト記憶 週次監査", company_id: companyId, builder_spec: { canonicalWorkflowId: "obsidian-project-memory-audit" } },
      { id: "automation_5", name: "Daily AI", company_id: companyId, builder_spec: { canonicalWorkflowId: "daily-ai-research-publish-run" } },
      { id: "automation_6", name: "NisenPrints", company_id: companyId, builder_spec: { canonicalWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest" } }
    ]
  });
  assert.equal(guide.items.find((item) => item.id === "email-review-reply").state, "needs_readback");
  assert.equal(guide.items.find((item) => item.id === "daily-backup-safety-check").state, "needs_readback");
  assert.equal(guide.items.find((item) => item.id === "obsidian-project-memory-audit").state, "needs_readback");
});

test("prefers an authoritative canonical binding and exposes conflicting candidates", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [
      { id: "automation_gmail", name: "メール確認・返信管理（AOS approval対応）", company_id: companyId, builder_spec: { canonicalWorkflowId: "email-review-reply" }, status: "active" },
      { id: "gmail-test-draft", name: "AOS受入テスト Chat Gmail 20260906", company_id: companyId, status: "draft" }
    ]
  });
  const gmail = guide.items.find((item) => item.id === "email-review-reply");
  assert.equal(gmail.bindingEvidence, "canonical_id");
  assert.equal(gmail.state, "needs_readback");
  assert.equal(gmail.automationId, "automation_gmail");
  assert.equal(gmail.candidateAutomations.length, 2);
});

test("prefers the one bound canonical copy over paused unbound duplicates", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [
      { id: "automation_gmail_bound", name: "メール確認・返信管理（AOS approval対応）", company_id: companyId, status: "active", execution_target: { state: "bound", connection_ref_id: "gmail-1", account_ref: "mailbox-1", connection_evidence: "verified" }, builder_spec: { canonicalWorkflowId: "email-review-reply" } },
      { id: "automation_gmail_paused", name: "AOS実runner下書き確認", company_id: companyId, status: "paused", execution_target: { state: "unbound", connection_evidence: "verified", exact_blocker: "execution_target_unbound" }, builder_spec: { canonicalWorkflowId: "email-review-reply" } },
      { id: "gmail-test-draft", name: "AOS受入テスト Chat Gmail 20260906", company_id: companyId, status: "draft" }
    ]
  });
  const gmail = guide.items.find((item) => item.id === "email-review-reply");
  assert.equal(gmail.bindingEvidence, "canonical_id");
  assert.equal(gmail.automationId, "automation_gmail_bound");
  assert.equal(gmail.executionTarget.state, "bound");
  assert.notEqual(gmail.state, "ambiguous");
  assert.equal(gmail.candidateAutomations.length, 3);
});

test("uses a fresh verified company Gmail account reference without exposing its value", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [
      { id: "automation_gmail", name: "メール確認・返信管理（AOS approval対応）", company_id: companyId, builder_spec: { canonicalWorkflowId: "email-review-reply" } }
    ],
    accountRefs: [{ id: "connection-gmail", companyId, platform: "gmail", accountRef: "private@example.com", status: "verified", verificationStatus: "verified", oauthState: "connected", revokedAt: null, expiresAt: null }]
  });
  const gmail = guide.items.find((item) => item.id === "email-review-reply");
  assert.equal(gmail.accountEvidence, "account_ref");
  assert.equal(gmail.automationId, "automation_gmail");
  assert.equal(gmail.connectionEvidence, "verified");
  assert.equal(gmail.executionTarget.state, "unknown");
});

test("does not infer a Gmail execution target from a verified company connection", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [{ id: "automation_gmail", name: "Gmail", company_id: companyId, builder_spec: { canonicalWorkflowId: "email-review-reply" }, execution_target: { state: "unbound", connection_evidence: "verified", exact_blocker: "execution_target_unbound", next_action: "bind explicitly" } }],
    accountRefs: [{ id: "connection-gmail", companyId, platform: "gmail", accountRef: "private@example.com", status: "verified", verificationStatus: "verified", oauthState: "connected", scopes: ["read"], revokedAt: null, expiresAt: null }]
  });
  const gmail = guide.items.find((item) => item.id === "email-review-reply");
  assert.equal(gmail.connectionEvidence, "verified");
  assert.equal(gmail.executionTarget.state, "unbound");
  assert.equal(gmail.state, "needs_binding");
  assert.equal(gmail.exactBlocker, "execution_target_unbound");
});

test("preserves explicit Gmail execution-target failure states", () => {
  for (const state of ["company_mismatch", "competing", "revoked", "scope_insufficient"]) {
    const guide = buildWorkflowStartGuide({
      ...base,
      automations: [{ id: `automation-${state}`, name: "Gmail", company_id: companyId, builder_spec: { canonicalWorkflowId: "email-review-reply" }, execution_target: { state, connection_evidence: "verified", exact_blocker: `blocker-${state}`, next_action: `fix-${state}` } }]
    });
    const gmail = guide.items.find((item) => item.id === "email-review-reply");
    assert.equal(gmail.executionTarget.state, state);
    assert.equal(gmail.exactBlocker, `blocker-${state}`);
    assert.equal(gmail.nextAction, `fix-${state}`);
  }
});

test("does not silently promote a name-only Gmail draft to canonical", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [
      { id: "gmail-test-draft", name: "AOS受入テスト Chat Gmail 20260906", company_id: companyId, status: "draft" }
    ]
  });
  const gmail = guide.items.find((item) => item.id === "email-review-reply");
  assert.equal(gmail.bindingEvidence, "name_or_alias");
  assert.equal(gmail.canonicalWorkflowId, "email-review-reply");
});

test("keeps company scope unknown when a candidate has no company id", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [{ id: "daily-unknown", canonicalWorkflowId: "daily-ai-research-publish-run", name: "Daily AI" }]
  });
  const daily = guide.items.find((item) => item.id === "daily-ai-research-publish-run");
  assert.equal(daily.companyEvidence, "company_scope_missing");
  assert.equal(daily.state, "needs_readback");
  assert.equal(daily.exactBlocker, "company_scope_missing");
});

test("does not synthesize a canonical registration from an inventory count", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [],
    executionGate: { status: "ready", canRun: false, canPreflight: true, exactBlocker: "external_action_blocked" }
  });
  assert.equal(guide.items.find((item) => item.id === "daily-ai-research-publish-run").state, "not_registered");
  assert.equal(guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").state, "not_registered");
});

test("exposes local-only checks independently of the aggregate effect gate", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    executionGate: { status: "ready", canRun: false, canPreflight: false, exactBlocker: "registered_automation_effect_stage_not_admitted" }
  });
  const backup = guide.items.find((item) => item.id === "daily-backup-safety-check");
  const obsidian = guide.items.find((item) => item.id === "obsidian-project-memory-audit");
  const daily = guide.items.find((item) => item.id === "daily-ai-research-publish-run");
  assert.deepEqual(guide.executionGate, {
    status: "blocked",
    canRun: false,
    canPreflight: false,
    exactBlocker: "registered_automation_effect_stage_not_admitted"
  });
  assert.deepEqual(backup.localCheck, {
    supported: true,
    label: "取得済みローカル情報を確認",
    exactBlocker: null
  });
  assert.deepEqual(obsidian.localCheck, {
    supported: true,
    label: "取得済みローカル情報を確認",
    exactBlocker: null
  });
  assert.equal(daily.localCheck.supported, false);
});

test("keeps the five-row guide separate from a dynamic six-record registration inventory", () => {
  const registeredAutomations = [
    { id: "daily-reg", canonicalWorkflowId: "daily-ai-research-publish-run", name: "Daily AI", company_id: companyId, status: "active", can_run: false, exact_blocker: "web_operation_aos_chrome_companion_runner_entrypoint_missing" },
    { id: "job-reg", canonicalWorkflowId: "job-application-manager", name: "Job Application Manager", company_id: companyId, status: "active", can_run: false, exact_blocker: "external_boundary" },
    { id: "nisen-reg", canonicalWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest", name: "NisenPrints", company_id: companyId, status: "active", can_run: false, exact_blocker: "external_boundary" },
    { id: "prompt-reg", canonicalWorkflowId: "prompt-transfer-ukiyoe", name: "prompt-transfer-ukiyoe", company_id: companyId, status: "active", can_run: false, exact_blocker: "external_boundary" },
    { id: "sns-reg", canonicalWorkflowId: "sns-multi-poster-ukiyoe", name: "sns-multi-poster-ukiyoe", company_id: companyId, status: "active", can_run: false, exact_blocker: "external_boundary" },
    { id: "x-reg", canonicalWorkflowId: "x-authenticated-browser-lane", name: "x-authenticated-browser-lane", company_id: companyId, status: "active", can_run: false, exact_blocker: "external_boundary" }
  ];
  const guide = buildWorkflowStartGuide({ ...base, registeredAutomations, registeredReadbackStatus: "ready" });
  assert.equal(guide.items.length, 5);
  assert.equal(guide.registeredAutomations.length, 6);
  assert.equal(guide.items.filter((item) => item.registrationStatus === "registered").length, 2);
  assert.equal(guide.items.filter((item) => item.registrationStatus === "not_present").length, 3);
  const daily = guide.items.find((item) => item.id === "daily-ai-research-publish-run");
  assert.equal(daily.registeredAutomationId, "daily-reg");
  assert.equal(daily.registeredCanRun, false);
  assert.equal(daily.registeredExactBlocker, "web_operation_aos_chrome_companion_runner_entrypoint_missing");
  assert.equal(guide.items.find((item) => item.id === "email-review-reply").registrationStatus, "not_present");
  assert.equal(guide.items.find((item) => item.id === "daily-backup-safety-check").registrationStatus, "not_present");
  assert.equal(guide.items.find((item) => item.id === "obsidian-project-memory-audit").registrationStatus, "not_present");
  assert.ok(guide.items.every((item) => item.registeredCanRun === false));
});

test("correlates the current API shape when canonical IDs are carried by registration IDs", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    registeredReadbackStatus: "ready",
    registeredAutomations: [
      { id: "daily-ai-research-publish-run", name: "Daily AI", company_id: companyId, can_run: false },
      { id: "nisenprints-daily-product-canva-printify-etsy-pinterest", name: "NisenPrints", company_id: companyId, can_run: false }
    ]
  });
  assert.equal(guide.items.find((item) => item.id === "daily-ai-research-publish-run").registrationStatus, "registered");
  assert.equal(guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").registrationStatus, "registered");
  assert.equal(guide.items.find((item) => item.id === "email-review-reply").registrationStatus, "not_present");
  assert.equal(guide.registeredAutomations[0].canonicalWorkflowId, "daily-ai-research-publish-run");
});

test("keeps registration loading and error distinct from a confirmed absent entry", () => {
  const loading = buildWorkflowStartGuide({ ...base, registeredReadbackStatus: "loading", registeredAutomations: [] });
  assert.ok(loading.items.every((item) => item.registrationStatus === "loading"));
  const error = buildWorkflowStartGuide({ ...base, registeredReadbackStatus: "error", executionGate: { status: "error", canRun: false, canPreflight: false, exactBlocker: "registered_readback_error" } });
  assert.ok(error.items.every((item) => item.registrationStatus === "error"));
  assert.ok(error.items.every((item) => item.registeredExactBlocker === "registered_readback_error"));
  const absent = buildWorkflowStartGuide({ ...base, registeredReadbackStatus: "ready", registeredAutomations: [] });
  assert.ok(absent.items.every((item) => item.registrationStatus === "not_present"));
  assert.ok(absent.items.every((item) => item.registeredExactBlocker === null));
});

test("keeps local-only checks eligible when the current registration response has no matching entry", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [],
    registeredReadbackStatus: "ready",
    registeredAutomations: [],
    executionGate: { status: "ready", canRun: false, canPreflight: false, exactBlocker: "external_effect_gate_closed" }
  });
  for (const id of ["daily-backup-safety-check", "obsidian-project-memory-audit"]) {
    const item = guide.items.find((candidate) => candidate.id === id);
    assert.equal(item.registrationStatus, "not_present");
    assert.equal(item.automationId, null);
    assert.equal(item.localCheck.supported, true);
  }
});

test("shows bounded latest same-run readback without changing the execution gate or blocker", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: base.automations.map((item) => item.id === "nisen-1" ? { ...item, latest_proof: undefined } : item),
    executionGate: { status: "ready", canRun: false, canPreflight: true, exactBlocker: "external_action_blocked" },
    runs: [{
      id: "run_nisen_latest",
      company_id: companyId,
      canonical_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      automation_id: "nisen-1",
      status: "completed",
      updated_at: "2026-09-09T01:02:03.000Z",
      metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, operation_effect_state: "none", effects_mode: "read_only" }
    }]
  });
  const nisen = guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.deepEqual(guide.executionGate, { status: "preflight_only", canRun: false, canPreflight: true, exactBlocker: "external_action_blocked" });
  assert.equal(nisen.state, "needs_readback");
  assert.equal(nisen.exactBlocker, "unknown_readback");
  assert.deepEqual(nisen.sameRunReadback, {
    runId: "run_nisen_latest",
    status: "completed",
    runUpdatedAt: "2026-09-09T01:02:03.000Z",
    proofType: "same_run_receipt_readback"
  });
  assert.match(nisen.proofLabel, /Run ID: run_nisen_latest/);
});

test("keeps a registration blocker authoritative when a trusted run overlay exists", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    automations: [{ ...base.automations[2], exact_blocker: "registered_effect_gate_closed" }],
    runs: [{
      id: "run_nisen_blocked",
      company_id: companyId,
      workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      automation_id: "nisen-1",
      status: "complete",
      created_at: "2026-09-09T03:00:00Z",
      metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, operation_effect_state: "none", effects_mode: "read_only" }
    }]
  });
  const nisen = guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.equal(nisen.state, "needs_reconciliation");
  assert.equal(nisen.exactBlocker, "registered_effect_gate_closed");
  assert.equal(nisen.sameRunReadback.runId, "run_nisen_blocked");
});

test("rejects untrusted latest runs and never falls back to an older verified run", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    runs: [
      { id: "run_old", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", created_at: "2026-09-08T01:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, operation_effect_state: "none", effects_mode: "read_only" } },
      { id: "run_new", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "running", created_at: "2026-09-09T01:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, operation_effect_state: "none", effects_mode: "read_only" } }
    ]
  });
  const nisen = guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.equal(nisen.sameRunReadback, undefined);
  assert.equal(nisen.state, "needs_readback");
  assert.equal(nisen.exactBlocker, "unknown_readback");
});

test("requires company, workflow, automation, and explicit trusted metadata for run overlays", () => {
  const rejectedRuns = [
    { id: "wrong-company", company_id: "other-company", workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", created_at: "2026-09-09T01:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false } },
    { id: "wrong-workflow", company_id: companyId, workflow_id: "daily-ai-research-publish-run", automation_id: "nisen-1", status: "complete", created_at: "2026-09-09T01:01:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false } },
    { id: "wrong-automation", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "other-automation", status: "complete", created_at: "2026-09-09T01:02:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false } },
    { id: "missing-metadata", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", created_at: "2026-09-09T01:03:00Z", metadata_json: { same_run_receipt: true, readback_verified: true } },
    { id: "effect-unknown", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", created_at: "2026-09-09T01:04:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, operation_effect_state: "unknown" } },
    { id: "not-terminal", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "queued", created_at: "2026-09-09T01:05:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false } }
  ];
  const guide = buildWorkflowStartGuide({ ...base, runs: rejectedRuns });
  const nisen = guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.equal(nisen.sameRunReadback, undefined);
});

test("selects the latest verified run independent of array order and supports string metadata", () => {
  const guide = buildWorkflowStartGuide({
    ...base,
    runs: [
      { id: "run_new", companyId, workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest", automationId: "nisen-1", status: "success", updatedAt: "2026-09-09T02:00:00Z", metadata_json: JSON.stringify({ same_run_receipt: true, readback_verified: true, external_action_executed: false, operation_effect_state: "none", read_only_stage: "reference_readback" }) },
      { id: "run_old", companyId, workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest", automationId: "nisen-1", status: "complete", updatedAt: "2026-09-09T01:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only" } }
    ]
  });
  const nisen = guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.equal(nisen.sameRunReadback.runId, "run_new");
});

test("treats invalid and future timestamps as unknown freshness without falling back", () => {
  for (const timestampField of [
    { updated_at: "not-a-timestamp" },
    { created_at: "2999-01-01T00:00:00Z" }
  ]) {
    const guide = buildWorkflowStartGuide({
      ...base,
      runs: [
        { id: "run_old", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", created_at: "2020-01-01T00:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only" } },
        { id: "run_invalid", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", ...timestampField, metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only" } }
      ]
    });
    const nisen = guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
    assert.equal(nisen.sameRunReadback, undefined);
    assert.equal(nisen.state, "needs_readback");
    assert.equal(nisen.proofLabel, "未確認");
  }
});

test("fails closed for same-timestamp run conflicts and expired or mismatched readback metadata", () => {
  const sameTimestamp = buildWorkflowStartGuide({
    ...base,
    runs: [
      { id: "run_a", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", updated_at: "2026-09-09T05:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only" } },
      { id: "run_b", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", status: "complete", updated_at: "2026-09-09T05:00:00Z", metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only" } }
    ]
  });
  assert.equal(sameTimestamp.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").sameRunReadback, undefined);

  for (const metadata of [
    { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only", readback_expires_at: "2020-01-01T00:00:00Z" },
    { same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only", binding_revision: "2" }
  ]) {
    const guide = buildWorkflowStartGuide({
      ...base,
      runs: [{ id: "run_stale", company_id: companyId, workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", automation_id: "nisen-1", binding_revision: "1", status: "complete", updated_at: "2026-09-09T05:00:00Z", metadata_json: metadata }]
    });
    assert.equal(guide.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").sameRunReadback, undefined);
  }
});

test("reads canonical workflow identity from compact run metadata and never overlays an unregistered row", () => {
  const fromMetadata = buildWorkflowStartGuide({
    ...base,
    automations: [{ id: "nisen-1", name: "NisenPrints", company_id: companyId }],
    runs: [{
      id: "run_metadata_identity",
      company_id: companyId,
      automation_id: "nisen-1",
      status: "complete",
      updated_at: "2026-09-09T04:00:00Z",
      metadata_json: { workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest", same_run_receipt: true, readback_verified: true, external_action_executed: false, effects_mode: "read_only" }
    }]
  });
  assert.equal(fromMetadata.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").sameRunReadback.runId, "run_metadata_identity");

  const unregistered = buildWorkflowStartGuide({
    ...base,
    automations: [],
    runs: [{
      id: "run_without_registration",
      company_id: companyId,
      workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      automation_id: "nisen-1",
      status: "complete",
      updated_at: "2026-09-09T04:00:00Z",
      metadata_json: { same_run_receipt: true, readback_verified: true, external_action_executed: false }
    }]
  });
  assert.equal(unregistered.items.find((item) => item.id === "nisenprints-daily-product-canva-printify-etsy-pinterest").sameRunReadback, undefined);
});
