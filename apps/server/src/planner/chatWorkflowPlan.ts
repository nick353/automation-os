import { createHash } from "node:crypto";
import type { AutomationRecord } from "../automations/repository.js";
import type { AutomationDefinitionInput } from "../automations/contracts.js";
import { canonicalJson } from "../automations/idempotency.js";
import type { CreatePlannerJob } from "./createPlannerJobs.js";

export const CHAT_WORKFLOW_COMPANY = "company_2560580981cedfd106b66245";
export const CHAT_WORKFLOW_BINDING_SCHEMA = "aos.chat_workflow_binding.v1" as const;

const workflows = [
  { id: "email-review-reply", kind: "email_review_registered", pattern: /Gmail|メール/iu,
    scope: "Gmailの最新最大100件のmetadataを確認・分類し、未送信の返信案を最大5件保存します。メール送信・Gmail下書き作成・Calendar変更はしません。",
    stages: ["newest_100_metadata", "classification_and_unsent_proposals", "same_run_result_and_cleanup"], requiresApproval: false },
  { id: "daily-ai-research-source-sync", kind: "daily_ai_research_sync_registered", pattern: /daily.?ai|日次.?AI|AI.{0,12}(?:調査|研究|ニュース)/iu,
    scope: "既存のDaily AI調査から原稿を最大3件作り、既存Sheetの39列・3管理ビューへ同期します。画像生成・公開・engagementはしません。",
    stages: ["research_queue_refresh", "existing_sheet_mirror", "cleanup"], requiresApproval: true },
  { id: "nisenprints-existing-product-audit", kind: "nisenprints_inventory_registered", pattern: /NisenPrints|Etsy|Printify|既存商品/iu,
    scope: "登録済みの既存shop・商品を読み取り、同一Runの管理snapshotを保存します。商品作成・編集・新規生成・公開はしません。",
    stages: ["existing_shop_and_product_readback", "run_owned_inventory_snapshot", "cleanup"], requiresApproval: false },
  { id: "daily-backup-safety-check", kind: "local_backup_registered", pattern: /backup|バックアップ/iu,
    scope: "既存バックアップの日時・remote一致・整合性・隔離復元結果を確認します。新規snapshotやpushはこの確認処理では行いません。",
    stages: ["existing_snapshot_readback", "integrity_and_restore_readback", "cleanup"], requiresApproval: false },
  { id: "obsidian-project-memory-audit", kind: "obsidian_audit_registered", pattern: /Obsidian|プロジェクト記憶/iu,
    scope: "登録プロジェクトを監査し、要対応と同一Runの結果を保存します。Vault・共有memory・AGENTSの更新やGit同期はしません。",
    stages: ["project_resolution", "read_only_audit", "run_owned_result_and_cleanup"], requiresApproval: false }
] as const;

export type ChatWorkflowId = typeof workflows[number]["id"];
export type ChatWorkflowAction = "run_once" | "save_draft";
export type ChatWorkflowOption = {
  automation_id: string;
  automation_revision: number;
  automation_version_id: string;
  workflow_id: ChatWorkflowId;
  name: string;
  scope: string;
  definition_sha256: string;
  can_run_once: boolean;
  can_save_draft: boolean;
  requires_approval: boolean;
  manual_blocker: string | null;
};
export type ChatWorkflowRequest = {
  job_id: string;
  company_id: string;
  prompt: string;
  prompt_sha256: string;
  family_ids: ChatWorkflowId[];
  can_run_once: boolean;
  can_save_draft: boolean;
  exact_blocker: string | null;
};

export function chatWorkflowHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function chatWorkflowRequest(job: CreatePlannerJob, companyId: string, actorUserId: string): ChatWorkflowRequest {
  if (companyId !== CHAT_WORKFLOW_COMPANY || job.metadata.actorUserId !== actorUserId
    || !Array.isArray(job.metadata.companyIds) || !job.metadata.companyIds.includes(companyId)) {
    throw new Error("chat_workflow_job_scope_mismatch");
  }
  const prompt = [...job.messages].reverse().find((message) => message.role === "user")?.text.trim() ?? "";
  const request: ChatWorkflowRequest = { job_id: job.id, company_id: companyId, prompt,
    prompt_sha256: chatWorkflowHash(prompt), family_ids: [], can_run_once: false, can_save_draft: false, exact_blocker: null };
  if (job.status !== "completed" || !job.result || !prompt) return { ...request, exact_blocker: "chat_workflow_plan_not_complete" };
  const families = workflows.filter((workflow) => workflow.pattern.test(prompt)).map((workflow) => workflow.id);
  if (!families.length) return { ...request, exact_blocker: "chat_workflow_registered_target_not_identified" };
  const effectRequest = prompt
    .replace(/(?:外部)?(?:メール)?(?:送信|公開|投稿|画像生成|動画生成|生成|課金|支払い|応募)(?:は|を)?(?:しない|せず|不要|なし|禁止|しません)/gu, "")
    .replace(/(?:do not|don't|without|no)\s+(?:send|publish|post|generat\w*)\b/giu, "");
  if (/(?:送信|公開|投稿|画像生成|動画生成|課金|支払い|応募|削除|購入)(?:して|する|したい|まで|も行う)|(?:新規|別の)(?:Sheet|シート|アカウント|shop)|\b(?:send|publish|post|delete|purchase)\s+(?:it|them|the|a|an|all)\b/iu.test(effectRequest)) {
    return { ...request, family_ids: families, exact_blocker: "chat_workflow_requested_effect_outside_supported_scope" };
  }
  const createRequest = prompt
    .replace(/(?:自動化|定期実行|下書き)(?:の|は|を)?(?:作成|保存|設定)(?:も|は|を|が)?(?:しない|しません|せず|不要|なし|禁止)/gu, "")
    .replace(/\b(?:do not|don't|never)\s+(?:create|save|configure).{0,40}?\b(?:automation|workflow|draft)\b/giu, "");
  const create = /(?:自動化|automation|workflow|定期実行|下書き).{0,24}(?:作成|作っ|作る|保存|設定)|(?:create|save).{0,24}(?:automation|workflow|draft)/iu.test(createRequest);
  const answerOnly = !create && /回答だけ|説明だけ|(?:結果|状況|実績|使い方|接続状態).{0,16}(?:見せ|教え|説明|確認)|でき(?:ます)?か|[?？]$|\b(?:explain|status|how to)\b/iu.test(prompt);
  const noRun = /まだ実行しない|実行しない|実行せず|保存だけ|案だけ|draft only|do not run/iu.test(prompt);
  const recurring = create && /毎日|毎週|定期|daily|weekly|schedule/iu.test(prompt);
  const run = !answerOnly && !noRun && !recurring
    && /実行|確認して|確認し|調査して|まとめて|まとめる|監査して|run|review|check/iu.test(prompt);
  return { ...request, family_ids: families, can_run_once: run, can_save_draft: create,
    exact_blocker: run || create ? null : "chat_workflow_answer_only_no_execution_requested" };
}

export function chatWorkflowOptions(request: ChatWorkflowRequest, automations: AutomationRecord[]): ChatWorkflowOption[] {
  if (request.exact_blocker) return [];
  return automations.flatMap((automation) => {
    const workflow = workflows.find((item) => item.kind === automation.workerCommandKind);
    if (!workflow || !request.family_ids.includes(workflow.id) || automation.companyId !== request.company_id
      || automation.archivedAt || automation.status === "archived" || automation.automationType !== "registered_workflow"
      || automation.builderSpec.schema !== "aos.registered_automation_adoption.v1"
      || automation.builderSpec.canonicalWorkflowId !== workflow.id) return [];
    // A copy remains traceable, but is not silently preferred over its source.
    return [{ automation_id: automation.id, automation_revision: automation.revision,
      automation_version_id: automation.currentVersionId, workflow_id: workflow.id, name: automation.name,
      scope: workflow.scope, definition_sha256: chatWorkflowHash(automation),
      can_run_once: request.can_run_once,
      can_save_draft: request.can_save_draft,
      requires_approval: workflow.requiresApproval,
      manual_blocker: null }];
  });
}

export function chatWorkflowDraftDefinition(job: CreatePlannerJob, source: AutomationRecord, option: ChatWorkflowOption, request: ChatWorkflowRequest): AutomationDefinitionInput {
  if (!option.can_save_draft || source.id !== option.automation_id || chatWorkflowHash(source) !== option.definition_sha256) {
    throw new Error("chat_workflow_draft_binding_mismatch");
  }
  const workflow = workflows.find((item) => item.id === option.workflow_id)!;
  const spec = JSON.parse(JSON.stringify(source.builderSpec)) as Record<string, unknown>;
  // New copies for checks/audits must not inherit a policy that writes a new
  // backup or maintains the Vault. The original registration is untouched.
  if (workflow.id === "daily-backup-safety-check" || workflow.id === "obsidian-project-memory-audit") spec.unattendedEffectPolicy = null;
  if (workflow.id !== "daily-ai-research-source-sync") {
    spec.stages = workflow.stages.map((id) => ({ id, kind: "readback", externalEffect: false, requiredProof: ["same_run_receipt"] }));
  }
  spec.chat_origin = { schema: CHAT_WORKFLOW_BINDING_SCHEMA, job_id: job.id, prompt: request.prompt,
    prompt_sha256: request.prompt_sha256, source_automation_id: source.id,
    source_automation_version_id: source.currentVersionId, fixed_scope: workflow.scope };
  return { automationType: "registered_workflow", name: (job.result?.title || source.name).slice(0, 120),
    description: "Chatから登録済み処理を参照して作成した停止中の下書き", goal: workflow.scope,
    lane: source.lane, riskLevel: source.riskLevel, approvalPolicy: source.approvalPolicy,
    workerCommandKind: source.workerCommandKind, createApproval: false, builderSpec: spec };
}
