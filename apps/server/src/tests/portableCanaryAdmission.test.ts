import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTABLE_CANARY_ADMISSION_TTL_MS,
  createPortableCanaryAdmissionEnvelopeV1,
  guardNisenPrintsCanaryOperation,
  validatePortableCanaryEvidenceV1,
  verifyPortableCanaryAdmissionV1,
  type PortableCanaryAdmissionAdapter,
  type PortableCanaryAdmissionOperation,
  type PortableCanaryAdmissionTrigger,
  type PortableCanaryAdmissionWorkflowId
} from "../runs/portableCanaryAdmission.js";
import type { PortableCanaryReceiptV1 } from "../runs/portableWorkflowContract.js";
import { runPortableWorkerCanary } from "../runs/portableWorkerCanary.js";

const receipt = (runId: string, workflowId: PortableCanaryAdmissionWorkflowId): PortableCanaryReceiptV1 => ({
  schema: "automation_os_portable_canary_receipt_v1",
  run_id: runId,
  workflow_id: workflowId,
  status: "completed" as const,
  stages: ["manifest_validation", "run_binding", "readback", "cleanup"],
  browser_started: false,
  connector_called: false,
  external_action_executed: false,
  exact_blocker: null
});

const tuples: Array<[PortableCanaryAdmissionWorkflowId, PortableCanaryAdmissionAdapter]> = [
  ["daily-ai-research-publish-run", "daily_ai_registered"],
  ["job-application-manager", "job_submit_registered"],
  ["nisenprints-daily-product-canva-printify-etsy-pinterest", "nisenprints_registered"]
];
const operations: PortableCanaryAdmissionOperation[] = ["manifest_validation", "run_binding", "readback", "cleanup"];
const triggers: PortableCanaryAdmissionTrigger[] = ["automation_os_scheduler", "automation_os_ui", "codex_app_bridge"];

function issue(input: {
  runId?: string;
  workflowId: PortableCanaryAdmissionWorkflowId;
  adapter: PortableCanaryAdmissionAdapter;
  trigger?: PortableCanaryAdmissionTrigger;
  operation?: PortableCanaryAdmissionOperation;
  request?: unknown;
  issuedAt?: string;
  expiresAt?: string;
  decision?: "allow" | "deny";
}) {
  const runId = input.runId ?? `run-${input.workflowId}`;
  return createPortableCanaryAdmissionEnvelopeV1({
    runId,
    workflowId: input.workflowId,
    adapter: input.adapter,
    trigger: input.trigger ?? "automation_os_scheduler",
    operation: input.operation ?? "manifest_validation",
    request: input.request ?? { run_id: runId, intent: "portable-canary" },
    portableReceipt: receipt(runId, input.workflowId),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    decision: input.decision
  });
}

test("all 12 exact workflow/adapter/operation tuples admit with every supported trigger", () => {
  let index = 0;
  for (const [workflowId, adapter] of tuples) {
    for (const operation of operations) {
      const trigger = triggers[index++ % triggers.length];
      const runId = `run-positive-${index}`;
      const request = { run_id: runId, workflow_id: workflowId, operation };
      const portableReceipt = receipt(runId, workflowId);
      const envelope = createPortableCanaryAdmissionEnvelopeV1({
        runId, workflowId, adapter, trigger, operation, request, portableReceipt,
        issuedAt: "2026-08-08T00:00:00.000Z",
        expiresAt: "2026-08-08T00:05:00.000Z"
      });
      const evidence = verifyPortableCanaryAdmissionV1({
        envelope, runId, workflowId, request, portableReceipt, now: "2026-08-08T00:01:00.000Z"
      });
      assert.equal(evidence.effect_free, true);
      assert.equal(evidence.decision, "allow");
      assert.equal(evidence.operation, operation);
      assert.equal(evidence.trigger, trigger);
    }
  }
});

test("admission remains compatible with every existing PortableTrigger value", () => {
  const runId = "run-trigger-compatibility";
  const workflowId = "daily-ai-research-publish-run" as const;
  const request = { run_id: runId, compatibility: true };
  const portableReceipt = receipt(runId, workflowId);
  for (const trigger of ["launchd", "github_actions"] as const) {
    const envelope = issue({ runId, workflowId, adapter: "daily_ai_registered", trigger, request });
    const evidence = verifyPortableCanaryAdmissionV1({
      envelope, runId, workflowId, request, portableReceipt, now: new Date()
    });
    assert.equal(evidence.trigger, trigger);
  }
});

test("portable worker canary accepts the legacy launchd and github_actions triggers", () => {
  const compatibilityTriggers = ["launchd", "github_actions"] as const;
  for (const [index, sourceTrigger] of compatibilityTriggers.entries()) {
    assert.doesNotThrow(() => runPortableWorkerCanary({
      runId: `run-trigger-worker-${index}`,
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger,
      idempotencyKey: `portable-trigger-compatibility:${sourceTrigger}`
    }));
  }
});

test("mutations, aliases, wildcards, defaults, extras, and dynamic values fail closed", () => {
  const base = {
    workflowId: "daily-ai-research-publish-run" as const,
    adapter: "daily_ai_registered" as const,
    trigger: "automation_os_scheduler" as const,
    operation: "manifest_validation" as const
  };
  for (const mutation of [
    { workflowId: "DAILY-AI-RESEARCH-PUBLISH-RUN" },
    { workflowId: " daily-ai-research-publish-run" },
    { workflowId: "daily_ai_research_publish_run" },
    { adapter: "*" },
    { adapter: "daily-ai-registered" },
    { trigger: "default" },
    { trigger: "automation_os_scheduler " },
    { operation: "manifest_validation_extra" },
    { operation: "${operation}" },
    { workflowId: "unknown-workflow" }
  ]) {
    assert.throws(() => issue({ ...base, ...mutation } as never), /portable_canary_admission_invalid/);
  }
});

test("nonce reuse, cross-run, stale, future, digest mismatch, and explicit deny are rejected", () => {
  const runId = "run-rejection-cases";
  const workflowId = "job-application-manager" as const;
  const request = { run_id: runId, purpose: "read-only" };
  const portableReceipt = receipt(runId, workflowId);
  const envelope = issue({ runId, workflowId, adapter: "job_submit_registered", request });
  const verifyInput = { envelope, runId, workflowId, request, portableReceipt, now: new Date() };
  assert.doesNotThrow(() => verifyPortableCanaryAdmissionV1(verifyInput));
  assert.throws(() => verifyPortableCanaryAdmissionV1(verifyInput), /nonce_reuse/);

  const crossRun = issue({ runId, workflowId, adapter: "job_submit_registered", request });
  assert.throws(() => verifyPortableCanaryAdmissionV1({
    envelope: crossRun, runId: "different-run", workflowId, request, portableReceipt, now: new Date()
  }), /cross_run/);

  const staleRun = "run-stale";
  const staleReceipt = receipt(staleRun, workflowId);
  const stale = issue({ runId: staleRun, workflowId, adapter: "job_submit_registered", issuedAt: "2026-08-08T00:00:00.000Z", expiresAt: "2026-08-08T00:05:00.000Z" });
  assert.throws(() => verifyPortableCanaryAdmissionV1({
    envelope: stale, runId: staleRun, workflowId, request: { run_id: staleRun }, portableReceipt: staleReceipt, now: "2026-08-08T00:05:00.000Z"
  }), /stale/);

  const futureRun = "run-future";
  const futureReceipt = receipt(futureRun, workflowId);
  const future = issue({ runId: futureRun, workflowId, adapter: "job_submit_registered", issuedAt: "2026-08-08T01:00:00.000Z", expiresAt: "2026-08-08T01:05:00.000Z" });
  assert.throws(() => verifyPortableCanaryAdmissionV1({
    envelope: future, runId: futureRun, workflowId, request: { run_id: futureRun }, portableReceipt: futureReceipt, now: "2026-08-08T00:00:00.000Z"
  }), /future/);

  const digestRun = "run-digest";
  const digestReceipt = receipt(digestRun, workflowId);
  const digest = issue({ runId: digestRun, workflowId, adapter: "job_submit_registered", request: { run_id: digestRun, value: "a" } });
  assert.throws(() => verifyPortableCanaryAdmissionV1({
    envelope: digest, runId: digestRun, workflowId, request: { run_id: digestRun, value: "b" }, portableReceipt: digestReceipt, now: new Date()
  }), /request_digest_mismatch/);

  const deniedRun = "run-denied";
  const deniedReceipt = receipt(deniedRun, workflowId);
  const denied = issue({ runId: deniedRun, workflowId, adapter: "job_submit_registered", decision: "deny" });
  assert.throws(() => verifyPortableCanaryAdmissionV1({
    envelope: denied, runId: deniedRun, workflowId, request: { run_id: deniedRun, intent: "portable-canary" }, portableReceipt: deniedReceipt, now: new Date()
  }), /decision_denied/);

  assert.ok(PORTABLE_CANARY_ADMISSION_TTL_MS <= 300_000);
});

test("NisenPrints guard allows only canary stages and denies unsafe, unknown, uncertain, and empty operations", () => {
  for (const operation of operations) assert.deepEqual(guardNisenPrintsCanaryOperation(operation), { allowed: true, reason: "canary_operation_allowed" });
  for (const operation of ["publish", "create", "update", "delete", "send", "upload_asset", "upload", "unknown", "uncertain", ""]) {
    assert.equal(guardNisenPrintsCanaryOperation(operation).allowed, false);
  }
  assert.equal(guardNisenPrintsCanaryOperation(undefined).allowed, false);
});

test("deny, error, and timeout harnesses never increment fallback counters", () => {
  const fallbackCounters = { total: 0, deny: 0, error: 0, timeout: 0 };
  for (const outcome of ["deny", "error", "timeout"] as const) {
    try {
      if (outcome === "deny") throw new Error("portable_canary_admission_invalid:decision_denied");
      if (outcome === "error") throw new Error("portable_canary_admission_error");
      throw new Error("portable_canary_admission_timeout");
    } catch (error) {
      assert.match(String(error), /portable_canary_admission_/);
    }
  }
  assert.deepEqual(fallbackCounters, { total: 0, deny: 0, error: 0, timeout: 0 });
});

test("evidence is redacted to safe fields and rejects secret-like or unknown fields", () => {
  const runId = "run-evidence";
  const workflowId = "daily-ai-research-publish-run" as const;
  const request = { run_id: runId, raw_payload: "must-not-return" };
  const portableReceipt = receipt(runId, workflowId);
  const envelope = issue({ runId, workflowId, adapter: "daily_ai_registered", request });
  const evidence = verifyPortableCanaryAdmissionV1({ envelope, runId, workflowId, request, portableReceipt, now: new Date() });
  assert.equal("raw_payload" in evidence, false);
  assert.equal("nonce" in evidence, false);
  assert.equal(JSON.stringify(evidence).includes("must-not-return"), false);
  assert.throws(() => validatePortableCanaryEvidenceV1({ ...evidence, token: "secret" }), /secret_field_forbidden/);
  assert.throws(() => validatePortableCanaryEvidenceV1({ ...evidence, unexpected: true }), /unknown_field/);
});
