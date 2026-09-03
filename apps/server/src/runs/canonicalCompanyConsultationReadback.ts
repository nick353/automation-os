import { readCompanyBindingReconciliationV1 } from "./companyBindingReconciliationReadback.js";
import { buildCanonicalCompanyConsultationV1 } from "./canonicalCompanyConsultation.js";
import type { CompanyBindingReconciliationReport } from "./companyBindingReconciliation.js";

export function buildCanonicalCompanyConsultationFromReconciliation(
  reconciliation: CompanyBindingReconciliationReport,
  companyId?: string | null
) {
  const normalizedCompanyId = companyId?.trim() || reconciliation.requested_company_id || "all";
  return buildCanonicalCompanyConsultationV1({
    reconciliation,
    snapshot: {
      snapshot_id: `company-binding-reconciliation:${normalizedCompanyId}:${reconciliation.generated_at}`,
      captured_at: reconciliation.generated_at,
      provenance: "aos_control_plane_company_binding_reconciliation_readonly_readback",
      fresh: true
    }
  });
}

/**
 * Build the Chat consultation projection from one fresh company-binding
 * reconciliation readback. No second source, mutation, provider call, or
 * schedule admission is performed here.
 */
export async function readCanonicalCompanyConsultationV1(options: {
  now?: string;
  companyId?: string | null;
  triggerCompanyId?: string | null;
  automationRoot?: string;
} = {}) {
  const reconciliation = await readCompanyBindingReconciliationV1(options);
  return buildCanonicalCompanyConsultationFromReconciliation(reconciliation, options.companyId);
}

export const canonicalCompanyConsultationReadbackMetadata = {
  read_only: true,
  external_action_executed: false
} as const;
