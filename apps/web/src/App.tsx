import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  AlertTriangle,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  FileCheck,
  FileText,
  Globe,
  Image,
  Layers3,
  Loader2,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Send,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { isSecretStorageOnlyMessage, resolveCreateMessageCommand } from "./createMessageSecrets.js";

type Row = Record<string, any>;
type View = "Dashboard" | "Create" | "Schedule" | "Runs" | "Skills" | "Sources" | "Lanes" | "Approvals";
type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type CreatePlannerDecision = "ask_more" | "save_plan" | "demo_first" | "ready_to_start" | "ready_to_schedule";

type CreatePlannerPlan = {
  source?: "local_codex" | "openai" | "local_fallback";
  intent?: "answer_question" | "plan_workflow";
  exactBlocker?: string;
  model?: string;
  title: string;
  reply: string;
  command: string;
  visibleSteps: string[];
  backendChecks: string[];
  answered?: string[];
  openQuestions?: string[];
  nextAction?: string;
  executionDecision?: CreatePlannerDecision;
  confidence?: "low" | "medium" | "high";
};

type CreatePlannerJobReadback = {
  id: string;
  status: "queued" | "running" | "completed" | "blocked";
  result?: CreatePlannerPlan;
  exactBlocker?: string;
  updatedAt?: string;
};

type CreateDraft = {
  command: string;
  title: string;
  reply: string;
  visibleSteps: string[];
  backendChecks: string[];
  answered: string[];
  openQuestions: string[];
  nextAction: string;
  executionDecision: CreatePlannerDecision;
  confidence: "low" | "medium" | "high";
  plannerSource?: "local_codex" | "openai" | "local_fallback";
  intent?: "answer_question" | "plan_workflow";
  plannerModel?: string;
  plannerBlocker?: string;
  plannerJobId?: string;
  plannerJobStatus?: CreatePlannerJobReadback["status"];
};

type CreateDraftSession = {
  version: 1;
  messages: ChatMessage[];
  draft: CreateDraft;
  researchSources: Record<ResearchSourceKey, boolean>;
  command: string;
};

type ActionReceiptTone = "ok" | "blocked" | "running" | "info";

type ActionReceipt = {
  id: string;
  tone: ActionReceiptTone;
  title: string;
  detail: string;
  nextAction: string;
  view?: View;
  runId?: string;
  planId?: string;
  checkId?: string;
  workflowId?: string;
  createdAt: string;
};

type SecretSummary = {
  id: string;
  kind: string;
  label: string;
  maskedValue: string;
  updatedAt: string;
};

type ResearchSourceKey = "web" | "x" | "reddit" | "youtube" | "mcp" | "api";

type ResearchSourcePlan = {
  key: ResearchSourceKey;
  label: string;
  enabled: boolean;
  mode: string;
  boundary: string;
  metadata: Row;
};

type ResearchPlan = {
  id: string;
  title: string;
  status: string;
  command: string;
  sources: ResearchSourcePlan[];
  visibleFlow: string[];
  sourceOfTruth: string[];
  proofBoundary: string[];
  approvalBoundary: string[];
  metadata: Row;
  demoCheckId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};

type PlannerCaptureResponse = {
  ok: boolean;
  status: string;
  plan?: ResearchPlan;
  proof?: Row;
  capture?: Row;
  runId?: string;
  run?: Row;
  error?: string;
  summary?: string;
};

type Dashboard = {
  runs: Row[];
  actionableRuns?: Row[];
  steps: Row[];
  lanes: Row[];
  approvals: Row[];
  approvalInbox?: Row[];
  externalPreflightChecklist?: Row[];
  proofs: Row[];
  childRuns: Row[];
  workerEvents: Row[];
  advisorEvents: Row[];
  systemChecks: Row[];
  bridgeActionCatalog: Row[];
  bridgeActions: Row[];
  bridgeExecutions: Row[];
  knowledgeNotes: Row[];
  researchPlans: ResearchPlan[];
  nextActions: Row[];
  assetSummary: Row[];
  assets: Row[];
  skills: Row[];
  registeredWorkflows: Row[];
  secrets: SecretSummary[];
  obsidian?: Row;
  resumeContract?: Row;
  codexCapabilities?: Row;
  codexParityLedger?: Row;
  codexAutomationMigrationLedger?: Row;
  capabilityRouter?: CapabilityRouterSnapshot;
  browserHealth?: Row;
  localWorker?: Row;
  schedulerStatus?: Row;
  deployment?: Row;
  productionGuard?: Row;
};

type CapabilityRoute = {
  id: string;
  label: string;
  status: "ready" | "partial" | "missing";
  lane: string;
  nextAction: string;
  evidence: string[];
  signals: string[];
};

type CapabilityGap = {
  id: string;
  label: string;
  priority: "high" | "medium" | "low";
  status: "not_connected" | "partly_connected" | "manual_only" | "legacy_lane";
  why: string;
  nextAction: string;
  action?: {
    kind: "create";
    label: string;
    view: "Create" | "Sources" | "Runs";
    command?: string;
    routeId?: string;
  };
};

type CapabilityRouterSnapshot = {
  generatedAt: string;
  command: string;
  primaryAction: string;
  recommendedRoutes: CapabilityRoute[];
  gapBacklog: CapabilityGap[];
  counts: Row;
};

type RunDetail = {
  run: Row;
  steps: Row[];
  proofs: Row[];
  children: Row[];
  workerEvents: Row[];
};

type ProofView = Row & {
  status: "ok" | "blocked" | "not_found";
  preview_kind?: "json" | "text" | "image" | "unsupported";
  preview?: string;
  blocked_reason?: string;
  mime_type?: string;
  image?: {
    mime_type?: string;
    width?: number;
    height?: number;
    base64_included?: boolean;
  };
};

type RunDispositionKind = "actionable" | "running" | "completed" | "archive";
type RunArchiveReason = "history_only" | "receipt_only" | "demo" | null;
type RunDisposition = {
  kind: RunDispositionKind;
  archiveReason: RunArchiveReason;
};

type RefreshOptions = {
  background?: boolean;
  staleNotice?: boolean;
};

const emptyDashboard: Dashboard = {
  runs: [],
  actionableRuns: [],
  steps: [],
  lanes: [],
  approvals: [],
  approvalInbox: [],
  externalPreflightChecklist: [],
  proofs: [],
  childRuns: [],
  workerEvents: [],
  advisorEvents: [],
  systemChecks: [],
  bridgeActionCatalog: [],
  bridgeActions: [],
  bridgeExecutions: [],
  knowledgeNotes: [],
  researchPlans: [],
  nextActions: [],
  assetSummary: [],
  assets: [],
  skills: [],
  registeredWorkflows: [],
  secrets: [],
  obsidian: {},
  resumeContract: {},
  codexCapabilities: {},
  codexParityLedger: { items: [] },
  codexAutomationMigrationLedger: { items: [], summary: {} },
  capabilityRouter: {
    generatedAt: "",
    command: "",
    primaryAction: "",
    recommendedRoutes: [],
    gapBacklog: [],
    counts: {}
  },
  browserHealth: {},
  deployment: {},
  productionGuard: {}
};

const createDraftSessionStorageKey = "automation-os:create-draft-session:v1";
const operatorWriteTokenStorageKey = "automation-os:operator-write-token:v1";

const primaryNav: Array<[View, string, React.ComponentType<{ size?: number }>]> = [
  ["Dashboard", "今", Activity],
  ["Create", "作る", MessageCircle],
  ["Schedule", "定期", RefreshCcw],
  ["Approvals", "確認", ShieldCheck],
  ["Runs", "履歴", Play]
];

const advancedNav: Array<[View, string, React.ComponentType<{ size?: number }>]> = [
  ["Skills", "スキル", Sparkles],
  ["Sources", "データ", Database],
  ["Lanes", "レーン", Layers3]
];

const hashViews: Record<string, View> = {
  "#home": "Dashboard",
  "#create": "Create",
  "#schedule": "Schedule",
  "#runs": "Runs",
  "#approvals": "Approvals",
  "#skills": "Skills",
  "#data": "Sources",
  "#sources": "Sources",
  "#lanes": "Lanes"
};

const viewHashes: Record<View, string> = {
  Dashboard: "#home",
  Create: "#create",
  Schedule: "#schedule",
  Runs: "#runs",
  Approvals: "#approvals",
  Skills: "#skills",
  Sources: "#sources",
  Lanes: "#lanes"
};

function initialView() {
  if (typeof window === "undefined") return "Dashboard";
  return hashViews[window.location.hash] ?? "Dashboard";
}

function isDashboard(value: unknown): value is Dashboard {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Dashboard>;
  return Array.isArray(candidate.runs)
    && (candidate.actionableRuns === undefined || Array.isArray(candidate.actionableRuns))
    && Array.isArray(candidate.steps)
    && Array.isArray(candidate.lanes)
    && Array.isArray(candidate.approvals)
    && (candidate.approvalInbox === undefined || Array.isArray(candidate.approvalInbox))
    && (candidate.externalPreflightChecklist === undefined || Array.isArray(candidate.externalPreflightChecklist))
    && Array.isArray(candidate.proofs)
    && Array.isArray(candidate.childRuns ?? [])
    && Array.isArray(candidate.workerEvents)
    && Array.isArray(candidate.advisorEvents)
    && Array.isArray(candidate.systemChecks ?? [])
    && Array.isArray(candidate.bridgeActionCatalog ?? [])
    && Array.isArray(candidate.bridgeActions ?? [])
    && Array.isArray(candidate.bridgeExecutions ?? [])
    && Array.isArray(candidate.knowledgeNotes ?? [])
    && Array.isArray(candidate.researchPlans ?? [])
    && Array.isArray(candidate.nextActions ?? [])
    && Array.isArray(candidate.assetSummary)
    && Array.isArray(candidate.assets)
    && Array.isArray(candidate.skills)
    && Array.isArray(candidate.secrets);
}

const actionableRunStatuses = new Set(["blocked", "partial", "waiting_approval", "approval_required"]);
const runningRunStatuses = new Set(["queued", "running", "in_progress", "started"]);
const completedRunStatuses = new Set(["complete", "completed"]);

function isTrueLike(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function classifyRun(run?: Row): RunDisposition {
  if (!run) return { kind: "archive", archiveReason: "history_only" };
  const meta = asJson<Row>(run.metadata_json, {});
  if (isTrueLike(run.resume_suppressed) || isTrueLike(meta.resume_suppressed)) {
    return { kind: "archive", archiveReason: "history_only" };
  }
  if (isTrueLike(run.demo) || isTrueLike(meta.demo) || isTrueLike(meta.seeded_demo)) {
    return { kind: "archive", archiveReason: "demo" };
  }
  if (
    run.worker_mode === "receipt_only"
    || run.execution_mode === "receipt_only"
    || isTrueLike(run.receipt_only)
    || meta.worker_mode === "receipt_only"
    || meta.execution_mode === "receipt_only"
    || isTrueLike(meta.receipt_only)
  ) {
    return { kind: "archive", archiveReason: "receipt_only" };
  }
  const status = String(run.status ?? "");
  if (actionableRunStatuses.has(status)) return { kind: "actionable", archiveReason: null };
  if (runningRunStatuses.has(status)) return { kind: "running", archiveReason: null };
  if (completedRunStatuses.has(status)) return { kind: "completed", archiveReason: null };
  return { kind: "archive", archiveReason: "history_only" };
}

function runDispositionRank(run: Row) {
  const disposition = classifyRun(run);
  if (disposition.kind === "actionable") return 0;
  if (disposition.kind === "running") return 1;
  if (disposition.kind === "completed") return 2;
  return 3;
}

function resolveSelectedRunId(current: string | null, runs: Row[], actionableRuns: Row[] = []): string | null {
  if (!runs.length) return null;
  if (current && runs.some((run) => run.id === current)) return current;
  const latestRunId = [...actionableRuns].sort((a, b) => runDispositionRank(a) - runDispositionRank(b))[0]?.id;
  return typeof latestRunId === "string" ? latestRunId : null;
}

function newerRunSnapshot(detailRun?: Row, dashboardRun?: Row) {
  if (!detailRun) return dashboardRun;
  if (!dashboardRun) return detailRun;
  const detailTime = Date.parse(String(detailRun.updated_at ?? detailRun.created_at ?? ""));
  const dashboardTime = Date.parse(String(dashboardRun.updated_at ?? dashboardRun.created_at ?? ""));
  if (Number.isFinite(detailTime) && Number.isFinite(dashboardTime) && dashboardTime > detailTime) {
    return dashboardRun;
  }
  if (String(detailRun.status ?? "") !== String(dashboardRun.status ?? "") && Number.isFinite(dashboardTime) && !Number.isFinite(detailTime)) {
    return dashboardRun;
  }
  return detailRun;
}

function isRunDetail(value: unknown): value is RunDetail {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunDetail>;
  return Boolean(candidate.run && typeof candidate.run === "object")
    && Array.isArray(candidate.steps)
    && Array.isArray(candidate.proofs)
    && Array.isArray(candidate.children ?? [])
    && Array.isArray(candidate.workerEvents);
}

const nisenPrintsQuickStarts = [
  {
    key: "nisenprints_etsy_sync",
    command: "NisenPrints Etsy Sync current listings 正本同期",
    beginnerLabel: "Etsy同期",
    beginnerDescription: "公開中の商品リストと手元の管理表をそろえます。",
    visibleSteps: ["Etsyの公開リストを確認", "手元の管理表を同期", "古い行が戻らないか確認"]
  },
  {
    key: "nisenprints_printify_recovery",
    command: "NisenPrints Printify recovery 途中復旧",
    beginnerLabel: "Printify復旧",
    beginnerDescription: "止まった商品を同じ続きから再開します。",
    visibleSteps: ["同じ商品を見つける", "未完了の段階から再開する", "Printifyの状態を確認する"]
  },
  {
    key: "nisenprints_full_publish_run",
    command: "NisenPrints Full Publish 新規公開 最後まで",
    beginnerLabel: "新規公開",
    beginnerDescription: "新しい商品を作って公開確認まで進めます。",
    visibleSteps: ["商品素材を作る", "Etsyに公開する", "公開リンクを確認する"]
  }
];

const createSuggestions = [
  "毎朝の確認作業を自動化したい",
  "申請や予約の状況を見て次の対応を決めたい",
  "メモや資料から手順を整理したい"
];

const initialCreatePrompt = "毎日の作業を相談しながら自動化したい";
const researchSourceKeys: ResearchSourceKey[] = ["web", "x", "reddit", "youtube", "mcp", "api"];
const researchSourceLabels: Record<ResearchSourceKey, string> = {
  web: "Web",
  x: "X",
  reddit: "Reddit",
  youtube: "YouTube",
  mcp: "連携先",
  api: "公式連携"
};
const initialResearchSources: Record<ResearchSourceKey, boolean> = {
  web: true,
  x: true,
  reddit: true,
  youtube: true,
  mcp: false,
  api: false
};

function normalizeVisibleSteps(value: unknown, fallback: string[] = ["目的を確認", "状態を見る", "開始"]) {
  const steps = Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim().slice(0, 120)] : [])
    : [];
  return steps.length ? steps.slice(0, 12) : fallback;
}

function sameVisibleSteps(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((step, index) => step === right[index]);
}

function sameResearchSources(sources: ResearchSourcePlan[], selection: Record<ResearchSourceKey, boolean>) {
  return researchSourceKeys.every((key) => sources.find((source) => source.key === key)?.enabled === selection[key]);
}

const initialCreateMessages: ChatMessage[] = [
  {
    id: "assistant-welcome",
    role: "assistant",
    text: "やりたいことをそのまま送ってください。"
  }
];

function normalizeCreateMessageForDedupe(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .trim();
}

function compactCreateMessages(messages: ChatMessage[]) {
  let previousRole: ChatMessage["role"] | null = null;
  let previousAssistantReply = "";
  return messages.flatMap((message): ChatMessage[] => {
    if (message.role !== "assistant") {
      previousRole = "user";
      previousAssistantReply = "";
      return [message];
    }
    const normalized = normalizeCreateMessageForDedupe(message.text);
    if (normalized && previousRole === "assistant" && previousAssistantReply === normalized) return [];
    previousRole = "assistant";
    previousAssistantReply = normalized;
    return [message];
  });
}

function asJson<T = any>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value ?? fallback) as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function compactId(id?: string) {
  if (!id) return "none";
  return id.length > 18 ? `${id.slice(0, 12)}...${id.slice(-5)}` : id;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const statusLabels: Record<string, string> = {
  active: "使用中",
  approved: "承認済み",
  blocked: "停止",
  blocked_by_executor: "外部操作待ち",
  cancelled: "取り消し",
  connected: "準備OK",
  completed: "完了",
  complete: "完了",
  covered: "対応済み",
  covered_local: "ローカル対応",
  failed: "失敗",
  gap: "未対応",
  good: "正常",
  idle: "待機中",
  ok: "OK",
  not_connected: "未接続",
  partial: "確認が必要",
  pending: "保留中",
  approval_required: "課金確認",
  queued: "待機中",
  ready: "準備完了",
  registered_runner_pending: "準備中",
  rejected: "却下",
  running: "実行中",
  skipped: "スキップ",
  waiting_approval: "承認待ち"
};

const workerModeLabels: Record<string, string> = {
  execute_codex: "Codex read-only実行",
  execute_child_codex: "別のAI作業",
  execute_playwright: "画面確認",
  execute_daily_ai_registered: "Daily AI実行",
  execute_nisenprints_registered: "NisenPrints実行",
  execute_prompt_transfer_registered: "転記実行",
  execute_sns_multi_poster_registered: "SNS投稿実行",
  execute_x_authenticated_browser_lane_registered: "X確認実行",
  human_input_required_with_evidence: "人間入力待ち",
  proof_only_external_write_boundary: "証跡確認",
  receipt_only: "証拠のみ",
  external_execution: "外部実行",
  local_worker: "Mac worker",
  local: "ローカル"
};

const resourceLabels: Record<string, string> = {
  browser_lane: "ブラウザ",
  commerce_publish: "公開作業",
  local: "ローカル",
  none: "なし",
  social_publish: "投稿作業"
};

const proofTypeLabels: Record<string, string> = {
  actual_execution_or_manual_verification: "実行確認",
  cleanup_proof: "片付け確認",
  codex_readonly_blocked: "Codex read-only停止",
  codex_readonly_execution: "Codex read-only完了",
  child_codex_blocked: "別のAI作業停止",
  child_codex_result: "別のAI作業結果",
  direct_engagement: "反応確認",
  direct_publish: "投稿確認",
  etsy_current_sync: "Etsy同期",
  etsy_current_listings_snapshot: "Etsy一覧確認",
  etsy_listing_discovered: "Etsyリスト確認",
  local_queue_synced: "ローカル同期",
  pinterest_pin_verified: "Pinterest確認",
  printify_product_same_id: "Printify同一商品",
  printify_status_checked: "Printify状態確認",
  resume_stage_verified: "再開位置確認",
  same_product_id_verified: "同一商品確認",
  screenshot: "スクリーンショット",
  stale_rows_pruned: "古い行の整理",
  worker_receipt: "処理記録"
};

const eventTypeLabels: Record<string, string> = {
  approval_required: "課金確認が必要",
  command_received: "依頼を受信",
  command_run_created: "実行作成",
  run_completed: "実行完了",
  run_created: "実行作成",
  run_started: "実行開始",
  step_completed: "手順完了",
  step_started: "手順開始",
  worker_completed: "処理完了",
  worker_blocked: "処理停止",
  worker_started: "処理開始"
};

const sourceTypeLabels: Record<string, string> = {
  agents_skills: "Agentスキル",
  codex_automations: "Automation",
  codex_sessions: "セッション",
  codex_skills: "Codexスキル",
  doc: "ドキュメント",
  docs: "ドキュメント",
  directory: "フォルダ",
  file: "ファイル",
  memory: "メモリ",
  missing: "未検出",
  plugin_cache: "プラグイン",
  prompt: "指示文",
  skill: "スキル"
};

function displayStatus(value?: string) {
  if (!value) return "不明";
  return statusLabels[value] ?? "状態不明";
}

function capabilityStatusLabel(value?: string) {
  if (value === "ready") return "使える";
  if (value === "partial") return "一部OK";
  if (value === "missing") return "未接続";
  return "確認";
}

function gapPriorityLabel(value?: string) {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  if (value === "low") return "低";
  return "確認";
}

function displayWorkerMode(value?: string) {
  if (!value) return "不明";
  return workerModeLabels[value] ?? "実行方式不明";
}

function displayResource(value?: string) {
  if (!value) return "ローカル";
  if (value.startsWith("bridge:")) return "外部操作";
  if (value.startsWith("collision:")) return "同時実行の確認";
  return resourceLabels[value] ?? "作業対象";
}

function displayProofType(value?: string) {
  if (!value) return "確認記録";
  return proofTypeLabels[value] ?? "確認記録";
}

function proofKindLabel(proofView?: ProofView | null) {
  if (!proofView) return "保存記録";
  if (proofView.preview_kind === "image") return "画面・画像";
  if (proofView.preview_kind === "json") return "構造化された記録";
  if (proofView.preview_kind === "text") return "テキスト記録";
  return "保存記録";
}

function proofConfirmationText(proof: Row, proofView?: ProofView | null) {
  const type = String(proof.proof_type ?? "");
  if (/cleanup|片付け/i.test(type)) {
    return "実行後に余計な処理やブラウザを残していないか確認する記録です。";
  }
  if (/publish|pin|submit|send|direct|external/i.test(type)) {
    return "外部側で実際に反映されたかを確認する記録です。";
  }
  if (/queue|sync|list|status|readable|visible_source|source_snapshot/i.test(type)) {
    return "正本として見た一覧・状態・内容を確認する記録です。";
  }
  if (proofView?.preview_kind === "image" || /screenshot|screen|image/i.test(type)) {
    return "画面の見た目をあとから確認するための記録です。";
  }
  if (proofView?.preview_kind === "json") {
    return "機械的な結果を人間が確認できる形で保存した記録です。";
  }
  if (proofView?.preview_kind === "text") {
    return "実行時に見た内容や結果をテキストで確認する記録です。";
  }
  return "この履歴が何を確認したかをあとから追えるようにする保存記録です。";
}

function proofPreviewSummary(proofView?: ProofView | null) {
  if (!proofView) return "読み込み前";
  if (proofView.status === "blocked") return "安全条件に合う範囲だけ表示します。";
  if (proofView.preview_kind === "image") return "画像本文は表示せず、保存形式と寸法を確認します。";
  if (proofView.preview_kind === "json") return "長い内容や機密になり得る値は省略・伏せ字にします。";
  if (proofView.preview_kind === "text") return "保存されたテキストの先頭だけを表示します。";
  return "この形式は内容表示の対象外です。";
}

function displayEventType(value?: string) {
  if (!value) return "処理ログ";
  return eventTypeLabels[value] ?? "処理ログ";
}

function displaySourceType(value?: string) {
  if (!value) return "データ";
  return sourceTypeLabels[value] ?? "データ";
}

function sourceTypeHelp(value?: string) {
  const map: Record<string, string> = {
    agents_skills: "再利用できる手順",
    codex_automations: "登録済みの自動化",
    codex_sessions: "過去の実行記録",
    codex_skills: "Codexで使える手順",
    doc: "読み込んだ資料",
    docs: "読み込んだ資料",
    memory: "前回までの学習メモ",
    plugin_cache: "追加できる機能",
    prompt: "実行に使う指示文",
    skill: "再利用できる手順"
  };
  return map[value ?? ""] ?? "必要なとき裏側で参照します";
}

function displayLaneRole(value?: string) {
  if (!value) return "待機レーン";
  if (/browser|chrome|playwright/i.test(value)) return "ブラウザ確認";
  if (/worker|executor|run/i.test(value)) return "実行";
  if (/review|verify|check/i.test(value)) return "確認";
  return displayVisibleSummary(value);
}

function displayLaneName(lane: Row) {
  const role = displayLaneRole(String(lane.role ?? ""));
  if (lane.status === "active") return `${role}レーン`;
  if (lane.status === "idle") return "待機レーン";
  return `${role}レーン`;
}

function displayLaneConnection(lane: Row) {
  if (lane.playwright_configured) return "Playwright専用";
  return lane.connection_configured ? "専用接続あり" : "接続未設定";
}

function displayLaneBrowserMode(lane: Row) {
  if (lane.playwright_configured) return "専用プロファイル";
  if (lane.profile_strategy === "cdp_profile_lane") return "専用レーン";
  if (lane.browser_use_configured) return "一時セッション";
  return "未設定";
}

function displayLaneRunName(lane: Row) {
  const runName = displayVisibleSummary(lane.run_name);
  if (runName) return runName;
  if (lane.run_id) return `実行 ${compactId(String(lane.run_id))}`;
  return "実行なし";
}

const attentionLaneStatuses = new Set(["active", "blocked"]);
const attentionLaneHealthValues = new Set(["collision", "approval_required", "failed", "error", "unhealthy", "blocked"]);

function laneNeedsAttention(lane: Row) {
  const status = String(lane.status ?? "").trim().toLowerCase();
  const health = String(lane.health ?? "").trim().toLowerCase();
  if (attentionLaneStatuses.has(status)) return true;
  if (!status || status === "idle") return false;
  return attentionLaneHealthValues.has(health);
}

function displayProfileStrategy(value?: string) {
  if (value === "cdp_profile_lane") return "専用環境";
  if (value === "unique_session") return "一時セッション";
  if (!value) return "未設定";
  return displayVisibleSummary(value);
}

function displayLaneVisibility(value?: string) {
  if (value === "visible") return "表示中";
  if (value === "hidden") return "非表示";
  if (!value) return "未設定";
  return displayVisibleSummary(value);
}

function isErrorNotice(value: string) {
  return /failed|error|required|失敗|エラー|できません|読み込めません|入力してください/.test(value);
}

function userError(value?: string) {
  const map: Record<string, string> = {
    api_not_found: "APIが見つかりません",
    approval_already_decided: "この承認はすでに処理済みです",
    approval_not_found: "承認リクエストが見つかりません",
    bridge_action_not_found: "Bridge操作が見つかりません",
    bridge_approval_not_approved: "先に承認してください",
    bridge_approval_required: "課金・購入・支払い・決済の確認が必要です",
    bridge_execute_not_required: "この操作は実行ボタンから使えます",
    bridge_executor_not_connected: "外部操作Bridgeはまだ接続されていません",
    browser_target_must_be_local: "検証対象はローカルURLだけにしてください",
    command_required: "やりたい作業を入力してください",
    dashboard_failed: "状態を読み込めませんでした",
    request_failed: "操作に失敗しました",
    obsidian_custom_export_requires_approval: "Obsidianの出力先変更には承認が必要です",
    production_write_locked: "本番では操作を停止しています",
    production_write_token_required: "本番操作には認証が必要です",
    run_detail_failed: "選んだ履歴を読み込めませんでした",
    run_failed: "実行できませんでした",
    run_not_found: "あとで見る履歴が見つかりません",
    secret_save_failed: "認証情報を保存できませんでした",
    unknown_error: "不明なエラーです"
  };
  if (!value) return "操作に失敗しました";
  return map[value] ?? "操作に失敗しました";
}

function errorCodeFromApiBody(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

async function readApiJson<T = Row>(response: Response, fallbackError = "request_failed"): Promise<T> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new Error(userError(fallbackError));
  }

  if (!text.trim()) {
    throw new Error(userError(fallbackError));
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(userError(fallbackError));
  }

  if (!response.ok) {
    throw new Error(userError(errorCodeFromApiBody(body) ?? fallbackError));
  }

  return body as T;
}

async function fetchApiJson<T = Row>(input: RequestInfo | URL, init: RequestInit | undefined, fallbackError: string): Promise<T> {
  let response: Response;
  try {
    const token = readStoredOperatorWriteToken();
    const headers = new Headers(init?.headers ?? {});
    if (token) headers.set("x-automation-os-token", token);
    response = await fetch(input, { ...init, headers });
  } catch {
    throw new Error(userError(fallbackError));
  }
  return readApiJson<T>(response, fallbackError);
}

function displayTaskName(value?: string) {
  if (!value) return "自動化";
  const publicName = displayPublicAutomationName(value);
  if (publicName) return publicName;
  if (/qa visible flow|receipt[- ]only/i.test(value)) return "確認作業";
  if (/etsy sync|current listings|正本同期/i.test(value)) return "Etsy同期";
  if (/printify|recovery|復旧/i.test(value)) return "Printify復旧";
  if (/full publish|新規公開|最後まで/i.test(value)) return "新規公開";
  if (/approve command run/i.test(value)) return "確認";
  if (/chrome_authenticated_action/.test(value)) return "ログイン済みChrome操作";
  if (/gmail_drive_calendar_action/.test(value)) return "Gmail/Drive/Calendar操作";
  if (/supabase_shopify_external_action/.test(value)) return "外部システム変更";
  return displayCreatePlanText(value);
}

function displayPublicAutomationName(value?: string) {
  const text = String(value ?? "");
  if (!text.trim()) return "";
  if (/post[- ]application|follow[- ]up|応募後/i.test(text)) return "応募後";
  if (/daily[-_ ]?ai|daily ai/i.test(text)) return "Daily AI";
  if (/job[-_ ]?application|job application|submit queue|応募/i.test(text)) return "応募";
  if (/nisenprints|etsy|printify|pinterest|新規公開/i.test(text)) return "NisenPrints";
  if (/sns[-_ ]?multi[-_ ]?poster|sns multi poster|\bSNS\b/i.test(text)) return "SNS";
  if (/x[-_ ]?authenticated[-_ ]?browser[-_ ]?lane|x authenticated browser lane|\bX\b/i.test(text)) return "X";
  if (/prompt[-_ ]?transfer|ukiyoe|転記/i.test(text)) return "転記";
  if (/automation os|morning|research[-_ ]?plan|朝|毎朝/i.test(text)) return "朝チェック";
  return "";
}

function displayApprovalTitle(value?: string) {
  if (!value) return "承認が必要です";
  const cleaned = value
    .replace(/^Bridge approval[:：]?\s*/i, "")
    .replace(/実行の承認[:：]?\s*/g, "")
    .replace(/approve command run[:：]?\s*/gi, "")
    .replace(/trusted-bridge|外部操作Bridge/gi, "")
    .trim();
  if (!cleaned) return "確認";
  const publicName = displayPublicAutomationName(cleaned);
  if (publicName) return `確認: ${publicName}`;
  const taskName = displayTaskName(cleaned);
  const visibleTask = taskName === value ? displayCreatePlanText(cleaned) : taskName;
  return visibleTask ? `確認: ${visibleTask}` : "確認";
}

function displayStepTime(step: Row) {
  const value = step.completed_at ?? step.started_at;
  if (value) return String(value).slice(11, 19);
  if (step.status === "pending" || step.status === "waiting_approval") return "未開始";
  return "時刻なし";
}

function displayApprovalSubtitle(approval: Row) {
  if (approval.requested_by === "trusted-bridge") {
    return "まだ動かしていません";
  }
  return "確認が必要です";
}

function displayRunCardStatus(disposition: RunDisposition) {
  if (disposition.kind === "actionable") return "確認";
  if (disposition.kind === "running") return "進行中";
  if (disposition.kind === "completed") return "完了";
  if (disposition.archiveReason === "demo") return "サンプル";
  if (disposition.archiveReason === "receipt_only") return "保存";
  return "古い";
}

function displayVisibleSummary(value?: string) {
  return String(value ?? "")
    .replace(/NisenPrints Etsy Sync current listings 正本同期/gi, "Etsy同期")
    .replace(/NisenPrints Printify recovery 途中復旧/gi, "Printify復旧")
    .replace(/NisenPrints Full Publish 新規公開 最後まで/gi, "新規公開")
    .replace(/\s+は/g, "は")
    .trim();
}

function displayCreatePlanText(value?: string) {
  return displayVisibleSummary(value)
    .replace(/専用ブラウザ\/CDP\/Google profileで見える範囲をread-only確認/gi, "専用ブラウザで見える範囲を確認")
    .replace(/X\/YouTube\/Redditは専用ブラウザ\/CDP\/Google profileで見える内容を優先/gi, "X、YouTube、Redditは専用ブラウザで見える範囲を確認")
    .replace(/公式Show transcript\/公開字幕をブラウザで読む/gi, "公式の字幕や台本をブラウザで読む")
    .replace(/YouTube台本は公式Show transcript\/公開字幕をブラウザで読む/gi, "YouTubeの台本は公式の字幕や台本をブラウザで読む")
    .replace(/Data API captions\.downloadは認可が必要なため初期実装では使わない/gi, "初期設定では使いません")
    .replace(/Data API captions\.downloadは認可が必要なので初期実装では使わない/gi, "初期設定では使いません")
    .replace(/API課金前提にせず、見えている画面を正本候補にする/gi, "画面で見える内容を確認元の候補にします")
    .replace(/公式API契約と認可条件を確認してから使う/gi, "公式の利用条件を確認してから使います")
    .replace(/課金・認可・外部書き込みは承認境界へ分離する/gi, "お金や許可が必要な操作は、始める前に確認します")
    .replace(/Browser Use/gi, "画面確認")
    .replace(/CDP\/Google profile/gi, "専用ブラウザ")
    .replace(/Google profile/gi, "ブラウザ設定")
    .replace(/\bCDP\b/g, "専用ブラウザ")
    .replace(/Show transcript/gi, "字幕や台本")
    .replace(/Data API captions\.download/gi, "初期設定では使わない字幕取得")
    .replace(/source-of-truth/gi, "確認元")
    .replace(/read-only inventory/gi, "見るだけの一覧")
    .replace(/read-only proof/gi, "見るだけの確認記録")
    .replace(/read-only/gi, "見るだけ")
    .replace(/receipt-only/gi, "記録だけ")
    .replace(/proof boundary/gi, "確認記録の条件")
    .replace(/run\/proof\/artifact\/DB\/readback/gi, "実行結果と保存記録の確認")
    .replace(/openai_\d+/gi, "AI計画に接続できませんでした")
    .replace(/openai_api_key_missing/gi, "AI計画の接続が未設定です")
    .replace(/codex_planner_[a-z0-9_]+/gi, "ローカル計画に接続できませんでした")
    .replace(/local_planner_[a-z0-9_]+/gi, "簡易計画で整理しています")
    .replace(/\bproof\b/gi, "確認記録")
    .replace(/\brun\b/gi, "実行履歴")
    .replace(/\bartifacts?\b/gi, "保存記録")
    .replace(/\breadback\b/gi, "読み直し確認")
    .replace(/\bDB\b/g, "保存データ")
    .replace(/正本/g, "確認元");
}

function displayChatMessage(message: ChatMessage) {
  const text = message.role === "assistant" ? displayCreatePlanText(message.text) : locallyRedactSecrets(message.text);
  return redactDisplayPaths(text);
}

function displayBridgeReceiptSummary(value?: string) {
  const summary = redactDisplayPaths(displayVisibleSummary(value));
  if (!summary) return "結果を記録しました";
  if (/Browser Use CLI|open\/state\/screenshot|state\/screenshot|screenshot/i.test(summary)) {
    return "画面確認が完了し、保存記録を残しました";
  }
  if (/\[redacted-(?:path|file-uri)\]|data\/artifacts\/|screenshotPath|statePath|logPath/i.test(summary)) {
    return "確認結果と保存記録を残しました";
  }
  return summary;
}

function redactDisplayPaths(value?: string) {
  return String(value ?? "")
    .replace(/file:(?:\\\/){3}Users(?:\\\/)[^\n\r"'<>]+/g, "[redacted-file-uri]")
    .replace(/file:(?:\/\/\/|\/\/|(?:\\\/){2,3})Users\/[^\n\r"'<>]+/g, "[redacted-file-uri]")
    .replace(/\/Users\/[^\n\r"'<>]+/g, "[redacted-path]")
    .replace(/(?:\/private)?\/tmp\/[^\n\r"'<>]+/g, "[redacted-path]")
    .replace(/(?:^|[\s"'(])Documents\/New project\/[^\n\r"'<>]+/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-path]`;
    })
    .replace(/(?:^|[\s"'(])data\/artifacts(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])artifacts(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])output\/playwright(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])\.playwright-cli(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]");
}

type BrowserUseResult = {
  check: Row;
  meta: Row;
  connection: Row;
  cleanup: Row;
  profileIsolation: Row;
  target: string;
  session: string;
  screenshotPath: string;
  statePath: string;
  logPath: string;
};

function toBrowserUseResult(check: Row): BrowserUseResult | null {
  const meta = asJson<Row>(check.metadata_json, {});
  const publicResult = asJson<Row>(meta.browser_use_result, {});
  const nestedMeta = asJson<Row>(meta.metadata, {});
  const driver = String(publicResult.driver ?? nestedMeta.driver ?? meta.driver ?? "");
  if (driver !== "browser_use_cli") return null;

  const connection = asJson<Row>(nestedMeta.connectionStrategy ?? meta.connectionStrategy, {});
  const cleanup = asJson<Row>(nestedMeta.cleanup ?? meta.cleanup, {});
  const profileIsolation = asJson<Row>(nestedMeta.profileIsolation ?? meta.profileIsolation, {});
  return {
    check,
    meta: { ...meta, ...nestedMeta },
    connection: Object.keys(connection).length ? connection : { mode: publicResult.connectionMode },
    cleanup: Object.keys(cleanup).length ? cleanup : { status: publicResult.cleanupStatus },
    profileIsolation,
    target: String(check.target_url ?? nestedMeta.targetUrl ?? meta.targetUrl ?? "--"),
    session: String(connection.session ?? nestedMeta.session ?? meta.session ?? "--"),
    screenshotPath: Number(publicResult.evidenceCount ?? 0) > 0 ? "saved" : String(nestedMeta.screenshotPath ?? meta.screenshotPath ?? ""),
    statePath: Number(publicResult.evidenceCount ?? 0) > 1 ? "saved" : String(nestedMeta.statePath ?? meta.statePath ?? ""),
    logPath: Number(publicResult.evidenceCount ?? 0) > 2 ? "saved" : String(nestedMeta.logPath ?? meta.logPath ?? "")
  };
}

function browserUseResultLine(result: BrowserUseResult) {
  if (result.check.status === "ok") return "画面確認が完了しました。";
  if (result.check.status === "blocked") return "確認が必要です。";
  return "結果を記録しました。";
}

function displayBrowserUseLane(result: BrowserUseResult) {
  if (result.connection.mode === "cdp_profile_lane") return "専用レーン";
  if (result.connection.mode === "unique_session") return "一時セッション";
  return "セッション";
}

function displayCleanupStatus(cleanup: Row) {
  if (cleanup.status === "ok") return "片付け済み";
  if (cleanup.reason === "browser_use_cli_missing") return "実行できませんでした";
  if (cleanup.reason === "cdp_profile_lane_preserved") return "専用レーンを保持";
  if (cleanup.status === "skipped") return "スキップ";
  if (cleanup.status === "blocked") return "片付け未完了";
  return "不明";
}

function displayShortDateTime(value?: string) {
  if (!value) return "未実行";
  return String(value).slice(0, 16).replace("T", " ");
}

function displayObsidianReason(value?: string) {
  const map: Record<string, string> = {
    api_state_change: "アプリ操作後の自動同期",
    bridge_action: "手動更新",
    cli_manual_export: "CLI手動実行",
    codex_stop_hook: "Codex終了時の自動同期",
    periodic: "定期同期"
  };
  if (!value) return "理由なし";
  if (value.endsWith("_skipped_export_in_flight")) return "同期中のためスキップ";
  return map[value] ?? value;
}

function displayGeneratedFileCheck(check: Row) {
  if (!check || typeof check !== "object" || check.checkedAt == null) return "生成ファイル確認: 未確認";
  const ok = check.ok === true;
  const total = Number(check.total ?? 0);
  const missing = Array.isArray(check.missing) ? check.missing.length : 0;
  const nonGenerated = Array.isArray(check.nonGenerated) ? check.nonGenerated.length : 0;
  if (ok) return `生成ファイル確認: OK ${total}件`;
  return `生成ファイル確認: 要確認 missing ${missing} / nonGenerated ${nonGenerated}`;
}

function displayGeneratedFileCheckPublic(check: Row) {
  if (!check || typeof check !== "object" || check.checkedAt == null) return "未確認";
  return check.ok === true ? "OK" : "要確認";
}

function publicEvidenceCopy(count: number) {
  if (count <= 0) return "保存記録はまだありません";
  return `${count}件の保存記録を内部に保存済み`;
}

function postNotice(message: string, body: Row) {
  const suffix = body.imported ?? body.ingested;
  const nestedRun = body.run && typeof body.run === "object" ? body.run : {};
  const nextAction = typeof body.nextAction === "string" ? body.nextAction : "";
  if (typeof suffix === "number") return `${message}: ${suffix}件`;
  if (body.counts && typeof body.counts === "object") return `${message}: skills=${body.counts.skills ?? 0}, plugins=${body.counts.plugins ?? 0}`;
  if (Array.isArray(body.notes)) return `${message}: ${body.notes.length}件`;
  if (typeof body.removed === "number") return `${message}: ${body.removed}件`;
  if (typeof body.summary === "string") return `${message}: ${displayBridgeReceiptSummary(body.summary)}`;
  if (typeof body.targetUrl === "string") return `${message}: ${body.targetUrl}`;
  if (typeof body.outputDir === "string") return `${message}: ${body.outputDir}`;
  if (nextAction) return `${message}: ${nextAction}`;
  if (typeof nestedRun.status === "string") return `${message}: ${displayStatus(nestedRun.status)}`;
  if (typeof body.status === "string") return `${message}: ${displayStatus(body.status)}`;
  return message;
}

function extractResponseRunId(body: Row) {
  if (typeof body.runId === "string" && body.runId.trim()) return body.runId;
  const nestedRun = body.run && typeof body.run === "object" ? body.run : {};
  return typeof nestedRun.runId === "string" && nestedRun.runId.trim() ? nestedRun.runId : null;
}

function extractResponsePlanId(body: Row) {
  if (typeof body.planId === "string" && body.planId.trim()) return body.planId;
  const nestedPlan = body.plan && typeof body.plan === "object" ? body.plan : {};
  return typeof nestedPlan.id === "string" && nestedPlan.id.trim() ? nestedPlan.id : null;
}

function extractResponseCheckId(body: Row) {
  if (typeof body.checkId === "string" && body.checkId.trim()) return body.checkId;
  if (typeof body.demoCheckId === "string" && body.demoCheckId.trim()) return body.demoCheckId;
  const systemCheck = body.systemCheck && typeof body.systemCheck === "object" ? body.systemCheck : {};
  return typeof systemCheck.id === "string" && systemCheck.id.trim() ? systemCheck.id : null;
}

function extractResponseWorkflowId(body: Row) {
  if (typeof body.workflowId === "string" && body.workflowId.trim()) return body.workflowId;
  const workflow = body.workflow && typeof body.workflow === "object" ? body.workflow : {};
  return typeof workflow.id === "string" && workflow.id.trim() ? workflow.id : null;
}

function secretLabels(secrets: SecretSummary[]) {
  return secrets.map((secret) => secret.label).filter(Boolean);
}

function savedSecretLine(secrets: SecretSummary[], kind: string) {
  const secret = secrets.find((entry) => entry.kind === kind);
  return secret ? `前回保存した${secret.label}があるので、必要ならこれを使いますね。値は画面には表示しません。` : "";
}

function savedSecretNotice(secrets: SecretSummary[]) {
  const labels = secretLabels(secrets);
  return labels.length ? `${labels.join("、")}を保存しました。次回からは保存済みのキーとして使います。値は画面には表示しません。` : "";
}

function locallyRedactSecrets(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[保存済み: APIキー]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[保存済み: APIキー]")
    .replace(/\b((?:api[_-]?key|token|secret|access[_-]?token)\s*[:=]\s*)([A-Za-z0-9_.-]{32,})\b/gi, "$1[保存済み: APIキー]")
    .replace(/((?:APIキー|apiキー|キー|トークン)\s*(?:[:=：]|は|が|を)?\s*)([A-Za-z0-9_.-]{32,})\b/g, "$1[保存済み: APIキー]");
}

function mayContainSecret(value: string) {
  return /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/i.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\b(?:api[_-]?key|token|secret|access[_-]?token)\s*[:=]\s*[A-Za-z0-9_.-]{32,}\b/i.test(value)
    || /(?:APIキー|apiキー|キー|トークン)\s*(?:[:=：]|は|が|を)?\s*[A-Za-z0-9_.-]{32,}\b/.test(value);
}

function conversationUserText(messages: ChatMessage[], nextText: string) {
  return [
    ...messages.filter((message) => message.role === "user").map((message) => message.text),
    nextText
  ].join("\n");
}

function detectedConversationFacts(text: string) {
  const lower = text.toLowerCase();
  return {
    cadence: /毎朝|毎日|毎週|定期|schedule|daily|weekly|朝|夜|\b\d{1,2}\s*時|\b\d{1,2}:\d{2}\b/.test(lower),
    retry: /失敗|止ま|再開|再試行|リトライ|retry|blocked|error|エラー|\d+\s*分後/.test(lower),
    permission: /投稿まで|送信まで|応募まで|公開まで|進めて|自動で|止めたい|条件|許可|していい|してよい/.test(lower),
    proof: /url|スクショ|画面|db|保存|証拠|証跡|ログ|readback|確認記録/.test(lower),
    source: /正本|source|queue|キュー|sheet|sheets|db|url|画面|ファイル|daily ai|nisenprints|x|youtube|etsy|printify/.test(lower)
  };
}

function conversationQuestionPlan(text: string) {
  const facts = detectedConversationFacts(text);
  return [
    facts.cadence && facts.retry ? null : "いつ動かし、失敗したら何分後に再確認しますか？",
    facts.permission ? null : "どこまで自動で進めてよく、どこで止めたいですか？",
    facts.proof && facts.source ? null : "正本にする画面・URL・DB・保存ファイルと、完了証拠はどれにしますか？"
  ].filter((question): question is string => Boolean(question));
}

function conversationAnsweredLabels(text: string) {
  const facts = detectedConversationFacts(text);
  return [
    facts.cadence ? "実行タイミング" : null,
    facts.retry ? "失敗時の扱い" : null,
    facts.permission ? "自動で進める範囲" : null,
    facts.source ? "正本候補" : null,
    facts.proof ? "完了証拠" : null
  ].filter((label): label is string => Boolean(label));
}

function automationAdvice(value: string, secrets: SecretSummary[] = [], history: ChatMessage[] = []): CreateDraft {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (isQuestionOnlyPrompt(text)) {
    return answerOnlyAdvice(text, secrets, history);
  }
  if (/printify|publishing|固着|商品id|product_id|product id/.test(lower)) {
    const keyLine = savedSecretLine(secrets, "printify");
    return {
      command: "NisenPrints Printify recovery 途中復旧",
      title: "Printifyの途中停止を同じ商品で復旧する",
      reply: `${keyLine ? `${keyLine} ` : ""}その場合は、同じ商品IDを使って再開するのが良いです。ユーザーには「同じ商品を確認」「復旧開始」「結果確認」だけを見せ、APIのis_locked確認や再Publish判断はバックエンド側で扱います。`,
      visibleSteps: ["同じ商品を確認", "止まった場所から再開", "Etsy公開状態を確認"],
      backendChecks: ["manifestのproduct_idを正本にする", "Printify API/UIの状態を照合", "重複商品を作らないガード"],
      answered: ["正本候補", "失敗時の扱い"],
      openQuestions: ["どこまで自動で進めてよく、どこで止めたいですか？"],
      nextAction: "保存して同じ商品を確認し、止まった場所から再開します。",
      executionDecision: "save_plan" as CreatePlannerDecision,
      confidence: "medium" as const,
      plannerSource: "local_fallback" as const
    };
  }
  if (/etsy|listing|リスティング|正本|公開リスト/.test(lower)) {
    const keyLine = savedSecretLine(secrets, "etsy");
    return {
      command: "NisenPrints Etsy Sync current listings 正本同期",
      title: "Etsyの現在公開リストを正本にする",
      reply: `${keyLine ? `${keyLine} ` : ""}それなら、Etsy側の現在公開リストを正として読み、ローカルの古いqueue/listingsを戻さない形が安全です。見せる画面は「同期する」「結果を見る」だけにして、古い行の退避や検証は裏側に回します。`,
      visibleSteps: ["Etsyの公開リストを確認", "ローカル管理データを同期", "古い行が復活しないか確認"],
      backendChecks: ["Etsy snapshot と queue/listings のID集合を比較", "stale rowsを退避", "同期後にテストと画面確認"],
      answered: ["正本候補", "完了証拠"],
      openQuestions: ["いつ動かし、失敗したら何分後に再確認しますか？"],
      nextAction: "保存してEtsyの公開リストを読み、同期結果を確認します。",
      executionDecision: "save_plan" as CreatePlannerDecision,
      confidence: "medium" as const,
      plannerSource: "local_fallback" as const
    };
  }
  if (/obsidian|wiki|vault/.test(lower)) {
    return {
      command: "Obsidian Wiki ingest compile lint automation",
      title: "Obsidianを知識ベースとして使う",
      reply: "Obsidianは、実行ログや学びをAIが読みやすいMarkdownにして、次の自動化作成に活かす場所として使うのが合っています。画面には「知識を使う」だけを出し、取り込み・リンク・lintは詳細に隠します。",
      visibleSteps: ["使うメモを選ぶ", "手順に変換", "不足や矛盾を確認"],
      backendChecks: ["Markdownへ正規化", "関連ページのリンク確認", "古い情報や矛盾のlint"],
      answered: ["正本候補"],
      openQuestions: ["いつ動かし、失敗したら何分後に再確認しますか？", "完了証拠はどれにしますか？"],
      nextAction: "使うメモを選び、手順化の実演から始めます。",
      executionDecision: "ask_more" as CreatePlannerDecision,
      confidence: "medium" as const,
      plannerSource: "local_fallback" as const
    };
  }
  const planning = deepPlanningAdvice(text || initialCreatePrompt, secrets, history);
  return {
    command: planning.command,
    title: planning.title,
    reply: planning.reply,
    visibleSteps: planning.visibleSteps,
    backendChecks: planning.backendChecks,
    answered: planning.answered,
    openQuestions: planning.openQuestions,
    nextAction: planning.nextAction,
    executionDecision: planning.executionDecision,
    confidence: planning.confidence,
    plannerSource: "local_fallback" as const
  };
}

function isQuestionOnlyPrompt(text: string) {
  const lower = text.toLowerCase();
  return /(\?|？|できること|どこまで|何ができる|説明して|教えて|書き出して|全て|一覧|違います|今の状況|what can|tell me|explain)/.test(lower)
    && !/作って|作成|実行|開始|保存|投稿|公開|応募|送信|定期|予約|自動化|workflow|automation/.test(lower);
}

function answerOnlyAdvice(value: string, secrets: SecretSummary[] = [], history: ChatMessage[] = []): CreateDraft {
  const text = value.trim();
  const lower = text.toLowerCase();
  const secretHint = secrets.length ? "保存済みの認証情報は必要な場面だけ使います。値は画面には出しません。\n\n" : "";
  if (/保存だけ|保存して|secret|認証情報|key|token|パスワード|password/.test(lower)) {
    return {
      command: text,
      title: "認証情報だけを安全に保存する",
      reply: `${secretHint}はい。認証情報は保存だけにして、実行や送信には進めません。次の一手は、保存したキーを使う場面が来たときに、その都度確認して進めることです。`,
      visibleSteps: ["認証情報を保存", "値を画面に出さない", "必要な場面でだけ使う"],
      backendChecks: ["secretを平文で残さない", "保存と実行を分ける", "画面にはマスクだけ出す"],
      answered: ["認証情報の保存", "実行しない境界"],
      openQuestions: [],
      nextAction: "保存は完了です。必要になったら、その時点で使うかどうかを確認します。",
      executionDecision: "ready_to_start",
      confidence: "high" as const,
      plannerSource: "local_fallback" as const,
      intent: "answer_question" as const
    };
  }
  const summary = /できること|何ができる|どこまで|一覧/.test(lower)
    ? "このチャットは、相談を受けて、必要なら保存・実演・開始・定期化までを分けて扱えます。"
    : "今の質問には、作成よりも説明が合っています。";
  return {
    command: text,
    title: "このチャットでできることを説明する",
    reply: `${secretHint}${summary}\n\n・質問への回答\n・保存前の計画づくり\n・実演前の確認\n・開始前の停止条件整理\n・履歴や失敗理由の読み直し\n\n必要なら次に、今の画面で押せるものや、まだ足りない確認項目を順番に並べます。`,
    visibleSteps: [],
    backendChecks: ["質問には答えだけ返す", "計画カードは出しすぎない", "必要時だけ保存や開始に進む"],
    answered: ["質問への回答", "保存前の整理"],
    openQuestions: [],
    nextAction: "続けて、見たい画面や確認したい操作を1つだけ教えてください。",
    executionDecision: "ready_to_start",
    confidence: "high" as const,
    plannerSource: "local_fallback" as const,
    intent: "answer_question" as const
  };
}

function deepPlanningAdvice(text: string, secrets: SecretSummary[] = [], history: ChatMessage[] = []) {
  const conversationText = conversationUserText(history, text);
  const lower = conversationText.toLowerCase();
  const isScheduled = /毎朝|毎日|毎週|定期|schedule|daily|weekly|朝|夜/.test(lower);
  const isSubmit = /応募|申請|送信|submit|apply|フォーム|予約/.test(lower);
  const publishNegated = /投稿やSNSの話ではありません|SNSの話ではありません|投稿.*ではありません|公開.*ではありません|投稿はしない|投稿しない|公開はしない|公開しない|postしない|publishしない|no post|do not post/i.test(conversationText);
  const isPublish = !publishNegated && /投稿|公開|publish|post|sns|x|twitter|instagram|threads|pinterest|etsy/.test(lower);
  const isResearch = /調査|確認|比較|探し|探す|research|watch|チェック|監視/.test(lower);
  const isDiagnosticReview = /失敗を見て|失敗.*原因|ロック原因|lock原因|修正方針|検証を提案|原因なら|提案して/.test(conversationText)
    && !/開始したい|実行したい|応募したい|送信したい|投稿したい|公開したい|保存したい/.test(conversationText);
  const hasExternalAction = isSubmit || isPublish;
  const savedSecretPrefix = secrets.length ? "保存済みの認証情報は、必要な場面だけ使います。値は画面には出しません。\n\n" : "";
  const summary = isDiagnosticReview
    ? "これは、実行を始めずに状態と原因を読み、次の検証だけを整理する相談です。"
    : hasExternalAction
    ? "これは「状況確認 → 判断 → 必要なら外部操作」までを1本にする自動化です。"
    : isResearch
      ? "これは「情報を集める → 判断する → 証拠を残す」ための自動化です。"
      : "これは、いま手でやっている作業を小さな手順に分けて自動化する相談です。";
  const cadenceStep = isScheduled ? "実行タイミングと失敗時の再開条件を決める" : "手動開始から実演して、定期化するか決める";
  const boundaryStep = hasExternalAction && !isDiagnosticReview ? "送信・投稿の直前に課金だけ止める境界を置く" : "読み取りと保存だけで安全に確認する";
  const proofStep = isResearch ? "見たURL・画面・保存結果を証跡として残す" : "実行結果・画面・後片付けを証跡として残す";
  const openQuestions = isDiagnosticReview ? [] : conversationQuestionPlan(conversationText);
  const answered = conversationAnsweredLabels(conversationText);
  const visibleSteps = [
    "目的と完了条件を確認",
    "正本になる画面やデータを読む",
    cadenceStep,
    boundaryStep,
    proofStep,
    "小さく実行して結果を確認"
  ];
  const backendChecks = [
    "source-of-truthを固定して古い履歴を混ぜない",
    "重い処理はバックグラウンドrunとして開始する",
    "run_idごとにURL・画面・ログ・cleanup証跡を残す",
    "失敗時はexact blockerを保存して同じ場所から再開する"
  ];
  const nextAction = isScheduled
    ? "まずは「保存」で計画を残し、「見る」で画面を確認してから、問題なければ定期化します。"
    : "まずは「保存」で計画を残し、「見る」で実演してから、問題なければ開始します。";
  const questionBlock = openQuestions.length
    ? ["確認したいこと", ...openQuestions.map((question) => `・${question}`)].join("\n")
    : ["確認できたこと", ...answered.map((label) => `・${label}`), "この内容で一度小さく試せます。"].join("\n");
  const reply = [
    `${savedSecretPrefix}${answered.length >= 3 ? "だいぶ具体化できました。" : "いいです。"}${summary}`,
    questionBlock,
    ["進め方", visibleSteps.join(" → ")].join("\n"),
    ["次の一手", nextAction].join("\n")
  ].join("\n\n");
  return {
    command: text,
    title: isScheduled ? "定期実行を相談しながら設計する" : "相談内容を実行できる手順に分解する",
    reply,
    visibleSteps,
    backendChecks,
    answered,
    openQuestions,
    nextAction,
    executionDecision: openQuestions.length > 1 ? "ask_more" as const : openQuestions.length === 1 ? "save_plan" as const : isScheduled ? "ready_to_schedule" as const : "demo_first" as const,
    confidence: openQuestions.length ? "medium" as const : "high" as const
  };
}

function savedSecretAdvice(): CreateDraft {
  return {
    command: "",
    title: "認証情報を保存しました",
    reply: "保存できました。次に作りたい自動化をそのまま教えてください。保存済みキーは必要な場面だけ使い、値は画面には出しません。",
    visibleSteps: ["やりたい自動化を入力", "必要な場面で保存済みキーを使う", "開始前に内容を確認"],
    backendChecks: ["保存済みキーを必要な場面だけ使う", "値を画面に表示しない", "自動化本文と認証情報を分ける"],
    answered: ["認証情報"],
    openQuestions: ["何を自動化したいですか？"],
    nextAction: "次のメッセージで目的を聞き、計画を作ります。",
    executionDecision: "ask_more" as CreatePlannerDecision,
    confidence: "medium" as const,
    plannerSource: "local_fallback" as const,
    intent: "answer_question" as const
  };
}

function readCreateDraftSession(): CreateDraftSession | null {
  try {
    const raw = window.localStorage.getItem(createDraftSessionStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CreateDraftSession>;
    if (parsed.version !== 1 || !isCreateDraft(parsed.draft) || !Array.isArray(parsed.messages)) return null;
    const messages = compactCreateMessages(parsed.messages
      .filter((message): message is ChatMessage => isChatMessage(message))
      .slice(-24));
    if (messages.length === 0) return null;
    return {
      version: 1,
      messages,
      draft: parsed.draft,
      researchSources: isResearchSourceSelection(parsed.researchSources) ? parsed.researchSources : initialResearchSources,
      command: typeof parsed.command === "string" ? parsed.command : parsed.draft.command
    };
  } catch {
    return null;
  }
}

function writeCreateDraftSession(session: CreateDraftSession) {
  try {
    window.localStorage.setItem(createDraftSessionStorageKey, JSON.stringify(session));
  } catch {
    // Draft persistence is convenience-only. The planner and run APIs remain authoritative.
  }
}

function clearCreateDraftSession() {
  try {
    window.localStorage.removeItem(createDraftSessionStorageKey);
  } catch {
    // Ignore storage failures; reset should still update in-memory state.
  }
}

function readStoredOperatorWriteToken() {
  try {
    return window.localStorage.getItem(operatorWriteTokenStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeStoredOperatorWriteToken(value: string) {
  try {
    window.localStorage.setItem(operatorWriteTokenStorageKey, value.trim());
    return true;
  } catch {
    return false;
  }
}

function clearStoredOperatorWriteToken() {
  try {
    window.localStorage.removeItem(operatorWriteTokenStorageKey);
  } catch {
    // Ignore storage failures; token can be overwritten later.
  }
}

async function readServerCreateDraftSession(): Promise<CreateDraftSession | null> {
  try {
    const body = await fetchApiJson<{ session?: Row | null }>("/api/create/session", undefined, "create_session_failed");
    const session = body.session;
    if (!session || !isCreateDraft(session.draft) || !Array.isArray(session.messages)) return null;
    const messages = compactCreateMessages(session.messages
      .flatMap((message, index): ChatMessage[] => {
        if (!message || typeof message !== "object") return [];
        const item = message as Row;
        const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
        if (!role || typeof item.text !== "string") return [];
        return [{
          id: typeof item.id === "string" ? item.id : `server-create-${index}`,
          role,
          text: item.text
        }];
      })
      .slice(-24));
    if (messages.length === 0) return null;
    return {
      version: 1,
      messages,
      draft: session.draft,
      researchSources: isResearchSourceSelection(session.researchSources) ? session.researchSources : initialResearchSources,
      command: typeof session.command === "string" ? session.command : session.draft.command
    };
  } catch {
    return null;
  }
}

function writeServerCreateDraftSession(session: CreateDraftSession) {
  void fetchApiJson("/api/create/session", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: session.messages,
      draft: session.draft,
      researchSources: session.researchSources,
      command: session.command
    })
  }, "create_session_save_failed").catch(() => undefined);
}

function isChatMessage(value: unknown): value is ChatMessage {
  const message = value as Partial<ChatMessage>;
  return typeof message?.id === "string"
    && (message.role === "assistant" || message.role === "user")
    && typeof message.text === "string";
}

function isCreateDraft(value: unknown): value is CreateDraft {
  const draft = value as Partial<CreateDraft>;
  return typeof draft?.command === "string"
    && typeof draft.title === "string"
    && typeof draft.reply === "string"
    && Array.isArray(draft.visibleSteps)
    && Array.isArray(draft.backendChecks)
    && Array.isArray(draft.answered)
    && Array.isArray(draft.openQuestions)
    && typeof draft.nextAction === "string";
}

function isResearchSourceSelection(value: unknown): value is Record<ResearchSourceKey, boolean> {
  const selection = value as Partial<Record<ResearchSourceKey, boolean>>;
  return researchSourceKeys.every((key) => typeof selection?.[key] === "boolean");
}

function previewResearchPlan(command: string, sources: Record<ResearchSourceKey, boolean>): ResearchPlan {
  const enabledLabels = researchSourceKeys.filter((key) => sources[key]).map((key) => researchSourceLabels[key]);
  const sourcePlans: ResearchSourcePlan[] = researchSourceKeys.map((key) => ({
    key,
    label: researchSourceLabels[key],
    enabled: sources[key],
    mode:
      key === "youtube"
        ? "公式の字幕や台本をブラウザで読む"
        : key === "x"
          ? "専用ブラウザで見える範囲を確認"
          : key === "reddit"
            ? "ブラウザで公開スレッドを見るだけ確認"
            : key === "mcp"
              ? "使える連携先を一覧で確認"
              : key === "api"
                ? "公式の利用条件を確認してから使います"
                : "公開Webをブラウザで読む",
    boundary:
      key === "youtube"
        ? "初期設定では使いません"
        : key === "x" || key === "reddit"
          ? "画面で見える内容を確認元の候補にします"
          : key === "api" || key === "mcp"
            ? "お金や許可が必要な操作は、始める前に確認します"
            : "公開ページの表示内容とURLをsource-of-truthにする",
    metadata: {}
  }));
  return {
    id: "preview",
    title: command.trim().slice(0, 72) || "相談プラン",
    status: "draft",
    command: command.trim() || initialCreatePrompt,
    sources: sourcePlans,
    visibleFlow: [
      "目的を確認",
      enabledLabels.length ? `${enabledLabels.join(" / ")} を見て確認` : "計画だけを確認",
      "完了の見分け方を決める",
      "課金・購入・支払い・決済だけ停止",
      "開始"
    ],
    sourceOfTruth: [
      "公開ページ、公式UI、保存済みローカルartifact、Automation OS DB",
      "X、YouTube、Redditは専用ブラウザで見える範囲を確認",
      "YouTubeの台本は公式の字幕や台本をブラウザで読む"
    ],
    proofBoundary: [
      "research_plan_snapshotは開始前計画証跡であり完了証跡ではない",
      "完了にはrun/proof/artifact/DB/readbackの別証跡が必要",
      "demoはローカルAutomation OS画面のBrowser Use checkのみ"
    ],
    approvalBoundary: [
      "課金・購入・支払い・決済だけhard stopにする",
      "送信、投稿、削除、応募、保存、外部書き込みは証跡を残して実行する",
      "字幕取得の特別なAPIは初期設定では使いません",
      "MCP/APIで課金、購入、支払い、決済が必要な場合だけ既存approval flowへ分離"
    ],
    metadata: { snapshotRole: "pre_start_plan_evidence_not_completion_proof" },
    demoCheckId: null,
    runId: null,
    createdAt: "",
    updatedAt: ""
  };
}

export default function App() {
  const [restoredCreateSession] = useState(() => readCreateDraftSession());
  const [serverCreateSessionChecked, setServerCreateSessionChecked] = useState(Boolean(restoredCreateSession));
  const [dashboard, setDashboard] = useState<Dashboard>(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [activeView, setActiveViewState] = useState<View>(initialView);
  const [command, setCommand] = useState("");
  const [createInput, setCreateInput] = useState("");
  const [createMessages, setCreateMessages] = useState<ChatMessage[]>(() => restoredCreateSession?.messages ?? initialCreateMessages);
  const [createDraft, setCreateDraft] = useState(() => restoredCreateSession?.draft ?? automationAdvice(initialCreatePrompt));
  const [researchSources, setResearchSources] = useState<Record<ResearchSourceKey, boolean>>(() => restoredCreateSession?.researchSources ?? initialResearchSources);
  const [activeResearchPlan, setActiveResearchPlan] = useState<ResearchPlan | null>(null);
  const [sourceCaptureResults, setSourceCaptureResults] = useState<Partial<Record<ResearchSourceKey, PlannerCaptureResponse>>>({});
  const [capabilityPlan, setCapabilityPlan] = useState<CapabilityRouterSnapshot | null>(null);
  const [createPlanDirty, setCreatePlanDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [operatorWriteTokenReady, setOperatorWriteTokenReady] = useState(() => Boolean(readStoredOperatorWriteToken()));
  const [actionReceipt, setActionReceipt] = useState<ActionReceipt | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [selectedProof, setSelectedProof] = useState<Row | null>(null);
  const [selectedProofView, setSelectedProofView] = useState<ProofView | null>(null);
  const [proofViewLoading, setProofViewLoading] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Row | null>(null);
  const quickActionsDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const visibleCreateSteps = normalizeVisibleSteps(createDraft.visibleSteps);
  const previewCreatePlan = previewResearchPlan(createDraft.command, researchSources);
  const createResearchPlan = {
    ...previewCreatePlan,
    ...(activeResearchPlan ?? {}),
    sources: previewCreatePlan.sources,
    visibleFlow: visibleCreateSteps
  };

  function recordActionReceipt(input: Omit<ActionReceipt, "id" | "createdAt">) {
    setActionReceipt({
      ...input,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString()
    });
  }

  function closeQuickActionMenu() {
    if (quickActionsDetailsRef.current) quickActionsDetailsRef.current.open = false;
  }

  function saveOperatorWriteToken(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setNotice("操作tokenを入力してください。");
      return false;
    }
    if (!writeStoredOperatorWriteToken(trimmed)) {
      setNotice("このブラウザに操作tokenを保存できませんでした。");
      return false;
    }
    setOperatorWriteTokenReady(true);
    setNotice("このブラウザに操作tokenを保存しました。");
    return true;
  }

  function clearOperatorWriteToken() {
    clearStoredOperatorWriteToken();
    setOperatorWriteTokenReady(false);
    setNotice("このブラウザの操作tokenを削除しました。");
  }

  async function refresh(announce = true, options: RefreshOptions = {}) {
    if (!options.background) setLoading(true);
    try {
      const body = await fetchApiJson<unknown>("/api/dashboard", undefined, "dashboard_failed");
      if (!isDashboard(body)) throw new Error(userError("dashboard_failed"));
      setDashboard(body);
      setSelectedRunId((current) => resolveSelectedRunId(current, body.runs, body.actionableRuns ?? []));
      if (announce) setNotice("最新の状態に更新しました");
    } catch (error) {
      setNotice(options.staleNotice ? "最新状態を取得できませんでした。前回データを表示中です。" : error instanceof Error ? error.message : "状態を読み込めませんでした");
    } finally {
      if (!options.background) setLoading(false);
    }
  }

  async function post(path: string, message: string, options: { view?: View; key?: string } = {}) {
    const key = options.key ?? path;
    closeQuickActionMenu();
    setBusyKey(key);
    try {
      const body = await fetchApiJson<Row>(path, { method: "POST" }, "request_failed");
      const approvalRequired = body.status === "approval_required"
        || body.status === "waiting_approval"
        || body.run?.status === "waiting_approval";
      const blocked = body.ok === false || body.status === "blocked";
      const responseRunId = extractResponseRunId(body);
      if (responseRunId) setSelectedRunId(responseRunId);
      if (body.id && path.includes("/skills/")) setSelectedSkill(body);
      if (blocked) {
        const detail = body.exactBlocker ? "詳細は診断に保存しました。" : postNotice("停止", body);
        recordActionReceipt({
          tone: "blocked",
          title: "操作は停止しました",
          detail,
          nextAction: responseRunId ? "履歴で理由と保存記録を確認してください。" : "診断または詳細で理由を確認してください。",
          view: responseRunId ? "Runs" : options.view,
          runId: responseRunId ?? undefined,
          planId: extractResponsePlanId(body) ?? undefined,
          checkId: extractResponseCheckId(body) ?? undefined,
          workflowId: extractResponseWorkflowId(body) ?? undefined
        });
        setNotice(body.exactBlocker ? "操作は停止しました。詳細は診断に保存しました。" : `操作は停止しました。${detail}`);
        void refresh(false, { background: true, staleNotice: true });
        return;
      }
      if (approvalRequired) {
        setActiveView("Approvals", false);
      } else if (options.view) {
        setActiveView(options.view, false);
      }
      const detail = postNotice(message, body);
      recordActionReceipt({
        tone: approvalRequired ? "blocked" : responseRunId ? "running" : "ok",
        title: approvalRequired ? "確認が必要です" : message,
        detail,
        nextAction: approvalRequired
          ? "承認画面で内容を確認してください。"
          : responseRunId
            ? typeof body.nextAction === "string" && body.nextAction.trim()
              ? body.nextAction
              : "履歴でキュー状態と保存記録を確認できます。"
            : "画面の最新状態を読み直しました。",
        view: approvalRequired ? "Approvals" : options.view,
        runId: approvalRequired ? undefined : responseRunId ?? undefined,
        planId: extractResponsePlanId(body) ?? undefined,
        checkId: extractResponseCheckId(body) ?? undefined,
        workflowId: extractResponseWorkflowId(body) ?? undefined
      });
      setNotice(approvalRequired ? `${detail}。承認画面で内容を確認してください。` : detail);
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作に失敗しました");
    } finally {
      setBusyKey(null);
    }
  }

  async function runSchedulerOnce() {
    setBusyKey("scheduler-run-once");
    try {
      const body = await fetchApiJson<Row>("/api/registered-workflows/scheduler/run-once", { method: "POST" }, "request_failed");
      const started = Number(body.started ?? 0);
      const blocked = Number(body.blocked ?? 0);
      const runIds = Array.isArray(body.runIds) ? body.runIds.filter((id): id is string => typeof id === "string") : [];
      if (runIds[0]) setSelectedRunId(runIds[0]);
      if (started > 0) {
        setActiveView("Runs", false);
        setNotice(blocked > 0 ? `${started}件開始しました。確認が必要な予定が${blocked}件あります。` : `${started}件開始しました。履歴で進行状況を確認できます。`);
        recordActionReceipt({
          tone: "running",
          title: "定期確認を開始しました",
          detail: blocked > 0 ? `${started}件開始、${blocked}件は確認が必要です。` : `${started}件開始しました。`,
          nextAction: "履歴で進行状況を確認できます。",
          view: "Runs",
          runId: runIds[0]
        });
      } else if (blocked > 0) {
        setNotice(`確認が必要な予定が${blocked}件あります。履歴と詳細に理由を保存しました。`);
        recordActionReceipt({
          tone: "blocked",
          title: "確認が必要な予定があります",
          detail: `${blocked}件の予定が停止理由を保存しました。`,
          nextAction: "履歴と詳細で理由を確認してください。",
          view: "Runs",
          runId: runIds[0]
        });
      } else {
        setNotice("今すぐ動かせる予定はありません。各行の再生ボタンなら個別に一回実行できます。");
        recordActionReceipt({
          tone: "info",
          title: "今すぐ動かせる予定はありません",
          detail: "定期の実行タイミングに該当するものはありませんでした。",
          nextAction: "各行の再生ボタンなら個別に一回実行できます。",
          view: "Schedule"
        });
      }
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作に失敗しました");
    } finally {
      setBusyKey(null);
    }
  }

  async function updateRegisteredSchedule(id: string, schedule: { frequency: string; time: string; days?: string[] }) {
    const key = `registered-schedule-${id}`;
    setBusyKey(key);
    try {
      const body = await fetchApiJson<Row>(`/api/registered-workflows/${encodeURIComponent(id)}/schedule`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule)
      }, "request_failed");
      const scheduleLabel = schedule.frequency === "weekly" ? `毎週 ${schedule.time}` : `毎日 ${schedule.time}`;
      setNotice(`予定を保存しました（${scheduleLabel}）`);
      recordActionReceipt({
        tone: "ok",
        title: "予定を保存しました",
        detail: scheduleLabel,
        nextAction: "次回の定期確認からこの予定を使います。",
        view: "Schedule",
        workflowId: extractResponseWorkflowId(body) ?? id
      });
      void refresh(false, { background: true, staleNotice: true });
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作に失敗しました");
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  async function saveAndSanitizeMessage(text: string, optimisticText = locallyRedactSecrets(text)) {
    if (!mayContainSecret(text)) {
      return { sanitizedText: optimisticText, storedSecrets: [] };
    }
    const body = await fetchApiJson<Row>("/api/secrets/from-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }, "secret_save_failed");
    const sanitizedText = typeof body.sanitizedText === "string" ? body.sanitizedText : optimisticText;
    return {
      sanitizedText: locallyRedactSecrets(sanitizedText),
      storedSecrets: Array.isArray(body.stored) ? body.stored as SecretSummary[] : []
    };
  }

  async function startRun(nextCommand: string, key = "start") {
    const rawCommand = nextCommand.trim();
    if (!rawCommand) {
      setNotice("やりたい作業を入力してください");
      return;
    }
    setBusyKey(key);
    setCommand(locallyRedactSecrets(rawCommand));
    try {
      const { sanitizedText, storedSecrets } = await saveAndSanitizeMessage(rawCommand);
      const safeCommand = sanitizedText.trim();
      if (!safeCommand) throw new Error("やりたい作業を入力してください");
      setCommand(safeCommand);
      const body = await fetchApiJson<Row>("/api/runs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: safeCommand })
      }, "run_failed");
      setSelectedRunId(body.runId);
      const status = body.run?.status ?? "queued";
      const secretNotice = savedSecretNotice(storedSecrets);
      recordActionReceipt({
        tone: status === "blocked" ? "blocked" : "running",
        title: "実行を開始しました",
        detail: `${secretNotice ? `${secretNotice} ` : ""}${displayStatus(status)}`.trim(),
        nextAction: status === "waiting_approval" ? "承認画面で内容を確認してください。" : "履歴で進行状況と保存記録を確認できます。",
        view: status === "waiting_approval" ? "Approvals" : "Runs",
        runId: typeof body.runId === "string" ? body.runId : undefined
      });
      setNotice(`${secretNotice ? `${secretNotice} ` : ""}実行を開始しました（${displayStatus(status)}）`);
      setActiveView(status === "waiting_approval" ? "Approvals" : "Runs", false);
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "実行できませんでした");
    } finally {
      setBusyKey(null);
    }
  }

  async function startCommand() {
    await startRun(command, "start");
  }

  function currentCreateSessionPayload() {
    const messages = compactCreateMessages(createMessages);
    return {
      messages: messages.map((message) => ({ role: message.role, text: message.text })),
      draft: createDraft,
      researchSources,
      command: createDraft.command.trim()
    };
  }

  async function saveResearchPlanForDraft(key = "research-plan-save", draft = createDraft) {
    const rawCommand = draft.command.trim() || initialCreatePrompt;
    const visibleFlow = normalizeVisibleSteps(draft.visibleSteps);
    setBusyKey(key);
    try {
      const body = await fetchApiJson<{ plan?: ResearchPlan }>("/api/planner/research-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: rawCommand, title: draft.title, sources: researchSources, visibleFlow })
      }, "research_plan_failed");
      if (!body.plan) throw new Error("調査計画を作成できませんでした");
      setActiveResearchPlan(body.plan);
      setCreatePlanDirty(false);
      recordActionReceipt({
        tone: "ok",
        title: "計画を保存しました",
        detail: "開始前の計画だけを保存しました。履歴は作らず、完了確認にもなりません。",
        nextAction: "次は「見る」で画面確認、または「開始」で実行を作れます。",
        view: "Create",
        planId: body.plan.id
      });
      setNotice("開始前の計画だけを保存しました。履歴は作らず、完了確認にもなりません。");
      void refresh(false, { background: true, staleNotice: true });
      return body.plan;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "調査計画を保存できませんでした");
      return null;
    } finally {
      setBusyKey(null);
    }
  }

  async function saveCreatePlan() {
    const pendingInput = createInput.trim();
    if (!pendingInput) return saveResearchPlanForDraft();
    const draft = await sendCreateMessage(pendingInput);
    if (!draft) return null;
    return saveResearchPlanForDraft("research-plan-save", draft);
  }

  async function refreshCapabilityPlan(commandText: string) {
    const body = await fetchApiJson<CapabilityRouterSnapshot>("/api/capability-router/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: commandText })
    }, "capability_router_failed");
    setCapabilityPlan(body);
    return body;
  }

  async function refreshCreatePlanner(nextMessages: ChatMessage[], currentDraft: string): Promise<CreateDraft> {
    const requestBody = {
      messages: nextMessages.map((message) => ({ role: message.role, text: message.text })),
      currentDraft
    };
    const body = await fetchApiJson<{ ok?: boolean; plan?: CreatePlannerPlan }>("/api/create/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    }, "create_planner_failed");
    if (!body.plan) throw new Error("計画を作れませんでした");
    if (shouldQueueCreatePlannerJob(body.plan)) {
      try {
        const queued = await fetchApiJson<{ ok?: boolean; plan?: CreatePlannerPlan; job?: CreatePlannerJobReadback }>("/api/create/plan/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        }, "create_planner_job_enqueue_failed");
        if (queued.plan && queued.job) {
          return createDraftFromPlannerPlan({
            ...queued.plan,
            reply: `${queued.plan.reply}\n\nMac workerで詳しい計画を作っています。結果が戻ったらこの下書きを更新します。`,
            exactBlocker: "mac_worker_planner_waiting"
          }, queued.job);
        }
      } catch {
        return createDraftFromPlannerPlan(body.plan, {
          id: "",
          status: "blocked",
          exactBlocker: "create_planner_job_enqueue_failed"
        });
      }
    }
    return createDraftFromPlannerPlan(body.plan);
  }

  function createDraftFromPlannerPlan(plan: CreatePlannerPlan, job?: Partial<CreatePlannerJobReadback>): CreateDraft {
    return {
      command: plan.command,
      title: plan.title,
      reply: plan.reply,
      visibleSteps: normalizeVisibleSteps(plan.visibleSteps),
      backendChecks: Array.isArray(plan.backendChecks) ? plan.backendChecks : [],
      answered: Array.isArray(plan.answered) ? plan.answered : [],
      openQuestions: Array.isArray(plan.openQuestions) ? plan.openQuestions : [],
      nextAction: plan.nextAction ?? "",
      executionDecision: plan.executionDecision ?? "ask_more",
      confidence: plan.confidence ?? "medium",
      plannerSource: plan.source ?? "local_fallback",
      intent: plan.intent === "answer_question" ? "answer_question" as const : "plan_workflow" as const,
      plannerModel: plan.model ?? "",
      plannerBlocker: job?.exactBlocker ?? plan.exactBlocker ?? "",
      plannerJobId: job?.id,
      plannerJobStatus: job?.status
    };
  }

  function shouldQueueCreatePlannerJob(plan: CreatePlannerPlan) {
    if (plan.intent === "answer_question") return false;
    return plan.source === "local_fallback" && plan.exactBlocker === "openai_api_key_missing";
  }

  async function ensureResearchPlan(key: string) {
    const visibleFlow = normalizeVisibleSteps(createDraft.visibleSteps);
    const rawCommand = createDraft.command.trim() || command.trim() || initialCreatePrompt;
    if (
      activeResearchPlan
      && !createPlanDirty
      && activeResearchPlan.command.trim() === rawCommand
      && sameVisibleSteps(activeResearchPlan.visibleFlow, visibleFlow)
      && sameResearchSources(activeResearchPlan.sources, researchSources)
    ) {
      return activeResearchPlan;
    }
    return saveResearchPlanForDraft(key);
  }

  function updateVisibleSteps(steps: string[]) {
    const visibleSteps = normalizeVisibleSteps(steps);
    setCreateDraft((draft) => ({ ...draft, visibleSteps }));
    setActiveResearchPlan(null);
    setSourceCaptureResults({});
    setCreatePlanDirty(true);
  }

  function toggleResearchSource(key: ResearchSourceKey) {
    setResearchSources((current) => ({ ...current, [key]: !current[key] }));
    setActiveResearchPlan(null);
    setSourceCaptureResults((current) => ({ ...current, [key]: undefined }));
    setCreatePlanDirty(true);
  }

  async function ensureStartedResearchPlan(key: string) {
    const plan = await ensureResearchPlan(key);
    if (!plan) return null;
    if (plan.status === "started" && plan.runId) return plan;
    const body = await fetchApiJson<Row>(`/api/planner/${encodeURIComponent(plan.id)}/start`, { method: "POST" }, "research_plan_start_failed");
    const startedPlan = body.plan as ResearchPlan | undefined;
    if (!startedPlan?.runId) throw new Error("調査計画を開始できませんでした");
    setActiveResearchPlan(startedPlan);
    if (body.runId) setSelectedRunId(body.runId);
    return startedPlan;
  }

  async function captureResearchSource(sourceKey: ResearchSourceKey, url: string) {
    if (!isVisibleCaptureSource(sourceKey)) {
      setNotice(`${researchSourceLabels[sourceKey]}はまだ実演接続していません`);
      return;
    }
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setNotice(`${researchSourceLabels[sourceKey]}のURLを入力してください`);
      return;
    }
    const key = `research-plan-capture-${sourceKey}`;
    setBusyKey(key);
    try {
      const plan = await ensureStartedResearchPlan(key);
      if (!plan) return;
      const endpoint = sourceKey === "youtube" ? "youtube-transcript" : "web-url";
      const body = await fetchApiJson<PlannerCaptureResponse>(`/api/planner/${encodeURIComponent(plan.id)}/capture/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmedUrl })
      }, `${sourceKey}_capture_failed`);
      if (body.plan) setActiveResearchPlan(body.plan);
      if (body.runId) setSelectedRunId(body.runId);
      setSourceCaptureResults((current) => ({ ...current, [sourceKey]: body }));
      const capture = body.capture ?? {};
      const blocker = capture.exactBlocker ? " 停止理由を内部記録に保存しました。" : "";
      const blockedNotice = sourceKey === "youtube"
        ? "YouTubeの台本を取得できませんでした。"
        : `${researchSourceLabels[sourceKey]}は${displayStatus(body.status)}です。`;
      recordActionReceipt({
        tone: body.ok ? "ok" : "blocked",
        title: body.ok ? `${researchSourceLabels[sourceKey]}の確認記録を保存しました` : `${researchSourceLabels[sourceKey]}の確認は停止しました`,
        detail: body.ok ? "確認結果を保存しました。" : `${blockedNotice}${blocker}`,
        nextAction: body.ok ? "保存記録を見てから、必要なら開始できます。" : "詳細で理由を確認し、別の確認元かURLを試してください。",
        view: body.runId ? "Runs" : "Create",
        runId: body.runId,
        planId: plan.id,
        checkId: extractResponseCheckId(body) ?? undefined
      });
      setNotice(body.ok ? `${researchSourceLabels[sourceKey]}の確認記録を保存しました。` : `${blockedNotice}${blocker}`);
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${researchSourceLabels[sourceKey]}の実演に失敗しました`);
    } finally {
      setBusyKey(null);
    }
  }

  async function demoResearchPlan() {
    const plan = await ensureResearchPlan("research-plan-demo");
    if (!plan) return;
    setBusyKey("research-plan-demo");
    try {
      const body = await fetchApiJson<{
        ok?: boolean;
        status?: string;
        exactBlocker?: string;
        plan?: ResearchPlan;
        systemCheck?: Row;
        externalOperation?: boolean;
      }>(`/api/planner/${encodeURIComponent(plan.id)}/demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUrl: "http://127.0.0.1:5173/#create" })
      }, "research_plan_demo_failed");
      if (body.plan) setActiveResearchPlan(body.plan);
      if (body.ok === false || body.status === "blocked") {
        recordActionReceipt({
          tone: "blocked",
          title: "実演確認は停止しました",
          detail: "詳細は診断に保存しました。",
          nextAction: "診断で理由を確認して、計画か確認元を直してください。",
          view: "Create",
          planId: plan.id,
          checkId: extractResponseCheckId(body) ?? undefined
        });
        setNotice("実演確認は停止しました。詳細は診断に保存しました。");
        void refresh(false, { background: true, staleNotice: true });
        return;
      }
      recordActionReceipt({
        tone: "ok",
        title: "実演確認を保存しました",
        detail: body.externalOperation === false
          ? "対象はローカル画面だけで、外部サイト操作は行っていません。"
          : "外部送信・公開・削除は行っていません。",
        nextAction: "問題なければ「開始」で実行を作れます。",
        view: "Create",
        planId: body.plan?.id ?? plan.id,
        checkId: extractResponseCheckId(body) ?? undefined
      });
      setNotice(
        body.externalOperation === false
          ? "実演確認を保存しました。対象はローカル画面だけで、外部サイト操作は行っていません。"
          : "実演確認を保存しました。外部送信・公開・削除は行っていません。"
      );
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "実演確認に失敗しました");
    } finally {
      setBusyKey(null);
    }
  }

  async function startResearchPlan() {
    const plan = await ensureResearchPlan("research-plan-start");
    if (!plan) return;
    setBusyKey("research-plan-start");
    try {
      const body = await fetchApiJson<Row>(`/api/planner/${encodeURIComponent(plan.id)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ createSession: currentCreateSessionPayload() })
      }, "research_plan_start_failed");
      if (body.plan) setActiveResearchPlan(body.plan as ResearchPlan);
      if (body.ok === false || body.status === "blocked" || typeof body.runId !== "string") {
        recordActionReceipt({
          tone: "blocked",
          title: "ローカル実行は作成されませんでした",
          detail: "詳細は診断に保存しました。",
          nextAction: "診断で理由を確認してから、計画を保存し直してください。",
          view: "Create",
          planId: extractResponsePlanId(body) ?? plan.id
        });
        setNotice("ローカル実行は作成されませんでした。詳細は診断に保存しました。");
        void refresh(false, { background: true, staleNotice: true });
        return;
      }
      if (body.runId) setSelectedRunId(body.runId);
      const status = body.run?.status ?? "queued";
      recordActionReceipt({
        tone: status === "blocked" ? "blocked" : "running",
        title: "ローカル実行を作成しました",
        detail: `${displayStatus(status)}。外部送信は行っていません。`,
        nextAction: status === "waiting_approval" ? "承認画面で内容を確認してください。" : "履歴で進行状況と保存記録を確認できます。",
        view: status === "waiting_approval" ? "Approvals" : "Runs",
        runId: body.runId,
        planId: extractResponsePlanId(body) ?? plan.id
      });
      setNotice(`ローカル実行を作成しました（${displayStatus(status)}）。外部送信は行っていません。開始前の計画は、完了記録とは別に扱います。`);
      setActiveView(status === "waiting_approval" ? "Approvals" : "Runs", false);
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "調査計画から開始できませんでした");
    } finally {
      setBusyKey(null);
    }
  }

  async function regularizeResearchPlan() {
    const plan = await ensureResearchPlan("research-plan-regularize");
    if (!plan) return;
    setBusyKey("research-plan-regularize");
    try {
      const body = await fetchApiJson<{ plan?: ResearchPlan; workflow?: Row }>(
        `/api/planner/${encodeURIComponent(plan.id)}/regularize`,
        { method: "POST" },
        "research_plan_regularize_failed"
      );
      if (body.plan) setActiveResearchPlan(body.plan);
      const schedule = asJson<Row>(body.workflow?.schedule_json, {});
      recordActionReceipt({
        tone: "ok",
        title: "定期実行に登録しました",
        detail: String(schedule.label ?? "毎日 09:00"),
        nextAction: "定期画面と履歴で次回の実行を確認できます。",
        view: "Schedule",
        planId: body.plan?.id ?? plan.id,
        workflowId: extractResponseWorkflowId(body) ?? undefined
      });
      setNotice(`定期実行に登録しました（${String(schedule.label ?? "毎日 09:00")}）。あとで見る履歴と確認記録で確認できます。`);
      void refresh(false, { background: true, staleNotice: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "定期実行に登録できませんでした");
    } finally {
      setBusyKey(null);
    }
  }

  function resetCreateComposer() {
    clearCreateDraftSession();
    setCreateInput("");
    setCreateMessages(initialCreateMessages);
    setCreateDraft(automationAdvice(initialCreatePrompt, dashboard.secrets));
    setCapabilityPlan(null);
    setResearchSources(initialResearchSources);
    setActiveResearchPlan(null);
    setCreatePlanDirty(false);
    setCommand("");
    recordActionReceipt({
      tone: "info",
      title: "新しい相談を開始しました",
      detail: "前の下書きはこのブラウザから消しました。",
      nextAction: "やりたいことを入力すると、計画を作り直します。",
      view: "Create"
    });
    setNotice("新しい相談を開始しました");
  }

  async function sendCreateMessage(value = createInput) {
    const text = value.trim();
    if (!text) return null;
    const optimisticText = locallyRedactSecrets(text);
    setBusyKey("secret-save");
    setCreateInput("");
    let displayText = optimisticText;
    let storedSecrets: SecretSummary[] = [];
    try {
      const result = await saveAndSanitizeMessage(text, optimisticText);
      displayText = result.sanitizedText;
      storedSecrets = result.storedSecrets;
    } catch {
      displayText = optimisticText;
    }
    const mergedSecrets = storedSecrets.length
      ? [...storedSecrets, ...dashboard.secrets.filter((secret) => !storedSecrets.some((stored) => stored.id === secret.id))]
      : dashboard.secrets;
    const secretOnlyMessage = isSecretStorageOnlyMessage(displayText, storedSecrets);
    const nextUserMessage: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: displayText };
    const historyForPlanner = [...createMessages, nextUserMessage];
    let advice = secretOnlyMessage ? savedSecretAdvice() : automationAdvice(displayText, mergedSecrets, createMessages);
    if (!secretOnlyMessage) {
      try {
        advice = await refreshCreatePlanner(historyForPlanner, createDraft.command);
      } catch {
        advice = automationAdvice(displayText, mergedSecrets, createMessages);
      }
    }
    let nextCapabilityPlan: CapabilityRouterSnapshot | null = null;
    if (!secretOnlyMessage) {
      try {
        nextCapabilityPlan = await refreshCapabilityPlan(displayText);
      } catch {
        nextCapabilityPlan = null;
      }
    }
    setCreateDraft(advice);
    setActiveResearchPlan(null);
    setCreatePlanDirty(false);
    if (storedSecrets.length) setCommand(resolveCreateMessageCommand(displayText, storedSecrets, ""));
    const routeNote = nextCapabilityPlan?.recommendedRoutes?.length
      ? ` 使えそうな道具: ${nextCapabilityPlan.recommendedRoutes.slice(0, 3).map((route) => route.label).join("、")}`
      : "";
    const plannerNote = advice.intent === "answer_question"
      ? ""
      : advice.plannerSource === "local_fallback"
      ? `\n\n確認状態\n・planner: 簡易計画${advice.plannerBlocker ? `（${displayCreatePlanText(advice.plannerBlocker)}）` : ""}\n・次に保存/実演/開始で実データを読んで確認します。`
      : advice.plannerSource
        ? `\n\n確認状態\n・planner: ${advice.plannerSource === "openai" ? "AI計画" : "ローカル計画"}${advice.plannerModel ? `（${advice.plannerModel}）` : ""}${routeNote ? `\n・${routeNote.trim()}` : ""}`
        : "";
    const routeGapNote = !nextCapabilityPlan?.recommendedRoutes?.length && nextCapabilityPlan?.gapBacklog?.length
      ? `\n・未接続: ${nextCapabilityPlan.gapBacklog.slice(0, 2).map((gap) => gap.label).join("、")}`
      : "";
    const reply = `${advice.reply}${plannerNote}${routeGapNote}`;
    const now = Date.now();
    setCreateMessages((messages) => compactCreateMessages([
      ...messages,
      nextUserMessage,
      ...(storedSecrets.length
        ? [
            {
              id: `assistant-secret-${now}`,
              role: "assistant" as const,
              text: `${secretLabels(storedSecrets).join("、")}を保存しました。次回からは「前回このキーがあるので、これを使いますね」と確認して進めます。値は画面には出しません。`
            }
          ]
        : []),
      { id: `assistant-${now}`, role: "assistant", text: reply }
    ]));
    if (storedSecrets.length) refresh(false);
    setBusyKey((current) => current === "secret-save" ? null : current);
    return advice;
  }

  async function continueRunInCreate(run: Row) {
    const runId = String(run.id);
    const detail = selectedRunDetail?.run?.id === runId ? selectedRunDetail : null;
    const meta = asJson<Row>(run.metadata_json, {});
    const proofGate = meta.proof_gate ?? {};
    const prompt = buildRunContinuationPrompt(run, meta, {
      proofCount: detail?.proofs.length ?? dashboard.proofs.filter((proof) => proof.run_id === runId).length,
      stepCount: detail?.steps.length ?? dashboard.steps.filter((step) => step.run_id === runId).length,
      eventCount: detail?.workerEvents.length ?? dashboard.workerEvents.filter((event) => event.run_id === runId).length,
      missingLabels: missingProofLabels(proofGate)
    });
    const userMessage: ChatMessage = { id: `user-run-${Date.now()}`, role: "user", text: prompt };
    const historyForPlanner = [...createMessages, userMessage];
    setBusyKey("create-run-continuation");
    setCreateInput("");
    setActiveView("Create", false);
    try {
      const advice = await refreshCreatePlanner(historyForPlanner, createDraft.command);
      setCreateDraft(advice);
      setActiveResearchPlan(null);
      setCreatePlanDirty(false);
      const now = Date.now();
      setCreateMessages((messages) => compactCreateMessages([
        ...messages,
        userMessage,
        { id: `assistant-run-${now}`, role: "assistant", text: advice.reply }
      ]));
      recordActionReceipt({
        tone: "info",
        title: "実行結果を読み込んで計画を更新しました",
        detail: `${displayTaskName(run.name)} の結論、不足、次の一手を作る画面へ反映しました。`,
        nextAction: advice.nextAction || "作る画面で次の手順を確認してください。",
        view: "Create",
        runId
      });
      setNotice("実行結果を作る画面に読み込み、次の一手を更新しました。");
      try {
        const nextCapabilityPlan = await refreshCapabilityPlan(advice.command);
        setCapabilityPlan(nextCapabilityPlan);
      } catch {
        setCapabilityPlan(null);
      }
    } catch {
      setCreateInput(prompt);
      recordActionReceipt({
        tone: "info",
        title: "作るで続き相談を始めます",
        detail: `${displayTaskName(run.name)} の続きを相談欄に用意しました。`,
        nextAction: "作る画面で送信して、次の手順を整理してください。",
        view: "Create",
        runId
      });
      setNotice("続き相談を入力欄に用意しました。送信すると計画を更新します。");
    } finally {
      setBusyKey((current) => current === "create-run-continuation" ? null : current);
    }
  }

  function handleCapabilityGapAction(gap: CapabilityGap) {
    const action = gap.action;
    if (!action) return;
    setActiveView(action.view, false);
    if (action.kind === "create" && action.command) {
      void sendCreateMessage(action.command);
    }
  }

  function handleNextAction(action: Row) {
    const view = String(action.view ?? "Dashboard") as View;
    setActiveView(view, false);
    if (view === "Create" && typeof action.command === "string" && action.command.trim()) {
      void sendCreateMessage(action.command);
    }
  }

  useEffect(() => {
    if (!busyKey) refresh(false);
    const timer = window.setInterval(() => {
      if (busyKey) return;
      fetchApiJson<unknown>("/api/dashboard", undefined, "dashboard_failed")
        .then((body) => {
          if (isDashboard(body)) {
            setDashboard(body);
            setSelectedRunId((current) => resolveSelectedRunId(current, body.runs, body.actionableRuns ?? []));
          }
        })
        .catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [busyKey]);

  useEffect(() => {
    if (restoredCreateSession) return;
    let cancelled = false;
    let hydrationTimer: number | undefined;
    readServerCreateDraftSession()
      .then((session) => {
        if (cancelled) return;
        if (session) {
          setCreateMessages(session.messages);
          setCreateDraft(session.draft);
          setResearchSources(session.researchSources);
          setCommand(session.command);
          setCreatePlanDirty(false);
          hydrationTimer = window.setTimeout(() => {
            if (!cancelled) setServerCreateSessionChecked(true);
          }, 0);
          return;
        }
        setServerCreateSessionChecked(true);
      }).catch(() => {
        if (!cancelled) setServerCreateSessionChecked(true);
      });
    return () => {
      cancelled = true;
      if (hydrationTimer !== undefined) window.clearTimeout(hydrationTimer);
    };
  }, [restoredCreateSession]);

  useEffect(() => {
    function syncViewFromHash() {
      const view = hashViews[window.location.hash] ?? "Dashboard";
      const viewChanged = activeView !== view;
      setActiveViewState(view);
      clearTransientViewFeedback(viewChanged);
    }
    window.addEventListener("hashchange", syncViewFromHash);
    window.addEventListener("popstate", syncViewFromHash);
    return () => {
      window.removeEventListener("hashchange", syncViewFromHash);
      window.removeEventListener("popstate", syncViewFromHash);
    };
  }, [activeView, notice, actionReceipt]);

  useEffect(() => {
    const session = {
      version: 1,
      messages: compactCreateMessages(createMessages),
      draft: createDraft,
      researchSources,
      command
    } satisfies CreateDraftSession;
    writeCreateDraftSession(session);
    if (serverCreateSessionChecked) writeServerCreateDraftSession(session);
  }, [command, createDraft, createMessages, researchSources, serverCreateSessionChecked]);

  useEffect(() => {
    const jobId = createDraft.plannerJobId;
    if (!jobId || createDraft.plannerJobStatus === "completed" || createDraft.plannerJobStatus === "blocked") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const body = await fetchApiJson<{ ok?: boolean; job?: CreatePlannerJobReadback; plan?: CreatePlannerPlan }>(
          `/api/create/plan/jobs/${encodeURIComponent(jobId)}`,
          undefined,
          "create_planner_job_readback_failed"
        );
        if (cancelled || !body.job) return;
        if (body.job.status === "completed" && (body.job.result ?? body.plan)) {
          const result = body.job.result ?? body.plan as CreatePlannerPlan;
          const nextDraft = createDraftFromPlannerPlan(result, body.job);
          setCreateDraft(nextDraft);
          setCreatePlanDirty(false);
          setCreateMessages((messages) => compactCreateMessages([
            ...messages,
            {
              id: `assistant-planner-job-${body.job?.id}-${Date.now()}`,
              role: "assistant",
              text: `${nextDraft.reply}\n\n確認状態\n・planner: Mac worker（Codex）\n・job: 完了`
            }
          ]));
          return;
        }
        if (body.job.status === "blocked") {
          setCreateDraft((draft) => ({
            ...draft,
            plannerJobStatus: "blocked",
            plannerBlocker: body.job?.exactBlocker ?? "mac_worker_planner_blocked"
          }));
          return;
        }
        setCreateDraft((draft) => ({
          ...draft,
          plannerJobStatus: body.job?.status ?? draft.plannerJobStatus,
          plannerBlocker: body.job?.status === "running" ? "mac_worker_planner_running" : "mac_worker_planner_waiting"
        }));
      } catch {
        if (!cancelled) {
          setCreateDraft((draft) => ({ ...draft, plannerBlocker: "create_planner_job_readback_failed" }));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [createDraft.plannerJobId, createDraft.plannerJobStatus]);

  useEffect(() => {
    if (activeView !== "Runs") setSelectedProof(null);
  }, [activeView]);

  useEffect(() => {
    if (!selectedProof) {
      setSelectedProofView(null);
      setProofViewLoading(false);
      return;
    }
    const viewerUrl = typeof selectedProof.viewer_url === "string"
      ? selectedProof.viewer_url
      : selectedProof.id
        ? `/api/proofs/${encodeURIComponent(String(selectedProof.id))}/view`
        : "";
    if (!viewerUrl) {
      setSelectedProofView({ status: "blocked", blocked_reason: "viewer_unavailable" });
      return;
    }
    let cancelled = false;
    setProofViewLoading(true);
    setSelectedProofView(null);
    fetchApiJson<ProofView>(viewerUrl, undefined, "proof_view_failed")
      .then((body) => {
        if (!cancelled) setSelectedProofView(body);
      })
      .catch(() => {
        if (!cancelled) setSelectedProofView({ status: "blocked", blocked_reason: "preview_unavailable" });
      })
      .finally(() => {
        if (!cancelled) setProofViewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProof]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      return;
    }
    let cancelled = false;
    setSelectedRunDetail(null);
    fetchApiJson<unknown>(`/api/runs/${encodeURIComponent(selectedRunId)}`, undefined, "run_detail_failed")
      .then((body) => {
        if (!isRunDetail(body)) throw new Error(userError("run_detail_failed"));
        if (!cancelled) setSelectedRunDetail(body);
      })
      .catch(() => {
        if (!cancelled) setSelectedRunDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const status = useMemo(() => {
    const pending = dashboard.approvals.filter((approval) => approval.status === "pending").length;
    const partial = dashboard.runs.filter((run) => run.status === "partial").length;
    return { pending, partial };
  }, [dashboard]);

  const dashboardActionableRuns = dashboard.actionableRuns ?? [];
  const dashboardSelectedRun = selectedRunId
    ? dashboard.runs.find((run) => run.id === selectedRunId)
    : dashboardActionableRuns[0];
  const selectedRunDetailRun = selectedRunDetail?.run?.id === selectedRunId ? selectedRunDetail.run : undefined;
  const selectedRun = newerRunSnapshot(selectedRunDetailRun, dashboardSelectedRun);
  const currentRun = selectedRun;
  const currentRunMeta = asJson<Row>(currentRun?.metadata_json, {});
  const detailForCurrentRun = selectedRunDetail?.run?.id === currentRun?.id ? selectedRunDetail : null;
  const runSteps = detailForCurrentRun ? detailForCurrentRun.steps : currentRun ? dashboard.steps.filter((step) => step.run_id === currentRun.id) : [];
  const runProofs = detailForCurrentRun ? detailForCurrentRun.proofs : currentRun ? dashboard.proofs.filter((proof) => proof.run_id === currentRun.id) : [];
  const runChildren = detailForCurrentRun
    ? detailForCurrentRun.children
    : currentRun
      ? dashboard.childRuns.filter((child) => child.parent_run_id === currentRun.id)
      : [];
  const runEvents = detailForCurrentRun
    ? detailForCurrentRun.workerEvents
    : currentRun
      ? dashboard.workerEvents.filter((event) => event.run_id === currentRun.id)
      : [];

  function clearTransientViewFeedback(viewChanged: boolean) {
    if (!viewChanged) return;
    const noticeToClear = notice;
    const receiptIdToClear = actionReceipt?.id ?? "";
    if (noticeToClear && !isErrorNotice(noticeToClear)) {
      setNotice((current) => current === noticeToClear ? "" : current);
    }
    if (receiptIdToClear) {
      setActionReceipt((current) => (
        current?.id === receiptIdToClear
          && (current.tone === "ok" || current.tone === "info")
          && !current.runId
          ? null
          : current
      ));
    }
  }

  function setActiveView(view: View, resetNotice = false) {
    const viewChanged = activeView !== view;
    if (viewChanged) closeQuickActionMenu();
    setActiveViewState(view);
    if (resetNotice) {
      setNotice("最新の状態に更新しました");
    } else {
      clearTransientViewFeedback(viewChanged);
    }
    if (typeof window !== "undefined" && window.location.hash !== viewHashes[view]) {
      window.history.pushState(null, "", viewHashes[view]);
    }
  }

  const drawerProof = activeView === "Runs" ? selectedProof : null;
  const drawerSkill = activeView === "Skills" ? selectedSkill : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand" aria-label="Automation OS">
          <div className="brand-mark" title="Automation OS">A</div>
        </div>
        <div className={loading ? "online muted" : "online"} title={loading ? "同期中" : "OK"} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span className="sr-only">{loading ? "同期中" : "OK"}</span>
        </div>
        <nav className="primary-nav">
          {primaryNav.map(([label, text, Icon]) => (
            <button
              className={label === activeView ? "nav-item active" : "nav-item"}
              key={label}
              title={text}
              aria-label={text}
              aria-current={label === activeView ? "page" : undefined}
              disabled={label === "Create" && busyKey === "secret-save"}
              onClick={() => {
                setActiveView(label);
              }}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="nav-item-label">{text}</span>
            </button>
          ))}
        </nav>
        <details className="advanced-nav">
          <summary title="診断" aria-label="診断">
            <Database size={16} />
            <span className="sr-only">診断</span>
          </summary>
          <nav>
            {advancedNav.map(([label, text, Icon]) => (
              <button className={label === activeView ? "nav-item active" : "nav-item"} key={label} onClick={() => setActiveView(label)}>
                <Icon size={17} />
                <span>{text}</span>
              </button>
            ))}
          </nav>
        </details>
        <div className="system-card">
          <Metric label="承認待ち" value={String(status.pending)} warn={status.pending > 0} />
          <Metric label="確認が必要" value={String(status.partial)} warn={status.partial > 0} />
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="command-area">
            <div className="command">
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="すぐ開始する短い指示" aria-label="すぐ開始する短い指示" />
              <button title="実行" onClick={startCommand} disabled={busyKey === "start" || busyKey === "secret-save"}>
                {busyKey === "start" ? <Loader2 size={18} className="spin" /> : <Play size={18} />}
              </button>
            </div>
          </div>
          <div className="quick-actions">
            <button className="icon-action" onClick={() => refresh()} disabled={loading} title="更新" aria-label="更新"><RefreshCcw size={16} /></button>
            <details className="advanced-actions icon-only-details" ref={quickActionsDetailsRef}>
              <summary title="診断" aria-label="診断">
                <Database size={16} />
                <span className="sr-only">診断</span>
              </summary>
              <div>
                <button onClick={() => post("/api/runs/demo-daily-ai", "デモを作成しました", { view: "Dashboard", key: "demo" })} disabled={busyKey === "demo"}><FileCheck size={16} /> デモ</button>
                <button onClick={() => post("/api/import/codex-assets", "データを取り込みました", { view: "Sources", key: "import" })} disabled={busyKey === "import"}><Archive size={16} /> 取り込み</button>
                <button onClick={() => post("/api/advisor/research-ingest", "調査メモを取り込みました", { view: "Sources", key: "research" })} disabled={busyKey === "research"}><Bot size={16} /> 調査</button>
                <button onClick={() => post("/api/bridge/actions/obsidian_export/run", "Obsidianを更新しました", { view: "Sources", key: "obsidian" })} disabled={busyKey === "obsidian"}><FileText size={16} /> Obsidian</button>
                <button onClick={() => post("/api/bridge/actions/codex_inventory/run", "Codex機能を確認しました", { view: "Sources", key: "capabilities" })} disabled={busyKey === "capabilities"}><Sparkles size={16} /> 機能確認</button>
                <button onClick={() => post("/api/browser/health", "ブラウザ検証の状態を確認しました", { view: "Sources", key: "browser-health" })} disabled={busyKey === "browser-health"}><Eye size={16} /> ブラウザ</button>
                <button onClick={() => post("/api/bridge/actions/local_browser_check/run", "画面を開いて確認しました", { view: "Sources", key: "browser-check" })} disabled={busyKey === "browser-check"}><Eye size={16} /> 開いて確認</button>
                <button onClick={() => post("/api/bridge/actions/browser_use_local_check/run", "Playwrightで確認しました", { view: "Sources", key: "browser-use-check" })} disabled={busyKey === "browser-use-check"}><Eye size={16} /> Playwright</button>
                <button onClick={() => post("/api/knowledge/refresh", "知識メモを更新しました", { view: "Sources", key: "knowledge" })} disabled={busyKey === "knowledge"}><Database size={16} /> 知識更新</button>
              </div>
            </details>
          </div>
        </header>

        {(loading || notice) && (
          <div className={isErrorNotice(notice) ? "notice error" : "notice"}>
            {loading ? "同期しています..." : notice}
          </div>
        )}
        {actionReceipt && (
          <ActionReceiptBanner
            receipt={actionReceipt}
            onView={(view) => setActiveView(view)}
            onSelectRun={(runId) => {
              setSelectedRunId(runId);
              setActiveView("Runs");
            }}
            onDismiss={() => setActionReceipt(null)}
          />
        )}

        {activeView === "Dashboard" && (
          <DashboardView
            dashboard={dashboard}
            currentRun={currentRun}
            currentRunMeta={currentRunMeta}
            runSteps={runSteps}
            runProofs={runProofs}
            runEvents={runEvents}
            onView={setActiveView}
            onNextAction={handleNextAction}
            onSelectRun={(run) => {
              setSelectedRunId(run.id);
              setActiveView("Runs");
            }}
            onSelectProof={setSelectedProof}
            onStartNisenPrints={(quickStart) => startRun(quickStart.command, quickStart.key)}
            onRefreshObsidian={() => post("/api/bridge/actions/obsidian_export/run", "Obsidianを更新しました", { view: "Sources", key: "bridge-obsidian_export" })}
            busyKey={busyKey}
          />
        )}

        {activeView === "Create" && (
          <CreateView
            messages={createMessages}
            input={createInput}
            draft={createDraft}
            researchSources={researchSources}
            researchPlan={createResearchPlan}
            sourceCaptureResults={sourceCaptureResults}
            capabilityPlan={capabilityPlan ?? dashboard.capabilityRouter ?? emptyDashboard.capabilityRouter}
            busyKey={busyKey}
            onInput={setCreateInput}
            onSend={sendCreateMessage}
            onSuggestion={sendCreateMessage}
            onSourceToggle={toggleResearchSource}
            onVisibleStepsChange={updateVisibleSteps}
            onSavePlan={saveCreatePlan}
            onDemoPlan={demoResearchPlan}
            onCaptureSource={captureResearchSource}
            onStart={startResearchPlan}
            onRegularize={regularizeResearchPlan}
            onReset={resetCreateComposer}
            secrets={dashboard.secrets}
          />
        )}

        {activeView === "Runs" && (
          <RunsView
            runs={dashboard.runs}
            actionableRuns={dashboardActionableRuns}
            selectedRun={currentRun}
            steps={runSteps}
            proofs={runProofs}
            children={runChildren}
            events={runEvents}
            localWorker={dashboard.localWorker ?? {}}
            onSelectRun={setSelectedRunId}
            onSelectProof={setSelectedProof}
            onRefreshRun={(run) => {
              setSelectedRunId(String(run.id));
              setNotice("履歴を更新しています。");
              recordActionReceipt({
                tone: "info",
                title: "履歴を更新しています",
                detail: `${displayTaskName(run.name)} の最新状態を読み直します。`,
                nextAction: "更新後に結論、理由、保存記録を確認してください。",
                view: "Runs",
                runId: String(run.id)
              });
              void refresh(false, { background: true, staleNotice: true });
            }}
            onOpenApprovals={() => {
              setActiveView("Approvals", false);
              recordActionReceipt({
                tone: "info",
                title: "承認画面を開きました",
                detail: "確認が必要な内容を一覧で見られます。",
                nextAction: "内容を確認して、進めるか止めるかを選んでください。",
                view: "Approvals"
              });
            }}
            onContinueInCreate={(run) => {
              void continueRunInCreate(run);
            }}
          />
        )}

        {activeView === "Schedule" && (
          <ScheduleView
            registeredWorkflows={dashboard.registeredWorkflows}
            schedulerStatus={dashboard.schedulerStatus ?? {}}
            onSchedulerRunOnce={runSchedulerOnce}
            onOpenRun={(id) => {
              setSelectedRunId(id);
              setActiveView("Runs", false);
              setNotice("履歴を開きました。保存記録と次の一手を確認できます。");
              recordActionReceipt({
                tone: "info",
                title: "履歴を開きました",
                detail: "定期の行から前回の実行を開きました。",
                nextAction: "詳細で結論、理由、保存記録を確認してください。",
                view: "Runs",
                runId: id
              });
            }}
            onRegisteredStart={(id) => post(`/api/registered-workflows/${encodeURIComponent(id)}/start`, "キューに入れました", { view: "Runs", key: `registered-${id}` })}
            onRegisteredToggle={(workflow) => {
              const paused = isPausedRegisteredWorkflow(workflow);
              return post(`/api/registered-workflows/${encodeURIComponent(String(workflow.id))}/${paused ? "resume" : "pause"}`, paused ? "再開しました" : "停止しました", { key: `registered-toggle-${workflow.id}` });
            }}
            onRegisteredSchedule={updateRegisteredSchedule}
            busyKey={busyKey}
            productionGuard={dashboard.productionGuard ?? {}}
            operatorWriteTokenReady={operatorWriteTokenReady}
            onSaveOperatorWriteToken={saveOperatorWriteToken}
            onClearOperatorWriteToken={clearOperatorWriteToken}
          />
        )}

        {activeView === "Approvals" && (
          <ApprovalsView approvals={dashboard.approvalInbox ?? dashboard.approvals} onDecision={post} busyKey={busyKey} />
        )}

        {activeView === "Lanes" && <LanesView lanes={dashboard.lanes} />}

        {activeView === "Sources" && (
          <SourcesView
            summary={dashboard.assetSummary}
            assets={dashboard.assets}
            events={dashboard.advisorEvents}
            checks={dashboard.systemChecks}
            bridgeCatalog={dashboard.bridgeActionCatalog}
            bridgeActions={dashboard.bridgeActions}
            bridgeExecutions={dashboard.bridgeExecutions}
            knowledgeNotes={dashboard.knowledgeNotes}
            researchPlans={dashboard.researchPlans}
            obsidian={dashboard.obsidian ?? {}}
            codexCapabilities={dashboard.codexCapabilities ?? {}}
            codexParityLedger={dashboard.codexParityLedger ?? { items: [] }}
            codexAutomationMigrationLedger={dashboard.codexAutomationMigrationLedger ?? { items: [], summary: {} }}
            capabilityRouter={dashboard.capabilityRouter ?? emptyDashboard.capabilityRouter}
            browserHealth={dashboard.browserHealth ?? {}}
            localWorker={dashboard.localWorker ?? {}}
            onImport={() => post("/api/import/codex-assets", "読み込んだ情報を更新しました", { view: "Sources", key: "import" })}
            onBridgeAction={(id) => post(`/api/bridge/actions/${id}/run`, "安全操作を受け付けました", { view: "Sources", key: `bridge-${id}` })}
            onGapAction={handleCapabilityGapAction}
            busyKey={busyKey}
          />
        )}

        {activeView === "Skills" && (
          <SkillsView
            runs={dashboard.runs}
            skills={dashboard.skills}
            selectedSkill={selectedSkill ?? dashboard.skills[0]}
            onSelectSkill={setSelectedSkill}
            onCreate={post}
            busyKey={busyKey}
          />
        )}

        {(drawerProof || drawerSkill) && (
          <DetailDrawer
            proof={drawerProof}
            proofView={selectedProofView}
            proofViewLoading={proofViewLoading}
            skill={drawerSkill}
            onClose={() => {
              setSelectedProof(null);
              setSelectedProofView(null);
              setSelectedSkill(null);
            }}
          />
        )}
      </main>
    </div>
  );
}

function ActionReceiptBanner({
  receipt,
  onView,
  onSelectRun,
  onDismiss
}: {
  receipt: ActionReceipt;
  onView: (view: View) => void;
  onSelectRun: (runId: string) => void;
  onDismiss: () => void;
}) {
  const icon = receipt.tone === "blocked"
    ? <AlertTriangle size={16} />
    : receipt.tone === "running"
      ? <Play size={16} />
      : receipt.tone === "ok"
        ? <Check size={16} />
        : <FileCheck size={16} />;
  const chips = [
    receipt.runId ? `履歴 ${compactId(receipt.runId)}` : "",
    receipt.planId ? `計画 ${compactId(receipt.planId)}` : "",
    receipt.checkId ? `確認 ${compactId(receipt.checkId)}` : "",
    receipt.workflowId ? `定期 ${compactId(receipt.workflowId)}` : ""
  ].filter(Boolean);
  return (
    <section className={`action-receipt ${receipt.tone}`} aria-label="直前の操作記録">
      <div className="action-receipt-main">
        <span className="action-receipt-icon" aria-hidden="true">{icon}</span>
        <div>
          <strong>{receipt.title}</strong>
          <small>{receipt.detail}</small>
          <small>{receipt.nextAction}</small>
        </div>
      </div>
      {chips.length > 0 && (
        <div className="action-receipt-chips">
          {chips.map((chip) => <span key={chip}>{chip}</span>)}
        </div>
      )}
      <div className="action-receipt-actions">
        {receipt.runId && (
          <button type="button" onClick={() => onSelectRun(receipt.runId ?? "")}>
            履歴を見る
          </button>
        )}
        {receipt.view && !receipt.runId && (
          <button type="button" onClick={() => onView(receipt.view ?? "Dashboard")}>
            開く
          </button>
        )}
      </div>
      <button type="button" className="action-receipt-dismiss" onClick={onDismiss} aria-label="直前の操作記録を閉じる" title="閉じる">
        <X size={14} aria-hidden="true" />
      </button>
    </section>
  );
}

function DashboardView(props: {
  dashboard: Dashboard;
  currentRun?: Row;
  currentRunMeta: Row;
  runSteps: Row[];
  runProofs: Row[];
  runEvents: Row[];
  onView: (view: View) => void;
  onNextAction: (action: Row) => void;
  onSelectRun: (run: Row) => void;
  onSelectProof: (proof: Row) => void;
  onStartNisenPrints: (quickStart: (typeof nisenPrintsQuickStarts)[number]) => void;
  onRefreshObsidian: () => Promise<void>;
  busyKey: string | null;
}) {
  const hasCurrentRun = Boolean(props.currentRun);
  const scheduled = props.dashboard.registeredWorkflows ?? [];
  return (
    <>
      <section className={`grid dashboard-main-grid ${hasCurrentRun ? "" : "dashboard-main-grid--idle"}`}>
        <Panel title="今" action="" actionLabel="履歴" onAction={() => props.onView("Runs")}>
          <RunSummary
            run={props.currentRun}
            meta={props.currentRunMeta}
            localWorker={props.dashboard.localWorker ?? {}}
            emptyText="なし"
            onOpen={() => props.currentRun && props.onSelectRun(props.currentRun)}
          />
        </Panel>
        <Panel title="定期" action="" actionLabel="定期" onAction={() => props.onView("Schedule")}>
          <MiniSchedule workflows={scheduled} />
        </Panel>
        <Panel title="確認" action="" actionLabel="確認" onAction={() => props.onView("Approvals")}>
          <ApprovalQueue approvals={(props.dashboard.approvalInbox ?? props.dashboard.approvals).slice(0, 5)} />
        </Panel>
        <Panel title="Mac worker" action="" actionLabel="診断" onAction={() => props.onView("Sources")}>
          <LocalWorkerStatus worker={props.dashboard.localWorker ?? {}} />
        </Panel>
        <Panel title="本番" action="" actionLabel="診断" onAction={() => props.onView("Sources")}>
          <DeploymentReadbackStatus deployment={props.dashboard.deployment ?? {}} />
        </Panel>
        {hasCurrentRun && (
          <Panel title="流れ" action="" actionLabel="履歴" onAction={() => props.onView("Runs")}>
            <Timeline
              steps={props.runSteps}
              emptyText="なし"
            />
          </Panel>
        )}
      </section>

      <details className="dashboard-more">
        <summary title="操作" aria-label="操作">
          <Sparkles size={16} />
          <span className="sr-only">操作</span>
        </summary>
        <NextActionsPanel actions={props.dashboard.nextActions} onAction={props.onNextAction} />
        <section className="quick-start-band compact">
          <div className="quick-start-head">
            <h2>NisenPrints</h2>
          </div>
          <div className="quick-start-grid">
            {nisenPrintsQuickStarts.map((quickStart) => (
              <article className="quick-start-card" key={quickStart.key}>
                <strong>{quickStart.beginnerLabel}</strong>
                <button
                  type="button"
                  className="quick-start-start"
                  onClick={() => props.onStartNisenPrints(quickStart)}
                  disabled={props.busyKey === quickStart.key}
                >
                  {props.busyKey === quickStart.key ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                  開始
                </button>
              </article>
            ))}
          </div>
        </section>
      </details>

      <details className="advanced-section">
        <summary title="診断" aria-label="診断">
          <Database size={16} />
          <span className="sr-only">診断</span>
        </summary>
        <ResumeContractCard contract={props.dashboard.resumeContract ?? {}} />
        <ObsidianSyncCard
          obsidian={props.dashboard.obsidian ?? {}}
          variant="compact"
          onOpenSources={() => props.onView("Sources")}
          onRefresh={props.onRefreshObsidian}
          busy={props.busyKey === "bridge-obsidian_export"}
        />
        <div className="advanced-grid">
          <button onClick={() => props.onView("Lanes")}>
            <Layers3 size={18} />
            <span>並列レーン</span>
            <strong>{props.dashboard.lanes.length}</strong>
          </button>
          <button onClick={() => props.onView("Runs")}>
            <FileCheck size={18} />
            <span>確認記録</span>
            <strong>{props.dashboard.proofs.length}</strong>
          </button>
          <button onClick={() => props.onView("Sources")}>
            <Bot size={18} />
            <span>調査メモ</span>
            <strong>{props.dashboard.advisorEvents.length}</strong>
          </button>
          <button onClick={() => props.onView("Runs")}>
            <Activity size={18} />
            <span>処理ログ</span>
            <strong>{props.dashboard.workerEvents.length}</strong>
          </button>
        </div>
      </details>
    </>
  );
}

function DeploymentReadbackStatus({ deployment }: { deployment: Row }) {
  const commit = String(deployment.commit ?? "");
  const commitLabel = commit ? commit.slice(0, 7) : "未確認";
  const commitSource = String(deployment.commitSource ?? "unknown");
  const plannerProvider = String(deployment.plannerProvider ?? "auto");
  const aiRuntime = asJson<Row>(deployment.aiRuntime, {});
  const openAiApiReady = Boolean(aiRuntime.openAiApiReady);
  const codexBinConfigured = Boolean(aiRuntime.codexBinConfigured);
  const codexPlannerSelected = Boolean(aiRuntime.codexPlannerSelected);
  const plannerExecutionMode = String(aiRuntime.plannerExecutionMode ?? "");
  const subscriptionPlannerReady = Boolean(aiRuntime.subscriptionPlannerReady);
  const plannerModeLabel = plannerExecutionMode === "hosted_openai_api"
    ? "API"
    : subscriptionPlannerReady
      ? "Mac worker"
      : codexPlannerSelected
        ? "Codex"
        : "未接続";
  const assets = asJson<Row>(deployment.assets, {});
  const jsAsset = String(assets.js ?? "");
  const cssAsset = String(assets.css ?? "");
  const assetsReady = Boolean(assets.indexFound && jsAsset && cssAsset);
  const assetLabel = assetsReady ? "配信中" : "未確認";
  return (
    <div className={`deployment-status deployment-status--${assetsReady ? "ready" : "unknown"}`}>
      <div className="deployment-main">
        <span>commit</span>
        <strong>{commitLabel}</strong>
      </div>
      <p>{assetsReady ? "本番のAPIと画面アセットを確認できます。" : "本番アセットはまだ確認できていません。"}</p>
      <small>取得元: {commitSource}</small>
      <small>planner: {plannerProvider}</small>
      <small>計画: {plannerModeLabel} / OpenAI API: {openAiApiReady ? "キー設定済み" : "使わない"} / Codex bin: {codexBinConfigured ? "明示設定" : "既定"}</small>
      <small>assets: {assetLabel}</small>
    </div>
  );
}

function LocalWorkerStatus({ worker }: { worker: Row }) {
  const status = String(worker.status ?? "missing");
  const label = String(worker.label ?? "未接続");
  const detail = String(worker.detail ?? "Mac workerはまだ確認できていません。");
  const nextAction = String(worker.nextAction ?? "Macで worker loop を起動してください。");
  const updatedAt = typeof worker.updatedAt === "string" ? worker.updatedAt.slice(5, 16).replace("T", " ") : "未確認";
  const processed = Number(worker.processed ?? 0);
  return (
    <div className={`local-worker-status local-worker-status--${status}`}>
      <div className="local-worker-main">
        <span>{label}</span>
        <strong>{processed}件</strong>
      </div>
      <p>{detail}</p>
      <small>{compactWorkerSetupGuidance(nextAction)}</small>
      <small>最終確認: {updatedAt}</small>
    </div>
  );
}

function MiniSchedule({ workflows }: { workflows: Row[] }) {
  const active = workflows.filter(isActiveRegisteredWorkflow);
  const paused = workflows.filter(isPausedRegisteredWorkflow);
  const needsCheck = active.filter((workflow) => Boolean(workflow.needs_check));
  const morningWorkflow = active.find(isMorningCheckWorkflow);
  const morningSummary = morningWorkflow ? displayMorningWorkflowSummary(morningWorkflow) : null;
  return (
    <div className="mini-schedule compact" aria-label={`予定 ${active.length}件、確認 ${needsCheck.length}件、停止 ${paused.length}件${morningSummary ? `、朝 ${morningSummary}` : ""}`}>
      <div title="予定">
        <strong>{active.length}</strong>
        <span>稼働中</span>
      </div>
      <div title="確認が必要">
        <strong>{needsCheck.length}</strong>
        <span>要確認</span>
      </div>
      {morningSummary && (
        <div className="mini-schedule-focus" title="朝チェック">
          <strong>{morningSummary}</strong>
          <span>朝チェック</span>
        </div>
      )}
      {active.length === 0 && <span className="sr-only">予定はありません</span>}
    </div>
  );
}

function ResumeContractCard({ contract }: { contract: Row }) {
  const readFirst = Array.isArray(contract.readFirst) ? contract.readFirst.slice(0, 3) : [];
  const projects = Array.isArray(contract.projects) ? contract.projects : [];
  return (
    <section className="resume-contract-band">
      <div className="resume-contract-copy">
        <div className="resume-contract-icon"><FileCheck size={18} /></div>
        <div>
          <h2>作業再開の準備</h2>
          <p>前回の続きがあるときは、必要な運用情報を裏側で確認してから進めます。</p>
        </div>
      </div>
      <details className="internal-details resume-contract-details icon-only-details">
        <summary title="診断" aria-label="診断">
          <Database size={16} />
          <span className="sr-only">診断</span>
        </summary>
        <small>対象プロジェクト: {projects.length}件</small>
        <small>最新の内部記録はバックエンドで確認します。</small>
        <div className="resume-contract-list">
          {readFirst.map((entry: Row) => (
            <span key={`${entry.kind}-${entry.label}`}>{String(entry.label ?? "read first")}</span>
          ))}
        </div>
      </details>
    </section>
  );
}

function NextActionsPanel({ actions, onAction }: { actions: Row[]; onAction: (action: Row) => void }) {
  const visible = actions.length
    ? actions
    : [
        {
          id: "ready",
          title: "準備できています",
          summary: "新規作成から相談するか、NisenPrintsの操作を選べます。",
          buttonLabel: "新規作成へ",
          view: "Create",
          severity: "normal"
        }
      ];
  return (
    <section className="next-actions-band">
      <div className="quick-start-head">
        <div>
          <h2>次にやること</h2>
          <span>今押せるものだけを表示しています。</span>
        </div>
      </div>
      <div className="next-action-list">
        {visible.map((action) => (
          <button className={`next-action-card ${action.severity === "attention" ? "attention" : ""}`} key={action.id} onClick={() => onAction(action)}>
            <div>
              <strong>{action.title}</strong>
              <p>{action.summary}</p>
            </div>
            <span>{action.buttonLabel}<ChevronRight size={15} /></span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ObsidianSyncCard({
  obsidian,
  variant,
  onRefresh,
  onOpenSources,
  busy,
  diagnostics = false
}: {
  obsidian: Row;
  variant: "compact" | "detail";
  onRefresh?: () => void;
  onOpenSources?: () => void;
  busy?: boolean;
  diagnostics?: boolean;
}) {
  const generatedFileCheck = asJson<Row>(obsidian.generatedFileCheck, obsidian.generatedFileCheck ?? {});
  const generatedFileCheckFailed = generatedFileCheck.checkedAt != null && generatedFileCheck.ok === false;
  const disabled = obsidian.enabled === false;
  const ok = obsidian.ok === true && !generatedFileCheckFailed;
  const failed = obsidian.ok === false || generatedFileCheckFailed;
  const statusText = disabled ? "自動同期OFF" : ok ? "同期済み" : failed ? "要確認" : "待機中";
  const statusClass = disabled ? "off" : ok ? "ok" : failed ? "failed" : "pending";
  const lastTime = displayShortDateTime(obsidian.lastSuccessAt ?? obsidian.lastAttemptAt);
  const reasonText = displayObsidianReason(typeof obsidian.reason === "string" ? obsidian.reason : undefined);
  const generatedFileCheckText = displayGeneratedFileCheck(generatedFileCheck);
  const publicGeneratedFileCheckText = displayGeneratedFileCheckPublic(generatedFileCheck);
  const compact = variant === "compact";
  const visibleCopy = failed
    ? `作業ノートの更新で確認が必要です。${obsidian.lastError ? "詳細で理由を確認できます。" : "もう一度更新できます。"}`
    : disabled
      ? "作業ノートの自動更新は停止中です。必要なときだけ手動で更新できます。"
      : ok
        ? compact ? `作業ノートは最新です。最終更新: ${lastTime}` : `作業ノートは最新です。最終同期: ${lastTime}`
        : "作業ノートはまだ更新待ちです。必要なら手動で更新できます。";
  const totalGenerated = Number(obsidian.files?.length ?? 0)
    + Number(obsidian.missionFiles?.length ?? 0)
    + Number(obsidian.secondBrainFiles?.length ?? 0)
    + Number(obsidian.dashboardFiles?.length ?? 0)
    + Number(obsidian.orientationFiles?.length ?? 0)
    + Number(obsidian.templateFiles?.length ?? 0);

  return (
    <article className={`obsidian-sync-card ${variant}`}>
      <div className="obsidian-sync-main">
        <div className={`obsidian-sync-icon ${statusClass}`}>
          {busy ? <Loader2 size={18} className="spin" /> : ok ? <Check size={18} /> : failed ? <AlertTriangle size={18} /> : <FileText size={18} />}
        </div>
        <div>
          <div className="obsidian-sync-title">
            <strong>作業ノート</strong>
            <span className={`pill ${failed ? "blocked" : ok ? "complete" : "pending"}`}>{statusText}</span>
          </div>
          <p>{visibleCopy}</p>
          {variant === "detail" && <small>{ok ? `${totalGenerated}件` : publicGeneratedFileCheckText}</small>}
        </div>
      </div>
      <div className="obsidian-sync-actions">
        {variant === "detail" && (
          <button className="text-button compact" onClick={onRefresh} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <RefreshCcw size={14} />}
            手動更新
          </button>
        )}
        {variant === "compact" && (
          <button className="text-button compact" onClick={onOpenSources}>
            詳細を見る
            <ChevronRight size={14} />
          </button>
        )}
      </div>
      {diagnostics && <details className="internal-details obsidian-sync-details">
        <summary>開発者向け診断</summary>
        <small>lastAttemptAt: {displayShortDateTime(obsidian.lastAttemptAt)}</small>
        <small>lastSuccessAt: {displayShortDateTime(obsidian.lastSuccessAt)}</small>
        <small>generatedFileCheck: {generatedFileCheckText}</small>
        <small>外部操作の完了判断には使いません。</small>
        <small>reason: {reasonText}</small>
        {obsidian.lastError && <small>lastError: {String(obsidian.lastError)}</small>}
        <small>generatedFileCheck.checkedAt: {displayShortDateTime(generatedFileCheck.checkedAt)}</small>
        <small>generatedFileCheck.ok: {String(generatedFileCheck.ok ?? "--")}</small>
        <small>generatedFileCheck.total: {String(generatedFileCheck.total ?? "--")}</small>
        <small>generatedFileCheck.missing: {String(generatedFileCheck.missing?.length ?? 0)}</small>
        <small>generatedFileCheck.nonGenerated: {String(generatedFileCheck.nonGenerated?.length ?? 0)}</small>
      </details>}
    </article>
  );
}

function researchPlannerStages(plan: ResearchPlan, captures: Partial<Record<ResearchSourceKey, PlannerCaptureResponse>>) {
  const enabled = plan.sources.filter((source) => source.enabled);
  const captureValues = Object.values(captures).filter(Boolean);
  const hasProof = captureValues.some((capture) => capture?.ok);
  const hasBlocker = captureValues.some((capture) => capture?.status === "blocked" || capture?.status === "rejected");
  const saved = plan.id !== "preview";
  const demoDone = Boolean(plan.demoCheckId);
  const started = plan.status === "started" || Boolean(plan.runId);
  return [
    { key: "consult", label: "相談", detail: plan.command ? "入力済み" : "未入力", state: plan.command ? "done" : "current" },
    { key: "save", label: "保存", detail: saved ? "実行なしで保存済み" : "まだ実行しない", state: saved ? "done" : "current" },
    { key: "demo", label: "実演", detail: demoDone ? "ローカル確認済み" : "外部送信なし", state: demoDone ? "done" : saved ? "current" : "pending" },
    { key: "sources", label: "ソース", detail: `${enabled.length}件ON`, state: enabled.length ? "done" : "pending" },
    { key: "proof", label: "確認記録", detail: hasProof ? "確認済み" : hasBlocker ? "確認が必要" : "記録だけでは未完了", state: hasProof ? "done" : hasBlocker ? "blocked" : "pending" },
    { key: "run", label: "一回実行", detail: started ? "開始済み" : "未開始", state: started ? "done" : "pending" }
  ];
}

function sourceProofState(source: ResearchSourcePlan, capture?: PlannerCaptureResponse): { label: string; tone: string } {
  if (!source.enabled) return { label: "OFF", tone: "idle" };
  if (capture?.ok) return { label: "確認済み", tone: "ok" };
  if (capture?.status === "blocked") return { label: "確認が必要", tone: "blocked" };
  if (capture?.status === "rejected") return { label: "確認が必要", tone: "failed" };
  if (source.key === "web" || source.key === "youtube") return { label: "未確認", tone: "partial" };
  return { label: "未接続", tone: "not_connected" };
}

function sourceNextConnection(source: ResearchSourcePlan): string {
  if (!source.enabled) return "必要ならONにする";
  if (source.key === "web") return "次: URLから確認記録を保存";
  if (source.key === "youtube") return "次: 公式の台本を確認";
  if (source.key === "x") return "次: 専用ブラウザで見るだけ確認";
  if (source.key === "reddit") return "次: 公開スレッドを確認";
  if (source.key === "mcp") return "次: 使える機能を一覧で確認";
  return "次: API契約と認可を確認";
}

function captureResultLines(capture?: PlannerCaptureResponse): string[] {
  if (!capture) return [];
  const result = capture.capture ?? {};
  const artifactPath = result.manifestFile ?? result.artifactDir ?? result.files?.manifest ?? capture.proof?.uri ?? result.ingest?.path;
  const savedInternally = Boolean(result.exactBlocker || artifactPath || capture.proof?.id);
  const youtubeBlocked = capture.status === "blocked" && result.exactBlocker && String(result.exactBlocker).startsWith("youtube_transcript_");
  return [
    `状態: ${displayStatus(capture.status)}`,
    savedInternally ? "内部記録に保存済み" : undefined,
    youtubeBlocked ? "次: 別の取得方法か動画候補の確認へ進めます" : undefined,
    result.summary ? displayBridgeReceiptSummary(String(result.summary)) : undefined
  ].filter((line): line is string => Boolean(line));
}

function isActiveRegisteredWorkflow(workflow: Row) {
  return String(workflow.status ?? "").toLowerCase() === "active";
}

function isPausedRegisteredWorkflow(workflow: Row) {
  return String(workflow.status ?? "").toLowerCase() === "paused";
}

function isManagedRegisteredWorkflow(workflow: Row) {
  return isActiveRegisteredWorkflow(workflow) || isPausedRegisteredWorkflow(workflow);
}

function displayWorkflowName(workflow: Row) {
  const explicit = workflow.public_name ?? workflow.beginnerLabel ?? workflow.beginner_label ?? workflow.label;
  if (typeof explicit === "string" && explicit.trim()) return displayVisibleSummary(explicit.trim());
  const name = `${String(workflow.id ?? "")} ${String(workflow.name ?? "")}`;
  const publicName = displayPublicAutomationName(name);
  if (publicName) return publicName;
  return "定期実行";
}

function isMorningCheckWorkflow(workflow: Row) {
  const id = String(workflow.id ?? "");
  const scheduleLabel = String(workflow.schedule_label ?? "");
  const publicText = [
    id,
    workflow.public_name,
    workflow.beginnerLabel,
    workflow.beginner_label,
    workflow.label,
    scheduleLabel
  ].map((value) => String(value ?? "")).join(" ");
  if (/daily-ai-research-publish-run|morning|朝|毎朝/i.test(publicText)) return true;
  return /^research-plan-/.test(id) && /\b09:00\b/.test(scheduleLabel);
}

function displayMorningWorkflowSummary(workflow: Row) {
  if (Boolean(workflow.needs_check)) return "確認";
  const label = displayWorkflowSchedule(workflow);
  return label.match(/\b\d{2}:\d{2}\b/)?.[0] ?? "確認";
}

function displayWorkflowSchedule(workflow: Row) {
  if (typeof workflow.schedule_label === "string" && workflow.schedule_label.trim()) return workflow.schedule_label;
  const schedule = asJson<Row>(workflow.schedule_json, {});
  if (typeof schedule.label === "string" && schedule.label.trim()) return schedule.label;
  const rrule = typeof schedule.rrule === "string" ? schedule.rrule : "";
  const hour = Number(rrule.match(/BYHOUR=(\d{1,2})/)?.[1] ?? NaN);
  const minute = Number(rrule.match(/BYMINUTE=(\d{1,2})/)?.[1] ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return "登録済み";
  }
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return /FREQ=WEEKLY/.test(rrule) && !/BYDAY=SU,MO,TU,WE,TH,FR,SA/.test(rrule) ? `毎週 ${time}` : `毎日 ${time}`;
}

function displayWorkflowScheduleShort(workflow: Row) {
  const label = displayWorkflowSchedule(workflow);
  return label.match(/\b\d{2}:\d{2}\b/)?.[0] ?? label;
}

function displayWorkflowCheckLabel(workflow: Row) {
  if (typeof workflow.check_label === "string" && workflow.check_label.trim()) return workflow.check_label.trim().slice(0, 4);
  if (Boolean(workflow.needs_check)) return "確認";
  return "OK";
}

function displayWorkflowTrustLabel(workflow: Row) {
  if (typeof workflow.trust_label === "string" && workflow.trust_label.trim()) return workflow.trust_label.trim().slice(0, 4);
  return "未確認";
}

function displayWorkflowFreshnessLabel(workflow: Row) {
  if (typeof workflow.freshness_label === "string" && workflow.freshness_label.trim()) return workflow.freshness_label.trim().slice(0, 2);
  return "未";
}

function displayWorkflowSafetyLabel(workflow: Row) {
  if (typeof workflow.safety_label === "string" && workflow.safety_label.trim()) return workflow.safety_label.trim().slice(0, 2);
  return "確認";
}

function displayWorkflowBoundaryLabel(workflow: Row) {
  if (typeof workflow.boundary_label === "string" && workflow.boundary_label.trim()) {
    return workflow.boundary_label.trim().replace(/前停止$/, "").slice(0, 4);
  }
  return "外部";
}

function displayWorkflowStateTitle(workflow: Row) {
  if (isPausedRegisteredWorkflow(workflow)) return "停止中";
  if (typeof workflow.check_label === "string" && workflow.check_label.trim()) return workflow.check_label.trim();
  if (Boolean(workflow.needs_check)) return "確認が必要";
  return "OK";
}

function displayWorkflowTrustTitle(workflow: Row) {
  return `信頼度: ${displayWorkflowTrustLabel(workflow)}`;
}

function displayWorkflowFreshnessTitle(workflow: Row) {
  return `鮮度: ${displayWorkflowFreshnessLabel(workflow)}`;
}

function displayWorkflowSafetyTitle(workflow: Row) {
  return `安全: ${displayWorkflowSafetyLabel(workflow)}`;
}

function displayWorkflowBoundaryTitle(workflow: Row) {
  if (typeof workflow.boundary_label === "string" && workflow.boundary_label.trim()) return workflow.boundary_label.trim();
  return "実行可・課金停止";
}

function displayWorkflowMetaSummary(workflow: Row) {
  const parts = [
    `信頼度: ${displayWorkflowTrustLabel(workflow)}`,
    `鮮度: ${displayWorkflowFreshnessLabel(workflow)}`,
    displayWorkflowBoundaryTitle(workflow).replace(/前停止$/, "")
  ];
  return parts.filter(Boolean).join(" / ");
}

function displayWorkflowLastActionSummary(workflow: Row) {
  const action = typeof workflow.last_action_label === "string" && workflow.last_action_label.trim()
    ? workflow.last_action_label.trim()
    : "まだ実行なし";
  const result = typeof workflow.last_result_label === "string" && workflow.last_result_label.trim()
    ? workflow.last_result_label.trim()
    : "待機中";
  const next = typeof workflow.next_action_label === "string" && workflow.next_action_label.trim()
    ? workflow.next_action_label.trim()
    : "再生で一回実行";
  return `${action}: ${result} / 次: ${next}`;
}

function workflowLastRunId(workflow: Row) {
  return typeof workflow.last_run_id === "string" && workflow.last_run_id.trim()
    ? workflow.last_run_id.trim()
    : null;
}

function createDecisionLabel(decision?: CreatePlannerDecision) {
  if (decision === "ready_to_schedule") return "定期化候補";
  if (decision === "ready_to_start") return "開始候補";
  if (decision === "demo_first") return "実演候補";
  if (decision === "save_plan") return "保存候補";
  return "質問あり";
}

function createPlannerJobStatusLabel(status: CreatePlannerJobReadback["status"]) {
  if (status === "completed") return "Mac worker完了";
  if (status === "running") return "Mac worker処理中";
  if (status === "blocked") return "Mac worker停止";
  return "Mac worker待ち";
}

function createPlannerImmediateLabel(draft: CreateDraft) {
  if (draft.plannerSource === "openai") return `即時: OpenAI API${draft.plannerModel ? ` / ${draft.plannerModel}` : ""}`;
  if (draft.plannerSource === "local_codex") return "即時: Mac worker / Codex CLI";
  return "即時: 簡易計画";
}

function createPlannerLlmLabel(draft: CreateDraft) {
  if (draft.plannerSource === "openai") return "LLM: OpenAI API";
  if (draft.plannerSource === "local_codex") return "LLM: Mac worker / Codex CLI";
  if (draft.plannerJobStatus) return `LLM: ${createPlannerJobStatusLabel(draft.plannerJobStatus)}`;
  if (draft.plannerBlocker === "mac_worker_planner_waiting" || draft.plannerBlocker === "openai_api_key_missing") return "LLM: Mac worker待機中";
  return "LLM: 未接続";
}

function createDecisionTone(decision?: CreatePlannerDecision) {
  if (decision === "ready_to_schedule" || decision === "ready_to_start" || decision === "demo_first") return "ready";
  if (decision === "save_plan") return "partial";
  return "blocked";
}

function workflowCheckTone(workflow: Row) {
  if (isPausedRegisteredWorkflow(workflow)) return "partial";
  const kind = String(workflow.check_kind ?? "");
  if (kind === "boundary") return "boundary";
  if (kind === "billing") return "approval";
  if (Boolean(workflow.needs_check)) return "blocked";
  return "ok";
}

function workflowTrustTone(workflow: Row) {
  const kind = String(workflow.trust_kind ?? "");
  if (kind === "high") return "ok";
  if (kind === "medium") return "boundary";
  if (kind === "low") return "blocked";
  return "partial";
}

function workflowFreshnessTone(workflow: Row) {
  const kind = String(workflow.freshness_kind ?? "");
  if (kind === "fresh") return "ok";
  if (kind === "recent") return "boundary";
  if (kind === "stale") return "blocked";
  return "partial";
}

function workflowSafetyTone(workflow: Row) {
  const kind = String(workflow.safety_kind ?? "");
  if (kind === "proof_only") return "ok";
  if (kind === "billing_only") return "boundary";
  return "partial";
}

const scheduleDayOptions = [
  { value: "MO", label: "月" },
  { value: "TU", label: "火" },
  { value: "WE", label: "水" },
  { value: "TH", label: "木" },
  { value: "FR", label: "金" },
  { value: "SA", label: "土" },
  { value: "SU", label: "日" }
];

function scheduleDraftFromWorkflow(workflow: Row) {
  const label = displayWorkflowSchedule(workflow);
  return {
    frequency: label.startsWith("毎週") ? "weekly" : "daily",
    time: label.match(/\b\d{2}:\d{2}\b/)?.[0] ?? "09:00",
    days: [scheduleDayOptions.find((day) => label.includes(day.label))?.value ?? "MO"]
  };
}

function isVisibleCaptureSource(key: ResearchSourceKey): key is "web" | "youtube" {
  return key === "web" || key === "youtube";
}

function detectedYouTubeUrlFromRoute(route?: CapabilityRoute): string | null {
  if (!route || route.id !== "youtube_transcript_capture") return null;
  for (const signal of route.signals) {
    try {
      const url = new URL(signal);
      if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) return url.href;
    } catch {
      // Router signals can include non-URL hints for other routes.
    }
  }
  return null;
}

function researchPlanSourceProofSummary(plan: ResearchPlan): Array<{ key: string; label: string; tone: string }> {
  const latestCaptures = asJson<Record<string, Row>>(plan.metadata?.latestCaptures, {});
  return plan.sources
    .filter((source) => source.enabled)
    .map((source) => {
      const capture = latestCaptures[source.key];
      if (capture?.proofState === "proof_saved") return { key: source.key, label: `${source.label}: 済`, tone: "complete" };
      if (capture?.exactBlocker) return { key: source.key, label: `${source.label}: 確認`, tone: "blocked" };
      if (source.key === "web" || source.key === "youtube") return { key: source.key, label: `${source.label}: 待ち`, tone: "partial" };
      return { key: source.key, label: `${source.label}: 未接続`, tone: "idle" };
    });
}

type CreateActionKey = "save" | "demo" | "start" | "schedule";

function createDecisionGuidance(
  decision: CreatePlannerDecision | undefined,
  state: { openQuestions: string[]; demoFinished: boolean; started: boolean }
) {
  if (state.started) {
    return {
      title: "開始済みです",
      detail: "次は履歴で進行状況と保存記録を確認します。",
      recommended: null as CreateActionKey | null,
      reasons: {} as Partial<Record<CreateActionKey, string>>
    };
  }
  if (decision === "ask_more") {
    return {
      title: "まだ聞きたいことがあります",
      detail: state.openQuestions[0] ?? "不足している条件を確認してから進めます。",
      recommended: "save" as CreateActionKey,
      reasons: {
        demo: "未確認の条件が残っています。",
        start: "先に質問へ答えるか、計画だけ保存してください。",
        schedule: "定期化の前に条件確認が必要です。"
      }
    };
  }
  if (decision === "save_plan") {
    return {
      title: "まず保存できます",
      detail: "計画を残してから、画面確認か実行に進めます。",
      recommended: "save" as CreateActionKey,
      reasons: {
        start: "保存してから開始すると、止まった時に戻りやすくなります。",
        schedule: "定期化の前に一度保存と実演をしてください。"
      }
    };
  }
  if (decision === "ready_to_schedule") {
    return {
      title: state.demoFinished ? "定期化できます" : "定期化の前に一度見ます",
      detail: state.demoFinished ? "実演済みなので、予定として登録できます。" : "まず画面で実演して、問題なければ定期化します。",
      recommended: (state.demoFinished ? "schedule" : "demo") as CreateActionKey,
      reasons: state.demoFinished ? {} : { schedule: "見るで実演してから定期化します。" }
    };
  }
  if (decision === "ready_to_start") {
    return {
      title: "開始できます",
      detail: "条件はそろっています。履歴と保存記録を残しながら開始できます。",
      recommended: "start" as CreateActionKey,
      reasons: {} as Partial<Record<CreateActionKey, string>>
    };
  }
  return {
    title: "一度見てから進めます",
    detail: "まず画面で実演して、証跡を残してから開始します。",
    recommended: "demo" as CreateActionKey,
    reasons: {
      start: state.demoFinished ? "" : "見るで実演してから開始します。",
      schedule: "定期化の前に実演が必要です。"
    }
  };
}

function ResearchPlanList({ plans }: { plans: ResearchPlan[] }) {
  return (
    <div className="research-plan-list">
      {plans.map((plan) => (
        <article key={plan.id}>
          <div>
            <span className={`pill ${plan.status}`}>{displayStatus(plan.status)}</span>
            <strong>{plan.title}</strong>
          </div>
          <div className="research-plan-proof-summary">
            {researchPlanSourceProofSummary(plan).map((item) => (
              <span className={`pill ${item.tone}`} key={`${plan.id}-${item.key}`}>{item.label}</span>
            ))}
          </div>
          <details className="internal-details">
            <summary>中身</summary>
            <ol>
              {plan.visibleFlow.slice(0, 5).map((step, index) => (
                <li key={`${plan.id}-${index}`}>{step}</li>
              ))}
            </ol>
            <small>詳細は内部記録に保存済みです。</small>
          </details>
        </article>
      ))}
      {plans.length === 0 && <Empty text="まだありません。" />}
    </div>
  );
}

function CreateView(props: {
  messages: ChatMessage[];
  input: string;
  draft: CreateDraft;
  researchSources: Record<ResearchSourceKey, boolean>;
  researchPlan: ResearchPlan;
  sourceCaptureResults: Partial<Record<ResearchSourceKey, PlannerCaptureResponse>>;
  capabilityPlan?: CapabilityRouterSnapshot;
  busyKey: string | null;
  onInput: (value: string) => void;
  onSend: () => Promise<CreateDraft | null>;
  onSuggestion: (value: string) => Promise<CreateDraft | null>;
  onSourceToggle: (key: ResearchSourceKey) => void;
  onVisibleStepsChange: (steps: string[]) => void;
  onSavePlan: () => Promise<ResearchPlan | null>;
  onDemoPlan: () => Promise<void>;
  onCaptureSource: (sourceKey: ResearchSourceKey, url: string) => Promise<void>;
  onStart: () => Promise<void>;
  onRegularize: () => Promise<void>;
  onReset: () => void;
  secrets: SecretSummary[];
}) {
  const createMessageBusy = props.busyKey === "secret-save";
  const createActionBusy =
    createMessageBusy
    || props.busyKey === "research-plan-save"
    || props.busyKey === "research-plan-demo"
    || props.busyKey === "research-plan-start"
    || props.busyKey === "research-plan-regularize"
    || props.busyKey?.startsWith("research-plan-capture-");
  const plan = props.researchPlan;
  const capabilityRoutes = props.capabilityPlan?.recommendedRoutes ?? [];
  const detectedYouTubeUrl = detectedYouTubeUrlFromRoute(capabilityRoutes.find((route) => route.id === "youtube_transcript_capture"));
  const visibleSteps = normalizeVisibleSteps(props.draft.visibleSteps, plan.visibleFlow);
  const answerOnly = props.draft.intent === "answer_question";
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [editingStepText, setEditingStepText] = useState("");
  const [sourceUrls, setSourceUrls] = useState<Partial<Record<ResearchSourceKey, string>>>({});
  const demoFinished = plan.status === "demoed" || Boolean(plan.demoCheckId);
  const started = plan.status === "started" || Boolean(plan.runId);
  const decisionGuidance = createDecisionGuidance(props.draft.executionDecision, {
    openQuestions: props.draft.openQuestions ?? [],
    demoFinished,
    started
  });
  const stageItems = researchPlannerStages(plan, props.sourceCaptureResults);
  const createActionCards = [
    {
      key: "save",
      tone: "safe",
      icon: props.busyKey === "research-plan-save" ? <Loader2 size={16} className="spin" /> : <FileCheck size={16} />,
      title: "保存",
      buttonLabel: "保存",
      actionLabel: "保存",
      disabled: createActionBusy || !props.draft.command.trim(),
      reason: decisionGuidance.reasons.save,
      onClick: props.onSavePlan
    },
    {
      key: "demo",
      tone: "observe",
      icon: props.busyKey === "research-plan-demo" ? <Loader2 size={16} className="spin" /> : <Eye size={16} />,
      title: "見る",
      buttonLabel: "見る",
      actionLabel: "ローカルで実演",
      disabled: createActionBusy || !props.draft.command.trim() || props.draft.executionDecision === "ask_more",
      reason: decisionGuidance.reasons.demo,
      onClick: props.onDemoPlan
    },
    {
      key: "start",
      tone: "run",
      icon: props.busyKey === "research-plan-start" ? <Loader2 size={16} className="spin" /> : <Play size={16} />,
      title: "開始",
      buttonLabel: "開始",
      actionLabel: "実行",
      disabled: createActionBusy || !props.draft.command.trim() || props.draft.executionDecision === "ask_more" || props.draft.executionDecision === "save_plan" || (props.draft.executionDecision === "demo_first" && !demoFinished),
      reason: decisionGuidance.reasons.start,
      onClick: props.onStart
    }
  ];
  const scheduleAction = {
    key: "schedule" as const,
    tone: "schedule",
    icon: props.busyKey === "research-plan-regularize" ? <Loader2 size={16} className="spin" /> : <RefreshCcw size={16} />,
    title: "定期",
    buttonLabel: "定期にする",
    actionLabel: "定期実行にする",
    disabled: createActionBusy || !props.draft.command.trim() || !demoFinished,
    reason: decisionGuidance.reasons.schedule,
    onClick: props.onRegularize
  };
  const visibleActionCards = props.draft.executionDecision === "ready_to_schedule" || demoFinished
    ? [...createActionCards, scheduleAction]
    : createActionCards;

  function selectStep(index: number) {
    setSelectedStepIndex(index);
  }

  function addStepAfter(index: number) {
    const nextSteps = [
      ...visibleSteps.slice(0, index + 1),
      "新しい操作",
      ...visibleSteps.slice(index + 1)
    ];
    props.onVisibleStepsChange(nextSteps);
    setSelectedStepIndex(index + 1);
    setEditingStepIndex(index + 1);
    setEditingStepText("新しい操作");
  }

  function startEditStep(index: number) {
    setSelectedStepIndex(index);
    setEditingStepIndex(index);
    setEditingStepText(visibleSteps[index] ?? "");
  }

  function commitStepEdit() {
    if (editingStepIndex == null) return;
    const nextValue = editingStepText.trim();
    if (nextValue) {
      props.onVisibleStepsChange(visibleSteps.map((step, index) => index === editingStepIndex ? nextValue : step));
    }
    setEditingStepIndex(null);
    setEditingStepText("");
  }

  function updateSourceUrl(sourceKey: ResearchSourceKey, value: string) {
    setSourceUrls((current) => ({ ...current, [sourceKey]: value }));
  }

  return (
    <section className="create-view">
      <article className="chat-panel">
        <div className="chat-head">
          <div>
            <h2>作る</h2>
          </div>
          <button className="text-button compact" onClick={props.onReset} disabled={createActionBusy}>
            <RefreshCcw size={15} />
            新しい相談
          </button>
        </div>
        {props.secrets.length > 0 && (
          <div className="sr-only">
            保存済みの認証情報があります
          </div>
        )}
        <div className="chat-thread" aria-live="polite">
          {props.messages.map((message) => (
            <div className={`chat-message ${message.role}`} key={message.id}>
              <div>{displayChatMessage(message)}</div>
            </div>
          ))}
        </div>
        <div className="suggestion-row">
          {createSuggestions.map((suggestion) => (
            <button key={suggestion} disabled={createActionBusy} onClick={() => props.onSuggestion(suggestion)}>{suggestion}</button>
          ))}
        </div>
        <div className="chat-composer">
          <textarea
            value={props.input}
            onChange={(event) => props.onInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void props.onSend();
              }
            }}
            placeholder="例: 毎朝の確認作業を、相談しながら計画したい"
            aria-label="相談して計画する内容"
            disabled={createActionBusy}
          />
          <button title="送信" aria-label="相談を送信" disabled={createActionBusy || !props.input.trim()} onClick={() => void props.onSend()}>
            {createMessageBusy ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
          </button>
        </div>
      </article>

      <aside className="create-plan">
        <div>
          <h2>{props.draft.title}</h2>
        </div>
        <section className={`conversation-brief ${answerOnly ? "answer-only" : ""}`}>
          <div>
            <strong>{answerOnly ? "回答" : "相談の整理"}</strong>
            {!answerOnly && <span className={`pill ${createDecisionTone(props.draft.executionDecision)}`}>{createDecisionLabel(props.draft.executionDecision)}</span>}
          </div>
          {!answerOnly && <div className="planner-state-row" aria-label="計画の確認状態">
            <span>{createPlannerImmediateLabel(props.draft)}</span>
            <span>{createPlannerLlmLabel(props.draft)}</span>
            <span>{props.draft.confidence === "high" ? "確信 高" : props.draft.confidence === "low" ? "確信 低" : "確信 中"}</span>
          </div>}
          <div className="brief-columns">
            <div>
              <span>{answerOnly ? "できること" : "確認できたこと"}</span>
              {(props.draft.answered?.length ? props.draft.answered : ["まだ整理中"]).map((item) => (
                <small key={item}>{item}</small>
              ))}
            </div>
            {!answerOnly && <div>
              <span>未確認</span>
              {(props.draft.openQuestions?.length ? props.draft.openQuestions : ["追加質問はありません"]).map((item) => (
                <small key={item}>{item}</small>
              ))}
            </div>}
          </div>
          <p>{props.draft.nextAction || "次のメッセージで計画を更新します。"}</p>
        </section>
        {!answerOnly && <section className="decision-guidance" aria-label="おすすめの次の操作">
          <div>
            <strong>{decisionGuidance.title}</strong>
            <span>{decisionGuidance.detail}</span>
          </div>
        </section>}
        {!answerOnly && <div className="visible-plan">
          <strong>流れ</strong>
          <div className="visible-flow" aria-label="画面に見せる流れ">
            {visibleSteps.map((step, index) => (
              <div className="visible-flow-item" key={`${step}-${index}`}>
                <div className={`visible-step ${selectedStepIndex === index ? "selected" : ""}`}>
                  {editingStepIndex === index ? (
                    <input
                      value={editingStepText}
                      autoFocus
                      onChange={(event) => setEditingStepText(event.target.value)}
                      onBlur={commitStepEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitStepEdit();
                        if (event.key === "Escape") {
                          setEditingStepIndex(null);
                          setEditingStepText("");
                        }
                      }}
                      disabled={createActionBusy}
                      aria-label="フロー項目を編集"
                    />
                  ) : (
                    <button type="button" onClick={() => selectStep(index)} disabled={createActionBusy}>
                      {step}
                    </button>
                  )}
                  {selectedStepIndex === index && editingStepIndex !== index && (
                    <div className="visible-step-tools" aria-label="フロー項目の操作">
                      <button type="button" title="編集" onClick={() => startEditStep(index)} disabled={createActionBusy}>
                        <Pencil size={14} />
                      </button>
                      <button type="button" title="直後に追加" onClick={() => addStepAfter(index)} disabled={createActionBusy}>
                        <Plus size={15} />
                      </button>
                    </div>
                  )}
                </div>
                {index < visibleSteps.length - 1 && (
                  <div className="visible-flow-arrow" aria-hidden="true">
                    <ChevronDown size={18} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>}
        {started && (
          <div className="run-proof-note">
            <Check size={15} />
            <span>開始済み</span>
          </div>
        )}
        {capabilityRoutes.length > 0 && (
          <section className="capability-suggestions">
            <div>
              <strong>使えそうな道具</strong>
            </div>
            <div className="capability-suggestion-list">
              {capabilityRoutes.slice(0, 3).map((route) => (
                <article key={route.id}>
                  <span className={`pill ${route.status}`}>{capabilityStatusLabel(route.status)}</span>
                  <strong>{route.label}</strong>
                  <small>{route.nextAction}</small>
                  {route.id === "youtube_transcript_capture" && detectedYouTubeUrl && (
                    <button
                      type="button"
                      onClick={() => void props.onCaptureSource("youtube", detectedYouTubeUrl)}
                      disabled={createActionBusy || !props.draft.command.trim()}
                    >
                      {props.busyKey === "research-plan-capture-youtube" ? <Loader2 size={15} className="spin" /> : <FileText size={15} />}
                      台本を取得
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        {!answerOnly && <div className="research-plan-actions">
          {visibleActionCards.map((action) => (
            <article className={`plan-action-card ${action.tone} ${decisionGuidance.recommended === action.key ? "recommended" : ""}`} key={action.key}>
              <div>
                <strong>{action.title}</strong>
                {decisionGuidance.recommended === action.key && <small>おすすめ</small>}
                {action.reason && <small>{action.reason}</small>}
              </div>
              <button
                className={decisionGuidance.recommended === action.key || action.key === "start" ? "primary-action" : ""}
                disabled={action.disabled}
                onClick={() => void action.onClick()}
                title={action.actionLabel ?? action.buttonLabel}
                aria-label={action.actionLabel ?? action.buttonLabel}
              >
                {action.icon}
                {action.buttonLabel}
              </button>
            </article>
          ))}
        </div>}
        <details className="create-advanced-settings">
          <summary>詳細</summary>
          <div className="research-source-toggle">
            <strong>確認に使う場所</strong>
            <div>
              {researchSourceKeys.map((key) => (
                <button
                  className={props.researchSources[key] ? "active" : ""}
                  key={key}
                  type="button"
                  onClick={() => props.onSourceToggle(key)}
                  disabled={createActionBusy}
                >
                  {researchSourceLabels[key]}
                </button>
              ))}
            </div>
          </div>
          <div className="research-source-list">
            {plan.sources.map((source) => (
              <article className={source.enabled ? "research-source-row enabled" : "research-source-row"} key={source.key}>
                <div className="source-row-head">
                  <div>
                    <strong>{source.label}</strong>
                    <span>{source.enabled ? displayCreatePlanText(source.mode) : "OFF"}</span>
                  </div>
                  <span className={`pill ${sourceProofState(source, props.sourceCaptureResults[source.key]).tone}`}>
                    {sourceProofState(source, props.sourceCaptureResults[source.key]).label}
                  </span>
                </div>
                <small>{source.enabled ? displayCreatePlanText(source.boundary) : "この計画では使いません"}</small>
                <small>{sourceNextConnection(source)}</small>
                {source.enabled && isVisibleCaptureSource(source.key) && (
                  <div className="source-capture-controls">
                    <input
                      value={sourceUrls[source.key] ?? ""}
                      onChange={(event) => updateSourceUrl(source.key, event.target.value)}
                      placeholder={source.key === "youtube" ? "https://www.youtube.com/watch?v=..." : "https://example.com/article"}
                      aria-label={`${source.label}の実演URL`}
                      disabled={createActionBusy}
                    />
                    <button
                      type="button"
                      onClick={() => void props.onCaptureSource(source.key, sourceUrls[source.key] ?? "")}
                      disabled={createActionBusy || !props.draft.command.trim()}
                    >
                      {props.busyKey === `research-plan-capture-${source.key}` ? <Loader2 size={15} className="spin" /> : <Eye size={15} />}
                      {source.key === "youtube" ? "台本を実演" : "Webを取得"}
                    </button>
                  </div>
                )}
                {source.enabled && props.sourceCaptureResults[source.key] && (
                  <div className="source-capture-result">
                    {captureResultLines(props.sourceCaptureResults[source.key]).map((line) => (
                      <small key={line}>{line}</small>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </details>
        <details className="create-diagnostics icon-only-details">
          <summary title="診断" aria-label="診断">
            <Database size={16} />
            <span className="sr-only">診断</span>
          </summary>
          <div className="planner-stage-strip" aria-label="提案の進行状態">
            {stageItems.map((stage) => (
              <div className={`planner-stage ${stage.state}`} key={stage.key}>
                <span>{stage.label}</span>
                <small>{stage.detail}</small>
              </div>
            ))}
          </div>
          <section className="execution-boundary" aria-label="実行前の境界">
            <div>
              <ShieldCheck size={16} />
              <span>保存と実演は実行ではありません</span>
            </div>
            <small>保存は開始前の計画だけ、実演はローカル画面の確認だけです。完了には、実行結果と保存記録の確認が別に必要です。</small>
            <small>記録だけの状態では、外部操作や手動確認が終わったとは扱いません。</small>
          </section>
          <div className="backend-plan">
            <strong>内部確認</strong>
            <small>確認元・確認記録・承認条件は内部に保存し、画面には実行の流れだけを表示します。</small>
            <small>{props.draft.backendChecks.length}件の確認項目を内部に保存します。</small>
          </div>
        </details>
      </aside>
    </section>
  );
}

function RunsView(props: {
  runs: Row[];
  actionableRuns: Row[];
  selectedRun?: Row;
  steps: Row[];
  proofs: Row[];
  children: Row[];
  events: Row[];
  localWorker: Row;
  onSelectRun: (id: string) => void;
  onSelectProof: (proof: Row) => void;
  onRefreshRun: (run: Row) => void;
  onOpenApprovals: () => void;
  onContinueInCreate: (run: Row) => void;
}) {
  const meta = asJson<Row>(props.selectedRun?.metadata_json, {});
  const actionableIds = new Set(props.actionableRuns.map((run) => run.id).filter((id): id is string => typeof id === "string"));
  const runGroups = props.runs.reduce<{ actionable: Row[]; running: Row[]; completed: Row[]; archive: Row[] }>((groups, run) => {
    if (actionableIds.has(String(run.id))) return groups;
    const disposition = classifyRun(run);
    const group = disposition.kind === "actionable" ? "actionable" : disposition.kind;
    groups[group].push(run);
    return groups;
  }, { actionable: props.actionableRuns, running: [], completed: [], archive: [] });
  const renderRunCard = (run: Row) => {
    const disposition = classifyRun(run);
    return (
      <button className={run.id === props.selectedRun?.id ? "run-card selected" : "run-card"} key={run.id} onClick={() => props.onSelectRun(run.id)}>
        <span className={`status-dot ${run.status}`} />
        <div>
          <strong>{displayTaskName(run.name)}</strong>
          <small>{displayRunCardStatus(disposition)}</small>
        </div>
        <ChevronRight size={15} />
      </button>
    );
  };
  return (
    <section className="view-grid runs-view">
      <Panel title="履歴" action={`${props.runs.length}件`}>
        <div className="run-list">
          {runGroups.actionable.length > 0 && (
            <div className="run-group">
              <h3>確認が必要</h3>
              {runGroups.actionable.map(renderRunCard)}
            </div>
          )}
          {runGroups.running.length > 0 && (
            <div className="run-group">
              <h3>進行中</h3>
              {runGroups.running.map(renderRunCard)}
            </div>
          )}
          {runGroups.completed.length > 0 && (
            <div className="run-group">
              <h3>完了</h3>
              {runGroups.completed.map(renderRunCard)}
            </div>
          )}
          {runGroups.archive.length > 0 && (
            <details className="run-group archive-runs">
              <summary>古い履歴 <span>{runGroups.archive.length}</span></summary>
              {runGroups.archive.map(renderRunCard)}
            </details>
          )}
          {props.runs.length === 0 && <Empty text="なし" />}
        </div>
      </Panel>

      <Panel title="詳細" action={props.selectedRun ? displayRunCardStatus(classifyRun(props.selectedRun)) : "なし"}>
        {!props.selectedRun ? (
          <Empty text="履歴から実行を選んでください。" />
        ) : (
          <>
            <RunSummary
              run={props.selectedRun}
              meta={meta}
              proofCount={props.proofs.length}
              stepCount={props.steps.length}
              eventCount={props.events.length}
              workerEvents={props.events}
              localWorker={props.localWorker}
              firstProof={props.proofs[0]}
              onRefresh={() => props.onRefreshRun(props.selectedRun as Row)}
              onOpenProof={props.proofs[0] ? () => props.onSelectProof(props.proofs[0]) : undefined}
              onOpenApprovals={props.onOpenApprovals}
              onContinueInCreate={() => props.onContinueInCreate(props.selectedRun as Row)}
            />
            <div className="detail-section">
              <h3>手順</h3>
              <Timeline steps={props.steps} />
            </div>
            <details className="internal-details">
              <summary title="詳細" aria-label="詳細">詳細</summary>
              <div className="detail-section">
                <h3>保存</h3>
                <ReceiptTable proofs={props.proofs} onSelect={props.onSelectProof} />
              </div>
              <div className="detail-section">
                <h3>記録</h3>
                <WorkerEvents events={props.events} />
              </div>
              <ChildCodexRuns children={props.children} />
            </details>
          </>
        )}
      </Panel>
    </section>
  );
}

function ScheduleView({
  registeredWorkflows,
  schedulerStatus,
  onSchedulerRunOnce,
  onOpenRun,
  onRegisteredStart,
  onRegisteredToggle,
  onRegisteredSchedule,
  busyKey,
  productionGuard,
  operatorWriteTokenReady,
  onSaveOperatorWriteToken,
  onClearOperatorWriteToken
}: {
  registeredWorkflows: Row[];
  schedulerStatus: Row;
  onSchedulerRunOnce: () => void;
  onOpenRun: (id: string) => void;
  onRegisteredStart: (id: string) => void;
  onRegisteredToggle: (workflow: Row) => void;
  onRegisteredSchedule: (id: string, schedule: { frequency: string; time: string; days?: string[] }) => Promise<boolean>;
  busyKey: string | null;
  productionGuard: Row;
  operatorWriteTokenReady: boolean;
  onSaveOperatorWriteToken: (value: string) => boolean;
  onClearOperatorWriteToken: () => void;
}) {
  const managedWorkflows = registeredWorkflows.filter(isManagedRegisteredWorkflow).sort((a, b) => Number(Boolean(b.needs_check)) - Number(Boolean(a.needs_check)));
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState({ frequency: "daily", time: "09:00", days: ["MO"] });
  const [operatorTokenInput, setOperatorTokenInput] = useState("");
  const writeLocked = productionGuard.required === true && productionGuard.mode === "locked";
  const writeTokenMissing = productionGuard.required === true && productionGuard.mode === "token_required" && !operatorWriteTokenReady;
  const writeDisabled = writeLocked || writeTokenMissing;
  const lockTitle = "Zeaburに実行用tokenが未設定です";
  const tokenTitle = "このブラウザに操作tokenを保存してください";
  const schedulerDisabled = schedulerStatus.enabled === false;
  return (
    <section className="schedule-view">
      <div className="simple-head">
        <h2>定期</h2>
        <div className="simple-head-actions">
          <button className="icon-action" disabled={writeDisabled || busyKey === "scheduler-run-once"} onClick={onSchedulerRunOnce} title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "今すぐ確認"} aria-label="今すぐ確認">
            {busyKey === "scheduler-run-once" ? <Loader2 size={16} className="spin" /> : <RefreshCcw size={16} />}
          </button>
        </div>
      </div>
      {schedulerDisabled && (
        <div className="schedule-lock warning-line" role="status">
          <AlertTriangle size={16} />
          <span>{String(schedulerStatus.detail ?? "時刻ベースの自動確認は停止しています。各行の再生ボタンで一回実行できます。")}</span>
        </div>
      )}
      {writeLocked && (
        <div className="schedule-lock warning-line" role="status">
          <AlertTriangle size={16} />
          <span>本番の実行ボタンは停止中です。Zeaburに実行用tokenを設定すると、ここから本番の保存先へ入り、Mac側で処理されます。</span>
        </div>
      )}
      {writeTokenMissing && (
        <form className="schedule-token-panel warning-line" role="status" onSubmit={(event) => {
          event.preventDefault();
          if (onSaveOperatorWriteToken(operatorTokenInput)) setOperatorTokenInput("");
        }}>
          <AlertTriangle size={16} />
          <span>このブラウザに操作tokenを保存すると、再生ボタンから本番の保存先へ送れます。</span>
          <input
            type="password"
            value={operatorTokenInput}
            onChange={(event) => setOperatorTokenInput(event.target.value)}
            placeholder="操作token"
            autoComplete="off"
            aria-label="操作token"
          />
          <button className="text-button primary" type="submit">保存</button>
        </form>
      )}
      {productionGuard.required === true && productionGuard.mode === "token_required" && operatorWriteTokenReady && (
        <div className="schedule-token-panel ready-line" role="status">
          <Check size={16} />
          <span>このブラウザは操作できます。</span>
          <button className="text-button" type="button" onClick={onClearOperatorWriteToken}>削除</button>
        </div>
      )}
      <div className="schedule-list">
        {managedWorkflows.map((workflow) => {
          const needsCheck = Boolean(workflow.needs_check);
          const paused = isPausedRegisteredWorkflow(workflow);
          const editing = editingId === String(workflow.id);
          const scheduleBusy = busyKey === `registered-schedule-${workflow.id}`;
          const lastRunId = workflowLastRunId(workflow);
          return (
            <article className="schedule-row" key={workflow.id} data-check={needsCheck ? "needed" : "ok"}>
              <span className={`schedule-check-chip ${workflowCheckTone(workflow)}`} title={displayWorkflowStateTitle(workflow)} aria-label={displayWorkflowStateTitle(workflow)}>
                {displayWorkflowCheckLabel(workflow)}
              </span>
              <div className="schedule-row-main">
                <strong>{displayWorkflowName(workflow)}</strong>
                <small>{displayWorkflowMetaSummary(workflow)}</small>
                {lastRunId ? (
                  <button className="schedule-row-result schedule-row-result-link" type="button" onClick={() => onOpenRun(lastRunId)} title="履歴で見る" aria-label={`${displayWorkflowName(workflow)}の前回の履歴を見る`}>
                    <span>{displayWorkflowLastActionSummary(workflow)}</span>
                    <ChevronRight size={13} />
                  </button>
                ) : (
                  <small className="schedule-row-result">{displayWorkflowLastActionSummary(workflow)}</small>
                )}
              </div>
              <span className="schedule-time" title={displayWorkflowSchedule(workflow)} aria-hidden="true">{displayWorkflowScheduleShort(workflow)}</span>
              <span className="sr-only">{displayWorkflowSchedule(workflow)}</span>
              <div className="schedule-row-actions" role="group" aria-label={`${displayWorkflowName(workflow)}の操作`}>
                <button className="icon-action" disabled={writeDisabled || scheduleBusy} onClick={() => {
                  setEditingId(editing ? "" : String(workflow.id));
                  setDraft(scheduleDraftFromWorkflow(workflow));
                }} title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "変更"} aria-label={`${displayWorkflowName(workflow)}の予定を変更`}>
                  {scheduleBusy ? <Loader2 size={16} className="spin" /> : <Pencil size={16} />}
                </button>
                <button className="icon-action" disabled={writeDisabled || busyKey === `registered-toggle-${workflow.id}`} onClick={() => onRegisteredToggle(workflow)} title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : paused ? "再開" : "停止"} aria-label={`${displayWorkflowName(workflow)}を${paused ? "再開" : "停止"}`}>
                  {busyKey === `registered-toggle-${workflow.id}` ? <Loader2 size={16} className="spin" /> : paused ? <Play size={16} /> : <Pause size={16} />}
                </button>
                <button className="icon-action" disabled={writeDisabled || busyKey === `registered-${workflow.id}`} onClick={() => onRegisteredStart(String(workflow.id))} title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "一回実行"} aria-label={`${displayWorkflowName(workflow)}を一回実行`}>
                  {busyKey === `registered-${workflow.id}` ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                </button>
              </div>
              {editing && (
                <form className="schedule-edit" onSubmit={(event) => {
                  event.preventDefault();
                  void onRegisteredSchedule(String(workflow.id), {
                    frequency: draft.frequency,
                    time: draft.time,
                    ...(draft.frequency === "weekly" ? { days: draft.days } : {})
                  }).then((ok) => {
                    if (ok) setEditingId("");
                  });
                }}>
                  <select value={draft.frequency} onChange={(event) => setDraft((current) => ({ ...current, frequency: event.target.value }))} aria-label="頻度">
                    <option value="daily">毎日</option>
                    <option value="weekly">毎週</option>
                  </select>
                  <input type="time" value={draft.time} onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))} aria-label="時刻" />
                  {draft.frequency === "weekly" && (
                    <select value={draft.days[0] ?? "MO"} onChange={(event) => setDraft((current) => ({ ...current, days: [event.target.value] }))} aria-label="曜日">
                      {scheduleDayOptions.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}
                    </select>
                  )}
                  <button className="icon-action" disabled={writeDisabled || scheduleBusy} type="submit" title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "保存"} aria-label={`${displayWorkflowName(workflow)}の予定を保存`}>
                    {scheduleBusy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                  </button>
                  <button className="icon-action" disabled={scheduleBusy} type="button" onClick={() => setEditingId("")} title="閉じる" aria-label="閉じる">
                    <X size={16} />
                  </button>
                </form>
              )}
            </article>
          );
        })}
        {managedWorkflows.length === 0 && <Empty text="まだありません。" />}
      </div>
    </section>
  );
}

function ApprovalsView({ approvals, onDecision, busyKey }: { approvals: Row[]; onDecision: (path: string, msg: string, options?: { view?: View; key?: string }) => Promise<void>; busyKey: string | null }) {
  return (
    <Panel title="確認" action={`${approvals.filter((approval) => approval.status === "pending").length}件`}>
      <ApprovalQueue approvals={approvals} onDecision={onDecision} busyKey={busyKey} full />
    </Panel>
  );
}

function LanesView({ lanes }: { lanes: Row[] }) {
  const active = lanes.filter((lane) => lane.status === "active").length;
  const attentionLanes = lanes.filter(laneNeedsAttention);
  const configured = lanes.filter((lane) => lane.playwright_configured || lane.connection_configured || lane.browser_use_configured).length;
  return (
    <Panel title="同時実行レーン" action={`${lanes.length}件`}>
      <div className="source-summary single">
        <div>
          <strong>{active}</strong>
          <span>使用中</span>
          <small>現在タスクを持つレーン</small>
        </div>
        <div>
          <strong>{attentionLanes.length}</strong>
          <span>要確認</span>
          <small>停止・実行中・健全性の確認</small>
        </div>
        <div>
          <strong>{configured}</strong>
          <span>接続設定</span>
          <small>ブラウザ接続設定あり</small>
        </div>
      </div>
      <LaneFocusList lanes={attentionLanes} />
      <details className="lane-audit-details">
        <summary>監査詳細</summary>
        <LaneMatrix lanes={lanes} />
      </details>
    </Panel>
  );
}

function SourcesView({
  summary,
  assets,
  events,
  checks,
  bridgeCatalog,
  bridgeActions,
  bridgeExecutions,
  knowledgeNotes,
  researchPlans,
  obsidian,
  codexCapabilities,
  codexParityLedger,
  codexAutomationMigrationLedger,
  capabilityRouter,
  browserHealth,
  localWorker,
  onImport,
  onBridgeAction,
  onGapAction,
  busyKey
}: {
  summary: Row[];
  assets: Row[];
  events: Row[];
  checks: Row[];
  bridgeCatalog: Row[];
  bridgeActions: Row[];
  bridgeExecutions: Row[];
  knowledgeNotes: Row[];
  researchPlans: ResearchPlan[];
  obsidian: Row;
  codexCapabilities: Row;
  codexParityLedger: Row;
  codexAutomationMigrationLedger: Row;
  capabilityRouter?: CapabilityRouterSnapshot;
  browserHealth: Row;
  localWorker: Row;
  onImport: () => void;
  onBridgeAction: (id: string) => void;
  onGapAction: (gap: CapabilityGap) => void;
  busyKey: string | null;
}) {
  const capabilitySummary = asJson<Row>(codexCapabilities.summary, {});
  const playwright = asJson<Row>(browserHealth.playwrightCli, {});
  const browserUse = asJson<Row>(browserHealth.browserUseCli, {});
  const browserBridge = asJson<Row>(browserHealth.codexBrowserBridge, {});
  const latestCheck = checks[0];
  const latestBrowserUseResult = useMemo(() => checks.map(toBrowserUseResult).find(Boolean) ?? null, [checks]);
  const parityItems = Array.isArray(codexParityLedger.items) ? codexParityLedger.items : [];
  const migrationSummary = asJson<Row>(codexAutomationMigrationLedger.summary, {});
  return (
    <section className="grid bottom-grid sources-view">
      <LocalWorkerSetupPanel worker={localWorker} />
      <ObsidianSyncCard
        obsidian={obsidian}
        variant="detail"
        onRefresh={() => onBridgeAction("obsidian_export")}
        busy={busyKey === "bridge-obsidian_export"}
      />
      <CapabilityBacklogPanel router={capabilityRouter ?? emptyDashboard.capabilityRouter} onGapAction={onGapAction} />
      <AutomationMigrationLedgerPanel summary={migrationSummary} generatedAt={String(codexAutomationMigrationLedger.generatedAt ?? "")} />
      <details className="sources-more">
        <summary>詳細</summary>
        <div className="grid bottom-grid sources-detail-grid">
          <CodexParityLedgerPanel items={parityItems} generatedAt={String(codexParityLedger.generatedAt ?? "")} />
          <Panel title="読み込み" action="更新" onAction={onImport}>
            <AssetInventory summary={summary} assets={assets} />
          </Panel>
          <Panel title="道具" action={browserUse.available ? "OK" : "確認"}>
            <div className="source-summary single">
              <div>
                <strong>{capabilitySummary.plugins ?? "--"}</strong>
                <span>拡張</span>
              </div>
              <div>
                <strong>{playwright.available ? "OK" : "--"}</strong>
                <span>画面</span>
              </div>
              <div>
                <strong>{browserUse.available ? "OK" : "--"}</strong>
                <span>自動確認</span>
              </div>
              <div>
                <strong>{browserBridge.status === "requires_bridge" ? "確認" : browserBridge.status ?? "--"}</strong>
                <span>共有画面</span>
              </div>
              <div>
                <strong>{latestCheck ? displayStatus(latestCheck.status) : "--"}</strong>
                <span>前回</span>
              </div>
            </div>
            {latestCheck && (
              <div className="check-result">
                <strong>{displayBridgeReceiptSummary(latestCheck.summary)}</strong>
                <small>{displayStatus(latestCheck.status)} · {displayShortDateTime(latestCheck.created_at)}</small>
                <small>詳細は内部記録に保存済みです。</small>
              </div>
            )}
          </Panel>
          <BrowserUseResultPanel result={latestBrowserUseResult} />
          <Panel title="計画" action={`${researchPlans.length}件`}>
            <ResearchPlanList plans={researchPlans} />
          </Panel>
          <Panel title="メモ" action={`${events.length}件`}>
            <ResearchTable events={events} />
          </Panel>
          <Panel title="操作" action={`${bridgeCatalog.length}件`}>
            <BridgeActionList actions={bridgeCatalog} receipts={bridgeActions} onRun={onBridgeAction} busyKey={busyKey} />
          </Panel>
          <Panel title="外部" action={`${bridgeExecutions.length}件`}>
            <BridgeExecutionList executions={bridgeExecutions} />
          </Panel>
          <Panel title="保存" action={`${knowledgeNotes.length}件`}>
            <KnowledgeNotes notes={knowledgeNotes} />
          </Panel>
        </div>
      </details>
    </section>
  );
}

function LocalWorkerSetupPanel({ worker }: { worker: Row }) {
  const status = String(worker.status ?? "missing");
  const label = String(worker.label ?? "未接続");
  const nextAction = String(worker.nextAction ?? "Macに本番PostgreSQL接続を保存してから stored worker proof を実行してください。");
  const processed = Number(worker.processed ?? 0);
  const guidance = compactWorkerSetupGuidance(nextAction);
  const isConnected = status === "ok" || status === "running" || status === "idle";
  const heartbeatLabel = status === "missing" ? "heartbeat 未確認" : "heartbeat 確認済み";
  return (
    <Panel title="Mac worker" action={heartbeatLabel}>
      <div className="worker-setup-panel">
        {isConnected ? (
          <div className="worker-ready-summary">
            <strong>{status === "running" ? "処理中です" : "待機中です"}</strong>
            <p>{guidance}</p>
          </div>
        ) : (
          <div className="worker-setup-steps">
            <div className="worker-setup-step">
              <span>1</span>
              <strong>接続情報を保存</strong>
              <small>本番PostgreSQLの接続を保存します。</small>
            </div>
            <div className="worker-setup-step">
              <span>2</span>
              <strong>接続を確認</strong>
              <small>保存済み接続で疎通proofを実行します。</small>
            </div>
            <div className="worker-setup-step">
              <span>3</span>
              <strong>待機を開始</strong>
              <small>登録済み実行をMacで拾える状態にします。</small>
            </div>
          </div>
        )}
        <div className="worker-status-grid" aria-label="Mac worker status">
          <span>状態</span>
          <strong>{label}</strong>
          <span>処理数</span>
          <strong>{processed}</strong>
        </div>
        <small>{status === "missing" ? "本番Mac workerのheartbeatを待っています。" : "Dashboardが最後のheartbeatを読んでいます。"}</small>
      </div>
    </Panel>
  );
}

function compactWorkerSetupGuidance(value: string) {
  const cleaned = value
    .replace(/npm run worker:production-proof:stored/gu, "接続 proof")
    .replace(/npm run worker:loop:stored/gu, "worker loop")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned || "接続情報を保存し、proof後にworkerを起動してください。";
}

function CapabilityBacklogPanel({ router, onGapAction }: { router?: CapabilityRouterSnapshot; onGapAction?: (gap: CapabilityGap) => void }) {
  const routes = router?.recommendedRoutes ?? [];
  const gaps = router?.gapBacklog ?? [];
  return (
    <Panel title="活用候補" action={`${gaps.length}件`}>
      <div className="capability-router-panel">
        {router?.primaryAction && (
          <div className="capability-primary">
            <strong>次に使う候補</strong>
            <small>{router.primaryAction}</small>
          </div>
        )}
        <div className="capability-suggestion-list">
          {routes.slice(0, 3).map((route) => (
            <article key={route.id}>
              <span className={`pill ${route.status}`}>{capabilityStatusLabel(route.status)}</span>
              <strong>{route.label}</strong>
              <small>{route.nextAction}</small>
            </article>
          ))}
          {routes.length === 0 && <Empty text="使える候補を確認中です。" />}
        </div>
        <details className="internal-details">
          <summary>まだつなぐもの</summary>
          <div className="capability-gap-list">
            {gaps.slice(0, 8).map((gap) => (
              <article key={gap.id}>
                <span className={`pill ${gap.priority}`}>{gapPriorityLabel(gap.priority)}</span>
                <strong>{gap.label}</strong>
                <small>{gap.nextAction}</small>
                {gap.action && onGapAction && (
                  <button type="button" onClick={() => onGapAction(gap)}>
                    <Plus size={15} />
                    {gap.action.label}
                  </button>
                )}
              </article>
            ))}
          </div>
        </details>
      </div>
    </Panel>
  );
}

function CodexParityLedgerPanel({ items, generatedAt }: { items: Row[]; generatedAt: string }) {
  return (
    <Panel title="Codex App互換台帳" action={`${items.length}項目`}>
      <div className="parity-ledger">
        <div className="parity-ledger-head">
          <div>
            <strong>対応状況</strong>
            <small>Codex Appでできることを、表示・実行境界・証跡で確認します。</small>
          </div>
          <small>{generatedAt ? `更新 ${displayShortDateTime(generatedAt)}` : "未生成"}</small>
        </div>
        <div className="parity-ledger-list">
          {items.map((item) => (
            <article className="parity-ledger-row" key={String(item.capability)}>
              <div>
                <span className={`pill ${item.status}`}>{displayStatus(String(item.status))}</span>
                <strong>{String(item.capability)}</strong>
                <small>{String(item.currentSurface)}</small>
              </div>
              <div className="parity-ledger-facts">
                <div>
                  <span>実行</span>
                  <small>{item.executionBoundary ? "実行条件を確認済み" : "確認待ち"}</small>
                </div>
                <div>
                  <span>証跡</span>
                  <small>{item.latestProof ? "内部証跡あり" : "証跡待ち"}</small>
                </div>
                <div>
                  <span>次の追加</span>
                  <small>{item.nextSafeAddition ? "次の改善候補あり" : "未設定"}</small>
                </div>
              </div>
            </article>
          ))}
          {items.length === 0 && <Empty text="Codex App互換台帳はまだ生成されていません。" />}
        </div>
      </div>
    </Panel>
  );
}

function AutomationMigrationLedgerPanel({ summary, generatedAt }: { summary: Row; generatedAt: string }) {
  const total = Number(summary.total ?? 0);
  const migrated = Number(summary.migrated ?? 0);
  const scheduled = Number(summary.scheduledConfirmed ?? 0);
  const actual = Number(summary.actualConfirmed ?? 0);
  const confirmed = Number(summary.proofConfirmed ?? 0);
  const blocked = Number(summary.blocked ?? 0);
  return (
    <Panel title="移行状況" action={`${total}件`}>
      <div className="source-summary single">
        <div>
          <strong>{migrated}</strong>
          <span>移行済み</span>
          <small>登録済みの定期として扱えます</small>
        </div>
        <div>
          <strong>{scheduled}</strong>
          <span>予定確認</span>
          <small>予定からの実行を確認済み</small>
        </div>
        <div>
          <strong>{actual}</strong>
          <span>実行確認</span>
          <small>最新の実行が完了済み</small>
        </div>
        <div>
          <strong>{confirmed}</strong>
          <span>確認済み</span>
          <small>完了確認まで揃っています</small>
        </div>
        <div>
          <strong>{blocked}</strong>
          <span>要確認</span>
          <small>次の確認が必要です</small>
        </div>
      </div>
      <small>{generatedAt ? `更新 ${displayShortDateTime(generatedAt)}` : "未生成"}</small>
    </Panel>
  );
}

function BrowserUseResultPanel({ result }: { result: BrowserUseResult | null }) {
  if (!result) {
    return (
      <Panel title="画面確認" action="未実行">
        <Empty text="まだありません。" />
      </Panel>
    );
  }

  const laneLabel = displayBrowserUseLane(result);
  const cleanupLabel = displayCleanupStatus(result.cleanup);
  const evidenceCount = [result.screenshotPath, result.statePath, result.logPath].filter(Boolean).length;
  return (
    <Panel title="画面確認" action={displayStatus(result.check.status)}>
      <div className="browser-use-result">
        <div className="browser-use-result-head">
          <div>
            <span className={`pill ${result.check.status}`}>{displayStatus(result.check.status)}</span>
            <strong>{browserUseResultLine(result)}</strong>
            <small>{displayBridgeReceiptSummary(result.check.summary)} · {displayShortDateTime(result.check.created_at)}</small>
          </div>
          <Bot size={22} />
        </div>
        <div className="browser-use-result-grid">
          <div>
            <span>結果</span>
            <strong>{displayStatus(result.check.status)}</strong>
            <small>ローカル画面を確認しました</small>
          </div>
          <div>
            <span>保存</span>
            <strong>{evidenceCount}件</strong>
            <small>{publicEvidenceCopy(evidenceCount)}</small>
          </div>
          <div>
            <span>ブラウザ</span>
            <strong>{laneLabel}</strong>
            <small>接続情報は内部記録に保存済み</small>
          </div>
          <div>
            <span>片付け</span>
            <strong>{cleanupLabel}</strong>
            <small>片付け状態を記録済み</small>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function SkillsView(props: {
  runs: Row[];
  skills: Row[];
  selectedSkill?: Row;
  onSelectSkill: (skill: Row) => void;
  onCreate: (path: string, msg: string, options?: { view?: View; key?: string }) => Promise<void>;
  busyKey: string | null;
}) {
  const latestRun = props.runs[0];
  return (
    <section className="view-grid skills-view">
      <Panel title="スキル作成" action="最新実行から作成">
        <div className="skill-box">
          <div className="skill-copy">
            <Sparkles size={18} />
            <div>
              <strong>{latestRun?.name ?? "実行履歴がありません"}</strong>
              <small>確認済みの実行から、再利用できるスキル下書きを作れます。</small>
            </div>
          </div>
          <button disabled={!latestRun || props.busyKey === "skill"} onClick={() => latestRun && props.onCreate(`/api/skills/from-run/${latestRun.id}`, "スキル下書きを作成しました", { view: "Skills", key: "skill" })}>
            {props.busyKey === "skill" ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} 下書き作成
          </button>
        </div>
      </Panel>
      <Panel title="スキル下書き" action={`${props.skills.length}件`}>
        <div className="compact-list">
          {props.skills.map((skill) => (
            <button className="list-row button-row" key={skill.id} onClick={() => props.onSelectSkill(skill)}>
              <FileText size={17} />
              <div>
                <strong>{skill.name}</strong>
                <small>{compactId(skill.run_id)} · {skill.created_at?.slice(0, 19)}</small>
              </div>
              <Eye size={15} />
            </button>
          ))}
          {props.skills.length === 0 && <Empty text="スキル下書きはまだありません。" />}
        </div>
        {props.selectedSkill && <MarkdownPreview markdown={props.selectedSkill.draft_markdown ?? props.selectedSkill.markdown} />}
      </Panel>
    </section>
  );
}

function RunSummary({
  run,
  meta,
  proofCount = 0,
  stepCount = 0,
  eventCount = 0,
  workerEvents = [],
  localWorker = {},
  firstProof,
  onOpen,
  onRefresh,
  onOpenProof,
  onOpenApprovals,
  onContinueInCreate,
  emptyText = "実行は選択されていません。"
}: {
  run?: Row;
  meta: Row;
  proofCount?: number;
  stepCount?: number;
  eventCount?: number;
  workerEvents?: Row[];
  localWorker?: Row;
  firstProof?: Row;
  onOpen?: () => void;
  onRefresh?: () => void;
  onOpenProof?: () => void;
  onOpenApprovals?: () => void;
  onContinueInCreate?: () => void;
  emptyText?: string;
}) {
  if (!run) return <Empty text={emptyText} />;
  const proofGate = meta.proof_gate ?? {};
  const researchPlanSnapshot = asJson<Row>(meta.research_plan_snapshot, {});
  const hasResearchPlanSnapshot = typeof researchPlanSnapshot.id === "string";
  const contract = meta.run_contract_summary ?? meta.run_contract;
  const contractProgress = contract?.progress ?? {};
  const progressDone = Number(contractProgress.done);
  const progressTotal = Number(contractProgress.total);
  const hasProgress = Number.isFinite(progressDone) && Number.isFinite(progressTotal) && progressTotal > 0;
  const contractDone = hasProgress ? `${progressDone} / ${progressTotal}` : contractProgress.ok || proofGate.ok ? "完了" : "確認待ち";
  const progressPercent = hasProgress ? Math.round(Math.max(0, Math.min(100, (progressDone / progressTotal) * 100))) : proofGate.ok ? 100 : 0;
  const missingVisibleSteps: string[] = Array.isArray(contract?.missingVisibleSteps) ? contract.missingVisibleSteps.map(String) : [];
  const nextVisibleStep = typeof contract?.nextVisibleStep === "string" ? contract.nextVisibleStep : "";
  const displayNextStep = nextVisibleStep || (proofGate.ok ? "完了" : "確認待ち");
  const remainingSummary = missingVisibleSteps.length > 0 ? `残り ${missingVisibleSteps.length}件` : "残りなし";
  const disposition = classifyRun(run);
  const humanReport = buildRunHumanReport(run, meta, { proofCount, stepCount, eventCount, nextStep: displayNextStep });
  const followUpActions = buildRunFollowUpActions(run, meta, { proofCount, firstProof });
  const createOrigin = buildCreateOriginSummary(meta);
  const workerResult = buildWorkerResultSummary(workerEvents);
  const queuedWorkerBody = buildQueuedWorkerBody(localWorker);
  const decisionBanner = (() => {
    if (disposition.kind === "actionable") {
      return { tone: "actionable", title: "確認", body: `次: ${displayNextStep}` };
    }
    if (disposition.kind === "running") {
      return { tone: "actionable", title: "進行中", body: workerResult ? "Mac worker処理中" : queuedWorkerBody };
    }
    if (disposition.archiveReason === "receipt_only") {
      return { tone: "archive", title: "保存", body: "完了ではありません" };
    }
    if (disposition.archiveReason === "demo") {
      return { tone: "archive", title: "サンプル", body: "操作不要" };
    }
    if (disposition.kind === "archive") {
      return { tone: "archive", title: "古い履歴", body: "操作不要" };
    }
    return { tone: "completed", title: "完了", body: "操作不要" };
  })();
  return (
    <div className="run-summary">
      <div>
        <span className={`pill ${run.status}`}>{displayStatus(run.status)}</span>
        <h2>{displayTaskName(run.name)}</h2>
        <div className={`decision-banner ${decisionBanner.tone}`}>
          <strong>{decisionBanner.title}</strong>
          <span>{decisionBanner.body}</span>
        </div>
      </div>
      {contract && (
        <div className="run-focus">
          <div>
            <span>次の1ステップ</span>
            <strong>{displayNextStep}</strong>
            <small>{remainingSummary}</small>
          </div>
          <div className="run-progress" aria-label={`進捗 ${contractDone}`}>
            <span><i style={{ width: `${progressPercent}%` }} /></span>
            <em>{contractDone}</em>
          </div>
        </div>
      )}
      <div className="run-human-report" aria-label="実行レポート">
        <ReportItem label="結論" value={humanReport.conclusion} />
        <ReportItem label="見たもの" value={humanReport.seen} />
        <ReportItem label="実行したこと" value={humanReport.did} />
        <ReportItem label="止まった理由" value={humanReport.blocker} />
        <ReportItem label="証跡" value={humanReport.proof} />
        <ReportItem label="次の一手" value={humanReport.next} />
      </div>
      {createOrigin && (
        <section className="run-create-origin" aria-label="作るから渡された相談">
          <div>
            <span>作るで相談した内容</span>
            <strong>{createOrigin.title}</strong>
            <small>{createOrigin.questionCount > 0 ? `${createOrigin.questionCount}件のやりとりから作成` : "保存済み相談から作成"}</small>
          </div>
          <div>
            <span>workerが最初に見ること</span>
            <strong>{createOrigin.nextAction}</strong>
            {createOrigin.visibleSteps.length > 0 && (
              <ol>
                {createOrigin.visibleSteps.map((step, index) => (
                  <li key={`${step}-${index}`}>{step}</li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}
      {workerResult && (
        <section className={`run-worker-result ${workerResult.tone}`} aria-label="Mac workerの処理結果">
          <div>
            <span>Mac workerの処理結果</span>
            <strong>{workerResult.title}</strong>
            <small>{workerResult.detail}</small>
          </div>
          <div>
            <span>次に見ること</span>
            <strong>{workerResult.nextAction}</strong>
            <small>{workerResult.when}</small>
          </div>
        </section>
      )}
      {followUpActions.length > 0 && (
        <div className="run-follow-up-actions" aria-label="次にできる操作">
          {followUpActions.map((action) => {
            const Icon = action.icon;
            const handler = action.kind === "refresh"
              ? onRefresh
              : action.kind === "proof"
                ? onOpenProof
                : action.kind === "approval"
                  ? onOpenApprovals
                  : onContinueInCreate;
            return (
              <button className={action.primary ? "text-button primary" : "text-button"} type="button" key={action.kind} onClick={handler} disabled={!handler}>
                <Icon size={15} />
                {action.label}
              </button>
            );
          })}
        </div>
      )}
      {missingVisibleSteps.length > 0 && (
        <details className="remaining-steps">
          <summary>残り一覧</summary>
          <ol>
            {missingVisibleSteps.map((step, index) => (
              <li key={`${step}-${index}`}>{step}</li>
            ))}
          </ol>
        </details>
      )}
      {disposition.archiveReason === "receipt_only" && (
        <div className="warning-line">
          <AlertTriangle size={16} />
          <span>保存のみ</span>
        </div>
      )}
      <details className="internal-details run-meta-details">
        <summary>状態</summary>
        <div className="summary-grid">
          <Metric label="開始" value={run.created_at?.slice(0, 16) ?? "不明"} />
          {contract ? (
            <>
              <Metric label="モード" value={contract.beginnerLabel ?? contract.mode ?? "NisenPrints"} />
              <Metric label="完了" value={contractDone} warn={!proofGate.ok} />
            </>
          ) : (
            <>
              <Metric label="実行方式" value={displayWorkerMode(meta.worker_mode)} warn={meta.worker_mode === "receipt_only"} />
              <Metric label="確認" value={proofGate.ok ? "完了" : "途中"} warn={!proofGate.ok} />
              <Metric label="次" value={proofGate.ok ? "完了" : "確認待ち"} warn={!proofGate.ok} />
            </>
          )}
        </div>
      </details>
      {hasResearchPlanSnapshot && (
        <details className="internal-details remaining-steps research-plan-snapshot">
          <summary title="診断" aria-label="診断">
            <Database size={16} />
            <span className="sr-only">診断</span>
          </summary>
          <small>開始前計画: {String(researchPlanSnapshot.title ?? researchPlanSnapshot.command ?? researchPlanSnapshot.id)}</small>
          <small>この計画は完了証跡ではありません。完了判断は内部のDBと証跡で行います。</small>
          {Array.isArray(researchPlanSnapshot.visibleFlow) && (
            <ol>
              {researchPlanSnapshot.visibleFlow.map((item, index) => (
                <li key={`${item}-${index}`}>{String(item)}</li>
              ))}
            </ol>
          )}
        </details>
      )}
      {onOpen && <button className="text-button" onClick={onOpen}>詳細を見る <ChevronRight size={15} /></button>}
    </div>
  );
}

function buildQueuedWorkerBody(worker: Row) {
  const status = String(worker.status ?? "");
  const processed = Number(worker.processed ?? 0);
  if (status === "running") return "Mac worker処理中 / 順番待ち";
  if (status === "ok" && processed > 0) return "Mac worker確認中";
  if (status === "blocked") return "Mac worker確認が必要";
  return "Mac worker待ち";
}

function buildCreateOriginSummary(meta: Row) {
  if (meta.create_session_source !== "create_view") return null;
  const snapshot = asJson<Row>(meta.create_session_snapshot, {});
  const draft = asJson<Row>(snapshot.draft, {});
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const visibleSteps = Array.isArray(draft.visibleSteps)
    ? draft.visibleSteps.map((item) => displayCreatePlanText(String(item))).filter(Boolean).slice(0, 4)
    : [];
  const title = displayCreatePlanText(String(meta.create_session_title ?? snapshot.title ?? draft.title ?? "作るから開始した実行"));
  const nextAction = displayCreatePlanText(String(meta.create_session_next_action ?? draft.nextAction ?? visibleSteps[0] ?? "保存済み相談を読んで実行します。"));
  const questionCount = messages.filter((message) => asJson<Row>(message, {}).role === "user").length;
  if (!title && !nextAction && visibleSteps.length === 0) return null;
  return { title, nextAction, visibleSteps, questionCount };
}

function buildWorkerResultSummary(events: Row[]) {
  if (!events.length) return null;
  const latest = [...events]
    .filter((event) => ["worker_completed", "worker_blocked", "worker_started", "worker_once_blocked"].includes(String(event.event_type)))
    .sort((a, b) => Date.parse(String(b.created_at ?? "")) - Date.parse(String(a.created_at ?? "")))[0];
  if (!latest) return null;
  const eventType = String(latest.event_type ?? "");
  const meta = asJson<Row>(latest.metadata_json, {});
  const message = redactDisplayPaths(String(latest.message ?? ""));
  const adapterKey = String(meta.adapter ?? meta.worker_mode ?? meta.execution_mode ?? "");
  const adapter = adapterKey ? displayWorkerMode(adapterKey) : "";
  if (eventType === "worker_completed") {
    return {
      tone: "ok",
      title: "Mac workerが処理しました。",
      detail: adapter ? `${adapter}で処理記録を残しました。` : "処理記録を残しました。",
      nextAction: "証跡と不足している確認を見てください。",
      when: latest.created_at?.slice(0, 19) ?? "時刻不明"
    };
  }
  if (eventType === "worker_blocked" || eventType === "worker_once_blocked") {
    return {
      tone: "blocked",
      title: "Mac workerが途中で止まりました。",
      detail: workerEventBlockerSummary(meta, message),
      nextAction: "止まった理由を確認して、作るで続き相談してください。",
      when: latest.created_at?.slice(0, 19) ?? "時刻不明"
    };
  }
  return {
    tone: "running",
    title: "Mac workerが処理中です。",
    detail: adapter ? `${adapter}で確認しています。` : "処理を開始しました。",
    nextAction: "少し待ってから状態を更新してください。",
    when: latest.created_at?.slice(0, 19) ?? "時刻不明"
  };
}

function workerEventBlockerSummary(meta: Row, message: string) {
  const issueSummary = asJson<Row>(meta.issue_ledger_summary, {});
  const issueBlocker = String(issueSummary.latest_blocker ?? "");
  if (issueBlocker) return `問題記録: ${displayCreatePlanText(issueBlocker).replace(/[_:]/g, " ")}。`;
  const blocker = String(meta.exact_blocker ?? meta.exactBlocker ?? meta.blocker ?? message ?? "");
  if (/billing|purchase|payment|checkout|invoice|subscription/i.test(blocker)) return "課金・購入・支払いの確認前で止まっています。";
  if (/auth|login|captcha|otp|security|identity|human[_ -]?input/i.test(blocker)) return "ログインや本人確認など、人間の入力が必要です。";
  if (/missing|not[_ -]?configured|not[_ -]?connected|runner/i.test(blocker)) return "実行に必要な接続や設定が足りません。";
  if (/timeout|timed[_ -]?out/i.test(blocker)) return "時間内に確認が終わりませんでした。";
  return message || "停止理由を詳細に保存しています。";
}

function buildRunHumanReport(run: Row, meta: Row, counts: { proofCount: number; stepCount: number; eventCount: number; nextStep: string }) {
  const status = String(run.status ?? "");
  const blocker = String(meta.exact_blocker ?? meta.exactBlocker ?? meta.stop_reason ?? meta.error ?? "");
  const proofGate = meta.proof_gate ?? {};
  const ok = status === "completed" || proofGate.ok === true;
  const receiptOnly = meta.worker_mode === "receipt_only" || classifyRun(run).archiveReason === "receipt_only";
  const approvalWaiting = status === "waiting_approval" || status === "approval_required";
  const partial = status === "partial";
  const blocked = status === "blocked" || status === "failed" || Boolean(blocker);
  const missingLabels = missingProofLabels(proofGate);
  const issueSummary = asJson<Row>(meta.issue_ledger_summary, {});
  const issueCount = Number(issueSummary.count ?? 0);
  const latestIssue = String(issueSummary.latest_blocker ?? "");
  const conclusion = ok
    ? "完了として扱えます。"
    : approvalWaiting
      ? "あなたの確認待ちです。"
    : receiptOnly
      ? "保存だけの記録です。実行完了ではありません。"
      : partial
        ? "一部だけ確認できています。完了には不足分があります。"
      : blocked
        ? "途中で止まっています。"
        : "まだ確認中です。";
  const seen = counts.stepCount > 0 ? `${counts.stepCount}件の手順を確認しました。` : "確認した手順はまだありません。";
  const did = counts.eventCount > 0 ? `${counts.eventCount}件の実行記録があります。` : "実行記録はまだありません。";
  const proof = issueCount > 0
    ? `${issueCount}件の問題記録があります。${latestIssue ? `最新: ${displayCreatePlanText(latestIssue).replace(/[_:]/g, " ")}。` : ""}`
    : counts.proofCount > 0
    ? `${counts.proofCount}件の保存記録があります。`
    : missingLabels.length > 0
      ? `${missingLabels.slice(0, 2).join("、")}がまだ不足しています。`
      : "保存記録はまだありません。";
  const next = runNextActionSummary({ ok, approvalWaiting, receiptOnly, partial, blocked, nextStep: counts.nextStep, missingLabels });
  return {
    conclusion,
    seen,
    did,
    blocker: runBlockerSummary({ blocker, receiptOnly, approvalWaiting, partial, blocked, missingLabels }),
    proof,
    next
  };
}

type RunFollowUpAction = {
  kind: "refresh" | "proof" | "approval" | "create";
  label: string;
  icon: typeof RefreshCcw;
  primary?: boolean;
};

function buildRunFollowUpActions(run: Row, meta: Row, counts: { proofCount: number; firstProof?: Row }): RunFollowUpAction[] {
  const status = String(run.status ?? "");
  const proofGate = meta.proof_gate ?? {};
  const ok = status === "completed" || proofGate.ok === true;
  const receiptOnly = meta.worker_mode === "receipt_only" || classifyRun(run).archiveReason === "receipt_only";
  const approvalWaiting = status === "waiting_approval" || status === "approval_required";
  const actions: RunFollowUpAction[] = [];

  if (counts.proofCount > 0 && counts.firstProof) {
    actions.push({ kind: "proof", label: "保存記録を見る", icon: Eye, primary: ok });
  }
  if (approvalWaiting) {
    actions.push({ kind: "approval", label: "承認を確認", icon: ShieldCheck, primary: true });
  }
  if (!ok) {
    actions.push({ kind: "refresh", label: "状態を更新", icon: RefreshCcw, primary: actions.length === 0 && !receiptOnly });
    actions.push({ kind: "create", label: "作るで続き相談", icon: MessageCircle, primary: receiptOnly && actions.length === 1 });
  }
  return actions;
}

function missingProofLabels(proofGate: Row) {
  const missing = Array.isArray(proofGate.missing) ? proofGate.missing : [];
  return missing
    .map((item) => proofTypeLabels[String(item)] ?? displayCreatePlanText(String(item)).replace(/[_:]/g, " "))
    .map((item) => item.trim())
    .filter(Boolean);
}

function runBlockerSummary(input: {
  blocker: string;
  receiptOnly: boolean;
  approvalWaiting: boolean;
  partial: boolean;
  blocked: boolean;
  missingLabels: string[];
}) {
  if (input.approvalWaiting) return "承認画面であなたの確認が必要です。";
  if (input.receiptOnly) return "開始前の保存記録だけです。";
  if (input.missingLabels.length > 0) return `${input.missingLabels.slice(0, 3).join("、")}がまだ不足しています。`;
  const blocker = input.blocker.toLowerCase();
  if (/billing|purchase|payment|checkout|invoice|subscription/.test(blocker)) return "課金・購入・支払いの確認前で停止しています。";
  if (/auth|login|captcha|otp|security|identity|human_input/.test(blocker)) return "ログインや本人確認など、人間の入力が必要です。";
  if (/timeout|timed[_ -]?out|時間/.test(blocker)) return "時間内に確認が終わりませんでした。";
  if (/runner|not[_ -]?configured|not[_ -]?connected|missing/.test(blocker)) return "実行に使う接続やローカル作業環境の確認が必要です。";
  if (input.blocked) return "詳細に停止理由を保存しています。";
  if (input.partial) return "完了に必要な確認がまだ残っています。";
  return "明確な停止理由はまだありません。";
}

function runNextActionSummary(input: {
  ok: boolean;
  approvalWaiting: boolean;
  receiptOnly: boolean;
  partial: boolean;
  blocked: boolean;
  nextStep: string;
  missingLabels: string[];
}) {
  if (input.ok) return "追加操作は不要です。";
  if (input.approvalWaiting) return "承認画面で内容を確認してください。";
  if (input.receiptOnly) return "実行結果か手動確認の記録を追加してください。";
  if (input.missingLabels.length > 0) return `${input.missingLabels[0]}を確認してください。`;
  if (input.partial) return input.nextStep || "不足している確認を続けてください。";
  if (input.blocked) return input.nextStep || "詳細を開いて、止まった理由を確認してください。";
  return input.nextStep || "次に確認する手順を選びます。";
}

function buildRunContinuationPrompt(
  run: Row,
  meta: Row,
  counts: { proofCount: number; stepCount: number; eventCount: number; missingLabels: string[] }
) {
  const nextStep = String(meta.run_contract_summary?.nextVisibleStep ?? meta.run_contract?.nextVisibleStep ?? "");
  const report = buildRunHumanReport(run, meta, {
    proofCount: counts.proofCount,
    stepCount: counts.stepCount,
    eventCount: counts.eventCount,
    nextStep
  });
  const missing = counts.missingLabels.length ? counts.missingLabels.slice(0, 3).join("、") : "不足している確認は画面上では特定できていません";
  return [
    "履歴からの続き相談です。",
    `対象: ${displayTaskName(run.name)}`,
    `状態: ${displayStatus(run.status)}`,
    `結論: ${report.conclusion}`,
    `止まった理由: ${report.blocker}`,
    `証跡: ${report.proof}`,
    `不足している確認: ${missing}`,
    `次の一手: ${report.next}`,
    "実行タイミング: 手動開始で小さく再確認します。",
    "自動で進める範囲: このrunと同じ範囲で、課金・購入・支払い・決済だけ停止します。",
    "正本: 履歴、保存記録、画面で見える確認結果を使います。",
    "完了証拠: 不足している確認を新しい保存記録として残します。",
    "この実行結果を踏まえて、追加質問、修正した手順、再実行前の確認、次に押すボタンを整理してください。"
  ].join("\n");
}

function ReportItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={warn ? "warn" : ""}>{value}</strong>
    </div>
  );
}

function Panel({ title, action, actionLabel, children, onAction }: { title: string; action: string; actionLabel?: string; children: React.ReactNode; onAction?: () => void }) {
  return (
    <article className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <button onClick={onAction} disabled={!onAction} title={actionLabel ?? action} aria-label={actionLabel ?? action} className={action ? undefined : "icon-only"}>
          {action && <span>{action}</span>}
          <ChevronRight size={15} />
        </button>
      </div>
      {children}
    </article>
  );
}

function Timeline({ steps, emptyText = "まだ実行されていません。" }: { steps: Row[]; emptyText?: string }) {
  const visible = steps.slice(0, 12);
  return (
    <div className="timeline">
      {visible.length === 0 && <Empty text={emptyText} />}
      {visible.map((step) => {
        const meta = asJson<Row>(step.metadata_json, {});
        return (
          <div className="timeline-row" key={step.id}>
            <span className={`status-dot ${step.status}`} />
            <div>
              <strong>{displayTaskName(step.name)}</strong>
              <small>{displayStatus(step.status)} · {(meta.resources ?? []).length ? `${(meta.resources ?? []).length}件の作業対象` : "ローカル処理"}</small>
            </div>
            <time>{displayStepTime(step)}</time>
          </div>
        );
      })}
    </div>
  );
}

function LaneMatrix({ lanes, compact = false }: { lanes: Row[]; compact?: boolean }) {
  const visible = compact ? lanes.slice(0, 5) : lanes;
  return (
    <div className="table-wrap">
      <table className="lane-matrix-table">
        <thead>
          <tr>
            <th>レーン</th>
            <th>役割</th>
            <th>接続</th>
            <th>ブラウザ</th>
            <th>プロファイル</th>
            <th>可視性</th>
            <th>実行/更新</th>
            <th>状態</th>
            <th>作業</th>
            <th>進行</th>
            <th>健全性</th>
            <th>ロック</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((lane) => (
            <tr key={lane.id}>
              <td className="lane-cell"><strong>{displayLaneName(lane)}</strong><small>ID: {compactId(lane.id)}</small></td>
              <td>{displayLaneRole(String(lane.role ?? ""))}</td>
              <td className="lane-cell"><strong>{displayLaneConnection(lane)}</strong><small>接続先は内部管理</small></td>
              <td className="lane-cell lane-detail-cell">
                <strong>{displayLaneBrowserMode(lane)}</strong>
                <small>接続情報は内部記録に保存</small>
              </td>
              <td className="lane-cell lane-path-cell">
                <strong>{displayProfileStrategy(String(lane.profile_strategy ?? ""))}</strong>
                <small>プロファイルは内部管理</small>
              </td>
              <td><span className={`pill ${lane.lane_visibility || "missing"}`}>{displayLaneVisibility(String(lane.lane_visibility ?? ""))}</span></td>
              <td className="lane-cell lane-run-cell">
                <strong>{displayLaneRunName(lane)}</strong>
                <small>{displayShortDateTime(lane.updated_at)}</small>
                <small>{lane.run_id ? `run ${compactId(String(lane.run_id))}` : "run未設定"}</small>
              </td>
              <td><span className={`pill ${lane.status}`}>{displayStatus(lane.status)}</span></td>
              <td>{displayVisibleSummary(lane.current_task) || "待機中"}</td>
              <td><Progress value={lane.progress} /></td>
              <td>{displayStatus(lane.health)}</td>
              <td>{asJson<string[]>(lane.resource_locks_json, []).map(displayResource).join(", ") || "なし"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lanes.length === 0 && <Empty text="レーンはまだありません。" />}
    </div>
  );
}

function LaneFocusList({ lanes }: { lanes: Row[] }) {
  if (lanes.length === 0) {
    return <Empty text="要確認のレーンはありません。" />;
  }

  return (
    <div className="lane-focus-list">
      {lanes.map((lane) => (
        <article className="lane-focus-card" key={lane.id}>
          <div className="lane-focus-head">
            <strong>{displayLaneName(lane)}</strong>
            <span className={`pill ${lane.status}`}>{displayStatus(lane.status)}</span>
          </div>
          <span>{displayLaneRunName(lane)}</span>
          <small>{displayVisibleSummary(lane.current_task) || "待機中"}</small>
          <div className="lane-focus-meta">
            <span>{displayShortDateTime(lane.updated_at)}</span>
            <span>{displayStatus(lane.health)}</span>
            <Progress value={lane.progress} />
          </div>
        </article>
      ))}
    </div>
  );
}

function ResearchTable({ events }: { events: Row[] }) {
  return (
    <div className="compact-list">
      {events.slice(0, 8).map((event) => (
        <div className="list-row" key={event.id}>
          <Bot size={17} />
          <div>
            <strong>{event.topic}</strong>
            <small>{event.recommendation}</small>
          </div>
          <span>{Math.round(Number(event.confidence) * 100)}%</span>
        </div>
      ))}
      {events.length === 0 && <Empty text="調査メモはまだありません。" />}
    </div>
  );
}

function BridgeActionList({
  actions,
  receipts,
  onRun,
  busyKey
}: {
  actions: Row[];
  receipts: Row[];
  onRun: (id: string) => void;
  busyKey: string | null;
}) {
  const latestByCapability = new Map<string, Row>();
  for (const receipt of receipts) {
    if (!latestByCapability.has(String(receipt.capability_id))) {
      latestByCapability.set(String(receipt.capability_id), receipt);
    }
  }
  return (
    <div className="compact-list">
      {actions.map((action) => {
        const latest = latestByCapability.get(action.id);
        const protectedAction = action.status === "approval_required";
        return (
          <div className="bridge-row" key={action.id}>
            <div>
              <strong>{action.label}</strong>
              <small>{action.visibleSummary}</small>
              {latest && <small>前回: {displayStatus(latest.status)} · {displayBridgeReceiptSummary(latest.summary)}</small>}
            </div>
            <button
              className={protectedAction ? "text-button danger" : "text-button compact"}
              disabled={busyKey === `bridge-${action.id}`}
              onClick={() => onRun(String(action.id))}
            >
              {busyKey === `bridge-${action.id}` ? <Loader2 size={14} className="spin" /> : protectedAction ? <ShieldCheck size={14} /> : <Play size={14} />}
              {protectedAction ? "承認へ進む" : action.buttonLabel ?? "実行"}
            </button>
          </div>
        );
      })}
      {actions.length === 0 && <Empty text="安全操作はまだありません。" />}
    </div>
  );
}

function BridgeExecutionList({ executions }: { executions: Row[] }) {
  return (
    <div className="compact-list">
      {executions.slice(0, 6).map((execution) => (
        <div className="list-row" key={execution.id}>
          <ShieldCheck size={17} />
          <div>
            <strong>{displayTaskName(execution.capability_id)}</strong>
            <small>{displayBridgeReceiptSummary(execution.summary)}</small>
          </div>
          <span>{displayStatus(execution.executor_status)}</span>
        </div>
      ))}
      {executions.length === 0 && <Empty text="外部実行はまだありません。" />}
    </div>
  );
}

function KnowledgeNotes({ notes }: { notes: Row[] }) {
  return (
    <div className="compact-list">
      {notes.map((note) => (
        <div className="list-row" key={note.id}>
          <Database size={17} />
          <div>
            <strong>{note.title}</strong>
            <small>{knowledgeNoteSummary(note)}</small>
          </div>
          <span>{note.updated_at?.slice(11, 16)}</span>
        </div>
      ))}
      {notes.length === 0 && <Empty text="知識メモはまだありません。" />}
    </div>
  );
}

function knowledgeNoteSummary(note: Row) {
  if (note.note_type === "credential_snapshot" || note.source_ref === "stored_secrets") {
    return "保存済みの認証情報があります。値は表示しません。";
  }
  return displayVisibleSummary(String(note.body ?? "").split("\n").find((line) => line.trim().startsWith("- "))?.replace(/^- /, "") ?? note.note_type);
}

function ApprovalQueue(props: {
  approvals: Row[];
  onDecision?: (path: string, msg: string, options?: { view?: View; key?: string }) => Promise<void>;
  busyKey?: string | null;
  full?: boolean;
}) {
  const pending = props.approvals.filter((approval) => approval.status === "pending");
  const visible = props.full ? pending : pending.slice(0, 5);
  return (
    <div className="approval-list">
      {visible.map((approval) => (
        <div className="approval" key={approval.id}>
          <div>
            <strong>{displayApprovalPublicTitle(approval)}</strong>
            <div className="approval-chip-row" aria-label="確認内容">
              <span className={`approval-chip ${displayApprovalActionTone(approval.action_kind)}`}>{displayApprovalActionLabel(approval)}</span>
              <span className="approval-chip boundary">{displayApprovalBoundaryLabel(approval)}</span>
              <span className="approval-chip execution">{displayApprovalExecutionLabel(approval)}</span>
            </div>
          </div>
          {approval.status === "pending" && approval.decision_enabled !== false && props.onDecision ? (
            <div className="approval-actions">
              <button title="承認" aria-label="承認" disabled={props.busyKey === `approve-${approval.id}`} onClick={() => props.onDecision?.(`/api/approvals/${approval.id}/approve`, "承認しました", { view: "Runs", key: `approve-${approval.id}` })}>
                <Check size={15} />
                承認
              </button>
              <button title="却下" aria-label="却下" disabled={props.busyKey === `reject-${approval.id}`} onClick={() => props.onDecision?.(`/api/approvals/${approval.id}/reject`, "却下しました", { view: "Approvals", key: `reject-${approval.id}` })}>
                <X size={15} />
                却下
              </button>
              <button title="取り消し" aria-label="取り消し" disabled={props.busyKey === `cancel-${approval.id}`} onClick={() => props.onDecision?.(`/api/approvals/${approval.id}/cancel`, "承認待ちを取り消しました", { view: "Approvals", key: `cancel-${approval.id}` })}>
                <Ban size={15} />
                取消
              </button>
            </div>
          ) : (
            <span className={`pill ${approval.status}`}>{displayStatus(approval.status)}</span>
          )}
        </div>
      ))}
      {visible.length === 0 && <Empty text={props.full ? "承認待ちはありません。" : "0"} />}
    </div>
  );
}

function displayApprovalPublicTitle(approval: Row) {
  if (typeof approval.task_label === "string" && approval.task_label.trim()) return `確認: ${approval.task_label.trim()}`;
  return displayApprovalTitle(typeof approval.title === "string" ? approval.title : undefined);
}

function displayApprovalActionLabel(approval: Row) {
  if (typeof approval.action_label === "string" && approval.action_label.trim()) return approval.action_label.trim();
  return "承認";
}

function displayApprovalBoundaryLabel(approval: Row) {
  if (typeof approval.boundary_label === "string" && approval.boundary_label.trim()) return approval.boundary_label.trim();
  return displayApprovalSubtitle(approval);
}

function displayApprovalExecutionLabel(approval: Row) {
  if (typeof approval.execution_label === "string" && approval.execution_label.trim()) return approval.execution_label.trim();
  return "未実行";
}

function displayApprovalActionTone(value: unknown) {
  const kind = String(value ?? "");
  if (/delete|purchase|auth|pii/.test(kind)) return "action-danger";
  if (/publish|submit|send|external/.test(kind)) return "action-external";
  return "action-approval";
}

function ReceiptTable({ proofs, onSelect }: { proofs: Row[]; onSelect?: (proof: Row) => void }) {
  return (
    <div className="compact-list">
      {proofs.slice(0, 10).map((proof) => (
        <button className="list-row button-row" key={proof.id} onClick={() => onSelect?.(proof)}>
          <FileCheck size={17} />
          <div>
            <strong>{proof.label}</strong>
            <small>{displayProofType(proof.proof_type)} · {proof.can_open ? "表示できます" : "保存記録あり"}</small>
          </div>
          <ChevronRight size={15} />
        </button>
      ))}
      {proofs.length === 0 && <Empty text="確認記録はまだありません。" />}
    </div>
  );
}

function ChildCodexRuns({ children }: { children: Row[] }) {
  return (
    <div className="compact-list child-codex-list">
      {children.map((child) => {
        const finished = child.exit_status == null ? "確認中" : "終了記録あり";
        return (
          <article className="list-row child-codex-row" key={child.id}>
            <Bot size={17} />
            <div>
              <strong>{displayStatus(child.status)} · 別のAI作業</strong>
              <small>{child.summary ? redactDisplayPaths(String(child.summary)) : "別のAI作業の結果待ちです"}</small>
              {child.blocker && <small>{displayBridgeReceiptSummary(String(child.blocker))}</small>}
              <small>指示文と結果の保存場所は内部記録に保存済みです。</small>
            </div>
            <span>{finished}</span>
          </article>
        );
      })}
      {children.length === 0 && <Empty text="この履歴には別のAI作業の結果はまだありません。保存記録だけの履歴とは別に表示します。" />}
    </div>
  );
}

function WorkerEvents({ events }: { events: Row[] }) {
  return (
    <div className="compact-list">
      {events.slice(0, 8).map((event) => (
        <div className="list-row" key={event.id}>
          <Activity size={17} />
          <div>
            <strong>{displayEventType(event.event_type)}</strong>
            <small>{redactDisplayPaths(String(event.message ?? ""))}</small>
          </div>
          <span>{event.created_at?.slice(11, 19)}</span>
        </div>
      ))}
      {events.length === 0 && <Empty text="処理ログはまだありません。" />}
    </div>
  );
}

function AssetInventory({ summary, assets }: { summary: Row[]; assets: Row[] }) {
  return (
    <div className="asset-grid">
      <div className="source-summary">
        {summary.map((source) => (
          <div key={source.source_type}>
            <strong>{source.count}</strong>
            <span>{displaySourceType(source.source_type)}</span>
            <small>{sourceTypeHelp(source.source_type)}</small>
          </div>
        ))}
        {summary.length === 0 && <Empty text="データはまだ取り込まれていません。" />}
      </div>
      <div className="asset-list">
        {assets.slice(0, 5).map((asset) => (
          <div key={asset.id}>
            <span>{displaySourceType(asset.kind)}</span>
            <strong>{asset.name}</strong>
            <small>詳細パスは内部で保持しています。</small>
          </div>
        ))}
        {assets.length > 5 && (
          <div>
            <span>内部データ</span>
            <strong>ほか {assets.length - 5} 件</strong>
            <small>必要なときだけバックエンドで参照します。</small>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailDrawer({
  proof,
  proofView,
  proofViewLoading,
  skill,
  onClose
}: {
  proof: Row | null;
  proofView: ProofView | null;
  proofViewLoading: boolean;
  skill: Row | null;
  onClose: () => void;
}) {
  return (
    <aside className="detail-drawer">
      <div className="drawer-head">
        <h2>{proof ? "確認記録の詳細" : "スキル下書き"}</h2>
        <button aria-label="詳細を閉じる" onClick={onClose}><X size={16} /></button>
      </div>
      {proof && (
        <div className="drawer-body">
          <div className="proof-human-summary">
            <span className="pill ok">{proofKindLabel(proofView)}</span>
            <strong>{proof.label || displayProofType(proof.proof_type)}</strong>
            <p>{proofConfirmationText(proof, proofView)}</p>
            <small>{proofPreviewSummary(proofView)}</small>
          </div>
          <div className="proof-fact-grid">
            <Metric label="種類" value={displayProofType(proof.proof_type)} />
            <Metric label="履歴" value={compactId(proof.run_id)} />
            <Metric label="サイズ" value={formatBytes(Number(proofView?.size_bytes ?? proof.size_bytes ?? 0))} />
            <Metric label="保存" value="保存記録あり" />
          </div>
          {proofViewLoading && <p>読み込んでいます...</p>}
          {!proofViewLoading && proofView?.status === "blocked" && (
            <p>{displayProofBlockedReason(proofView.blocked_reason)}</p>
          )}
          {!proofViewLoading && proofView?.status === "ok" && (
            <ProofPreview proofView={proofView} />
          )}
          {!proofViewLoading && !proofView && <p>表示できる内容はありません。</p>}
        </div>
      )}
      {skill && <MarkdownPreview markdown={skill.draft_markdown ?? skill.markdown} />}
    </aside>
  );
}

function ProofPreview({ proofView }: { proofView: ProofView }) {
  if (proofView.preview_kind === "image") {
    const dimensions = proofView.image?.width && proofView.image?.height
      ? `${proofView.image.width} x ${proofView.image.height}`
      : "寸法未取得";
    return (
      <div className="proof-preview proof-image-card">
        <div className="proof-image-placeholder" aria-hidden="true">
          <Image size={28} />
        </div>
        <div className="proof-preview-meta">
          <Metric label="形式" value={proofView.mime_type ?? "画像"} />
          <Metric label="画像" value={dimensions} />
          <p>画像本文は表示しません。保存形式・寸法・履歴との接続だけを確認できます。</p>
        </div>
      </div>
    );
  }
  if (typeof proofView.preview === "string" && proofView.preview.trim()) {
    return (
      <div className="proof-preview">
        <Metric label="形式" value={proofView.mime_type ?? "テキスト"} />
        <pre>{redactDisplayPaths(proofView.preview)}</pre>
        {proofView.truncated && <p>長い内容は省略しています。</p>}
      </div>
    );
  }
  return <p>表示できる preview はありません。</p>;
}

function displayProofBlockedReason(reason?: string) {
  const map: Record<string, string> = {
    absolute_path_requires_file_uri: "保存先の形式が安全条件に合わないため表示しません。",
    file_too_large: "ファイルが大きすぎるため表示しません。",
    file_unavailable: "保存記録のファイルを確認できません。",
    invalid_file_uri: "保存先の形式が正しくないため表示しません。",
    missing_file_reference: "表示できる保存先がありません。",
    not_a_file: "保存記録がファイルではないため表示しません。",
    path_not_allowed: "許可された保存領域の外なので表示しません。",
    remote_uri_not_allowed: "外部URLは表示しません。",
    tmp_path_not_allowed: "一時領域のファイルは表示しません。",
    unsupported_file_type: "この形式は preview 対象外です。",
    unsupported_uri_scheme: "この保存先形式は表示できません。"
  };
  return map[String(reason ?? "")] ?? "安全確認のため表示しません。";
}

function MarkdownPreview({ markdown }: { markdown?: string }) {
  return <pre className="markdown-preview">{markdown || "Markdown はまだありません。"}</pre>;
}

function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <span style={{ width: `${Math.max(0, Math.min(100, Number(value) || 0))}%` }} />
      <em>{value}%</em>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
