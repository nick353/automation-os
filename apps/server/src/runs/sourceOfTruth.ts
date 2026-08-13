import { dbBackend } from "../db/client.js";

export const SOURCE_OF_TRUTH_SCHEMA_V1 = "automation_os_source_of_truth.v1" as const;
export type SourceOfTruthV1 = { schema: typeof SOURCE_OF_TRUTH_SCHEMA_V1; kind: "production_aos" | "local_aos" | "remote_aos_worker"; backend: "postgres" | "sqlite" | "queue"; company_id: string; run_id: string; authoritative: true; mixed_source_forbidden: true; exact_blocker: string | null };

export function declareSourceOfTruth(input: { kind: SourceOfTruthV1["kind"]; companyId: string; runId: string; backend?: SourceOfTruthV1["backend"] }): SourceOfTruthV1 {
  const backend = input.backend ?? (input.kind === "remote_aos_worker" ? "queue" : dbBackend);
  const validProduction = input.kind === "production_aos" && backend === "postgres";
  return { schema: SOURCE_OF_TRUTH_SCHEMA_V1, kind: input.kind, backend, company_id: input.companyId, run_id: input.runId, authoritative: true, mixed_source_forbidden: true, exact_blocker: validProduction || input.kind !== "production_aos" ? null : "production_aos_requires_postgres_source_of_truth" };
}
