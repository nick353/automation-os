import { execSql, nowIso, querySql, sqlValue } from "../db/client.js";

export const PORTABLE_EXECUTION_SOURCE = "automation-os" as const;

export type PortableRunIsolationRow = {
  id: string;
  status: string;
  execution_source: string;
  quarantined: number;
  readback_proof_id: string | null;
  metadata_json: string;
};

export type QuarantineResult = {
  requested: string[];
  quarantined: string[];
  skipped: string[];
};

export function listClaimablePortableRuns(limit = 100): PortableRunIsolationRow[] {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return querySql<PortableRunIsolationRow>(`
    SELECT id, status, execution_source, quarantined, readback_proof_id, metadata_json
    FROM runs
    WHERE status IN ('queued', 'running', 'waiting_approval')
      AND execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)}
      AND quarantined=0
    ORDER BY created_at ASC, id ASC
    LIMIT ${boundedLimit}
  `);
}

export function quarantineLegacyRuns(runIds: readonly string[]): QuarantineResult {
  const requested = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) throw new Error("portable_quarantine_run_ids_required");
  const rows = querySql<PortableRunIsolationRow>(`
    SELECT id, status, execution_source, quarantined, readback_proof_id, metadata_json
    FROM runs
    WHERE id IN (${requested.map((id) => sqlValue(id)).join(", ")})
  `);
  const found = new Set(rows.map((row) => row.id));
  const skipped = requested.filter((id) => !found.has(id));
  const quarantined = rows.filter((row) => row.quarantined === 0 && row.status !== "completed" && row.status !== "cancelled").map((row) => row.id);
  for (const runId of quarantined) {
    const timestamp = nowIso();
    const current = rows.find((row) => row.id === runId)!;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(current.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = { portable_metadata_parse_error: true };
    }
    execSql(`
      UPDATE runs
      SET execution_source='legacy', quarantined=1, readback_proof_id=NULL,
          metadata_json=${sqlValue({
            ...metadata,
            portable_quarantine: {
              schema: "automation_os_portable_quarantine.v1",
              reason: "pre_migration_queued_run",
              quarantined_at: timestamp,
              external_action_executed: false
            }
          })}, updated_at=${sqlValue(timestamp)}
      WHERE id=${sqlValue(runId)} AND quarantined=0
    `);
  }
  return { requested, quarantined, skipped: [...skipped, ...rows.filter((row) => row.quarantined !== 0 || row.status === "completed" || row.status === "cancelled").map((row) => row.id)] };
}

export function attachPortableReadbackProof(runId: string, proofId: string): void {
  if (!runId.trim() || !proofId.trim()) throw new Error("portable_readback_proof_binding_required");
  const changed = querySql<{ id: string }>(`SELECT id FROM runs WHERE id=${sqlValue(runId)} AND execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)} AND quarantined=0 LIMIT 1`);
  if (changed.length !== 1) throw new Error("portable_readback_run_not_claimable");
  execSql(`UPDATE runs SET readback_proof_id=${sqlValue(proofId)}, updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(runId)} AND execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)} AND quarantined=0`);
}
