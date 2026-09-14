import {
  dbBackend,
  initDb,
  initializePostgresSchemaAsync,
  makeId,
  nowIso,
  querySql,
  querySqlAsync,
  runSqlTransaction,
  runSqlTransactionAsync,
  sqlValue
} from "../db/client.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { hashIdempotencyRequest } from "../automations/idempotency.js";
import { buildPortableWorkerExecutionRoutingSnapshot } from "../codex/executionRouting.js";
import { startCommandRun } from "./workerEngine.js";
import {
  PORTABLE_LOCAL_WORKFLOW_SCHEMA,
  localWorkflowManifest,
  type PortableLocalWorkflowId,
  type PortableLocalSourceSnapshot,
  UNATTENDED_FIXED_LOCAL_EFFECT_POLICY
} from "./portableLocalWorkflow.js";
import { backupBusinessPayloadHash, obsidianBusinessPayloadHash } from "./portableLocalWorkflow.js";
import { DAILY_AI_RESEARCH_SYNC_WORKFLOW, DAILY_AI_RESEARCH_SYNC_POLICY, DAILY_AI_RESEARCH_SYNC_COMPANY,
  DAILY_AI_RESEARCH_SYNC_ACCOUNT, DAILY_AI_RESEARCH_SYNC_TARGET, dailyAiResearchSyncPayloadHash, dailyAiResearchSyncBundleValid } from "./dailyAiResearchSourceSync.js";
import { preparePortableExternalApprovalPostgres } from "./portableWorkflowEntrypoint.js";
import {
  createRegisteredRootAdmissionV1,
  type RegisteredRootAdmissionV1
} from "./registeredRootAdmission.js";

export type PortableLocalWorkflowStartInput = {
  workflowId: PortableLocalWorkflowId;
  sourceTrigger: "automation_os_scheduler" | "automation_os_ui" | "codex_app_bridge" | "launchd" | "github_actions";
  idempotencyKey: string;
  registeredAutomationId?: string;
  registeredAutomationVersionId?: string | null;
  companyId: string;
  dueKey?: string;
  readOnlyStage?: "reference_readback";
  effectStage?: "business_execute";
  inputBundle?: Record<string, unknown> | null;
  unattendedEffectPolicy?: typeof UNATTENDED_FIXED_LOCAL_EFFECT_POLICY | typeof DAILY_AI_RESEARCH_SYNC_POLICY;
  sourceSnapshot?: PortableLocalSourceSnapshot;
  chatOrigin?: { schema: "aos.chat_workflow_binding.v1"; binding_id: string; job_id: string; prompt_sha256: string };
  recoveryOrigin?: { schema: "aos.portable_run_recovery.v1"; binding_id: string; parent_run_id: string; company_id: string };
};

export type PortableLocalWorkflowStartResult = {
  runId: string;
  replayed: boolean;
  workflowId: PortableLocalWorkflowId;
  sourceTrigger: PortableLocalWorkflowStartInput["sourceTrigger"];
  idempotencyKey: string;
  executionMode: "read_only" | "business_effect";
  status: string;
  registeredRoot?: RegisteredRootAdmissionV1;
};

export function portableChatWorkflowRunId(origin: NonNullable<PortableLocalWorkflowStartInput["chatOrigin"]>): string {
  return `run_chat_${hashIdempotencyRequest(origin).slice(0, 32)}`;
}

export function portableRecoveryRunId(origin: NonNullable<PortableLocalWorkflowStartInput["recoveryOrigin"]>): string {
  return `run_retry_${hashIdempotencyRequest(origin).slice(0, 32)}`;
}

export async function startPortableLocalWorkflowRun(input: PortableLocalWorkflowStartInput): Promise<PortableLocalWorkflowStartResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const companyId = input.companyId.trim();
  if (!idempotencyKey) throw new Error("portable_idempotency_key_required");
  if (!companyId) throw new Error("company_id_required");
  if (input.chatOrigin && input.recoveryOrigin) throw new Error("portable_run_origin_conflict");
  if (input.recoveryOrigin && input.recoveryOrigin.company_id !== companyId) throw new Error("portable_recovery_company_mismatch");
  const boundRunId = input.chatOrigin ? portableChatWorkflowRunId(input.chatOrigin)
    : input.recoveryOrigin ? portableRecoveryRunId(input.recoveryOrigin) : null;
  if (input.readOnlyStage !== undefined && input.readOnlyStage !== "reference_readback") {
    throw new Error("portable_local_read_only_stage_unsupported");
  }
  if (input.effectStage !== undefined && input.effectStage !== "business_execute") {
    throw new Error("portable_local_business_effect_stage_unsupported");
  }
  const inputBundle = normalizeLocalBusinessInput(input);
  const postgres = dbBackend === "postgres";
  if (postgres) await initializePostgresSchemaAsync();
  else initDb();
  const requestHash = hashIdempotencyRequest({
    schema: PORTABLE_LOCAL_WORKFLOW_SCHEMA,
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    company_id: companyId,
    due_key: input.dueKey ?? null,
    read_only_stage: input.effectStage ? null : (input.readOnlyStage ?? "reference_readback"),
    effect_stage: input.effectStage ?? null,
    input_bundle: inputBundle,
    unattended_effect_policy: input.unattendedEffectPolicy ?? null,
    source_snapshot: input.sourceSnapshot ?? null,
    ...(input.chatOrigin ? { chat_origin: input.chatOrigin,
      registered_automation_id: input.registeredAutomationId ?? null,
      registered_automation_version_id: input.registeredAutomationVersionId ?? null } : {}),
    ...(input.recoveryOrigin ? { recovery_origin: input.recoveryOrigin,
      registered_automation_id: input.registeredAutomationId ?? null,
      registered_automation_version_id: input.registeredAutomationVersionId ?? null } : {}),
    idempotency_key: idempotencyKey
  });
  const existingQuery = `
    SELECT request_hash, status, run_id
    FROM portable_workflow_invocations
    WHERE workflow_id=${sqlValue(input.workflowId)}
      AND source_trigger=${sqlValue(input.sourceTrigger)}
      AND company_scope=${sqlValue(companyId)}
      AND idempotency_key=${sqlValue(idempotencyKey)}
    LIMIT 1
  `;
  const existing = (postgres
    ? (await querySqlAsync<{ request_hash: string; status: string; run_id: string | null }>(existingQuery))[0]
    : querySql<{ request_hash: string; status: string; run_id: string | null }>(existingQuery)[0]);
  if (existing?.request_hash !== requestHash && existing) {
    throw new Error("portable_workflow_invocation_payload_conflict");
  }
  const existingRunId = existing?.run_id ?? (existing ? boundRunId : null);
  if (existingRunId) {
    const runQuery = `SELECT id, status FROM runs WHERE id=${sqlValue(existingRunId)} AND company_id=${sqlValue(companyId)} LIMIT 1`;
    const run = (postgres
      ? (await querySqlAsync<{ id: string; status: string }>(runQuery))[0]
      : querySql<{ id: string; status: string }>(runQuery)[0]);
    if (run) return result(input, idempotencyKey, run.id, run.status, true);
  }
  const reservationId = makeId("portable_local_invocation");
  try {
    const reservationStep = {
      sql: `INSERT INTO portable_workflow_invocations
        (id, workflow_id, source_trigger, company_scope, company_id, idempotency_key, request_hash, status, run_id, created_at, updated_at)
        VALUES (${sqlValue(reservationId)}, ${sqlValue(input.workflowId)}, ${sqlValue(input.sourceTrigger)}, ${sqlValue(companyId)}, ${sqlValue(companyId)}, ${sqlValue(idempotencyKey)}, ${sqlValue(requestHash)}, 'pending', NULL, ${sqlValue(nowIso())}, ${sqlValue(nowIso())})`,
      expectChanges: 1
    };
    if (postgres) await runSqlTransactionAsync([reservationStep]);
    else runSqlTransaction([reservationStep]);
  } catch {
    const racedQuery = `
      SELECT run_id, status, request_hash FROM portable_workflow_invocations
      WHERE workflow_id=${sqlValue(input.workflowId)} AND source_trigger=${sqlValue(input.sourceTrigger)}
        AND company_scope=${sqlValue(companyId)} AND idempotency_key=${sqlValue(idempotencyKey)} LIMIT 1
    `;
    const raced = (postgres
      ? (await querySqlAsync<{ run_id: string | null; status: string; request_hash: string }>(racedQuery))[0]
      : querySql<{ run_id: string | null; status: string; request_hash: string }>(racedQuery)[0]);
    if (raced?.request_hash !== requestHash) throw new Error("portable_workflow_invocation_payload_conflict");
    if (raced?.run_id) {
      const runQuery = `SELECT id, status FROM runs WHERE id=${sqlValue(raced.run_id)} LIMIT 1`;
      const run = (postgres
        ? (await querySqlAsync<{ id: string; status: string }>(runQuery))[0]
        : querySql<{ id: string; status: string }>(runQuery)[0]);
      if (run) return result(input, idempotencyKey, run.id, run.status, true);
    }
    throw new Error("portable_local_workflow_invocation_pending");
  }
  try {
    const manifest = localWorkflowManifest(input.workflowId);
    const source = input.sourceTrigger === "automation_os_scheduler" ? "scheduler" as const : "manual" as const;
    const registeredRoot = createRegisteredRootAdmissionV1({
      registeredAutomationId: input.registeredAutomationId ?? input.workflowId,
      workflowId: input.workflowId,
      runId: boundRunId ?? makeId("run"),
      sourceTrigger: input.sourceTrigger,
      definitionFingerprint: hashIdempotencyRequest(manifest)
    });
    // Chat's durable binding deterministically identifies this Run before it
    // exists. Do not prefill invocation.run_id: its foreign key correctly
    // requires an existing Run. A lost completion is recovered by the same ID.
    const persistedInputBundle = inputBundle ? writeLocalInputBundle(registeredRoot.run_id, input.workflowId, inputBundle) : null;
    const started = await startCommandRun(manifest.command, {
      runId: registeredRoot.run_id,
      deferWorker: true,
      prepareOnly: Boolean(input.effectStage),
      automationId: input.registeredAutomationId ?? null,
      automationVersionId: input.registeredAutomationVersionId ?? null,
      companyId,
      executionRouting: buildPortableWorkerExecutionRoutingSnapshot({
        command: manifest.command,
        source,
        workflowId: input.workflowId,
        plannedAdapters: ["mac_local_worker"],
        selectedLane: "portable_local_worker"
      }),
      metadata: {
      ...(input.effectStage ? {} : { read_only_stage: input.readOnlyStage ?? "reference_readback" }),
      ...(input.effectStage ? { effect_stage: input.effectStage } : {}),
      ...(persistedInputBundle ? { input_bundle_path: persistedInputBundle.path } : {}),
      ...(persistedInputBundle
        ? {
            portable_input_bundle: {
              schema: "automation_os_portable_workflow_input_bundle.v1",
              run_id: registeredRoot.run_id,
              path: persistedInputBundle.path,
              sha256: persistedInputBundle.sha256,
              created_at: persistedInputBundle.createdAt,
              fields: Object.keys(inputBundle ?? {}),
              ...(inputBundle ? { input: inputBundle } : {})
            }
          }
        : {}),
        registeredWorkflowId: input.workflowId,
        registered_workflow_id: input.workflowId,
        ...(input.chatOrigin ? { chat_origin: input.chatOrigin } : {}),
        ...(input.recoveryOrigin ? { recovery_origin: input.recoveryOrigin } : {}),
        workflow_id: input.workflowId,
        registered_workflow_start: {
          source,
          runnerKind: manifest.workerCommandKind,
          workflow_id: input.workflowId,
          ...(input.dueKey ? { dueKey: input.dueKey } : {}),
          portable: true,
          local_worker: true
        },
        portable_workflow_invocation: {
          schema: "automation_os_portable_local_workflow_invocation_v1",
          workflow_id: input.workflowId,
          source_trigger: input.sourceTrigger,
          registered_automation_id: registeredRoot.registered_automation_id,
          idempotency_key: idempotencyKey,
          company_id: companyId,
          ...(input.effectStage ? {} : { read_only_stage: input.readOnlyStage ?? "reference_readback" }),
          ...(input.effectStage ? { effect_stage: input.effectStage } : {}),
          ...(input.unattendedEffectPolicy ? { unattended_effect_policy: input.unattendedEffectPolicy } : {}),
          ...(persistedInputBundle ? { input_bundle_path: persistedInputBundle.path } : {}),
          app_dependency: false,
          external_action_executed: false
        },
        registered_root_admission: registeredRoot,
        ...(input.sourceSnapshot ? { source_snapshot: input.sourceSnapshot } : {}),
        ...(input.unattendedEffectPolicy ? { unattended_effect_policy: input.unattendedEffectPolicy } : {}),
        portable_worker: {
          workflow_id: input.workflowId,
          mode: input.effectStage ? "business_effect" : "read_only",
          ...(input.effectStage ? { effect_stage: input.effectStage } : {}),
          ...(persistedInputBundle ? { input_bundle_path: persistedInputBundle.path } : {}),
          local_worker: true,
          external_action_executed: false
        },
        worker_protocol: "mac_worker_polling_required",
        worker_mode: "queued_for_mac_worker",
        worker_loop: { status: "waiting_for_pickup", launchReason: "portable_local_workflow_entrypoint", queuedAt: nowIso() },
        mac_worker: { status: "waiting_for_pickup", launchReason: "portable_local_workflow_entrypoint", queuedAt: nowIso() }
      }
    });
    if (input.effectStage) {
      if ((dbBackend !== "postgres" && input.workflowId !== "email-review-reply") || !companyId || !persistedInputBundle) {
        throw new Error("portable_local_business_requires_postgres_bundle");
      }
      await preparePortableExternalApprovalPostgres({
        runId: started.runId,
        workflowId: input.workflowId,
        companyId,
        effectStage: input.effectStage,
        idempotencyKey,
        inputBundle: inputBundle!,
        inputBundleSha256: persistedInputBundle.sha256,
        browserSurface: "browser_use_cli",
        approvalMode: input.unattendedEffectPolicy === UNATTENDED_FIXED_LOCAL_EFFECT_POLICY
          || (input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW && input.unattendedEffectPolicy === DAILY_AI_RESEARCH_SYNC_POLICY)
          ? "registered_unattended_local"
          : "explicit"
      });
    }
    const completionStep = {
      sql: `UPDATE portable_workflow_invocations SET status='completed', run_id=${sqlValue(started.runId)}, updated_at=${sqlValue(nowIso())}
            WHERE id=${sqlValue(reservationId)} AND request_hash=${sqlValue(requestHash)} AND status='pending'`,
      expectChanges: 1
    };
    if (postgres) await runSqlTransactionAsync([completionStep]);
    else runSqlTransaction([completionStep]);
    const current = (await querySqlAsync<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE id=${sqlValue(started.runId)} LIMIT 1`))[0];
    return result(input, idempotencyKey, started.runId, current?.status ?? String(started.run.status ?? "queued"), false, registeredRoot);
  } catch (error) {
    if (!boundRunId) {
      const releaseStep = { sql: `DELETE FROM portable_workflow_invocations WHERE id=${sqlValue(reservationId)} AND status='pending'` };
      if (postgres) await runSqlTransactionAsync([releaseStep]);
      else runSqlTransaction([releaseStep]);
    }
    throw error;
  }
}

function result(input: PortableLocalWorkflowStartInput, idempotencyKey: string, runId: string, status: string, replayed: boolean, registeredRoot?: RegisteredRootAdmissionV1): PortableLocalWorkflowStartResult {
  return { runId, replayed, workflowId: input.workflowId, sourceTrigger: input.sourceTrigger, idempotencyKey, executionMode: input.effectStage ? "business_effect" : "read_only", status, ...(registeredRoot ? { registeredRoot } : {}) };
}

function normalizeLocalBusinessInput(input: PortableLocalWorkflowStartInput): Record<string, unknown> | null {
  if (!input.effectStage) {
    // Gmail's read-only provider review still needs the exact company-bound
    // connection/account pair in the Run so the worker can revalidate it at
    // the provider boundary. Other read-only local workflows have no caller
    // input and continue to reject arbitrary bundles.
    if (input.workflowId !== "email-review-reply" || input.inputBundle === undefined || input.inputBundle === null) return null;
    if (typeof input.inputBundle !== "object" || Array.isArray(input.inputBundle)) {
      throw new Error("portable_local_gmail_input_bundle_invalid");
    }
    const allowed = new Set(["connection_ref_id", "account_ref"]);
    const normalized: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input.inputBundle)) {
      if (!allowed.has(key) || typeof raw !== "string" || !raw.trim() || raw.length > 1000) {
        throw new Error("portable_local_gmail_input_bundle_invalid");
      }
      normalized[key] = raw.trim();
    }
    if (typeof normalized.connection_ref_id !== "string" || typeof normalized.account_ref !== "string") {
      throw new Error("portable_local_gmail_input_bundle_required");
    }
    return normalized;
  }
  if (input.workflowId !== "daily-backup-safety-check" && input.workflowId !== "obsidian-project-memory-audit"
    && input.workflowId !== DAILY_AI_RESEARCH_SYNC_WORKFLOW && input.workflowId !== "email-review-reply") {
    throw new Error("portable_local_business_workflow_unsupported");
  }
  if (!input.inputBundle || typeof input.inputBundle !== "object" || Array.isArray(input.inputBundle)) {
    throw new Error("portable_local_business_input_bundle_required");
  }
  const bundle = input.inputBundle;
  if (input.workflowId === "email-review-reply") {
    const allowed = new Set([
      "connection_ref_id", "account_ref", "target_key", "payload_hash", "source_snapshot_id",
      "gmail_source_run_id", "gmail_source_review_hash", "gmail_source_evidence_sha256",
      "gmail_canonical_reply_payload_sha256", "gmail_reply_effect_input_json", "gmail_reply_producer_result_json"
    ]);
    const normalized: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(bundle)) {
      if (!allowed.has(key) || typeof raw !== "string" || !raw.trim()
        || raw.length > (key.endsWith("_json") ? 400_000 : 1_000)) {
        throw new Error("portable_local_gmail_business_input_bundle_invalid");
      }
      normalized[key] = raw.trim();
    }
    const required = ["connection_ref_id", "account_ref", "target_key", "payload_hash", "source_snapshot_id",
      "gmail_source_run_id", "gmail_source_review_hash", "gmail_source_evidence_sha256",
      "gmail_canonical_reply_payload_sha256", "gmail_reply_effect_input_json", "gmail_reply_producer_result_json"];
    if (required.some((key) => typeof normalized[key] !== "string")
      || !/^[a-f0-9]{64}$/u.test(String(normalized.payload_hash))
      || !/^[a-f0-9]{64}$/u.test(String(normalized.source_snapshot_id))
      || !/^[a-f0-9]{64}$/u.test(String(normalized.gmail_source_review_hash))
      || !/^[a-f0-9]{64}$/u.test(String(normalized.gmail_source_evidence_sha256))
      || !/^[a-f0-9]{64}$/u.test(String(normalized.gmail_canonical_reply_payload_sha256))) {
      throw new Error("portable_local_gmail_business_input_bundle_required");
    }
    try {
      const parsedInput = JSON.parse(String(normalized.gmail_reply_effect_input_json)) as unknown;
      const parsedResult = JSON.parse(String(normalized.gmail_reply_producer_result_json)) as unknown;
      if (!parsedInput || typeof parsedInput !== "object" || !parsedResult || typeof parsedResult !== "object") {
        throw new Error("invalid");
      }
    } catch {
      throw new Error("portable_local_gmail_business_input_bundle_invalid");
    }
    return normalized;
  }
  if (input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW
    && (input.companyId !== DAILY_AI_RESEARCH_SYNC_COMPANY || !dailyAiResearchSyncBundleValid(bundle))) {
    throw new Error("portable_local_business_target_invalid");
  }
  const allowed = new Set(["account_ref", "target_key", "payload_hash", "source_snapshot_id"]);
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bundle)) {
    if (!allowed.has(key) || typeof raw !== "string" || !raw.trim() || raw.length > 1000) {
      throw new Error("portable_local_business_input_bundle_invalid");
    }
    normalized[key] = raw.trim();
  }
  const expected = input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW
    ? { accountRef: DAILY_AI_RESEARCH_SYNC_ACCOUNT, targetKey: DAILY_AI_RESEARCH_SYNC_TARGET, payloadHash: dailyAiResearchSyncPayloadHash() }
    : input.workflowId === "daily-backup-safety-check"
    ? { accountRef: "github:nick353/daily-workspace-backup", targetKey: "daily-workspace-backup:main", payloadHash: backupBusinessPayloadHash() }
    : { accountRef: "github:nick353/obsidian-vault-backup", targetKey: "obsidian-vault-backup:main", payloadHash: obsidianBusinessPayloadHash() };
  if (normalized.account_ref !== expected.accountRef
    || normalized.target_key !== expected.targetKey
    || normalized.payload_hash !== expected.payloadHash) {
    throw new Error("portable_local_business_target_invalid");
  }
  return normalized;
}

function writeLocalInputBundle(runId: string, workflowId: PortableLocalWorkflowId, inputBundle: Record<string, unknown>): { path: string; sha256: string; createdAt: string } {
  const artifactRoot = resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"));
  const runRoot = resolve(artifactRoot, runId);
  if (runRoot === artifactRoot || !runRoot.startsWith(`${artifactRoot}${sep}`)) throw new Error("portable_local_input_bundle_path_invalid");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const createdAt = nowIso();
  const bytes = `${JSON.stringify({ schema: "automation_os_portable_workflow_input_bundle.v1", workflow_id: workflowId, run_id: runId, input: inputBundle, created_at: createdAt }, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bundlePath = resolve(runRoot, "portable-input-bundle.v1.json");
  if (existsSync(bundlePath)) {
    if (readFileSync(bundlePath, "utf8") !== bytes) throw new Error("portable_local_input_bundle_immutable_collision");
  } else {
    writeFileSync(bundlePath, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  chmodSync(bundlePath, 0o600);
  return { path: bundlePath, sha256, createdAt };
}
