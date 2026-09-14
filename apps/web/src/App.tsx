import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { buildWorkflowStartGuide, type WorkflowStartGuideItem } from "./workflowStartGuide";
import { ApprovalReadbackPanel } from "./ApprovalReadbackPanel";
import { companyApprovalListReadbackUrl, validateCompanyApprovalListReadback } from "./approvalReadFilters";
import { unifiedManagementNavigation } from "./unifiedManagementModel";

type Status = "running" | "waiting" | "approved" | "blocked" | "enabled" | "disabled" | "draft";
type ApiTokenScope = "unknown" | "read" | "write" | "unrestricted";

const subTabLabels = [
  ["仕事", "automations"],
  ["保存情報", "memory"],
  ["Lane", "lanes"],
  ["パフォーマンス", "performance"],
  ["連携", "integrations"],
  ["Security", "security"],
  ["成果物 / KPI", "artifacts"],
  ["復旧", "recovery"]
];

function withMvpApiHeaders(init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  return { ...init, credentials: "include" as const, headers };
}

async function mvpFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const requestUrl = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (!requestUrl.includes("/api/mvp/state") || typeof AbortController === "undefined") {
    return fetch(input, withMvpApiHeaders(init));
  }
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  // The first authenticated read may include a cold Postgres control-plane
  // snapshot after the server has restarted.  The API is already bounded and
  // fails closed; give that bounded read enough time to complete instead of
  // converting a recoverable cold-start into a false local-mode timeout.
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    return await fetch(input, withMvpApiHeaders({ ...init, signal: controller.signal }));
  } catch (error) {
    if (timedOut && error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
      throw new Error("mvp_state_request_timeout");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function pluginAuthReadbackFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  if (typeof AbortController === "undefined") return mvpFetch(input, init);
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    return await mvpFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
      throw new Error("plugin_auth_readback_timeout");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function mvpDiagnosticsEnabled(): boolean {
  const hashQuery = location.hash.split("?", 2)[1] ?? "";
  return new URLSearchParams(hashQuery).get("mvp_diagnostics") === "1";
}

function mvpReadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function pluginAuthUrlBlocker(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "official_auth_url_invalid";
    if (url.hostname === "chatgpt.com" && !/^\/(?:apps|plugins)\/[^/]+/.test(url.pathname)) return "official_auth_surface_not_actionable";
    return null;
  } catch {
    return "official_auth_url_invalid";
  }
}

function pluginAuthLinkLabel(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "chatgpt.com") return "公式接続・インストールページ";
  } catch { /* Invalid URLs are disabled by pluginAuthUrlBlocker. */ }
  return "公式接続ページ";
}

function pluginPlatformMatches(pluginName: string, platform: unknown) {
  const aliases: Record<string, string> = { mail: "gmail", drive: "google-drive", calendar: "google-calendar" };
  const value = String(platform ?? "").trim().toLowerCase();
  return pluginName.trim().toLowerCase() === (aliases[value] ?? value);
}

function isActionablePluginAuthUrl(value: string) {
  return pluginAuthUrlBlocker(value) === null;
}

function publicRunStatus(status: unknown) {
  const value = String(status ?? "").toLowerCase();
  if (value === "complete" || value === "completed" || value === "success" || value === "succeeded") return "完了";
  if (value === "cancelled" || value === "canceled") return "キャンセル";
  if (value === "timed_out") return "タイムアウト";
  if (value === "reconciliation_required") return "照合待ち";
  if (value === "blocked" || value === "failed") return "要確認";
  if (value === "running") return "実行中";
  if (value === "waiting_approval" || value === "approval_required" || value === "approval_pending") return "承認待ち";
  if (value === "queued" || value === "pending" || value === "waiting") return "待機中";
  if (value.includes("sign_in") || value.includes("login") || value.includes("auth")) return "サインインが必要";
  if (value === "unavailable" || value.endsWith("_unavailable")) return "利用不可";
  return "未確認";
}

function chatModePresentation(prompt: string) {
  const value = prompt.trim();
  if (!value) return { label: "入力待ち", consequence: "送信すると、まず質問・下書き・定期実行・実行依頼のどれかを判定します。" };
  if (/[?？]|教えて|確認して|状況|一覧|ステータス|どうなって/iu.test(value)) {
    return { label: "質問・確認", consequence: "回答とreadbackを返します。保存・スケジュール変更・外部操作は開始しません。" };
  }
  if (/毎日|毎週|毎月|定期|スケジュール|schedule|cron/iu.test(value)) {
    return { label: "定期実行の相談", consequence: "予定の候補を確認します。保存しても停止中の下書きで、明示的な有効化と既存ゲートが必要です。" };
  }
  if (/今すぐ|実行して|開始して|run now|execute|送信して|投稿して|応募して/iu.test(value)) {
    return { label: "実行依頼", consequence: "対象・認証・承認・同一Runのreadbackを満たすまで実行しません。結果不明時は再送しません。" };
  }
  return { label: "自動化の下書き", consequence: "仕様メモを作成します。保存後も外部操作は開始せず、承認と実行設定は別の明示操作です。" };
}

const READ_ONLY_BUSINESS_PROOF_PENDING_BLOCKERS = new Set([
  "portable_remote_read_only_business_completion_proof_pending",
  "portable_external_read_only_business_completion_proof_pending",
]);

function isReadOnlyNoEffectReadbackComplete(run: any, mvpState?: MvpState): boolean {
  const blocker = String(runBlockerValue(run, mvpState) ?? "").trim().toLowerCase();
  return READ_ONLY_BUSINESS_PROOF_PENDING_BLOCKERS.has(blocker);
}

function publicRunStatusForRun(run: any, mvpState?: MvpState): string {
  return isReadOnlyNoEffectReadbackComplete(run, mvpState) ? "読取確認済み" : publicRunStatus(run?.status);
}

function publicProofStatus(status: unknown) {
  const value = String(status ?? "").toLowerCase();
  if (["ok", "stored", "available", "verified"].includes(value)) return "保存済み";
  if (["blocked", "failed", "error"].includes(value)) return "要確認";
  return "未確認";
}

function isRunActiveStatus(status: unknown) {
  return ["queued", "running"].includes(String(status ?? "").toLowerCase());
}

function isRunStoppedStatus(status: unknown) {
  return ["blocked", "failed", "cancelled", "canceled", "timed_out", "reconciliation_required"].includes(String(status ?? "").toLowerCase());
}

function isRunCompletedStatus(status: unknown) {
  return ["complete", "completed", "success", "succeeded"].includes(String(status ?? "").toLowerCase());
}

function publicBlockerSummary(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "未確認";
  const safe = redactSensitiveText(raw);
  const normalized = safe.toLowerCase();
  if (["none", "no_blocker", "no blocker", "null", "undefined"].includes(normalized)) return "なし";
  // An old Browser Use/Chrome binding identifier is historical run data, not
  // current Profile 2 proof. Never surface or reuse the opaque identifier as
  // if it described the currently selected browser session.
  if (/^Browser is not available:\s*\S+/iu.test(raw)) {
    return "Chrome接続の過去Run記録（現行証跡ではありません） / 次: fresh Chrome Plugin・Profile 2 readback";
  }
  if (normalized === "portable_preflight_run_waiting_for_worker_readback") {
    return "Mac workerの同一Run readback待ち / 次: worker claimまたはexact blockerを確認";
  }
  if (normalized === "browser_use_worker_readback_pending") {
    return "Mac workerのCompanion同一Run readback待ち（認証・画面状態は未確認） / 取得できなければexact blockerとして確定";
  }
  if (normalized === "same_run_receipt_required") {
    return "同一Runのreceiptが未確認です（外部効果は未確認） / 次: provider receipt・source sync・cleanupのreadbackを確認";
  }
  if (READ_ONLY_BUSINESS_PROOF_PENDING_BLOCKERS.has(normalized)) {
    return "read-only確認は完了しました（外部操作なし） / 投稿・応募などの業務完了証跡は作成していません";
  }
  if (normalized === "portable_worker_company_scope_mismatch") {
    return "Runの会社scopeとMac worker対象会社が不一致です / 次: 正本にする会社・endpointを確認してscopeを揃えてからread-only Runを開始";
  }
  if (normalized === "scope_alignment_decision_required") {
    return "AOS queueとMac workerの会社scopeが一致していません / 次: 正本にする会社とendpointを確認してからclaimを再開";
  }
  if (normalized === "aos_local_diagnostic_scope_not_authorized_for_claim") {
    return "local診断用AOS scopeはclaim権限の正本ではありません / 次: 保護されたAOS readbackで正規会社・endpointを確認してからclaimを再開";
  }
  if (normalized === "aos_scope_alignment_required") {
    return "AOSの会社scope整合性が未確認です / 次: 正規会社・endpointを保護されたreadbackで確認してから手動実行を再開";
  }
  if (normalized === "aos_automation_binding_missing") {
    return "AOS側の登録workflow bindingが未確認です / 次: 正規AOS scopeのregistered workflow readbackを確認してから手動実行を再開";
  }
  if (normalized === "codex_app_automation_run_now_api_unavailable") {
    return "公式の手動実行入口がこのCodex環境で未提供です / 次: Codex Appのrun-now capabilityが利用可能になってからno-effect Runを開始";
  }
  if (normalized === "production_token_required") {
    return "AOS本番の認証が必要です / 次: 会社1の公式認証を完了してから、保護されたreadbackを再確認";
  }
  if (normalized === "production_token_required_or_private_ingress_gate_for_unauthenticated_direct_api") {
    return "AOS保護APIのOwner認証が必要です / 次: 公式AOS画面の認証後にprotected readbackを再確認";
  }
  if (normalized === "profile_not_connected") {
    return "AOS Chrome Companionプロファイルが未接続です / 次: Chromeの拡張でReconnect→Connectedを確認してから、新しいtask-owned sessionで対象をfresh readback";
  }
  if (["client_transport_disconnected", "extension_transport_disconnected"].includes(normalized)) {
    return "Companion通信が切断されました / 次: 接続を復旧し、前回操作を再送せず新しいsessionで対象をfresh readback";
  }
  if (["unknown_effect", "unknown_effect_ledger_only"].includes(normalized)) {
    return "外部効果が未確認です / 次: 同じRunのreceipt・対象readbackを照合し、再送しない";
  }
  if (normalized === "ledger_only") {
    return "過去の台帳記録のみです / 次: live tabや操作可能なsessionとは扱わず、現在の対象を新しくreadback";
  }
  if (normalized === "owner_sso_required" || normalized === "owner_sso_required_on_fresh_task_owned_ingress_session") {
    return "AOS OwnerのGoogle認証が必要です / 次: 公式AOS画面でnichika2000823@gmail.comの認証を完了してから、保護されたreadbackを再確認";
  }
  if (normalized === "job_application_account_connection_inventory_empty") {
    return "応募アカウントが未接続です / 次: Integrationsで応募先のverified接続を認証して確認";
  }
  if (normalized === "job_application_account_ref_not_verified") {
    return "応募アカウントの確認が必要です / 次: 対象account_refを再認証してverified接続を確認";
  }
  if (normalized === "job_provider_connection_inventory_missing") {
    return "応募先のverified接続が未確認です / 次: Integrationsで応募先accountの接続状態を確認";
  }
  if (normalized === "job_application_internal_browser_auth_surface_mismatch") {
    return "応募対象のProfile 2内部認証と現在のWeb操作面が不一致です / 次: Chrome Plugin・Profile 2を選択してfresh readbackを確認";
  }
  if (normalized === "standing_approval_scope_unverified") {
    return "応募の対象範囲が未承認です / 次: 対象限定approvalの範囲と期限を確認";
  }
  if (normalized === "portable_external_approval_required") {
    return "この処理の実行承認待ちです / 次: 同じRunの対象・内容・期限を確認";
  }
  if (normalized === "approval_expired_requires_fresh_target_bound_approval") {
    return "実行承認の期限が切れています / 次: 対象と内容を確認し、新しい依頼の承認を準備";
  }
  if (normalized === "approval_rejected") {
    return "承認が却下されたため、このRunは実行前に停止しました";
  }
  if (normalized === "approval_cancelled") {
    return "承認が取り消されたため、このRunは実行前に停止しました";
  }
  if (normalized === "same_run_provider_receipt_source_sync_reconciliation_missing") {
    return "応募結果の同一Run証跡が不足しています / 次: provider receipt・source sync・reconciliationを確認";
  }
  if (normalized === "codex_app_server_chatgpt_login_required") {
    return "専用Codexサービスのログイン承認待ちです / 次: OpenAI認証画面で承認を完了";
  }
  if (normalized === "codex_app_server_remote_required_for_auth") {
    return "このAOS画面はMacのlocal stdio接続です。専用Zeabur Codexサービスの認証画面には接続していません / 次: 専用remote WebSocket接続を設定してから認証を開始";
  }
  if (normalized === "zeabur_connector_auth_not_verified") {
    return "会社1のPlugin認証が未完了です / 次: 公式Integrationsで認証状態を確認";
  }
  if (normalized === "plugin_auth_readback_timeout") {
    return "Plugin認証状態のreadbackがタイムアウトしました / 次: 接続状態を確認してから新しい確認を1回だけ実行";
  }
  if (normalized === "company_connection_ref_missing") {
    return "会社1の接続参照がverifiedではありません / 次: 公式認証後に同じ会社scopeで再確認";
  }
  if (normalized === "registered_automation_local_runner_not_wired_to_http") {
    return "手動実行の接続準備が完了していません / 次: 登録automationのfresh readback後に正規手動実行接続を確認";
  }
  if (normalized === "registered_automation_effect_stage_not_admitted") {
    return "読み取り専用の確認要求は受付可能です。業務実行は未許可です / 次: 対象限定の承認・同一Run receipt・source syncを確認";
  }
  if (normalized === "chrome_selected_tab_readback_invalid") {
    return "Chromeの現在タブを取得できません / 次: Profile 2で対象タブを選択してから、正規Bridgeの登録状態を再確認";
  }
  if (normalized === "chrome_plugin_runtime_host_environment_missing") {
    return "Chrome Pluginの公式実行ホストが利用できません / 次: Codex Chrome laneがtrusted runtimeを広告した後に、Profile 2のfresh readbackを再確認";
  }
  if (normalized === "chrome_plugin_bridge_endpoint_not_listening") {
    return "Chrome Pluginの公式Bridgeが起動していません / 次: 公式Bridgeの状態変化後に、Profile 2のfresh readbackを再確認";
  }
  if (normalized === "chrome_extension_browser_client_session_setup_timeout") {
    return "Chrome Pluginの新規接続がタイムアウトしました / 次: 状態変化後に同じbindingを使わず、Profile 2のfresh admissionを1回だけ再確認";
  }
  if (normalized === "chrome_extension_target_readback_target_not_in_fresh_open_tabs") {
    return "確認対象のタブがfresh一覧にありません / 次: allowlist済みのtask-owned対象を用意してから、同一runでreadbackを再確認";
  }
  if (normalized === "chrome_extension_target_readback_tabs_get_timeout") {
    return "Chromeの対象タブを読み取るためのhandle取得がタイムアウトしました / 次: Chrome状態変化後に同じbindingを使わず、Profile 2のfresh readbackを1回だけ再確認";
  }
  if (normalized.includes("registered_automation")) {
    return "登録automationの確認が必要です / 次: 登録状態とread-only可否を再確認";
  }
  if (normalized === "chrome_plugin_bridge_refresh_failed:chrome_plugin_bridge_health_binding_invalid") {
    return "Chrome Plugin・Profile 2の接続先が現行Bridgeと一致していません / 次: Profile 2の正規接続を再確認してからread-only Runを再実行";
  }
  if (normalized.includes("chrome_plugin_foreground_executor_lease_expired")) {
    return "このread-only RunはChromeのforeground接続期限切れで停止しました / 次: 新しい正規Profile 2 Bridgeで、このRunのworker readbackだけを確認";
  }
  if (normalized.includes("chrome_plugin_bridge_refresh_failed") || normalized.includes("chrome_plugin_bridge")) {
    return "Chrome Plugin・Profile 2の接続確認が必要です / 次: 正規Bridgeのfresh readbackを確認してからread-only Runを再実行";
  }
  if (normalized.includes("chrome_extension") || normalized.includes("chrome_plugin")) {
    return "Chrome Plugin・Profile 2の確認が必要です / 次: 正規Bridgeの接続状態を確認してください";
  }
  if (normalized.includes("approval")) return `承認が必要です / blocker=${safe}`;
  if (normalized.includes("heartbeat") || normalized.includes("worker")) return `Mac側の接続確認が必要です / blocker=${safe}`;
  if (normalized.includes("chrome") || normalized.includes("browser")) return "ブラウザ接続の確認が必要です / 次: 指定された正規ブラウザsurfaceを確認してください";
  if (normalized.includes("auth") || normalized.includes("login") || normalized.includes("credential")) return `ログイン確認が必要です / blocker=${safe}`;
  return `詳細確認が必要です / blocker=${safe}`;
}

function publicRunBlockerSummary(run: any, mvpState?: MvpState) {
  const raw = runBlockerValue(run, mvpState);
  if (raw) return publicBlockerSummary(raw);
  const status = String(run?.status ?? "").toLowerCase();
  if (["complete", "completed", "success", "succeeded"].includes(status)) return "なし";
  return "未確認";
}

function jstDateKey(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : null;
}

function jstDateLabel(value: Date = new Date()) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(value);
}

function runTimestamp(run: any) {
  return run?.updated_at ?? run?.started_at ?? run?.queued_at ?? run?.created_at ?? null;
}

// A portable worker may persist the provider/bridge blocker only inside the
// same-run receipt. Keep the UI bound to that receipt instead of presenting a
// blank stop reason when the top-level run projection has no error column.
function runBlockerValue(run: any, mvpState?: MvpState): string | null {
  const metadata = parseJsonRecord(run?.metadata_json);
  const remoteReceipt = parseJsonRecord(metadata.remote_worker_receipt);
  const explicit = [
    run?.exact_blocker,
    run?.last_error,
    metadata.stop_reason,
    metadata.exact_blocker,
    remoteReceipt.exact_blocker,
  ].find((value) => typeof value === "string" && value.trim()) as string | null;
  if (explicit) return explicit;
  const invocation = parseJsonRecord(metadata.portable_workflow_invocation);
  const readOnlyStage = typeof metadata.read_only_stage === "string"
    ? metadata.read_only_stage
    : typeof invocation.read_only_stage === "string" ? invocation.read_only_stage : "";
  const status = String(run?.status ?? "").toLowerCase();
  const claim = parseJsonRecord(metadata.remote_worker_claim);
  const hasClaim = typeof claim.run_id === "string" || typeof claim.worker_id === "string";
  const hasReceipt = typeof remoteReceipt.status === "string" || typeof remoteReceipt.exact_blocker === "string";
  const runCompanyId = runCompanyScopeId(run, mvpState);
  const remoteWorkerCompanyIds = Array.isArray(mvpState?.worker?.worker_scope?.remoteWorkerCompanyIds)
    ? mvpState.worker.worker_scope.remoteWorkerCompanyIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  if (readOnlyStage === "reference_readback"
    && ["queued", "waiting", "running", "waiting_approval"].includes(status)
    && !hasClaim
    && !hasReceipt
    && Boolean(runCompanyId)
    && remoteWorkerCompanyIds.length > 0
    && !remoteWorkerCompanyIds.includes(runCompanyId)) {
    return "portable_worker_company_scope_mismatch";
  }
  if (readOnlyStage === "reference_readback"
    && ["queued", "waiting", "running", "waiting_approval"].includes(status)
    && !hasClaim
    && !hasReceipt) {
    return "portable_preflight_run_waiting_for_worker_readback";
  }
  return null;
}

function runCompanyScopeId(run: any, mvpState?: MvpState): string {
  const automation = mvpState?.automations?.find((item: any) => item.id === run?.automation_id);
  return String(run?.company_id ?? run?.project_id ?? automation?.company_id ?? automation?.project_id ?? "").trim();
}

function relativeAgeLabel(value: unknown) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return "未確認";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}秒前`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}分前`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}時間前`;
  return `${Math.floor(ageHours / 24)}日前`;
}

function workerFreshnessLabel(worker: Partial<NonNullable<MvpState["worker"]>> & { updatedAt?: string | null }) {
  const timestamp = worker.heartbeat_at ?? worker.updatedAt ?? null;
  const age = relativeAgeLabel(timestamp);
  if (worker.readback_status === "stored") return `状態記録: ${age} / Mac heartbeat未確認`;
  if (worker.heartbeat_fresh === false) return `heartbeat: ${age} / stale`;
  if (worker.heartbeat_fresh === true) return `heartbeat: ${age} / fresh`;
  return `状態記録: ${age} / heartbeat鮮度未確認`;
}

function portableDiagnosticHeartbeatLabel(diagnostics: any) {
  const checks = Array.isArray(diagnostics?.pc?.system_checks)
    ? diagnostics.pc.system_checks.filter((check: any) => check?.kind === "portable_mac_worker")
    : [];
  const latest = [...checks].sort((a: any, b: any) => {
    const aTime = Date.parse(String(a?.created_at ?? ""));
    const bTime = Date.parse(String(b?.created_at ?? ""));
    return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
  }).at(-1);
  if (!latest) return null;
  let metadata: Record<string, unknown> = {};
  if (typeof latest.metadata_json === "string") {
    try {
      const parsed = JSON.parse(latest.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      metadata = {};
    }
  } else if (latest.metadata_json && typeof latest.metadata_json === "object" && !Array.isArray(latest.metadata_json)) {
    metadata = latest.metadata_json;
  }
  const timestamp = typeof metadata.heartbeat_at === "string"
    ? metadata.heartbeat_at
    : typeof latest.created_at === "string" ? latest.created_at : null;
  const parsedTimestamp = Date.parse(String(timestamp ?? ""));
  if (!Number.isFinite(parsedTimestamp)) return "heartbeat: 未確認 / system check";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - parsedTimestamp) / 1000));
  const fresh = ageSeconds <= 300 && String(latest.status ?? "").toLowerCase() !== "blocked" && !metadata.exact_blocker;
  return `heartbeat: ${relativeAgeLabel(timestamp)} / ${fresh ? "fresh" : "stale"} (system check)`;
}

function adminWorkerFreshnessLabel(diagnostics: any, worker: MvpState["worker"]) {
  const portable = portableDiagnosticHeartbeatLabel(diagnostics)
    ?? (worker?.heartbeat_at ? workerFreshnessLabel(worker) : "未確認");
  const local = diagnostics?.pc?.local_worker?.updatedAt
    ? workerFreshnessLabel({ updatedAt: diagnostics.pc.local_worker.updatedAt, readback_status: "diagnostic" })
    : "未確認";
  return `Portable Mac worker: ${portable} / local worker診断: ${local}`;
}

function isChromePluginRuntime(runtime: MvpState["browser_use_runtime"]) {
  return runtime?.backend === "chrome_plugin"
    || runtime?.surface === "signed_chrome_extension_profile2"
    || runtime?.helper === "chrome_extension_trusted_bridge";
}

// Profile 2 is the fixed, signed Chrome Plugin browser-auth binding for the
// job lane. It is not a provider OAuth connection and therefore does not
// appear in the company connection inventory.
const CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF = "auth:chrome-profile2";

function isChromePluginProfile2Backend(value: MvpState["web_operation_backend"] | undefined) {
  const profile = value?.chrome_profile;
  return value?.backend === "chrome_plugin"
    && profile?.id === "profile2"
    && profile?.name === "Profile 2"
    && profile?.directory === "Profile 2"
    && profile?.surface === "signed_chrome_extension_profile2";
}

function publicWebOperationBackendLabel(backend: unknown) {
  if (backend === "chrome_plugin") return "Chrome Plugin";
  if (backend === "browser_use_cli") return "Browser Use CLI";
  if (backend === "aos_chrome_companion") return "AOS Chrome Companion";
  if (backend === "playwright") return "Playwright";
  return backend ? String(backend) : "Browser runtime";
}

function publicBrowserUseRuntimeStatus(runtime: MvpState["browser_use_runtime"]) {
  if (!runtime) return "未確認";
  if (isChromePluginRuntime(runtime)) {
    const pluginReadback = runtime.chromePluginReadback;
    if (pluginReadback?.status === "ready" || runtime.status === "verified") return "確認済み";
    if (pluginReadback?.status === "stale" || pluginReadback?.exactBlocker || runtime.exactBlocker === "chrome_extension_bridge_readback_stale") return "要確認";
    if (runtime.status === "readback_pending") return "Chrome Plugin readback未確定";
    if (runtime.status === "blocked") return "要確認";
    return "未確認";
  }
  const processBlocker = runtime.processReadback?.exactBlocker;
  if (processBlocker === "browser_use_unregistered_live_process") return "未登録Browserあり（照合待ち）";
  if (processBlocker === "browser_use_live_process_binding_mismatch") return "profile / port不一致（照合待ち）";
  if (runtime.processReadback?.status === "unavailable") return "process readback取得不可";
  if (runtime.status === "verified") return "確認済み";
  if (runtime.status === "readback_pending") return "Mac worker readback未確定";
  if (runtime.status === "blocked") return "要確認";
  return "未確認";
}

function publicBrowserUseLaneReadbackStatus(lane: BrowserUseLaneBinding) {
  const value = String(lane.liveReadbackStatus ?? "not_claimed");
  if (value === "verified" || value === "same_run_verified") return "same-run実測済み";
  if (value === "blocked") return "same-run readback停止";
  return "未claim（予約のみ）";
}

function publicBrowserUseLaneProcessReadbackStatus(lane: BrowserUseLaneBinding) {
  const value = String(lane.processReadbackStatus ?? "not_observed");
  if (value === "present") return "process検出（profile/port一致）";
  if (value === "binding_mismatch") return "process検出（profile/port不一致）";
  if (value === "absent") return "process未検出";
  if (value === "unavailable") return "process readback取得不可";
  return "process未観測";
}

function publicBrowserUseLaneNextCheck(lane: BrowserUseLaneBinding, runtime: MvpState["browser_use_runtime"]) {
  const readback = String(lane.liveReadbackStatus ?? "not_claimed");
  if (readback === "verified" || readback === "same_run_verified") return "同一Runのreceipt / cleanupを確認";
  if (readback === "blocked") return "exact blockerを解消して再読戻し";
  if (runtime?.runtimeRole === "control_plane") return "Mac workerの同一Run readbackを取得";
  return "profile/port lockとprocess identityを同一Runで確認";
}

function publicBrowserUseRuntimeNextCheck(runtime: MvpState["browser_use_runtime"]) {
  if (!runtime) return "AOS stateを同期してCompanion runtimeを確認";
  if (isChromePluginRuntime(runtime)) {
    const pluginBlocker = runtime.chromePluginReadback?.exactBlocker ?? runtime.exactBlocker;
    if (pluginBlocker) return `Chrome Plugin trusted bridgeとProfile 2のfresh readbackを確認（${pluginBlocker}）`;
    if (runtime.status === "readback_pending") return "Chrome Plugin trusted bridgeとProfile 2のfresh readbackを確認";
    if (runtime.status === "blocked") return "Chrome Plugin runtimeのexact blockerを確認";
    if (runtime.status === "verified" || runtime.chromePluginReadback?.status === "ready") return "実行時はChrome Plugin authority・Profile 2・receipt・cleanupを確認";
    return runtime.nextAction ?? "Chrome Plugin/Profile 2のreadbackを確認";
  }
  if (runtime.processReadback?.exactBlocker) return `foreign / process bindingを変更せず、同一Runのroom・authority・recordingを照合（${runtime.processReadback.exactBlocker}）`;
  if (runtime.processReadback?.status === "unavailable") return "Mac workerからprocess identityとprofile/port lockのreadbackを取得";
  if (runtime.status === "readback_pending") return "Mac worker heartbeatと同一RunのCompanion readbackを確認";
  if (runtime.status === "blocked") return runtime.exactBlocker ? `exact blocker: ${runtime.exactBlocker}` : "Mac worker runtimeのexact blockerを確認";
  if (runtime.status === "verified") return "実行時はauthority・profile/port lock・receipt・cleanupを確認";
  return runtime.nextAction ?? "Companion runtimeのreadbackを確認";
}

function publicBrowserUseProcessReadbackStatus(readback: BrowserUseProcessReadback | undefined) {
  if (!readback) return "未確認";
  if (readback.status === "available") return "同一ホストprocess実測済み";
  if (readback.status === "unavailable") return "同一ホストprocess未取得";
  return "未確認";
}

function publicPortableRemoteWorkerProcessReadback(worker: BrowserUseProcessReadback["portableRemoteWorker"] | undefined) {
  if (!worker) return { label: "未確認", detail: "remote workerのreadbackを確認してください。" };
  if (worker.processStatus === "present") {
    return {
      label: "同一ホストprocess検出",
      detail: `process=${worker.processCount ?? 0}。process存在だけではheartbeat・queue claim・receipt・source syncを完了扱いにしません。`
    };
  }
  if (worker.status === "remote_reported") {
    const identity = worker.remoteReport?.identityStatus && worker.remoteReport.identityStatus !== "verified"
      ? ` / identity=${worker.remoteReport.identityStatus}`
      : "";
    return {
      label: "Mac heartbeat reportあり",
      detail: `APIホストのprocessは未観測です${identity}。同一Runのreceipt/readbackを別に確認してください。`
    };
  }
  if (worker.processReadbackStatus === "unavailable") {
    return { label: "同一ホストprocess未取得", detail: "Mac workerのheartbeat reportと同一Runのreadbackを確認してください。" };
  }
  if (worker.status === "absent") {
    return { label: "同一ホストprocess未観測", detail: "Mac停止とは判定せず、heartbeatでMac側を別に確認してください。" };
  }
  if (worker.remoteReport?.readbackStatus === "unreadable") {
    return { label: "heartbeat report未読", detail: worker.remoteReport.exactBlocker ?? "保存されたheartbeat reportを再取得してください。" };
  }
  return { label: "未確認", detail: "remote workerのheartbeatとprocess readbackを確認してください。" };
}

function publicBrowserOperationalAuthenticationStatus(readback: BrowserUseOperationalReadback | undefined) {
  const status = readback?.authentication?.status;
  if (status === "waiting_auth") return "認証待ち（人間入力）";
  if (status === "verified") return "同一Run認証readback済み";
  if (status === "not_required") return "認証不要を同一Run確認";
  return "未確認（画面readback必須）";
}

function publicBrowserOperationalEffectStatus(readback: BrowserUseOperationalReadback | undefined) {
  const effect = readback?.externalEffect;
  if (effect?.status === "executed" && effect.externalActionExecuted === true) return "実行済み（receipt照合待ち）";
  if (effect?.status === "approval_pending") return "承認待ち";
  if (effect?.status === "reconciliation_required") return "作用不明（再実行禁止）";
  return "未検証（provider receipt必須）";
}

function publicBrowserOperationalCompletionStatus(readback: BrowserUseOperationalReadback | undefined) {
  const completion = readback?.businessCompletion;
  if (completion?.status === "verified" && completion.businessCompletionVerified === true) return "業務完了verified";
  if (completion?.status === "blocked") return "blocked";
  return "業務完了未claim";
}

function publicBrowserOperationalProofStatus(readback: BrowserUseOperationalReadback | undefined) {
  const receipt = readback?.receipt?.status ?? "not_claimed";
  const sourceSync = readback?.sourceSync?.status ?? "not_claimed";
  return `receipt=${receipt} / source sync=${sourceSync}`;
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
  /** Preserve identity metadata for the five-row start guide. */
  company_id?: string;
  builder_spec?: Record<string, unknown>;
  execution_target?: Record<string, unknown>;
  exact_blocker?: string;
  latest_proof?: Record<string, unknown>;
  revision: number;
  automation_type: string;
  name: string;
  desc: string;
  schedule: string;
  schedule_version: string;
  next_run_at: string;
  lane: string;
  last: string;
  execution_mode: "control_plane_dry_run" | "registered_workflow_readback" | "portable_mac_worker_queue" | "unverified";
  execution_label: string;
  scheduler_effect: string;
  status: Status;
};
type ScheduleKind = "manual" | "daily" | "weekly" | "cron";
type ScheduleDraft = {
  kind: ScheduleKind;
  expression: string;
  timezone: string;
  enabled: boolean;
};

type BrowserUseLaneBinding = {
  id?: string;
  workflowId?: string;
  runnerKind?: string;
  canonicalBrowserSurface?: string;
  executionContract?: string;
  visibility?: string;
  status?: string;
  lifecycle?: string;
  profileRef?: string;
  profileName?: string;
  reservedPort?: number;
  portStatus?: string;
  ownership?: string;
  bindingStatus?: string;
  liveReadbackStatus?: string;
  processReadbackStatus?: string;
  processPid?: number | null;
  processReadbackCapturedAt?: string | null;
};

type BrowserUseProcessReadback = {
  schema?: string;
  status?: string;
  source?: string;
  capturedAt?: string;
  exactBlocker?: string | null;
  nextAction?: string;
  unregisteredBrowserProcessCount?: number;
  bindingMismatchCount?: number;
  registeredLanes?: Array<{ laneId?: string; workflowId?: string; profileRef?: string; reservedPort?: number; processStatus?: string; matchingPid?: number | null; mismatchPid?: number | null }>;
  roomReadback?: { status?: string; source?: string; reconciliation?: string | null; activeRoomCount?: number; matchedProcessCount?: number; exactBlocker?: string | null };
  browserProcesses?: Array<{ kind?: string; pid?: number; processCount?: number; profileRef?: string; profileName?: string; port?: number; laneId?: string | null; workflowId?: string | null; bindingStatus?: string; ownership?: string; readbackStatus?: string; roomId?: string | null; roomState?: string | null; roomLifecycle?: string | null; roomOwnerKind?: string | null; roomOwnerId?: string | null; roomTaskId?: string | null; roomAutomationId?: string | null; roomCurrentActivity?: string | null; roomMatchStatus?: string; roomOwnership?: string; roomReclaimAllowed?: boolean | null; roomReadbackStatus?: string }>;
  workerScopeReadback?: {
    status?: string;
    controlPlaneCompanyIds?: string[];
    remoteWorkerCompanyIds?: string[];
    remoteOrigins?: string[];
    workerIds?: string[];
    remoteWorkerInstanceIds?: string[];
    remoteWorkerGenerations?: string[];
    identityStatus?: string;
    alignmentCandidates?: Array<{ scope?: string; status?: string; companyIds?: string[]; origins?: string[]; workerIds?: string[] }>;
    alignmentDecisionRequired?: boolean;
    exactBlocker?: string | null;
    nextAction?: string;
  };
  portableRemoteWorker?: {
    status?: string;
    processStatus?: string;
    processReadbackStatus?: string;
    processCount?: number;
    pids?: number[];
    mode?: string;
    effects?: string;
    durableOnly?: boolean | null;
    processes?: Array<{ pid?: number; workerId?: string | null; remoteOrigin?: string | null; remoteCompanyId?: string | null; mode?: string; effects?: string; durableOnly?: boolean | null }>;
    scopeReadback?: {
      status?: string;
      controlPlaneCompanyIds?: string[];
      remoteWorkerCompanyIds?: string[];
      remoteOrigins?: string[];
      workerIds?: string[];
      remoteWorkerInstanceIds?: string[];
      remoteWorkerGenerations?: string[];
      identityStatus?: string;
      alignmentCandidates?: Array<{ scope?: string; status?: string; companyIds?: string[]; origins?: string[]; workerIds?: string[] }>;
      alignmentDecisionRequired?: boolean;
      exactBlocker?: string | null;
      nextAction?: string;
    };
    transportReadback?: {
      status?: string;
      heartbeatStatus?: string;
      heartbeatExactBlocker?: string | null;
      heartbeatAt?: string | null;
      lastSuccessfulHeartbeatAt?: string | null;
      lastAttemptAt?: string | null;
      claimStatus?: string;
      generationStartedAt?: string | null;
      updatedAt?: string | null;
      pid?: number | null;
      workerId?: string | null;
      workerInstanceId?: string | null;
      generation?: string | null;
      observedAt?: string | null;
      identityStatus?: string;
      remoteOrigin?: string | null;
    };
    remoteReport?: {
      readbackStatus?: string;
      identityStatus?: string;
      workerInstanceId?: string | null;
      generation?: string | null;
      exactBlocker?: string | null;
      status?: string;
    } | null;
  };
};

type BrowserUseOperationalReadback = {
  schema?: string;
  scope?: string;
  capturedAt?: string;
  authentication?: { status?: string; exactBlocker?: string | null; source?: string };
  externalEffect?: { status?: string; externalActionExecuted?: boolean; exactBlocker?: string; source?: string };
  businessCompletion?: { status?: string; businessCompletionVerified?: boolean; exactBlocker?: string; source?: string };
  receipt?: { status?: string; sameRunReceipt?: boolean; exactBlocker?: string };
  sourceSync?: { status?: string; sameRunSourceSync?: boolean; exactBlocker?: string };
  worker?: { processStatus?: string; transportStatus?: string; heartbeatStatus?: string; claimStatus?: string; receiptStatus?: string; sourceSyncStatus?: string; exactBlocker?: string | null };
};

function normalizeScheduleKind(value: unknown): ScheduleKind {
  return value === "manual" || value === "daily" || value === "weekly" || value === "cron" ? value : "manual";
}
type MvpState = {
  updated_at?: string;
  web_operation_backend?: {
    schema?: string;
    id?: string;
    backend?: "chrome_plugin" | "browser_use_cli" | "playwright" | string;
    revision?: number;
    chrome_profile?: { id?: string; name?: string; directory?: string; surface?: string };
    source?: string;
    updated_at?: string;
    updated_by?: string | null;
    exact_blocker?: string | null;
  };
  worker?: { id: string; status: string; heartbeat_at: string | null; queue_depth: number; queue_current_count?: number; queue_historical_count?: number; queue_unknown_count?: number; last_run_id: string | null; heartbeat_age_seconds?: number | null; heartbeat_fresh?: boolean; readback_status?: string; exact_blocker?: string | null; next_action?: string; queue_scope?: { source?: string; company_ids?: string[] }; worker_scope?: NonNullable<BrowserUseProcessReadback["portableRemoteWorker"]>["scopeReadback"]; portable_remote_worker?: BrowserUseProcessReadback["portableRemoteWorker"]; external_action_executed?: boolean };
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
  registered_workflow_ids?: string[];
  registered_workflows?: Array<{ id?: string; name?: string }>;
  sync_readback?: {
    schema?: string;
    captured_at?: string;
    company_ids?: string[];
    automation_ids?: string[];
    registered_workflow_ids?: string[];
    automation_count?: number;
    registered_workflow_count?: number;
    runs_count?: number;
  };
  company_scope?: { enforced?: boolean; company_ids?: string[] };
  presentation_profiles?: Array<{ id: string; kind: string; label: string; source?: string; revision?: number; exactBlocker?: string | null; purpose?: string; freshnessSlaMinutes?: number; browserUseLane?: string; stopBoundary?: string; primaryMetrics?: string[]; widgets?: string[]; preferredGrouping?: string; explanation?: string }>;
  browser_use_runtime?: { backend?: string; surface?: string; helper?: string; runtimeRole?: string; status?: string; exactBlocker?: string | null; readbackStatus?: string; summary?: string; nextAction?: string; fallbackPolicy?: string; contract?: string[]; lanes?: BrowserUseLaneBinding[]; processReadback?: BrowserUseProcessReadback; chromePluginReadback?: { status?: string; exactBlocker?: string | null; capturedAt?: string | null; refreshStatus?: string | null; bridgeInstanceId?: string | null; bridgeUrl?: string | null; browser?: { metadata?: Record<string, string> } }; operationalReadback?: BrowserUseOperationalReadback; workflowInventory?: { sets?: Record<string, string[]>; relationships?: { browser_and_catalog_overlap?: string[]; browser_only?: string[]; catalog_only?: string[]; lane_only?: string[]; browser_and_portable_match?: boolean; catalog_and_adapter_match?: boolean } } };
  schedules?: any[];
  runs?: any[];
  /** Dedicated company-scoped latest-run candidates for the five-row start guide. */
  workflowStartGuideRuns?: any[];
  readback_projection?: "full" | "ui" | "summary" | string;
  run_summary?: { total_count?: number; blocked_count?: number; active_count?: number; completed_count?: number; today_count?: number; today_blocked_count?: number; today_active_count?: number; today_completed_count?: number };
  approval_summary?: { total_count?: number; waiting_count?: number; expired_count?: number };
  proof_summary?: { total_count?: number };
  job_summary?: { total_count?: number; queued_count?: number; leased_count?: number };
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
      targetScopedAvailable?: boolean;
      targetScopedExactBlocker?: string | null;
      targetScopedOperationStatus?: string;
      summary: string;
      nextAction: string;
      chromeBinary: string | null;
      cdpLaneConfigured: boolean;
      targetScopedReadback?: {
        status?: string;
        operationReady?: boolean;
        operationStatus?: string;
        exactBlocker?: string | null;
      };
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
    automationOsApi?: CapabilitySurface;
    mcp?: CapabilitySurface;
    cli?: CapabilitySurface;
    appServer?: CapabilitySurface;
    skills?: CapabilityItem[];
    plugins?: CapabilityItem[];
    availablePlugins?: CapabilityItem[];
    automations?: CapabilityItem[];
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
    toolPreference?: ToolPreferenceReadback;
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

type MvpLoadStatus = "loading" | "ready" | "degraded" | "error";

type RunDetail = {
  run: any;
  steps: any[];
  proofs: any[];
  children: any[];
  workerEvents: any[];
};

type PortableRunProjection = {
  same_run?: boolean;
  execution_mode_label?: string;
  planned_operation_scope?: { status?: string; operation?: string | null; account_ref?: string | null; target_key?: string | null; payload_hash?: string | null; source_snapshot_id?: string | null; vault_path?: string | null; repository?: string | null; branch?: string | null; provenance?: Record<string, string> };
  observed_results?: { status?: string; operation?: string | null; maintenance?: boolean | null; export?: boolean | null; git_sync?: boolean | null; provenance?: Record<string, string> };
  missing?: string[];
  mismatches?: string[];
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

type CapabilityItem = CapabilitySurface & {
  role?: "primary" | "helper";
  hiddenFromSuggestions?: boolean;
  catalogSource?: "installed" | "recommended" | "official";
  installHint?: string;
  pluginId?: string;
  marketplaceName?: string;
  authPolicy?: "ON_INSTALL" | "ON_USE" | null;
};

type PluginAuthPollState = {
  status: "verified" | "blocked" | "checking";
  attempt: number;
  exactBlocker: string | null;
  runtimeReady?: boolean;
};

type GmailReadOnlyCanaryReadback = {
  schema?: string;
  status?: "ready_for_provider_call" | "completed" | "blocked" | string;
  runId?: string;
  companyId?: string;
  connector?: string;
  operation?: string;
  transport?: string;
  selectedTool?: { id?: string; label?: string; kind?: string; status?: string } | null;
  providerToolCallObserved?: boolean;
  providerAccountPresent?: boolean;
  providerAccountHash?: string | null;
  exactBlocker?: string | null;
  nextAction?: string;
  externalActionExecuted?: boolean;
  dataRead?: boolean;
  dataPersisted?: boolean;
  secretMaterialIncluded?: boolean;
  providerReceipt?: unknown;
  sourceSync?: { status?: string; accountRefHash?: string; exactBlocker?: string };
  reconciliation?: { required?: boolean; status?: string };
  cleanup?: { status?: string; ephemeralThread?: boolean };
};

type ZeaburConnectorRegistryReadback = {
  exactBlocker?: string | null;
  capturedAt?: string;
  target?: { serviceName?: string; serviceId?: string; environmentId?: string };
  appServer?: { servicePresent?: boolean; runtimeStatus?: string; codexLogin?: string };
  pluginRegistry?: {
    installed?: Array<{ id?: string; name?: string; installed?: boolean; authStatus?: string; marketplaceName?: string; authPolicy?: "ON_INSTALL" | "ON_USE" | null }>;
    available?: Array<{ id?: string; name?: string; installed?: boolean; authStatus?: string; marketplaceName?: string; authPolicy?: "ON_INSTALL" | "ON_USE" | null }>;
  };
  mcpRegistry?: { configuredCount?: number; verified?: boolean; names?: string[] };
  connectorAuth?: Record<string, string>;
};

type ToolPreferenceReadback = {
  schema?: string;
  order?: string[];
  priorityPolicy?: string;
  selected?: {
    id?: string;
    label?: string;
    kind?: string;
    status?: string;
    companyBound?: boolean;
    verified?: boolean;
    reason?: string;
    executionOwner?: string;
  } | null;
  candidates?: Array<{
    id?: string;
    label?: string;
    kind?: string;
    rank?: number;
    status?: string;
    commandMatch?: boolean;
    companyBound?: boolean;
    verified?: boolean;
    reason?: string;
  }>;
  officialCandidates?: Array<{
    id?: string;
    label?: string;
    kind?: string;
    endpoint?: string;
    sourceUrl?: string;
    status?: string;
    commandMatch?: boolean;
  }>;
  companyIds?: string[];
  fallbackPolicy?: string;
  discovery?: { source?: string; officialCatalogResearch?: string };
  connectorExecution?: {
    connector?: string;
    owner?: string;
    status?: string;
    zeaburPluginInstalled?: boolean;
    zeaburConnectorAuth?: string;
    zeaburMcpConfigured?: boolean;
    macWorkerDefaultSurface?: string;
    fallbackPolicy?: string;
    exactBlocker?: string | null;
    nextAction?: string;
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

function publicCapabilityBlocker(surface?: { status?: string; exactBlocker?: string | null }) {
  const exactBlocker = String(surface?.exactBlocker ?? "").trim();
  if (exactBlocker) return exactBlocker;
  if (surface?.status === "ready" || surface?.status === "available") return "なし";
  return "未確認";
}

function publicCapabilityStatus(surface?: { status?: string }) {
  if (surface?.status === "ready") return "確認済み";
  if (surface?.status === "blocked") return "停止中";
  if (surface?.status === "available") return "利用可能";
  return "未確認";
}

function publicChromeLaneStatus(surface?: { status?: string; targetScopedAvailable?: boolean }) {
  if (surface?.targetScopedAvailable === true && surface.status !== "ready") return "target-scoped利用可";
  return publicCapabilityStatus(surface);
}

function publicChromeLaneBlocker(surface?: { status?: string; exactBlocker?: string | null; targetScopedAvailable?: boolean; targetScopedExactBlocker?: string | null }) {
  const foreground = publicCapabilityBlocker(surface);
  if (surface?.targetScopedAvailable === true && surface.status !== "ready") {
    return `foreground操作: ${foreground} / target-scoped: 利用可（URL・タイトル・DOM readback）`;
  }
  if (surface?.targetScopedExactBlocker && surface.status !== "ready") {
    return `foreground操作: ${foreground} / target-scoped: ${surface.targetScopedExactBlocker}`;
  }
  return foreground;
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
  company_registration_projection?: any[];
};

type CanonicalAutomationRegistryReadback = {
  ok?: boolean;
  schema?: string;
  authority?: string;
  companyId?: string;
  status?: "ok" | string;
  items?: Array<{
    id: string;
    source: "protected_postgres_catalog" | "codex_heartbeat" | string;
    plane: "catalog" | "heartbeat" | string;
    companyId: string;
    name: string;
    schedule?: { kind?: string; expression?: string; timezone?: string };
    entry?: { sourceAutomationId?: string | null; workerCommandKind?: string; readOnlyDefault?: boolean };
    effect?: { externalActionDefault?: boolean; executedInThisReadback?: boolean };
  }>;
  executionLaneAdapters?: string[];
  promotedToRuntimeRegistry?: boolean;
  externalActionExecuted?: boolean;
};

function workerStatusSummary(worker: MvpState["worker"]) {
  if (!worker) {
    return {
      fresh: false,
      stored: false,
      label: "unknown",
      blocker: "mac_worker_state_missing",
      nextAction: "MVP stateを再読込してworker状態を確認してください。",
      freshness: "未確認",
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
    freshness: workerFreshnessLabel(worker),
    display: blocker ? `blocker=${blocker} / 次: ${nextAction}` : storedReadback ? `readback=stored / 次: ${nextAction}` : `heartbeat=${worker.readback_status ?? "unknown"} / 次: ${nextAction}`
  };
}

type AutomationPlan = {
  kind: string;
  title: string;
  schedule: string;
  cadence: string;
  scheduleEnabled?: boolean;
  scheduleTimezone?: string;
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
  chat_stream_text_length?: number;
  chat_events?: PlannerEvent[];
  tool_preference?: ToolPreferenceReadback | null;
  proposed_changes?: PlannerChange[];
  requires_confirmation?: string[];
  web_operation_intake?: WebOperationIntake;
};

type CanonicalCompanyConsultationReadback = {
  schema: "canonical_company_consultation.v1";
  status: string;
  selection_state: "selected" | "unresolved";
  canonical_company_id: string | null;
  snapshot?: {
    snapshot_id?: string;
    captured_at?: string;
    input_fingerprint?: string;
    fresh?: boolean;
  };
  candidates: Array<{
    company_id: string;
    status: string;
    counts: { registered_automations: number; local_automations: number; schedules: number };
    provenance: { trigger: string | null; local: string };
    reason_codes: string[];
  }>;
  owner_decision: {
    required: boolean;
    recommended_candidate_company_id: string | null;
    available_candidate_company_ids: string[];
  };
  downstream: {
    schedule_activation: { status: string; exact_blocker: string | null };
    brief: { delivery_status: string; exact_blocker: string | null };
    provider_receipt: { status: string; exact_blocker: string | null };
    source_sync: { status: string; exact_blocker: string | null };
    reconciliation: { status: string; exact_blocker: string | null };
    cleanup: { status: string; exact_blocker: string | null };
  };
  chat: { consultation_available: boolean; read_only_demo_available: boolean; approval_preview_available: boolean; company_scoped_registration_ready: boolean; exact_blocker: string | null };
  exact_blocker: string | null;
  external_action_executed: false;
};

type WebOperationIntake = {
  schema: string;
  applicable: boolean;
  status: "not_applicable" | "needs_input" | "ready_for_read" | "approval_required" | "blocked";
  operation: "read" | "create" | "update" | "publish" | "submit" | "delete" | null;
  site_or_url: string | null;
  account_ref: string | null;
  semantic_target: string | null;
  payload_hash: string | null;
  payload_present: boolean;
  scope: string | null;
  missing_fields: string[];
  questions: string[];
  fixed_locator_detected: boolean;
  exact_blocker: string | null;
  next_stage: "not_applicable" | "clarify" | "read" | "approval";
  external_action_executed: false;
  readback_required: true;
  no_replay: true;
  web_operation_contract?: { schema?: string; operation_model?: { target_resolution?: string; fixed_playbook_policy?: string; unknown_effect_policy?: string } };
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
  streamTextLength: number;
  events: PlannerEvent[];
  workerStatus?: string;
  workerBlocker?: string;
  workerNextAction?: string;
};

type WorkerReadback = {
  status?: string;
  exactBlocker?: string | null;
  nextAction?: string | null;
  updatedAt?: string | null;
  processed?: number;
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
  webOperationIntake?: WebOperationIntake;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type ChatThreadReadback = {
  threadId: string;
  latestJobId: string;
  latestStatus: string;
  updatedAt: string;
  companyIds: string[];
  messages: Array<{ role: "assistant" | "user"; text: string }>;
  serverReply?: string;
  resultTitle?: string;
};

type ChatSessionReadback = {
  id: string;
  project_id: string;
  name: string;
  codex_thread_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

function nextChatId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function actionStamp() {
  return `${new Date().toLocaleTimeString("ja-JP", { hour12: false })}.${String(Date.now()).slice(-3)}`;
}

function normalizeApprovalStatus(status: string): Status {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "waiting" || normalized === "pending") return "waiting";
  if (normalized === "approved") return "approved";
  return "blocked";
}

function isApprovalExpired(status: unknown, expiresAt: unknown, now = Date.now()): boolean {
  if (!isApprovalWaitingStatus(status) || typeof expiresAt !== "string" || !expiresAt.trim()) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

function isApprovalWaitingStatus(status: unknown): boolean {
  return status === "waiting" || status === "pending";
}

function isApprovalWaiting(status: unknown, expiresAt?: unknown): boolean {
  return isApprovalWaitingStatus(status) && !isApprovalExpired(status, expiresAt);
}

function detectSchedule(text: string) {
  const recurring = /毎日|毎週|毎月|\b(?:daily|weekly|monthly)\b/iu.test(text);
  if (/手動.{0,8}(?:のみ|だけ|読み取り)|定期実行は(?:無効|なし|不要)|manual.only/iu.test(text)
    || (!recurring && /[1１一]回|一度だけ|今回だけ|まだ実行しない|実行せず|保存(?:する)?だけ|\b(?:once|one[- ]off|one[- ]time|draft only)\b/iu.test(text))) {
    return { schedule: "manual", cadence: "manual" };
  }
  const timeMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u) ?? text.match(/([01]?\d|2[0-3])\s*時(?:\s*([0-5]?\d)\s*分)?/u);
  const hour = timeMatch ? Number(timeMatch[1]) : text.includes("夕方") ? 18 : text.includes("夜") ? 20 : 9;
  const minute = Number(timeMatch?.[2] ?? 0);
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const cadence = /毎週|\bweekly\b/iu.test(text) ? "weekly" : /毎月|\bmonthly\b/iu.test(text) ? "monthly" : "daily";
  if (cadence === "monthly") return { schedule: `${minute} ${hour} 1 * *`, cadence };
  if (cadence === "weekly") {
    const weekday = /(?:毎週|週).*(?:日曜|日曜日)/u.test(text) ? "SUN"
      : /(?:毎週|週).*(?:月曜|月曜日)/u.test(text) ? "MON"
        : /(?:毎週|週).*(?:火曜|火曜日)/u.test(text) ? "TUE"
          : /(?:毎週|週).*(?:水曜|水曜日)/u.test(text) ? "WED"
            : /(?:毎週|週).*(?:木曜|木曜日)/u.test(text) ? "THU"
              : /(?:毎週|週).*(?:金曜|金曜日)/u.test(text) ? "FRI"
                : /(?:毎週|週).*(?:土曜|土曜日)/u.test(text) ? "SAT" : "MON";
    return { schedule: `${weekday} ${time}`, cadence };
  }
  return { schedule: time, cadence };
}

function scheduleKindForPlan(plan: AutomationPlan): ScheduleKind {
  if (plan.cadence === "manual") return "manual";
  if (plan.cadence === "weekly") return "weekly";
  if (plan.cadence === "monthly") return "cron";
  return "daily";
}

function schedulePreferencesFromPrompt(prompt: string): Pick<AutomationPlan, "scheduleEnabled" | "scheduleTimezone"> {
  const paused = /停止中のまま|停止して|無効(?:のまま|にして|に設定)|有効化(?:は|を)?しない|再開(?:は|を)?しない|(?:keep|leave).{0,15}(?:paused|disabled)|do not enable/iu.test(prompt);
  const active = !paused && /(?:予定|定期実行|スケジュール).{0,12}(?:再開して|有効(?:化して|にして))|\b(?:enable|resume)\s+(?:the\s+)?schedule\b/iu.test(prompt);
  const timezone = prompt.match(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/u)?.[0];
  let scheduleTimezone: string | undefined;
  if (timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); scheduleTimezone = timezone; } catch { /* Not an IANA timezone. */ }
  }
  return { ...(paused || active ? { scheduleEnabled: active } : {}), ...(scheduleTimezone ? { scheduleTimezone } : {}) };
}

function plannedChatScheduleValues(plan: AutomationPlan, currentSchedule: any) {
  const kind = scheduleKindForPlan(plan);
  return { kind, expression: kind === "manual" ? null : plan.schedule.trim(),
    timezone: plan.scheduleTimezone ?? String(currentSchedule?.timezone ?? "Asia/Tokyo"),
    enabled: kind !== "manual" && (plan.scheduleEnabled ?? currentSchedule?.enabled === true) };
}

type ChatScheduleAdjustment = { companyId: string; automationId: string; kind: ScheduleKind;
  expression: string | null; timezone: string; enabled: boolean; previousRevision: number };

function matchesChatScheduleAdjustment(schedule: any, expected: ChatScheduleAdjustment): boolean {
  if (!schedule || (schedule.company_id ?? schedule.companyId) !== expected.companyId
    || (schedule.automation_id ?? schedule.automationId) !== expected.automationId
    || schedule.kind !== expected.kind || (schedule.expression ?? null) !== expected.expression
    || schedule.timezone !== expected.timezone || schedule.enabled !== expected.enabled
    || Number(schedule.revision) !== expected.previousRevision + 1) return false;
  const next = "next_run_at" in schedule ? schedule.next_run_at : schedule.nextRunAt;
  return !expected.enabled || expected.kind === "manual" ? next === null
    : typeof next === "string" && Number.isFinite(Date.parse(next));
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
  if (kind === "creative-video" || kind === "Creative / Runway" || kind === "Runway広告動画生成") return "creative-video";
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
  return "";
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
  "creative-video": {
    kindLabel: "Creative / Runway",
    automationName: "Runway広告動画生成",
    approvalPolicy: "required_before_external_publish",
    steps: ["素材とブランド条件を確認", "動画プロンプトと尺を確認", "生成結果と利用権限を確認", "広告配信前に承認で停止", "承認後の公開Laneを割り当て", "生成物とreadbackを保存"],
    inputSources: "Runway MCP / 素材manifest / ブランドガイドライン / Project Memory",
    outputs: "動画生成下書き / 承認ログ / 生成物readback / Artifact",
    riskBoundary: "動画生成、広告公開、支払い、削除は承認まで実行しません。"
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
  return builderConfigs[type] ?? {
    kindLabel: "未確認",
    automationName: "未確認の自動化",
    approvalPolicy: "未確認",
    steps: ["保存済みautomation_typeを確認してから編集します"],
    inputSources: "API readback取得中",
    outputs: "未確認（保存しません）",
    riskBoundary: "未認識の自動化タイプは保存・承認・定期実行更新を行いません。"
  };
}

function isSupportedAutomationType(type: string) {
  return Object.prototype.hasOwnProperty.call(builderConfigs, type);
}

function registeredWorkflowSteps(spec: Record<string, any> | undefined): Array<{ title: string; enabled: boolean }> {
  if (!Array.isArray(spec?.stages)) return [];
  return spec.stages.flatMap((stage: unknown) => {
    if (!stage || typeof stage !== "object") return [];
    const value = stage as Record<string, unknown>;
    const title = [value.title, value.name, value.id].find((candidate) => typeof candidate === "string" && candidate.trim());
    return typeof title === "string" ? [{ title: title.trim(), enabled: value.enabled !== false }] : [];
  });
}

function registeredWorkflowBuilderConfig(automation: Record<string, any> | undefined, spec: Record<string, any> | undefined): BuilderConfig | null {
  // Only an existing, company-scoped API record gets this metadata editor.
  // Do not make /registered_workflow/edit a template or rewrite its runner spec.
  if (!automation?.id || automation.automation_type !== "registered_workflow") return null;
  return {
    kindLabel: "登録業務",
    automationName: String(automation.name ?? "登録業務"),
    approvalPolicy: String(automation.approval_policy ?? "未確認"),
    steps: registeredWorkflowSteps(spec).map((step) => step.title),
    inputSources: typeof spec?.canonicalWorkflowId === "string" ? `登録workflow: ${spec.canonicalWorkflowId}` : "登録runnerの入力契約（詳細はRunで確認）",
    outputs: "同じRunの実行結果・保存成果物・照合証拠",
    riskBoundary: "処理契約・接続先・承認ポリシーは登録値を保持します。名前・目的の編集だけでは処理内容は変わりません。予定の変更は別に保存します。"
  };
}

type ChatWorkflowOption = { automation_id: string; automation_revision: number; automation_version_id: string;
  workflow_id: string; name: string; scope: string; definition_sha256: string;
  can_run_once: boolean; can_save_draft: boolean; requires_approval: boolean; manual_blocker: string | null };
type ChatWorkflowResult = { binding_id: string; job_id: string; company_id: string; action: "run_once" | "save_draft";
  status: string; run_id?: string | null; run_status?: string | null; automation_id?: string | null; scope: string };
type ChatWorkflowReadback = { schema: string; job_id: string; company_id: string; options: ChatWorkflowOption[];
  actions: ChatWorkflowResult[]; exact_blocker: string | null };

async function requestChatWorkflowActions(companyId: string, jobId: string, signal?: AbortSignal): Promise<ChatWorkflowReadback> {
  const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/chat-jobs/${encodeURIComponent(jobId)}/workflow-actions`,
    { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true || body.schema !== "aos.chat_workflow_options.v1" || body.company_id !== companyId || body.job_id !== jobId
    || !Array.isArray(body.options) || !Array.isArray(body.actions)
    || body.options.some((option: ChatWorkflowOption) => !option || typeof option.automation_id !== "string"
      || !Number.isSafeInteger(option.automation_revision) || option.automation_revision < 1
      || !/^[a-f0-9]{64}$/.test(option.definition_sha256))
    || body.actions.some((action: ChatWorkflowResult) => action.company_id !== companyId || action.job_id !== jobId)) {
    throw new Error(body?.exact_blocker || "chat_workflow_readback_mismatch");
  }
  return body;
}

function fixedChatWorkflowConfirmed(readback: ChatWorkflowReadback | null, companyId: string, jobId?: string): boolean {
  return Boolean(readback && jobId && readback.company_id === companyId && readback.job_id === jobId
    && readback.schema === "aos.chat_workflow_options.v1" && !readback.exact_blocker && readback.options.length === 1
    && (readback.options[0].can_run_once || readback.actions.some((action) => action.action === "run_once")));
}

function ChatWorkflowActionsPanel({ model, companyId, jobId, onBusy, onReadback }: {
  model: AppModel; companyId: string; jobId: string; onBusy: (busy: boolean) => void; onReadback?: (value: ChatWorkflowReadback | null) => void;
}) {
  const [readback, setReadback] = useState<ChatWorkflowReadback | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readbackRequired, setReadbackRequired] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    onReadback?.(null);
    try {
      const next = await requestChatWorkflowActions(companyId, jobId, signal);
      if (!mounted.current || signal?.aborted) return;
      setReadback(next);
      onReadback?.(next);
      setReadbackRequired(false);
      setSelectedId((current) => next.options.some((option) => option.automation_id === current)
        ? current : next.options.length === 1 ? next.options[0].automation_id : "");
      setError("");
    } catch (cause) {
      if (mounted.current && !signal?.aborted) setError(publicBlockerSummary(cause instanceof Error ? cause.message : "chat_workflow_read_failed"));
    } finally { if (mounted.current && !signal?.aborted) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); onReadback?.(null); };
  }, [companyId, jobId]);
  const selected = readback?.options.find((option) => option.automation_id === selectedId);
  const perform = async (action: "run_once" | "save_draft") => {
    if (inFlight.current || loading || readbackRequired || !selected || model.mvpLoadStatus !== "ready"
      || readback?.company_id !== companyId || readback.job_id !== jobId
      || readback.actions.some((item) => item.action === action)
      || (action === "run_once" ? !selected.can_run_once : !selected.can_save_draft)) return;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/chat-jobs/${encodeURIComponent(jobId)}/workflow-actions`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": `chat-workflow-${jobId}-${action}` },
        body: JSON.stringify({ action, automation_id: selected.automation_id, expected_revision: selected.automation_revision,
          definition_sha256: selected.definition_sha256 })
      });
      const result = await response.json().catch(() => null) as (ChatWorkflowResult & { ok?: boolean; exact_blocker?: string }) | null;
      if (!response.ok || result?.ok !== true || result.company_id !== companyId || result.job_id !== jobId || result.action !== action) {
        throw new Error(result?.exact_blocker || "chat_workflow_action_result_unconfirmed");
      }
      if (!mounted.current) return;
      // Read the same saved action before displaying or navigating to a result.
      const confirmed = await requestChatWorkflowActions(companyId, jobId);
      const saved = confirmed.actions.find((item) => item.binding_id === result.binding_id && item.action === action);
      if (!saved || saved.run_id !== result.run_id || saved.automation_id !== result.automation_id) throw new Error("chat_workflow_action_readback_mismatch");
      if (!mounted.current) return;
      setReadback(confirmed);
      if (action === "run_once" && saved.run_id) {
        model.setReceipt(`会話の依頼を登録済み処理のRunへ結び付けました。run=${saved.run_id} / 受付は完了ではありません。結果はこのRunで確認します。`);
        go(`#/projects/${companyId}/runs/${saved.run_id}`);
      } else if (action === "save_draft" && saved.status === "draft_saved" && saved.automation_id) {
        const state = await readMvpState("ui", { fresh: true });
        if (!mounted.current) return;
        const persisted = state.automations?.find((automation: Record<string, any>) => automation.id === saved.automation_id && automation.company_id === companyId);
        if (!persisted || persisted.automation_type !== "registered_workflow") throw new Error("chat_workflow_draft_state_readback_mismatch");
        model.setMvpState(state);
        model.setAutomationRows(toAutomationRows(state.automations ?? []));
        model.setReceipt(`登録済み処理に接続した下書きを保存しました。automation=${saved.automation_id} / 実行・予定有効化はしていません。`);
        go(`#/projects/${companyId}/automations/${saved.automation_id}/edit`);
      }
    } catch (cause) {
      if (mounted.current) {
        setReadbackRequired(true);
        setError(`結果は未確認です: ${publicBlockerSummary(cause instanceof Error ? cause.message : "chat_workflow_action_failed")}。同じ依頼の結果を再取得してください。自動で再実行はしません。`);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
      onBusy(false);
    }
  };
  if (!loading && !error && readback && !readback.actions.length
    && ["chat_workflow_registered_target_not_identified", "chat_workflow_answer_only_no_execution_requested"].includes(readback.exact_blocker ?? "")) return null;
  return <section className="question-box" data-control-id="chat.workflow-actions" aria-label="登録済み処理への接続">
    <strong>登録済み処理で実行・保存</strong>
    <p>会話の提案とは別に、実行する固定処理と対象を確認します。仕様メモの変更だけでは処理は変わりません。</p>
    {loading && <p role="status">この会社・会話に使える登録処理と保存済みの結果を確認しています。</p>}
    {error && <p role="alert">{error}</p>}
    {readback?.exact_blocker && readback.exact_blocker !== "chat_workflow_answer_only_no_execution_requested" && <p>{publicBlockerSummary(readback.exact_blocker)}。この依頼をそのまま実行できる登録処理は確認できていません。</p>}
    {Boolean(readback?.options.length) && <>
      <label>実行対象の登録業務
        <select data-control-id="chat.workflow-target" aria-label="実行対象の登録業務" value={selectedId} disabled={busy || loading} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">対象を選んでください</option>
          {readback!.options.map((option) => <option key={option.automation_id} value={option.automation_id}>{option.name}</option>)}
        </select>
      </label>
      {selected && <p>{selected.scope}</p>}
      {selected?.requires_approval && selected.can_run_once && <p>既存Sheetを更新するため、実行前にこのRunの対象・内容・期限を承認画面で確認します。承認前は調査・同期を開始しません。予定の常時許可とは別です。</p>}
      {selected?.manual_blocker && <p>この業務のChatからの手動実行はまだ未接続です。登録済み予定の結果とは別です。</p>}
      <div className="button-row">
        {selected?.can_run_once && <Button controlId="chat.workflow-run" disabled={busy || loading || readbackRequired || readback!.actions.some((item) => item.action === "run_once")} onClick={() => { void perform("run_once"); }}>{selected.requires_approval ? "この処理の実行承認を準備" : "この処理を1回実行"}</Button>}
        {selected?.can_save_draft && <Button controlId="chat.workflow-save" disabled={busy || loading || readbackRequired || readback!.actions.some((item) => item.action === "save_draft")} onClick={() => { void perform("save_draft"); }}>実処理に接続した下書きを保存</Button>}
      </div>
    </>}
    {readback?.actions.map((item) => <p key={item.binding_id}>
      {item.status === "draft_saved" ? "下書き保存済み・予定なし" : item.status === "draft_archived" ? "下書きはアーカイブ済み" : item.run_id ? `Run受付済み（${item.run_status ?? "結果確認中"}）` : "依頼の紐付けは保存済み・実行結果は未確認"}
      {item.run_id && <> — <a data-control-id="chat.workflow-run-result" href={`#/projects/${companyId}/runs/${item.run_id}`}>同じRunの結果を開く</a></>}
      {item.action === "save_draft" && item.automation_id && <> — <a data-control-id="chat.workflow-draft-open" href={`#/projects/${companyId}/automations/${item.automation_id}/edit`}>保存した下書きを開く</a></>}
    </p>)}
    <Button controlId="chat.workflow-readback" disabled={busy || loading} onClick={() => { void load(); }}>同じ依頼の結果を再取得</Button>
  </section>;
}

async function requestChatPlan(
  prompt: string,
  selectedPlatforms: string[],
  options: { projectId?: string; sessionId?: string; messages?: ChatMessage[]; threadId?: string; signal?: AbortSignal; onJobId?: (jobId: string) => void; onProgress?: (progress: PlannerProgress) => void } = {}
): Promise<PlannerReadback> {
  const conversation = (options.messages?.length ? options.messages : [{ id: "current", role: "user" as const, text: prompt }])
    .map((message) => ({ role: message.role, text: message.text }));
  const response = await mvpFetch("/api/create/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      messages: conversation,
      currentDraft: prompt,
      project_id: options.projectId,
      session_id: options.sessionId,
      codex_thread_id: options.threadId
    })
  });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    error?: unknown;
    exactBlocker?: unknown;
    job?: PlannerJobReadback;
    worker_readback?: WorkerReadback | null;
  } | null;
  if (!response.ok || body?.ok !== true || !body.job?.id) {
    const exact = typeof body?.exactBlocker === "string"
      ? body.exactBlocker
      : typeof body?.error === "string"
        ? body.error
        : "planner_readback_unavailable";
    throw new Error(redactSensitiveText(exact).slice(0, 180) || "planner_readback_unavailable");
  }
  options.onJobId?.(body.job.id);
  let job = body.job;
  let workerReadback = body.worker_readback ?? null;
  options.onProgress?.(plannerProgressFromJob(body.job.id!, job, workerReadback));
  if (workerReadback?.status === "blocked" && workerReadback.exactBlocker) {
    throw new Error(workerReadback.exactBlocker);
  }
  for (let attempt = 0; attempt < 90 && job.status !== "completed" && job.status !== "blocked"; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    if (options.signal?.aborted) throw new Error("chat_request_aborted");
    const poll = await mvpFetch(`/api/create/plan/jobs/${encodeURIComponent(body.job.id)}`, { cache: "no-store", signal: options.signal });
    const pollBody = await poll.json().catch(() => null) as { ok?: boolean; job?: PlannerJobReadback; worker_readback?: WorkerReadback | null } | null;
    if (!poll.ok || pollBody?.ok !== true || !pollBody.job) throw new Error("planner_job_readback_unavailable");
    job = pollBody.job;
    workerReadback = pollBody.worker_readback ?? null;
    options.onProgress?.(plannerProgressFromJob(body.job.id!, job, workerReadback));
    if (workerReadback?.status === "blocked" && workerReadback.exactBlocker) {
      throw new Error(workerReadback.exactBlocker);
    }
  }
  return plannerReadbackFromJob(job, prompt, selectedPlatforms, options.projectId);
}

function plannerReadbackFromJob(job: PlannerJobReadback, prompt: string, selectedPlatforms: string[], projectId?: string): PlannerReadback {
  if (!job.id || job.status !== "completed" || !job.result || typeof job.result.title !== "string") {
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
    planner_mode: serverPlan.operation === "answer_question" && questions.length === 0 ? "answer_only" : serverPlan.executionDecision ?? "server_readback",
    planner_model_ref: serverPlan.model ?? null,
    planner_schema_version: "create-plan-v1",
    planner_operation: serverPlan.operation ?? "answer_question",
    // Keep the planner readback bound to the same project that was sent to the
    // server. Falling back to session storage is only for legacy callers that
    // do not provide an explicit project scope.
    project_id: projectId?.trim() || projectSlugFromPrompt(prompt),
    automation_type: explicitAutomationType ?? "answer-only",
    plan: {
      ...productDefaults,
      ...schedulePreferencesFromPrompt(prompt),
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
    creation_blocker: canCreate || (serverPlan.operation === "answer_question" && questions.length === 0) ? null : questions.length
      ? "確認事項への回答が必要です"
      : serverPlan.operation !== "create_automation"
        ? "新規自動化の作成依頼として確認できませんでした"
      : explicitAutomationType === null
        ? "自動化の種類を明記してください"
        : "実行可能な自動化プランとして確認できませんでした",
    server_reply: serverPlan.reply?.trim() || serverPlan.nextAction?.trim() || "プランを確認しました。",
    chat_job_id: job.id,
    chat_thread_id: typeof job.metadata?.codexThreadId === "string" ? job.metadata.codexThreadId : null,
    chat_turn_id: typeof job.metadata?.codexTurnId === "string" ? job.metadata.codexTurnId : null,
    chat_status: job.status,
    chat_stream_text_length: typeof job.metadata?.streamTextLength === "number" ? job.metadata.streamTextLength : 0,
    chat_events: plannerProgressFromJob(job.id, job).events,
    tool_preference: job.metadata?.toolPreference && typeof job.metadata.toolPreference === "object"
      ? job.metadata.toolPreference as ToolPreferenceReadback
      : null,
    proposed_changes: Array.isArray(serverPlan.proposedChanges) ? serverPlan.proposedChanges : [],
    requires_confirmation: Array.isArray(serverPlan.requiresConfirmation) ? serverPlan.requiresConfirmation : [],
    web_operation_intake: serverPlan.webOperationIntake
  };
}

async function requestSavedChatPlan(thread: ChatThreadReadback, projectId: string, signal?: AbortSignal): Promise<PlannerReadback> {
  if (!projectId || !thread.companyIds.includes(projectId) || !thread.latestJobId) throw new Error("chat_history_scope_mismatch");
  const response = await mvpFetch(`/api/create/plan/jobs/${encodeURIComponent(thread.latestJobId)}`, { cache: "no-store", signal });
  const body = await response.json().catch(() => null) as { ok?: boolean; job?: PlannerJobReadback } | null;
  const job = body?.job;
  if (!response.ok || !body?.ok || !job || job.id !== thread.latestJobId || job.metadata?.codexThreadId !== thread.threadId) {
    throw new Error("chat_history_plan_readback_mismatch");
  }
  const prompt = [...thread.messages].reverse().find((message) => message.role === "user")?.text ?? "";
  // Read the persisted result only. Resuming never queues another model turn
  // or creates an automation, and the normal result mapper keeps save gates.
  return plannerReadbackFromJob(job, prompt, [], projectId);
}

async function storeChatSecrets(rawText: string, projectId?: string): Promise<{ sanitizedText: string; storedCount: number; runnerPendingCount: number }> {
  const fallback = redactSensitiveText(rawText);
  if (!projectId) return { sanitizedText: fallback, storedCount: 0, runnerPendingCount: 0 };
  const response = await mvpFetch("/api/secrets/from-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, text: rawText })
  });
  const body = await response.json().catch(() => ({})) as {
    sanitizedText?: unknown;
    stored?: Array<{ availableToRunner?: unknown }>;
    exactBlocker?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    const blocker = typeof body.exactBlocker === "string" ? body.exactBlocker : typeof body.error === "string" ? body.error : `secret_storage_http_${response.status}`;
    throw new Error(blocker);
  }
  return {
    sanitizedText: typeof body.sanitizedText === "string" ? body.sanitizedText : fallback,
    storedCount: Array.isArray(body.stored) ? body.stored.length : 0,
    runnerPendingCount: Array.isArray(body.stored)
      ? body.stored.filter((item) => item?.availableToRunner === false).length
      : 0
  };
}

function secretRunnerNote(readback: { runnerPendingCount: number }): string {
  return readback.runnerPendingCount > 0
    ? ` / Mac worker readback未確定=${readback.runnerPendingCount}件`
    : "";
}

async function requestChatThreads(projectId: string): Promise<ChatThreadReadback[]> {
  if (!projectId) return [];
  const response = await mvpFetch(`/api/create/chat/threads?project_id=${encodeURIComponent(projectId)}&limit=20`, { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; threads?: ChatThreadReadback[]; exactBlocker?: string };
  if (!response.ok || body.ok !== true) throw new Error(body.exactBlocker || `chat_threads_http_${response.status}`);
  return Array.isArray(body.threads) ? body.threads : [];
}

async function requestChatSessions(projectId: string): Promise<ChatSessionReadback[]> {
  if (!projectId) return [];
  const response = await mvpFetch(`/api/create/chat/sessions?project_id=${encodeURIComponent(projectId)}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; sessions?: ChatSessionReadback[]; exactBlocker?: string; error?: string };
  if (!response.ok || body.ok !== true) throw new Error(body.exactBlocker || body.error || `chat_sessions_http_${response.status}`);
  return Array.isArray(body.sessions) ? body.sessions : [];
}

async function createChatSession(projectId: string, name: string): Promise<ChatSessionReadback> {
  const response = await mvpFetch("/api/create/chat/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, name })
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; session?: ChatSessionReadback; exactBlocker?: string; error?: string };
  if (!response.ok || body.ok !== true || !body.session) throw new Error(body.exactBlocker || body.error || `chat_session_create_http_${response.status}`);
  return body.session;
}

async function activateChatSession(projectId: string, sessionId: string): Promise<ChatSessionReadback> {
  const response = await mvpFetch(`/api/create/chat/sessions/${encodeURIComponent(sessionId)}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId })
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; session?: ChatSessionReadback; exactBlocker?: string; error?: string };
  if (!response.ok || body.ok !== true || !body.session) throw new Error(body.exactBlocker || body.error || `chat_session_activate_http_${response.status}`);
  return body.session;
}

async function cancelChatPlannerJob(jobId: string): Promise<PlannerJobReadback> {
  const response = await mvpFetch(`/api/create/plan/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; job?: PlannerJobReadback; exactBlocker?: string; error?: string };
  if (!response.ok || body.ok !== true || !body.job) {
    throw new Error(body.exactBlocker || body.error || `chat_job_cancel_http_${response.status}`);
  }
  return body.job;
}

type PlannerJobReadback = {
  id?: string;
  status?: string;
  result?: ServerPlannerResult;
  exactBlocker?: string;
  metadata?: Record<string, unknown>;
};

function plannerProgressFromJob(jobId: string, job: PlannerJobReadback, workerReadback?: WorkerReadback | null): PlannerProgress {
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
    streamTextLength: typeof job.metadata?.streamTextLength === "number" ? job.metadata.streamTextLength : 0,
    events,
    workerStatus: typeof workerReadback?.status === "string" ? workerReadback.status : undefined,
    workerBlocker: typeof workerReadback?.exactBlocker === "string" ? workerReadback.exactBlocker : undefined,
    workerNextAction: typeof workerReadback?.nextAction === "string" ? workerReadback.nextAction : undefined
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
    <div className="chat-progress" data-control-id="chat.progress.panel" role="region" aria-live="off" aria-label={`Chat処理進捗。状態=${plannerProgressLabel(status)}${progress?.jobId ? ` / job=${progress.jobId}` : ""}${progress?.threadId ? ` / thread=${progress.threadId}` : ""}`}>
      <div className="chat-progress-heading">
        <strong>{plannerProgressLabel(status)}</strong>
        {progress?.jobId && <span className="muted">job: {progress.jobId}</span>}
      </div>
      <p className="muted">{progress?.threadId ? `thread: ${progress.threadId}` : "threadを割り当て中"}{progress?.turnId ? ` / turn: ${progress.turnId}` : ""}</p>
      {progress?.events.length ? (
        <div className="chat-progress-events">
          {progress.events.slice(-5).map((event, index) => <span key={`${event.method}-${event.capturedAt ?? index}`}>{plannerEventLabel(event.method)}</span>)}
        </div>
      ) : <p className="muted">workerのfresh進捗readbackを取得します。</p>}
      {progress?.streamTextLength ? <details><summary>受信進捗（内部JSONは表示しません）</summary><p className="muted">Codexから {progress.streamTextLength.toLocaleString("ja-JP")} 文字を受信しました。</p></details> : null}
      {progress?.workerBlocker && <p className="muted">Mac worker: {publicBlockerSummary(progress.workerBlocker)}{progress.workerNextAction ? ` / 次: ${progress.workerNextAction}` : ""}</p>}
      {!planning && status === "completed" && <p className="muted">回答・計画の受信が完了しました。外部操作は実行していません。</p>}
    </div>
  );
}

function toAutomationRows(items: any[]): AutomationRow[] {
  return items.map((item) => ({
    id: String(item.id),
    project_id: String(item.project_id ?? item.company_id ?? "未確認"),
    company_id: typeof item.company_id === "string" ? item.company_id : undefined,
    // The start guide must correlate saved company-scoped records by their
    // immutable canonical workflow ID. Keep the nested adoption spec in this
    // bounded row projection instead of manufacturing a name-only conflict.
    builder_spec: item.builder_spec && typeof item.builder_spec === "object" && !Array.isArray(item.builder_spec)
      ? item.builder_spec as Record<string, unknown>
      : undefined,
    execution_target: item.execution_target && typeof item.execution_target === "object" && !Array.isArray(item.execution_target)
      ? item.execution_target as Record<string, unknown>
      : undefined,
    exact_blocker: typeof item.exact_blocker === "string" ? item.exact_blocker : undefined,
    latest_proof: item.latest_proof && typeof item.latest_proof === "object" && !Array.isArray(item.latest_proof)
      ? item.latest_proof as Record<string, unknown>
      : undefined,
    revision: Number(item.revision ?? 1),
    automation_type: String(item.automation_type ?? item.id ?? "sns-post"),
    name: String(item.name),
    desc: String(item.desc ?? item.goal ?? ""),
    schedule: String(item.schedule ?? "未設定"),
    schedule_version: String(item.pinned_schedule_version_id ?? "未固定"),
    next_run_at: String(item.next_run_at ?? "未計算"),
    lane: String(item.lane ?? "Lane 1"),
    last: String(item.last_run_at ?? item.last ?? "未実行"),
    execution_mode: (["control_plane_dry_run", "registered_workflow_readback", "portable_mac_worker_queue"].includes(item.execution_mode) ? item.execution_mode : "unverified") as AutomationRow["execution_mode"],
    execution_label: String(item.execution_label ?? "実行契約未確認（保存のみ）"),
    scheduler_effect: String(item.scheduler_effect ?? "not_configured"),
    status: (item.status === "active" ? "enabled" : item.status === "paused" ? "disabled" : ["running", "waiting", "approved", "blocked", "enabled", "disabled", "draft"].includes(item.status) ? item.status : "draft") as Status
  }));
}

function displayedAutomationLane(lane: unknown, backend: unknown): string {
  const persistedLane = String(lane ?? "Lane 1");
  if (!["browser_use_cli", "chrome_plugin", "playwright"].includes(persistedLane)) return persistedLane;
  const selectedBackend = String(backend ?? "chrome_plugin");
  return ["chrome_plugin", "browser_use_cli", "playwright"].includes(selectedBackend)
    ? selectedBackend
    : persistedLane;
}

// Screen-level refreshes use the bounded list projection.  Run detail pages
// read their complete receipt through the company-scoped Run detail endpoint, so the UI does not need
// to re-transfer every historical metadata blob on every navigation or
// retry.  The full MVP projection remains available to explicit API callers.
async function readMvpState(projection: "full" | "ui" | "summary" | "chat" = "ui", options: { fresh?: boolean; companyId?: string; origin?: string; signal?: AbortSignal } = { fresh: true }) {
  const query = new URLSearchParams();
  if (projection !== "full") query.set("projection", projection);
  if (options.fresh) query.set("fresh", "1");
  if (options.companyId) query.set("company_id", options.companyId);
  if (mvpDiagnosticsEnabled()) {
    query.set("diagnostics", "1");
    query.set("read_origin", options.origin ?? "mvp_state_reader");
    query.set("read_id", mvpReadId());
  }
  const queryString = query.toString();
  const response = await mvpFetch(`/api/mvp/state${queryString ? `?${queryString}` : ""}`, { cache: "no-store", signal: options.signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const blocker = body && typeof body === "object" && typeof body.exactBlocker === "string"
      ? body.exactBlocker
      : null;
    if (!blocker) throw new Error(`mvp_state_http_${response.status}`);
    const error = new Error(`mvp_state_http_${response.status}`) as Error & { exactBlocker?: string };
    error.exactBlocker = blocker ?? undefined;
    throw error;
  }
  return body;
}

function mvpStateErrorBlocker(error: unknown): string | null {
  if (error && typeof error === "object" && typeof (error as { exactBlocker?: unknown }).exactBlocker === "string") {
    return String((error as { exactBlocker: string }).exactBlocker);
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message === "mvp_state_request_timeout" || message === "mvp_state_summary_readback_timeout" || message === "mvp_state_detail_readback_timeout") return message;
  // Scope/projection assertions are client-side readback gates. Preserve the
  // exact blocker so a valid, company-scoped summary can remain visible in
  // read-only degraded mode instead of falling through to an unscoped empty
  // page. Mutating controls remain fail-closed until the detail projection is
  // fresh and exact.
  if (message === "mvp_state_company_scope_mismatch" || message.startsWith("mvp_state_projection_mismatch:")) return message;
  const match = message.match(/^mvp_state_http_\d+:(.+)$/u);
  return match?.[1] ?? null;
}

const PROTECTED_AUTH_BLOCKERS = new Set([
  "owner_sso_required",
  "owner_sso_required_on_fresh_task_owned_ingress_session",
  "private_ingress_or_sso_required",
  "server_auth_session_secret_missing"
]);

function getProtectedAuthBlocker(error: unknown): string | null {
  const exactBlocker = mvpStateErrorBlocker(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (exactBlocker && PROTECTED_AUTH_BLOCKERS.has(exactBlocker)) return exactBlocker;
  return PROTECTED_AUTH_BLOCKERS.has(message) ? message : null;
}

function isSummaryDegradedMvpBlocker(blocker: string | null): boolean {
  return blocker === "mvp_state_postgres_read_timeout"
    || blocker === "mvp_state_summary_readback_timeout"
    || blocker === "mvp_state_detail_readback_timeout"
    || blocker === "mvp_state_company_scope_mismatch"
    || blocker?.startsWith("mvp_state_projection_mismatch:") === true;
}

function isRetryableMvpStateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch|NetworkError|Load failed|mvp_state_request_timeout|mvp_state_http_(?:408|429|500|502|503|504)/i.test(message);
}

const MVP_SUMMARY_READBACK_TIMEOUT_MS = 12_000;
const MVP_DETAIL_READBACK_TIMEOUT_MS = 20_000;
const HOME_BRIEF_READBACK_TIMEOUT_MS = 8_000;

function withMvpDetailReadbackTimeout<T>(promise: Promise<T>, timeoutMs = MVP_DETAIL_READBACK_TIMEOUT_MS, blocker = "mvp_state_detail_readback_timeout"): Promise<T> {
  let timer: number | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error(blocker) as Error & { exactBlocker?: string };
      error.exactBlocker = blocker;
      reject(error);
    }, timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer !== undefined) window.clearTimeout(timer);
    });
  });
}

async function readMvpStateWithRetry(projection: "full" | "ui" | "summary" | "chat" = "ui", options: { fresh?: boolean; companyId?: string; origin?: string; signal?: AbortSignal } = { fresh: true }) {
  let lastError: unknown = null;
  // A freshly restarted production API can briefly reject a protected read
  // while auth/session and the control-plane snapshot settle. Keep this
  // bounded and read-only; never retry a mutation endpoint here.
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await readMvpState(projection, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === maxAttempts - 1 || !isRetryableMvpStateError(error)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 900 : 1800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("mvp_state_readback_failed");
}

function assertMvpStateReadbackScope(state: MvpState, projection: "full" | "ui" | "summary" | "chat", companyId?: string): MvpState {
  if (companyId) {
    const scope = state.company_scope;
    if (scope?.enforced !== true || !Array.isArray(scope.company_ids) || scope.company_ids.length !== 1 || scope.company_ids[0] !== companyId) {
      throw new Error("mvp_state_company_scope_mismatch");
    }
  }
  if (projection !== "full" && state.readback_projection !== projection) {
    throw new Error(`mvp_state_projection_mismatch:${projection}`);
  }
  return state;
}

async function bootstrapAuthSession(signal?: AbortSignal): Promise<ApiTokenScope> {
  const response = await mvpFetch("/api/auth/session", { cache: "no-store", signal });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; scope?: string; exactBlocker?: string };
  if (!response.ok || body.ok !== true) throw new Error(body.exactBlocker || `auth_session_http_${response.status}`);
  if (body.scope === "read" || body.scope === "write" || body.scope === "unrestricted") return body.scope;
  return "unknown";
}

async function readApiTokenCapability(): Promise<ApiTokenScope> {
  const response = await mvpFetch("/api/auth/capability", { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; scope?: string; exactBlocker?: string };
  if (!response.ok || body.ok !== true) throw new Error(body.exactBlocker || `api_capability_http_${response.status}`);
  if (body.scope === "read" || body.scope === "write" || body.scope === "unrestricted") return body.scope;
  return "unknown";
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

async function fetchApiJson<T>(url: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  const response = await mvpFetch(url, { cache: "no-store", ...options });
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
  const width = window.innerWidth || 1200;
  const height = window.innerHeight || 900;
  const scale = Math.min(1, 1200 / width, 900 / height);
  try {
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(document.body, {
      backgroundColor: "#ffffff",
      width,
      height,
      scale,
      x: window.scrollX,
      y: window.scrollY,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      imageTimeout: 2500,
      logging: false,
      ignoreElements: (element) => element.classList.contains("feedback-launcher") || element.classList.contains("feedback-panel")
    });
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.62), error: null };
  } catch {
    return { dataUrl: null, error: "feedback_screenshot_render_failed" };
  }
}

async function captureAppScreenshotWithTimeout(timeoutMs = 15000): Promise<{ dataUrl: string | null; error: string | null }> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      captureAppScreenshot(),
      new Promise<{ dataUrl: string | null; error: string | null }>((resolve) => {
        timer = window.setTimeout(() => resolve({ dataUrl: null, error: "feedback_screenshot_timeout" }), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function approvalDueLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "期限未設定（承認前に確認）";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "期限未確認（承認前に確認）";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date) + " JST";
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

type ChatRouteContext = {
  companyId: string;
  projectId: string;
  context: string;
  runId: string;
  scheduleId: string;
  automationId: string;
};

function routePath(route: string) {
  const hash = route.startsWith("#") ? route : `#${route}`;
  const queryIndex = hash.indexOf("?");
  return queryIndex >= 0 ? hash.slice(0, queryIndex) : hash;
}

function safeRouteValue(value: string | null, maxLength = 120) {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : "";
}

function safeProjectId(value: string | null) {
  const normalized = safeRouteValue(value, 120);
  return normalized && /^[a-z0-9][a-z0-9_-]*$/i.test(normalized) ? normalized : "";
}

function chatRouteContext(route: string): ChatRouteContext {
  const query = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query);
  const companyId = safeProjectId(params.get("company"));
  const projectId = safeProjectId(params.get("project"));
  return {
    companyId: companyId || projectId,
    projectId: projectId || companyId,
    context: safeRouteValue(params.get("context"), 80),
    runId: safeRouteValue(params.get("run") || params.get("run_id")),
    scheduleId: safeRouteValue(params.get("schedule") || params.get("schedule_id")),
    automationId: safeRouteValue(params.get("automation") || params.get("automation_id"))
  };
}

function chatHref({ companyId, projectId, context, runId, scheduleId, automationId }: Partial<ChatRouteContext> = {}) {
  const params = new URLSearchParams();
  const scopedProjectId = safeProjectId(companyId ?? null) || safeProjectId(projectId ?? null);
  if (scopedProjectId) {
    params.set("company", scopedProjectId);
    params.set("project", scopedProjectId);
  }
  const values: Array<[string, string | undefined]> = [
    ["context", context],
    ["run", runId],
    ["schedule", scheduleId],
    ["automation", automationId]
  ];
  values.forEach(([key, value]) => {
    const normalized = safeRouteValue(value ?? null);
    if (normalized) params.set(key, normalized);
  });
  const query = params.toString();
  return `#/chat${query ? `?${query}` : ""}`;
}

const COMMON_WEB_OPERATION_PROMPT_TEMPLATE = [
  "目的: read / create / update / publish / submit / delete のどれか",
  "サイトまたはURL:",
  "会社とアカウント:",
  "対象（意味で指定。例: 公開、保存、応募、削除）:",
  "内容（本文・画像・ファイル・応募内容など）:",
  "公開先・送信先・対象範囲:",
].join("\n");

function projectSlugFromRoute(route: string) {
  return routePath(route).match(/\/projects\/([^/]+)/)?.[1] ?? "";
}

function automationIdFromRoute(route: string) {
  const match = route.match(/\/automations\/([^/]+)\/edit/);
  return match ? decodeURIComponent(match[1]) : "sns-post";
}

function rememberProject(slug: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem("automation-os-active-project", slug);
  // Company scope is not a secret. Keep it across AOS tabs so opening the
  // authentication surface in a fresh tab does not silently fall back to an
  // unscoped "pending / unverified" projection.
  window.localStorage.setItem("automation-os-active-project", slug);
}

function rememberedProject() {
  if (typeof window === "undefined") return "";
  const saved = window.sessionStorage.getItem("automation-os-active-project")
    ?? window.localStorage.getItem("automation-os-active-project");
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
  go(chatHref({ companyId: projectId, context: "automation-create" }));
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

function reactNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join(" ");
  if (React.isValidElement(node)) return reactNodeText((node.props as { children?: React.ReactNode }).children);
  return "";
}

function Button({ children, icon, variant = "secondary", onClick, disabled = false, controlId, type = "button", ariaLabel }: { children: React.ReactNode; icon?: React.ReactNode; variant?: "primary" | "secondary" | "danger"; onClick?: () => void; disabled?: boolean; controlId?: string; type?: "button" | "submit"; ariaLabel?: string }) {
  const explicitLabel = ariaLabel?.trim() || reactNodeText(children).trim() || undefined;
  return <button type={type} data-control-id={controlId} className={`btn ${variant}`} aria-label={explicitLabel} title={explicitLabel} onClick={onClick} disabled={disabled}>{icon}{children}</button>;
}

function IconButton({ children, onClick, label, controlId, disabled = false }: { children: React.ReactNode; onClick?: () => void; label: string; controlId?: string; disabled?: boolean }) {
  return <button type="button" data-control-id={controlId} className="icon-btn" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function App() {
  const route = useRoute();
  const routeScopedCompanyId = safeProjectId(projectSlugFromRoute(route)) || undefined;
  const [receipt, setReceiptValue] = useState("Local Agent は状態確認を開始しました。");
  const [receiptAt, setReceiptAt] = useState(() => Date.now());
  const [receiptRoute, setReceiptRoute] = useState(() => location.hash || "#/");
  const setReceipt = (value: string) => {
    setReceiptValue(value);
    setReceiptAt(Date.now());
    setReceiptRoute(route);
  };
  const [automationRows, setAutomationRows] = useState<AutomationRow[]>([]);
  const [createdTemplates, setCreatedTemplates] = useState<string[]>([]);
  const [mvpState, setMvpState] = useState<MvpState>({});
  const [mvpLoadStatus, setMvpLoadStatus] = useState<MvpLoadStatus>("loading");
  const [mvpLoadBlocker, setMvpLoadBlocker] = useState<string | null>(null);
  const [mvpSyncing, setMvpSyncing] = useState(false);
  const [feedbackReadback, setFeedbackReadback] = useState<MvpState["feedbacks"]>([]);
  const [feedbackReadStatus, setFeedbackReadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [apiAccessRequired, setApiAccessRequired] = useState(false);
  const [apiTokenScope, setApiTokenScope] = useState<ApiTokenScope>("unknown");
  const [accessChecking, setAccessChecking] = useState(false);
  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const routeName = routePath(route);
    // Project routes already carry the canonical company scope. Reuse it for
    // both the summary fallback and the authenticated detail readback so a
    // company page does not fetch every visible company's dashboard rows and
    // metadata before it can render. The server still enforces membership for
    // the requested company; an invalid/empty route remains unscoped.
    const scopedCompanyId = routeScopedCompanyId;
    const projection = routeName === "#/"
      ? "summary"
      : routeName === "#/chat" ? "chat" : "ui";
    let detailReady = projection === "summary";
    setMvpLoadStatus("loading");
    const authPromise = bootstrapAuthSession(controller.signal)
      .then((scope) => {
        if (!cancelled) setApiTokenScope(scope);
        return { ok: true as const, scope };
      })
      .catch((error) => ({ ok: false as const, error }));
    const readSummaryProjection = () => withMvpDetailReadbackTimeout(
      readMvpStateWithRetry("summary", { fresh: true, companyId: scopedCompanyId, origin: "route_summary", signal: controller.signal })
        .then((state) => assertMvpStateReadbackScope(state, "summary", scopedCompanyId)),
      MVP_SUMMARY_READBACK_TIMEOUT_MS,
      "mvp_state_summary_readback_timeout",
    );
    const readDetailProjection = () => withMvpDetailReadbackTimeout(
      readMvpStateWithRetry(projection, { fresh: true, companyId: scopedCompanyId, origin: "route_detail", signal: controller.signal })
        .then((state) => assertMvpStateReadbackScope(state, projection, scopedCompanyId)),
    );
    const readDetailState = async () => {
      // Establish the same-origin HttpOnly session before the first protected
      // detail request. Starting both requests together creates a predictable
      // 401 -> retry race on a cold page and leaves the UI in
      // mvp_state_readback_pending longer than necessary.
      const auth = await authPromise;
      if (!auth.ok) {
        throw auth.error instanceof Error ? auth.error : new Error("auth_session_unavailable");
      }
      return readDetailProjection();
    };
    let summaryStateForFallback: MvpState | null = null;
    const statePromise = projection === "summary"
      ? readSummaryProjection()
        : readSummaryProjection()
        .then((summaryState) => {
          summaryStateForFallback = summaryState;
          if (!cancelled && !detailReady) {
            // Make the summary projection usable immediately while the
            // authenticated detail projection continues in the background.
            // Mutating controls remain fail-closed until the detail proof is
            // ready, but navigation and read-only inspection do not stall.
            setMvpState(summaryState);
            setMvpLoadStatus("degraded");
            setMvpLoadBlocker("mvp_state_detail_readback_pending");
            setAutomationRows(toAutomationRows(summaryState.automations ?? []));
            setFeedbackReadback(summaryState.feedbacks ?? []);
            setReceipt("MVP summary readback 済みです。詳細readbackはバックグラウンドで再試行中です。外部効果は開始しません。");
          }
          return readDetailState();
        })
        .catch((error) => controller.signal.aborted ? Promise.reject(error) : readDetailState());
    statePromise
      .then((state) => {
        if (cancelled) return;
        detailReady = true;
        setMvpState(state);
        setMvpLoadStatus("ready");
        setMvpLoadBlocker(null);
        setAutomationRows(toAutomationRows(state.automations ?? []));
        setFeedbackReadback(state.feedbacks ?? []);
        const worker = state.worker?.status ? `worker=${state.worker.status}` : "worker=unknown";
        const runCount = state.sync_readback?.runs_count ?? state.run_summary?.total_count ?? state.runs?.length ?? 0;
        setReceipt(`MVP ${projection} readback 済みです。${worker} / runs=${runCount}`);
      })
      .catch((error) => {
        if (cancelled) return;
        const blocker = mvpStateErrorBlocker(error);
        const protectedAuthBlocker = getProtectedAuthBlocker(error);
        if (summaryStateForFallback && isSummaryDegradedMvpBlocker(blocker) && projectOptionsFromState(summaryStateForFallback).length > 0) {
          setMvpState(summaryStateForFallback);
          setMvpLoadStatus("degraded");
          setMvpLoadBlocker(blocker);
          setAutomationRows(toAutomationRows(summaryStateForFallback.automations ?? []));
          setFeedbackReadback(summaryStateForFallback.feedbacks ?? []);
          setReceipt("MVP summaryを表示中です。詳細readback未確定 / 保存・送信・定期実行変更なし。");
          return;
        }
        setMvpLoadStatus("error");
        setMvpLoadBlocker(blocker ?? protectedAuthBlocker);
        const message = error instanceof Error ? error.message : "";
        if (/^(?:auth_session|mvp_state)_http_(?:401|423)$/.test(message) || protectedAuthBlocker) {
          setApiAccessRequired(true);
          setReceipt(protectedAuthBlocker
            ? `安全な管理セッションを確立できません。${publicBlockerSummary(protectedAuthBlocker)}`
            : "安全な管理セッションを確立できません。private ingressまたはSSOの設定を確認してください。");
          return;
        }
        setReceipt("Local Agent はローカル表示を維持中です。MVP APIのblockerを確認してください。");
      });
    return () => { cancelled = true; controller.abort(); };
  }, [route, routeScopedCompanyId]);
  React.useEffect(() => {
    if (mvpLoadStatus !== "ready") return;
    let cancelled = false;
    setFeedbackReadStatus("loading");
    mvpFetch("/api/mvp/feedback", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (cancelled) return;
        // The authentication gate owns the unauthenticated/locked state. Do not
        // let this secondary readback replace its actionable guidance.
        if (response.status === 401 || response.status === 423) { setFeedbackReadStatus("error"); return; }
        if (!response.ok || json.ok === false) throw new Error("feedback_readback_failed");
        setFeedbackReadback(Array.isArray(json.feedbacks) ? json.feedbacks : []);
        setFeedbackReadStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setFeedbackReadStatus("error");
        setReceipt("Feedback readbackに失敗しました。空のキューとは断定せず、直前の表示を維持します。");
      });
    return () => { cancelled = true; };
  }, [mvpLoadStatus, route]);
  const page = useMemo(() => renderPage(route, {
    setReceipt,
    automationRows,
    setAutomationRows,
    createdTemplates,
    setCreatedTemplates,
    mvpState,
    setMvpState,
    mvpLoadStatus,
    mvpLoadBlocker,
    feedbackReadback,
    feedbackReadStatus,
    setFeedbackReadback
  }), [route, automationRows, createdTemplates, mvpState, mvpLoadStatus, mvpLoadBlocker, feedbackReadback, feedbackReadStatus]);

  const retryAuthSession = async () => {
    setAccessChecking(true);
    try {
      const scope = await bootstrapAuthSession();
      const state = await readMvpStateWithRetry("ui", { fresh: true, companyId: routeScopedCompanyId, origin: "auth_retry" });
      setApiTokenScope(scope);
      setMvpState(state);
      setMvpLoadStatus("ready");
      setMvpLoadBlocker(null);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setFeedbackReadback(state.feedbacks ?? []);
      setApiAccessRequired(false);
      setReceipt(scope === "read"
        ? "読み取り専用の安全な管理セッションを確認しました。"
        : "安全な管理セッションを確認しました。Automation OSを利用できます。");
    } catch (error) {
      const blocker = mvpStateErrorBlocker(error);
      const protectedAuthBlocker = getProtectedAuthBlocker(error);
      setMvpLoadBlocker(blocker ?? protectedAuthBlocker);
      const message = error instanceof Error ? error.message : "";
      if (/auth_session_http_(?:401|423)|mvp_state_http_(?:401|423)/.test(message) || protectedAuthBlocker) {
        setReceipt(protectedAuthBlocker
          ? `安全な管理セッションを確立できません。${publicBlockerSummary(protectedAuthBlocker)}`
          : "安全な管理セッションを確立できません。private ingressまたはSSOの設定後に再確認してください。");
      } else {
        setReceipt("認証状態のreadbackに失敗しました。表示中の値は最新と断定できません。");
      }
    } finally {
      setAccessChecking(false);
    }
  };

  const syncState = async () => {
    const hadReadyState = mvpLoadStatus === "ready";
    setMvpSyncing(true);
    if (!hadReadyState) setMvpLoadStatus("loading");
    setReceipt("最新状態を同期しています。");
    try {
      const readGlobalState = async () => {
        const state = await readMvpStateWithRetry();
        return state;
      };
      const state = routeScopedCompanyId
        ? await readMvpStateWithRetry("ui", { fresh: true, companyId: routeScopedCompanyId, origin: "manual_sync" })
        : await readGlobalState();
      setMvpState(state);
      setMvpLoadStatus("ready");
      setMvpLoadBlocker(null);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setFeedbackReadback(state.feedbacks ?? []);
      const sync = state.sync_readback;
      const scope = sync?.company_ids?.join(",") || "スコープ未取得";
      const automationCount = sync?.automation_count ?? "未取得";
      const registeredCount = sync?.registered_workflow_count ?? "未取得";
      const runCount = sync?.runs_count ?? state.runs?.length ?? "未取得";
      const capturedAt = sync?.captured_at ?? state.updated_at ?? "取得時刻未取得";
      setReceipt(`同期しました。scope=${scope} / company automations=${automationCount} / registered workflows=${registeredCount} / runs=${runCount} / ${capturedAt}`);
    } catch (error) {
      if (!hadReadyState) setMvpLoadStatus("error");
      setMvpLoadBlocker(mvpStateErrorBlocker(error));
      setReceipt("同期に失敗しました。表示中の値は最新と断定できません。");
    } finally {
      setMvpSyncing(false);
    }
  };

  if (apiAccessRequired) {
    const ownerSsoLoginUrl = "https://aos-admin-ingress.zeabur.app/auth/login?return_to=%2F";
    return (
      <main className="main">
        <section>
          <PageTitle title="Automation OS" desc="この画面はprivate ingress / SSOで保護されています。" />
          <Panel title="安全な管理セッション" controlId="shell.auth-session.panel">
            <p className="muted">APIキーはブラウザへ入力しません。サーバーがSecret StoreまたはKeychainから認証情報を取得し、private ingress / SSOで確認できた場合だけHttpOnly・Secure cookieを発行します。cookieやtokenはブラウザ保存領域・URL・録画・artifactへ入りません。</p>
            <ol className="auth-steps">
              <li>「Google認証を開始」を押し、許可アカウント <code>nichika2000823@gmail.com</code> で本人が認証します。</li>
              <li>認証後にこの画面へ戻ったら、「認証状態を再確認」を押します。</li>
              <li>「書き込み許可」と会社1が表示されるまで、保存・承認・実行は行いません。</li>
            </ol>
            <div className="button-row">
              <a className="btn primary" data-control-id="shell.auth-session.open-owner-sso" href={ownerSsoLoginUrl}>Google認証を開始</a>
            </div>
            <form className="access-form" onSubmit={(event) => { event.preventDefault(); void retryAuthSession(); }}>
              <div className="button-row"><Button type="submit" controlId="shell.auth-session.retry" variant="primary" disabled={accessChecking}>{accessChecking ? "確認中" : "認証状態を再確認"}</Button></div>
            </form>
            <div id="auth-session-status" className="action-note" role="status">{receipt}</div>
          </Panel>
        </section>
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar route={route} isOwner={hasOwnerAdminAccess(mvpState)} />
      <main className="main">
      <TopHeader receipt={receipt} receiptAt={receiptAt} receiptRoute={receiptRoute} currentRoute={route} setReceipt={setReceipt} onSync={syncState} isOwner={hasOwnerAdminAccess(mvpState)} mvpState={mvpState} mvpLoadStatus={mvpLoadStatus} mvpSyncing={mvpSyncing} apiTokenScope={apiTokenScope} />
        {page}
      </main>
      <FeedbackWidget route={route} setReceipt={setReceipt} setMvpState={setMvpState} onSaved={(row) => setFeedbackReadback((rows) => [row, ...(rows ?? []).filter((item) => item.id !== row.id)])} readOnlyEvidenceMode={mvpLoadStatus !== "ready"} />
    </div>
  );
}

function Sidebar({ route, isOwner }: { route: string; isOwner: boolean }) {
  const currentPath = routePath(route);
  const icons = { "#/": Home, "#/chat": MessageSquare, "#/projects": FolderKanban, "#/runs": Activity, "#/approvals": ClipboardCheck, "#/plugins": Network } as const;
  const nav = [
    ...unifiedManagementNavigation().map((item) => [item.label, item.route, icons[item.route]] as const),
    ...(isOwner ? [["Admin", "#/admin", Settings] as const] : [])
  ];
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
                          : href === "#/plugins" ? "shell.sidebar.plugins"
                          : "shell.sidebar.admin"
            }
            className={currentPath === href || (href.includes("projects") && currentPath.includes("projects")) ? "active" : ""}
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

function TopHeader({ receipt, receiptAt, receiptRoute, currentRoute, setReceipt, onSync, isOwner, mvpState, mvpLoadStatus, mvpSyncing, apiTokenScope }: { receipt: string; receiptAt: number; receiptRoute: string; currentRoute: string; setReceipt: (value: string) => void; onSync: () => Promise<void>; isOwner: boolean; mvpState: MvpState; mvpLoadStatus: MvpLoadStatus; mvpSyncing: boolean; apiTokenScope: ApiTokenScope }) {
  const [query, setQuery] = useState("");
  const companyCount = projectOptionsFromState(mvpState).length;
  const canStartAutomation = mvpLoadStatus === "ready" && companyCount > 0;
  const receiptIsCurrent = routePath(receiptRoute) === routePath(currentRoute);
  const receiptAge = relativeAgeLabel(new Date(receiptAt).toISOString());
  const actions = [
    { label: "ホーム", route: "#/", keywords: "home ホーム dashboard ダッシュボード" },
    { label: "チャット", route: "#/chat", keywords: "chat チャット 作成 自動化 llm" },
    { label: "会社 / 仕事", route: "#/projects", keywords: "company 会社 work 仕事 project プロジェクト 顧客 client 自動化 automation workflow" },
    { label: "履歴", route: "#/runs", keywords: "run worker queue 実行 履歴" },
    { label: "承認", route: "#/approvals", keywords: "approval 承認 停止 外部操作" },
    { label: "設定・接続", route: "#/plugins", keywords: "plugin プラグイン MCP CLI API 認証 接続 ツール 設定 settings" },
    { label: "PC状態", route: "#/system/pc-status", keywords: "pc mac ローカル heartbeat ハートビート 実行先" },
    { label: "本番状態", route: "#/production/status", keywords: "production 本番 deploy 配信状態" },
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
        <div className="top-status-summary" role="status">
          <span className={`status-dot ${mvpLoadStatus === "ready" ? "ready" : "pending"}`} aria-hidden="true" />
          <span>{mvpSyncing ? "状態を同期中" : mvpLoadStatus === "ready" ? "状態を確認済み" : "状態を確認中"}</span>
        </div>
        <details className="top-diagnostics">
          <summary>詳細状態</summary>
          <div className="top-diagnostics-body">
            <div className="top-receipt" role="status" data-freshness={receiptIsCurrent ? "current" : "stale"} title={receipt}>{receipt}</div>
            <small>{receiptIsCurrent ? "この画面" : "前の画面"} / {receiptAge}</small>
            <span data-control-id="shell.auth.scope" aria-label="管理セッションの権限範囲">
              {apiTokenScope === "read" ? "認証: 読み取り専用" : apiTokenScope === "write" ? "認証: 書き込み許可" : apiTokenScope === "unrestricted" ? "認証: ローカル保護なし" : "認証: 権限範囲未確認"}
            </span>
          </div>
        </details>
      </div>
      <div className="top-actions">
        {mvpSyncing && <span className="muted" role="status" data-control-id="shell.top-header.sync-status">状態を同期中（表示は前回確認済み）</span>}
        <IconButton controlId="shell.top-header.sync" label={mvpSyncing ? "同期中" : "同期"} disabled={mvpSyncing} onClick={() => { void onSync(); }}><RefreshCw size={16} /></IconButton>
        <Button controlId="shell.top-header.new-automation" ariaLabel={canStartAutomation ? "新しい自動化" : companyCount === 0 && mvpLoadStatus === "ready" ? "会社を登録" : "詳細readback未確認"} variant="primary" icon={<Plus size={15} />} disabled={mvpLoadStatus !== "ready"} onClick={() => openAutomationCreator(mvpState, setReceipt)}>{canStartAutomation ? "新しい自動化" : companyCount === 0 && mvpLoadStatus === "ready" ? "会社を登録" : "詳細readback未確認"}</Button>
      </div>
    </header>
  );
}

function ProjectTabs({ mvpState }: { mvpState: MvpState }) {
  const route = useRoute();
  const currentPath = routePath(route);
  const activeProject = projectSlugFromRoute(route);
  const activeSection = subTabLabels.find(([, section]) => currentPath.includes(`/${section}`))?.[1] ?? "automations";
  const stateOptions = projectOptionsFromState(mvpState);
  const projectOptions = stateOptions;
  return (
    <div className="project-tabs">
      <div className="project-switcher">{projectOptions.length
        ? projectOptions.map(({ id, label }) => <button data-control-id={`projects.switcher.${id}`} className={id === activeProject ? "selected" : ""} onClick={() => { rememberProject(id); go(`#/projects/${id}/${activeSection}`); }} key={id}>{label}</button>)
        : <span className="muted">会社はまだ登録されていません</span>}</div>
      <div className="sub-tabs">{subTabLabels.map(([label, section]) => {
        const href = `#/projects/${activeProject}/${section}`;
        return <a data-control-id={`projects.sections.${section}`} className={currentPath === href ? "active" : ""} key={href} href={href}>{label}</a>;
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

function ReadbackState({ title, detail, tone = "neutral", nextAction, onAction }: { title: string; detail: string; tone?: PublicStateTone; nextAction?: string; onAction?: () => void }) {
  return <div className={`readback-state ${tone}`} role="status">
    <div className="readback-state-head"><strong>{title}</strong><PublicStateChip tone={tone} label={tone === "attention" ? "要確認" : tone === "info" ? "確認中" : tone === "success" ? "確認済み" : "未確認"} /></div>
    <p>{detail}</p>
    {nextAction && <div className="readback-state-next"><span>次の操作: {nextAction}</span>{onAction && <Button controlId="readback-state.confirm" onClick={onAction}>確認する</Button>}</div>}
  </div>;
}

function ProjectScopeNotice({ projectId, mvpState }: { projectId: string; mvpState: MvpState }) {
  return (
    <div className="project-scope-bar" role="status">
      <div><strong>会社scope: {projectLabelFromState(mvpState, projectId)}</strong><span>membership readbackから取得</span></div>
      <span>外部投稿・送信・削除・認証操作は別の明示gate</span>
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
  const summary = obsidian?.summary ?? "Obsidian statusのfresh readbackを取得します。";
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

function FeedbackFixQueue({ feedbacks, readStatus, state, setReceipt, setFeedbackReadback, canTriage = false }: { feedbacks: MvpState["feedbacks"]; readStatus: "loading" | "ready" | "error"; state: MvpState; setReceipt: (value: string) => void; setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>>; canTriage?: boolean }) {
  const feedback = readStatus === "ready" ? feedbackItemsFromState({ ...state, feedbacks }) : [];
  const allOpenItems = feedback.filter((item) => item.status === "open");
  const allTriagedItems = feedback.filter((item) => item.status === "triaged");
  const openItems = allOpenItems.slice(0, 10);
  const triagedItems = allTriagedItems.slice(0, 3);
  const updateFeedbackStatus = async (feedbackId: string, status: "open" | "triaged") => {
    if (!canTriage) {
      setReceipt("FeedbackのtriageはOwner専用です。表示のみ行い、状態変更は送信していません。");
      return;
    }
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
      {canTriage ? <Button controlId={`home.feedback.queue.triage.${item.id}`} variant="primary" onClick={() => updateFeedbackStatus(item.id, "triaged")}>triaged にする</Button> : <span className="muted">Owner専用・表示のみ</span>}
    </div>
  ]) : [["open feedbackなし", "-", "-", "-", "現在のreadbackでは未処理feedbackはありません", <StatusBadge status="waiting" label="未処理なし" />]];
  return (
    <Panel title="Feedback修正キュー" controlId="home.feedback.queue.panel">
      {readStatus !== "ready" ? <ReadbackState title={readStatus === "loading" ? "Feedbackを確認中" : "Feedbackを確認できません"} detail="未取得や認証失敗を未処理0件とは扱いません。上部の同期で再確認してください。" tone={readStatus === "loading" ? "info" : "attention"} /> : <>
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
              {canTriage ? <Button controlId={`home.feedback.queue.open.${item.id}.restore`} onClick={() => updateFeedbackStatus(item.id, "open")}>open に戻す</Button> : <span className="muted">Owner専用・表示のみ</span>}
            </div>
          ))}
        </div>
      )}
      <p className="muted">この一覧はMVP stateの feedback proof readback です。スクショ本体やsecretは表示しません。{canTriage ? "状態変更はOwner権限でreadback後に行います。" : "状態変更はOwner専用のため、現在は表示のみです。"}</p>
      </>}
    </Panel>
  );
}

function WebOperationAdmissionPanel({ model, projectId }: { model: AppModel; projectId?: string }) {
  const runtime = model.mvpState.browser_use_runtime;
  const configuredBackend = model.mvpState.web_operation_backend?.backend;
  const stateReadbackPhase = model.mvpLoadStatus === "loading"
    ? "API fresh source-of-truth確認中"
    : model.mvpLoadStatus === "error"
      ? "API readback要確認"
      : model.mvpLoadStatus === "degraded"
        ? "summary表示 / 詳細readback未確定"
      : "API readback確認済み";
  const configuredBackendLabel = model.mvpLoadStatus !== "ready"
    ? model.mvpLoadStatus === "loading" ? "確認中" : "未確認"
    : configuredBackend === undefined
    ? "未確認"
    : publicWebOperationBackendLabel(configuredBackend);
  const selectedProjectId = projectId || resolveProjectSelection(model.mvpState);
  const selectedProject = selectedProjectId ? projectLabelFromState(model.mvpState, selectedProjectId) : "未選択";
  const runtimePhase = model.mvpLoadStatus === "loading"
    ? "loading"
    : model.mvpLoadStatus === "error"
      ? "error"
      : model.mvpLoadStatus === "degraded"
        ? "degraded"
      : runtime?.status === "verified"
        ? "ready"
        : "nogo";
  const runtimeBlocker = runtimePhase === "loading"
    ? "mvp_state_readback_pending"
    : runtimePhase === "error"
      ? model.mvpLoadBlocker ?? "mvp_state_readback_unavailable"
      : runtimePhase === "degraded"
        ? model.mvpLoadBlocker ?? "mvp_state_detail_readback_pending"
      : runtimePhase === "nogo"
        ? runtime?.chromePluginReadback?.exactBlocker ?? runtime?.exactBlocker ?? "web_operation_runtime_readback_unverified"
        : "none_claimed";
  const runtimeLabel = model.mvpLoadStatus !== "ready"
    ? model.mvpLoadStatus === "loading" ? "確認中" : "要確認"
    : publicBrowserUseRuntimeStatus(runtime);
  const registeredWorkflowCount = (model.mvpState.registered_workflow_ids ?? []).length;
  const registeredLanes = runtime?.lanes ?? [];
  const processReadback = runtime?.processReadback;
  const operationalReadback = runtime?.operationalReadback;
  const liveBrowserProcesses = processReadback?.browserProcesses ?? [];
  const portableRemoteWorker = processReadback?.portableRemoteWorker;
  const workerScope = portableRemoteWorker?.scopeReadback ?? processReadback?.workerScopeReadback;
  const queueScope = model.mvpState.worker?.queue_scope;
  const workerTransport = portableRemoteWorker?.transportReadback;
  const workerTransportLabel = workerTransport?.heartbeatStatus === "ok"
    ? `受理済み / ${relativeAgeLabel(workerTransport.lastSuccessfulHeartbeatAt ?? workerTransport.heartbeatAt ?? null)}`
    : workerTransport?.heartbeatStatus === "blocked"
      ? `復旧待ち / ${publicBlockerSummary(workerTransport.heartbeatExactBlocker ?? "transport blocker不明")}`
      : "未確認";
  const workflowInventory = runtime?.workflowInventory;
  const nextAction = model.mvpLoadStatus === "loading"
    ? "APIのfresh state readbackを実行中です。12秒で結果を確定し、未取得ならread-only表示へ切り替えます。"
    : model.mvpLoadStatus === "error"
      ? "APIのreadbackを再取得してください。未確認のbackend・runtimeを実行可能とは扱いません。"
      : model.mvpLoadStatus === "degraded"
        ? "summaryを表示済みです。詳細readbackはバックグラウンドで再試行し、未取得ならexact blockerを確定します。保存・送信・定期実行変更は安全停止です。"
      : runtime?.nextAction
    ? redactDisplayPaths(runtime.nextAction)
    : selectedProjectId
      ? "目的・対象・アカウントをチャットに入力し、まず読み取り計画を確認してください。"
      : "会社を選択してから、目的・対象・アカウントを入力してください。";
  const openChat = () => {
    if (!selectedProjectId) {
      go("#/projects");
      return;
    }
    rememberProject(selectedProjectId);
    go(chatHref({ companyId: selectedProjectId, context: "web-operation-admission" }));
  };
  return (
      <Panel title="Web操作の共通入口" controlId="web-admission.panel">
      <p className="muted">初見のサイトでも、固定されたクリック手順ではなく、現在の画面の意味・状態・対象候補を読み直して進めます。ここではまだ保存・実行・外部操作はまだ開始できません。ブラウザ起動、投稿、送信、削除、認証、課金も実行しません。</p>
      <div className="action-note" role="status" data-control-id="web-admission.status" data-readback-phase={runtimePhase} data-exact-blocker={runtimeBlocker}>状態: {stateReadbackPhase} / 実行可否: {runtimeLabel} / 次: {nextAction} / 外部操作: なし</div>
      <CompanionRecoveryGuide companyId={selectedProjectId} blockerCandidates={[runtimeBlocker, runtime?.exactBlocker, runtime?.chromePluginReadback?.exactBlocker, model.mvpState.browserHealth?.chromeExtension?.exactBlocker, model.mvpLoadBlocker]} />
      {workflowInventory?.sets && (
        <div className="preview-box" data-control-id="web-admission.workflow-inventory">
          <strong>登録集合の意味</strong>
          <p className="muted">Browser/portable {workflowInventory.sets.registered_browser_workflows?.length ?? 0}件 / Company catalog {workflowInventory.sets.company_automation_catalog_workflows?.length ?? 0}件 / Browser lane {workflowInventory.sets.browser_lane_workflows?.length ?? 0}件。YouTubeの一時laneなど、実行workflowとlane専用項目は別集合として表示しています。</p>
        </div>
      )}
      <details className="home-secondary-details technical-readback-details">
        <summary>接続・workerの技術詳細（必要な場合のみ）</summary>
      <div className="preview-box" data-control-id="web-admission.lane-binding">
        <strong>{configuredBackendLabel} workflow resourceの対応（AOS登録値）</strong>
        <p className="muted">ここに表示するprofileは秘密情報を含まない論理参照名、portはworkflow-ownedの予約portです。lifecycle（scheduled / single-use / temporary）も併記します。「使用中」「ログイン済み」「実行可能」とは解釈しません。実プロセスのlistenは別表の実測process port、認証状態と画面readbackはMac workerが同一Runで返した場合だけ反映します。登録値は互換診断として表示しますが、現在の選択面・対象・task・Run束縛が正本です。</p>
        <div className="lane-binding-summary" data-control-id="web-admission.lane-binding.summary" role="status">
          <span><strong>設定済みbackend:</strong> {configuredBackendLabel}</span>
          <span><strong>state readback:</strong> {stateReadbackPhase}</span>
          <span><strong>runtime readback surface:</strong> {model.mvpLoadStatus === "ready" ? runtime?.surface ?? "未確認" : "未確認"}</span>
          <span><strong>runtime:</strong> {runtimeLabel}</span>
          <span><strong>runtime role:</strong> {model.mvpLoadStatus === "ready" ? runtime?.runtimeRole ?? "unknown" : "unknown"}</span>
          <span><strong>次の確認:</strong> {publicBrowserUseRuntimeNextCheck(runtime)}</span>
        </div>
        {registeredLanes.length ? <DataTable controlId="web-admission.lane-binding.table" headers={["Workflow", "lifecycle", "論理profile", "予約port (AOS)", "process readback", "所有 / binding", "same-run readback", "次の確認"]} rows={registeredLanes.map((lane) => [
          lane.workflowId ?? "-",
          lane.lifecycle ?? "-",
          <code>{lane.profileRef ?? lane.profileName ?? "-"}</code>,
          lane.reservedPort == null ? "-" : String(lane.reservedPort),
          `${publicBrowserUseLaneProcessReadbackStatus(lane)}${lane.processPid ? ` / pid=${lane.processPid}` : ""}`,
          `${lane.ownership ?? "workflow_owned"} / ${lane.bindingStatus ?? "registered"}`,
          publicBrowserUseLaneReadbackStatus(lane),
          publicBrowserUseLaneNextCheck(lane, runtime)
        ])} /> : <p className="muted">{configuredBackendLabel}の登録workflow resource定義はありません。固定値を補って表示せず、AOS inventoryのfresh readbackを取得します。</p>}
        <div className="lane-binding-summary" data-control-id="web-admission.process-readback" role="status">
          <span><strong>同一ホストprocess:</strong> {publicBrowserUseProcessReadbackStatus(processReadback)}</span>
          <span><strong>remote worker:</strong> {portableRemoteWorker?.status ?? "未確認"} / effects={portableRemoteWorker?.effects ?? "unknown"}</span>
          <span><strong>queue scope:</strong> {workerScope?.status ?? "未確認"} / AOS={workerScope?.controlPlaneCompanyIds?.join(", ") || "未確認"} / worker={workerScope?.remoteWorkerCompanyIds?.join(", ") || "未確認"}</span>
          <span><strong>heartbeat transport:</strong> {workerTransportLabel} / claim={workerTransport?.claimStatus ?? "unknown"}</span>
          <span><strong>未登録Browser:</strong> {processReadback?.unregisteredBrowserProcessCount ?? "未確認"}件</span>
        </div>
        {workerScope && <div className="preview-box" data-control-id="web-admission.scope-alignment">
          <strong>Queue / Workerのscope候補</strong>
          <p className="muted">AOSが現在読んでいるqueueと、同一ホストで観測したremote workerのendpoint/companyを分けて表示します。候補が一致するまで、remote workerへのclaimを実行可能とは扱いません。</p>
          <DataTable controlId="web-admission.scope-alignment.table" headers={["候補", "readback", "company", "endpoint", "worker"]} rows={(workerScope.alignmentCandidates ?? []).map((candidate) => [
            candidate.scope === "control_plane_queue" ? "現在のAOS control-plane queue" : candidate.scope === "portable_remote_worker" ? "同一ホストのremote worker" : candidate.scope ?? "unknown",
            candidate.status ?? "unknown",
            candidate.companyIds?.join(", ") || "未確認",
            candidate.origins?.join(", ") || "未確認",
            candidate.workerIds?.join(", ") || "未確認"
          ])} />
          <div className="preview-box" data-control-id="web-admission.scope-alignment.plan">
            <strong>正本の選択と必要な整合（自動切替なし）</strong>
            <p className="muted">現在のAOS queue source={queueScope?.source ?? "未確認"} / company={queueScope?.company_ids?.join(", ") || workerScope.controlPlaneCompanyIds?.join(", ") || "未確認"}。remote workerのendpoint/companyと一致する正本を人間が決め、fresh config readback後にだけclaimへ進みます。</p>
            <DataTable controlId="web-admission.scope-alignment.plan.table" headers={["正本候補", "必要な変更", "現在の扱い", "選択前"]} rows={workerScope.alignmentDecisionRequired ? [
              ["AOS control-plane queue", "remote workerの到達先endpoint・company・backendを、このAOS queueと同じ正本へ揃える", "未整合", "claim不可"],
              ["portable remote worker", "AOSのendpoint・database backend・companyをremote workerが参照する正本へ揃え、local queueを別系統として隔離する", "未整合", "claim不可"]
            ] : [
              ["一致したcompany scope", "fresh config / heartbeat / queue readbackを再確認する", "一致確認済み", "receipt・source syncまで別途必要"]
            ]} />
            <p className="muted">選択後の順序: config readback → 新世代heartbeat → 同一company queue readback → claim → receipt → source sync → cleanup。ここではendpoint、company、databaseを変更しません。</p>
          </div>
          <p className="muted">{workerScope.alignmentDecisionRequired ? "判断が必要: AOS queueとremote workerのcompany/endpointを同じ正本へ揃えるまでclaimしません。" : workerScope.exactBlocker ? `readback blocker: ${workerScope.exactBlocker}` : "scope候補の比較は完了しています。claim・receipt・source syncは別の同一Run証跡です。"}</p>
        </div>}
        {liveBrowserProcesses.length ? <DataTable controlId="web-admission.process-readback.table" headers={["検出対象", "論理profile", "process port", "AOS binding", "room owner/readback", "同一ホストreadback"]} rows={liveBrowserProcesses.map((process) => [
          process.kind ?? "browser_use_chrome",
          <code>{process.profileRef ?? process.profileName ?? "-"}</code>,
          process.port == null ? "-" : String(process.port),
          `${process.bindingStatus ?? "unknown"} / ${process.workflowId ?? "AOS未登録"}`,
          process.roomId
            ? `${process.roomOwnership ?? "bound"} / ${process.roomOwnerKind ?? "owner"}:${process.roomOwnerId ?? "unknown"} / room=${process.roomId} / ${process.roomMatchStatus ?? "unknown"} / reclaim=${process.roomReclaimAllowed === false ? "no" : "unknown"}`
            : `room=${process.roomReadbackStatus ?? "unknown"} / owner=${process.ownership ?? "unknown"}`,
          `${process.readbackStatus ?? "unknown"} / pid=${process.pid ?? "?"} / tree=${process.processCount ?? 1}`
        ])} /> : <p className="muted">同一ホストで検出された{configuredBackendLabel} browser processはありません。これはAOS予約値が使用中・ログイン済み・実行可能という意味ではありません。</p>}
        <p className="muted">process readbackはprofile / portの同一ホスト実測、登録binding、Browser Use canonical room registryのowner readbackを分けて示します。room ownerが表示されてもAOSがforeign roomを回収・利用できる意味ではありません。ログイン状態、画面状態、外部効果、同一Runの完了は別証跡が必要です。{processReadback?.exactBlocker ? ` exact blocker=${processReadback.exactBlocker}` : " external_action=false"} / room={processReadback?.roomReadback?.status ?? "unknown"} / active rooms={processReadback?.roomReadback?.activeRoomCount ?? "未確認"}</p>
        {(portableRemoteWorker?.status === "present" || portableRemoteWorker?.status === "remote_reported") && <p className="muted">{portableRemoteWorker.status === "remote_reported" ? "Mac workerのheartbeat reportを受理済みですが、API応答ホストのprocessは未観測です。" : "portable remote workerのプロセス存在とHeartbeat HTTP受理を分離表示しています。"} heartbeat・queue claim・receipt・source syncは別に確認します。read-only境界: effects={portableRemoteWorker.effects ?? "unknown"} / mode={portableRemoteWorker.mode ?? "unknown"} / transport={workerTransportLabel}。queue scope={workerScope?.status ?? "unknown"}{workerScope?.exactBlocker ? ` / exact blocker=${workerScope.exactBlocker}` : ""}。</p>}
        {workerScope?.status === "mismatch" && <p className="muted">AOS queue と Mac worker が別会社scopeを見ています。endpoint/companyを同じ対象へ揃えるまで claim は実行しません。remote origin={workerScope.remoteOrigins?.join(", ") || "未確認"}。</p>}
        <p className="muted">判定境界: {runtime?.summary ?? "runtime readbackなし"} / {runtime?.exactBlocker ? `exact blocker=${runtime.exactBlocker}` : "external_action=false"}</p>
      </div>
      </details>
      <div className="preview-box" data-control-id="web-admission.operational-readback">
        <strong>認証・外部作用・業務完了のreadback</strong>
        <p className="muted">この表示は現在のcontrol-plane snapshotです。run固有の画面・provider receipt・source-of-truth syncが返るまで、認証済み・作用済み・業務完了とは解釈しません。</p>
        <div className="lane-binding-summary" role="status">
          <span><strong>認証:</strong> {publicBrowserOperationalAuthenticationStatus(operationalReadback)}</span>
          <span><strong>外部作用:</strong> {publicBrowserOperationalEffectStatus(operationalReadback)}</span>
          <span><strong>業務完了:</strong> {publicBrowserOperationalCompletionStatus(operationalReadback)}</span>
          <span><strong>証跡:</strong> {publicBrowserOperationalProofStatus(operationalReadback)}</span>
        </div>
        <p className="muted">blocker: auth={operationalReadback?.authentication?.exactBlocker ?? "unknown"} / effect={operationalReadback?.externalEffect?.exactBlocker ?? "unknown"} / completion={operationalReadback?.businessCompletion?.exactBlocker ?? "unknown"}</p>
      </div>
      <DataTable controlId="web-admission.checklist" headers={["確認項目", "共通の扱い", "初見ユーザーが入力するもの"]} rows={[
        ["操作の種類", "read / create / update / publish / submit / delete を区別", "何をしたいかを自然文で書く"],
        ["アカウント", "会社scope + account_refを同一Runに束縛", "使う会社・サービス・アカウントを指定"],
        ["対象", "live semantic candidateの唯一一致。固定CSS/XPath/DOM順は権威にしない", "URLまたはサイト名と、対象の意味（例: 公開、保存、応募）"],
        ["内容", "本文・画像・応募内容・削除対象をpayload hashで同一Runに固定", "投稿文、ファイル、応募内容、削除範囲など"],
        ["認証", "ログイン・OTP・CAPTCHA・本人確認は人間境界。secretは保存・表示しない", "必要なら画面上で自分でログインし、完了後に続行"],
        ["外部効果", "read以外は明示承認 → 1回のaction → provider/source readback", "公開先・送信先・対象範囲・承認判断"],
        ["完了条件", "同一Runのreceipt、source-of-truth sync、cleanupが揃うまで完了扱いにしない", "結果URL・受付番号・更新状態が見えるかを確認"]
      ]} />
      <div className="preview-box">
        <strong>固定化しないための停止条件</strong>
        <p>候補が0件・複数件、画面状態が変わった、必要情報が未知、認証待ち、外部効果が不明な場合は停止して質問または照合に戻ります。古いスクショ・selector・成功扱い・外部効果不明の状態から再実行しません。</p>
        <p className="muted">次: {nextAction}</p>
      </div>
      <div className="preview-box" data-control-id="web-admission.prompt-template">
        <strong>Chatに渡す入力テンプレート</strong>
        <pre>{COMMON_WEB_OPERATION_PROMPT_TEMPLATE}</pre>
        <p className="muted">サイト固有のselectorやクリック順は不要です。未入力の項目はplannerが質問し、認証・OTP・CAPTCHAは人間境界で停止します。</p>
      </div>
      <div className="button-row">
        <Button controlId="web-admission.chat" variant="primary" icon={<MessageSquare size={14} />} onClick={openChat}>{selectedProjectId ? "この条件で依頼を始める" : "会社を選んで依頼を始める"}</Button>
        <Button controlId="web-admission.approvals" icon={<ClipboardCheck size={14} />} onClick={() => go("#/approvals")}>承認キューを見る</Button>
      </div>
    </Panel>
  );
}

type AppModel = {
  setReceipt: (value: string) => void;
  automationRows: AutomationRow[];
  setAutomationRows: React.Dispatch<React.SetStateAction<AutomationRow[]>>;
  createdTemplates: string[];
  setCreatedTemplates: React.Dispatch<React.SetStateAction<string[]>>;
  mvpState: MvpState;
  setMvpState: React.Dispatch<React.SetStateAction<MvpState>>;
  mvpLoadStatus: MvpLoadStatus;
  mvpLoadBlocker: string | null;
  feedbackReadback: MvpState["feedbacks"];
  feedbackReadStatus: "loading" | "ready" | "error";
  setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>>;
};

const COMPANION_RECOVERY_BLOCKERS = new Set([
  "profile_not_connected",
  "client_transport_disconnected",
  "extension_transport_disconnected",
  "unknown_effect",
  "unknown_effect_ledger_only",
  "ledger_only",
  "owner_sso_required",
  "owner_sso_required_on_fresh_task_owned_ingress_session"
]);

function CompanionRecoveryGuide({ companyId, blockerCandidates }: { companyId?: string; blockerCandidates: unknown[] }) {
  const signals = [...new Set(blockerCandidates
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => COMPANION_RECOVERY_BLOCKERS.has(value)))];
  const signalLabel = signals.length
    ? signals.map((value) => `${value}: ${publicBlockerSummary(value)}`).join(" / ")
    : "Companionの切断理由はfresh readbackで確認できていません。接続済みとは断定しません。";
  const companyLabel = companyId === "company_2560580981cedfd106b66245"
    ? "Company 1（company_2560580981cedfd106b66245）"
    : companyId
      ? `現在選択中の会社（${companyId}） / Company 1は company_2560580981cedfd106b66245`
      : "Company 1（company_2560580981cedfd106b66245）";
  return (
    <details className="preview-box companion-recovery-guide" data-control-id="web-admission.companion-recovery">
      <summary>Companion接続の復旧手順</summary>
      <p className="muted">接続が戻った表示だけでは、業務Runや外部効果を再開できるとは扱いません。次の順序で対象を読み直します。</p>
      <ol>
        <li>ChromeのAOS Chrome Companionプロファイルで <code>Reconnect</code> を押し、<code>Connected</code> を確認する。</li>
        <li>過去・別taskのsessionやleaseを使わず、現在のtaskが所有する新しいtask-owned sessionを作る。</li>
        <li>{companyLabel}と対象を、同じsessionのfresh semantic＋visual readbackで確認する。</li>
        <li>readbackが不十分な場合だけ、同じ対象のread-only確認を一回追加する。これは前回操作の再クリック・再送ではない。</li>
      </ol>
      <div className="action-note" role="status" data-control-id="web-admission.companion-recovery.status">
        <strong>現在の扱い:</strong> {signalLabel}
      </div>
      <p className="muted">{signals.some((value) => value.includes("unknown_effect") || value === "ledger_only") ? "効果未確定・ledger-onlyは同じRunのreceiptと対象readbackで照合し、再送しません。" : "Owner SSOが必要な場合はReconnectとは別の人間操作です。公式SSO後にCompany 1のprotected stateを再取得します。"} Connectedやこの案内の開閉だけで、session作成・Run開始・保存・送信・公開・feedback変更は行いません。</p>
    </details>
  );
}

function TruthfulLanesPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const [laneReadback, setLaneReadback] = useState<any>(null);
  const [laneReadStatus, setLaneReadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [laneRefresh, setLaneRefresh] = useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setLaneReadback(null); setLaneReadStatus("loading");
    void fetchApiJson<any>(`/api/v1/companies/${encodeURIComponent(companyId)}/lanes/readback`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.company_id !== companyId || result.company_scope?.company_id !== companyId || result.company_scope?.enforced !== true
        || result.source !== "company_run_steps" || !Array.isArray(result.observed)) throw new Error("company_lanes_readback_mismatch");
      setLaneReadback(result); setLaneReadStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setLaneReadStatus("error"); });
    return () => controller.abort();
  }, [companyId, laneRefresh]);
  const registeredLanes = model.mvpState.browser_use_runtime?.lanes ?? [];
  const selectedBackend = model.mvpState.web_operation_backend?.backend ?? model.mvpState.browser_use_runtime?.backend ?? "unknown";
  const selectedBackendLabel = publicWebOperationBackendLabel(selectedBackend);
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="Lane readback" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <Panel title="登録済みLane定義" controlId="truthful.lanes.registry.panel">
        <p className="muted">現在のAOS選択backend={selectedBackendLabel}。登録Lane定義の旧runner名は互換性のため別のworkflow-owned契約として表示しています。下表のrunnerはプロセス起動中・ログイン済み・実行可能とは解釈しません。選択backendへの実行bindingはRun開始時に固定され、実際の会社Runで観測されたLaneは下の表に分けて表示します。</p>
        {registeredLanes.length ? <DataTable controlId="truthful.lanes.registry.table" headers={["Lane", "Workflow", "lifecycle", "論理profile", "予約port (AOS)", "Runner契約", "process readback", "Live readback", "定義状態"]} rows={registeredLanes.map((lane: BrowserUseLaneBinding) => [lane.id ?? "-", lane.workflowId ?? "-", lane.lifecycle ?? "-", <code>{lane.profileRef ?? lane.profileName ?? "-"}</code>, lane.reservedPort == null ? "-" : String(lane.reservedPort), lane.runnerKind ?? lane.executionContract ?? "-", `${publicBrowserUseLaneProcessReadbackStatus(lane)}${lane.processPid ? ` / pid=${lane.processPid}` : ""}`, publicBrowserUseLaneReadbackStatus(lane), `${lane.ownership ?? "workflow_owned"} / ${lane.bindingStatus ?? lane.status ?? "registered"}`])} /> : <p className="muted">登録済みLane定義はありません。</p>}
      </Panel>
      <Panel title="永続化済みLane情報" controlId="truthful.lanes.panel">
        <Button controlId="truthful.lanes.refresh" onClick={() => setLaneRefresh((value) => value + 1)} disabled={laneReadStatus === "loading"}>Lane記録を再読込</Button>
        {laneReadStatus === "loading" ? <ReadbackState title="Lane記録を確認中" detail="この会社のRun手順から実際に保存されたLane IDを読み込んでいます。" tone="info" />
          : laneReadStatus === "error" ? <ReadbackState title="Lane記録を取得できません" detail="取得失敗を記録なしとは扱いません。再読込できます。" tone="attention" />
          : laneReadback.observed.length ? <DataTable controlId="truthful.lanes.table" headers={["Lane", "Run数", "手順数", "最終記録時刻"]} rows={laneReadback.observed.map((lane: any) => [lane.lane_id, lane.run_count, lane.step_count, lane.last_observed_at ?? "未記録"])} />
          : <ReadbackState title="保存されたLane記録は0件です" detail="この会社のRun手順を確認しました。登録定義を実行記録の代わりにはしません。" tone="success" />}
        <p className="muted">保存された手順の履歴であり、現在のブラウザ起動・ログイン・ロック状態ではありません。確認: {laneReadback?.captured_at ?? "未確認"}。この画面からLane作成・ブラウザ起動・ロック解除は行いません。</p>
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
        {model.mvpLoadStatus === "loading" || (model.mvpLoadStatus === "degraded" && model.mvpLoadBlocker === "mvp_state_detail_readback_pending") ? <ReadbackState title="保存情報を確認中" detail="会社別の保存記録を読み込んでいます。" tone="info" />
          : model.mvpLoadStatus !== "ready" ? <ReadbackState title="保存情報の最新状態を確認できません" detail="読取失敗を保存件数0件とは扱いません。上部の同期で再確認してください。" tone="attention" />
          : memory.length ? <DataTable controlId="truthful.memory.info.table" headers={["項目", "内容", "更新日時"]} rows={memory.map((item) => [item.title ?? item.memory_key ?? item.key, item.body ?? "-", item.updated_at ?? "未記録"])} />
          : <ReadbackState title="保存済み情報は0件です" detail="この会社の永続化記録を確認しました。この画面は閲覧専用で、Chatからの任意の保存情報作成には対応していません。" tone="success" />}
        <Button controlId="truthful.memory.open-artifacts" onClick={() => go(`#/projects/${encodeURIComponent(companyId)}/artifacts`)}>業務の成果物を見る</Button>
      </Panel>
    </section>
  );
}

function connectionMutationReadbackConfirmed(refs: any[] | undefined, item: any, action: "reconnect" | "revoke") {
  const saved = refs?.find((row) => row.id === item.id);
  return Boolean(saved && Number.isFinite(Number(saved.revision)) && Number.isFinite(Number(item.revision))
    && Number(saved.revision) > Number(item.revision)
    && (action === "revoke" ? saved.status === "revoked"
      : saved.status === "reconnect_required" && (saved.oauth_state ?? saved.oauthState) === "reauthorization_required"));
}

function TruthfulIntegrationsPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const isSecurity = route.includes("/security");
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const role = projectOptionsFromState(model.mvpState).find((company) => company.id === companyId)?.role ?? "viewer";
  const canManage = role === "owner" || role === "admin";
  const [accountRefs, setAccountRefs] = useState<any[]>([]);
  const [inventoryStatus, setInventoryStatus] = useState<"loading" | "ready" | "error">(canManage ? "loading" : "ready");
  const [busyId, setBusyId] = useState<string | null>(null);
  const inventoryGeneration = React.useRef(0);
  const inventoryScope = React.useRef(companyId);
  inventoryScope.current = companyId;
  const loadInventory = async () => {
    const generation = ++inventoryGeneration.current;
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
      if (generation !== inventoryGeneration.current || inventoryScope.current !== companyId) return;
      if (result.company_scope?.enforced !== true || result.company_scope.company_id !== companyId || !Array.isArray(result.refs)
        || result.refs.some((item: any) => (item.companyId ?? item.company_id) !== companyId)) throw new Error("company_connection_inventory_scope_mismatch");
      setAccountRefs(result.refs ?? []);
      setInventoryStatus("ready");
      return result.refs as any[];
    } catch {
      if (generation !== inventoryGeneration.current || inventoryScope.current !== companyId) return;
      setAccountRefs([]);
      setInventoryStatus("error");
    }
  };
  React.useEffect(() => { void loadInventory(); return () => { inventoryGeneration.current += 1; }; }, [companyId, canManage]);
  const refreshInventory = async () => {
    const refs = await loadInventory();
    if (inventoryScope.current !== companyId) return;
    model.setReceipt(refs
      ? `${companyName}: 接続記録${refs.length}件の最新状態を再取得しました。表の状態を確認してください。処理の再送・外部providerの認証や失効は行っていません。`
      : `${companyName}: 接続記録を再取得できませんでした。操作結果を未確認のまま保持しています。処理は再送していません。`);
  };
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
      const refs = await loadInventory();
      if (!connectionMutationReadbackConfirmed(refs, item, action)) {
        model.setReceipt(`${item.platform}: 接続操作の結果は未確認です。再送せず、接続記録を再読込して照合してください。`);
        return;
      }
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
      <PageTitle title={companyName} desc={isSecurity ? "Security / 権限・secret・接続境界" : "Integrations / 接続参照と再認証要求"} />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      {isSecurity && <div className="notice-row" role="note">Securityは閲覧専用です。接続の追加・再認証・ローカル参照の無効化は「連携」画面で行います。</div>}
      <Panel title={isSecurity ? "Security / 接続境界（閲覧専用）" : "Integrations / 会社別接続inventory"} controlId={isSecurity ? "truthful.security.refs.panel" : "truthful.integrations.refs.panel"}>
        {canManage && <Button controlId="truthful.integrations.inventory-refresh" onClick={() => { void refreshInventory(); }} disabled={inventoryStatus === "loading" || busyId !== null}>接続記録を再読込</Button>}
        <p className="muted">保存された接続参照と検証日時を表示します。今この場でのProvider利用成功やOAuthの再認証完了を保証するものではありません。</p>
        {canManage && inventoryStatus === "loading" ? <ReadbackState title="接続inventoryを確認中" detail="会社別APIから最新の接続参照を読み込んでいます。" tone="info" /> : canManage && inventoryStatus === "error" ? <ReadbackState title="接続inventoryを確認できません" detail="未確認状態を接続済みとは表示していません。「接続記録を再読込」で、この会社の記録を再取得できます。" tone="attention" /> : canManage && accountRefs.length ? <DataTable controlId="truthful.integrations.refs.table" headers={["サービス", "アカウント参照", "OAuth", "Scope", "期限", "最終検証", "状態", "操作"]} rows={accountRefs.map((item) => [
          item.platform,
          item.account_ref ?? item.accountRef,
          item.oauth_state ?? item.oauthState ?? "not_configured",
          (item.scopes ?? []).join(", ") || "なし",
          item.expires_at ?? item.expiresAt ?? "期限なし",
          item.last_verified_at ?? item.lastVerifiedAt ?? "未検証",
          <StatusBadge status={integrationStatusBadge(item).status} label={integrationStatusBadge(item).label} />,
          (isSecurity ? <span className="muted">連携画面で管理</span> : <div className="row-actions">
            <Button controlId={`integrations.reconnect.${item.id}`} onClick={() => { void mutateConnection(item, "reconnect"); }} disabled={busyId !== null}>再認証を要求</Button>
            {item.status !== "revoked" && <Button controlId={`integrations.revoke.${item.id}`} variant="danger" onClick={() => { void mutateConnection(item, "revoke"); }} disabled={busyId !== null}>接続参照を無効化</Button>}
          </div>)
        ])} /> : canManage ? <ReadbackState title="接続はまだ設定されていません" detail="この会社に保存された接続参照はありません。未確認サービスや架空の接続状態は表示しません。" nextAction="必要なサービスを明示してから、再認証要求を保存する" /> : <ReadbackState title="接続inventoryは閲覧権限が必要です" detail="Owner/Adminの会社membershipが確認できるまで、接続状態を推測して表示しません。" tone="attention" />}
      </Panel>
      <Panel title={isSecurity ? "Security guard / 適用中の境界" : "Integrations / 接続操作の境界"} controlId={isSecurity ? "truthful.security.boundary.panel" : "truthful.integrations.boundary.panel"}>
        <CheckList items={isSecurity
          ? ["password・access token・refresh tokenはinventory APIへ保存しない", "会社membershipとRBACをserver側で検証", "未検証の接続を有効とは表示しない", "外部provider側の失効やOAuth認証はこの画面から実行しない"]
          : ["再接続は再認証要求の永続化まで。OAuth認証は人間gate", "無効化はローカル接続参照のみ。外部provider失効を実行済みとは表示しない", "接続状態はfresh readback後にだけ表示する", "会社membershipとRBACをserver側で検証"]} />
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

function normalizedPluginName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
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

async function requestCompanyPresentationProfile(companyId: string, init: RequestInit = {}) {
  const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/presentation-profile`, { ...init, cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.exactBlocker || result.error || "project_profile_read_failed");
  const profile = result.profile;
  if (result.company_scope?.enforced !== true || result.company_scope?.company_id !== companyId || profile?.id !== companyId
    || !["derived_from_project_automation_catalog", "persisted_project_profile"].includes(profile?.source)
    || !Array.isArray(profile.primaryMetrics) || !Array.isArray(profile.widgets) || !profile.label
    || result.revision !== (profile.revision ?? 0)) throw new Error("project_profile_readback_mismatch");
  return profile as NonNullable<MvpState["presentation_profiles"]>[number];
}

function ProjectPresentationProfilePanel({ model, companyId }: { model: AppModel; companyId: string }) {
  const profile = model.mvpState.presentation_profiles?.find((item) => item.id === companyId);
  const role = projectOptionsFromState(model.mvpState).find((project) => project.id === companyId)?.role ?? "viewer";
  const canManage = role === "owner" || role === "admin" || role === "operator";
  const [draft, setDraft] = useState<PresentationProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [readbackRequired, setReadbackRequired] = useState(false);
  const mutationRef = React.useRef(false);
  const scopeRef = React.useRef(companyId);
  scopeRef.current = companyId;
  React.useEffect(() => { setReadbackRequired(false); }, [companyId]);
  const [note, setNote] = useState("プロジェクトの自動化カタログから表示方法を判定しています。");
  React.useEffect(() => {
    setDraft(profile ? presentationProfileDraft(profile) : null);
    setNote(profile?.exactBlocker ? `表示profileを確認できません: ${profile.exactBlocker}` : profile?.source === "persisted_project_profile" ? `保存済みprofile / revision=${profile.revision ?? "?"}` : "自動判定profile。必要ならこのプロジェクト専用に調整できます。");
  }, [companyId, profile?.revision, profile?.source, profile?.exactBlocker, profile?.label]);
  if (!profile || !draft) return <Panel title="表示profile"><p className="muted">このプロジェクトの表示profileを取得できませんでした。未確認のwidgetやKPIは表示しません。</p></Panel>;
  const update = (key: keyof PresentationProfileDraft, value: string) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const applyProfile = (nextProfile: NonNullable<MvpState["presentation_profiles"]>[number]) => {
    model.setMvpState((state) => ({ ...state, presentation_profiles: [
      ...(state.presentation_profiles ?? []).filter((item) => item.id !== companyId), nextProfile
    ] }));
    setReadbackRequired(false);
    setDraft(presentationProfileDraft(nextProfile));
  };
  const reconcile = async () => {
    if (mutationRef.current) return;
    mutationRef.current = true; setSaving(true); setNote("保存内容を読み直しています。保存要求は再送しません。");
    try {
      const nextProfile = await requestCompanyPresentationProfile(companyId);
      if (scopeRef.current !== companyId) return;
      applyProfile(nextProfile);
      setNote(`最新の保存内容を照合しました / revision=${nextProfile.revision ?? 0}。内容を確認してから編集できます。`);
    } catch (error) {
      if (scopeRef.current === companyId) setNote(`保存内容の照合が必要です: ${error instanceof Error ? error.message : "project_profile_read_failed"}`);
    } finally { mutationRef.current = false; setSaving(false); }
  };
  const save = async () => {
    if (!canManage || mutationRef.current || readbackRequired) return;
    mutationRef.current = true;
    const primaryMetrics = draft.primaryMetrics.split(",").map((item) => item.trim()).filter(Boolean);
    const widgets = draft.widgets.split(",").map((item) => item.trim()).filter(Boolean);
    setSaving(true);
    setNote("表示profileを保存し、revisionを確認しています。");
    try {
      const nextProfile = await requestCompanyPresentationProfile(companyId, {
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
      if (scopeRef.current !== companyId) return;
      if (nextProfile.revision !== (profile.revision ?? 0) + 1) throw new Error("project_profile_revision_readback_mismatch");
      applyProfile(nextProfile);
      setNote(`保存済みprofile / revision=${nextProfile.revision} / 外部処理なし`);
      model.setReceipt(`表示profileを保存しました。project=${companyId} / revision=${nextProfile.revision}`);
    } catch (error) {
      if (scopeRef.current !== companyId) return;
      const exact = error instanceof Error ? error.message : "project_profile_save_failed";
      setReadbackRequired(true);
      setNote(`保存結果を確認できません: ${exact}。「保存内容を照合」で読み直してください。保存要求は再送しません。`);
      model.setReceipt(`表示profileの保存を確認できませんでした: ${exact}`);
    } finally {
      mutationRef.current = false;
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
          <label><span className="field-label">種類</span><select data-control-id="truthful.performance.profile.field.kind" aria-label="表示profileの種類" value={draft.kind} onChange={(event) => update("kind", event.target.value)}><option value="research">調査</option><option value="jobs">応募</option><option value="commerce">商品</option><option value="social">SNS</option><option value="operations">運用</option></select></label>
          <label><span className="field-label">表示名</span><input data-control-id="truthful.performance.profile.field.label" aria-label="表示profileの表示名" value={draft.label} onChange={(event) => update("label", event.target.value)} /></label>
          <label><span className="field-label">鮮度SLA（分）</span><input data-control-id="truthful.performance.profile.field.freshness-sla" aria-label="表示profileの鮮度SLA（分）" type="number" min="1" value={draft.freshnessSlaMinutes} onChange={(event) => update("freshnessSlaMinutes", event.target.value)} placeholder="未設定" /></label>
          <label><span className="field-label">グルーピング</span><select data-control-id="truthful.performance.profile.field.grouping" aria-label="表示profileのグルーピング" value={draft.preferredGrouping} onChange={(event) => update("preferredGrouping", event.target.value)}><option value="day">日</option><option value="week">週</option><option value="workflow">workflow</option><option value="stage">stage</option></select></label>
          <label className="span-2"><span className="field-label">主要KPI（カンマ区切り）</span><input data-control-id="truthful.performance.profile.field.primary-metrics" aria-label="表示profileの主要KPI" value={draft.primaryMetrics} onChange={(event) => update("primaryMetrics", event.target.value)} /></label>
          <label className="span-2"><span className="field-label">widget（カンマ区切り）</span><input data-control-id="truthful.performance.profile.field.widgets" aria-label="表示profileのwidget" value={draft.widgets} onChange={(event) => update("widgets", event.target.value)} placeholder="kpi, timeline, failure_table" /></label>
          <label className="span-2"><span className="field-label">目的</span><textarea data-control-id="truthful.performance.profile.field.purpose" aria-label="表示profileの目的" value={draft.purpose} onChange={(event) => update("purpose", event.target.value)} /></label>
          <label className="span-2"><span className="field-label">Browser Use lane</span><textarea data-control-id="truthful.performance.profile.field.browser-use-lane" aria-label="表示profileのBrowser Use lane" value={draft.browserUseLane} onChange={(event) => update("browserUseLane", event.target.value)} /></label>
          <label className="span-2"><span className="field-label">停止境界</span><textarea data-control-id="truthful.performance.profile.field.stop-boundary" aria-label="停止境界" value={draft.stopBoundary} onChange={(event) => update("stopBoundary", event.target.value)} /></label>
          <label className="span-2"><span className="field-label">説明</span><textarea data-control-id="truthful.performance.profile.field.explanation" aria-label="表示profileの説明" value={draft.explanation} onChange={(event) => update("explanation", event.target.value)} /></label>
        </div>
        <div className="button-row"><Button controlId="truthful.performance.profile.save" variant="primary" onClick={() => { void save(); }} disabled={saving || readbackRequired}>{saving ? "確認中" : "表示profileを保存"}</Button>
          <Button controlId="truthful.performance.profile.reconcile" onClick={() => { void reconcile(); }} disabled={saving}>保存内容を照合</Button></div>
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
  const chartRows = rows
    .filter((row) => row.label.trim() && Number.isFinite(row.value) && row.value > 0)
    .slice(-14);
  if (!chartRows.length) return null;
  const max = Math.max(...chartRows.map((row) => row.value));
  return <div className="mini-bar-chart" aria-label="プロジェクト別実績グラフ">{chartRows.map((row) => <div className="mini-bar-row" key={row.label}><span>{row.label}</span><div className="mini-bar-track"><div className="mini-bar-fill" style={{ width: `${Math.min(100, Math.max(0, Math.round((row.value / max) * 100)))}%` }} /></div><strong>{row.value}</strong></div>)}</div>;
}

function validAnalyticsCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function validAnalyticsLabel(value: unknown): string | null {
  const label = String(value ?? "").trim();
  return label && label !== "未確認" ? label : null;
}

type PerformanceSeries = {
  title: string;
  emptyLabel: string;
  headers: string[];
  chartRows: Array<{ label: string; value: number }>;
  rows: React.ReactNode[][];
};

function performanceSeriesForGrouping(analytics: any, grouping: string): PerformanceSeries {
  if (grouping === "workflow") {
    const rows = (Array.isArray(analytics?.by_automation) ? analytics.by_automation : []).filter((row: any) => validAnalyticsLabel(row.automation_name ?? row.automation_id) && validAnalyticsCount(row.total_jobs) !== null);
    return {
      title: "Workflow別実績",
      emptyLabel: "表示できるWorkflow別bucketはありません。",
      headers: ["Workflow", "Job", "完了", "完了率", "更新"],
      chartRows: rows.map((row: any) => ({ label: String(row.automation_name ?? row.automation_id), value: validAnalyticsCount(row.total_jobs) as number })),
      rows: rows.map((row: any) => [row.automation_name ?? row.automation_id ?? "未確認", row.total_jobs, row.completed_jobs, formatRatio(row.completion_rate), row.last_updated_at ?? "-"])
    };
  }
  if (grouping === "stage") {
    const rows = (Array.isArray(analytics?.by_stage) ? analytics.by_stage : []).filter((row: any) => validAnalyticsLabel(stageLabel(row.stage)) && validAnalyticsCount(row.total_jobs) !== null);
    return {
      title: "状態・段階別実績",
      emptyLabel: "表示できる状態・段階別bucketはありません。",
      headers: ["状態", "Job", "完了", "未完了", "完了率"],
      chartRows: rows.map((row: any) => ({ label: stageLabel(row.stage), value: validAnalyticsCount(row.total_jobs) as number })),
      rows: rows.map((row: any) => [stageLabel(row.stage), row.total_jobs, row.completed_jobs, row.failed_jobs, formatRatio(row.completion_rate)])
    };
  }
  const dateRows = (Array.isArray(analytics?.by_date) ? analytics.by_date : []).filter((row: any) => validAnalyticsLabel(row.date) && validAnalyticsCount(row.total_jobs) !== null);
  if (grouping === "week") {
    const buckets = new Map<string, { total: number; completed: number; failed: number }>();
    for (const row of dateRows) {
      const key = isoWeekLabel(String(row.date ?? ""));
      if (!key) continue;
      const bucket = buckets.get(key) ?? { total: 0, completed: 0, failed: 0 };
      bucket.total += Number(row.total_jobs ?? 0);
      bucket.completed += Number(row.completed_jobs ?? 0);
      bucket.failed += Number(row.failed_jobs ?? 0);
      buckets.set(key, bucket);
    }
    const rows = [...buckets.entries()].map(([label, bucket]) => [label, bucket.total, bucket.completed, bucket.failed]);
    return {
      title: "週別実績",
      emptyLabel: "表示できる週別bucketはありません。",
      headers: ["週 (UTC)", "Job", "完了", "未完了"],
      chartRows: rows.filter((row) => validAnalyticsCount(row[1]) !== null).map((row) => ({ label: String(row[0]), value: validAnalyticsCount(row[1]) as number })),
      rows
    };
  }
  return {
    title: "日別実績",
    emptyLabel: "表示できる日別bucketはありません。",
    headers: ["日付 (UTC)", "Job", "完了", "未完了"],
    chartRows: dateRows.map((row: any) => ({ label: String(row.date), value: validAnalyticsCount(row.total_jobs) as number })),
    rows: dateRows.map((row: any) => [row.date, row.total_jobs, row.completed_jobs, row.failed_jobs])
  };
}

function isoWeekLabel(value: string): string | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function stageLabel(value: unknown): string {
  const labels: Record<string, string> = { queued: "待機", leased: "実行中", completed: "完了", failed: "失敗", cancelled: "キャンセル", timed_out: "タイムアウト", reconciliation_required: "照合待ち" };
  const raw = String(value ?? "");
  return labels[raw] ?? (raw || "未確認");
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
    // A project switch must not carry the previous project's date window or
    // automation filter into a new project's graph/readback.
    setFromDate(dateInputValue(Date.now() - 29 * 24 * 60 * 60 * 1000));
    setToDate(dateInputValue(Date.now()));
    setAutomationId("");
  }, [companyId]);
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
        if (result.company_scope?.enforced !== true || result.company_id !== companyId || result.company_scope.company_id !== companyId
          || result.query?.from !== from || result.query?.to !== to || (result.query?.automation_id ?? "") !== automationId) {
          throw new Error("company_analytics_readback_mismatch");
        }
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
  const grouping = profile?.preferredGrouping ?? "day";
  const performanceSeries = performanceSeriesForGrouping(analytics, grouping);
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="会社別パフォーマンス集計" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <ProjectPresentationProfilePanel model={model} companyId={companyId} />
      <Panel title="集計条件" controlId="truthful.performance.filter.panel">
        <div className="builder-grid">
          <label>開始日<input aria-label="開始日" data-control-id="truthful.performance.filter.from" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label>終了日<input aria-label="終了日" data-control-id="truthful.performance.filter.to" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
          <label>Automation<select aria-label="表示対象の自動化" data-control-id="truthful.performance.filter.automation" value={automationId} onChange={(event) => setAutomationId(event.target.value)}><option value="">全て</option>{automationOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <Button controlId="truthful.performance.refresh.button" onClick={() => setRefreshGeneration((value) => value + 1)}>再読込</Button>
        </div>
      </Panel>
      {analyticsStatus === "ready" && <Panel title="Run実績（durable Jobとは別集計）" controlId="truthful.performance.run-readback.panel">
        <p className="muted">登録業務のRunを含む、durable Jobに紐付かないRun記録です。下のJob集計とは重複しません。「完了状態」は保存されたRun statusで、業務完了の証明は個別Runのreceipt・照合結果で確認してください。作成日時と更新日時から実処理時間を推測しません。</p>
        {analytics?.run_readback?.source !== "runs_without_durable_job_lineage" ? <ReadbackState title="Run集計は未確認です" detail="現在のAPIからRun専用集計を取得できませんでした。0件とは扱いません。" tone="attention" />
          : analytics.run_readback.total_runs === 0 ? <ReadbackState title="この条件のRunは0件です" detail="会社・期間・Automationで絞り込んだ保存記録を確認しました。" tone="success" /> : <>
            <DataTable controlId="truthful.performance.run-readback.summary" headers={["Run総数", "完了状態", "処理中・待機中", "停止・失敗・取消", "最終更新"]} rows={[[analytics.run_readback.total_runs, analytics.run_readback.completed_runs,
              analytics.run_readback.active_runs, analytics.run_readback.stopped_runs, analytics.run_readback.last_updated_at ?? "未記録"]]} />
            <h3>日別Run（UTC）</h3>
            <MiniBarChart rows={(analytics.run_readback.by_date ?? []).map((row: any) => ({ label: row.date, value: row.total_runs }))} />
            <DataTable controlId="truthful.performance.run-readback.dates" headers={["日付（UTC）", "Run", "完了状態"]} rows={(analytics.run_readback.by_date ?? []).map((row: any) => [row.date, row.total_runs, row.completed_runs])} />
            <DataTable controlId="truthful.performance.run-readback.automations" headers={["Automation", "Run", "完了状態", "最終更新"]} rows={(analytics.run_readback.by_automation ?? []).map((row: any) => [row.automation_name, row.total_runs, row.completed_runs, row.last_updated_at ?? "未記録"])} />
          </>}
      </Panel>}
      {analyticsStatus === "loading" ? <Panel title="集計中" controlId="truthful.performance.loading.panel"><ReadbackState title="パフォーマンスを集計中" detail="会社別の永続Jobと承認記録を読み込んでいます。長く続く場合はAPI readbackの状態を確認してください。" tone="info" />
      </Panel> : analyticsStatus === "error" ? <Panel title="集計できませんでした" controlId="truthful.performance.error.panel"><ReadbackState title="最新の集計を取得できません" detail="前回値を最新値として残していません。条件を確認し、再読込してください。" tone="attention" nextAction="再読込ボタンで同じ条件を再確認する" />
      </Panel> : analytics?.data_state === "empty" || analytics?.metrics?.outcome?.availability !== "available" ? <Panel title="計測データなし" controlId="truthful.performance.empty.panel"><ReadbackState title="この期間に計測可能なJobがありません" detail="KPIやグラフは表示していません。承認記録など別の証跡があっても、Job実績としては集計しません。" nextAction="期間またはAutomationを変更する" />
      </Panel> : <>
        <p className="muted" data-control-id="truthful.performance.completion-boundary">ここでのJob・完了率はdurable Job statusの集計です。provider receipt・source sync・reconciliationが揃った業務完了とは別で、業務完了をclaimしません。</p>
        <div className="cards four">
          <MetricCard controlId="truthful.performance.metric.jobs" title="Job" value={String(outcome?.denominator ?? 0)} sub="durable_jobsのみ" status="enabled" />
          <MetricCard controlId="truthful.performance.metric.completion" title="完了率" value={formatRatio(outcome?.completion_rate)} sub={`${outcome?.numerator ?? 0}/${outcome?.denominator ?? 0}`} status={(outcome?.statuses?.failed ?? 0) > 0 ? "blocked" : "enabled"} />
          <MetricCard controlId="truthful.performance.metric.duration" title="平均所要時間" value={formatDuration(duration?.average)} sub={`sample ${duration?.sample_size ?? 0}`} status={duration?.availability === "available" ? "enabled" : "waiting"} />
          <MetricCard controlId="truthful.performance.metric.approval" title="承認平均時間" value={formatDuration(approvalLatency?.average)} sub={`sample ${approvalLatency?.sample_size ?? 0}`} status={approvalLatency?.availability === "available" ? "enabled" : "waiting"} />
        </div>
        {widgets.has("timeline") && <Panel title={performanceSeries.title} controlId="truthful.performance.series.panel">
          {performanceSeries.rows.length ? <>{performanceSeries.chartRows.length ? <MiniBarChart rows={performanceSeries.chartRows} /> : <p className="muted">グラフに使える有効な数値bucketはありません。</p>}<DataTable controlId="truthful.performance.series.table" headers={performanceSeries.headers} rows={performanceSeries.rows} /></> : <p className="muted">{performanceSeries.emptyLabel}</p>}
        </Panel>}
        {widgets.has("kpi") && grouping !== "workflow" && <Panel title="Automation別実績" controlId="truthful.performance.automation.panel">
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
          <p className="muted">Job集計の状態: {analytics.data_state} / 更新: {analytics.last_updated_at ?? "未計測"} / 対象期間: {analytics.query?.from} – {analytics.query?.to} / Job集計から除外したRun（上の別集計に表示）: {analytics.completeness?.excluded_legacy_runs ?? 0}</p>
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

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function proofExternalActionState(proof: any): boolean | undefined {
  const metadata = parseJsonRecord(proof?.metadata_json);
  const receipt = metadata.receipt && typeof metadata.receipt === "object" && !Array.isArray(metadata.receipt)
    ? metadata.receipt as Record<string, unknown> : parseJsonRecord(metadata.receipt);
  const candidates = [
    proof?.external_action_executed,
    proof?.externalActionExecuted,
    metadata.external_action_executed,
    metadata.externalActionExecuted,
    receipt.external_action_executed,
    receipt.externalActionExecuted
  ];
  return candidates.includes(true) ? true : candidates.find((value): value is boolean => typeof value === "boolean");
}

function runExternalActionReadback(run: any, proofs: any[]): { executed: boolean | null; unknown: boolean } {
  const metadata = parseJsonRecord(run?.metadata_json);
  const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : parseJsonRecord(value);
  const claim = record(metadata.remote_worker_claim);
  const receipt = record(metadata.remote_worker_receipt);
  const unknown = metadata.operation_effect_state === "unknown"
    || (metadata.exact_blocker === "portable_remote_claim_expired_without_receipt" && !receipt.run_id && claim.execution_mode !== "read_only");
  const candidates = [metadata.external_action_executed, run?.external_action_executed,
    receipt.external_action_executed, ...proofs.map(proofExternalActionState)];
  return { executed: candidates.includes(true) ? true : unknown ? null : candidates.includes(false) ? false : null, unknown };
}

function companyArtifactProofs(state: MvpState, companyId: string): any[] {
  const automationIds = new Set((state.automations ?? []).filter((item) => (item.company_id ?? item.project_id) === companyId).map((item) => item.id));
  const runIds = new Set((state.runs ?? []).filter((run) => {
    const scope = run.company_id ?? run.project_id;
    return scope ? scope === companyId : automationIds.has(run.automation_id);
  }).map((run) => run.id));
  return (state.proofs ?? []).filter((proof) => {
    const scope = proof.company_id ?? proof.project_id;
    return scope ? scope === companyId : runIds.has(proof.run_id);
  });
}

function TruthfulArtifactsPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const proofs = companyArtifactProofs(model.mvpState, companyId);
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="保存済み成果物 / Proof" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <ProjectPresentationProfileSummary model={model} companyId={companyId} context="artifacts" />
      <Panel title="Proof一覧" controlId="truthful.artifacts.proofs.panel">
        {model.mvpLoadStatus === "loading" || (model.mvpLoadStatus === "degraded" && model.mvpLoadBlocker === "mvp_state_detail_readback_pending") ? <ReadbackState title="成果物を確認中" detail="会社別の保存記録を読み込んでいます。" tone="info" />
          : model.mvpLoadStatus !== "ready" ? <ReadbackState title="成果物の最新状態を確認できません" detail="読取失敗を0件とは扱いません。上部の同期で再確認してください。" tone="attention" />
          : proofs.length ? <DataTable controlId="truthful.artifacts.proofs.table" headers={["ID", "Run", "種類", "状態", "作成日時", "開く"]} rows={proofs.map((proof) => [proof.id, proof.run_id ?? "-", proof.proof_type ?? proof.kind ?? "-", proof.status ?? "stored", proof.created_at ?? "-",
            proof.run_id ? <Button controlId={`truthful.artifacts.open.${proof.id}`} onClick={() => go(`#/projects/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(proof.run_id)}`)}>Runの成果物を開く</Button> : <span className="muted">Run未紐付けのため開けません</span>
          ])} /> : <ReadbackState title="保存済みProofは0件です" detail="この会社の保存記録を確認しました。固定サンプルや架空KPIは表示していません。" tone="success" />}
        <p className="muted">Runの結果ページで、該当Proofの「安全に開く」から内容を確認できます。古い成果物は作成日時を確認し、最新の業務結果とは区別してください。</p>
        <p className="muted" data-control-id="truthful.artifacts.completion-boundary">保存済みProofはreadbackの記録です。provider receipt・source sync・reconciliationが揃うまで業務完了をclaimしません。</p>
      </Panel>
    </section>
  );
}

async function requestCompanyRunDetail(companyId: string, runId: string, signal?: AbortSignal): Promise<RunDetail> {
  const detail = await fetchApiJson<RunDetail>(`/api/v1/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(runId)}`, { signal });
  if (detail.run?.id !== runId || (detail.run?.company_id ?? detail.run?.project_id) !== companyId) {
    throw new Error("run_detail_company_scope_mismatch");
  }
  return {
    ...detail,
    steps: (detail.steps ?? []).filter((step) => step.run_id === runId && (!step.company_id || step.company_id === companyId)),
    proofs: (detail.proofs ?? []).filter((proof) => proof.run_id === runId && (!proof.company_id || proof.company_id === companyId))
  };
}

function watchCompanyRunDetail(companyId: string, runId: string, signal: AbortSignal,
  onUpdate: (detail: RunDetail, checkedAt: string, watching: boolean) => void, onError: (error: unknown) => void): () => void {
  let stopped = false;
  let timer: number | undefined;
  let reads = 0;
  const read = async () => {
    try {
      const value = await requestCompanyRunDetail(companyId, runId, signal);
      if (stopped || signal.aborted) return;
      reads += 1;
      const watching = isRunActiveStatus(value.run.status) && reads < 120;
      onUpdate(value, new Date().toISOString(), watching);
      // Read only, serial and bounded. A failure never retries a Run or a
      // provider operation, and keeps the last verified result visible.
      if (watching) timer = window.setTimeout(() => { void read(); }, 2500);
    } catch (error) { if (!stopped && !signal.aborted) onError(error); }
  };
  void read();
  return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
}

function verifiedBusinessReceiptForRun(run: any): Record<string, any> | null {
  if (!run?.id || !isRunCompletedStatus(run.status)) return null;
  const metadata = parseJsonRecord(run.metadata_json);
  const receiptValue = metadata.remote_worker_receipt;
  if (!receiptValue || typeof receiptValue !== "object" || Array.isArray(receiptValue)) return null;
  const receipt = receiptValue as Record<string, any>;
  if (receipt.run_id !== run.id || receipt.status !== "complete"
    || receipt.business_proof_verified !== true || receipt.same_run_receipt !== true || receipt.same_run_source_sync !== true
    || receipt.readback_verified !== true || receipt.cleanup_verified !== true
    || receipt.adapter_result?.business_completion_verified !== true || receipt.adapter_result?.remote_verified !== true) return null;
  const companyId = run.company_id ?? run.project_id;
  if (!companyId || receipt.approval_receipt?.binding?.company_id !== companyId) return null;
  return receipt;
}

function businessReceiptSummary(receipt: Record<string, any>): string {
  if (receipt.workflow_id === "daily-ai-research-source-sync" && receipt.adapter_result?.local_receipt?.full_publish_completed === false && receipt.adapter_result?.local_receipt?.generation_performed === false) {
    return "調査・既存Sheets同期を確認（画像生成・公開なし）";
  }
  return "このRunで許可された処理の完了を確認";
}

function verifiedGmailReviewForRun(run: any): { fetched: number; proposals: number; items: Array<{ category: string; summary: string; reply: string | null }> | null } | null {
  if (!run?.id || !isRunCompletedStatus(run.status)) return null;
  const metadata = parseJsonRecord(run.metadata_json);
  const value = metadata.remote_worker_receipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, any>;
  const result = receipt?.adapter_result?.local_receipt?.review;
  const companyId = run.company_id ?? run.project_id;
  if (!companyId || metadata.external_action_executed === true || receipt?.run_id !== run.id || receipt.status !== "complete"
    || receipt.workflow_id !== "email-review-reply" || receipt.effects_mode !== "read_only"
    || receipt.read_only_proof_verified !== true || receipt.same_run_receipt !== true
    || receipt.readback_verified !== true || receipt.cleanup_verified !== true || receipt.external_action_executed !== false
    || result?.run_id !== run.id || result.company_id !== companyId || result.status !== "complete" || result.exact_blocker !== null
    || result.provider_read_observed !== true || result.messages_sent !== false || result.provider_drafts_created !== false
    || result.external_action_executed !== false) return null;
  const counts = result.diagnostics;
  if (!counts || !Number.isInteger(counts.fetched_count) || counts.fetched_count < 0 || counts.fetched_count > 100
    || counts.item_count !== counts.fetched_count || counts.unique_id_count !== counts.fetched_count
    || !Number.isInteger(counts.reply_candidate_count) || counts.reply_candidate_count < 0 || counts.reply_candidate_count > 5) return null;
  const synced = metadata.gmail_review_source_sync as Record<string, any> | undefined;
  const syncedResult = synced?.schema === "aos.gmail_review_source_sync.v1" && synced.run_id === run.id && synced.company_id === companyId
    && typeof result.review_hash === "string" && /^[a-f0-9]{64}$/u.test(result.review_hash)
    && synced.source_review_hash === result.review_hash && synced.review_result?.review_hash === result.review_hash
    && synced.review_result?.run_id === run.id && synced.review_result?.company_id === companyId
    && synced.review_result?.status === "complete" && synced.review_result?.messages_sent === false
    && synced.review_result?.provider_drafts_created === false && synced.review_result?.external_action_executed === false
    ? synced.review_result : null;
  const rows = (syncedResult ?? result).review?.items;
  const completeItems = Array.isArray(rows) && rows.length === counts.fetched_count
    && rows.every((item: any) => item && typeof item.message_id === "string" && item.message_id.trim()
      && typeof item.category === "string" && typeof item.summary === "string"
      && (item.reply_candidate === null || typeof item.reply_candidate === "string"))
    && new Set(rows.map((item: any) => item.message_id)).size === rows.length
    && rows.filter((item: any) => typeof item.reply_candidate === "string" && item.reply_candidate.trim()).length === counts.reply_candidate_count;
  return { fetched: counts.fetched_count, proposals: counts.reply_candidate_count,
    items: completeItems ? rows.map((item: any) => ({ category: redactSensitiveText(item.category).slice(0, 80),
      summary: redactSensitiveText(item.summary).slice(0, 240), reply: item.reply_candidate ? redactSensitiveText(item.reply_candidate).slice(0, 400) : null })) : null };
}

function verifiedObsidianAuditForRun(run: any): { summary: { projects: number; ok: number; attention: number; blocked: number }; projects: Array<Record<string, any>> | null; truncated: boolean; generatedAt: string | null } | null {
  if (!run?.id || !isRunCompletedStatus(run.status)) return null;
  const metadata = parseJsonRecord(run.metadata_json);
  const receipt = metadata.remote_worker_receipt as Record<string, any> | undefined;
  const value = receipt?.adapter_result?.local_receipt;
  const companyId = run.company_id ?? run.project_id;
  if (!companyId || !receipt || metadata.external_action_executed === true || receipt.run_id !== run.id || receipt.status !== "complete"
    || receipt.workflow_id !== "obsidian-project-memory-audit" || receipt.effects_mode !== "read_only"
    || receipt.read_only_proof_verified !== true || receipt.same_run_receipt !== true || receipt.readback_verified !== true
    || receipt.cleanup_verified !== true || receipt.external_action_executed !== false || value?.audit_only !== true
    || value.write_performed !== false || value.maintenance_performed !== false || value.git_sync_performed !== false) return null;
  const summary = value.audit_summary;
  if (!summary || ![summary.projects, summary.ok, summary.attention, summary.blocked].every((n) => Number.isInteger(n) && n >= 0)
    || summary.projects !== summary.ok + summary.attention + summary.blocked) return null;
  const rows = value.audit_projects;
  const truncated = value.audit_projects_truncated === true;
  const valid = value.audit_run_id === run.id && value.audit_company_id === companyId
    && typeof value.audit_generated_at === "string" && Number.isFinite(Date.parse(value.audit_generated_at))
    && typeof value.audit_projects_truncated === "boolean" && truncated === (summary.projects > 20)
    && Array.isArray(rows) && rows.length === Math.min(summary.projects, 20)
    && rows.every((row: any) => row && typeof row.project_id === "string" && row.project_id.trim()
      && typeof row.project_label === "string" && ["ok", "attention", "blocked"].includes(row.status)
      && typeof row.finding === "string" && typeof row.next_action === "string"
      && (row.state_updated_at === null || typeof row.state_updated_at === "string")
      && (row.latest_activity_at === null || typeof row.latest_activity_at === "string"))
    && new Set(rows.map((row: any) => row.project_id)).size === rows.length
    && (truncated || ["ok", "attention", "blocked"].every((status) => rows.filter((row: any) => row.status === status).length === summary[status]));
  return { summary, projects: valid ? rows : null, truncated: valid && truncated, generatedAt: valid ? value.audit_generated_at : null };
}

function portableProjectionForRun(run: any): PortableRunProjection | null {
  const stored = run?.portable_operation_projection ?? run?.operation_projection;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored as PortableRunProjection;
  const metadata = parseJsonRecord(run?.metadata_json);
  const bundleRecord = metadata.portable_input_bundle && typeof metadata.portable_input_bundle === "object" ? metadata.portable_input_bundle as Record<string, any> : null;
  const input = bundleRecord?.input && typeof bundleRecord.input === "object" ? bundleRecord.input as Record<string, any> : {};
  const invocation = metadata.portable_workflow_invocation && typeof metadata.portable_workflow_invocation === "object" ? metadata.portable_workflow_invocation as Record<string, any> : {};
  const source = metadata.source_snapshot && typeof metadata.source_snapshot === "object" ? metadata.source_snapshot as Record<string, any> : {};
  const first = (key: string, candidates: Array<[unknown, string]>) => { for (const [value, path] of candidates) if (typeof value === "string" && value.trim()) return [value, path] as const; return [null, null] as const; };
  const fields = { operation: first("operation", [[input.operation, "run.portable_input_bundle.input.operation"], [invocation.operation, "run.portable_workflow_invocation.operation"]]), account_ref: first("account_ref", [[input.account_ref, "run.portable_input_bundle.input.account_ref"]]), target_key: first("target_key", [[input.target_key, "run.portable_input_bundle.input.target_key"]]), payload_hash: first("payload_hash", [[input.payload_hash, "run.portable_input_bundle.input.payload_hash"]]), source_snapshot_id: first("source_snapshot_id", [[input.source_snapshot_id, "run.portable_input_bundle.input.source_snapshot_id"], [source.source_snapshot_id, "run.source_snapshot.source_snapshot_id"]]), vault_path: first("vault_path", [[input.vault_path, "run.portable_input_bundle.input.vault_path"], [source.vault_path, "run.source_snapshot.vault_path"]]), repository: first("repository", [[input.repository, "run.portable_input_bundle.input.repository"], [source.repository, "run.source_snapshot.repository"]]), branch: first("branch", [[input.branch, "run.portable_input_bundle.input.branch"], [source.branch, "run.source_snapshot.branch"]]) };
  const provenance = Object.fromEntries(Object.entries(fields).filter(([, pair]) => pair[0] && pair[1]).map(([key, pair]) => [key, pair[1] as string]));
  return { execution_mode_label: invocation.effect_stage === "business_execute" ? "業務実行" : invocation.execution_mode === "read_only" ? "読取専用" : "実行種別未確認", planned_operation_scope: { status: fields.operation[0] && fields.account_ref[0] && fields.target_key[0] && fields.payload_hash[0] && fields.source_snapshot_id[0] ? "planned" : "missing", operation: fields.operation[0], account_ref: fields.account_ref[0], target_key: fields.target_key[0], payload_hash: fields.payload_hash[0], source_snapshot_id: fields.source_snapshot_id[0], vault_path: fields.vault_path[0], repository: fields.repository[0], branch: fields.branch[0], provenance }, observed_results: { status: "not_acquired", operation: null, maintenance: null, export: null, git_sync: null, provenance: {} }, missing: Object.entries(fields).filter(([, pair]) => !pair[0]).map(([key]) => key), mismatches: [] };
}

function TruthfulRunDetailPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const runId = decodeURIComponent(route.split("/runs/")[1]?.split("/")[0] ?? "");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailCheckedAt, setDetailCheckedAt] = useState("");
  const [detailWatching, setDetailWatching] = useState(false);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [proofView, setProofView] = useState<ProofView | null>(null);
  const [selectedProofId, setSelectedProofId] = useState<string | null>(null);
  const detailKey = `${companyId}:${runId}`;
  const currentDetail = detail?.run?.id === runId && (detail.run.company_id ?? detail.run.project_id) === companyId ? detail : null;
  React.useEffect(() => {
    setDetail(null);
    setDetailError("");
    setDetailCheckedAt("");
    setSelectedProofId(null);
    setProofView(null);
  }, [detailKey]);
  React.useEffect(() => {
    const controller = new AbortController();
    setDetailError("");
    setDetailWatching(true);
    const stop = watchCompanyRunDetail(companyId, runId, controller.signal,
      (value, checkedAt, watching) => { setDetail(value); setDetailCheckedAt(checkedAt); setDetailWatching(watching); },
      (error) => { setDetailError(error instanceof Error ? error.message : "run_detail_unavailable"); setDetailWatching(false); });
    return () => { controller.abort(); stop(); };
  }, [detailKey, detailRefresh]);
  React.useEffect(() => {
    if (!selectedProofId || !currentDetail?.proofs.some((proof) => proof.id === selectedProofId && proof.can_open !== false)) return;
    const controller = new AbortController();
    setProofView(null);
    fetchApiJson<ProofView>(`/api/proofs/${encodeURIComponent(selectedProofId)}/view`, { signal: controller.signal })
      .then((view) => {
        if (view.id !== selectedProofId || view.run_id !== runId) throw new Error("proof_run_scope_mismatch");
        if (!controller.signal.aborted) setProofView(view);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProofView({ id: selectedProofId, run_id: runId, status: "blocked", blocked_reason: error instanceof Error ? error.message : "viewer_unavailable" });
      });
    return () => controller.abort();
  }, [detailKey, selectedProofId, currentDetail]);
  const run = currentDetail?.run ?? (model.mvpState.runs ?? []).find((item) => {
    if (item.id !== runId) return false;
    const automationCompanyId = model.mvpState.automations?.find((automation) => automation.id === item.automation_id)?.company_id
      ?? model.mvpState.automations?.find((automation) => automation.id === item.automation_id)?.project_id;
    return Boolean(companyId) && (item.company_id ?? item.project_id ?? automationCompanyId) === companyId;
  });
  const proofs = (currentDetail?.proofs ?? model.mvpState.proofs ?? []).filter((proof) => proof.run_id === runId
    && ((!proof.company_id && !proof.project_id) || (proof.company_id ?? proof.project_id) === companyId));
  if (!run) return <ProjectUnavailablePage loading={!detailError} reason={detailError ? "このRunは現在の会社別API readbackでは確認できません。" : "会社別の同一Run詳細を取得しています。"} />;
  const verifiedReceipt = currentDetail ? verifiedBusinessReceiptForRun(run) : null;
  const gmailReview = currentDetail ? verifiedGmailReviewForRun(run) : null;
  const obsidianAudit = currentDetail ? verifiedObsidianAuditForRun(run) : null;
  const runBlocker = runBlockerValue(run, model.mvpState) ?? "-";
  const publicRunBlocker = publicRunBlockerSummary(run, model.mvpState) || publicRunBlockerSummary(run);
  const externalAction = runExternalActionReadback(run, proofs);
  const externalActionLabel = externalAction.unknown ? externalAction.executed === true ? "あり（結果未確認・再送不可）" : "結果未確認（要照合・再送不可）"
    : externalAction.executed === false ? "なし（未実行）" : externalAction.executed === true ? verifiedReceipt ? "あり（照合済み）" : "あり（要確認）" : "未確認";
  const portableProjection = currentDetail ? portableProjectionForRun(run) : null;
  return (
    <section>
      <PageTitle title={`実行詳細: ${run.id}`} desc="永続化済みreadbackのみ表示" />
      <p className="muted" role="status">{detailError ? `詳細の更新失敗（${publicBlockerSummary(detailError)}）。直近の確認済み結果を表示中です。` : currentDetail ? "同一Runの詳細APIを確認済み" : "同一Runの詳細を取得中です。"}
        {detailCheckedAt && <> / 最終確認 {detailCheckedAt}</>}{detailWatching && " / 実行中は自動更新します"}</p>
      <Button controlId="truthful.run-detail.refresh" disabled={detailWatching} onClick={() => setDetailRefresh((value) => value + 1)}>同じRunの結果を再取得</Button>
      <Panel title="Run" controlId="truthful.run-detail.run.panel">
        <DataTable controlId="truthful.run-detail.run.table" headers={["自動化", "状態", "受付", "開始", "確認事項", "停止理由", "外部効果"]} rows={[[run.automation_name ?? model.mvpState.automations?.find((item) => item.id === run.automation_id)?.name ?? run.automation_id ?? "-", <StatusBadge status={isReadOnlyNoEffectReadbackComplete(run, model.mvpState) ? "waiting" : isRunCompletedStatus(run.status) ? "approved" : isRunStoppedStatus(run.status) ? "blocked" : run.status === "running" ? "running" : "waiting"} label={publicRunStatusForRun(run, model.mvpState)} />, run.queued_at ?? run.created_at ?? "-", run.started_at ?? currentDetail?.steps.find((step) => step.started_at)?.started_at ?? "-", publicRunBlocker, runBlocker === "-" ? "なし" : publicBlockerSummary(runBlocker), externalActionLabel]]} />
      </Panel>
      {portableProjection && <Panel title="Portable処理projection" controlId="truthful.run-detail.portable-projection">
        <DataTable controlId="truthful.run-detail.portable-projection.table" headers={["項目", "値", "来歴"]} rows={[
          ["実行種別", portableProjection.execution_mode_label ?? "実行種別未確認", "保存済み invocation.effect_stage / execution_mode"],
          ...Object.entries(portableProjection.planned_operation_scope ?? {}).filter(([key]) => key !== "provenance" && key !== "status").map(([key, value]) => [key, value == null ? "未取得" : String(value), portableProjection.planned_operation_scope?.provenance?.[key] ?? "未取得"] as [string, string, string]),
          ["planned scope", portableProjection.planned_operation_scope?.status ?? "missing", "projection"],
          ["observed results", portableProjection.observed_results?.status === "not_acquired" ? "not_acquired（receiptなし）" : portableProjection.observed_results?.status ?? "not_acquired", portableProjection.observed_results?.provenance?.operation ?? "同一Run receipt未取得"]
        ]} />
        {(portableProjection.missing ?? []).length > 0 && <p className="muted">未取得: {portableProjection.missing?.join(", ")}</p>}
        {(portableProjection.mismatches ?? []).length > 0 && <p className="action-note">不一致: {portableProjection.mismatches?.join(", ")}</p>}
      </Panel>}
      {externalAction.unknown && <p className="action-note" role="status">結果を受信できなかったことは「操作なし」の証明ではありません。同じRunのworker記録と実際の保存先を照合し、処理を再送しないでください。</p>}
      {verifiedReceipt && <p className="action-note" role="status">{businessReceiptSummary(verifiedReceipt)}。同一Runの実行記録・source同期・結果照合・cleanupを確認済みです。</p>}
      {gmailReview && <Panel title="Gmail確認結果（未送信）" controlId="truthful.run-detail.gmail-result">
        <p role="status">metadata {gmailReview.fetched}件の取得・分類を確認しました。未送信の返信案 {gmailReview.proposals}件（上限5件）。メール送信・Gmail下書き作成はしていません。</p>
        {gmailReview.proposals === 0 && <p>今回の確認では返信案の候補はありませんでした。</p>}
        {gmailReview.items ? <DataTable controlId="truthful.run-detail.gmail-items" headers={["分類", "要約", "返信案（未送信）"]} rows={gmailReview.items.map((item) => [item.category, item.summary, item.reply ?? "なし"])} />
          : <p className="muted">この保存記録では分類の本文が省略されています。件数は確認済みですが、全件の要約はまだAOSへ転送されていません。</p>}
        <small>metadataだけに基づく提案です。メール本文や添付ファイルの確認・送信の承認とは別です。</small>
      </Panel>}
      {obsidianAudit && <Panel title="Obsidian監査結果（読取のみ）" controlId="truthful.run-detail.obsidian-result">
        <p role="status">{obsidianAudit.summary.projects}プロジェクトを監査。要確認 {obsidianAudit.summary.attention}件 / 停止要因 {obsidianAudit.summary.blocked}件 / 問題なし {obsidianAudit.summary.ok}件。Vault更新・Git同期はしていません。</p>
        {obsidianAudit.generatedAt && <p className="muted">このRunの監査時刻: {obsidianAudit.generatedAt}</p>}
        {obsidianAudit.projects ? <DataTable controlId="truthful.run-detail.obsidian-projects" headers={["プロジェクト", "状態", "確認事項", "STATE更新", "最新活動", "次の操作"]} rows={obsidianAudit.projects.map((item) => [
          redactSensitiveText(item.project_label), item.status === "ok" ? "問題なし" : item.status === "attention" ? "要確認" : "停止要因",
          redactSensitiveText(item.finding), item.state_updated_at ?? "なし", item.latest_activity_at ?? "未確認", redactSensitiveText(item.next_action)
        ])} /> : <p>この過去のRunには件数集計だけが保存されています。個別の理由や次の操作を確認するには、新しい読取監査を依頼してください。過去の結果は書き換えません。</p>}
        {obsidianAudit.truncated && <p>要対応を優先して先頭20プロジェクトを表示しています。全件の表示ではありません。</p>}
      </Panel>}
      {currentDetail && <Panel title="手順" controlId="truthful.run-detail.steps.panel"><DataTable controlId="truthful.run-detail.steps.table" headers={["手順", "状態", "開始", "完了"]} rows={currentDetail.steps.map((step) => [step.name ?? step.id, publicRunStatus(step.status), step.started_at ?? "-", step.completed_at ?? "-"])} /></Panel>}
      <Panel title="確認記録" controlId="truthful.run-detail.proof.panel">
        <DataTable controlId="truthful.run-detail.proof.table" headers={["ID", "種類", "状態", "業務完了判定", "表示"]} rows={proofs.length ? proofs.map((proof) => [proof.id, proof.proof_type ?? proof.kind ?? "-", publicProofStatus(proof.status ?? (currentDetail ? "stored" : undefined)), verifiedReceipt && (proof.proof_type ?? proof.kind) === "worker_receipt" ? "このRunの処理完了を確認" : "未claim", <Button controlId={`truthful.run-detail.proof.${proof.id}`} disabled={!currentDetail || proof.can_open === false} onClick={() => setSelectedProofId(proof.id)}>安全に開く</Button>]) : [["保存済み確認記録なし", "-", "-", "未claim", "-"]]} />
        <p className="muted">確認記録はreadbackの記録です。provider receipt・source sync・reconciliationが揃うまで業務完了をclaimしません。読取確認の完了と生成・公開の完了は別です。</p>
        {selectedProofId && !proofView && <p role="status">確認記録を取得中です。</p>}
        {proofView?.run_id === runId && proofView.id === selectedProofId && <div className="preview-box" role="region" aria-label="確認記録プレビュー">
          <strong>{proofView.label ?? "確認記録"}</strong>
          {proofView.status === "ok" && proofView.preview && <pre>{redactDisplayPaths(proofView.preview)}</pre>}
          {proofView.status !== "ok" && <p>{publicBlockerSummary(proofView.blocked_reason)}</p>}
          {proofView.truncated && <small>安全のため先頭部分のみ表示しています。</small>}
        </div>}
      </Panel>
      <div className="button-row">
        {currentDetail && run.status === "waiting_approval" && <Button controlId="truthful.run-detail.open-approval" onClick={() => go(`#/approvals?run_id=${encodeURIComponent(runId)}&company_id=${encodeURIComponent(companyId)}`)}>このRunの承認を確認</Button>}
        <Button controlId="truthful.run-detail.open-recovery" onClick={() => go(`#/projects/${encodeURIComponent(companyId)}/recovery?run_id=${encodeURIComponent(runId)}`)}>会社別の復旧画面を開く</Button>
      </div>
      <p className="muted">復旧画面はこの会社とRunを引き継ぎます。実行前のキャンセル、外部効果なしを確認できたRunの再試行だけを提示します。完了済み・結果不明の処理は再送しません。</p>
    </section>
  );
}

async function requestPortableRunRecovery(companyId: string, runId: string) {
  const body = await fetchApiJson<{ recovery: any }>(`/api/v1/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(runId)}/recovery`);
  const row = body?.recovery;
  if (!row || row.schema !== "aos.portable_run_recovery.v1" || row.company_id !== companyId || row.run_id !== runId
    || typeof row.readback_token !== "string") throw new Error("portable_recovery_readback_mismatch");
  return row;
}

function portableRecoveryReason(code: unknown): string {
  const reasons: Record<string, string> = {
    portable_recovery_effect_already_executed: "外部効果が実行済みです。同じ処理は再送しません。",
    portable_recovery_effect_unconfirmed: "外部結果が未確認です。同じRunのreceipt・保存先を先に照合してください。",
    portable_recovery_worker_claim_active: "workerが実行を受付済みです。同じRunの結果を確認してください。",
    portable_recovery_registration_changed: "元の登録内容・versionが変更またはアーカイブされています。Builderで内容を確認し、新しい依頼を作ってください。",
    portable_recovery_run_not_cancellable: "未受付の実行前Runだけをキャンセルできます。",
    portable_recovery_run_not_retryable: "停止・失敗・キャンセル済みで、外部効果なしを確認できたRunだけ再試行できます。",
    portable_recovery_retry_already_prepared: "このRunの再試行は作成済みです。新しいRunの結果を開いてください。",
    portable_recovery_retry_preparing: "前の要求は記録されていますが、新しいRunの準備完了は未確認です。同じRunを照合してください。",
    portable_recovery_workflow_unsupported: "このRunは登録済み5業務のMac worker処理ではありません。下のJob記録またはRun詳細を確認してください。"
  };
  return code ? reasons[String(code)] ?? publicBlockerSummary(code) : "操作できます";
}

function recoveryRunOptionStatus(run: any, recovery: any, companyId: string): string {
  return String(recovery?.company_id === companyId && recovery?.run_id === run.id
    && typeof recovery.status === "string" ? recovery.status : run.status ?? "unknown");
}

function TruthfulRecoveryPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const requestedRunId = new URLSearchParams(route.split("?")[1] ?? "").get("run_id") ?? "";
  const [recovery, setRecovery] = useState<any>(null);
  const [recoveryReadStatus, setRecoveryReadStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [runActionBusy, setRunActionBusy] = useState(false);
  const [runReadbackRequired, setRunReadbackRequired] = useState(false);
  const [runNote, setRunNote] = useState("Runを選ぶと実行状態と可能な操作を確認します。");
  const runMutationRef = useRef(false);
  const recoveryReadGeneration = useRef(0);
  const companyRuns = (model.mvpState.runs ?? []).filter((run: any) => String(run.company_id ?? "") === companyId);
  const jobs = (model.mvpState.jobs ?? []).filter((job) => String(job.company_id ?? "") === companyId);
  const attempts = model.mvpState.job_attempts ?? [];
  const selectedRunIsScoped = companyRuns.some((run: any) => run.id === requestedRunId);
  const canMutateJob = ["owner", "admin", "operator"].includes(projectOptionsFromState(model.mvpState).find((company) => company.id === companyId)?.role ?? "viewer");
  const [mutatingJobId, setMutatingJobId] = useState<string | null>(null);
  const [note, setNote] = useState("会社別のdurable job readbackから復旧候補を確認しています。");
  const retryIdempotencyRef = useRef<Record<string, string>>({});
  const refreshRun = async () => {
    if (!requestedRunId) {
      recoveryReadGeneration.current += 1;
      setRecovery(null); setRecoveryReadStatus("idle");
      setRunNote("Runを選ぶと実行状態と可能な操作を確認します。");
      return null;
    }
    const generation = ++recoveryReadGeneration.current;
    setRecoveryReadStatus("loading");
    setRunNote(`${requestedRunId} の保存状態を読み込んでいます。処理は再送しません。`);
    try {
      const value = await requestPortableRunRecovery(companyId, requestedRunId);
      if (generation !== recoveryReadGeneration.current) return null;
      setRecovery(value);
      setRecoveryReadStatus("ready");
      setRunReadbackRequired(false);
      setRunNote(`同じRunの保存状態を確認: ${value.status} / ${actionStamp()}（処理の再送なし）`);
      return value;
    } catch (error) {
      if (generation !== recoveryReadGeneration.current) return null;
      setRecoveryReadStatus("error");
      setRunReadbackRequired(true);
      setRunNote(`Runの最新状態を確認できません: ${publicBlockerSummary(error instanceof Error ? error.message : "readback_failed")}`);
      return null;
    }
  };
  useEffect(() => {
    setRecovery(null);
    setRunReadbackRequired(false);
    void refreshRun();
    return () => { recoveryReadGeneration.current += 1; };
  }, [companyId, requestedRunId]);
  const mutateRun = async (action: "cancel" | "retry") => {
    if (runMutationRef.current || runReadbackRequired || recoveryReadStatus !== "ready" || !canMutateJob
      || recovery?.run_id !== requestedRunId || recovery?.company_id !== companyId
      || !(action === "cancel" ? recovery.can_cancel : recovery.can_retry)) return;
    runMutationRef.current = true;
    setRunActionBusy(true);
    setRunNote("1回だけ要求し、保存された同じRunの状態を確認しています。");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(requestedRunId)}/recovery/${action}`, {
        method: "POST", headers: { "content-type": "application/json", ...(action === "retry" ? { "idempotency-key": `portable-retry-${requestedRunId}` } : {}) },
        body: JSON.stringify({ expected_readback_token: recovery.readback_token })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "portable_recovery_action_unconfirmed");
      const saved = await refreshRun();
      if (!saved || (action === "cancel" ? saved.status !== "cancelled"
        : !saved.retry?.result_confirmed || saved.retry.run_id !== body.retry_run?.id)) throw new Error("portable_recovery_action_readback_mismatch");
      setRunNote(action === "cancel" ? "キャンセル保存と未実行Runの停止を確認しました。履歴は保持しています。"
        : saved.requires_fresh_approval ? "新しいRunと承認待ちを保存しました。新しいRunの対象・内容を確認して承認してください。旧承認は再利用しません。"
        : "新しいRunを1件受付しました。Mac workerでの処理結果は新しいRunで確認してください。");
    } catch (error) {
      setRunReadbackRequired(true);
      setRunNote(`操作結果を確定できません: ${publicBlockerSummary(error instanceof Error ? error.message : "action_unconfirmed")}。再送せず「同じRunを照合」で確認してください。`);
    } finally {
      runMutationRef.current = false;
      setRunActionBusy(false);
    }
  };
  const reconcileBackupEvidence = async () => {
    if (runMutationRef.current || runReadbackRequired || recoveryReadStatus !== "ready" || !canMutateJob
      || recovery?.run_id !== requestedRunId || recovery?.company_id !== companyId
      || recovery?.can_reconcile_backup_evidence !== true) return;
    runMutationRef.current = true;
    setRunActionBusy(true);
    setRunNote("バックアップの保存済み証拠だけを1回受付し、同じRunの結果を確認しています。providerは再実行しません。");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(requestedRunId)}/recovery/reconcile-post-effect`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": `portable-backup-post-effect-${requestedRunId}` },
        body: JSON.stringify({ expected_readback_token: recovery.readback_token })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "portable_backup_evidence_reconcile_unconfirmed");
      const saved = await refreshRun();
      if (!saved || saved.run_id !== requestedRunId || saved.company_id !== companyId
        || !["queued", "claimed", "verified", "blocked"].includes(String(saved.backup_post_effect_reconciliation?.status))) {
        throw new Error("portable_backup_evidence_reconcile_readback_mismatch");
      }
      setRunNote("バックアップ証拠の照合要求を保存しました。Mac workerのevidence-only結果を同じRunで確認します。");
    } catch (error) {
      setRunReadbackRequired(true);
      setRunNote(`バックアップ証拠の結果を確定できません: ${publicBlockerSummary(error instanceof Error ? error.message : "reconcile_unconfirmed")}。再送せず同じRunを照合してください。`);
    } finally {
      runMutationRef.current = false;
      setRunActionBusy(false);
    }
  };
  useEffect(() => {
    if (model.mvpLoadStatus === "ready") {
      setNote(`会社別durable job readback確認済み: jobs=${jobs.length} / external_action=false`);
    } else if (model.mvpLoadStatus === "error") {
      setNote("Recovery readback未確認: 現在の表示を最新状態とは断定しません / external_action=false");
    }
  }, [model.mvpLoadStatus, companyId, jobs.length]);
  const refresh = async () => {
    try {
      const state = await readMvpState("ui", { fresh: true });
      model.setMvpState(state);
      model.setAutomationRows(toAutomationRows(state.automations ?? []));
      const scopedJobs = (state.jobs ?? []).filter((job: any) => String(job.company_id ?? "") === companyId);
      model.setReceipt(`Recovery readback 済みです。company=${companyId} / jobs=${scopedJobs.length}`);
      setNote(`再読込完了: jobs=${scopedJobs.length} / ${actionStamp()}`);
    } catch {
      model.setReceipt("Recovery readbackに失敗しました。最新状態は確認できていません。");
      setNote(`再読込失敗: 現在の表示は最新と断定できません / ${actionStamp()}`);
    }
  };
  const mutateJob = async (job: any, action: "cancel" | "retry") => {
    if (mutatingJobId === job.id) return;
    setMutatingJobId(job.id);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (action === "retry") {
        const fingerprint = `${job.company_id}:${job.id}:${job.status}:${job.attempt_count ?? 0}`;
        headers["idempotency-key"] = retryIdempotencyRef.current[fingerprint]
          ?? (retryIdempotencyRef.current[fingerprint] = newIdempotencyKey("ui-recovery-retry"));
      }
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/jobs/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        headers,
        body: "{}"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `${action}_failed`);
      model.setReceipt(`${job.id}: ${action === "retry" ? "再試行キュー登録" : "キャンセル"}を保存しました。`);
      setNote(`${job.id}: ${action} / status=${body.job?.status ?? "unknown"} / ${actionStamp()}`);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : `${action}_failed`;
      model.setReceipt(`${job.id}: 操作に失敗しました（${publicBlockerSummary(message)}）。`);
      setNote(`${job.id}: ${action}失敗 / ${publicBlockerSummary(message)} / ${actionStamp()}`);
    } finally {
      setMutatingJobId(null);
    }
  };
  const attemptsByJob = new Map<string, any[]>();
  for (const attempt of attempts) {
    const jobId = String(attempt.job_id ?? "");
    if (!jobId) continue;
    const current = attemptsByJob.get(jobId) ?? [];
    current.push(attempt);
    attemptsByJob.set(jobId, current);
  }
  const recoveryJobs = jobs.filter((job) => ["failed", "timed_out", "reconciliation_required"].includes(String(job.status)));
  const pendingJobs = jobs.filter((job) => ["queued", "leased"].includes(String(job.status)));
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={`${companyName} / 復旧`} desc="同じ会社・Runの結果を照合し、実行前キャンセルと安全な再試行を行います" >
        <Button controlId="truthful.recovery.refresh" icon={<RefreshCw size={15} />} onClick={() => { void refresh(); }}>再読込</Button>
      </PageTitle>
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <Panel title="登録済み業務のRun復旧" controlId="truthful.recovery.portable.panel">
        <label>確認するRun <select data-control-id="truthful.recovery.portable.select" aria-label="復旧するRun" value={selectedRunIsScoped ? requestedRunId : ""}
          disabled={runActionBusy} onChange={(event) => go(`#/projects/${encodeURIComponent(companyId)}/recovery?run_id=${encodeURIComponent(event.target.value)}`)}>
          <option value="">Runを選択してください</option>
          {companyRuns.map((run: any) => <option key={run.id} value={run.id}>{run.name ?? run.id} / {run.id} / {publicRunStatus(recoveryRunOptionStatus(run, recovery, companyId))}</option>)}
        </select></label>
        {requestedRunId && !selectedRunIsScoped && <p className="action-note" role="status">指定されたRunは現在の会社別summaryにありません。未照合のRunは表示・操作しません。</p>}
        <p role="status">{runNote}</p>
        {requestedRunId && selectedRunIsScoped && <div className="button-row">
          <Button controlId="truthful.recovery.portable.refresh" disabled={runActionBusy || recoveryReadStatus === "loading"} onClick={() => { void refreshRun(); }}>同じRunを照合</Button>
          <Button controlId="truthful.recovery.portable.open-run" onClick={() => go(`#/projects/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(requestedRunId)}`)}>元のRunを開く</Button>
        </div>}
        {recovery?.run_id === requestedRunId && recovery?.company_id === companyId && <>
          <DataTable controlId="truthful.recovery.portable.table" headers={["確認項目", "保存された状態"]} rows={[
            ["Run / 会社", `${recovery.run_id} / ${recovery.company_id}`],
            ["業務 / version", `${recovery.workflow_id} / ${recovery.automation_version_id ?? "未確認"}`],
            ["状態 / 最終照合", `${publicRunStatus(recovery.status)} / ${approvalDueLabel(recovery.checked_at)}`],
            ["外部効果", recovery.external_action_executed === true ? "実行済み・再送不可" : recovery.external_action_executed === false ? "なしを確認" : "結果未確認・照合が必要"],
            ["固定対象 / account", `${recovery.target_key ?? "登録済み読取処理"} / ${recovery.account_ref ?? "元の登録を保持"}`],
            ["キャンセル", portableRecoveryReason(recovery.cancel_blocker)],
            ["再試行", portableRecoveryReason(recovery.retry_blocker)]
          ]} />
          <p className="muted">キャンセルはworkerが未受付のRunを停止します。再試行は元の会社・登録version・処理範囲を保持した新しいRunを1件作り、旧Runの結果は変更しません。書込処理は新しい対象承認が必要です。完了済み・外部結果不明・実行中の処理は再送しません。</p>
          {recoveryReadStatus !== "ready" && <p>表示は最新状態と未照合です。操作は停止しています。</p>}
          <div className="button-row">
            {canMutateJob && recovery.can_cancel && <Button controlId="truthful.recovery.portable.cancel" variant="danger"
              disabled={runActionBusy || runReadbackRequired || recoveryReadStatus !== "ready"} onClick={() => { void mutateRun("cancel"); }}>実行前キャンセル</Button>}
            {canMutateJob && recovery.can_retry && <Button controlId="truthful.recovery.portable.retry" variant="primary"
              disabled={runActionBusy || runReadbackRequired || recoveryReadStatus !== "ready"} onClick={() => { void mutateRun("retry"); }}>
              {recovery.requires_fresh_approval ? "新しいRunと承認を準備" : "新しいRunで再試行"}</Button>}
            {canMutateJob && recovery.can_reconcile_backup_evidence && <Button controlId="truthful.recovery.portable.backup-post-effect" variant="primary"
              disabled={runActionBusy || runReadbackRequired || recoveryReadStatus !== "ready"} onClick={() => { void reconcileBackupEvidence(); }}>
              バックアップの結果を回収</Button>}
            {recovery.retry?.result_confirmed && <Button controlId="truthful.recovery.portable.open-retry"
              onClick={() => go(`#/projects/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(recovery.retry.run_id)}`)}>再試行Runの結果を開く</Button>}
          </div>
          {!canMutateJob && <p>現在の会社権限は閲覧のみです。</p>}
        </>}
      </Panel>
      <div className="action-note" role="status">{note}</div>
      <div className="cards four">
        <MetricCard controlId="truthful.recovery.metric.recovery" title="要確認Job" value={String(recoveryJobs.length)} sub="failed / timeout / reconciliation" status={recoveryJobs.length ? "blocked" : "enabled"} />
        <MetricCard controlId="truthful.recovery.metric.pending" title="待機Job" value={String(pendingJobs.length)} sub="queued / leased" status={pendingJobs.length ? "waiting" : "enabled"} />
        <MetricCard controlId="truthful.recovery.metric.attempts" title="試行記録" value={String(attempts.filter((attempt) => String(attempt.company_id ?? "") === companyId || jobs.some((job) => job.id === attempt.job_id)).length)} sub="保存済みattempt" status="enabled" />
        <MetricCard controlId="truthful.recovery.metric.external" title="再試行の実行先" value="worker" sub="受付と処理完了は別に確認" status="enabled" />
      </div>
      <Panel title="復旧候補" controlId="truthful.recovery.jobs.panel">
        <p className="muted">以下は別系統のdurable job記録です。再試行を受付するとworkerが保存済みの処理契約に従って実行します。受付だけでは業務完了ではありません。</p>
        {recoveryJobs.length ? <DataTable controlId="truthful.recovery.jobs.table" headers={["Job", "状態", "試行", "最後のエラー", "更新", "操作"]} rows={recoveryJobs.map((job) => {
          const jobAttempts = attemptsByJob.get(String(job.id)) ?? [];
          const canCancel = ["timed_out"].includes(String(job.status));
          const canRetry = ["failed", "timed_out"].includes(String(job.status));
          return [
            <a data-control-id={`truthful.recovery.job.${job.id}`} href={`#/projects/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(job.run_id)}`}>{job.id}</a>,
            <StatusBadge status={job.status === "failed" || job.status === "timed_out" || job.status === "reconciliation_required" ? "blocked" : "waiting"} label={publicRunStatus(job.status)} />,
            `${job.attempt_count ?? 0}/${job.max_attempts ?? "-"} (${jobAttempts.length})`,
            job.last_error ? publicBlockerSummary(job.last_error) : "なし",
            job.updated_at ?? "-",
            canMutateJob && (canRetry || canCancel) ? <div className="button-row">
              {canRetry && <Button controlId={`truthful.recovery.retry.${job.id}`} variant="primary" disabled={mutatingJobId === job.id} onClick={() => { void mutateJob(job, "retry"); }}>{mutatingJobId === job.id ? "保存確認中" : "再試行"}</Button>}
              {canCancel && <Button controlId={`truthful.recovery.cancel.${job.id}`} variant="danger" disabled={mutatingJobId === job.id} onClick={() => { void mutateJob(job, "cancel"); }}>{mutatingJobId === job.id ? "保存確認中" : "キャンセル"}</Button>}
            </div> : <span data-control-id={`truthful.recovery.read-only.${job.id}`}>{String(job.status) === "reconciliation_required" ? "照合待ちのため操作なし" : "閲覧のみ"}</span>
          ];
        })} /> : <ReadbackState title="復旧候補はありません" detail="現在の会社別readbackにfailed・timeout・照合待ちのJobはありません。未確認のJobや架空のLane競合は表示していません。" tone="success" nextAction="新しい問題が出た場合は、Run詳細からこの画面を開く" />}
      </Panel>
      <Panel title="復旧できない状態" controlId="truthful.recovery.boundary.panel">
        <DataTable controlId="truthful.recovery.boundary.table" headers={["状態", "扱い", "理由"]} rows={[
          ["reconciliation_required", "外部readback未確定", "外部効果の有無を確認せず再実行しない"],
          ["completed / cancelled", "操作なし", "終端状態のため変更しない"],
          ["Lane起動 / lock解除", "未提供", "会社別の実Runner契約がまだない"]
        ]} />
      </Panel>
    </section>
  );
}

function TruthfulPluginsPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const capabilities = model.mvpState.codexCapabilities;
  const surfaces = [capabilities?.browser, capabilities?.chrome, capabilities?.mcp, capabilities?.appServer, capabilities?.cli, capabilities?.automationOsApi].filter((surface): surface is CapabilitySurface => Boolean(surface));
  const companies = projectOptionsFromState(model.mvpState);
  const requestedCompanyId = useMemo(() => projectSlugFromRoute(route) || chatRouteContext(route).companyId || chatRouteContext(route).projectId, [route]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => resolveProjectSelection(model.mvpState, requestedCompanyId));
  const [activeTab, setActiveTab] = useState<"all" | "plugin" | "skill" | "mcp" | "cli" | "api">("all");
  const [query, setQuery] = useState("");
  const [accountRefs, setAccountRefs] = useState<any[]>([]);
  const [accountRefsStatus, setAccountRefsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [busyToolId, setBusyToolId] = useState<string | null>(null);
  const [pluginAuthUrls, setPluginAuthUrls] = useState<Record<string, string[]>>({});
  const [pluginAuthPoll, setPluginAuthPoll] = useState<Record<string, PluginAuthPollState>>({});
  const [companyAccountRef, setCompanyAccountRef] = useState(() => window.sessionStorage.getItem("aos-plugin-account-ref") ?? "");
  const [companyAccountScopes, setCompanyAccountScopes] = useState(() => window.sessionStorage.getItem("aos-plugin-account-scopes") ?? "read,write");
  const pluginAuthPollGeneration = useRef<Record<string, number>>({});
  const pluginAuthCompany = useRef(selectedCompanyId);
  pluginAuthCompany.current = selectedCompanyId;
  const [authWizardPluginId, setAuthWizardPluginId] = useState<string | null>(() => window.sessionStorage.getItem("aos-plugin-wizard-selection"));
  React.useEffect(() => {
    if (authWizardPluginId) window.sessionStorage.setItem("aos-plugin-wizard-selection", authWizardPluginId);
  }, [authWizardPluginId]);
  const [gmailCanary, setGmailCanary] = useState<GmailReadOnlyCanaryReadback | null>(null);
  const [gmailCanaryStatus, setGmailCanaryStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [zeaburRegistry, setZeaburRegistry] = useState<ZeaburConnectorRegistryReadback | null>(null);
  const [zeaburRegistryStatus, setZeaburRegistryStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [codexAuth, setCodexAuth] = useState<any>(null);
  const [codexAuthConnection, setCodexAuthConnection] = useState<any>(null);
  const [codexAuthStatus, setCodexAuthStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [codexAuthError, setCodexAuthError] = useState<string | null>(null);
  const codexAuthReadGeneration = useRef(0);
  const runtime = model.mvpState.browser_use_runtime;
  const selectedBackend = runtime?.backend ?? model.mvpState.web_operation_backend?.backend;
  const chromeReadback = runtime?.chromePluginReadback;
  const chromeReadbackBlocker = chromeReadback?.exactBlocker ?? runtime?.exactBlocker ?? null;
  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);
  const canManageCompany = selectedCompany?.role === "owner" || selectedCompany?.role === "admin";
  const toolPreference = model.mvpState.capabilityRouter?.toolPreference;
  const catalog = useMemo(() => {
    const items: Array<CapabilityItem & { catalogKind: "plugin" | "skill" | "mcp" | "cli" | "api" }> = [];
    const pluginIndexes = new Map<string, number>();
    const pluginSourceRank = (item: CapabilityItem) => item.catalogSource === "official" ? 3 : item.catalogSource === "installed" ? 2 : 1;
    const addPlugin = (item: CapabilityItem & { catalogKind: "plugin" }) => {
      const key = normalizedPluginName(item.name);
      const existingIndex = pluginIndexes.get(key);
      if (existingIndex === undefined) {
        pluginIndexes.set(key, items.length);
        items.push(item);
        return;
      }
      const existing = items[existingIndex];
      if (existing.catalogSource === "official" && existing.state.configured && !item.state.configured) return;
      if (pluginSourceRank(item) < pluginSourceRank(existing)) return;
      // The remote Codex Server registry is the authoritative source for the
      // exact remote plugin id, marketplace, and auth policy. Merge it over
      // the static catalog entry so every available Plugin gets the same
      // install/auth button as Codex App without showing duplicates.
      items[existingIndex] = {
        ...existing,
        ...item,
        state: item.state,
        pluginId: item.pluginId ?? existing.pluginId,
        marketplaceName: item.marketplaceName ?? existing.marketplaceName,
        authPolicy: item.authPolicy ?? existing.authPolicy,
        installHint: item.installHint ?? existing.installHint
      };
    };
    for (const item of capabilities?.plugins ?? []) addPlugin({ ...item, catalogSource: item.catalogSource ?? "installed", catalogKind: "plugin" });
    for (const item of capabilities?.availablePlugins ?? []) {
      addPlugin({ ...item, catalogSource: item.catalogSource ?? "recommended", catalogKind: "plugin" });
    }
    for (const item of zeaburRegistry?.pluginRegistry?.installed ?? []) {
      if (!item.name) continue;
      const verified = item.authStatus === "verified";
      addPlugin({
        id: `zeabur:plugin:${item.id ?? item.name}`,
        name: item.name,
        path: `zeabur://codex-app-server/plugins/${item.id ?? item.name}`,
        status: "available_with_codex_runtime",
        kind: "plugin",
        state: { configured: true, enabled: true, verified, connected: verified },
        catalogSource: "official",
        pluginId: item.id ?? item.name,
        marketplaceName: item.marketplaceName ?? (item.id?.includes("@") ? item.id.split("@").pop() : undefined),
        authPolicy: item.authPolicy ?? null,
        catalogKind: "plugin"
      });
    }
    for (const item of zeaburRegistry?.pluginRegistry?.available ?? []) {
      if (!item.name) continue;
      addPlugin({
        id: `zeabur:catalog:plugin:${item.id ?? item.name}`,
        name: item.name,
        path: `zeabur://codex-app-server/plugin-catalog/${item.id ?? item.name}`,
        status: "catalog_available",
        kind: "plugin",
        state: { configured: false, enabled: false, verified: false, connected: false },
        catalogSource: "official",
        pluginId: item.id ?? item.name,
        marketplaceName: item.marketplaceName ?? (item.id?.includes("@") ? item.id.split("@").pop() : undefined),
        authPolicy: item.authPolicy ?? null,
        installHint: "Codex Serverの公式Plugin catalogから追加後、同じボタンでProvider認証へ進みます。",
        catalogKind: "plugin"
      });
    }
    for (const item of capabilities?.skills ?? []) items.push({ ...item, catalogKind: "skill" });
    if (capabilities?.mcp) items.push({ ...capabilities.mcp, catalogKind: "mcp" });
    if (capabilities?.cli) items.push({ ...capabilities.cli, catalogKind: "cli" });
    if (capabilities?.automationOsApi) items.push({ ...capabilities.automationOsApi, catalogKind: "api" });
    return items;
  }, [capabilities, zeaburRegistry]);
  const filteredCatalog = catalog.filter((item) => {
    if (activeTab !== "all" && item.catalogKind !== activeTab) return false;
    const haystack = `${item.name} ${item.id} ${item.kind} ${item.path}`.toLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLowerCase());
  });
  const loadCompanyConnections = async (companyId: string) => {
    if (!companyId || !companies.some((company) => company.id === companyId)) {
      setAccountRefs([]);
      setAccountRefsStatus("idle");
      return;
    }
    if (!canManageCompany) {
      setAccountRefs([]);
      setAccountRefsStatus("ready");
      return;
    }
    setAccountRefsStatus("loading");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/connection-account-refs`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || "company_connection_inventory_read_failed");
      setAccountRefs(Array.isArray(body.refs) ? body.refs : []);
      setAccountRefsStatus("ready");
    } catch {
      setAccountRefs([]);
      setAccountRefsStatus("error");
    }
  };
  React.useEffect(() => { void loadCompanyConnections(selectedCompanyId); }, [selectedCompanyId, canManageCompany]);
  const loadPersistedGmailCanary = async (companyId: string) => {
    if (!companyId || !canManageCompany) {
      setGmailCanary(null);
      setGmailCanaryStatus("idle");
      return;
    }
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/connectors/gmail/read-only-canary`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.persisted !== true || !body.readback) {
        setGmailCanary(null);
        setGmailCanaryStatus("idle");
        return;
      }
      setGmailCanary(body.readback);
      setGmailCanaryStatus(body.readback.status === "completed" ? "ready" : "error");
    } catch {
      setGmailCanary(null);
      setGmailCanaryStatus("idle");
    }
  };
  React.useEffect(() => { void loadPersistedGmailCanary(selectedCompanyId); }, [selectedCompanyId, canManageCompany]);
  React.useEffect(() => {
    let active = true;
    if (!selectedCompanyId) {
      setZeaburRegistry(null);
      setZeaburRegistryStatus("idle");
      return () => { active = false; };
    }
    setZeaburRegistryStatus("loading");
    void mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/connector-registry`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !active) throw new Error(body.error ?? "zeabur_connector_registry_read_failed");
        setZeaburRegistry(body.registry ?? null);
        setZeaburRegistryStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setZeaburRegistry(null);
        setZeaburRegistryStatus("error");
      });
    return () => { active = false; };
  }, [selectedCompanyId]);
  const loadCodexAuth = async (companyId: string) => {
    const readGeneration = ++codexAuthReadGeneration.current;
    if (!companyId || !canManageCompany) {
      setCodexAuth(null);
      setCodexAuthError(null);
      setCodexAuthStatus("idle");
      return;
    }
    setCodexAuthStatus("loading");
    setCodexAuth(null);
    setCodexAuthConnection(null);
    setCodexAuthError(null);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/codex/app-server/auth/status`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.auth) throw new Error(body.exactBlocker ?? body.error ?? "codex_device_auth_status_failed");
      if (readGeneration !== codexAuthReadGeneration.current) return;
      setCodexAuth(body.auth);
      setCodexAuthConnection(body.connection ?? null);
      setCodexAuthError(null);
      setCodexAuthStatus("ready");
    } catch (error) {
      if (readGeneration !== codexAuthReadGeneration.current) return;
      setCodexAuth(null);
      setCodexAuthError(publicBlockerSummary(error instanceof Error ? error.message : "codex_device_auth_status_failed"));
      setCodexAuthStatus("error");
    }
  };
  React.useEffect(() => { void loadCodexAuth(selectedCompanyId); }, [selectedCompanyId, canManageCompany]);
  const startCodexAuth = async (restart = false) => {
    if (!selectedCompanyId || !canManageCompany) {
      model.setReceipt("専用Codexサービス認証には会社1のOwner/Admin scopeが必要です。");
      return;
    }
    // Invalidate an in-flight status poll before issuing a new device-code request.
    codexAuthReadGeneration.current += 1;
    setCodexAuthStatus("loading");
    setCodexAuth(null);
    setCodexAuthConnection(null);
    setCodexAuthError(null);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/auth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restart })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.auth) throw new Error(body.exactBlocker ?? body.error ?? "codex_device_auth_start_failed");
      setCodexAuth(body.auth);
      setCodexAuthConnection(body.connection ?? null);
      setCodexAuthError(null);
      setCodexAuthStatus("ready");
      const url = typeof body.auth.verificationUrl === "string" ? body.auth.verificationUrl : "";
      const opened = url ? window.open(url, "_blank", "noopener,noreferrer") : null;
      model.setReceipt(body.auth.status === "verified" || body.auth.status === "already_authenticated"
        ? "専用Codexサービスは認証済みです。"
        : `${restart ? "新しい認証コードを発行しました" : (opened ? "公式認証画面を開きました" : "公式認証画面を開いてください")}。表示コード: ${body.auth.userCode ?? "未取得"}`);
    } catch (error) {
      setCodexAuth(null);
      setCodexAuthConnection(null);
      setCodexAuthError(publicBlockerSummary(error instanceof Error ? error.message : "codex_device_auth_start_failed"));
      setCodexAuthStatus("error");
      model.setReceipt(`専用Codexサービス認証を開始できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "codex_device_auth_start_failed")}）。`);
    }
  };
  const refreshCodexAuth = async () => { await loadCodexAuth(selectedCompanyId); };
  const codexAuthVerified = Boolean(codexAuth?.account?.accountPresent)
    && (codexAuth?.status === "verified" || codexAuth?.status === "already_authenticated");
  const canReissueCodexAuth = codexAuth?.status === "pending"
    || (codexAuth?.status === "blocked" && codexAuth?.exactBlocker === "codex_device_auth_failed");
  const codexAuthCodeVisible = codexAuthStatus !== "loading"
    && codexAuth?.status === "pending"
    && Boolean(codexAuth.userCode);
  const matchingConnection = (item: CapabilityItem) => accountRefs.find((ref) => {
    const platform = String(ref.platform ?? "").toLowerCase();
    const name = item.name.toLowerCase();
    return Boolean(platform) && pluginPlatformMatches(name, platform);
  });
  const pluginAuthPolicyLabel = (item: CapabilityItem) => item.authPolicy === "ON_USE"
    ? "使用時に公式認証"
    : item.authPolicy === "ON_INSTALL"
      ? "追加時に公式認証"
      : "認証方式未確認";
  const companyAuthStatus = (item: CapabilityItem & { catalogKind: string }) => {
    if (item.catalogSource === "recommended" || item.status === "catalog_available") {
      return item.catalogSource === "official" && item.authPolicy
        ? `Codex Serverカタログ / ${pluginAuthPolicyLabel(item)} / 未追加`
        : "未追加・追加可能";
    }
    if (item.catalogKind !== "plugin") return item.state.connected ? "接続済み" : item.state.verified ? "検証済み" : item.state.configured ? "カタログ確認済み" : "未確認";
    const ref = matchingConnection(item);
    if (ref && integrationStatusBadge(ref).label === "verified") return pluginAuthPoll[item.id]?.status === "verified" ? "会社接続・Server利用確認済み" : "会社接続参照あり・利用状態未確認";
    if (ref) return "再認証・検証待ち";
    return selectedCompanyId ? "会社認証が必要" : "会社未選択";
  };
  const pluginItems = catalog.filter((item) => item.catalogKind === "plugin");
  // The authentication wizard is an action surface, not the full provider
  // catalog. Keep the common/connected choices here and leave the complete
  // server inventory inside the collapsed diagnostics section below.
  const wizardPluginItems = pluginItems.filter((item) => {
    const name = item.name.trim().toLowerCase();
    const common = new Set(["gmail", "github", "google-drive", "google-calendar", "canva", "supabase"]);
    return item.catalogSource !== "official" || common.has(name) || Boolean(matchingConnection(item));
  });
  const serverPluginEntries = [
    ...(zeaburRegistry?.pluginRegistry?.installed ?? []),
    ...(zeaburRegistry?.pluginRegistry?.available ?? [])
  ];
  const serverAuthCapableCount = serverPluginEntries.filter((item) => item.authPolicy === "ON_INSTALL" || item.authPolicy === "ON_USE").length;
  const serverOnInstallCount = serverPluginEntries.filter((item) => item.authPolicy === "ON_INSTALL").length;
  const serverOnUseCount = serverPluginEntries.filter((item) => item.authPolicy === "ON_USE").length;
  const wizardItem = wizardPluginItems.find((item) => item.id === authWizardPluginId)
    ?? wizardPluginItems.find((item) => {
      const ref = matchingConnection(item);
      const catalogOnly = item.catalogSource === "recommended" || item.status === "catalog_available";
      return catalogOnly || !ref || integrationStatusBadge(ref).label !== "verified";
    })
    ?? wizardPluginItems[0]
    ?? null;
  const buildPluginAuthSteps = (item: CapabilityItem & { catalogKind: string }) => {
    const ref = matchingConnection(item);
    const catalogOnly = item.catalogSource === "recommended" || item.status === "catalog_available";
    const companySelected = Boolean(selectedCompanyId);
    const companyVerified = Boolean(ref && integrationStatusBadge(ref).label === "verified" && pluginAuthPoll[item.id]?.status === "verified");
    const authUrls = pluginAuthUrls[item.id] ?? [];
    const actionableAuthUrls = authUrls.filter(isActionablePluginAuthUrl);
    const authSurfaceBlocker = authUrls.length > 0 && actionableAuthUrls.length === 0
      ? pluginAuthUrlBlocker(authUrls[0]) ?? "official_auth_surface_not_actionable"
      : null;
    const registryPlugin = (zeaburRegistry?.pluginRegistry?.installed ?? []).find((plugin) => (plugin.name ?? "").trim().toLowerCase() === item.name.trim().toLowerCase());
    const registryVerified = Boolean(pluginAuthPoll[item.id]?.runtimeReady);
    const busy = busyToolId === item.id;
    const steps: Array<{ key: string; label: string; detail: string; status: "done" | "active" | "pending" | "blocked" }> = [
      {
        key: "company",
        label: "会社を選択",
        status: companySelected ? "done" : "blocked",
        detail: companySelected ? `会社「${selectedCompany?.label ?? selectedCompanyId}」に紐付けます。` : "認証先の会社を選択してください。"
      },
      {
        key: "install",
        label: "Pluginを追加",
        status: !companySelected ? "pending" : catalogOnly ? "active" : "done",
        detail: !companySelected ? "会社選択後に進めます。" : catalogOnly ? `公式Codex App Serverへ追加します。${item.authPolicy ? `認証ポリシー: ${pluginAuthPolicyLabel(item)}。` : "認証ポリシーは未確認です。"}` : "Pluginは追加済みです。"
      },
      {
        key: "oauth",
        label: "公式認証を承認",
        status: !companySelected || catalogOnly ? "pending" : companyVerified || registryVerified ? "done" : authSurfaceBlocker ? "blocked" : authUrls.length > 0 || busy ? "active" : "active",
        detail: companyVerified ? "会社接続参照と専用Serverの接続・呼び出し可能状態を確認しました。実業務の結果はRunで確認します。" : registryVerified ? "専用Serverの接続・呼び出し可能状態を確認しました。会社との紐付けを確認します。" : authSurfaceBlocker ? "利用できる接続URLを取得できませんでした。" : authUrls.length > 0 ? "公式接続ページでインストール・接続を進めてください。AOSに戻ると自動再確認します。" : "「公式認証を開始」を押して接続先を取得します。"
      },
      {
        key: "scope",
        label: "会社scopeを検証",
        status: !companySelected || catalogOnly ? "pending" : companyVerified ? "done" : authSurfaceBlocker ? "blocked" : ref ? "active" : "pending",
        detail: companyVerified ? "会社scopeの接続参照が検証済みです。" : authSurfaceBlocker ? "認証操作URLがないため会社scopeを確認できません。" : ref ? "承認後に「認証状態を再確認」で会社scopeを読み直します。" : "公式認証後に会社scopeのreadbackを確認します。"
      }
    ];
    const completed = steps.filter((step) => step.status === "done").length;
    return { steps, completed, complete: companySelected && !catalogOnly && companyVerified, ref, catalogOnly, authUrls, actionableAuthUrls, authSurfaceBlocker, registryVerified, authPolicy: item.authPolicy ?? null };
  };
  const ensureCodexAppServerAuthForPlugin = async (item: CapabilityItem & { catalogKind: string }): Promise<boolean> => {
    if (!selectedCompanyId) return false;
    const statusResponse = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/auth/status`, { cache: "no-store" });
    const statusBody = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok || !statusBody.auth) throw new Error(statusBody.exactBlocker ?? statusBody.error ?? "codex_device_auth_status_failed");
    const statusAuth = statusBody.auth;
    const verified = Boolean(statusAuth.account?.accountPresent)
      && (statusAuth.status === "verified" || statusAuth.status === "already_authenticated");
    if (verified) {
      setCodexAuth(statusAuth);
      setCodexAuthConnection(statusBody.connection ?? null);
      return true;
    }
    const authResponse = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ restart: false })
    });
    const authBody = await authResponse.json().catch(() => ({}));
    if (!authResponse.ok || !authBody.auth) throw new Error(authBody.exactBlocker ?? authBody.error ?? "codex_device_auth_start_failed");
    const auth = authBody.auth;
    setCodexAuth(auth);
    setCodexAuthConnection(authBody.connection ?? null);
    const authVerified = Boolean(auth.account?.accountPresent)
      && (auth.status === "verified" || auth.status === "already_authenticated");
    if (authVerified) return true;
    if (auth.status === "pending") {
      const url = typeof auth.verificationUrl === "string" ? auth.verificationUrl : "";
      const opened = url ? window.open(url, "_blank", "noopener,noreferrer") : null;
      setPluginAuthPoll((current) => ({
        ...current,
        [item.id]: { status: "blocked", attempt: 0, exactBlocker: "codex_device_code_entry_required" }
      }));
      model.setReceipt(`${item.name}: Codex App Serverの公式認証を開始しました。${opened ? "認証画面を開きました" : "認証URLを表示しました"}。コード入力後に同じボタンを再実行すると、認証済みreadbackを確認してPluginへ進みます。`);
      return false;
    }
    throw new Error(auth.exactBlocker ?? "codex_device_auth_not_verified");
  };
  const startPluginAddAndAuth = (item: CapabilityItem & { catalogKind: string }) => {
    if (!selectedCompanyId) {
      model.setReceipt(`${item.name}: 追加前に会社を選択してください。認証は会社scopeへ紐付けます。`);
      return;
    }
    const knownAuthUrls = pluginAuthUrls[item.id] ?? [];
    const knownAuthSurfaceBlocker = knownAuthUrls.length > 0 && knownAuthUrls.every((url) => !isActionablePluginAuthUrl(url))
      ? pluginAuthUrlBlocker(knownAuthUrls[0]) ?? "official_auth_surface_not_actionable"
      : null;
    if (knownAuthSurfaceBlocker) {
      // The previous response is known and was a read-only/non-actionable
      // surface, so a deliberate button press may request one fresh provider
      // read. Never loop or retry this automatically.
      setPluginAuthUrls((current) => ({ ...current, [item.id]: [] }));
      setPluginAuthPoll((current) => ({
        ...current,
        [item.id]: { status: "blocked", attempt: 0, exactBlocker: knownAuthSurfaceBlocker }
      }));
    }
    const existingRef = matchingConnection(item);
    const pluginId = item.pluginId ?? (item.id.split(":").pop() ?? item.name);
    const marketplaceName = item.marketplaceName ?? (pluginId.includes("@") ? pluginId.split("@").pop() : "openai-curated");
    setBusyToolId(item.id);
    void (async () => {
      try {
        const codexReady = await ensureCodexAppServerAuthForPlugin(item);
        if (!codexReady) return;
        const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/plugins/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plugin_id: pluginId, plugin_name: item.name, marketplace_name: marketplaceName })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) throw new Error(body.exactBlocker ?? body.error ?? "codex_app_server_plugin_install_failed");
      if (pluginAuthCompany.current !== selectedCompanyId) return;
      // The available catalog ID changes on installation. Keep selection and
      // auth state attached to the canonical installed ID, without a reload.
      if (body.registry) {
        setZeaburRegistry(body.registry);
        setZeaburRegistryStatus("ready");
      }
      item = { ...item, id: `zeabur:plugin:${body.plugin.id}`, pluginId: body.plugin.id };
      setAuthWizardPluginId(item.id);
      await loadCompanyConnections(selectedCompanyId);
      const urls: string[] = Array.isArray(body.auth?.authorization_urls) ? body.auth.authorization_urls.filter((value: unknown): value is string => typeof value === "string" && value.length > 0) : [];
      if (urls.length > 0) {
        setPluginAuthUrls((current) => ({ ...current, [item.id]: [...new Set(urls)] }));
        const actionableUrls = urls.filter(isActionablePluginAuthUrl);
        pluginAuthPollGeneration.current[item.id] = (pluginAuthPollGeneration.current[item.id] ?? 0) + 1;
        if (actionableUrls.length === 0) {
          const exactBlocker = pluginAuthUrlBlocker(urls[0]) ?? "official_auth_surface_not_actionable";
          setPluginAuthPoll((current) => ({
            ...current,
            [item.id]: { status: "blocked", attempt: 0, exactBlocker }
          }));
          model.setReceipt(`${item.name}: 接続・承認操作のない公式詳細ページだけが返されました。認証画面として開かず、${exactBlocker}で停止します。`);
          return;
        }
        const opened = window.open(actionableUrls[0], "_blank", "noopener,noreferrer");
        setPluginAuthPoll((current) => ({
          ...current,
          [item.id]: { status: "blocked", attempt: 0, exactBlocker: "plugin_auth_user_action_required" }
        }));
        model.setReceipt(opened
          ? `${item.name}: 公式接続ページを開きました。インストール案内が出た場合は、その先の接続操作へ進みます。AOSに戻ると自動再確認します。`
          : `${item.name}: 公式接続リンクを用意しました。リンク先で接続し、AOSに戻ると自動再確認します。`);
        return;
      }
      if (existingRef && canManageCompany) {
        const reconnectResponse = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/connection-account-refs/${encodeURIComponent(existingRef.id)}/reconnect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_revision: existingRef.revision })
        });
        const reconnectBody = await reconnectResponse.json().catch(() => ({}));
        if (!reconnectResponse.ok || !reconnectBody.ok) throw new Error(reconnectBody.error || "company_connection_reconnect_failed");
        await loadCompanyConnections(selectedCompanyId);
        void refreshPluginAuth(item);
        model.setReceipt(`${item.name}: 公式認証URLは発行されませんでした。会社scopeの再認証要求を保存しました。公式Provider側で承認後、「認証状態を再確認」を押してください。`);
        return;
      }
      await refreshPluginAuth(item);
      model.setReceipt(`${item.name}: Plugin追加後の接続状態を再確認しました。実利用状態はウィザードに表示します。`);
      } catch (error) {
        model.setReceipt(`${item.name}: Plugin追加・会社認証を開始できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "plugin_install_failed")}）。`);
      } finally {
        setBusyToolId(null);
      }
    })();
  };
  const refreshPluginAuth = async (item: CapabilityItem & { catalogKind: string }, background = false) => {
    if (!selectedCompanyId) {
      model.setReceipt(`${item.name}: 先に会社を選択してください。`);
      return;
    }
    const companyId = selectedCompanyId;
    const generation = (pluginAuthPollGeneration.current[item.id] ?? 0) + 1;
    pluginAuthPollGeneration.current[item.id] = generation;
    const current = () => pluginAuthCompany.current === companyId && pluginAuthPollGeneration.current[item.id] === generation;
    // A tab focus/screenshot can start a background recheck. Preserve the
    // last verified display until that read settles; errors still clear it.
    setPluginAuthPoll((state) => background && state[item.id]?.status === "verified" ? state : ({ ...state, [item.id]: { status: "checking", attempt: generation, exactBlocker: null } }));
    if (!background) setAccountRefsStatus("loading");
    if (!background) model.setReceipt(`${item.name}: 認証状態を確認中です。公式接続と会社scopeをreadbackしています。`);
    try {
      const accessResponse = await pluginAuthReadbackFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/codex/app-server/plugins/access?plugin_id=${encodeURIComponent(item.pluginId ?? item.id.split(":").pop() ?? item.name)}`, { cache: "no-store" });
      const accessBody = await accessResponse.json().catch(() => ({}));
      if (!accessResponse.ok || !accessBody.ok) throw new Error(accessBody.exactBlocker ?? accessBody.error ?? "plugin_access_readback_failed");
      if (!current()) return false;
      const connectionsResponse = await pluginAuthReadbackFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/connection-account-refs`, { cache: "no-store" });
      const connectionsBody = await connectionsResponse.json().catch(() => ({}));
      if (!connectionsResponse.ok || !connectionsBody.ok) throw new Error(connectionsBody.error ?? "company_connection_inventory_read_failed");
      const refs = Array.isArray(connectionsBody.refs) ? connectionsBody.refs : [];
      const itemName = item.name.trim().toLowerCase();
      const matchingRef = refs.find((ref: any) => {
        const platform = String(ref.platform ?? "").toLowerCase();
        return Boolean(platform) && pluginPlatformMatches(itemName, platform);
      });
      const verifiedRef = Boolean(matchingRef && integrationStatusBadge(matchingRef).label === "verified");
      const apps = Array.isArray(accessBody.access?.apps) ? accessBody.access.apps : [];
      const registryVerified = apps.length > 0 && apps.every((app: any) => app.accessStateAvailable === true && app.isAccessible === true && app.isEnabled === true && app.callable === true);
      // A remote connector registry and the AOS company connection inventory
      // are separate authorities. Company auth is verified only by the
      // matching, revisioned company connection reference.
      if (!current()) return false;
      setAccountRefs(refs);
      setAccountRefsStatus("ready");
      // An installed/callable App can still have an expired provider token.
      // Keep its official connection page reachable even at wizard step 3/4.
      const connectionUrls = apps.map((app: any) => app.installUrl).filter((url: unknown): url is string => typeof url === "string" && isActionablePluginAuthUrl(url));
      if (connectionUrls.length > 0) setPluginAuthUrls((state) => ({ ...state, [item.id]: [...new Set([...(state[item.id] ?? []), ...connectionUrls])] }));
      const verified = verifiedRef && registryVerified;
      setPluginAuthPoll((current) => ({
        ...current,
        [item.id]: { status: verified ? "verified" : "blocked", attempt: generation, runtimeReady: registryVerified, exactBlocker: verified ? null : (registryVerified ? "company_connection_ref_missing" : (apps.length ? "plugin_connection_not_ready" : "plugin_auth_method_unconfirmed")) }
      }));
      if (!background) {
        model.setReceipt(verified
          ? `${item.name}: 認証済みreadbackと会社scopeを確認しました。`
          : `${item.name}: 確認完了。ただし会社scopeは未確認です（${registryVerified ? "company_connection_ref_missing" : apps.length ? "plugin_connection_not_ready" : "plugin_auth_method_unconfirmed"}）。`);
      }
      return verified;
    } catch (error) {
      if (!current()) return false;
      setPluginAuthPoll((state) => ({ ...state, [item.id]: { status: "blocked", attempt: generation, runtimeReady: false, exactBlocker: publicBlockerSummary(error instanceof Error ? error.message : "plugin_auth_readback_failed") } }));
      setAccountRefsStatus("error");
      model.setReceipt(`${item.name}: 認証状態を再確認できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "plugin_auth_readback_failed")}）。`);
      return false;
    }
  };
  const latestPluginAuthRefresh = useRef(refreshPluginAuth);
  latestPluginAuthRefresh.current = refreshPluginAuth;
  const wizardAuthUrlKey = wizardItem ? (pluginAuthUrls[wizardItem.id] ?? []).join("\n") : "";
  React.useEffect(() => {
    if (!selectedCompanyId || !wizardItem || wizardItem.status === "catalog_available" || wizardItem.catalogSource === "recommended") return;
    let disposed = false;
    let inFlight = false;
    let attempts = 0;
    const check = async () => {
      if (disposed || inFlight || attempts >= 12) return;
      inFlight = true;
      attempts += 1;
      try {
        const verified = await latestPluginAuthRefresh.current(wizardItem, true);
        if (verified) attempts = 12;
      } finally { inFlight = false; }
    };
    const onFocus = () => { attempts = 0; void check(); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    void check();
    const timer = wizardAuthUrlKey ? window.setInterval(() => { if (document.visibilityState === "visible") void check(); }, 10_000) : null;
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      pluginAuthPollGeneration.current[wizardItem.id] = (pluginAuthPollGeneration.current[wizardItem.id] ?? 0) + 1;
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selectedCompanyId, wizardItem?.id, wizardAuthUrlKey]);
  const linkPluginCompanyScope = async (item: CapabilityItem & { catalogKind: string }) => {
    if (!selectedCompanyId || !canManageCompany) {
      model.setReceipt(`${item.name}: 会社Owner/Admin scopeが必要です。`);
      return;
    }
    const accountRef = companyAccountRef.trim();
    const scopes = companyAccountScopes.split(",").map((value) => value.trim()).filter(Boolean);
    if (!accountRef) {
      model.setReceipt(`${item.name}: 公式画面に表示されたアカウント参照（メール等）を入力してください。`);
      return;
    }
    if (!scopes.length) {
      model.setReceipt(`${item.name}: 権限scopeを1つ以上入力してください。`);
      return;
    }
    setBusyToolId(item.id);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/plugins/company-scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plugin_name: item.name, account_ref: accountRef, scopes })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.exactBlocker ?? body.error ?? "plugin_company_scope_failed");
      window.sessionStorage.setItem("aos-plugin-account-ref", accountRef);
      window.sessionStorage.setItem("aos-plugin-account-scopes", scopes.join(","));
      await loadCompanyConnections(selectedCompanyId);
      await refreshPluginAuth(item);
      model.setReceipt(`${item.name}: 公式registry verifiedと会社scopeを照合し、会社認証済みとして保存しました。`);
    } catch (error) {
      model.setReceipt(`${item.name}: 会社scopeの紐付けに失敗しました（${publicBlockerSummary(error instanceof Error ? error.message : "plugin_company_scope_failed")}）。`);
    } finally {
      setBusyToolId(null);
    }
  };
  const runGmailCanary = async () => {
    if (!selectedCompanyId) {
      model.setReceipt("Gmail read-only canaryには会社の選択が必要です。");
      return;
    }
    setGmailCanaryStatus("loading");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/connectors/gmail/provider-read-only-canary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        if (body.readback) setGmailCanary(body.readback);
        throw new Error(body.readback?.exactBlocker ?? body.error ?? "gmail_provider_read_only_canary_failed");
      }
      setGmailCanary(body.readback ?? body);
      setGmailCanaryStatus("ready");
      model.setReceipt(`Gmail provider canary: ${body.readback?.status ?? "unknown"}。同一Runのreceipt・scope・reconciliation・cleanupを確認しました。本文操作はしていません。`);
    } catch (error) {
      const responseMessage = error instanceof Error ? error.message : "readback_failed";
      setGmailCanary((current) => current ? { ...current, status: "blocked", exactBlocker: responseMessage } : { status: "blocked", exactBlocker: responseMessage });
      setGmailCanaryStatus("error");
      model.setReceipt(`Gmail provider canaryを完了できませんでした（${publicBlockerSummary(responseMessage)}）。同じRunを自動再送しません。`);
    }
  };
  const kindLabel = (kind: string) => ({ plugin: "Plugin", skill: "Skill", mcp: "MCP", cli: "CLI", api: "API" }[kind] ?? kind);
  const statusLabel = (item: CapabilityItem & { catalogKind: string }) => item.catalogSource === "recommended" || item.status === "catalog_available" ? "追加可能" : item.catalogKind === "plugin" ? pluginAuthPoll[item.id]?.runtimeReady ? "Server利用可" : "追加済み" : item.state.connected ? "接続済み" : item.state.verified ? "検証済み" : item.state.enabled ? "有効" : item.status === "missing" ? "未提供" : "要確認";
  const wizard = wizardItem ? buildPluginAuthSteps(wizardItem) : null;
  const wizardAuthPoll = wizardItem ? pluginAuthPoll[wizardItem.id] : null;
  const wizardStepLabel = (status: "done" | "active" | "pending" | "blocked") => ({ done: "完了", active: "次に実行", pending: "未開始", blocked: "必要" }[status]);
  React.useEffect(() => {
    if (model.mvpLoadStatus !== "ready") return;
    const routeCompany = requestedCompanyId && companies.some((company) => company.id === requestedCompanyId)
      ? requestedCompanyId
      : "";
    setSelectedCompanyId((current) => {
      const next = resolveProjectSelection(model.mvpState, routeCompany || current);
      if (next) rememberProject(next);
      return next;
    });
  }, [model.mvpLoadStatus, model.mvpState, requestedCompanyId]);
  return (
    <section>
      <PageTitle title="設定・接続" desc="会社ごとの接続と、Chatで使うサービスを管理" />
      <Panel title="Gmail read-only canary" controlId="truthful.plugins.gmail-canary.panel">
        <p className="muted">会社scopeを確認したうえで、専用Codex App ServerのGmail Pluginへプロフィール確認を同一Runで1回だけ依頼します。本文・添付・送信・下書きには触れず、provider receipt・source sync・reconciliation・cleanupを返します。</p>
        <div className="button-row">
          <Button controlId="truthful.plugins.gmail-canary.run" variant="primary" disabled={!selectedCompanyId || gmailCanaryStatus === "loading"} onClick={() => { void runGmailCanary(); }}>{gmailCanaryStatus === "loading" ? "providerを確認中…" : "Gmail provider canaryを実行"}</Button>
          <span className="muted">外部効果: false / 本文・添付: false / data persisted: false</span>
        </div>
        {gmailCanary ? <DataTable controlId="truthful.plugins.gmail-canary.readback" headers={["項目", "値"]} rows={[
          ["status", gmailCanary.status ?? "unknown"],
          ["run / operation", `${gmailCanary.runId ?? "-"} / ${gmailCanary.operation ?? "profile_read"}`],
          ["company", gmailCanary.companyId ?? selectedCompanyId ?? "-"],
          ["selected tool", gmailCanary.selectedTool ? `${gmailCanary.selectedTool.label ?? "-"} / ${gmailCanary.selectedTool.kind ?? "-"} / ${gmailCanary.selectedTool.status ?? "-"}` : "なし"],
          ["provider tool call", String(gmailCanary.providerToolCallObserved ?? false)],
          ["provider account", gmailCanary.providerAccountPresent ? `確認済み / hash=${gmailCanary.providerAccountHash ?? "-"}` : "未確認"],
          ["exact blocker", gmailCanary.exactBlocker ?? "なし"],
          ["external_action_executed", String(gmailCanary.externalActionExecuted ?? false)],
          ["data read / persisted", `${String(gmailCanary.dataRead ?? false)} / ${String(gmailCanary.dataPersisted ?? false)}`],
          ["provider receipt", gmailCanary.providerReceipt ? "同一Runで確認済み" : "未発行"],
          ["source sync / reconciliation / cleanup", `${gmailCanary.sourceSync?.status ?? "unknown"} / ${gmailCanary.reconciliation?.status ?? "unknown"} / ${gmailCanary.cleanup?.status ?? "unknown"}`],
          ["next action", gmailCanary.nextAction ?? "-"],
        ]} /> : <ReadbackState title="canary未実行" detail="会社を選択してread-only admissionを実行すると、同一時点の接続境界だけを表示します。" tone="info" nextAction="会社scopeを選び、canaryを確認する" />}
      </Panel>
      <Panel title="ユーザーが行う接続" controlId="truthful.plugins.auth-wizard.panel">
        <p className="settings-section-kicker">接続の手順</p>
        <p className="muted">すべてのPluginを同じ4段階で進めます。パスワード・OTP・CAPTCHA・デバイスコードは公式画面でユーザーが入力し、AOSは秘密値を保存しません。</p>
        {wizardItem && wizard ? <>
          <div className="plugin-auth-wizard-header">
            <label>接続先の会社
              <select data-control-id="truthful.plugins.auth-wizard.company-select" value={selectedCompanyId} onChange={(event) => { const next = event.target.value; setSelectedCompanyId(next); if (next) rememberProject(next); }}>
                <option value="">会社を選択してください</option>
                {companies.map((company) => <option key={company.id} value={company.id}>{company.label} ({company.role})</option>)}
              </select>
            </label>
            <label>対象Plugin
              <select data-control-id="truthful.plugins.auth-wizard.plugin-select" value={wizardItem.id} onChange={(event) => setAuthWizardPluginId(event.target.value)}>
                {wizardPluginItems.map((item) => <option key={item.id} value={item.id}>{item.name} ({companyAuthStatus(item)})</option>)}
              </select>
            </label>
            <div className={`plugin-auth-wizard-summary ${wizard.complete ? "is-complete" : ""}`}>
              <strong>{wizard.complete ? "認証完了" : `${wizard.completed}/4 完了`}</strong>
              <span>{wizard.complete ? `会社「${selectedCompany?.label ?? selectedCompanyId}」で利用できます。` : selectedCompanyId ? `${wizardItem.name}を会社「${selectedCompany?.label ?? selectedCompanyId}」へ接続します。` : "まず会社を選択してください。"}</span>
            </div>
            {gmailCanary?.status === "completed" && wizardItem.name.trim().toLowerCase() !== "gmail" && <p className="muted">Gmailのread-only確認は完了済みです。現在は未確認の{wizardItem.name}を次の認証対象として表示しています。</p>}
          </div>
          <ol className="plugin-auth-steps">
            {wizard.steps.map((step, index) => <li key={step.key} className={`plugin-auth-step is-${step.status}`}>
              <span className="plugin-auth-step-number">{index + 1}</span>
              <div><strong>{step.label}</strong><span>{step.detail}</span></div>
              <em>{wizardStepLabel(step.status)}</em>
            </li>)}
          </ol>
          <div className="button-row">
            <Button
              controlId="truthful.plugins.auth-wizard.primary"
              variant="primary"
              disabled={!selectedCompanyId || wizard.complete || wizard.registryVerified || busyToolId === wizardItem.id}
              onClick={() => startPluginAddAndAuth(wizardItem)}
            >
              {wizard.authSurfaceBlocker ? "認証URLを再取得" : busyToolId === wizardItem.id ? "認証開始中…" : wizard.registryVerified ? "会社scopeを下で紐付け" : wizard.catalogOnly ? "Pluginを追加して認証を開始" : wizard.ref ? "公式認証を再要求" : "公式認証を開始"}
            </Button>
            <Button
              controlId="truthful.plugins.auth-wizard.refresh"
              disabled={!selectedCompanyId || busyToolId === wizardItem.id || wizardAuthPoll?.status === "checking"}
              onClick={() => { void refreshPluginAuth(wizardItem); }}
            >{wizardAuthPoll?.status === "checking" ? "確認中…" : "認証状態を再確認"}</Button>
          </div>
          <div className="action-note" role="status" aria-live="polite" data-control-id="truthful.plugins.auth-wizard.refresh-status">
            {wizardAuthPoll?.status === "checking"
              ? "専用ServerとCompany 1の接続参照を読み直しています。"
              : wizardAuthPoll?.status === "blocked"
                ? `再確認結果: ${wizardAuthPoll.exactBlocker ?? "未確認"}。再確認は完了しましたが、認証状態は変わっていません。`
                : wizardAuthPoll?.status === "verified"
                  ? "再確認結果: Company 1の接続参照と専用Serverの利用状態を確認済みです。"
                  : "公式認証後に再確認すると、Company 1への接続状態を読み直します。"}
          </div>
          {wizard.authUrls.length > 0 ? <div className="plugin-auth-links" role="status" aria-live="polite">
            <strong>公式接続リンク</strong>
            <p className="muted">インストール案内ページが表示された場合は、その先の接続操作へ進んでください。AOSに戻ると接続状態を自動確認します。リンクを開いただけでは認証完了になりません。</p>
            {wizard.authUrls.map((url, index) => isActionablePluginAuthUrl(url) ? <a data-control-id={`truthful.plugins.auth-wizard.link.${`${wizardItem.id}-${index}`}`} key={`${wizardItem.id}:wizard-auth:${index}`} href={url} target="_blank" rel="noreferrer">{wizardItem.name} {pluginAuthLinkLabel(url)}{wizard.authUrls.length > 1 ? ` ${index + 1}` : ""}</a> : <span key={`${wizardItem.id}:wizard-auth:${index}`}>利用できない接続URL</span>)}
          </div> : null}
          {wizardAuthPoll?.status === "checking" ? <ReadbackState title="接続状態を自動確認中" detail="専用Serverの接続・呼び出し可能状態と会社接続参照を照合しています。" tone="info" nextAction="確認結果をこの画面へ反映します" /> : null}
          {wizardAuthPoll?.status === "verified" ? <ReadbackState title="会社接続・Server利用状態を確認済み" detail="最新の接続状態と会社接続参照が一致しています。実際の業務成功はRunの結果で確認します。" tone="success" nextAction="業務のread-only確認へ進む" /> : null}
          {wizardAuthPoll?.status === "blocked" ? <ReadbackState title={wizardAuthPoll.exactBlocker === "official_auth_surface_not_actionable" ? "認証画面が提供されていません" : "認証済みreadback未確認"} detail={wizardAuthPoll.exactBlocker === "official_auth_surface_not_actionable" ? "Providerから接続・承認操作のないPlugin詳細ページが返されました。AOSは認証画面として開きません。" : `公式認証の結果はまだ会社scopeへ反映されていません（${wizardAuthPoll.exactBlocker ?? "zeabur_connector_auth_not_verified"}）。未認証として扱います。`} tone="attention" nextAction={wizardAuthPoll.exactBlocker === "official_auth_surface_not_actionable" ? "Providerの接続・承認URLを取得してから再実行" : "公式画面の承認後に「認証状態を再確認」を押す"} /> : null}
          {selectedCompanyId && !wizard.catalogOnly && wizard.registryVerified && !wizard.complete ? <div className="plugin-company-scope-link" role="group" aria-label="会社scopeへ紐付け">
            <p className="muted">専用Serverには接続済みAppとして登録されています。実APIがトークン失効を返す場合は、上の公式接続リンクで再認証してください。接続先アカウントを確認したうえで、選択中の会社へアカウント参照とscopeを紐付けます。秘密値は保存しません。</p>
            {wizard.ref ? <p className="muted">既存の会社接続参照: <strong>{wizard.ref.account_ref ?? wizard.ref.accountRef ?? "未確認"}</strong>（現在は未verified。公式画面の同じアカウント参照を確認して入力してください）</p> : null}
            <label>公式アカウント参照（メール等）
              <input data-control-id="truthful.plugins.auth-wizard.account-ref" value={companyAccountRef} onChange={(event) => setCompanyAccountRef(event.target.value)} placeholder="例: your-account@example.com" autoComplete="email" />
            </label>
            <label>会社scope（カンマ区切り）
              <input data-control-id="truthful.plugins.auth-wizard.scopes" value={companyAccountScopes} onChange={(event) => setCompanyAccountScopes(event.target.value)} placeholder="read,write" />
            </label>
            <Button controlId="truthful.plugins.auth-wizard.link-company-scope" variant="primary" disabled={busyToolId === wizardItem.id} onClick={() => { void linkPluginCompanyScope(wizardItem); }}>{busyToolId === wizardItem.id ? "会社へ紐付け中…" : "公式認証を会社へ紐付け"}</Button>
          </div> : null}
          <p className="plugin-auth-wizard-boundary">外部効果: AOSは公式認証URLの開始と会社scopeのreadbackだけを扱います。承認後は同じ画面のfresh readbackで確認し、未確認のまま送信・取得へ進みません。</p>
        </> : <>
          {companies.length ? <div className="plugin-auth-wizard-header">
            <label>接続先の会社
              <select data-control-id="truthful.plugins.auth-wizard.company-select-empty" value={selectedCompanyId} onChange={(event) => { const next = event.target.value; setSelectedCompanyId(next); if (next) rememberProject(next); }}>
                <option value="">会社を選択してください</option>
                {companies.map((company) => <option key={company.id} value={company.id}>{company.label} ({company.role})</option>)}
              </select>
            </label>
          </div> : null}
          <ReadbackState
            title="認証対象Pluginがありません"
            detail={selectedCompanyId ? `会社「${selectedCompany?.label ?? selectedCompanyId}」のPlugin registryを確認中です。verified readbackがないPluginは認証済みと表示しません。` : "先に会社を選択すると、会社scopeのPlugin registryと認証対象が表示されます。"}
            tone="attention"
            nextAction={selectedCompanyId ? "Zeabur Codex App ServerのPlugin registryを再確認する" : "接続先の会社を選択する"}
          />
        </>}
      </Panel>
      <Panel title="Chatのツール選択ルール" controlId="truthful.plugins.preference.panel">
        <div className="tool-preference-summary">
          <div><strong>優先順位</strong><span>Plugin → MCP / CLI / API（同率2位）</span></div>
          <div><strong>会社scope</strong><span>{toolPreference?.companyIds?.length ? toolPreference.companyIds.join(", ") : "選択会社のreadback未確定"}</span></div>
          <div><strong>fallback</strong><span>{toolPreference?.fallbackPolicy === "no_implicit_fallback" ? "黙って下位候補へ切替えない" : "未確認"}</span></div>
        </div>
        {toolPreference?.selected ? <p className="muted">現在の候補: {toolPreference.selected.label ?? "-"} / {kindLabel(toolPreference.selected.kind ?? "")} / {toolPreference.selected.status ?? "unknown"} / {toolPreference.selected.reason ?? ""}</p> : <ReadbackState title="Chatの候補をまだ確定できません" detail="依頼文と会社scopeが揃った同一Chat Runで、Plugin→同率2位候補の順に選びます。" tone="info" nextAction="会社を選択してChatから依頼する" />}
        {toolPreference?.connectorExecution ? <p className="muted">connector配置: {toolPreference.connectorExecution.owner ?? "none"} / {toolPreference.connectorExecution.status ?? "unknown"} / blocker={toolPreference.connectorExecution.exactBlocker ?? "なし"} / Mac既定面={toolPreference.connectorExecution.macWorkerDefaultSurface ?? "chrome_plugin_profile2"} / fallback={toolPreference.connectorExecution.fallbackPolicy ?? "explicit_only"}</p> : null}
      </Panel>
      <details className="plugin-advanced-details">
        <summary>管理者・技術詳細（接続先と診断）を表示</summary>
      <Panel title="Zeabur Codex App Server registry" controlId="truthful.plugins.zeabur-registry.panel">
        <p className="muted">Plugin/MCP/connectorの正本は接続先Codex App Serverです。AOSサイト内へPluginを移植せず、Zeabur側のfresh registry readbackだけを表示します。Mac Workerの既定実行面はChrome Plugin / Profile 2です。</p>
        {zeaburRegistryStatus === "loading" ? <ReadbackState title="Zeabur registryを自動確認中" detail="接続先のPlugin registry・MCP設定・connector認証のreadbackを取得しています。結果が取れなければexact blockerを確定します。" tone="info" nextAction="自動再読込を実行し、失敗時はexact blockerを表示する" />
          : zeaburRegistry ? <DataTable controlId="truthful.plugins.zeabur-registry.readback" headers={["項目", "値"]} rows={[
            ["service", zeaburRegistry.target?.serviceName ?? "codex-app-server"],
            ["runtime / Codex login", `${zeaburRegistry.appServer?.runtimeStatus ?? "unknown"} / ${zeaburRegistry.appServer?.codexLogin ?? "unknown"}`],
            ["installed Plugin", (zeaburRegistry.pluginRegistry?.installed ?? []).map((item) => `${item.name ?? "-"} (${item.authStatus ?? "unknown"})`).join(", ") || "なし"],
            ["Plugin auth catalog", `${serverPluginEntries.length} entries / auth-policy-declared=${serverAuthCapableCount} / ON_INSTALL=${serverOnInstallCount} / ON_USE=${serverOnUseCount}`],
            ["available Plugin", (zeaburRegistry.pluginRegistry?.available ?? []).length
              ? `${(zeaburRegistry.pluginRegistry?.available ?? []).slice(0, 24).map((item) => `${item.name ?? "-"}${item.authPolicy ? ` [${item.authPolicy}]` : ""}`).join(", ")}${(zeaburRegistry.pluginRegistry?.available ?? []).length > 24 ? " …" : ""}`
              : "なし"],
            ["MCP registry", `${zeaburRegistry.mcpRegistry?.configuredCount ?? 0} configured / verified=${String(zeaburRegistry.mcpRegistry?.verified ?? false)}`],
            ["Gmail / Supabase auth", `${zeaburRegistry.connectorAuth?.gmail ?? "unknown"} / ${zeaburRegistry.connectorAuth?.supabase ?? "unknown"}`],
            ["exact blocker", zeaburRegistry.exactBlocker ?? "なし"],
          ]} /> : <ReadbackState title="Zeabur registryを確認できません" detail="AOSは接続先registryの証拠がない限り、Plugin/MCP/connectorを実行可能とは表示しません。Mac connectorへも暗黙fallbackしません。" tone="attention" nextAction="Zeabur側のregistry readback syncを設定する" />}
      </Panel>
      <Panel title="専用Codexサービス認証" controlId="truthful.plugins.codex-auth.panel">
        <p className="muted">専用Codex App Serverの認証だけを開始します。パスワード・OTP・CAPTCHA・デバイスコードはブラウザ上でユーザーが入力し、AOSは秘密値を保存しません。</p>
        {codexAuthStatus === "loading" ? <ReadbackState title="Codex認証状態を自動確認中" detail="常駐AOSサービスが保持する同一App Server接続を確認しています。結果が取れなければexact blockerを確定します。" tone="info" nextAction="自動再読込を実行し、失敗時はexact blockerを表示する" />
          : <DataTable controlId="truthful.plugins.codex-auth.readback" headers={["項目", "値"]} rows={[
            ["状態", codexAuth?.status ?? (codexAuthStatus === "error" ? "開始失敗" : "未確認")],
            ["アカウント", codexAuth?.account?.accountPresent ? `${codexAuth.account.accountType ?? "chatgpt"} / ${codexAuth.account.planType ?? "-"}` : "未認証"],
            ["completion", codexAuth?.completionObserved ? "確認済み" : "未確認"],
            ["account/updated", codexAuth?.accountUpdatedObserved ? "chatgpt確認済み" : "未確認"],
            ["デバイスコード", codexAuthCodeVisible ? codexAuth?.userCode : "未発行"],
            ["接続", codexAuthConnection?.mode ? `${codexAuthConnection.mode}${codexAuthConnection.exact_blocker ? ` / ${codexAuthConnection.exact_blocker}` : ""}` : "未確認"],
            ["blocker", codexAuth?.exactBlocker ?? codexAuthError ?? "なし"],
            ["認証URL", codexAuth?.verificationUrl ? <a data-control-id="truthful.plugins.codex-auth.verification-url" href={codexAuth.verificationUrl} target="_blank" rel="noreferrer">公式画面を開く</a> : "-"],
            ["次の操作", codexAuthError
              ? "表示コードは未発行です。表示されたblockerを解消してから認証フローを再試行"
              : codexAuthVerified
                ? "認証済みです。コードの再入力・再発行は不要です"
                : codexAuthCodeVisible
                  ? "表示されたコードをユーザーが公式画面へ入力（入力後に「認証状態を再確認」）"
                  : "認証フローを開始して表示コードを発行"],
            ["認証状態の確認", codexAuth?.status === "pending" ? "公式画面でコード入力後に「認証状態を再確認」" : codexAuthVerified ? "認証済み（readback確認済み）" : "必要時のみ再確認"],
          ]} />}
        {codexAuthCodeVisible ? <div
          data-testid="codex-device-code-visible"
          role="status"
          aria-live="polite"
          style={{ margin: "16px 0", padding: "16px", border: "2px solid #2563eb", borderRadius: "12px", background: "#eff6ff" }}
        >
          <p style={{ margin: "0 0 8px", fontWeight: 700 }}>認証コードが発行されました</p>
          <code style={{ display: "block", fontSize: "1.8rem", letterSpacing: "0.12em", lineHeight: 1.4, padding: "10px 12px", background: "#fff", borderRadius: "8px", overflowWrap: "anywhere" }}>{codexAuth.userCode}</code>
          <p className="muted" style={{ margin: "10px 0 0" }}>このコードを公式認証画面へ入力してください。AOSはコードを自動入力・コピーしません。</p>
          {codexAuth.verificationUrl ? <a data-control-id="truthful.plugins.codex-auth.device-verification-url" href={codexAuth.verificationUrl} target="_blank" rel="noreferrer">公式認証画面を開く</a> : null}
        </div> : <p className="muted" role="status">{codexAuthVerified
          ? "専用Codexサービスは認証済みです。コードを再入力する必要はありません。"
          : codexAuth?.status === "blocked" && codexAuth?.exactBlocker === "codex_device_auth_failed"
            ? "前の認証コードは拒否されたため無効です。原因を確認後、認証コードを再発行して公式画面へ入力してください。"
          : codexAuthConnection?.mode === "local_stdio"
            ? "このAOS画面はローカルstdio接続です。専用Zeabur Codexサービスの認証コードはこの画面へ共有されません。専用remote WebSocket authorityを設定した同じAOSサービスで再確認してください。"
            : "認証コードは現在の画面に表示されていません。上の「認証状態を再確認」を押して、発行済みコードを読み込みます。"}</p>}
        {codexAuthError ? <p className="muted" role="status">認証コードはまだ発行されていません。原因: {codexAuthError} / 認証フローの再発行は、原因解消後に1回だけ行います。</p> : null}
        <div className="button-row">
          <Button controlId="truthful.plugins.codex-auth.start" variant="primary" disabled={!selectedCompanyId || !canManageCompany || codexAuthStatus === "loading" || codexAuthVerified} onClick={() => { void startCodexAuth(canReissueCodexAuth); }}>{codexAuthVerified ? "認証済み" : canReissueCodexAuth ? "認証コードを再発行" : "認証フローを開始"}</Button>
          <Button controlId="truthful.plugins.codex-auth.refresh" disabled={!selectedCompanyId || !canManageCompany || codexAuthStatus === "loading"} onClick={() => { void refreshCodexAuth(); }}>認証状態を再確認</Button>
        </div>
      </Panel>
      <Panel title="公式リサーチ候補（未接続）" controlId="truthful.plugins.research.panel">
        <p className="muted">公式ドキュメントで発見した候補です。表示だけではインストール・認証・接続済みとは扱いません。Chatの依頼内容に一致した候補を、会社scopeと権限を確認してから採用します。</p>
        {toolPreference?.officialCandidates?.length ? <DataTable controlId="truthful.plugins.research.table" headers={["候補", "種別", "endpoint", "状態", "出典"]} rows={toolPreference.officialCandidates.map((candidate) => [candidate.label ?? candidate.id ?? "-", kindLabel(candidate.kind ?? ""), candidate.endpoint ?? "-", candidate.commandMatch ? "依頼に適合" : "カタログのみ", candidate.sourceUrl ? <a data-control-id={`truthful.plugins.research.source.${candidate.id ?? "unknown"}`} href={candidate.sourceUrl} target="_blank" rel="noreferrer">公式ドキュメント</a> : "-"])} /> : <ReadbackState title="公式リサーチ候補はありません" detail="今回の依頼に一致する公式MCP候補を確認できませんでした。" tone="info" nextAction="Plugin inventoryまたはCLI/API候補を確認する" />}
      </Panel>
      </details>
      <Panel title="Plugin一覧の絞り込み" controlId="truthful.plugins.company.panel">
        <div className="plugin-controls plugin-controls-filter">
          <label className="plugin-search">検索
            <input data-control-id="truthful.plugins.search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Plugin / Skill / MCP / CLIを検索" />
          </label>
        </div>
        <div className="plugin-tabs" role="tablist" aria-label="ツール種別">
          {([["all", "すべて"], ["plugin", "Plugin"], ["skill", "Skills"], ["mcp", "MCP"], ["cli", "CLI"], ["api", "API"]] as const).map(([id, label]) => <button type="button" key={id} role="tab" aria-selected={activeTab === id} className={activeTab === id ? "selected" : ""} data-control-id={`truthful.plugins.tab.${id}`} onClick={() => setActiveTab(id)}>{label}</button>)}
        </div>
        <p className="muted">{accountRefsStatus === "loading" ? "会社別接続状態を確認中…" : accountRefsStatus === "error" ? "会社別接続状態を確認できません。接続済みとは表示していません。" : selectedCompanyId ? `会社「${selectedCompany?.label ?? selectedCompanyId}」の秘密値を持たない接続参照を表示します。` : "会社未選択のため、認証状態は表示しません。"}</p>
        <p className="muted" data-control-id="truthful.plugins.codex-server-auth-summary">{zeaburRegistryStatus === "ready" ? `Codex Serverカタログ: ${serverPluginEntries.length}件 / 認証ポリシー宣言 ${serverAuthCapableCount}件（追加時 ${serverOnInstallCount}、使用時 ${serverOnUseCount}）。実際の認証方式と接続状態は対象Pluginごとに確認します。` : "Codex Serverカタログを取得中です。静的候補を認証可能とは表示しません。"}</p>
      </Panel>
      <Panel title={`管理者・詳細: ツールカタログ (${filteredCatalog.length})`} controlId="truthful.plugins.catalog.panel">
        {filteredCatalog.length ? <details className="plugin-catalog-details">
          <summary>管理者・詳細情報として全ツールのインベントリを表示（{filteredCatalog.length}件）</summary>
              <p className="muted">通常は認証ウィザードと会社接続の状態だけを確認します。519件の全インベントリは必要な場合だけ開きます。表示だけでは認証済み・実行可能とは扱いません。</p>
          <div className="plugin-grid">
            {filteredCatalog.map((item) => {
              const ref = matchingConnection(item);
              const catalogOnly = item.catalogSource === "recommended" || item.status === "catalog_available";
              const canAuth = item.catalogKind === "plugin" && !catalogOnly;
              const auth = item.catalogKind === "plugin" ? buildPluginAuthSteps(item) : null;
              const serverAuth = item.catalogKind === "plugin" && item.catalogSource === "official" && item.authPolicy ? `Codex Server認証ポリシー / ${pluginAuthPolicyLabel(item)}` : null;
              return <article className="plugin-card" key={`${item.catalogKind}:${item.id}`} data-control-id={`truthful.plugins.card.${item.id}`}>
                <div className="plugin-card-heading"><span className="plugin-icon">{item.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.name}</strong><span>{kindLabel(item.catalogKind)} / {item.kind}</span></div><StatusBadge status={item.state.connected ? "enabled" : item.state.verified ? "approved" : item.status === "missing" ? "blocked" : "draft"} label={statusLabel(item)} /></div>
                <p className="muted">{item.path}</p>
                <p className="plugin-auth">{companyAuthStatus(item)}{serverAuth ? ` / ${serverAuth}` : ""}{ref?.last_verified_at ? ` / ${ref.last_verified_at}` : ""}</p>
                {auth ? <div className="plugin-card-progress"><strong>共通認証 {auth.completed}/4</strong><span>{auth.complete ? "認証完了" : auth.steps.find((step) => step.status === "active" || step.status === "blocked")?.label ?? "確認待ち"}</span></div> : null}
                <div className="button-row">
                  {catalogOnly && <Button controlId={`truthful.plugins.add-auth.${item.id}`} variant="primary" disabled={!selectedCompanyId || busyToolId === item.id} onClick={() => startPluginAddAndAuth(item)}>{busyToolId === item.id ? "認証開始中…" : serverAuth ? "Codex Serverで追加して認証" : "追加して認証"}</Button>}
                  {canAuth && <Button controlId={`truthful.plugins.auth.${item.id}`} variant="primary" disabled={!selectedCompanyId || busyToolId === item.id} onClick={() => startPluginAddAndAuth(item)}>{busyToolId === item.id ? "認証開始中…" : ref ? "再認証を要求" : "追加して認証"}</Button>}
                  {auth && <Button controlId={`truthful.plugins.auth-wizard.${item.id}`} onClick={() => setAuthWizardPluginId(item.id)}>認証手順</Button>}
                  <Button controlId={`truthful.plugins.details.${item.id}`} onClick={() => model.setReceipt(`${item.name}: ${item.catalogKind} inventoryを表示中。実行・外部効果はありません。`)}>詳細</Button>
                </div>
              </article>;
            })}
          </div>
        </details> : <ReadbackState title="一致するツールがありません" detail="現在のCodex inventoryにないPluginを接続済みとは表示しません。" tone="attention" nextAction="検索条件を変えるか、Codex側のPlugin/MCP inventoryを更新する" />}
      </Panel>
      <details className="plugin-advanced-details">
        <summary>管理者・技術詳細（実行面と接続状態）を表示</summary>
      <Panel title="Codex surface readback" controlId="truthful.plugins.surfaces.panel">
        {surfaces.length ? <DataTable controlId="truthful.plugins.surfaces.table" headers={["Surface", "Kind", "Status", "Configured", "Enabled", "Connected"]} rows={surfaces.map((surface) => [surface.name, surface.kind, getCapabilitySurfaceStatus(surface), getCapabilitySurfaceState(surface).configured ? "yes" : "no", getCapabilitySurfaceState(surface).enabled ? "yes" : "no", getCapabilitySurfaceState(surface).connected ? "yes" : "no"])} /> : <ReadbackState title="Capability readbackがありません" detail="静的なPlugin候補や、接続済みに見える状態は表示していません。現在は機能の存在ではなく、検証済みのsurfaceだけを正本とします。" tone="attention" nextAction="Codex surfaceのfresh readbackを取得する" />}
      </Panel>
      <Panel title="Chrome Extension readback" controlId="truthful.plugins.chrome.panel">
        {selectedBackend !== "chrome_plugin" ? <ReadbackState title="Chrome Pluginは現在の選択面ではありません" detail={`現在の選択backend=${selectedBackend ?? "未確認"}。Chrome Pluginのreadbackを実行面として表示していません。`} tone="info" nextAction="Adminのbackend設定と次回run開始時のbindingを確認する" />
          : chromeReadback ? <><p>Chrome Plugin / Profile 2: {publicBrowserUseRuntimeStatus(runtime)} / blocker={chromeReadbackBlocker ?? "なし"}</p><p className="muted">status={chromeReadback.status ?? "unknown"} / refresh={chromeReadback.refreshStatus ?? "unknown"} / captured={chromeReadback.capturedAt ?? "未確認"} / {publicBrowserUseRuntimeNextCheck(runtime)}</p></>
          : <ReadbackState title="Chrome Extensionのreadbackがありません" detail="選択backendはChrome Pluginですが、Profile 2のruntime readbackがありません。推測で接続済みとは表示しません。" tone="attention" nextAction="Chrome Plugin trusted bridgeとProfile 2のfresh readbackを確認する" />}
      </Panel>
      </details>
    </section>
  );
}

async function requestProductionReadback(companyId: string, signal?: AbortSignal) {
  const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/production/readback`, { cache: "no-store", signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.ok !== true) throw new Error(value.error ?? "production_readback_failed");
  if (value.source !== "api_host_runtime" || value.company_scope?.enforced !== true || value.company_scope.company_id !== companyId
    || !value.persistence?.adapter || !value.deployment || !value.checked_at) throw new Error("production_readback_mismatch");
  return value;
}

function TruthfulProductionStatusPage({ model }: { model: AppModel }) {
  const companies = projectOptionsFromState(model.mvpState).filter((company) => ["owner", "admin"].includes(company.role ?? ""));
  const [selection, setSelection] = useState("");
  const companyId = companies.some((company) => company.id === selection) ? selection : companies[0]?.id ?? "";
  const [readback, setReadback] = useState<any>(null);
  const [readStatus, setReadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReadback(null); setReadStatus("loading");
    if (!companyId) { setReadStatus("error"); return () => controller.abort(); }
    void requestProductionReadback(companyId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setReadback(value); setReadStatus("ready"); }
    }).catch(() => { if (!controller.signal.aborted) setReadStatus("error"); });
    return () => controller.abort();
  }, [companyId, refresh]);
  const current = readback?.company_scope?.company_id === companyId ? readback : null;
  const readiness = current?.readiness;
  const browser = current?.browser;
  const chromeUnobserved = !browser?.chromeExtension?.readback?.capturedAt && browser?.chromeExtension?.status !== "ready" && browser?.chromeExtension?.targetScopedAvailable !== true;
  const workerSummary = workerStatusSummary(model.mvpState.worker);
  const readinessRows = readiness && typeof readiness === "object"
    ? Object.entries(readiness).filter(([key]) => ["status", "production_ready", "goal_complete", "blocker", "next_action", "checked_at", "source"].includes(key)).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value ?? "-")])
    : [];
  return (
    <section>
      <PageTitle title="本番状態" desc="現在のAPI readback。deployや外部検証は実行しません。" />
      <label>確認する会社 <select aria-label="本番状態の会社" data-control-id="truthful.production.scope.select" value={companyId} onChange={(event) => setSelection(event.target.value)}>
        {companies.map((company) => <option key={company.id} value={company.id}>{company.label}</option>)}
      </select></label>
      <Button controlId="truthful.production.readback.refresh" disabled={readStatus === "loading" || !companyId} onClick={() => setRefresh((value) => value + 1)}>本番状態を再読込</Button>
      <p role="status">{readStatus === "loading" ? "本番APIホストの状態を確認中です。" : readStatus === "error" ? "最新状態を確認できません。会社の管理権限と接続を確認し、再読込してください。" : `確認: ${current?.checked_at ?? "未確認"} / APIホストの情報です。Mac workerと実業務結果は別に確認します。`}</p>
      <div className="cards four">
        <MetricCard controlId="truthful.production.metric.persistence" title="Persistence" value={String(current?.persistence?.adapter ?? "未確認")} sub="現在のAPI readback" status={current?.persistence?.adapter ? "enabled" : "waiting"} statusLabel={current?.persistence?.adapter ? undefined : readStatus === "loading" ? "確認中" : "未確認"} />
        <MetricCard controlId="truthful.production.metric.worker" title="Worker" value={model.mvpState.worker?.status ?? "未確認"} sub={`${workerSummary.label} / ${workerSummary.freshness}`} status={model.mvpState.worker?.heartbeat_fresh ? "enabled" : model.mvpState.worker?.readback_status === "stored" ? "draft" : "blocked"} />
        <MetricCard controlId="truthful.production.metric.chrome" title="公式Chrome / APIホスト観測" value={chromeUnobserved ? "未観測" : publicChromeLaneStatus(browser?.chromeExtension)} sub={`Companionの接続状態とは別です / ${publicChromeLaneBlocker(browser?.chromeExtension)}`} status={chromeUnobserved ? "waiting" : browser?.chromeExtension?.status === "ready" ? "enabled" : browser?.chromeExtension?.targetScopedAvailable === true ? "draft" : "blocked"} statusLabel={chromeUnobserved ? "未観測" : undefined} />
        <MetricCard controlId="truthful.production.metric.goal" title="Goal Complete" value={readiness?.goal_complete === true ? "true" : readiness?.goal_complete === false ? "false" : "未確認"} sub="配信や接続確認から業務完了を推定しません" status={readiness?.goal_complete === true ? "approved" : readiness?.goal_complete === false ? "blocked" : "waiting"} statusLabel={readiness?.goal_complete === true ? "完了確認済み" : readiness?.goal_complete === false ? "未完了" : "未確認"} />
      </div>
      <Panel title="現在配信しているアプリ" controlId="truthful.production.deployment.panel">
        <p>{current?.deployment ? `現在のAPIホストから配信中 / ${current.deployment.version || "バージョン未確認"}` : "配信情報は未確認です。"}</p>
        {current?.deployment ? <details className="production-technical-details">
          <summary>配信の技術詳細を表示</summary>
          <DataTable controlId="truthful.production.deployment.table" headers={["項目", "APIホストの読取結果"]} rows={[
            ["Version", current.deployment.version || "未確認"], ["Commit / 出所", `${current.deployment.commit || "未確認"} / ${current.deployment.commitSource}`],
            ["Web asset", current.deployment.assets?.js || "未確認"], ["Runtime artifact hash", current.deployment.runtimeParity?.artifactHash || "未確認"]
          ]} />
        </details> : null}
        <p className="muted">配信確認は稼働状況の参考です。ソースとの一致や全業務の完了は別の証拠で確認します。</p>
      </Panel>
      <Panel title="Production readiness readback" controlId="truthful.production.readback.panel">{readinessRows.length ? <details className="production-technical-details">
        <summary>技術的なreadbackを表示（業務完了とは別管理）</summary>
        <DataTable controlId="truthful.production.readback.table" headers={["項目", "値"]} rows={readinessRows} />
      </details> : readStatus === "loading" ? <ReadbackState title="Production readinessを確認中" detail="選択した会社のAPI応答を待っています。本番準備完了とは扱いません。" tone="info" /> : <ReadbackState title="Production readinessを確認できません" detail="過去の固定Run IDや確認件数は現在値として表示していません。本番準備完了とは扱いません。" tone="attention" nextAction="承認済みrevisionとfresh production readbackを取得する" />}</Panel>
      <Panel title="この画面の操作範囲" controlId="truthful.production.hard-stops.panel"><CheckList items={["この画面からproduction deployは実行しません", "この画面から外部投稿・送信・削除は実行しません", "この画面から認証情報・secretを変更しません", "配信やheartbeatの確認と、各業務の完了証拠は別に扱います"]} /></Panel>
    </section>
  );
}

function hasOwnerAdminAccess(state: MvpState) {
  return projectOptionsFromState(state).some((company) => company.role === "owner");
}

function AdminDiagnosticDetails({ summary = "内部診断を表示", value }: { summary?: string; value: string }) {
  return <details className="admin-diagnostic-details">
    <summary>{summary}</summary>
    <pre>{value}</pre>
  </details>;
}

function OwnerAdminPage({ model }: { model: AppModel }) {
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [backendSetting, setBackendSetting] = useState<any>(null);
  const [backendChoice, setBackendChoice] = useState("chrome_plugin");
  const [backendSaving, setBackendSaving] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const loadVersionRef = useRef(0);
  const load = async () => {
    const loadVersion = ++loadVersionRef.current;
    setStatus("loading");
    try {
      const [diagnosticsResponse, backendResponse] = await Promise.all([
        mvpFetch("/api/v1/admin/diagnostics", { cache: "no-store" }),
        mvpFetch("/api/v1/settings/web-operation-backend", { cache: "no-store" })
      ]);
      const body = await diagnosticsResponse.json().catch(() => ({}));
      const backendBody = await backendResponse.json().catch(() => ({}));
      if (!diagnosticsResponse.ok || !body.ok) throw new Error(body.error || "owner_admin_read_failed");
      if (!backendResponse.ok || !backendBody.ok) throw new Error(backendBody.error || "web_operation_backend_read_failed");
      if (loadVersion !== loadVersionRef.current) return;
      setDiagnostics(body);
      setBackendSetting(backendBody);
      setBackendChoice(String(backendBody.setting?.backend ?? "chrome_plugin"));
      setStatus("ready");
      model.setReceipt("Owner専用Admin diagnosticsを再読込しました。外部操作は実行していません。");
    } catch {
      if (loadVersion !== loadVersionRef.current) return;
      setDiagnostics(null);
      setStatus("error");
      model.setReceipt("Owner専用Admin diagnosticsを確認できませんでした。");
    }
  };
  React.useEffect(() => { void load(); }, []);
  if (model.mvpLoadStatus === "loading" || (model.mvpLoadStatus === "degraded" && model.mvpLoadBlocker === "mvp_state_detail_readback_pending")) return <ProjectUnavailablePage loading scopeLabel="Admin membership" reason="Owner membershipを確認中です。未取得を権限拒否とは扱いません。" />;
  if (!hasOwnerAdminAccess(model.mvpState)) return <ProjectUnavailablePage reason="Admin diagnosticsはOwner membershipだけが閲覧できます。" />;
  const diagnosticText = (value: unknown) => redactSensitiveText(redactDisplayPaths(JSON.stringify(value ?? {}, null, 2)));
  const runtime = backendSetting?.setting?.backend === "browser_use_cli" ? model.mvpState.browser_use_runtime : undefined;
  const workerNeedsAttention = model.mvpState.worker?.heartbeat_fresh !== true || Boolean(model.mvpState.worker?.exact_blocker);
  const runtimeNeedsAttention = runtime?.status !== "verified" || Boolean(runtime?.exactBlocker);
  const adminNextAction = workerNeedsAttention
    ? { label: "Workerのheartbeatを再確認", route: "#/system/pc-status", detail: model.mvpState.worker?.exact_blocker ? publicBlockerSummary(model.mvpState.worker.exact_blocker) : "Mac Workerのfresh readbackが必要です。" }
    : runtimeNeedsAttention
      ? { label: "PCとWorkerの観測を開く", route: "#/system/pc-status", detail: `ブラウザを使う処理の確認です。選択面: ${publicWebOperationBackendLabel(backendSetting?.setting?.backend)}。${runtime?.exactBlocker ? publicBlockerSummary(runtime.exactBlocker) : "選択面の接続はこの診断では未確認です。PC状態ではWorkerのheartbeatとAPIホストの観測を確認できます。"} 各業務の結果は同じRunのreceiptで別に確認します。` }
      : { label: "自動化を確認", route: "#/projects", detail: "実行前に会社scope・承認・同一Runのproofを確認します。" };
  const adapterCoverageRows = Array.isArray(backendSetting?.adapter_coverage)
    ? backendSetting.adapter_coverage.map((item: any) => {
      const modeKey = `${backendChoice}_mode`;
      const blockerKey = `${backendChoice}_exact_blocker`;
      const nextActionKey = `${backendChoice}_next_action`;
      const legacyMode = backendChoice === "chrome_plugin"
        ? (item.chrome_plugin ? "effectful" : "not_bound")
        : item[backendChoice] === true ? "effectful" : "not_bound";
      const mode = String(item[modeKey] ?? legacyMode);
      return [
        String(item.adapter ?? "-"),
        mode,
        String(item[blockerKey] ?? "-") || "-",
        String(item[nextActionKey] ?? "run開始時にadapterを再確認"),
      ];
    })
    : [];
  const saveBackend = async () => {
    if (backendSaving || status !== "ready" || !backendSetting?.setting?.revision) return;
    const requestedBackend = backendChoice;
    const expectedRevision = backendSetting.setting.revision;
    // Invalidate any older Admin readback before the write.  A slow diagnostics
    // response must not overwrite the same-run post-save backend readback.
    loadVersionRef.current += 1;
    setBackendSaving(true);
    model.setReceipt(`Web操作バックエンドを${requestedBackend}へ保存中です。`);
    try {
      const response = await mvpFetch("/api/v1/settings/web-operation-backend", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend: requestedBackend, expected_revision: expectedRevision })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        model.setReceipt(`Web操作バックエンドを変更できませんでした: ${body.exactBlocker ?? body.error ?? "unknown"}`);
        return;
      }
      const readbackResponse = await mvpFetch("/api/v1/settings/web-operation-backend", { cache: "no-store" });
      const readback = await readbackResponse.json().catch(() => ({}));
      const readbackSetting = readback?.setting;
      if (!readbackResponse.ok || !readback.ok || readbackSetting?.backend !== requestedBackend || readbackSetting?.revision !== body.setting?.revision) {
        const exactBlocker = readback?.exactBlocker ?? readback?.error ?? "web_operation_backend_post_save_readback_mismatch";
        setBackendSetting(body);
        model.setMvpState((current) => ({ ...current, web_operation_backend: body.setting }));
        model.setReceipt(`Web操作バックエンドは保存されましたが、fresh readbackを確認できませんでした: ${exactBlocker}`);
        return;
      }
      setBackendSetting(readback);
      setBackendChoice(String(readbackSetting.backend));
      model.setMvpState((current) => ({ ...current, web_operation_backend: readbackSetting }));
      model.setReceipt(`次回runから全automationの選択を${readbackSetting.backend}へ切り替えました。Profile 2 / revision=${readbackSetting.revision} / fresh readback=ok`);
    } catch (error) {
      const exactBlocker = error instanceof Error ? error.message : "web_operation_backend_save_failed";
      model.setReceipt(`Web操作バックエンドを変更できませんでした: ${exactBlocker}`);
    } finally {
      setBackendSaving(false);
    }
  };
  return (
    <section>
      <PageTitle title="Admin" desc="Owner専用: PC・Browser・Codex・Obsidian・Worker・Deployment diagnostics">
        <Button controlId="admin.refresh" onClick={() => { void load(); }} disabled={status === "loading"}>{status === "loading" ? "確認中" : "再確認"}</Button>
      </PageTitle>
      {status === "error" && <Panel title="Admin readback" controlId="admin.error.panel"><p className="muted">Owner専用API readbackを取得できませんでした。通常の会社ページへ内部診断値はfallback表示しません。</p></Panel>}
      {status === "ready" && diagnostics && <>
        <div className="operator-next-action" data-control-id="admin.next-action" role="status">
          <div><strong>状態に応じた確認</strong><span>{adminNextAction.detail}</span></div>
          <Button controlId="admin.next-action.open" variant="primary" onClick={() => go(adminNextAction.route)}>{adminNextAction.label}</Button>
        </div>
        <Panel title="全automationのWeb操作バックエンド" controlId="admin.web-operation-backend.panel">
          <p className="muted">AOSのグローバル設定です。変更は次回run開始時に固定され、既存runのbackendは変更しません。現在の選択面（{publicWebOperationBackendLabel(backendSetting?.setting?.backend)}）を各automationの次回runへ伝播し、未登録・未検証なら別surfaceへ切り替えず安全停止します。</p>
          <div className="form-row">
            <label htmlFor="admin-web-operation-backend">実行面</label>
            <select id="admin-web-operation-backend" data-control-id="admin.web-operation-backend.select" aria-label="ウェブ操作バックエンド" value={backendChoice} disabled={backendSaving || status !== "ready"} onChange={(event) => setBackendChoice(event.target.value)}>
              <option value="chrome_plugin">Chrome plugin</option>
              <option value="browser_use_cli">Browser Use CLI</option>
              <option value="aos_chrome_companion">AOS Chrome Companion</option>
              <option value="playwright">Playwright</option>
            </select>
            <Button controlId="admin.web-operation-backend.save" variant="primary" disabled={backendSaving || status !== "ready"} onClick={() => { void saveBackend(); }}>{backendSaving ? "保存中…" : "保存"}</Button>
          </div>
          <p className="muted">current={backendSetting?.setting?.backend ?? "未確認"} / revision={backendSetting?.setting?.revision ?? "?"} / Profile={backendSetting?.setting?.chrome_profile?.name ?? "Profile 2"} / local sync={backendSetting?.local_sync?.written ? "ok" : backendSetting?.local_sync?.exact_blocker ?? "unknown"}</p>
          <p className="muted">未接続adapterは別surfaceへfallbackせず停止します。entrypoint_onlyは実行可能を意味せず、target-bound admissionが必要です。</p>
          {adapterCoverageRows.length ? <DataTable controlId="admin.web-operation-backend.adapter-coverage" headers={["Adapter", "選択面の状態", "Exact blocker", "次の安全な作業"]} rows={adapterCoverageRows} /> : <ReadbackState title="adapter coverageを確認できません" detail="現行APIのreadbackが必要です。" tone="attention" nextAction="Admin diagnosticsを再確認する" />}
        </Panel>
        <Panel title="PC / Worker" controlId="admin.pc.panel">
          <p className="muted">鮮度: {adminWorkerFreshnessLabel(diagnostics, model.mvpState.worker)}</p>
          <AdminDiagnosticDetails value={diagnosticText(diagnostics.pc)} />
        </Panel>
        <Panel title="Browser / Codex" controlId="admin.browser-codex.panel"><AdminDiagnosticDetails value={diagnosticText({ browser: diagnostics.browser, codex: diagnostics.codex })} /></Panel>
        <Panel title="IAB / Root capability" controlId="admin.iab.panel"><AdminDiagnosticDetails value={diagnosticText(diagnostics.iab)} /></Panel>
        <Panel title="Browser Use / workflow adapters" controlId="admin.workflow-adapters.panel">
          <p className="muted">正規実行面は上のAOS選択に従います。未接続adapterは別surfaceへfallbackせず安全停止します。</p>
          <AdminDiagnosticDetails value={diagnosticText(diagnostics.workflow_adapters)} />
        </Panel>
        <Panel title="Company SaaS release readiness" controlId="admin.company-release-readiness.panel"><AdminDiagnosticDetails value={diagnosticText(diagnostics.company_release_readiness)} /></Panel>
        <Panel title="Company SaaS evidence gates" controlId="admin.company-release-evidence.panel"><AdminDiagnosticDetails value={diagnosticText(diagnostics.company_release_evidence)} /></Panel>
        <Panel title="Obsidian" controlId="admin.obsidian.panel"><AdminDiagnosticDetails value={diagnosticText(diagnostics.obsidian)} /></Panel>
        <Panel title="Deployment / Guards" controlId="admin.deployment.panel"><AdminDiagnosticDetails value={diagnosticText({ deployment: diagnostics.deployment, guards: diagnostics.guards })} /></Panel>
      </>}
      <FeedbackFixQueue feedbacks={model.feedbackReadback} readStatus={model.feedbackReadStatus} state={model.mvpState} setReceipt={model.setReceipt} setFeedbackReadback={model.setFeedbackReadback} canTriage={hasOwnerAdminAccess(model.mvpState)} />
    </section>
  );
}

function renderPage(route: string, model: AppModel) {
  const { setReceipt } = model;
  const currentPath = routePath(route);
  const hasCachedCompanyScope = projectOptionsFromState(model.mvpState).length > 0;
  const canRenderDegradedReadOnlySurface = model.mvpLoadStatus === "degraded"
    && hasCachedCompanyScope
    && (
      currentPath === "#/"
      || currentPath === "#/projects"
      || currentPath === "#/projects/"
      || currentPath === "#/chat"
      || currentPath === "#/runs"
      || currentPath === "#/approvals"
      || currentPath === "#/templates"
      || currentPath === "#/plugins"
      || currentPath === "#/production/status"
      || currentPath === "#/system/pc-status"
      || currentPath.endsWith("/automations")
    );
  const canRenderCachedCompanySurface = hasCachedCompanyScope
    && (currentPath === "#/projects" || currentPath === "#/projects/" || currentPath.includes("/projects/"));
  const canRenderCachedReadOnlySurface = hasCachedCompanyScope
    && (canRenderCachedCompanySurface || currentPath === "#/chat" || canRenderDegradedReadOnlySurface);
  const canRenderSafeGlobalSurface = ["#/", "#/chat", "#/projects", "#/projects/", "#/runs", "#/approvals", "#/templates", "#/plugins", "#/system/pc-status", "#/production/status"].includes(currentPath);
  const stateDependentRoute = currentPath !== "#/admin";
  if (stateDependentRoute && model.mvpLoadStatus !== "ready" && !canRenderCachedReadOnlySurface && !canRenderSafeGlobalSurface) {
    const summaryOnly = currentPath === "#/runs" || currentPath === "#/approvals";
    const summary = summaryOnly
      ? currentPath === "#/runs"
        ? `直近summary: Run ${model.mvpState.run_summary?.total_count ?? model.mvpState.runs?.length ?? 0}件 / 停止 ${model.mvpState.run_summary?.blocked_count ?? 0}件 / 待機 ${model.mvpState.run_summary?.active_count ?? 0}件 / 完了 ${model.mvpState.run_summary?.completed_count ?? 0}件`
        : `直近summary: 承認待ち ${model.mvpState.approval_summary?.waiting_count ?? 0}件 / 期限切れ ${model.mvpState.approval_summary?.expired_count ?? 0}件`
      : undefined;
    return <ProjectUnavailablePage
      loading={model.mvpLoadStatus === "loading"}
      scopeLabel="MVP state"
      blocker={model.mvpLoadBlocker}
      summary={summary}
      reason={model.mvpLoadStatus === "loading" ? "MVP stateをAPIから確認しています。" : model.mvpLoadBlocker ? `MVP state readback blocker=${model.mvpLoadBlocker}` : "MVP stateを確認できませんでした。同期してから再確認してください。"}
    />;
  }
  if (currentPath === "#/chat") return <ChatPage model={model} />;
  if (currentPath === "#/approvals") return <ApprovalsPage model={model} />;
  if (currentPath === "#/runs") return <RunsPage model={model} />;
  if (currentPath === "#/templates") return <TemplatesPage model={model} />;
  if (currentPath === "#/admin") return <OwnerAdminPage model={model} />;
  if (currentPath === "#/plugins") return <TruthfulPluginsPage model={model} />;
  if (currentPath.endsWith("/plugins")) return <TruthfulPluginsPage model={model} />;
  if (currentPath === "#/production/status") return hasOwnerAdminAccess(model.mvpState) ? <TruthfulProductionStatusPage model={model} /> : <ProjectUnavailablePage reason="本番状態はOwner専用です。" />;
  if (currentPath === "#/system/pc-status") return <PcStatusPage model={model} />;
  if (currentPath === "#/projects" || currentPath === "#/projects/") return <ProjectDirectoryPage model={model} />;
  if (currentPath.includes("/projects/")) {
    if (model.mvpLoadStatus === "error" && !hasCachedCompanyScope) return <ProjectUnavailablePage reason="会社一覧を確認できませんでした。同期してから再度お試しください。" />;
    const projectOptions = projectOptionsFromState(model.mvpState);
    const requestedProject = projectSlugFromRoute(route);
    if (!projectOptions.length) return <ProjectUnavailablePage reason="会社はまだ登録されていません。API readbackで会社を確認してから自動化を作成してください。" />;
    if (!projectOptions.some((project) => project.id === requestedProject)) return <ProjectUnavailablePage reason="この会社は現在のAPI readbackでは確認できません。会社一覧から選び直してください。" />;
  }
  if (currentPath.includes("/job-admission")) return <JobApplicationAdmissionPage model={model} />;
  if (currentPath.includes("/performance")) return <TruthfulPerformancePage model={model} />;
  if (currentPath.includes("/automations/") && currentPath.includes("/edit")) return <BuilderPage model={model} />;
  if (currentPath.includes("/lanes")) return <TruthfulLanesPage model={model} />;
  if (currentPath.includes("/memory")) return <TruthfulMemoryPage model={model} />;
  if (currentPath.includes("/integrations") || currentPath.includes("/security")) return <TruthfulIntegrationsPage model={model} />;
  if (currentPath.includes("/artifacts")) return <TruthfulArtifactsPage model={model} />;
  if (currentPath.includes("/recovery")) return <TruthfulRecoveryPage model={model} />;
  if (currentPath.includes("/runs/")) return <TruthfulRunDetailPage model={model} />;
  if (currentPath.includes("/automations")) return <AutomationsPage model={model} />;
  // A company-root URL must stay company-scoped. Falling through to the
  // global HomePage makes the URL and the visible data disagree, which is
  // especially misleading when a user arrives from a company link or a
  // read-only route audit. Use the existing automation view as the stable
  // default section for a validated company root.
  if (/^#\/projects\/[^/]+$/u.test(currentPath)) return <AutomationsPage model={model} />;
  if (currentPath.includes("/projects/")) return <ProjectUnavailablePage reason="この会社画面は現在のルート契約では確認できません。会社タブから選び直してください。" />;
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
      go(chatHref({ companyId: createdCompanyId, context: "company-setup" }));
    } catch {
      setSetupNote("会社を登録できませんでした。入力内容とAPI接続を確認してください。");
      model.setReceipt("会社登録のreadbackを確認できなかったため、自動化作成画面には進みませんでした。");
    } finally {
      setCreatingCompany(false);
    }
  };
  const cachedCompanyScope = projectOptionsFromState(model.mvpState);
  if (model.mvpLoadStatus === "loading" && cachedCompanyScope.length === 0) return <ProjectUnavailablePage loading reason="会社一覧をAPIから確認しています。" />;
  if (model.mvpLoadStatus === "error" && cachedCompanyScope.length === 0) return <ProjectUnavailablePage reason="会社一覧を確認できませんでした。右上の同期から再取得してください。" />;
  const projects = projectOptionsFromState(model.mvpState);
  const companySetupPanel = (
    <Panel title={projects.length ? "会社を追加" : "最初の会社を登録"} controlId="projects.setup.panel">
      <form className="setup-form" onSubmit={createCompany}>
        <label htmlFor="company-name">会社名
          <input id="company-name" data-control-id="projects.setup.name" value={companyName} onChange={(event) => setCompanyName(event.target.value)} maxLength={120} autoComplete="organization" autoFocus={!projects.length} aria-describedby="company-setup-status" placeholder="例: 株式会社サンプル" />
        </label>
        <div className="button-row">
          <Button controlId="projects.setup.create" type="submit" variant="primary" disabled={creatingCompany || !companyName.trim()}>{creatingCompany ? "登録中" : "登録して自動化を作る"}</Button>
        </div>
        <div id="company-setup-status" className="action-note" role="status">{setupNote}</div>
      </form>
    </Panel>
  );
  return (
    <section>
      <PageTitle title="会社" desc="管理する会社と、その会社の自動化を選びます。" />
      {model.mvpLoadStatus !== "ready" && <div className="action-note warning" role="status">{model.mvpLoadStatus === "degraded" ? `表示中の会社一覧は直近のsummary readbackです。詳細readbackはバックグラウンドで再試行中です（blocker=${model.mvpLoadBlocker ?? "mvp_state_detail_readback_pending"}）。保存・実行は安全停止中で、read-only確認は利用できます。` : "表示中の会社一覧は直近のsummary readbackを取得中です。未取得の間は保存・実行を安全停止し、取得後にread-only表示へ切り替えます。"}</div>}
      {projects.length ? (
        <>
          <Panel title="会社一覧" controlId="home.company-list.panel">
            <div className="project-directory-grid">
              {projects.map(({ id, label, role }) => {
                const projectAutomations = (model.mvpState.automations ?? []).filter((item) => String(item.company_id ?? item.project_id ?? "") === id);
                const projectRuns = (model.mvpState.runs ?? []).filter((run) => String(run.company_id ?? run.project_id ?? "") === id || projectAutomations.some((item) => item.id === run.automation_id));
                const projectBlocked = projectRuns.filter((run) => ["blocked", "failed"].includes(String(run.status))).length;
                const projectQueued = projectRuns.filter((run) => ["queued", "pending", "running"].includes(String(run.status))).length;
                return <article className="project-directory-card" key={id}>
                  <div className="project-directory-head"><div><strong>{label}</strong><span>{role} / company scope</span></div><StatusBadge status={projectBlocked ? "blocked" : projectQueued ? "waiting" : "enabled"} label={projectBlocked ? "履歴要確認" : projectQueued ? "実行待ち" : "監視中"} /></div>
                  <div className="project-directory-stats"><span><strong>{projectAutomations.length}</strong> 自動化</span><span><strong>{projectRuns.length}</strong> Run</span><span><strong>{projectQueued}</strong> 待機/実行</span><span><strong>{projectBlocked}</strong> 要確認</span></div>
                  <p>{projectBlocked ? "この会社に確認が必要なRunがあります。" : projectQueued ? "Workerのclaimと同一Run readbackを確認します。" : "保存済みの会社scopeと自動化を確認できます。"}</p>
                  <Button controlId={`home.projects.open.${id}`} onClick={() => { rememberProject(id); go(`#/projects/${id}/automations`); }}>{label}を開く<ChevronRight size={14} /></Button>
                </article>;
              })}
            </div>
          </Panel>
          {companySetupPanel}
        </>
      ) : (
        companySetupPanel
      )}
    </section>
  );
}

function ProjectUnavailablePage({ reason, loading = false, scopeLabel = "会社", blocker, summary }: { reason: string; loading?: boolean; scopeLabel?: string; blocker?: string | null; summary?: string }) {
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loading]);
  const warmupTimedOut = loading && loadingSeconds >= 30;
  const warmupIsSlow = loading && loadingSeconds >= 8;
  const title = loading ? warmupTimedOut ? `${scopeLabel}の確認がタイムアウトしました` : `${scopeLabel}を確認中` : `${scopeLabel}を確認できません`;
  const description = loading
    ? "未確認の会社データや古いproofは表示せず、read-only APIの確認後に画面を切り替えます。"
    : "未確認の会社IDでは表示や保存を行いません。";
  const statusMessage = warmupTimedOut
    ? "read-only stateの確認に30秒以上かかっています。無限に待たず、右上の同期で安全に再試行してください。"
    : warmupIsSlow
      ? "read-only stateの準備が続いています。古い記録や未確認のproofは表示していません。"
      : reason;
  const readbackPhase = loading ? warmupTimedOut ? "error" : "loading" : "error";
  const exactBlocker = loading ? warmupTimedOut ? "mvp_state_readback_timeout" : "mvp_state_readback_pending" : blocker ?? "mvp_state_readback_unavailable";
  return (
    <section>
      <PageTitle title={title} desc={description} />
      <Panel title={`${scopeLabel} readback`} controlId="home.company-scope.panel">
        <p role="status" data-control-id="home.company-scope.readback-state" data-readback-phase={readbackPhase} data-exact-blocker={exactBlocker}>{statusMessage} / phase={readbackPhase} / blocker={exactBlocker}</p>
        {summary && <p className="action-note" role="status" data-control-id="home.company-scope.summary">{summary} / 詳細readback未確認。以下の件数だけを暫定表示しています。</p>}
        {loading && <p className="muted">状態が確認できるまで、保存・実行・外部操作の操作ボタンは表示しません。{warmupTimedOut ? "同期を押すとread-only確認だけを再試行します。" : ""}</p>}
        {!loading && <Button controlId="home.company-scope.back" onClick={() => go("#/")}>ホームへ戻る</Button>}
      </Panel>
    </section>
  );
}

function openFeedbackFor(comment: string, context: Record<string, unknown> = {}) {
  window.dispatchEvent(new CustomEvent("automation-os-open-feedback", { detail: { comment, context } }));
}

type PendingFeedback = { id: string; companyId: string };
const pendingFeedbackStorageKey = "aos-feedback-pending-v1";

function readPendingFeedback(): PendingFeedback | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(pendingFeedbackStorageKey) ?? "null");
    return value && /^feedback_ui_[a-zA-Z0-9_-]{16,100}$/.test(value.id) && typeof value.companyId === "string" && value.companyId
      ? { id: value.id, companyId: value.companyId } : null;
  } catch { return null; }
}

async function requestSavedFeedback(pending: PendingFeedback) {
  const response = await mvpFetch(`/api/mvp/feedback?company_id=${encodeURIComponent(pending.companyId)}&feedback_id=${encodeURIComponent(pending.id)}`, { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true || result.company_scope?.enforced !== true
    || result.company_scope.company_ids?.length !== 1 || result.company_scope.company_ids[0] !== pending.companyId
    || !Array.isArray(result.feedbacks) || result.feedbacks.length !== 1) throw new Error("feedback_result_unconfirmed");
  const row = result.feedbacks[0];
  if (row.id !== pending.id || row.feedback_id !== pending.id || row.company_id !== pending.companyId) throw new Error("feedback_result_scope_mismatch");
  return row;
}

function FeedbackWidget({ route, setReceipt, setMvpState, onSaved, readOnlyEvidenceMode = false }: { route: string; setReceipt: (value: string) => void; setMvpState: React.Dispatch<React.SetStateAction<MvpState>>; onSaved: (row: any) => void; readOnlyEvidenceMode?: boolean }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [capture, setCapture] = useState<any>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotStatus, setScreenshotStatus] = useState<"idle" | "capturing" | "ready" | "failed" | "skipped">("idle");
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false);
  const [feedbackContext, setFeedbackContext] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(readPendingFeedback);
  const pendingFeedbackRef = useRef(pendingFeedback);
  const submitRef = useRef(false);
  const rememberPending = (value: PendingFeedback | null) => {
    if (value) window.sessionStorage.setItem(pendingFeedbackStorageKey, JSON.stringify(value));
    else window.sessionStorage.removeItem(pendingFeedbackStorageKey);
    pendingFeedbackRef.current = value;
    setPendingFeedback(value);
  };
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
    if (submitRef.current) return;
    if (typeof preset?.comment === "string") setComment(preset.comment);
    setFeedbackContext(preset?.context ?? null);
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    if (pendingFeedbackRef.current) {
      setReceipt("前の送信結果を同じIDで照合してください。新しい送信や画面キャプチャは開始しません。");
      return;
    }
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
  const confirmSaved = async (pending: PendingFeedback) => {
    const row = await requestSavedFeedback(pending);
    onSaved(row);
    rememberPending(null);
    close();
    setReceipt(`フィードバックの保存を確認しました。id=${row.id} / screenshot=${row.screenshot_artifact_id ?? "none"} / inbox=local（外部転送なし）`);
  };
  const reconcile = async () => {
    if (submitRef.current || !pendingFeedbackRef.current) return;
    submitRef.current = true;
    setBusy(true);
    try { await confirmSaved(pendingFeedbackRef.current); }
    catch { setReceipt("保存結果は未確認です。同じIDの読取照合だけを行いました。送信は繰り返していません。"); }
    finally { submitRef.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (submitRef.current || pendingFeedbackRef.current) return;
    if (readOnlyEvidenceMode) {
      setReceipt("read-only evidence mode: フィードバック保存は未開始です / blocker=mvp_state_readback_not_ready");
      return;
    }
    const safeComment = redactSensitiveText(comment).trim();
    if (!safeComment) {
      setReceipt("コメントを入力してから送信してください。");
      return;
    }
    if (!sensitiveConfirmed) {
      setReceipt("secret、password、本人確認コードが映っていない確認にチェックしてください。");
      return;
    }
    const companyId = rememberedProject();
    if (!companyId) { setReceipt("送信先の会社を選択してください。"); return; }
    submitRef.current = true;
    try {
      setBusy(true);
      const pending = { id: newIdempotencyKey("feedback_ui").replace(/:/g, "_"), companyId };
      rememberPending(pending);
      const response = await mvpFetch("/api/mvp/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          company_id: companyId,
          project_id: companyId,
          feedback_id: pending.id,
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
      if (!response.ok || !result.ok) {
        if ([400, 403, 413, 415].includes(response.status) && ["feedback_comment_required", "feedback_id_invalid", "feedback_screenshot_sensitive_confirmation_required", "feedback_screenshot_too_large", "feedback_screenshot_mime_not_allowed", "company_scope_forbidden"].includes(result.error)) rememberPending(null);
        throw new Error(result.exact_blocker || result.error || "feedback_submit_failed");
      }
      if (result.feedback?.id !== pending.id || result.feedback?.company_id !== companyId) throw new Error("feedback_result_scope_mismatch");
      if (result.state) setMvpState(result.state);
      await confirmSaved(pending);
    } catch {
      setReceipt(pendingFeedbackRef.current ? "フィードバックの保存結果は未確認です。再送せず「保存結果を照合」で同じIDを確認してください。"
        : "フィードバックは未保存です。入力内容・会社権限を確認してください。");
    } finally {
      submitRef.current = false;
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
            <textarea id="feedback-panel-comment" ref={commentRef} data-control-id="feedback.panel.comment" aria-describedby="feedback-panel-comment-help" value={comment} disabled={busy || readOnlyEvidenceMode || Boolean(pendingFeedback)} onChange={(event) => setComment(event.target.value)} placeholder="どこが使いにくいか、期待した動き、実際の動きを書いてください。" />
          </label>
          <label className="feedback-confirm" htmlFor="feedback-panel-sensitive-confirm">
            <input id="feedback-panel-sensitive-confirm" data-control-id="feedback.panel.sensitive-confirm" type="checkbox" checked={sensitiveConfirmed} disabled={readOnlyEvidenceMode} onChange={(event) => setSensitiveConfirmed(event.target.checked)} />
            secret、password、token、本人確認コードが画面に映っていないことを確認しました
          </label>
          <p id="feedback-panel-comment-help" className="muted">{readOnlyEvidenceMode ? "read-only evidence mode: 最新のMVP state readbackが確認できるまで保存しません。" : "password、token、private key、本人確認コードが画面に映っている時は送らないでください。"}</p>
          <div className="button-row">
            {pendingFeedback && <p role="status">保存結果の確認待ち: {pendingFeedback.id} / {pendingFeedback.companyId}。閉じたり再読込しても、同じ記録を再送しません。</p>}
            {pendingFeedback && <Button controlId="feedback.panel.reconcile" disabled={busy} onClick={reconcile}>保存結果を照合</Button>}
            <Button controlId="feedback.panel.submit" variant="primary" icon={<MessageSquare size={14} />} disabled={busy || Boolean(pendingFeedback) || readOnlyEvidenceMode || !sensitiveConfirmed} onClick={submit}>{busy ? "保存確認中..." : "送信"}</Button>
          </div>
        </div>
      )}
    </>
  );
}

type PublicStateTone = "success" | "info" | "attention" | "neutral";

function PublicStateChip({ tone, label }: { tone: PublicStateTone; label: string }) {
  return <span className={`state-chip ${tone}`}>{label}</span>;
}

function runDisplayState(run: any): { label: string; tone: PublicStateTone; detail: string } {
  const status = String(run?.status ?? "").toLowerCase();
  if (isReadOnlyNoEffectReadbackComplete(run)) {
    return { label: "読取確認済み", tone: "info", detail: publicBlockerSummary(runBlockerValue(run)) };
  }
  if (["completed", "complete", "success", "succeeded"].includes(status)) {
    return { label: "完了", tone: "success", detail: "Runの完了状態をreadbackしました。業務完了proofは別途確認します。" };
  }
  if (["blocked", "failed"].includes(status)) {
    return { label: "要確認", tone: "attention", detail: publicBlockerSummary(run?.exact_blocker ?? run?.last_error) };
  }
  if (["cancelled", "canceled"].includes(status)) {
    return { label: "キャンセル", tone: "neutral", detail: "Runはキャンセル済みです。終端状態のため再実行せず、必要なら新しいRunを作成します。" };
  }
  if (status === "timed_out") {
    return { label: "タイムアウト", tone: "attention", detail: publicBlockerSummary(run?.exact_blocker ?? run?.last_error) };
  }
  if (status === "reconciliation_required") {
    return { label: "照合待ち", tone: "attention", detail: "外部効果の有無を照合するまで再実行しません。" };
  }
  if (["running", "leased"].includes(status)) {
    return { label: "実行中", tone: "info", detail: "Workerと同一Runの進行を確認しています。" };
  }
  if (["queued", "pending", "waiting_approval", "approval_required"].includes(status)) {
    return { label: status.includes("approval") ? "承認待ち" : "実行未確定", tone: "info", detail: status.includes("approval") ? "外部操作前に承認で停止しています。" : "QueueからWorkerのclaim/readbackを取得します。" };
  }
  return { label: "未確認", tone: "neutral", detail: "最新のRun readbackが必要です。" };
}

function runBusinessCompletionVerified(run: any): boolean {
  if (run?.business_completion_verified === true || run?.completion_verified === true) return true;
  const metadata = parseJsonRecord(run?.metadata_json);
  return metadata.business_completion_verified === true || verifiedBusinessReceiptForRun(run) !== null;
}

function proofRowsForRun(run: any, proofs: any[] = []): any[] {
  const runId = String(run?.id ?? "");
  if (!runId) return [];
  return proofs.filter((proof) => String(proof?.run_id ?? "") === runId);
}

function proofCountForRun(run: any, proofs: any[] = []): number {
  return proofRowsForRun(run, proofs).length;
}

function RunTimeline({ run, compact = false, proofCount = 0 }: { run: any; compact?: boolean; proofCount?: number }) {
  const state = runDisplayState(run);
  const raw = String(run?.status ?? "").toLowerCase();
  const businessCompletionVerified = runBusinessCompletionVerified(run);
  const currentIndex = businessCompletionVerified
    ? 4
    : ["completed", "complete", "success", "succeeded"].includes(raw)
      ? 3
    : ["running", "leased"].includes(raw)
      ? 2
      : ["queued", "pending", "waiting_approval", "approval_required"].includes(raw)
        ? 1
        : proofCount > 0
          ? 3
          : run?.started_at
            ? 2
            : 0;
  const stages = ["仕様", "Queue", "Worker", "Proof", businessCompletionVerified ? "業務完了verified" : "業務完了未claim"];
  return (
    <div className={`run-timeline ${compact ? "compact" : ""}`} data-control-id="run.timeline" aria-label={`Run進行: ${state.label}`}>
      <div className="run-timeline-head"><strong>Run進行</strong><PublicStateChip tone={state.tone} label={state.label} /></div>
      <div className="run-timeline-steps">
        {stages.map((stage, index) => (
          <div className={`run-timeline-step ${index < currentIndex ? "done" : index === currentIndex ? "current" : "pending"}`} key={stage}>
            <span className="run-timeline-dot" />
            <span>{stage}</span>
          </div>
        ))}
      </div>
      {!compact && <p className="muted">{state.detail}</p>}
    </div>
  );
}

function SetupProgress({ companyCount, automationCount, workerReady, proofReady }: { companyCount: number; automationCount: number; workerReady: boolean; proofReady: boolean }) {
  const steps = [
    { label: "会社", complete: companyCount > 0, detail: companyCount > 0 ? `${companyCount}社` : "登録が必要" },
    { label: "自動化", complete: automationCount > 0, detail: automationCount > 0 ? `${automationCount}件` : "最初の1件を作成" },
    { label: "Worker", complete: workerReady, detail: workerReady ? "readback確認済み" : "確認待ち" },
    { label: "Proof", complete: proofReady, detail: proofReady ? "記録あり" : "Run後に確認" }
  ];
  return (
    <div className="setup-progress" data-control-id="home.setup-progress" aria-label="AOSセットアップ進捗">
      {steps.map((step, index) => <div className={`setup-step ${step.complete ? "complete" : "pending"}`} key={step.label}>
        <span className="setup-step-number">{step.complete ? "✓" : index + 1}</span>
        <div><strong>{step.label}</strong><small>{step.detail}</small></div>
      </div>)}
    </div>
  );
}

function HomePriorityPanel({ model, waitingApprovals, blockedRuns, queuedRuns, waitingApprovalCount, blockedRunCount, queuedRunCount }: { model: AppModel; waitingApprovals: any[]; blockedRuns: any[]; queuedRuns: any[]; waitingApprovalCount?: number; blockedRunCount?: number; queuedRunCount?: number }) {
  const runtime = model.mvpState.browser_use_runtime;
  const remoteWorkerVerified = model.mvpState.worker?.heartbeat_fresh === true;
  const workerWaiting = model.mvpState.worker?.heartbeat_fresh === false || (!remoteWorkerVerified && runtime?.status === "readback_pending");
  const workerBlocked = Boolean(model.mvpState.worker?.exact_blocker) || (!remoteWorkerVerified && (runtime?.status === "blocked" || Boolean(runtime?.exactBlocker)));
  const waitingCount = waitingApprovalCount ?? waitingApprovals.length;
  const blockedCount = blockedRunCount ?? blockedRuns.length;
  const todayBlockedCount = model.mvpState.run_summary?.today_blocked_count
    ?? blockedRuns.filter((run) => jstDateKey(runTimestamp(run)) === jstDateKey(new Date())).length;
  const historicalBlockedCount = Math.max(0, blockedCount - todayBlockedCount);
  const queuedRunCountFallback = queuedRunCount ?? queuedRuns.length;
  const workerQueueCurrentCount = typeof model.mvpState.worker?.queue_current_count === "number"
    ? Math.max(0, model.mvpState.worker.queue_current_count)
    : queuedRunCountFallback;
  const workerQueueHistoricalCount = typeof model.mvpState.worker?.queue_historical_count === "number"
    ? Math.max(0, model.mvpState.worker.queue_historical_count)
    : 0;
  const priority = waitingCount
    ? { tone: "attention" as PublicStateTone, label: "承認待ち", title: `${waitingCount}件の外部操作が承認待ちです`, detail: "承認されるまで投稿・送信・応募などの外部操作は安全に停止しています。", action: "承認キューを確認", route: "#/approvals" }
    : todayBlockedCount
      ? { tone: "attention" as PublicStateTone, label: "今日の要確認", title: `今日の${todayBlockedCount}件のRunに確認が必要です`, detail: `過去の停止記録${historicalBlockedCount}件は別の履歴です。結果が不明な外部操作は同じ対象を照合し、再送しません。`, action: "要確認のRunを見る", route: "#/runs" }
      : workerBlocked
        ? { tone: "attention" as PublicStateTone, label: "Worker要確認", title: "Workerの実行経路に確認が必要です", detail: runtime?.exactBlocker ?? "Mac workerのexact blockerを確認してください。", action: "PC状態を見る", route: "#/system/pc-status" }
        : workerWaiting
          ? { tone: "info" as PublicStateTone, label: "Worker確認", title: "Companionの同一Run readbackを取得します", detail: "Worker heartbeatだけでは業務完了にしません。receipt、source sync、cleanupを同じRunで確認し、未取得ならexact blockerを確定します。", action: "PC状態を見る", route: "#/system/pc-status" }
          : workerQueueCurrentCount
            ? { tone: "info" as PublicStateTone, label: "実行未確定", title: `${workerQueueCurrentCount}件のWorker claim/readbackを取得します`, detail: "Queue投入だけでは業務完了と扱いません。Worker claimと同一Run readbackが必要です。", action: "実行履歴を見る", route: "#/runs" }
            : workerQueueHistoricalCount
              ? { tone: "info" as PublicStateTone, label: "履歴確認", title: `履歴queue ${workerQueueHistoricalCount}件は再利用しません`, detail: "過去のqueued記録は現行実行ではありません。状態変化後に新しいidempotencyでread-only確認を行います。", action: "実行履歴を見る", route: "#/runs" }
              : historicalBlockedCount
                ? { tone: "info" as PublicStateTone, label: "過去の履歴", title: `今日の停止Runはありません / 過去の停止記録${historicalBlockedCount}件`, detail: "過去の失敗・テスト記録は保持しています。現在の稼働停止や再実行が必要な件数とは限りません。", action: "実行履歴を見る", route: "#/runs" }
                : { tone: "success" as PublicStateTone, label: "状態確認済み", title: "現在、表示対象の要対応はありません", detail: "この画面のreadback結果です。外部操作の完了は各Runの実結果で確認します。", action: "自動化を確認", route: "#/projects" };
  const visibleDetail = priority.tone === "attention" && priority.label === "Worker要確認"
    ? publicBlockerSummary(priority.detail)
    : priority.detail;
  return (
    <div className={`home-priority-panel ${priority.tone}`} data-control-id="home.priority.panel">
      <div className="home-priority-copy">
        <div className="home-priority-label"><span>いま最初に見ること</span><PublicStateChip tone={priority.tone} label={priority.label} /></div>
        <h2>{priority.title}</h2>
        <p>{visibleDetail}</p>
      </div>
      <Button controlId="home.priority.action" variant={priority.tone === "attention" ? "primary" : "secondary"} onClick={() => go(priority.route)}>{priority.action}<ChevronRight size={15} /></Button>
    </div>
  );
}

function HomeTodayDigest({ mvpState, automationCount, waitingApprovals, blockedRuns, waitingApprovalCount, blockedRunCount }: { mvpState: MvpState; automationCount: number; waitingApprovals: any[]; blockedRuns: any[]; waitingApprovalCount?: number; blockedRunCount?: number }) {
  const today = jstDateKey(new Date());
  const todayRuns = (mvpState.runs ?? []).filter((run) => jstDateKey(runTimestamp(run)) === today);
  const completed = mvpState.run_summary?.today_completed_count ?? todayRuns.filter((run) => isRunCompletedStatus(run.status)).length;
  const stopped = mvpState.run_summary?.today_blocked_count ?? todayRuns.filter((run) => isRunStoppedStatus(run.status)).length;
  const active = mvpState.run_summary?.today_active_count ?? todayRuns.filter((run) => isRunActiveStatus(run.status)).length;
  const todayCount = mvpState.run_summary?.today_count ?? todayRuns.length;
  const waitingCount = waitingApprovalCount ?? waitingApprovals.length;
  const blockedCount = blockedRunCount ?? blockedRuns.length;
  const metrics = [
    { label: "今日のRun", value: String(todayCount), detail: `完了 ${completed} / 実行中・待機 ${active}`, tone: todayCount ? "info" : "neutral" },
    { label: "要確認", value: String(stopped), detail: stopped ? "今日の停止理由と次の操作を確認" : blockedCount ? `今日なし / 過去の停止記録 ${blockedCount}件` : "現在の停止Runなし", tone: stopped ? "attention" : "success" },
    { label: "承認待ち", value: String(waitingCount), detail: waitingCount ? "外部操作前で停止中" : "確認待ちはありません", tone: waitingCount ? "attention" : "success" },
    { label: "登録自動化", value: String(automationCount), detail: "下書き・対象外を含む全会社の登録数", tone: automationCount ? "success" : "neutral" }
  ];
  return (
    <Panel title={`今日の概要 / ${jstDateLabel()}`} controlId="home.today-digest.panel">
      <div className="today-digest-grid" aria-label="今日のAOS digest">
        {metrics.map((metric) => <div className={`today-digest-item ${metric.tone}`} key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <small>{metric.detail}</small>
        </div>)}
      </div>
      <details className="home-inline-details"><summary>集計の対象と見方</summary><p className="today-digest-note">全会社の登録状況と履歴を集計しています。会社1の今回の利用対象は下のBriefで確認してください。今日の件数はJSTのRun更新時刻を基準にし、候補発見・キュー登録・外部効果・業務完了を別状態として扱います。</p></details>
    </Panel>
  );
}

function HomeCompanyBrief({ companies }: { companies: Array<{ id: string; label: string }> }) {
  const companyOneId = "company_2560580981cedfd106b66245";
  const [period, setPeriod] = useState<"morning" | "evening">(() => new Date().getHours() >= 15 ? "evening" : "morning");
  const [readbacks, setReadbacks] = useState<Record<string, { status: "ready" | "error"; bundle?: any; exactBlocker?: string }>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [delivering, setDelivering] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const loadInFlightRef = useRef(false);
  const companyKey = companies.map((company) => company.id).join(",");
  const load = async (requestedPeriod = period) => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setRefreshing(true);
    setStatus("loading");
    const entries = await Promise.all(companies.map(async (company) => {
      try {
        const response = await withMvpDetailReadbackTimeout(
          mvpFetch(`/api/v1/companies/${encodeURIComponent(company.id)}/brief?brief_type=${requestedPeriod}&business_date=${encodeURIComponent(jstDateKey(new Date()) ?? "unknown-date")}&timezone=Asia%2FTokyo`, { cache: "no-store" }),
          HOME_BRIEF_READBACK_TIMEOUT_MS,
          "company_brief_readback_timeout",
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) throw new Error(String(body.exact_blocker ?? body.exactBlocker ?? body.error ?? `company_brief_http_${response.status}`));
        return [company.id, { status: "ready" as const, bundle: body }];
      } catch (error) {
        return [company.id, { status: "error" as const, exactBlocker: error instanceof Error ? error.message : "company_brief_readback_failed" }];
      }
    }));
    const next = Object.fromEntries(entries) as Record<string, { status: "ready" | "error"; bundle?: any; exactBlocker?: string }>;
    setReadbacks(next);
    setStatus(Object.values(next).some((entry) => entry.status === "error") ? "error" : "ready");
    setRefreshing(false);
    loadInFlightRef.current = false;
  };
  const deliver = async (companyId: string) => {
    if (companyId !== companyOneId || delivering) return;
    setDelivering(`${companyId}:${period}`);
    setDeliveryError(null);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/brief/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": newIdempotencyKey("brief-home-delivery") },
        body: JSON.stringify({
          brief_type: period,
          business_date: jstDateKey(new Date()) ?? "unknown-date",
          timezone: "Asia/Tokyo",
          template_version: "v1"
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(String(body.exact_blocker ?? body.exactBlocker ?? body.error ?? `company_brief_delivery_http_${response.status}`));
      await load(period);
    } catch (error) {
      setDeliveryError(error instanceof Error ? error.message : "company_brief_delivery_failed");
    } finally {
      setDelivering(null);
    }
  };
  React.useEffect(() => {
    if (companies.length === 0) {
      setReadbacks({});
      setStatus("ready");
      return;
    }
    void load(period);
  }, [companyKey, period]);
  return <Panel title="今日の仕事" controlId="home.company-brief.panel">
    <p className="muted">会社ごとの仕事の状態と、今日の確認事項を表示します。外部への送信や公開はここでは行いません。</p>
    <div className="button-row" role="group" aria-label="会社別Briefの期間">
      <Button controlId="home.company-brief.morning" variant={period === "morning" ? "primary" : "secondary"} onClick={() => setPeriod("morning")}>朝Brief</Button>
      <Button controlId="home.company-brief.evening" variant={period === "evening" ? "primary" : "secondary"} onClick={() => setPeriod("evening")}>夜Brief</Button>
      <Button controlId="home.company-brief.refresh" icon={<RefreshCw size={14} />} disabled={refreshing} onClick={() => { void load(period); }}>{refreshing ? "確認中" : "fresh readback"}</Button>
    </div>
    {deliveryError ? <p className="muted" role="alert">Home配信のexact blocker={deliveryError}</p> : null}
    {status === "loading" ? <ReadbackState title="会社別Briefを自動確認中" detail="各会社の登録automationを同時にreadbackしています。結果が取れなければ会社ごとのexact blockerを確定します。" tone="info" nextAction="自動再読込を実行し、失敗時は会社ごとのexact blockerを表示する" />
      : status === "error" ? <ReadbackState title="一部の会社Briefを確認できません" detail="会社ごとのexact blockerを下に表示しています。確認できない会社の値は推測しません。" tone="attention" nextAction="会社scopeとAOS serverのhealthをfresh確認する" />
        : null}
    <div className="section-grid" data-control-id="home.company-brief.companies">
      {companies.map((company) => {
        const entry = readbacks[company.id];
        const briefCompany = entry?.bundle?.companies?.find((item: any) => item.company_id === company.id);
        const items = Array.isArray(briefCompany?.items) ? briefCompany.items : [];
        const automationItems = items.filter((item: any) => String(item?.record_id ?? "").startsWith("mvp_automation:"));
        const auxiliaryItems = Math.max(0, items.length - automationItems.length);
        const delivery = entry?.bundle?.delivery;
        const latestDelivery = entry?.bundle?.latest_delivery ?? (delivery?.status === "delivered" ? delivery : null);
        return <div className="preview-box" key={company.id} data-control-id={`home.company-brief.company.${company.id}`}>
          <strong>{company.label}</strong>
          {entry?.status === "error" ? <p className="muted">readback未確認 / exact blocker={entry.exactBlocker ?? "unknown"}</p> : <>
            {entry?.bundle?.scope_note ? <p className="muted">{entry.bundle.scope_note}</p> : null}
            <p className="muted">確認対象 {automationItems.length}件 / 状態={briefCompany?.status ?? "未確認"}</p>
            <details className="home-inline-details" data-control-id={`home.company-brief.items.${company.id}`}>
              <summary>仕事の詳細を表示（{automationItems.length}件）</summary>
              {automationItems.length ? automationItems.map((item: any) => <div key={item.record_id} className="job-classification-note">
                <strong>{item.title}</strong><span>{item.summary}</span><small>次: {item.next_action ?? "未設定"}</small>
              </div>) : <p className="muted">表示対象の仕事はありません。</p>}
            </details>
            <details className="home-inline-details"><summary>更新情報</summary>{latestDelivery ? <p className="muted" data-control-id="home.company-brief.last-delivery">最終更新: {latestDelivery.delivered_at}{entry?.bundle?.latest_delivery_matches_current === false ? "（配信後に状態が更新されています）" : "（現在の内容と一致）"}</p> : <p className="muted">まだHome更新はありません。</p>}<p className="muted">補助情報 {auxiliaryItems}件 / 除外 {entry?.bundle?.counts?.excluded_records ?? 0}件 / delivery={delivery?.status ?? "not_attempted"}</p>{latestDelivery ? <p className="muted">配信Run: {latestDelivery.run_id} / receipt・source sync・reconciliation・cleanupを確認済み</p> : null}</details>
            {company.id === companyOneId ? <div className="button-row">
              <Button controlId="home.company-brief.deliver" variant="primary" disabled={Boolean(delivering) || refreshing || !briefCompany} onClick={() => { void deliver(company.id); }}>
                {delivering === `${company.id}:${period}` ? "Homeへ配信中" : latestDelivery ? "最新内容をHomeへ再配信" : "AOS Homeに配信"}
              </Button>
              {latestDelivery ? <small className="muted">最終配信の証拠: receipt=verified / source sync=synced / reconciliation=reconciled / cleanup=verified</small> : null}
            </div> : null}
          </>}
        </div>;
      })}
    </div>
    <p className="muted" role="status" data-control-id="home.company-brief.boundary">source=AOS DB / Home delivery=internal / external notification=false / external_action=false</p>
  </Panel>;
}

function HomeSchedulerControl({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "blocked">("idle");
  const [message, setMessage] = useState("Company 1の自然tickと短期soakを、外部効果なしで実行できます。");
  const runOperation = async (operation: "run-once" | "natural-tick" | "soak") => {
    if (status === "running") return;
    setStatus("running");
    const label = operation === "run-once" ? "scheduler canary" : operation === "natural-tick" ? "自然tick" : "短期soak";
    setMessage(`${label}を実行し、同じCompany 1 scopeのscheduler receiptをreadbackしています。`);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/scheduler/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: operation === "soak" ? JSON.stringify({ cycles: 3, interval_ms: 1_000 }) : JSON.stringify({ reason: `owner_requested_no_effect_${operation}` })
      });
      const body = await response.json().catch(() => ({}));
      const exactBlocker = body.exactBlocker ?? body.exact_blocker ?? body.error ?? null;
      if (!response.ok || body.ok === false) {
        setStatus("blocked");
        setMessage(`${label}はexact blockerで確定しました: ${String(exactBlocker ?? `http_${response.status}`)}`);
        return;
      }
      setStatus("complete");
      const tick = body.tick ?? body;
      const materialized = operation === "soak"
        ? Array.isArray(body.runIds) ? body.runIds.length : 0
        : Array.isArray(tick.portableRunIds) ? tick.portableRunIds.length + (Array.isArray(tick.occurrences) ? tick.occurrences.length : 0) : 0;
      setMessage(`${label}完了 / status=${String(body.status ?? tick.status ?? "unknown")} / materialized=${materialized}件 / service_user=${String(tick.serviceUserSource ?? "readback")} / duplicate=${Array.isArray(body.duplicateRunIds) ? body.duplicateRunIds.length : 0}件 / external_action=false`);
    } catch (error) {
      setStatus("blocked");
      setMessage(`${label}のreadbackに失敗しました: ${error instanceof Error ? error.message : "scheduler_operation_failed"}`);
    }
  };
  return <Panel title="Company 1 scheduler" controlId="home.scheduler.panel">
    <p className="muted">自然tickは実時刻で1回、短期soakは同じCompany 1 scopeで3回実行します。いずれもdurable queueのmaterializationだけで、外部操作・通知・送信は行いません。</p>
    <div className="button-row">
      <Button controlId="home.scheduler.run-once" disabled={status === "running"} onClick={() => { void runOperation("run-once"); }}>
        {status === "running" ? "scheduler実行中" : "canary"}
      </Button>
      <Button controlId="home.scheduler.natural-tick" variant="primary" disabled={status === "running"} onClick={() => { void runOperation("natural-tick"); }}>自然tickを実行</Button>
      <Button controlId="home.scheduler.soak" disabled={status === "running"} onClick={() => { void runOperation("soak"); }}>短期soakを実行</Button>
    </div>
    <p className={`muted ${status === "blocked" ? "attention" : ""}`} role="status" data-control-id="home.scheduler.status">{message}</p>
  </Panel>;
}

function HomeObsidianBusinessControl({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<"idle" | "preparing" | "approval" | "running" | "complete" | "blocked">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [message, setMessage] = useState("固定の非公開Obsidian backupだけをAOS承認付きで実行できます。");
  const start = async () => {
    if (status === "preparing" || status === "running") return;
    setStatus("preparing");
    setMessage("fresh source readbackを作成し、固定target-bound approvalを準備しています。");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/portable-local/obsidian-project-memory-audit/business-run`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const body = await response.json().catch(() => ({}));
      const exactBlocker = body.exactBlocker ?? body.exact_blocker ?? body.error ?? null;
      if (!response.ok || body.ok === false) {
        setStatus("blocked");
        setMessage(`Obsidian business runはexact blockerで停止しました: ${String(exactBlocker ?? `http_${response.status}`)}`);
        return;
      }
      const nextRunId = typeof body.run?.id === "string" ? body.run.id : null;
      const nextApprovalId = typeof body.approval?.id === "string" ? body.approval.id : null;
      setRunId(nextRunId);
      setApprovalId(nextApprovalId);
      setStatus(nextApprovalId && body.approval.status === "pending" ? "approval" : "running");
      setMessage(nextApprovalId && body.approval.status === "pending"
        ? `固定targetのAOS承認待ちです / run=${nextRunId ?? "unknown"}`
        : `Obsidian business runを開始しました / run=${nextRunId ?? "unknown"}`);
    } catch (error) {
      setStatus("blocked");
      setMessage(`Obsidian business runの準備に失敗しました: ${error instanceof Error ? error.message : "obsidian_business_run_failed"}`);
    }
  };
  const approve = async () => {
    if (!approvalId || status !== "approval") return;
    setStatus("running");
    setMessage("固定target-bound approvalを承認し、Mac worker receiptをreadbackしています。");
    try {
      const response = await mvpFetch(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, { method: "POST", headers: { "content-type": "application/json" } });
      const body = await response.json().catch(() => ({}));
      const exactBlocker = body.exactBlocker ?? body.exact_blocker ?? body.error ?? null;
      if (!response.ok || body.ok === false) {
        setStatus("blocked");
        setMessage(`Obsidian approvalはexact blockerで停止しました: ${String(exactBlocker ?? `http_${response.status}`)}`);
        return;
      }
      const detail = runId ? await mvpFetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" }).then((result) => result.json().catch(() => ({}))) : {};
      const detailStatus = String(detail.status ?? detail.run?.status ?? "queued");
      setStatus(detailStatus === "complete" ? "complete" : detailStatus === "blocked" ? "blocked" : "running");
      setMessage(`Obsidian approval完了 / run_status=${detailStatus} / fixed_private_remote=true / external_action=${detailStatus === "complete" ? "verified" : "readback_pending"}`);
    } catch (error) {
      setStatus("blocked");
      setMessage(`Obsidian approvalのreadbackに失敗しました: ${error instanceof Error ? error.message : "obsidian_approval_failed"}`);
    }
  };
  return <Panel title="Obsidian private backup" controlId="home.obsidian-business.panel">
    <p className="muted">Company 1の固定vaultから、非公開GitHub repositoryのmainだけへ同期します。source readback・AOS承認・Mac worker receipt・remote parityが揃わない限り完了扱いにしません。</p>
    <div className="button-row">
      <Button controlId="home.obsidian-business.start" variant="primary" disabled={status === "preparing" || status === "running"} onClick={() => { void start(); }}>
        {status === "preparing" ? "同期準備中" : "Obsidianを同期準備"}
      </Button>
      {status === "approval" ? <Button controlId="home.obsidian-business.approve" variant="primary" onClick={() => { void approve(); }}>固定targetを承認して同期</Button> : null}
    </div>
    <p className={`muted ${status === "blocked" ? "attention" : ""}`} role="status" data-control-id="home.obsidian-business.status">{message}</p>
  </Panel>;
}

function blockerGroupLabel(run: any, mvpState?: MvpState) {
  const exactValue = runBlockerValue(run, mvpState);
  const exact = String(exactValue ?? "").trim();
  const normalized = exact.toLowerCase();
  if (!exact) return "停止理由を取得できません";
  if (normalized.includes("worker") || normalized.includes("heartbeat") || normalized.includes("scope")) return "Mac Worker・会社scope";
  if (normalized.includes("auth") || normalized.includes("login") || normalized.includes("credential")) return "認証・接続";
  if (normalized.includes("browser") || normalized.includes("chrome") || normalized.includes("profile") || normalized.includes("port")) return "Chrome Plugin・Profile 2";
  if (normalized.includes("approval")) return "承認";
  return "その他の確認";
}

function runBlockerFilterKey(run: any, mvpState?: MvpState) {
  const exact = String(runBlockerValue(run, mvpState) ?? "").trim().toLowerCase();
  if (!exact) return "__unknown__";
  if (exact.includes("worker") || exact.includes("heartbeat") || exact.includes("scope")) return "__worker__";
  if (exact.includes("auth") || exact.includes("login") || exact.includes("credential")) return "__auth__";
  if (exact.includes("browser") || exact.includes("chrome") || exact.includes("profile") || exact.includes("port")) return "__chrome__";
  if (exact.includes("approval")) return "__approval__";
  return "__other__";
}

function BlockerTriage({ runs, collapsed = false, totalCount }: { runs: any[]; collapsed?: boolean; totalCount?: number }) {
  const groups = new Map<string, any[]>();
  runs.forEach((run) => {
    const key = blockerGroupLabel(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  });
  const effectiveTotal = totalCount ?? runs.length;
  const content = groups.size ? <div className="blocker-triage">
    {[...groups.entries()].map(([label, items], index) => <div className="blocker-triage-item" key={label}>
      <div><strong>{label}</strong><span>{items.length}件</span></div>
      <p>{publicBlockerSummary(runBlockerValue(items[0]))}</p>
      <Button controlId={`home.blocker-triage.${index}`} onClick={() => go(`#/runs?blocker=${encodeURIComponent(runBlockerFilterKey(items[0]))}`)}>この原因のRunを見る</Button>
    </div>)}
  </div> : effectiveTotal > 0 ? <div className="empty-state attention"><strong>要確認のRun {effectiveTotal}件</strong><span>停止理由の詳細は実行履歴のfresh readbackで確認します。件数だけのsummaryを、原因確認済みとは扱いません。</span><Button controlId="home.blocker-triage.open-runs" onClick={() => go("#/runs")}>実行履歴で詳細を見る</Button></div> : <div className="empty-state success"><strong>現在、要確認のRunはありません</strong><span>外部効果のreceiptと業務完了proofは、Runごとに確認します。</span></div>;
  if (collapsed) {
    return <details className="runs-blocker-triage" data-control-id="runs.blocker-triage.panel">
      <summary>要確認の原因をまとめて見る（{groups.size}種類 / {effectiveTotal}件）</summary>
      <Panel title="要確認の原因" controlId="runs.blocker-triage.details">{content}</Panel>
    </details>;
  }
  return <Panel title="要確認の原因" controlId="home.blocker-triage.panel">{content}</Panel>;
}

function HomeBrowserDetails({ model, projectId }: { model: AppModel; projectId?: string }) {
  return <details className="home-browser-details" data-control-id="home.browser-details">
    <summary>Browser Use / Worker / Companion復旧の詳細を開く</summary>
    {projectId ? <WebOperationAdmissionPanel model={model} projectId={projectId} /> : <WebOperationAdmissionPanel model={model} />}
  </details>;
}

function ControlPlaneRolesPanel({ collapsed = false }: { collapsed?: boolean } = {}) {
  const roles: Array<[string, string, string, PublicStateTone]> = [
    ["AOS Control Plane", "仕様・Queue・承認・状態を保持", "ここが正本。queuedだけでは完了扱いしません。", "info" as PublicStateTone],
    ["Codex App", "登録・会話・triggerの入口", "登録されたことと実行されたことを分けます。", "neutral" as PublicStateTone],
    ["Mac Worker", "同一Runのclaim・Browser実行", "heartbeat、scope、receiptをfresh readbackします。", "attention" as PublicStateTone],
    ["Proof / Source", "外部効果・業務完了の証明", "provider receiptとsource syncが揃うまで未claimです。", "success" as PublicStateTone]
  ];
  const content = <div className="role-map">
      {roles.map(([title, summary, detail, tone]) => <div className="role-card" key={title}>
        <div className="role-card-head"><strong>{title}</strong><PublicStateChip tone={tone} label={title === "Proof / Source" ? "証明" : "役割"} /></div>
        <span>{summary}</span>
        <small>{detail}</small>
      </div>)}
    </div>;
  if (collapsed) {
    return <details className="home-secondary-details" data-control-id="home.roles.details">
      <summary>AOSの役割と完了条件を詳しく見る</summary>
      <div className="home-secondary-details-body">{content}</div>
    </details>;
  }
  return <Panel title="AOSの役割と完了条件" controlId="home.roles.panel">{content}</Panel>;
}

function HomePage({ model }: { model: AppModel }) {
  const { setReceipt, automationRows, mvpState, feedbackReadback } = model;
  if (model.mvpLoadStatus === "loading" || model.mvpLoadStatus === "error") {
    return (
      <section>
        <PageTitle title="ホーム" desc="会社と自動化の最新状態を確認します。" />
        <Panel title="状態を確認中" controlId="home.api-readback.panel">
          <p>{model.mvpLoadStatus === "loading" ? "最新状態を取得しています。件数は取得完了後に表示します。" : "最新状態を確認できませんでした。右上の同期から再取得してください。"}</p>
        </Panel>
      </section>
    );
  }
  if (model.mvpLoadStatus === "degraded") {
    const companyOptions = projectOptionsFromState(mvpState);
    const runSummary = mvpState.run_summary ?? {};
    const approvalSummary = mvpState.approval_summary ?? {};
    const firstCompany = companyOptions[0];
    return (
      <section>
        <PageTitle title="ホーム" desc="現在確認できている概要を表示しています。" />
        <div className="action-note warning" role="status" data-control-id="home.degraded-readback">詳細状態の確認が終わるまで、保存・送信・定期実行の変更は停止しています。確認できる範囲の閲覧と安全な導線は利用できます。</div>
        <div className="cards degraded-summary" data-control-id="home.degraded-summary">
          <MetricCard controlId="home.degraded-summary.companies" title="会社" value={`${companyOptions.length}社`} sub="確認済みの会社" status="draft" />
          <MetricCard controlId="home.degraded-summary.runs" title="Run" value={`${runSummary.total_count ?? 0}件`} sub={`停止=${runSummary.blocked_count ?? 0}`} status="draft" />
          <MetricCard controlId="home.degraded-summary.approvals" title="承認" value={`${approvalSummary.waiting_count ?? 0}件`} sub={`期限切れ=${approvalSummary.expired_count ?? 0}`} status="draft" />
          <MetricCard controlId="home.degraded-summary.external" title="外部操作" value="未実行" sub="承認前は安全に停止" status="enabled" />
        </div>
        <Panel title="今できること" controlId="home.degraded-next.panel">
          <p className="muted">詳細状態が戻るまで、no-effectの手動確認だけを案内します。応募送信・投稿・保存・承認変更は開始しません。</p>
          <div className="button-row">
            {firstCompany && <Button controlId="home.degraded.automations" variant="primary" onClick={() => go(`#/projects/${firstCompany.id}/automations`)}>仕事を確認</Button>}
            <Button controlId="home.degraded.chat" onClick={() => go(firstCompany ? chatHref({ companyId: firstCompany.id, context: "degraded-summary" }) : "#/chat")}>Chatを開く</Button>
            <Button controlId="home.degraded.runs" onClick={() => go("#/runs")}>Run summaryを見る</Button>
            <Button controlId="home.degraded.sync" onClick={() => go("#/projects")}>会社scopeを見る</Button>
          </div>
        </Panel>
      </section>
    );
  }
  const companyOptions = projectOptionsFromState(mvpState);
  const waitingApprovals = (mvpState.approvals ?? []).filter((approval) => isApprovalWaiting(approval.status, approval.expires_at));
  const expiredApprovals = (mvpState.approvals ?? []).filter((approval) => isApprovalExpired(approval.status, approval.expires_at));
  const blockedRuns = (mvpState.runs ?? []).filter((run) => isRunStoppedStatus(run.status));
  const queuedRuns = (mvpState.runs ?? []).filter((run) => isRunActiveStatus(run.status));
  const waitingApprovalCount = mvpState.approval_summary?.waiting_count ?? waitingApprovals.length;
  const expiredApprovalCount = mvpState.approval_summary?.expired_count ?? expiredApprovals.length;
  const runCount = mvpState.run_summary?.total_count ?? mvpState.runs?.length ?? 0;
  const blockedRunCount = mvpState.run_summary?.blocked_count ?? blockedRuns.length;
  const homeTodayBlockedCount = mvpState.run_summary?.today_blocked_count
    ?? blockedRuns.filter((run) => jstDateKey(runTimestamp(run)) === jstDateKey(new Date())).length;
  const queuedRunCount = mvpState.run_summary?.active_count ?? queuedRuns.length;
  const homeQueueCurrentCount = typeof mvpState.worker?.queue_current_count === "number"
    ? Math.max(0, mvpState.worker.queue_current_count)
    : queuedRunCount;
  const homeQueueHistoricalCount = typeof mvpState.worker?.queue_historical_count === "number"
    ? Math.max(0, mvpState.worker.queue_historical_count)
    : 0;
  const jobCount = mvpState.job_summary?.total_count ?? mvpState.jobs?.length ?? 0;
  const queuedJobCount = mvpState.job_summary?.queued_count ?? (mvpState.jobs ?? []).filter((job) => job.status === "queued").length;
  const activeJobCount = mvpState.job_summary?.leased_count ?? (mvpState.jobs ?? []).filter((job) => job.status === "leased").length;
  const feedbackRows = feedbackItemsFromState({ ...mvpState, feedbacks: feedbackReadback });
  const openFeedbackCount = feedbackRows.filter((item) => item.status === "open").length;
  const triagedFeedbackCount = feedbackRows.filter((item) => item.status === "triaged").length;
  const workerReady = mvpState.browser_use_runtime?.status === "verified" || mvpState.worker?.heartbeat_fresh === true;
  const proofReady = (mvpState.proofs ?? []).length > 0 || (mvpState.proof_summary?.total_count ?? 0) > 0;
  const latestRun = [...(mvpState.runs ?? [])].sort((a, b) => (Date.parse(String(b.updated_at ?? b.created_at ?? b.queued_at ?? "")) || 0) - (Date.parse(String(a.updated_at ?? a.created_at ?? a.queued_at ?? "")) || 0))[0] ?? null;
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
        <HomeBrowserDetails model={model} />
      </section>
    );
  }
  const pristineCompany = automationRows.length === 0
    && waitingApprovalCount === 0
    && expiredApprovalCount === 0
    && runCount === 0
    && jobCount === 0;
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
        <HomeBrowserDetails model={model} projectId={companyOptions[0].id} />
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
              {companyOptions.map((project) => <Button controlId={`home.first-use.company.${project.id}`} key={project.id} onClick={() => { rememberProject(project.id); go(chatHref({ companyId: project.id, context: "home-company-picker" })); }}>{project.label}で作る</Button>)}
            </div>
          </div>
        </Panel>
        <HomeBrowserDetails model={model} />
      </section>
    );
  }
  const nextAction = waitingApprovalCount
      ? { label: "承認を確認", route: "#/approvals", icon: <ClipboardCheck size={15} /> }
    : expiredApprovalCount
      ? { label: "期限切れを確認", route: "#/approvals", icon: <ClipboardCheck size={15} /> }
    : blockedRunCount
      ? { label: "要確認の実行を見る", route: "#/runs", icon: <Activity size={15} /> }
      : { label: "実行履歴を確認", route: "#/runs", icon: <Activity size={15} /> };
  const manualRunProject = resolveProjectSelection(mvpState, companyOptions.length === 1 ? companyOptions[0].id : undefined);
  const manualRunRoute = manualRunProject ? `#/projects/${manualRunProject}/automations` : "#/projects";
  const projectCards = [
    {
      title: "会社",
      value: `${companyOptions.length}社`,
      sub: `自動化 ${automationRows.length}件`,
      status: companyOptions.length ? "enabled" : "waiting"
    },
    {
      title: "承認",
      value: `${waitingApprovalCount}件`,
      sub: `${expiredApprovalCount ? `期限切れ ${expiredApprovalCount}件 / ` : ""}外部操作前に停止する確認待ち`,
      status: waitingApprovalCount ? "waiting" : expiredApprovalCount ? "blocked" : "enabled"
    },
    {
      title: "実行履歴",
      value: `${runCount}件`,
      sub: `記録上未完 Run ${queuedRunCount} / fresh queue ${homeQueueCurrentCount} / historical ${homeQueueHistoricalCount} / 今日の停止 ${homeTodayBlockedCount}`,
      status: homeQueueCurrentCount ? "running" : homeTodayBlockedCount ? "blocked" : "enabled"
    },
    {
      title: "Jobs",
      value: `${jobCount}件`,
      sub: `queued ${queuedJobCount} / active ${activeJobCount}`,
      status: activeJobCount ? "running" : queuedJobCount ? "waiting" : "enabled"
    }
  ];
  const liveRows = automationRows.length ? automationRows.map((item) => [
    displayedAutomationLane(item.lane, mvpState.web_operation_backend?.backend),
    projectLabelFromState(mvpState, item.project_id),
    item.name,
    <StatusBadge status={item.status} />,
    <Button controlId={`home.row.open.${item.project_id}.${item.id}`} onClick={() => go(`#/projects/${item.project_id}/automations`)}>自動化一覧を開く</Button>
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
      <PageTitle title="ホーム" desc="今日の仕事、要対応、最新の実行結果を確認します。">
        <Button controlId="home.manual-run.open" onClick={() => go(manualRunRoute)} icon={<Play size={15} />}>手動実行を開く</Button>
        <Button controlId="home.next.open" variant="primary" icon={nextAction.icon} onClick={() => go(nextAction.route)}>{nextAction.label}</Button>
      </PageTitle>
      <HomePriorityPanel model={model} waitingApprovals={waitingApprovals} blockedRuns={blockedRuns} queuedRuns={queuedRuns} waitingApprovalCount={waitingApprovalCount} blockedRunCount={blockedRunCount} queuedRunCount={queuedRunCount} />
      <HomeTodayDigest mvpState={mvpState} automationCount={automationRows.length} waitingApprovals={waitingApprovals} blockedRuns={blockedRuns} waitingApprovalCount={waitingApprovalCount} blockedRunCount={blockedRunCount} />
      <details className="home-status-details" data-control-id="home.status-legend">
        <summary>状態の見方</summary>
        <div className="status-legend" aria-label="AOSの状態表示の見方">
          <strong>状態の見方</strong>
          <span><i className="status-legend-dot success" />正常</span>
          <span><i className="status-legend-dot info" />ユーザー操作待ち</span>
          <span><i className="status-legend-dot attention" />復旧・確認待ち</span>
          <small>外部操作の完了は、承認だけでなく同一Runのreceiptとsource syncまで確認します。</small>
        </div>
      </details>
      <div className="section-grid">
        <Panel title="最近の結果" controlId="home.latest-run.panel">
          {latestRun ? <>
            <div className="latest-run-meta"><strong>{latestRun.automation_name ?? latestRun.automation_id ?? "最新の自動化"}</strong><span>{publicRunStatusForRun(latestRun, mvpState)}</span></div>
            <details className="home-inline-details"><summary>実行の識別情報</summary><p className="muted">Run ID: {latestRun.id}</p></details>
            <RunTimeline run={latestRun} proofCount={proofCountForRun(latestRun, mvpState.proofs ?? [])} />
          </> : <div className="empty-state"><strong>まだ結果はありません</strong><span>自動化を作ると、Queue・Worker・Proofの進行をここで確認できます。</span></div>}
        </Panel>
          <Panel title="承認待ち" controlId="home.pending-approvals.panel">
          <div className="approval-widget">
            <strong>承認待ち {waitingApprovalCount}件</strong>
            <span>{expiredApprovalCount ? `期限切れ ${expiredApprovalCount}件 / ` : ""}承認されるまで外部操作は安全に停止</span>
            <span>記録上未完 Run {queuedRunCount}件 / fresh queue {homeQueueCurrentCount}件 / historical {homeQueueHistoricalCount}件</span>
            <Button controlId="home.approvals.open" variant="primary" onClick={() => go("#/approvals")}>承認キューを開く</Button>
          </div>
          </Panel>
      </div>
      <HomeCompanyBrief companies={companyOptions.filter((company) => company.id === "company_2560580981cedfd106b66245")} />
      <details className="home-secondary-details" data-control-id="home.secondary-details">
        <summary>詳細・履歴・管理操作を開く</summary>
        <div className="home-secondary-details-body">
          <HomeSchedulerControl companyId="company_2560580981cedfd106b66245" />
          <HomeObsidianBusinessControl companyId="company_2560580981cedfd106b66245" />
          <SetupProgress companyCount={companyOptions.length} automationCount={automationRows.length} workerReady={workerReady} proofReady={proofReady} />
          <ControlPlaneRolesPanel collapsed />
          <div className="cards four">
            {projectCards.map((card) => <MetricCard controlId={`home.metric.${card.title === "会社" ? "company" : card.title === "承認" ? "approvals" : card.title === "実行履歴" ? "runs" : "jobs"}`} key={card.title} title={card.title} value={card.value} sub={card.sub} status={card.status as Status} />)}
          </div>
          <div className="section-grid">
            <Panel title="ライブ実行" className="span-2" controlId="home.live-execution.panel">
              <DataTable controlId="home.live-execution.table" headers={["Lane", "プロジェクト", "タスク", "状態", "操作"]} rows={liveRows} />
            </Panel>
          </div>
          <Panel title="進捗一覧" controlId="home.progress.panel">
            <DataTable controlId="home.progress.table" headers={["対象", "状態", "Schedule", "Lane", "停止条件", "証跡"]} rows={automationRows.map((item) => [
              item.name,
              <StatusBadge status={item.status} />,
              item.schedule,
              displayedAutomationLane(item.lane, mvpState.web_operation_backend?.backend),
              item.status === "enabled" ? "外部操作前に承認停止" : item.last,
              "API / artifact readback"
            ])} />
          </Panel>
          <BlockerTriage runs={blockedRuns} totalCount={blockedRunCount} />
          <HomeBrowserDetails model={model} />
          <Panel title="Feedbackサマリ" controlId="home.feedback-summary.panel">
            <div className="feedback-summary compact">
              <strong>open {openFeedbackCount}件</strong>
              <span>triaged {triagedFeedbackCount}件</span>
              <span>triageはOwner専用Adminで行います</span>
            </div>
          </Panel>
        </div>
      </details>
    </section>
  );
}

function ChatPage({ model }: { model: AppModel }) {
  const { setReceipt, setAutomationRows, mvpState, setMvpState } = model;
  const route = useRoute();
  const requestedChatContext = useMemo(() => chatRouteContext(route), [route]);
  const requestedProjectId = requestedChatContext.companyId || requestedChatContext.projectId;
  const selectedBackend = mvpState.web_operation_backend?.backend ?? mvpState.browser_use_runtime?.backend;
  const selectedRuntimeSurfaceLabel = publicWebOperationBackendLabel(selectedBackend);
  const [created, setCreated] = useState(false);
  const [appServerProbeLoading, setAppServerProbeLoading] = useState(false);
  const [appServerProbeReadback, setAppServerProbeReadback] = useState<{ status: string; exactBlocker: string | null; externalActionExecuted: boolean } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [requestText, setRequestText] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [planVisible, setPlanVisible] = useState(false);
  const [plannerReadback, setPlannerReadback] = useState<PlannerReadback | null>(null);
  const [workflowReadback, setWorkflowReadback] = useState<ChatWorkflowReadback | null>(null);
  const [plannerProgress, setPlannerProgress] = useState<PlannerProgress | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(requestedProjectId || rememberedProject());
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
  const [scheduleReadbackRequired, setScheduleReadbackRequired] = useState(false);
  const [chatThreadId, setChatThreadId] = useState(() => rememberedChatThread(requestedProjectId || rememberedProject()));
  const [chatSessionId, setChatSessionId] = useState("");
  const [chatSessions, setChatSessions] = useState<ChatSessionReadback[]>([]);
  const [chatSessionsLoading, setChatSessionsLoading] = useState(false);
  const [newChatSessionName, setNewChatSessionName] = useState("");
  const [chatThreads, setChatThreads] = useState<ChatThreadReadback[]>([]);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [chatNote, setChatNote] = useState("新しい自動化リクエストを入力できます。");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", text: "どんな自動化を作りたいですか？目的、対象サービス、止めてほしい条件を書いてください。曖昧なところは質問しながら仕様にします。" }
  ]);
  const [companyConsultation, setCompanyConsultation] = useState<{ status: "loading" | "ready" | "error"; readback?: CanonicalCompanyConsultationReadback; exactBlocker?: string }>({ status: "loading" });
  const [companyConsultationRefreshing, setCompanyConsultationRefreshing] = useState(false);
  const companyConsultationRequestInFlightRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const newChatSessionNameRef = useRef<HTMLInputElement>(null);
  const submittedPromptRef = useRef("");
  const plannerRequestGeneration = useRef(0);
  const plannerAbortRef = useRef<AbortController | null>(null);
  const activePlannerJobRef = useRef("");
  const createIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const scheduleAdjustmentInFlight = useRef(false);
  const pendingScheduleAdjustment = useRef<ChatScheduleAdjustment | null>(null);
  const webOperationTemplateAppliedRef = useRef(false);
  const canonicalProjects = projectOptionsFromState(mvpState);
  React.useEffect(() => {
    if (model.mvpLoadStatus !== "ready") return;
    setSelectedProjectId((current) => {
      const requested = requestedProjectId && canonicalProjects.some((project) => project.id === requestedProjectId)
        ? requestedProjectId
        : "";
      const next = resolveProjectSelection(mvpState, requested || current);
      if (next) rememberProject(next);
      return next;
    });
  }, [model.mvpLoadStatus, mvpState, requestedProjectId]);
  const loadCompanyConsultation = async () => {
    if (!selectedProjectId || model.mvpLoadStatus !== "ready" || companyConsultationRequestInFlightRef.current) return;
    companyConsultationRequestInFlightRef.current = true;
    setCompanyConsultationRefreshing(true);
    setCompanyConsultation({ status: "loading" });
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedProjectId)}/control-plane/consultation`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as CanonicalCompanyConsultationReadback & { error?: string; exactBlocker?: string };
      if (!response.ok || body.schema !== "canonical_company_consultation.v1") {
        throw new Error(body.exact_blocker ?? body.exactBlocker ?? body.error ?? `company_consultation_http_${response.status}`);
      }
      setCompanyConsultation({ status: "ready", readback: body });
    } catch (error) {
      setCompanyConsultation({ status: "error", exactBlocker: error instanceof Error ? error.message : "canonical_company_consultation_readback_failed" });
    } finally {
      setCompanyConsultationRefreshing(false);
      companyConsultationRequestInFlightRef.current = false;
    }
  };
  React.useEffect(() => {
    if (!selectedProjectId) {
      setCompanyConsultation({ status: "loading" });
      return;
    }
    if (model.mvpLoadStatus !== "ready") {
      setCompanyConsultation({ status: "error", exactBlocker: model.mvpLoadBlocker ?? "mvp_state_detail_readback_pending" });
      return;
    }
    void loadCompanyConsultation();
  }, [selectedProjectId, model.mvpLoadStatus, model.mvpLoadBlocker]);
  React.useEffect(() => {
    if (requestedChatContext.context !== "web-operation-admission" || webOperationTemplateAppliedRef.current) return;
    if (prompt.trim() || requestText.trim()) return;
    webOperationTemplateAppliedRef.current = true;
    setPrompt(COMMON_WEB_OPERATION_PROMPT_TEMPLATE);
    setChatNote("初見Web操作の入力テンプレートを用意しました。内容を埋めてから送信してください。まだ外部操作は実行していません。");
  }, [prompt, requestText, requestedChatContext.context]);
  const platformOptions = ["Instagram", "TikTok", "Facebook"];
  const allPlatformsSelected = selectedPlatforms.length === platformOptions.length;
  const draftPrompt = prompt.trim();
  const safePrompt = requestText.trim();
  const activePrompt = draftPrompt || safePrompt;
  const redactedActivePrompt = redactSensitiveText(activePrompt);
  const fallbackPlan = buildAutomationPlan(redactedActivePrompt, selectedPlatforms);
  const plan = plannerReadback?.plan ?? fallbackPlan;
  const targetProject = selectedProjectId;
  const fixedWorkflowConfirmed = fixedChatWorkflowConfirmed(workflowReadback, targetProject, plannerReadback?.chat_job_id);
  const visiblePlanQuestions = plan.questions.filter((question) => !fixedWorkflowConfirmed
    || !plannerReadback?.web_operation_intake?.questions.includes(question));
  const selectedChatSession = chatSessions.find((session) => session.id === chatSessionId);
  const requestThreadId = selectedChatSession ? (selectedChatSession.codex_thread_id ?? "") : chatThreadId;
  const presentationProfile = mvpState.presentation_profiles?.find((profile) => profile.id === targetProject);
  const targetAutomations = (mvpState.automations ?? []).filter((automation) => String(automation.company_id ?? automation.project_id ?? "") === targetProject
    && automation.status !== "archived" && !automation.archived_at);
  const selectedAutomation = targetAutomations.find((automation) => automation.id === selectedAutomationId);
  const plannerAdapter = plannerReadback?.planner_adapter ?? "client_deterministic_preview";
  const plannerMode = plannerReadback?.planner_mode ?? "not_requested";
  const plannerModeLabel = plannerReadback?.planner_operation === "answer_question" && !plan.questions.length
    ? "回答" : plannerMode;
  const plannerPublicBlocker = plannerReadback?.exact_blocker ? publicBlockerSummary(plannerReadback.exact_blocker) : null;
  const chatScopeLabel = targetProject ? projectLabelFromState(mvpState, targetProject) : "未選択";
  const companyChatCapabilities = companyConsultation.readback?.chat;
  const canonicalCompanyId = companyConsultation.readback?.canonical_company_id;
  const canonicalCompanyLabel = canonicalCompanyId
    ? projectLabelFromState(mvpState, canonicalCompanyId) || canonicalCompanyId
    : "未確定";
  const appServerSurface = mvpState.codexCapabilities?.appServer;
  const appServerSurfaceState = getCapabilitySurfaceState(appServerSurface);
  const appServerProbeStatus = String(appServerProbeReadback?.status ?? "").toLowerCase();
  const appServerStatusLabel = appServerProbeReadback
    ? appServerProbeStatus === "ok" && appServerProbeReadback.externalActionExecuted !== true
      ? "確認済み"
      : "要確認"
    : appServerSurfaceState.connected
      ? "接続済み"
      : appServerSurfaceState.verified
        ? "確認済み（接続待ち）"
        : plannerReadback?.chat_turn_id && plannerReadback.server_reply && !plannerReadback.exact_blocker
          ? "直近の会話で応答確認"
        : appServerSurface
          ? "要確認"
          : "未確認";
  const probeCodexAppServer = async () => {
    if (appServerProbeLoading) return;
    setAppServerProbeLoading(true);
    try {
      const response = await mvpFetch("/api/codex/app-server/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        probe?: { status?: string; exactBlocker?: string | null; externalActionExecuted?: boolean };
        exactBlocker?: string;
      };
      if (!response.ok) {
        throw new Error(body.probe?.exactBlocker || body.exactBlocker || `codex_app_server_probe_http_${response.status}`);
      }
      const status = body.probe?.status || (body.ok ? "ok" : "blocked");
      const blocker = body.probe?.exactBlocker || (body.ok ? "none" : "codex_app_server_probe_unconfirmed");
      const externalAction = body.probe?.externalActionExecuted === true;
      setAppServerProbeReadback({ status, exactBlocker: blocker === "none" ? null : blocker, externalActionExecuted: externalAction });
      setReceipt(`Codex App Serverのread-only probeを実行しました。status=${status} / blocker=${blocker} / external_action=${externalAction}`);
      setChatNote(`Codex App Server readback: status=${status} / ${publicBlockerSummary(blocker)} / external_action=${externalAction} / ${actionStamp()}`);
      // The probe response is the fresh authority for this control.  A cold or
      // degraded MVP snapshot must not hide a successful bounded probe behind
      // the 30-second state-readback timeout.  Refresh the broader snapshot in
      // the background and keep the probe result visible immediately.
        void readMvpStateWithRetry("ui", { origin: "codex_probe_refresh" })
        .then((freshState) => {
          setMvpState(freshState);
          setChatNote((current) => `${current} / state readback=ok`);
        })
        .catch((stateError) => {
          const exact = stateError instanceof Error ? stateError.message : "mvp_state_readback_unavailable";
          setChatNote((current) => `${current} / state readback未確認=${publicBlockerSummary(exact)}`);
        });
    } catch (error) {
      const exact = error instanceof Error ? error.message : "codex_app_server_probe_failed";
      setAppServerProbeReadback({ status: "blocked", exactBlocker: exact, externalActionExecuted: false });
      setReceipt(`Codex App Serverのread-only probeを確認できませんでした: ${publicBlockerSummary(exact)} / external_action=false`);
      setChatNote(`Codex App Server readback未確認: ${publicBlockerSummary(exact)} / external_action=false / ${actionStamp()}`);
    } finally {
      setAppServerProbeLoading(false);
    }
  };
  const chatStatus = plannerProgress?.status ?? plannerReadback?.chat_status ?? (plannerReadback ? "completed" : "idle");
  const targetProjectIsVerified = model.mvpLoadStatus === "ready" && Boolean(targetProject) && canonicalProjects.some((project) => project.id === targetProject);
  // This saves an inert draft into an API-confirmed AOS company. The separate
  // external trigger/company mapping is diagnostic, not authority for a local
  // draft. Provider execution and schedule activation retain their own checks.
  const canCreatePlan = plannerReadback?.can_create === true && targetProjectIsVerified;
  const isCreateAutomationPlan = plannerReadback?.planner_operation === "create_automation";
  const isManageWorkflowPlan = plannerReadback?.planner_operation === "manage_workflow";
  const selectedSchedule = (mvpState.schedules ?? []).find((schedule) => (schedule.company_id ?? schedule.companyId) === targetProject
    && (schedule.automation_id ?? schedule.automationId) === selectedAutomation?.id);
  const scheduleAdjustmentPreview = plannedChatScheduleValues(plan, selectedSchedule);
  const canAdjustSchedule = isManageWorkflowPlan
    && plannerReadback?.planner_mode === "ready_to_schedule"
    && targetProjectIsVerified
    && !scheduleReadbackRequired
    && Boolean(selectedAutomation?.id);
  const cancelPlanning = async () => {
    if (!planning) return;
    plannerRequestGeneration.current += 1;
    plannerAbortRef.current?.abort();
    plannerAbortRef.current = null;
    const jobId = activePlannerJobRef.current;
    activePlannerJobRef.current = "";
    setPlanning(false);
    setPlannerReadback(null);
    setPlanVisible(false);
    setCreated(false);
    setPlannerError(null);
    if (jobId) {
      try {
        const cancelled = await cancelChatPlannerJob(jobId);
        setPlannerProgress((current) => ({
          ...(current ?? { jobId, status: "blocked", streamTextLength: 0, events: [] }),
          status: cancelled.status ?? "blocked"
        }));
        setReceipt(`Chatのplanner処理を停止しました。job=${jobId} / external_action=false`);
        setChatNote(`planner停止済み: job=${jobId} / ${actionStamp()}`);
      } catch (error) {
        const exact = error instanceof Error ? error.message : "chat_job_cancel_failed";
        setPlannerProgress((current) => current ? { ...current, status: "blocked" } : null);
        setReceipt(`Chatの停止結果を確認できませんでした: ${publicBlockerSummary(exact)}`);
        setChatNote(`planner停止のreadback未確認: ${publicBlockerSummary(exact)} / ${actionStamp()}`);
      }
    } else {
      setPlannerProgress(null);
      setReceipt("Chatのplanner処理を停止しました。jobはまだ発行されていません。");
      setChatNote(`planner停止: job発行前 / ${actionStamp()}`);
    }
  };
  const resetChat = () => {
    if (planning || creating) return;
    plannerAbortRef.current?.abort();
    plannerAbortRef.current = null;
    activePlannerJobRef.current = "";
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
    setReceipt("入力と未保存の計画表示を消去しました。選択中の会話と保存済み履歴は保持しています。");
    setChatNote(`入力消去完了。別の話題は「新しい会話名」から会話を作成してください。 / ${actionStamp()}`);
    promptRef.current?.focus();
  };
  const beginSeparateConversation = () => {
    if (planning || creating || !targetProjectIsVerified) return;
    newChatSessionNameRef.current?.focus();
    setChatNote("新しい会話名を入力し「新しい会話を作成」を押してください。作成が確認できるまで現在の会話を保持します。");
  };
  React.useEffect(() => {
    setChatThreadId(rememberedChatThread(selectedProjectId));
    setChatSessionId("");
    setSelectedAutomationId("");
    let stale = false;
    if (!selectedProjectId || model.mvpLoadStatus !== "ready") {
      setChatSessions([]);
      setChatSessionsLoading(false);
      setChatThreads([]);
      setChatHistoryLoading(false);
      return () => { stale = true; };
    }
    setChatSessionsLoading(true);
    requestChatSessions(selectedProjectId)
      .then((sessions) => {
        if (stale) return;
        setChatSessions(sessions);
        const active = sessions.find((session) => session.active) ?? sessions[0];
        if (active) {
          setChatSessionId(active.id);
          setChatThreadId(active.codex_thread_id ?? "");
        }
      })
      .catch((error) => {
        if (!stale) {
          setChatSessions([]);
          setChatNote(`名前付きチャットを確認できませんでした: ${publicBlockerSummary(error instanceof Error ? error.message : "chat_sessions_unavailable")} / ${actionStamp()}`);
        }
      })
      .finally(() => {
        if (!stale) setChatSessionsLoading(false);
      });
    setChatHistoryLoading(true);
    requestChatThreads(selectedProjectId)
      .then((threads) => {
        if (!stale) setChatThreads(threads);
      })
      .catch((error) => {
        if (!stale) {
          setChatThreads([]);
          const exact = error instanceof Error ? error.message : "chat_history_unavailable";
          setChatNote(`チャット履歴を確認できませんでした: ${publicBlockerSummary(exact)} / ${actionStamp()}`);
        }
      })
      .finally(() => {
        if (!stale) setChatHistoryLoading(false);
      });
    return () => { stale = true; };
  }, [selectedProjectId, model.mvpLoadStatus]);
  React.useEffect(() => {
    if (selectedAutomationId && !targetAutomations.some((automation) => automation.id === selectedAutomationId)) {
      setSelectedAutomationId("");
    }
  }, [selectedAutomationId, targetAutomations.map((automation) => automation.id).join("|")]);
  React.useEffect(() => { setSelectedAutomationId(""); }, [targetProject, plannerReadback?.chat_job_id]);
  const clearVisibleConversation = (session?: ChatSessionReadback) => {
    setPrompt("");
    setRequestText("");
    submittedPromptRef.current = "";
    setSelectedPlatforms([]);
    setSelectedAutomationId("");
    setPlanVisible(false);
    setPlannerReadback(null);
    setPlannerProgress(null);
    setPlannerError(null);
    setCreated(false);
    createIdempotencyRef.current = null;
    setChatThreadId(session?.codex_thread_id ?? "");
    setMessages([{ id: "welcome", role: "assistant", text: session ? `${session.name}を開きました。目的や調整内容を入力してください。` : "新しい会話を開始できます。" }]);
  };
  const switchChatSession = async (sessionId: string) => {
    if (!selectedProjectId || planning || creating || !sessionId || sessionId === chatSessionId) return;
    const target = chatSessions.find((session) => session.id === sessionId);
    if (!target) return;
    try {
      const activated = await activateChatSession(selectedProjectId, sessionId);
      setChatSessionId(activated.id);
      setChatSessions((items) => items.map((session) => ({ ...session, active: session.id === activated.id, ...(session.id === activated.id ? activated : {}) })));
      setChatThreadId(activated.codex_thread_id ?? "");
      const thread = activated.codex_thread_id ? chatThreads.find((item) => item.threadId === activated.codex_thread_id) : undefined;
      if (thread) resumeChat(thread);
      else clearVisibleConversation(activated);
      setChatNote(`チャットセッションを切り替えました: ${activated.name} / ${actionStamp()}`);
      setReceipt(`プロジェクト別チャットを切り替えました。session=${activated.name} / external_action=false`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "chat_session_activate_failed";
      setChatNote(`チャットセッションの切替を確認できませんでした: ${publicBlockerSummary(exact)} / ${actionStamp()}`);
    }
  };
  const createNamedChatSession = async () => {
    const name = newChatSessionName.trim();
    if (!selectedProjectId || !name || planning || creating) {
      setChatNote("新しいチャット名と保存先の会社を指定してください。");
      return;
    }
    try {
      const createdSession = await createChatSession(selectedProjectId, name);
      const activated = await activateChatSession(selectedProjectId, createdSession.id);
      setChatSessions((items) => [...items.map((session) => ({ ...session, active: false })), { ...activated, active: true }]);
      setChatSessionId(activated.id);
      setNewChatSessionName("");
      clearVisibleConversation(activated);
      setChatNote(`新しいチャットセッションを作成しました: ${activated.name} / ${actionStamp()}`);
      setReceipt(`プロジェクト別チャットを作成しました。session=${activated.name} / external_action=false`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "chat_session_create_failed";
      setChatNote(`チャットセッションの作成を確認できませんでした: ${publicBlockerSummary(exact)} / ${actionStamp()}`);
    }
  };
  const togglePlatform = (platform: string) => {
    if (!targetProjectIsVerified || planning || creating) return;
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
  const resumeChat = async (thread: ChatThreadReadback) => {
    if (planning || creating) return;
    const restoredMessages = thread.messages
      .filter((message) => message.text.trim())
      .map((message, index) => ({ id: `restored-${thread.threadId}-${index}`, role: message.role, text: message.text }));
    const lastUserMessage = [...thread.messages].reverse().find((message) => message.role === "user");
    setChatThreadId(thread.threadId);
    rememberChatThread(selectedProjectId, thread.threadId);
    setMessages(restoredMessages.length ? restoredMessages : [{ id: "welcome", role: "assistant", text: "この会話には表示できるメッセージがありません。" }]);
    setRequestText(lastUserMessage?.text ?? "");
    setPrompt("");
    setPlanVisible(false);
    setPlannerReadback(null);
    setPlannerProgress(null);
    setPlannerError(null);
    setCreated(false);
    createIdempotencyRef.current = null;
    setReceipt(`Codex App Serverの会話を再開しました。thread=${thread.threadId.slice(0, 12)}… / 最新job=${thread.latestJobId}`);
    setChatNote(`履歴から再開: ${thread.resultTitle ?? "会話"} / ${actionStamp()}`);
    if (thread.latestStatus !== "completed") return;
    const requestGeneration = ++plannerRequestGeneration.current;
    const controller = new AbortController();
    plannerAbortRef.current = controller;
    activePlannerJobRef.current = "";
    setPlanning(true);
    try {
      const readback = await requestSavedChatPlan(thread, selectedProjectId, controller.signal);
      if (plannerRequestGeneration.current !== requestGeneration) return;
      setPlannerReadback(readback);
      setPlanVisible(true);
      submittedPromptRef.current = lastUserMessage?.text ?? "";
      setReceipt(`保存済みの会話とプランを復元しました。job=${thread.latestJobId} / 再送・実行なし`);
    } catch (error) {
      if (plannerRequestGeneration.current !== requestGeneration) return;
      setPlannerError(`会話本文は復元しましたが、保存済みプランは確認できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "chat_history_plan_unavailable")}）。再送・実行はしていません。`);
    } finally {
      if (plannerRequestGeneration.current === requestGeneration) {
        setPlanning(false);
        if (plannerAbortRef.current === controller) plannerAbortRef.current = null;
      }
    }
  };
  const selectAllPlatforms = () => {
    if (!targetProjectIsVerified || planning || creating) return;
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
  const prepareCompanyChatStage = (stage: "consultation" | "demo" | "approval") => {
    if (!targetProjectIsVerified || planning || creating || !companyChatCapabilities) return;
    const stagePrompt = stage === "consultation"
      ? `この会社scope（${chatScopeLabel}）の登録済み自動化タスクについて、目的・頻度・成功条件・停止条件を相談したい。外部操作はしないで。`
      : stage === "demo"
        ? `この会社scope（${chatScopeLabel}）の登録済み自動化タスクをread-onlyで実演previewして。provider呼出し、保存、送信、公開はしないで。`
        : `この会社scope（${chatScopeLabel}）の自動化案について、外部効果なしの承認previewを作って。対象、payload、承認条件、同一Runのreadback条件を示し、実行はしないで。`;
    setPrompt(stagePrompt);
    setRequestText("");
    setPlanVisible(false);
    setPlannerReadback(null);
    setPlannerProgress(null);
    setPlannerError(null);
    setCreated(false);
    createIdempotencyRef.current = null;
    setChatNote(`${stage === "consultation" ? "相談" : stage === "demo" ? "read-only実演preview" : "承認preview"}の入力を用意しました。送信するまで外部操作はありません / ${actionStamp()}`);
    promptRef.current?.focus();
  };
  const startPlan = async () => {
    if (!targetProjectIsVerified) {
      setReceipt("先に、保存先の会社を選択してからプランを作成してください。");
      setChatNote(`プラン作成待ち: 会社scope未選択 / ${actionStamp()}`);
      return;
    }
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
    const plannerController = new AbortController();
    plannerAbortRef.current = plannerController;
    activePlannerJobRef.current = "";
    try {
      const secretReadback = await storeChatSecrets(activePrompt, selectedProjectId);
      const safePrompt = secretReadback.sanitizedText.trim();
      if (!safePrompt) throw new Error("chat_prompt_empty_after_secret_redaction");
      setPrompt(safePrompt);
      const readback = await requestChatPlan(safePrompt, selectedPlatforms, {
        projectId: selectedProjectId,
        sessionId: chatSessionId || undefined,
        threadId: requestThreadId || undefined,
        signal: plannerController.signal,
        onJobId: (jobId) => { activePlannerJobRef.current = jobId; },
        messages: [...messages, { id: "current", role: "user", text: safePrompt }],
        onProgress: (progress) => {
          if (plannerRequestGeneration.current === requestGeneration) setPlannerProgress(progress);
        }
      });
      if (plannerRequestGeneration.current !== requestGeneration) return;
      setPlannerReadback(readback);
      if (readback.chat_thread_id) {
        setChatThreadId(readback.chat_thread_id);
        rememberChatThread(selectedProjectId, readback.chat_thread_id);
        if (chatSessionId) {
          requestChatSessions(selectedProjectId).then(setChatSessions).catch(() => undefined);
        }
      }
      setPlannerError(null);
      setRequestText(safePrompt);
      submittedPromptRef.current = safePrompt;
      setPlanVisible(true);
      setCreated(false);
      setMessages((items) => [
        ...items,
        { id: nextChatId("assistant-plan"), role: "assistant", text: readback.server_reply }
      ]);
      const secretNote = secretRunnerNote(secretReadback);
      setReceipt(`plannerの回答を確認しました。planner=${readback.planner_adapter} / secret=${secretReadback.storedCount}件を非表示保存${secretNote} / external_action=false`);
      setChatNote(`planner回答完了: ${readback.plan.title} / secret=${secretReadback.storedCount}件を安全保存${secretNote} / ${actionStamp()}`);
    } catch (error) {
      if (plannerRequestGeneration.current !== requestGeneration) return;
      const exact = error instanceof Error ? error.message : "planner_readback_unavailable";
      const blocker = publicBlockerSummary(exact);
      setPlannerReadback(null);
      setPlanVisible(false);
      setCreated(false);
      setPlannerError(`プランAPIの結果を確認できませんでした（${blocker}）。自動化の作成は確認されておらず、プラン送信の到達状態は不明です。`);
      setReceipt(`プラン作成結果を確認できませんでした（${blocker}）。自動化の作成は確認されていません。`);
      setChatNote(`プラン作成停止: ${blocker} / ${actionStamp()}`);
    } finally {
      if (plannerRequestGeneration.current === requestGeneration) {
        setPlanning(false);
        if (plannerAbortRef.current === plannerController) plannerAbortRef.current = null;
        activePlannerJobRef.current = "";
      }
    }
  };
  const sendMessage = async () => {
    if (!targetProjectIsVerified) {
      setReceipt("先に、保存先の会社を選択してから送信してください。");
      setChatNote(`送信待ち: 会社scope未選択 / ${actionStamp()}`);
      return;
    }
    if (!draftPrompt) {
      promptRef.current?.focus();
      setReceipt("まず作りたい自動化を入力してください。");
      setChatNote(`送信待ち: 入力が必要です / ${actionStamp()}`);
      return;
    }
    const requestGeneration = plannerRequestGeneration.current + 1;
    plannerRequestGeneration.current = requestGeneration;
    createIdempotencyRef.current = null;
    setPlanning(true);
    const plannerController = new AbortController();
    plannerAbortRef.current = plannerController;
    activePlannerJobRef.current = "";
    try {
      const secretReadback = await storeChatSecrets(draftPrompt, selectedProjectId);
      const safePrompt = secretReadback.sanitizedText.trim();
      if (!safePrompt) throw new Error("chat_prompt_empty_after_secret_redaction");
      const readback = await requestChatPlan(safePrompt, selectedPlatforms, {
        projectId: selectedProjectId,
        sessionId: chatSessionId || undefined,
        threadId: requestThreadId || undefined,
        signal: plannerController.signal,
        onJobId: (jobId) => { activePlannerJobRef.current = jobId; },
        messages: [...messages, { id: "current", role: "user", text: safePrompt }],
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
        if (chatSessionId) {
          requestChatSessions(selectedProjectId).then(setChatSessions).catch(() => undefined);
        }
      }
      setPlannerError(null);
      setRequestText(safePrompt);
      submittedPromptRef.current = safePrompt;
      setPrompt("");
      setMessages((items) => [
        ...items,
        { id: nextChatId("user"), role: "user", text: safePrompt },
        { id: nextChatId("assistant"), role: "assistant", text: readback.server_reply }
      ]);
      setPlanVisible(true);
      setCreated(false);
      const secretNote = secretRunnerNote(secretReadback);
      setReceipt(`plannerの会話結果を更新しました。planner=${readback.planner_adapter} / secret=${secretReadback.storedCount}件を非表示保存${secretNote} / mode=${readback.planner_mode}`);
      setChatNote(`送信完了: ${currentPlan.title} / secret=${secretReadback.storedCount}件を安全保存${secretNote} / ${actionStamp()}`);
    } catch (error) {
      if (plannerRequestGeneration.current !== requestGeneration) return;
      const exact = error instanceof Error ? error.message : "planner_readback_unavailable";
      const blocker = publicBlockerSummary(exact);
      setPlannerReadback(null);
      setPlanVisible(false);
      setCreated(false);
      setPlannerError(`プランAPIの結果を確認できませんでした（${blocker}）。自動化の作成は確認されておらず、送信の到達状態は不明です。`);
      setReceipt(`送信結果を確認できませんでした（${blocker}）。自動化の作成は確認されていません。`);
      setChatNote(`送信停止: ${blocker} / ${actionStamp()}`);
    } finally {
      if (plannerRequestGeneration.current === requestGeneration) {
        setPlanning(false);
        if (plannerAbortRef.current === plannerController) plannerAbortRef.current = null;
        activePlannerJobRef.current = "";
      }
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
    const builderSlug = automationSlugForKind(plan.kind);
    if (!builderSlug || !isSupportedAutomationType(builderSlug)) {
      setReceipt(`plannerが返した自動化タイプ（${plan.kind}）をBuilderで確認できません。SNSとして置き換えず、詳細設定は開きません。`);
      setChatNote(`詳細設定停止: 未認識のautomation_type=${plan.kind} / ${actionStamp()}`);
      return;
    }
    setReceipt("詳細設定を開きました。Lane・承認・リトライ条件を確認できます。");
    setChatNote(`詳細設定へ移動: project=${targetProject} / kind=${plan.kind} / ${actionStamp()}`);
    rememberProject(targetProject);
    go(`#/projects/${targetProject}/automations/${builderSlug}/edit`);
  };
  const saveAdjustedSchedule = async () => {
    if (scheduleAdjustmentInFlight.current || scheduleReadbackRequired) return;
    if (!canAdjustSchedule || !selectedAutomation?.id || selectedAutomation.id !== selectedAutomationId) {
      setReceipt("対象自動化と、保存可能な定期実行案を確認してください。外部操作は実行していません。");
      return;
    }
    const currentSchedule = (mvpState.schedules ?? []).find((schedule) => (schedule.company_id ?? schedule.companyId) === targetProject
      && (schedule.automation_id ?? schedule.automationId) === selectedAutomation.id);
    const { kind, expression, timezone, enabled } = plannedChatScheduleValues(plan, currentSchedule);
    if (kind !== "manual" && !expression) {
      setReceipt("定期実行の式が未確定です。チャットで時刻・曜日を指定してください。");
      return;
    }
    const adjustment: ChatScheduleAdjustment = { companyId: targetProject, automationId: selectedAutomation.id,
      kind, expression, timezone, enabled, previousRevision: Number(currentSchedule?.revision ?? 0) };
    scheduleAdjustmentInFlight.current = true;
    pendingScheduleAdjustment.current = adjustment;
    setCreating(true);
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(adjustment.companyId)}/automations/${encodeURIComponent(adjustment.automationId)}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: adjustment.kind,
          expression: adjustment.expression,
          timezone: adjustment.timezone,
          // Preserve the stored state unless the latest request explicitly
          // pauses/resumes it. A new schedule stays paused by default.
          enabled: adjustment.enabled,
          expected_revision: adjustment.previousRevision || 1
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if ([400, 403, 404, 409].includes(response.status)) pendingScheduleAdjustment.current = null;
        throw new Error(body.exactBlocker || body.exact_blocker || body.error || `schedule_adjust_http_${response.status}`);
      }
      const freshState = await readMvpState("ui", { fresh: true });
      setMvpState(freshState);
      setAutomationRows(toAutomationRows(freshState.automations ?? []));
      const saved = (freshState.schedules ?? []).find((schedule: any) => matchesChatScheduleAdjustment(schedule, adjustment));
      if (!saved) throw new Error("chat_schedule_readback_mismatch");
      pendingScheduleAdjustment.current = null;
      setScheduleReadbackRequired(false);
      setReceipt(`選択した自動化の定期実行を保存・再取得しました。automation=${adjustment.automationId} / kind=${saved.kind} / revision=${saved.revision} / next=${!adjustment.enabled || kind === "manual" ? "次回なし" : saved.next_run_at ?? saved.nextRunAt} / 外部処理は起動していません。`);
      setChatNote(`定期実行の調整を保存しました: ${selectedAutomation.name ?? selectedAutomation.id} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "schedule_adjust_failed";
      setScheduleReadbackRequired(true);
      setReceipt(`定期実行の調整は未確認です: ${publicBlockerSummary(exact)}。同じ保存を繰り返さず、対象の設定を再取得してください。`);
      setChatNote(`定期実行の調整停止: ${publicBlockerSummary(exact)} / ${actionStamp()}`);
    } finally {
      scheduleAdjustmentInFlight.current = false;
      setCreating(false);
    }
  };
  const readAdjustedSchedule = async () => {
    if (scheduleAdjustmentInFlight.current) return;
    const pending = pendingScheduleAdjustment.current;
    const companyId = pending?.companyId ?? targetProject;
    const automationId = pending?.automationId ?? selectedAutomation?.id;
    if (!companyId || !automationId) return;
    scheduleAdjustmentInFlight.current = true;
    setCreating(true);
    try {
      const state = await readMvpState("ui", { fresh: true });
      if (!state.automations?.some((item: any) => item.id === automationId && (item.company_id ?? item.project_id) === companyId)) throw new Error("chat_schedule_company_scope_mismatch");
      setMvpState(state);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      const schedule = state.schedules?.find((item: any) => (item.company_id ?? item.companyId) === companyId && (item.automation_id ?? item.automationId) === automationId);
      if (pending && !matchesChatScheduleAdjustment(schedule, pending)) throw new Error("chat_schedule_result_still_unconfirmed");
      pendingScheduleAdjustment.current = null;
      setScheduleReadbackRequired(false);
      setReceipt(`同じ対象の予定を再取得しました。automation=${automationId} / revision=${schedule?.revision ?? "予定なし"} / 保存の再送・実行なし。`);
      setChatNote(`予定の読取照合が完了しました / ${actionStamp()}`);
    } catch (error) {
      setReceipt(`予定の確認は未完了です: ${publicBlockerSummary(error instanceof Error ? error.message : "chat_schedule_readback_failed")}。保存は再送していません。`);
    } finally { scheduleAdjustmentInFlight.current = false; setCreating(false); }
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
    if (!targetProjectIsVerified || !projectOptionsFromState(mvpState).some((project) => project.id === targetProject)) {
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
    const createKey = plannerReadback.chat_job_id
      ? `chat-automation-create-${plannerReadback.chat_job_id}`
      : stableIdempotencyKey(createIdempotencyRef, "chat-automation-create", createFingerprint);
    let createdAutomationId = "";
    setCreating(true);
    try {
      const response = await mvpFetch("/api/mvp/automations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": createKey },
        body: JSON.stringify({
          name: plan.title.slice(0, 80),
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
          create_approval: false,
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
            web_operation_intake: plannerReadback.web_operation_intake ?? null,
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
            // Creating from chat produces a paused draft. Enabling a recurring
            // run is a separate, explicit Builder action.
            body: JSON.stringify({ kind: scheduleKind, expression: plan.schedule, timezone: "Asia/Tokyo", enabled: false, expected_revision: 1 })
          });
          const scheduleResult = await scheduleResponse.json().catch(() => ({}));
          if (!scheduleResponse.ok) throw new Error(scheduleResult.exactBlocker || scheduleResult.exact_blocker || scheduleResult.error || `schedule_save_http_${scheduleResponse.status}`);
          savedSchedule = scheduleResult.schedule;
        }
        freshState = await readMvpState("ui", { fresh: true });
        scheduleNote = `定期実行を停止中の下書きとして保存確認しました。schedule_revision=${savedSchedule?.revision ?? "?"} / next=${savedSchedule?.nextRunAt ?? savedSchedule?.next_run_at ?? "未計算"} / 有効化はBuilderで明示してください`;
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
          const recoveryState = await readMvpState("ui", { fresh: true });
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
        <Button controlId="chat.reset" icon={<Plus size={14} />} onClick={beginSeparateConversation} disabled={planning || creating || !targetProjectIsVerified}>別の会話を始める</Button>
      </PageTitle>
      {model.mvpLoadStatus !== "ready" && canonicalProjects.length > 0 && <div className="action-note warning" role="status">
        直近のsummary readbackを表示しています。会社scopeと確認用ショートカットは使えますが、詳細readbackが完了するまで保存・実行は停止しています。
      </div>}
      <div className="chat-context" role="region" aria-label="Chatの会社scopeと状態">
        <strong>会社: {chatScopeLabel}</strong>
        <span>状態: {plannerProgress ? plannerProgressLabel(chatStatus) : chatStatus === "idle" ? "入力待ち" : chatStatus}</span>
        <details className="chat-context-details">
          <summary>接続・実行の詳細</summary>
          <div className="chat-context-details-body">
            <span data-control-id="chat.app-server.status" aria-label={`Codex App Server接続状態: ${appServerStatusLabel}`}>Codex App Server: {appServerStatusLabel}</span>
            <Button controlId="chat.app-server.probe" variant="secondary" disabled={appServerProbeLoading} onClick={() => { void probeCodexAppServer(); }}>
              {appServerProbeLoading ? "確認中" : "接続状態を確認"}
            </Button>
            {requestedChatContext.context && <span>context: {requestedChatContext.context}</span>}
            {requestedChatContext.runId && <span>run: {requestedChatContext.runId}</span>}
            {requestedChatContext.scheduleId && <span>schedule: {requestedChatContext.scheduleId}</span>}
            {(plannerReadback?.chat_job_id || plannerProgress?.jobId) && <span>job: {plannerReadback?.chat_job_id ?? plannerProgress?.jobId}</span>}
            {(plannerReadback?.chat_thread_id || chatThreadId || plannerProgress?.threadId) && <span>thread: {plannerReadback?.chat_thread_id ?? chatThreadId ?? plannerProgress?.threadId}</span>}
          </div>
        </details>
      </div>
      <label className="chat-input">
        保存先の会社
        <select data-control-id="chat.project-select" aria-label="保存先の会社" value={selectedProjectId} disabled={planning || creating || !canonicalProjects.length} onChange={(event) => {
          const projectId = event.target.value;
          setSelectedProjectId(projectId);
          if (projectId) {
            rememberProject(projectId);
            if (projectId !== requestedProjectId) {
              go(chatHref({
                companyId: projectId,
                context: requestedChatContext.context || "chat",
                runId: requestedChatContext.runId,
                scheduleId: requestedChatContext.scheduleId,
                automationId: requestedChatContext.automationId
              }));
            }
          }
          setCreated(false);
        }}>
          <option value="">会社を選択してください</option>
          {canonicalProjects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select>
      </label>
      <div className="chat-session-controls" role="group" aria-label="プロジェクト別チャットセッション">
        <label className="chat-input">
          会話セッション
          <select data-control-id="chat.session-select" aria-label="会話セッション" value={chatSessionId} disabled={planning || creating || chatSessionsLoading || !chatSessions.length} onChange={(event) => { void switchChatSession(event.target.value); }}>
            {!chatSessions.length && <option value="">{chatSessionsLoading ? "確認中" : "名前付き会話は未作成"}</option>}
            {chatSessions.map((session) => <option key={session.id} value={session.id}>{session.name}{session.active ? "（使用中）" : ""}</option>)}
          </select>
        </label>
        <label className="chat-input chat-session-new-name">
          新しい会話名
          <input ref={newChatSessionNameRef} data-control-id="chat.session-name" aria-label="新しい会話名" value={newChatSessionName} disabled={planning || creating || !targetProjectIsVerified} onChange={(event) => setNewChatSessionName(event.target.value.slice(0, 120))} placeholder="例: 週次レポート改善" />
        </label>
        <Button controlId="chat.session-create" icon={<Plus size={14} />} onClick={() => { void createNamedChatSession(); }} disabled={!newChatSessionName.trim() || planning || creating || !targetProjectIsVerified}>新しい会話を作成</Button>
      </div>
      {chatSessionId && <p className="muted chat-session-note">この会社の会話をセッション単位で分離しています。Codex App Server threadは選択中のセッションへ紐づきます。</p>}
      {isManageWorkflowPlan && (
        <label className="chat-input">
          調整対象の自動化
          <select data-control-id="chat.automation-select" aria-label="調整対象の自動化" value={selectedAutomation?.id ?? ""} disabled={planning || creating || scheduleReadbackRequired || !targetAutomations.length} onChange={(event) => setSelectedAutomationId(event.target.value)}>
            <option value="">自動化を選択してください</option>
            {targetAutomations.map((automation) => <option key={automation.id} value={automation.id}>{automation.name ?? automation.id}</option>)}
          </select>
          {!targetAutomations.length && <small>この会社に保存済みの自動化がありません。</small>}
        </label>
      )}
      <div className="action-note" role="status" aria-live="off">{chatNote}</div>
      {plannerError && <div className="notice-row" role="alert">{plannerError}</div>}
      {presentationProfile && <div className="notice-row" role="note">
        表示プロファイル: {presentationProfile.label} / {presentationProfile.explanation ?? "このプロジェクトのreadbackに合わせて表示します。"}
      </div>}
      {mvpState.browser_use_runtime && <details className="chat-runtime-details">
        <summary>実行面の状態を確認</summary>
        <div className="notice-row" role="note">{selectedRuntimeSurfaceLabel}: {publicBrowserUseRuntimeStatus(mvpState.browser_use_runtime)} / {mvpState.browser_use_runtime.summary ?? "状態未確定"} / {mvpState.browser_use_runtime.fallbackPolicy ?? "切替ルール未確定"} / 登録レーン {mvpState.browser_use_runtime.lanes?.length ?? 0}</div>
      </details>}
      <div className={`scope-gate ${targetProjectIsVerified ? "ready" : "attention"}`} data-control-id="chat.scope-gate" role="status">
        <div><strong>{targetProjectIsVerified ? `作成対象: ${chatScopeLabel}` : "作成対象の会社を選んでください"}</strong><span>{targetProjectIsVerified ? "この会社scopeに保存・readbackします。外部効果は別承認です。" : "会社未選択のままではplanner・保存・実行に進みません。"}</span></div>
        {!targetProjectIsVerified && <Button controlId="chat.scope-gate.open-projects" onClick={() => go("#/projects")}>会社一覧を開く</Button>}
      </div>
      <details className="chat-advanced-diagnostics" data-control-id="chat.advanced-diagnostics">
        <summary>システム状態・Web操作の詳細を表示</summary>
      {Boolean(targetProject) && <Panel title="登録元の会社対応付け（診断）" controlId="chat.company-consultation.panel">
        <div className="button-row">
          <span className="muted">登録元とAOSの候補をfresh readbackし、Chatで相談するための読み取り専用 projectionです。</span>
          <Button controlId="chat.company-consultation.refresh" disabled={companyConsultationRefreshing || model.mvpLoadStatus !== "ready"} onClick={() => { void loadCompanyConsultation(); }}>{companyConsultationRefreshing ? "確認中" : "最新状態を確認"}</Button>
        </div>
        {companyConsultation.status === "loading" && <p className="muted">会社scopeの候補と出所を確認しています。</p>}
        {companyConsultation.status === "error" && <p className="muted">相談projectionを確認できませんでした: {publicBlockerSummary(companyConsultation.exactBlocker)}</p>}
        {companyConsultation.status === "ready" && companyConsultation.readback && <>
          <div className="notice-row" role="status">
            <strong>登録元との照合状態: {companyConsultation.readback.selection_state === "selected" ? `Owner選択済み（${canonicalCompanyLabel}）` : "対応付け未設定"}</strong>
            <span>{companyConsultation.readback.selection_state === "selected" ? "Ownerが選択した登録元の会社対応付けを保持しています。外部操作は別承認です。" : "外部登録元の会社対応付けは未設定です。上で選択済みのAOS会社や、既存接続・Runの状態とは別の診断です。"}</span>
            <span>blocker: {publicBlockerSummary(companyConsultation.readback.exact_blocker)} / external_action=false</span>
          </div>
          <div className="button-row" role="group" aria-label="会社scopeのChat段階">
            <Button controlId="chat.company-consultation.start" disabled={!companyConsultation.readback.chat.consultation_available || !targetProjectIsVerified || planning || creating} onClick={() => prepareCompanyChatStage("consultation")}>相談を入力</Button>
            <Button controlId="chat.company-consultation.demo-preview" disabled={!companyConsultation.readback.chat.read_only_demo_available || !targetProjectIsVerified || planning || creating} onClick={() => prepareCompanyChatStage("demo")}>read-only実演preview</Button>
            <Button controlId="chat.company-consultation.approval-preview" disabled={!companyConsultation.readback.chat.approval_preview_available || !targetProjectIsVerified || planning || creating} onClick={() => prepareCompanyChatStage("approval")}>承認previewを相談</Button>
          </div>
          <p className="muted">上のボタンはChat入力を用意するだけです。送信後もprovider・保存・送信・公開は開始せず、会社scopeとpreviewを会話で擦り合わせます。</p>
          <DataTable
            controlId="chat.company-consultation.candidates"
            headers={["候補会社", "状態", "登録automation", "AOS automation", "schedule", "出所"]}
            rows={companyConsultation.readback.candidates.map((candidate) => [
              candidate.company_id,
              candidate.status,
              String(candidate.counts.registered_automations),
              String(candidate.counts.local_automations),
              String(candidate.counts.schedules),
              `${candidate.provenance.trigger ?? "登録元なし"} / ${candidate.provenance.local}`
            ])}
          />
          <p className="muted">Chat相談={companyConsultation.readback.chat.consultation_available ? "利用可能" : "停止"} / read-only実演={companyConsultation.readback.chat.read_only_demo_available ? "利用可能" : "停止"} / 承認preview={companyConsultation.readback.chat.approval_preview_available ? "利用可能" : "停止"} / company-scoped登録={companyConsultation.readback.chat.company_scoped_registration_ready ? "利用可能" : "停止"} / provider・source sync・reconciliation・cleanup=未実行</p>
          {companyConsultation.readback.snapshot?.input_fingerprint && <p className="muted">snapshot: {companyConsultation.readback.snapshot.snapshot_id ?? "未確認"} / fingerprint: {companyConsultation.readback.snapshot.input_fingerprint.slice(0, 16)}…</p>}
        </>}
      </Panel>}
        <WebOperationAdmissionPanel model={model} projectId={targetProject} />
      </details>
      <div className="choice-row" aria-label="司令室ショートカット">
        <button data-control-id="chat.shortcut.job-status" disabled={planning || creating} onClick={() => {
          const shortcut = "今日の求人応募状況を確認";
          setPrompt(shortcut);
          setPlanVisible(false);
          setPlannerReadback(null);
          setPlannerProgress(null);
          setChatNote(`${shortcut}を入力欄にセットしました / ${actionStamp()}`);
          promptRef.current?.focus();
        }}>今日の求人応募状況を確認</button>
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
      <Panel title="最近のチャット" className="chat-history-panel" controlId="chat.history.panel">
        <p className="muted">会社別に保存されたCodex App Serverのthreadをreadbackします。再開して送ると同じthreadで続きます。</p>
        {chatHistoryLoading ? <p className="muted">チャット履歴を確認しています。</p> : chatThreads.length ? (
          <div className="status-grid">
            {chatThreads.map((thread, index) => (
              <div key={thread.threadId}>
                <strong>{thread.resultTitle ?? "Automation OSの会話"}</strong>
                <span>{thread.latestStatus} / {thread.updatedAt} / {thread.messages.length} messages</span>
                <Button controlId={`chat.history.resume.${index}`} onClick={() => resumeChat(thread)} disabled={planning || creating}>この会話を再開</Button>
              </div>
            ))}
          </div>
        ) : <p className="muted">この会社に保存済みのチャット履歴はありません。</p>}
      </Panel>
      <div className="chat-shell">
        <div className="chat-thread" role="region" aria-label={`Chat司令室。会社scope=${chatScopeLabel} / status=${chatStatus}`}>
          <div className="message-list" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Chatメッセージ">
            {messages.map((message) => <Bubble key={message.id} side={message.role === "user" ? "user" : undefined}>{message.text}</Bubble>)}
          </div>
          <ChatProgressPanel progress={plannerProgress} planning={planning} />
          <div className="choice-row" aria-label={`投稿先サービス（${selectedPlatforms.length}件選択）`}>
            {platformOptions.map((platform) => (
              <button type="button" data-control-id={`chat.platform.toggle.${platform}`} aria-pressed={selectedPlatforms.includes(platform)} aria-disabled={!targetProjectIsVerified || planning || creating} disabled={planning || creating} className={selectedPlatforms.includes(platform) ? "selected" : ""} onClick={() => togglePlatform(platform)} key={platform}>{platform}</button>
            ))}
            <button type="button" data-control-id="chat.platform.select-all" aria-pressed={allPlatformsSelected} disabled={!targetProjectIsVerified || planning || creating} className={allPlatformsSelected ? "selected" : ""} onClick={selectAllPlatforms}>{allPlatformsSelected ? "全て解除" : "全て選択"}</button>
            <button type="button" data-control-id="chat.details.focus" disabled={!targetProjectIsVerified || planning || creating} onClick={() => { setChatNote(`詳細入力へフォーカスしました / ${actionStamp()}`); promptRef.current?.focus(); }}>詳細を書く</button>
          </div>
          <div className="chat-mode-summary" data-control-id="chat.mode-summary" role="status" aria-live="polite">
            {(() => {
              const mode = chatModePresentation(activePrompt);
              return <><strong>送信モード: {mode.label}</strong><span>{mode.consequence}</span></>;
            })()}
          </div>
          <div className="chat-composer">
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
            <Button controlId="chat.cancel" onClick={() => { void cancelPlanning(); }} disabled={!planning}>停止</Button>
            <Button controlId="chat.send" variant="primary" icon={<MessageSquare size={14} />} onClick={sendMessage} disabled={!draftPrompt || planning || creating}>{planning ? "確認中" : "送信して考える"}</Button>
            <Button controlId="chat.recreate" onClick={startPlan} disabled={!activePrompt || planning || creating}>プランを再作成</Button>
            <Button controlId="chat.reset-input" onClick={resetChat} disabled={planning || creating}>入力をリセット</Button>
          </div>
          </div>
          {planVisible && (
          <div className="plan-card">
            <h3>{plan.title}</h3>
            {isCreateAutomationPlan && <p className="muted">{plan.targetLabel} / {plan.cadence} / {plan.schedule} / 外部操作前に承認停止</p>}
            <p className="muted">source: {plannerAdapter} / mode: {plannerModeLabel}{plannerPublicBlocker ? ` / ${plannerPublicBlocker}` : ""}</p>
            {plannerReadback?.tool_preference && <p className="muted">tool preference: Plugin first / MCP・CLI・API tied second / selected={plannerReadback.tool_preference.selected?.label ?? "未選択"} ({plannerReadback.tool_preference.selected?.status ?? "unknown"}) / company={plannerReadback.tool_preference.companyIds?.join(", ") || "未確認"}</p>}
            {plannerReadback?.chat_job_id && <p className="muted">job: {plannerReadback.chat_job_id} / thread: {plannerReadback.chat_thread_id ?? "未接続"} / turn: {plannerReadback.chat_turn_id ?? "未確定"}</p>}
            <p>{plannerReadback?.server_reply}</p>
            {plannerReadback?.web_operation_intake?.applicable && !fixedWorkflowConfirmed && (
              <div className="question-box" data-control-id="chat.web-operation-intake" role="status">
                <strong>共通Web操作の判定（外部操作なし）</strong>
                <p>状態: {plannerReadback.web_operation_intake.status} / 目的: {plannerReadback.web_operation_intake.operation ?? "未確定"} / 次: {plannerReadback.web_operation_intake.next_stage}</p>
                <p className="muted">対象: {plannerReadback.web_operation_intake.semantic_target ?? "未確認"} / account: {plannerReadback.web_operation_intake.account_ref ?? "未確認"} / site: {plannerReadback.web_operation_intake.site_or_url ?? "未確認"}</p>
                {plannerReadback.web_operation_intake.questions.map((question) => <p key={question}>{question}</p>)}
                <p className="muted">固定selector・XPath・DOM順は権威にせず、現在画面の意味候補を1件に解決します。外部効果は承認・同一Run readback・cleanupが揃うまで完了扱いにしません。</p>
              </div>
            )}
            {plannerReadback?.proposed_changes?.length ? <div className="question-box"><strong>保存候補の変更</strong>{plannerReadback.proposed_changes.map((change) => <p key={`${change.target}-${change.field}`}>{change.target} / {change.field}: {change.before ? `${change.before} → ` : ""}{change.after}</p>)}</div> : null}
            {plannerReadback?.requires_confirmation?.length ? <div className="question-box"><strong>確認が必要なこと</strong>{plannerReadback.requires_confirmation.map((item) => <p key={item}>{item}</p>)}</div> : null}
            {plan.steps.map((s, i) => <div className="step-line" key={s}><span>{i + 1}</span>{s}</div>)}
            {visiblePlanQuestions.length > 0 && <div className="question-box">
              <strong>確認したいこと</strong>
              {visiblePlanQuestions.map((question) => <p key={question}>{question}</p>)}
            </div>}
            {targetProjectIsVerified && targetProject === "company_2560580981cedfd106b66245" && plannerReadback?.chat_job_id &&
              <ChatWorkflowActionsPanel key={`${targetProject}:${plannerReadback.chat_job_id}`} model={model} companyId={targetProject}
                jobId={plannerReadback.chat_job_id} onBusy={setCreating} onReadback={setWorkflowReadback} />}
            {isManageWorkflowPlan && selectedAutomation && <div className="question-box" data-control-id="chat.schedule-preview">
              <strong>予定の設定内容（保存結果は下の確認欄に表示）</strong>
              <p>対象: {selectedAutomation.name ?? selectedAutomation.id} / {selectedAutomation.id}</p>
              <p>会社: {targetProject} / {scheduleAdjustmentPreview.kind} / {scheduleAdjustmentPreview.expression ?? "手動のみ"} / {scheduleAdjustmentPreview.timezone}</p>
              <p>保存後: {scheduleAdjustmentPreview.enabled ? "有効（次回予定から実行対象）" : "停止中（次回実行なし）"} / 現在revision: {selectedSchedule?.revision ?? "予定なし"}</p>
              <p>予定だけを保存します。今すぐ実行・処理内容の変更はしません。</p>
            </div>}
            <div className="button-row">
              {isCreateAutomationPlan && <Button controlId="chat.create" variant="primary" onClick={createFromChat} disabled={!canCreatePlan || creating}>{creating ? "保存確認中" : "仕様メモの下書きを保存"}</Button>}
              {isManageWorkflowPlan && <Button controlId="chat.adjust-schedule" variant="primary" onClick={saveAdjustedSchedule} disabled={!canAdjustSchedule || creating}>{creating ? "調整を保存中" : "定期実行を調整して保存"}</Button>}
              {(isManageWorkflowPlan || scheduleReadbackRequired) && <Button controlId="chat.adjust-readback" onClick={() => { void readAdjustedSchedule(); }} disabled={creating || (!selectedAutomation && !pendingScheduleAdjustment.current)}>対象の予定を再取得</Button>}
              <Button controlId="chat.edit" onClick={editPlan} disabled={creating}>内容を修正</Button>
              <Button controlId="chat.open-details" onClick={openDetails} disabled={!canCreatePlan || creating}>詳細設定を開く</Button>
            </div>
            {isManageWorkflowPlan
              ? <p className="muted">{canAdjustSchedule ? "このボタンは選択した自動化のschedule APIだけをrevision付きで更新します。外部投稿・送信は実行しません。" : "既存自動化を選び、時刻・曜日などを具体化すると保存できます。"}</p>
              : !canCreatePlan && <p className="muted">{plannerReadback?.can_create && !targetProjectIsVerified ? "保存先の会社を会社一覧から選択してください" : plannerReadback?.creation_blocker}</p>}
            {isCreateAutomationPlan && <p className="muted">「仕様メモの下書き」は実runnerへ接続しません。上に登録済み処理が表示された場合は、処理範囲を確認して実処理に接続した下書きを保存できます。</p>}
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

function JobApplicationTargetAdmissionPanel({ model, companyId }: { model: AppModel; companyId: string }) {
  const { setReceipt, mvpState } = model;
  const chromeProfile2BrowserAuthActive = isChromePluginProfile2Backend(mvpState.web_operation_backend);
  const internalBrowserAuthRef = chromeProfile2BrowserAuthActive ? CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF : "";
  const adoptedJobAutomation = (mvpState.automations ?? []).find((automation: any) => {
    const spec = automation?.builder_spec ?? {};
    return spec?.canonicalWorkflowId === "job-application-manager" || spec?.sourceAutomationId === "automation-3";
  });
  const adoptedJobAutomationId = String(adoptedJobAutomation?.id ?? "");
  const [form, setForm] = useState<Record<string, string>>({
    workflow_id: "job-application-manager",
    registered_automation_id: "",
    candidate_key: "",
    job_url: "",
    job_id: "",
    application_url: "",
    company_name: "",
    role: "",
    account_ref: "",
    audience_company: "",
    audience_job: "",
    resume_locale: "ja-JP",
    resume_sha256: "",
    payload_ref: "",
    payload_sha256: "",
    input_bundle_ref: "",
    input_bundle_sha256: "",
    owner_ref: "owner:automation-os",
    authority_ref: "authority:job-application-manager",
    source_snapshot_id: "",
    source_snapshot_expires_at: "",
    bucket: "japan_targeted",
    sequence: "1",
    attempt: "1",
    supply_run_id: ""
  });
  const [readback, setReadback] = useState<any>({ status: "loading", admissions: [] });
  const [connectionReadback, setConnectionReadback] = useState<any>({ status: "loading", refs: [] });
  const [busy, setBusy] = useState<"register" | "trigger" | "approve" | "retry" | "recover_expired" | "reconcile" | null>(null);
  const [reconciliationForm, setReconciliationForm] = useState({ artifact_ref: "", artifact_sha256: "" });
  const [reconciliationReadback, setReconciliationReadback] = useState<any>({ status: "loading", reconciliations: [] });
  const admissionKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const triggerKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const retryKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const reconciliationKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const update = (key: string, value: string) => setForm((previous) => ({ ...previous, [key]: value }));
  React.useEffect(() => {
    if (!adoptedJobAutomationId) return;
    setForm((previous) => previous.registered_automation_id === "" || previous.registered_automation_id === "automation-3"
      ? { ...previous, registered_automation_id: adoptedJobAutomationId }
      : previous);
  }, [adoptedJobAutomationId]);
  React.useEffect(() => {
    setForm((previous) => {
      const currentAccountRef = previous.account_ref.trim();
      if (internalBrowserAuthRef) {
        return !currentAccountRef || currentAccountRef === CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF
          ? { ...previous, account_ref: internalBrowserAuthRef }
          : previous;
      }
      return currentAccountRef === CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF
        ? { ...previous, account_ref: "" }
        : previous;
    });
  }, [internalBrowserAuthRef]);
  const loadReadback = async () => {
    setReadback((previous: any) => ({ ...previous, status: "loading" }));
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-target-admissions`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `target_admission_readback_http_${response.status}`);
      setReadback({ ...body, status: "ready" });
    } catch (error) {
      const exact = error instanceof Error ? error.message : "target_admission_readback_unavailable";
      setReadback({ status: "error", exactBlocker: exact, admissions: [] });
    }
  };
  const loadReconciliationReadback = async () => {
    setReconciliationReadback((previous: any) => ({ ...previous, status: "loading" }));
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-reconciliations`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `job_application_reconciliation_readback_http_${response.status}`);
      setReconciliationReadback({ ...body, status: "ready" });
    } catch (error) {
      const exact = error instanceof Error ? error.message : "job_application_reconciliation_readback_unavailable";
      setReconciliationReadback({ status: "error", exactBlocker: exact, reconciliations: [] });
    }
  };
  const loadConnectionReadback = async () => {
    setConnectionReadback((previous: any) => ({ ...previous, status: "loading" }));
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/connection-account-refs`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `connection_inventory_readback_http_${response.status}`);
      setConnectionReadback({ status: "ready", refs: Array.isArray(body.refs) ? body.refs : [], source: body.source ?? "aos_database" });
    } catch (error) {
      const exact = error instanceof Error ? error.message : "connection_inventory_readback_unavailable";
      setConnectionReadback({ status: "error", exactBlocker: exact, refs: [] });
    }
  };
  React.useEffect(() => { void loadReadback(); void loadReconciliationReadback(); void loadConnectionReadback(); }, [companyId]);
  const activeAdmission = (readback.admissions ?? []).find((item: any) => ["registered", "approval_pending", "approved", "running", "submitted", "reconciled"].includes(item.status)) ?? null;
  const approvalHandoffRecoveryEligible = activeAdmission?.status === "approved" && activeAdmission?.approval_status === "approved";
  const approvalExpiredRecoveryEligible = activeAdmission?.status === "approval_pending"
    && activeAdmission?.approval_status === "pending"
    && Boolean(activeAdmission?.run_id)
    && typeof activeAdmission?.approval_expires_at === "string"
    && Number.isFinite(Date.parse(activeAdmission.approval_expires_at))
    && Date.parse(activeAdmission.approval_expires_at) <= Date.now();
  const admissionAccountRef = String(activeAdmission?.account_ref ?? form.account_ref ?? "").trim();
  const verifiedConnectionRefs = connectionReadback.status === "ready"
    ? (Array.isArray(connectionReadback.refs) ? connectionReadback.refs : []).filter((ref: any) => {
      const oauthState = ref.oauth_state ?? ref.oauthState;
      const verificationStatus = ref.verification_status ?? ref.verificationStatus;
      const expiresAt = ref.expires_at ?? ref.expiresAt ?? null;
      return ref.status === "verified"
        && verificationStatus === "verified"
        && (oauthState === "connected" || oauthState === "not_applicable")
        && !ref.revoked_at && !ref.revokedAt
        && (!expiresAt || Date.parse(expiresAt) > Date.now());
    })
    : [];
  const approvalConnectionGate = (() => {
    if (!activeAdmission || (activeAdmission.approval_status !== "pending" && !approvalHandoffRecoveryEligible)) return "";
    if (connectionReadback.status === "loading") return "job_application_account_connection_readback_pending";
    if (connectionReadback.status !== "ready") return connectionReadback.exactBlocker ?? "job_application_account_connection_inventory_unavailable";
    const refs = Array.isArray(connectionReadback.refs) ? connectionReadback.refs : [];
    const targetAccountRef = admissionAccountRef;
    if (targetAccountRef === CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF) {
      return chromeProfile2BrowserAuthActive ? "" : "job_application_internal_browser_auth_surface_mismatch";
    }
    const hasVerifiedTarget = refs.some((ref: any) => {
      const oauthState = ref.oauth_state ?? ref.oauthState;
      const verificationStatus = ref.verification_status ?? ref.verificationStatus;
      const expiresAt = ref.expires_at ?? ref.expiresAt ?? null;
      return String(ref.account_ref ?? ref.accountRef ?? "").trim() === targetAccountRef
        && ref.status === "verified"
        && verificationStatus === "verified"
        && (oauthState === "connected" || oauthState === "not_applicable")
        && !ref.revoked_at && !ref.revokedAt
        && (!expiresAt || Date.parse(expiresAt) > Date.now());
    });
    if (hasVerifiedTarget) return "";
    return refs.length === 0 ? "job_application_account_connection_inventory_empty" : "job_application_account_ref_not_verified";
  })();
  const admissionRows = Array.isArray(readback.admissions) ? readback.admissions : [];
  const blockedAdmission = admissionRows.find((item: any) => item.status === "blocked")
    ?? (Array.isArray(readback.blocked_admissions) ? readback.blocked_admissions.find((item: any) => item.status === "blocked") : null);
  const todayKey = jstDateKey(new Date());
  const todayAdmissions = admissionRows.filter((item: any) => jstDateKey(item.updated_at ?? item.created_at) === todayKey);
  const todayBusinessSuccessCount = readback.status === "ready"
    ? todayAdmissions.filter((item: any) => item.status === "reconciled").length
    : null;
  const attentionAdmissionCount = readback.status === "ready"
    ? admissionRows.filter((item: any) => ["blocked", "rejected", "cancelled"].includes(String(item.status ?? ""))).length
    : null;
  const registrationBlocker = (() => {
    if (readback.status !== "ready") return readback.status === "loading" ? "応募対象のfresh readback確認中" : `応募対象readback未確認: ${readback.exactBlocker ?? "unknown"}`;
    if (activeAdmission) return "応募対象は既に1件登録済み";
    if (!form.candidate_key.trim()) return "candidate_keyが必要です";
    if (!form.job_url.trim() && !form.job_id.trim()) return "求人URLまたは求人IDが必要です";
    if (!form.company_name.trim()) return "会社名が必要です";
    if (!form.role.trim()) return "職種が必要です";
    if (!form.account_ref.trim()) return "account_refが必要です";
    if (form.account_ref.trim() === CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF && !chromeProfile2BrowserAuthActive) return "job_application_internal_browser_auth_surface_mismatch";
    if (!form.audience_company.trim() || !form.audience_job.trim()) return "audienceの会社・求人が必要です";
    if (!form.resume_locale.trim() || !form.resume_sha256.trim()) return "Resume localeとSHA-256が必要です";
    const hasPayloadPair = Boolean(form.payload_ref.trim() && form.payload_sha256.trim());
    const hasInputBundlePair = Boolean(form.input_bundle_ref.trim() && form.input_bundle_sha256.trim());
    if (!hasPayloadPair && !hasInputBundlePair) return "payloadまたはimmutable input_bundleのref・SHA-256が必要です";
    if (!form.owner_ref.trim() || !form.authority_ref.trim()) return "owner referenceとauthority referenceが必要です";
    if (!form.source_snapshot_id.trim() || !form.source_snapshot_expires_at.trim()) return "有効期限付きsource snapshotが必要です";
    if (!Number.isFinite(Date.parse(form.source_snapshot_expires_at)) || Date.parse(form.source_snapshot_expires_at) <= Date.now()) return "source snapshot expiryは現在時刻より未来である必要があります";
    if (!form.supply_run_id.trim()) return "supply_run_idが必要です";
    return "";
  })();
  const register = async () => {
    if (busy) return;
    const fingerprint = JSON.stringify(form);
    const idempotencyKey = stableIdempotencyKey(admissionKeyRef, "job-application-target-admission", fingerprint);
    setBusy("register");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-target-admissions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          workflow_id: "job-application-manager",
          registered_automation_id: form.registered_automation_id || undefined,
          candidate_key: form.candidate_key,
          job_url: form.job_url || undefined,
          job_id: form.job_id || undefined,
          application_url: form.application_url || undefined,
          company_name: form.company_name,
          role: form.role,
          account_ref: form.account_ref,
          audience: { company: form.audience_company, job: form.audience_job },
          resume_locale: form.resume_locale,
          resume_sha256: form.resume_sha256,
          payload_ref: form.payload_ref || undefined,
          payload_sha256: form.payload_sha256 || undefined,
          input_bundle_ref: form.input_bundle_ref || undefined,
          input_bundle_sha256: form.input_bundle_sha256 || undefined,
          owner_ref: form.owner_ref,
          authority_ref: form.authority_ref,
          effect_specific_approval: { action_kind: "one_candidate_submit", policy_version: "automation_os_portable_external_approval_binding.v1" },
          source_snapshot_id: form.source_snapshot_id,
          source_snapshot_expires_at: form.source_snapshot_expires_at,
          bucket: form.bucket,
          sequence: Number(form.sequence),
          attempt: Number(form.attempt),
          supply_run_id: form.supply_run_id
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `target_admission_create_http_${response.status}`);
      setReceipt(`応募対象を${body.source_of_truth ?? body.source_of_truth_backend ?? "AOS source"}へ登録しました。candidate=${body.admission?.candidate_key ?? "保存済み"} / approval=未開始 / external_action=false`);
      await loadReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "target_admission_create_failed";
      setReceipt(`応募対象は登録されていません。exact blocker=${exact}`);
    } finally {
      setBusy(null);
    }
  };
  const retryBlockedAdmission = async () => {
    if (!blockedAdmission || busy) return;
    const fingerprint = `${blockedAdmission.id}:${blockedAdmission.status}:${blockedAdmission.attempt ?? ""}:${blockedAdmission.run_id ?? ""}:${blockedAdmission.source_snapshot_id ?? ""}`;
    const idempotencyKey = stableIdempotencyKey(retryKeyRef, "job-application-target-retry", fingerprint);
    setBusy("retry");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-target-admissions/${encodeURIComponent(blockedAdmission.id)}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          source_snapshot_id: blockedAdmission.source_snapshot_id,
          source_snapshot_expires_at: blockedAdmission.source_snapshot_expires_at,
          supply_run_id: blockedAdmission.supply_run_id
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `target_admission_retry_http_${response.status}`);
      setReceipt(`前回Runは再利用せず、同じ対象を新しいattempt=${body.target_admission?.attempt ?? "保存済み"}として再準備しました。previous_run=${body.previous_run_id ?? "未確認"} / external_action=false`);
      await loadReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "target_admission_retry_failed";
      setReceipt(`応募対象の安全な再準備は未完了です。exact blocker=${exact}`);
    } finally {
      setBusy(null);
    }
  };
  const recoverExpiredApproval = async () => {
    if (!approvalExpiredRecoveryEligible || !activeAdmission || busy) return;
    setBusy("recover_expired");
    try {
      const supplyResponse = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-candidate-supply`, { cache: "no-store" });
      const supplyBody = await supplyResponse.json().catch(() => ({}));
      if (!supplyResponse.ok || supplyBody.ok === false) throw new Error(supplyBody.exactBlocker || supplyBody.error || `candidate_supply_readback_http_${supplyResponse.status}`);
      const candidate = Array.isArray(supplyBody.candidates)
        ? supplyBody.candidates.find((item: any) => String(item.candidateKey ?? item.candidate_key ?? "") === String(activeAdmission.candidate_key))
        : null;
      const sourceSnapshotId = String(candidate?.sourceSnapshotId ?? candidate?.source_snapshot_id ?? activeAdmission.source_snapshot_id ?? "").trim();
      const sourceSnapshotExpiresAt = String(candidate?.sourceSnapshotExpiresAt ?? candidate?.source_snapshot_expires_at ?? activeAdmission.source_snapshot_expires_at ?? "").trim();
      const supplyRunId = String(candidate?.supplyRunId ?? candidate?.supply_run_id ?? activeAdmission.supply_run_id ?? "").trim();
      if (!sourceSnapshotId || !sourceSnapshotExpiresAt) throw new Error("target_admission_fresh_source_snapshot_missing");
      const fingerprint = `${activeAdmission.id}:${activeAdmission.attempt ?? ""}:${activeAdmission.run_id ?? ""}:${activeAdmission.approval_id ?? ""}:${sourceSnapshotId}`;
      const idempotencyKey = stableIdempotencyKey(retryKeyRef, "job-application-target-expired-approval-recovery", fingerprint);
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-target-admissions/${encodeURIComponent(activeAdmission.id)}/recover-expired-approval`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ source_snapshot_id: sourceSnapshotId, source_snapshot_expires_at: sourceSnapshotExpiresAt, supply_run_id: supplyRunId })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `target_admission_expired_recovery_http_${response.status}`);
      setReceipt(`期限切れ承認を再利用せず、attempt=${body.target_admission?.attempt ?? "新規"}へ再準備しました。previous_run=${body.previous_run_id ?? "未確認"} / old_run_reused=false / external_action=false`);
      await loadReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "target_admission_expired_recovery_failed";
      setReceipt(`期限切れ承認の再準備は未完了です。exact blocker=${exact}`);
    } finally {
      setBusy(null);
    }
  };
  const trigger = async () => {
    if (!activeAdmission || busy) return;
    const automationId = form.registered_automation_id || activeAdmission.registered_automation_id || "";
    const fingerprint = `${activeAdmission.id}:${automationId}:${activeAdmission.status}:${activeAdmission.attempt ?? ""}:${activeAdmission.idempotency_key ?? ""}`;
    const idempotencyKey = stableIdempotencyKey(triggerKeyRef, "job-application-target-trigger", fingerprint);
    setBusy("trigger");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-target-admissions/${encodeURIComponent(activeAdmission.id)}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ automation_id: automationId })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.exactBlocker || body.error || `target_admission_trigger_http_${response.status}`);
      setReceipt(`同一Runへ束縛しました。run=${body.run?.id ?? "保存済み"} / approval=${body.approval?.status ?? "未確認"} / external_action=false`);
      await loadReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "target_admission_trigger_failed";
      setReceipt(`応募Runは開始されていません。exact blocker=${exact}`);
    } finally {
      setBusy(null);
    }
  };
  const approve = async () => {
    if (!activeAdmission?.approval_id || busy) return;
    setBusy("approve");
    try {
      const response = await mvpFetch(`/api/mvp/approvals/${encodeURIComponent(activeAdmission.approval_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", note: "Target-bound one-candidate application approval" })
      });
      const body = await response.json().catch(() => ({}));
      const recoveredExistingApproval = response.status === 409 && body.portable_recovery?.requeued === true;
      if ((!response.ok || body.ok === false) && !recoveredExistingApproval) {
        const recoveryReason = body.portable_recovery?.reason ? ` / portable_recovery=${body.portable_recovery.reason}` : "";
        throw new Error(`${body.exactBlocker || body.error || `target_admission_approval_http_${response.status}`}${recoveryReason}`);
      }
      setReceipt(recoveredExistingApproval
        ? `同一Runの承認handoffを再同期しました。approval=${activeAdmission.approval_id} / worker pickup待ち / external_action=false`
        : `target-bound approvalを保存しました。approval=${activeAdmission.approval_id} / worker receipt/readbackを取得します / external_action=false`);
      await loadReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "target_admission_approval_failed";
      setReceipt(`approvalは確定していません。exact blocker=${exact}`);
    } finally {
      setBusy(null);
    }
  };
  const reconcileExisting = async () => {
    if (busy || !reconciliationForm.artifact_ref.trim() || !reconciliationForm.artifact_sha256.trim()) return;
    const idempotencyKey = stableIdempotencyKey(
      reconciliationKeyRef,
      "job-application-existing-reconciliation",
      JSON.stringify(reconciliationForm)
    );
    setBusy("reconcile");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-reconciliations`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(reconciliationForm)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker || body.error || `job_application_reconciliation_http_${response.status}`);
      setReceipt(`既存応募を照合-onlyでAOSへ同期しました。run=${body.run?.id ?? "保存済み"} / 再応募=false / business_completion=false`);
      await loadReconciliationReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "job_application_reconciliation_failed";
      setReceipt(`既存応募は同期されていません。exact blocker=${exact}`);
    } finally {
      setBusy(null);
    }
  };
  const field = (key: string, label: string, placeholder = "") => <label key={key}>{label}<input aria-label={label} data-control-id={`job-target-admission.${key}`} value={form[key] ?? ""} placeholder={placeholder} onChange={(event) => update(key, event.target.value)} /></label>;
  return (
    <Panel title="応募対象を登録（target-bound admission）" controlId="job-target-admission.panel">
      <p className="muted">登録先はAPIのfresh source-of-truth readbackに従います。Resume／payloadの中身、パスワード、OTP、token、個人情報は入力・保存・表示しません。Resumeとpayloadは参照先とSHA-256だけを指定します。</p>
      <div className="action-note" role="status" data-control-id="job-target-admission.readback">source={readback.status === "ready" ? String(readback.source_of_truth ?? readback.source_of_truth_backend ?? "未確認") : readback.status} / workflow=job-application-manager / candidate={readback.candidate_count ?? 0} / approval={readback.approval_count ?? 0} / external_action=false</div>
      {readback.exactBlocker && <p className="muted">readback blocker: {readback.exactBlocker}</p>}
      <section className="job-progress-panel" data-control-id="job-application.progress.panel" aria-label="今日の求人応募進捗">
        <div className="panel-head"><h3>今日の応募進捗</h3><span className="muted">目標は20件 / JST</span></div>
        <div className="job-progress-grid">
          <div className="job-progress-item"><span>今日の目標</span><strong>20件</strong><small>応募成功の目標</small></div>
          <div className={`job-progress-item ${todayBusinessSuccessCount === null ? "pending" : todayBusinessSuccessCount > 0 ? "success" : "attention"}`} data-control-id="job-application.progress.success"><span>今日の成功応募</span><strong>{todayBusinessSuccessCount === null ? "未確認" : `${todayBusinessSuccessCount}件`}</strong><small>{todayBusinessSuccessCount === null ? "fresh readback未確定" : "reconciled（業務完了proofあり）のみ"}</small></div>
          <div className="job-progress-item" data-control-id="job-application.progress.candidates"><span>登録候補</span><strong>{readback.status === "ready" ? `${Number(readback.candidate_count ?? 0)}件` : "未確認"}</strong><small>候補登録済み / 応募完了とは別</small></div>
          <div className={`job-progress-item ${attentionAdmissionCount ? "attention" : "success"}`} data-control-id="job-application.progress.attention"><span>停止・要確認</span><strong>{attentionAdmissionCount === null ? "未確認" : `${attentionAdmissionCount}件`}</strong><small>{attentionAdmissionCount ? "登録・応募を再実行せず原因を確認" : "現在の登録readbackに該当なし"}</small></div>
        </div>
        <p className="job-progress-note">成功応募は、target admissionが<strong>reconciled</strong>になったものだけを数えます。候補登録・承認待ち・submitted・照合-onlyは成功件数に含めません。外部効果の完了は別の同一Run証跡で確認します。</p>
        <div className="job-classification-note" data-control-id="job-application.progress.classification" role="status"><strong>候補の追加分類</strong><span>給与根拠不足: 未確認 / 重複候補: 未確認</span><small>現行のtarget admission readbackは給与根拠・重複判定を返さないため、0件とは推測しません。候補供給readbackが揃った時点で分類します。</small></div>
      </section>
      <div className="form-grid job-admission-basic-fields">
        {field("registered_automation_id", "採用済み応募自動化ID", adoptedJobAutomationId || "会社に応募workflowを採用すると自動入力")}
        {field("candidate_key", "candidate_key", "supply ledgerのcandidate_key")}
        <label>workflow_id<input aria-label="workflow_id" data-control-id="job-target-admission.workflow_id" value="job-application-manager" readOnly /></label>
        {field("job_url", "求人URL（URLまたは求人ID）")}
        {field("job_id", "求人ID（URLがない場合）")}
        {field("application_url", "応募URL（省略時は求人URL）")}
        {field("company_name", "会社名")}
        {field("role", "職種")}
        {chromeProfile2BrowserAuthActive
          ? <label>account_ref（Profile 2内部認証）<input aria-label="account_ref（Profile 2内部認証）" data-control-id="job-target-admission.account_ref" value={form.account_ref} readOnly /></label>
          : field("account_ref", "account_ref")}
        {field("audience_company", "audience 対象会社")}
        {field("audience_job", "audience 対象求人")}
        {field("input_bundle_ref", "immutable input_bundle ref", "input-bundle://...")}
        {field("input_bundle_sha256", "input_bundle SHA-256")}
      </div>
      {chromeProfile2BrowserAuthActive
        ? <p className="muted" data-control-id="job-target-admission.internal-browser-auth-note">Chrome Plugin・Profile 2のfresh browser authorityを応募対象へ自動束縛しています。これはprovider OAuth接続ではないため、Integrationsの会社別connection inventoryには表示しません。</p>
        : <p className="muted" data-control-id="job-target-admission.provider-auth-note">現在のWeb操作面はProfile 2内部認証ではありません。provider account_refを入力し、会社別verified接続をfresh確認してください。</p>}
      <details className="job-admission-advanced" data-control-id="job-target-admission.advanced">
        <summary>証跡・権限・入力ハッシュの詳細を表示</summary>
        <p className="muted">応募対象を一意に確定するための参照値です。ファイル本文やsecretは入力せず、refとSHA-256だけを指定します。</p>
        <div className="form-grid">
          {field("resume_locale", "Resume locale", "ja-JP")}
          {field("resume_sha256", "Resume SHA-256")}
          {field("payload_ref", "payload immutable ref")}
          {field("payload_sha256", "payload SHA-256")}
          {field("owner_ref", "owner reference")}
          {field("authority_ref", "authority reference")}
          {field("source_snapshot_id", "source_snapshot_id")}
          {field("source_snapshot_expires_at", "source snapshot expiry", "2026-08-13T12:00:00.000Z")}
          {field("supply_run_id", "supply_run_id")}
          <label>bucket<select aria-label="求人対象bucket" data-control-id="job-target-admission.bucket" value={form.bucket} onChange={(event) => update("bucket", event.target.value)}><option value="japan_targeted">japan_targeted</option><option value="overseas_global">overseas_global</option></select></label>
          {field("sequence", "sequence")}
          {field("attempt", "attempt")}
        </div>
      </details>
      {registrationBlocker && <p className="muted" data-control-id="job-target-admission.register-gate" role="status">登録待機: {registrationBlocker}</p>}
      <div className="preview-box" data-control-id="job-target-admission.approval-contract">
        <strong>effect-specific approval</strong>
        <p className="muted">action_kind=one_candidate_submit / policy=automation_os_portable_external_approval_binding.v1 / target digest・同一Run idempotency・provider receipt・source sync・reconciliation・cleanupを維持します。</p>
      </div>
      <div className="preview-box" data-control-id="job-target-admission.connection-gate" role="status">
        <strong>応募アカウント接続ゲート</strong>
        <p className="muted">応募対象のaccount_refと会社別connection inventoryをfresh照合します。verified接続が確認できるまで、承認・handoff再同期は保存しません。</p>
        <p className="muted" data-control-id="job-target-admission.connection-readback">
          対象account_ref: <strong>{admissionAccountRef || "未設定"}</strong>
          {admissionAccountRef === CHROME_PLUGIN_INTERNAL_BROWSER_AUTH_REF
            ? "（Chrome Plugin / Profile 2の内部認証。provider OAuth接続とは別）"
            : "（provider接続）"}
          {" / "}verified接続: {connectionReadback.status === "loading" ? "確認中" : connectionReadback.status !== "ready" ? "未確認" : `${verifiedConnectionRefs.length}件`}
          {connectionReadback.status === "ready" && verifiedConnectionRefs.length > 0
            ? ` / ${verifiedConnectionRefs.map((ref: any) => `${ref.platform ?? "provider"}:${ref.account_ref ?? ref.accountRef ?? "未確認"}`).join(", ")}`
            : ""}
        </p>
        {approvalConnectionGate
          ? <p>承認停止: {approvalConnectionGate} / 次: {approvalConnectionGate === "job_application_account_connection_inventory_empty" ? "Integrationsでverified接続参照を用意する" : approvalConnectionGate === "job_application_internal_browser_auth_surface_mismatch" ? "Chrome Plugin・Profile 2を選択してfresh browser authorityを確認する" : "対象account_refを再認証・検証する"}</p>
          : <p>承認ゲート: {activeAdmission ? "対象account_refのverified接続を確認済み" : "対象Run登録後に確認"}</p>}
      </div>
      <div className="button-row">
        <Button controlId="job-target-admission.register" variant="primary" disabled={Boolean(busy) || Boolean(registrationBlocker)} onClick={() => { void register(); }}>{busy === "register" ? "登録確認中" : activeAdmission ? "登録済み（1件制限）" : "応募対象を登録"}</Button>
        {blockedAdmission && <Button controlId="job-target-admission.retry-blocked" variant="primary" disabled={Boolean(busy) || Boolean(activeAdmission)} onClick={() => { void retryBlockedAdmission(); }}>{busy === "retry" ? "再準備確認中" : "前回失敗を再利用せず安全に再準備"}</Button>}
        {approvalExpiredRecoveryEligible && <Button controlId="job-target-admission.recover-expired-approval" variant="primary" disabled={Boolean(busy)} onClick={() => { void recoverExpiredApproval(); }}>{busy === "recover_expired" ? "期限切れ承認を再準備中" : "期限切れ承認を再利用せず再準備"}</Button>}
        <Button controlId="job-target-admission.trigger" disabled={Boolean(busy) || !activeAdmission || Boolean(activeAdmission?.run_id)} onClick={() => { void trigger(); }}>{busy === "trigger" ? "同一Runへ束縛中" : "採用済み応募workflowの同一Runを開始"}</Button>
        <Button controlId="job-target-admission.approve" variant="primary" disabled={Boolean(busy) || Boolean(approvalConnectionGate) || (activeAdmission?.approval_status !== "pending" && !approvalHandoffRecoveryEligible)} onClick={() => { void approve(); }}>{busy === "approve" ? "承認保存中" : approvalHandoffRecoveryEligible ? "同一Runのhandoffを再同期" : "応募を承認"}</Button>
        <Button controlId="job-target-admission.refresh" icon={<RefreshCw size={14} />} onClick={() => { void loadReadback(); }}>fresh readback</Button>
      </div>
      {activeAdmission && <div className="preview-box" data-control-id="job-target-admission.candidate-readback">
        <strong>candidate readback</strong>
        <p>candidate={activeAdmission.candidate_key} / status={activeAdmission.status} / approval={activeAdmission.approval_status} / run={activeAdmission.run_id ?? "未開始"}</p>
        <p className="muted">source_snapshot={activeAdmission.source_snapshot_id} / expires={activeAdmission.source_snapshot_expires_at} / target_digest={activeAdmission.target_digest} / ref/hashのみ表示</p>
      </div>}
      {blockedAdmission && <div className="preview-box" data-control-id="job-target-admission.blocked-readback">
        <strong>停止した対象のreadback</strong>
        <p>candidate={blockedAdmission.candidate_key} / status=blocked / approval={blockedAdmission.approval_status} / previous_run={blockedAdmission.run_id ?? "未確認"}</p>
        <p className="muted">外部効果は実行されていません。安全な再準備は、同一対象の前回Runを再実行せず、durable no-effect証跡・Effect Ledger・source snapshot有効期限を確認してattemptだけを更新します。</p>
      </div>}
      <section className="panel" data-control-id="job-reconciliation.panel">
        <div className="panel-head"><h3>既存応募の照合-only同期</h3></div>
        <p className="muted">Profile 2で取得済みの応募済みreadbackだけをAOSへ記録します。新しい応募Run、承認、送信は発生せず、業務完了もclaimしません。</p>
        <div className="form-grid">
          <label>readback artifact ref<input aria-label="既存応募readback artifact ref" data-control-id="job-reconciliation.artifact-ref" value={reconciliationForm.artifact_ref} onChange={(event) => setReconciliationForm((previous) => ({ ...previous, artifact_ref: event.target.value }))} /></label>
          <label>readback artifact SHA-256<input aria-label="既存応募readback artifact SHA-256" data-control-id="job-reconciliation.artifact-sha256" value={reconciliationForm.artifact_sha256} onChange={(event) => setReconciliationForm((previous) => ({ ...previous, artifact_sha256: event.target.value }))} /></label>
        </div>
        <p className="muted" role="status" data-control-id="job-reconciliation.readback">{reconciliationReadback.status === "ready" ? `照合済み=${reconciliationReadback.reconciliations?.length ?? 0}件 / external_action=false / business_completion=false` : reconciliationReadback.status === "loading" ? "照合readback確認中" : `照合readback未確認: ${reconciliationReadback.exactBlocker ?? "unknown"}`}</p>
        <div className="button-row">
          <Button controlId="job-reconciliation.submit" variant="primary" disabled={Boolean(busy) || !reconciliationForm.artifact_ref.trim() || !reconciliationForm.artifact_sha256.trim()} onClick={() => { void reconcileExisting(); }}>{busy === "reconcile" ? "照合保存中" : "既存応募を照合-onlyで同期"}</Button>
          <Button controlId="job-reconciliation.refresh" icon={<RefreshCw size={14} />} onClick={() => { void loadReconciliationReadback(); }}>照合readback</Button>
        </div>
      </section>
    </Panel>
  );
}

function JobApplicationAdmissionPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const activeProject = projectSlugFromRoute(route);
  const projectName = projectLabelFromState(model.mvpState, activeProject);
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={`${projectName} / 応募登録`} desc="求人応募の対象登録・同一Run・承認・照合を、定期実行とは分けて管理します。">
        <Button controlId="job-admission.back-to-automations" onClick={() => go(`#/projects/${activeProject}/automations`)}>自動化一覧へ</Button>
      </PageTitle>
      <div className="action-note" role="status">応募登録は対象を一意に確定する専用画面です。登録・Run開始・承認・送信はそれぞれ別の状態として確認します。</div>
      <ProjectScopeNotice projectId={activeProject} mvpState={model.mvpState} />
      {activeProject && <JobApplicationDigestPanel model={model} companyId={activeProject} />}
      {activeProject && <JobSheetPopulationAuditPanel companyId={activeProject} />}
      {activeProject && <JobApplicationTargetAdmissionPanel model={model} companyId={activeProject} />}
    </section>
  );
}

function isHourlyCandidateForDisplay(candidate: any): boolean {
  const period = String(candidate?.salaryPeriod ?? candidate?.salary_period ?? "").trim().toLowerCase();
  const role = String(candidate?.role ?? "").toLowerCase();
  return period === "hourly" || /\/hr\b|per\s+hour\b|hourly\b/u.test(role);
}

function normalizeCandidateForDisplay(candidate: any): any {
  if (!isHourlyCandidateForDisplay(candidate)) return candidate;
  const blockers = String(candidate?.blocker ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!blockers.includes("annual_salary_threshold_not_proven_from_hourly_contract_range")) {
    blockers.push("annual_salary_threshold_not_proven_from_hourly_contract_range");
  }
  return {
    ...candidate,
    salaryPeriod: "hourly",
    salaryJpy: null,
    status: "blocked",
    blocker: blockers.join(","),
    nextAction: "時給を年収へ換算する契約時間根拠がないため、年収根拠を確認してから進む"
  };
}

function candidateDisplayStage(status: unknown): "応募完了" | "応募準備" | "発見" {
  if (status === "reconciled") return "応募完了";
  if (status === "eligible") return "応募準備";
  return "発見";
}

function JobApplicationDigestPanel({ model, companyId }: { model: AppModel; companyId: string }) {
  const [period, setPeriod] = useState<"morning" | "evening">("morning");
  const [readback, setReadback] = useState<any>({ status: "loading", digest: null, candidates: [], sheet_mirrors: [] });
  const [refreshing, setRefreshing] = useState(false);
  const [candidateImportText, setCandidateImportText] = useState("");
  const [candidateImporting, setCandidateImporting] = useState(false);
  const [candidateImportReceipt, setCandidateImportReceipt] = useState("");
  const load = async (requestedPeriod = period) => {
    if (refreshing) return;
    setRefreshing(true);
    setReadback((previous: any) => ({ ...previous, status: "loading" }));
    try {
      const supplyResponse = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-candidate-supply`, { cache: "no-store" });
      const supplyBody = await supplyResponse.json().catch(() => ({}));
      if (!supplyResponse.ok || supplyBody.ok === false) throw new Error(supplyBody.exactBlocker || supplyBody.error || `job_application_supply_http_${supplyResponse.status}`);
      // Candidate supply already returns the same company-scoped digest
      // snapshot. Use that single readback for both the morning/evening view
      // selector instead of serially waiting on two identical Postgres fan-
      // outs. The period is a presentation choice here; no schedule is
      // changed and no provider action is started.
      setReadback({ status: "ready", period: requestedPeriod, ...supplyBody, digest: supplyBody.digest ?? null });
    } catch (error) {
      const exact = error instanceof Error ? error.message : "job_application_digest_readback_unavailable";
      setReadback({ status: "error", exactBlocker: exact, digest: null, candidates: [], sheet_mirrors: [] });
    } finally {
      setRefreshing(false);
    }
  };
  const importCandidateSupply = async () => {
    if (candidateImporting) return;
    const raw = candidateImportText.trim();
    if (!raw || raw.length > 120_000) {
      setCandidateImportReceipt("候補を保存していません。20件以内の候補JSONを入力してください。");
      return;
    }
    setCandidateImporting(true);
    setCandidateImportReceipt("候補をAOSへ保存中 / 外部action=false");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown }).candidates)
          ? (parsed as { candidates: unknown[] }).candidates
          : [];
      if (candidates.length < 1 || candidates.length > 20) throw new Error("candidate_import_count_invalid");
      const forbidden = /password|passwd|secret|token|cookie|otp|security[_-]?code|api[_-]?key|private[_-]?key/iu;
      const results: Array<{ ok: boolean; status: number; blocker: string | null }> = [];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("candidate_import_record_invalid");
        const candidateKeys = Object.keys(candidate as Record<string, unknown>);
        if (candidateKeys.some((key) => forbidden.test(key))) throw new Error("candidate_import_sensitive_field_rejected");
        const candidateKey = typeof (candidate as { candidate_key?: unknown }).candidate_key === "string"
          ? (candidate as { candidate_key: string }).candidate_key
          : "";
        if (!candidateKey) throw new Error("candidate_import_candidate_key_required");
        const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-candidate-supply`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": newIdempotencyKey(`candidate-supply:${candidateKey}`) },
          body: JSON.stringify(candidate)
        });
        const body = await response.json().catch(() => ({}));
        results.push({ ok: response.ok && body.ok !== false, status: response.status, blocker: body.exact_blocker ?? body.exactBlocker ?? body.error ?? body.candidate?.blocker ?? null });
      }
      const saved = results.filter((result) => result.ok).length;
      const blocked = results.filter((result) => !result.ok).length;
      setCandidateImportReceipt(`候補保存 ${saved}件 / 停止・要確認 ${blocked}件 / external_action=false`);
      await load(period);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "candidate_import_failed";
      setCandidateImportReceipt(`候補は保存していません。exact blocker=${exact} / external_action=false`);
    } finally {
      setCandidateImporting(false);
    }
  };
  React.useEffect(() => { void load(period); }, [companyId, period]);
  const digest = readback.digest;
  const displayCandidates = Array.isArray(readback.candidates) ? readback.candidates.map(normalizeCandidateForDisplay) : [];
  const hourlyCandidateCount = displayCandidates.filter((candidate: any) => isHourlyCandidateForDisplay(candidate)).length;
  const salaryAnnualThresholdUnprovenCount = Math.max(Number(digest?.salary_annual_threshold_unproven_count ?? 0), hourlyCandidateCount);
  const salaryBelowThresholdCount = Math.max(0, Number(digest?.salary_below_threshold_count ?? 0) - hourlyCandidateCount);
  const candidateRows = displayCandidates.map((candidate: any) => {
    const hourly = isHourlyCandidateForDisplay(candidate);
    const salary = !hourly && Number.isFinite(Number(candidate.salaryJpy)) && Number(candidate.salaryJpy) > 0
      ? `${Number(candidate.salaryJpy).toLocaleString("ja-JP")}円`
      : hourly ? "年収未確認（時給）" : "未確認";
    const stage = candidateDisplayStage(candidate.status);
    const remoteMode = String(candidate.remoteMode ?? candidate.remote_mode ?? "").trim();
    const workLocation = String(candidate.workLocation ?? candidate.work_location ?? "").trim();
    const workstyle = [remoteMode, workLocation].filter(Boolean).join(" / ") || "未確認";
    return [candidate.companyName ?? "-", candidate.role ?? "-", candidate.language === "en" ? "英語 / Resume" : "日本語 / 履歴書", salary, workstyle, stage] as any[];
  });
  const previewCandidateRows = candidateRows.slice(0, 3);
  const detailCandidateRows = candidateRows.slice(3);
  const candidateHeaders = ["会社", "職種", "書類", "給与JPY（年換算）", "勤務形態", "状態"];
  const emptyCandidateRows = [["候補なし", "-", "-", "未確認", "未確認", "発見"]];
  return <Panel title="朝夕digest / 求人候補の手動readback" controlId="job-application.digest.panel">
    <p className="muted">通知やscheduleは変更せず、現在のAOS DBから手動で確認します。候補発見・queued・承認待ち・応募成功は別の数として表示します。</p>
    <div className="button-row" role="group" aria-label="求人digestの期間">
      <Button controlId="job-application.digest.morning" variant={period === "morning" ? "primary" : "secondary"} onClick={() => setPeriod("morning")}>朝digest</Button>
      <Button controlId="job-application.digest.evening" variant={period === "evening" ? "primary" : "secondary"} onClick={() => setPeriod("evening")}>夕digest</Button>
      <Button controlId="job-application.digest.refresh" icon={<RefreshCw size={14} />} disabled={refreshing} onClick={() => { void load(period); }}>{refreshing ? "確認中" : "手動で再確認"}</Button>
    </div>
    {readback.status === "loading" ? <ReadbackState title="求人digestを自動確認中" detail="AOS DBの候補・target admission・Sheets mirror状態を読み取っています。結果が取れなければexact blockerを確定します。" tone="info" nextAction="自動再読込を実行し、失敗時はexact blockerを表示する" />
      : readback.status === "error" ? <ReadbackState title="求人digestを確認できません" detail={`exact blocker=${readback.exactBlocker ?? "unknown"}`} tone="attention" nextAction="会社scopeとAOS serverのhealthを確認する" />
        : digest ? <>
          <div className="cards four" data-control-id="job-application.digest.metrics">
            <MetricCard controlId="job-application.digest.target" title="今日の目標" value={`${digest.target ?? 20}件`} sub="手動実行 / JST" status="enabled" />
            <MetricCard controlId="job-application.digest.success" title="成功応募" value={`${digest.success_count ?? 0}件`} sub="reconciledのみ" status={digest.success_count ? "approved" : "draft"} />
            <MetricCard controlId="job-application.digest.candidates" title="候補" value={`${digest.candidate_count ?? 0}件`} sub={`条件適合=${digest.eligible_candidate_count ?? 0}`} status="draft" />
            <MetricCard controlId="job-application.digest.stopped" title="停止・要確認" value={`${digest.stopped_count ?? 0}件`} sub={`照合待ち=${digest.awaiting_reconciliation_count ?? 0}`} status={digest.stopped_count ? "blocked" : "enabled"} />
          </div>
          <div className="job-cumulative-progress" data-control-id="job-application.digest.cumulative" role="status">
            <div><strong>累計1,000件の進捗</strong><span>{digest.cumulative_success === null || digest.cumulative_success === undefined ? "未確認" : `${digest.cumulative_success} / ${digest.cumulative_target ?? 1000}件`}</span></div>
            <small>reconciled（同一Runの業務完了proofあり）の応募だけを加算。候補・queued・submitted・照合待ちは含めません。</small>
          </div>
          <p className="muted" data-control-id="job-application.digest.next-action">次の1手: {digest.next_action ?? "fresh候補のreadbackを確認"}</p>
          <details className="job-candidate-import" data-control-id="job-application.digest.candidate-import">
            <summary>候補供給を手動でAOS ledgerへ保存</summary>
            <p className="muted">Chromeで取得した候補の構造化データだけを保存します。応募・承認・Run開始・スケジュール変更は行いません。パスワード、token、cookie、OTPなどのキーは拒否します。</p>
            <label>候補JSON（1〜20件）<textarea aria-label="候補供給JSON" data-control-id="job-application.digest.candidate-import-input" value={candidateImportText} onChange={(event) => setCandidateImportText(event.target.value)} placeholder='[{"candidate_key":"linkedin-123","source_snapshot_id":"...","source_snapshot_expires_at":"...","supply_run_id":"...","job_url":"https://www.linkedin.com/jobs/view/123/","company_name":"Example AI","role":"AI Marketing","language":"en","salary_original_min":null,"salary_original_max":null,"salary_currency":"JPY","salary_period":"annual","fx_to_jpy":null,"salary_source_url":null,"fx_source_url":null,"salary_source_time":null,"work_location":"japan","work_authorization":"japan_visa","remote_mode":"hybrid"}]' /></label>
            <div className="button-row">
              <Button controlId="job-application.digest.candidate-import-submit" variant="primary" disabled={candidateImporting || !candidateImportText.trim()} onClick={() => { void importCandidateSupply(); }}>{candidateImporting ? "候補を保存中" : "AOS ledgerへ保存"}</Button>
            </div>
            {candidateImportReceipt && <p className="muted" role="status" data-control-id="job-application.digest.candidate-import-receipt">{candidateImportReceipt}</p>}
          </details>
          <p className="muted" role="status">条件適合候補は応募送信可能数とは別です。account_ref・authority・承認・provider receipt・source sync・reconciliation・cleanupが揃うまで送信は開始しません。</p>
          <div className="job-classification-note" data-control-id="job-application.digest.classification"><strong>判定内訳</strong><span>給与根拠不足={digest.salary_evidence_missing_count ?? 0} / 年収換算未確認={salaryAnnualThresholdUnprovenCount} / 年収基準未達={salaryBelowThresholdCount} / 重複除外={digest.duplicate_excluded_count ?? 0}</span><small>年収は500万円以上をJPY換算根拠付きで判定。時給は契約時間根拠なしに年収化せず、未確認は0件に丸めません。</small></div>
          <div className="job-candidate-stage-note" data-control-id="job-application.digest.candidate-stage" role="status"><strong>候補の表示段階</strong><span>reconciledのみ=応募完了 / eligibleのみ=応募準備 / それ以外=発見</span><small>応募完了はreconciled以外に推測しません。</small></div>
          <div className="job-candidate-preview" data-control-id="job-application.digest.candidate-preview">
            <strong>候補プレビュー（最大3件）</strong>
            <DataTable controlId="job-application.digest.candidate-table" headers={candidateHeaders} rows={previewCandidateRows.length ? previewCandidateRows : emptyCandidateRows} />
          </div>
          <details className="job-candidate-details" data-control-id="job-application.digest.candidate-details">
            <summary>候補詳細（プレビュー以外 {detailCandidateRows.length}件）</summary>
            <p className="muted">同じ会社scopeのcandidate readbackを表示します。ここでも候補段階はread-onlyで、応募・公開・Sheet write・schedule変更は行いません。</p>
            {detailCandidateRows.length ? <DataTable headers={candidateHeaders} rows={detailCandidateRows} /> : <p className="muted">追加候補はありません。</p>}
          </details>
          <p className="muted" data-control-id="job-application.digest.sheets">Sheets mirror: prepared/syncedの状態だけを表示。現在の同期状態={readback.sheet_mirrors?.length ? `${readback.sheet_mirrors.length}行` : "未確認"} / 外部Sheets connectorは未検証なら応募成功とは扱いません。 <a data-control-id="job-application.digest.sheets.open" href="https://docs.google.com/spreadsheets/d/1NuafTrHrgjPVR2biU2KjpqHCWyZuHfMUaYm4eLuWoyI/edit#gid=1255319564" target="_blank" rel="noreferrer">Sheetsを開く</a></p>
        </> : <ReadbackState title="求人digestは未確認です" detail="候補供給readbackがありません。" tone="attention" nextAction="手動で再確認する" />}
  </Panel>;
}

const SHEET_POPULATION_AUDIT_SCHEMA = "aos.job_application_sheet_mirror_sync.v1";
const SHEET_POPULATION_AUDIT_PLACEHOLDER = JSON.stringify({
  schema: SHEET_POPULATION_AUDIT_SCHEMA,
  spreadsheet_id: "spreadsheet-id",
  sheet_id: "1255319564",
  sheet_name: "AOS候補",
  range: "A2:T167",
  readback_at: "2026-08-26T00:00:00.000Z",
  rows: [{
    row_number: 2,
    values: [
      "candidate-key",
      "source-snapshot-id",
      "2026-08-27T00:00:00.000Z",
      "Example AI",
      "AI Marketing",
      "https://example.com/job",
      "https://example.com/apply",
      "en",
      "hybrid",
      "Japan",
      "japan_visa",
      5000000,
      null,
      null,
      "JPY",
      "annual",
      "https://example.com/salary",
      "eligible",
      null,
      "target admissionを確認"
    ]
  }]
}, null, 2);

function JobSheetPopulationAuditPanel({ companyId }: { companyId: string }) {
  const [payloadText, setPayloadText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [result, setResult] = useState<any>(null);
  const [exactBlocker, setExactBlocker] = useState<string | null>(null);
  const runAudit = async () => {
    if (status === "loading") return;
    setStatus("loading");
    setResult(null);
    setExactBlocker(null);
    try {
      const parsed = JSON.parse(payloadText.trim()) as any;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schema !== SHEET_POPULATION_AUDIT_SCHEMA) {
        throw new Error("sheet_population_readback_schema_required");
      }
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(companyId)}/job-application-sheet-mirror-population-audit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payloadText
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.exactBlocker ?? body.exact_blocker ?? body.error ?? `sheet_population_audit_http_${response.status}`);
      setResult(body.audit ?? null);
      setStatus("ready");
    } catch (error) {
      const exact = error instanceof Error ? error.message : "sheet_population_audit_failed";
      setExactBlocker(exact);
      setStatus("error");
    }
  };
  const value = (field: string) => result?.[field] === null || result?.[field] === undefined ? "—" : String(result[field]);
  const list = (field: string) => Array.isArray(result?.[field]) && result[field].length ? result[field].slice(0, 5).join(", ") : "なし";
  const populationLabel = result?.population_exact === true ? "一致" : result?.population_exact === false ? "差分あり" : "—";
  return <Panel title="Sheets母集団監査 / read-only" controlId="job-application.sheet-population-audit.panel">
    <details data-control-id="job-application.sheet-population-audit.details">
      <summary>native Sheet readbackを入力して確認</summary>
      <p className="muted">公式Sheets connectorの20列readback JSONを貼り付け、AOS sourceとの候補人口だけを比較します。明示操作時だけ実行し、保存・削除・応募・schedule変更は行いません。</p>
      <label>native Sheet readback JSON<textarea aria-label="native Sheet readback JSON" data-control-id="job-application.sheet-population-audit.input" value={payloadText} onChange={(event) => setPayloadText(event.target.value)} placeholder={SHEET_POPULATION_AUDIT_PLACEHOLDER} /></label>
      <div className="button-row">
        <Button controlId="job-application.sheet-population-audit.reload" icon={<RefreshCw size={14} />} disabled={status === "loading" || !payloadText.trim()} onClick={() => { void runAudit(); }}>{status === "loading" ? "監査中" : "read-onlyで監査"}</Button>
      </div>
      {status === "idle" ? <ReadbackState title="母集団監査は未確認です" detail="native Sheet readbackを入力して明示実行するまで、AOSやSheetsへアクセスしません。" tone="neutral" nextAction="折りたたみを開き、readbackを入力して監査する" /> : null}
      {status === "error" ? <ReadbackState title="母集団監査を確認できません" detail={`exact blocker=${exactBlocker ?? "unknown"}`} tone="attention" nextAction="source・connector・readbackを確認する" /> : null}
      {status === "ready" && result ? <>
        <div className="cards four" data-control-id="job-application.sheet-population-audit.metrics">
          <MetricCard controlId="job-application.sheet-population-audit.population" title="母集団" value={populationLabel} sub="candidate keyの比較" status={result.population_exact ? "approved" : "blocked"} />
          <MetricCard controlId="job-application.sheet-population-audit.source-count" title="AOS source" value={value("source_count")} sub="候補件数" status="enabled" />
          <MetricCard controlId="job-application.sheet-population-audit.sheet-count" title="Sheet data rows" value={value("sheet_data_row_count")} sub={`入力行=${value("sheet_row_count")}`} status="enabled" />
          <MetricCard controlId="job-application.sheet-population-audit.matching-count" title="一致候補" value={value("matching_candidate_count")} sub="candidate key" status="enabled" />
        </div>
        <div className="job-classification-note" data-control-id="job-application.sheet-population-audit.anomalies"><strong>要確認内訳</strong><span>空行={value("blank_row_count")} / malformed={value("malformed_row_count")} / source重複={Array.isArray(result.duplicate_source_candidate_keys) ? result.duplicate_source_candidate_keys.length : "—"} / Sheet重複={Array.isArray(result.duplicate_sheet_candidate_keys) ? result.duplicate_sheet_candidate_keys.length : "—"}</span><small>source-only={list("source_only_candidate_keys")} / Sheet-only={list("sheet_only_candidate_keys")}</small></div>
        <p className="muted" role="status">external_action_executed={result.external_action_executed === false ? "false" : "未確認"} / audit schema={value("schema")}</p>
      </> : null}
    </details>
  </Panel>;
}

const REGISTERED_AUTOMATION_LABELS: Record<string, string> = {
  "daily-ai-research-publish-run": "日次AI 研究・公開",
  "job-application-manager": "求人応募管理",
  "nisenprints-daily-product-canva-printify-etsy-pinterest": "NisenPrints 商品・公開",
  "prompt-transfer-ukiyoe": "浮世絵プロンプト転記",
  "sns-multi-poster-ukiyoe": "SNSマルチ投稿",
  "x-authenticated-browser-lane": "X認証ブラウザlane"
};

function workflowGuideBadge(item: WorkflowStartGuideItem): { status: Status; label: string } {
  if (item.state === "ready") return { status: "enabled", label: item.statusLabel };
  if (["company_mismatch", "ambiguous", "needs_reconciliation"].includes(item.state)) return { status: "blocked", label: item.statusLabel };
  if (item.state === "not_registered") return { status: "draft", label: item.statusLabel };
  return { status: "waiting", label: item.statusLabel };
}

function workflowExecutionTargetLabel(item: WorkflowStartGuideItem): string {
  const labels: Record<WorkflowStartGuideItem["executionTarget"]["state"], string> = {
    unknown: "未確認",
    not_required: "不要",
    unbound: "未設定",
    bound: "binding確認済み",
    company_mismatch: "会社不一致",
    competing: "競合",
    revoked: "失効",
    scope_insufficient: "scope不足"
  };
  return labels[item.executionTarget.state] ?? "未確認";
}

function WorkflowStartGuidePanel({
  guide,
  localCheckEnabled = false,
  localCheckReceipts = {},
  onLocalCheck
}: {
  guide: ReturnType<typeof buildWorkflowStartGuide>;
  localCheckEnabled?: boolean;
  localCheckReceipts?: Record<string, string>;
  onLocalCheck?: (item: WorkflowStartGuideItem) => void;
}) {
  const gateLabel = guide.executionGate.status === "ready"
    ? "登録inventory内に実行可能フラグあり"
    : guide.executionGate.status === "preflight_only"
      ? "登録inventoryはread-only確認のみ"
      : guide.executionGate.status === "blocked"
        ? "登録inventoryの業務実行は停止中"
        : "実行ゲート未確認";
  const gateDetail = guide.executionGate.status === "preflight_only"
    ? "登録readbackは新鮮ですが、登録inventoryの業務実行はまだ許可されていません。read-only確認だけ進められます。5ワークフロー個別の可否は各行で確認します。"
    : guide.executionGate.status === "ready"
      ? "これは登録inventory全体の集約値です。5ワークフロー全体の実行完了を意味せず、個別の承認・同一Run証跡は各行とRunsで確認します。"
      : guide.executionGate.status === "blocked"
        ? `登録readbackの業務実行ゲートが停止しています。5ワークフロー個別の状態は各行で確認します。${publicBlockerSummary(guide.executionGate.exactBlocker)}`
      : "登録automationのfresh readbackが揃うまで、実行可否を判断しません。";
  const settledRegistrationItems = guide.items.every((item) => item.registrationStatus === "registered" || item.registrationStatus === "not_present");
  const registeredGuideCount = guide.items.filter((item) => item.registrationStatus === "registered").length;
  const missingGuideCount = guide.items.filter((item) => item.registrationStatus === "not_present").length;
  return (
    <Panel title={`${guide.companyLabel} 開始ガイド（5ワークフロー）`} controlId="projects.workflow-start-guide.panel">
      <p className="muted">これはGmail・Daily AI・NisenPrints・Backup・Obsidianの5行を確認する開始ガイド用カタログです。登録インベントリや利用可能性を表すものではありません。登録状態は下のCompany 1登録automation欄とcanonical workflow IDで別に確認します。ここから外部操作は開始しません。</p>
      {settledRegistrationItems && <div className="action-note" role="status"><strong>登録対応の集約</strong><span>このCompany 1 responseとの対応 {registeredGuideCount}/{guide.items.length}件 / 対応entryなし {missingGuideCount}件 / 登録inventory {guide.registeredAutomations.length}件</span><small>登録済みとrunnableは別です。runnable=trueは各行の値で確認し、登録なしはこのCompany 1 responseの範囲だけを示します。</small></div>}
      <div className={`action-note ${guide.executionGate.status === "blocked" ? "warning" : ""}`} role="status" data-control-id="projects.workflow-start-guide.gate">
        <strong>{gateLabel}</strong>
        <span>{gateDetail}</span>
        <small>scope=登録inventory全体 / can_run={String(guide.executionGate.canRun)} / can_preflight={String(guide.executionGate.canPreflight)} / この表示によるexternal_action=false</small>
      </div>
      <details className="workflow-guide-details">
        <summary>5ワークフローの詳細・証跡・次の確認を開く</summary>
        <DataTable
          controlId="projects.workflow-start-guide.table"
          headers={["Workflow", "現在状態 / blocker", "会社接続 / 実行対象 / binding", "承認要件", "次の確認", "証跡 / 外部効果"]}
          rows={guide.items.map((item) => {
            const badge = workflowGuideBadge(item);
            return [
              <div><strong>{item.label}</strong><small>{item.description}</small><details className="workflow-guide-meta"><summary>登録・canonicalの詳細</summary><small>guide canonical: {item.canonicalWorkflowId}</small><small>登録: {item.registrationStatus === "registered" ? `${item.registeredAutomationId ?? "ID未確認"} / ${item.registeredStatus ?? "状態未確認"} / 業務実行=${item.registeredCanRun ? "許可" : "未許可"}（外部効果は承認・同一Run receipt後のみ）` : item.registrationStatus === "not_present" ? "このCompany 1 responseに対応entryなし（全体の不存在は意味しません）" : item.registrationStatus === "loading" ? "Company 1登録responseを取得中" : `Company 1登録responseを取得できません / ${item.registeredExactBlocker ?? "unknown"}`}</small>{item.candidateAutomations.length > 0 && <small>guide候補: {item.candidateAutomations.map((candidate) => `${candidate.id} (${candidate.canonicalWorkflowId ?? "canonical未確認"})`).join(" / ")}</small>}</details></div>,
              <div><StatusBadge status={badge.status} label={badge.label} /><small>blocker: {item.exactBlocker ? publicBlockerSummary(item.exactBlocker) : "unknown（同一Run readback未確認）"}</small></div>,
              <div><small>company: {item.companyEvidence === "company_scope_match" ? "scope一致" : item.companyEvidence === "company_scope_mismatch" ? "scope不一致" : "未確認"}</small><small>会社接続: {item.connectionEvidence === "verified" ? "verified" : item.connectionEvidence === "available_unverified" ? "存在するが未verified" : item.connectionEvidence === "missing" ? "未検出" : item.connectionEvidence === "not_required" ? "不要" : "未確認"}</small><small>実行対象: {workflowExecutionTargetLabel(item)}{item.executionTarget.connectionRefId ? ` / ${item.executionTarget.connectionRefId}` : ""}</small><small>binding: {item.bindingEvidence}</small></div>,
              <span>{item.approvalRequirement}</span>,
              <div>
                <span>{item.nextAction}{item.bindingEvidence === "conflicting" && <small>binding根拠: 候補間で競合</small>}{item.bindingEvidence === "name_or_alias" && <small>binding根拠: 名前/aliasのみ（canonical ID未確認）</small>}</span>
                {item.localCheck.supported && <>
                  <Button
                    controlId={`projects.workflow-start-guide.local-check.${item.id}`}
                    disabled={!localCheckEnabled || !item.localCheck.supported || (item.registrationStatus !== "not_present" && !item.automationId)}
                    onClick={() => onLocalCheck?.(item)}
                  >{item.localCheck.label}</Button>
                  <small>{localCheckReceipts[item.id] ?? (localCheckEnabled ? "取得済み情報だけを確認します（接続・認証・業務完了は未確認）" : "登録readback完了後に利用できます")}</small>
                </>}
                <a data-control-id={`projects.workflow-start-guide.runs.${item.id}`} href={`#/runs?company_id=${encodeURIComponent(guide.companyId ?? "")}`} aria-label={`${item.label}の会社別Runsを開く`}>実行履歴を開く</a>
                <small>この会社の履歴が開きます。対象ワークフローの結果を確認してください</small>
              </div>,
              <div><span>{item.proofLabel}</span><small>{item.externalEffectLabel}</small></div>,
            ];
          })}
        />
      </details>
    </Panel>
  );
}

function AutomationsPage({ model }: { model: AppModel }) {
  const { setReceipt, automationRows, mvpState, setMvpState, setAutomationRows } = model;
  const route = useRoute();
  const routeProject = projectSlugFromRoute(route);
  const activeProject = routeProject || resolveProjectSelection(mvpState);
  const projectName = activeProject ? projectLabelFromState(mvpState, activeProject) : "会社未選択";
  const selectedBackend = mvpState.web_operation_backend?.backend;
  const canMutateCompany = model.mvpLoadStatus === "ready";
  const visibleAutomationRows = automationRows.filter((row) => (row.project_id ?? activeProject) === activeProject);
  const [registeredReadback, setRegisteredReadback] = useState<RegisteredAutomationReadback>({});
  const [registeredReadbackStatus, setRegisteredReadbackStatus] = useState<"loading" | "ready" | "error">("loading");
  const [canonicalRegistry, setCanonicalRegistry] = useState<CanonicalAutomationRegistryReadback>({});
  const [canonicalRegistryStatus, setCanonicalRegistryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [registeredReceipts, setRegisteredReceipts] = useState<Record<string, string>>({});
  const [registeredRunReadbacks, setRegisteredRunReadbacks] = useState<Record<string, { runId: string; status: string; blocker?: string }>>({});
  const [registeredRequestingId, setRegisteredRequestingId] = useState<string | null>(null);
  const [selectedPortableWorkflowId, setSelectedPortableWorkflowId] = useState("");
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [pageNote, setPageNote] = useState("定期実行を開きました。押した操作の結果はここにも表示します。");
  const registeredRequestInFlight = useRef(false);
  const registeredReadbackRequestRef = useRef(0);
  const registeredReadbackAbortRef = useRef<AbortController | null>(null);
  const [registeredReadbackRefreshing, setRegisteredReadbackRefreshing] = useState(false);
  const [registeredSurfaceRefreshing, setRegisteredSurfaceRefreshing] = useState(false);
  const [localCheckReceipts, setLocalCheckReceipts] = useState<Record<string, string>>({});
  const portableItems = (registeredReadback.automations ?? []).filter((item) => item.portable?.supported);
  const selectedPortableItem = portableItems.find((item) => item.id === selectedPortableWorkflowId) ?? portableItems[0];
  const registeredFallbackItems = (mvpState.registered_workflows ?? mvpState.registered_workflow_ids ?? []).map((item) => {
    const id = typeof item === "string" ? item : String(item.id ?? "");
    const name = typeof item === "string"
      ? (REGISTERED_AUTOMATION_LABELS[item] ?? item)
      : String(item.name ?? REGISTERED_AUTOMATION_LABELS[String(item.id ?? "")] ?? item.id ?? "");
    return {
      id,
      name,
      portable: { supported: false },
      can_preflight: false,
      can_run: false,
      exact_blocker: registeredReadback.exact_boundary ?? "registered_automation_readback_unavailable",
      state_fallback: true,
      manual_trigger: {
        // mvp/state is a fresh company-scoped source for the registered id.
        // This fallback exposes only the provider-neutral no-effect trigger;
        // detailed proof/preflight controls remain disabled until the
        // registered-automation readback endpoint is healthy.
        available: true,
        execution_mode: "preflight_no_effect",
        provider_neutral: true,
        external_action_allowed: false,
        exact_blocker: null
      }
    };
  }).filter((item) => item.id);
  const manualTargetItems = portableItems.length ? portableItems : registeredFallbackItems;
  const selectedManualTargetId = selectedPortableWorkflowId || manualTargetItems[0]?.id || "";
  const selectedManualTarget = manualTargetItems.find((item) => item.id === selectedManualTargetId) ?? manualTargetItems[0];
  const selectedManualRunReadback = selectedManualTarget ? registeredRunReadbacks[selectedManualTarget.id] : undefined;
  const registeredAutomationCount = registeredReadback.automation_count ?? registeredReadback.automations?.length ?? 0;
  const registeredSummaryLabel = registeredReadbackStatus === "loading"
    ? "登録状態を確認中"
    : registeredReadbackStatus === "ready"
      ? `${registeredAutomationCount}件のfresh readback済み`
      : "登録状態を確認できません";
  const registeredGateLabel = registeredReadbackStatus === "ready"
      ? (portableItems.some((item) => item.can_preflight === true) ? "read-only確認可能" : "read-only確認は停止中")
      : registeredFallbackItems.length ? "詳細readback未確定 / no-effect手動実行のみ" : "詳細readback未確定";
  const registeredCanRun = (registeredReadback.automations ?? []).some((item: any) => item.can_run === true);
  const registeredCanPreflight = (registeredReadback.automations ?? []).some((item: any) => item.can_preflight === true);
  const registeredGateBlocker = registeredReadback.exact_boundary
    ?? (registeredReadbackStatus === "ready" && !registeredCanRun ? "registered_automation_effect_stage_not_admitted" : null);
  // Identity for the start guide must come from the company-scoped saved
  // records. The runner inventory is a separate six-item capability
  // readback; merging it into the same candidate set can manufacture a
  // false conflict (and can hide the builder's canonicalWorkflowId).
  const guideSavedAutomations = visibleAutomationRows.length
    ? visibleAutomationRows
    : (mvpState.automations ?? mvpState.registered_workflows ?? []);
  const workflowStartGuide = buildWorkflowStartGuide({
    companyId: activeProject,
    companyLabel: projectName,
    auth: {
      verified: canMutateCompany && Boolean(activeProject),
      exactBlocker: canMutateCompany ? null : (model.mvpLoadBlocker ?? "owner_sso_required")
    },
    worker: {
      heartbeatFresh: mvpState.worker?.heartbeat_fresh === true,
      status: mvpState.worker?.status,
      exactBlocker: mvpState.worker?.exact_blocker ?? null
    },
    runtime: {
      status: mvpState.browser_use_runtime?.status,
      exactBlocker: mvpState.browser_use_runtime?.exactBlocker ?? null
    },
    executionGate: {
      status: registeredReadbackStatus,
      canRun: registeredCanRun,
      canPreflight: registeredCanPreflight,
      exactBlocker: registeredGateBlocker
    },
    // The guide's five catalog records and the company-scoped registration
    // inventory are separate sources. Correlation is canonical-ID based.
    automations: [
      ...guideSavedAutomations.map((item) => ({ ...item, _guide_source: "saved" })),
      ...(!guideSavedAutomations.length ? (registeredReadback.automations ?? []).map((item) => ({ ...item, _guide_source: "runner" })) : []),
    ],
    // The runner inventory is intentionally broader than the five-row Guide.
    // Prefer the explicit company-scoped projection when present so missing
    // global runner entries cannot make a saved Company 1 workflow look
    // unregistered.  The aggregate execution gate above still uses the
    // runner inventory and remains fail-closed.
    registeredAutomations: registeredReadback.company_registration_projection
      ?? registeredReadback.automations
      ?? [],
    accountRefs: mvpState.account_refs ?? [],
    registeredReadbackStatus,
    runs: mvpState.workflowStartGuideRuns ?? mvpState.runs ?? []
  });
  // Local-only checks use already-loaded company-scoped state. They are
  // intentionally independent from the aggregate runner can_preflight gate:
  // a missing corresponding runner registration must not prevent a read-only
  // inspection of existing Backup/Obsidian records, but loading/degraded MVP
  // state must still fail closed.
  const localCheckEnabled = registeredReadbackStatus === "ready" && model.mvpLoadStatus === "ready" && Boolean(activeProject);
  const runLocalCheck = (item: WorkflowStartGuideItem) => {
    const name = item.label;
    if (!localCheckEnabled || !item.localCheck.supported || (item.registrationStatus !== "not_present" && !item.automationId)) {
      const message = `ローカル確認未開始 / ${item.localCheck.exactBlocker ?? "registered_readback_pending"} / external_action=false`;
      setLocalCheckReceipts((previous) => ({ ...previous, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
      return;
    }
    // This branch deliberately inspects only already-loaded, company-scoped
    // state. It never queues a Run, touches a provider, or uses Companion.
    const records = Array.isArray(mvpState.runs) ? mvpState.runs : [];
    const proofs = Array.isArray(mvpState.proofs) ? mvpState.proofs : [];
    const matches = (record: any) => {
      const recordCompany = String(record?.company_id ?? record?.companyId ?? record?.project_id ?? record?.projectId ?? "");
      if (recordCompany !== activeProject) return false;
      const automationId = String(record?.automation_id ?? record?.automationId ?? "");
      const workflowId = String(record?.workflow_id ?? record?.workflowId ?? "");
      return automationId === item.automationId || workflowId === item.canonicalWorkflowId;
    };
    const runCount = records.filter(matches).length;
    const proofCount = proofs.filter(matches).length;
    const kind = item.id === "daily-backup-safety-check" ? "snapshot/integrity" : "project/Vault parity";
    const matchingRecords = records.filter(matches);
    const latestRecord = matchingRecords.reduce<any>((latest, candidate) => {
      if (!latest) return candidate;
      const latestTime = String(latest?.updated_at ?? latest?.updatedAt ?? latest?.created_at ?? latest?.createdAt ?? "");
      const candidateTime = String(candidate?.updated_at ?? candidate?.updatedAt ?? candidate?.created_at ?? candidate?.createdAt ?? "");
      if (!latestTime) return candidate;
      if (!candidateTime) return latest;
      return candidateTime > latestTime ? candidate : latest;
    }, null);
    const latestStatus = latestRecord?.status ?? "記録なし";
    const message = `ローカル確認済み / ${kind} metadata=${runCount > 0 ? "あり" : "未確認"} / runs=${runCount} / proofs=${proofCount} / latest=${latestStatus} / Provider接続・認証・queue・外部サイト操作なし / 業務完了=未確認 / external_action=false`;
    setLocalCheckReceipts((previous) => ({ ...previous, [item.id]: message }));
    setReceipt(`${name}: ${message}`);
    setPageNote(`${name}: ${message} / ${actionStamp()}`);
  };
  React.useEffect(() => {
    setSelectedPortableWorkflowId((current) => current && manualTargetItems.some((item) => item.id === current) ? current : (manualTargetItems[0]?.id ?? ""));
  }, [activeProject, registeredReadbackStatus, registeredReadback.automations, mvpState.registered_workflow_ids, mvpState.registered_workflows]);
  const loadCanonicalRegistry = async () => {
    if (!activeProject) {
      setCanonicalRegistryStatus("error");
      setCanonicalRegistry({ ok: false, externalActionExecuted: false });
      return;
    }
    setCanonicalRegistryStatus("loading");
    try {
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/canonical-automation-registry`, { cache: "no-store" });
      const readback = await response.json().catch(() => ({}));
      if (!response.ok || readback.ok === false || readback.status !== "ok") {
        throw new Error(readback.exactBlocker || readback.exact_blocker || `canonical_registry_http_${response.status}`);
      }
      setCanonicalRegistry(readback);
      setCanonicalRegistryStatus("ready");
    } catch {
      setCanonicalRegistry({ ok: false, externalActionExecuted: false });
      setCanonicalRegistryStatus("error");
    }
  };
  const loadRegisteredReadback = async () => {
    const requestId = ++registeredReadbackRequestRef.current;
    registeredReadbackAbortRef.current?.abort();
    setRegisteredReadbackRefreshing(true);
    setRegisteredReadbackStatus("loading");
    // Do not leave a previous can_preflight=true response usable while a new
    // bridge-bound readback is in flight.  Only this request's ready response
    // can re-enable the read-only control.
    setRegisteredReadback({});
    setRegisteredReceipts({});
    setRegisteredRunReadbacks({});
    if (!activeProject) {
      setRegisteredReadbackStatus("error");
      setRegisteredReadbackRefreshing(false);
      setPageNote("会社scopeが未確認のため、登録automationを再確認できません。");
      return;
    }
    const controller = new AbortController();
    registeredReadbackAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 35_000);
    setPageNote(`${projectName} 登録automationのfresh readbackを確認中 / ${actionStamp()}`);
    try {
      // Include the read-only migration ledger so the screen can distinguish
      // "no proof was read" from "historical proof exists but is not a
      // current same-run receipt". The server still keeps can_run=false and
      // never promotes historical evidence to an executable proof.
      const response = await mvpFetch(`/api/mvp/registered-automations?project_id=${encodeURIComponent(activeProject)}&include_ledger=1`, { cache: "no-store", signal: controller.signal });
      const readback = await response.json().catch(() => ({}));
      if (!response.ok || readback.ok === false) throw new Error(readback.exact_boundary || readback.exact_blocker || `registered_automation_readback_http_${response.status}`);
      if (requestId !== registeredReadbackRequestRef.current) return;
      setRegisteredReadback(readback);
      setRegisteredReadbackStatus("ready");
      setReceipt(`Codex App登録自動化 readback 済みです。count=${readback.automation_count ?? 0}`);
      setPageNote(`Codex App登録自動化 readback完了: count=${readback.automation_count ?? 0} / ${actionStamp()}`);
    } catch (error) {
      if (requestId !== registeredReadbackRequestRef.current) return;
      setRegisteredReadbackStatus("error");
      const exact = error instanceof DOMException && error.name === "AbortError"
        ? "registered_automation_readback_timeout"
        : error instanceof Error ? error.message : "registered_automation_readback_unavailable";
      setRegisteredReadback({ ok: false, read_only: true, exact_boundary: exact, automations: [] });
      setReceipt(`Codex App登録自動化 readback 失敗: ${exact}`);
      setPageNote(`Codex App登録自動化 readback失敗: ${exact} / ${actionStamp()}`);
    } finally {
      window.clearTimeout(timeout);
      if (requestId === registeredReadbackRequestRef.current) {
        registeredReadbackAbortRef.current = null;
        setRegisteredReadbackRefreshing(false);
      }
    }
  };
  const refreshRegisteredCompanionSurface = async () => {
    if (!activeProject || !canMutateCompany || registeredSurfaceRefreshing || registeredRequestInFlight.current) return;
    const idempotencyKey = `ui-companion-surface-refresh:${activeProject}:${Date.now()}`;
    const sourceAutomationIds = [
      "automation",
      "daily-ai-research-publish-run",
      "daily-backup-safety-check",
      "nisenprints-daily-product-canva-printify-etsy-pinterest",
      "obsidian"
    ];
    try {
      setRegisteredSurfaceRefreshing(true);
      setPageNote(`${projectName}の登録Workflowを${publicWebOperationBackendLabel(selectedBackend)} surfaceへ同期中 / ${actionStamp()}`);
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/registered-automations/adopt`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ source_automation_ids: sourceAutomationIds, enable_schedules: true })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.exact_blocker || result.error || `registered_companion_surface_refresh_http_${response.status}`);
      const count = Array.isArray(result.adopted) ? result.adopted.length : sourceAutomationIds.length;
      const message = `${publicWebOperationBackendLabel(selectedBackend)} surface同期済み / ${count}件 / スケジュール設定は維持 / external_action=false`;
      setRegisteredReceipts((previous) => ({ ...previous, __surface__: message }));
      setReceipt(message);
      setPageNote(`${message} / ${actionStamp()}`);
      await loadRegisteredReadback();
    } catch (error) {
      const exact = error instanceof Error ? error.message : "registered_companion_surface_refresh_failed";
      const message = `${publicWebOperationBackendLabel(selectedBackend)} surface同期未確認 / ${publicBlockerSummary(exact)} / external_action=false`;
      setRegisteredReceipts((previous) => ({ ...previous, __surface__: message }));
      setReceipt(message);
      setPageNote(`${message} / ${actionStamp()}`);
    } finally {
      setRegisteredSurfaceRefreshing(false);
    }
  };
  React.useEffect(() => {
    setPageNote(`${projectName} 定期実行を開きました。押した操作の結果はここにも表示します / ${actionStamp()}`);
    void loadCanonicalRegistry();
    void loadRegisteredReadback();
    return () => {
      registeredReadbackRequestRef.current += 1;
      registeredReadbackAbortRef.current?.abort();
      registeredReadbackAbortRef.current = null;
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
  const requestPortableRun = async (item: any) => {
    const name = item.name ?? item.id;
    if (!item.portable?.supported) {
      const message = `blocked / portable manifest未登録: ${publicBlockerSummary(item.portable?.exact_blocker ?? "portable_workflow_manifest_missing")}`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      return;
    }
    if (item.can_run !== true) {
      const message = `blocked / AOSキュー登録なし / ${publicBlockerSummary(item.exact_blocker ?? item.blocked_action ?? "registered_automation_not_run_ready")}`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
      return;
    }
    if (registeredRequestInFlight.current) {
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "別のAOS実行が進行中です。完了後に再試行してください。" }));
      return;
    }
    const idempotencyKey = `ui:${item.id}:${Date.now()}`;
    try {
      registeredRequestInFlight.current = true;
      setRegisteredRequestingId(item.id);
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "AOSへキュー登録中..." }));
      const response = await mvpFetch(`/api/portable-workflows/${encodeURIComponent(item.id)}/run?project_id=${encodeURIComponent(activeProject)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ project_id: activeProject, idempotency_key: idempotencyKey })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exact_blocker || result.error || `portable_workflow_http_${response.status}`);
      const portable = result.portable ?? {};
      const message = `AOS ${result.replayed ? "replay" : "queued"} / run=${result.runId ?? "?"} / mode=${portable.execution_mode ?? item.portable.execution_mode ?? "canary"} / worker=${result.workerProtocol ?? "mac_worker_polling_required"} / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "portable_workflow_request_failed";
      const message = `blocked / AOSキュー登録なし / ${publicBlockerSummary(exact)}`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } finally {
      registeredRequestInFlight.current = false;
      setRegisteredRequestingId(null);
    }
  };
  const requestManualTrigger = async (item: any) => {
    const name = item.name ?? item.id;
    if ((registeredReadbackStatus !== "ready" && item.state_fallback !== true) || item.manual_trigger?.available !== true) {
      const message = `blocked / 手動実行登録なし / ${publicBlockerSummary(item.manual_trigger?.exact_blocker ?? "registered_manual_trigger_not_available")} / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
      return;
    }
    if (registeredRequestInFlight.current) {
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "別のAOS手動実行登録が進行中です。完了後に再試行してください。" }));
      return;
    }
    const idempotencyKey = `ui-manual:${activeProject}:${item.id}:${Date.now()}`;
    try {
      registeredRequestInFlight.current = true;
      setRegisteredRequestingId(item.id);
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "AOSへ手動実行を登録中..." }));
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/automations/${encodeURIComponent(item.id)}/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          project_id: activeProject,
          provider_neutral: true,
          execution_mode: "preflight_no_effect",
          external_action_allowed: false
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exact_blocker || result.error || `manual_trigger_http_${response.status}`);
      const run = result.run ?? {};
      const runId = String(run.id ?? result.runId ?? "").trim();
      let sameRunStatus = String(run.status ?? "queued");
      let sameRunBlocker = "";
      let sameRunReadbackLabel = "same-run readback=PENDING_CONFIRMATION";
      if (runId) {
        try {
          const detail = await fetchApiJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
          sameRunStatus = String(detail.run?.status ?? sameRunStatus);
          sameRunBlocker = String(detail.run?.exact_blocker ?? detail.run?.blocker ?? "").trim();
          sameRunReadbackLabel = `same-run status=${sameRunStatus}${sameRunBlocker ? ` / blocker=${publicBlockerSummary(sameRunBlocker)}` : ""}`;
        } catch {
          sameRunReadbackLabel = "same-run readback=PENDING_CONFIRMATION";
        }
        setRegisteredRunReadbacks((previous) => ({
          ...previous,
          [item.id]: { runId, status: sameRunStatus, ...(sameRunBlocker ? { blocker: sameRunBlocker } : {}) }
        }));
      }
      const message = `手動実行を登録 / run=${runId || "?"} / status=${run.status ?? "queued"} / ${sameRunReadbackLabel} / mode=preflight_no_effect / provider_neutral=true / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "manual_trigger_failed";
      const message = `blocked / 手動実行登録なし / ${publicBlockerSummary(exact)} / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } finally {
      registeredRequestInFlight.current = false;
      setRegisteredRequestingId(null);
    }
  };
  const requestPortablePreflight = async (item: any) => {
    const name = item.name ?? item.id;
    if (registeredReadbackStatus !== "ready" || !item.portable?.supported || item.can_preflight !== true) {
      const message = `blocked / read-only preflight未接続 / ${publicBlockerSummary(item.preflight_exact_blocker ?? item.portable?.exact_blocker ?? "portable_read_only_route_not_configured")}`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
      return;
    }
    if (registeredRequestInFlight.current) {
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "別のread-only確認が進行中です。完了後に再試行してください。" }));
      return;
    }
    const idempotencyKey = `ui-preflight:${item.id}:${Date.now()}`;
    try {
      registeredRequestInFlight.current = true;
      setRegisteredRequestingId(item.id);
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: "read-only preflightをAOSへキュー登録中..." }));
      const response = await mvpFetch(`/api/portable-workflows/${encodeURIComponent(item.id)}/run?project_id=${encodeURIComponent(activeProject)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ project_id: activeProject, idempotency_key: idempotencyKey, read_only_stage: "reference_readback" })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exact_blocker || result.error || `portable_read_only_preflight_http_${response.status}`);
      const portable = result.portable ?? {};
      const message = `read-only preflight ${result.replayed ? "replay" : "queued"} / run=${result.runId ?? "?"} / stage=reference_readback / mode=${portable.execution_mode ?? item.portable.execution_mode ?? "canary"} / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "portable_read_only_preflight_failed";
      const message = `blocked / read-only preflight未開始 / ${publicBlockerSummary(exact)} / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } finally {
      registeredRequestInFlight.current = false;
      setRegisteredRequestingId(null);
    }
  };
  const toggleRegisteredSchedule = async (item: any) => {
    const paused = item.status === "paused";
    const name = item.name ?? item.id;
    try {
      const response = await mvpFetch(`/api/registered-workflows/${encodeURIComponent(item.id)}/${paused ? "resume" : "pause"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: activeProject })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.exact_blocker || result.error || `registered_schedule_toggle_http_${response.status}`);
      const nextStatus = result.workflow?.status ?? (paused ? "active" : "paused");
      setRegisteredReadback((previous) => ({
        ...previous,
        automations: (previous.automations ?? []).map((current) => current.id === item.id ? { ...current, status: nextStatus } : current)
      }));
      const message = `定期実行を${nextStatus === "paused" ? "停止" : "再開"} / UI→AOS scheduler / external_action=false`;
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: message }));
      setReceipt(`${name}: ${message}`);
      setPageNote(`${name}: ${message} / ${actionStamp()}`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "registered_schedule_toggle_failed";
      setRegisteredReceipts((prev) => ({ ...prev, [item.id]: `blocked / 定期実行変更なし / ${publicBlockerSummary(exact)}` }));
    }
  };
  const registeredGateSummary = (item: any) => {
    const preflight = item.can_preflight === true
      ? "read-only preflight=admitted"
      : `read-only preflight=blocked / ${publicBlockerSummary(item.preflight_exact_blocker ?? item.exact_blocker ?? item.blocked_action)}`;
    const manual = item.manual_trigger?.available === true
      ? "manual no-effect=available"
      : `manual no-effect=blocked / ${publicBlockerSummary(item.manual_trigger?.exact_blocker ?? "registered_manual_trigger_not_available")}`;
    const effectful = item.can_run === true
      ? "effectful gate=admitted"
      : `effectful gate=blocked / ${publicBlockerSummary(item.exact_blocker ?? item.blocked_action ?? "registered_effect_not_admitted")}`;
    return `${preflight} / ${manual} / ${effectful}`;
  };
  const describeRegistered = (item: any) => {
    const currentProof = item.latest_proof?.same_run_receipt === true;
    const proof = currentProof ? ` / proof=${item.latest_proof.status ?? "available"} ${item.latest_proof.checked_at ?? ""}` : item.latest_proof ? " / proof=historical_not_current" : " / proof=missing";
    const action = item.preflight_status ?? item.ui_action ?? "read-only";
    const status = item.can_run ? "runnable" : item.can_preflight === true ? "read-only preflight ready" : "blocked";
    const gate = registeredGateSummary(item);
    const next = item.can_run || item.can_preflight ? "次: read-only preflightを実行" : "次: 確認事項を解消してproofを確認";
    const message = `${status} / read-only=true / ${action} / ${gate}${proof} / external_action=false / ${next}`;
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
      const state = await readMvpState("ui", { fresh: true });
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
      <PageTitle title={projectName} desc="仕事と定期実行">
        <Button controlId="projects.job-admission.open" disabled={!activeProject || !canMutateCompany} onClick={() => go(`#/projects/${activeProject}/job-admission`)}>応募登録</Button>
        <Button controlId="projects.new" icon={<Plus size={15} />} variant="primary" disabled={!canMutateCompany} onClick={() => { setPageNote(`新規追加: チャットへ移動します / ${actionStamp()}`); go(chatHref({ companyId: activeProject, context: "project-automations" })); }}>新規追加</Button>
      </PageTitle>
      <div className="action-note" role="status">{pageNote}</div>
      {!canMutateCompany && <div className="action-note warning" role="status">この画面は直近のsummaryを先に表示しています。最新の詳細readbackが完了するまで、保存・定期実行変更・応募登録は停止しています。</div>}
      {!activeProject && <div className="action-note warning" role="status">会社を選択してから応募登録・自動化の作成を行ってください。会社IDが未確認の状態では保存や実行に進みません。</div>}
      <ProjectScopeNotice projectId={activeProject} mvpState={mvpState} />
      {activeProject && <Panel title="Canonical自動化レジストリ（正本7件）" controlId="projects.canonical-registry.panel">
        <div className="action-note" role="status">
          <strong>{canonicalRegistryStatus === "ready" ? `${canonicalRegistry.items?.length ?? 0}件 / Company scope=${canonicalRegistry.companyId ?? activeProject}` : canonicalRegistryStatus === "loading" ? "正本レジストリを確認中" : "正本レジストリを確認できません"}</strong>
          <span>protected Postgres catalog 6件＋Company Brief heartbeat 1件。実行adapter inventoryや開始ガイドとは別の正本です。</span>
          <small>promoted_to_runtime_registry={String(canonicalRegistry.promotedToRuntimeRegistry ?? false)} / external_action_executed={String(canonicalRegistry.externalActionExecuted ?? false)}</small>
          <div className="button-row compact"><Button controlId="projects.canonical-registry.refresh" onClick={() => { void loadCanonicalRegistry(); }} disabled={canonicalRegistryStatus === "loading" || !activeProject} icon={<RefreshCw size={14} />}>正本を再確認</Button></div>
        </div>
        <DataTable
          controlId="projects.canonical-registry.table"
          headers={["Canonical ID", "名前", "正本plane", "schedule", "入口", "外部効果"]}
          rows={canonicalRegistryStatus === "ready" && (canonicalRegistry.items ?? []).length
            ? (canonicalRegistry.items ?? []).map((item) => [
              item.id,
              item.name,
              item.plane === "heartbeat" ? "Company Brief heartbeat" : "catalog",
              `${item.schedule?.expression ?? "未確認"} ${item.schedule?.timezone ?? ""}`,
              `${item.entry?.workerCommandKind ?? "未確認"} / source=${item.entry?.sourceAutomationId ?? "heartbeat"}`,
              `default=${String(item.effect?.externalActionDefault ?? false)} / executed=${String(item.effect?.executedInThisReadback ?? false)}`
            ])
            : [[canonicalRegistryStatus === "loading" ? "正本readbackを取得中" : "正本readback未確認", "-", "-", "-", "-", "external_action=false"]]}
        />
        {canonicalRegistryStatus === "ready" && <p className="muted">補助adapter: {(canonicalRegistry.executionLaneAdapters ?? []).join(" / ") || "未確認"}。adapterの存在はcanonical登録・業務完了・Provider receiptを意味しません。</p>}
      </Panel>}
      {activeProject && <WorkflowStartGuidePanel
        guide={workflowStartGuide}
        localCheckEnabled={localCheckEnabled}
        localCheckReceipts={localCheckReceipts}
        onLocalCheck={runLocalCheck}
      />}
      {activeProject && <Panel title="求人応募（専用画面）" controlId="projects.job-admission.panel">
        <p className="muted">応募対象の登録、同一Runへの束縛、承認、既存応募の照合は、通常の定期実行とは異なる高影響フローです。専用画面で対象と次の操作を確認します。</p>
        <div className="button-row"><Button controlId="projects.job-admission.open-panel" variant="primary" disabled={!canMutateCompany} onClick={() => go(`#/projects/${activeProject}/job-admission`)}>応募登録を開く</Button></div>
      </Panel>}
      {activeProject && <div className="quick-action-row" data-control-id="projects.registered.quick-run.panel">
        <div>
          <strong>定期実行を待たずに実行</strong>
          <span>対象を1つ選び、read-only確認またはAOSへの手動実行登録を行います。</span>
        </div>
        {manualTargetItems.length > 0 ? <div className="quick-action-controls">
          <label className="quick-action-select">対象
            <select
              aria-label="手動実行する自動化"
              data-control-id="projects.registered.quick-run.select"
              value={selectedManualTarget?.id ?? ""}
              onChange={(event) => setSelectedPortableWorkflowId(event.target.value)}
            >
              {manualTargetItems.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}
            </select>
          </label>
          <div className="button-row compact">
            <Button
              controlId={selectedManualTarget ? `projects.registered.quick-run.${selectedManualTarget.id}` : "projects.registered.quick-run.read-only"}
              ariaLabel={`${selectedManualTarget?.name ?? "選択した自動化"}: read-only確認`}
              onClick={() => { if (selectedManualTarget) void requestPortablePreflight(selectedManualTarget); }}
              disabled={Boolean(registeredRequestingId) || selectedManualTarget?.can_preflight !== true}
              icon={registeredRequestingId === selectedManualTarget?.id ? <Clock size={14} /> : <Play size={14} />}
            >read-only確認</Button>
            <Button
              controlId={selectedManualTarget ? `projects.registered.quick-run.manual.${selectedManualTarget.id}` : "projects.registered.quick-run.manual"}
              ariaLabel={`${selectedManualTarget?.name ?? "選択した自動化"}: 手動実行`}
              variant="primary"
              onClick={() => { if (selectedManualTarget) void requestManualTrigger(selectedManualTarget); }}
              disabled={Boolean(registeredRequestingId) || (registeredReadbackStatus !== "ready" && selectedManualTarget?.state_fallback !== true) || selectedManualTarget?.manual_trigger?.available !== true}
              icon={registeredRequestingId === selectedManualTarget?.id ? <Clock size={14} /> : <Play size={14} />}
            >手動実行</Button>
          </div>
          {selectedManualTarget && <small className="quick-action-gate">{selectedManualTarget.manual_trigger?.available === true
            ? selectedManualTarget.state_fallback === true
              ? "詳細readback未確定ですが、会社scopeで対象IDを確認済みです。no-effect手動実行だけ登録できます（外部操作は開始しません）"
              : "AOSのno-effect手動実行を登録します（外部操作は開始しません）"
            : `手動実行は停止中: ${publicBlockerSummary(selectedManualTarget.manual_trigger?.exact_blocker ?? "実行条件未確認")}`}</small>}
          {selectedManualRunReadback && <a
            data-control-id="projects.registered.quick-run.same-run-readback"
            href={`#/projects/${encodeURIComponent(activeProject)}/runs/${encodeURIComponent(selectedManualRunReadback.runId)}`}
          >同一Runを確認: status={selectedManualRunReadback.status}</a>}
        </div> : <div className="quick-action-empty" role="status">
          <strong>{registeredReadbackStatus === "loading" ? "実行対象を確認中" : "手動実行できる対象はありません"}</strong>
          <span>{registeredReadbackStatus === "loading" ? "登録済みautomationのfresh readbackを取得します。" : publicBlockerSummary(registeredReadback.exact_boundary ?? "registered_portable_workflow_not_available")}</span>
        </div>}
      </div>}
      <ProjectPresentationProfileSummary model={model} companyId={activeProject} context="automations" />
      {activeProject && (
        <details className="home-secondary-details project-guide-details" data-control-id="projects.guide.panel">
          <summary>{projectName} 操作ガイドと安全ルールを開く</summary>
          <div className="home-secondary-details-body">
          <div className="status-grid">
            <div><strong>実行ボタン</strong><span>read-only preflightを行い、外部投稿・応募・削除は実行しません。</span></div>
            <div><strong>結果表示</strong><span>押下後はこのページ上部、行内receipt、上部バーに exact blocker / proof / external_action を表示します。</span></div>
            <div><strong>次に必要なこと</strong><span>ログイン、CDP lane、sandbox/test承認、OTP/本人確認などが必要な時は人間対応として表示します。</span></div>
            <div><strong>安全境界</strong><span>UI操作は external_action=false を期待境界にし、readbackで true が出た場合はblockerとして扱います。</span></div>
          </div>
          </div>
        </details>
      )}
      <Panel title="仕事一覧" controlId="projects.automation.panel">
        <details className="home-secondary-details" data-control-id="projects.automation.details">
          <summary>保存済みの仕事の詳細一覧を開く（{visibleAutomationRows.length}件）</summary>
          <div className="home-secondary-details-body">
            <DataTable controlId="projects.automation.table" headers={["タスク名", "説明", "スケジュール", "実行契約", "Lane", "最終実行", "ステータス", "操作"]} rows={visibleAutomationRows.length ? visibleAutomationRows.map((a) => [a.name, a.desc, <div data-control-id={`projects.automation.schedule.${a.id}`}><strong>{a.schedule}</strong><small>next {a.next_run_at} / version {a.schedule_version}</small></div>, <div data-control-id={`projects.automation.execution.${a.id}`}><strong>{a.execution_label}</strong><small>{a.scheduler_effect}</small></div>, displayedAutomationLane(a.lane, selectedBackend), a.last, <StatusBadge status={a.status} />, <div className="row-actions"><IconButton controlId={`projects.automation.edit.${a.id}`} label={`${a.name}を編集`} onClick={() => { setPageNote(`${a.name}: 編集画面へ移動します / ${actionStamp()}`); go(`#/projects/${activeProject}/automations/${a.id}/edit`); }}><Edit3 size={14} /></IconButton><IconButton controlId={`projects.automation.archive.${a.id}`} label={`${a.name}をアーカイブ`} disabled={Boolean(archivingId) || !canMutateCompany} onClick={() => archiveAutomation(a)}>{archivingId === a.id ? <Clock size={14} /> : <Archive size={14} />}</IconButton></div>]) : [["このプロジェクトの自動化はまだありません", "チャットから追加できます", "-", "実行契約未確認", "-", "-", <StatusBadge status="draft" />, <Button controlId="projects.automation.create" disabled={!canMutateCompany} onClick={() => { setPageNote(`作成する: チャットへ移動します / ${actionStamp()}`); go(chatHref({ companyId: activeProject, context: "project-automations" })); }}>作成する</Button>]]} />
          </div>
        </details>
      </Panel>
      {activeProject && (
          <Panel title="登録済みの仕事（実行adapter inventory）" controlId="projects.registered.panel">
          <div className="action-note" role="status">
            <strong>{registeredSummaryLabel}</strong>
            <span>{registeredGateLabel}</span>
            <small>これは固定実行adapterのreadbackです。canonical正本7件とは別集合で、外部作用はこの画面から開始しません。</small>
            {registeredReadbackStatus === "error" && <small>確認事項: {publicBlockerSummary(registeredReadback.exact_boundary ?? "registered_automation_readback_unavailable")}。正規Bridgeのfresh readback後にread-only可否を再判定します。</small>}
            <div className="button-row compact">
              <Button controlId="projects.registered.refresh" onClick={() => { void loadRegisteredReadback(); }} disabled={registeredReadbackRefreshing || !activeProject} icon={<RefreshCw size={14} />}>{registeredReadbackRefreshing ? "再確認中" : "登録状態を再確認"}</Button>
              <Button controlId="projects.registered.companion-surface-refresh" onClick={() => { void refreshRegisteredCompanionSurface(); }} disabled={registeredSurfaceRefreshing || registeredReadbackRefreshing || !activeProject || !canMutateCompany} icon={<RefreshCw size={14} />}>{registeredSurfaceRefreshing ? "同期中" : `${publicWebOperationBackendLabel(selectedBackend)}経路へ同期`}</Button>
            </div>
          </div>
          <details className="home-secondary-details" data-control-id="projects.registered.details">
            <summary>登録Automationの詳細・proof・laneを開く</summary>
            <div className="home-secondary-details-body">
              <p className="muted">{projectName}の固定実行adapterをAPIのfresh responseに含まれる件数・名前・状態で表示します。canonical正本7件と開始ガイド5行は別集合です。現在のAOS選択backend={publicWebOperationBackendLabel(selectedBackend)}です。Codex AppはUI/トリガー、AOSがスケジュールとRunの正本、登録workflowの次回runは選択backendへ束縛されます。旧lane名は互換診断として保持し、選択backendへの実行bindingはRun開始時に確認します。外部作用の完了はworker receipt/readbackでのみ確認します。</p>
              <DataTable
                controlId="projects.registered.table"
                headers={["名前", "状態", `${publicWebOperationBackendLabel(selectedBackend)} workflow lane`, "実行クラス", "判定", "Blocker / Proof", "操作"]}
                rows={registeredReadbackStatus === "loading"
              ? [["Codex App登録自動化のreadbackを取得中", "loading", "-", "-", "-", "APIのfresh source-of-truthを待機中", <StatusBadge status="waiting" label="readback取得中" />]]
              : registeredReadbackStatus === "error"
              ? [["Company 1登録automationのreadbackを取得できません", registeredReadback.exact_boundary ?? "unavailable", "-", "-", "-", publicBlockerSummary(registeredReadback.exact_boundary ?? "registered_automation_readback_unavailable"), <StatusBadge status="blocked" label="readback error" />]]
              : (registeredReadback.automations ?? []).length ? (registeredReadback.automations ?? []).map((item) => [
              item.name ?? item.id,
              item.status ?? "-",
              item.browser_use_lane ? <div><strong>{item.browser_use_lane.profileRef ?? item.browser_use_lane.profileName ?? "-"}</strong><small>予約port {item.browser_use_lane.reservedPort ?? "-"} / {item.browser_use_lane.lifecycle ?? "-"} / live={publicBrowserUseLaneReadbackStatus(item.browser_use_lane)}</small></div> : "未束縛",
              item.execution_class ?? "-",
              <StatusBadge status={item.can_run ? "enabled" : item.latest_proof?.same_run_receipt === true ? "approved" : "blocked"} label={item.action_label ?? item.ui_action ?? "read-only"} />,
              item.latest_proof?.same_run_receipt === true
                ? `${item.latest_proof.status ?? "proof"} / 保存済み記録あり`
                : `${registeredGateSummary(item)}${item.latest_proof ? " / proof=historical_not_current" : ""}`,
              <div className="row-actions">
                {item.manual_trigger?.available === true && <button
                  type="button"
                  data-control-id={`projects.registered.manual-run.${item.id}`}
                  className="icon-btn"
                  aria-label={`${item.name ?? item.id}: 手動実行`}
                  title={`${item.name ?? item.id}: no-effect手動実行`}
                  onClick={() => requestManualTrigger(item)}
                  disabled={Boolean(registeredRequestingId) || registeredReadbackStatus !== "ready"}
                >
                  {registeredRequestingId === item.id ? <Clock size={14} /> : <Play size={14} />}
                </button>}
                {item.portable?.supported && <button
                  type="button"
                  data-control-id={`projects.registered.portable-run.${item.id}`}
                  className="icon-btn"
                  aria-label={`行内read-only preflight: ${item.name ?? item.id}`}
                  title={`行内read-only preflight: ${item.name ?? item.id}`}
                  onClick={() => requestPortablePreflight(item)}
                  disabled={Boolean(registeredRequestingId) || registeredReadbackStatus !== "ready" || item.can_preflight !== true}
                >
                  {registeredRequestingId === item.id ? <Clock size={14} /> : <Play size={14} />}
                </button>}
                {item.portable?.supported && <button
                  type="button"
                  data-control-id={`projects.registered.schedule-toggle.${item.id}`}
                  className="icon-btn"
                  aria-label={`${item.name ?? item.id}: 定期実行を${item.status === "paused" ? "再開" : "停止"}`}
                  title={`${item.name ?? item.id}: 定期実行を${item.status === "paused" ? "再開" : "停止"}`}
                  onClick={() => toggleRegisteredSchedule(item)}
                  disabled={Boolean(registeredRequestingId) || !canMutateCompany}
                >
                  <Clock size={14} />
                </button>}
                <button
                  type="button"
                  data-control-id={`projects.registered.open.${item.id}`}
                  className="icon-btn"
                  aria-label={`${item.name ?? item.id}: ${item.action_label ?? item.ui_action ?? "確認"}`}
                  title={`${item.name ?? item.id}: ${item.action_label ?? item.ui_action ?? "確認"}`}
                  onClick={() => requestRegisteredRun(item)}
                  disabled={Boolean(registeredRequestingId)}
                >
                  {registeredRequestingId === item.id ? <Clock size={14} /> : item.can_run ? <Play size={14} /> : <ShieldCheck size={14} />}
                </button>
                <IconButton controlId={`projects.registered.issue.${item.id}`} label={`${item.name ?? item.id}: 問題を送る`} onClick={() => openFeedbackFor(`${item.name ?? item.id}: `, {
                  source: "registered_automation",
                  automation_id: item.id,
                  automation_name: item.name ?? item.id,
                  project_id: activeProject,
                  preflight_status: item.preflight_status ?? item.ui_action ?? item.action_label ?? "read-only",
                  exact_blocker: item.exact_blocker ?? item.blocked_action ?? "",
                  route: location.hash || `#/projects/${activeProject}/automations`
                })}><AlertTriangle size={14} /></IconButton>
                <IconButton controlId={`projects.registered.detail.${item.id}`} label={`${item.name ?? item.id}: 詳細`} onClick={() => describeRegistered(item)}><MoreHorizontal size={14} /></IconButton>
                {registeredReceipts[item.id] && <small className="inline-action-receipt">{registeredReceipts[item.id]}</small>}
              </div>
            ]) : [["Codex App登録自動化のreadbackがありません", registeredReadback.exact_boundary ?? "unavailable", "-", "-", "-", "-", <StatusBadge status="waiting" label="read-only" />]]}
                />
            </div>
          </details>
          <div className="receipt-strip">company-scoped readback / status={registeredReadbackStatus} / count={registeredReadback.automation_count ?? registeredReadback.automations?.length ?? 0} / external_action=false</div>
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
  const builderTypeSupported = isSupportedAutomationType(builderType);
  const registeredConfig = registeredWorkflowBuilderConfig(persistedAutomation, persistedSpec?.spec);
  const registeredWorkflow = registeredConfig !== null;
  const builderEditable = builderTypeSupported || registeredWorkflow;
  const builderConfig = registeredConfig ?? builderConfigForAutomationType(builderType);
  const builderKind = builderConfig.kindLabel;
  const builderTitle = `${builderKind} 自動化仕様`;
  const automationName = persistedAutomation?.name ?? builderConfig.automationName;
  const canonicalWorkflowId = String(persistedSpec?.spec?.canonicalWorkflowId ?? persistedSpec?.spec?.canonical_workflow_id ?? "");
  const isGmailExecutionWorkflow = canonicalWorkflowId === "email-review-reply";
  const persistedExecutionTarget = persistedAutomation?.execution_target && typeof persistedAutomation.execution_target === "object"
    ? persistedAutomation.execution_target
    : persistedSpec?.spec?.execution_target && typeof persistedSpec.spec.execution_target === "object"
      ? persistedSpec.spec.execution_target as Record<string, unknown>
      : null;
  const executionMode = String(persistedAutomation?.execution_mode ?? "unverified");
  const executionLabel = String(persistedAutomation?.execution_label ?? "実行契約未確認（保存のみ）");
  const schedulerEffect = String(persistedAutomation?.scheduler_effect ?? "not_configured");
  const persistedStepRecords: Array<{ [key: string]: unknown; title: string; enabled: boolean }> = registeredWorkflow
    ? registeredWorkflowSteps(persistedSpec?.spec)
    : Array.isArray(persistedSpec?.spec?.steps)
    ? persistedSpec.spec.steps
      .map((step: any) => ({ ...(typeof step === "object" && step ? step : {}), title: typeof step === "string" ? step : step?.title, enabled: typeof step === "string" ? true : step?.enabled !== false }))
      .filter((step: { title?: unknown }): step is { title: string; enabled: boolean } => typeof step.title === "string" && Boolean(step.title.trim()))
    : [];
  const [builderDraft, setBuilderDraft] = useState({
    name: automationName,
    goal: String(persistedAutomation?.goal ?? ""),
    target_label: String(persistedSpec?.spec?.target_label ?? ""),
    steps: persistedStepRecords.length ? persistedStepRecords : builderConfig.steps.map((title) => ({ title, enabled: true })),
    lane: persistedAutomation?.lane ?? "未設定",
    schedule: persistedSpec?.spec?.schedule_hint ?? "",
    approval_policy: persistedAutomation?.approval_policy ?? builderConfig.approvalPolicy,
    retry_rule: persistedSpec?.spec?.retry_rule ?? ""
  });
  const [saving, setSaving] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [gmailConnectionRefs, setGmailConnectionRefs] = useState<any[]>([]);
  const [gmailConnectionRefsStatus, setGmailConnectionRefsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gmailTargetDraft, setGmailTargetDraft] = useState({ connectionRefId: "", accountRef: "" });
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>({
    kind: normalizeScheduleKind(persistedSchedule?.kind),
    expression: String(persistedSchedule?.expression ?? ""),
    timezone: String(persistedSchedule?.timezone ?? "Asia/Tokyo"),
    enabled: persistedSchedule ? persistedSchedule.enabled === true : false
  });
  const builderCreateIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [builderNotice, setBuilderNotice] = useState("外部投稿・送信・公開はまだ実行していません。");
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
      goal: String(persistedAutomation?.goal ?? ""),
      target_label: String(persistedSpec?.spec?.target_label ?? ""),
      steps: persistedStepRecords.length ? persistedStepRecords : builderConfig.steps.map((title) => ({ title, enabled: true })),
      lane: persistedAutomation?.lane ?? "未設定",
      schedule: persistedSpec?.spec?.schedule_hint ?? "",
      approval_policy: persistedAutomation?.approval_policy ?? builderConfig.approvalPolicy,
      retry_rule: persistedSpec?.spec?.retry_rule ?? ""
    });
  }, [automationId, persistedAutomation?.updated_at, persistedSpec?.updated_at, automationName, builderConfig.approvalPolicy]);
  React.useEffect(() => {
    const connectionRefId = typeof persistedExecutionTarget?.connection_ref_id === "string"
      ? persistedExecutionTarget.connection_ref_id.trim()
      : typeof persistedExecutionTarget?.connectionRefId === "string"
        ? persistedExecutionTarget.connectionRefId.trim()
        : "";
    const accountRef = typeof persistedExecutionTarget?.account_ref === "string"
      ? persistedExecutionTarget.account_ref.trim()
      : typeof persistedExecutionTarget?.accountRef === "string"
        ? persistedExecutionTarget.accountRef.trim()
        : "";
    setGmailTargetDraft({ connectionRefId, accountRef });
  }, [automationId, persistedAutomation?.revision, persistedSpec?.updated_at, persistedExecutionTarget?.connection_ref_id, persistedExecutionTarget?.connectionRefId, persistedExecutionTarget?.account_ref, persistedExecutionTarget?.accountRef]);
  React.useEffect(() => {
    let active = true;
    if (!isGmailExecutionWorkflow || !activeProject) {
      setGmailConnectionRefs([]);
      setGmailConnectionRefsStatus("idle");
      return () => { active = false; };
    }
    setGmailConnectionRefsStatus("loading");
    void mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/connection-account-refs`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true || body.company_scope?.company_id !== activeProject || !Array.isArray(body.refs)) {
          throw new Error(body.exact_blocker || body.error || "gmail_execution_target_inventory_read_failed");
        }
        if (!active) return;
        setGmailConnectionRefs(body.refs.filter((ref: any) => ["gmail", "mail"].includes(String(ref.platform ?? "").toLowerCase())));
        setGmailConnectionRefsStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setGmailConnectionRefs([]);
        setGmailConnectionRefsStatus("error");
      });
    return () => { active = false; };
  }, [activeProject, isGmailExecutionWorkflow]);
  React.useEffect(() => {
    setScheduleDraft({
      kind: normalizeScheduleKind(persistedSchedule?.kind),
      expression: String(persistedSchedule?.expression ?? ""),
      timezone: String(persistedSchedule?.timezone ?? "Asia/Tokyo"),
      enabled: persistedSchedule ? persistedSchedule.enabled === true : false
    });
  }, [automationId, persistedSchedule?.revision, persistedSchedule?.kind, persistedSchedule?.expression, persistedSchedule?.timezone, persistedSchedule?.enabled]);
  const saveBuilder = async () => {
    if (!builderEditable) {
      noteBuilder(`未認識のautomation_type=${builderType}です。SNSとして置き換えず、正本の型を確認するまで保存しません。`);
      return;
    }
    if (saving) return;
    if (!builderDraft.name.trim() || !builderDraft.goal.trim() || (!registeredWorkflow && (!builderDraft.steps.length || builderDraft.steps.some((step) => !step.title.trim())))) {
      noteBuilder("自動化名・依頼内容・空欄のない手順を入力してください。まだ保存していません。");
      return;
    }
    setSaving(true);
    try {
      if (registeredWorkflow) {
        const registeredSpec = { ...(persistedSpec?.spec ?? {}) } as Record<string, unknown>;
        if (isGmailExecutionWorkflow && gmailConnectionRefsStatus === "ready") {
          if (gmailTargetDraft.connectionRefId) {
            registeredSpec.execution_target = { connection_ref_id: gmailTargetDraft.connectionRefId, account_ref: gmailTargetDraft.accountRef };
          } else if (gmailTargetDraft.accountRef) {
            registeredSpec.execution_target = { account_ref: gmailTargetDraft.accountRef };
          } else {
            delete registeredSpec.execution_target;
          }
        }
        const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(activeProject)}/automations/${encodeURIComponent(automationId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_revision: persistedAutomation.revision, name: builderDraft.name.trim(), goal: builderDraft.goal.trim(), ...(isGmailExecutionWorkflow && gmailConnectionRefsStatus === "ready" ? { builder_spec: registeredSpec } : {}) })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.exactBlocker || result.exact_blocker || result.error || "registered_metadata_save_failed");
        const freshState = await readMvpState("ui", { fresh: true });
        const saved = (freshState.automations ?? []).find((item: any) => item.id === automationId && (item.company_id ?? item.project_id) === activeProject);
        setMvpState(freshState);
        setAutomationRows(toAutomationRows(freshState.automations ?? []));
        if (!saved || saved.name !== builderDraft.name.trim() || saved.goal !== builderDraft.goal.trim()) throw new Error("registered_metadata_readback_mismatch");
        noteBuilder("登録業務の名前・目的を保存し、再取得して確認しました。処理契約・接続先・承認ポリシー・実予定は変更していません。");
        return;
      }
      const specPayload: Record<string, unknown> = {
        ...(persistedSpec?.spec ?? {}),
        automation_type: automationSlugForKind(builderType),
        steps: builderDraft.steps.map((step) => ({ ...step, title: step.title.trim() })),
        target_label: builderDraft.target_label,
        schedule_hint: builderDraft.schedule,
        retry_rule: builderDraft.retry_rule,
        approval_policy: builderDraft.approval_policy,
        external_action_allowed: false
      };
      if (isGmailExecutionWorkflow && gmailConnectionRefsStatus === "ready") {
        if (gmailTargetDraft.connectionRefId) {
          specPayload.execution_target = { connection_ref_id: gmailTargetDraft.connectionRefId, account_ref: gmailTargetDraft.accountRef };
        } else if (gmailTargetDraft.accountRef) {
          specPayload.execution_target = { account_ref: gmailTargetDraft.accountRef };
        } else {
          delete specPayload.execution_target;
        }
      }
      const readError = async (response: Response, fallback: string) => {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.exact_blocker || body.exactBlocker || body.error || fallback);
      };
      if (!persistedAutomation) {
        const createFingerprint = [
          activeProject,
          automationId,
          builderDraft.name,
          builderDraft.goal,
          builderDraft.target_label,
          JSON.stringify(builderDraft.steps),
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
            goal: builderDraft.goal,
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
          goal: builderDraft.goal,
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
    if (!builderEditable) {
      noteBuilder(`未認識のautomation_type=${builderType}です。定期実行の更新は未確認のまま保存しません。`);
      return;
    }
    if (scheduleSaving) return;
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
      const freshState = await readMvpState("ui", { fresh: true });
      setMvpState(freshState);
      setAutomationRows(toAutomationRows(freshState.automations ?? []));
      const savedSchedule = (freshState.schedules ?? []).find((item: any) => String(item.automation_id ?? item.automationId ?? "") === automationId);
      if (!savedSchedule || savedSchedule.kind !== scheduleDraft.kind
        || String(savedSchedule.expression ?? "") !== (scheduleDraft.kind === "manual" ? "" : scheduleDraft.expression.trim())
        || savedSchedule.timezone !== scheduleDraft.timezone.trim() || savedSchedule.enabled !== scheduleDraft.enabled
        || Number(savedSchedule.revision) <= Number(persistedSchedule?.revision ?? 0)) throw new Error("schedule_readback_mismatch");
      setScheduleDraft({
        kind: normalizeScheduleKind(savedSchedule?.kind ?? result.schedule?.kind),
        expression: String(savedSchedule?.expression ?? result.schedule?.expression ?? ""),
        timezone: String(savedSchedule?.timezone ?? result.schedule?.timezone ?? scheduleDraft.timezone),
        enabled: savedSchedule ? savedSchedule.enabled === true : result.schedule?.enabled === true
      });
      const enabled = savedSchedule ? savedSchedule.enabled === true : result.schedule?.enabled === true;
      noteBuilder(`定期実行を${enabled ? "有効化" : "停止中の下書きとして"}保存しました。revision=${savedSchedule?.revision ?? result.schedule?.revision ?? "?"} / next=${!enabled || scheduleDraft.kind === "manual" ? "次回なし" : savedSchedule?.next_run_at ?? result.schedule?.nextRunAt ?? "未計算"} / external_action=false`);
    } catch (error) {
      const exact = error instanceof Error ? error.message : "schedule_save_failed";
      noteBuilder(`定期実行の保存は未確認です: ${exact}。同じ保存を繰り返さず、現在の設定を再読込して照合してください。`);
    } finally {
      setScheduleSaving(false);
    }
  };
  return (
    <section>
      <ProjectTabs mvpState={mvpState} />
      <PageTitle title={builderTitle} desc={registeredWorkflow ? "登録済み業務の表示名・目的・実予定を編集します。処理契約は保持します。" : "チャットやテンプレートから生成された自動化を編集します。"}>
        <Button controlId="builder.save" onClick={saveBuilder} disabled={saving || !builderEditable}>{saving ? "保存確認中" : registeredWorkflow ? "名前・目的を保存" : "下書きとして保存"}</Button>
        {!registeredWorkflow && <Button
          controlId="builder.sync"
          variant="primary"
          disabled={!builderTypeSupported || saving}
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
        </Button>}
      </PageTitle>
      <ProjectScopeNotice projectId={activeProject} mvpState={mvpState} />
      {!builderEditable && <div className="notice-row" role="alert">この自動化の型（<code>{builderType}</code>）は現在のBuilderで確認できません。SNSとして表示・保存せず、正本のautomation_typeを確認してください。</div>}
      {registeredWorkflow && <div className="notice-row">登録済みの処理を表示しています。名前・目的と実予定は編集できます。手順・接続先・承認・リトライは登録契約の値を保持し、この画面では変更しません。</div>}
      <div className="builder-grid">
        <div>
          <Panel title="基本設定" controlId="builder.basic.panel">
            <div className="form-grid">
              <label>自動化名<input data-control-id="builder.name" aria-label="自動化名" readOnly={!builderEditable} value={builderDraft.name} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, name: event.target.value }))} /></label>
              <label>{registeredWorkflow ? "目的・説明（表示用）" : "依頼内容"}<textarea data-control-id="builder.goal" aria-label={registeredWorkflow ? "目的・説明（表示用）" : "依頼内容"} readOnly={!builderEditable} rows={4} maxLength={4000} value={builderDraft.goal} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, goal: event.target.value }))} /></label>
              <label>実行先の説明（仕様メモ）<input data-control-id="builder.target-label" aria-label="実行先の説明（仕様メモ）" readOnly={registeredWorkflow || !builderEditable} value={builderDraft.target_label} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, target_label: event.target.value }))} /></label>
              <label>プロジェクト<input data-control-id="builder.project" aria-label="プロジェクト" value={projectName} readOnly /></label>
              <label>Lane<input data-control-id="builder.lane" aria-label="Lane" readOnly={registeredWorkflow || !builderEditable} value={builderDraft.lane} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, lane: event.target.value }))} /></label>
              <label>スケジュール希望（仕様メモ）<input data-control-id="builder.schedule" aria-label="スケジュール希望（仕様メモ）" readOnly={registeredWorkflow || !builderEditable} value={builderDraft.schedule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, schedule: event.target.value }))} /></label>
              <label>承認ポリシー<input data-control-id="builder.approval-policy" aria-label="承認ポリシー" readOnly={registeredWorkflow || !builderEditable} value={builderDraft.approval_policy} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, approval_policy: event.target.value }))} /></label>
              <label>リトライルール<input data-control-id="builder.retry-rule" aria-label="リトライルール" readOnly={registeredWorkflow || !builderEditable} value={builderDraft.retry_rule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, retry_rule: event.target.value }))} /></label>
            </div>
          </Panel>
          {isGmailExecutionWorkflow && <Panel title="Gmail実行対象" controlId="builder.gmail-execution-target.panel">
            <p className="muted">Gmail workflowは会社のverified接続を自動選択しません。対象connection refを1つ明示して保存し、Run開始時にも同じrefを再検証します。</p>
            <div className="form-grid">
              <label>対象Gmail connection ref
                <select
                  data-control-id="builder.gmail-execution-target.connection-ref"
                  aria-label="対象Gmail connection ref"
                  value={gmailTargetDraft.connectionRefId || (gmailTargetDraft.accountRef ? "__account_only__" : "")}
                  disabled={saving || gmailConnectionRefsStatus !== "ready"}
                  onChange={(event) => {
                    const connectionRefId = event.target.value;
                    if (connectionRefId === "__account_only__") return;
                    const selected = gmailConnectionRefs.find((ref) => String(ref.id ?? "") === connectionRefId);
                    setGmailTargetDraft({ connectionRefId, accountRef: String(selected?.account_ref ?? selected?.accountRef ?? "") });
                  }}
                >
                  <option value="">未設定（Gmail Runは停止）</option>
                  {!gmailTargetDraft.connectionRefId && gmailTargetDraft.accountRef && <option value="__account_only__">保存済みaccount_ref（connection ref未確認）</option>}
                  {gmailTargetDraft.connectionRefId && !gmailConnectionRefs.some((ref) => String(ref.id ?? "") === gmailTargetDraft.connectionRefId) && <option value={gmailTargetDraft.connectionRefId}>保存済みref（inventory未確認）</option>}
                  {gmailConnectionRefs.map((ref) => <option key={ref.id} value={ref.id}>{ref.id} / {ref.account_ref ?? ref.accountRef ?? "account_ref未確認"} / {ref.status ?? "状態未確認"}</option>)}
                </select>
                <Button controlId="builder.gmail-execution-target.clear" disabled={saving || gmailConnectionRefsStatus !== "ready" || (!gmailTargetDraft.connectionRefId && !gmailTargetDraft.accountRef)} onClick={() => setGmailTargetDraft({ connectionRefId: "", accountRef: "" })}>対象を解除</Button>
              </label>
              <label>対象account_ref<input data-control-id="builder.gmail-execution-target.account-ref" aria-label="対象Gmail account_ref" readOnly value={gmailTargetDraft.accountRef} /></label>
            </div>
            <div className="action-note" role="status">
              {gmailConnectionRefsStatus === "loading" ? "会社別Gmail connection inventoryを確認中です。" : gmailConnectionRefsStatus === "error" ? "会社別Gmail connection inventoryを確認できません。targetの変更は保存しません。" : `保存状態: ${persistedAutomation?.execution_target?.state ?? (gmailTargetDraft.connectionRefId ? "再確認中" : "unbound")} / external_action=false`}
            </div>
          </Panel>}
          <Panel title="ワークフロー手順" controlId="builder.steps.panel">
            {registeredWorkflow ? <>
              <p className="muted">登録された処理手順です。各実行の状況と結果はRun詳細で確認できます。</p>
              {builderDraft.steps.length ? <ol>{builderDraft.steps.map((step, i) => <li key={i}>{step.title}{!step.enabled ? "（登録時に無効）" : ""}</li>)}</ol> : <p className="muted">手順はこのreadbackに含まれていません。登録runnerの実行結果を確認してください。</p>}
            </> : <>
            <p className="muted">内容・実行先の説明・手順は保存する仕様です。接続アカウントや実行権限、固定済みscheduleのversionは変更しません。</p>
            {builderDraft.steps.map((step, i) => <div className="workflow-row builder-step-row" key={i}>
              <label className="builder-step-title">手順 {i + 1}<textarea rows={2} data-control-id={`builder.step.title.${i}`} aria-label={`手順 ${i + 1}`} readOnly={!builderEditable} value={step.title} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, steps: draft.steps.map((item, index) => index === i ? { ...item, title: event.target.value } : item) }))} /></label>
              <label className="checkbox-label"><input type="checkbox" data-control-id={`builder.step.enabled.${i}`} aria-label={`手順 ${i + 1} を有効にする`} disabled={!builderEditable} checked={step.enabled} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, steps: draft.steps.map((item, index) => index === i ? { ...item, enabled: event.target.checked } : item) }))} />有効</label>
              <Button controlId={`builder.step.remove.${i}`} disabled={!builderEditable || builderDraft.steps.length <= 1} onClick={() => setBuilderDraft((draft) => ({ ...draft, steps: draft.steps.filter((_, index) => index !== i) }))}>手順 {i + 1} を削除</Button>
            </div>)}
            <Button controlId="builder.step.add" disabled={!builderEditable} onClick={() => setBuilderDraft((draft) => ({ ...draft, steps: [...draft.steps, { title: "", enabled: true }] }))}>手順を追加</Button>
            </>}
          </Panel>
          <Panel title="定期実行の実設定" controlId="builder.schedule.panel">
            <p className="muted">仕様メモではなく、会社スコープのschedule APIへrevision付きで保存します。次回実行が未計算の場合は成功と扱いません。</p>
            <div className="form-grid">
              <label>実行種別<select data-control-id="builder.schedule.kind" aria-label="定期実行の種別" value={scheduleDraft.kind} disabled={scheduleSaving || !persistedAutomation || !builderEditable} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, kind: normalizeScheduleKind(event.target.value), enabled: event.target.value === "manual" ? false : draft.enabled }))}>
                <option value="manual">手動</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="cron">Cron</option>
              </select></label>
              <label>実行式<input data-control-id="builder.schedule.expression" aria-label="定期実行の実行式" value={scheduleDraft.expression} disabled={scheduleSaving || !persistedAutomation || !builderEditable || scheduleDraft.kind === "manual"} placeholder={scheduleDraft.kind === "cron" ? "0 9 * * *" : "09:00"} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, expression: event.target.value }))} /></label>
              <label>Timezone<input data-control-id="builder.schedule.timezone" aria-label="定期実行のTimezone" value={scheduleDraft.timezone} disabled={scheduleSaving || !persistedAutomation || !builderEditable} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, timezone: event.target.value }))} /></label>
              <label className="checkbox-label"><input data-control-id="builder.schedule.enabled" aria-label="定期実行を有効にする" type="checkbox" checked={scheduleDraft.enabled} disabled={scheduleSaving || !persistedAutomation || !builderEditable || scheduleDraft.kind === "manual"} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, enabled: event.target.checked }))} /> 有効にする（下書き本体も有効化し、予定時刻から実行）</label>
            </div>
            <div className="button-row">
              <Button controlId="builder.schedule.save" variant="primary" onClick={saveSchedule} disabled={scheduleSaving || !persistedAutomation || !builderEditable}>{scheduleSaving ? "定期実行を保存中" : "定期実行を保存"}</Button>
            </div>
            <div className="action-note" role="status">{persistedAutomation ? `revision=${persistedSchedule?.revision ?? "新規(1)"} / status=${persistedSchedule?.status ?? (scheduleDraft.enabled ? "有効化前" : "停止中の下書き")} / next=${persistedSchedule && (!persistedSchedule.enabled || persistedSchedule.kind === "manual") ? "次回なし" : persistedSchedule?.next_run_at ?? "未計算"}` : "自動化本体を保存すると、実設定を編集できます。新規scheduleは停止中の下書きから始まります。"}</div>
          </Panel>
          <Panel title="実行契約" controlId="builder.execution-contract.panel">
            <p><strong>{executionLabel}</strong></p>
            <div className="action-note" role="status">mode={executionMode} / scheduler={schedulerEffect} / external_action_allowed=false</div>
            {executionMode === "control_plane_dry_run" && <p className="muted">定期実行は scheduled_dry_run を作成し、予約・制御面のproofまでです。外部サイトの操作、送信、投稿は起動しません。</p>}
            {executionMode === "unverified" && <p className="muted">実行経路はまだ確認できていません。保存済み仕様を実行済みとは扱いません。</p>}
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

function approvalDecisionReadbackMatches(row: any, item: any, decision: "approve" | "reject"): boolean {
  return Boolean(row && row.id === item.id && String(row.company_id ?? row.project_id ?? "") === item.project
    && String(row.run_id ?? "") === item.runId
    && row.status === (decision === "approve" ? "approved" : "rejected")
    && String(row.action_kind ?? "") === item.actionKind
    && String(row.target_account_ref_id ?? "なし") === item.targetAccount
    && String(row.payload_hash ?? "") === item.payloadHash
    && String(row.policy_version ?? "") === item.policyVersion
    && (row.expires_at ?? null) === item.expiresAt);
}

function approvalRunReadbackMatches(item: any, run: any): boolean {
  return Boolean(item?.runId && run
    && String(run.id ?? "") === item.runId
    && String(run.company_id ?? run.project_id ?? "") === item.project);
}

function approvalPortableTarget(item: any, run: any): Record<string, any> | null {
  if (!item?.portableBound || !approvalRunReadbackMatches(item, run)) return null;
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : parseJsonRecord(value);
  const metadata = parseJsonRecord(run.metadata_json);
  const binding = record(metadata.portable_target_bound_approval_binding);
  const bundle = record(record(metadata.portable_input_bundle).input);
  const target = record(binding.target);
  if (binding.schema !== "automation_os_portable_external_approval_binding.v1"
    || metadata.approval_id !== item.id || binding.run_id !== item.runId
    || binding.company_id !== item.project || binding.effect_stage !== item.actionKind
    || target.account_ref !== item.targetAccount || bundle.payload_hash !== item.payloadHash
    || target.target_key !== bundle.target_key) return null;
  const targetKey = target.target_key ?? target.application_url ?? target.job_url;
  if (typeof targetKey !== "string" || !targetKey) return null;
  return { workflowId: binding.workflow_id, targetKey, accountRef: target.account_ref, payloadHash: bundle.payload_hash };
}

async function fetchExactApprovalRun(item: any): Promise<any> {
  if (!item?.runId) return null;
  const detail = await fetchApiJson<RunDetail>(`/api/runs/${encodeURIComponent(item.runId)}`);
  const run = detail?.run;
  if (!approvalRunReadbackMatches(item, run)) throw new Error("approval_run_readback_mismatch");
  if (item.portableBound && !approvalPortableTarget(item, run)) throw new Error("approval_target_readback_mismatch");
  return run;
}

function approvalTargetPrefix(item: { bound?: boolean; portableBound?: boolean }): string {
  if (item.portableBound) return "portable対象";
  if (item.bound) return "対象Run";
  return "承認対象";
}

function approvalExecutionLabel(status: unknown, expired: boolean, item: { bound?: boolean; portableBound?: boolean }): string {
  const prefix = approvalTargetPrefix(item);
  const normalized = String(status ?? "").toLowerCase();
  if (expired) return `${prefix}の承認期限切れ（外部効果は未確認）`;
  if (normalized === "pending" || normalized === "waiting") return `${prefix}の承認待ち`;
  if (normalized === "approved") return `${prefix}を承認済み（同じRunの実行結果は未確認）`;
  if (normalized === "rejected") return `${prefix}を却下（外部効果は未確認）`;
  return `${prefix}の承認状態未確認（外部効果は未確認）`;
}

function ApprovalsPage({ model }: { model: AppModel }) {
  const { setReceipt, mvpState, setMvpState } = model;
  const route = useRoute();
  const query = new URLSearchParams(route.includes("?") ? route.slice(route.indexOf("?") + 1) : "");
  const runFilter = safeRouteValue(query.get("run_id"), 180);
  const companyFilter = safeRouteValue(query.get("company_id"), 180);
  const readbackCompanyId = companyFilter || resolveProjectSelection(mvpState);
  const readbackCompanyLabel = readbackCompanyId ? projectLabelFromState(mvpState, readbackCompanyId) : "会社未選択";
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalStatusNote, setApprovalStatusNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [readbackRequired, setReadbackRequired] = useState(false);
  const [approvalRun, setApprovalRun] = useState<any>(null);
  const [approvalRunReadStatus, setApprovalRunReadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [companyApprovalReadback, setCompanyApprovalReadback] = useState<Array<Record<string, unknown>>>([]);
  const [companyApprovalReadbackStatus, setCompanyApprovalReadbackStatus] = useState<"loading" | "ready" | "error">("loading");
  const inFlight = useRef(false);
  const unknownDecision = useRef<{ approvalId: string; decision: "approve" | "reject" } | null>(null);
  const readCompanyApprovalList = async () => {
    if (!readbackCompanyId) {
      setCompanyApprovalReadback([]);
      setCompanyApprovalReadbackStatus("error");
      return;
    }
    setCompanyApprovalReadbackStatus("loading");
    try {
      const response = await mvpFetch(companyApprovalListReadbackUrl(readbackCompanyId), { cache: "no-store" });
      if (!response.ok) throw new Error(`approval_list_readback_http_${response.status}`);
      const body = validateCompanyApprovalListReadback(await response.json(), readbackCompanyId);
      setCompanyApprovalReadback(body.approvals);
      setCompanyApprovalReadbackStatus("ready");
    } catch {
      setCompanyApprovalReadback([]);
      setCompanyApprovalReadbackStatus("error");
    }
  };
  React.useEffect(() => { void readCompanyApprovalList(); }, [readbackCompanyId]);
  // Prefer the company-scoped API row: the dashboard projection may contain
  // the same approval ID with deliberately reduced fields, while the exact
  // target/action binding is only present in the protected readback.
  const approvalRows = [...companyApprovalReadback, ...(mvpState.approvals ?? [])]
    .filter((approval, index, rows) => rows.findIndex((candidate) => String(candidate.id ?? "") === String(approval.id ?? "")) === index);
  const persistedApprovals = approvalRows.filter((approval) =>
    (!runFilter || String(approval.run_id ?? "") === runFilter)
    && (!companyFilter || String(approval.company_id ?? approval.project_id ?? "") === companyFilter)).map((approval) => {
    const fallbackParts = String(approval.content ?? "").split(" / ").map((part) => part.trim()).filter(Boolean);
    const actionLabel = String(approval.action_label ?? approval.action_kind ?? fallbackParts[0] ?? "未確認");
    const targetLabel = String(approval.target_account_ref_id ?? approval.target_label ?? approval.boundary_label ?? fallbackParts[1] ?? "未確認");
    const normalizedStatus = String(approval.status ?? "").toLowerCase();
    const knownStatus = ["pending", "waiting", "approved", "rejected"].includes(normalizedStatus);
    const expired = isApprovalExpired(normalizedStatus, approval.expires_at);
    const exactBinding = Boolean(approval.action_kind && approval.payload_hash && approval.policy_version);
    const durableBound = Boolean(approval.job_id && exactBinding);
    const portableBound = Boolean(!approval.job_id && exactBinding && approval.run_id);
    const executionLabel = approvalExecutionLabel(normalizedStatus, expired, { bound: durableBound, portableBound });
    const approvalLabel = expired
      ? "期限切れ"
      : normalizedStatus === "pending" || normalizedStatus === "waiting"
        ? "承認待ち"
      : normalizedStatus === "approved"
        ? durableBound || portableBound ? "対象限定で承認済み" : "承認済み（結果未確認）"
        : normalizedStatus === "rejected"
          ? "却下"
          : "要確認";
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
    status: expired ? "blocked" : normalizeApprovalStatus(approval.status),
    approvalLabel,
    knownStatus,
    expired,
    decisionEligible: knownStatus && !expired && (normalizedStatus === "pending" || normalizedStatus === "waiting"),
    // Portable approvals intentionally have no durable_job row. Keep the
    // decision endpoint selection unchanged, but expose their run/action
    // binding instead of presenting them as unbound in the read-only UI.
    bound: durableBound,
    portableBound,
    runId: String(approval.run_id ?? ""),
    expiresAt: approval.expires_at ?? null,
    revision: Number(approval.decision_revision ?? 1),
    actionKind: String(approval.action_kind ?? ""),
    targetAccount: String(approval.target_account_ref_id ?? "なし"),
    payloadHash: String(approval.payload_hash ?? ""),
    policyVersion: String(approval.policy_version ?? "")
    };
  });
  const visibleApprovals = persistedApprovals.filter((approval) => approval.status === "waiting" || approval.expired || !approval.knownStatus || Boolean(runFilter));
  const approvedApprovals = persistedApprovals.filter((approval) => approval.status === "approved");
  const selectedIndex = visibleApprovals.length ? Math.min(selected, visibleApprovals.length - 1) : -1;
  const item = selectedIndex >= 0 ? visibleApprovals[selectedIndex] : null;
  const selectedCompanyRole = item ? projectOptionsFromState(mvpState).find((company) => company.id === item.project)?.role ?? "viewer" : "viewer";
  const canDecideApproval = ["owner", "admin", "approver"].includes(selectedCompanyRole);
  const portableTarget = approvalPortableTarget(item, approvalRun);
  React.useEffect(() => {
    setApprovalRun(null);
    setApprovalRunReadStatus("loading");
    if (!item?.runId) {
      setApprovalRunReadStatus("ready");
      return;
    }
    let cancelled = false;
    fetchExactApprovalRun(item)
      .then((run) => { if (!cancelled) { setApprovalRun(run); setApprovalRunReadStatus("ready"); } })
      .catch(() => { if (!cancelled) { setApprovalRun(null); setApprovalRunReadStatus("error"); } });
    return () => { cancelled = true; };
  }, [item?.id, item?.runId, item?.payloadHash]);
  React.useEffect(() => {
    if (selected !== selectedIndex) setSelected(selectedIndex < 0 ? 0 : selectedIndex);
  }, [selected, selectedIndex]);
  React.useEffect(() => {
    setApprovalNote("表示された対象と内容を確認しました。");
    setApprovalStatusNote(item ? `${item.kind}: ${item.content} を選択 / ${actionStamp()}` : `承認候補はありません / ${actionStamp()}`);
    setEditing(false);
  }, [selected, item?.id, item?.content]);
  const refreshApprovals = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const state = await readMvpState("ui", { fresh: true });
      await readCompanyApprovalList();
      const persisted = item?.id ? state.approvals?.find((approval: any) => approval.id === item.id) : null;
      let exactRun: any = null;
      if (item?.runId) {
        exactRun = await fetchExactApprovalRun(item);
        setApprovalRun(exactRun);
        setApprovalRunReadStatus("ready");
      }
      const pending = unknownDecision.current;
      const recoveringThisDecision = Boolean(pending && pending.approvalId === item?.id);
      const recovered = !recoveringThisDecision
        || approvalDecisionReadbackMatches(persisted, item, pending!.decision);
      setMvpState(state);
      if (recoveringThisDecision && !recovered) {
        setReadbackRequired(true);
        setApprovalStatusNote(`保存結果はGET-only readbackでまだ確定していません。PATCH再送は停止中です。同じ承認とRunを再取得してください / ${actionStamp()}`);
        return;
      }
      if (recoveringThisDecision) {
        unknownDecision.current = null;
        setEditing(false);
        setApprovalStatusNote(`同じ承認ID${item?.id ? `=${item.id}` : ""}と同じRun${item?.runId ? `=${item.runId}` : ""}をGET-onlyで確認しました。外部効果・完了は未確認です / ${actionStamp()}`);
      }
      setReadbackRequired(false);
      if (!recoveringThisDecision) setApprovalStatusNote(`保存状態を再取得しました。再送・承認操作はしていません / ${actionStamp()}`);
    } catch {
      setReadbackRequired(true);
      setApprovalRunReadStatus("error");
      setApprovalStatusNote(`保存状態または同じRunは未確認です。GET-onlyで再取得し、PATCHは再送しません / ${actionStamp()}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const updateSelectedApproval = async (decision: "approve" | "reject") => {
    if (inFlight.current || readbackRequired || unknownDecision.current?.approvalId === item?.id) return;
    if (!item?.id || !item.decisionEligible || !canDecideApproval) {
      setReceipt(item ? "承認状態または権限を確認できないため、承認操作を停止しました。外部送信・投稿は実行していません。" : "承認候補はありません。外部送信・投稿は実行していません。");
      return;
    }
    if (decision === "approve" && item.portableBound && !portableTarget) {
      setApprovalStatusNote("同じRunの実行対象を確認できていません。結果を再取得してください。");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await mvpFetch(item.bound
        ? `/api/v1/companies/${encodeURIComponent(item.project)}/approvals/${encodeURIComponent(item.id)}`
        : `/api/mvp/approvals/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(item.bound ? { "if-match": String(item.revision) } : {}) },
        body: JSON.stringify({ decision: item.bound ? (decision === "approve" ? "approved" : "rejected") : decision,
          note: approvalNote || "表示された対象と内容を確認しました。",
          ...(item.portableBound ? { expected_binding: { company_id: item.project, run_id: item.runId,
            action_kind: item.actionKind, target_account_ref_id: item.targetAccount, payload_hash: item.payloadHash,
            policy_version: item.policyVersion, expires_at: item.expiresAt } } : {}) })
      });
      if (!response.ok) throw new Error("approval_update_failed");
      await response.json();
      const state = await readMvpState("ui", { fresh: true });
      await readCompanyApprovalList();
      const persisted = state.approvals?.find((approval: any) => approval.id === item.id);
      if (!approvalDecisionReadbackMatches(persisted, item, decision)) throw new Error("approval_decision_readback_mismatch");
      if (item.portableBound) {
        const exactRun = await fetchExactApprovalRun(item);
        setApprovalRun(exactRun);
        setApprovalRunReadStatus("ready");
      }
      setMvpState(state);
      setEditing(false);
      unknownDecision.current = null;
      const outcome = decision === "reject" ? "却下" : item.bound || item.portableBound ? "対象を限定した実行承認" : "ローカル下書き確認";
      const next = decision === "approve" && (item.bound || item.portableBound)
        ? "同じRunのworkerはこの対象の処理を開始できます。外部効果・完了はまだ確認しておらず、同じRunの結果で確認します。"
        : "承認の保存を確認しました。業務の実行結果とは別です。";
      setReceipt(`${item.kind}: ${outcome}の保存を同じ承認IDで確認。${next}`);
      setApprovalStatusNote(`${item.kind}: ${outcome}を保存・再取得済み。${next} / ${actionStamp()}`);
    } catch {
      unknownDecision.current = item?.id ? { approvalId: item.id, decision } : null;
      setReadbackRequired(true);
      setReceipt(`${item.kind}: 保存結果または同じRunは未確認です。GET-onlyで再取得し、同じ承認のPATCHは再送しません。`);
      setApprovalStatusNote(`${item.kind}: 保存結果・同じRunは未確認 / GET-only recoveryのみ / PATCH再送停止 / ${actionStamp()}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
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
      <PageTitle title="承認キュー" desc="会社別の承認待ち、承認済み、期限切れを状態に応じて確認します。">
        <Button controlId="approvals.refresh" disabled={busy} onClick={refreshApprovals}>保存状態を再取得</Button>
      </PageTitle>
      <p className="muted" data-control-id="approvals.company-scope">対象会社: {readbackCompanyLabel} / {readbackCompanyId || "会社スコープ未確認"} / 承認操作は対象Runのreadback後に表示</p>
      {runFilter && <p className="muted" data-control-id="approvals.run-filter">対象Run: {runFilter} / 会社: {companyFilter || "現在の権限範囲"}</p>}
      <ApprovalReadbackPanel companyId={readbackCompanyId} initialRunId={runFilter} readApiJson={async (url, options) => {
        const response = await mvpFetch(url, { cache: "no-store", signal: options?.signal });
        if (!response.ok) throw new Error(`approval_readback_http_${response.status}`);
        return response.json();
      }} />
      <p className="muted" role="status" data-control-id="approvals.company-api-readback">会社スコープAPI一覧: {companyApprovalReadbackStatus === "ready" ? `${companyApprovalReadback.length}件を取得` : companyApprovalReadbackStatus === "loading" ? "取得中" : "未確認"}</p>
      <div className="action-note" role="status">{approvalStatusNote || `承認候補 ${visibleApprovals.length}件 / 承認済み ${approvedApprovals.length}件 / 業務結果は同じRunで確認`}</div>
      <Panel title="Standing Approval（常時許可）の範囲" controlId="approvals.standing-approval.panel">
        <div className="action-note" role="status" data-control-id="approvals.standing-approval.readback">対象範囲: 未確認（現行の承認source readbackにStanding Approval項目がありません）</div>
        <p className="muted">常時許可の存在・対象・期限は、正規の承認sourceで確認できるまで有効とは扱いません。求人応募やその他の外部効果へ、未確認の常時許可を自動適用しません。</p>
      </Panel>
      <div className="split approvals-layout">
        <Panel title={runFilter ? "このRunの承認" : "承認待ち / 期限切れ"} className="list-panel" controlId="approvals.list.panel">
          {visibleApprovals.length ? visibleApprovals.map((a, i) => <button data-control-id={`approvals.row.${a.id ?? i}`} key={a.id ?? a.content} className={`list-row approval-row ${i === selectedIndex ? "selected" : ""}`} onClick={() => { setSelected(i); setApprovalStatusNote(`${a.kind}: ${a.content} を選択 / ${actionStamp()}`); }}><span>{a.kind}</span><strong>{a.content}</strong><small>{a.project} / {a.lane}</small><div className="approval-facts"><span>Action: {a.actionLabel}</span><span>Target: {a.targetLabel}</span><span>状態: {a.executionLabel}</span></div><StatusBadge status={a.status} label={a.approvalLabel} /></button>) : (
            <div className="empty-state">
              <strong>{approvedApprovals.length ? `承認済み ${approvedApprovals.length}件 / 承認待ちはありません` : "承認待ちはありません"}</strong>
              <span>{approvedApprovals.length ? "承認済みのため、再度承認するボタンは表示しません。続きは対象Runのreceipt/readbackで確認します。" : "API readback上、外部操作前の確認待ちは0件です。"}</span>
            </div>
          )}
        </Panel>
        <aside className="side-panel wide approvals-detail">
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
              <div className="preview-box">{item.expired ? "承認期限を過ぎたため、この承認は無効です。必要なら内容を確認して新しい依頼を作成してください。" : "承認は表示されたRun・対象・内容だけに適用します。"} 承認メモを編集しても、実行内容や対象は変わりません。内容の変更は元の依頼を修正し、新しい対象に対して承認します。</div>
              {item.runId && <Button controlId="approvals.open-run" onClick={() => go(`#/projects/${encodeURIComponent(item.project)}/runs/${encodeURIComponent(item.runId)}`)}>同じRunの結果を開く</Button>}
              {item.portableBound && (portableTarget ? <div className="preview-box" data-control-id="approvals.target-preview">
                <p>実行対象: {portableTarget.targetKey} / account: {portableTarget.accountRef}</p>
                {portableTarget.workflowId === "daily-ai-research-source-sync" && <p>調査と原稿最大3件、既存Sheetsの39列・3ビューだけを同期します。遠隔のみの行は保持し、画像生成・送信・公開はしません。</p>}
              </div> : <p className="muted" role={approvalRunReadStatus === "loading" ? "status" : "alert"}>{approvalRunReadStatus === "loading"
                ? "同じRunの実行対象を確認中です。"
                : approvalRunReadStatus === "error" ? "同じRunの実行対象を取得できませんでした。"
                  : "取得したRunの対象が、この承認の内容と一致しません。"} 「保存状態を再取得」で確認してください。対象を確認できるまで承認・実行は開始しません。</p>)}
              {(item.bound || item.portableBound) && <DataTable controlId={`approvals.binding.${item.id}`} headers={["Binding", "Value"]} rows={[
                ["Binding type", item.portableBound ? "portable run/action" : "durable job"],
                ["Action", item.actionKind],
                ["Target", item.targetAccount],
                ["Payload SHA-256", item.payloadHash],
                ["Policy", item.policyVersion],
                ["Decision revision", String(item.revision)]
              ]} />}
              {editing && <label>承認メモ（実行内容は変わりません）<textarea data-control-id="approvals.edit" aria-label="承認修正メモ" disabled={busy || readbackRequired} value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label>}
              {canDecideApproval && item.decisionEligible ? <div className="button-row"><Button controlId="approvals.approve" variant="primary" icon={<Check size={15} />} disabled={busy || readbackRequired || (item.portableBound && !portableTarget)} onClick={approveSelected}>承認</Button><Button controlId="approvals.edit-button" icon={<Edit3 size={15} />} disabled={busy || readbackRequired} onClick={() => { setEditing(true); setApprovalStatusNote(`${item.kind}: 承認メモ欄を開きました / ${actionStamp()}`); }}>承認メモを編集</Button><Button controlId="approvals.reject" variant="danger" disabled={busy || readbackRequired} onClick={rejectSelected}>却下</Button></div> : <p className="muted" data-control-id="approvals.read-only">{item.expired ? "期限切れのため操作できません。内容を確認し、新しい承認を作成してください。" : item.knownStatus && !item.decisionEligible ? "この承認は確定済みです。同じRunの結果を確認してください。" : "承認状態または会社権限を確認できないため、承認操作は表示していません。"}</p>}
            </>
          ) : (
            <>
              <h3>{approvedApprovals.length ? "承認済みです" : "承認待ちはありません"}</h3>
              <p className="muted">API readback / 承認済み {approvedApprovals.length}件 / 業務結果は同じRunで確認</p>
              <div className="preview-box">{approvedApprovals.length ? "この承認はすでに確定しているため、再承認ボタンは表示しません。対象Runのreceipt/readbackで次の処理を確認します。" : "新しい承認が作成されると、対象workflow、停止条件、証跡URI、操作ボタンがここに表示されます。"}</div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function RunsPage({ model }: { model: AppModel }) {
  const { mvpState, setMvpState, setReceipt, setAutomationRows } = model;
  const route = useRoute();
  const routeQuery = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
  const scopedCompanyId = safeProjectId(new URLSearchParams(routeQuery).get("company_id"));
  const initialScopedState = scopedCompanyId
    && mvpState.company_scope?.enforced === true
    && mvpState.company_scope.company_ids?.length === 1
    && mvpState.company_scope.company_ids[0] === scopedCompanyId ? mvpState : null;
  const [scopedState, setScopedState] = useState<MvpState | null>(initialScopedState);
  const [scopedReadbackStatus, setScopedReadbackStatus] = useState<"loading" | "ready" | "error">(scopedCompanyId ? (initialScopedState ? "ready" : "loading") : "ready");
  const [scopedReadbackBlocker, setScopedReadbackBlocker] = useState<string | null>(null);
  const viewState = scopedCompanyId ? (scopedState ?? {}) : mvpState;
  const runs = (viewState.runs ?? []).filter((run: any) => !scopedCompanyId || String(run.company_id ?? run.project_id ?? "") === scopedCompanyId);
  const jobs = (viewState.jobs ?? []).filter((job: any) => !scopedCompanyId || String(job.company_id ?? job.project_id ?? "") === scopedCompanyId);
  const proofs = (viewState.proofs ?? []).filter((proof: any) => !scopedCompanyId || String(proof.company_id ?? proof.project_id ?? "") === scopedCompanyId);
  const approvals = (viewState.approvals ?? []).filter((approval: any) => !scopedCompanyId || String(approval.company_id ?? approval.project_id ?? "") === scopedCompanyId);
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [blockerFilter, setBlockerFilter] = useState(() => {
    return safeRouteValue(new URLSearchParams(routeQuery).get("blocker"), 240);
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [selectedProofId, setSelectedProofId] = useState<string | null>(null);
  const [proofView, setProofView] = useState<ProofView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutatingJobId, setMutatingJobId] = useState<string | null>(null);
  const retryIdempotencyRef = useRef<Record<string, string>>({});
  const [actionNote, setActionNote] = useState("実行履歴を開きました。再読込とfilter操作の結果はここにも表示します。");
  const projectForRun = (run: any) => run.company_id ?? run.project_id ?? viewState.automations?.find((automation) => automation.id === run.automation_id)?.project_id ?? "";
  const statusMatches = (run: any) => {
    if (statusFilter === "active") return isRunActiveStatus(run.status);
    if (statusFilter === "blocked") return isRunStoppedStatus(run.status);
    if (statusFilter === "completed") return isRunCompletedStatus(run.status);
    return true;
  };
  const blockerMatches = (run: any) => !blockerFilter || runBlockerFilterKey(run, viewState) === blockerFilter;
  const publicRunHistoryBlocker = (run: any) => publicRunBlockerSummary(run, viewState) || publicRunBlockerSummary(run);
  const filteredRuns = runs.filter((run) => statusMatches(run) && (projectFilter === "all" || projectForRun(run) === projectFilter) && blockerMatches(run));
  const activeRuns = runs.filter((run) => isRunActiveStatus(run.status));
  const activeRunsForProject = activeRuns.filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter);
  const blockedRuns = runs.filter((run) => isRunStoppedStatus(run.status));
  const stoppedRuns = blockedRuns;
  const completedRuns = runs.filter((run) => isRunCompletedStatus(run.status));
  const blockerOptions = [...new Map(blockedRuns.map((run) => [runBlockerFilterKey(run, viewState), blockerGroupLabel(run, viewState)]))].sort((a, b) => a[1].localeCompare(b[1], "ja"));
  const dashboardSelectedRun = runs.find((run) => run.id === selectedRunId && filteredRuns.some((filtered) => filtered.id === run.id)) ?? filteredRuns[0] ?? null;
  const detailForCurrentRun = selectedRunDetail?.run?.id === dashboardSelectedRun?.id ? selectedRunDetail : null;
  const selectedRun = newerRunSnapshot(detailForCurrentRun?.run, dashboardSelectedRun);
  const selectedProofs = detailForCurrentRun?.proofs
    ? Array.from(new Map([
      ...proofRowsForRun(selectedRun, proofs),
      ...(detailForCurrentRun.proofs ?? []).filter((proof) => String(proof?.run_id ?? "") === String(selectedRun?.id ?? ""))
    ].map((proof) => [String(proof.id), proof])).values())
    : selectedRun ? proofRowsForRun(selectedRun, proofs) : [];
  const selectedSteps = detailForCurrentRun?.steps ?? [];
  const selectedWorkerEvents = detailForCurrentRun?.workerEvents ?? [];
  const selectedJob = selectedRun ? jobs.find((job) => job.run_id === selectedRun.id) ?? null : null;
  const selectedJobCompanyId = String(selectedJob?.company_id ?? selectedRun?.company_id ?? "");
  const selectedJobRole = projectOptionsFromState(viewState).find((company) => company.id === selectedJobCompanyId)?.role ?? "viewer";
  const canMutateJob = ["owner", "admin", "operator"].includes(selectedJobRole);
  const refreshScoped = async () => {
    if (!scopedCompanyId) return;
    setScopedReadbackStatus("loading");
    setScopedReadbackBlocker(null);
    try {
      const state = await readMvpState("ui", { fresh: true, companyId: scopedCompanyId });
      const scope = state.company_scope;
      if (scope?.enforced !== true || !Array.isArray(scope.company_ids) || scope.company_ids.length !== 1 || scope.company_ids[0] !== scopedCompanyId) {
        throw new Error("company_scoped_runs_readback_mismatch");
      }
      setScopedState(state);
      setScopedReadbackStatus("ready");
      setMvpState(state);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      setReceipt(`会社別Runs readback 済みです。company=${scopedCompanyId} / runs=${state.runs?.length ?? 0}`);
      setActionNote(`会社別Runs再読込完了: company=${scopedCompanyId} / runs=${state.runs?.length ?? 0} / ${actionStamp()}`);
    } catch (error) {
      setScopedState(null);
      setScopedReadbackStatus("error");
      setScopedReadbackBlocker(error instanceof Error ? error.message : "company_scoped_runs_unavailable");
      setActionNote(`会社別Runs readback未確認: company=${scopedCompanyId} / ${actionStamp()}`);
    }
  };
  const refresh = async () => {
    if (scopedCompanyId) {
      await refreshScoped();
      return;
    }
    try {
      const state = await readMvpState("ui", { fresh: true });
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
  const initialRefreshHandledRef = useRef(false);
  React.useEffect(() => {
    // App's route-level loader already requests the UI projection when this
    // page is mounted.  Avoid starting a second fresh readback in the same
    // render boundary; a direct/older summary entry still gets one refresh.
    if (initialRefreshHandledRef.current) return;
    initialRefreshHandledRef.current = true;
    if (model.mvpLoadStatus === "ready" && model.mvpState.readback_projection === "ui") return;
    void refresh();
  }, []);
  React.useEffect(() => {
    if (!scopedCompanyId) return;
    void refreshScoped();
  }, [scopedCompanyId]);
  React.useEffect(() => {
    setBlockerFilter(safeRouteValue(new URLSearchParams(routeQuery).get("blocker"), 240));
  }, [route]);
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
    (scopedCompanyId
      ? requestCompanyRunDetail(scopedCompanyId, currentRunId)
      : fetchApiJson<RunDetail>(`/api/runs/${encodeURIComponent(currentRunId)}`))
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
  }, [dashboardSelectedRun?.id, scopedCompanyId]);
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
      (scopedCompanyId ? readMvpState("ui", { fresh: true, companyId: scopedCompanyId }) : readMvpState()).then((state) => {
        if (scopedCompanyId && (state.company_scope?.enforced !== true || state.company_scope.company_ids?.length !== 1 || state.company_scope.company_ids[0] !== scopedCompanyId)) return;
        if (scopedCompanyId) setScopedState(state);
        setMvpState(state);
        setAutomationRows(toAutomationRows(state.automations ?? []));
        setSelectedRunId((current) => resolveSelectedRunId(current, state.runs ?? [], state.actionableRuns ?? []));
      }).catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [setAutomationRows, setMvpState, scopedCompanyId]);
  if (scopedCompanyId && scopedReadbackStatus !== "ready") {
    return <section>
      <PageTitle title="実行履歴" desc="会社別の保存された確認記録を表示します。">
        <Button controlId="runs.scoped-refresh" icon={<RefreshCw size={15} />} onClick={() => { void refresh(); }}>再読込</Button>
      </PageTitle>
      <ProjectUnavailablePage loading={scopedReadbackStatus === "loading"} scopeLabel={`Runs / ${scopedCompanyId}`} blocker={scopedReadbackStatus === "error" ? scopedReadbackBlocker : undefined} reason={scopedReadbackStatus === "loading" ? "会社別Runs readbackを確認しています。" : "会社別Runs readbackを取得できません。グローバル履歴へフォールバックせず、同じ会社scopeを再確認してください。"} />
    </section>;
  }
  return (
    <section>
      <PageTitle title="実行履歴" desc="自動化の進み具合と保存された確認記録を表示します。">
        <Button controlId="runs.refresh" icon={<RefreshCw size={15} />} onClick={refresh}>再読込</Button>
      </PageTitle>
      <div className="action-note" role="status">{actionNote}</div>
      <div className="runs-status-toolbar" aria-label="実行履歴の状態フィルター">
        <span className="field-label">履歴フィルター</span>
        <div className="filter-row">
          {[
            ["active", `処理中 ${activeRuns.length}`],
            ["blocked", `停止 ${stoppedRuns.length}`],
            ["completed", `完了 ${completedRuns.length}`],
            ["all", `全て ${runs.length}`]
          ].map(([key, label]) => <button aria-pressed={statusFilter === key} data-control-id={`runs.status-filter.${key}`} key={key} className={statusFilter === key ? "selected" : ""} onClick={() => { setStatusFilter(key); setActionNote(`Status filter: ${label} を選択しました。表示run=${runs.filter((run) => {
            if (key === "active") return isRunActiveStatus(run.status);
            if (key === "blocked") return isRunStoppedStatus(run.status);
            if (key === "completed") return isRunCompletedStatus(run.status);
            return true;
          }).filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter).length} / ${actionStamp()}`); }}>{label}</button>)}
        </div>
      </div>
      <div className="cards four">
        <MetricCard controlId="runs.metric.count" title="実行件数" value={String(runs.length)} sub="保存済みの履歴" status={runs.length ? "enabled" : "waiting"} />
        <MetricCard controlId="runs.metric.proofs" title="確認記録" value={String(proofs.length)} sub="安全に開ける記録" status={proofs.length ? "enabled" : "waiting"} />
        <MetricCard controlId="runs.metric.queued-jobs" title="待機Job" value={String(jobs.filter((job) => job.status === "queued").length)} sub="会社別durable queue" status={jobs.some((job) => job.status === "queued") ? "waiting" : "enabled"} />
        <MetricCard controlId="runs.metric.active-jobs" title="実行中Job" value={String(jobs.filter((job) => job.status === "leased").length)} sub="永続化済みjob状態" status={jobs.some((job) => job.status === "leased") ? "running" : "enabled"} />
      </div>
      <Panel title="実行前の安全確認" controlId="runs.safety.panel">
        <div className="filter-row">
          {[
            ["all", "全プロジェクト"],
            ...projectOptionsFromState(viewState).map((option) => [option.id, option.label])
            ].map(([key, label]) => <button data-control-id={`runs.project-filter.${key}`} key={key} className={projectFilter === key ? "selected" : ""} onClick={() => { setProjectFilter(key); setActionNote(`Project filter: ${label} を選択しました / ${actionStamp()}`); }}>{label}</button>)}
        </div>
        {blockerOptions.length > 0 && <details className="runs-blocker-filter">
          <summary>停止理由を絞り込む（{blockerOptions.length}種類{blockerFilter ? " / 選択中" : ""}）</summary>
          <div role="group" aria-label="停止理由フィルター">
            <span className="field-label">停止理由</span>
            <div className="filter-row">
              <button type="button" data-control-id="runs.blocker-filter.all" className={!blockerFilter ? "selected" : ""} onClick={() => { setBlockerFilter(""); setActionNote(`停止理由フィルターを解除しました / ${actionStamp()}`); }}>全て</button>
              {blockerOptions.map(([key, label], index) => <button type="button" data-control-id={`runs.blocker-filter.${index}`} className={blockerFilter === key ? "selected" : ""} key={key} onClick={() => { setBlockerFilter(key); setActionNote(`${label}を表示しています / ${actionStamp()}`); }}>{label}</button>)}
            </div>
          </div>
        </details>}
        <DataTable controlId="runs.preview.table" headers={["項目", "状態", "意味"]} rows={[
          ["処理候補", String(activeRunsForProject.length), "選択中の会社にあるqueued/running Run"],
          ["承認待ち", String(approvals.filter((approval) => isApprovalWaiting(approval.status, approval.expires_at)).length), "外部操作の前に人間確認が必要な件数"],
          ["安全境界", "外部操作なし", "投稿・送信・削除・認証・課金は承認なしに実行しません"]
        ]} />
      </Panel>
      <BlockerTriage runs={blockedRuns} collapsed />
      <div className="split">
        <Panel title="履歴" className="list-panel" controlId="runs.history.panel">
          <DataTable controlId="runs.history.table" headers={["記録", "自動化", "状態", "開始待ち", "確認事項", "記録数"]} rows={filteredRuns.slice(0, 20).map((run) => [
            <button data-control-id={`runs.row.run-link.${run.id}`} className="link-button" onClick={() => { setSelectedRunId(run.id); setActionNote(`履歴を選択しました / ${publicRunStatusForRun(run, viewState)} / ${actionStamp()}`); }}>{run.id}</button>,
            run.automation_name ?? run.automation_id,
            <StatusBadge status={isRunCompletedStatus(run.status) ? "approved" : isReadOnlyNoEffectReadbackComplete(run, viewState) ? "waiting" : isRunStoppedStatus(run.status) ? "blocked" : run.status === "running" ? "running" : "waiting"} label={publicRunStatusForRun(run, viewState)} />,
            run.queued_at ?? "-",
            publicRunHistoryBlocker(run),
            String(proofCountForRun(run, proofs))
          ])} />
        </Panel>
        <aside className="side-panel wide">
          <h3>確認記録</h3>
          {selectedRun ? <p className="muted">{selectedRun.id} / {publicRunStatusForRun(selectedRun, viewState)}{detailLoading ? " / 読込中" : ""}</p> : <p className="muted">履歴はまだありません。</p>}
          {selectedRun && <p className="muted">手順 {selectedSteps.length}件 / 更新 {selectedWorkerEvents.length}件</p>}
          {selectedRun && <RunTimeline run={selectedRun} compact proofCount={selectedProofs.length} />}
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
              {canMutateJob && ["queued", "leased", "failed", "timed_out"].includes(selectedJob.status) ? <div className="button-row">
                {["queued", "leased", "timed_out"].includes(selectedJob.status) && <Button controlId={`runs.job.cancel.${selectedJob.id}`} variant="danger" disabled={mutatingJobId === selectedJob.id} onClick={() => { void mutateJob(selectedJob, "cancel"); }}>{mutatingJobId === selectedJob.id ? "保存確認中" : "キャンセル"}</Button>}
                {["failed", "timed_out"].includes(selectedJob.status) && <Button controlId={`runs.job.retry.${selectedJob.id}`} variant="primary" disabled={mutatingJobId === selectedJob.id} onClick={() => { void mutateJob(selectedJob, "retry"); }}>{mutatingJobId === selectedJob.id ? "保存確認中" : "再試行"}</Button>}
              </div> : <p className="muted" data-control-id={`runs.job.read-only.${selectedJob.id}`}>{selectedJob.status === "reconciliation_required" ? "照合待ちのため、外部作用の有無を確認するまでjob操作は表示していません。" : "この会社では閲覧権限のため、job操作は表示していません。"}</p>}
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
  const route = useRoute();
  const routeQuery = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
  const scopedCompanyId = safeProjectId(new URLSearchParams(routeQuery).get("company_id"));
  const worker = mvpState.worker;
  const workerSummary = workerStatusSummary(worker);
  const queueHistoricalCount = worker?.queue_historical_count ?? 0;
  const queueCurrentCount = worker?.queue_current_count ?? worker?.queue_depth ?? 0;
  const queueUnknownCount = worker?.queue_unknown_count ?? 0;
  const queueDisplay = queueHistoricalCount > 0
    ? `fresh=${queueCurrentCount} / historical=${queueHistoricalCount}${queueUnknownCount > 0 ? ` / unknown=${queueUnknownCount}` : ""}`
    : queueUnknownCount > 0 ? `fresh=${queueCurrentCount} / unknown=${queueUnknownCount}` : "fresh queued record";
  const processReadback = mvpState.browser_use_runtime?.processReadback;
  const portableRemoteWorker = processReadback?.portableRemoteWorker;
  const workerScope = portableRemoteWorker?.scopeReadback ?? processReadback?.workerScopeReadback;
  const workerTransport = portableRemoteWorker?.transportReadback;
  const portableProcessReadback = publicPortableRemoteWorkerProcessReadback(portableRemoteWorker);
  const workerTransportLabel = workerTransport?.heartbeatStatus === "ok"
    ? `受理済み / ${relativeAgeLabel(workerTransport.lastSuccessfulHeartbeatAt ?? workerTransport.heartbeatAt ?? null)}`
    : workerTransport?.heartbeatStatus === "blocked"
      ? `blocked / ${workerTransport.heartbeatExactBlocker ?? "transport blocker不明"}`
      : "未確認";
  const [pcNote, setPcNote] = useState("PC状態を開きました。再確認結果はここにも表示します。");
  const [pcRefreshing, setPcRefreshing] = useState(false);
  const pcInFlight = React.useRef(false);
  const pcMounted = React.useRef(true);
  React.useEffect(() => { pcMounted.current = true; return () => { pcMounted.current = false; }; }, []);
  const orderedRuns = [...(mvpState.runs ?? [])].sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
  const activeRuns = orderedRuns.filter((run) => isRunActiveStatus(run.status));
  const stoppedRuns = orderedRuns.filter((run) => isRunStoppedStatus(run.status));
  const refresh = async () => {
    if (pcInFlight.current) return;
    pcInFlight.current = true; setPcRefreshing(true);
    try {
      const state = await readMvpState("ui", { fresh: true, companyId: scopedCompanyId || undefined });
      if (scopedCompanyId && (state.company_scope?.enforced !== true
        || state.company_scope.company_ids?.length !== 1
        || state.company_scope.company_ids[0] !== scopedCompanyId)) {
        throw new Error("pc_status_company_scope_mismatch");
      }
      if (!pcMounted.current) return;
      setMvpState(state);
      setAutomationRows(toAutomationRows(state.automations ?? []));
      const nextSummary = workerStatusSummary(state.worker);
      setReceipt(`Local Agent heartbeat readback 済みです。worker=${state.worker?.status ?? "unknown"} / queue=${state.worker?.queue_depth ?? 0}${nextSummary.blocker ? ` / blocker=${nextSummary.blocker}` : ""}`);
      setPcNote(`Local Agent readback完了: worker=${state.worker?.status ?? "unknown"} / queue=${state.worker?.queue_depth ?? 0} / ${nextSummary.display} / ${actionStamp()}`);
    } catch {
      if (!pcMounted.current) return;
      setReceipt("Local Agent のMVP readbackに失敗しました。");
      setPcNote(`Local Agent readback失敗: MVP API接続を確認してください / ${actionStamp()}`);
    } finally { pcInFlight.current = false; if (pcMounted.current) setPcRefreshing(false); }
  };
  React.useEffect(() => {
    if (scopedCompanyId) void refresh();
  }, [scopedCompanyId]);
  return (
    <section>
      <PageTitle title="PC状態" desc="Mac workerのheartbeatと、API応答ホスト上のprocess診断を分けて表示します。">
        <Button controlId="pc.refresh" onClick={refresh} disabled={pcRefreshing}>{pcRefreshing ? "確認中" : "再確認"}</Button>
      </PageTitle>
      <div className="action-note" role="status">{pcNote}</div>
      <div className="cards four">
        <MetricCard controlId="pc.metric.local-agent" title="Local Agent" value={workerSummary.fresh ? "heartbeat確認済み" : workerSummary.stored ? "API readback" : "要確認"} sub={`${workerSummary.nextAction} / ${workerSummary.freshness}`} status={workerSummary.fresh ? "enabled" : workerSummary.stored ? "draft" : "blocked"} />
        <MetricCard controlId="pc.metric.heartbeat" title="Heartbeat" value={workerSummary.fresh ? "fresh" : workerSummary.stored ? "未取得" : "stale"} sub={workerSummary.freshness} status={workerSummary.fresh ? "enabled" : workerSummary.stored ? "draft" : "blocked"} />
        <MetricCard controlId="pc.metric.queue" title="Queue" value={String(worker?.queue_depth ?? 0)} sub={queueDisplay} status={queueCurrentCount > 0 ? "running" : queueHistoricalCount > 0 || queueUnknownCount > 0 ? "draft" : "enabled"} />
        <MetricCard controlId="pc.metric.last-run" title="最新のRun記録" value={orderedRuns.length ? "あり" : "なし"} sub={orderedRuns[0]?.id ?? "記録なし"} status={orderedRuns.length ? "enabled" : "waiting"} />
      </div>
      <Panel title="Local Agent readback" controlId="pc.readback.panel"><DataTable controlId="pc.readback.table" headers={["項目", "状態", "次に見ること"]} rows={[["接続状態", workerSummary.fresh ? "接続確認済み" : workerSummary.stored ? "API保存済み / heartbeat未確認" : "要確認", workerSummary.nextAction], ["Worker", worker?.status ?? "unknown", worker?.id ?? "unknown"], ["Queue scope", workerScope?.status ?? "未確認", `AOS=${worker?.queue_scope?.company_ids?.join(", ") || workerScope?.controlPlaneCompanyIds?.join(", ") || "未確認"} / worker=${workerScope?.remoteWorkerCompanyIds?.join(", ") || "未確認"}`], ["Heartbeat", workerSummary.freshness, workerSummary.blocker ?? (workerSummary.stored ? "Mac heartbeat未取得" : "問題なし")], ["Heartbeat transport", workerTransportLabel, workerTransport?.claimStatus === "idle" ? "claimなし。queue claim/receipt/source syncは未完了。heartbeat・queue claim・receipt・source syncは別readbackです" : workerTransport?.heartbeatExactBlocker ?? "同一Runのclaim/receiptを確認"], ["Queue", String(worker?.queue_depth ?? 0), worker?.next_action ?? (worker?.queue_scope?.source === "local_sqlite" ? "ローカルSQLite queueです。remote workerの本番scopeとは別物です。" : "外部操作は各workflowの承認境界で停止")], ["Portable remote worker process", portableProcessReadback.label, portableProcessReadback.detail], ["AOS browser resource readback", processReadback?.unregisteredBrowserProcessCount != null ? `未登録 ${processReadback.unregisteredBrowserProcessCount}件 / mismatch ${processReadback.bindingMismatchCount ?? 0}件` : "未確認", processReadback?.exactBlocker ?? workerScope?.exactBlocker ?? "Companionのworkflow-owned resourceと同一Run readbackを確認してください。"]]} /></Panel>
      <p className="muted">上のprocess診断はAPIが応答したホストの観測です。ZeaburにMacのprocessが見つからないことだけではMac停止と判定できません。Mac側の通信はheartbeatで、heartbeat・queue claim・receipt・source syncはそれぞれ別readbackです。業務結果は同一Runのreceiptで確認してください。</p>
      <Panel title="記録上の処理中・待機中Run（現行queueとは別）" controlId="pc.running.panel">
        <p className="muted">閲覧権限のある全会社のRun記録です。queuedという保存状態だけでは、現に待機・稼働しているとは判定しません。上のQueue件数はdurable Jobの別集計です。</p>
        {activeRuns.length ? <DataTable controlId="pc.running.table" headers={["Run", "会社", "Automation", "記録上の開始時刻", "保存状態", "確認事項"]} rows={activeRuns.slice(0, 8).map((run) => [run.id, projectLabelFromState(mvpState, run.company_id ?? run.project_id ?? ""), run.automation_name ?? run.automation_id, run.started_at ?? "未記録", <StatusBadge status="waiting" label={`${publicRunStatusForRun(run, mvpState)}（稼働未確認）`} />, publicRunBlockerSummary(run, mvpState)])} /> : <p>現在の読取範囲に処理中・待機中のRun記録はありません。</p>}
      </Panel>
      <Panel title="停止・失敗・取消の履歴（稼働中ではありません）" controlId="pc.stopped.panel">{stoppedRuns.length ? <DataTable controlId="pc.stopped.table" headers={["Run", "更新時刻", "状態", "記録された理由"]} rows={stoppedRuns.slice(0, 8).map((run) => [run.id, run.updated_at ?? "未記録", publicRunStatusForRun(run, mvpState), publicRunBlockerSummary(run, mvpState)])} /> : <p>現在の読取範囲に停止履歴はありません。</p>}</Panel>
    </section>
  );
}

function TemplatesPage({ model }: { model: AppModel }) {
  const { setReceipt, createdTemplates, setCreatedTemplates, setMvpState, setAutomationRows } = model;
  const [selected, setSelected] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const createIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [templateNote, setTemplateNote] = useState("テンプレートは保存可能な下書きカタログです。接続とLaneの実行可能性は別のreadbackで確認します。");
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
    setTemplateNote(`${name}: 下書き保存を開始しました。外部投稿・送信は実行しません。`);
    const automationType = name.includes("Gmail")
      ? "gmail-reply"
      : name.includes("DM")
        ? "dm-reply"
        : category.includes("リサーチ")
          ? "research-report"
          : name.includes("Runway")
            ? "creative-video"
            : "sns-post";
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
      setReceipt(`${name} の自動化案の下書きを保存しました。automation=${result.automation.id} / 外部操作は未実行です。`);
      setTemplateNote(`${name}: 下書き保存完了 automation=${result.automation.id} / 接続・Laneの実行可能性は未確認です。`);
    } catch {
      setReceipt(`${name} の下書きAPI保存は未確認です。作成済みには追加していません。外部操作は未実行です。`);
      setTemplateNote(`${name}: 下書きAPI保存は未確認です。作成済みには追加していません。`);
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
      <PageTitle title="テンプレート / Skills" desc="再利用可能な自動化の下書きカタログです。" />
      <div className="action-note" role="status">{templateNote}</div>
      <div className="notice-row" role="status">表示される接続名とLaneはカタログ上の想定値です。保存は下書き作成だけで、実際の接続・ログイン・外部操作は行いません。</div>
      <label className="chat-input">
        保存先の会社
        <select data-control-id="templates.project-select" aria-label="テンプレートの保存先会社" value={selectedProjectId} disabled={model.mvpLoadStatus !== "ready"} onChange={(event) => setSelectedProjectId(event.target.value)}>
          <option value="">会社を選択してください</option>
          {canonicalProjects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select>
      </label>
      <div className="split">
        <div className="template-grid">{templates.map((t, i) => <button data-control-id={`templates.card.${i}`} key={t[0]} className={`template-card ${i === selected ? "selected" : ""}`} onClick={() => { setSelected(i); setTemplateNote(`${t[0]} を選択しました。想定接続=${t[2]} / 推奨表示Lane=${t[3]}（実行可能性は未確認）`); }}><LayoutTemplate size={17} /><strong>{t[0]}</strong><span>{t[1]}</span><small>想定接続: {t[2]} / Lane表示: {t[3]}</small></button>)}</div>
        <aside className="side-panel wide"><h3>{templates[selected][0]}</h3><p>想定接続: {templates[selected][2]}</p><p>推奨表示Lane: {templates[selected][3]}（実行可能性は未確認）</p><p>承認: {templates[selected][4]}</p><Button controlId="templates.use" variant="primary" onClick={useTemplate} disabled={!selectedProjectIsVerified || saving}>{saving ? "保存確認中" : "下書きを保存"}</Button><h3>作成済み</h3><p>{createdTemplates.length ? createdTemplates.join(" / ") : "まだありません"}</p></aside>
      </div>
    </section>
  );
}

function Panel({ title, children, className = "", controlId }: { title: string; children: React.ReactNode; className?: string; controlId?: string }) {
  return <section data-control-id={controlId} className={`panel ${className}`}><div className="panel-head"><h2>{title}</h2></div>{children}</section>;
}

function MetricCard({ title, value, sub, status, statusLabel, controlId }: { title: string; value: string; sub: string; status: Status; statusLabel?: string; controlId?: string }) {
  return <div data-control-id={controlId} className="metric"><div><span>{title}</span><strong>{value}</strong><small>{sub}</small></div><StatusBadge status={status} label={statusLabel} /></div>;
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
