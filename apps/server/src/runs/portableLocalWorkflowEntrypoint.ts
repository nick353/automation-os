import { initDb, makeId, nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { hashIdempotencyRequest } from "../automations/idempotency.js";
import { buildPortableWorkerExecutionRoutingSnapshot } from "../codex/executionRouting.js";
import { startCommandRun } from "./workerEngine.js";
import {
  PORTABLE_LOCAL_WORKFLOW_SCHEMA,
  localWorkflowManifest,
  type PortableLocalWorkflowId
} from "./portableLocalWorkflow.js";

export type PortableLocalWorkflowStartInput = {
  workflowId: PortableLocalWorkflowId;
  sourceTrigger: "automation_os_scheduler" | "automation_os_ui" | "codex_app_bridge" | "launchd" | "github_actions";
  idempotencyKey: string;
  companyId: string;
  dueKey?: string;
  readOnlyStage?: "reference_readback";
};

export type PortableLocalWorkflowStartResult = {
  runId: string;
  replayed: boolean;
  workflowId: PortableLocalWorkflowId;
  sourceTrigger: PortableLocalWorkflowStartInput["sourceTrigger"];
  idempotencyKey: string;
  executionMode: "read_only";
  status: string;
};

export async function startPortableLocalWorkflowRun(input: PortableLocalWorkflowStartInput): Promise<PortableLocalWorkflowStartResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const companyId = input.companyId.trim();
  if (!idempotencyKey) throw new Error("portable_idempotency_key_required");
  if (!companyId) throw new Error("company_id_required");
  if (input.readOnlyStage !== undefined && input.readOnlyStage !== "reference_readback") {
    throw new Error("portable_local_read_only_stage_unsupported");
  }
  initDb();
  const requestHash = hashIdempotencyRequest({
    schema: PORTABLE_LOCAL_WORKFLOW_SCHEMA,
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    company_id: companyId,
    due_key: input.dueKey ?? null,
    read_only_stage: input.readOnlyStage ?? "reference_readback",
    idempotency_key: idempotencyKey
  });
  const existing = querySql<{ request_hash: string; status: string; run_id: string | null }>(`
    SELECT request_hash, status, run_id
    FROM portable_workflow_invocations
    WHERE workflow_id=${sqlValue(input.workflowId)}
      AND source_trigger=${sqlValue(input.sourceTrigger)}
      AND company_scope=${sqlValue(companyId)}
      AND idempotency_key=${sqlValue(idempotencyKey)}
    LIMIT 1
  `)[0];
  if (existing?.request_hash !== requestHash && existing) {
    throw new Error("portable_workflow_invocation_payload_conflict");
  }
  if (existing?.run_id) {
    const run = querySql<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE id=${sqlValue(existing.run_id)} LIMIT 1`)[0];
    if (run) return result(input, idempotencyKey, run.id, run.status, true);
  }
  const reservationId = makeId("portable_local_invocation");
  try {
    runSqlTransaction([{
      sql: `INSERT INTO portable_workflow_invocations
        (id, workflow_id, source_trigger, company_scope, company_id, idempotency_key, request_hash, status, run_id, created_at, updated_at)
        VALUES (${sqlValue(reservationId)}, ${sqlValue(input.workflowId)}, ${sqlValue(input.sourceTrigger)}, ${sqlValue(companyId)}, ${sqlValue(companyId)}, ${sqlValue(idempotencyKey)}, ${sqlValue(requestHash)}, 'pending', NULL, ${sqlValue(nowIso())}, ${sqlValue(nowIso())})`,
      expectChanges: 1
    }]);
  } catch {
    const raced = querySql<{ run_id: string | null; status: string; request_hash: string }>(`
      SELECT run_id, status, request_hash FROM portable_workflow_invocations
      WHERE workflow_id=${sqlValue(input.workflowId)} AND source_trigger=${sqlValue(input.sourceTrigger)}
        AND company_scope=${sqlValue(companyId)} AND idempotency_key=${sqlValue(idempotencyKey)} LIMIT 1
    `)[0];
    if (raced?.request_hash !== requestHash) throw new Error("portable_workflow_invocation_payload_conflict");
    if (raced?.run_id) {
      const run = querySql<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE id=${sqlValue(raced.run_id)} LIMIT 1`)[0];
      if (run) return result(input, idempotencyKey, run.id, run.status, true);
    }
    throw new Error("portable_local_workflow_invocation_pending");
  }
  try {
    const manifest = localWorkflowManifest(input.workflowId);
    const source = input.sourceTrigger === "automation_os_scheduler" ? "scheduler" as const : "manual" as const;
    const started = await startCommandRun(manifest.command, {
      deferWorker: true,
      companyId,
      executionRouting: buildPortableWorkerExecutionRoutingSnapshot({
        command: manifest.command,
        source,
        workflowId: input.workflowId,
        plannedAdapters: ["mac_local_worker"],
        selectedLane: "portable_local_worker"
      }),
      metadata: {
        read_only_stage: input.readOnlyStage ?? "reference_readback",
        registeredWorkflowId: input.workflowId,
        registered_workflow_id: input.workflowId,
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
          idempotency_key: idempotencyKey,
          company_id: companyId,
          read_only_stage: input.readOnlyStage ?? "reference_readback",
          app_dependency: false,
          external_action_executed: false
        },
        portable_worker: {
          workflow_id: input.workflowId,
          mode: "read_only",
          local_worker: true,
          external_action_executed: false
        },
        worker_protocol: "mac_worker_polling_required",
        worker_mode: "queued_for_mac_worker",
        worker_loop: { status: "waiting_for_pickup", launchReason: "portable_local_workflow_entrypoint", queuedAt: nowIso() },
        mac_worker: { status: "waiting_for_pickup", launchReason: "portable_local_workflow_entrypoint", queuedAt: nowIso() }
      }
    });
    runSqlTransaction([{
      sql: `UPDATE portable_workflow_invocations SET status='completed', run_id=${sqlValue(started.runId)}, updated_at=${sqlValue(nowIso())}
            WHERE id=${sqlValue(reservationId)} AND request_hash=${sqlValue(requestHash)} AND status='pending'`,
      expectChanges: 1
    }]);
    return result(input, idempotencyKey, started.runId, String(started.run.status ?? "queued"), false);
  } catch (error) {
    runSqlTransaction([{ sql: `DELETE FROM portable_workflow_invocations WHERE id=${sqlValue(reservationId)} AND status='pending'` }]);
    throw error;
  }
}

function result(input: PortableLocalWorkflowStartInput, idempotencyKey: string, runId: string, status: string, replayed: boolean): PortableLocalWorkflowStartResult {
  return { runId, replayed, workflowId: input.workflowId, sourceTrigger: input.sourceTrigger, idempotencyKey, executionMode: "read_only", status };
}
