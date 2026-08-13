import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  runPortableExternalWorker,
  PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED,
  PORTABLE_EXTERNAL_APPROVAL_REQUIRED,
  PORTABLE_EXTERNAL_LEGACY_RUNNER_FORBIDDEN
} from "../runs/portableExternalWorker.js";
import { portableExternalRunnerConfigured, resolvePortableExternalRunner } from "../runs/portableExternalRunnerConfig.js";
import { issuePortableExternalEffectAuthorityV1, validatePortableExternalEffectAuthorityV1 } from "../runs/portableExternalEffectAuthority.js";

test("portable external effect authority requires a concrete payload hash", () => {
  const base = {
    companyId: "company-authority-payload",
    workflowId: "job-application-manager",
    runId: "run-authority-payload",
    stepId: "step-authority-payload",
    effectStage: "one_candidate_submit",
    approvalId: "approval-authority-payload",
    idempotencyKey: "authority-payload",
    targetDigest: "a".repeat(64),
    inputBundleSha256: "b".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.throws(
    () => issuePortableExternalEffectAuthorityV1({ ...base, payloadHash: null as unknown as string }),
    /portable_effect_authority_payload_hash_invalid/u,
  );
  const authority = issuePortableExternalEffectAuthorityV1({ ...base, payloadHash: "c".repeat(64) });
  assert.throws(
    () => validatePortableExternalEffectAuthorityV1({ ...authority, payload_hash: null }, undefined, Date.now()),
    /portable_effect_authority_payload_hash_invalid/u,
  );
});

test("portable external runner defaults to the AOS-owned Browser Use CLI entrypoint", () => {
  const environment = {} as NodeJS.ProcessEnv;
  assert.match(resolvePortableExternalRunner(environment), /scripts\/aos-portable-browser-use-runner\.mjs$/u);
  assert.equal(portableExternalRunnerConfigured(environment), true);
});

test("portable external runner switches to the AOS-owned business entrypoint only when effects are enabled", () => {
  const environment = { AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled" } as NodeJS.ProcessEnv;
  assert.match(resolvePortableExternalRunner(environment), /scripts\/aos-portable-business-runner\.mjs$/u);
  assert.equal(portableExternalRunnerConfigured(environment), true);
});

test("portable external timeout terminates the owned descendant process group and records cleanup proof", async () => {
  const previous = {
    runner: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER,
    timeout: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS,
    artifactRoot: process.env.AUTOMATION_OS_ARTIFACT_ROOT,
  };
  const root = mkdtempSync(join(tmpdir(), "automation-os-process-group-timeout-"));
  const pidPath = join(root, "descendant.pid");
  const runner = join(root, "timeout-runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
setInterval(() => {}, 60000);
`, { mode: 0o700 });
  chmodSync(runner, 0o700);
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = runner;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS = "10000";
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = root;
  let descendantPid: number | null = null;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "daily-ai-research-publish-run",
      runId: "run_process_group_timeout",
      stepId: "step_process_group_timeout",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "process-group-timeout",
      approvalGranted: true
    });
    descendantPid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(result.exactBlocker, "portable_external_worker_timeout");
    assert.equal(result.externalActionExecuted, false);
    assert.equal(result.processGroupCleanup?.attempted, true);
    assert.equal(result.processGroupCleanup?.verified, true);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(descendantPid, 0);
        await delay(25);
      } catch {
        break;
      }
    }
    assert.throws(() => process.kill(descendantPid!, 0));
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* fixture already exited */ }
    }
    if (previous.runner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous.runner;
    if (previous.timeout === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS = previous.timeout;
    if (previous.artifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previous.artifactRoot;
  }
});

test("generic Web effect intent crosses the worker boundary as enabled only with target authority", async () => {
  const previous = {
    runner: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER,
    effects: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS,
    approval: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL,
    artifactRoot: process.env.AUTOMATION_OS_ARTIFACT_ROOT,
  };
  const root = mkdtempSync(join(tmpdir(), "automation-os-generic-web-effect-worker-"));
  const runner = join(root, "fixture-runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
import fs from 'node:fs';
const intent = JSON.parse(fs.readFileSync(process.env.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH, 'utf8'));
console.log(JSON.stringify({status:'blocked', exact_blocker:'fixture_effect_mode:' + process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS + ':' + intent.operation, external_action_executed:false, browser_surface:'browser_use_cli'}));
`, { mode: 0o700 });
  chmodSync(runner, 0o700);
  const authority = issuePortableExternalEffectAuthorityV1({
    companyId: "company-generic-web",
    workflowId: "daily-ai-research-publish-run",
    runId: "run-generic-web-effect-worker",
    stepId: "step-generic-web-effect-worker",
    effectStage: "web_operation_effect",
    approvalId: "approval-generic-web-effect-worker",
    idempotencyKey: "generic-web-effect-worker",
    targetDigest: "b".repeat(64),
    inputBundleSha256: "d".repeat(64),
    payloadHash: "a".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = runner;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "read_only";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = "approved";
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = root;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "daily-ai-research-publish-run",
      runId: authority.run_id,
      stepId: authority.step_id,
      sourceTrigger: "automation_os_ui",
      idempotencyKey: authority.idempotency_key,
      approvalGranted: true,
      effectAuthority: authority,
      webOperationIntent: {
        schema: "automation_os_web_operation_intent.v1",
        browser_surface: "browser_use_cli",
        operation: "publish",
        account_ref: "generic-web-account",
        allowed_origins: ["https://example.com"],
        entry_url: "https://example.com/",
        target: { semantic_query: "Publish" },
        target_binding: { target_digest: "b".repeat(64), source_state_digest: "c".repeat(64) },
        action_plan: {
          schema: "automation_os_web_operation_action_plan.v1",
          steps: [{ action: "click_target", target: { semantic_query: "Publish" } }],
          payload: {},
          payload_hash: "a".repeat(64),
          readback: { semantic_query: "Published", expected: "present" },
        },
        payload_hash: "a".repeat(64),
        approval_status: "pending",
        authority_sha256: null,
        readback_required: true,
        no_replay: true,
      },
    });
    assert.equal(result.exactBlocker, "fixture_effect_mode:enabled:publish");
    assert.equal(result.externalActionExecuted, false);
    assert.ok(result.webOperationIntentPath && existsSync(result.webOperationIntentPath));
    const persisted = JSON.parse(readFileSync(result.webOperationIntentPath!, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.operation, "publish");
    assert.equal(persisted.approval_status, "approved");
    assert.match(String(persisted.authority_sha256 || ""), /^[a-f0-9]{64}$/u);
  } finally {
    if (previous.runner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous.runner;
    if (previous.effects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previous.effects;
    if (previous.approval === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = previous.approval;
    if (previous.artifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previous.artifactRoot;
  }
});

test("effects-enabled generic worker stops before runner binding when portable authority is absent", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const previousArtifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "enabled";
  delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = mkdtempSync(join(tmpdir(), "automation-os-business-runner-"));
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_business_binding_pending",
      stepId: "run_external_business_binding_pending_step_1",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "external-business-binding-pending",
      approvalGranted: true
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, "portable_external_effect_authority_missing");
    assert.equal(result.externalActionExecuted, false);
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
    if (previousArtifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previousArtifactRoot;
  }
});

test("local portable worker forwards an immutable target-bound effect authority to the child runner", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const previousApproval = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
  const previousArtifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  const root = mkdtempSync(join(tmpdir(), "automation-os-effect-authority-forwarding-"));
  const artifactRoot = join(root, "artifacts");
  const runner = join(root, "runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node\nconsole.log(JSON.stringify({status:"blocked",exact_blocker:"fixture_no_browser_dispatch",external_action_executed:false,browser_surface:"browser_use_cli"}));\n`, { mode: 0o700 });
  chmodSync(runner, 0o700);
  const authority = issuePortableExternalEffectAuthorityV1({
    companyId: "company-test",
    workflowId: "job-application-manager",
    runId: "run_effect_authority_forwarding",
    stepId: "step_effect_authority_forwarding",
    effectStage: "one_candidate_submit",
    approvalId: "approval_effect_authority_forwarding",
    idempotencyKey: "effect-authority-forwarding",
    targetDigest: "a".repeat(64),
    inputBundleSha256: "b".repeat(64),
    payloadHash: "c".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = runner;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "enabled";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = "approved";
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: authority.run_id,
      stepId: authority.step_id,
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: authority.idempotency_key,
      approvalGranted: true,
      effectAuthority: authority
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, "fixture_no_browser_dispatch");
    assert.equal(result.externalActionExecuted, false);
    const authorityPath = join(artifactRoot, authority.run_id, "portable-effect-authority.v1.json");
    assert.equal(statSync(authorityPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(authorityPath, "utf8")), authority);
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
    if (previousApproval === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = previousApproval;
    if (previousArtifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previousArtifactRoot;
  }
});

test("AOS generic worker cannot reach the Job Browser Use CLI submit boundary without portable authority", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const previousApproval = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
  const previousBusinessRunner = process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION;
  const previousNoLaunch = process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH;
  const previousArtifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  const artifactRoot = mkdtempSync(join(tmpdir(), "automation-os-job-submit-preflight-"));
  const runId = "run_job_submit_preflight_no_launch";
  const runRoot = join(artifactRoot, runId);
  const bundlePath = join(runRoot, "portable-input-bundle.v1.json");
  const businessRunner = "/Users/nichikatanaka/Documents/New project/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs";
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: {
      job_url: "https://www.linkedin.com/jobs/view/4405084150/",
      application_url: "https://www.linkedin.com/jobs/view/4405084150/",
      candidate_key: "opp-submit-preflight",
      bucket: "japan_targeted",
      sequence: 1,
      attempt: 1,
      source_snapshot_id: "snapshot-submit-preflight",
      supply_run_id: "supply-submit-preflight",
      company: "",
      role: "LinkedIn job opening",
    },
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "enabled";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = "approved";
  process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION = businessRunner;
  process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH = "1";
  delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId,
      stepId: "job_candidate_submit_preflight",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: runId,
      approvalGranted: true,
      inputBundlePath: bundlePath,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, "portable_external_effect_authority_missing");
    assert.equal(result.externalActionExecuted, false);
    assert.equal(result.response?.browser_surface, "browser_use_cli");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
    if (previousApproval === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = previousApproval;
    if (previousBusinessRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION;
    else process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION = previousBusinessRunner;
    if (previousNoLaunch === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH;
    else process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH = previousNoLaunch;
    if (previousArtifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previousArtifactRoot;
  }
});

test("AOS generic worker cannot reach Daily AI or NisenPrints Browser Use without portable authority", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const previousApproval = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
  const previousDailyRunner = process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI;
  const previousNisenRunner = process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS;
  const previousNoLaunch = process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH;
  const previousArtifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  const artifactRoot = mkdtempSync(join(tmpdir(), "automation-os-workflow-boundaries-preflight-"));
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "enabled";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = "approved";
  process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI = join(process.cwd(), "scripts", "aos-daily-ai-business-runner.mjs");
  process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS = join(process.cwd(), "scripts", "aos-nisenprints-business-runner.mjs");
  process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH = "1";
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;
  delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  try {
    const cases = [
      { workflowId: "daily-ai-research-publish-run", exactBlocker: "daily_ai_browser_use_cli_no_launch_canary" },
      { workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest", exactBlocker: "nisenprints_browser_use_cli_no_launch_canary" },
    ];
    for (const current of cases) {
      const runId = `run_${current.workflowId.replaceAll("-", "_")}_no_launch`;
      const result = await runPortableExternalWorker({
        workflowId: current.workflowId,
        runId,
        stepId: "workflow_business_preflight",
        sourceTrigger: "automation_os_scheduler",
        idempotencyKey: runId,
        approvalGranted: true,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.exactBlocker, "portable_external_effect_authority_missing");
      assert.equal(result.externalActionExecuted, false);
      assert.equal(result.response?.browser_surface, "browser_use_cli");
    }
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
    if (previousApproval === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = previousApproval;
    if (previousDailyRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI;
    else process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI = previousDailyRunner;
    if (previousNisenRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS;
    else process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS = previousNisenRunner;
    if (previousNoLaunch === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH;
    else process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH = previousNoLaunch;
    if (previousArtifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previousArtifactRoot;
  }
});

test("portable external worker fails closed when an explicit empty adapter disables the default", async () => {
  const previous = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = "";
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_test",
      stepId: "run_external_worker_test_step_1",
      sourceTrigger: "codex_app_bridge",
      idempotencyKey: "external-worker-test",
      approvalGranted: true
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED);
    assert.equal(result.externalActionExecuted, false);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous;
  }
});

test("portable external worker requires approval before spawning the adapter", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const previousArtifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  const root = mkdtempSync(join(tmpdir(), "automation-os-external-approval-"));
  const artifactRoot = join(root, "artifacts");
  const marker = join(root, "spawned.marker");
  const runner = join(root, "runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\nconsole.log(JSON.stringify({status:"complete",exact_blocker:null,external_action_executed:true}));\n`);
  chmodSync(runner, 0o700);
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = runner;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "enabled";
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;
  try {
    const blocked = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_approval_required",
      stepId: "run_external_worker_approval_required_step_1",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "external-worker-approval-required",
      approvalGranted: false
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.exactBlocker, PORTABLE_EXTERNAL_APPROVAL_REQUIRED);
    assert.equal(blocked.externalActionExecuted, false);
    assert.throws(() => readFileSync(marker, "utf8"));

    const approved = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_approval_granted",
      stepId: "run_external_worker_approval_granted_step_1",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "external-worker-approval-granted",
      approvalGranted: true
    });
    assert.equal(approved.status, "complete");
    assert.equal(approved.externalActionExecuted, true);
    assert.equal(readFileSync(marker, "utf8"), "spawned");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
    if (previousArtifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previousArtifactRoot;
  }
});

test("portable external worker refuses the historical Codex delegation runner", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = join(process.cwd(), "scripts", "portable-external-runner.mjs");
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_legacy_runner",
      stepId: "run_external_worker_legacy_runner_step_1",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "external-worker-legacy-runner",
      approvalGranted: true
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, PORTABLE_EXTERNAL_LEGACY_RUNNER_FORBIDDEN);
    assert.equal(result.externalActionExecuted, false);
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
  }
});

test("live adaptive public Web readback uses a fresh single-use profile and terminal cleanup", { skip: process.env.AOS_LIVE_ADAPTIVE_E2E !== "1" }, async () => {
  const previous = {
    runner: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER,
    effects: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS,
    approval: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL,
    artifactRoot: process.env.AUTOMATION_OS_ARTIFACT_ROOT,
  };
  const artifactRoot = mkdtempSync(join(tmpdir(), "automation-os-adaptive-public-live-"));
  const runId = `run_adaptive_public_live_example_${process.pid}_${Date.now()}`;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "read_only";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = "approved";
  delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "daily-ai-research-publish-run",
      runId,
      stepId: "adaptive_public_readback",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "adaptive-public-live-example",
      approvalGranted: true,
      readOnlyStage: "web_operation_read",
      webOperationIntent: {
        schema: "automation_os_web_operation_intent.v1",
        browser_surface: "browser_use_cli",
        operation: "read",
        account_ref: "public",
        allowed_origins: ["https://example.com"],
        entry_url: "https://example.com/",
        target: { semantic_query: "Example Domain" },
        payload_hash: null,
        approval_status: "not_required",
        authority_sha256: null,
        readback_required: true,
        no_replay: true,
      },
    });
    assert.equal(result.externalActionExecuted, false);
    assert.equal(result.response?.generic_web_operation, true);
    assert.equal(result.response?.effects_mode, "read_only");
    assert.equal(result.response?.cleanup_verified, true);
    assert.equal(result.response?.semantic_target_readback_verified, true);
    assert.equal(result.response?.status, "complete");
    assert.ok(result.webOperationIntentPath && existsSync(result.webOperationIntentPath));
    assert.equal(statSync(result.webOperationIntentPath!).mode & 0o777, 0o600);
    const persisted = JSON.parse(readFileSync(result.webOperationIntentPath!, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.run_id, runId);
    assert.equal(persisted.workflow_id, "daily-ai-research-publish-run");
    assert.equal(persisted.source_trigger, "automation_os_ui");
    assert.equal(persisted.account_ref, "public");
  } finally {
    if (previous.runner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous.runner;
    if (previous.effects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previous.effects;
    if (previous.approval === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = previous.approval;
    if (previous.artifactRoot === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
    else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previous.artifactRoot;
  }
});
