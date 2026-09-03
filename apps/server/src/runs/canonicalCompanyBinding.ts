export const CANONICAL_COMPANY_BINDING_SCHEMA_V1 = "automation_os_canonical_company_binding.v1" as const;

const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export type CanonicalCompanyBindingBlocker =
  | "portable_worker_company_scope_mismatch"
  | "canonical_company_scope_unknown"
  | null;

export type CanonicalCompanyBindingInput = {
  /** Fresh, owner-authorized source of the canonical company binding. */
  authorityCompanyId?: string | null;
  authorityFresh?: boolean;
  sourceCompanyId?: string | null;
  sourceFresh?: boolean;
  workerCompanyId?: string | null;
  workerFresh?: boolean;
  runtimeCompanyId?: string | null;
  runtimeFresh?: boolean;
  /** This guard never grants effect permission, even when false. */
  externalActionExecuted?: boolean;
};

export type CanonicalCompanyBindingResult = {
  schema: typeof CANONICAL_COMPANY_BINDING_SCHEMA_V1;
  status: "matched" | "mismatch" | "unknown";
  /** Null unless the fresh authority and every required observation agree. */
  canonicalScope: string | null;
  bindingMatch: boolean;
  externalActionAllowed: false;
  effectfulAdmissionAllowed: false;
  canaryAdmissionAllowed: false;
  externalActionExecuted: boolean;
  exactBlocker: CanonicalCompanyBindingBlocker;
  reason: string;
};

function normalizeCompanyId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return COMPANY_ID.test(normalized) ? normalized : null;
}

/**
 * Decide whether one fresh, owner-authorized company binding is proven.
 *
 * This is intentionally a pure observation guard. It does not select a
 * company by majority, recency, or process precedence, and it never grants
 * external-effect or canary admission. A matched result is only the binding
 * prerequisite for a separate canary/effect gate.
 */
export function evaluateCanonicalCompanyBinding(
  input: CanonicalCompanyBindingInput = {}
): CanonicalCompanyBindingResult {
  const authorityCompanyId = normalizeCompanyId(input.authorityCompanyId);
  const sourceCompanyId = normalizeCompanyId(input.sourceCompanyId);
  const workerCompanyId = normalizeCompanyId(input.workerCompanyId);
  const runtimeCompanyId = normalizeCompanyId(input.runtimeCompanyId);
  const externalActionExecuted = input.externalActionExecuted === true;

  const allRequiredObservationsFresh = input.authorityFresh === true
    && input.sourceFresh === true
    && input.workerFresh === true
    && input.runtimeFresh === true;
  const allRequiredCompanyIdsPresent = authorityCompanyId !== null
    && sourceCompanyId !== null
    && workerCompanyId !== null
    && runtimeCompanyId !== null;

  if (!allRequiredObservationsFresh || !allRequiredCompanyIdsPresent) {
    return Object.freeze({
      schema: CANONICAL_COMPANY_BINDING_SCHEMA_V1,
      status: "unknown",
      canonicalScope: null,
      bindingMatch: false,
      externalActionAllowed: false,
      effectfulAdmissionAllowed: false,
      canaryAdmissionAllowed: false,
      externalActionExecuted,
      exactBlocker: "canonical_company_scope_unknown",
      reason: "fresh owner-authorized authority and fresh source/worker/runtime company observations are required"
    });
  }

  const bindingMatch = sourceCompanyId === authorityCompanyId
    && workerCompanyId === authorityCompanyId
    && runtimeCompanyId === authorityCompanyId;

  if (!bindingMatch) {
    return Object.freeze({
      schema: CANONICAL_COMPANY_BINDING_SCHEMA_V1,
      status: "mismatch",
      canonicalScope: null,
      bindingMatch: false,
      externalActionAllowed: false,
      effectfulAdmissionAllowed: false,
      canaryAdmissionAllowed: false,
      externalActionExecuted,
      exactBlocker: "portable_worker_company_scope_mismatch",
      reason: "fresh source, worker, and runtime company observations do not all match the fresh authority company"
    });
  }

  return Object.freeze({
    schema: CANONICAL_COMPANY_BINDING_SCHEMA_V1,
    status: "matched",
    canonicalScope: authorityCompanyId,
    bindingMatch: true,
    externalActionAllowed: false,
    effectfulAdmissionAllowed: false,
    canaryAdmissionAllowed: false,
    externalActionExecuted,
    exactBlocker: null,
    reason: "fresh authority and source/worker/runtime company observations match; canary/effect admission remains separate"
  });
}
