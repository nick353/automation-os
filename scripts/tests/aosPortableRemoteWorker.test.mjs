import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { bindBusinessReceiptToClaim, createAdmission, createEffectAuthorityFile, effectAuthorityFromClaim, mergePortableRemoteWorkerStatus, portableRemoteErrorCode, portableRemoteHttpTimeoutMs, requestPortableRemoteJson, shouldEmitPortableRemoteResult } from "../aos-portable-remote-worker.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runWorker(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/aos-portable-remote-worker.mjs", ...args], {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("local setup collision is reported once as a no-effect portable receipt", async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-test-"));
  const runId = "run_remote_setup_collision_regression";
  const stepId = `${runId}_step_1`;
  const idempotencyKey = "portable-remote-setup-collision-regression";
  const admissionName = `portable-external-admission-${sha256(`${runId}:${stepId}:${idempotencyKey}`).slice(0, 24)}.json`;
  const runRoot = join(artifactRoot, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(runRoot, admissionName), "{}\n", { mode: 0o600 });

  const claim = {
    run_id: runId,
    company_id: "company_remote_setup_collision_regression",
    workflow_id: "job-application-manager",
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: idempotencyKey,
    read_only_stage: "candidate_supply",
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    input_bundle: {
      source_snapshot_id: "snapshot-remote-setup-collision-regression",
      supply_run_id: "supply-remote-setup-collision-regression",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
    input_bundle_sha256: null,
    target_digest: null,
    worker_id: "mac-remote-setup-collision-regression",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    external_action_executed: false,
    browser_surface: "browser_use_cli",
  };
  let receiptBody = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/portable-worker/claim") {
      response.end(JSON.stringify({ ok: true, claimed: true, external_action_executed: false, run: claim }));
      return;
    }
    if (request.url === `/api/portable-worker/${runId}/receipt`) {
      receiptBody = JSON.parse(body);
      response.end(JSON.stringify({ ok: true, replayed: false, receipt: receiptBody.receipt, artifact_uri: "file:///redacted/receipt.json", external_action_executed: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runWorker({
      AUTOMATION_OS_PORTABLE_REMOTE_TOKEN: "test-token-not-logged",
      AUTOMATION_OS_PORTABLE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: claim.company_id,
      AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: claim.worker_id,
      AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT: artifactRoot,
    }, ["--once"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output, {
      status: "blocked",
      run_id: runId,
      workflow_id: claim.workflow_id,
      step_id: stepId,
      exact_blocker: "portable_remote_immutable_collision",
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      cleanup_verified: false,
      readback_verified: false,
      remote_replayed: false,
      child_exit_code: null,
      child_signal: null,
    });
    assert.equal(receiptBody?.receipt?.exact_blocker, "portable_remote_immutable_collision");
    assert.equal(receiptBody?.receipt?.external_action_executed, false);
    assert.equal(receiptBody?.receipt?.effects_mode, "read_only");
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("resident remote worker dispatches registered local workflows to the Mac local adapter", async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "aos-portable-local-worker-test-"));
  const runId = "run_remote_local_workflow_regression";
  const stepId = `${runId}_step_1`;
  const claim = {
    run_id: runId,
    company_id: "company_remote_local_workflow_regression",
    workflow_id: "daily-backup-safety-check",
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: "portable-remote-local-workflow-regression",
    read_only_stage: "reference_readback",
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    input_bundle: null,
    input_bundle_sha256: null,
    target_digest: null,
    worker_id: "mac-remote-local-workflow-regression",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    external_action_executed: false,
    browser_surface: "browser_use_cli",
  };
  let receiptBody = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/portable-worker/claim") {
      response.end(JSON.stringify({ ok: true, claimed: true, external_action_executed: false, run: claim }));
      return;
    }
    if (request.url === `/api/portable-worker/${runId}/receipt`) {
      receiptBody = JSON.parse(body);
      response.end(JSON.stringify({ ok: true, replayed: false, receipt: receiptBody.receipt, artifact_uri: "file:///redacted/receipt.json", external_action_executed: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runWorker({
      AUTOMATION_OS_PORTABLE_REMOTE_TOKEN: "test-token-not-logged",
      AUTOMATION_OS_PORTABLE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: claim.company_id,
      AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: claim.worker_id,
      AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT: artifactRoot,
      AUTOMATION_OS_WORKER_ROLE: "mac",
    }, ["--once"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.workflow_id, claim.workflow_id);
    assert.ok(["local_backup_runner_missing", "local_backup_effect_requires_explicit_approval"].includes(output.exact_blocker));
    assert.equal(output.external_action_executed, false);
    assert.equal(output.browser_surface, "browser_use_cli");
    assert.equal(receiptBody?.receipt?.browser_surface, "browser_use_cli");
    assert.equal(receiptBody?.receipt?.adapter_result?.execution_surface, "mac_local_worker");
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("resident worker suppresses idle poll receipts while once mode remains observable", () => {
  assert.equal(shouldEmitPortableRemoteResult({ status: "idle" }, { logIdle: false }), false);
  assert.equal(shouldEmitPortableRemoteResult({ status: "idle" }, { logIdle: true }), true);
  assert.equal(shouldEmitPortableRemoteResult({ status: "idle" }, { force: true, logIdle: false }), true);
  assert.equal(shouldEmitPortableRemoteResult({ status: "blocked" }, { logIdle: false }), true);
});

test("remote HTTP requests are bounded and convert an abort into an exact blocker", async () => {
  assert.equal(portableRemoteHttpTimeoutMs(0), 1_000);
  assert.equal(portableRemoteHttpTimeoutMs(999_999), 120_000);
  assert.equal(portableRemoteHttpTimeoutMs("invalid"), 15_000);
  const server = createServer((_request, _response) => {
    // Deliberately never complete this response; the worker must not hang.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      requestPortableRemoteJson(`http://127.0.0.1:${address.port}/heartbeat`, "test-token-not-logged", {}, { timeoutMs: 1_000 }),
      (error) => error instanceof Error && error.message === "portable_remote_http_timeout"
    );
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("remote worker status classification never exposes transport error text", () => {
  assert.equal(portableRemoteErrorCode(new Error("portable_remote_http_timeout")), "portable_remote_http_timeout");
  assert.equal(portableRemoteErrorCode(new Error("portable_remote_http_401")), "portable_remote_http_401");
  assert.equal(portableRemoteErrorCode(new Error("fetch failed with token=secret")), "portable_remote_http_failed");
});

test("heartbeat status updates preserve the latest claim state", () => {
  const merged = mergePortableRemoteWorkerStatus({
    claim_status: "idle",
    last_claim_at: "2026-08-11T11:11:05.344Z",
    heartbeat_status: "ok",
  }, {
    status: "heartbeat_ok",
    heartbeat_status: "ok",
    last_successful_heartbeat_at: "2026-08-11T11:11:06.001Z",
  });
  assert.equal(merged.claim_status, "idle");
  assert.equal(merged.last_claim_at, "2026-08-11T11:11:05.344Z");
  assert.equal(merged.last_successful_heartbeat_at, "2026-08-11T11:11:06.001Z");
});

test("same portable worker claim reuses a valid admission instead of rewriting its time-bound receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-admission-reuse-"));
  const claim = {
    run_id: "run_remote_admission_reuse_regression",
    company_id: "company_remote_admission_reuse_regression",
    workflow_id: "job-application-manager",
    step_id: "run_remote_admission_reuse_regression_step_1",
    source_trigger: "automation_os_scheduler",
    idempotency_key: "portable-remote-admission-reuse-regression",
    read_only_stage: "candidate_supply",
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    input_bundle: null,
    input_bundle_sha256: null,
    target_digest: null,
    worker_id: "mac-remote-admission-reuse-regression",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    external_action_executed: false,
    browser_surface: "browser_use_cli",
  };

  const first = createAdmission(claim, root);
  const second = createAdmission(claim, root);
  assert.equal(second.path, first.path);
  assert.equal(second.sha256, first.sha256);
});

test("portable effect authority is normalized from the claim and materialized for the child runner", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-authority-handoff-"));
  const runId = "run_remote_authority_handoff_regression";
  const stepId = `${runId}_step_1`;
  const authorityInputs = {
    company_id: "company_remote_authority_handoff_regression",
    workflow_id: "job-application-manager",
    run_id: runId,
    step_id: stepId,
    effect_stage: "one_candidate_submit",
    approval_id: "approval_remote_authority_handoff_regression",
    idempotency_key: "portable-remote-authority-handoff-regression",
    target_digest: "a".repeat(64),
    input_bundle_sha256: "b".repeat(64),
  };
  const authority = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: `portable-effect-${sha256([
      authorityInputs.company_id,
      authorityInputs.workflow_id,
      authorityInputs.run_id,
      authorityInputs.step_id,
      authorityInputs.effect_stage,
      authorityInputs.approval_id,
      authorityInputs.idempotency_key,
      authorityInputs.target_digest,
      authorityInputs.input_bundle_sha256,
    ].join("\u001f")).slice(0, 32)}`,
    issued_by: "automation_os_portable_controller",
    ...authorityInputs,
    effect_class: "external_non_idempotent",
    approval_status: "approved",
    external_action_authorized: true,
    first_class_root_required: false,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  const claim = {
    ...authorityInputs,
    execution_mode: "business_effect",
    portable_effect_authority: authority,
  };

  assert.equal(effectAuthorityFromClaim(claim), authority);
  const materialized = createEffectAuthorityFile(claim, root);
  assert.ok(materialized);
  assert.equal(existsSync(materialized.path), true);
  assert.equal(readFileSync(materialized.path, "utf8"), `${JSON.stringify(authority, null, 2)}\n`);
  assert.equal(materialized.sha256, sha256(readFileSync(materialized.path)));
});

test("business receipt is bound to the current AOS target-bound approval receipt", () => {
  const approvalReceipt = {
    schema: "automation_os_portable_target_bound_approval_receipt.v1",
    approval_id: "approval_receipt_handoff_regression",
    approval_status: "approved",
    binding_sha256: "c".repeat(64),
    binding: {
      schema: "automation_os_portable_external_approval_binding.v1",
      company_id: "company_receipt_handoff_regression",
      workflow_id: "job-application-manager",
      run_id: "run_receipt_handoff_regression",
      step_id: "run_receipt_handoff_regression_step_1",
      effect_stage: "one_candidate_submit",
      idempotency_key: "receipt-handoff-regression",
      input_bundle_sha256: "d".repeat(64),
      target_digest: "e".repeat(64),
      binding_sha256: "c".repeat(64),
    },
  };
  const claim = { execution_mode: "business_effect", approval_receipt: approvalReceipt };
  const childReceipt = { status: "complete", external_action_executed: true, approval_receipt: null };
  const bound = bindBusinessReceiptToClaim(claim, childReceipt);
  assert.equal(bound.approval_receipt, approvalReceipt);
  assert.equal(bound.external_action_executed, true);
  assert.equal(bindBusinessReceiptToClaim({ execution_mode: "read_only" }, childReceipt), childReceipt);
});
