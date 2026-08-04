export const PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1 = "automation_os_portable_workflow_manifest_v1" as const;
export const PORTABLE_RUN_MANIFEST_SCHEMA_V1 = "automation_os_portable_run_manifest_v1" as const;

export type PortableWorkflowId =
  | "job-application-manager"
  | "daily-ai-research-publish-run"
  | "nisenprints-daily-product-canva-printify-etsy-pinterest"
  | "prompt-transfer-ukiyoe"
  | "sns-multi-poster-ukiyoe"
  | "x-authenticated-browser-lane";

export type PortableTrigger = "automation_os_scheduler" | "automation_os_ui" | "codex_app_bridge" | "launchd" | "github_actions";
export type PortableExternalEffectPolicy = "disabled" | "approval_required";

export type PortableWorkflowManifestV1 = {
  schema: typeof PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1;
  workflow_id: PortableWorkflowId;
  version: 1;
  name: string;
  schedule: {
    rrule: string;
    timezone: string;
  };
  execution: {
    backend: "automation_os_worker";
    browser_surface: "browser_use_cli";
    connector_gateway: "mcp";
    app_dependency: false;
  };
  stages: string[];
  external_effect_policy: PortableExternalEffectPolicy;
  source_refs: string[];
};

export type PortableRunManifestV1 = {
  schema: typeof PORTABLE_RUN_MANIFEST_SCHEMA_V1;
  run_id: string;
  workflow_id: PortableWorkflowId;
  source_trigger: PortableTrigger;
  execution_backend: "automation_os_worker";
  idempotency_key: string;
  external_action_allowed: false;
  app_dependency: false;
};

export type PortableCanaryReceiptV1 = {
  schema: "automation_os_portable_canary_receipt_v1";
  run_id: string;
  workflow_id: PortableWorkflowId;
  status: "completed";
  stages: Array<"manifest_validation" | "run_binding" | "readback" | "cleanup">;
  browser_started: false;
  connector_called: false;
  external_action_executed: false;
  exact_blocker: null;
};

const forbiddenKeys = new Set([
  "controller_identity",
  "first_class_root",
  "registered_run_token",
  "app_thread_id",
  "app_task_id",
  "codex_turn_id",
  "codex_session_id"
]);
const secretKeyPattern = /(token|cookie|password|secret|authorization|storagestate|storage_state)/i;

function fail(reason: string): never {
  throw new Error(`portable_workflow_contract_invalid:${reason}`);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) fail(`${field}_invalid`);
  return value;
}

function inspectKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) inspectKeys(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) fail(`${key}_forbidden`);
    if (secretKeyPattern.test(key)) fail(`${key}_forbidden`);
    inspectKeys(child);
  }
}

export function validatePortableWorkflowManifestV1(value: PortableWorkflowManifestV1): PortableWorkflowManifestV1 {
  inspectKeys(value);
  if (value.schema !== PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1) fail("schema_invalid");
  if (value.version !== 1) fail("version_invalid");
  identifier(value.workflow_id, "workflow_id");
  if (!value.name.trim()) fail("name_empty");
  if (!value.schedule.rrule.trim() || !value.schedule.timezone.trim()) fail("schedule_invalid");
  if (value.execution.backend !== "automation_os_worker") fail("backend_invalid");
  if (value.execution.browser_surface !== "browser_use_cli") fail("browser_surface_invalid");
  if (value.execution.connector_gateway !== "mcp") fail("connector_gateway_invalid");
  if (value.execution.app_dependency !== false) fail("app_dependency_invalid");
  if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.some((stage) => !stage.trim())) {
    fail("stages_invalid");
  }
  if (value.external_effect_policy !== "disabled" && value.external_effect_policy !== "approval_required") {
    fail("external_effect_policy_invalid");
  }
  if (!Array.isArray(value.source_refs) || value.source_refs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    fail("source_refs_invalid");
  }
  return value;
}

export function validatePortableRunManifestV1(value: PortableRunManifestV1): PortableRunManifestV1 {
  inspectKeys(value);
  if (value.schema !== PORTABLE_RUN_MANIFEST_SCHEMA_V1) fail("run_schema_invalid");
  identifier(value.run_id, "run_id");
  identifier(value.workflow_id, "workflow_id");
  if (!["automation_os_scheduler", "automation_os_ui", "codex_app_bridge", "launchd", "github_actions"].includes(value.source_trigger)) {
    fail("source_trigger_invalid");
  }
  if (value.execution_backend !== "automation_os_worker") fail("run_backend_invalid");
  if (!value.idempotency_key.trim()) fail("idempotency_key_empty");
  if (value.external_action_allowed !== false) fail("external_action_allowed_invalid");
  if (value.app_dependency !== false) fail("run_app_dependency_invalid");
  return value;
}

export function createPortableRunManifestV1(input: {
  runId: string;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
}): PortableRunManifestV1 {
  return validatePortableRunManifestV1({
    schema: PORTABLE_RUN_MANIFEST_SCHEMA_V1,
    run_id: input.runId,
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    execution_backend: "automation_os_worker",
    idempotency_key: input.idempotencyKey,
    external_action_allowed: false,
    app_dependency: false
  });
}

export const portableWorkflowManifests: Record<PortableWorkflowId, PortableWorkflowManifestV1> = {
  "job-application-manager": {
    schema: PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1,
    workflow_id: "job-application-manager",
    version: 1,
    name: "求人応募管理",
    schedule: { rrule: "RRULE:FREQ=WEEKLY;BYHOUR=7;BYMINUTE=30;BYDAY=SU,MO,TU,WE,TH,FR,SA", timezone: "Asia/Tokyo" },
    execution: { backend: "automation_os_worker", browser_surface: "browser_use_cli", connector_gateway: "mcp", app_dependency: false },
    stages: ["mail_intake", "job_discovery", "candidate_review", "external_submit"],
    external_effect_policy: "approval_required",
    source_refs: ["/Users/nichikatanaka/.codex/automations/automation-3/automation.toml", "job-application-manager-automation"]
  },
  "daily-ai-research-publish-run": {
    schema: PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1,
    workflow_id: "daily-ai-research-publish-run",
    version: 1,
    name: "Daily AI Research + Publish Run",
    schedule: { rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", timezone: "Asia/Tokyo" },
    execution: { backend: "automation_os_worker", browser_surface: "browser_use_cli", connector_gateway: "mcp", app_dependency: false },
    stages: ["research", "draft", "approval", "external_publish"],
    external_effect_policy: "approval_required",
    source_refs: ["/Users/nichikatanaka/.codex/automations/daily-ai-research-publish-run/automation.toml", "daily-ai-research-publish-run"]
  },
  "nisenprints-daily-product-canva-printify-etsy-pinterest": {
    schema: PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1,
    workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    version: 1,
    name: "NisenPrints Daily Product + Canva + Printify + Etsy + Pinterest",
    schedule: { rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30;BYSECOND=0", timezone: "Asia/Tokyo" },
    execution: { backend: "automation_os_worker", browser_surface: "browser_use_cli", connector_gateway: "mcp", app_dependency: false },
    stages: ["product_prepare", "asset_prepare", "approval", "external_publish"],
    external_effect_policy: "approval_required",
    source_refs: ["/Users/nichikatanaka/.codex/automations/nisenprints-daily-product-canva-printify-etsy-pinterest/automation.toml", "etsy-pinterest-poster"]
  },
  "prompt-transfer-ukiyoe": {
    schema: PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1,
    workflow_id: "prompt-transfer-ukiyoe",
    version: 1,
    name: "Prompt Transfer Ukiyoe",
    schedule: { rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=45;BYSECOND=0", timezone: "Asia/Tokyo" },
    execution: { backend: "automation_os_worker", browser_surface: "browser_use_cli", connector_gateway: "mcp", app_dependency: false },
    stages: ["prompt_read", "sheets_write", "readback"],
    external_effect_policy: "approval_required",
    source_refs: ["prompt-transfer-ukiyoe", "prompt-transfer"]
  },
  "sns-multi-poster-ukiyoe": {
    schema: PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1,
    workflow_id: "sns-multi-poster-ukiyoe",
    version: 1,
    name: "SNS Multi Poster Ukiyoe",
    schedule: { rrule: "FREQ=DAILY;BYHOUR=18;BYMINUTE=0;BYSECOND=0", timezone: "Asia/Tokyo" },
    execution: { backend: "automation_os_worker", browser_surface: "browser_use_cli", connector_gateway: "mcp", app_dependency: false },
    stages: ["content_prepare", "approval", "external_post", "readback"],
    external_effect_policy: "approval_required",
    source_refs: ["sns-multi-poster-ukiyoe", "sns-multi-poster"]
  },
  "x-authenticated-browser-lane": {
    schema: PORTABLE_WORKFLOW_MANIFEST_SCHEMA_V1,
    workflow_id: "x-authenticated-browser-lane",
    version: 1,
    name: "X Authenticated Browser Lane",
    schedule: { rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0", timezone: "Asia/Tokyo" },
    execution: { backend: "automation_os_worker", browser_surface: "browser_use_cli", connector_gateway: "mcp", app_dependency: false },
    stages: ["authenticated_read", "approval", "external_post", "readback"],
    external_effect_policy: "approval_required",
    source_refs: ["automation-os:native:x-authenticated-browser-lane"]
  }
};

for (const manifest of Object.values(portableWorkflowManifests)) validatePortableWorkflowManifestV1(manifest);
