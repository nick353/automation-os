export const VERSIONED_ADAPTER_SCHEMA_V1 = "automation_os_versioned_route_adapter.v1" as const;
export type VersionedAdapterV1 = { schema: typeof VERSIONED_ADAPTER_SCHEMA_V1; adapter_id: string; version: string; supported_routes: readonly string[]; known_constraints: readonly string[]; rollback_to: string; isolation_scope: "adapter_only" };
export const versionedAdapters: readonly VersionedAdapterV1[] = [
  "linkedin", "greenhouse", "lever", "workable", "ashby", "hrmos", "smartrecruiters", "workday", "company_form"
].map((adapter_id) => ({ schema: VERSIONED_ADAPTER_SCHEMA_V1, adapter_id, version: "1.0.0", supported_routes: [adapter_id], known_constraints: ["semantic_resolution_only", "unknown_required_fact_fail_closed", "visible_confirmation_required_for_effect"], rollback_to: "previous_verified_version", isolation_scope: "adapter_only" as const }));

export function anonymizeRouteLearning(input: { adapterId: string; route: string; labels: readonly string[]; roles: readonly string[] }): { schema: "automation_os_route_learning.v1"; adapter_id: string; route_digest: string; label_digests: string[]; role_digests: string[]; reused_authority: false; reused_target: false; reused_receipt: false; reused_approval: false } {
  const digest = (value: string) => { let hash = 0; for (const char of value) hash = ((hash << 5) - hash + char.codePointAt(0)!) | 0; return Math.abs(hash).toString(16); };
  return { schema: "automation_os_route_learning.v1", adapter_id: input.adapterId, route_digest: digest(input.route), label_digests: input.labels.map(digest), role_digests: input.roles.map(digest), reused_authority: false, reused_target: false, reused_receipt: false, reused_approval: false };
}
