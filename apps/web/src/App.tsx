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

const subTabLabels = [
  ["定期実行", "automations"],
  ["保存情報", "memory"],
  ["Lane", "lanes"],
  ["パフォーマンス", "performance"],
  ["連携", "integrations"],
  ["成果物 / KPI", "artifacts"]
];

const writeTokenStorageKey = "automation-os-write-token";
var runtimeWriteToken = "";

function readWriteToken() {
  if (runtimeWriteToken.trim()) return runtimeWriteToken.trim();
  try {
    return (window.sessionStorage.getItem(writeTokenStorageKey) || "").trim();
  } catch {
    return runtimeWriteToken.trim();
  }
}

function persistWriteToken(value: string) {
  runtimeWriteToken = value.trim();
  try {
    const normalized = value.trim();
    window.sessionStorage.setItem(writeTokenStorageKey, normalized);
    window.localStorage.removeItem(writeTokenStorageKey);
  } catch {
    // ignore storage errors in read-only mode
  }
}

function clearWriteToken() {
  runtimeWriteToken = "";
  try {
    window.sessionStorage.removeItem(writeTokenStorageKey);
    window.localStorage.removeItem(writeTokenStorageKey);
  } catch {
    // ignore storage errors in read-only mode
  }
}

function withMvpApiHeaders(init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  const token = readWriteToken();
  if (token) headers.set("x-automation-os-token", token);
  return { ...init, headers };
}

async function mvpFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, withMvpApiHeaders(init));
}

function newIdempotencyKey(scope: string) {
  const nonce = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${nonce}`;
}

function stableIdempotencyKey(
  ref: { current: { fingerprint: string; key: string } | null },
  scope: string,
  fingerprint: string
) {
  if (!ref.current || ref.current.fingerprint !== fingerprint) {
    ref.current = { fingerprint, key: newIdempotencyKey(scope) };
  }
  return ref.current.key;
}

function redactSensitiveText(value: string) {
  return String(value || "")
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/(?:authorization|bearer|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|private[_-]?key|security[_-]?code|database[_-]?url|otp|recovery[_-]?code)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\b(?:sk-|xox|ghp_|eyJ)[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s,;]+/gi, "[redacted]")
    .replace(/BEGIN PRIVATE KEY[\s\S]*?END PRIVATE KEY/g, "[redacted]");
}

function redactDisplayPaths(value: unknown) {
  return redactSensitiveText(String(value ?? ""))
    .replace(/file:\/\/\/(?:Users|private|tmp)\/[^\n\r"'<>]+/gi, "[保存場所]")
    .replace(/\/Users\/[^\n\r"'<>]+/g, "[保存場所]")
    .replace(/(?:\/private)?\/tmp\/[^\n\r"'<>]+/g, "[保存場所]")
    .replace(/(?:Documents\/New project|data\/artifacts|artifacts\/|output\/playwright|\.playwright-cli)[^\n\r"'<>]*/gi, "[保存場所]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[外部リンク]");
}

function publicRunStatus(status: unknown) {
  const value = String(status ?? "").toLowerCase();
  if (value === "completed" || value === "success" || value === "succeeded") return "完了";
  if (value === "blocked" || value === "failed") return "要確認";
  if (value === "running") return "実行中";
  if (value === "queued" || value === "pending" || value === "waiting_approval") return "待機中";
  return "未確認";
}

function publicBlockerSummary(value: unknown) {
  if (!String(value ?? "").trim()) return "なし";
  const normalized = String(value).toLowerCase();
  if (normalized.includes("approval")) return "承認が必要です";
  if (normalized.includes("heartbeat") || normalized.includes("worker")) return "Mac側の接続確認が必要です";
  if (normalized.includes("chrome") || normalized.includes("browser")) return "Chrome接続の確認が必要です";
  if (normalized.includes("auth") || normalized.includes("login") || normalized.includes("credential")) return "ログイン確認が必要です";
  return "詳細確認が必要です";
}

function runDispositionRank(run: any) {
  const status = String(run?.status ?? "");
  if (status === "blocked" || status === "waiting_approval" || status === "approval_required") return 0;
  if (status === "running") return 1;
  if (status === "queued" || status === "pending") return 2;
  return 3;
}

function resolveSelectedRunId(current: string | null, runs: any[], actionableRuns: any[] = []): string | null {
  if (!runs.length) return null;
  if (current && runs.some((run) => run.id === current)) return current;
  const candidates = actionableRuns.length ? actionableRuns : runs;
  const latestRunId = [...candidates]
    .sort((a, b) => runDispositionRank(a) - runDispositionRank(b))[0]?.id;
  return typeof latestRunId === "string" ? latestRunId : null;
}

function newerRunSnapshot(detailRun: any, dashboardRun: any) {
  if (!detailRun) return dashboardRun ?? null;
  if (!dashboardRun) return detailRun;
  const detailTime = Date.parse(String(detailRun.updated_at ?? detailRun.created_at ?? "")) || 0;
  const dashboardTime = Date.parse(String(dashboardRun.updated_at ?? dashboardRun.created_at ?? "")) || 0;
  return dashboardTime >= detailTime ? dashboardRun : detailRun;
}

type AutomationRow = {
  id: string;
  project_id: string;
  revision: number;
  automation_type: string;
  name: string;
  desc: string;
  schedule: string;
  schedule_version: string;
  next_run_at: string;
  lane: string;
  last: string;
  status: Status;
};
type ScheduleKind = "manual" | "daily" | "weekly" | "cron";
type ScheduleDraft = {
  kind: ScheduleKind;
  expression: string;
  timezone: string;
  enabled: boolean;
};

function normalizeScheduleKind(value: unknown): ScheduleKind {
  return value === "manual" || value === "daily" || value === "weekly" || value === "cron" ? value : "daily";
}
type MvpState = {
  updated_at?: string;
  worker?: { id: string; status: string; heartbeat_at: string | null; queue_depth: number; last_run_id: string | null; heartbeat_age_seconds?: number | null; heartbeat_fresh?: boolean; readback_status?: string; exact_blocker?: string | null; next_action?: string; external_action_executed?: boolean };
  obsidian?: {
    ok?: boolean | null;
    enabled?: boolean;
    health?: "disabled" | "healthy" | "recovering" | "degraded" | "unknown";
    summary?: string;
    nextStep?: string;
    lastAttemptAt?: string | null;
    lastSuccessAt?: string | null;
    lastFailureAt?: string | null;
    lastError?: string | null;
    failureCount?: number;
    nextRecoveryAt?: string | null;
    reason?: string | null;
    generatedFileCheck?: {
      ok: boolean;
      checkedAt?: string | null;
      total?: number;
      missing?: string[];
      nonGenerated?: string[];
    };
  };
  persistence?: any;
  projects?: any[];
  companies?: any[];
  automations?: any[];
  presentation_profiles?: Array<{ id: string; kind: string; label: string; source?: string; revision?: number; exactBlocker?: string | null; purpose?: string; freshnessSlaMinutes?: number; browserUseLane?: string; stopBoundary?: string; primaryMetrics?: string[]; widgets?: string[]; preferredGrouping?: string; explanation?: string }>;
  browser_use_runtime?: { surface?: string; helper?: string; status?: string; exactBlocker?: string | null; fallbackPolicy?: string; contract?: string[]; lanes?: any[] };
  schedules?: any[];
  runs?: any[];
  jobs?: any[];
  job_attempts?: any[];
  schedule_occurrences?: any[];
  actionableRuns?: any[];
  proofs?: any[];
  approvals?: any[];
  project_memory?: any[];
  account_refs?: any[];
  builder_specs?: any[];
  audit_events?: any[];
  redaction_readback?: any;
  production_readiness_readback?: any;
  browserHealth?: {
    codexBrowserBridge?: {
      required: boolean;
      directCallableFromLocalApp: boolean;
      status: string;
      summary: string;
    };
    chromeExtension?: {
      status: string;
      exactBlocker: string | null;
      summary: string;
      nextAction: string;
      chromeBinary: string | null;
      cdpLaneConfigured: boolean;
    };
  };
  codexCapabilities?: {
    summary: {
      skills: number;
      agentSkills: number;
      plugins: number;
      automations: number;
      mcp: number;
    };
    browser?: CapabilitySurface;
    chrome?: CapabilitySurface;
    mcp?: CapabilitySurface;
    appServer?: CapabilitySurface;
    notes?: string[];
  };
  capabilityRouter?: {
    primaryAction?: string;
    counts?: { ready: number; partial: number; missing: number; gaps: number };
    recommendedRoutes?: Array<{
      id: string;
      label: string;
      status: string;
      lane: string;
      nextAction: string;
      authority?: string;
      proof?: string;
    }>;
    gapBacklog?: Array<{
      id: string;
      label: string;
      priority: string;
      status: string;
      nextAction: string;
    }>;
  };
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
  feedback_summary?: {
    source?: string;
    captured_at?: string;
    count?: number;
    open_count?: number;
    triaged_count?: number;
  };
};

type MvpLoadStatus = "loading" | "ready" | "error";

type RunDetail = {
  run: any;
  steps: any[];
  proofs: any[];
  children: any[];
  workerEvents: any[];
};

type ProofView = {
  id: string;
  run_id?: string;
  proof_type?: string;
  label?: string;
  created_at?: string;
  status: "ok" | "blocked" | "not_found";
  preview_kind?: "text" | "json" | "image" | "unsupported";
  preview?: string;
  blocked_reason?: string;
  truncated?: boolean;
  image?: { width?: number; height?: number; mime_type?: string };
};

type CapabilitySurface = {
  id: string;
  name: string;
  path: string;
  status: string;
  kind: string;
  state: {
    configured: boolean;
    enabled: boolean;
    verified: boolean;
    connected: boolean;
  };
};

const defaultCapabilitySurfaceState = {
  configured: false,
  enabled: false,
  verified: false,
  connected: false
} as const;

function getCapabilitySurfaceState(surface?: CapabilitySurface) {
  return surface?.state ?? defaultCapabilitySurfaceState;
}

function getCapabilitySurfaceStatus(surface?: CapabilitySurface) {
  const state = getCapabilitySurfaceState(surface);
  return state.connected ? "connected" : state.verified ? "verified" : "requires_bridge";
}

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
      stored: false,
      label: "unknown",
      blocker: "mac_worker_state_missing",
      nextAction: "MVP stateを再読込してworker状態を確認してください。",
      display: "worker=unknown / blocker=mac_worker_state_missing"
    };
  }
  const storedReadback = worker.readback_status === "stored";
  const blocker = worker.exact_blocker ?? (worker.heartbeat_fresh === false && !storedReadback
    ? worker.readback_status === "heartbeat_missing" ? "mac_worker_heartbeat_missing" : "mac_worker_heartbeat_stale"
    : null);
  const nextAction = worker.next_action ?? (blocker
    ? "Mac worker laneを起動してheartbeat/readbackを更新してください。"
    : storedReadback
      ? "APIに保存されたqueue状態です。Mac workerのheartbeatは別readbackで確認します。"
      : "worker heartbeatはfreshです。各workflowのauth/readback境界を取るまでqueued jobは処理しません。");
  return {
    fresh: worker.heartbeat_fresh === true,
    stored: storedReadback,
    label: storedReadback ? "API保存済み（heartbeat未確認）" : worker.readback_status ?? "unknown",
    blocker,
    nextAction,
    display: blocker ? `blocker=${blocker} / 次: ${nextAction}` : storedReadback ? `readback=stored / 次: ${nextAction}` : `heartbeat=${worker.readback_status ?? "unknown"} / 次: ${nextAction}`
  };
}

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
  planner_operation: "create_automation" | "manage_workflow" | "answer_question";
  project_id: string;
  automation_type: string;
  plan: AutomationPlan;
  exact_blocker: string | null;
  can_create: boolean;
  creation_blocker: string | null;
  server_reply: string;
  chat_job_id?: string;
  chat_thread_id?: string | null;
  chat_turn_id?: string | null;
  chat_status?: string;
  chat_stream_text?: string;
  chat_events?: PlannerEvent[];
  proposed_changes?: PlannerChange[];
  requires_confirmation?: string[];
};

type PlannerChange = {
  target: string;
  field: string;
  before?: string;
  after: string;
};

type PlannerEvent = {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  status?: string;
  capturedAt?: string;
};

type PlannerProgress = {
  jobId: string;
  status: string;
  threadId?: string;
  turnId?: string;
  streamText: string;
  events: PlannerEvent[];
};

type ServerPlannerResult = {
  source?: string;
  intent?: "answer_question" | "plan_workflow";
  operation?: "create_automation" | "manage_workflow" | "answer_question";
  exactBlocker?: string;
  model?: string;
  title?: string;
  reply?: string;
  visibleSteps?: string[];
  openQuestions?: string[];
  nextAction?: string;
  executionDecision?: string;
  proposedChanges?: PlannerChange[];
  requiresConfirmation?: string[];
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

function normalizeApprovalStatus(status: string): Status {
  if (status === "waiting" || status === "pending") return "waiting";
  if (status === "rejected") return "blocked";
  return "approved";
}

function isApprovalWaiting(status: unknown): boolean {
  return status === "waiting" || status === "pending";
}

function detectSchedule(text: string) {
  const hourMatch = text.match(/(\d{1,2})\s*時/);
  const hour = hourMatch ? Math.max(0, Math.min(23, Number(hourMatch[1]))) : text.includes("夕方") ? 18 : text.includes("夜") ? 20 : 9;
  const cadence = text.includes("毎週") ? "weekly" : text.includes("毎月") ? "monthly" : "daily";
  if (cadence === "monthly") return { schedule: `0 ${hour} 1 * *`, cadence };
  if (cadence === "weekly") {
    const weekday = /(?:毎週|週).*(?:日曜|日曜日)/u.test(text) ? "SUN"
      : /(?:毎週|週).*(?:月曜|月曜日)/u.test(text) ? "MON"
        : /(?:毎週|週).*(?:火曜|火曜日)/u.test(text) ? "TUE"
          : /(?:毎週|週).*(?:水曜|水曜日)/u.test(text) ? "WED"
            : /(?:毎週|週).*(?:木曜|木曜日)/u.test(text) ? "THU"
              : /(?:毎週|週).*(?:金曜|金曜日)/u.test(text) ? "FRI"
                : /(?:毎週|週).*(?:土曜|土曜日)/u.test(text) ? "SAT" : "MON";
    return { schedule: `${weekday} ${String(hour).padStart(2, "0")}:00`, cadence };
  }
  return { schedule: `${String(hour).padStart(2, "0")}:00`, cadence };
}

function scheduleKindForPlan(plan: AutomationPlan): ScheduleKind {
  if (plan.cadence === "weekly") return "weekly";
  if (plan.cadence === "monthly") return "cron";
  return "daily";
}

function buildAutomationPlan(prompt: string, selectedPlatforms: string[]): AutomationPlan {
  const lower = prompt.toLowerCase();
  const { schedule, cadence } = detectSchedule(prompt);
  const wantsLine = prompt.includes("LINE") || prompt.includes("Line") || prompt.includes("ライン") || lower.includes("line");
  const wantsNotify = prompt.includes("通知") || prompt.includes("知らせ") || prompt.includes("送って") || prompt.includes("連絡") || lower.includes("notify") || lower.includes("alert") || lower.includes("webhook") || lower.includes("slack");
  const wantsNews = prompt.includes("最新") || prompt.includes("ニュース") || prompt.includes("探して") || prompt.includes("調べ") || prompt.includes("まとめ") || lower.includes("google") || lower.includes("web") || lower.includes("news");
  const wantsAi = prompt.includes("AI") || lower.includes("ai");
  if ((lower.includes("gmail") || prompt.includes("メール") || prompt.includes("問い合わせ") || prompt.includes("返信"))
    && !prompt.includes("DM返信")
    && !prompt.includes("ダイレクトメッセージ")
    && !lower.includes("dm reply")
    && !lower.includes("dm-reply")) {
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
  if (prompt.includes("フィードバック") || lower.includes("feedback")) {
    return {
      kind: "フィードバック",
      title: "フィードバック収集 自動化プラン",
      schedule,
      cadence,
      targetLabel: "Feedback / Support",
      steps: ["フィードバックの入力元を確認", "重複と個人情報の混入を検査", "内容を分類", "優先度と担当先を整理", "triage待ちで停止", "readbackと証跡を保存"],
      questions: ["フィードバックの入力元", "triage時の承認条件"],
      safetyNote: "収集と分類までは進めますが、外部送信や公開は承認まで実行しません。",
      approvalPolicy: "required_before_external_send"
    };
  }
  if (prompt.includes("DM返信") || prompt.includes("ダイレクトメッセージ") || lower.includes("dm reply") || lower.includes("dm-reply")) {
    return {
      kind: "DM返信",
      title: "DM返信 自動化プラン",
      schedule,
      cadence,
      targetLabel: "SNS DM",
      steps: ["受信DMを確認", "返信候補を生成", "個人情報とsecret混入を検査", "返信下書きを作成", "承認待ちで停止", "送信結果と証跡を保存"],
      questions: ["対象アカウント", "送信前の承認条件"],
      safetyNote: "DM送信は承認まで実行しません。",
      approvalPolicy: "required_before_external_send"
    };
  }
  if (prompt.includes("広告投稿") || prompt.includes("広告") || lower.includes("ads")) {
    return {
      kind: "広告投稿",
      title: "広告投稿 自動化プラン",
      schedule,
      cadence,
      targetLabel: "広告アカウント",
      steps: ["キャンペーン素材を確認", "投稿先アカウントを確認", "広告文案を作成", "配信条件と予算を検査", "承認待ちで停止", "配信結果と証跡を保存"],
      questions: ["広告アカウント", "配信前の承認条件"],
      safetyNote: "広告出稿は承認まで実行しません。",
      approvalPolicy: "required_before_external_post"
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
  if (kind === "sns-post" || kind === "SNS投稿") return "sns-post";
  if (kind === "メール返信") return "gmail-reply";
  if (kind === "gmail-reply") return "gmail-reply";
  if (kind === "リサーチ") return "research-report";
  if (kind === "research-report") return "research-report";
  if (kind === "情報収集・通知") return "research-notification";
  if (kind === "research-notification") return "research-notification";
  if (kind === "Daily AI") return "daily-ai";
  if (kind === "daily-ai") return "daily-ai";
  if (kind === "NisenPrints") return "nisenprints";
  if (kind === "nisenprints") return "nisenprints";
  if (kind === "Codex Job Manager") return "codex-job-manager";
  if (kind === "codex-job-manager") return "codex-job-manager";
  if (kind === "回答のみ") return "answer-only";
  if (kind === "answer-only") return "answer-only";
  if (kind === "フィードバック") return "feedback";
  if (kind === "feedback") return "feedback";
  if (kind === "DM返信") return "dm-reply";
  if (kind === "dm-reply") return "dm-reply";
  if (kind === "広告投稿") return "ads";
  if (kind === "ads") return "ads";
  return "sns-post";
}

function explicitAutomationTypeFromPrompt(prompt: string): string | null {
  const normalized = prompt.toLowerCase();
  if (/daily\s*ai|デイリーai/u.test(normalized)) return "daily-ai";
  if (/nisenprints|printify|etsy|pinterest/u.test(normalized)) return "nisenprints";
  if (/job manager|求人|応募/u.test(normalized)) return "codex-job-manager";
  if (/gmail|メール返信/u.test(normalized)) return "gmail-reply";
  if (/dm返信|ダイレクトメッセージ/u.test(normalized)) return "dm-reply";
  if (/フィードバック/u.test(normalized)) return "feedback";
  if (/広告/u.test(normalized)) return "ads";
  if (/line|webhook|通知/u.test(normalized)) return "research-notification";
  if (/リサーチ|調査|レポート/u.test(normalized)) return "research-report";
  if (/sns|instagram|tiktok|facebook|linkedin|\bx\b|投稿/u.test(normalized)) return "sns-post";
  return null;
}

type BuilderConfig = {
  kindLabel: string;
  automationName: string;
  approvalPolicy: string;
  steps: string[];
  inputSources: string;
  outputs: string;
  riskBoundary: string;
};

const builderConfigs: Record<string, BuilderConfig> = {
  "sns-post": {
    kindLabel: "SNS投稿",
    automationName: "SNS投稿",
    approvalPolicy: "required_before_external_post",
    steps: ["素材の取得元を確認", "投稿文と画像候補を作成", "SNSの下書きに変換", "外部投稿前に承認で停止", "承認後の実行Laneを割り当て", "実行結果とURLを保存", "失敗時の再試行条件を記録"],
    inputSources: "Google Drive / スプレッドシート / ブランドガイドライン / Plugin output",
    outputs: "SNS投稿レポート / 投稿ログ / Artifact",
    riskBoundary: "投稿、DM送信、メール送信、LINE/Webhook/外部通知、広告出稿、課金生成、削除は承認必須です。"
  },
  feedback: {
    kindLabel: "フィードバック",
    automationName: "フィードバック",
    approvalPolicy: "required_before_external_send",
    steps: ["フィードバックの入力元を確認", "重複と個人情報の混入を検査", "内容を分類", "優先度と担当先を整理", "triage待ちで停止", "readbackと証跡を保存"],
    inputSources: "フィードバックフォーム / 画面コメント / API readback / Project Memory",
    outputs: "フィードバック一覧 / triage queue / screenshot proof / Artifact",
    riskBoundary: "外部送信、公開、削除、本人確認、認証突破は承認必須です。"
  },
  "dm-reply": {
    kindLabel: "DM返信",
    automationName: "DM返信",
    approvalPolicy: "required_before_external_send",
    steps: ["受信DMを確認", "返信候補を生成", "個人情報とsecret混入を検査", "返信下書きを作成", "承認待ちで停止", "送信結果と証跡を保存"],
    inputSources: "SNS DM / 受信箱 / Project Memory / 返信テンプレート",
    outputs: "返信下書き / 承認ログ / 送信証跡 / Artifact",
    riskBoundary: "DM送信、返信公開、削除、本人確認、認証突破は承認必須です。"
  },
  ads: {
    kindLabel: "広告投稿",
    automationName: "広告投稿",
    approvalPolicy: "required_before_external_post",
    steps: ["キャンペーン素材を確認", "投稿先アカウントを確認", "広告文案を作成", "配信条件と予算を検査", "承認待ちで停止", "配信結果と証跡を保存"],
    inputSources: "広告アカウント / キャンペーン素材 / Project Memory / 予算メモ",
    outputs: "広告下書き / 承認ログ / 配信前チェック / Artifact",
    riskBoundary: "広告配信開始、出稿、支払い、削除、認証突破は承認必須です。"
  },
  "gmail-reply": {
    kindLabel: "メール返信",
    automationName: "Gmail返信",
    approvalPolicy: "required_before_external_send",
    steps: ["対象メールを抽出", "返信案を生成", "個人情報とsecretを検査", "下書き作成", "承認待ち", "メール送信", "送信レポート保存"],
    inputSources: "Gmail / Project Memory / 承認メモ",
    outputs: "返信下書き / 承認ログ / 送信証跡",
    riskBoundary: "メール送信は承認まで実行しません。"
  },
  "research-report": {
    kindLabel: "リサーチ",
    automationName: "リサーチレポート",
    approvalPolicy: "required_before_external_publish",
    steps: ["調査対象を確認", "参照元を収集", "要点を整理", "レポート下書き作成", "レビュー待ち", "成果物保存", "引用元レポート保存"],
    inputSources: "Web / Google Drive / Sheets / Project Memory",
    outputs: "調査レポート / 引用元一覧 / Artifact",
    riskBoundary: "外部投稿や送信は含めず、成果物保存前に確認します。"
  },
  "research-notification": {
    kindLabel: "情報収集・通知",
    automationName: "AI最新情報 LINE通知",
    approvalPolicy: "required_before_external_notification",
    steps: ["通知条件と情報源を確認", "Google/Webから最新情報候補を収集", "重複・古い情報・信頼性の低い情報を除外", "重要ポイントを短く要約", "通知文の下書きを作成", "LINE/Webhook/外部通知送信前に承認で停止", "readbackと証跡を保存"],
    inputSources: "Google検索 / Web / Project Memory / LINE接続情報",
    outputs: "要約 / LINE通知下書き / 承認ログ / Artifact",
    riskBoundary: "LINE/Webhook/外部通知は承認まで実行しません。"
  },
  "daily-ai": {
    kindLabel: "Daily AI",
    automationName: "Daily AI",
    approvalPolicy: "required_before_external_post",
    steps: ["AIニュース候補を読む", "投稿案を作成", "重複投稿を確認", "SNS/Sheets証跡を確認", "外部投稿前に承認で停止", "cleanupを保存"],
    inputSources: "ニュースソース / Project Memory / Sheets / SNS account readback",
    outputs: "投稿下書き / 投稿直前停止receipt / Sheets同期証跡 / Artifact",
    riskBoundary: "SNS投稿、外部通知、削除、認証突破は承認必須です。投稿直前で停止します。"
  },
  nisenprints: {
    kindLabel: "NisenPrints",
    automationName: "NisenPrints",
    approvalPolicy: "required_before_external_publish",
    steps: ["新規トピック重複確認", "Canva/画像素材確認", "Printify商品準備", "Etsy listing確認", "Pinterestリンク確認", "公開/削除/支払い境界で停止", "manifestとreadbackを保存"],
    inputSources: "Canva / Printify / Etsy / Pinterest / 商品manifest",
    outputs: "商品準備manifest / 既存ID readback / 公開直前停止receipt / Artifact",
    riskBoundary: "商品作成、公開、Pin投稿、削除、支払い、checkout、認証突破は承認必須です。既存IDを保持して直前停止します。"
  },
  "codex-job-manager": {
    kindLabel: "Codex Job Manager",
    automationName: "Codex Job Manager",
    approvalPolicy: "required_before_external_submit",
    steps: ["求人キューを読む", "候補URLと会社名を確認", "応募前フォームを準備", "送信/assessment/本人確認の前で停止", "証跡とcleanupを保存"],
    inputSources: "求人キュー / 会社URL / 応募フォームreadback / Project Memory",
    outputs: "求人候補一覧 / 応募直前停止receipt / 会社URL・入力内容証跡 / Artifact",
    riskBoundary: "応募submit、assessment/test、本人確認、メール認証、個人情報送信は承認必須です。送信直前で停止します。"
  },
  "answer-only": {
    kindLabel: "回答のみ",
    automationName: "回答のみ",
    approvalPolicy: "auto_allowed_for_draft_only",
    steps: ["質問意図を確認", "回答草案を作成", "外部操作を伴わないことを確認", "結果を保存"],
    inputSources: "チャット入力 / Project Memory",
    outputs: "回答草案 / 参照メモ / Artifact",
    riskBoundary: "外部送信、投稿、購入、認証突破は行いません。"
  }
};

function builderConfigForAutomationType(type: string): BuilderConfig {
  return builderConfigs[type] ?? builderConfigs["sns-post"];
}

async function requestChatPlan(
  prompt: string,
  selectedPlatforms: string[],
  options: { projectId?: string; messages?: ChatMessage[]; threadId?: string; onProgress?: (progress: PlannerProgress) => void } = {}
): Promise<PlannerReadback> {
  const conversation = (options.messages?.length ? options.messages : [{ id: "current", role: "user" as const, text: prompt }])
    .map((message) => ({ role: message.role, text: message.text }));
  const response = await mvpFetch("/api/create/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: conversation,
      currentDraft: prompt,
      project_id: options.projectId,
      codex_thread_id: options.threadId
    })
  });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    job?: PlannerJobReadback;
  } | null;
  if (!response.ok || body?.ok !== true || !body.job?.id) {
    throw new Error("planner_readback_unavailable");
  }
  let job = body.job;
  options.onProgress?.(plannerProgressFromJob(body.job.id!, job));
  for (let attempt = 0; attempt < 90 && job.status !== "completed" && job.status !== "blocked"; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    const poll = await mvpFetch(`/api/create/plan/jobs/${encodeURIComponent(body.job.id)}`, { cache: "no-store" });
    const pollBody = await poll.json().catch(() => null) as { ok?: boolean; job?: PlannerJobReadback } | null;
    if (!poll.ok || pollBody?.ok !== true || !pollBody.job) throw new Error("planner_job_readback_unavailable");
    job = pollBody.job;
    options.onProgress?.(plannerProgressFromJob(body.job.id!, job));
  }
  if (job.status !== "completed" || !job.result || typeof job.result.title !== "string") {
    throw new Error(job.exactBlocker || "codex_app_server_unavailable");
  }
  const serverPlan = job.result;
  const explicitAutomationType = explicitAutomationTypeFromPrompt(prompt);
  const productDefaults = buildAutomationPlan(prompt, selectedPlatforms);
  const productConfig = builderConfigForAutomationType(explicitAutomationType ?? "answer-only");
  const steps = Array.isArray(serverPlan.visibleSteps) && serverPlan.visibleSteps.length
    ? serverPlan.visibleSteps.filter((step): step is string => typeof step === "string" && Boolean(step.trim()))
    : serverPlan.operation === "create_automation" ? productDefaults.steps : [];
  const questions = Array.isArray(serverPlan.openQuestions)
    ? serverPlan.openQuestions.filter((question): question is string => typeof question === "string" && Boolean(question.trim()))
    : [];
  const canCreate = serverPlan.operation === "create_automation"
    && serverPlan.intent === "plan_workflow"
    && serverPlan.executionDecision !== "ask_more"
    && questions.length === 0
    && explicitAutomationType !== null;
  return {
    ok: true,
    planner_adapter: serverPlan.source ?? "server_planner",
    planner_mode: serverPlan.executionDecision ?? "server_readback",
    planner_model_ref: serverPlan.model ?? null,
    planner_schema_version: "create-plan-v1",
    planner_operation: serverPlan.operation ?? "answer_question",
    project_id: projectSlugFromPrompt(prompt),
    automation_type: explicitAutomationType ?? "answer-only",
    plan: {
      ...productDefaults,
      title: serverPlan.title!,
      kind: explicitAutomationType ? productConfig.kindLabel : serverPlan.title!,
      targetLabel: explicitAutomationType ? productDefaults.targetLabel : "会社内の作業",
      approvalPolicy: explicitAutomationType ? productConfig.approvalPolicy : "not_applicable",
      steps,
      questions,
      safetyNote: explicitAutomationType ? productConfig.riskBoundary : ""
    },
    exact_blocker: serverPlan.exactBlocker ?? null,
    can_create: canCreate,
    creation_blocker: canCreate ? null : questions.length
      ? "確認事項への回答が必要です"
      : serverPlan.operation !== "create_automation"
        ? "新規自動化の作成依頼として確認できませんでした"
      : explicitAutomationType === null
        ? "自動化の種類を明記してください"
        : "実行可能な自動化プランとして確認できませんでした",
    server_reply: serverPlan.reply?.trim() || serverPlan.nextAction?.trim() || "プランを確認しました。",
    chat_job_id: body.job.id,
    chat_thread_id: typeof job.metadata?.codexThreadId === "string" ? job.metadata.codexThreadId : null,
    chat_turn_id: typeof job.metadata?.codexTurnId === "string" ? job.metadata.codexTurnId : null,
    chat_status: job.status,
    chat_stream_text: typeof job.metadata?.streamText === "string" ? job.metadata.streamText : "",
    chat_events: plannerProgressFromJob(body.job.id!, job).events,
    proposed_changes: Array.isArray(serverPlan.proposedChanges) ? serverPlan.proposedChanges : [],
    requires_confirmation: Array.isArray(serverPlan.requiresConfirmation) ? serverPlan.requiresConfirmation : []
  };
}

type PlannerJobReadback = {
  id?: string;
  status?: string;
  result?: ServerPlannerResult;
  exactBlocker?: string;
  metadata?: Record<string, unknown>;
};

function plannerProgressFromJob(jobId: string, job: PlannerJobReadback): PlannerProgress {
  const events = Array.isArray(job.metadata?.events)
    ? job.metadata.events
      .filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object")
      .map((event) => ({
        method: typeof event.method === "string" ? event.method : "unknown",
        ...(typeof event.threadId === "string" ? { threadId: event.threadId } : {}),
        ...(typeof event.turnId === "string" ? { turnId: event.turnId } : {}),
        ...(typeof event.itemId === "string" ? { itemId: event.itemId } : {}),
        ...(typeof event.delta === "string" ? { delta: event.delta } : {}),
        ...(typeof event.status === "string" ? { status: event.status } : {}),
        ...(typeof event.capturedAt === "string" ? { capturedAt: event.capturedAt } : {})
      }))
      .slice(-8)
    : [];
  return {
    jobId,
    status: typeof job.status === "string" ? job.status : "unknown",
    threadId: typeof job.metadata?.codexThreadId === "string" ? job.metadata.codexThreadId : undefined,
    turnId: typeof job.metadata?.codexTurnId === "string" ? job.metadata.codexTurnId : undefined,
    streamText: typeof job.metadata?.streamText === "string" ? job.metadata.streamText : "",
    events
  };
}

function plannerProgressLabel(status: string): string {
  if (status === "queued") return "Mac worker待機中";
  if (status === "running") return "Codex App Serverで処理中";
  if (status === "completed") return "回答を受信しました";
  if (status === "blocked") return "処理が停止しました";
  return "状態を確認中";
}

function plannerEventLabel(method: string): string {
  if (method === "item/agentMessage/delta") return "回答を受信中";
  if (method === "item/completed") return "回答項目を完了";
  if (method === "turn/completed") return "turn完了";
  if (method === "thread/started") return "thread開始";
  return method;
}

function ChatProgressPanel({ progress, planning }: { progress: PlannerProgress | null; planning: boolean }) {
  if (!progress && !planning) return null;
  const status = progress?.status ?? "queued";
  return (
    <div className="chat-progress" data-control-id="chat.progress.panel" role="status" aria-live="polite">
      <div className="chat-progress-heading">
        <strong>{plannerProgressLabel(status)}</strong>
        {progress?.jobId && <span className="muted">job: {progress.jobId}</span>}
      </div>
      <p className="muted">{progress?.threadId ? `thread: ${progress.threadId}` : "threadを割り当て中"}{progress?.turnId ? ` / turn: ${progress.turnId}` : ""}</p>
      {progress?.events.length ? (
        <div className="chat-progress-events">
          {progress.events.slice(-5).map((event, index) => <span key={`${event.method}-${event.capturedAt ?? index}`}>{plannerEventLabel(event.method)}</span>)}
        </div>
      ) : <p className="muted">workerから進捗を待っています。</p>}
      {progress?.streamText && <details><summary>受信進捗（内部JSONは表示しません）</summary><p className="muted">Codexから {progress.streamText.length.toLocaleString("ja-JP")} 文字を受信しました。</p></details>}
      {!planning && status === "completed" && <p className="muted">外部操作は実行していません。内容確認後に保存へ進みます。</p>}
    </div>
  );
}

function toAutomationRows(items: any[]): AutomationRow[] {
  return items.map((item) => ({
    id: String(item.id),
    project_id: String(item.project_id ?? item.company_id ?? "未確認"),
    revision: Number(item.revision ?? 1),
    automation_type: String(item.automation_type ?? item.id ?? "sns-post"),
    name: String(item.name),
    desc: String(item.desc ?? item.goal ?? ""),
    schedule: String(item.schedule ?? "未設定"),
    schedule_version: String(item.pinned_schedule_version_id ?? "未固定"),
    next_run_at: String(item.next_run_at ?? "未計算"),
    lane: String(item.lane ?? "Lane 1"),
    last: String(item.last_run_at ?? item.last ?? "未実行"),
    status: (["running", "waiting", "approved", "blocked", "enabled", "disabled", "draft"].includes(item.status) ? item.status : "draft") as Status
  }));
}

async function readMvpState() {
  const response = await mvpFetch("/api/mvp/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`mvp_state_http_${response.status}`);
  return response.json();
}

type ProjectOption = { id: string; label: string; role: string };

function projectLabelFromId(id: string) {
  return id
    .replace(/^project[-_]?/i, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || id;
}

function projectOptionsFromState(state: MvpState): ProjectOption[] {
  const options = new Map<string, ProjectOption>();
  const canonicalCompanies = state.companies ?? state.projects ?? [];
  for (const project of canonicalCompanies) {
    const id = String(project?.id ?? project?.project_id ?? "").trim();
    if (!id) continue;
    options.set(id, {
      id,
      label: String(project?.name ?? project?.label ?? projectLabelFromId(id)),
      role: String(project?.role ?? "viewer")
    });
  }
  return [...options.values()];
}

function projectLabelFromState(state: MvpState, id: string) {
  return projectOptionsFromState(state).find((project) => project.id === id)?.label ?? projectLabelFromId(id);
}

async function fetchApiJson<T>(url: string): Promise<T> {
  const response = await mvpFetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`api_readback_http_${response.status}`);
  return response.json() as Promise<T>;
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

function approvalDueLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "期限未設定（承認前に確認）";
  const normalized = value.trim();
  return normalized.includes("T") ? normalized.replace("T", " ").replace(/\.\d{3}Z$/u, "").replace(/Z$/u, "") : normalized;
}
const templates = [
  ["SNS毎日投稿", "SNS運用", "Instagram / X / LinkedIn", "Lane 1", "承認必須"],
  ["Instagramストーリー投稿", "SNS運用", "Instagram", "Lane 1", "初回承認"],
  ["DM返信", "カスタマーサポート", "Instagram / Facebook", "Lane 2", "承認必須"],
  ["Gmail返信", "メール", "Gmail", "Lane 3", "承認必須"],
  ["競合リサーチ", "リサーチ", "Google / Sheets", "Lane 3", "自動許可"],
  ["Runway広告動画生成", "Creative / Runway", "Runway MCP", "Local", "承認必須"]
];

function useRoute() {
  const [route, setRoute] = useState(location.hash || "#/");
  React.useEffect(() => {
    const onHash = () => {
      const nextRoute = location.hash || "#/";
      setRoute(nextRoute);
    };
    addEventListener("hashchange", onHash);
    onHash();
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function projectSlugFromRoute(route: string) {
  return route.match(/\/projects\/([^/]+)/)?.[1] ?? "";
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
  return saved && /^[a-z0-9][a-z0-9_-]*$/i.test(saved) ? saved : "";
}

function chatThreadStorageKey(projectId: string) {
  return `automation-os-codex-thread:${projectId || "all"}`;
}

function rememberedChatThread(projectId: string) {
  if (!projectId) return "";
  const saved = window.sessionStorage.getItem(chatThreadStorageKey(projectId));
  return saved && /^[a-z0-9][a-z0-9_-]*$/i.test(saved) ? saved : "";
}

function rememberChatThread(projectId: string, threadId: string) {
  if (projectId && threadId) window.sessionStorage.setItem(chatThreadStorageKey(projectId), threadId);
}

function clearChatThread(projectId: string) {
  if (projectId) window.sessionStorage.removeItem(chatThreadStorageKey(projectId));
}

function resolveProjectSelection(state: MvpState, current = rememberedProject()) {
  const options = projectOptionsFromState(state);
  if (current && options.some((project) => project.id === current)) return current;
  const remembered = rememberedProject();
  if (remembered && options.some((project) => project.id === remembered)) return remembered;
  return options.length === 1 ? options[0].id : "";
}

function openAutomationCreator(state: MvpState, setReceipt?: (value: string) => void) {
  const projects = projectOptionsFromState(state);
  if (!projects.length) {
    setReceipt?.("最初に、自動化を保存する会社を登録してください。");
    go("#/projects");
    return;
  }
  const projectId = resolveProjectSelection(state);
  if (projectId) rememberProject(projectId);
  go("#/chat");
}

function projectSlugFromPrompt(prompt: string) {
  void prompt;
  return rememberedProject();
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

function Button({ children, icon, variant = "secondary", onClick, disabled = false, controlId, type = "button" }: { children: React.ReactNode; icon?: React.ReactNode; variant?: "primary" | "secondary" | "danger"; onClick?: () => void; disabled?: boolean; controlId?: string; type?: "button" | "submit" }) {
  return <button type={type} data-control-id={controlId} className={`btn ${variant}`} onClick={onClick} disabled={disabled}>{icon}{children}</button>;
}

function IconButton({ children, onClick, label, controlId, disabled = false }: { children: React.ReactNode; onClick?: () => void; label: string; controlId?: string; disabled?: boolean }) {
  return <button type="button" data-control-id={controlId} className="icon-btn" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function App() {
  const route = useRoute();
  const [receipt, setReceipt] = useState("Local Agent は待機中です。");
  const [writeToken, setWriteToken] = useState(readWriteToken());
  const [automationRows, setAutomationRows] = useState<AutomationRow[]>([]);
  const [createdTemplates, setCreatedTemplates] = useState<string[]>([]);
  const [mvpState, setMvpState] = useState<MvpState>({});
  const [mvpLoadStatus, setMvpLoadStatus] = useState<MvpLoadStatus>("loading");
  const [feedbackReadback, setFeedbackReadback] = useState<MvpState["feedbacks"]>([]);
  const [apiAccessRequired, setApiAccessRequired] = useState(false);
  const [accessChecking, setAccessChecking] = useState(false);
  React.useEffect(() => {
    readMvpState()
      .then((state) => {
        setMvpState(state);
        setMvpLoadStatus("ready");
        setAutomationRows(toAutomationRows(state.automations ?? []));
        setFeedbackReadback(state.feedbacks ?? []);
        const worker = state.worker?.status ? `worker=${state.worker.status}` : "worker=unknown";
        setReceipt(`MVP state readback 済みです。${worker} / runs=${state.runs?.length ?? 0}`);
      })
      .catch((error) => {
        setMvpLoadStatus("error");
        const message = error instanceof Error ? error.message : "";
        if (/mvp_state_http_(?:401|423)/.test(message)) {
          setApiAccessRequired(true);
          setReceipt("operator token が必要です。");
          return;
        }
        setReceipt("Local Agent は待機中です。MVP API未接続のためローカル表示です。");
      });
  }, []);
  React.useEffect(() => {
    mvpFetch("/api/mvp/feedback", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.ok === false) throw new Error("feedback_readback_failed");
        setFeedbackReadback(Array.isArray(json.feedbacks) ? json.feedbacks : []);
      })
      .catch(() => {
        setReceipt("Feedback readbackに失敗しました。空のキューとは断定せず、直前の表示を維持します。");
      });
  }, []);
  const page = useMemo(() => renderPage(route, {
    setReceipt,
    writeToken,
    setWriteToken,
    automationRows,
    setAutomationRows,
    createdTemplates,
    setCreatedTemplates,
    mvpState,
    setMvpState,
    mvpLoadStatus,
    feedbackReadback,
    setFeedbackReadback
  }), [route, writeToken, automationRows, createdTemplates, mvpState, mvpLoadStatus, feedbackReadback]);

  const unlockOperatorAccess = async () => {
    if (!writeToken.trim()) {
      setReceipt("operator token を入力してください。");
      return;
    }
    setAccessChecking(true);
    persistWriteToken(writeToken);
    try {
      const state = await readMvpState();
      setMvpState(state);
      setMvpLoadStatus("ready");
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setFeedbackReadback(state.feedbacks ?? []);
      setApiAccessRequired(false);
      setReceipt("operator token を確認しました。このタブでAutomation OSを利用できます。");
    } catch {
      clearWriteToken();
      setReceipt("operator token を確認できませんでした。値を確認してください。");
    } finally {
      setAccessChecking(false);
    }
  };

  const syncState = async () => {
    setMvpLoadStatus("loading");
    setReceipt("最新状態を同期しています。");
    try {
      const state = await readMvpState();
      setMvpState(state);
      setMvpLoadStatus("ready");
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setFeedbackReadback(state.feedbacks ?? []);
      setReceipt(`同期しました。automations=${state.automations?.length ?? 0} / runs=${state.runs?.length ?? 0} / ${state.updated_at ?? "更新時刻未取得"}`);
    } catch {
      setMvpLoadStatus("error");
      setReceipt("同期に失敗しました。表示中の値は最新と断定できません。");
    }
  };

  if (apiAccessRequired) {
    return (
      <main className="main">
        <section>
          <PageTitle title="Automation OS" desc="この画面は管理者専用です。" />
          <Panel title="オペレーター確認" controlId="shell.operator.panel">
            <form className="access-form" onSubmit={(event) => { event.preventDefault(); void unlockOperatorAccess(); }}>
              <label>Operator token<input data-control-id="shell.operator.token-input" type="password" value={writeToken} onChange={(event) => setWriteToken(event.target.value)} autoComplete="current-password" autoFocus aria-describedby="operator-token-help operator-token-status" /></label>
              <p id="operator-token-help" className="muted">token はこのタブだけに保存し、タブを閉じると破棄されます。</p>
              <div className="button-row"><Button controlId="shell.operator.open" type="submit" variant="primary" disabled={accessChecking}>{accessChecking ? "確認中" : "開く"}</Button></div>
              <div id="operator-token-status" className="action-note" role="status">{receipt}</div>
            </form>
          </Panel>
        </section>
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar route={route} isOwner={hasOwnerAdminAccess(mvpState)} />
      <main className="main">
        <TopHeader receipt={receipt} setReceipt={setReceipt} onSync={syncState} isOwner={hasOwnerAdminAccess(mvpState)} mvpState={mvpState} mvpLoadStatus={mvpLoadStatus} />
        {page}
      </main>
      <FeedbackWidget route={route} setReceipt={setReceipt} setMvpState={setMvpState} />
    </div>
  );
}

function Sidebar({ route, isOwner }: { route: string; isOwner: boolean }) {
  const nav = [
    ["ホーム", "#/", Home],
    ["チャット", "#/chat", MessageSquare],
    ["会社", "#/projects", FolderKanban],
    ["実行履歴", "#/runs", Activity],
    ["承認", "#/approvals", ClipboardCheck],
    ["テンプレート", "#/templates", LayoutTemplate],
    ...(isOwner ? [["Admin", "#/admin", Settings] as const] : [])
  ] as const;
  return (
    <aside className="sidebar">
      <div className="brand">Automation OS</div>
      <nav>
        {nav.map(([label, href, Icon]) => (
          <a
            key={href}
            data-control-id={
              href === "#/" ? "shell.sidebar.home"
                : href === "#/chat" ? "shell.sidebar.chat"
                  : href === "#/projects" ? "shell.sidebar.projects"
                    : href === "#/runs" ? "shell.sidebar.runs"
                      : href === "#/approvals" ? "shell.sidebar.approvals"
                        : href === "#/templates" ? "shell.sidebar.templates"
                          : "shell.sidebar.admin"
            }
            className={route === href || (href.includes("projects") && route.includes("projects")) ? "active" : ""}
            href={href}
            aria-label={label}
            title={label}
          >
            <Icon size={16} /> <span className="nav-label">{label}</span>
          </a>
        ))}
      </nav>
      <div className="user">
        <div className="avatar">A</div>
        <div>
          <strong>{isOwner ? "Owner" : "Company member"}</strong>
          <span>Automation OS</span>
        </div>
      </div>
    </aside>
  );
}

function TopHeader({ receipt, setReceipt, onSync, isOwner, mvpState, mvpLoadStatus }: { receipt: string; setReceipt: (value: string) => void; onSync: () => Promise<void>; isOwner: boolean; mvpState: MvpState; mvpLoadStatus: MvpLoadStatus }) {
  const [query, setQuery] = useState("");
  const companyCount = projectOptionsFromState(mvpState).length;
  const canStartAutomation = mvpLoadStatus === "ready" && companyCount > 0;
  const actions = [
    { label: "ホーム", route: "#/", keywords: "home ホーム dashboard ダッシュボード" },
    { label: "チャット", route: "#/chat", keywords: "chat チャット 作成 自動化 llm" },
    { label: "会社一覧", route: "#/projects", keywords: "company 会社 project プロジェクト 顧客 client 自動化" },
    { label: "実行履歴", route: "#/runs", keywords: "run worker queue 実行 履歴" },
    { label: "承認", route: "#/approvals", keywords: "approval 承認 停止 外部操作" },
    { label: "テンプレート", route: "#/templates", keywords: "template テンプレート skills skill 雛形" },
    ...(isOwner ? [{ label: "Admin", route: "#/admin", keywords: "admin pc worker browser codex obsidian production deploy diagnostics" }] : []),
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
      setReceipt(`検索: "${query}" に一致する画面が見つかりません。チャット、会社一覧、実行履歴、テンプレート、プラグイン、本番状態などで検索できます。`);
      return;
    }
    if (found.label === "Feedback") {
      openFeedbackFor(`検索からFeedbackを開きました: ${query}`, { source: "top_search", query });
      setReceipt("Feedbackを開きました。コメントとスクショを送信できます。");
      return;
    }
    if (found.route === "#/chat") {
      if (mvpLoadStatus !== "ready") {
        setReceipt("会社一覧の確認が完了していないため、自動化作成画面には進みませんでした。");
        return;
      }
      openAutomationCreator(mvpState, setReceipt);
      return;
    }
    go(found.route);
    setReceipt(`検索: ${found.label} を開きました。`);
  };
  return (
    <header className="topbar">
      <div className="top-context">
        <form className="search" onSubmit={submitSearch}>
          <Search size={15} />
          <input
            data-control-id="shell.top-header.search-input"
            aria-label="画面検索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="画面を検索"
          />
          <button data-control-id="shell.top-header.search-submit" type="submit">移動</button>
        </form>
        <div className="top-receipt" role="status" title={receipt}>{receipt}</div>
      </div>
      <div className="top-actions">
        <IconButton controlId="shell.top-header.sync" label="同期" onClick={() => { void onSync(); }}><RefreshCw size={16} /></IconButton>
        <Button controlId="shell.top-header.new-automation" variant="primary" icon={<Plus size={15} />} disabled={mvpLoadStatus !== "ready"} onClick={() => openAutomationCreator(mvpState, setReceipt)}>{canStartAutomation ? "新しい自動化" : companyCount === 0 && mvpLoadStatus === "ready" ? "会社を登録" : "確認中"}</Button>
      </div>
    </header>
  );
}

function ProjectTabs({ mvpState }: { mvpState: MvpState }) {
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const activeSection = subTabLabels.find(([, section]) => route.includes(`/${section}`))?.[1] ?? "automations";
  const stateOptions = projectOptionsFromState(mvpState);
  const projectOptions = stateOptions;
  return (
    <div className="project-tabs">
      <div className="project-switcher">{projectOptions.length
        ? projectOptions.map(({ id, label }) => <button data-control-id={`projects.switcher.${id}`} className={id === activeProject ? "selected" : ""} onClick={() => { rememberProject(id); go(`#/projects/${id}/${activeSection}`); }} key={id}>{label}</button>)
        : <span className="muted">会社はまだ登録されていません</span>}</div>
      <div className="sub-tabs">{subTabLabels.map(([label, section]) => {
        const href = `#/projects/${activeProject}/${section}`;
        return <a data-control-id={`projects.sections.${section}`} className={route === href ? "active" : ""} key={href} href={href}>{label}</a>;
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

function ProjectScopeNotice({ projectId, mvpState }: { projectId: string; mvpState: MvpState }) {
  return (
    <div className="notice-row">
      {projectLabelFromState(mvpState, projectId)} は認証済みmembershipから取得した会社範囲です。外部投稿・送信・削除・認証操作は別の明示gateを維持します。
    </div>
  );
}

type ObsidianGeneratedFileCheck = NonNullable<NonNullable<MvpState["obsidian"]>["generatedFileCheck"]>;

function displayGeneratedFileCheckPublic(generatedFileCheck?: ObsidianGeneratedFileCheck) {
  if (!generatedFileCheck) return "生成ファイル確認: 未取得";
  const missing = generatedFileCheck.missing?.length ?? 0;
  const nonGenerated = generatedFileCheck.nonGenerated?.length ?? 0;
  return generatedFileCheck.ok
    ? `生成ファイル確認: OK / missing ${missing} / non-generated ${nonGenerated}`
    : `生成ファイル確認: 要確認 / missing ${missing} / non-generated ${nonGenerated}`;
}

function ObsidianSyncCard({ obsidian, setReceipt }: { obsidian?: MvpState["obsidian"]; setReceipt: (value: string) => void; }) {
  const health = obsidian?.health ?? (obsidian?.ok === false ? "degraded" : obsidian?.ok === true ? "healthy" : "unknown");
  const generatedFileCheckFailed = obsidian?.generatedFileCheck ? !obsidian.generatedFileCheck.ok : false;
  const ok = obsidian?.ok === true && !generatedFileCheckFailed;
  const failed = obsidian?.ok === false || generatedFileCheckFailed;
  const publicGeneratedFileCheckText = displayGeneratedFileCheckPublic(obsidian?.generatedFileCheck);
  const diagnostics = failed || health !== "healthy";
  const summary = obsidian?.summary ?? "Obsidian status readbackを待っています。";
  const nextStep = obsidian?.nextStep ?? "API readbackが入ると次の一手がここに出ます。";
  const healthLabel = {
    healthy: "安定",
    recovering: "回復中",
    degraded: "要確認",
    disabled: "停止中",
    unknown: "未確認"
  }[health] ?? "未確認";
  return (
      <Panel title="Obsidian同期" controlId="obsidian.sync.panel">
      <div className="obsidian-sync-card">
        <div className="obsidian-sync-title">
          <strong>作業ノート</strong>
          <StatusBadge status={ok ? "enabled" : failed ? "blocked" : "draft"} label={healthLabel} />
        </div>
        <p>{summary}</p>
        <p className="muted">{nextStep}</p>
        <div className="obsidian-sync-actions">
          <Button controlId="obsidian.sync.read-state" variant="primary" onClick={() => setReceipt(`Obsidian: ${healthLabel} / ${summary} / ${nextStep}`)}>状態を読む</Button>
          <Button controlId="obsidian.sync.generated-files" onClick={() => setReceipt(publicGeneratedFileCheckText)} icon={<RefreshCw size={14} />}>生成ファイル確認</Button>
        </div>
        {diagnostics && (
          <details className="internal-details obsidian-sync-details">
            <summary>開発者向け診断</summary>
            <div className="obsidian-sync-diagnostics">
              <div>health: {health}</div>
              <div>lastSuccessAt: {obsidian?.lastSuccessAt ?? "none"}</div>
              <div>lastFailureAt: {obsidian?.lastFailureAt ?? "none"}</div>
              <div>nextRecoveryAt: {obsidian?.nextRecoveryAt ?? "none"}</div>
              <div>failureCount: {obsidian?.failureCount ?? 0}</div>
              <div>reason: {obsidian?.reason ?? "none"}</div>
              <div>{publicGeneratedFileCheckText}</div>
              <p>外部操作の完了判断には使いません。</p>
            </div>
          </details>
        )}
      </div>
    </Panel>
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
      const response = await mvpFetch(`/api/mvp/feedback/${encodeURIComponent(feedbackId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.exactBlocker || result.error || "feedback_update_failed");
      const refreshed = await mvpFetch("/api/mvp/feedback", { cache: "no-store" }).then(async (response) => {
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
      <Button controlId={`home.feedback.queue.open.${item.id}`} onClick={() => {
        setReceipt(`Feedback ${item.id}: ${classifyFeedback(item.comment, item.route)} / ${humanNextStepForFeedback(item.comment, item.route)}`);
        if (item.route.startsWith("#/")) go(item.route);
      }}>対象を開く</Button>
      <Button controlId={`home.feedback.queue.triage.${item.id}`} variant="primary" onClick={() => updateFeedbackStatus(item.id, "triaged")}>triaged にする</Button>
    </div>
  ]) : [["open feedbackなし", "-", "-", "-", "現在のreadbackでは未処理feedbackはありません", <StatusBadge status="waiting" label="未処理なし" />]];
  return (
    <Panel title="Feedback修正キュー" controlId="home.feedback.queue.panel">
      <div className="feedback-summary">
        <strong>open {allOpenItems.length}件</strong>
        <span>triaged {allTriagedItems.length}件</span>
        <span>表示 {openItems.length}件 / 押しても分からない系を最優先</span>
      </div>
      <DataTable controlId="home.feedback.queue.table" headers={["ID", "分類", "画面", "スクショ", "次の修正", "操作"]} rows={rows} />
      {triagedItems.length > 0 && (
        <div className="feedback-triaged">
          <strong>最近 triaged</strong>
          {triagedItems.map((item) => (
            <div key={item.id} className="feedback-triaged-item">
              <span>{item.id}</span>
              <span>{item.comment}</span>
              <Button controlId={`home.feedback.queue.open.${item.id}.restore`} onClick={() => updateFeedbackStatus(item.id, "open")}>open に戻す</Button>
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
  writeToken: string;
  setWriteToken: React.Dispatch<React.SetStateAction<string>>;
  automationRows: AutomationRow[];
  setAutomationRows: React.Dispatch<React.SetStateAction<AutomationRow[]>>;
  createdTemplates: string[];
  setCreatedTemplates: React.Dispatch<React.SetStateAction<string[]>>;
  mvpState: MvpState;
  setMvpState: React.Dispatch<React.SetStateAction<MvpState>>;
  mvpLoadStatus: MvpLoadStatus;
  feedbackReadback: MvpState["feedbacks"];
  setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>>;
};

function TruthfulLanesPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const companyRuns = (model.mvpState.runs ?? []).filter((run) => (run.company_id ?? run.project_id) === companyId);
  const observedLanes = [...new Set(companyRuns.map((run) => String(run.lane ?? "").trim()).filter(Boolean))];
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="Lane readback" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <Panel title="永続化済みLane情報" controlId="truthful.lanes.panel">
        {observedLanes.length ? (
          <DataTable controlId="truthful.lanes.table" headers={["Lane", "Run数"]} rows={observedLanes.map((lane) => [lane, String(companyRuns.filter((run) => run.lane === lane).length)])} />
        ) : <p className="muted">この会社には永続化済みのLane情報がありません。Lane作成・ブラウザ起動・ロック解除APIは未実装のため、操作ボタンは表示しません。</p>}
      </Panel>
    </section>
  );
}

function TruthfulMemoryPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const memory = (model.mvpState.project_memory ?? []).filter((item) => (item.company_id ?? item.project_id) === companyId);
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="保存情報 / Project Memory" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <Panel title="保存済み情報" controlId="truthful.memory.info.panel">
        {memory.length ? <DataTable controlId="truthful.memory.info.table" headers={["項目", "内容"]} rows={memory.map((item) => [item.title ?? item.key, item.body ?? "-"])} /> : <p className="muted">会社別永続化APIのreadbackに保存済み情報はありません。プレースホルダーやローカルだけの編集結果は表示しません。</p>}
      </Panel>
    </section>
  );
}

function TruthfulIntegrationsPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const role = projectOptionsFromState(model.mvpState).find((company) => company.id === companyId)?.role ?? "viewer";
  const canManage = role === "owner" || role === "admin";
  const [accountRefs, setAccountRefs] = useState<any[]>([]);
  const [inventoryStatus, setInventoryStatus] = useState<"loading" | "ready" | "error">(canManage ? "loading" : "ready");
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadInventory = async () => {
    if (!canManage) {
      setAccountRefs([]);
      setInventoryStatus("ready");
      return;
    }
    setInventoryStatus("loading");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/connection-account-refs`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "company_connection_inventory_read_failed");
      setAccountRefs(result.refs ?? []);
      setInventoryStatus("ready");
    } catch {
      setAccountRefs([]);
      setInventoryStatus("error");
    }
  };
  React.useEffect(() => { void loadInventory(); }, [companyId, canManage]);
  const mutateConnection = async (item: any, action: "reconnect" | "revoke") => {
    try {
      setBusyId(item.id);
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/connection-account-refs/${encodeURIComponent(item.id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: item.revision })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `company_connection_${action}_failed`);
      await loadInventory();
      model.setReceipt(action === "reconnect"
        ? `${item.platform}: 再認証要求を保存しました。OAuth画面での認証は人間操作として未実行です。`
        : `${item.platform}: ローカル接続参照を無効化しました。外部provider側のtoken失効は未実行です。`);
    } catch {
      model.setReceipt(`${item.platform}: 接続状態の保存に失敗しました。最新revisionを再読込してください。`);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="会社別Integrations inventory" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <Panel title="会社別接続inventory" controlId="truthful.integrations.refs.panel">
        {canManage && inventoryStatus === "loading" ? <p className="muted">接続inventoryを会社別APIから確認しています。</p> : canManage && inventoryStatus === "error" ? <p className="muted">接続inventoryを確認できませんでした。未確認状態を接続済みとして表示しません。</p> : canManage && accountRefs.length ? <DataTable controlId="truthful.integrations.refs.table" headers={["サービス", "アカウント参照", "OAuth", "Scope", "期限", "最終検証", "状態", "操作"]} rows={accountRefs.map((item) => [
          item.platform,
          item.account_ref ?? item.accountRef,
          item.oauth_state ?? item.oauthState ?? "not_configured",
          (item.scopes ?? []).join(", ") || "なし",
          item.expires_at ?? item.expiresAt ?? "期限なし",
          item.last_verified_at ?? item.lastVerifiedAt ?? "未検証",
          <StatusBadge status={integrationStatusBadge(item).status} label={integrationStatusBadge(item).label} />,
          <div className="row-actions">
            <Button controlId={`integrations.reconnect.${item.id}`} onClick={() => { void mutateConnection(item, "reconnect"); }} disabled={busyId !== null}>再認証を要求</Button>
            {item.status !== "revoked" && <Button controlId={`integrations.revoke.${item.id}`} variant="danger" onClick={() => { void mutateConnection(item, "revoke"); }} disabled={busyId !== null}>接続参照を無効化</Button>}
          </div>
        ])} /> : canManage ? <p className="muted">この会社に保存された接続参照はありません。未確認サービスや架空の接続状態は表示しません。</p> : <p className="muted">Integrations inventoryはOwner/Adminだけが閲覧できます。</p>}
      </Panel>
      <Panel title="適用中の境界" controlId="truthful.integrations.boundary.panel">
        <CheckList items={["password・access token・refresh tokenはinventory APIへ保存しない", "再接続は再認証要求の永続化まで。OAuth認証は人間gate", "無効化はローカル接続参照のみ。外部provider失効を実行済みとは表示しない", "会社membershipとRBACをserver側で検証"]} />
      </Panel>
    </section>
  );
}

function integrationStatusBadge(item: any): { status: Status; label: string } {
  if (item.status === "revoked") return { status: "disabled", label: "revoked" };
  if (item.status === "reconnect_required") return { status: "waiting", label: "reconnect required" };
  const oauthState = item.oauth_state ?? item.oauthState ?? "not_configured";
  const expiresAt = item.expires_at ?? item.expiresAt ?? null;
  if (oauthState === "revoked") return { status: "disabled", label: "revoked" };
  if (oauthState === "expired" || (expiresAt && Date.parse(expiresAt) <= Date.now())) return { status: "blocked", label: "expired" };
  if (oauthState === "error") return { status: "blocked", label: "connection error" };
  const verification = item.verification_status ?? item.verificationStatus ?? "unverified";
  const lastVerifiedAt = item.last_verified_at ?? item.lastVerifiedAt ?? null;
  if (item.status === "verified" && verification === "verified" && lastVerifiedAt && (oauthState === "connected" || oauthState === "not_applicable")) return { status: "enabled", label: "verified" };
  if (verification === "failed" || verification === "expired") return { status: "blocked", label: verification };
  return { status: "draft", label: "unverified" };
}

type PresentationProfileDraft = {
  kind: string;
  label: string;
  purpose: string;
  freshnessSlaMinutes: string;
  browserUseLane: string;
  stopBoundary: string;
  primaryMetrics: string;
  widgets: string;
  preferredGrouping: string;
  explanation: string;
};

function presentationProfileDraft(profile: NonNullable<MvpState["presentation_profiles"]>[number]): PresentationProfileDraft {
  return {
    kind: profile.kind,
    label: profile.label,
    purpose: profile.purpose ?? "",
    freshnessSlaMinutes: profile.freshnessSlaMinutes ? String(profile.freshnessSlaMinutes) : "",
    browserUseLane: profile.browserUseLane ?? "",
    stopBoundary: profile.stopBoundary ?? "",
    primaryMetrics: (profile.primaryMetrics ?? []).join(", "),
    widgets: (profile.widgets ?? []).join(", "),
    preferredGrouping: profile.preferredGrouping ?? "week",
    explanation: profile.explanation ?? ""
  };
}

function ProjectPresentationProfilePanel({ model, companyId }: { model: AppModel; companyId: string }) {
  const profile = model.mvpState.presentation_profiles?.find((item) => item.id === companyId);
  const role = projectOptionsFromState(model.mvpState).find((project) => project.id === companyId)?.role ?? "viewer";
  const canManage = role === "owner" || role === "admin" || role === "operator";
  const [draft, setDraft] = useState<PresentationProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("プロジェクトの自動化カタログから表示方法を判定しています。");
  React.useEffect(() => {
    setDraft(profile ? presentationProfileDraft(profile) : null);
    setNote(profile?.exactBlocker ? `表示profileを確認できません: ${profile.exactBlocker}` : profile?.source === "persisted_project_profile" ? `保存済みprofile / revision=${profile.revision ?? "?"}` : "自動判定profile。必要ならこのプロジェクト専用に調整できます。");
  }, [companyId, profile?.revision, profile?.source, profile?.exactBlocker, profile?.label]);
  if (!profile || !draft) return <Panel title="表示profile"><p className="muted">このプロジェクトの表示profileを取得できませんでした。未確認のwidgetやKPIは表示しません。</p></Panel>;
  const update = (key: keyof PresentationProfileDraft, value: string) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const save = async () => {
    if (!canManage || saving) return;
    const primaryMetrics = draft.primaryMetrics.split(",").map((item) => item.trim()).filter(Boolean);
    const widgets = draft.widgets.split(",").map((item) => item.trim()).filter(Boolean);
    setSaving(true);
    setNote("表示profileを保存し、revisionを確認しています。");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/presentation-profile`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(profile.revision ? { expected_revision: profile.revision } : {}),
          profile: {
            kind: draft.kind,
            label: draft.label,
            purpose: draft.purpose,
            freshnessSlaMinutes: draft.freshnessSlaMinutes ? Number(draft.freshnessSlaMinutes) : undefined,
            browserUseLane: draft.browserUseLane,
            stopBoundary: draft.stopBoundary,
            primaryMetrics,
            widgets,
            preferredGrouping: draft.preferredGrouping,
            explanation: draft.explanation
          }
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.exactBlocker || result.error || "project_profile_save_failed");
      const nextProfile = result.profile;
      model.setMvpState((state) => ({
        ...state,
        presentation_profiles: (state.presentation_profiles ?? []).map((item) => item.id === companyId ? nextProfile : item)
      }));
      setNote(`保存済みprofile / revision=${result.revision ?? "?"} / external_action=false`);
      model.setReceipt(`表示profileを保存しました。project=${companyId} / revision=${result.revision ?? "?"}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "project_profile_save_failed";
      setNote(`保存できませんでした: ${exact}`);
      model.setReceipt(`表示profileの保存を確認できませんでした: ${exact}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="プロジェクト別表示profile" controlId="truthful.performance.profile.panel">
      <div className="profile-summary">
        <div><strong>{profile.label}</strong><StatusBadge status={profile.source === "persisted_project_profile" ? "enabled" : "draft"} label={profile.source === "persisted_project_profile" ? `保存済み revision=${profile.revision ?? "?"}` : "自動判定"} /></div>
        <p>{profile.explanation}</p>
        <p className="muted">KPI: {(profile.primaryMetrics ?? []).join(" / ") || "未設定"} / widget: {(profile.widgets ?? []).join(" / ") || "未設定"} / grouping: {profile.preferredGrouping ?? "未設定"}</p>
        <p className="muted">鮮度SLA: {profile.freshnessSlaMinutes ? `${profile.freshnessSlaMinutes}分` : "未設定"} / Browser Use lane: {profile.browserUseLane || "未設定"} / 停止境界: {profile.stopBoundary || "未設定"}</p>
        <div className="action-note" role="status">{note}</div>
      </div>
      {canManage ? <details className="profile-editor">
        <summary>このプロジェクトの見せ方を調整</summary>
        <div className="builder-grid">
          <label>種類<select value={draft.kind} onChange={(event) => update("kind", event.target.value)}><option value="research">調査</option><option value="jobs">応募</option><option value="commerce">商品</option><option value="social">SNS</option><option value="operations">運用</option></select></label>
          <label>表示名<input value={draft.label} onChange={(event) => update("label", event.target.value)} /></label>
          <label>鮮度SLA（分）<input type="number" min="1" value={draft.freshnessSlaMinutes} onChange={(event) => update("freshnessSlaMinutes", event.target.value)} placeholder="未設定" /></label>
          <label>グルーピング<select value={draft.preferredGrouping} onChange={(event) => update("preferredGrouping", event.target.value)}><option value="day">日</option><option value="week">週</option><option value="workflow">workflow</option><option value="stage">stage</option></select></label>
          <label className="span-2">主要KPI（カンマ区切り）<input value={draft.primaryMetrics} onChange={(event) => update("primaryMetrics", event.target.value)} /></label>
          <label className="span-2">widget（カンマ区切り）<input value={draft.widgets} onChange={(event) => update("widgets", event.target.value)} placeholder="kpi, timeline, failure_table" /></label>
          <label className="span-2">目的<textarea value={draft.purpose} onChange={(event) => update("purpose", event.target.value)} /></label>
          <label className="span-2">Browser Use lane<textarea value={draft.browserUseLane} onChange={(event) => update("browserUseLane", event.target.value)} /></label>
          <label className="span-2">停止境界<textarea value={draft.stopBoundary} onChange={(event) => update("stopBoundary", event.target.value)} /></label>
          <label className="span-2">説明<textarea value={draft.explanation} onChange={(event) => update("explanation", event.target.value)} /></label>
        </div>
        <div className="button-row"><Button controlId="truthful.performance.profile.save" variant="primary" onClick={() => { void save(); }} disabled={saving}>{saving ? "保存確認中" : "表示profileを保存"}</Button></div>
      </details> : <p className="muted">表示profileの保存はOwner/Admin/Operatorだけが行えます。</p>}
    </Panel>
  );
}

function ProjectPresentationProfileSummary({ model, companyId, context }: { model: AppModel; companyId: string; context: string }) {
  const profile = model.mvpState.presentation_profiles?.find((item) => item.id === companyId);
  const projectName = projectLabelFromState(model.mvpState, companyId);
  return (
    <Panel title={`${projectName} 表示profile`} controlId={`truthful.${context}.profile-summary.panel`}>
      {profile ? <div className="profile-summary">
        <div><strong>{profile.label}</strong><StatusBadge status={profile.source === "persisted_project_profile" ? "enabled" : "draft"} label={profile.source === "persisted_project_profile" ? `保存済み revision=${profile.revision ?? "?"}` : "自動判定"} /></div>
        <p>{profile.explanation || "このプロジェクトの用途に合わせた表示設定です。"}</p>
        <p className="muted">KPI: {(profile.primaryMetrics ?? []).join(" / ") || "未設定"} / widget: {(profile.widgets ?? []).join(" / ") || "未設定"} / grouping: {profile.preferredGrouping ?? "未設定"}</p>
        <p className="muted">鮮度SLA: {profile.freshnessSlaMinutes ? `${profile.freshnessSlaMinutes}分` : "未設定"} / 停止境界: {profile.stopBoundary || "未設定"}</p>
      </div> : <p className="muted">このプロジェクトの表示profileを取得できませんでした。未確認のKPIやwidgetは表示しません。</p>}
    </Panel>
  );
}

function MiniBarChart({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return <div className="mini-bar-chart" aria-label="プロジェクト別実績グラフ">{rows.slice(-14).map((row) => <div className="mini-bar-row" key={row.label}><span>{row.label}</span><div className="mini-bar-track"><div className="mini-bar-fill" style={{ width: `${Math.max(2, Math.round((row.value / max) * 100))}%` }} /></div><strong>{row.value}</strong></div>)}</div>;
}

function TruthfulPerformancePage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const automationOptions = (model.mvpState.automations ?? []).filter((item) => (item.company_id ?? item.project_id) === companyId);
  const [fromDate, setFromDate] = useState(() => dateInputValue(Date.now() - 29 * 24 * 60 * 60 * 1000));
  const [toDate, setToDate] = useState(() => dateInputValue(Date.now()));
  const [automationId, setAutomationId] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [analyticsStatus, setAnalyticsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [analytics, setAnalytics] = useState<any>(null);
  const analyticsRequestGeneration = useRef(0);
  React.useEffect(() => {
    if (automationId && !automationOptions.some((item) => item.id === automationId)) setAutomationId("");
  }, [companyId, automationId, model.mvpState.automations]);
  React.useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = ++analyticsRequestGeneration.current;
    setAnalytics(null);
    setAnalyticsStatus("loading");
    const load = async () => {
      try {
        const from = new Date(`${fromDate}T00:00:00.000Z`).toISOString();
        const to = new Date(`${toDate}T23:59:59.999Z`).toISOString();
        const params = new URLSearchParams({ from, to });
        if (automationId) params.set("automation_id", automationId);
        const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/analytics/performance?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || "company_analytics_read_failed");
        if (controller.signal.aborted || analyticsRequestGeneration.current !== requestGeneration) return;
        setAnalytics(result);
        setAnalyticsStatus("ready");
      } catch (error) {
        if (controller.signal.aborted || analyticsRequestGeneration.current !== requestGeneration) return;
        setAnalytics(null);
        setAnalyticsStatus("error");
      }
    };
    void load();
    return () => controller.abort();
  }, [companyId, fromDate, toDate, automationId, refreshGeneration]);
  const outcome = analytics?.metrics?.outcome;
  const duration = analytics?.metrics?.duration;
  const approvalLatency = analytics?.metrics?.approval_latency;
  const failures = analytics?.metrics?.failure_categories;
  const profile = model.mvpState.presentation_profiles?.find((item) => item.id === companyId);
  const widgets = new Set(profile?.widgets ?? ["kpi", "timeline", "failure_table", "evidence_timeline"]);
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="会社別パフォーマンス集計" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <ProjectPresentationProfilePanel model={model} companyId={companyId} />
      <Panel title="集計条件" controlId="truthful.performance.filter.panel">
        <div className="builder-grid">
          <label>開始日<input data-control-id="truthful.performance.filter.from" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label>終了日<input data-control-id="truthful.performance.filter.to" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
          <label>Automation<select data-control-id="truthful.performance.filter.automation" value={automationId} onChange={(event) => setAutomationId(event.target.value)}><option value="">全て</option>{automationOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <Button controlId="truthful.performance.refresh.button" onClick={() => setRefreshGeneration((value) => value + 1)}>再読込</Button>
        </div>
      </Panel>
      {analyticsStatus === "loading" ? <Panel title="集計中" controlId="truthful.performance.loading.panel"><p className="muted">会社別の永続Jobと承認記録を集計しています。</p></Panel> : analyticsStatus === "error" ? <Panel title="集計できませんでした" controlId="truthful.performance.error.panel"><p className="muted">前回値を最新値として残していません。条件を確認して再読込してください。</p></Panel> : analytics?.data_state === "empty" ? <Panel title="計測データなし" controlId="truthful.performance.empty.panel"><p className="muted">この期間に計測可能なdurable Jobはありません。0件を成功率や所要時間として表示しません。</p></Panel> : <>
        <div className="cards four">
          <MetricCard controlId="truthful.performance.metric.jobs" title="Job" value={String(outcome?.denominator ?? 0)} sub="durable_jobsのみ" status="enabled" />
          <MetricCard controlId="truthful.performance.metric.completion" title="完了率" value={formatRatio(outcome?.completion_rate)} sub={`${outcome?.numerator ?? 0}/${outcome?.denominator ?? 0}`} status={(outcome?.statuses?.failed ?? 0) > 0 ? "blocked" : "enabled"} />
          <MetricCard controlId="truthful.performance.metric.duration" title="平均所要時間" value={formatDuration(duration?.average)} sub={`sample ${duration?.sample_size ?? 0}`} status={duration?.availability === "available" ? "enabled" : "waiting"} />
          <MetricCard controlId="truthful.performance.metric.approval" title="承認平均時間" value={formatDuration(approvalLatency?.average)} sub={`sample ${approvalLatency?.sample_size ?? 0}`} status={approvalLatency?.availability === "available" ? "enabled" : "waiting"} />
        </div>
        {widgets.has("timeline") && <Panel title="日別実績" controlId="truthful.performance.series.panel">
          {(analytics.by_date ?? []).length ? <><MiniBarChart rows={analytics.by_date.map((row: any) => ({ label: row.date, value: Number(row.total_jobs ?? 0) }))} /><DataTable controlId="truthful.performance.series.table" headers={["日付 (UTC)", "Job", "完了", "未完了"]} rows={analytics.by_date.map((row: any) => [row.date, row.total_jobs, row.completed_jobs, row.failed_jobs])} /></> : <p className="muted">表示できる日別bucketはありません。</p>}
        </Panel>}
        {widgets.has("kpi") && <Panel title="Automation別実績" controlId="truthful.performance.automation.panel">
          {(analytics.by_automation ?? []).length ? <DataTable controlId="truthful.performance.automation.table" headers={["Automation", "Job", "完了", "完了率", "更新"]} rows={analytics.by_automation.map((row: any) => [row.automation_name, row.total_jobs, row.completed_jobs, formatRatio(row.completion_rate), row.last_updated_at ?? "-"])} /> : <p className="muted">表示できるAutomation別集計はありません。</p>}
        </Panel>}
        {widgets.has("failure_table") && <Panel title="失敗カテゴリ" controlId="truthful.performance.failures.panel">
          {(failures?.categories ?? []).length ? <DataTable controlId="truthful.performance.failures.table" headers={["分類", "件数"]} rows={failures.categories.map((row: any) => [row.category, row.count])} /> : <p className="muted">この期間に分類対象の失敗はありません。</p>}
        </Panel>}
        {widgets.has("kpi") && <Panel title="未計測指標" controlId="truthful.performance.unavailable.panel">
          <DataTable controlId="truthful.performance.unavailable.table" headers={["指標", "状態", "理由"]} rows={[
            ["Cost", analytics.metrics?.cost?.availability ?? "unavailable", analytics.metrics?.cost?.reason ?? "source unavailable"],
            ["Time saved", analytics.metrics?.time_saved?.availability ?? "unavailable", analytics.metrics?.time_saved?.reason ?? "source unavailable"],
            ["SLA", analytics.metrics?.sla?.availability ?? "unavailable", analytics.metrics?.sla?.reason ?? "source unavailable"]
          ]} />
        </Panel>}
        {widgets.has("evidence_timeline") && <Panel title="集計の来歴" controlId="truthful.performance.provenance.panel">
          <DataTable controlId="truthful.performance.provenance.table" headers={["Source", "Rows", "Last updated", "Included"]} rows={(analytics.provenance ?? []).map((row: any) => [row.source, row.row_count, row.last_updated_at ?? "-", row.included === false ? "no" : "yes"])} />
          <p className="muted">状態: {analytics.data_state} / 更新: {analytics.last_updated_at ?? "未計測"} / 対象期間: {analytics.query?.from} – {analytics.query?.to} / legacy run除外: {analytics.completeness?.excluded_legacy_runs ?? 0}</p>
        </Panel>}
      </>}
    </section>
  );
}

function dateInputValue(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatRatio(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : "未計測";
}

function formatDuration(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未計測";
  if (value < 60_000) return `${Math.round(value / 1000)}秒`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}分`;
  return `${Math.round(value / 360_000) / 10}時間`;
}

function TruthfulArtifactsPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const automationIds = new Set((model.mvpState.automations ?? []).filter((item) => (item.company_id ?? item.project_id) === companyId).map((item) => item.id));
  const runIds = new Set((model.mvpState.runs ?? []).filter((run) => (run.company_id ?? run.project_id) === companyId || automationIds.has(run.automation_id)).map((run) => run.id));
  const proofs = (model.mvpState.proofs ?? []).filter((proof) => (proof.company_id ?? proof.project_id) === companyId || runIds.has(proof.run_id));
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="保存済み成果物 / Proof" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <ProjectPresentationProfileSummary model={model} companyId={companyId} context="artifacts" />
      <Panel title="Proof一覧" controlId="truthful.artifacts.proofs.panel">
        {proofs.length ? <DataTable controlId="truthful.artifacts.proofs.table" headers={["ID", "Run", "種類", "状態", "作成日時"]} rows={proofs.map((proof) => [proof.id, proof.run_id ?? "-", proof.proof_type ?? proof.kind ?? "-", proof.status ?? "stored", proof.created_at ?? "-"])} /> : <p className="muted">この会社に保存済みproofはありません。固定サンプル、架空KPI、未保存のダウンロードや承認操作は表示しません。</p>}
      </Panel>
    </section>
  );
}

function TruthfulRunDetailPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const runId = decodeURIComponent(route.split("/runs/")[1]?.split("/")[0] ?? "");
  const run = (model.mvpState.runs ?? []).find((item) => {
    if (item.id !== runId) return false;
    const automationCompanyId = model.mvpState.automations?.find((automation) => automation.id === item.automation_id)?.company_id
      ?? model.mvpState.automations?.find((automation) => automation.id === item.automation_id)?.project_id;
    return Boolean(companyId) && (item.company_id ?? item.project_id ?? automationCompanyId) === companyId;
  });
  const proofs = (model.mvpState.proofs ?? []).filter((proof) => proof.run_id === runId
    && ((!proof.company_id && !proof.project_id) || (proof.company_id ?? proof.project_id) === companyId));
  if (!run) return <ProjectUnavailablePage reason="このRunは現在の会社別API readbackでは確認できません。" />;
  return (
    <section>
      <PageTitle title={`実行詳細: ${run.id}`} desc="永続化済みreadbackのみ表示" />
      <Panel title="Run" controlId="truthful.run-detail.run.panel">
        <DataTable controlId="truthful.run-detail.run.table" headers={["Automation", "Status", "Queued", "Started", "確認事項"]} rows={[[run.automation_name ?? run.automation_id ?? "-", <StatusBadge status={run.status === "blocked" ? "blocked" : run.status === "running" ? "running" : "waiting"} label={run.status} />, run.queued_at ?? "-", run.started_at ?? "-", publicBlockerSummary(run.exact_blocker)]]} />
      </Panel>
      <Panel title="Proof" controlId="truthful.run-detail.proof.panel"><DataTable controlId="truthful.run-detail.proof.table" headers={["ID", "種類", "状態"]} rows={proofs.length ? proofs.map((proof) => [proof.id, proof.proof_type ?? proof.kind ?? "-", proof.status ?? "stored"]) : [["保存済みproofなし", "-", "-"]]} /></Panel>
      <p className="muted">途中再開・復旧アクションのserver契約は未実装のため、操作ボタンは表示しません。</p>
    </section>
  );
}

function TruthfulRecoveryPage() {
  return <ProjectUnavailablePage reason="durable recovery APIは未実装です。架空のLane競合や実行可能に見える復旧操作は表示しません。" />;
}

function TruthfulPluginsPage({ model }: { model: AppModel }) {
  const capabilities = model.mvpState.codexCapabilities;
  const surfaces = [capabilities?.browser, capabilities?.chrome, capabilities?.mcp, capabilities?.appServer].filter((surface): surface is CapabilitySurface => Boolean(surface));
  return (
    <section>
      <PageTitle title="プラグイン / MCP" desc="検証済みreadbackのみ表示" />
      <Panel title="Codex surface readback" controlId="truthful.plugins.surfaces.panel">
        {surfaces.length ? <DataTable controlId="truthful.plugins.surfaces.table" headers={["Surface", "Kind", "Status", "Configured", "Enabled", "Connected"]} rows={surfaces.map((surface) => [surface.name, surface.kind, getCapabilitySurfaceStatus(surface), getCapabilitySurfaceState(surface).configured ? "yes" : "no", getCapabilitySurfaceState(surface).enabled ? "yes" : "no", getCapabilitySurfaceState(surface).connected ? "yes" : "no"])} /> : <p className="muted">capability readbackはありません。静的なPlugin候補や同期済みに見える操作は表示しません。</p>}
      </Panel>
      <Panel title="Chrome Extension readback" controlId="truthful.plugins.chrome.panel"><p>{model.mvpState.browserHealth?.chromeExtension?.status ?? "未確認"} / blocker={model.mvpState.browserHealth?.chromeExtension?.exactBlocker ?? "none"}</p><p className="muted">{model.mvpState.browserHealth?.chromeExtension?.summary ?? "readbackなし"}</p></Panel>
    </section>
  );
}

function TruthfulProductionStatusPage({ model }: { model: AppModel }) {
  const readiness = model.mvpState.production_readiness_readback;
  const browser = model.mvpState.browserHealth;
  const readinessRows = readiness && typeof readiness === "object"
    ? Object.entries(readiness).filter(([key]) => ["status", "production_ready", "goal_complete", "blocker", "next_action", "checked_at", "source"].includes(key)).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value ?? "-")])
    : [];
  return (
    <section>
      <PageTitle title="本番状態" desc="現在のAPI readback。deployや外部検証は実行しません。" />
      <div className="cards four">
        <MetricCard controlId="truthful.production.metric.persistence" title="Persistence" value={String(model.mvpState.persistence?.adapter ?? "unknown")} sub="current API readback" status={model.mvpState.persistence?.adapter ? "enabled" : "waiting"} />
        <MetricCard controlId="truthful.production.metric.worker" title="Worker" value={model.mvpState.worker?.status ?? "unknown"} sub={workerStatusSummary(model.mvpState.worker).label} status={model.mvpState.worker?.heartbeat_fresh ? "enabled" : model.mvpState.worker?.readback_status === "stored" ? "draft" : "blocked"} />
        <MetricCard controlId="truthful.production.metric.chrome" title="Chrome lane" value={browser?.chromeExtension?.status ?? "unknown"} sub={browser?.chromeExtension?.exactBlocker ?? "no blocker reported"} status={browser?.chromeExtension?.status === "ready" ? "enabled" : "blocked"} />
        <MetricCard controlId="truthful.production.metric.goal" title="Goal Complete" value={readiness?.goal_complete === true ? "true" : "false"} sub="readbackがtrueになるまで未完了" status={readiness?.goal_complete === true ? "approved" : "blocked"} />
      </div>
      <Panel title="Production readiness readback" controlId="truthful.production.readback.panel">{readinessRows.length ? <DataTable controlId="truthful.production.readback.table" headers={["項目", "値"]} rows={readinessRows} /> : <p className="muted">production readiness readbackはありません。過去の固定run IDや確認件数は現在値として表示しません。</p>}</Panel>
      <Panel title="Hard stops" controlId="truthful.production.hard-stops.panel"><CheckList items={["production deployは未実行", "外部投稿・送信・削除は未実行", "real credential / secret mutationは未実行", "production claimは実証跡が揃うまで禁止"]} /></Panel>
    </section>
  );
}

function hasOwnerAdminAccess(state: MvpState) {
  return projectOptionsFromState(state).some((company) => company.role === "owner");
}

function OwnerAdminPage({ model }: { model: AppModel }) {
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const load = async () => {
    setStatus("loading");
    try {
      const response = await mvpFetch("/api/v1/admin/diagnostics", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || "owner_admin_read_failed");
      setDiagnostics(body);
      setStatus("ready");
      model.setReceipt("Owner専用Admin diagnosticsを再読込しました。外部操作は実行していません。");
    } catch {
      setDiagnostics(null);
      setStatus("error");
      model.setReceipt("Owner専用Admin diagnosticsを確認できませんでした。");
    }
  };
  React.useEffect(() => { void load(); }, []);
  if (!hasOwnerAdminAccess(model.mvpState)) return <ProjectUnavailablePage reason="Admin diagnosticsはOwner membershipだけが閲覧できます。" />;
  const diagnosticText = (value: unknown) => redactSensitiveText(redactDisplayPaths(JSON.stringify(value ?? {}, null, 2)));
  return (
    <section>
      <PageTitle title="Admin" desc="Owner専用: PC・Browser・Codex・Obsidian・Worker・Deployment diagnostics">
        <Button controlId="admin.refresh" onClick={() => { void load(); }} disabled={status === "loading"}>{status === "loading" ? "確認中" : "再確認"}</Button>
      </PageTitle>
      {status === "error" && <Panel title="Admin readback" controlId="admin.error.panel"><p className="muted">Owner専用API readbackを取得できませんでした。通常の会社ページへ内部診断値はfallback表示しません。</p></Panel>}
      {status === "ready" && diagnostics && <>
        <Panel title="PC / Worker" controlId="admin.pc.panel"><pre>{diagnosticText(diagnostics.pc)}</pre></Panel>
        <Panel title="Browser / Codex" controlId="admin.browser-codex.panel"><pre>{diagnosticText({ browser: diagnostics.browser, codex: diagnostics.codex })}</pre></Panel>
        <Panel title="IAB / Root capability" controlId="admin.iab.panel"><pre>{diagnosticText(diagnostics.iab)}</pre></Panel>
        <Panel title="IAB workflow adapters" controlId="admin.workflow-adapters.panel"><pre>{diagnosticText(diagnostics.workflow_adapters)}</pre></Panel>
        <Panel title="Company SaaS release readiness" controlId="admin.company-release-readiness.panel"><pre>{diagnosticText(diagnostics.company_release_readiness)}</pre></Panel>
        <Panel title="Company SaaS evidence gates" controlId="admin.company-release-evidence.panel"><pre>{diagnosticText(diagnostics.company_release_evidence)}</pre></Panel>
        <Panel title="Obsidian" controlId="admin.obsidian.panel"><pre>{diagnosticText(diagnostics.obsidian)}</pre></Panel>
        <Panel title="Deployment / Guards" controlId="admin.deployment.panel"><pre>{diagnosticText({ deployment: diagnostics.deployment, guards: diagnostics.guards })}</pre></Panel>
      </>}
      <FeedbackFixQueue feedbacks={model.feedbackReadback} state={model.mvpState} setReceipt={model.setReceipt} setFeedbackReadback={model.setFeedbackReadback} />
    </section>
  );
}

function renderPage(route: string, model: AppModel) {
  const { setReceipt } = model;
  if (route === "#/chat") return <ChatPage model={model} />;
  if (route === "#/approvals") return <ApprovalsPage model={model} />;
  if (route === "#/runs") return <RunsPage model={model} />;
  if (route === "#/templates") return <TemplatesPage model={model} />;
  if (route === "#/admin") return <OwnerAdminPage model={model} />;
  if (route === "#/plugins") return <TruthfulPluginsPage model={model} />;
  if (route === "#/production/status") return hasOwnerAdminAccess(model.mvpState) ? <TruthfulProductionStatusPage model={model} /> : <ProjectUnavailablePage reason="本番状態はOwner専用です。" />;
  if (route === "#/system/pc-status") return <PcStatusPage model={model} />;
  if (route === "#/projects" || route === "#/projects/") return <ProjectDirectoryPage model={model} />;
  if (route.includes("/projects/")) {
    if (model.mvpLoadStatus === "loading") return <ProjectUnavailablePage reason="会社一覧をAPIから確認しています。" />;
    if (model.mvpLoadStatus === "error") return <ProjectUnavailablePage reason="会社一覧を確認できませんでした。同期してから再度お試しください。" />;
    const projectOptions = projectOptionsFromState(model.mvpState);
    const requestedProject = projectSlugFromRoute(route);
    if (!projectOptions.length) return <ProjectUnavailablePage reason="会社はまだ登録されていません。API readbackで会社を確認してから自動化を作成してください。" />;
    if (!projectOptions.some((project) => project.id === requestedProject)) return <ProjectUnavailablePage reason="この会社は現在のAPI readbackでは確認できません。会社一覧から選び直してください。" />;
  }
  if (route.includes("/performance")) return <TruthfulPerformancePage model={model} />;
  if (route.includes("/automations/") && route.includes("/edit")) return <BuilderPage model={model} />;
  if (route.includes("/lanes")) return <TruthfulLanesPage model={model} />;
  if (route.includes("/memory")) return <TruthfulMemoryPage model={model} />;
  if (route.includes("/integrations") || route.includes("/security")) return <TruthfulIntegrationsPage model={model} />;
  if (route.includes("/artifacts")) return <TruthfulArtifactsPage model={model} />;
  if (route.includes("/recovery")) return <TruthfulRecoveryPage />;
  if (route.includes("/runs/")) return <TruthfulRunDetailPage model={model} />;
  if (route.includes("/automations")) return <AutomationsPage model={model} />;
  return <HomePage model={model} />;
}

function ProjectDirectoryPage({ model }: { model: AppModel }) {
  const [companyName, setCompanyName] = useState("");
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [setupNote, setSetupNote] = useState("会社名を登録すると、その会社専用の自動化を作成できます。");
  const companyCreateIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const createCompany = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = companyName.trim();
    if (!name) {
      setSetupNote("会社名を入力してください。");
      return;
    }
    if (creatingCompany) return;
    const createKey = stableIdempotencyKey(companyCreateIdempotencyRef, "company-create", name);
    setCreatingCompany(true);
    setSetupNote("会社を登録しています。");
    try {
      const response = await mvpFetch("/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": createKey },
        body: JSON.stringify({ name })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || "company_create_failed");
      const createdCompanyId = String(result.company?.id ?? "").trim();
      const state = await readMvpState();
      if (!createdCompanyId || !projectOptionsFromState(state).some((project) => project.id === createdCompanyId)) {
        throw new Error("company_create_readback_missing");
      }
      model.setMvpState(state);
      model.setAutomationRows(toAutomationRows(state.automations ?? []));
      model.setFeedbackReadback(state.feedbacks ?? []);
      rememberProject(createdCompanyId);
      model.setReceipt(`${name} を登録しました。最初の自動化を作成できます。`);
      go("#/chat");
    } catch {
      setSetupNote("会社を登録できませんでした。入力内容とAPI接続を確認してください。");
      model.setReceipt("会社登録のreadbackを確認できなかったため、自動化作成画面には進みませんでした。");
    } finally {
      setCreatingCompany(false);
    }
  };
  if (model.mvpLoadStatus === "loading") return <ProjectUnavailablePage reason="会社一覧をAPIから確認しています。" />;
  if (model.mvpLoadStatus === "error") return <ProjectUnavailablePage reason="会社一覧を確認できませんでした。右上の同期から再取得してください。" />;
  const projects = projectOptionsFromState(model.mvpState);
  return (
    <section>
      <PageTitle title="会社" desc="管理する会社と、その会社の自動化を選びます。" />
      {projects.length ? (
      <Panel title="会社一覧" controlId="home.company-list.panel">
        <div className="project-switcher">
            {projects.map(({ id, label }) => <Button controlId={`home.projects.open.${id}`} key={id} onClick={() => { rememberProject(id); go(`#/projects/${id}/automations`); }}>{label}を開く</Button>)}
          </div>
        </Panel>
      ) : (
        <Panel title="最初の会社を登録" controlId="projects.setup.panel">
          <form className="setup-form" onSubmit={createCompany}>
            <label htmlFor="company-name">会社名
              <input id="company-name" data-control-id="projects.setup.name" value={companyName} onChange={(event) => setCompanyName(event.target.value)} maxLength={120} autoComplete="organization" autoFocus aria-describedby="company-setup-status" placeholder="例: 株式会社サンプル" />
            </label>
            <div className="button-row">
              <Button controlId="projects.setup.create" type="submit" variant="primary" disabled={creatingCompany || !companyName.trim()}>{creatingCompany ? "登録中" : "登録して自動化を作る"}</Button>
            </div>
            <div id="company-setup-status" className="action-note" role="status">{setupNote}</div>
          </form>
        </Panel>
      )}
    </section>
  );
}

function ProjectUnavailablePage({ reason }: { reason: string }) {
  return (
    <section>
      <PageTitle title="会社を確認できません" desc="未確認の会社IDでは表示や保存を行いません。" />
      <Panel title="会社スコープ" controlId="home.company-scope.panel">
        <p>{reason}</p>
        <Button controlId="home.company-scope.back" onClick={() => go("#/")}>ホームへ戻る</Button>
      </Panel>
    </section>
  );
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
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
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  React.useEffect(() => {
    if (!open) return;
    const focusTarget = commentRef.current ?? dialogRef.current;
    window.requestAnimationFrame(() => focusTarget?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => element.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
  }, [open]);
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
      const response = await mvpFetch("/api/mvp/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          company_id: rememberedProject(),
          project_id: rememberedProject(),
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
      const screenshotReceipt = result.feedback.screenshot_artifact_id ? `stored:${result.feedback.screenshot_artifact_id}` : "none";
      setReceipt(`フィードバックを送信しました。id=${result.feedback.feedback_id ?? result.feedback.id} / screenshot=${screenshotReceipt}${inbox}`);
    } catch {
      setReceipt("フィードバック保存に失敗しました。API readbackを確認してください。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button data-control-id="feedback.launcher" className="feedback-launcher" type="button" aria-label="フィードバックを送る" title="フィードバックを送る" onClick={() => openFeedback()} disabled={busy}>
        <Camera size={18} />
        <span>Feedback</span>
      </button>
      {open && (
        <div className="feedback-panel" role="dialog" aria-modal="true" aria-labelledby="feedback-panel-title" aria-describedby="feedback-panel-desc" ref={dialogRef} tabIndex={-1}>
          <p id="feedback-panel-desc" className="sr-only">スクショを確認しながら、コメントを入力して送信できます。Escape で閉じられます。</p>
          <div className="feedback-panel-head">
            <div>
              <strong id="feedback-panel-title">フィードバック</strong>
              <small>{route} / {screenshotStatus === "capturing" ? "スクショ取得中" : screenshot ? "スクショあり" : screenshotStatus === "skipped" ? "スクショなしで送信" : screenshotError ? "スクショなし" : "準備済み"}</small>
            </div>
            <IconButton controlId="feedback.panel.close" label="閉じる" onClick={close}><X size={14} /></IconButton>
          </div>
          {feedbackContext && <div className="feedback-context">context: {String(feedbackContext.automation_name ?? feedbackContext.source ?? "page")}</div>}
          {screenshot ? <img className="feedback-preview" src={screenshot} alt="送信する画面キャプチャ" /> : (
            <div className={`feedback-preview missing ${screenshotStatus === "capturing" ? "loading" : ""}`}>
              {screenshotStatus === "capturing" ? "スクショ取得中です。待たずにコメントを書けます。" : "スクショなしでも送れます。URLと画面テキストは一緒に保存されます。"}
              {screenshotError && <small>{screenshotError}</small>}
            </div>
          )}
          <div className="feedback-actions">
            <Button controlId="feedback.panel.screenshot-retake" disabled={busy || screenshotStatus === "capturing"} onClick={() => runCapture(route)}>スクショ再取得</Button>
            <Button controlId="feedback.panel.skip-screenshot" disabled={busy} onClick={skipScreenshot}>スクショなしで送る</Button>
          </div>
          <label htmlFor="feedback-panel-comment">
            コメント
            <textarea id="feedback-panel-comment" ref={commentRef} data-control-id="feedback.panel.comment" aria-describedby="feedback-panel-comment-help" value={comment} disabled={busy} onChange={(event) => setComment(event.target.value)} placeholder="どこが使いにくいか、期待した動き、実際の動きを書いてください。" />
          </label>
          <label className="feedback-confirm" htmlFor="feedback-panel-sensitive-confirm">
            <input id="feedback-panel-sensitive-confirm" data-control-id="feedback.panel.sensitive-confirm" type="checkbox" checked={sensitiveConfirmed} onChange={(event) => setSensitiveConfirmed(event.target.checked)} />
            secret、password、token、本人確認コードが画面に映っていないことを確認しました
          </label>
          <p id="feedback-panel-comment-help" className="muted">password、token、private key、本人確認コードが画面に映っている時は送らないでください。</p>
          <div className="button-row">
            <Button controlId="feedback.panel.submit" variant="primary" icon={<MessageSquare size={14} />} disabled={busy || !sensitiveConfirmed} onClick={submit}>{busy ? "送信中..." : "送信"}</Button>
          </div>
        </div>
      )}
    </>
  );
}

function HomePage({ model }: { model: AppModel }) {
  const { setReceipt, automationRows, mvpState, feedbackReadback } = model;
  if (model.mvpLoadStatus !== "ready") {
    return (
      <section>
        <PageTitle title="ホーム" desc="会社と自動化の最新状態を確認します。" />
        <Panel title="API readback" controlId="home.api-readback.panel">
          <p>{model.mvpLoadStatus === "loading" ? "最新状態を取得しています。件数は取得完了後に表示します。" : "最新状態を確認できませんでした。右上の同期から再取得してください。"}</p>
        </Panel>
      </section>
    );
  }
  const companyOptions = projectOptionsFromState(mvpState);
  const waitingApprovals = (mvpState.approvals ?? []).filter((approval) => approval.status === "waiting" || approval.status === "pending");
  const blockedRuns = (mvpState.runs ?? []).filter((run) => run.status === "blocked");
  const queuedRuns = (mvpState.runs ?? []).filter((run) => run.status === "queued");
  const feedbackRows = feedbackItemsFromState({ ...mvpState, feedbacks: feedbackReadback });
  const openFeedbackCount = feedbackRows.filter((item) => item.status === "open").length;
  const triagedFeedbackCount = feedbackRows.filter((item) => item.status === "triaged").length;
  const queuedJobs = (mvpState.jobs ?? []).filter((job) => job.status === "queued");
  const activeJobs = (mvpState.jobs ?? []).filter((job) => job.status === "leased");
  const openFirstAutomation = () => openAutomationCreator(mvpState, setReceipt);
  const openTemplates = () => {
    const projectId = resolveProjectSelection(mvpState);
    if (projectId) rememberProject(projectId);
    go("#/templates");
  };
  if (!companyOptions.length) {
    return (
      <section>
        <PageTitle title="ホーム" desc="会社と自動化の最新状態を確認します。">
          <Button controlId="home.first-use.register" variant="primary" icon={<Plus size={15} />} onClick={() => go("#/projects")}>会社を登録</Button>
        </PageTitle>
        <Panel title="最初の設定" controlId="home.first-use.panel">
          <div className="first-use-content">
            <strong>会社がまだ登録されていません</strong>
            <p>最初に、自動化を保存する会社を登録します。</p>
            <Button controlId="home.first-use.open-projects" variant="primary" onClick={() => go("#/projects")}>会社名を登録する</Button>
          </div>
        </Panel>
      </section>
    );
  }
  const pristineCompany = automationRows.length === 0
    && waitingApprovals.length === 0
    && (mvpState.runs?.length ?? 0) === 0
    && (mvpState.jobs?.length ?? 0) === 0;
  if (pristineCompany && companyOptions.length === 1) {
    return (
      <section>
        <PageTitle title="ホーム" desc={`${companyOptions[0].label} の準備ができました。`}>
          <Button controlId="home.first-use.chat" variant="primary" icon={<Plus size={15} />} onClick={openFirstAutomation}>自動化を作る</Button>
        </PageTitle>
        <Panel title="最初の自動化を作る" controlId="home.first-use.automation.panel">
          <div className="first-use-content">
            <strong>{companyOptions[0].label}</strong>
            <p>自動化はまだ登録されていません</p>
            <div className="button-row">
              <Button controlId="home.first-use.chat-secondary" variant="primary" icon={<MessageSquare size={14} />} onClick={openFirstAutomation}>チャットで作る</Button>
              <Button controlId="home.first-use.templates" icon={<LayoutTemplate size={14} />} onClick={openTemplates}>テンプレートから選ぶ</Button>
            </div>
          </div>
        </Panel>
      </section>
    );
  }
  if (pristineCompany) {
    return (
      <section>
        <PageTitle title="ホーム" desc={`${companyOptions.length}社から、自動化を作る会社を選びます。`} />
        <Panel title="自動化を作る会社を選択" controlId="home.first-use.company-picker.panel">
          <div className="first-use-content">
            <p>保存先の会社を選ぶと、その会社を選択した状態でチャットを開きます。</p>
            <div className="project-switcher">
              {companyOptions.map((project) => <Button controlId={`home.first-use.company.${project.id}`} key={project.id} onClick={() => { rememberProject(project.id); go("#/chat"); }}>{project.label}で作る</Button>)}
            </div>
          </div>
        </Panel>
      </section>
    );
  }
  const nextAction = waitingApprovals.length
    ? { label: "承認を確認", route: "#/approvals", icon: <ClipboardCheck size={15} /> }
    : blockedRuns.length
      ? { label: "要確認の実行を見る", route: "#/runs", icon: <Activity size={15} /> }
      : { label: "実行履歴を確認", route: "#/runs", icon: <Activity size={15} /> };
  const projectCards = [
    {
      title: "会社",
      value: `${companyOptions.length}社`,
      sub: `自動化 ${automationRows.length}件`,
      status: companyOptions.length ? "enabled" : "waiting"
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
      title: "Jobs",
      value: `${mvpState.jobs?.length ?? 0}件`,
      sub: `queued ${queuedJobs.length} / active ${activeJobs.length}`,
      status: activeJobs.length ? "running" : queuedJobs.length ? "waiting" : "enabled"
    }
  ];
  const liveRows = automationRows.length ? automationRows.map((item) => [
    item.lane,
    projectLabelFromState(mvpState, item.project_id),
    item.name,
    <StatusBadge status={item.status} />,
    <Button controlId={`home.row.open.${item.project_id}.${item.name}`} onClick={() => go(`#/projects/${item.project_id}/automations`)}>自動化一覧を開く</Button>
  ]) : companyOptions.length === 1 ? [[
    "-",
    companyOptions[0].label,
    "自動化はまだ登録されていません",
    <StatusBadge status="draft" label="0件" />,
    <Button controlId="home.row.create.automation" onClick={openFirstAutomation}>新しい自動化</Button>
  ]] : companyOptions.length > 1 ? [[
    "-",
    `${companyOptions.length}社`,
    "保存先の会社を選択してください",
    <StatusBadge status="draft" label="0件" />,
    <Button controlId="home.row.choose.company" onClick={openFirstAutomation}>会社を選んで作る</Button>
  ]] : [[
    "-",
    "会社未登録",
    "会社がまだ登録されていません",
    <StatusBadge status="waiting" label="要登録" />,
    <Button controlId="home.row.open.projects" onClick={() => go("#/projects")}>会社一覧を確認</Button>
  ]];
  return (
    <section>
      <PageTitle title="ホーム" desc="すべての会社と自動化の状態を確認できます。">
        <Button controlId="home.next.open" variant="primary" icon={nextAction.icon} onClick={() => go(nextAction.route)}>{nextAction.label}</Button>
      </PageTitle>
      <div className="cards four">
        {projectCards.map((card) => <MetricCard controlId={`home.metric.${card.title === "会社" ? "company" : card.title === "承認" ? "approvals" : card.title === "実行履歴" ? "runs" : "jobs"}`} key={card.title} title={card.title} value={card.value} sub={card.sub} status={card.status as Status} />)}
      </div>
      <div className="section-grid">
        <Panel title="ライブ実行" className="span-2" controlId="home.live-execution.panel">
          <DataTable controlId="home.live-execution.table" headers={["Lane", "プロジェクト", "タスク", "状態", "操作"]} rows={liveRows} />
        </Panel>
        <Panel title="承認待ち" controlId="home.pending-approvals.panel">
          <div className="approval-widget">
            <strong>承認待ち {waitingApprovals.length}件</strong>
            <span>外部操作は承認前に停止</span>
            <span>queued {queuedRuns.length}件</span>
            <Button controlId="home.approvals.open" variant="primary" onClick={() => go("#/approvals")}>承認キューを開く</Button>
          </div>
        </Panel>
      </div>
      <Panel title="進捗一覧" controlId="home.progress.panel">
        <DataTable controlId="home.progress.table" headers={["対象", "状態", "Schedule", "Lane", "停止条件", "証跡"]} rows={automationRows.map((item) => [
          item.name,
          <StatusBadge status={item.status} />,
          item.schedule,
          item.lane,
          item.status === "enabled" ? "外部操作前に承認停止" : item.last,
          "API / artifact readback"
        ])} />
      </Panel>
      <Panel title="Feedbackサマリ" controlId="home.feedback-summary.panel">
        <div className="feedback-summary compact">
          <strong>open {openFeedbackCount}件</strong>
          <span>triaged {triagedFeedbackCount}件</span>
          <span>triageはOwner専用Adminで行います</span>
        </div>
      </Panel>
    </section>
  );
}

function ChatPage({ model }: { model: AppModel }) {
  const { setReceipt, setAutomationRows, mvpState, setMvpState } = model;
  const [created, setCreated] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [requestText, setRequestText] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [planVisible, setPlanVisible] = useState(false);
  const [plannerReadback, setPlannerReadback] = useState<PlannerReadback | null>(null);
  const [plannerProgress, setPlannerProgress] = useState<PlannerProgress | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(rememberedProject());
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
  const [chatThreadId, setChatThreadId] = useState(() => rememberedChatThread(rememberedProject()));
  const [planning, setPlanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [chatNote, setChatNote] = useState("新しい自動化リクエストを入力できます。");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", text: "どんな自動化を作りたいですか？目的、対象サービス、止めてほしい条件を書いてください。曖昧なところは質問しながら仕様にします。" }
  ]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const submittedPromptRef = useRef("");
  const plannerRequestGeneration = useRef(0);
  const createIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const canonicalProjects = projectOptionsFromState(mvpState);
  React.useEffect(() => {
    if (model.mvpLoadStatus !== "ready") return;
    setSelectedProjectId((current) => {
      const next = resolveProjectSelection(mvpState, current);
      if (next) rememberProject(next);
      return next;
    });
  }, [model.mvpLoadStatus, mvpState]);
  const platformOptions = ["Instagram", "TikTok", "Facebook"];
  const allPlatformsSelected = selectedPlatforms.length === platformOptions.length;
  const draftPrompt = prompt.trim();
  const safePrompt = requestText.trim();
  const activePrompt = draftPrompt || safePrompt;
  const redactedActivePrompt = redactSensitiveText(activePrompt);
  const fallbackPlan = buildAutomationPlan(redactedActivePrompt, selectedPlatforms);
  const plan = plannerReadback?.plan ?? fallbackPlan;
  const targetProject = selectedProjectId;
  const presentationProfile = mvpState.presentation_profiles?.find((profile) => profile.id === targetProject);
  const targetAutomations = (mvpState.automations ?? []).filter((automation) => String(automation.project_id ?? automation.company_id ?? "") === targetProject);
  const selectedAutomation = targetAutomations.find((automation) => automation.id === selectedAutomationId) ?? targetAutomations[0];
  const plannerAdapter = plannerReadback?.planner_adapter ?? "client_deterministic_preview";
  const plannerMode = plannerReadback?.planner_mode ?? "not_requested";
  const plannerPublicBlocker = plannerReadback?.exact_blocker ? publicBlockerSummary(plannerReadback.exact_blocker) : null;
  const targetProjectIsVerified = model.mvpLoadStatus === "ready" && Boolean(targetProject) && canonicalProjects.some((project) => project.id === targetProject);
  const canCreatePlan = plannerReadback?.can_create === true && targetProjectIsVerified;
  const isCreateAutomationPlan = plannerReadback?.planner_operation === "create_automation";
  const isManageWorkflowPlan = plannerReadback?.planner_operation === "manage_workflow";
  const canAdjustSchedule = isManageWorkflowPlan
    && plannerReadback?.planner_mode === "ready_to_schedule"
    && targetProjectIsVerified
    && Boolean(selectedAutomation?.id);
  const resetChat = () => {
    plannerRequestGeneration.current += 1;
    setPlanning(false);
    setPrompt("");
    setRequestText("");
    submittedPromptRef.current = "";
    setSelectedPlatforms([]);
    setPlanVisible(false);
    setPlannerReadback(null);
    setPlannerProgress(null);
    setPlannerError(null);
    setCreated(false);
    createIdempotencyRef.current = null;
    setChatThreadId("");
    clearChatThread(selectedProjectId);
    setMessages([{ id: "welcome", role: "assistant", text: "リセットしました。前の計画や選択は引き継がず、新しい自動化として考えます。" }]);
    setReceipt("チャットをリセットしました。新しい自動化リクエストを入力できます。");
    setChatNote(`リセット完了: platform=0 / plan=false / ${actionStamp()}`);
    promptRef.current?.focus();
  };
  React.useEffect(() => {
    setChatThreadId(rememberedChatThread(selectedProjectId));
    setSelectedAutomationId("");
  }, [selectedProjectId]);
  React.useEffect(() => {
    if (!selectedAutomationId || !targetAutomations.some((automation) => automation.id === selectedAutomationId)) {
      setSelectedAutomationId(targetAutomations[0]?.id ?? "");
    }
  }, [selectedAutomationId, targetAutomations.map((automation) => automation.id).join("|")]);
  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((items) => {
      const next = items.includes(platform) ? items.filter((item) => item !== platform) : [...items, platform];
      setChatNote(`投稿先を更新: ${next.length ? next.join(" / ") : "未選択"} / ${actionStamp()}`);
      return next;
    });
    setPlanVisible(false);
    setPlannerReadback(null);
    setPlannerProgress(null);
    setPlannerError(null);
    setCreated(false);
    createIdempotencyRef.current = null;
  };
  const selectAllPlatforms = () => {
    const next = allPlatformsSelected ? [] : platformOptions;
    setSelectedPlatforms(next);
    setPlanVisible(false);
    setPlannerReadback(null);
    setPlannerProgress(null);
    setPlannerError(null);
    setCreated(false);
    createIdempotencyRef.current = null;
    setChatNote(`投稿先を${allPlatformsSelected ? "全解除" : "一括選択"}: ${next.length ? next.join(" / ") : "未選択"} / ${actionStamp()}`);
  };
  const startPlan = async () => {
    if (!activePrompt) {
      promptRef.current?.focus();
      setReceipt("自動化リクエストを入力してからプランを作成してください。");
      setChatNote(`プラン作成待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    const requestGeneration = plannerRequestGeneration.current + 1;
    plannerRequestGeneration.current = requestGeneration;
    createIdempotencyRef.current = null;
    setPlanning(true);
    try {
      const readback = await requestChatPlan(redactedActivePrompt, selectedPlatforms, {
        projectId: selectedProjectId,
        threadId: plannerReadback?.chat_thread_id ?? chatThreadId ?? undefined,
        messages: [...messages, { id: "current", role: "user", text: redactedActivePrompt }],
        onProgress: (progress) => {
          if (plannerRequestGeneration.current === requestGeneration) setPlannerProgress(progress);
        }
      });
      if (plannerRequestGeneration.current !== requestGeneration) return;
      setPlannerReadback(readback);
      if (readback.chat_thread_id) {
        setChatThreadId(readback.chat_thread_id);
        rememberChatThread(selectedProjectId, readback.chat_thread_id);
      }
      setPlannerError(null);
      setRequestText(redactedActivePrompt);
      submittedPromptRef.current = activePrompt.trim();
      setPlanVisible(true);
      setCreated(false);
      setMessages((items) => [
        ...items,
        { id: nextChatId("assistant-plan"), role: "assistant", text: readback.server_reply }
      ]);
      setReceipt(`plannerの回答を確認しました。planner=${readback.planner_adapter} / external_action=false`);
      setChatNote(`planner回答完了: ${readback.plan.title} / ${actionStamp()}`);
    } catch {
      if (plannerRequestGeneration.current !== requestGeneration) return;
      setPlannerReadback(null);
      setPlanVisible(false);
      setCreated(false);
      setPlannerError("プランAPIの結果を確認できませんでした。自動化の作成は確認されておらず、プラン送信の到達状態は不明です。");
      setReceipt("プラン作成結果を確認できませんでした。自動化の作成は確認されていません。");
      setChatNote(`プラン作成失敗: API接続を確認してください / ${actionStamp()}`);
    } finally {
      if (plannerRequestGeneration.current === requestGeneration) setPlanning(false);
    }
  };
  const sendMessage = async () => {
    if (!draftPrompt) {
      promptRef.current?.focus();
      setReceipt("まず作りたい自動化を入力してください。");
      setChatNote(`送信待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    const redactedDraft = redactSensitiveText(draftPrompt);
    const requestGeneration = plannerRequestGeneration.current + 1;
    plannerRequestGeneration.current = requestGeneration;
    createIdempotencyRef.current = null;
    setPlanning(true);
    try {
      const readback = await requestChatPlan(redactedDraft, selectedPlatforms, {
        projectId: selectedProjectId,
        threadId: plannerReadback?.chat_thread_id ?? chatThreadId ?? undefined,
        messages: [...messages, { id: "current", role: "user", text: redactedDraft }],
        onProgress: (progress) => {
          if (plannerRequestGeneration.current === requestGeneration) setPlannerProgress(progress);
        }
      });
      if (plannerRequestGeneration.current !== requestGeneration) return;
      const currentPlan = readback.plan;
      setPlannerReadback(readback);
      if (readback.chat_thread_id) {
        setChatThreadId(readback.chat_thread_id);
        rememberChatThread(selectedProjectId, readback.chat_thread_id);
      }
      setPlannerError(null);
      setRequestText(redactedDraft);
      submittedPromptRef.current = draftPrompt;
      setPrompt("");
      setMessages((items) => [
        ...items,
        { id: nextChatId("user"), role: "user", text: redactedDraft },
        { id: nextChatId("assistant"), role: "assistant", text: readback.server_reply }
      ]);
      setPlanVisible(true);
      setCreated(false);
      setReceipt(`plannerの会話結果を更新しました。planner=${readback.planner_adapter} / mode=${readback.planner_mode}`);
      setChatNote(`送信完了: ${currentPlan.title} / ${actionStamp()}`);
    } catch {
      if (plannerRequestGeneration.current !== requestGeneration) return;
      setPlannerReadback(null);
      setPlanVisible(false);
      setCreated(false);
      setPlannerError("プランAPIの結果を確認できませんでした。自動化の作成は確認されておらず、プラン送信の到達状態は不明です。");
      setReceipt("送信結果を確認できませんでした。自動化の作成は確認されていません。");
      setChatNote(`送信失敗: API接続を確認してください / ${actionStamp()}`);
    } finally {
      if (plannerRequestGeneration.current === requestGeneration) setPlanning(false);
    }
  };
  const editPlan = () => {
    setPrompt(redactSensitiveText(safePrompt));
    setPlanVisible(false);
    setCreated(false);
    createIdempotencyRef.current = null;
    setReceipt("内容を修正できます。入力後にプランを再作成してください。");
    setChatNote(`修正モード: 既存内容を入力欄へ戻しました / ${actionStamp()}`);
    promptRef.current?.focus();
  };
  const openDetails = () => {
    if (!canCreatePlan) {
      setReceipt(plannerReadback?.creation_blocker ?? "作成可能な自動化プランを確認できませんでした。");
      return;
    }
    setReceipt("詳細設定を開きました。Lane・承認・リトライ条件を確認できます。");
    setChatNote(`詳細設定へ移動: project=${targetProject} / kind=${plan.kind} / ${actionStamp()}`);
    rememberProject(targetProject);
    go(`#/projects/${targetProject}/automations/${automationSlugForKind(plan.kind)}/edit`);
  };
  const saveAdjustedSchedule = async () => {
    if (!canAdjustSchedule || !selectedAutomation?.id) {
      setReceipt("対象自動化と、保存可能な定期実行案を確認してください。外部操作は実行していません。");
      return;
    }
    const currentSchedule = (mvpState.schedules ?? []).find((schedule) => String(schedule.automation_id ?? schedule.automationId ?? "") === selectedAutomation.id);
    const kind = scheduleKindForPlan(plan);
    const expression = plan.schedule.trim();
    if (!expression) {
      setReceipt("定期実行の式が未確定です。チャットで時刻・曜日を指定してください。");
      return;
    }
    setCreating(true);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(targetProject)}/automations/${encodeURIComponent(selectedAutomation.id)}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          expression,
          timezone: String(currentSchedule?.timezone ?? "Asia/Tokyo"),
          enabled: currentSchedule?.enabled !== false,
          expected_revision: Number(currentSchedule?.revision ?? 1)
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.exactBlocker || body.exact_blocker || body.error || `schedule_adjust_http_${response.status}`);
      const freshState = await readMvpState();
      setMvpState(freshState);
      setAutomationRows(toAutomationRows(freshState.automations ?? []));
      const saved = (freshState.schedules ?? []).find((schedule: any) => String(schedule.automation_id ?? schedule.automationId ?? "") === selectedAutomation.id);
      setReceipt(`既存自動化の定期実行を保存しました。automation=${selectedAutomation.id} / kind=${saved?.kind ?? kind} / revision=${saved?.revision ?? "?"} / next=${saved?.next_run_at ?? "未計算"} / external_action=false`);
      setChatNote(`定期実行の調整を保存しました: ${selectedAutomation.name ?? selectedAutomation.id} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "schedule_adjust_failed";
      setReceipt(`定期実行の調整は未確認です: ${exact}。revisionを再読込してから再試行してください。`);
      setChatNote(`定期実行の調整停止: ${exact} / ${actionStamp()}`);
    } finally {
      setCreating(false);
    }
  };
  const createFromChat = async () => {
    if (!activePrompt) {
      promptRef.current?.focus();
      setReceipt("自動化リクエストを入力してから作成してください。");
      setChatNote(`作成待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    if (!plannerReadback?.can_create) {
      setCreated(false);
      setReceipt(plannerReadback?.creation_blocker ?? "作成可能な自動化プランを確認できませんでした。");
      setChatNote(`作成待ち: plannerの確認事項を完了してください / ${actionStamp()}`);
      return;
    }
    if (!projectOptionsFromState(mvpState).some((project) => project.id === targetProject)) {
      setCreated(false);
      setReceipt("現在のAPI readbackで確認できない会社には保存できません。会社一覧から選び直してください。");
      setChatNote(`作成停止: 会社スコープ未確認 / ${actionStamp()}`);
      return;
    }
    if (creating) return;
    const createFingerprint = [
      targetProject,
      plannerReadback.automation_type,
      redactedActivePrompt,
      plan.title,
      plan.schedule,
      plan.cadence
    ].join("|");
    const createKey = stableIdempotencyKey(createIdempotencyRef, "chat-automation-create", createFingerprint);
    let createdAutomationId = "";
    setCreating(true);
    try {
      const response = await mvpFetch("/api/mvp/automations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": createKey },
        body: JSON.stringify({
          name: `${plan.kind}: ${redactedActivePrompt}`.slice(0, 80),
          project_id: targetProject,
          automation_type: plannerReadback.automation_type,
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
      createdAutomationId = String(result.automation?.id ?? "");
      let freshState = result.state;
      let scheduleNote = "定期実行はBuilderの実設定で確認してください。";
      if (["daily", "weekly", "monthly"].includes(plan.cadence)) {
        const scheduleUrl = `/api/v1/companies/${encodeURIComponent(targetProject)}/automations/${encodeURIComponent(result.automation.id)}/schedule`;
        const scheduleRead = await mvpFetch(scheduleUrl, { cache: "no-store" });
        const scheduleReadBody = await scheduleRead.json().catch(() => ({}));
        if (!scheduleRead.ok) throw new Error(scheduleReadBody.exactBlocker || scheduleReadBody.error || `schedule_read_http_${scheduleRead.status}`);
        let savedSchedule = scheduleReadBody.schedule;
        const scheduleKind = scheduleKindForPlan(plan);
        if (savedSchedule && (savedSchedule.kind !== scheduleKind || String(savedSchedule.expression ?? "") !== String(plan.schedule))) {
          throw new Error("schedule_existing_mismatch");
        }
        if (!savedSchedule) {
          const scheduleResponse = await mvpFetch(scheduleUrl, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: scheduleKind, expression: plan.schedule, timezone: "Asia/Tokyo", enabled: true, expected_revision: 1 })
          });
          const scheduleResult = await scheduleResponse.json().catch(() => ({}));
          if (!scheduleResponse.ok) throw new Error(scheduleResult.exactBlocker || scheduleResult.exact_blocker || scheduleResult.error || `schedule_save_http_${scheduleResponse.status}`);
          savedSchedule = scheduleResult.schedule;
        }
        freshState = await readMvpState();
        scheduleNote = `定期実行を保存確認しました。schedule_revision=${savedSchedule?.revision ?? "?"} / next=${savedSchedule?.nextRunAt ?? savedSchedule?.next_run_at ?? "未計算"}`;
      }
      setMvpState(freshState);
      setAutomationRows(toAutomationRows(freshState.automations ?? []));
      setCreated(true);
      setReceipt(`Automation Builder に自動化案を保存しました。automation=${result.automation.id} / ${scheduleNote}`);
      setChatNote(`作成完了: automation=${result.automation.id} / ${scheduleNote} / ${actionStamp()}`);
      rememberProject(targetProject);
      go(`#/projects/${targetProject}/automations/${result.automation.id}/edit`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "create_automation_failed";
      if (createdAutomationId) {
        try {
          const recoveryState = await readMvpState();
          setMvpState(recoveryState);
          setAutomationRows(toAutomationRows(recoveryState.automations ?? []));
        } catch {
          // Keep the exact partial-save boundary in the receipt; no success is inferred.
        }
        setCreated(false);
        setReceipt(`automation=${createdAutomationId} は作成済みですが、定期実行の保存を確認できませんでした: ${exact}`);
        setChatNote(`部分保存: automation=${createdAutomationId} / Builderで定期実行を確認してください / ${actionStamp()}`);
        rememberProject(targetProject);
        go(`#/projects/${targetProject}/automations/${createdAutomationId}/edit`);
        return;
      }
      setCreated(false);
      setReceipt(`Automation Builderへの保存を確認できませんでした: ${exact}。実体のない編集画面へは進みません。`);
      setChatNote(`作成失敗: MVP API readbackを確認してください / ${exact} / ${actionStamp()}`);
    } finally {
      setCreating(false);
    }
  };
  if (model.mvpLoadStatus === "ready" && canonicalProjects.length === 0) {
    return (
      <section className="chat-page">
        <PageTitle title="チャット" desc="自動化を保存する会社が必要です。" />
        <Panel title="会社を登録してください" controlId="chat.company-required.panel">
          <div className="first-use-content">
            <p>会社を登録すると、その会社専用の自動化を作成できます。</p>
            <Button controlId="chat.company-required.open" variant="primary" onClick={() => go("#/projects")}>会社を登録する</Button>
          </div>
        </Panel>
      </section>
    );
  }
  return (
    <section className="chat-page">
      <PageTitle title="チャット" desc="自然言語から自動化を作成します。">
        <Button controlId="chat.reset" icon={<RefreshCw size={14} />} onClick={resetChat} disabled={planning || creating}>会話をリセット</Button>
      </PageTitle>
      <label className="chat-input">
        保存先の会社
        <select data-control-id="chat.project-select" aria-label="保存先の会社" value={selectedProjectId} disabled={planning || creating || model.mvpLoadStatus !== "ready"} onChange={(event) => {
          const projectId = event.target.value;
          setSelectedProjectId(projectId);
          if (projectId) rememberProject(projectId);
          setCreated(false);
        }}>
          <option value="">会社を選択してください</option>
          {canonicalProjects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select>
      </label>
      {isManageWorkflowPlan && (
        <label className="chat-input">
          調整対象の自動化
          <select data-control-id="chat.automation-select" aria-label="調整対象の自動化" value={selectedAutomation?.id ?? ""} disabled={planning || creating || !targetAutomations.length} onChange={(event) => setSelectedAutomationId(event.target.value)}>
            <option value="">自動化を選択してください</option>
            {targetAutomations.map((automation) => <option key={automation.id} value={automation.id}>{automation.name ?? automation.id}</option>)}
          </select>
          {!targetAutomations.length && <small>この会社に保存済みの自動化がありません。</small>}
        </label>
      )}
      <div className="action-note" role="status">{chatNote}</div>
      {plannerError && <div className="notice-row" role="alert">{plannerError}</div>}
      {presentationProfile && <div className="notice-row" role="status">
        表示プロファイル: {presentationProfile.label} / {presentationProfile.explanation ?? "このプロジェクトのreadbackに合わせて表示します。"}
      </div>}
      {mvpState.browser_use_runtime && <div className="notice-row" role="status">
        Browser Use: {mvpState.browser_use_runtime.status ?? "unknown"}{mvpState.browser_use_runtime.exactBlocker ? " / canonical Browser Use helperの確認が必要です" : ""} / {mvpState.browser_use_runtime.fallbackPolicy ?? "readback待ち"} / registered lanes {mvpState.browser_use_runtime.lanes?.length ?? 0}
      </div>}
      <div className="choice-row" aria-label="司令室ショートカット">
        {["システム全体を確認", "定期実行を作成", "既存定期実行を調整", "失敗を確認"].map((shortcut) => (
          <button data-control-id={`chat.shortcut.${shortcut}`} disabled={planning || creating} key={shortcut} onClick={() => {
            setPrompt(shortcut);
            setPlanVisible(false);
            setPlannerReadback(null);
            setPlannerProgress(null);
            setChatNote(`${shortcut}を入力欄にセットしました / ${actionStamp()}`);
            promptRef.current?.focus();
          }}>{shortcut}</button>
        ))}
      </div>
      <div className="chat-shell">
        <div className="chat-thread">
          <div className="message-list" aria-live="polite">
            {messages.map((message) => <Bubble key={message.id} side={message.role === "user" ? "user" : undefined}>{message.text}</Bubble>)}
          </div>
          <ChatProgressPanel progress={plannerProgress} planning={planning} />
          <div className="choice-row" aria-label={`投稿先サービス（${selectedPlatforms.length}件選択）`}>
            {platformOptions.map((platform) => (
              <button type="button" data-control-id={`chat.platform.toggle.${platform}`} aria-pressed={selectedPlatforms.includes(platform)} disabled={planning || creating} className={selectedPlatforms.includes(platform) ? "selected" : ""} onClick={() => togglePlatform(platform)} key={platform}>{platform}</button>
            ))}
            <button type="button" data-control-id="chat.platform.select-all" aria-pressed={allPlatformsSelected} disabled={planning || creating} className={allPlatformsSelected ? "selected" : ""} onClick={selectAllPlatforms}>{allPlatformsSelected ? "全て解除" : "全て選択"}</button>
            <button type="button" data-control-id="chat.details.focus" disabled={planning || creating} onClick={() => { setChatNote(`詳細入力へフォーカスしました / ${actionStamp()}`); promptRef.current?.focus(); }}>詳細を書く</button>
          </div>
          <label className="chat-input">
            自動化リクエスト
            <textarea
              data-control-id="chat.prompt"
              ref={promptRef}
              aria-label="自動化リクエスト"
              value={prompt}
              disabled={planning || creating}
              onChange={(event) => {
                const nextPrompt = event.target.value;
                const normalizedNextPrompt = nextPrompt.trim();
                if (planVisible && normalizedNextPrompt && normalizedNextPrompt === submittedPromptRef.current) return;
                setPrompt(nextPrompt);
                setPlanVisible(false);
                setCreated(false);
                createIdempotencyRef.current = null;
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
                createIdempotencyRef.current = null;
                setChatNote(`改行を挿入しました / ${actionStamp()}`);
              }}
              placeholder="例: 毎日GoogleでAIの最新情報を探してまとめてLINEに通知する自動化を作って。"
            />
          </label>
          <div className="button-row">
            <Button controlId="chat.send" variant="primary" icon={<MessageSquare size={14} />} onClick={sendMessage} disabled={!draftPrompt || planning || creating}>{planning ? "確認中" : "送信して考える"}</Button>
            <Button controlId="chat.recreate" onClick={startPlan} disabled={!activePrompt || planning || creating}>プランを再作成</Button>
            <Button controlId="chat.reset-input" onClick={resetChat} disabled={planning || creating}>入力をリセット</Button>
          </div>
          {planVisible && (
          <div className="plan-card">
            <h3>{plan.title}</h3>
            {isCreateAutomationPlan && <p className="muted">{plan.targetLabel} / {plan.cadence} / {plan.schedule} / 外部操作前に承認停止</p>}
            <p className="muted">source: {plannerAdapter} / mode: {plannerMode}{plannerPublicBlocker ? ` / ${plannerPublicBlocker}` : ""}</p>
            {plannerReadback?.chat_job_id && <p className="muted">job: {plannerReadback.chat_job_id} / thread: {plannerReadback.chat_thread_id ?? "未接続"} / turn: {plannerReadback.chat_turn_id ?? "未確定"}</p>}
            <p>{plannerReadback?.server_reply}</p>
            {plannerReadback?.proposed_changes?.length ? <div className="question-box"><strong>保存候補の変更</strong>{plannerReadback.proposed_changes.map((change) => <p key={`${change.target}-${change.field}`}>{change.target} / {change.field}: {change.before ? `${change.before} → ` : ""}{change.after}</p>)}</div> : null}
            {plannerReadback?.requires_confirmation?.length ? <div className="question-box"><strong>確認が必要なこと</strong>{plannerReadback.requires_confirmation.map((item) => <p key={item}>{item}</p>)}</div> : null}
            {plan.steps.map((s, i) => <div className="step-line" key={s}><span>{i + 1}</span>{s}</div>)}
            <div className="question-box">
              <strong>確認したいこと</strong>
              {plan.questions.map((question) => <p key={question}>{question}</p>)}
            </div>
            <div className="button-row">
              {isCreateAutomationPlan && <Button controlId="chat.create" variant="primary" onClick={createFromChat} disabled={!canCreatePlan || creating}>{creating ? "保存確認中" : "この内容で作成"}</Button>}
              {isManageWorkflowPlan && <Button controlId="chat.adjust-schedule" variant="primary" onClick={saveAdjustedSchedule} disabled={!canAdjustSchedule || creating}>{creating ? "調整を保存中" : "定期実行を調整して保存"}</Button>}
              <Button controlId="chat.edit" onClick={editPlan} disabled={creating}>内容を修正</Button>
              <Button controlId="chat.open-details" onClick={openDetails} disabled={!canCreatePlan || creating}>詳細設定を開く</Button>
            </div>
            {isManageWorkflowPlan
              ? <p className="muted">{canAdjustSchedule ? "このボタンは選択した自動化のschedule APIだけをrevision付きで更新します。外部投稿・送信は実行しません。" : "既存自動化を選び、時刻・曜日などを具体化すると保存できます。"}</p>
              : !canCreatePlan && <p className="muted">{plannerReadback?.can_create && !targetProjectIsVerified ? "保存先の会社を会社一覧から選択してください" : plannerReadback?.creation_blocker}</p>}
          </div>
          )}
          {created && <Bubble>作成済みです。Automation Builder で仕様を編集できます。</Bubble>}
        </div>
        <aside className="side-panel">
          <h3>Automation Builder</h3>
          <p>{planVisible ? (isCreateAutomationPlan ? `${plan.kind}として仕様化中です。${plan.safetyNote}` : "plannerの回答を表示しています。新規自動化としては保存しません。") : "入力と選択が完了すると、ここに自動化案の状態が反映されます。"}</p>
          <p className="muted">{planVisible ? (isCreateAutomationPlan ? `${plan.targetLabel} / ${plan.schedule} / ${plan.cadence}` : plan.title) : "送信すると会話とプランが更新されます。"}</p>
          <p className="muted">{planVisible ? `Codex App Server ${plannerAdapter} / thread ${plannerReadback?.chat_thread_id ?? "未接続"}` : "システム状態を読んで、質問・作成・調整・失敗確認に分けます。"}</p>
          <StatusBadge status="draft" />
        </aside>
      </div>
    </section>
  );
}

function AutomationsPage({ model }: { model: AppModel }) {
  const { setReceipt, automationRows, mvpState, setMvpState, setAutomationRows } = model;
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabelFromState(mvpState, activeProject);
  const visibleAutomationRows = automationRows.filter((row) => (row.project_id ?? activeProject) === activeProject);
  const [registeredReadback, setRegisteredReadback] = useState<RegisteredAutomationReadback>({});
  const [registeredReceipts, setRegisteredReceipts] = useState<Record<string, string>>({});
  const [registeredRequestingId, setRegisteredRequestingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [pageNote, setPageNote] = useState("定期実行を開きました。押した操作の結果はここにも表示します。");
  const registeredRequestInFlight = useRef(false);
  React.useEffect(() => {
    let stale = false;
    setPageNote(`${projectName} 定期実行を開きました。押した操作の結果はここにも表示します / ${actionStamp()}`);
    if (!activeProject) {
      setRegisteredReadback({});
      setRegisteredReceipts({});
      return () => {
        stale = true;
      };
    }
    mvpFetch(`/api/mvp/registered-automations?project_id=${encodeURIComponent(activeProject)}`, { cache: "no-store" })
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
      const response = await mvpFetch(`/api/mvp/registered-automations/${encodeURIComponent(item.id)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: activeProject })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exact_blocker || result.error || `registered_automation_http_${response.status}`);
      if (result.ok) {
        const readOnly = result.read_only === false ? "false" : "true";
        const externalAction = result.external_action_executed === true ? "true" : "false";
        const proof = result.latest_proof ? `proof=${result.latest_proof.status ?? "available"}` : "proof=artifact_readback_pending";
        const blocker = publicBlockerSummary(result.exact_blocker ?? result.blocked_action);
        const next = externalAction === "true" ? "停止: 外部action検出のため証跡確認" : "次: proof/readback確認、必要なら人間ログイン/CDP lane";
        const message = `accepted / read-only=${readOnly} / external_action=${externalAction} / ${proof} / blocker=${blocker} / ${next}`;
        setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
        setReceipt(`${name}: ${message}`);
        setPageNote(`${name}: ${message} / ${actionStamp()}`);
        return;
      }
      const proof = result.latest_proof ? ` / latest=${result.latest_proof.status ?? "proof"} ${result.latest_proof.checked_at ?? ""}` : "";
      const message = `blocked / read-only=true / 確認事項=${publicBlockerSummary(result.exact_blocker ?? "registered_automation_preflight_only")}${proof}`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "registered_automation_request_failed";
      const message = `blocked / read-only=true / 確認事項=${publicBlockerSummary(exact)} / 実行開始なし`;
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
    const blocker = publicBlockerSummary(item.exact_blocker ?? item.blocked_action);
    const next = item.can_run ? "次: read-only preflightを実行" : "次: 確認事項を解消してproofを確認";
    const message = `${status} / read-only=true / ${action} / 確認事項=${blocker}${proof} / external_action=false / ${next}`;
    setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
    setReceipt(`${item.name ?? item.id}: ${message}`);
    setPageNote(`${item.name ?? item.id}: ${message} / ${actionStamp()}`);
  };
  const archiveAutomation = async (automation: AutomationRow) => {
    try {
      setArchivingId(automation.id);
      setPageNote(`${automation.name}: アーカイブを保存中 / ${actionStamp()}`);
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/automations/${encodeURIComponent(automation.id)}`, {
        method: "DELETE",
        headers: { "if-match": String(automation.revision) }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exactBlocker || result.error || `automation_archive_http_${response.status}`);
      const state = await readMvpState();
      setMvpState(state);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      const message = `${automation.name}: revision ${result.automation?.revision ?? "?"} でアーカイブし、API readbackで一覧から除外されました。`;
      setReceipt(message);
      setPageNote(`${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "automation_archive_failed";
      setReceipt(`${automation.name}: アーカイブ未確認 / ${exact}`);
      setPageNote(`${automation.name}: アーカイブ未確認 / ${exact} / ${actionStamp()}`);
    } finally {
      setArchivingId(null);
    }
  };
  return (
    <section>
      <ProjectTabs mvpState={mvpState} />
      <PageTitle title={projectName} desc="定期実行">
        <Button controlId="projects.new" icon={<Plus size={15} />} variant="primary" onClick={() => { setPageNote(`新規追加: チャットへ移動します / ${actionStamp()}`); go("#/chat"); }}>新規追加</Button>
      </PageTitle>
      <div className="action-note" role="status">{pageNote}</div>
      <ProjectScopeNotice projectId={activeProject} mvpState={mvpState} />
      <ProjectPresentationProfileSummary model={model} companyId={activeProject} context="automations" />
      {activeProject && (
        <Panel title={`${projectName} 操作ガイド`} controlId="projects.guide.panel">
          <div className="status-grid">
            <div><strong>実行ボタン</strong><span>read-only preflightを行い、外部投稿・応募・削除は実行しません。</span></div>
            <div><strong>結果表示</strong><span>押下後はこのページ上部、行内receipt、上部バーに exact blocker / proof / external_action を表示します。</span></div>
            <div><strong>次に必要なこと</strong><span>ログイン、CDP lane、sandbox/test承認、OTP/本人確認などが必要な時は人間対応として表示します。</span></div>
            <div><strong>安全境界</strong><span>UI操作は external_action=false を期待境界にし、readbackで true が出た場合はblockerとして扱います。</span></div>
          </div>
        </Panel>
      )}
      <Panel title="自動化一覧" controlId="projects.automation.panel">
        <DataTable controlId="projects.automation.table" headers={["タスク名", "説明", "スケジュール", "Lane", "最終実行", "ステータス", "操作"]} rows={visibleAutomationRows.length ? visibleAutomationRows.map((a) => [a.name, a.desc, <div data-control-id={`projects.automation.schedule.${a.id}`}><strong>{a.schedule}</strong><small>next {a.next_run_at} / version {a.schedule_version}</small></div>, a.lane, a.last, <StatusBadge status={a.status} />, <div className="row-actions"><IconButton controlId={`projects.automation.edit.${a.id}`} label={`${a.name}を編集`} onClick={() => { setPageNote(`${a.name}: 編集画面へ移動します / ${actionStamp()}`); go(`#/projects/${activeProject}/automations/${a.id}/edit`); }}><Edit3 size={14} /></IconButton><IconButton controlId={`projects.automation.archive.${a.id}`} label={`${a.name}をアーカイブ`} disabled={Boolean(archivingId)} onClick={() => archiveAutomation(a)}>{archivingId === a.id ? <Clock size={14} /> : <Archive size={14} />}</IconButton></div>]) : [["このプロジェクトの自動化はまだありません", "チャットから追加できます", "-", "-", "-", <StatusBadge status="draft" />, <Button controlId="projects.automation.create" onClick={() => { setPageNote(`作成する: チャットへ移動します / ${actionStamp()}`); go("#/chat"); }}>作成する</Button>]]} />
      </Panel>
      {activeProject && (
        <Panel title="Codex App登録済み自動化" controlId="projects.registered.panel">
          <p className="muted">{projectName}の会社スコープでreadbackします。外部投稿・応募・削除・認証突破はせず、押した操作はproof確認か exact blocker を返します。</p>
          <DataTable
            controlId="projects.registered.table"
            headers={["名前", "状態", "実行クラス", "判定", "Blocker / Proof", "操作"]}
            rows={(registeredReadback.automations ?? []).length ? (registeredReadback.automations ?? []).map((item) => [
              item.name ?? item.id,
              item.status ?? "-",
              item.execution_class ?? "-",
              <StatusBadge status={item.can_run ? "enabled" : item.latest_proof ? "approved" : "blocked"} label={item.action_label ?? item.ui_action ?? "read-only"} />,
              item.latest_proof ? `${item.latest_proof.status ?? "proof"} / 保存済み記録あり` : publicBlockerSummary(item.exact_blocker ?? item.blocked_action),
              <div className="row-actions">
                <button
                  type="button"
                  data-control-id={`projects.registered.open.${item.id}`}
                  className="icon-btn"
                  aria-label={item.action_label ?? "確認"}
                  title={item.action_label ?? "確認"}
                  onClick={() => requestRegisteredRun(item)}
                  disabled={Boolean(registeredRequestingId)}
                >
                  {registeredRequestingId === item.id ? <Clock size={14} /> : item.can_run ? <Play size={14} /> : <ShieldCheck size={14} />}
                </button>
                <IconButton controlId={`projects.registered.issue.${item.id}`} label="問題を送る" onClick={() => openFeedbackFor(`${item.name ?? item.id}: `, {
                  source: "registered_automation",
                  automation_id: item.id,
                  automation_name: item.name ?? item.id,
                  project_id: activeProject,
                  preflight_status: item.preflight_status ?? item.ui_action ?? item.action_label ?? "read-only",
                  exact_blocker: item.exact_blocker ?? item.blocked_action ?? "",
                  route: location.hash || `#/projects/${activeProject}/automations`
                })}><AlertTriangle size={14} /></IconButton>
                <IconButton controlId={`projects.registered.detail.${item.id}`} label="詳細" onClick={() => describeRegistered(item)}><MoreHorizontal size={14} /></IconButton>
                {registeredReceipts[item.id] && <small className="inline-action-receipt">{registeredReceipts[item.id]}</small>}
              </div>
            ]) : [["Codex App登録自動化のreadbackがありません", registeredReadback.exact_boundary ?? "unavailable", "-", "-", "-", <StatusBadge status="waiting" label="read-only" />]]}
          />
          <div className="receipt-strip">company-scoped readback / count={registeredReadback.automation_count ?? registeredReadback.automations?.length ?? 0} / external_action=false</div>
        </Panel>
      )}
    </section>
  );
}

function BuilderPage({ model }: { model: AppModel }) {
  const { setReceipt, mvpState, setMvpState, setAutomationRows } = model;
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabelFromState(mvpState, activeProject);
  const routeAutomationKey = automationIdFromRoute(route);
  const persistedAutomation = mvpState.automations?.find((item) => item.id === routeAutomationKey && (item.project_id ?? item.company_id ?? activeProject) === activeProject)
    ?? mvpState.automations?.find((item) => (item.project_id ?? item.company_id ?? activeProject) === activeProject && item.automation_type === routeAutomationKey);
  const automationId = persistedAutomation?.id ?? routeAutomationKey;
  const persistedSpec = mvpState.builder_specs?.find((item) => item.automation_id === automationId);
  const persistedSchedule = mvpState.schedules?.find((item) => String(item.automation_id ?? item.automationId ?? "") === automationId);
  const builderType = persistedAutomation?.automation_type ?? routeAutomationKey;
  const builderConfig = builderConfigForAutomationType(builderType);
  const builderKind = builderConfig.kindLabel;
  const builderTitle = `${builderKind} 自動化仕様`;
  const automationName = persistedAutomation?.name ?? builderConfig.automationName;
  const persistedStepRecords: Array<{ title: string; enabled: boolean }> = Array.isArray(persistedSpec?.spec?.steps)
    ? persistedSpec.spec.steps
      .map((step: any) => ({ title: typeof step === "string" ? step : step?.title, enabled: typeof step === "string" ? true : step?.enabled !== false }))
      .filter((step: { title?: unknown }): step is { title: string; enabled: boolean } => typeof step.title === "string" && Boolean(step.title.trim()))
    : [];
  const [builderDraft, setBuilderDraft] = useState({
    name: automationName,
    lane: persistedAutomation?.lane ?? "未設定",
    schedule: persistedSpec?.spec?.schedule_hint ?? "",
    approval_policy: persistedAutomation?.approval_policy ?? builderConfig.approvalPolicy,
    retry_rule: persistedSpec?.spec?.retry_rule ?? ""
  });
  const enabled = persistedStepRecords.length ? persistedStepRecords.map((step) => step.enabled) : builderConfig.steps.map(() => true);
  const [saving, setSaving] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>({
    kind: normalizeScheduleKind(persistedSchedule?.kind),
    expression: String(persistedSchedule?.expression ?? persistedSpec?.spec?.schedule_hint ?? ""),
    timezone: String(persistedSchedule?.timezone ?? "Asia/Tokyo"),
    enabled: persistedSchedule ? persistedSchedule.enabled !== false : true
  });
  const builderCreateIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [builderNotice, setBuilderNotice] = useState("外部投稿・送信・公開はまだ実行していません。");
  const steps: string[] = persistedStepRecords.length ? persistedStepRecords.map((step) => step.title) : builderConfig.steps;
  const builderInputSources = builderConfig.inputSources;
  const builderOutputs = builderConfig.outputs;
  const builderRiskBoundary = builderConfig.riskBoundary;
  const noteBuilder = (message: string) => {
    setBuilderNotice(message);
    setReceipt(message);
  };
  React.useEffect(() => {
    setBuilderDraft({
      name: automationName,
      lane: persistedAutomation?.lane ?? "未設定",
      schedule: persistedSpec?.spec?.schedule_hint ?? "",
      approval_policy: persistedAutomation?.approval_policy ?? builderConfig.approvalPolicy,
      retry_rule: persistedSpec?.spec?.retry_rule ?? ""
    });
  }, [automationId, persistedAutomation?.updated_at, persistedSpec?.updated_at, automationName, builderConfig.approvalPolicy]);
  React.useEffect(() => {
    setScheduleDraft({
      kind: normalizeScheduleKind(persistedSchedule?.kind),
      expression: String(persistedSchedule?.expression ?? persistedSpec?.spec?.schedule_hint ?? builderDraft.schedule ?? ""),
      timezone: String(persistedSchedule?.timezone ?? "Asia/Tokyo"),
      enabled: persistedSchedule ? persistedSchedule.enabled !== false : true
    });
  }, [automationId, persistedSchedule?.revision, persistedSchedule?.kind, persistedSchedule?.expression, persistedSchedule?.timezone, persistedSchedule?.enabled, persistedSpec?.updated_at, builderDraft.schedule]);
  const saveBuilder = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const specPayload = {
        automation_type: automationSlugForKind(builderType),
        steps: steps.map((step, index) => ({ title: step, enabled: enabled[index] })),
        schedule_hint: builderDraft.schedule,
        retry_rule: builderDraft.retry_rule,
        approval_policy: builderDraft.approval_policy,
        external_action_allowed: false
      };
      const readError = async (response: Response, fallback: string) => {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.exact_blocker || body.exactBlocker || body.error || fallback);
      };
      if (!persistedAutomation) {
        const createFingerprint = [
          activeProject,
          automationId,
          builderDraft.name,
          builderDraft.lane,
          builderDraft.schedule,
          builderDraft.approval_policy,
          builderDraft.retry_rule
        ].join("|");
        const createKey = stableIdempotencyKey(builderCreateIdempotencyRef, "builder-automation-create", createFingerprint);
        const createResponse = await mvpFetch("/api/mvp/automations", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": createKey },
          body: JSON.stringify({
            id: automationId,
            name: builderDraft.name,
            project_id: activeProject,
            automation_type: automationSlugForKind(builderType),
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
        if (!createResponse.ok) await readError(createResponse, "automation_create_failed");
        const createResult = await createResponse.json();
        setMvpState(createResult.state);
        setAutomationRows(toAutomationRows(createResult.state.automations ?? []));
        noteBuilder("Builder設定を新しい下書きとして保存し、API readbackで確認しました。外部投稿・送信は未実行です。");
        go(`#/projects/${activeProject}/automations/${createResult.automation.id}/edit`);
        return;
      }
      const patchResponse = await mvpFetch(`/api/mvp/automations/${encodeURIComponent(automationId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: persistedAutomation.revision,
          name: builderDraft.name,
          lane: builderDraft.lane,
          approval_policy: builderDraft.approval_policy,
          automation_type: automationSlugForKind(builderType),
          builder_spec: specPayload
        })
      });
      if (!patchResponse.ok) await readError(patchResponse, "automation_patch_failed");
      const patchResult = await patchResponse.json();
      setMvpState(patchResult.state);
      setAutomationRows(toAutomationRows(patchResult.state.automations ?? []));
      noteBuilder("Builder設定を保存し、API readbackで確認しました。外部投稿・送信は未実行です。");
    } catch (error) {
      const exact = error instanceof Error ? error.message : "builder_save_failed";
      noteBuilder(`Builder設定の保存は未確認です: ${exact}`);
    } finally {
      setSaving(false);
    }
  };
  const saveSchedule = async () => {
    if (!persistedAutomation) {
      noteBuilder("先に自動化本体を下書き保存してから、定期実行を保存してください。");
      return;
    }
    if (scheduleDraft.kind !== "manual" && !scheduleDraft.expression.trim()) {
      noteBuilder("定期実行の式を入力してください。manualの場合だけ式を空にできます。");
      return;
    }
    setScheduleSaving(true);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/automations/${encodeURIComponent(automationId)}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: scheduleDraft.kind,
          expression: scheduleDraft.kind === "manual" ? null : scheduleDraft.expression.trim(),
          timezone: scheduleDraft.timezone.trim(),
          enabled: scheduleDraft.enabled,
          expected_revision: persistedSchedule ? Number(persistedSchedule.revision) : 1
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exactBlocker || result.exact_blocker || result.error || `schedule_save_http_${response.status}`);
      const freshState = await readMvpState();
      setMvpState(freshState);
      setAutomationRows(toAutomationRows(freshState.automations ?? []));
      const savedSchedule = (freshState.schedules ?? []).find((item: any) => String(item.automation_id ?? item.automationId ?? "") === automationId);
      setScheduleDraft({
        kind: normalizeScheduleKind(savedSchedule?.kind ?? result.schedule?.kind),
        expression: String(savedSchedule?.expression ?? result.schedule?.expression ?? ""),
        timezone: String(savedSchedule?.timezone ?? result.schedule?.timezone ?? scheduleDraft.timezone),
        enabled: savedSchedule ? savedSchedule.enabled !== false : result.schedule?.enabled !== false
      });
      noteBuilder(`定期実行を保存しました。revision=${savedSchedule?.revision ?? result.schedule?.revision ?? "?"} / next=${savedSchedule?.next_run_at ?? result.schedule?.nextRunAt ?? "未計算"} / external_action=false`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "schedule_save_failed";
      noteBuilder(`定期実行の保存は未確認です: ${exact}。revisionを再読込してから再試行してください。`);
    } finally {
      setScheduleSaving(false);
    }
  };
  return (
    <section>
      <ProjectTabs mvpState={mvpState} />
      <PageTitle title={builderTitle} desc="チャットやテンプレートから生成された自動化を編集します。">
        <Button controlId="builder.save" onClick={saveBuilder} disabled={saving}>{saving ? "保存確認中" : "下書きとして保存"}</Button>
        <Button
          controlId="builder.sync"
          variant="primary"
          onClick={async () => {
            try {
              const approvalTitle = `${builderDraft.name || builderTitle} 公開確認`;
              const approvalResponse = await mvpFetch("/api/mvp/approvals", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  company_id: activeProject,
                  project_id: activeProject,
                  title: approvalTitle,
                  requested_by: "builder-ui",
                  approval_group_id: activeProject,
                  resource_locks: [builderType, activeProject],
                  priority: "normal",
                  run_id: null
                })
              });
              if (!approvalResponse.ok) throw new Error("approval_create_failed");
              const approvalResult = await approvalResponse.json();
              setMvpState(approvalResult.state ?? mvpState);
              noteBuilder(`公開確認を承認キューへ送信しました。/ ${actionStamp()}`);
              setReceipt("公開確認を承認キューへ送信しました。外部投稿はまだ実行していません。");
            } catch (error) {
              const exact = error instanceof Error ? error.message : "approval_create_failed";
              noteBuilder(`公開確認の送信は未確認です: ${exact}`);
            }
          }}
        >
          承認キューへ送る
        </Button>
      </PageTitle>
      <ProjectScopeNotice projectId={activeProject} mvpState={mvpState} />
      <div className="builder-grid">
        <div>
          <Panel title="基本設定" controlId="builder.basic.panel">
            <div className="form-grid">
              <label>自動化名<input data-control-id="builder.name" value={builderDraft.name} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, name: event.target.value }))} /></label>
              <label>プロジェクト<input data-control-id="builder.project" value={projectName} readOnly /></label>
              <label>Lane<input data-control-id="builder.lane" value={builderDraft.lane} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, lane: event.target.value }))} /></label>
              <label>スケジュール希望（仕様メモ）<input data-control-id="builder.schedule" value={builderDraft.schedule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, schedule: event.target.value }))} /></label>
              <label>承認ポリシー<input data-control-id="builder.approval-policy" value={builderDraft.approval_policy} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, approval_policy: event.target.value }))} /></label>
              <label>リトライルール<input data-control-id="builder.retry-rule" value={builderDraft.retry_rule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, retry_rule: event.target.value }))} /></label>
            </div>
          </Panel>
          <Panel title="ワークフロー手順" controlId="builder.steps.panel">
            {steps.map((s, i) => <div className="workflow-row" key={s}><span className="drag">::</span><strong>{i + 1}. {s}</strong><small>{enabled[i] ? "有効" : "無効"}</small></div>)}
          </Panel>
          <Panel title="定期実行の実設定" controlId="builder.schedule.panel">
            <p className="muted">仕様メモではなく、会社スコープのschedule APIへrevision付きで保存します。次回実行が未計算の場合は成功と扱いません。</p>
            <div className="form-grid">
              <label>実行種別<select data-control-id="builder.schedule.kind" value={scheduleDraft.kind} disabled={scheduleSaving || !persistedAutomation} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, kind: normalizeScheduleKind(event.target.value) }))}>
                <option value="manual">手動</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="cron">Cron</option>
              </select></label>
              <label>実行式<input data-control-id="builder.schedule.expression" value={scheduleDraft.expression} disabled={scheduleSaving || !persistedAutomation || scheduleDraft.kind === "manual"} placeholder={scheduleDraft.kind === "cron" ? "0 9 * * *" : "09:00"} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, expression: event.target.value }))} /></label>
              <label>Timezone<input data-control-id="builder.schedule.timezone" value={scheduleDraft.timezone} disabled={scheduleSaving || !persistedAutomation} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, timezone: event.target.value }))} /></label>
              <label className="checkbox-label"><input data-control-id="builder.schedule.enabled" type="checkbox" checked={scheduleDraft.enabled} disabled={scheduleSaving || !persistedAutomation} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, enabled: event.target.checked }))} /> 有効にする</label>
            </div>
            <div className="button-row">
              <Button controlId="builder.schedule.save" variant="primary" onClick={saveSchedule} disabled={scheduleSaving || !persistedAutomation}>{scheduleSaving ? "定期実行を保存中" : "定期実行を保存"}</Button>
            </div>
            <div className="action-note" role="status">{persistedAutomation ? `revision=${persistedSchedule?.revision ?? "新規(1)"} / status=${persistedSchedule?.status ?? "未保存"} / next=${persistedSchedule?.next_run_at ?? "未計算"}` : "自動化本体を保存すると、実設定を編集できます。"}</div>
          </Panel>
        </div>
        <aside className="side-panel">
          <h3>入力元</h3><p>{builderInputSources}</p>
          <h3>出力</h3><p>{builderOutputs}</p>
          <h3>危険操作</h3><p>{builderRiskBoundary}</p>
          <div className="preview-box">{builderNotice}</div>
        </aside>
      </div>
    </section>
  );
}

function ApprovalsPage({ model }: { model: AppModel }) {
  const { setReceipt, mvpState, setMvpState } = model;
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalStatusNote, setApprovalStatusNote] = useState("");
  const persistedApprovals = (mvpState.approvals ?? []).map((approval) => {
    const fallbackParts = String(approval.content ?? "").split(" / ").map((part) => part.trim()).filter(Boolean);
    const actionLabel = String(approval.action_label ?? approval.action_kind ?? fallbackParts[0] ?? "未確認");
    const targetLabel = String(approval.target_account_ref_id ?? approval.target_label ?? approval.boundary_label ?? fallbackParts[1] ?? "未確認");
    const executionLabel = String(approval.execution_label ?? fallbackParts[2] ?? (approval.external_action_allowed === false ? "外部操作なし" : "未確認"));
    return {
    id: approval.id,
    kind: String(approval.task_label ?? approval.title ?? approval.kind ?? "承認候補"),
    content: String(approval.title ?? approval.content ?? approval.task_label ?? "承認候補"),
    actionLabel,
    targetLabel,
    executionLabel,
    project: String(approval.company_id ?? approval.project_id ?? ""),
    lane: String(approval.approval_group_id ?? approval.lane ?? "MVP API"),
    due: approvalDueLabel(approval.expires_at),
    risk: String(approval.action_kind ? "exact action binding" : approval.boundary_label ?? (approval.external_action_allowed ? "要確認" : "外部操作なし")),
    status: normalizeApprovalStatus(approval.status),
    bound: Boolean(approval.job_id && approval.action_kind && approval.payload_hash),
    revision: Number(approval.decision_revision ?? 1),
    actionKind: String(approval.action_kind ?? ""),
    targetAccount: String(approval.target_account_ref_id ?? "なし"),
    payloadHash: String(approval.payload_hash ?? ""),
    policyVersion: String(approval.policy_version ?? "")
    };
  });
  const visibleApprovals = persistedApprovals.filter((approval) => approval.status === "waiting");
  const selectedIndex = visibleApprovals.length ? Math.min(selected, visibleApprovals.length - 1) : -1;
  const item = selectedIndex >= 0 ? visibleApprovals[selectedIndex] : null;
  const selectedCompanyRole = item ? projectOptionsFromState(mvpState).find((company) => company.id === item.project)?.role ?? "viewer" : "viewer";
  const canDecideApproval = ["owner", "admin", "approver"].includes(selectedCompanyRole);
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
      const response = await mvpFetch(item.bound
        ? `/api/v1/companies/${encodeURIComponent(item.project)}/approvals/${encodeURIComponent(item.id)}`
        : `/api/mvp/approvals/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(item.bound ? { "if-match": String(item.revision) } : {}) },
        body: JSON.stringify({ decision: item.bound ? (decision === "approve" ? "approved" : "rejected") : decision, note: approvalNote || "UIから確認。外部操作は許可していません。" })
      });
      if (!response.ok) throw new Error("approval_update_failed");
      const result = await response.json();
      setMvpState(result.state ?? await readMvpState());
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
      <PageTitle title="承認キュー" desc="会社別の確認待ちを1件ずつ処理します。" />
      <div className="action-note" role="status">{approvalStatusNote || `承認候補 ${visibleApprovals.length}件 / external_action=false`}</div>
      <div className="split">
        <Panel title="承認待ち一覧" className="list-panel" controlId="approvals.list.panel">
          {visibleApprovals.length ? visibleApprovals.map((a, i) => <button data-control-id={`approvals.row.${a.id ?? i}`} key={a.id ?? a.content} className={`list-row approval-row ${i === selectedIndex ? "selected" : ""}`} onClick={() => { setSelected(i); setApprovalStatusNote(`${a.kind}: ${a.content} を選択 / ${actionStamp()}`); }}><span>{a.kind}</span><strong>{a.content}</strong><small>{a.project} / {a.lane}</small><div className="approval-facts"><span>Action: {a.actionLabel}</span><span>Target: {a.targetLabel}</span><span>状態: {a.executionLabel}</span></div><StatusBadge status={a.status} label={a.status === "approved" ? "local draft承認" : a.risk} /></button>) : (
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
              <p className="muted">{item.project} / {item.lane}</p>
              <DataTable controlId={`approvals.summary.${item.id}`} headers={["項目", "値"]} rows={[
                ["Action", item.actionLabel],
                ["Target", item.targetLabel],
                ["状態", item.executionLabel],
                ["期限", item.due],
                ["Risk", item.risk]
              ]} />
              <div className="preview-box">{item.content} の全文プレビューです。送信前に人間が承認し、必要なら編集します。外部投稿・送信・応募・公開は承認と証跡なしに実行しません。</div>
              {item.bound && <DataTable controlId={`approvals.binding.${item.id}`} headers={["Binding", "Value"]} rows={[
                ["Action", item.actionKind],
                ["Target", item.targetAccount],
                ["Payload SHA-256", item.payloadHash],
                ["Policy", item.policyVersion],
                ["Decision revision", String(item.revision)]
              ]} />}
              {editing && <label>修正メモ<textarea data-control-id="approvals.edit" aria-label="承認修正メモ" value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label>}
              {canDecideApproval ? <div className="button-row"><Button controlId="approvals.approve" variant="primary" icon={<Check size={15} />} onClick={approveSelected}>承認</Button><Button controlId="approvals.edit-button" icon={<Edit3 size={15} />} onClick={() => { setEditing(true); setApprovalStatusNote(`${item.kind}: 編集欄を開きました / ${actionStamp()}`); setReceipt(`${item.kind} の編集欄を開きました。`); }}>編集</Button><Button controlId="approvals.reject" variant="danger" onClick={rejectSelected}>却下</Button></div> : <p className="muted" data-control-id="approvals.read-only">この会社では閲覧権限のため、承認操作は表示していません。</p>}
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
  const jobs = mvpState.jobs ?? [];
  const proofs = mvpState.proofs ?? [];
  const [statusFilter, setStatusFilter] = useState("active");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [selectedProofId, setSelectedProofId] = useState<string | null>(null);
  const [proofView, setProofView] = useState<ProofView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutatingJobId, setMutatingJobId] = useState<string | null>(null);
  const retryIdempotencyRef = useRef<Record<string, string>>({});
  const [actionNote, setActionNote] = useState("実行履歴を開きました。再読込とfilter操作の結果はここにも表示します。");
  const projectForRun = (run: any) => run.company_id ?? mvpState.automations?.find((automation) => automation.id === run.automation_id)?.project_id ?? "";
  const statusMatches = (run: any) => {
    if (statusFilter === "active") return ["queued", "running"].includes(run.status);
    if (statusFilter === "blocked") return run.status === "blocked";
    if (statusFilter === "completed") return ["complete", "completed"].includes(run.status);
    return true;
  };
  const filteredRuns = runs.filter((run) => statusMatches(run) && (projectFilter === "all" || projectForRun(run) === projectFilter));
  const activeRuns = runs.filter((run) => ["queued", "running"].includes(run.status));
  const activeRunsForProject = activeRuns.filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter);
  const blockedRuns = runs.filter((run) => run.status === "blocked");
  const completedRuns = runs.filter((run) => ["complete", "completed"].includes(run.status));
  const dashboardSelectedRun = runs.find((run) => run.id === selectedRunId && filteredRuns.some((filtered) => filtered.id === run.id)) ?? filteredRuns[0] ?? null;
  const detailForCurrentRun = selectedRunDetail?.run?.id === dashboardSelectedRun?.id ? selectedRunDetail : null;
  const selectedRun = newerRunSnapshot(detailForCurrentRun?.run, dashboardSelectedRun);
  const selectedProofs = detailForCurrentRun?.proofs ?? (selectedRun ? proofs.filter((proof) => selectedRun.proof_ids?.includes(proof.id)) : []);
  const selectedSteps = detailForCurrentRun?.steps ?? [];
  const selectedWorkerEvents = detailForCurrentRun?.workerEvents ?? [];
  const selectedJob = selectedRun ? jobs.find((job) => job.run_id === selectedRun.id) ?? null : null;
  const selectedJobCompanyId = String(selectedJob?.company_id ?? selectedRun?.company_id ?? "");
  const selectedJobRole = projectOptionsFromState(mvpState).find((company) => company.id === selectedJobCompanyId)?.role ?? "viewer";
  const canMutateJob = ["owner", "admin", "operator"].includes(selectedJobRole);
  const refresh = async () => {
    try {
      const state = await readMvpState();
      setMvpState(state);
      setSelectedRunId((current) => resolveSelectedRunId(current, state.runs ?? [], state.actionableRuns ?? []));
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setReceipt(`Runs readback 済みです。runs=${state.runs?.length ?? 0} / proofs=${state.proofs?.length ?? 0}`);
      setActionNote(`再読込完了: runs=${state.runs?.length ?? 0} / proofs=${state.proofs?.length ?? 0} / project=${projectFilter} / ${actionStamp()}`);
    } catch {
      setReceipt("Runs readback に失敗しました。MVP API接続を確認してください。");
      setActionNote(`再読込失敗: MVP API接続を確認してください / ${actionStamp()}`);
    }
  };
  const mutateJob = async (job: any, action: "cancel" | "retry") => {
    if (mutatingJobId === job.id) return;
    setMutatingJobId(job.id);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (action === "retry") {
        const retryFingerprint = `${job.company_id}:${job.id}:${job.status}:${job.attempt_count ?? 0}`;
        headers["idempotency-key"] = retryIdempotencyRef.current[retryFingerprint]
          ?? (retryIdempotencyRef.current[retryFingerprint] = newIdempotencyKey("ui-job-retry"));
      }
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(job.company_id)}/jobs/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        headers,
        body: "{}"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `${action}_failed`);
      setReceipt(`${job.id}: ${action === "cancel" ? "キャンセル" : "再試行キュー登録"}を保存しました。`);
      setActionNote(`${job.id}: ${action} / status=${body.job?.status ?? "unknown"} / ${actionStamp()}`);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : `${action}_failed`;
      setReceipt(`${job.id}: 操作に失敗しました（${publicBlockerSummary(message)}）。`);
      setActionNote(`${job.id}: ${action}失敗 / ${publicBlockerSummary(message)} / ${actionStamp()}`);
    } finally {
      setMutatingJobId(null);
    }
  };
  React.useEffect(() => {
    refresh();
  }, []);
  React.useEffect(() => {
    const currentRunId = dashboardSelectedRun?.id;
    if (!currentRunId) {
      setSelectedRunDetail(null);
      setSelectedProofId(null);
      setProofView(null);
      return;
    }
    let cancelled = false;
    setSelectedRunDetail(null);
    setSelectedProofId(null);
    setProofView(null);
    setDetailLoading(true);
    fetchApiJson<RunDetail>(`/api/runs/${encodeURIComponent(currentRunId)}`)
      .then((detail) => {
        if (cancelled) return;
        setSelectedRunDetail(detail);
        setSelectedProofId((current) => detail.proofs.some((proof) => proof.id === current) ? current : null);
      })
      .catch(() => {
        if (!cancelled) setSelectedRunDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [dashboardSelectedRun?.id]);
  React.useEffect(() => {
    if (!selectedProofId) {
      setProofView(null);
      return;
    }
    const viewerUrl = `/api/proofs/${encodeURIComponent(selectedProofId)}/view`;
    let cancelled = false;
    fetchApiJson<ProofView>(viewerUrl)
      .then((view) => { if (!cancelled) setProofView(view); })
      .catch(() => { if (!cancelled) setProofView({ id: selectedProofId, status: "blocked", blocked_reason: "viewer_unavailable" }); });
    return () => { cancelled = true; };
  }, [selectedProofId]);
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      readMvpState().then((state) => {
        setMvpState(state);
        setAutomationRows(toAutomationRows(state.automations ?? []));
        setSelectedRunId((current) => resolveSelectedRunId(current, state.runs ?? [], state.actionableRuns ?? []));
      }).catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [setAutomationRows, setMvpState]);
  return (
    <section>
      <PageTitle title="実行履歴" desc="自動化の進み具合と保存された確認記録を表示します。">
        <Button controlId="runs.refresh" icon={<RefreshCw size={15} />} onClick={refresh}>再読込</Button>
      </PageTitle>
      <div className="action-note" role="status">{actionNote}</div>
      <div className="cards four">
        <MetricCard controlId="runs.metric.count" title="実行件数" value={String(runs.length)} sub="保存済みの履歴" status={runs.length ? "enabled" : "waiting"} />
        <MetricCard controlId="runs.metric.proofs" title="確認記録" value={String(proofs.length)} sub="安全に開ける記録" status={proofs.length ? "enabled" : "waiting"} />
        <MetricCard controlId="runs.metric.queued-jobs" title="待機Job" value={String(jobs.filter((job) => job.status === "queued").length)} sub="会社別durable queue" status={jobs.some((job) => job.status === "queued") ? "waiting" : "enabled"} />
        <MetricCard controlId="runs.metric.active-jobs" title="実行中Job" value={String(jobs.filter((job) => job.status === "leased").length)} sub="永続化済みjob状態" status={jobs.some((job) => job.status === "leased") ? "running" : "enabled"} />
      </div>
      <Panel title="実行前の安全確認" controlId="runs.safety.panel">
        <div className="filter-row">
          {[
            ["all", "全Project"],
            ...projectOptionsFromState(mvpState).map((option) => [option.id, option.label])
            ].map(([key, label]) => <button data-control-id={`runs.project-filter.${key}`} key={key} className={projectFilter === key ? "selected" : ""} onClick={() => { setProjectFilter(key); setActionNote(`Project filter: ${label} を選択しました / ${actionStamp()}`); }}>{label}</button>)}
        </div>
        <DataTable controlId="runs.preview.table" headers={["項目", "状態", "意味"]} rows={[
          ["処理候補", String(activeRunsForProject.length), "選択中の会社にあるqueued/running Run"],
          ["承認待ち", String((mvpState.approvals ?? []).filter((approval) => isApprovalWaiting(approval.status)).length), "外部操作の前に人間確認が必要な件数"],
          ["安全境界", "外部操作なし", "投稿・送信・削除・認証・課金は承認なしに実行しません"]
        ]} />
      </Panel>
      <div className="split">
        <Panel title="履歴" className="list-panel" controlId="runs.history.panel">
          <div className="filter-row">
            {[
              ["active", `処理中 ${activeRuns.length}`],
              ["blocked", `停止 ${blockedRuns.length}`],
              ["completed", `完了 ${completedRuns.length}`],
              ["all", `全て ${runs.length}`]
            ].map(([key, label]) => <button data-control-id={`runs.status-filter.${key}`} key={key} className={statusFilter === key ? "selected" : ""} onClick={() => { setStatusFilter(key); setActionNote(`Status filter: ${label} を選択しました。表示run=${runs.filter((run) => {
              if (key === "active") return ["queued", "running"].includes(run.status);
              if (key === "blocked") return run.status === "blocked";
              if (key === "completed") return ["complete", "completed"].includes(run.status);
              return true;
            }).filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter).length} / ${actionStamp()}`); }}>{label}</button>)}
          </div>
          <DataTable controlId="runs.history.table" headers={["記録", "自動化", "状態", "開始待ち", "確認事項", "記録数"]} rows={filteredRuns.slice(0, 20).map((run) => [
            <button data-control-id={`runs.row.run-link.${run.id}`} className="link-button" onClick={() => { setSelectedRunId(run.id); setActionNote(`履歴を選択しました / ${publicRunStatus(run.status)} / ${actionStamp()}`); }}>{run.id}</button>,
            run.automation_name ?? run.automation_id,
            <StatusBadge status={["complete", "completed"].includes(run.status) ? "approved" : run.status === "blocked" ? "blocked" : run.status === "running" ? "running" : "waiting"} label={publicRunStatus(run.status)} />,
            run.queued_at ?? "-",
            publicBlockerSummary(run.exact_blocker),
            String(run.proof_ids?.length ?? 0)
          ])} />
        </Panel>
        <aside className="side-panel wide">
          <h3>確認記録</h3>
          {selectedRun ? <p className="muted">{selectedRun.id} / {publicRunStatus(selectedRun.status)}{detailLoading ? " / 読込中" : ""}</p> : <p className="muted">履歴はまだありません。</p>}
          {selectedRun && <p className="muted">手順 {selectedSteps.length}件 / 更新 {selectedWorkerEvents.length}件</p>}
          {selectedProofs.length ? selectedProofs.map((proof) => (
            <div className="preview-box" key={proof.id}>
              <strong>{redactDisplayPaths(proof.label ?? proof.proof_type ?? proof.kind ?? "確認記録")}</strong>
              {proof.summary && <p>{redactDisplayPaths(proof.summary)}</p>}
              <Button controlId={`runs.row.proof.${proof.id}`} onClick={() => setSelectedProofId(proof.id)}>安全に開く</Button>
            </div>
          )) : <div className="preview-box">この履歴に確認記録はまだありません。</div>}
          {selectedJob && (
            <div className="preview-box" data-control-id={`runs.job.${selectedJob.id}`}>
              <strong>Durable job</strong>
              <p>{selectedJob.id} / {publicRunStatus(selectedJob.status)}</p>
              <p className="muted">version {selectedJob.automation_version_id} / attempts {selectedJob.attempt_count}/{selectedJob.max_attempts}</p>
              {selectedJob.last_error && <p>{publicBlockerSummary(selectedJob.last_error)}</p>}
              {canMutateJob ? <div className="button-row">
                {["queued", "leased", "reconciliation_required", "timed_out"].includes(selectedJob.status) && <Button controlId={`runs.job.cancel.${selectedJob.id}`} variant="danger" disabled={mutatingJobId === selectedJob.id} onClick={() => { void mutateJob(selectedJob, "cancel"); }}>{mutatingJobId === selectedJob.id ? "保存確認中" : "キャンセル"}</Button>}
                {["failed", "timed_out"].includes(selectedJob.status) && <Button controlId={`runs.job.retry.${selectedJob.id}`} variant="primary" disabled={mutatingJobId === selectedJob.id} onClick={() => { void mutateJob(selectedJob, "retry"); }}>{mutatingJobId === selectedJob.id ? "保存確認中" : "再試行"}</Button>}
              </div> : <p className="muted" data-control-id={`runs.job.read-only.${selectedJob.id}`}>この会社では閲覧権限のため、job操作は表示していません。</p>}
            </div>
          )}
          {proofView && (
            <div className="preview-box" role="region" aria-label="確認記録プレビュー">
              <strong>{proofView.label ?? "確認記録"}</strong>
              {proofView.status === "ok" && proofView.preview && <pre>{redactDisplayPaths(proofView.preview)}</pre>}
              {proofView.status === "ok" && proofView.preview_kind === "image" && <p>画像記録を確認できます（{proofView.image?.width ?? "?"} × {proofView.image?.height ?? "?"}）。</p>}
              {proofView.status !== "ok" && <p>{publicBlockerSummary(proofView.blocked_reason)}</p>}
              {proofView.truncated && <small>安全のため先頭部分のみ表示しています。</small>}
            </div>
          )}
        </aside>
      </div>
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
        <Button controlId="pc.refresh" onClick={refresh}>再確認</Button>
      </PageTitle>
      <div className="action-note" role="status">{pcNote}</div>
      <div className="cards four">
        <MetricCard controlId="pc.metric.local-agent" title="Local Agent" value={workerSummary.fresh ? "heartbeat確認済み" : workerSummary.stored ? "API readback" : "要確認"} sub={workerSummary.blocker ? workerSummary.nextAction : workerSummary.nextAction} status={workerSummary.fresh ? "enabled" : workerSummary.stored ? "draft" : "blocked"} />
        <MetricCard controlId="pc.metric.heartbeat" title="Heartbeat" value={workerSummary.fresh ? "fresh" : workerSummary.stored ? "未取得" : "stale"} sub={worker?.heartbeat_at ?? "未確認"} status={workerSummary.fresh ? "enabled" : workerSummary.stored ? "draft" : "blocked"} />
        <MetricCard controlId="pc.metric.queue" title="Queue" value={String(worker?.queue_depth ?? 0)} sub="待機中の実行候補" status={(worker?.queue_depth ?? 0) > 0 ? "running" : "enabled"} />
        <MetricCard controlId="pc.metric.last-run" title="Last Run" value={worker?.last_run_id ? "あり" : "なし"} sub={worker?.last_run_id ?? "未実行"} status={worker?.last_run_id ? "enabled" : "waiting"} />
      </div>
      <Panel title="Local Agent readback" controlId="pc.readback.panel"><DataTable controlId="pc.readback.table" headers={["項目", "状態", "次に見ること"]} rows={[["接続状態", workerSummary.fresh ? "接続確認済み" : workerSummary.stored ? "API保存済み / heartbeat未確認" : "要確認", workerSummary.nextAction], ["Worker", worker?.status ?? "unknown", worker?.id ?? "unknown"], ["Heartbeat", worker?.heartbeat_at ?? "none", workerSummary.blocker ?? (workerSummary.stored ? "Mac heartbeat未取得" : "問題なし")], ["Queue", String(worker?.queue_depth ?? 0), "外部操作は各workflowの承認境界で停止"]]} /></Panel>
      <Panel title="実行中ローカルタスク" controlId="pc.running.panel"><DataTable controlId="pc.running.table" headers={["Run", "Automation", "開始時刻", "ステータス", "Blocker"]} rows={(mvpState.runs ?? []).filter((run) => ["queued", "running", "blocked"].includes(run.status)).slice(0, 8).map((run) => [run.id, run.automation_name ?? run.automation_id, run.started_at ?? run.queued_at ?? "-", <StatusBadge status={run.status === "blocked" ? "blocked" : run.status === "running" ? "running" : "waiting"} label={run.status} />, run.exact_blocker ?? "-"])} /></Panel>
    </section>
  );
}

function TemplatesPage({ model }: { model: AppModel }) {
  const { setReceipt, createdTemplates, setCreatedTemplates, setMvpState, setAutomationRows } = model;
  const [selected, setSelected] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const createIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [templateNote, setTemplateNote] = useState("テンプレートを選ぶと詳細が表示されます。使用するを押すと保存結果をここに表示します。");
  const canonicalProjects = projectOptionsFromState(model.mvpState);
  React.useEffect(() => {
    if (model.mvpLoadStatus !== "ready") return;
    setSelectedProjectId((current) => {
      const next = resolveProjectSelection(model.mvpState, current);
      if (next) rememberProject(next);
      return next;
    });
  }, [model.mvpLoadStatus, model.mvpState]);
  const selectedProjectIsVerified = model.mvpLoadStatus === "ready"
    && canonicalProjects.some((project) => project.id === selectedProjectId);
  const useTemplate = async () => {
    const [name, category, target, lane, approval] = templates[selected];
    if (!selectedProjectIsVerified) {
      setReceipt("保存先の会社を会社一覧から明示選択してください。");
      setTemplateNote(`${name}: 保存先会社が未選択のため保存していません。`);
      return;
    }
    if (saving) return;
    setSaving(true);
    setTemplateNote(`${name}: 保存を開始しました。外部投稿・送信は実行しません。`);
    const automationType = name.includes("Gmail") || name.includes("DM") ? "gmail-reply" : category.includes("リサーチ") ? "research-report" : "sns-post";
    const createFingerprint = [selectedProjectId, String(selected), name, category, target, lane, approval].join("|");
    const createKey = stableIdempotencyKey(createIdempotencyRef, "template-automation-create", createFingerprint);
    try {
      const response = await mvpFetch("/api/mvp/automations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": createKey },
        body: JSON.stringify({
          name,
          project_id: selectedProjectId,
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
    } finally {
      setSaving(false);
    }
  };
  if (model.mvpLoadStatus === "ready" && canonicalProjects.length === 0) {
    return (
      <section>
        <PageTitle title="テンプレート / Skills" desc="テンプレートを保存する会社が必要です。" />
        <Panel title="会社を登録してください" controlId="templates.company-required.panel">
          <div className="first-use-content">
            <p>会社を登録すると、テンプレートから自動化を作成できます。</p>
            <Button controlId="templates.company-required.open" variant="primary" onClick={() => go("#/projects")}>会社を登録する</Button>
          </div>
        </Panel>
      </section>
    );
  }
  return (
    <section>
      <PageTitle title="テンプレート / Skills" desc="再利用可能な自動化テンプレートから作成します。" />
      <div className="action-note" role="status">{templateNote}</div>
      <label className="chat-input">
        保存先の会社
        <select data-control-id="templates.project-select" aria-label="テンプレートの保存先会社" value={selectedProjectId} disabled={model.mvpLoadStatus !== "ready"} onChange={(event) => setSelectedProjectId(event.target.value)}>
          <option value="">会社を選択してください</option>
          {canonicalProjects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select>
      </label>
      <div className="split">
        <div className="template-grid">{templates.map((t, i) => <button data-control-id={`templates.card.${i}`} key={t[0]} className={`template-card ${i === selected ? "selected" : ""}`} onClick={() => { setSelected(i); setTemplateNote(`${t[0]} を選択しました。必要接続=${t[2]} / 推奨Lane=${t[3]}`); }}><LayoutTemplate size={17} /><strong>{t[0]}</strong><span>{t[1]}</span><small>{t[2]} / {t[3]}</small></button>)}</div>
        <aside className="side-panel wide"><h3>{templates[selected][0]}</h3><p>必要接続: {templates[selected][2]}</p><p>推奨Lane: {templates[selected][3]}</p><p>承認: {templates[selected][4]}</p><Button controlId="templates.use" variant="primary" onClick={useTemplate} disabled={!selectedProjectIsVerified || saving}>{saving ? "保存確認中" : "使用する"}</Button><h3>作成済み</h3><p>{createdTemplates.length ? createdTemplates.join(" / ") : "まだありません"}</p></aside>
      </div>
    </section>
  );
}

function Panel({ title, children, className = "", controlId }: { title: string; children: React.ReactNode; className?: string; controlId?: string }) {
  return <section data-control-id={controlId} className={`panel ${className}`}><div className="panel-head"><h2>{title}</h2></div>{children}</section>;
}

function MetricCard({ title, value, sub, status, controlId }: { title: string; value: string; sub: string; status: Status; controlId?: string }) {
  return <div data-control-id={controlId} className="metric"><div><span>{title}</span><strong>{value}</strong><small>{sub}</small></div><StatusBadge status={status} /></div>;
}

function DataTable({ headers, rows, controlId, caption }: { headers: string[]; rows: React.ReactNode[][]; controlId?: string; caption?: string }) {
  const tableCaption = (caption ?? headers.join(" / ")).trim();
  return (
    <div data-control-id={controlId} className="table-wrap">
      <table>
        <caption className="sr-only">{tableCaption}</caption>
        <thead>
          <tr>{headers.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => <td key={j} data-label={headers[j] ?? `列${j + 1}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bubble({ children, side }: { children: React.ReactNode; side?: "user" }) {
  return <div className={`bubble ${side === "user" ? "user-bubble" : ""}`}>{children}</div>;
}

function CheckList({ items }: { items: string[] }) {
  return <ul className="check-list">{items.map((i) => <li key={i}><Check size={15} />{i}</li>)}</ul>;
}

function Stepper() {
  return <div className="stepper">{["成功ステップ", "直前成功", "失敗ステップ", "未実行"].map((s, i) => <div key={s} className={i === 2 ? "failed" : ""}><Circle size={14} /><strong>{s}</strong><span>{["素材取得", "Lane確認", "Chrome起動", "投稿実行"][i]}</span></div>)}</div>;
}

export default App;
