import { listRegisteredAutomationCatalog, type RegisteredAutomationCatalogEntry } from "./registeredCatalog.js";
import { fixedRegisteredWorkflows } from "../registeredWorkflows.js";

export const CANONICAL_AUTOMATION_REGISTRY_SCHEMA = "aos.canonical_automation_registry.v1" as const;
export const CANONICAL_COMPANY_ID = "company_2560580981cedfd106b66245" as const;
/**
 * Project A is the stable UI-facing scope for the Google-owned AOS project.
 * Runtime workers intentionally use the canonical Company 1 id instead.  Keep
 * this allow-list explicit and tiny; arbitrary company ids must never be
 * silently rewritten into the production worker scope.
 */
export const CANONICAL_COMPANY_SCOPE_ALIASES = Object.freeze({
  "project-a": CANONICAL_COMPANY_ID
} as const);

export type CanonicalCompanyScopeResolution = {
  requestedCompanyId: string | null;
  executionCompanyId: string | null;
  alias: keyof typeof CANONICAL_COMPANY_SCOPE_ALIASES | null;
};

export function resolveCanonicalCompanyScope(companyId?: string | null): CanonicalCompanyScopeResolution {
  const requestedCompanyId = typeof companyId === "string" ? companyId.trim() || null : null;
  if (!requestedCompanyId) {
    return { requestedCompanyId: null, executionCompanyId: null, alias: null };
  }
  const alias = Object.prototype.hasOwnProperty.call(CANONICAL_COMPANY_SCOPE_ALIASES, requestedCompanyId)
    ? requestedCompanyId as keyof typeof CANONICAL_COMPANY_SCOPE_ALIASES
    : null;
  return {
    requestedCompanyId,
    executionCompanyId: alias ? CANONICAL_COMPANY_SCOPE_ALIASES[alias] : requestedCompanyId,
    alias
  };
}

export type CanonicalAutomationRegistryItem = {
  id: string;
  source: "protected_postgres_catalog" | "execution_lane" | "codex_heartbeat";
  plane: "catalog" | "adapter" | "heartbeat";
  companyId: string;
  name: string;
  schedule: {
    kind: "daily" | "weekly";
    expression: string;
    timezone: "Asia/Tokyo";
  };
  entry: {
    sourceAutomationId: string | null;
    workerCommandKind: string;
    readOnlyDefault: true;
  };
  effect: {
    externalActionDefault: false;
    executedInThisReadback: false;
  };
  catalog?: RegisteredAutomationCatalogEntry;
  adapter?: {
    runnerKind: string;
    projectRoot: string;
    scheduleRrule: string;
    runnerStatus: string;
  };
};

export type CanonicalAutomationRegistryReadback = {
  schema: typeof CANONICAL_AUTOMATION_REGISTRY_SCHEMA;
  authority: "protected_postgres_catalog_plus_codex_heartbeat";
  companyId: string;
  requestedCompanyId: string;
  companyScopeAlias: CanonicalCompanyScopeResolution["alias"];
  status: "ok" | "blocked";
  items: CanonicalAutomationRegistryItem[];
  conflicts: Array<{ id: string; plane: CanonicalAutomationRegistryItem["plane"]; reason: string }>;
  executionLaneAdapters: string[];
  promotedToRuntimeRegistry: boolean;
  externalActionExecuted: false;
};

function runtimeRegistryPromotionEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on|enabled)$/iu.test(
    String(environment.AUTOMATION_OS_REGISTERED_WORKFLOW_RUNS_ENABLED ?? "").trim(),
  );
}

const companyBriefHeartbeat: Omit<CanonicalAutomationRegistryItem, "companyId"> = {
  id: "aos-morning-brief",
  source: "codex_heartbeat",
  plane: "heartbeat",
  name: "AOS Company Brief",
  schedule: { kind: "daily", expression: "07:45, 21:45", timezone: "Asia/Tokyo" },
  entry: { sourceAutomationId: null, workerCommandKind: "company_brief_heartbeat", readOnlyDefault: true },
  effect: { externalActionDefault: false, executedInThisReadback: false }
};

export function buildCanonicalAutomationRegistryReadback(
  companyId: string = CANONICAL_COMPANY_ID
): CanonicalAutomationRegistryReadback {
  const scope = resolveCanonicalCompanyScope(companyId);
  const executionCompanyId = scope.executionCompanyId ?? CANONICAL_COMPANY_ID;
  const catalogItems = listRegisteredAutomationCatalog().map((catalog) => ({
    id: catalog.canonicalWorkflowId,
    source: "protected_postgres_catalog" as const,
    plane: "catalog" as const,
    companyId: executionCompanyId,
    name: catalog.name,
    schedule: catalog.schedule,
    entry: {
      sourceAutomationId: catalog.sourceAutomationId,
      workerCommandKind: catalog.workerCommandKind,
      readOnlyDefault: true as const
    },
    effect: { externalActionDefault: false as const, executedInThisReadback: false as const },
    catalog
  }));

  const catalogIds = new Set(catalogItems.map((item) => item.id));
  const conflicts: CanonicalAutomationRegistryReadback["conflicts"] = [];
  const catalogSeen = new Set<string>();
  for (const item of catalogItems) {
    if (catalogSeen.has(item.id)) conflicts.push({ id: item.id, plane: "catalog", reason: "duplicate_canonical_catalog_definition" });
    catalogSeen.add(item.id);
  }
  const adapterItems = fixedRegisteredWorkflows
    .filter((workflow) => !catalogIds.has(workflow.id))
    .map((workflow) => ({
      id: workflow.id,
      source: "execution_lane" as const,
      plane: "adapter" as const,
      companyId: executionCompanyId,
      name: workflow.name,
      schedule: {
        kind: "daily" as const,
        expression: workflow.schedule.rrule,
        timezone: "Asia/Tokyo" as const
      },
      entry: {
        sourceAutomationId: workflow.provenance.legacyAutomationId ?? workflow.id,
        workerCommandKind: workflow.runnerKind,
        readOnlyDefault: true as const
      },
      effect: { externalActionDefault: false as const, executedInThisReadback: false as const },
      adapter: {
        runnerKind: workflow.runnerKind,
        projectRoot: workflow.projectRoot,
        scheduleRrule: workflow.schedule.rrule,
        runnerStatus: workflow.runnerStatus
      }
    }));

  return {
    schema: CANONICAL_AUTOMATION_REGISTRY_SCHEMA,
    authority: "protected_postgres_catalog_plus_codex_heartbeat",
    companyId: executionCompanyId,
    requestedCompanyId: scope.requestedCompanyId ?? executionCompanyId,
    companyScopeAlias: scope.alias,
    status: conflicts.length === 0 ? "ok" : "blocked",
    items: [...catalogItems, ...adapterItems, { ...companyBriefHeartbeat, companyId: executionCompanyId }],
    conflicts,
    executionLaneAdapters: [
      "daily-ai-research-publish-run",
      "nisenprints-daily-product-canva-printify-etsy-pinterest",
      "job-application-manager",
      "prompt-transfer-ukiyoe",
      "sns-multi-poster-ukiyoe",
      "x-authenticated-browser-lane"
    ],
    // Promotion here means that the canonical catalog is admitted to the
    // runtime's registered-run gate. It does not execute an external action;
    // the downstream workflow approval and receipt boundary remains intact.
    promotedToRuntimeRegistry: runtimeRegistryPromotionEnabled(),
    externalActionExecuted: false
  };
}

/**
 * Resolve the one canonical registration used by runtime admission.  The
 * catalog is authoritative when a workflow has both a catalog record and an
 * execution-lane adapter; the adapter is only a fallback for adapter-only
 * lanes.  Duplicate catalog definitions fail closed instead of being
 * silently hidden by a Set.
 */
export function resolveCanonicalAutomationRegistration(input: {
  companyId?: string;
  workflowId: string;
}): CanonicalAutomationRegistryItem {
  const scope = resolveCanonicalCompanyScope(input.companyId ?? CANONICAL_COMPANY_ID);
  if (scope.executionCompanyId !== CANONICAL_COMPANY_ID) throw new Error("canonical_automation_company_scope_invalid");
  const readback = buildCanonicalAutomationRegistryReadback(CANONICAL_COMPANY_ID);
  if (readback.status !== "ok") throw new Error("canonical_automation_registry_conflict");
  const item = readback.items.find((candidate) => candidate.id === input.workflowId);
  if (!item) throw new Error("canonical_automation_workflow_unknown");
  return item;
}
