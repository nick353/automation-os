import { execSql, insert, makeId, nowIso, resetDemoData, sqlValue } from "./db/client.js";
import { allocateParallelLanes } from "./runs/laneManager.js";
import { createApprovalRequest } from "./runs/approvalGate.js";
import { evaluateProofGate, summarizeProofGate } from "./runs/proofGate.js";
import { decomposeGoal } from "./planner/decompose.js";
import { seedResearchKnowledge } from "./planner/advisor.js";

export function seedDailyAiDemo() {
  resetDemoData();
  const now = nowIso();
  const runId = "run_demo_daily_ai";
  const objective =
    "Collect Daily AI sources, publish one candidate to X and LinkedIn, study engagement, sync receipts, refresh buffer, and keep cleanup proof.";

  insert("runs", {
    id: runId,
    name: "Daily AI full-flow demo",
    status: "complete",
    objective,
    created_at: now,
    updated_at: now,
    metadata_json: { ai_adapters: ["codex_cli", "codex_app", "chatgpt_subscription"], openai_api: "optional_docs_only" }
  });

  const planned = decomposeGoal(
    "Daily AI source collection, X publish, LinkedIn publish, post publish engagement, Sheets sync, buffer refresh, cleanup"
  );
  const lanePlan = allocateParallelLanes(
    planned.map((task) => ({
      id: task.id,
      name: task.name,
      role: task.laneRole,
      resources: task.resources,
      dangerousAction: task.dangerousAction
    })),
    { basePort: 9333, profileRoot: "/tmp/automation-os/daily-ai/profiles", workdirRoot: "/tmp/automation-os/daily-ai/workdirs" }
  );

  lanePlan.lanes.forEach((lane, index) => {
    insert("lanes", {
      id: lane.id,
      run_id: runId,
      role: lane.role,
      cdp_port: lane.cdpPort,
      profile_dir: lane.profileDir,
      workdir: lane.workdir,
      browser_use_session: lane.browserUseSession,
      browser_use_cdp_url: lane.browserUseCdpUrl,
      browser_use_profile: lane.browserUseProfile,
      profile_strategy: lane.profileStrategy,
      lane_visibility: lane.laneVisibility,
      status: "idle",
      current_task: planned[index]?.name ?? "standby",
      progress: [82, 64, 61, 45, 93, 100, 100][index] ?? 0,
      health: lane.collisionWith.length ? "collision" : "good",
      resource_locks_json: lane.resourceLocks,
      updated_at: now
    });
  });

  planned.forEach((task, index) => {
    insert("run_steps", {
      id: `step_demo_${index + 1}`,
      run_id: runId,
      name: task.name,
      status: "completed",
      lane_id: lanePlan.lanes[index]?.id,
      started_at: now,
      completed_at: now,
      metadata_json: { resources: task.resources, parallel_safe: task.parallelSafe }
    });
  });

  const approval = createApprovalRequest({
    runId,
    title: "Approved parallel X + LinkedIn publish commit",
    requestedBy: "system",
    approvalGroupId: "approval_group_daily_ai_publish",
    resourceLocks: ["x_publish", "linkedin_publish", "social_publish"],
    priority: "high"
  });
  insert("approvals", {
    id: approval.id,
    run_id: approval.runId,
    title: approval.title,
    requested_by: approval.requestedBy,
    status: "approved",
    priority: approval.priority,
    approval_group_id: approval.approvalGroupId,
    resource_locks_json: approval.resourceLocks,
    created_at: approval.createdAt,
    decided_at: now,
    decision_note: "Demo proof seed assumes the publish commit was approved before proof capture"
  });

  const proofTypes = [
    ["source_collection", "RSS/API source snapshot", "data://daily-ai/source-collection.json", 214000],
    ["x_publish", "X publish receipt", "receipt://x/post/demo", 19000],
    ["linkedin_publish", "LinkedIn publish receipt", "receipt://linkedin/post/demo", 22000],
    ["engagement", "Post-publish feed-study receipt", "receipt://daily-ai/engagement/demo", 66000],
    ["postflight_sync", "Sheets sync dry receipt", "receipt://daily-ai/postflight-sync/demo", 41000],
    ["buffer_refresh", "Buffer 3/3 refreshed", "receipt://daily-ai/buffer-refresh/demo", 36000],
    ["cleanup", "Profile and process cleanup receipt", "receipt://daily-ai/cleanup/demo", 13000]
  ] as const;

  for (const [proofType, label, uri, sizeBytes] of proofTypes) {
    insert("proofs", {
      id: makeId("proof"),
      run_id: runId,
      step_id: null,
      proof_type: proofType,
      label,
      uri,
      size_bytes: sizeBytes,
      created_at: now,
      metadata_json: { demo: true }
    });
  }

  for (const event of seedResearchKnowledge(now)) {
    insert("advisor_events", {
      id: event.id,
      topic: event.topic,
      source: event.source,
      summary: event.summary,
      recommendation: event.recommendation,
      trigger_context: event.triggerContext,
      confidence: event.confidence,
      created_at: event.createdAt,
      metadata_json: event.metadata
    });
  }

  const proofGate = evaluateProofGate(proofTypes.map(([proofType, label, uri]) => ({ proofType, label, uri })));
  execSql(
    `UPDATE runs SET metadata_json=${sqlValue({
      proof_gate: proofGate,
      proof_summary: summarizeProofGate(proofGate),
      lane_collisions: lanePlan.collisions,
      worker_protocol: "local_worker_v1"
    })} WHERE id=${sqlValue(runId)};`
  );

  return { runId, lanes: lanePlan.lanes.length, approvals: 1, proofs: proofTypes.length, advisorEvents: 3, proofGate };
}
