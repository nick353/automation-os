import { createHash } from "node:crypto";
import { constants as fsConstants, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dbBackend, dbPath, initDb, insert, nowIso, querySql, resetDemoData, sqlValue } from "../db/client.js";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshRegisteredWorkflows } from "../registeredWorkflows.js";
import { resolveWorkerAdapterPolicy, runWorkerOnce, startCommandRun, type WorkerAdapter } from "./workerEngine.js";
import { BROWSER_USE_CLI_REQUIRED_BLOCKER } from "./workerEngine.js";
import {
  projectReferenceWorkflowAdmission,
  type ReferenceWorkflowAdmissionProjectionV1
} from "../serviceReadiness/referenceWorkflowAdmission.js";
import {
  assertServiceReadinessRuntimeBindingMatches,
  deriveServiceReadinessRootId,
  referenceWorkflowIdFromMetadata,
  validateServiceReadinessRuntimeBindingV1
} from "../serviceReadiness/runtimeBinding.js";
import {
  assertServiceReadinessCleanupReceiptMatches,
  buildServiceReadinessCleanupReceiptV1,
  hashServiceReadinessCleanupReceiptV1,
  validateServiceReadinessCleanupReceiptV1,
  type ServiceReadinessCleanupReceiptV1
} from "../serviceReadiness/cleanupReceipt.js";

export const referenceWorkflowCanarySchema = "automation_os_reference_workflow_canary.v2";

type ReferenceDefinition = {
  id: string;
  adapterWorkflowId: "daily-ai" | "job-application-manager" | "nisenprints";
  adapter: WorkerAdapter;
  command: string;
  exitStatusKey: string;
};

const references: readonly ReferenceDefinition[] = [
  {
    id: "daily-ai-research-publish-run",
    adapterWorkflowId: "daily-ai",
    adapter: "daily_ai_registered",
    command: "Daily AI registered workflow run full flow",
    exitStatusKey: "daily_ai_exit_status"
  },
  {
    id: "job-application-manager",
    adapterWorkflowId: "job-application-manager",
    adapter: "job_submit_registered",
    command: "Job Application Manager registered workflow billing-only inbox readback and submit",
    exitStatusKey: "registered_codex_exit_status"
  },
  {
    id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    adapterWorkflowId: "nisenprints",
    adapter: "nisenprints_registered",
    command: "NisenPrints registered workflow billing-only proof gate full publish",
    exitStatusKey: "nisenprints_exit_status"
  }
] as const;

export type ReferenceWorkflowCanaryPath = {
  id: string;
  adapter: string;
  run_id: string;
  status: "proof_backed_safe_stop_verified" | "failed";
  exact_blocker: string | null;
  run_blocked: boolean;
  step_blocked: boolean;
  proof_gate_ok: boolean;
  runner_exit_status: number | null;
  runner_started: boolean;
  runner_completed: boolean;
  external_action_executed: boolean;
  idempotent_recheck: boolean;
  approval_boundary_verified: boolean;
  company_scope_verified: boolean;
  start_lineage_verified: boolean;
  worker_blocked_event_verified: boolean;
  safety_proof_verified: boolean;
  runtime_binding_verified: boolean;
  cleanup_receipt_verified: boolean;
  cleanup_receipt_sha256: string | null;
  completion_claimed: false;
  operation_proof_gate_ok: false;
  definition_fingerprint: string;
  schedule_fingerprint: string;
  reference_workflow_admission: ReferenceWorkflowAdmissionProjectionV1;
};

export type ReferenceWorkflowCanaryReceipt = {
  schema: typeof referenceWorkflowCanarySchema;
  generated_at: string;
  ok: boolean;
  safety_reference_paths_ok: boolean;
  reference_paths_complete: false;
  external_action_executed: false;
  mode: "isolated_sqlite_proof_backed_safe_stop_canary";
  scope: {
    database: "ephemeral_tmp";
    artifacts: "ephemeral_tmp";
    approval_model: "billing_only_no_start_approval";
  };
  paths: ReferenceWorkflowCanaryPath[];
};

export async function runReferenceWorkflowCanary(): Promise<ReferenceWorkflowCanaryReceipt> {
  if (dbBackend !== "sqlite") {
    throw new Error("reference_workflow_canary_requires_isolated_sqlite");
  }
  if (!process.env.AUTOMATION_OS_DB?.trim()) {
    throw new Error("reference_workflow_canary_db_required");
  }
  if (!process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim()) {
    throw new Error("reference_workflow_canary_artifact_root_required");
  }
  if (resolve(process.env.AUTOMATION_OS_DB) !== resolve(dbPath)) {
    throw new Error("reference_workflow_canary_database_binding_mismatch");
  }
  if (!isTempOwnedPath(dbPath) || !isTempOwnedPath(process.env.AUTOMATION_OS_ARTIFACT_ROOT)) {
    throw new Error("reference_workflow_canary_isolated_temp_paths_required");
  }
  if (existsSync(resolve(dbPath))) {
    throw new Error("reference_workflow_canary_fresh_database_required");
  }
  const canonicalDatabasePath = resolveThroughExistingAncestor(dbPath);
  const canonicalArtifactRoot = resolveThroughExistingAncestor(process.env.AUTOMATION_OS_ARTIFACT_ROOT);

  initDb();
  resetDemoData();
  const canaryIdentity = seedReferenceCanaryCompany();
  const registered = refreshRegisteredWorkflows();
  const paths: ReferenceWorkflowCanaryPath[] = [];

  for (const reference of references) {
    const registration = registered.find((row) => row.id === reference.id);
    const registeredCommand = parseRecord(parseJson(registration?.start_command_json)).command;
    const registeredSchedule = parseRecord(parseJson(registration?.schedule_json));
    const definitionFingerprint = sha256Json({
      id: registration?.id ?? null,
      status: registration?.status ?? null,
      runner_kind: registration?.runner_kind ?? null,
      start_command_json: registration?.start_command_json ?? null,
      source_refs_json: registration?.source_refs_json ?? null,
      provenance_json: registration?.provenance_json ?? null
    });
    const scheduleFingerprint = sha256Json({ schedule_json: registration?.schedule_json ?? null });
    const dueKey = `reference-canary:${reference.id}:${scheduleFingerprint.slice(0, 16)}`;
    const startLineage = {
      workflow_id: reference.id,
      source: "reference_workflow_canary",
      due_key: dueKey,
      definition_fingerprint: definitionFingerprint,
      schedule_fingerprint: scheduleFingerprint,
      actor_user_id: canaryIdentity.actorUserId,
      company_id: canaryIdentity.companyId
    };
    const policy = resolveWorkerAdapterPolicy(reference.adapter);
    const referenceWorkflowAdmission = projectReferenceWorkflowAdmission({ workflow_id: reference.adapterWorkflowId });
    const registrationOk = Boolean(
      registration &&
        registration.status === "active" &&
        registration.runner_kind === reference.adapter &&
        registeredCommand === reference.command &&
        registeredSchedule.kind === "cron" &&
        typeof registeredSchedule.rrule === "string" &&
        registeredSchedule.rrule.trim() !== "" &&
        policy.classification === "browser_use_cli" &&
        policy.evidence.includes("surface:browser_use_cli") &&
        policy.evidence.includes("no_fallback:true")
    );
    if (!registrationOk) {
      throw new Error(`reference_workflow_canary_precondition_failed:${reference.id}`);
    }
    assertCanaryRuntimeBindings(canonicalDatabasePath, canonicalArtifactRoot);
    const summary = await startCommandRun(reference.command, {
      deferWorker: true,
      companyId: canaryIdentity.companyId,
      referenceWorkflowCanary: true,
      metadata: {
        reference_workflow_canary: true,
        registeredWorkflowId: reference.id,
        registered_workflow_id: reference.id,
        registered_workflow_start: startLineage,
        reference_workflow_admission: referenceWorkflowAdmission,
        external_action_executed: false
      }
    });
    const runId = String(summary.runId ?? "");
    const pendingApprovals = querySql<{ id: string; status: string }>(
      `SELECT id, status FROM approvals WHERE run_id=${sqlValue(runId)} ORDER BY id ASC`
    );
    const queuedRun = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
    const queuedPlan = parseRecord(parseObject(queuedRun?.metadata_json).plan);
    const approvalBoundaryVerified = pendingApprovals.length === 0 && queuedPlan.approvalRequired === false;
    assertCanaryRuntimeBindings(canonicalDatabasePath, canonicalArtifactRoot);
    await runWorkerOnce(runId);
    assertCanaryRuntimeBindings(canonicalDatabasePath, canonicalArtifactRoot);
    const preCleanupState = readCanaryState(runId, reference.exitStatusKey, {
      ...canaryIdentity,
      workflowId: reference.id,
      adapter: reference.adapter,
      definitionFingerprint,
      scheduleFingerprint,
      dueKey,
      artifactRoot: canonicalArtifactRoot
    });
    const cleanupReceipt = writeCanaryCleanupReceipt({
      artifactRoot: canonicalArtifactRoot,
      runId,
      stepId: preCleanupState.stepId,
      rootId: deriveServiceReadinessRootId(runId),
      workflowId: reference.adapterWorkflowId,
      attemptId: preCleanupState.attemptId,
      fencingToken: preCleanupState.fencingToken
    });
    const before = readCanaryState(runId, reference.exitStatusKey, {
      ...canaryIdentity,
      workflowId: reference.id,
      adapter: reference.adapter,
      definitionFingerprint,
      scheduleFingerprint,
      dueKey,
      artifactRoot: canonicalArtifactRoot
    });
    await runWorkerOnce(runId);
    assertCanaryRuntimeBindings(canonicalDatabasePath, canonicalArtifactRoot);
    const after = readCanaryState(runId, reference.exitStatusKey, {
      ...canaryIdentity,
      workflowId: reference.id,
      adapter: reference.adapter,
      definitionFingerprint,
      scheduleFingerprint,
      dueKey,
      artifactRoot: canonicalArtifactRoot
    });
    const idempotentRecheck = JSON.stringify(before) === JSON.stringify(after);
    const safe =
      registrationOk &&
      before.runStatus === "blocked" &&
      before.stepStatus === "blocked" &&
      before.exactBlocker === BROWSER_USE_CLI_REQUIRED_BLOCKER &&
      before.proofGateOk === false &&
      before.runnerExitStatus === null &&
      !before.runnerStarted &&
      !before.runnerCompleted &&
      before.externalActionExecuted === false &&
      approvalBoundaryVerified &&
      before.companyScopeVerified &&
      before.startLineageVerified &&
      before.workerBlockedEventVerified &&
      before.safetyProofVerified &&
      before.runtimeBindingVerified &&
      before.cleanupReceiptVerified &&
      idempotentRecheck;
    paths.push({
      id: reference.id,
      adapter: reference.adapter,
      run_id: runId,
      status: safe ? "proof_backed_safe_stop_verified" : "failed",
      exact_blocker: before.exactBlocker,
      run_blocked: before.runStatus === "blocked",
      step_blocked: before.stepStatus === "blocked",
      proof_gate_ok: before.proofGateOk,
      runner_exit_status: before.runnerExitStatus,
      runner_started: before.runnerStarted,
      runner_completed: before.runnerCompleted,
      external_action_executed: before.externalActionExecuted,
      idempotent_recheck: idempotentRecheck,
      approval_boundary_verified: approvalBoundaryVerified,
      company_scope_verified: before.companyScopeVerified,
      start_lineage_verified: before.startLineageVerified,
      worker_blocked_event_verified: before.workerBlockedEventVerified,
      safety_proof_verified: before.safetyProofVerified,
      runtime_binding_verified: before.runtimeBindingVerified,
      cleanup_receipt_verified: before.cleanupReceiptVerified,
      cleanup_receipt_sha256: cleanupReceipt.sha256,
      completion_claimed: false,
      operation_proof_gate_ok: false,
      definition_fingerprint: definitionFingerprint,
      schedule_fingerprint: scheduleFingerprint,
      reference_workflow_admission: referenceWorkflowAdmission
    });
  }

  const safetyReferencePathsOk = paths.length === references.length && paths.every((path) => path.status === "proof_backed_safe_stop_verified");
  return {
    schema: referenceWorkflowCanarySchema,
    generated_at: new Date().toISOString(),
    ok: safetyReferencePathsOk,
    safety_reference_paths_ok: safetyReferencePathsOk,
    reference_paths_complete: false,
    external_action_executed: false,
    mode: "isolated_sqlite_proof_backed_safe_stop_canary",
    scope: { database: "ephemeral_tmp", artifacts: "ephemeral_tmp", approval_model: "billing_only_no_start_approval" },
    paths
  };
}

function readCanaryState(runId: string, exitStatusKey: string, expected: {
  actorUserId: string;
  companyId: string;
  workflowId: string;
  adapter: string;
  definitionFingerprint: string;
  scheduleFingerprint: string;
  dueKey: string;
  artifactRoot: string;
}) {
  const run = querySql<{ status: string; company_id: string | null; metadata_json: string }>(
    `SELECT status, company_id, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  const step = querySql<{ id: string; status: string; company_id: string | null; metadata_json: string }>(
    `SELECT id, status, company_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(runId)} ORDER BY id ASC LIMIT 1`
  )[0];
  const events = querySql<{ event_type: string; company_id: string | null; metadata_json: string }>(
    `SELECT event_type, company_id, metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC, id ASC`
  );
  const proofs = querySql<{ proof_type: string; company_id: string | null; step_id: string | null; uri: string; size_bytes: number; metadata_json: string }>(
    `SELECT proof_type, company_id, step_id, uri, size_bytes, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC, id ASC`
  );
  const runMetadata = parseObject(run?.metadata_json);
  const stepMetadata = parseObject(step?.metadata_json);
  const proofGate = parseRecord(runMetadata.proof_gate);
  const routeReadback = parseRecord(runMetadata.route_readback);
  const routeDecisionFingerprint = stringOrNull(runMetadata.route_decision_fingerprint);
  const routeReadbackFingerprint = stringOrNull(runMetadata.route_readback_fingerprint);
  const startLineage = parseRecord(runMetadata.registered_workflow_start);
  const rawExitStatus = stepMetadata[exitStatusKey] ?? runMetadata[exitStatusKey];
  const workerBlockedEvents = events.filter((event) => event.event_type === "worker_blocked");
  const guardProofs = proofs.filter((proof) => proof.proof_type === "registered_workflow_route_guard_attestation");
  const guardProof = guardProofs[0];
  const guardMetadata = parseObject(guardProof?.metadata_json);
  const guardLineage = parseRecord(guardMetadata.registered_workflow_start);
  const expectedServiceWorkflowId = referenceWorkflowIdFromMetadata({ registeredWorkflowId: expected.workflowId });
  const runtimeBindingResult = validateServiceReadinessRuntimeBindingV1(stepMetadata.service_readiness_runtime_binding);
  const runtimeBindingVerified = runtimeBindingResult.ok && runtimeBindingResult.value.status === "blocked" &&
    runtimeBindingResult.value.exact_blocker === "in_app_browser_runtime_unavailable" &&
    runtimeBindingResult.value.root_id === deriveServiceReadinessRootId(runId) &&
    runtimeBindingResult.value.workflow_id === expectedServiceWorkflowId &&
    runtimeBindingResult.value.run_id === runId &&
    runtimeBindingResult.value.stage_id === step?.id &&
    runtimeBindingResult.value.external_action_executed === false;
  const cleanupReceipt = readCanaryCleanupReceipt(expected.artifactRoot, runId);
  const cleanupReceiptVerified = cleanupReceipt.ok && cleanupReceipt.value.workflow_id === expectedServiceWorkflowId;
  if (cleanupReceiptVerified && cleanupReceipt.ok) {
    try {
      assertServiceReadinessCleanupReceiptMatches(cleanupReceipt.value, {
        root_id: deriveServiceReadinessRootId(runId),
        workflow_id: expectedServiceWorkflowId as "daily-ai" | "job-application-manager" | "nisenprints",
        run_id: runId,
        stage_id: step?.id ?? "",
        attempt_id: runtimeBindingResult.ok ? runtimeBindingResult.value.attempt_id : "",
        fencing_token: runtimeBindingResult.ok ? runtimeBindingResult.value.fencing_token : 0
      });
    } catch {
      // The boolean below is the proof boundary; a mismatched receipt is not accepted.
    }
  }
  const verifiedCleanup = cleanupReceiptVerified && cleanupReceipt.ok
    ? (() => {
        try {
          assertServiceReadinessCleanupReceiptMatches(cleanupReceipt.value, {
            root_id: deriveServiceReadinessRootId(runId),
            workflow_id: expectedServiceWorkflowId as "daily-ai" | "job-application-manager" | "nisenprints",
            run_id: runId,
            stage_id: step?.id ?? "",
            attempt_id: runtimeBindingResult.ok ? runtimeBindingResult.value.attempt_id : "",
            fencing_token: runtimeBindingResult.ok ? runtimeBindingResult.value.fencing_token : 0
          });
          return true;
        } catch {
          return false;
        }
      })()
    : false;
  const companyScopeVerified =
    run?.company_id === expected.companyId &&
    step?.company_id === expected.companyId &&
    events.every((event) => event.company_id === expected.companyId) &&
    guardProofs.every((proof) => proof.company_id === expected.companyId);
  const startLineageVerified = lineageMatches(startLineage, expected) && lineageMatches(guardLineage, expected);
  const safetyProofVerified =
    proofs.length === 1 &&
    guardProofs.length === 1 &&
    guardProof?.step_id === step?.id &&
    guardMetadata.schema === "automation_os_route_guard_attestation.v1" &&
    guardMetadata.adapter === expected.adapter &&
    validFingerprint(routeDecisionFingerprint) &&
    validFingerprint(routeReadbackFingerprint) &&
    guardMetadata.route_decision_fingerprint === routeDecisionFingerprint &&
    guardMetadata.route_readback_fingerprint === routeReadbackFingerprint &&
    guardMetadata.exact_blocker === BROWSER_USE_CLI_REQUIRED_BLOCKER &&
    guardMetadata.worker_outcome === "blocked_before_runner" &&
    guardMetadata.completion_claimed === false &&
    guardMetadata.operation_proof_gate_ok === false &&
    guardMetadata.external_action_executed === false &&
    validateGuardRuntimeBinding(guardMetadata.service_readiness_runtime_binding, runId, step?.id ?? "", expectedServiceWorkflowId ?? expected.workflowId) &&
    verifyGuardArtifact(guardProof, {
      runId,
      stepId: step?.id ?? "",
      expected,
      artifactRoot: expected.artifactRoot,
      routeDecisionFingerprint,
      routeReadbackFingerprint
    });
  const externalActionExecuted = [
    runMetadata,
    stepMetadata,
    ...events.map((event) => parseObject(event.metadata_json)),
    ...proofs.map((proof) => parseObject(proof.metadata_json))
  ].some(hasTrueExternalActionFlag);
  return {
    runStatus: run?.status ?? "missing",
    stepStatus: step?.status ?? "missing",
    exactBlocker: stringOrNull(runMetadata.stop_reason ?? routeReadback.exactBlocker ?? stepMetadata.stop_reason),
    proofGateOk: proofGate.ok === true,
    runnerExitStatus: typeof rawExitStatus === "number" ? rawExitStatus : null,
    runnerStarted: events.some((event) => event.event_type === "worker_started"),
    runnerCompleted: events.some((event) => event.event_type === "worker_completed"),
    externalActionExecuted,
    companyScopeVerified,
    startLineageVerified,
    workerBlockedEventVerified: workerBlockedEvents.length === 1,
    safetyProofVerified,
    runtimeBindingVerified,
    cleanupReceiptVerified: verifiedCleanup,
    cleanupReceiptSha256: cleanupReceipt.ok ? cleanupReceipt.sha256 : null,
    stepId: step?.id ?? "",
    attemptId: runtimeBindingResult.ok ? runtimeBindingResult.value.attempt_id : "",
    fencingToken: runtimeBindingResult.ok ? runtimeBindingResult.value.fencing_token : 0,
    eventTypes: events.map((event) => event.event_type)
  };
}

function canaryCleanupPath(artifactRoot: string, runId: string): string {
  return resolve(artifactRoot, "service-readiness-cleanup", `${runId}.json`);
}

function writeCanaryCleanupReceipt(input: {
  artifactRoot: string;
  runId: string;
  stepId: string;
  rootId: string;
  workflowId: "daily-ai" | "job-application-manager" | "nisenprints";
  attemptId: string;
  fencingToken: number;
}): { receipt: ServiceReadinessCleanupReceiptV1; sha256: string } {
  const path = canaryCleanupPath(input.artifactRoot, input.runId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const receipt = buildServiceReadinessCleanupReceiptV1({
    root_id: input.rootId,
    workflow_id: input.workflowId,
    run_id: input.runId,
    stage_id: input.stepId,
    attempt_id: input.attemptId,
    fencing_token: input.fencingToken,
    artifact_uri: `file://${path}`,
    created_at: new Date().toISOString()
  });
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { receipt, sha256: hashServiceReadinessCleanupReceiptV1(receipt) };
}

function readCanaryCleanupReceipt(artifactRoot: string, runId: string): { ok: true; value: ServiceReadinessCleanupReceiptV1; sha256: string } | { ok: false; exact_blocker: string } {
  const path = canaryCleanupPath(artifactRoot, runId);
  try {
    const bytes = readFileSync(path);
    const result = validateServiceReadinessCleanupReceiptV1(JSON.parse(bytes.toString("utf8")));
    if (!result.ok) return result;
    const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } finally {
      closeSync(fd);
    }
    if (stat.mode & 0o077 || stat.nlink !== 1 || stat.size !== bytes.byteLength) return { ok: false, exact_blocker: "service_readiness_cleanup_receipt_file_untrusted" };
    return { ok: true, value: result.value, sha256: hashServiceReadinessCleanupReceiptV1(result.value) };
  } catch {
    return { ok: false, exact_blocker: "service_readiness_cleanup_receipt_unreadable" };
  }
}

function validateGuardRuntimeBinding(value: unknown, runId: string, stepId: string, workflowId: string): boolean {
  const result = validateServiceReadinessRuntimeBindingV1(value);
  if (!result.ok || result.value.status !== "blocked") return false;
  try {
    assertServiceReadinessRuntimeBindingMatches(result.value, {
      root_id: deriveServiceReadinessRootId(runId),
      workflow_id: workflowId as "daily-ai" | "job-application-manager" | "nisenprints",
      run_id: runId,
      stage_id: stepId,
      attempt_id: result.value.attempt_id,
      fencing_token: result.value.fencing_token,
      effect_key: null
    });
    return result.value.exact_blocker === "in_app_browser_runtime_unavailable" && result.value.external_action_executed === false;
  } catch {
    return false;
  }
}

function seedReferenceCanaryCompany() {
  const actorUserId = "user_reference_canary_owner";
  const companyId = "company_reference_canary";
  const timestamp = nowIso();
  insert("users", {
    id: actorUserId,
    auth_provider: "reference_canary",
    auth_subject: actorUserId,
    email: null,
    display_name: "Reference Canary Owner",
    kind: "human",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  insert("companies", { id: companyId, slug: companyId, name: "Reference Canary Company", status: "active", created_at: timestamp, updated_at: timestamp });
  insert("company_memberships", {
    id: "membership_reference_canary_owner",
    company_id: companyId,
    user_id: actorUserId,
    role: "owner",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  return { actorUserId, companyId };
}

function lineageMatches(lineage: Record<string, unknown>, expected: {
  actorUserId: string;
  companyId: string;
  workflowId: string;
  definitionFingerprint: string;
  scheduleFingerprint: string;
  dueKey: string;
}): boolean {
  return lineage.workflow_id === expected.workflowId &&
    lineage.source === "reference_workflow_canary" &&
    lineage.due_key === expected.dueKey &&
    lineage.definition_fingerprint === expected.definitionFingerprint &&
    lineage.schedule_fingerprint === expected.scheduleFingerprint &&
    lineage.actor_user_id === expected.actorUserId &&
    lineage.company_id === expected.companyId;
}

function verifyGuardArtifact(
  proof: { uri: string; size_bytes: number; metadata_json: string } | undefined,
  input: {
    runId: string;
    stepId: string;
    expected: {
      actorUserId: string;
      companyId: string;
      workflowId: string;
      adapter: string;
      definitionFingerprint: string;
      scheduleFingerprint: string;
      dueKey: string;
    };
    artifactRoot: string;
    routeDecisionFingerprint: string;
    routeReadbackFingerprint: string;
  }
): boolean {
  if (!proof?.uri.startsWith("file://")) return false;
  try {
    const path = fileURLToPath(proof.uri);
    const bytes = readFileSync(path);
    const metadata = parseObject(proof.metadata_json);
    const artifact = parseRecord(JSON.parse(bytes.toString("utf8")));
    return existsSync(path) &&
      isPathWithin(input.artifactRoot, resolveThroughExistingAncestor(path)) &&
      bytes.byteLength === Number(proof.size_bytes) &&
      metadata.size_bytes === bytes.byteLength &&
      metadata.mime_type === "application/json" &&
      metadata.checksum_sha256 === createHash("sha256").update(bytes).digest("hex") &&
      artifact.schema === "automation_os_route_guard_attestation.v1" &&
      artifact.run_id === input.runId &&
      artifact.step_id === input.stepId &&
      artifact.company_id === input.expected.companyId &&
      artifact.adapter === input.expected.adapter &&
      lineageMatches(parseRecord(artifact.registered_workflow_start), input.expected) &&
      artifact.route_decision_fingerprint === input.routeDecisionFingerprint &&
      artifact.route_readback_fingerprint === input.routeReadbackFingerprint &&
      artifact.exact_blocker === BROWSER_USE_CLI_REQUIRED_BLOCKER &&
      artifact.worker_outcome === "blocked_before_runner" &&
      artifact.completion_claimed === false &&
      artifact.operation_proof_gate_ok === false &&
      artifact.external_action_executed === false &&
      validateGuardRuntimeBinding(
        artifact.service_readiness_runtime_binding,
        input.runId,
        input.stepId,
        referenceWorkflowIdFromMetadata({ registeredWorkflowId: input.expected.workflowId }) ?? input.expected.workflowId
      );
  } catch {
    return false;
  }
}

function assertCanaryRuntimeBindings(databasePath: string, artifactRoot: string): void {
  const runtimeDatabasePath = process.env.AUTOMATION_OS_DB?.trim();
  const runtimeArtifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim();
  if (!runtimeDatabasePath || resolveThroughExistingAncestor(runtimeDatabasePath) !== databasePath) {
    throw new Error("reference_workflow_canary_database_binding_changed");
  }
  if (!runtimeArtifactRoot || resolveThroughExistingAncestor(runtimeArtifactRoot) !== artifactRoot) {
    throw new Error("reference_workflow_canary_artifact_binding_changed");
  }
}

function isPathWithin(root: string, target: string): boolean {
  const scoped = relative(root, target);
  return Boolean(scoped) && !scoped.startsWith("..") && !isAbsolute(scoped);
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasTrueExternalActionFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTrueExternalActionFlag);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if ((normalized === "externalactionexecuted" || normalized === "externalactionexecutedbyrehearsal") && nested === true) return true;
    return hasTrueExternalActionFlag(nested);
  });
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return parseRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTempOwnedPath(value: string): boolean {
  const target = resolveThroughExistingAncestor(value);
  return [tmpdir(), "/tmp", "/private/tmp"].map(resolveThroughExistingAncestor).some((root) => {
    const scoped = relative(root, target);
    return Boolean(scoped) && !scoped.startsWith("..") && !isAbsolute(scoped);
  });
}

function resolveThroughExistingAncestor(value: string): string {
  const target = resolve(value);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return target;
    existing = parent;
  }
  return resolve(realpathSync(existing), relative(existing, target));
}
