import React, { useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  CalendarClock,
  Camera,
  Check,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock,
  Cpu,
  Database,
  Download,
  Edit3,
  FileText,
  FolderKanban,
  Gauge,
  Home,
  KeyRound,
  Layers3,
  LayoutTemplate,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Video,
  Wifi,
  X
} from "lucide-react";
import "./styles.css";

type Status = "running" | "waiting" | "approved" | "blocked" | "enabled" | "disabled" | "draft";

const projects = ["プロジェクトA", "プロジェクトB", "プロジェクトC", "プロジェクトD"];
const projectSlugs = ["project-a", "project-b", "project-c", "project-d"];
const projectLabels = Object.fromEntries(projectSlugs.map((slug, index) => [slug, projects[index]]));
const projectCapabilities = Object.fromEntries(projectSlugs.map((slug) => [slug, {
  api_readback_available: true,
  external_action_disabled: true,
  registered_automation_scope: slug === "project-a" ? "connected" : "project-a-only",
  data_scope: slug === "project-a" ? "mvp_state_readback" : "placeholder_only"
}]));
const subTabLabels = [
  ["定期実行", "automations"],
  ["保存情報", "memory"],
  ["Lane", "lanes"],
  ["パフォーマンス", "performance"],
  ["接続・権限・セキュリティ", "security"],
  ["成果物 / KPI", "artifacts"]
];

function redactSensitiveText(value: string) {
  return String(value || "")
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/(?:authorization|bearer|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|private[_-]?key|security[_-]?code|database[_-]?url|otp|recovery[_-]?code)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\b(?:sk-|xox|ghp_|eyJ)[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s,;]+/gi, "[redacted]")
    .replace(/BEGIN PRIVATE KEY[\s\S]*?END PRIVATE KEY/g, "[redacted]");
}

const seedAutomations = [
  { id: "sns-post", project_id: "project-a", automation_type: "sns-post", name: "SNS投稿", desc: "X / LinkedIn / Instagram に投稿", schedule: "09:00", lane: "Lane 1", last: "今日 08:58", status: "enabled" as Status },
  { id: "feedback", project_id: "project-a", automation_type: "feedback", name: "フィードバック", desc: "プロダクトのフィードバック収集", schedule: "10:00", lane: "Lane 1", last: "昨日 10:02", status: "enabled" as Status },
  { id: "dm-reply", project_id: "project-a", automation_type: "dm-reply", name: "DM返信", desc: "各SNSのDMに自動返信", schedule: "11:00", lane: "Lane 2", last: "承認待ち", status: "waiting" as Status },
  { id: "ads", project_id: "project-a", automation_type: "ads", name: "広告投稿", desc: "広告アカウントへ投稿・告知", schedule: "13:00", lane: "Lane 2", last: "未実行", status: "draft" as Status }
];

type AutomationRow = typeof seedAutomations[number];
type MvpState = {
  updated_at?: string;
  worker?: { id: string; status: string; heartbeat_at: string | null; queue_depth: number; last_run_id: string | null; heartbeat_age_seconds?: number | null; heartbeat_fresh?: boolean; readback_status?: string; exact_blocker?: string | null; next_action?: string; external_action_executed?: boolean };
  persistence?: any;
  projects?: any[];
  automations?: any[];
  schedules?: any[];
  runs?: any[];
  proofs?: any[];
  approvals?: any[];
  project_memory?: any[];
  account_refs?: any[];
  builder_specs?: any[];
  audit_events?: any[];
  redaction_readback?: any;
  production_readiness_readback?: any;
  feedbacks?: Array<{
    id: string;
    feedback_id: string;
    status: string;
    route: string;
    page_title: string;
    comment: string;
    artifact_uri: string;
    has_screenshot: boolean;
    viewport: Record<string, unknown>;
    workflow_context: Record<string, unknown>;
    category: string;
    severity: string;
    fix_target: string;
    captured_at: string;
    created_at: string;
    payload: Record<string, unknown>;
  }>;
};

type RegisteredAutomationReadback = {
  ok?: boolean;
  read_only?: boolean;
  exact_boundary?: string;
  safety_boundary?: string;
  source_ref?: string | null;
  preflight_source_ref?: string | null;
  latest_proof_source_ref?: string | null;
  inventory_run_id?: string;
  preflight_run_id?: string;
  latest_proof_run_id?: string;
  automation_count?: number;
  automations?: any[];
};

function workerStatusSummary(worker: MvpState["worker"]) {
  if (!worker) {
    return {
      fresh: false,
      label: "unknown",
      blocker: "mac_worker_state_missing",
      nextAction: "MVP stateを再読込してworker状態を確認してください。",
      display: "worker=unknown / blocker=mac_worker_state_missing"
    };
  }
  const blocker = worker.exact_blocker ?? (worker.heartbeat_fresh === false
    ? worker.readback_status === "heartbeat_missing" ? "mac_worker_heartbeat_missing" : "mac_worker_heartbeat_stale"
    : null);
  const nextAction = worker.next_action ?? (blocker
    ? "Mac worker laneを起動してheartbeat/readbackを更新してください。"
    : "worker heartbeatはfreshです。各workflowのauth/readback境界を取るまでqueued jobは処理しません。");
  return {
    fresh: worker.heartbeat_fresh === true,
    label: worker.readback_status ?? "unknown",
    blocker,
    nextAction,
    display: blocker ? `blocker=${blocker} / 次: ${nextAction}` : `heartbeat=${worker.readback_status ?? "unknown"} / 次: ${nextAction}`
  };
}

type ProductionRollupResult = {
  id: string;
  capability: string;
  actual_status: "confirmed" | "blocked-runtime-verification";
  artifact: string;
  blocker: string | null;
  resume_condition: string | null;
};

type AutomationPlan = {
  kind: string;
  title: string;
  schedule: string;
  cadence: string;
  targetLabel: string;
  steps: string[];
  questions: string[];
  safetyNote: string;
  approvalPolicy: string;
};

type PlannerReadback = {
  ok: boolean;
  planner_adapter: string;
  planner_mode: string;
  planner_model_ref: string | null;
  planner_schema_version: string;
  project_id: string;
  automation_type: string;
  plan: AutomationPlan;
  exact_blocker: string | null;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

function nextChatId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function actionStamp() {
  return `${new Date().toLocaleTimeString("ja-JP", { hour12: false })}.${String(Date.now()).slice(-3)}`;
}

function detectSchedule(text: string) {
  const hourMatch = text.match(/(\d{1,2})\s*時/);
  const hour = hourMatch ? Math.max(0, Math.min(23, Number(hourMatch[1]))) : text.includes("夕方") ? 18 : text.includes("夜") ? 20 : 9;
  const cadence = text.includes("毎週") ? "weekly" : text.includes("毎月") ? "monthly" : "daily";
  return { schedule: `${String(hour).padStart(2, "0")}:00`, cadence };
}

function buildAutomationPlan(prompt: string, selectedPlatforms: string[]): AutomationPlan {
  const lower = prompt.toLowerCase();
  const { schedule, cadence } = detectSchedule(prompt);
  const wantsLine = prompt.includes("LINE") || prompt.includes("Line") || prompt.includes("ライン") || lower.includes("line");
  const wantsNotify = prompt.includes("通知") || prompt.includes("知らせ") || prompt.includes("送って") || prompt.includes("連絡") || lower.includes("notify") || lower.includes("alert") || lower.includes("webhook") || lower.includes("slack");
  const wantsNews = prompt.includes("最新") || prompt.includes("ニュース") || prompt.includes("探して") || prompt.includes("調べ") || prompt.includes("まとめ") || lower.includes("google") || lower.includes("web") || lower.includes("news");
  const wantsAi = prompt.includes("AI") || lower.includes("ai");
  if (lower.includes("gmail") || prompt.includes("メール") || prompt.includes("問い合わせ") || prompt.includes("返信")) {
    return {
      kind: "メール返信",
      title: "メール返信 自動化プラン",
      schedule,
      cadence,
      targetLabel: "Gmail / 問い合わせ",
      steps: ["受信条件と対象ラベルを確認", "返信案を作成", "個人情報とsecret混入を検査", "送信前に承認で停止", "承認後の実行Laneを割り当て", "送信結果と証跡を保存", "失敗時の再試行条件を記録"],
      questions: ["対象にするメールラベルや送信元条件", "返信してよい範囲と必ず止める条件"],
      safetyNote: "メール送信は承認まで実行しません。",
      approvalPolicy: "required_before_external_send"
    };
  }
  if (wantsLine || wantsNotify) {
    const topic = wantsNews ? (wantsAi ? "AI最新情報" : "指定トピックの最新情報") : "通知";
    const sourceStep = wantsNews ? "Google/Webから最新情報候補を収集" : "指定された情報源または内部データを取得";
    return {
      kind: "情報収集・通知",
      title: `${topic} LINE通知 自動化プラン`,
      schedule,
      cadence,
      targetLabel: wantsLine ? "LINE通知" : "外部通知",
      steps: ["通知条件と情報源を確認", sourceStep, "重複・古い情報・信頼性の低い情報を除外", "重要ポイントを短く要約", "通知文の下書きを作成", "LINE/Webhook/外部通知送信前に承認で停止", "readbackと証跡を保存"],
      questions: ["通知先の接続先または承認済みsecret lane", "毎回承認するか、下書き保存だけにするか"],
      safetyNote: "LINE/Webhook/外部通知は承認まで実行しません。",
      approvalPolicy: "required_before_external_notification"
    };
  }
  if (prompt.includes("調査") || prompt.includes("リサーチ") || lower.includes("research")) {
    return {
      kind: "リサーチ",
      title: "リサーチ 自動化プラン",
      schedule,
      cadence,
      targetLabel: "Web / Drive",
      steps: ["調査対象と禁止範囲を確認", "参照元を収集", "要点と引用元を整理", "レポート下書きを作成", "人間レビューで停止", "承認後に成果物へ保存", "失敗時の再試行条件を記録"],
      questions: ["調査対象の範囲", "保存先とレビュー条件"],
      safetyNote: "外部投稿や送信は含めず、成果物保存前に確認します。",
      approvalPolicy: "required_before_external_publish"
    };
  }
  const targetLabel = selectedPlatforms.length ? selectedPlatforms.join(" / ") : "SNS";
  return {
    kind: "SNS投稿",
    title: `${targetLabel}投稿 自動化プラン`,
    schedule,
    cadence,
    targetLabel,
    steps: ["素材の取得元を確認", "投稿文と画像候補を作成", `${targetLabel} の下書きに変換`, "外部投稿前に承認で停止", "承認後の実行Laneを割り当て", "実行結果とURLを保存", "失敗時の再試行条件を記録"],
    questions: ["投稿先アカウント", "投稿前の承認条件"],
    safetyNote: "外部投稿は承認まで実行しません。",
    approvalPolicy: "required_before_external_post"
  };
}

function automationSlugForKind(kind: string) {
  if (kind === "メール返信") return "gmail-reply";
  if (kind === "リサーチ") return "research-report";
  if (kind === "情報収集・通知") return "research-notification";
  if (kind === "Daily AI") return "daily-ai";
  if (kind === "NisenPrints") return "nisenprints";
  if (kind === "Codex Job Manager") return "codex-job-manager";
  if (kind === "回答のみ") return "answer-only";
  return "sns-post";
}

async function requestChatPlan(prompt: string, selectedPlatforms: string[]): Promise<PlannerReadback> {
  const fallbackPlan = buildAutomationPlan(prompt, selectedPlatforms);
  try {
    const response = await fetch("/api/mvp/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, selected_platforms: selectedPlatforms })
    });
    if (!response.ok) throw new Error("planner_api_failed");
    return await response.json();
  } catch {
    return {
      ok: true,
      planner_adapter: "client_fallback_deterministic",
      planner_mode: "api_unavailable_fallback",
      planner_model_ref: null,
      planner_schema_version: "client-fallback-v1",
      project_id: projectSlugFromPrompt(prompt),
      automation_type: automationSlugForKind(fallbackPlan.kind),
      plan: fallbackPlan,
      exact_blocker: "chat_planner_api_unavailable_fallback_client"
    };
  }
}

const productionRollup: {
  run_id: string;
  overall_status: string;
  goal_complete: boolean;
  confirmed_count: number;
  blocked_count: number;
  results: ProductionRollupResult[];
} = {
  run_id: "20260702022000",
  overall_status: "in_progress_blocked_runtime_verification",
  goal_complete: false,
  confirmed_count: 4,
  blocked_count: 6,
  results: [
    { id: "P001", capability: "registered_automation_inventory", actual_status: "confirmed", artifact: "artifacts/registered-automation-inventory/20260702010000/inventory.json", blocker: null, resume_condition: null },
    { id: "P002", capability: "daily_backup_mac_execution", actual_status: "confirmed", artifact: "artifacts/registered-automation-runs/20260702011000/daily-backup-readback.json", blocker: null, resume_condition: null },
    { id: "P003", capability: "external_automation_read_only_preflight", actual_status: "confirmed", artifact: "artifacts/registered-automation-preflight/20260702012000/preflight.json", blocker: null, resume_condition: null },
    { id: "P004", capability: "production_migration_contract", actual_status: "confirmed", artifact: "artifacts/production-migration-contract/20260702013000/verification.json", blocker: null, resume_condition: null },
    { id: "P005", capability: "real_auth_login_org_isolation", actual_status: "blocked-runtime-verification", artifact: "artifacts/auth-readback-verification/20260702017000/auth-readback-verification.json", blocker: "real browser/API/DB/audit auth readbacks and checksums missing", resume_condition: "Fill auth-readback-template in real mode after provider login/logout/session/revoke/UserA-vs-UserB isolation/audit evidence." },
    { id: "P006", capability: "real_secret_vault_local_mac_boundary", actual_status: "blocked-runtime-verification", artifact: "artifacts/secret-vault-readback-verification/20260702018000/secret-vault-readback-verification.json", blocker: "real vault operation/redaction artifacts and checksums missing", resume_condition: "Fill secret-vault-readback-template in real mode with opaque reference register/use/revoke/expire and redaction proof." },
    { id: "P007", capability: "production_deploy_and_rollback", actual_status: "blocked-runtime-verification", artifact: "artifacts/production-deploy-smoke/20260702016000/deploy-smoke.json", blocker: "production URL remote health/smoke and rollback proof missing", resume_condition: "Set AUTOMATION_OS_PRODUCTION_URL, deploy to target, verify remote health/readiness/browser smoke and rollback proof." },
    { id: "P008", capability: "real_external_action_sandbox", actual_status: "blocked-runtime-verification", artifact: "artifacts/external-action-sandbox-verification/20260702019000/external-action-sandbox-verification.json", blocker: "real-mode approval receipt/provider readback/cleanup/audit/checksums missing", resume_condition: "Fill external-action-sandbox-template in real mode for a sandbox/test account only." },
    { id: "P009", capability: "production_like_external_measurement", actual_status: "blocked-runtime-verification", artifact: "artifacts/p009-prodlike-external-measurement-gate/20260702020000/p009-prodlike-external-measurement-gate.json", blocker: "P008 sandbox, structured production-like run submission, and real readback package not ready", resume_condition: "Confirm P008, submit structured production-like run, and provide checksum-backed real readback package." },
    { id: "P010", capability: "ten_m_readiness", actual_status: "blocked-runtime-verification", artifact: "artifacts/p010-10m-readiness-gate/20260702021000/p010-10m-readiness-gate.json", blocker: "P009, real final measured evidence bundle, and manager acceptance/claim allowance not ready", resume_condition: "Confirm P009, provide real final measured evidence bundle, and obtain manager acceptance with claim allowance." }
  ]
};

const currentProductionReadiness = {
  run_id: "20260702263000",
  production_ready: false,
  goal_complete: false,
  confirmed_count: 69,
  blocked_runtime_count: 6,
  next_required_runtime_stage: "P005_real_login_auth",
  next_runtime_evidence_workspace: "artifacts/runtime-evidence-collection/20260702063000-p005",
  next_runtime_verifier_command: "AUTH_READBACK_INPUT=artifacts/runtime-evidence-collection/20260702063000-p005/auth-readback.json AUTH_READBACK_RUN_ID=<run-id> npm run verify:auth-readback",
  next_runtime_secret_scan_command: "npm run scan:runtime-evidence-collection-secrets",
  next_stage_gate_artifact: "artifacts/p005-p010-next-stage-gate/20260702226000-p092-next-stage-gate/next-stage-gate.json",
  next_stage_gate_command: "P005_P010_NEXT_STAGE_GATE_RUN_ID=20260702226000-p092-next-stage-gate npm run verify:p005-p010-next-stage-gate",
  p005_real_auth_operator_handoff_artifact: "artifacts/p005-real-auth-operator-handoff/20260702232000-p093-p005-auth-handoff/operator-handoff.json",
  p005_real_auth_operator_handoff_command: "P005_REAL_AUTH_OPERATOR_HANDOFF_RUN_ID=20260702232000-p093-p005-auth-handoff npm run verify:p005-real-auth-operator-handoff",
  p005_runtime_evidence_submission_workspace_artifact: "artifacts/p005-runtime-evidence-submission-workspace/20260702237000-p094-p005-submission-workspace/submission-workspace.json",
  p005_runtime_evidence_submission_workspace_command: "P005_RUNTIME_EVIDENCE_SUBMISSION_WORKSPACE_RUN_ID=20260702237000-p094-p005-submission-workspace npm run verify:p005-runtime-evidence-submission-workspace",
  p005_auth_readback_readiness_gap_report_artifact: "artifacts/p005-auth-readback-readiness-gap-report/20260702242000-p095-p005-auth-gap/gap-report.json",
  p005_auth_readback_readiness_gap_report_command: "P005_AUTH_READBACK_READINESS_GAP_RUN_ID=20260702242000-p095-p005-auth-gap npm run verify:p005-auth-readback-readiness-gap-report",
  p005_auth_readback_promotion_plan_artifact: "artifacts/p005-auth-readback-promotion-plan/20260702247000-p096-p005-auth-promotion-plan/promotion-plan.json",
  p005_auth_readback_promotion_plan_command: "P005_AUTH_READBACK_PROMOTION_PLAN_RUN_ID=20260702247000-p096-p005-auth-promotion-plan npm run verify:p005-auth-readback-promotion-plan",
  p005_auth_readback_promotion_safety_snapshot_artifact: "artifacts/p005-auth-readback-promotion-safety-snapshot/20260702252000-p097-p005-auth-promotion-safety-snapshot/safety-snapshot.json",
  p005_auth_readback_promotion_safety_snapshot_command: "P005_AUTH_READBACK_PROMOTION_SAFETY_SNAPSHOT_RUN_ID=20260702252000-p097-p005-auth-promotion-safety-snapshot npm run verify:p005-auth-readback-promotion-safety-snapshot",
  p005_auth_readback_promotion_contract_artifact: "artifacts/p005-auth-readback-promotion-contract/20260702257000-p098-p005-auth-promotion-contract/promotion-contract.json",
  p005_auth_readback_promotion_contract_command: "P005_AUTH_READBACK_PROMOTION_CONTRACT_RUN_ID=20260702257000-p098-p005-auth-promotion-contract npm run verify:p005-auth-readback-promotion-contract",
  p005_auth_readback_artifact_acceptance_gate_artifact: "artifacts/p005-auth-readback-artifact-acceptance-gate/20260702262000-p099-p005-auth-artifact-acceptance-gate/acceptance-gate.json",
  p005_auth_readback_artifact_acceptance_gate_command: "P005_AUTH_READBACK_ARTIFACT_ACCEPTANCE_GATE_RUN_ID=20260702262000-p099-p005-auth-artifact-acceptance-gate npm run verify:p005-auth-readback-artifact-acceptance-gate",
  local_readiness_verifier_command: "PRODUCTION_READINESS_LOCAL_RUN_ID=20260702266000 npm run verify:production-readiness-local",
  registered_automation_model_policy_command: "npm run verify:registered-automation-model-policy",
  registered_automation_inventory_current_command: "REGISTERED_AUTOMATION_INVENTORY_RUN_ID=20260702050000 npm run inventory:registered-automations",
  registered_automation_preflight_current_command: "REGISTERED_AUTOMATION_INVENTORY_RUN_ID=20260702050000 REGISTERED_AUTOMATION_PREFLIGHT_RUN_ID=20260702051000 npm run preflight:registered-automations",
  registered_automation_execution_matrix_command: "npm run verify:registered-automation-execution-matrix",
  external_automation_unblock_packet_command: "npm run verify:external-automation-unblock-packet",
  production_runtime_unblock_packet_command: "npm run verify:production-runtime-unblock-packet",
  runtime_evidence_collection_all_command: "npm run verify:runtime-evidence-collection-all",
  runtime_evidence_collection_all_secret_scan_command: "npm run scan:runtime-evidence-collection-all-secrets",
  production_promotion_audit_command: "npm run verify:production-promotion-audit",
  runtime_evidence_submission_packet_command: "npm run verify:runtime-evidence-submission-packet",
  registered_automation_drift_guard_command: "npm run verify:registered-automation-drift-guard",
  full_objective_completion_audit_command: "npm run verify:full-objective-completion-audit",
  real_runtime_evidence_intake_gate_command: "npm run verify:real-runtime-evidence-intake-gate",
  runtime_evidence_checksum_staging_command: "npm run verify:runtime-evidence-checksum-staging",
  runtime_evidence_promotion_pipeline_command: "npm run verify:runtime-evidence-promotion-pipeline",
  p005_real_auth_capture_packet_command: "npm run verify:p005-real-auth-capture-packet",
  p006_secret_vault_capture_packet_command: "npm run verify:p006-secret-vault-capture-packet",
  p007_production_deploy_capture_packet_command: "npm run verify:p007-production-deploy-capture-packet",
  p008_external_action_capture_packet_command: "npm run verify:p008-external-action-capture-packet",
  p009_prodlike_capture_packet_command: "npm run verify:p009-prodlike-capture-packet",
  p010_10m_capture_packet_command: "npm run verify:p010-10m-capture-packet",
  p005_p010_operator_packet_command: "npm run verify:p005-p010-operator-packet",
  p005_p010_redacted_hygiene_gate_command: "npm run verify:p005-p010-redacted-hygiene",
  p005_p010_stage_promotion_queue_command: "npm run verify:p005-p010-promotion-queue",
  p005_real_auth_first_stage_packet_command: "npm run verify:p005-real-auth-first-stage-packet",
  p006_secret_vault_first_stage_packet_command: "npm run verify:p006-secret-vault-first-stage-packet",
  p007_production_deploy_first_stage_packet_command: "npm run verify:p007-production-deploy-first-stage-packet",
  p008_external_action_first_stage_packet_command: "npm run verify:p008-external-action-first-stage-packet",
  p009_prodlike_first_stage_packet_command: "npm run verify:p009-prodlike-first-stage-packet",
  p010_10m_first_stage_packet_command: "npm run verify:p010-10m-first-stage-packet",
  p005_real_auth_operator_packet_command: "npm run verify:p005-real-auth-operator-packet",
  p005_real_auth_artifact_intake_command: "npm run verify:p005-real-auth-artifact-intake",
  p006_secret_vault_operator_packet_command: "npm run verify:p006-secret-vault-operator-packet",
  p006_secret_vault_artifact_intake_command: "npm run verify:p006-secret-vault-artifact-intake",
  p007_production_deploy_operator_packet_command: "npm run verify:p007-production-deploy-operator-packet",
  p007_production_deploy_artifact_intake_command: "npm run verify:p007-production-deploy-artifact-intake",
  p008_external_action_operator_packet_command: "npm run verify:p008-external-action-operator-packet",
  p008_external_action_artifact_intake_command: "npm run verify:p008-external-action-artifact-intake",
  p009_prodlike_operator_packet_command: "npm run verify:p009-prodlike-operator-packet",
  p009_prodlike_artifact_intake_command: "npm run verify:p009-prodlike-artifact-intake",
  p010_10m_operator_packet_command: "npm run verify:p010-10m-operator-packet",
  p010_10m_artifact_intake_command: "npm run verify:p010-10m-artifact-intake",
  p077_operator_packet_suite_command: "npm run verify:p005-p010-operator-packet-suite",
  p085_artifact_intake_suite_command: "npm run verify:p005-p010-artifact-intake-suite",
  p086_runtime_artifact_blocker_index_command: "npm run verify:p005-p010-runtime-artifact-blocker-index",
  p087_real_auth_submission_preflight_command: "npm run verify:p005-real-auth-submission-preflight",
  p088_auth_readback_submission_manifest_command: "npm run verify:p005-auth-readback-submission-manifest",
  p089_auth_readback_manifest_alignment_command: "AUTH_READBACK_INPUT=artifacts/runtime-evidence-collection/20260702063000-p005/auth-readback.json AUTH_READBACK_RUN_ID=20260702206000-p005-manifest npm run verify:auth-readback",
  p090_auth_readback_prepromotion_packet_command: "P005_AUTH_READBACK_PREPROMOTION_RUN_ID=20260702212000-p090-p005-auth-prepromotion npm run verify:p005-auth-readback-prepromotion-packet",
  p091_p006_p010_readback_prepromotion_packet_command: "P006_P010_READBACK_PREPROMOTION_RUN_ID=20260702220000-p091-p006-p010-prepromotion npm run verify:p006-p010-readback-prepromotion-packet",
  p092_next_stage_gate_command: "P005_P010_NEXT_STAGE_GATE_RUN_ID=20260702226000-p092-next-stage-gate npm run verify:p005-p010-next-stage-gate",
  p093_real_auth_operator_handoff_command: "P005_REAL_AUTH_OPERATOR_HANDOFF_RUN_ID=20260702232000-p093-p005-auth-handoff npm run verify:p005-real-auth-operator-handoff",
  p094_runtime_evidence_submission_workspace_command: "P005_RUNTIME_EVIDENCE_SUBMISSION_WORKSPACE_RUN_ID=20260702237000-p094-p005-submission-workspace npm run verify:p005-runtime-evidence-submission-workspace",
  p095_auth_readback_readiness_gap_report_command: "P005_AUTH_READBACK_READINESS_GAP_RUN_ID=20260702242000-p095-p005-auth-gap npm run verify:p005-auth-readback-readiness-gap-report",
  p096_auth_readback_promotion_plan_command: "P005_AUTH_READBACK_PROMOTION_PLAN_RUN_ID=20260702247000-p096-p005-auth-promotion-plan npm run verify:p005-auth-readback-promotion-plan",
  p097_auth_readback_promotion_safety_snapshot_command: "P005_AUTH_READBACK_PROMOTION_SAFETY_SNAPSHOT_RUN_ID=20260702252000-p097-p005-auth-promotion-safety-snapshot npm run verify:p005-auth-readback-promotion-safety-snapshot",
  p098_auth_readback_promotion_contract_command: "P005_AUTH_READBACK_PROMOTION_CONTRACT_RUN_ID=20260702257000-p098-p005-auth-promotion-contract npm run verify:p005-auth-readback-promotion-contract",
  user_usable_today: {
    automation_creation_and_local_mvp: "confirmed-by-earlier-M001-M009-track",
    registered_daily_backup_local_run: "confirmed",
    production_saas_runtime: "not_confirmed"
  },
  blocked_runtime_capabilities: [
    "real_login_auth",
    "real_secret_vault",
    "production_deploy_and_rollback",
    "external_action_sandbox",
    "production_like_measurement",
    "ten_m_readiness"
  ],
  hard_stops_not_crossed: [
    "production deploy",
    "real login credential entry",
    "real secret vault mutation",
    "external posting/sending/deleting",
    "payment_purchase_checkout",
    "captcha_otp_security_code_identity",
    "production customer data"
  ]
};

function toAutomationRows(items: any[]): AutomationRow[] {
  return items.map((item) => ({
    id: String(item.id),
    project_id: String(item.project_id ?? "project-a"),
    automation_type: String(item.automation_type ?? item.id ?? "sns-post"),
    name: String(item.name),
    desc: String(item.desc ?? item.goal ?? ""),
    schedule: String(item.schedule ?? item.next_run_at ?? "未設定"),
    lane: String(item.lane ?? "Lane 1"),
    last: String(item.last ?? "未実行"),
    status: (["running", "waiting", "approved", "blocked", "enabled", "disabled", "draft"].includes(item.status) ? item.status : "draft") as Status
  }));
}

async function readMvpState() {
  const response = await fetch("/api/mvp/state", { cache: "no-store" });
  if (!response.ok) throw new Error("mvp_state_unavailable");
  return response.json();
}

function buildFeedbackCapture(route: string) {
  return {
    route,
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, device_pixel_ratio: window.devicePixelRatio || 1 },
    user_agent: navigator.userAgent,
    screen_text: redactSensitiveText(document.body.innerText || "").slice(0, 8000)
  };
}

async function captureAppScreenshot(): Promise<{ dataUrl: string | null; error: string | null }> {
  const width = Math.min(window.innerWidth || 1200, 1200);
  const height = Math.min(window.innerHeight || 900, 900);
  try {
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(document.body, {
      backgroundColor: "#ffffff",
      width,
      height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      scrollX: 0,
      scrollY: 0,
      ignoreElements: (element) => element.classList.contains("feedback-launcher") || element.classList.contains("feedback-panel")
    });
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.62), error: null };
  } catch {
    // Fall through to a no-dependency SVG capture so feedback still works if canvas rendering fails.
  }
  try {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".feedback-launcher,.feedback-panel").forEach((node) => node.remove());
    clone.querySelectorAll("script").forEach((node) => node.remove());
    const serialized = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("feedback_screenshot_render_failed"));
        img.src = objectUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("feedback_canvas_unavailable");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL("image/jpeg", 0.62), error: null };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (error) {
    return { dataUrl: null, error: error instanceof Error ? error.message : "feedback_screenshot_failed" };
  }
}

function captureAppScreenshotWithTimeout(timeoutMs = 3500): Promise<{ dataUrl: string | null; error: string | null }> {
  return Promise.race([
    captureAppScreenshot(),
    new Promise<{ dataUrl: string | null; error: string | null }>((resolve) => {
      window.setTimeout(() => resolve({ dataUrl: null, error: "feedback_screenshot_timeout" }), timeoutMs);
    })
  ]);
}

const lanes = [
  { name: "Lane 1", port: 9331, profile: "Startup-A", account: "startup.a@gmail.com", task: "Instagram投稿", queue: 2, lock: "ロック中", status: "running" as Status },
  { name: "Lane 2", port: 9332, profile: "Startup-A-SNS", account: "startup.sns@gmail.com", task: "X投稿", queue: 4, lock: "ロック中", status: "blocked" as Status },
  { name: "Lane 3", port: 9333, profile: "Research", account: "未割り当て", task: "なし", queue: 0, lock: "ロックなし", status: "enabled" as Status }
];

const seedApprovalItems = [
  { kind: "SNS投稿", project: "プロジェクトA", lane: "Lane 1", content: "Instagram ストーリー投稿の下書き", risk: "通常", due: "15分後", status: "waiting" as Status },
  { kind: "DM返信", project: "プロジェクトA", lane: "Lane 2", content: "価格問い合わせへの返信案", risk: "高", due: "今日", status: "waiting" as Status },
  { kind: "Runway生成", project: "プロジェクトB", lane: "Local", content: "商品画像から15秒動画を生成", risk: "高", due: "明日", status: "blocked" as Status },
  { kind: "Gmail返信", project: "プロジェクトC", lane: "Lane 3", content: "商談候補日の返信案", risk: "通常", due: "2日後", status: "waiting" as Status }
];

const templates = [
  ["SNS毎日投稿", "SNS運用", "Instagram / X / LinkedIn", "Lane 1", "承認必須"],
  ["Instagramストーリー投稿", "SNS運用", "Instagram", "Lane 1", "初回承認"],
  ["DM返信", "カスタマーサポート", "Instagram / Facebook", "Lane 2", "承認必須"],
  ["Gmail返信", "メール", "Gmail", "Lane 3", "承認必須"],
  ["競合リサーチ", "リサーチ", "Google / Sheets", "Lane 3", "自動許可"],
  ["Runway広告動画生成", "Creative / Runway", "Runway MCP", "Local", "承認必須"]
];

const plugins = [
  ["Runway MCP", "MCP Server", "Codex Bridge", "mock未接続", "8", "readiness"],
  ["Google Drive", "App Integration", "Direct MCP", "mock未接続", "4", "readiness"],
  ["Gmail", "App Integration", "Direct MCP", "mock未接続", "3", "readiness"],
  ["Slack", "MCP Server", "Direct MCP", "要再認証", "5", "一部利用不可"],
  ["Browser Use", "Codex Plugin", "Codex Bridge", "mock未接続", "6", "readiness"],
  ["Figma", "Codex Plugin", "未設定", "未認証", "2", "未検証"]
];

function useRoute() {
  const [route, setRoute] = useState(location.hash || "#/projects/project-a/artifacts");
  React.useEffect(() => {
    const onHash = () => {
      const nextRoute = location.hash || "#/projects/project-a/artifacts";
      const slug = projectSlugs.find((projectSlug) => nextRoute.includes(`/projects/${projectSlug}`));
      if (slug) rememberProject(slug);
      setRoute(nextRoute);
    };
    addEventListener("hashchange", onHash);
    onHash();
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function projectSlugFromRoute(route: string) {
  return projectSlugs.find((slug) => route.includes(`/projects/${slug}`)) ?? "project-a";
}

function automationIdFromRoute(route: string) {
  const match = route.match(/\/automations\/([^/]+)\/edit/);
  return match ? decodeURIComponent(match[1]) : "sns-post";
}

function rememberProject(slug: string) {
  window.sessionStorage.setItem("automation-os-active-project", slug);
}

function rememberedProject() {
  const saved = window.sessionStorage.getItem("automation-os-active-project");
  return projectSlugs.includes(saved ?? "") ? saved! : "project-a";
}

function projectSlugFromPrompt(prompt: string) {
  const normalized = prompt.toLowerCase().replace(/\s+/g, "");
  const match = normalized.match(/(?:project|プロジェクト)-?([abcdａｂｃｄ])/);
  if (!match) return rememberedProject();
  const letter = match[1].normalize("NFKC");
  const index = ["a", "b", "c", "d"].indexOf(letter);
  return index >= 0 ? projectSlugs[index] : rememberedProject();
}

function go(hash: string) {
  location.hash = hash.replace(/^#/, "");
}

function StatusBadge({ status, label }: { status: Status; label?: string }) {
  return <span className={`badge ${status}`}>{label ?? statusLabel(status)}</span>;
}

function statusLabel(status: Status) {
  return {
    running: "実行中",
    waiting: "承認待ち",
    approved: "承認済み",
    blocked: "要確認",
    enabled: "有効",
    disabled: "停止中",
    draft: "下書き"
  }[status];
}

function Button({ children, icon, variant = "secondary", onClick, disabled = false }: { children: React.ReactNode; icon?: React.ReactNode; variant?: "primary" | "secondary" | "danger"; onClick?: () => void; disabled?: boolean }) {
  return <button type="button" className={`btn ${variant}`} onClick={onClick} disabled={disabled}>{icon}{children}</button>;
}

function IconButton({ children, onClick, label }: { children: React.ReactNode; onClick?: () => void; label: string }) {
  return <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function App() {
  const route = useRoute();
  const [receipt, setReceipt] = useState("Local Agent は待機中です。");
  const [automationRows, setAutomationRows] = useState<AutomationRow[]>(seedAutomations);
  const [approvalRows, setApprovalRows] = useState(seedApprovalItems);
  const [createdTemplates, setCreatedTemplates] = useState<string[]>([]);
  const [mvpState, setMvpState] = useState<MvpState>({});
  const [feedbackReadback, setFeedbackReadback] = useState<MvpState["feedbacks"]>([]);
  React.useEffect(() => {
    readMvpState()
      .then((state) => {
        setMvpState(state);
        setAutomationRows(toAutomationRows(state.automations ?? []));
        const worker = state.worker?.status ? `worker=${state.worker.status}` : "worker=unknown";
        setReceipt(`MVP state readback 済みです。${worker} / runs=${state.runs?.length ?? 0}`);
      })
      .catch(() => setReceipt("Local Agent は待機中です。MVP API未接続のためローカル表示です。"));
  }, []);
  React.useEffect(() => {
    fetch("/api/mvp/feedback", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.ok === false) throw new Error("feedback_readback_failed");
        setFeedbackReadback(Array.isArray(json.feedbacks) ? json.feedbacks : []);
      })
      .catch(() => setFeedbackReadback([]));
  }, []);
  const page = useMemo(() => renderPage(route, {
    setReceipt,
    automationRows,
    setAutomationRows,
    approvalRows,
    setApprovalRows,
    createdTemplates,
    setCreatedTemplates,
    mvpState,
    setMvpState,
    feedbackReadback,
    setFeedbackReadback
  }), [route, automationRows, approvalRows, createdTemplates, mvpState, feedbackReadback]);

  return (
    <div className="app">
      <Sidebar route={route} />
      <main className="main">
        <TopHeader receipt={receipt} setReceipt={setReceipt} />
        {page}
      </main>
      <FeedbackWidget route={route} setReceipt={setReceipt} setMvpState={setMvpState} />
    </div>
  );
}

function Sidebar({ route }: { route: string }) {
  const nav = [
    ["ホーム", "#/", Home],
    ["チャット", "#/chat", MessageSquare],
    ["プロジェクト", "#/projects/project-a/automations", FolderKanban],
    ["実行履歴", "#/runs", Activity],
    ["承認", "#/approvals", ClipboardCheck],
    ["テンプレート", "#/templates", LayoutTemplate],
    ["プラグイン / MCP", "#/plugins", PlugZap],
    ["本番状態", "#/production/status", ShieldCheck],
    ["PC状態", "#/system/pc-status", Cpu]
  ] as const;
  return (
    <aside className="sidebar">
      <div className="brand">Automation OS</div>
      <nav>
        {nav.map(([label, href, Icon]) => (
          <a key={href} className={route === href || (href.includes("projects") && route.includes("projects")) ? "active" : ""} href={href}>
            <Icon size={16} /> {label}
          </a>
        ))}
      </nav>
      <div className="user">
        <div className="avatar">A</div>
        <div>
          <strong>Administrator</strong>
          <span>Local Agent</span>
        </div>
      </div>
    </aside>
  );
}

function TopHeader({ receipt, setReceipt }: { receipt: string; setReceipt: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const actions = [
    { label: "ホーム", route: "#/", keywords: "home ホーム dashboard ダッシュボード" },
    { label: "チャット", route: "#/chat", keywords: "chat チャット 作成 自動化 llm" },
    { label: "Project A", route: "#/projects/project-a/automations", keywords: "project プロジェクト プロジェクトa daily ai job nisenprints 実行" },
    { label: "実行履歴", route: "#/runs", keywords: "run worker queue 実行 履歴" },
    { label: "承認", route: "#/approvals", keywords: "approval 承認 停止 外部操作" },
    { label: "テンプレート", route: "#/templates", keywords: "template テンプレート skills skill 雛形" },
    { label: "プラグイン / MCP", route: "#/plugins", keywords: "plugin plugins プラグイン mcp runway browser" },
    { label: "本番状態", route: "#/production/status", keywords: "production 本番 deploy zeabur" },
    { label: "PC状態", route: "#/system/pc-status", keywords: "pc worker heartbeat local agent" },
    { label: "Feedback", route: "", keywords: "feedback フィードバック 問題 スクショ" }
  ];
  const submitSearch = (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = query.trim().toLowerCase();
    if (!text) {
      setReceipt(receipt);
      return;
    }
    const found = actions.find((action) => `${action.label} ${action.keywords}`.toLowerCase().includes(text));
    if (!found) {
      setReceipt(`検索: "${query}" に一致する画面が見つかりません。チャット、プロジェクトA、実行履歴、テンプレート、プラグイン、本番状態などで検索できます。`);
      return;
    }
    if (found.label === "Feedback") {
      openFeedbackFor(`検索からFeedbackを開きました: ${query}`, { source: "top_search", query });
      setReceipt("Feedbackを開きました。コメントとスクショを送信できます。");
      return;
    }
    go(found.route);
    setReceipt(`検索: ${found.label} を開きました。`);
  };
  return (
    <header className="topbar">
      <form className="search" onSubmit={submitSearch}>
        <Search size={15} />
        <input
          aria-label="画面検索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={receipt}
        />
        <button type="submit">移動</button>
      </form>
      <div className="top-actions">
        <IconButton label="同期" onClick={() => setReceipt("画面表示を更新しました。API readbackが必要な項目は各ページの再読込で確認してください。")}><RefreshCw size={16} /></IconButton>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => go("#/chat")}>新しい自動化</Button>
      </div>
    </header>
  );
}

function ProjectTabs() {
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const activeSection = subTabLabels.find(([, section]) => route.includes(`/${section}`))?.[1] ?? "automations";
  return (
    <div className="project-tabs">
      <div className="project-switcher">{projectSlugs.map((slug) => <button className={slug === activeProject ? "selected" : ""} onClick={() => { rememberProject(slug); go(`#/projects/${slug}/${activeSection}`); }} key={slug}>{projectLabels[slug]}</button>)}</div>
      <div className="sub-tabs">{subTabLabels.map(([label, section]) => {
        const href = `#/projects/${activeProject}/${section}`;
        return <a className={route === href ? "active" : ""} key={href} href={href}>{label}</a>;
      })}</div>
    </div>
  );
}

function PageTitle({ title, desc, children }: { title: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      <div className="title-actions">{children}</div>
    </div>
  );
}

function ProjectScopeNotice({ projectId }: { projectId: string }) {
  const capability = projectCapabilities[projectId] ?? projectCapabilities["project-a"];
  if (projectId === "project-a") return null;
  return (
    <div className="notice-row">
      {projectLabels[projectId]} は {capability.data_scope} です。API readbackは下書き保存まで、外部投稿・送信・削除・認証操作は実行しません。登録済みCodex App自動化はProject Aだけに接続しています。
    </div>
  );
}

function feedbackItemsFromState(state: MvpState) {
  const directFeedbacks = (state.feedbacks ?? []).map((item) => ({
    id: item.feedback_id ?? item.id,
    status: item.status ?? "open",
    project_id: item.workflow_context?.project_id ?? item.payload?.project_id ?? null,
    route: item.route ?? "unknown",
    comment: item.comment ?? item.payload?.comment ?? "",
    target: item.fix_target ?? "unknown",
    hasScreenshot: item.has_screenshot === true,
    artifact: item.artifact_uri ?? "-",
    created_at: item.created_at ?? ""
  }));
  if (directFeedbacks.length) return directFeedbacks;
  return (state.proofs ?? [])
    .filter((item) => item.kind === "ui_feedback")
    .map((item) => ({
      id: item.feedback_id ?? item.id,
      status: item.status ?? "open",
      project_id: item.project_id ?? null,
      route: item.route ?? "unknown",
      comment: item.comment_preview ?? item.comment ?? item.summary ?? "",
      target: item.fix_target ?? "unknown",
      hasScreenshot: item.has_screenshot === true,
      artifact: item.artifact_uri ?? "-"
    }));
}

function classifyFeedback(comment: string, route: string) {
  const text = `${comment} ${route}`;
  if (/反応|できない|キュー|再生|ボタン|押して/.test(text)) return "操作反応";
  if (/パフォーマンス|グラフ|見せ方|柔軟/.test(text)) return "表示改善";
  if (/スクショ|Feedback|フィードバック|Supabase|inbox/.test(text)) return "Feedback導線";
  if (/chat|チャット|リセット|Enter/i.test(text)) return "チャット";
  return "確認待ち";
}

function humanNextStepForFeedback(comment: string, route: string) {
  const category = classifyFeedback(comment, route);
  if (category === "操作反応") return "押下後にreadback、exact blocker、次の解除条件を画面へ出す";
  if (category === "表示改善") return "Project別のKPI表示とplaceholder/readback状態を分ける";
  if (category === "Feedback導線") return "送信ID、スクショ有無、inbox状態を送信後に出す";
  if (category === "チャット") return "入力、改行、送信、リセット後の状態を明示する";
  return "再現操作をChrome QAへ追加する";
}

function FeedbackFixQueue({ feedbacks, state, setReceipt, setFeedbackReadback }: { feedbacks: MvpState["feedbacks"]; state: MvpState; setReceipt: (value: string) => void; setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>> }) {
  const feedback = feedbackItemsFromState({ ...state, feedbacks });
  const allOpenItems = feedback.filter((item) => item.status === "open");
  const allTriagedItems = feedback.filter((item) => item.status === "triaged");
  const openItems = allOpenItems.slice(0, 10);
  const triagedItems = allTriagedItems.slice(0, 3);
  const updateFeedbackStatus = async (feedbackId: string, status: "open" | "triaged") => {
    try {
      const response = await fetch(`/api/mvp/feedback/${encodeURIComponent(feedbackId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.exactBlocker || result.error || "feedback_update_failed");
      const refreshed = await fetch("/api/mvp/feedback", { cache: "no-store" }).then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.ok === false) throw new Error("feedback_readback_failed");
        return Array.isArray(json.feedbacks) ? json.feedbacks : [];
      });
      setFeedbackReadback(refreshed);
      setReceipt(`Feedback ${feedbackId} を ${status} に更新しました。`);
    } catch (error) {
      setReceipt(error instanceof Error ? error.message : "Feedback の更新に失敗しました。");
    }
  };
  const rows = openItems.length ? openItems.map((item) => [
    item.id,
    classifyFeedback(item.comment, item.route),
    item.route,
    item.hasScreenshot ? "あり" : "なし",
    humanNextStepForFeedback(item.comment, item.route),
    <div className="row-actions">
      <Button onClick={() => {
        setReceipt(`Feedback ${item.id}: ${classifyFeedback(item.comment, item.route)} / ${humanNextStepForFeedback(item.comment, item.route)}`);
        if (item.route.startsWith("#/")) go(item.route);
      }}>対象を開く</Button>
      <Button variant="primary" onClick={() => updateFeedbackStatus(item.id, "triaged")}>triaged にする</Button>
    </div>
  ]) : [["open feedbackなし", "-", "-", "-", "現在のreadbackでは未処理feedbackはありません", <StatusBadge status="approved" label="完了" />]];
  return (
    <Panel title="Feedback修正キュー">
      <div className="feedback-summary">
        <strong>open {allOpenItems.length}件</strong>
        <span>triaged {allTriagedItems.length}件</span>
        <span>表示 {openItems.length}件 / 押しても分からない系を最優先</span>
      </div>
      <DataTable headers={["ID", "分類", "画面", "スクショ", "次の修正", "操作"]} rows={rows} />
      {triagedItems.length > 0 && (
        <div className="feedback-triaged">
          <strong>最近 triaged</strong>
          {triagedItems.map((item) => (
            <div key={item.id} className="feedback-triaged-item">
              <span>{item.id}</span>
              <span>{item.comment}</span>
              <Button onClick={() => updateFeedbackStatus(item.id, "open")}>open に戻す</Button>
            </div>
          ))}
        </div>
      )}
      <p className="muted">この一覧はMVP stateの feedback proof readback です。スクショ本体やsecretは表示しません。</p>
    </Panel>
  );
}

type AppModel = {
  setReceipt: (value: string) => void;
  automationRows: AutomationRow[];
  setAutomationRows: React.Dispatch<React.SetStateAction<AutomationRow[]>>;
  approvalRows: typeof seedApprovalItems;
  setApprovalRows: React.Dispatch<React.SetStateAction<typeof seedApprovalItems>>;
  createdTemplates: string[];
  setCreatedTemplates: React.Dispatch<React.SetStateAction<string[]>>;
  mvpState: MvpState;
  setMvpState: React.Dispatch<React.SetStateAction<MvpState>>;
  feedbackReadback: MvpState["feedbacks"];
  setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>>;
};

function renderPage(route: string, model: AppModel) {
  const { setReceipt } = model;
  if (route === "#/chat") return <ChatPage model={model} />;
  if (route === "#/approvals") return <ApprovalsPage model={model} />;
  if (route === "#/runs") return <RunsPage model={model} />;
  if (route === "#/templates") return <TemplatesPage model={model} />;
  if (route === "#/plugins") return <PluginsPage setReceipt={setReceipt} />;
  if (route === "#/production/status") return <ProductionStatusPage setReceipt={setReceipt} />;
  if (route === "#/system/pc-status") return <PcStatusPage model={model} />;
  if (route.includes("/performance")) return <PerformancePage model={model} />;
  if (route.includes("/automations/") && route.includes("/edit")) return <BuilderPage model={model} />;
  if (route.includes("/lanes")) return <LanesPage setReceipt={setReceipt} />;
  if (route.includes("/memory")) return <MemoryPage model={model} />;
  if (route.includes("/security")) return <SecurityPage model={model} />;
  if (route.includes("/artifacts")) return <ArtifactsPage setReceipt={setReceipt} />;
  if (route.includes("/recovery")) return <RecoveryPage setReceipt={setReceipt} />;
  if (route.includes("/runs/")) return <RunDetailPage setReceipt={setReceipt} />;
  if (route.includes("/automations")) return <AutomationsPage model={model} />;
  return <HomePage model={model} />;
}

function openFeedbackFor(comment: string, context: Record<string, unknown> = {}) {
  window.dispatchEvent(new CustomEvent("automation-os-open-feedback", { detail: { comment, context } }));
}

function FeedbackWidget({ route, setReceipt, setMvpState }: { route: string; setReceipt: (value: string) => void; setMvpState: React.Dispatch<React.SetStateAction<MvpState>> }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [capture, setCapture] = useState<any>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotStatus, setScreenshotStatus] = useState<"idle" | "capturing" | "ready" | "failed" | "skipped">("idle");
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false);
  const [feedbackContext, setFeedbackContext] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const captureGeneration = useRef(0);
  const runCapture = async (nextRoute = route) => {
    const generation = captureGeneration.current + 1;
    captureGeneration.current = generation;
    setScreenshotStatus("capturing");
    setScreenshot(null);
    setScreenshotError(null);
    const nextCapture = buildFeedbackCapture(nextRoute);
    setCapture(nextCapture);
    const image = await captureAppScreenshotWithTimeout();
    if (captureGeneration.current !== generation) return;
    setScreenshot(image.dataUrl);
    setScreenshotError(image.error);
    setScreenshotStatus(image.dataUrl ? "ready" : "failed");
    setReceipt(image.dataUrl ? "スクショを取得しました。コメントを書いて送信できます。" : "スクショなしでも送信できます。必要なら再取得してください。");
  };
  const openFeedback = async (preset?: { comment?: string; context?: Record<string, unknown> }) => {
    if (typeof preset?.comment === "string") setComment(preset.comment);
    setFeedbackContext(preset?.context ?? null);
    setOpen(true);
    setReceipt("フィードバック欄を開きました。スクショ取得中でもコメント入力できます。");
    runCapture(route);
  };
  React.useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      openFeedback({ comment: detail.comment, context: detail.context });
    };
    window.addEventListener("automation-os-open-feedback", listener);
    return () => window.removeEventListener("automation-os-open-feedback", listener);
  }, [route]);
  const close = () => {
    captureGeneration.current += 1;
    setOpen(false);
    setComment("");
    setScreenshot(null);
    setScreenshotError(null);
    setScreenshotStatus("idle");
    setSensitiveConfirmed(false);
    setFeedbackContext(null);
  };
  const skipScreenshot = () => {
    captureGeneration.current += 1;
    setScreenshot(null);
    setScreenshotError("feedback_screenshot_skipped_by_user");
    setScreenshotStatus("skipped");
    setCapture(buildFeedbackCapture(route));
    setReceipt("スクショなしで送信する準備をしました。URLと画面テキストは保存されます。");
  };
  const submit = async () => {
    const safeComment = redactSensitiveText(comment).trim();
    if (!safeComment) {
      setReceipt("コメントを入力してから送信してください。");
      return;
    }
    if (!sensitiveConfirmed) {
      setReceipt("secret、password、本人確認コードが映っていない確認にチェックしてください。");
      return;
    }
    try {
      setBusy(true);
      const response = await fetch("/api/mvp/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          comment: safeComment,
          route,
          url: location.href,
          page_title: document.title,
          capture: capture ?? buildFeedbackCapture(route),
          screenshot_data_url: screenshot,
          workflow_context: feedbackContext,
          category: feedbackContext?.source === "registered_automation" ? "automation_issue" : "bug",
          fix_target: feedbackContext?.source === "registered_automation" ? "registered_automation" : "ui",
          sensitive_content_confirmed: true
        })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.exact_blocker || result.error || "feedback_submit_failed");
      setMvpState(result.state);
      setOpen(false);
      setComment("");
      setSensitiveConfirmed(false);
      setFeedbackContext(null);
      const inbox = result.inbox_forward?.status === "sent" ? " / inbox=sent" : result.inbox_forward?.status === "failed" ? " / inbox=failed" : " / inbox=local";
      setReceipt(`フィードバックを送信しました。id=${result.feedback.feedback_id ?? result.feedback.id} / screenshot=${result.feedback.has_screenshot ? "yes" : "no"}${inbox}`);
    } catch {
      setReceipt("フィードバック保存に失敗しました。API readbackを確認してください。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="feedback-launcher" type="button" aria-label="フィードバックを送る" title="フィードバックを送る" onClick={() => openFeedback()} disabled={busy}>
        <Camera size={18} />
        <span>Feedback</span>
      </button>
      {open && (
        <div className="feedback-panel" role="dialog" aria-label="フィードバック送信">
          <div className="feedback-panel-head">
            <div>
              <strong>フィードバック</strong>
              <small>{route} / {screenshotStatus === "capturing" ? "スクショ取得中" : screenshot ? "スクショあり" : screenshotStatus === "skipped" ? "スクショなしで送信" : screenshotError ? "スクショなし" : "準備済み"}</small>
            </div>
            <IconButton label="閉じる" onClick={close}><X size={14} /></IconButton>
          </div>
          {feedbackContext && <div className="feedback-context">context: {String(feedbackContext.automation_name ?? feedbackContext.source ?? "page")}</div>}
          {screenshot ? <img className="feedback-preview" src={screenshot} alt="送信する画面キャプチャ" /> : (
            <div className={`feedback-preview missing ${screenshotStatus === "capturing" ? "loading" : ""}`}>
              {screenshotStatus === "capturing" ? "スクショ取得中です。待たずにコメントを書けます。" : "スクショなしでも送れます。URLと画面テキストは一緒に保存されます。"}
              {screenshotError && <small>{screenshotError}</small>}
            </div>
          )}
          <div className="feedback-actions">
            <Button disabled={busy || screenshotStatus === "capturing"} onClick={() => runCapture(route)}>スクショ再取得</Button>
            <Button disabled={busy} onClick={skipScreenshot}>スクショなしで送る</Button>
          </div>
          <label>
            コメント
            <textarea value={comment} disabled={busy} onChange={(event) => setComment(event.target.value)} placeholder="どこが使いにくいか、期待した動き、実際の動きを書いてください。" />
          </label>
          <label className="feedback-confirm">
            <input type="checkbox" checked={sensitiveConfirmed} onChange={(event) => setSensitiveConfirmed(event.target.checked)} />
            secret、password、token、本人確認コードが画面に映っていないことを確認しました
          </label>
          <p className="muted">password、token、private key、本人確認コードが画面に映っている時は送らないでください。</p>
          <div className="button-row">
            <Button variant="primary" icon={<MessageSquare size={14} />} disabled={busy || !sensitiveConfirmed} onClick={submit}>{busy ? "送信中..." : "送信"}</Button>
            <Button disabled={busy} onClick={close}>閉じる</Button>
          </div>
        </div>
      )}
    </>
  );
}

function HomePage({ model }: { model: AppModel }) {
  const { setReceipt, automationRows, mvpState, feedbackReadback } = model;
  const projectAAutomations = automationRows.filter((row) => (row.project_id ?? "project-a") === "project-a");
  const waitingApprovals = (mvpState.approvals ?? []).filter((approval) => approval.status === "waiting");
  const blockedRuns = (mvpState.runs ?? []).filter((run) => run.status === "blocked");
  const queuedRuns = (mvpState.runs ?? []).filter((run) => run.status === "queued");
  const feedbackRows = feedbackItemsFromState({ ...mvpState, feedbacks: feedbackReadback });
  const openFeedbackCount = feedbackRows.filter((item) => item.status === "open").length;
  const triagedFeedbackCount = feedbackRows.filter((item) => item.status === "triaged").length;
  const worker = mvpState.worker;
  const workerSummary = workerStatusSummary(worker);
  const projectCards = [
    {
      title: "プロジェクトA",
      value: `${projectAAutomations.length}件 接続`,
      sub: `Codex App登録: Daily AI / NisenPrints / Job`,
      status: projectAAutomations.length === 3 ? "enabled" : "waiting"
    },
    {
      title: "承認",
      value: `${waitingApprovals.length}件`,
      sub: "外部操作前に停止する確認待ち",
      status: waitingApprovals.length ? "waiting" : "enabled"
    },
    {
      title: "実行履歴",
      value: `${mvpState.runs?.length ?? 0}件`,
      sub: `queued ${queuedRuns.length} / blocked ${blockedRuns.length}`,
      status: queuedRuns.length ? "running" : blockedRuns.length ? "blocked" : "enabled"
    },
    {
      title: "Worker",
      value: worker?.status ?? "unknown",
      sub: workerSummary.display,
      status: workerSummary.fresh ? "enabled" : "blocked"
    }
  ];
  const liveRows = projectAAutomations.length ? projectAAutomations.map((item) => [
    item.lane,
    "-",
    "プロジェクトA",
    item.name,
    <StatusBadge status={item.status} />,
    <RowActions name={item.name} setReceipt={setReceipt} scope="Project A registered readback" />
  ]) : [["未接続", "-", "プロジェクトA", "Codex App登録自動化のreadback待ち", <StatusBadge status="waiting" />, <Button onClick={() => go("#/projects/project-a/automations")}>確認する</Button>]];
  return (
    <section>
      <PageTitle title="ホーム" desc="すべてのプロジェクトと自動化の状態を確認できます。">
        <Button variant="primary" icon={<Play size={15} />} onClick={() => setReceipt(`Project A readback: automations=${projectAAutomations.length} / queued=${queuedRuns.length} / external_action=false / worker=${workerSummary.label}${workerSummary.blocker ? ` / blocker=${workerSummary.blocker}` : ""}`)}>確認して実行</Button>
      </PageTitle>
      <div className="cards four">
        {projectCards.map((card) => <MetricCard key={card.title} title={card.title} value={card.value} sub={card.sub} status={card.status as Status} />)}
      </div>
      <div className="section-grid">
        <Panel title="ライブ実行" className="span-2">
          <DataTable headers={["Lane", "Port", "プロジェクト", "タスク", "状態", "操作"]} rows={liveRows} />
        </Panel>
        <Panel title="承認待ち">
          <div className="approval-widget">
            <strong>承認待ち {waitingApprovals.length}件</strong>
            <span>外部操作は承認前に停止</span>
            <span>queued {queuedRuns.length}件</span>
            <Button variant="primary" onClick={() => go("#/approvals")}>承認キューを開く</Button>
          </div>
        </Panel>
        <FeedbackFixQueue feedbacks={feedbackReadback} state={mvpState} setReceipt={setReceipt} setFeedbackReadback={model.setFeedbackReadback} />
      </div>
      <Panel title="進捗一覧">
        <DataTable headers={["対象", "状態", "Schedule", "Lane", "停止条件", "証跡"]} rows={projectAAutomations.map((item) => [
          item.name,
          <StatusBadge status={item.status} />,
          item.schedule,
          item.lane,
          item.status === "enabled" ? "外部操作前に承認停止" : item.last,
          "API / artifact readback"
        ])} />
      </Panel>
      <Panel title="Feedbackサマリ">
        <div className="feedback-summary compact">
          <strong>open {openFeedbackCount}件</strong>
          <span>triaged {triagedFeedbackCount}件</span>
          <span>送信後は Home からすぐ triage できます</span>
        </div>
      </Panel>
    </section>
  );
}

function ChatPage({ model }: { model: AppModel }) {
  const { setReceipt, setAutomationRows, setMvpState } = model;
  const [created, setCreated] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [requestText, setRequestText] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [planVisible, setPlanVisible] = useState(false);
  const [plannerReadback, setPlannerReadback] = useState<PlannerReadback | null>(null);
  const [chatNote, setChatNote] = useState("新しい自動化リクエストを入力できます。");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", text: "どんな自動化を作りたいですか？目的、対象サービス、止めてほしい条件を書いてください。曖昧なところは質問しながら仕様にします。" }
  ]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const submittedPromptRef = useRef("");
  const platformOptions = ["Instagram", "TikTok", "Facebook"];
  const draftPrompt = prompt.trim();
  const safePrompt = requestText.trim();
  const activePrompt = draftPrompt || safePrompt;
  const redactedActivePrompt = redactSensitiveText(activePrompt);
  const fallbackPlan = buildAutomationPlan(redactedActivePrompt, selectedPlatforms);
  const plan = plannerReadback?.plan ?? fallbackPlan;
  const targetProject = plannerReadback?.project_id ?? projectSlugFromPrompt(redactedActivePrompt);
  const plannerAdapter = plannerReadback?.planner_adapter ?? "client_deterministic_preview";
  const plannerMode = plannerReadback?.planner_mode ?? "not_requested";
  const resetChat = () => {
    setPrompt("");
    setRequestText("");
    submittedPromptRef.current = "";
    setSelectedPlatforms([]);
    setPlanVisible(false);
    setPlannerReadback(null);
    setCreated(false);
    setMessages([{ id: "welcome", role: "assistant", text: "リセットしました。前の計画や選択は引き継がず、新しい自動化として考えます。" }]);
    setReceipt("チャットをリセットしました。新しい自動化リクエストを入力できます。");
    setChatNote(`リセット完了: platform=0 / plan=false / ${actionStamp()}`);
    promptRef.current?.focus();
  };
  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((items) => {
      const next = items.includes(platform) ? items.filter((item) => item !== platform) : [...items, platform];
      setChatNote(`投稿先を更新: ${next.length ? next.join(" / ") : "未選択"} / ${actionStamp()}`);
      return next;
    });
    setPlanVisible(false);
    setPlannerReadback(null);
    setCreated(false);
  };
  const selectAllPlatforms = () => {
    setSelectedPlatforms(platformOptions);
    setPlanVisible(false);
    setPlannerReadback(null);
    setCreated(false);
    setChatNote(`投稿先を一括選択: ${platformOptions.join(" / ")} / ${actionStamp()}`);
  };
  const startPlan = async () => {
    if (!activePrompt) {
      promptRef.current?.focus();
      setReceipt("自動化リクエストを入力してからプランを作成してください。");
      setChatNote(`プラン作成待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    const readback = await requestChatPlan(redactedActivePrompt, selectedPlatforms);
    setPlannerReadback(readback);
    setRequestText(redactedActivePrompt);
    submittedPromptRef.current = activePrompt.trim();
    setPlanVisible(true);
    setCreated(false);
    setMessages((items) => [
      ...items,
      { id: nextChatId("assistant-plan"), role: "assistant", text: `${readback.plan.kind}として理解しました。${readback.plan.targetLabel}向けに、${readback.plan.schedule} / ${readback.plan.cadence}で動く下書きを作ります。${readback.plan.safetyNote} 確認したいこと: ${readback.plan.questions.join(" / ")}` }
    ]);
    setReceipt(`チャット内容から自動化プランを作成しました。planner=${readback.planner_adapter} / external_action=false`);
    setChatNote(`プラン作成完了: ${readback.plan.kind} / ${readback.plan.targetLabel} / ${actionStamp()}`);
  };
  const sendMessage = async () => {
    if (!draftPrompt) {
      promptRef.current?.focus();
      setReceipt("まず作りたい自動化を入力してください。");
      setChatNote(`送信待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    const redactedDraft = redactSensitiveText(draftPrompt);
    const readback = await requestChatPlan(redactedDraft, selectedPlatforms);
    const currentPlan = readback.plan;
    setPlannerReadback(readback);
    setRequestText(redactedDraft);
    submittedPromptRef.current = draftPrompt;
    setPrompt("");
    setMessages((items) => [
      ...items,
      { id: nextChatId("user"), role: "user", text: redactedDraft },
      { id: nextChatId("assistant"), role: "assistant", text: `${currentPlan.kind}として受け取りました。${currentPlan.targetLabel}で、${currentPlan.schedule}に${currentPlan.cadence}実行する下書きにします。${currentPlan.safetyNote} まだ必要なのは「${currentPlan.questions.join("」「")}」です。` }
    ]);
    setPlanVisible(true);
    setCreated(false);
    setReceipt(`${currentPlan.kind}の会話プランを更新しました。planner=${readback.planner_adapter} / mode=${readback.planner_mode}`);
    setChatNote(`送信完了: ${currentPlan.kind} / ${currentPlan.targetLabel} / ${actionStamp()}`);
  };
  const editPlan = () => {
    setPrompt(redactSensitiveText(safePrompt));
    setPlanVisible(false);
    setCreated(false);
    setReceipt("内容を修正できます。入力後にプランを再作成してください。");
    setChatNote(`修正モード: 既存内容を入力欄へ戻しました / ${actionStamp()}`);
    promptRef.current?.focus();
  };
  const openDetails = () => {
    setReceipt("詳細設定を開きました。Lane・承認・リトライ条件を確認できます。");
    setChatNote(`詳細設定へ移動: project=${targetProject} / kind=${plan.kind} / ${actionStamp()}`);
    rememberProject(targetProject);
    go(`#/projects/${targetProject}/automations/${automationSlugForKind(plan.kind)}/edit`);
  };
  const createFromChat = async () => {
    if (!activePrompt) {
      promptRef.current?.focus();
      setReceipt("自動化リクエストを入力してから作成してください。");
      setChatNote(`作成待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    try {
      const response = await fetch("/api/mvp/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${plan.kind}: ${redactedActivePrompt}`.slice(0, 80),
          project_id: targetProject,
          automation_type: automationSlugForKind(plan.kind),
          desc: "チャットから作成した安全なMVP自動化",
          goal: `${redactedActivePrompt} / ${plan.targetLabel} 向けに下書き作成まで行い、外部操作前に承認で停止する`,
          schedule: plan.schedule,
          cadence: plan.cadence,
          lane: "Lane 1",
          risk_level: "high",
          approval_policy: plan.approvalPolicy,
          worker_command_kind: "safe_local_demo",
          create_approval: true,
          builder_spec: {
            source: "chat",
            prompt: redactedActivePrompt,
            planner_adapter: plannerAdapter,
            planner_mode: plannerMode,
            planner_schema_version: plannerReadback?.planner_schema_version ?? "client-preview",
            planner_model_ref: plannerReadback?.planner_model_ref ?? null,
            plan_title: plan.title,
            target_label: plan.targetLabel,
            steps: plan.steps,
            questions: plan.questions,
            safety_note: plan.safetyNote,
            approval_policy: plan.approvalPolicy,
            external_action_allowed: false
          }
        })
      });
      if (!response.ok) throw new Error("create_automation_failed");
      const result = await response.json();
      setMvpState(result.state);
      setAutomationRows(toAutomationRows(result.state.automations ?? []));
      setCreated(true);
      setReceipt(`Automation Builder に自動化案を保存しました。automation=${result.automation.id}`);
      setChatNote(`作成完了: automation=${result.automation.id} / ${actionStamp()}`);
      rememberProject(targetProject);
      go(`#/projects/${targetProject}/automations/${result.automation.id}/edit`);
    } catch {
      setCreated(false);
      setReceipt("Automation Builder への保存に失敗しました。実体のない編集画面へは進みません。MVP API readbackを確認してください。");
      setChatNote(`作成失敗: MVP API readbackを確認してください / ${actionStamp()}`);
    }
  };
  return (
    <section className="chat-page">
      <PageTitle title="チャット" desc="自然言語から自動化を作成します。">
        <Button icon={<RefreshCw size={14} />} onClick={resetChat}>会話をリセット</Button>
      </PageTitle>
      <div className="action-note" role="status">{chatNote}</div>
      <div className="chat-shell">
        <div className="chat-thread">
          <div className="message-list" aria-live="polite">
            {messages.map((message) => <Bubble key={message.id} side={message.role === "user" ? "user" : undefined}>{message.text}</Bubble>)}
          </div>
          <div className="choice-row">
            {platformOptions.map((platform) => (
              <button className={selectedPlatforms.includes(platform) ? "selected" : ""} onClick={() => togglePlatform(platform)} key={platform}>{platform}</button>
            ))}
            <button className={selectedPlatforms.length === platformOptions.length ? "selected" : ""} onClick={selectAllPlatforms}>Instagram / TikTok / Facebook</button>
            <button onClick={() => { setChatNote(`詳細入力へフォーカスしました / ${actionStamp()}`); promptRef.current?.focus(); }}>詳細を書く</button>
          </div>
          <label className="chat-input">
            自動化リクエスト
            <textarea
              ref={promptRef}
              aria-label="自動化リクエスト"
              value={prompt}
              onChange={(event) => {
                const nextPrompt = event.target.value;
                const normalizedNextPrompt = nextPrompt.trim();
                if (planVisible && normalizedNextPrompt && normalizedNextPrompt === submittedPromptRef.current) return;
                setPrompt(nextPrompt);
                setPlanVisible(false);
                setCreated(false);
                setChatNote(`入力更新: ${normalizedNextPrompt.length}文字 / ${actionStamp()}`);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
                event.preventDefault();
                const target = event.currentTarget;
                const start = target.selectionStart ?? prompt.length;
                const end = target.selectionEnd ?? prompt.length;
                target.setRangeText("\n", start, end, "end");
                setPrompt(target.value);
                setPlanVisible(false);
                setCreated(false);
                setChatNote(`改行を挿入しました / ${actionStamp()}`);
              }}
              placeholder="例: 毎日GoogleでAIの最新情報を探してまとめてLINEに通知する自動化を作って。"
            />
          </label>
          <div className="button-row">
            <Button variant="primary" icon={<MessageSquare size={14} />} onClick={sendMessage} disabled={!draftPrompt}>送信して考える</Button>
            <Button onClick={startPlan} disabled={!activePrompt}>プランを再作成</Button>
            <Button onClick={resetChat}>入力をリセット</Button>
          </div>
          {planVisible && (
          <div className="plan-card">
            <h3>{plan.title}</h3>
            <p className="muted">{plan.targetLabel} / {plan.cadence} / {plan.schedule} / 外部操作前に承認停止</p>
            <p className="muted">planner: {plannerAdapter} / {plannerMode}{plannerReadback?.exact_blocker ? ` / ${plannerReadback.exact_blocker}` : ""}</p>
            {plan.steps.map((s, i) => <div className="step-line" key={s}><span>{i + 1}</span>{s}</div>)}
            <div className="question-box">
              <strong>確認したいこと</strong>
              {plan.questions.map((question) => <p key={question}>{question}</p>)}
            </div>
            <div className="button-row">
              <Button variant="primary" onClick={createFromChat}>この内容で作成</Button>
              <Button onClick={editPlan}>内容を修正</Button>
              <Button onClick={openDetails}>詳細設定を開く</Button>
            </div>
          </div>
          )}
          {created && <Bubble>作成済みです。Automation Builder で仕様を編集できます。</Bubble>}
        </div>
        <aside className="side-panel">
          <h3>Automation Builder</h3>
          <p>{planVisible ? `${plan.kind}として仕様化中です。${plan.safetyNote}` : "入力と選択が完了すると、ここに自動化案の状態が反映されます。"}</p>
          <p className="muted">{planVisible ? `${plan.targetLabel} / ${plan.schedule} / ${plan.cadence}` : "送信すると会話とプランが更新されます。"}</p>
          <p className="muted">{planVisible ? `planner ${plannerAdapter}` : "server-side planner readbackで仕様化します。"}</p>
          <StatusBadge status="draft" />
        </aside>
      </div>
    </section>
  );
}

function AutomationsPage({ model }: { model: AppModel }) {
  const { setReceipt, automationRows, setAutomationRows, setMvpState } = model;
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabels[activeProject];
  const visibleAutomationRows = automationRows.filter((row) => (row.project_id ?? "project-a") === activeProject);
  const [registeredReadback, setRegisteredReadback] = useState<RegisteredAutomationReadback>({});
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [automationReceipts, setAutomationReceipts] = useState<Record<string, string>>({});
  const [registeredReceipts, setRegisteredReceipts] = useState<Record<string, string>>({});
  const [registeredRequestingId, setRegisteredRequestingId] = useState<string | null>(null);
  const [pageNote, setPageNote] = useState("定期実行を開きました。押した操作の結果はここにも表示します。");
  const registeredRequestInFlight = useRef(false);
  React.useEffect(() => {
    setPendingDelete(null);
    setIsDeleting(false);
  }, [activeProject]);
  React.useEffect(() => {
    let stale = false;
    setPageNote(`${projectName} 定期実行を開きました。押した操作の結果はここにも表示します / ${actionStamp()}`);
    if (activeProject !== "project-a") {
      setRegisteredReadback({});
      setRegisteredReceipts({});
      return () => {
        stale = true;
      };
    }
    fetch("/api/mvp/registered-automations?project_id=project-a", { cache: "no-store" })
      .then(async (response) => {
        const readback = await response.json().catch(() => ({}));
        if (!response.ok || readback.ok === false) throw new Error(readback.exact_boundary || readback.exact_blocker || `registered_automation_readback_http_${response.status}`);
        return readback;
      })
      .then((readback) => {
        if (stale) return;
        setRegisteredReadback(readback);
        setReceipt(`Codex App登録自動化 readback 済みです。count=${readback.automation_count ?? 0}`);
        setPageNote(`Codex App登録自動化 readback完了: count=${readback.automation_count ?? 0} / ${actionStamp()}`);
      })
      .catch((error) => {
        if (stale) return;
        const exact = error instanceof Error ? error.message : "registered_automation_readback_unavailable";
        setRegisteredReadback({ ok: false, read_only: true, exact_boundary: exact, automations: [] });
        setReceipt(`Codex App登録自動化 readback 失敗: ${exact}`);
        setPageNote(`Codex App登録自動化 readback失敗: ${exact} / ${actionStamp()}`);
      });
    return () => {
      stale = true;
    };
  }, [activeProject, projectName]);
  const runAutomation = async (id: string, name: string) => {
    try {
      setAutomationReceipts((prev) => ({ ...prev, [id]: "API readback確認中 / まだ実行開始は未確定です" }));
      const response = await fetch(`/api/mvp/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      if (!response.ok) throw new Error("run_queue_failed");
      const result = await response.json();
      setMvpState(result.state);
      setAutomationRows(toAutomationRows(result.state.automations ?? []));
      const message = `queued run=${result.run.id}${result.duplicate ? " / duplicate lock" : ""} / local_runner_pending / external_action=false`;
      setAutomationReceipts((prev) => ({ ...prev, [id]: message }));
      setReceipt(`${name}: ${message}。PC workerが拾うまでは外部サービス上の操作は始まりません。実行履歴でrun状態を確認してください。`);
      setPageNote(`${name}: ${message} / 次: 実行履歴でworker pickupとproofを確認 / ${actionStamp()}`);
    } catch {
      setAutomationReceipts((prev) => ({ ...prev, [id]: "API readback失敗 / 実行開始なし" }));
      setReceipt(`${name} はAPI readbackなしのため実行開始していません。queued状態は未確認です。`);
      setPageNote(`${name}: API readback失敗 / 実行開始なし / ${actionStamp()}`);
    }
  };
  const requestDeleteAutomation = (id: string, name: string) => {
    setPendingDelete({ id, name });
    setReceipt(`${name} の削除は確認待ちです。外部サービス上の投稿やデータは削除しません。`);
    setPageNote(`${name}: 削除確認を開きました。まだ削除していません / ${actionStamp()}`);
  };
  const deleteAutomation = async () => {
    if (!pendingDelete || isDeleting) return;
    const { id, name } = pendingDelete;
    try {
      setIsDeleting(true);
      const response = await fetch(`/api/mvp/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.exact_blocker || result.error || "delete_failed");
      setMvpState(result.state);
      setAutomationRows(toAutomationRows(result.state.automations ?? []));
      setPendingDelete(null);
      setIsDeleting(false);
      setReceipt(`${name} を削除しました。external_action_executed=false / schedule removed`);
      setPageNote(`${name}: 内部設定を削除しました / external_action=false / ${actionStamp()}`);
    } catch {
      setIsDeleting(false);
      setReceipt(`${name} は削除できませんでした。API readbackを確認してください。`);
      setPageNote(`${name}: 削除失敗 / API readbackを確認してください / ${actionStamp()}`);
    }
  };
  const requestRegisteredRun = async (item: any) => {
    const name = item.name ?? item.id;
    if (!item.can_run) {
      describeRegistered(item);
      return;
    }
    if (registeredRequestInFlight.current) {
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "別の確認が進行中です。完了後に再試行してください。" }));
      return;
    }
    try {
      registeredRequestInFlight.current = true;
      setRegisteredRequestingId(item.id);
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "preflight / proof readback確認中..." }));
      setPageNote(`${name}: preflight / proof readback確認中 / ${actionStamp()}`);
      const response = await fetch(`/api/mvp/registered-automations/${encodeURIComponent(item.id)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: "project-a" })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exact_blocker || result.error || `registered_automation_http_${response.status}`);
      if (result.ok) {
        const readOnly = result.read_only === false ? "false" : "true";
        const externalAction = result.external_action_executed === true ? "true" : "false";
        const proof = result.latest_proof ? `proof=${result.latest_proof.status ?? "available"}` : "proof=artifact_readback_pending";
        const blocker = result.exact_blocker ?? result.blocked_action ?? "none";
        const next = externalAction === "true" ? "停止: 外部action検出のため証跡確認" : "次: proof/readback確認、必要なら人間ログイン/CDP lane";
        const message = `accepted / read-only=${readOnly} / external_action=${externalAction} / ${proof} / blocker=${blocker} / ${next}`;
        setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
        setReceipt(`${name}: ${message}`);
        setPageNote(`${name}: ${message} / ${actionStamp()}`);
        return;
      }
      const proof = result.latest_proof ? ` / latest=${result.latest_proof.status ?? "proof"} ${result.latest_proof.checked_at ?? ""}` : "";
      const message = `blocked / read-only=true / blocker=${result.exact_blocker ?? "registered_automation_preflight_only"}${proof}`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "registered_automation_request_failed";
      const message = `blocked / read-only=true / blocker=${exact} / 実行開始なし`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } finally {
      registeredRequestInFlight.current = false;
      setRegisteredRequestingId(null);
    }
  };
  const describeRegistered = (item: any) => {
    const proof = item.latest_proof ? ` / proof=${item.latest_proof.status ?? "available"} ${item.latest_proof.checked_at ?? ""}` : " / proof=missing";
    const action = item.preflight_status ?? item.ui_action ?? "read-only";
    const status = item.can_run ? "runnable" : "blocked";
    const blocker = item.exact_blocker ?? item.blocked_action ?? "none";
    const next = item.can_run ? "次: read-only preflightを実行" : blocker === "none" ? "次: proofを確認" : "次: blocker解除条件を満たす";
    const message = `${status} / read-only=true / ${action} / blocker=${blocker}${proof} / external_action=false / ${next}`;
    setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
    setReceipt(`${item.name ?? item.id}: ${message}`);
    setPageNote(`${item.name ?? item.id}: ${message} / ${actionStamp()}`);
  };
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={projectName} desc="定期実行">
        <Button icon={<Plus size={15} />} variant="primary" onClick={() => { setPageNote(`新規追加: チャットへ移動します / ${actionStamp()}`); go("#/chat"); }}>新規追加</Button>
      </PageTitle>
      <div className="action-note" role="status">{pageNote}</div>
      <ProjectScopeNotice projectId={activeProject} />
      {pendingDelete && (
        <div className="confirm-panel" role="dialog" aria-label="削除確認">
          <div>
            <strong>{pendingDelete.name} を削除しますか？</strong>
            <p>内部の自動化設定とスケジュールだけを削除します。外部サービス上の投稿やデータは削除しません。</p>
          </div>
          <div className="button-row compact">
            <Button variant="danger" disabled={isDeleting} onClick={deleteAutomation}>{isDeleting ? "削除中" : "削除する"}</Button>
            <Button disabled={isDeleting} onClick={() => { setPendingDelete(null); setReceipt("削除をキャンセルしました。"); setPageNote(`削除をキャンセルしました / ${actionStamp()}`); }}>キャンセル</Button>
          </div>
        </div>
      )}
      {activeProject === "project-a" && (
        <Panel title="Project A 操作ガイド">
          <div className="status-grid">
            <div><strong>実行ボタン</strong><span>read-only preflightを行い、外部投稿・応募・削除は実行しません。</span></div>
            <div><strong>結果表示</strong><span>押下後はこのページ上部、行内receipt、上部バーに exact blocker / proof / external_action を表示します。</span></div>
            <div><strong>次に必要なこと</strong><span>ログイン、CDP lane、sandbox/test承認、OTP/本人確認などが必要な時は人間対応として表示します。</span></div>
            <div><strong>安全境界</strong><span>UI操作は external_action=false を期待境界にし、readbackで true が出た場合はblockerとして扱います。</span></div>
          </div>
        </Panel>
      )}
      <Panel title="自動化一覧">
        <DataTable headers={["タスク名", "説明", "スケジュール", "Lane", "最終実行", "ステータス", "操作"]} rows={visibleAutomationRows.length ? visibleAutomationRows.map((a) => [a.name, a.desc, a.schedule, a.lane, a.last, <StatusBadge status={a.status} />, <div className="row-actions"><IconButton label={`${a.name}を実行`} onClick={() => runAutomation(a.id, a.name)}><Play size={14} /></IconButton><IconButton label={`${a.name}を編集`} onClick={() => { setPageNote(`${a.name}: 編集画面へ移動します / ${actionStamp()}`); go(`#/projects/${activeProject}/automations/${a.id}/edit`); }}><Edit3 size={14} /></IconButton><IconButton label={`${a.name}を削除`} onClick={() => requestDeleteAutomation(a.id, a.name)}><Trash2 size={14} /></IconButton><IconButton label={`${a.name}の詳細`} onClick={() => { const message = `Lane=${a.lane} / status=${a.status} / ${actionStamp()}`; setAutomationReceipts((prev) => ({ ...prev, [a.id]: message })); setPageNote(`${a.name}: ${message}`); setReceipt(`${a.name} の詳細を選択しました。${message}`); }}><MoreHorizontal size={14} /></IconButton>{automationReceipts[a.id] && <small className="inline-action-receipt">{automationReceipts[a.id]}</small>}</div>]) : [["このプロジェクトの自動化はまだありません", "チャットから追加できます", "-", "-", "-", <StatusBadge status="draft" />, <Button onClick={() => { setPageNote(`作成する: チャットへ移動します / ${actionStamp()}`); go("#/chat"); }}>作成する</Button>]]} />
      </Panel>
      {activeProject === "project-a" && (
        <Panel title="Codex App登録済み自動化">
          <p className="muted">Project Aだけに接続しています。外部投稿・応募・削除・認証突破はせず、押した操作はproof確認か exact blocker を返します。</p>
          <DataTable
            headers={["名前", "状態", "実行クラス", "判定", "Blocker / Proof", "操作"]}
            rows={(registeredReadback.automations ?? []).length ? (registeredReadback.automations ?? []).map((item) => [
              item.name ?? item.id,
              item.status ?? "-",
              item.execution_class ?? "-",
              <StatusBadge status={item.can_run ? "enabled" : item.latest_proof ? "approved" : "blocked"} label={item.action_label ?? item.ui_action ?? "read-only"} />,
              item.latest_proof ? `${item.latest_proof.status ?? "proof"} / ${item.latest_proof.source_ref ?? "latest"}` : (item.exact_blocker ?? item.blocked_action ?? "-"),
              <div className="row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={item.action_label ?? "確認"}
                  title={item.action_label ?? "確認"}
                  onClick={() => requestRegisteredRun(item)}
                  disabled={Boolean(registeredRequestingId)}
                >
                  {registeredRequestingId === item.id ? <Clock size={14} /> : item.can_run ? <Play size={14} /> : <ShieldCheck size={14} />}
                </button>
                <IconButton label="問題を送る" onClick={() => openFeedbackFor(`${item.name ?? item.id}: `, {
                  source: "registered_automation",
                  automation_id: item.id,
                  automation_name: item.name ?? item.id,
                  project_id: "project-a",
                  preflight_status: item.preflight_status ?? item.ui_action ?? item.action_label ?? "read-only",
                  exact_blocker: item.exact_blocker ?? item.blocked_action ?? "",
                  route: location.hash || "#/projects/project-a/automations"
                })}><AlertTriangle size={14} /></IconButton>
                <IconButton label="詳細" onClick={() => describeRegistered(item)}><MoreHorizontal size={14} /></IconButton>
                {registeredReceipts[item.id] && <small className="inline-action-receipt">{registeredReceipts[item.id]}</small>}
              </div>
            ]) : [["Codex App登録自動化のreadbackがありません", registeredReadback.exact_boundary ?? "unavailable", "-", "-", "-", <StatusBadge status="waiting" label="read-only" />]]}
          />
          <div className="receipt-strip">
            source={registeredReadback.source_ref ?? "unavailable"} / preflight={registeredReadback.preflight_run_id ?? "missing"} / proof={registeredReadback.latest_proof_run_id ?? "missing"}
          </div>
        </Panel>
      )}
      <button className="fab" aria-label="新規追加" onClick={() => { setPageNote(`新規追加FAB: チャットへ移動します / ${actionStamp()}`); go("#/chat"); }}><Plus size={22} /></button>
    </section>
  );
}

function PerformancePage({ model }: { model: AppModel }) {
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabels[activeProject];
  const { mvpState } = model;
  const hasProjectMetrics = activeProject === "project-a";
  const projectAutomationIds = new Set((mvpState.automations ?? []).filter((item) => (item.project_id ?? "project-a") === activeProject).map((item) => item.id));
  const projectRuns = (mvpState.runs ?? []).filter((run) => {
    return run.project_id === activeProject || projectAutomationIds.has(run.automation_id);
  });
  const projectRunIds = new Set(projectRuns.map((run) => run.id));
  const projectProofIdsFromRuns = new Set(projectRuns.flatMap((run) => run.proof_ids ?? []));
  const proofBelongsToProject = (proof: any) => {
    if (proof.project_id) return proof.project_id === activeProject;
    if (proof.automation_id && projectAutomationIds.has(proof.automation_id)) return true;
    if (proof.run_id && projectRunIds.has(proof.run_id)) return true;
    return Boolean(proof.id && projectProofIdsFromRuns.has(proof.id));
  };
  const projectProofs = (mvpState.proofs ?? []).filter(proofBelongsToProject);
  const projectFeedbackItems = feedbackItemsFromState(mvpState).filter((item) => item.project_id === activeProject || item.route.includes(`/projects/${activeProject}/`));
  const blockedRuns = projectRuns.filter((run) => run.status === "blocked");
  const completeRuns = projectRuns.filter((run) => ["complete", "completed"].includes(run.status));
  const completionReadback = projectRuns.length ? `${completeRuns.length}/${projectRuns.length}` : "未計測";
  const metrics = hasProjectMetrics
    ? [["実行数", String(projectRuns.length || 0), "MVP state readback", "enabled"], ["完了readback", completionReadback, blockedRuns.length ? `blocked ${blockedRuns.length}` : "strict成功とは別", blockedRuns.length ? "blocked" : "waiting"], ["Proof", String(projectProofs.length), "Project A関連のみ", projectProofs.length ? "enabled" : "waiting"], ["Worker", mvpState.worker?.status ?? "unknown", mvpState.worker?.readback_status ?? "MVP state", mvpState.worker?.status === "idle" ? "enabled" : "waiting"]]
    : [["実行数", "0", "未接続Project", "waiting"], ["完了readback", "未計測", "Project Aのみ接続済み", "waiting"], ["エンゲージメント", "未計測", "外部SNS readback待ち", "waiting"], ["返信対応数", "0", "DM / Gmail未接続", "waiting"]];
  const laneRows = hasProjectMetrics
    ? [["Lane 1", String(projectRuns.filter((run) => run.lane === "Lane 1").length), String(projectRuns.filter((run) => run.lane === "Lane 1" && run.status === "blocked").length), "未計測", String(mvpState.worker?.queue_depth ?? 0)], ["Lane 2", String(projectRuns.filter((run) => run.lane === "Lane 2").length), String(projectRuns.filter((run) => run.lane === "Lane 2" && run.status === "blocked").length), "未計測", "readback待ち"], ["Lane 3", String(projectRuns.filter((run) => run.lane === "Lane 3").length), String(projectRuns.filter((run) => run.lane === "Lane 3" && run.status === "blocked").length), "未計測", "readback待ち"]]
    : [["このプロジェクトのLane実績はまだありません", "-", "-", "-", "-"]];
  const kpiRows = hasProjectMetrics ? [
    ["Daily AI", "投稿重複防止 / proof確認", `${projectProofs.filter((proof) => /daily|ai/i.test(`${proof.id ?? ""} ${proof.kind ?? ""} ${proof.workflow ?? ""}`)).length} proof`, "投稿URL・重複skip・cleanup"],
    ["Job Manager", "応募/assessment境界", `${projectProofs.filter((proof) => /job|application/i.test(`${proof.id ?? ""} ${proof.kind ?? ""} ${proof.workflow ?? ""}`)).length} proof`, "会社名・求人URL・送信前停止"],
    ["NisenPrints", "product/listing/pin重複防止", `${projectProofs.filter((proof) => /nisen|printify|etsy|pinterest/i.test(`${proof.id ?? ""} ${proof.kind ?? ""} ${proof.workflow ?? ""}`)).length} proof`, "Printify/Etsy/Pinterest ID対応"],
    ["Feedback", "操作詰まりの改善", `${projectFeedbackItems.filter((item) => item.status === "open").length} open`, "open feedbackを修正キューへ"]
  ] : [["このProject", "未接続", "readback待ち", "Project Aのみ実workflow接続"]];
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={projectName} desc="パフォーマンス" />
      <ProjectScopeNotice projectId={activeProject} />
      <div className="cards four">
        {metrics.map(([title, value, sub, status]) => <MetricCard title={title} value={value} sub={sub} status={status as Status} key={title} />)}
      </div>
      <div className="section-grid">
        <Panel title="実行パフォーマンス" className="span-2"><LineChart /></Panel>
        <Panel title="チャネル別成果"><Bars /></Panel>
      </div>
      <Panel title="Project別KPI設計">
        <DataTable headers={["対象", "見るべき指標", "現在のreadback", "次の確認"]} rows={kpiRows} />
        <p className="muted">Project AはMVP state/API readbackから表示します。未接続Projectは実データが入るまで未計測として扱います。</p>
      </Panel>
      <Panel title="Lane別状況"><DataTable headers={["Lane", "成功", "失敗", "平均時間", "キュー"]} rows={laneRows} /></Panel>
    </section>
  );
}

function BuilderPage({ model }: { model: AppModel }) {
  const { setReceipt, mvpState, setMvpState, setAutomationRows } = model;
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabels[activeProject];
  const routeAutomationKey = automationIdFromRoute(route);
  const persistedAutomation = mvpState.automations?.find((item) => item.id === routeAutomationKey && (item.project_id ?? "project-a") === activeProject)
    ?? mvpState.automations?.find((item) => (item.project_id ?? "project-a") === activeProject && item.automation_type === routeAutomationKey);
  const automationId = persistedAutomation?.id ?? routeAutomationKey;
  const persistedSpec = mvpState.builder_specs?.find((item) => item.automation_id === automationId);
  const builderType = persistedAutomation?.automation_type ?? routeAutomationKey;
  const builderKind = builderType === "gmail-reply"
    ? "メール返信"
    : builderType === "research-report"
      ? "リサーチ"
      : builderType === "research-notification"
        ? "情報収集・通知"
        : builderType === "daily-ai"
          ? "Daily AI"
          : builderType === "nisenprints"
            ? "NisenPrints"
            : builderType === "codex-job-manager"
              ? "Codex Job Manager"
              : "SNS投稿";
  const builderTitle = `${builderKind} 自動化仕様`;
  const automationName = persistedAutomation?.name
    ?? (builderKind === "メール返信"
      ? "Gmail返信"
      : builderKind === "リサーチ"
        ? "リサーチレポート"
        : builderKind === "情報収集・通知"
          ? "AI最新情報 LINE通知"
          : builderKind === "Daily AI"
            ? "Daily AI"
            : builderKind === "NisenPrints"
              ? "NisenPrints"
              : builderKind === "Codex Job Manager"
                ? "Codex Job Manager"
                : "SNS投稿");
  const [builderDraft, setBuilderDraft] = useState({
    name: automationName,
    lane: persistedAutomation?.lane ?? "Lane 1",
    schedule: persistedAutomation?.schedule ?? "09:00",
    approval_policy: persistedAutomation?.approval_policy ?? (builderKind === "情報収集・通知" ? "required_before_external_notification" : "毎回承認"),
    retry_rule: persistedSpec?.spec?.retry_rule ?? "最大3回 / 5分間隔"
  });
  const [enabled, setEnabled] = useState([true, true, true, true, true, false, true]);
  const [builderNotice, setBuilderNotice] = useState("外部投稿・送信・公開はまだ実行していません。");
  const persistedSteps: string[] = Array.isArray(persistedSpec?.spec?.steps)
    ? persistedSpec.spec.steps.map((step: any) => typeof step === "string" ? step : step?.title).filter(Boolean)
    : [];
  const steps: string[] = persistedSteps.length ? persistedSteps : builderKind === "メール返信"
    ? ["対象メールを抽出", "返信案を生成", "個人情報とsecretを検査", "下書き作成", "承認待ち", "メール送信", "送信レポート保存"]
    : builderKind === "リサーチ"
      ? ["調査対象を確認", "参照元を収集", "要点を整理", "レポート下書き作成", "レビュー待ち", "成果物保存", "引用元レポート保存"]
      : builderKind === "情報収集・通知"
        ? ["検索条件を確認", "Google/Webから最新情報を収集", "重複と信頼性を検査", "要約を作成", "LINE通知下書き作成", "承認待ち", "readbackと証跡を保存"]
        : builderKind === "Daily AI"
          ? ["AIニュース候補を読む", "投稿案を作成", "重複投稿を確認", "SNS/Sheets証跡を確認", "外部投稿前に承認で停止", "cleanupを保存"]
          : builderKind === "NisenPrints"
            ? ["新規トピック重複確認", "Canva/画像素材確認", "Printify商品準備", "Etsy listing確認", "Pinterestリンク確認", "公開/削除/支払い境界で停止", "manifestとreadbackを保存"]
            : builderKind === "Codex Job Manager"
              ? ["求人キューを読む", "候補URLと会社名を確認", "応募前フォームを準備", "送信/assessment/本人確認の前で停止", "証跡とcleanupを保存"]
            : ["Google Driveから素材取得", "投稿文を生成", "Instagram / TikTok / Facebookに接続", "下書き作成", "承認待ち", "投稿実行", "レポート保存"];
  const builderInputSources = builderKind === "メール返信"
    ? "Gmail / Project Memory / 承認メモ"
    : builderKind === "リサーチ"
      ? "Web / Google Drive / Sheets / Project Memory"
      : builderKind === "情報収集・通知"
        ? "Google検索 / Web / Project Memory / LINE接続情報"
        : builderKind === "Daily AI"
          ? "ニュースソース / Project Memory / Sheets / SNS account readback"
          : builderKind === "NisenPrints"
            ? "Canva / Printify / Etsy / Pinterest / 商品manifest"
            : builderKind === "Codex Job Manager"
              ? "求人キュー / 会社URL / 応募フォームreadback / Project Memory"
              : "Google Drive / スプレッドシート / ブランドガイドライン / Plugin output";
  const builderOutputs = builderKind === "メール返信"
    ? "返信下書き / 承認ログ / 送信証跡"
    : builderKind === "リサーチ"
      ? "調査レポート / 引用元一覧 / Artifact"
      : builderKind === "情報収集・通知"
        ? "要約 / LINE通知下書き / 承認ログ / Artifact"
        : builderKind === "Daily AI"
          ? "投稿下書き / 投稿直前停止receipt / Sheets同期証跡 / Artifact"
          : builderKind === "NisenPrints"
            ? "商品準備manifest / 既存ID readback / 公開直前停止receipt / Artifact"
            : builderKind === "Codex Job Manager"
              ? "求人候補一覧 / 応募直前停止receipt / 会社URL・入力内容証跡 / Artifact"
              : "SNS投稿レポート / 投稿ログ / Artifact";
  const builderRiskBoundary = builderKind === "Daily AI"
    ? "SNS投稿、外部通知、削除、認証突破は承認必須です。投稿直前で停止します。"
    : builderKind === "NisenPrints"
      ? "商品作成、公開、Pin投稿、削除、支払い、checkout、認証突破は承認必須です。既存IDを保持して直前停止します。"
      : builderKind === "Codex Job Manager"
        ? "応募submit、assessment/test、本人確認、メール認証、個人情報送信は承認必須です。送信直前で停止します。"
        : "投稿、DM送信、メール送信、LINE/Webhook/外部通知、広告出稿、課金生成、削除は承認必須です。";
  const noteBuilder = (message: string) => {
    setBuilderNotice(message);
    setReceipt(message);
  };
  React.useEffect(() => {
    setBuilderDraft({
      name: automationName,
      lane: persistedAutomation?.lane ?? "Lane 1",
      schedule: persistedAutomation?.schedule ?? "09:00",
      approval_policy: persistedAutomation?.approval_policy ?? (builderKind === "情報収集・通知" ? "required_before_external_notification" : "毎回承認"),
      retry_rule: persistedSpec?.spec?.retry_rule ?? "最大3回 / 5分間隔"
    });
  }, [automationId, persistedAutomation?.updated_at, persistedSpec?.updated_at]);
  const saveBuilder = async () => {
    try {
      const specPayload = {
        automation_type: automationSlugForKind(builderKind),
        steps: steps.map((step, index) => ({ title: step, enabled: enabled[index] })),
        retry_rule: builderDraft.retry_rule,
        approval_policy: builderDraft.approval_policy,
        external_action_allowed: false
      };
      if (!persistedAutomation) {
        const createResponse = await fetch("/api/mvp/automations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: builderDraft.name,
            project_id: activeProject,
            automation_type: automationSlugForKind(builderKind),
            desc: `${builderKind} Builderから作成した安全なMVP自動化`,
            goal: `${builderDraft.name} の下書き作成まで行い、外部操作前に承認で停止する`,
            schedule: builderDraft.schedule,
            cadence: "daily",
            lane: builderDraft.lane,
            risk_level: "high",
            approval_policy: builderDraft.approval_policy,
            worker_command_kind: "safe_local_demo",
            create_approval: true,
            builder_spec: specPayload
          })
        });
        if (!createResponse.ok) throw new Error("automation_create_failed");
        const createResult = await createResponse.json();
        setMvpState(createResult.state);
        setAutomationRows(toAutomationRows(createResult.state.automations ?? []));
        noteBuilder("Builder設定を新しい下書きとして保存し、API readbackで確認しました。外部投稿・送信は未実行です。");
        go(`#/projects/${activeProject}/automations/${createResult.automation.id}/edit`);
        return;
      }
      const patchResponse = await fetch(`/api/mvp/automations/${encodeURIComponent(automationId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: builderDraft.name,
          lane: builderDraft.lane,
          schedule: builderDraft.schedule,
          approval_policy: builderDraft.approval_policy,
          project_id: activeProject,
          automation_type: automationSlugForKind(builderKind)
        })
      });
      if (!patchResponse.ok) throw new Error("automation_patch_failed");
      const patchResult = await patchResponse.json();
      const specResponse = await fetch(`/api/mvp/automations/${encodeURIComponent(automationId)}/builder-spec`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(specPayload)
      });
      if (!specResponse.ok) throw new Error("builder_spec_save_failed");
      const specResult = await specResponse.json();
      setMvpState(specResult.state ?? patchResult.state);
      setAutomationRows(toAutomationRows((specResult.state ?? patchResult.state).automations ?? []));
      noteBuilder("Builder設定を保存し、API readbackで確認しました。外部投稿・送信は未実行です。");
    } catch {
      noteBuilder("Builder設定の保存は未確認です。API readbackに失敗しました。");
    }
  };
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={builderTitle} desc="チャットやテンプレートから生成された自動化を編集します。">
        <Button onClick={saveBuilder}>下書きとして保存</Button>
        <Button onClick={() => noteBuilder("mockテスト候補を作成しました。外部実行・投稿はしていません。")}>テスト実行</Button>
        <Button variant="primary" onClick={() => noteBuilder("公開は確認待ちです。承認キューへ送る前のレビュー状態です。")}>公開</Button>
      </PageTitle>
      <ProjectScopeNotice projectId={activeProject} />
      <div className="builder-grid">
        <div>
          <Panel title="基本設定">
            <div className="form-grid">
              <label>自動化名<input value={builderDraft.name} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, name: event.target.value }))} /></label>
              <label>プロジェクト<input value={projectName} readOnly /></label>
              <label>Lane<input value={builderDraft.lane} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, lane: event.target.value }))} /></label>
              <label>スケジュール<input value={builderDraft.schedule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, schedule: event.target.value }))} /></label>
              <label>承認ポリシー<input value={builderDraft.approval_policy} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, approval_policy: event.target.value }))} /></label>
              <label>リトライルール<input value={builderDraft.retry_rule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, retry_rule: event.target.value }))} /></label>
            </div>
          </Panel>
          <Panel title="ワークフロー手順">
            {steps.map((s, i) => <div className="workflow-row" key={s}><span className="drag">::</span><strong>{i + 1}. {s}</strong><button className={enabled[i] ? "switch on" : "switch"} onClick={() => setEnabled((prev) => prev.map((v, idx) => idx === i ? !v : v))} /><IconButton label="編集" onClick={() => noteBuilder(`${s} の編集対象を選択しました。ローカル表示のみで保存は未実行です。`)}><Edit3 size={14} /></IconButton><IconButton label="テスト実行" onClick={() => noteBuilder(`${s} のmockテスト候補を作成しました。外部実行はしていません。`)}><Play size={14} /></IconButton></div>)}
          </Panel>
        </div>
        <aside className="side-panel">
          <h3>入力元</h3><p>{builderInputSources}</p>
          <h3>出力</h3><p>{builderOutputs}</p>
          <h3>危険操作</h3><p>{builderRiskBoundary}</p>
          <div className="preview-box">{builderNotice}</div>
          <Button variant="primary" onClick={() => noteBuilder("現在設定のmockテスト候補を作成しました。実ブラウザ・外部投稿・送信は未実行です。")}>現在設定でmockテスト</Button>
        </aside>
      </div>
    </section>
  );
}

function ApprovalsPage({ model }: { model: AppModel }) {
  const { setReceipt, approvalRows, mvpState, setMvpState } = model;
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalStatusNote, setApprovalStatusNote] = useState("");
  const persistedApprovals = (mvpState.approvals ?? []).map((approval) => ({
    id: approval.id,
    kind: approval.kind,
    content: approval.content,
    project: approval.project_id,
    lane: "MVP API",
    due: approval.updated_at?.slice(0, 10) ?? "-",
    risk: approval.external_action_allowed ? "要確認" : "外部操作なし",
    status: approval.status === "waiting" ? "waiting" as Status : approval.status === "rejected" ? "blocked" as Status : "approved" as Status
  }));
  const visibleApprovals = persistedApprovals.filter((approval) => approval.status === "waiting");
  const selectedIndex = visibleApprovals.length ? Math.min(selected, visibleApprovals.length - 1) : -1;
  const item = selectedIndex >= 0 ? visibleApprovals[selectedIndex] : null;
  React.useEffect(() => {
    if (selected !== selectedIndex) setSelected(selectedIndex < 0 ? 0 : selectedIndex);
  }, [selected, selectedIndex]);
  React.useEffect(() => {
    setApprovalNote(`${item?.content ?? "承認候補はありません"} を確認しました。`);
    setApprovalStatusNote(item ? `${item.kind}: ${item.content} を選択 / ${actionStamp()}` : `承認候補はありません / ${actionStamp()}`);
    setEditing(false);
  }, [selected, item?.id, item?.content]);
  const updateSelectedApproval = async (decision: "approve" | "reject") => {
    if (!item?.id) {
      setReceipt("承認候補はありません。外部送信・投稿は実行していません。");
      return;
    }
    try {
      const response = await fetch(`/api/mvp/approvals/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note: approvalNote || "UIから確認。外部操作は許可していません。" })
      });
      if (!response.ok) throw new Error("approval_update_failed");
      const result = await response.json();
      setMvpState(result.state);
      setEditing(false);
      setReceipt(`${item.kind} を${decision === "approve" ? "local draft承認" : "却下"}として保存しました。外部送信・投稿は実行していません。`);
      setApprovalStatusNote(`${item.kind}: ${decision === "approve" ? "local draft承認" : "却下"}として保存 / external_action=false / ${actionStamp()}`);
    } catch {
      setReceipt(`${item.kind} の状態保存は未確認です。外部送信・投稿は実行していません。`);
      setApprovalStatusNote(`${item.kind}: 状態保存は未確認 / external_action=false / ${actionStamp()}`);
    }
  };
  const approveSelected = () => {
    updateSelectedApproval("approve");
  };
  const rejectSelected = () => {
    updateSelectedApproval("reject");
  };
  return (
    <section>
      <PageTitle title="承認キュー" desc="複数プロジェクト横断の確認待ちを処理します。">
        <Button disabled={!visibleApprovals.length} onClick={() => { setApprovalStatusNote(`一括承認候補を確認しました。対象=${visibleApprovals.length} / 状態変更なし / ${actionStamp()}`); setReceipt("一括承認候補を確認しました。状態変更や外部実行はしていません。"); }}>一括承認</Button>
      </PageTitle>
      <div className="action-note" role="status">{approvalStatusNote || `承認候補 ${visibleApprovals.length}件 / external_action=false`}</div>
      <div className="split">
        <Panel title="承認待ち一覧" className="list-panel">
          {visibleApprovals.length ? visibleApprovals.map((a, i) => <button key={a.id ?? a.content} className={`list-row approval-row ${i === selectedIndex ? "selected" : ""}`} onClick={() => { setSelected(i); setApprovalStatusNote(`${a.kind}: ${a.content} を選択 / ${actionStamp()}`); }}><span>{a.kind}</span><strong>{a.content}</strong><small>{a.project} / {a.lane}</small><StatusBadge status={a.status} label={a.status === "approved" ? "local draft承認" : a.risk} /></button>) : (
            <div className="empty-state">
              <strong>承認待ちはありません</strong>
              <span>API readback上、外部操作前の確認待ちは0件です。</span>
            </div>
          )}
        </Panel>
        <aside className="side-panel wide">
          {item ? (
            <>
              <h3>{item.kind}</h3>
              <p className="muted">{item.project} / {item.lane} / 期限 {item.due}</p>
              <div className="preview-box">{item.content} の全文プレビューです。送信前に人間が承認し、必要なら編集します。外部投稿・送信・応募・公開は承認と証跡なしに実行しません。</div>
              {editing && <label>修正メモ<textarea aria-label="承認修正メモ" value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label>}
              <div className="button-row"><Button variant="primary" icon={<Check size={15} />} onClick={approveSelected}>承認</Button><Button icon={<Edit3 size={15} />} onClick={() => { setEditing(true); setApprovalStatusNote(`${item.kind}: 編集欄を開きました / ${actionStamp()}`); setReceipt(`${item.kind} の編集欄を開きました。`); }}>編集</Button><Button variant="danger" onClick={rejectSelected}>却下</Button></div>
            </>
          ) : (
            <>
              <h3>承認待ちはありません</h3>
              <p className="muted">API readback / external_action=false</p>
              <div className="preview-box">新しい承認が作成されると、対象workflow、停止条件、証跡URI、操作ボタンがここに表示されます。</div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function RunsPage({ model }: { model: AppModel }) {
  const { mvpState, setMvpState, setReceipt, setAutomationRows } = model;
  const runs = mvpState.runs ?? [];
  const proofs = mvpState.proofs ?? [];
  const worker = mvpState.worker;
  const [statusFilter, setStatusFilter] = useState("active");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [workerPreview, setWorkerPreview] = useState<any>(null);
  const [actionNote, setActionNote] = useState("実行履歴を開きました。再読込、worker、filter操作の結果はここにも表示します。");
  const projectForRun = (run: any) => mvpState.automations?.find((automation) => automation.id === run.automation_id)?.project_id ?? "project-a";
  const statusMatches = (run: any) => {
    if (statusFilter === "active") return ["queued", "running"].includes(run.status);
    if (statusFilter === "blocked") return run.status === "blocked";
    if (statusFilter === "completed") return run.status === "completed";
    return true;
  };
  const filteredRuns = runs.filter((run) => statusMatches(run) && (projectFilter === "all" || projectForRun(run) === projectFilter));
  const activeRuns = runs.filter((run) => ["queued", "running"].includes(run.status));
  const activeRunsForProject = activeRuns.filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter);
  const blockedRuns = runs.filter((run) => run.status === "blocked");
  const completedRuns = runs.filter((run) => run.status === "completed");
  const workerSummary = workerStatusSummary(worker);
  const selectedRun = runs.find((run) => run.id === selectedRunId && filteredRuns.some((filtered) => filtered.id === run.id)) ?? filteredRuns[0] ?? null;
  const selectedProofs = selectedRun ? proofs.filter((proof) => selectedRun.proof_ids?.includes(proof.id)) : [];
  const refresh = async () => {
    try {
      const state = await readMvpState();
      setMvpState(state);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setReceipt(`Runs readback 済みです。runs=${state.runs?.length ?? 0} / proofs=${state.proofs?.length ?? 0}`);
      await refreshWorkerPreview(projectFilter);
      setActionNote(`再読込完了: runs=${state.runs?.length ?? 0} / proofs=${state.proofs?.length ?? 0} / project=${projectFilter} / ${actionStamp()}`);
    } catch {
      setReceipt("Runs readback に失敗しました。MVP API接続を確認してください。");
      setActionNote(`再読込失敗: MVP API接続を確認してください / ${actionStamp()}`);
    }
  };
  React.useEffect(() => {
    refresh();
  }, []);
  const refreshWorkerPreview = async (projectId = projectFilter) => {
    try {
      const body = projectId === "all" ? { limit: 10 } : { project_id: projectId, limit: 10 };
      const response = await fetch("/api/mvp/worker/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error("worker_preview_failed");
      const result = await response.json();
      setWorkerPreview(result);
      const blocker = result.exact_blocker ? ` / blocker=${result.exact_blocker}` : "";
      setReceipt(`worker preview: queued=${result.picked_count ?? 0} / highRisk=${result.high_risk_count ?? 0}${blocker} / external_action=false`);
      setActionNote(`worker preview更新: project=${projectId} / queued=${result.picked_count ?? 0} / highRisk=${result.high_risk_count ?? 0}${blocker} / ${actionStamp()}`);
    } catch {
      setWorkerPreview(null);
      setReceipt("worker preview に失敗しました。実行はしていません。");
      setActionNote(`worker preview失敗: project=${projectId} / 実行はしていません / ${actionStamp()}`);
    }
  };
  const runWorkerOnce = async () => {
    if (workerSummary.blocker) {
      setReceipt(`${workerSummary.blocker}: worker heartbeat/readback が必要です。外部操作はしていません。`);
      setActionNote(`worker実行停止: ${workerSummary.blocker} / ${workerSummary.nextAction} / ${actionStamp()}`);
      return;
    }
    try {
      const body = projectFilter === "all" ? { limit: 10 } : { project_id: projectFilter, limit: 10 };
      const response = await fetch("/api/mvp/worker/once", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error("worker_once_failed");
      const result = await response.json();
      setMvpState(result.state);
      setAutomationRows(toAutomationRows(result.state.automations ?? []));
      if (result.exact_blocker) {
        setReceipt(`${result.exact_blocker}: worker heartbeat/readback が必要です。外部操作はしていません。`);
        setActionNote(`worker実行停止: ${result.exact_blocker} / ${result.next_action ?? "Mac worker laneを起動してください"} / ${actionStamp()}`);
        return;
      }
      setReceipt(result.picked ? `worker が ${result.processed_runs?.length ?? 1}件を処理しました。latest=${result.run.id} / status=${result.run.status}` : "worker は待機中です。queued runはありません。");
      setActionNote(result.picked ? `worker実行完了: processed=${result.processed_runs?.length ?? 1} / latest=${result.run.id} / status=${result.run.status} / ${actionStamp()}` : `worker実行完了: queued runはありません。外部操作はしていません / ${actionStamp()}`);
    } catch {
      setReceipt("worker 実行に失敗しました。MVP API接続を確認してください。");
      setActionNote(`worker実行失敗: MVP API接続を確認してください / ${actionStamp()}`);
    }
  };
  return (
    <section>
      <PageTitle title="実行履歴" desc="MVP stateからrun、worker、proofを読み取ります。">
        <Button icon={<RefreshCw size={15} />} onClick={refresh}>再読込</Button>
        <Button variant="primary" icon={<Play size={15} />} onClick={runWorkerOnce} disabled={Boolean(workerSummary.blocker)}>workerを実行</Button>
      </PageTitle>
      <div className="action-note" role="status">{actionNote}</div>
      <div className="cards four">
        <MetricCard title="Runs" value={String(runs.length)} sub="durable state" status={runs.length ? "enabled" : "waiting"} />
        <MetricCard title="Proofs" value={String(proofs.length)} sub="artifact readback" status={proofs.length ? "enabled" : "waiting"} />
        <MetricCard title="Worker" value={worker?.status ?? "unknown"} sub={workerSummary.display} status={workerSummary.fresh ? "enabled" : "blocked"} />
        <MetricCard title="Queue" value={String(worker?.queue_depth ?? 0)} sub="queued runs" status={(worker?.queue_depth ?? 0) > 0 ? "running" : "enabled"} />
      </div>
      <Panel title="Worker Impact Preflight">
        <div className="filter-row">
          {[
            ["all", "全Project"],
            ...projectSlugs.map((slug) => [slug, projectLabels[slug]])
          ].map(([key, label]) => <button key={key} className={projectFilter === key ? "selected" : ""} onClick={() => { setProjectFilter(key); setActionNote(`Project filter: ${label} を選択しました。previewを更新しています / ${actionStamp()}`); refreshWorkerPreview(key); }}>{label}</button>)}
        </div>
        <DataTable headers={["項目", "値", "意味"]} rows={[
          ["対象queued", String(workerPreview?.picked_count ?? activeRunsForProject.length), "この条件でworkerが処理候補にする件数"],
          ["Project内訳", JSON.stringify(workerPreview?.by_project ?? {}), "API preview readback"],
          ["高リスク", String(workerPreview?.high_risk_count ?? 0), "外部操作前にblockedへ止める対象"],
          ["Preview blocker", workerPreview?.exact_blocker ?? workerSummary.blocker ?? "none", workerPreview?.next_action ?? workerSummary.nextAction],
          ["Heartbeat", workerSummary.label, workerSummary.blocker ? `blocker=${workerSummary.blocker}` : "fresh readback"],
          ["次の一手", workerSummary.nextAction, "worker completion expectation"],
          ["安全境界", "external_action_executed=false", "投稿・送信・削除・認証突破・課金操作なし"]
        ]} />
      </Panel>
      <div className="split">
        <Panel title="Run readback" className="list-panel">
          <div className="filter-row">
            {[
              ["active", `処理中 ${activeRuns.length}`],
              ["blocked", `停止 ${blockedRuns.length}`],
              ["completed", `完了 ${completedRuns.length}`],
              ["all", `全て ${runs.length}`]
            ].map(([key, label]) => <button key={key} className={statusFilter === key ? "selected" : ""} onClick={() => { setStatusFilter(key); setActionNote(`Status filter: ${label} を選択しました。表示run=${runs.filter((run) => {
              if (key === "active") return ["queued", "running"].includes(run.status);
              if (key === "blocked") return run.status === "blocked";
              if (key === "completed") return run.status === "completed";
              return true;
            }).filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter).length} / ${actionStamp()}`); }}>{label}</button>)}
          </div>
          <DataTable headers={["Run", "Automation", "Status", "Trigger", "Queued", "Blocker", "Proofs"]} rows={filteredRuns.slice(0, 20).map((run) => [
            <button className="link-button" onClick={() => { setSelectedRunId(run.id); setActionNote(`Run選択: ${run.id} / status=${run.status} / ${actionStamp()}`); }}>{run.id}</button>,
            run.automation_name ?? run.automation_id,
            <StatusBadge status={run.status === "completed" ? "approved" : run.status === "blocked" ? "blocked" : run.status === "running" ? "running" : "waiting"} label={run.status} />,
            run.trigger ?? "-",
            run.queued_at ?? "-",
            run.exact_blocker ?? "-",
            String(run.proof_ids?.length ?? 0)
          ])} />
        </Panel>
        <aside className="side-panel wide">
          <h3>Latest proof</h3>
          {selectedRun ? <p className="muted">{selectedRun.id} / {selectedRun.status}</p> : <p className="muted">runはまだありません。</p>}
          {selectedProofs.length ? selectedProofs.map((proof) => (
            <div className="preview-box" key={proof.id}>
              <strong>{proof.kind}</strong>
              <p>{proof.summary}</p>
              <small>{proof.artifact_uri}</small>
              <small>sha256 {String(proof.sha256).slice(0, 16)}...</small>
            </div>
          )) : <div className="preview-box">最新runにproofはまだありません。</div>}
          <h3>Worker readback</h3>
          <p>{worker?.id ?? "unknown"} / {worker?.status ?? "unknown"} / queue {worker?.queue_depth ?? 0}</p>
          <p className="muted">{workerSummary.display}</p>
        </aside>
      </div>
    </section>
  );
}

function LanesPage({ setReceipt }: { setReceipt: (value: string) => void }) {
  const [selected, setSelected] = useState(0);
  const [laneNote, setLaneNote] = useState("Lane操作の結果はここに表示します。ブラウザ起動やプロセス停止は実行しません。");
  const route = useRoute();
  const projectName = projectLabels[projectSlugFromRoute(route)];
  const selectedLane = lanes[selected];
  const requestLaneBrowser = (lane: typeof lanes[number]) => {
    setReceipt(`${lane.name} のブラウザ確認リクエストを作成しました。実Chrome起動は未実行です。`);
    setLaneNote(`${lane.name}: ブラウザ確認リクエストを作成しました。実Chrome起動は未実行です / ${actionStamp()}`);
  };
  const selectLane = (index: number) => {
    setSelected(index);
    setLaneNote(`${lanes[index].name} を選択しました。Port ${lanes[index].port} / ${lanes[index].profile} / ${actionStamp()}`);
  };
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={projectName} desc="Lane">
        <Button icon={<Plus size={15} />} onClick={() => { setReceipt("Lane追加フォームを準備しました。実Chrome profile作成は人間確認後に進めます。"); setLaneNote(`Lane追加フォームを準備しました。実Chrome profile作成は人間確認後に進めます / ${actionStamp()}`); }}>Laneを追加</Button>
      </PageTitle>
      <ProjectScopeNotice projectId={projectSlugFromRoute(route)} />
      <div className="action-note" role="status">{laneNote}</div>
      <p className="muted">Laneは共有実行面の表示です。{projectName}固有の実行状態はAPI readback後に反映します。</p>
      <Panel title="LaneはPlaywright実行環境の分離単位です">
        <DataTable headers={["Lane名", "Port", "Google Profile", "Browser Status", "使用アカウント", "現在のタスク", "キュー数", "ロック状態", "操作"]} rows={lanes.map((l, i) => [l.name, String(l.port), l.profile, <StatusBadge status={l.status} />, l.account, `${projectName} / ${l.task}`, String(l.queue), l.lock, <div className="row-actions"><IconButton label={`${l.name}を選択`} onClick={() => selectLane(i)}><ChevronRight size={14} /></IconButton><IconButton label={`${l.name}のブラウザを開く`} onClick={() => requestLaneBrowser(l)}><Network size={14} /></IconButton>{selected === i && <small className="inline-action-receipt">選択中 / {laneNote}</small>}</div>])} />
      </Panel>
      <aside className="floating-detail"><h3>{selectedLane.name}</h3><p>Port {selectedLane.port} / {selectedLane.profile}</p><Button icon={<Network size={14} />} onClick={() => requestLaneBrowser(selectedLane)}>ブラウザ確認</Button><Button onClick={() => { setReceipt(`${selectedLane.name} のPort ${selectedLane.port} 確認リクエストを作成しました。実ポート検査は未実行です。`); setLaneNote(`${selectedLane.name}: Port ${selectedLane.port} 確認リクエストを作成しました。実ポート検査は未実行です / ${actionStamp()}`); }}>ポート確認</Button><Button onClick={() => { setReceipt(`${selectedLane.name} のProfileロック解除は人間確認待ちです。`); setLaneNote(`${selectedLane.name}: Profileロック解除は人間確認待ちです / ${actionStamp()}`); }}>Profileロック解除</Button><Button variant="danger" onClick={() => { setReceipt(`${selectedLane.name} の停止は確認待ちです。実プロセスは停止していません。`); setLaneNote(`${selectedLane.name}: 停止は確認待ちです。実プロセスは停止していません / ${actionStamp()}`); }}>Lane停止</Button></aside>
    </section>
  );
}

function MemoryPage({ model }: { model: AppModel }) {
  const { setReceipt, mvpState, setMvpState } = model;
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabels[activeProject];
  const createMemoryItems = () => [
    { key: "business", title: "事業概要", body: "このプロジェクトで必要なビジネス情報を保存しています。非表示のプロジェクトルールや運用方針も背景で活用されます。" },
    { key: "target", title: "ターゲット", body: "このプロジェクトで必要なビジネス情報を保存しています。非表示のプロジェクトルールや運用方針も背景で活用されます。" },
    { key: "brand", title: "ブランドトーン", body: "このプロジェクトで必要なビジネス情報を保存しています。非表示のプロジェクトルールや運用方針も背景で活用されます。" },
    { key: "product", title: "商品情報", body: "このプロジェクトで必要なビジネス情報を保存しています。非表示のプロジェクトルールや運用方針も背景で活用されます。" }
  ];
  const createLoginRows = () => [
    { platform: "Instagram", accountRef: "placeholder / 未確認", secretRef: "secret未確認", twoFactor: "未確認", updated: "未確認" },
    { platform: "TikTok", accountRef: "placeholder / 未確認", secretRef: "secret未確認", twoFactor: "未確認", updated: "未確認" },
    { platform: "LinkedIn", accountRef: "placeholder / 未確認", secretRef: "secret未確認", twoFactor: "未確認", updated: "未確認" }
  ];
  const [memoryByProject, setMemoryByProject] = useState(() => Object.fromEntries(projectSlugs.map((slug) => [slug, createMemoryItems()])));
  const [editingMemory, setEditingMemory] = useState(0);
  const [memoryDraft, setMemoryDraft] = useState(createMemoryItems()[0].body);
  const [loginByProject, setLoginByProject] = useState(() => Object.fromEntries(projectSlugs.map((slug) => [slug, createLoginRows()])));
  const [editingLogin, setEditingLogin] = useState(0);
  const [loginDraft, setLoginDraft] = useState(createLoginRows()[0].accountRef);
  const [memoryNote, setMemoryNote] = useState("保存情報を開きました。編集・保存・接続参照更新の結果はここにも表示します。");
  const persistedMemory = mvpState.project_memory?.filter((item) => item.project_id === activeProject).map((item) => ({ key: item.key, title: item.title, body: item.body })) ?? [];
  const persistedLogins = mvpState.account_refs?.filter((item) => item.project_id === activeProject).map((item) => ({ platform: item.platform, accountRef: item.account_ref, secretRef: item.secret_ref, twoFactor: item.two_factor, updated: item.updated_at?.slice(0, 10) ?? "readback" })) ?? [];
  const memoryItems = persistedMemory.length ? persistedMemory : (memoryByProject[activeProject] ?? createMemoryItems());
  const localLoginRows = loginByProject[activeProject] ?? createLoginRows();
  const loginRows = persistedLogins.length
    ? [
      ...localLoginRows.map((row) => persistedLogins.find((persisted) => persisted.platform === row.platform) ?? row),
      ...persistedLogins.filter((persisted) => !localLoginRows.some((row) => row.platform === persisted.platform))
    ]
    : localLoginRows;
  React.useEffect(() => {
    setEditingMemory(0);
    setMemoryDraft(memoryItems[0]?.body ?? createMemoryItems()[0].body);
    setEditingLogin(0);
    setLoginDraft(loginRows[0]?.accountRef ?? createLoginRows()[0].accountRef);
  }, [activeProject, mvpState.updated_at]);
  const selectMemory = (index: number) => {
    setEditingMemory(index);
    setMemoryDraft(memoryItems[index].body);
    setReceipt(`${projectName} の ${memoryItems[index].title} を編集できます。`);
    setMemoryNote(`${projectName}: ${memoryItems[index].title} を選択 / ${actionStamp()}`);
  };
  const saveMemory = async () => {
    const redactedMemoryDraft = redactSensitiveText(memoryDraft);
    setMemoryByProject((all) => ({ ...all, [activeProject]: memoryItems.map((item, index) => index === editingMemory ? { ...item, body: redactedMemoryDraft } : item) }));
    try {
      const item = memoryItems[editingMemory];
      const response = await fetch(`/api/mvp/projects/${encodeURIComponent(activeProject)}/memory/${encodeURIComponent(item.key)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: item.title, body: redactedMemoryDraft })
      });
      if (!response.ok) throw new Error("memory_save_failed");
      const result = await response.json();
      setMvpState(result.state);
      setReceipt(`${projectName} の ${item.title} を保存し、API readbackで確認しました。`);
      setMemoryNote(`${projectName}: ${item.title} を保存 / API readback済み / ${actionStamp()}`);
    } catch {
      setReceipt(`${projectName} の ${memoryItems[editingMemory].title} はローカル表示のみ更新しました。API readbackは未確認です。`);
      setMemoryNote(`${projectName}: ${memoryItems[editingMemory].title} をローカル更新 / API readback未確認 / ${actionStamp()}`);
    }
  };
  const selectLogin = (index: number) => {
    setEditingLogin(index);
    setLoginDraft(loginRows[index].accountRef);
    setReceipt(`${loginRows[index].platform} の接続参照を編集できます。secret値はこの画面では扱いません。`);
    setMemoryNote(`${projectName}: ${loginRows[index].platform} の接続参照を選択 / secret値は扱いません / ${actionStamp()}`);
  };
  const saveLogin = async () => {
    const redactedLoginDraft = redactSensitiveText(loginDraft);
    setLoginByProject((all) => ({ ...all, [activeProject]: loginRows.map((row, index) => index === editingLogin ? { ...row, accountRef: redactedLoginDraft, updated: "2026-07-03" } : row) }));
    try {
      const row = loginRows[editingLogin];
      const response = await fetch(`/api/mvp/projects/${encodeURIComponent(activeProject)}/account-refs/${encodeURIComponent(row.platform)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_ref: redactedLoginDraft, two_factor: row.twoFactor })
      });
      if (!response.ok) throw new Error("account_ref_save_failed");
      const result = await response.json();
      setMvpState(result.state);
      setReceipt(`${row.platform} の接続参照を保存し、API readbackで確認しました。secret値は保存していません。`);
      setMemoryNote(`${projectName}: ${row.platform} 接続参照を保存 / API readback済み / secret値なし / ${actionStamp()}`);
    } catch {
      setReceipt(`${loginRows[editingLogin].platform} の接続参照をローカル表示で更新しました。API readbackは未確認です。secret値は保存していません。`);
      setMemoryNote(`${projectName}: ${loginRows[editingLogin].platform} 接続参照をローカル更新 / API readback未確認 / secret値なし / ${actionStamp()}`);
    }
  };
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={projectName} desc="保存情報 / Project Memory" />
      <ProjectScopeNotice projectId={activeProject} />
      <div className="action-note" role="status">{memoryNote}</div>
      <div className="cards two">
        {memoryItems.map((item, index) => (
          <div className={`panel memory-card ${editingMemory === index ? "selected" : ""}`} key={item.title}>
            <div className="panel-head">
              <h2>{item.title}</h2>
              <IconButton label={`${item.title}を編集`} onClick={() => selectMemory(index)}><MoreHorizontal size={16} /></IconButton>
            </div>
            <p>{item.body}</p>
          </div>
        ))}
      </div>
      <div className="section-grid">
        <Panel title="ログイン情報 / 接続アカウント" className="span-2">
          <DataTable headers={["プラットフォーム", "アカウント参照", "Secret参照", "2段階認証", "最終更新", "操作"]} rows={loginRows.map((row, index) => [row.platform, row.accountRef, row.secretRef, row.twoFactor, row.updated, <IconButton label={`${row.platform}を編集`} onClick={() => selectLogin(index)}><Edit3 size={14} /></IconButton>])} />
        </Panel>
        <aside className="side-panel wide">
          <h3>{memoryItems[editingMemory].title}を編集</h3>
          <label>保存内容<textarea value={memoryDraft} onChange={(event) => { setMemoryDraft(event.target.value); setMemoryNote(`${projectName}: ${memoryItems[editingMemory].title} 入力更新 ${event.target.value.trim().length}文字 / ${actionStamp()}`); }} aria-label="保存情報の編集" /></label>
          <Button variant="primary" onClick={saveMemory}>保存情報を保存</Button>
          <h3>{loginRows[editingLogin].platform} 接続情報</h3>
          <label>アカウント参照<input value={loginDraft} onChange={(event) => { setLoginDraft(event.target.value); setMemoryNote(`${projectName}: ${loginRows[editingLogin].platform} 接続参照入力更新 / secret値なし / ${actionStamp()}`); }} aria-label="アカウント参照" /></label>
          <p className="muted">パスワードやtokenはこのUIに入力・保存しません。secret更新は外部の承認済みlaneで別途確認します。</p>
          <Button onClick={saveLogin}>接続参照を更新</Button>
        </aside>
      </div>
    </section>
  );
}

function SecurityPage({ model }: { model: AppModel }) {
  const { mvpState, setReceipt } = model;
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabels[activeProject];
  const [securityNote, setSecurityNote] = useState("接続・権限を開きました。接続サービスの操作結果はここに表示します。実ログインやOTP突破は実行しません。");
  const policies = ["閲覧", "下書き作成", "投稿", "DM送信", "メール送信", "画像生成", "動画生成", "広告出稿", "削除"];
  const services = ["Google Drive", "Gmail", "Instagram", "TikTok", "Facebook", "LinkedIn", "Slack", "Runway"];
  const accountRefs = mvpState.account_refs?.filter((item) => item.project_id === activeProject) ?? [];
  const serviceAction = (service: string, action: string) => {
    const message = `${projectName} ${service}: ${action} / login_state=not_verified_here / external_action=false / ${actionStamp()}`;
    setSecurityNote(message);
    setReceipt(message);
  };
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={projectName} desc="接続・権限・セキュリティ" />
      <ProjectScopeNotice projectId={activeProject} />
      <div className="action-note" role="status">{securityNote}</div>
      <p className="muted">この表はプロジェクト別の接続参照表示です。実認証readbackは未接続です。</p>
      <div className="section-grid">
        <Panel title="接続サービス" className="span-2"><DataTable headers={["サービス", "接続アカウント", "ステータス", "操作"]} rows={services.map((s, i) => {
          const persisted = accountRefs.find((item) => item.platform === s);
          const accountRef = persisted?.account_ref ?? "placeholder / 未確認";
          const status = persisted ? <StatusBadge status="enabled" label="参照あり" /> : <StatusBadge status="waiting" label="未確認" />;
          return [s, accountRef, status, <div className="row-actions"><IconButton label={`${s}接続テスト`} onClick={() => serviceAction(s, "接続テスト候補を表示。実ログイン/API callなし")}><Play size={14} /></IconButton><IconButton label={`${s}詳細`} onClick={() => serviceAction(s, `account_ref=${accountRef}`)}><MoreHorizontal size={14} /></IconButton><IconButton label={`${s}問題を送る`} onClick={() => openFeedbackFor(`${projectName} ${s}: 接続サービスの操作について`, { source: "connection_service", service: s, project_id: activeProject, route: location.hash || "#/projects/project-a/security" })}><AlertTriangle size={14} /></IconButton></div>];
        })} /></Panel>
        <Panel title="セキュリティ"><CheckList items={["二段階認証", "シークレット保管", "認証情報ローテーション", "許可されたローカルフォルダ", "危険な操作の保護", `Redaction readback: ${mvpState.redaction_readback?.ok ? "pass" : "未確認"}`]} /></Panel>
      </div>
      <Panel title="権限ポリシー"><DataTable headers={["アクション", "ポリシー"]} rows={policies.map((p) => [p, p === "閲覧" || p === "下書き作成" ? "自動許可" : p === "削除" ? "禁止" : "承認必須"])} /></Panel>
    </section>
  );
}

function PcStatusPage({ model }: { model: AppModel }) {
  const { setReceipt, mvpState, setMvpState, setAutomationRows } = model;
  const worker = mvpState.worker;
  const workerSummary = workerStatusSummary(worker);
  const [pcNote, setPcNote] = useState("PC状態を開きました。再確認結果はここにも表示します。");
  const refresh = async () => {
    try {
      const state = await readMvpState();
      setMvpState(state);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      const nextSummary = workerStatusSummary(state.worker);
      setReceipt(`Local Agent heartbeat readback 済みです。worker=${state.worker?.status ?? "unknown"} / queue=${state.worker?.queue_depth ?? 0}${nextSummary.blocker ? ` / blocker=${nextSummary.blocker}` : ""}`);
      setPcNote(`Local Agent readback完了: worker=${state.worker?.status ?? "unknown"} / queue=${state.worker?.queue_depth ?? 0} / ${nextSummary.display} / ${actionStamp()}`);
    } catch {
      setReceipt("Local Agent のMVP readbackに失敗しました。");
      setPcNote(`Local Agent readback失敗: MVP API接続を確認してください / ${actionStamp()}`);
    }
  };
  return (
    <section>
      <PageTitle title="PC状態" desc="ユーザーPC上のAutomation OS Local Agent状態を表示します。">
        <Button onClick={refresh}>再確認</Button>
      </PageTitle>
      <div className="action-note" role="status">{pcNote}</div>
      <div className="cards four">
        <MetricCard title="Local Agent" value={workerSummary.fresh ? "heartbeat確認済み" : "要確認"} sub={workerSummary.blocker ? workerSummary.nextAction : "外部操作証跡はworkflowごとに別確認します。"} status={workerSummary.fresh ? "enabled" : "blocked"} />
        <MetricCard title="Heartbeat" value={workerSummary.fresh ? "fresh" : "stale"} sub={worker?.heartbeat_at ?? "未確認"} status={workerSummary.fresh ? "enabled" : "blocked"} />
        <MetricCard title="Queue" value={String(worker?.queue_depth ?? 0)} sub="待機中の実行候補" status={(worker?.queue_depth ?? 0) > 0 ? "running" : "enabled"} />
        <MetricCard title="Last Run" value={worker?.last_run_id ? "あり" : "なし"} sub={worker?.last_run_id ?? "未実行"} status={worker?.last_run_id ? "enabled" : "waiting"} />
      </div>
      <Panel title="Local Agent readback"><DataTable headers={["項目", "状態", "次に見ること"]} rows={[["接続状態", workerSummary.fresh ? "接続確認済み" : "要確認", workerSummary.nextAction], ["Worker", worker?.status ?? "unknown", worker?.id ?? "unknown"], ["Heartbeat", worker?.heartbeat_at ?? "none", workerSummary.blocker ?? "問題なし"], ["Queue", String(worker?.queue_depth ?? 0), "外部操作は各workflowの承認境界で停止"]]} /></Panel>
      <Panel title="実行中ローカルタスク"><DataTable headers={["Run", "Automation", "開始時刻", "ステータス", "Blocker"]} rows={(mvpState.runs ?? []).filter((run) => ["queued", "running", "blocked"].includes(run.status)).slice(0, 8).map((run) => [run.id, run.automation_name ?? run.automation_id, run.started_at ?? run.queued_at ?? "-", <StatusBadge status={run.status === "blocked" ? "blocked" : run.status === "running" ? "running" : "waiting"} label={run.status} />, run.exact_blocker ?? "-"])} /></Panel>
    </section>
  );
}

function ProductionStatusPage({ setReceipt }: { setReceipt: (value: string) => void }) {
  const [liveState, setLiveState] = useState<MvpState | null>(null);
  const [liveReadbackAt, setLiveReadbackAt] = useState("");
  const [readbackNote, setReadbackNote] = useState("本番状態を読み込み中です。API readback結果はここに表示します。");
  const confirmed = productionRollup.results.filter((item) => item.actual_status === "confirmed");
  const blocked = productionRollup.results.filter((item) => item.actual_status !== "confirmed");
  const liveReadiness = liveState?.production_readiness_readback;
  const refreshLive = async () => {
    try {
      const state = await readMvpState();
      const readbackAt = new Date().toISOString();
      setLiveState(state);
      setLiveReadbackAt(readbackAt);
      setReceipt(`本番状態API readback 済みです。adapter=${state.persistence?.adapter ?? "unknown"} / runs=${state.runs?.length ?? 0} / blocker=${state.production_readiness_readback?.blocker ?? "none"}`);
      setReadbackNote(`API readback完了: adapter=${state.persistence?.adapter ?? "unknown"} / runs=${state.runs?.length ?? 0} / blocker=${state.production_readiness_readback?.blocker ?? "none"} / ${readbackAt}`);
    } catch {
      setReceipt("本番状態API readbackに失敗しました。静的rollupのみ表示しています。");
      setReadbackNote(`API readback失敗: 静的rollupのみ表示しています / ${actionStamp()}`);
    }
  };
  React.useEffect(() => {
    refreshLive();
  }, []);
  const rows = productionRollup.results.map((item) => [
    item.id,
    item.capability,
    <StatusBadge
      status={item.actual_status === "confirmed" ? "approved" : "blocked"}
      label={item.actual_status === "confirmed" ? "confirmed" : "blocked-runtime-verification"}
    />,
    item.artifact,
    item.blocker ?? "-",
    item.resume_condition ?? "-"
  ]);

  return (
    <section>
      <PageTitle title="本番状態" desc="デプロイ、DB、Worker、外部操作境界の現在地です。">
        <Button
          icon={<RefreshCw size={15} />}
          onClick={refreshLive}
        >
          API readback
        </Button>
      </PageTitle>
      <div className="action-note" role="status">{readbackNote}</div>
      <Panel title="Live API Readback">
        <DataTable
          headers={["項目", "状態"]}
          rows={[
            ["Readback", liveReadbackAt || "未確認"],
            ["DB / 永続化", liveState?.persistence ? `${liveState.persistence.adapter} / ${liveState.persistence.volume_ready ? "永続化OK" : liveState.persistence.exact_blocker ?? "要確認"}` : "未確認"],
            ["Write guard", liveState?.persistence?.write_probe ? `${liveState.persistence.write_probe.ok ? "保護OK" : "要確認"} / ${liveState.persistence.write_probe.probe_ref ?? liveState.persistence.write_probe.exact_blocker ?? "-"}` : "未確認"],
            ["Worker", liveState?.worker ? `${liveState.worker.heartbeat_fresh ? "接続確認済み" : "要確認"} / queue=${liveState.worker.queue_depth}` : "未確認"],
            ["Runs / Automations", `${liveState?.runs?.length ?? 0} runs / ${liveState?.automations?.length ?? 0} automations`],
            ["Redaction", liveState?.redaction_readback?.ok ? "pass" : "未確認"],
            ["Production readiness", liveReadiness ? `${liveReadiness.configured ? "設定済み" : "未設定"} / ${liveReadiness.blocker ?? "ok"}` : "未確認"],
            ["External action", liveState?.worker?.external_action_executed === true ? "実行検出 / 要確認" : liveState?.worker?.external_action_executed === false ? "未検出 / readback=false" : "未確認"]
          ]}
        />
      </Panel>
      <div className="cards four">
        <MetricCard title="Rollup" value={productionRollup.run_id} sub={productionRollup.overall_status} status="waiting" />
        <MetricCard title="Confirmed" value={String(confirmed.length)} sub="P001-P004" status="approved" />
        <MetricCard title="Blocked Runtime" value={String(blocked.length)} sub="P005-P010" status="blocked" />
        <MetricCard title="Goal Complete" value={productionRollup.goal_complete ? "true" : "false"} sub="実証跡が揃うまでfalse" status={productionRollup.goal_complete ? "approved" : "blocked"} />
      </div>
      <div className="cards four">
        <MetricCard title="Current Packet" value={currentProductionReadiness.run_id} sub="current-production-readiness" status="waiting" />
        <MetricCard title="Production Ready" value={currentProductionReadiness.production_ready ? "true" : "false"} sub="P005-P010実証跡待ち" status={currentProductionReadiness.production_ready ? "approved" : "blocked"} />
        <MetricCard title="Next Stage" value={currentProductionReadiness.next_required_runtime_stage} sub="runtime evidence" status="blocked" />
        <MetricCard title="Runtime Suite" value="confirmed" sub="P016-P024" status="approved" />
      </div>
      <div className="section-grid">
        <Panel title="確認済み" className="span-2">
          <CheckList items={confirmed.map((item) => `${item.id}: ${item.capability}`)} />
        </Panel>
        <Panel title="Hard Stops">
          <CheckList items={["No raw secrets", "No public external side effects", "No production claim without P010", ...currentProductionReadiness.hard_stops_not_crossed]} />
        </Panel>
      </div>
      <Panel title="次に必要な本番証跡">
        <DataTable
          headers={["確認項目", "状態"]}
          rows={[
            ["今日使える範囲", currentProductionReadiness.user_usable_today.automation_creation_and_local_mvp],
            ["本番SaaS実行", currentProductionReadiness.user_usable_today.production_saas_runtime],
            ["止まっている実証跡", currentProductionReadiness.blocked_runtime_capabilities.join(", ")],
            ["次のゲート", currentProductionReadiness.next_required_runtime_stage],
            ["次の作業場所", currentProductionReadiness.next_runtime_evidence_workspace],
            ["人間対応が必要なもの", "実ログイン、外部操作直前の確認、OTP/本人確認が出た場合の入力"]
          ]}
        />
      </Panel>
      <Panel title="Production Goal Gates">
        <DataTable headers={["ID", "Capability", "Status", "Artifact", "Blocker", "Resume Condition"]} rows={rows} />
      </Panel>
    </section>
  );
}

function RunDetailPage({ setReceipt }: { setReceipt: (value: string) => void }) {
  return (
    <section>
      <PageTitle title="実行詳細: Project A / SNS投稿 / 2026-06-29 09:00" desc="結果だけ表示 / 過程を表示">
        <Button icon={<RefreshCw size={15} />} onClick={() => setReceipt("このRunを途中から再開します。")}>途中から再開</Button>
      </PageTitle>
      <div className="run-grid">
        <Panel title="実行ステップ" className="span-2">
          {["要件確認", "素材取得", "Chrome起動", "Lane確保", "ログイン確認", "下書き作成", "承認", "投稿実行", "レポート保存"].map((s, i) => <div className="timeline-row" key={s}><span className={i < 6 ? "done-dot" : "wait-dot"} /> <strong>{s}</strong><small>{i < 6 ? "完了" : "待機中"}</small></div>)}
        </Panel>
        <aside className="side-panel">
          <h3>ライブプレビュー</h3>
          <div className="preview-box">Mock local-agent readiness. Real browser screenshots, real logs, and real Chrome profile locks are not connected in this milestone.</div>
          <Button variant="primary" onClick={() => go("#/runs/run-2026-06-29-0900/recovery")}>復旧UIを開く</Button>
        </aside>
      </div>
    </section>
  );
}

function RecoveryPage({ setReceipt }: { setReceipt: (value: string) => void }) {
  const [action, setAction] = useState("待機して再実行");
  return (
    <section>
      <PageTitle title="失敗時の復旧UI" desc="Laneのリソース競合により、タスクが実行できませんでした。" />
      <div className="recovery-alert"><AlertTriangle size={20} /> Lane 2 の Port 9332 が使用中で、Google Profile Startup-A-SNS がロックされています。</div>
      <div className="section-grid">
        <Panel title="ワークフロー実行状況" className="span-2"><Stepper /></Panel>
        <Panel title="失敗原因"><CheckList items={["LANE_LOCKED_PORT", "PROFILE_LOCKED", "直前成功ステップ: Lane確認", "失敗ステップ: Chrome起動"]} /></Panel>
      </div>
      <Panel title="推奨復旧アクション">
        <div className="choice-row">{["待機して再実行", "別Laneへ移動", "ブラウザを開いて確認", "このステップから再開", "今回だけスキップ", "Codex Bridgeを再接続", "Pluginを再認証"].map((a) => <button className={a === action ? "selected" : ""} onClick={() => setAction(a)} key={a}>{a}</button>)}</div>
        <Button variant="primary" onClick={() => setReceipt(`${action} を選択しました。実行詳細に反映します。`)}>選択した復旧を実行</Button>
      </Panel>
    </section>
  );
}

function TemplatesPage({ model }: { model: AppModel }) {
  const { setReceipt, createdTemplates, setCreatedTemplates, setMvpState, setAutomationRows } = model;
  const [selected, setSelected] = useState(0);
  const [templateNote, setTemplateNote] = useState("テンプレートを選ぶと詳細が表示されます。使用するを押すと保存結果をここに表示します。");
  const useTemplate = async () => {
    const [name, category, target, lane, approval] = templates[selected];
    setTemplateNote(`${name}: 保存を開始しました。外部投稿・送信は実行しません。`);
    const automationType = name.includes("Gmail") || name.includes("DM") ? "gmail-reply" : category.includes("リサーチ") ? "research-report" : "sns-post";
    try {
      const response = await fetch("/api/mvp/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          project_id: rememberedProject(),
          automation_type: automationType,
          desc: `${category} テンプレートから作成した安全なMVP自動化`,
          goal: `${target} 向けに下書き作成まで行い、外部操作前に承認で停止する`,
          schedule: "09:00",
          cadence: "daily",
          lane,
          risk_level: approval.includes("承認") ? "high" : "low",
          approval_policy: approval.includes("承認") ? "required_before_external_post" : "auto_allowed_for_draft_only",
          worker_command_kind: "safe_local_demo",
          create_approval: approval.includes("承認"),
          builder_spec: {
            source: "template",
            template_name: name,
            category,
            target_label: target,
            approval,
            external_action_allowed: false
          }
        })
      });
      if (!response.ok) throw new Error("template_create_failed");
      const result = await response.json();
      setMvpState(result.state);
      setAutomationRows(toAutomationRows(result.state.automations ?? []));
      setCreatedTemplates((items) => items.includes(name) ? items : [...items, name]);
      setReceipt(`${name} から自動化案を保存しました。automation=${result.automation.id} / 外部操作は未実行です。`);
      setTemplateNote(`${name}: 保存完了 automation=${result.automation.id} / 外部操作は未実行です。`);
    } catch {
      setReceipt(`${name} のAPI保存は未確認です。作成済みには追加していません。外部操作は未実行です。`);
      setTemplateNote(`${name}: API保存は未確認です。作成済みには追加していません。外部操作は未実行です。`);
    }
  };
  return (
    <section>
      <PageTitle title="テンプレート / Skills" desc="再利用可能な自動化テンプレートから作成します。" />
      <div className="action-note" role="status">{templateNote}</div>
      <div className="split">
        <div className="template-grid">{templates.map((t, i) => <button key={t[0]} className={`template-card ${i === selected ? "selected" : ""}`} onClick={() => { setSelected(i); setTemplateNote(`${t[0]} を選択しました。必要接続=${t[2]} / 推奨Lane=${t[3]}`); }}><LayoutTemplate size={17} /><strong>{t[0]}</strong><span>{t[1]}</span><small>{t[2]} / {t[3]}</small></button>)}</div>
        <aside className="side-panel wide"><h3>{templates[selected][0]}</h3><p>必要接続: {templates[selected][2]}</p><p>推奨Lane: {templates[selected][3]}</p><p>承認: {templates[selected][4]}</p><Button variant="primary" onClick={useTemplate}>使用する</Button><h3>作成済み</h3><p>{createdTemplates.length ? createdTemplates.join(" / ") : "まだありません"}</p></aside>
      </div>
    </section>
  );
}

function ArtifactsPage({ setReceipt }: { setReceipt: (value: string) => void }) {
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabels[activeProject];
  const hasArtifacts = activeProject === "project-a";
  const metrics = hasArtifacts
    ? [["Daily AI証跡", "readback待ち"], ["Job証跡", "readback待ち"], ["NisenPrints証跡", "readback待ち"], ["Feedback", "API readback待ち"], ["外部公開", "停止境界"]]
    : [["月間リード数", "未接続"], ["DM返信率", "未計測"], ["SNS投稿数", "未接続"], ["商談化数", "未接続"], ["LP訪問数", "未計測"]];
  const artifactRows = hasArtifacts
    ? [["Daily AI", "投稿前proof", "最新readback待ち", "Daily AI", "Local", "Browser/Sheets", <StatusBadge status="waiting" label="直前停止" />, <RowActions name="Daily AI証跡" setReceipt={setReceipt} scope="成果物" />], ["Job Manager", "応募前receipt", "最新readback待ち", "Job", "Local", "Browser", <StatusBadge status="waiting" label="submit前停止" />, <RowActions name="Job証跡" setReceipt={setReceipt} scope="成果物" />], ["NisenPrints", "publish manifest", "最新readback待ち", "NisenPrints", "Local", "Canva/Printify/Etsy/Pinterest", <StatusBadge status="waiting" label="公開前停止" />, <RowActions name="NisenPrints証跡" setReceipt={setReceipt} scope="成果物" />]]
    : [["このプロジェクトの成果物はまだありません", "-", "-", "-", "-", "-", <StatusBadge status="draft" />, <Button onClick={() => go("#/chat")}>チャットで作成</Button>]];
  return (
    <section>
      <ProjectTabs />
      <PageTitle title={projectName} desc="成果物 / KPI" />
      <ProjectScopeNotice projectId={activeProject} />
      <div className="cards five">{metrics.map(([a, b]) => <MetricCard title={a} value={b} sub={hasArtifacts ? "Project A" : "API readback未実行"} status="waiting" key={a} />)}</div>
      <div className="split">
        <Panel title="成果物一覧" className="list-panel"><DataTable headers={["タイトル", "タイプ", "生成日時", "自動化", "Lane", "Plugin", "ステータス", "操作"]} rows={artifactRows} /></Panel>
        <aside className="side-panel wide"><h3>右側プレビュー</h3><div className="preview-box">{hasArtifacts ? "証跡artifactを選ぶと、投稿前/応募前/公開前のreceiptをここに表示します。現在は外部操作未実行です。" : `${projectName} の成果物はまだありません。実データ接続後に表示します。`}</div><Button icon={<Download size={15} />} onClick={() => setReceipt("成果物artifactの取得候補を表示しました。実ファイル取得は未実行です。")}>ダウンロード</Button><Button onClick={() => setReceipt("承認キュー候補を表示しました。API readbackは未実行です。")}>承認へ送る</Button></aside>
      </div>
    </section>
  );
}

function PluginsPage({ setReceipt }: { setReceipt: (value: string) => void }) {
  const [pluginNote, setPluginNote] = useState("プラグイン / MCP を開きました。接続候補を表示します。live MCP callや外部認証は実行しません。");
  const pluginRows = plugins.map((p) => [
    ...p.slice(0, 6),
    <RowActions
      name={p[0]}
      setReceipt={(value) => {
        setPluginNote(`${value} / ${actionStamp()}`);
        setReceipt(value);
      }}
      scope="プラグイン"
    />
  ]);
  return (
    <section>
      <PageTitle title="プラグイン / MCP" desc="Codex app互換のPlugin、MCP Server、Codex Bridge、Local Wrapperを管理します。">
        <Button icon={<RefreshCw size={15} />} onClick={() => { setPluginNote(`Codex同期候補を表示しました。実Codex同期/API readbackは未実行です / ${actionStamp()}`); setReceipt("mock一覧を表示しました。実Codex同期/API readbackは未実行です。"); }}>Codexから同期</Button>
      </PageTitle>
      <div className="action-note" role="status">{pluginNote}</div>
      <div className="notice-row">接続候補の一覧です。ここから外部認証、MCP live call、投稿、送信、secret保存は実行しません。</div>
      <div className="cards four">
        <MetricCard title="利用可能候補" value="6" sub="readiness catalog" status="waiting" />
        <MetricCard title="接続済みMCP" value="0" sub="本画面では未接続" status="waiting" />
        <MetricCard title="Codex Bridge対応" value="候補あり" sub="Runway / Browser Use readiness" status="waiting" />
        <MetricCard title="要認証" value="1" sub="Slack" status="waiting" />
      </div>
      <div className="split">
        <Panel title="Readiness Catalog" className="list-panel"><DataTable headers={["プラグイン", "種類", "接続方式", "認証状態", "Tools", "ステータス", "操作"]} rows={pluginRows} /></Panel>
        <aside className="side-panel wide"><h3>Runway MCP</h3><p>優先接続方式: Codex Bridge</p><p>代替方式: Direct MCP / Local Wrapper</p><p>画像生成、動画生成、edit video、upscale video は承認必須です。</p><div className="preview-box">接続候補の確認画面です。実Runway、実Codex Bridge、実MCP認証はここでは実行しません。</div><Button variant="primary" onClick={() => { setPluginNote(`Runway MCP 接続テスト候補を表示しました。実認証/API readbackは未実行です / ${actionStamp()}`); setReceipt("Runway MCP の接続テスト候補を表示しました。実認証/API readbackは未実行です。"); }}>接続テスト</Button></aside>
      </div>
    </section>
  );
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-head"><h2>{title}</h2><span className="panel-menu-static" title="このパネルのメニューはread-only表示です"><MoreHorizontal size={16} /></span></div>{children}</section>;
}

function MetricCard({ title, value, sub, status }: { title: string; value: string; sub: string; status: Status }) {
  return <div className="metric"><div><span>{title}</span><strong>{value}</strong><small>{sub}</small></div><StatusBadge status={status} /></div>;
}

function DataTable({ headers, rows }: { headers: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return <div className="table-wrap"><table><thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function RowActions({ name = "項目", setReceipt, scope = "行操作" }: { name?: string; setReceipt?: (value: string) => void; scope?: string }) {
  const [state, setState] = useState("待機中");
  const update = (message: string) => {
    setState(message);
    setReceipt?.(`${scope}: ${name} - ${message}`);
  };
  return (
    <div className="row-actions">
      <IconButton label="実行候補" onClick={() => update("実行候補を選択しました。API readback未実行で、外部操作はしていません。")}><Play size={14} /></IconButton>
      <IconButton label="一時停止候補" onClick={() => update("一時停止候補を選択しました。状態変更は未実行です。")}><Pause size={14} /></IconButton>
      <IconButton label="詳細" onClick={() => update("詳細候補を表示中です。保存は未実行です。")}><MoreHorizontal size={14} /></IconButton>
      <small>{state}</small>
    </div>
  );
}

function Bubble({ children, side }: { children: React.ReactNode; side?: "user" }) {
  return <div className={`bubble ${side === "user" ? "user-bubble" : ""}`}>{children}</div>;
}

function LineChart() {
  return <div className="line-chart"><svg viewBox="0 0 640 220" role="img" aria-label="実行パフォーマンスグラフ"><polyline points="20,170 120,150 220,130 320,118 420,90 520,70 620,42" fill="none" stroke="#111" strokeWidth="3" /><g>{[20,120,220,320,420,520,620].map((x, i) => <circle key={x} cx={x} cy={[170,150,130,118,90,70,42][i]} r="5" fill="#111" />)}</g></svg></div>;
}

function Bars() {
  return <div className="bars">{["X", "Instagram", "LinkedIn", "Gmail"].map((b, i) => <div key={b}><span>{b}</span><strong style={{ width: `${88 - i * 14}%` }} /></div>)}</div>;
}

function CheckList({ items }: { items: string[] }) {
  return <ul className="check-list">{items.map((i) => <li key={i}><Check size={15} />{i}</li>)}</ul>;
}

function Stepper() {
  return <div className="stepper">{["成功ステップ", "直前成功", "失敗ステップ", "未実行"].map((s, i) => <div key={s} className={i === 2 ? "failed" : ""}><Circle size={14} /><strong>{s}</strong><span>{["素材取得", "Lane確認", "Chrome起動", "投稿実行"][i]}</span></div>)}</div>;
}

export default App;
