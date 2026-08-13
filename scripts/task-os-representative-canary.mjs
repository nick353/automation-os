#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { compileTaskPlan, fieldProvenance } from "../apps/server/dist/taskContracts/taskDsl.js";
import { outcomeContract, routeSurface } from "../apps/server/dist/taskContracts/taskOsPolicy.js";

const runId = `representative-canary-${Date.now()}`;
const hash = "b".repeat(64);
const definitions = [
  { id: "job_application", objective: "求人1件へ応募し、receipt/source sync/reconciliation/cleanupを得る", verb: "submit", taskClass: "external_effect", surface: "browser_use_cli", uiRequired: true },
  { id: "email_draft", objective: "メール1件を下書きとして保存し、可逆更新のreadbackを得る", verb: "draft", taskClass: "reversible_update", surface: "connector", uiRequired: false },
  { id: "sns_post", objective: "SNS投稿1件を送信し、visible provider receiptとsource syncを得る", verb: "publish", taskClass: "external_effect", surface: "browser_use_cli", uiRequired: true },
  { id: "admin_update", objective: "管理画面の1項目を可逆更新し、状態変化をreadbackする", verb: "update", taskClass: "reversible_update", surface: "api", uiRequired: false },
  { id: "data_sync", objective: "データ同期1件を実行し、source syncとreconciliationを得る", verb: "update", taskClass: "reversible_update", surface: "api", uiRequired: false },
  { id: "read_only", objective: "対象を閲覧し、read-only readbackを得る", verb: "read", taskClass: "read_only", surface: "api", uiRequired: false }
];

function compile(definition) {
  const taskId = `${runId}-${definition.id}`;
  const task = {
    schema: "automation_os_task_dsl.v1",
    task_id: taskId,
    workflow_id: definition.id === "job_application" ? "job-application-manager" : `representative-${definition.id}`,
    objective: definition.objective,
    intent: { verb: definition.verb, target_description: "target:fixture" },
    inputs: [
      fieldProvenance({ field: "target", source: "user_input", valueRef: "target:fixture", valueSha256: hash }),
      fieldProvenance({ field: "account", source: "profile", valueRef: "account:fixture", valueSha256: hash }),
      ...(definition.verb === "read" ? [] : [fieldProvenance({ field: "payload", source: "user_input", valueRef: "payload:fixture", valueSha256: hash })])
    ],
    constraints: { max_effects: definition.taskClass === "external_effect" ? 1 : 0, allowed_origins: ["https://example.com"], required_capabilities: ["observe", "locate"], sources: [] },
    completion: { provider_receipt: true, source_sync: true, reconciliation: true, cleanup: true, visible_confirmation: definition.taskClass === "external_effect" }
  };
  const plan = compileTaskPlan(task);
  const route = routeSurface({ uiRequired: definition.uiRequired, preferred: definition.surface, available: [definition.surface], allowed: ["api", "connector", "local", "browser_use_cli", "codex_app_browser"] });
  const outcome = outcomeContract(definition.taskClass, "fixture_state_change");
  return {
    task_id: taskId,
    task_kind: definition.id,
    task_class: plan.task_class,
    plan: { nodes: plan.nodes.map((node) => node.id), omitted: plan.omitted, next_stage: plan.next_stage, restart_point: plan.restart_point },
    surface_route: { selected: route.selected, exact_blocker: route.exact_blocker },
    outcome_contract: outcome.schema,
    proof: {
      mode: definition.taskClass === "external_effect" ? "shadow_no_effect" : "fixture",
      provider_receipt: definition.taskClass === "external_effect" ? "no_effect_fixture_receipt" : "fixture_receipt",
      source_sync: true,
      reconciliation: true,
      cleanup: true,
      external_action_executed: false,
      visible_confirmation: definition.taskClass === "external_effect" ? "required_for_effectful_promotion" : "not_required"
    },
    exact_blocker: definition.taskClass === "external_effect" ? "effectful_canary_requires_fresh_target_authority_approval" : null,
    restart_point: definition.taskClass === "external_effect" ? "effect admission preview" : "same-run source sync"
  };
}

const result = {
  schema: "automation_os_task_os_representative_canary.v1",
  run_id: runId,
  fresh: true,
  external_action_executed: false,
  tasks: definitions.map(compile),
  invariant: { wrong_target_count: 0, ambiguous_submit_replays: 0, cleanup_residual_count: 0 },
  source_of_truth: "contract_fixture_not_production",
  exact_blocker: "production_protected_readback_and_business_target_missing",
  next_action: "complete protected production readback, then promote only the target-bound one-effect lane",
  restart_point: "target-bound admission"
};

const output = process.env.AOS_REPRESENTATIVE_CANARY_ARTIFACT ? path.resolve(process.env.AOS_REPRESENTATIVE_CANARY_ARTIFACT) : null;
if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); }
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
