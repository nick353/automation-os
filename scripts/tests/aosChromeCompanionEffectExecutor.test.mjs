import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AOS_CHROME_COMPANION_EFFECT_SURFACE,
  companionActionsForIntent,
  readbackFromReceipt,
  runAosChromeCompanionWebOperationEffect,
} from "../aos-chrome-companion-effect-executor.mjs";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const origin = "https://fixture.example.com";

function authorityFixture(root, input, intent) {
  const runRoot = join(root, input.run_id);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const body = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: `companion-${input.run_id}`,
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    effect_stage: "web_operation_effect",
    approval_status: "approved",
    idempotency_key: input.idempotency_key,
    target_digest: intent.target_binding.target_digest,
    input_bundle_sha256: sha256(`${input.run_id}:input`),
    payload_hash: intent.payload_hash,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    reconciliation_required: true,
    no_auto_retry: true,
    external_action_authorized: true,
  };
  const path = join(runRoot, "portable-effect-authority.v1.json");
  const bytes = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, sha256: sha256(bytes), id: body.authority_id };
}

function intentFixture(input) {
  const payload = { content_text: `payload:${input.workflow_id}` };
  return {
    schema: "automation_os_web_operation_intent.v1",
    browser_surface: AOS_CHROME_COMPANION_EFFECT_SURFACE,
    operation: input.workflow_id === "job-application-manager" ? "submit" : input.workflow_id === "prompt-transfer-ukiyoe" ? "update" : "publish",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    source_trigger: input.source_trigger,
    idempotency_key: input.idempotency_key,
    account_ref: "fixture-account",
    allowed_origins: [origin],
    entry_url: `${origin}/app`,
    target: { semantic_query: "Publish" },
    target_binding: { target_digest: sha256("Publish"), source_state_digest: sha256("approved-state") },
    action_plan: {
      schema: "automation_os_web_operation_action_plan.v1",
      steps: [
        { action: "fill_target", target: { semantic_query: "Body" }, payload_key: "content_text" },
        { action: "click_target", target: { semantic_query: "Publish" } },
        { action: "wait", seconds: 1 },
      ],
      payload,
      payload_hash: sha256(JSON.stringify(payload)),
      readback: { semantic_query: "Published", expected: "present" },
    },
    payload_hash: sha256(JSON.stringify(payload)),
    approval_status: "approved",
    authority_sha256: null,
    readback_required: true,
    no_replay: true,
  };
}

test("Companion action plan uses only bounded semantic primitives", () => {
  const input = { workflow_id: "daily-ai-research-publish-run", run_id: "run-map", step_id: "effect", source_trigger: "test", idempotency_key: "idem-map" };
  const actions = companionActionsForIntent(intentFixture(input));
  assert.deepEqual(actions.map((action) => action.method), ["page.type", "page.click", "page.delay", "page.query"]);
  assert.deepEqual(actions[0].params.locator, { text: "Body" });
  assert.equal(actions[0].params.physicalFallback, "on_verified_no_effect");
  assert.equal(actions[0].params.clear, true);
  assert.equal(actions.at(-1).params.query, "Published");
  assert.ok(actions.every((action) => JSON.stringify(action).includes("selector") === false));
});

test("Companion maps select, rich text, upload, and submit actions with operation readback", () => {
  const input = { workflow_id: "job-application-manager", run_id: "run-map-extended", step_id: "effect", source_trigger: "test", idempotency_key: "idem-map-extended" };
  const intent = intentFixture(input);
  const payload = {
    content_text: "Applicant content",
    selected_text: "Tokyo",
    upload_path: "/tmp/resume.pdf",
  };
  intent.action_plan = {
    schema: "automation_os_web_operation_action_plan.v1",
    steps: [
      { action: "select", target: { semantic_query: "Location" }, option: { label: "Tokyo" } },
      { action: "select_text", target: { semantic_query: "Cover letter" }, payload_key: "selected_text" },
      { action: "upload", target: { semantic_query: "Resume" }, payload_key: "upload_path" },
      { action: "submit", target: { semantic_query: "Submit application" } },
    ],
    payload,
    payload_hash: sha256(JSON.stringify(payload)),
    readback: {
      semantic_query: "Application submitted",
      kind: "selection",
      expected: "present",
      expected_text: "Tokyo",
    },
  };
  intent.payload_hash = intent.action_plan.payload_hash;
  const actions = companionActionsForIntent(intent);
  assert.deepEqual(actions.map((action) => action.method), [
    "page.selectOption",
    "page.selectText",
    "page.upload",
    "page.submit",
    "page.query",
  ]);
  assert.equal(actions[0].params.autoVisualProof, true);
  assert.deepEqual(actions[0].params.option, { label: "Tokyo" });
  assert.equal(actions[2].params.filePath, "/tmp/resume.pdf");
  assert.equal(actions[3].params.locator.text, "Submit application");
  assert.equal(actions.at(-1).params.query, "Application submitted");

  const readback = readbackFromReceipt({
    actions: [{
      method: "page.query",
      result: {
        count: 1,
        matches: [{ role: "status", selectedText: "Tokyo", valuePresent: true }],
      },
    }],
  }, intent);
  assert.equal(readback.verified, true);
  assert.equal(readback.operation_specific_verified, true);
  assert.equal(readback.observed_control.selected_text, "Tokyo");
});

test("all registered workflow families complete only with provider, source-sync, and cleanup proof and never replay", async () => {
  const workflows = [
    "daily-ai-research-publish-run",
    "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "job-application-manager",
    "prompt-transfer-ukiyoe",
    "sns-multi-poster-ukiyoe",
    "x-authenticated-browser-lane",
  ];
  for (const [index, workflowId] of workflows.entries()) {
    const root = mkdtempSync(join(tmpdir(), "aos-companion-effect-"));
    const input = { workflow_id: workflowId, run_id: `run-companion-${index}`, step_id: "web-effect", source_trigger: "test", idempotency_key: `idem-${index}`, task_id: `task-${index}` };
    const intent = intentFixture(input);
    const authority = authorityFixture(root, input, intent);
    intent.authority_sha256 = authority.sha256;
    let dispatchCount = 0;
    const adapterModule = {
      async executeAosChromeCompanionAuthorized(request) {
        dispatchCount += 1;
        assert.deepEqual(request.precondition, {
          semanticQuery: "Publish",
          targetDigest: intent.target_binding.target_digest,
          sourceStateDigest: intent.target_binding.source_state_digest,
        });
        return {
          result: "verified",
          external_action_executed: true,
          provider_receipt_trusted: true,
          visual_readback_verified: true,
          cleanup_verified: true,
          cleanup: { session_closed: true, lease_released_by_session_close: true, terminal_tab_cleanup: "verified" },
          reconciliation: { attempted: false, verified: false, replayed: false },
          actions: request.actions.map((action) => ({
            method: action.method,
            result: action.method === "page.query"
              ? { ok: true, count: 1 }
              : action.method === "page.type" && index === 0
                ? { ok: true, inputStrategy: "physical_fallback", semanticNoEffectVerified: true, physicalFallbackAttempted: true }
                : { ok: true, inputStrategy: action.method === "page.type" ? "semantic" : undefined },
          })),
        };
      },
    };
    const environment = {
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.path,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.sha256,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: authority.id,
    };
    const route = { mode: "authorized", lifecycle: "scheduled", public_lane: false, allowed_origins: [origin] };
    const first = await runAosChromeCompanionWebOperationEffect(input, route, intent, environment, { adapterModule, client: { close() {} } });
    assert.equal(first.status, "complete", workflowId);
    assert.equal(first.browser_surface, AOS_CHROME_COMPANION_EFFECT_SURFACE);
    assert.equal(first.adapter_result.provider_receipt_trusted, true);
    assert.equal(first.adapter_result.source_sync.verified, true);
    assert.equal(first.adapter_result.input_recovery.policy, "semantic_then_verified_no_effect_physical_once");
    assert.equal(first.adapter_result.input_recovery.physical_fallback_used, index === 0);
    assert.equal(first.adapter_result.input_recovery.physical_fallback_count, index === 0 ? 1 : 0);
    assert.equal(first.adapter_result.input_recovery.ambiguous_effect_replay_allowed, false);
    assert.equal(first.cleanup_verified, true);
    assert.equal(first.web_operation_lifecycle.state, "cleaned");
    const duplicate = await runAosChromeCompanionWebOperationEffect(input, route, intent, environment, { adapterModule, client: { close() {} } });
    assert.equal(duplicate.status, "blocked");
    assert.equal(duplicate.exact_blocker, "portable_external_web_operation_duplicate_idempotency_key");
    assert.equal(dispatchCount, 1, workflowId);
  }
});

test("unknown effects and incomplete cleanup block and remain no-replay", async () => {
  for (const mode of ["unknown_effect", "cleanup_missing"]) {
    const root = mkdtempSync(join(tmpdir(), "aos-companion-negative-"));
    const input = { workflow_id: "daily-ai-research-publish-run", run_id: `run-${mode}`, step_id: "web-effect", source_trigger: "test", idempotency_key: `idem-${mode}`, task_id: `task-${mode}` };
    const intent = intentFixture(input);
    const authority = authorityFixture(root, input, intent);
    intent.authority_sha256 = authority.sha256;
    let dispatchCount = 0;
    const adapterModule = {
      async executeAosChromeCompanionAuthorized(request) {
        dispatchCount += 1;
        return mode === "unknown_effect"
          ? {
              result: "blocked",
              exact_blocker: { code: "operation_effect_unknown" },
              external_action_executed: true,
              provider_receipt_trusted: false,
              cleanup_verified: false,
              reconciliation: { attempted: true, verified: true, replayed: false },
              actions: request.actions.map((action) => ({ method: action.method, result: action.method === "page.query" ? { ok: true, count: 1 } : { ok: true } })),
            }
          : {
              result: "verified",
              external_action_executed: true,
              provider_receipt_trusted: true,
              visual_readback_verified: true,
              cleanup_verified: false,
              cleanup: { session_closed: false, terminal_tab_cleanup: "unknown" },
              reconciliation: { attempted: false, verified: false, replayed: false },
              actions: request.actions.map((action) => ({ method: action.method, result: action.method === "page.query" ? { ok: true, count: 1 } : { ok: true } })),
            };
      },
    };
    const environment = {
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.path,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.sha256,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: authority.id,
    };
    const route = { mode: "authorized", lifecycle: "scheduled", public_lane: false, allowed_origins: [origin] };
    const first = await runAosChromeCompanionWebOperationEffect(input, route, intent, environment, { adapterModule, client: { close() {} } });
    assert.equal(first.status, "blocked");
    assert.equal(first.web_operation_lifecycle.state, "effect_unknown");
    assert.equal(first.web_operation_lifecycle.no_replay, true);
    assert.equal(first.cleanup_verified, false);
    const duplicate = await runAosChromeCompanionWebOperationEffect(input, route, intent, environment, { adapterModule, client: { close() {} } });
    assert.equal(duplicate.exact_blocker, "portable_external_web_operation_duplicate_idempotency_key");
    assert.equal(dispatchCount, 1);
  }
});
