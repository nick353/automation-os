/** Shared display contract for the company API and Postgres UI readback. */
export function automationExecutionContract(workerCommandKind: unknown): {
  execution_mode: "control_plane_dry_run" | "registered_workflow_readback" | "portable_mac_worker_queue" | "unverified";
  execution_label: string;
  scheduler_effect: "queues_scheduled_dry_run" | "queues_portable_mac_worker" | "requires_registered_runner_readback" | "not_configured";
  external_action_allowed: false;
} {
  const kind = typeof workerCommandKind === "string" ? workerCommandKind.trim().toLowerCase() : "";
  if (kind === "safe_local_demo") return {
    execution_mode: "control_plane_dry_run",
    execution_label: "制御面の予約・dry-runのみ（外部処理なし）",
    scheduler_effect: "queues_scheduled_dry_run",
    external_action_allowed: false
  };
  if (kind === "daily_ai_research_sync_registered") return {
    execution_mode: "portable_mac_worker_queue",
    execution_label: "Daily AI調査→既存Sheets同期（生成・公開なし／実結果はRunで照合）",
    scheduler_effect: "queues_portable_mac_worker",
    external_action_allowed: false
  };
  if (["daily_ai_registered", "job_submit_registered", "nisenprints_registered"].includes(kind)) return {
    execution_mode: "portable_mac_worker_queue",
    execution_label: "AOS portable workflow → Mac worker queue（実処理はRunで確認）",
    scheduler_effect: "queues_portable_mac_worker",
    external_action_allowed: false
  };
  if (kind.includes("registered")) return {
    execution_mode: "registered_workflow_readback",
    execution_label: "登録workflow契約（実行readback待ち）",
    scheduler_effect: "requires_registered_runner_readback",
    external_action_allowed: false
  };
  return {
    execution_mode: "unverified",
    execution_label: "実行契約未確認（保存のみ）",
    scheduler_effect: "not_configured",
    external_action_allowed: false
  };
}
