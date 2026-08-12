import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAdaptiveWebOperationEffect } from "../web-operation-effect-executor.mjs";

const origin = "https://fixture.example.com";
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const sourceStateDigest = sha256("fixture-source-state");
const authorityId = ({ companyId, workflowId, runId, stepId, effectStage, approvalId, idempotencyKey, targetDigest, inputBundleSha256 }) =>
  `portable-effect-${sha256([companyId, workflowId, runId, stepId, effectStage, approvalId, idempotencyKey, targetDigest, inputBundleSha256].join("\u001f")).slice(0, 32)}`;

function fixtureAuthority({ root, runId, stepId, workflowId, targetDigest, payloadHash }) {
  const inputBundleSha256 = sha256(`${runId}:fixture-input`);
  const body = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: authorityId({ companyId: "fixture-company", workflowId, runId, stepId, effectStage: "web_operation_effect", approvalId: "fixture-approval", idempotencyKey: "fixture-idempotency", targetDigest, inputBundleSha256 }),
    issued_by: "automation_os_portable_controller",
    company_id: "fixture-company",
    workflow_id: workflowId,
    run_id: runId,
    step_id: stepId,
    effect_stage: "web_operation_effect",
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    approval_id: "fixture-approval",
    approval_status: "approved",
    idempotency_key: "fixture-idempotency",
    target_digest: targetDigest,
    input_bundle_sha256: inputBundleSha256,
    payload_hash: payloadHash,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    timeout_ms: 60_000,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    first_class_root_required: false,
    app_dependency: false,
    external_action_authorized: true,
  };
  const runRoot = join(root, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const authorityPath = join(runRoot, "portable-effect-authority.v1.json");
  const bytes = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(authorityPath, bytes, { mode: 0o600 });
  chmodSync(authorityPath, 0o600);
  return { authorityPath, authoritySha256: sha256(bytes), authorityId: body.authority_id };
}

function intentFor(operation, runId, stepId) {
  const targetText = operation === "delete" ? "Delete" : operation === "update" ? "Save" : operation === "create" ? "Create" : operation === "submit" ? "Submit" : "Publish";
  const readbackText = operation === "delete" ? "Existing record" : operation === "update" ? "Updated record" : operation === "create" ? "Created record" : operation === "submit" ? "Submitted record" : "Published record";
  const payload = operation === "update" || operation === "create" ? { text: `${operation} fixture content` } : {};
  const payloadHash = sha256(JSON.stringify(payload));
  return {
    schema: "automation_os_web_operation_intent.v1",
    browser_surface: "browser_use_cli",
    operation,
    run_id: runId,
    step_id: stepId,
    idempotency_key: "fixture-idempotency",
    account_ref: "fixture-account",
    allowed_origins: [origin],
    entry_url: `${origin}/app`,
    target: { semantic_query: targetText },
    target_binding: { target_digest: sha256(targetText), source_state_digest: sourceStateDigest },
    action_plan: {
      schema: "automation_os_web_operation_action_plan.v1",
      steps: [
        ...(Object.keys(payload).length ? [{ action: "fill_target", target: { semantic_query: "Content" }, payload_key: "text" }] : []),
        { action: "click_target", target: { semantic_query: targetText } },
      ],
      payload,
      payload_hash: payloadHash,
      readback: { semantic_query: readbackText, expected: operation === "delete" ? "absent" : "present" },
    },
    payload_hash: payloadHash,
    approval_status: "approved",
    authority_sha256: null,
    readback_required: true,
    no_replay: true,
  };
}

function fixtureAdapter(readbackText) {
  let deleted = false;
  const advance = (flow, amount = 1) => ({ ...flow, contract: { ...flow.contract, action_sequence: Number(flow.contract.action_sequence || 0) + amount } });
  return {
    async startBrowserUseCliFlow(input) {
      return { session: input.session, profile: "/fixture/profile", port: input.port, contract: { action_sequence: 0, requested_session: input.session, effective_session: input.session } };
    },
    async runBrowserUseCliFlowCommand({ flow }) { return advance(flow); },
    async runBrowserUseCliFlowTargetClick({ flow, targetText }) {
      if (targetText === "Delete") deleted = true;
      return { ...advance(flow), target_result: { candidate: { match_text_sha256: sha256(targetText), match_status: "present", backend_present: true }, before_state: { state_sha256: sourceStateDigest } } };
    },
    async runBrowserUseCliFlowTargetInspect({ flow, targetText }) {
      const absent = deleted && targetText === readbackText;
      return { ...advance(flow), target_result: { candidate: { match_text_sha256: sha256(targetText), match_status: absent ? "not_found" : "present", backend_present: !absent }, before_state: { state_sha256: sourceStateDigest } } };
    },
    async runBrowserUseCliFlowReadOnlyBatch({ flow }) { return advance(flow, 3); },
    async finalizeBrowserUseCliFlow({ flow }) { return { ...flow, finalized: true, receipt_path: "/fixture/receipt.json" }; },
  };
}

test("fixture E2E executes create/update/publish/submit/delete through one semantic executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-effect-fixture-"));
  for (const operation of ["create", "update", "publish", "submit", "delete"]) {
    const runId = `fixture-${operation}`;
    const stepId = `fixture-${operation}-step`;
    const intent = intentFor(operation, runId, stepId);
    const authority = fixtureAuthority({ root, runId, stepId, workflowId: "daily-ai-research-publish-run", targetDigest: intent.target_binding.target_digest, payloadHash: intent.payload_hash });
    const result = await runAdaptiveWebOperationEffect(
      { workflow_id: "daily-ai-research-publish-run", run_id: runId, step_id: stepId, idempotency_key: intent.idempotency_key },
      { automation_id: "fixture-web", stage_id: "fixture-web-effect", mode: "authorized", lifecycle: "scheduled", public_lane: false, allowed_origins: [origin], port: 19885 },
      { ...intent, authority_sha256: authority.authoritySha256 },
      {
        AUTOMATION_OS_ARTIFACT_ROOT: root,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.authorityPath,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.authoritySha256,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: authority.authorityId,
      },
      fixtureAdapter(intent.action_plan.readback.semantic_query),
    );
    assert.equal(result.status, "complete", operation);
    assert.equal(result.external_action_executed, true, operation);
    assert.equal(result.readback_verified, true, operation);
    assert.equal(result.cleanup_verified, true, operation);
    assert.equal(result.same_run_receipt, true, operation);
    assert.equal(result.web_operation_lifecycle.no_replay, true, operation);
  }
});

test("effectful fixture route cannot use public mode or a mismatched authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-effect-negative-"));
  const intent = intentFor("publish", "fixture-negative", "fixture-negative-step");
  const authority = fixtureAuthority({ root, runId: intent.run_id, stepId: intent.step_id, workflowId: "daily-ai-research-publish-run", targetDigest: intent.target_binding.target_digest, payloadHash: intent.payload_hash });
  const environment = {
    AUTOMATION_OS_ARTIFACT_ROOT: root,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.authorityPath,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.authoritySha256,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: authority.authorityId,
  };
  await assert.rejects(
    () => runAdaptiveWebOperationEffect({ workflow_id: intent.workflow_id || "daily-ai-research-publish-run", run_id: intent.run_id, step_id: intent.step_id, idempotency_key: intent.idempotency_key }, { ...environment, mode: "public", lifecycle: "single-use", public_lane: true, allowed_origins: [origin], port: null }, { ...intent, authority_sha256: authority.authoritySha256 }, environment, fixtureAdapter("Published record")),
    /portable_external_web_operation_effect_authorized_route_required/,
  );
  await assert.rejects(
    () => runAdaptiveWebOperationEffect({ workflow_id: "daily-ai-research-publish-run", run_id: intent.run_id, step_id: intent.step_id, idempotency_key: intent.idempotency_key }, { mode: "authorized", lifecycle: "scheduled", public_lane: false, allowed_origins: [origin], port: 19885, automation_id: "fixture-web", stage_id: "fixture-web-effect" }, { ...intent, authority_sha256: "c".repeat(64) }, environment, fixtureAdapter("Published record")),
    /portable_external_effect_authority_intent_digest_mismatch/,
  );
});
