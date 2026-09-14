import { makeId, nowIso, querySqlAsync, sqlValue } from "../db/client.js";
import { createAutomationRecordAsync, getAutomationRecordAsync, listAutomationRecordsAsync } from "../automations/repository.js";
import { runIdempotentSqlMutationAsync } from "../automations/idempotency.js";
import { getCreatePlannerJobAsync } from "./createPlannerJobs.js";
import { portableChatWorkflowRunId, startPortableLocalWorkflowRun } from "../runs/portableLocalWorkflowEntrypoint.js";
import { CHAT_WORKFLOW_BINDING_SCHEMA, chatWorkflowDraftDefinition, chatWorkflowOptions, chatWorkflowRequest,
  type ChatWorkflowAction, type ChatWorkflowOption } from "./chatWorkflowPlan.js";
import type { AutomationDefinitionInput } from "../automations/contracts.js";
import type { PortableLocalBusinessAdmission } from "../runs/portableLocalWorkflow.js";
import { DAILY_AI_RESEARCH_SYNC_WORKFLOW, prepareDailyAiResearchSyncAdmission } from "../runs/dailyAiResearchSourceSync.js";

type Scope = { companyId: string; actorUserId: string; jobId: string };
type Binding = Record<string, unknown> & {
  schema: typeof CHAT_WORKFLOW_BINDING_SCHEMA;
  binding_id: string;
  job_id: string;
  company_id: string;
  action: ChatWorkflowAction;
  selected: ChatWorkflowOption;
  prompt_sha256: string;
  created_at: string;
  draft_definition: AutomationDefinitionInput | null;
  business_admission?: PortableLocalBusinessAdmission | null;
};

async function readContext(input: Scope) {
  const job = await getCreatePlannerJobAsync(input.jobId);
  if (!job) throw new Error("chat_workflow_job_not_found");
  const request = chatWorkflowRequest(job, input.companyId, input.actorUserId);
  const automations = await listAutomationRecordsAsync(input.companyId);
  return { job, request, automations, options: chatWorkflowOptions(request, automations) };
}

export async function readChatWorkflowActions(input: Scope) {
  const context = await readContext(input);
  const records = await querySqlAsync<{ response_json: string }>(
    `SELECT response_json FROM mvp_idempotency_keys WHERE company_id=${sqlValue(input.companyId)}
       AND scope=${sqlValue(`chat:workflow:${input.jobId}`)} AND status='completed' ORDER BY created_at`
  );
  const actions = [];
  for (const record of records) {
    const binding = JSON.parse(record.response_json) as Binding;
    if (binding.schema === CHAT_WORKFLOW_BINDING_SCHEMA && binding.job_id === input.jobId && binding.company_id === input.companyId) {
      actions.push(await readBoundResult(binding, true));
    }
  }
  return { schema: "aos.chat_workflow_options.v1", job_id: input.jobId, company_id: input.companyId,
    prompt_sha256: context.request.prompt_sha256, options: context.options, actions,
    exact_blocker: context.request.exact_blocker ?? (context.options.length ? null : "chat_workflow_current_registration_unavailable"),
    external_action_executed: false };
}

export async function executeChatWorkflowAction(input: Scope & {
  action: ChatWorkflowAction;
  automationId: string;
  expectedRevision: number;
  definitionSha256: string;
  idempotencyKey: string;
}) {
  if (input.action !== "run_once" && input.action !== "save_draft") throw new Error("chat_workflow_action_invalid");
  if (input.idempotencyKey !== `chat-workflow-${input.jobId}-${input.action}`) throw new Error("chat_workflow_idempotency_binding_invalid");
  const { job, request, automations, options } = await readContext(input);
  const selected = options.find((option) => option.automation_id === input.automationId);
  if (!selected) throw new Error(request.exact_blocker ?? "chat_workflow_selected_registration_unavailable");
  if (selected.automation_revision !== input.expectedRevision || selected.definition_sha256 !== input.definitionSha256) {
    throw new Error("chat_workflow_registration_changed_read_again");
  }
  if (input.action === "run_once" && !selected.can_run_once) throw new Error(selected.manual_blocker ?? "chat_workflow_run_not_requested");
  if (input.action === "save_draft" && !selected.can_save_draft) throw new Error("chat_workflow_draft_not_requested");
  const source = automations.find((automation) => automation.id === selected.automation_id)!;
  const candidate: Binding = { schema: CHAT_WORKFLOW_BINDING_SCHEMA, binding_id: makeId("chat_workflow_binding"),
    job_id: job.id, company_id: input.companyId, action: input.action, selected,
    prompt_sha256: request.prompt_sha256, created_at: nowIso(),
    draft_definition: input.action === "save_draft" ? chatWorkflowDraftDefinition(job, source, selected, request) : null };
  if (input.action === "run_once" && selected.workflow_id === DAILY_AI_RESEARCH_SYNC_WORKFLOW) {
    // Capture once in the immutable Chat binding. A lost HTTP response or a
    // repeated click must not mint a new snapshot/time or a second Run.
    candidate.business_admission = prepareDailyAiResearchSyncAdmission({ companyId: input.companyId,
      dueKey: `chat-run-${candidate.binding_id}`, scheduledFor: candidate.created_at });
    if (candidate.business_admission.status !== "ready" || !candidate.business_admission.inputBundle) {
      throw new Error(candidate.business_admission.exact_blocker ?? "chat_daily_ai_target_binding_unavailable");
    }
    candidate.business_admission.sourceSnapshot.adapter_result = {
      ...candidate.business_admission.sourceSnapshot.adapter_result,
      admission_source: "automation_os_ui", requested_at: candidate.created_at,
      source_automation_id: selected.automation_id, source_automation_version_id: selected.automation_version_id,
      source_definition_sha256: selected.definition_sha256
    };
  }
  // This existing transaction records an immutable action binding, NOT a
  // business-completion receipt. One job/action can never obtain a second
  // target by changing the HTTP idempotency key after an uncertain response.
  const reserved = await runIdempotentSqlMutationAsync<Binding>({ companyId: input.companyId,
    scope: `chat:workflow:${job.id}`, key: input.action,
    request: { action: input.action, job_id: job.id, source_id: selected.automation_id,
      source_revision: selected.automation_revision, source_definition_sha256: selected.definition_sha256,
      prompt_sha256: request.prompt_sha256 }, resourceSteps: [], response: candidate });
  const binding = reserved.response;
  if (binding.action === "save_draft") {
    if (!binding.draft_definition) throw new Error("chat_workflow_draft_definition_missing");
    await createAutomationRecordAsync({ companyId: input.companyId, actorUserId: input.actorUserId,
      definition: binding.draft_definition, automationId: `automation_${binding.binding_id}`,
      idempotencyKey: `chat-draft-${binding.binding_id}`, idempotencyRequest: binding });
  } else {
    const dailyAi = binding.selected.workflow_id === DAILY_AI_RESEARCH_SYNC_WORKFLOW;
    const business = binding.business_admission;
    if (dailyAi && (business?.status !== "ready" || !business.inputBundle)) {
      throw new Error("chat_daily_ai_saved_target_binding_missing");
    }
    // Use the existing explicit, target-bound approval path for the Sheet
    // write. Do not label a Chat request as a natural schedule or inherit its
    // unattended approval. The other four adapters remain read-only.
    await startPortableLocalWorkflowRun({ workflowId: binding.selected.workflow_id,
      companyId: input.companyId, sourceTrigger: "automation_os_ui",
      registeredAutomationId: binding.selected.automation_id,
      registeredAutomationVersionId: binding.selected.automation_version_id,
      ...(dailyAi ? { effectStage: "business_execute" as const, inputBundle: business!.inputBundle,
        sourceSnapshot: business!.sourceSnapshot } : { readOnlyStage: "reference_readback" as const }),
      idempotencyKey: `chat-run-${binding.binding_id}`,
      chatOrigin: { schema: CHAT_WORKFLOW_BINDING_SCHEMA, binding_id: binding.binding_id,
        job_id: binding.job_id, prompt_sha256: binding.prompt_sha256 } });
  }
  return readBoundResult(binding, reserved.replayed);
}

async function readBoundResult(binding: Binding, replayed: boolean) {
  const base = { schema: CHAT_WORKFLOW_BINDING_SCHEMA, binding_id: binding.binding_id, job_id: binding.job_id,
    company_id: binding.company_id, action: binding.action, workflow_id: binding.selected.workflow_id,
    scope: binding.selected.scope, replayed, external_action_executed: false };
  if (binding.action === "save_draft") {
    const automation = await getAutomationRecordAsync(binding.company_id, `automation_${binding.binding_id}`, true);
    return { ...base, status: automation?.archivedAt ? "draft_archived" : automation ? "draft_saved" : "binding_recorded_result_unconfirmed",
      automation_id: automation?.id ?? null, automation_revision: automation?.revision ?? null,
      schedule_created: false, run_started: false };
  }
  const rows = await querySqlAsync<{ id: string; status: string; automation_id: string | null }>(
    `SELECT run.id, run.status, run.automation_id FROM portable_workflow_invocations invocation
       JOIN runs run ON run.id=COALESCE(invocation.run_id, ${sqlValue(portableChatWorkflowRunId({ schema: CHAT_WORKFLOW_BINDING_SCHEMA,
         binding_id: binding.binding_id, job_id: binding.job_id, prompt_sha256: binding.prompt_sha256 }))}) AND run.company_id=invocation.company_id
       WHERE invocation.company_id=${sqlValue(binding.company_id)} AND invocation.workflow_id=${sqlValue(binding.selected.workflow_id)}
         AND invocation.source_trigger='automation_os_ui' AND invocation.idempotency_key=${sqlValue(`chat-run-${binding.binding_id}`)} LIMIT 1`
  );
  return { ...base, status: rows[0] ? "run_admitted" : "binding_recorded_result_unconfirmed",
    run_id: rows[0]?.id ?? null, run_status: rows[0]?.status ?? null,
    automation_id: binding.selected.automation_id, business_completion_verified: false };
}
