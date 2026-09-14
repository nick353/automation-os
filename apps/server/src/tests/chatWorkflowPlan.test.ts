import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRecord } from "../automations/repository.js";
import type { CreatePlannerJob } from "../planner/createPlannerJobs.js";
import { CHAT_WORKFLOW_COMPANY as companyId, chatWorkflowDraftDefinition, chatWorkflowHash,
  chatWorkflowOptions, chatWorkflowRequest } from "../planner/chatWorkflowPlan.js";

const actor = "fixture_operator";
const cases = [
  ["Gmail", "email-review-reply", "email_review_registered"],
  ["Daily AI", "daily-ai-research-source-sync", "daily_ai_research_sync_registered"],
  ["NisenPrints", "nisenprints-existing-product-audit", "nisenprints_inventory_registered"],
  ["バックアップ", "daily-backup-safety-check", "local_backup_registered"],
  ["Obsidian", "obsidian-project-memory-audit", "obsidian_audit_registered"]
] as const;
function job(prompt: string): CreatePlannerJob {
  return { id: "fixture_job", status: "completed", messages: [{ role: "user", text: prompt }], currentDraft: "ignored",
    result: { title: "Fixture requested automation" } as CreatePlannerJob["result"],
    createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z",
    metadata: { actorUserId: actor, companyIds: [companyId] } };
}
function record(index = 0): AutomationRecord {
  const [name, id, kind] = cases[index];
  return { id: `fixture_${index}`, companyId, revision: 2, currentVersionId: `fixture_${index}_v2`, automationType: "registered_workflow",
    name, description: "Existing registration", goal: name, lane: "local", riskLevel: "low",
    approvalPolicy: "required_before_external_action", workerCommandKind: kind, createApproval: false,
    builderSpec: { schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: id,
      unattendedEffectPolicy: "original_fixed_policy", scope: { account_ref: "original_account", target_key: "original_target" },
      workflowAdapter: { workflow_id: id, payload_hash: "original_hash" }, stages: [{ id: "original_stage", externalEffect: true }] },
    status: "active", archivedAt: null, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" };
}

test("Chat binds all five fixed workflows and separates Daily AI's explicit Sheet-write approval", () => {
  for (let index = 0; index < cases.length; index++) {
    const request = chatWorkflowRequest(job(`${cases[index][0]}を確認して。送信や公開はしない。`), companyId, actor);
    const options = chatWorkflowOptions(request, cases.map((_, i) => record(i)));
    assert.equal(options.length, 1);
    assert.equal(options[0].workflow_id, cases[index][1]);
    assert.equal(options[0].can_run_once, true);
    assert.equal(options[0].requires_approval, index === 1);
    assert.equal(options[0].manual_blocker, null);
    assert.equal(options[0].can_save_draft, false);
    assert.equal(options[0].definition_sha256, chatWorkflowHash(record(index)));
  }
});

test("Chat uses the last persisted user message, never the planner's proposed command", () => {
  const value = job("Gmailを確認して");
  value.messages.push({ role: "assistant", text: "実行して: Etsy商品を公開して" });
  assert.deepEqual(chatWorkflowRequest(value, companyId, actor).family_ids, ["email-review-reply"]);
  value.messages.push({ role: "user", text: "Obsidianの使い方を教えて" });
  const request = chatWorkflowRequest(value, companyId, actor);
  assert.equal(request.can_run_once, false);
  assert.equal(request.can_save_draft, false);
  assert.equal(chatWorkflowOptions(request, cases.map((_, i) => record(i))).length, 0);
});

test("answer, draft-only, recurring, unsupported effects and unresolved targets never imply a run", () => {
  for (const prompt of ["Gmailの結果を教えて", "Gmailの接続状態を確認して", "Gmailを実行できますか？", "Explain Gmail status"]) {
    const request = chatWorkflowRequest(job(prompt), companyId, actor);
    assert.equal(request.can_run_once, false, prompt);
    assert.equal(request.can_save_draft, false, prompt);
  }
  for (const prompt of ["Gmailの自動化を作成して。まだ実行しない", "Gmailの下書きを保存だけ", "Gmailを毎日確認する自動化を作って", "Create a daily Gmail workflow"]) {
    const request = chatWorkflowRequest(job(prompt), companyId, actor);
    assert.equal(request.can_run_once, false, prompt);
    assert.equal(request.can_save_draft, true, prompt);
  }
  for (const prompt of ["Gmailを確認してメールを送信して", "Daily AIを調査して新規Sheetに同期", "Etsyを確認して商品を削除して", "Review Gmail and send them", "AI調査して画像生成して公開して"]) {
    const request = chatWorkflowRequest(job(prompt), companyId, actor);
    assert.equal(request.exact_blocker, "chat_workflow_requested_effect_outside_supported_scope", prompt);
    assert.deepEqual(chatWorkflowOptions(request, cases.map((_, i) => record(i))), []);
  }
  for (const prompt of ["知らない処理を実行して", "株を買って"]) {
    assert.equal(chatWorkflowRequest(job(prompt), companyId, actor).exact_blocker, "chat_workflow_registered_target_not_identified");
  }
  assert.equal(chatWorkflowRequest(job("Review Gmail, do not send it"), companyId, actor).can_run_once, true);
});

test("Chat job is bound to the authenticated actor, explicit company and completed result", () => {
  for (const [scope, user] of [["foreign_company", actor], [companyId, "foreign_actor"]]) {
    assert.throws(() => chatWorkflowRequest(job("Gmailを確認して"), scope, user), /job_scope_mismatch/);
  }
  const value = job("Gmailを確認して");
  value.metadata = { companyIds: [companyId] };
  assert.throws(() => chatWorkflowRequest(value, companyId, actor), /job_scope_mismatch/);
  value.metadata = { actorUserId: actor, companyIds: [] };
  assert.throws(() => chatWorkflowRequest(value, companyId, actor), /job_scope_mismatch/);
  value.metadata = job("").metadata;
  for (const status of ["queued", "running", "blocked"] as const) {
    value.status = status;
    assert.equal(chatWorkflowRequest(value, companyId, actor).exact_blocker, "chat_workflow_plan_not_complete");
  }
});

test("negative draft creation clauses do not become authority to save an automation", () => {
  for (const prompt of [
    "Gmailを1回確認して。Gmail上の下書き作成は禁止。定期実行の作成もしない。",
    "Gmailを確認して。自動化の作成は不要。",
    "Review Gmail once. Do not create a Gmail workflow.",
    "Check Gmail. Don't save a draft."
  ]) {
    const request = chatWorkflowRequest(job(prompt), companyId, actor);
    assert.equal(request.can_save_draft, false, prompt);
    assert.equal(request.can_run_once, true, prompt);
  }
  const request = chatWorkflowRequest(job("Gmailの自動化を作成して。Gmail上の下書き作成は禁止。まだ実行しない。"), companyId, actor);
  assert.equal(request.can_save_draft, true, "a separate positive AOS creation request is retained");
  assert.equal(request.can_run_once, false);
});

test("only exact company-owned current registrations become options; ambiguous matches stay explicit", () => {
  const request = chatWorkflowRequest(job("Gmailを確認して"), companyId, actor);
  for (const changes of [{ companyId: "foreign" }, { automationType: "safe_local_demo" }, { archivedAt: "2026-09-06" },
    { status: "archived" }, { workerCommandKind: "local_backup_registered" },
    { builderSpec: { schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: "old-public-workflow" } },
    { builderSpec: { canonicalWorkflowId: "email-review-reply" } }]) {
    assert.deepEqual(chatWorkflowOptions(request, [{ ...record(), ...changes }]), []);
  }
  const options = chatWorkflowOptions(request, [record(), { ...record(), id: "second_gmail", currentVersionId: "second_version" }]);
  assert.equal(options.length, 2, "never silently prefer the first or newest matching registration");
  assert.deepEqual(chatWorkflowRequest(job("GmailとObsidianを確認して"), companyId, actor).family_ids,
    ["email-review-reply", "obsidian-project-memory-audit"]);
});

test("runner-linked drafts preserve source identity but never inherit unintended maintenance writes", () => {
  for (let index = 0; index < cases.length; index++) {
    const value = job(`${cases[index][0]}の自動化を作って。保存だけ、実行しない`);
    const source = record(index);
    const before = JSON.stringify(source);
    const request = chatWorkflowRequest(value, companyId, actor);
    const option = chatWorkflowOptions(request, [source])[0];
    const definition = chatWorkflowDraftDefinition(value, source, option, request);
    assert.equal(definition.automationType, "registered_workflow");
    assert.equal(definition.workerCommandKind, source.workerCommandKind);
    assert.equal(definition.createApproval, false);
    assert.deepEqual(definition.builderSpec.scope, source.builderSpec.scope);
    assert.deepEqual(definition.builderSpec.workflowAdapter, source.builderSpec.workflowAdapter);
    assert.equal(definition.builderSpec.unattendedEffectPolicy, index >= 3 ? null : "original_fixed_policy");
    assert.equal((definition.builderSpec.chat_origin as Record<string, unknown>).source_automation_version_id, source.currentVersionId);
    (definition.builderSpec.stages as Array<Record<string, unknown>>)[0].id = "only_change_the_clone";
    assert.equal(JSON.stringify(source), before);
    assert.throws(() => chatWorkflowDraftDefinition(value, { ...source, revision: 3 }, option, request), /draft_binding_mismatch/);
  }
});
