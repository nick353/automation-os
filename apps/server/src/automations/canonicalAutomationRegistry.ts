import { listRegisteredAutomationCatalog, type RegisteredAutomationCatalogEntry } from "./registeredCatalog.js";

export const CANONICAL_AUTOMATION_REGISTRY_SCHEMA = "aos.canonical_automation_registry.v1" as const;
export const CANONICAL_COMPANY_ID = "company_2560580981cedfd106b66245" as const;

export type CanonicalAutomationRegistryItem = {
  id: string;
  source: "protected_postgres_catalog" | "codex_heartbeat";
  plane: "catalog" | "heartbeat";
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
};

export type CanonicalAutomationRegistryReadback = {
  schema: typeof CANONICAL_AUTOMATION_REGISTRY_SCHEMA;
  authority: "protected_postgres_catalog_plus_codex_heartbeat";
  companyId: string;
  status: "ok";
  items: CanonicalAutomationRegistryItem[];
  executionLaneAdapters: string[];
  promotedToRuntimeRegistry: false;
  externalActionExecuted: false;
};

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
  const catalogItems = listRegisteredAutomationCatalog().map((catalog) => ({
    id: catalog.canonicalWorkflowId,
    source: "protected_postgres_catalog" as const,
    plane: "catalog" as const,
    companyId,
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

  return {
    schema: CANONICAL_AUTOMATION_REGISTRY_SCHEMA,
    authority: "protected_postgres_catalog_plus_codex_heartbeat",
    companyId,
    status: "ok",
    items: [...catalogItems, { ...companyBriefHeartbeat, companyId }],
    executionLaneAdapters: [
      "daily-ai-research-publish-run",
      "nisenprints-daily-product-canva-printify-etsy-pinterest",
      "job-application-manager",
      "prompt-transfer-ukiyoe",
      "sns-multi-poster-ukiyoe",
      "x-authenticated-browser-lane"
    ],
    promotedToRuntimeRegistry: false,
    externalActionExecuted: false
  };
}
