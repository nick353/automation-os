import { initDb, makeId, nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { createHash } from "node:crypto";
import { hashIdempotencyRequest } from "../automations/idempotency.js";
import {
  fixedRegisteredWorkflows,
  getRegisteredWorkflowStartCommand,
  initRegisteredWorkflows,
  type RegisteredWorkflowRow
} from "../registeredWorkflows.js";
import { startCommandRun } from "./workerEngine.js";
import { PORTABLE_EXECUTION_SOURCE } from "./portableWorkerIsolation.js";
import {
  PORTABLE_WORKER_CANARY_MODE,
  PORTABLE_WORKER_EXTERNAL_MODE,
  portableWorkflowIdForWorkerAdapter
} from "./portableWorkflowWorker.js";
import {
  type PortableTrigger,
  type PortableWorkflowId
} from "./portableWorkflowContract.js";

export type PortableWorkflowStartInput = {
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  dueKey?: string;
  /**
   * Optional viewer/company scope for interactive starts. Global scheduler
   * starts intentionally omit it; App bridge starts must bind it so the run
   * is visible in the same company-scoped readback that accepted it.
   */
  companyId?: string | null;
};

export type PortableWorkflowStartResult = {
  runId: string;
  replayed: boolean;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  executionMode: typeof PORTABLE_WORKER_CANARY_MODE | typeof PORTABLE_WORKER_EXTERNAL_MODE;
  status?: string;
};

const portableTriggers = new Set<PortableTrigger>(["automation_os_scheduler", "automation_os_ui", "codex_app_bridge", "launchd", "github_actions"]);

export function isPortableWorkflowTrigger(value: string): value is PortableTrigger {
  return portableTriggers.has(value as PortableTrigger);
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function portableInvocationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const value = metadata.portable_workflow_invocation;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type PortableInvocationRow = {
  id: string;
  workflow_id: string;
  source_trigger: PortableTrigger;
  company_scope: string;
  company_id: string | null;
  idempotency_key: string;
  request_hash: string;
  status: "pending" | "completed";
  run_id: string | null;
};

type PortableInvocationReservation =
  | { kind: "owner"; reservationId: string }
  | { kind: "completed"; row: PortableInvocationRow };

const PORTABLE_GLOBAL_COMPANY_SCOPE = "__global__";
const PORTABLE_INVOCATION_WAIT_ATTEMPTS = 20;
const PORTABLE_INVOCATION_WAIT_MS = 100;

function normalizedCompanyId(input: PortableWorkflowStartInput): string | null {
  const value = typeof input.companyId === "string" ? input.companyId.trim() : input.companyId;
  return value || null;
}

function portableCompanyScope(companyId: string | null): string {
  return companyId ?? PORTABLE_GLOBAL_COMPANY_SCOPE;
}

function portableInvocationRequestHash(input: PortableWorkflowStartInput): string {
  return hashIdempotencyRequest({
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    company_id: normalizedCompanyId(input),
    due_key: input.dueKey ?? null,
    idempotency_key: input.idempotencyKey
  });
}

function readPortableInvocation(input: PortableWorkflowStartInput, requestHash: string): PortableInvocationRow | undefined {
  const companyId = normalizedCompanyId(input);
  const row = querySql<PortableInvocationRow>(`
    SELECT id, workflow_id, source_trigger, company_scope, company_id, idempotency_key,
           request_hash, status, run_id
    FROM portable_workflow_invocations
    WHERE workflow_id=${sqlValue(input.workflowId)}
      AND source_trigger=${sqlValue(input.sourceTrigger)}
      AND company_scope=${sqlValue(portableCompanyScope(companyId))}
      AND idempotency_key=${sqlValue(input.idempotencyKey)}
    LIMIT 1
  `)[0];
  if (row && row.request_hash !== requestHash) {
    throw new Error("portable_workflow_invocation_payload_conflict");
  }
  return row;
}

function portableWorkerExecutionMode(): typeof PORTABLE_WORKER_CANARY_MODE | typeof PORTABLE_WORKER_EXTERNAL_MODE {
  return process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE?.trim() === PORTABLE_WORKER_CANARY_MODE
    ? PORTABLE_WORKER_CANARY_MODE
    : PORTABLE_WORKER_EXTERNAL_MODE;
}

function resultFromRun(input: PortableWorkflowStartInput, idempotencyKey: string, run: { id: string; status: string }, replayed: boolean): PortableWorkflowStartResult {
  return {
    runId: run.id,
    replayed,
    workflowId: input.workflowId,
    sourceTrigger: input.sourceTrigger,
    idempotencyKey,
    executionMode: portableWorkerExecutionMode(),
    status: run.status
  };
}

function resultFromCompletedInvocation(input: PortableWorkflowStartInput, idempotencyKey: string, row: PortableInvocationRow): PortableWorkflowStartResult {
  if (!row.run_id) throw new Error("portable_workflow_invocation_run_missing");
  const run = querySql<{ id: string; status: string }>(
    `SELECT id, status FROM runs WHERE id=${sqlValue(row.run_id)} LIMIT 1`
  )[0];
  if (!run) throw new Error("portable_workflow_invocation_run_missing");
  return resultFromRun(input, idempotencyKey, run, true);
}

function findExistingPortableRun(input: PortableWorkflowStartInput): { id: string; status: string } | undefined {
  const companyId = normalizedCompanyId(input);
  const rows = querySql<{ id: string; status: string; company_id: string | null; metadata_json: string }>(`
    SELECT id, status, company_id, metadata_json
    FROM runs
    WHERE execution_source='${PORTABLE_EXECUTION_SOURCE}' AND quarantined=0
    ORDER BY created_at DESC
    LIMIT 500
  `);
  return rows.find((row) => {
    const invocation = portableInvocationMetadata(parseMetadata(row.metadata_json));
    const start = parseMetadata(row.metadata_json).registered_workflow_start;
    const startMetadata = start && typeof start === "object" && !Array.isArray(start)
      ? start as Record<string, unknown>
      : {};
    return invocation.workflow_id === input.workflowId
      && invocation.source_trigger === input.sourceTrigger
      && invocation.idempotency_key === input.idempotencyKey
      && row.company_id === companyId
      && (typeof startMetadata.dueKey === "string" ? startMetadata.dueKey : null) === (input.dueKey ?? null);
  });
}

async function waitForPortableInvocation(input: PortableWorkflowStartInput, requestHash: string, initial: PortableInvocationRow): Promise<PortableInvocationRow | null> {
  let current: PortableInvocationRow | undefined = initial;
  for (let attempt = 0; attempt < PORTABLE_INVOCATION_WAIT_ATTEMPTS; attempt += 1) {
    if (current.status === "completed") return current;
    const existingRun = findExistingPortableRun(input);
    if (existingRun) {
      runSqlTransaction([{
        sql: `UPDATE portable_workflow_invocations
              SET status='completed', run_id=${sqlValue(existingRun.id)}, updated_at=${sqlValue(nowIso())}
              WHERE id=${sqlValue(current.id)} AND request_hash=${sqlValue(requestHash)} AND status='pending'`,
        expectChanges: 1
      }]);
      return readPortableInvocation(input, requestHash) ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, PORTABLE_INVOCATION_WAIT_MS));
    current = readPortableInvocation(input, requestHash);
    if (!current) return null;
  }
  throw new Error("portable_workflow_invocation_pending");
}

async function reservePortableInvocation(input: PortableWorkflowStartInput, requestHash: string): Promise<PortableInvocationReservation> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = readPortableInvocation(input, requestHash);
    if (existing) {
      const resolved = await waitForPortableInvocation(input, requestHash, existing);
      if (resolved) {
        if (resolved.status !== "completed") throw new Error("portable_workflow_invocation_pending");
        return { kind: "completed", row: resolved };
      }
      continue;
    }
    const reservationId = makeId("portable_invocation");
    const companyId = normalizedCompanyId(input);
    try {
      runSqlTransaction([{
        sql: `INSERT INTO portable_workflow_invocations
              (id, workflow_id, source_trigger, company_scope, company_id, idempotency_key, request_hash, status, run_id, created_at, updated_at)
              VALUES (${sqlValue(reservationId)}, ${sqlValue(input.workflowId)}, ${sqlValue(input.sourceTrigger)},
                      ${sqlValue(portableCompanyScope(companyId))}, ${sqlValue(companyId)}, ${sqlValue(input.idempotencyKey)},
                      ${sqlValue(requestHash)}, 'pending', NULL, ${sqlValue(nowIso())}, ${sqlValue(nowIso())})`,
        expectChanges: 1
      }]);
      return { kind: "owner", reservationId };
    } catch (error) {
      const raced = readPortableInvocation(input, requestHash);
      if (!raced) throw error;
      const resolved = await waitForPortableInvocation(input, requestHash, raced);
      if (resolved) {
        if (resolved.status !== "completed") throw new Error("portable_workflow_invocation_pending");
        return { kind: "completed", row: resolved };
      }
    }
  }
  throw new Error("portable_workflow_invocation_pending");
}

function completePortableInvocation(reservationId: string, runId: string): void {
  runSqlTransaction([{
    sql: `UPDATE portable_workflow_invocations
          SET status='completed', run_id=${sqlValue(runId)}, updated_at=${sqlValue(nowIso())}
          WHERE id=${sqlValue(reservationId)} AND status='pending'`,
    expectChanges: 1
  }]);
}

function releasePortableInvocation(reservationId: string): void {
  runSqlTransaction([{
    sql: `DELETE FROM portable_workflow_invocations
          WHERE id=${sqlValue(reservationId)} AND status='pending'`
  }]);
}

function getPortableRegisteredWorkflow(workflowId: PortableWorkflowId): RegisteredWorkflowRow {
  const workflow = initRegisteredWorkflows().find((row) => row.id === workflowId);
  if (!workflow) throw new Error("portable_registered_workflow_missing");
  if (!fixedRegisteredWorkflows.some((fixed) => fixed.id === workflow.id && fixed.runnerKind === workflow.runner_kind)) {
    throw new Error("portable_registered_workflow_not_fixed");
  }
  if (workflow.company_id) throw new Error("portable_workflow_company_scope_unsupported");
  if (portableWorkflowIdForWorkerAdapter(workflow.runner_kind) !== workflowId) {
    throw new Error("portable_registered_runner_binding_mismatch");
  }
  return workflow;
}

export async function startPortableWorkflowRun(input: PortableWorkflowStartInput): Promise<PortableWorkflowStartResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("portable_idempotency_key_required");
  if (!isPortableWorkflowTrigger(input.sourceTrigger)) throw new Error("portable_source_trigger_invalid");
  initDb();
  const workflow = getPortableRegisteredWorkflow(input.workflowId);
  const normalizedInput = { ...input, idempotencyKey };
  const requestHash = portableInvocationRequestHash(normalizedInput);
  const stored = readPortableInvocation(normalizedInput, requestHash);
  if (stored?.status === "completed") return resultFromCompletedInvocation(normalizedInput, idempotencyKey, stored);
  const existing = findExistingPortableRun(normalizedInput);
  if (existing) {
    return resultFromRun(normalizedInput, idempotencyKey, existing, true);
  }
  const command = getRegisteredWorkflowStartCommand(workflow.id);
  if (!command) throw new Error("portable_registered_start_command_missing");
  const source = input.sourceTrigger === "automation_os_scheduler" ? "scheduler" as const : "manual" as const;
  // Fixed workflows are always handed to the portable external worker unless
  // canary is explicitly requested.  An unset server mode must not re-enable
  // the legacy per-workflow runner; the external worker still enforces its
  // approval and effect-policy gates before invoking Browser Use CLI.
  const portableWorkerMode = portableWorkerExecutionMode();
  const queuedAt = nowIso();
  const reservation = await reservePortableInvocation(normalizedInput, requestHash);
  if (reservation.kind === "completed") return resultFromCompletedInvocation(normalizedInput, idempotencyKey, reservation.row);
  try {
    const result = await startCommandRun(command, {
      deferWorker: true,
      ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
      metadata: {
      registeredWorkflowId: workflow.id,
      registered_workflow_id: workflow.id,
      workflowId: workflow.id,
      workflow_id: workflow.id,
      registered_workflow_start: {
        source,
        runnerKind: workflow.runner_kind,
        workflow_id: workflow.id,
        definition_fingerprint: hashRegisteredWorkflowDefinition(workflow),
        schedule_fingerprint: hashRegisteredWorkflowSchedule(workflow),
        ...(input.dueKey ? { dueKey: input.dueKey } : {}),
        portable: true
      },
      portable_workflow_invocation: {
        schema: "automation_os_portable_workflow_invocation_v1",
        workflow_id: input.workflowId,
        source_trigger: input.sourceTrigger,
        idempotency_key: idempotencyKey,
        app_dependency: false,
        external_action_executed: false
      },
      portable_worker: {
        ...(portableWorkerMode ? { mode: portableWorkerMode } : {}),
        workflow_id: workflow.id,
        external_adapter_configured: Boolean(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER?.trim()),
        external_action_executed: false
      },
      worker_protocol: "mac_worker_polling_required",
      worker_mode: "queued_for_mac_worker",
      worker_loop: {
        status: "waiting_for_pickup",
        launchReason: "portable_workflow_entrypoint",
        queuedAt,
        requiredCommand: "npm run worker:loop:stored"
      },
      mac_worker: {
        status: "waiting_for_pickup",
        launchReason: "portable_workflow_entrypoint",
        queuedAt,
        requiredCommand: "npm run worker:loop:stored"
      }
      }
    });
    completePortableInvocation(reservation.reservationId, result.runId);
    return resultFromRun(normalizedInput, idempotencyKey, { id: result.runId, status: String(result.run.status ?? "queued") }, false);
  } catch (error) {
    releasePortableInvocation(reservation.reservationId);
    throw error;
  }
}

function hashRegisteredWorkflowDefinition(workflow: RegisteredWorkflowRow): string {
  return createHash("sha256").update(JSON.stringify({
    id: workflow.id,
    status: workflow.status,
    runner_kind: workflow.runner_kind,
    start_command_json: workflow.start_command_json,
    source_refs_json: workflow.source_refs_json,
    provenance_json: workflow.provenance_json
  })).digest("hex");
}

function hashRegisteredWorkflowSchedule(workflow: RegisteredWorkflowRow): string {
  return createHash("sha256").update(JSON.stringify({ schedule_json: workflow.schedule_json })).digest("hex");
}
