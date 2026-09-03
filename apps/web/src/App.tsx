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

type Status = "running" | "waiting" | "approved" | "blocked" | "enabled" | "disabled" | "draft";
type ApiTokenScope = "unknown" | "read" | "write" | "unrestricted";

const subTabLabels = [
  ["定期実行", "automations"],
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
  // The first authenticated read may include a cold Postgres control-plane
  // snapshot after the server has restarted.  The API is already bounded and
  // fails closed; give that bounded read enough time to complete instead of
  // converting a recoverable cold-start into a false local-mode timeout.
  const timer = window.setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(input, withMvpApiHeaders({ ...init, signal: controller.signal }));
  } catch (error) {
    if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
      throw new Error("mvp_state_request_timeout");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
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
    // The live Codex App Server currently returns this ChatGPT plugin-details
    // route for Gmail. It is an official page, but it contains no connect or
    // authorize control, so it must not be presented as an auth surface or
    // kept in a polling state indefinitely.
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/plugins/plugin_connector_1p_")) {
      return "official_auth_surface_not_actionable";
    }
    return null;
  } catch {
    return "official_auth_url_invalid";
  }
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
  if (value === "queued" || value === "pending" || value === "waiting_approval") return "待機中";
  return "未確認";
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
    return "Mac workerのBrowser Use同一Run readback待ち（認証・画面状態は未確認） / 次: 同じRunのworker receiptを確認";
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
    return "外部応募の承認待ちです / 次: 対象1件の内容と送信権限を確認";
  }
  if (normalized === "approval_expired_requires_fresh_target_bound_approval") {
    return "応募承認の期限が切れています / 次: freshな対象1件に束縛した承認を確認";
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
  if (normalized === "registered_automation_local_runner_not_wired_to_http") {
    return "手動実行の接続準備が完了していません / 次: 登録automationのfresh readback後に正規手動実行接続を確認";
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
  if (backend === "playwright") return "Playwright";
  return backend ? String(backend) : "Browser runtime";
}

function publicBrowserUseRuntimeStatus(runtime: MvpState["browser_use_runtime"]) {
  if (!runtime) return "未確認";
  if (isChromePluginRuntime(runtime)) {
    const pluginReadback = runtime.chromePluginReadback;
    if (pluginReadback?.status === "ready" || runtime.status === "verified") return "確認済み";
    if (pluginReadback?.status === "stale" || pluginReadback?.exactBlocker || runtime.exactBlocker === "chrome_extension_bridge_readback_stale") return "要確認";
    if (runtime.status === "readback_pending") return "Chrome Plugin確認待ち";
    if (runtime.status === "blocked") return "要確認";
    return "未確認";
  }
  const processBlocker = runtime.processReadback?.exactBlocker;
  if (processBlocker === "browser_use_unregistered_live_process") return "未登録Browserあり（照合待ち）";
  if (processBlocker === "browser_use_live_process_binding_mismatch") return "profile / port不一致（照合待ち）";
  if (runtime.processReadback?.status === "unavailable") return "process readback取得不可";
  if (runtime.status === "verified") return "確認済み";
  if (runtime.status === "readback_pending") return "Mac worker確認待ち";
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
  if (runtime?.runtimeRole === "control_plane") return "Mac workerの同一Run readback待ち";
  return "profile/port lockとprocess identityを同一Runで確認";
}

function publicBrowserUseRuntimeNextCheck(runtime: MvpState["browser_use_runtime"]) {
  if (!runtime) return "AOS stateを同期してBrowser Use runtimeを確認";
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
  if (runtime.status === "readback_pending") return "Mac worker heartbeatと同一RunのBrowser Use readbackを確認";
  if (runtime.status === "blocked") return runtime.exactBlocker ? `exact blocker: ${runtime.exactBlocker}` : "Mac worker runtimeのexact blockerを確認";
  if (runtime.status === "verified") return "実行時はauthority・profile/port lock・receipt・cleanupを確認";
  return runtime.nextAction ?? "Browser Use runtimeのreadbackを確認";
}

function publicBrowserUseProcessReadbackStatus(readback: BrowserUseProcessReadback | undefined) {
  if (!readback) return "未確認";
  if (readback.status === "available") return "同一ホストprocess実測済み";
  if (readback.status === "unavailable") return "同一ホストprocess未取得";
  return "未確認";
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
  revision: number;
  automation_type: string;
  name: string;
  desc: string;
  schedule: string;
  schedule_version: string;
  next_run_at: string;
  lane: string;
  last: string;
  execution_mode: "control_plane_dry_run" | "registered_workflow_readback" | "unverified";
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
    alignmentCandidates?: Array<{ scope?: string; status?: string; companyIds?: string[]; origins?: string[]; workerIds?: string[] }>;
    alignmentDecisionRequired?: boolean;
    exactBlocker?: string | null;
    nextAction?: string;
  };
  portableRemoteWorker?: {
    status?: string;
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
      remoteOrigin?: string | null;
    };
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
  return value === "manual" || value === "daily" || value === "weekly" || value === "cron" ? value : "daily";
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
  presentation_profiles?: Array<{ id: string; kind: string; label: string; source?: string; revision?: number; exactBlocker?: string | null; purpose?: string; freshnessSlaMinutes?: number; browserUseLane?: string; stopBoundary?: string; primaryMetrics?: string[]; widgets?: string[]; preferredGrouping?: string; explanation?: string }>;
  browser_use_runtime?: { backend?: string; surface?: string; helper?: string; runtimeRole?: string; status?: string; exactBlocker?: string | null; readbackStatus?: string; summary?: string; nextAction?: string; fallbackPolicy?: string; contract?: string[]; lanes?: BrowserUseLaneBinding[]; processReadback?: BrowserUseProcessReadback; chromePluginReadback?: { status?: string; exactBlocker?: string | null; capturedAt?: string | null; refreshStatus?: string | null; bridgeInstanceId?: string | null; bridgeUrl?: string | null; browser?: { metadata?: Record<string, string> } }; operationalReadback?: BrowserUseOperationalReadback; workflowInventory?: { sets?: Record<string, string[]>; relationships?: { browser_and_catalog_overlap?: string[]; browser_only?: string[]; catalog_only?: string[]; lane_only?: string[]; browser_and_portable_match?: boolean; catalog_and_adapter_match?: boolean } } };
  schedules?: any[];
  runs?: any[];
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
};

type PluginAuthPollState = {
  status: "polling" | "verified" | "blocked";
  attempt: number;
  exactBlocker: string | null;
};

type GmailReadOnlyCanaryReadback = {
  schema?: string;
  status?: "ready_for_provider_call" | "blocked" | string;
  companyId?: string;
  connector?: string;
  transport?: string;
  selectedTool?: { id?: string; label?: string; kind?: string; status?: string } | null;
  exactBlocker?: string | null;
  nextAction?: string;
  externalActionExecuted?: boolean;
  dataRead?: boolean;
  dataPersisted?: boolean;
  secretMaterialIncluded?: boolean;
  providerReceipt?: unknown;
  reconciliation?: { required?: boolean; status?: string };
};

type ZeaburConnectorRegistryReadback = {
  exactBlocker?: string | null;
  capturedAt?: string;
  target?: { serviceName?: string; serviceId?: string; environmentId?: string };
  appServer?: { servicePresent?: boolean; runtimeStatus?: string; codexLogin?: string };
  pluginRegistry?: {
    installed?: Array<{ id?: string; name?: string; installed?: boolean; authStatus?: string }>;
    available?: Array<{ id?: string; name?: string; installed?: boolean; authStatus?: string }>;
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
    inputSources: "API readback待ち",
    outputs: "未確認（保存しません）",
    riskBoundary: "未認識の自動化タイプは保存・承認・定期実行更新を行いません。"
  };
}

function isSupportedAutomationType(type: string) {
  return Object.prototype.hasOwnProperty.call(builderConfigs, type);
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
    // Keep the planner readback bound to the same project that was sent to the
    // server. Falling back to session storage is only for legacy callers that
    // do not provide an explicit project scope.
    project_id: options.projectId?.trim() || projectSlugFromPrompt(prompt),
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
    chat_stream_text_length: typeof job.metadata?.streamTextLength === "number" ? job.metadata.streamTextLength : 0,
    chat_events: plannerProgressFromJob(body.job.id!, job).events,
    tool_preference: job.metadata?.toolPreference && typeof job.metadata.toolPreference === "object"
      ? job.metadata.toolPreference as ToolPreferenceReadback
      : null,
    proposed_changes: Array.isArray(serverPlan.proposedChanges) ? serverPlan.proposedChanges : [],
    requires_confirmation: Array.isArray(serverPlan.requiresConfirmation) ? serverPlan.requiresConfirmation : [],
    web_operation_intake: serverPlan.webOperationIntake
  };
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
    ? ` / Mac worker確認待ち=${readback.runnerPendingCount}件`
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
      ) : <p className="muted">workerから進捗を待っています。</p>}
      {progress?.streamTextLength ? <details><summary>受信進捗（内部JSONは表示しません）</summary><p className="muted">Codexから {progress.streamTextLength.toLocaleString("ja-JP")} 文字を受信しました。</p></details> : null}
      {progress?.workerBlocker && <p className="muted">Mac worker: {publicBlockerSummary(progress.workerBlocker)}{progress.workerNextAction ? ` / 次: ${progress.workerNextAction}` : ""}</p>}
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
    execution_mode: (item.execution_mode === "control_plane_dry_run" || item.execution_mode === "registered_workflow_readback" ? item.execution_mode : "unverified") as AutomationRow["execution_mode"],
    execution_label: String(item.execution_label ?? "実行契約未確認（保存のみ）"),
    scheduler_effect: String(item.scheduler_effect ?? "not_configured"),
    status: (["running", "waiting", "approved", "blocked", "enabled", "disabled", "draft"].includes(item.status) ? item.status : "draft") as Status
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
// read their complete receipt through /api/runs/:id, so the UI does not need
// to re-transfer every historical metadata blob on every navigation or
// retry.  The full MVP projection remains available to explicit API callers.
async function readMvpState(projection: "full" | "ui" | "summary" | "chat" = "ui", options: { fresh?: boolean } = { fresh: true }) {
  const query = new URLSearchParams();
  if (projection !== "full") query.set("projection", projection);
  if (options.fresh) query.set("fresh", "1");
  const queryString = query.toString();
  const response = await mvpFetch(`/api/mvp/state${queryString ? `?${queryString}` : ""}`, { cache: "no-store" });
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
  if (message === "mvp_state_request_timeout" || message === "mvp_state_detail_readback_timeout") return message;
  const match = message.match(/^mvp_state_http_\d+:(.+)$/u);
  return match?.[1] ?? null;
}

function isSummaryDegradedMvpBlocker(blocker: string | null): boolean {
  return blocker === "mvp_state_postgres_read_timeout"
    || blocker === "mvp_state_detail_readback_timeout";
}

function isRetryableMvpStateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch|NetworkError|Load failed|mvp_state_request_timeout|mvp_state_http_(?:408|429|500|502|503|504)/i.test(message);
}

const MVP_DETAIL_READBACK_TIMEOUT_MS = 20_000;

function withMvpDetailReadbackTimeout<T>(promise: Promise<T>, timeoutMs = MVP_DETAIL_READBACK_TIMEOUT_MS): Promise<T> {
  let timer: number | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error("mvp_state_detail_readback_timeout") as Error & { exactBlocker?: string };
      error.exactBlocker = "mvp_state_detail_readback_timeout";
      reject(error);
    }, timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer !== undefined) window.clearTimeout(timer);
    });
  });
}

async function readMvpStateWithRetry(projection: "full" | "ui" | "summary" | "chat" = "ui", options: { fresh?: boolean } = { fresh: true }) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readMvpState(projection, options);
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !isRetryableMvpStateError(error)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("mvp_state_readback_failed");
}

async function bootstrapAuthSession(): Promise<ApiTokenScope> {
  const response = await mvpFetch("/api/auth/session", { cache: "no-store" });
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
  window.sessionStorage.setItem("automation-os-active-project", slug);
  // Company scope is not a secret. Keep it across AOS tabs so opening the
  // authentication surface in a fresh tab does not silently fall back to an
  // unscoped "pending / unverified" projection.
  window.localStorage.setItem("automation-os-active-project", slug);
}

function rememberedProject() {
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

function Button({ children, icon, variant = "secondary", onClick, disabled = false, controlId, type = "button", ariaLabel }: { children: React.ReactNode; icon?: React.ReactNode; variant?: "primary" | "secondary" | "danger"; onClick?: () => void; disabled?: boolean; controlId?: string; type?: "button" | "submit"; ariaLabel?: string }) {
  return <button type={type} data-control-id={controlId} className={`btn ${variant}`} aria-label={ariaLabel} title={ariaLabel} onClick={onClick} disabled={disabled}>{icon}{children}</button>;
}

function IconButton({ children, onClick, label, controlId, disabled = false }: { children: React.ReactNode; onClick?: () => void; label: string; controlId?: string; disabled?: boolean }) {
  return <button type="button" data-control-id={controlId} className="icon-btn" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function App() {
  const route = useRoute();
  const [receipt, setReceiptValue] = useState("Local Agent は待機中です。");
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
  const [apiAccessRequired, setApiAccessRequired] = useState(false);
  const [apiTokenScope, setApiTokenScope] = useState<ApiTokenScope>("unknown");
  const [accessChecking, setAccessChecking] = useState(false);
  React.useEffect(() => {
    let cancelled = false;
    const routeName = routePath(route);
    const projection = routeName === "#/"
      ? "summary"
      : routeName === "#/chat" ? "chat" : "ui";
    let detailReady = projection === "summary";
    setMvpLoadStatus("loading");
    const authPromise = bootstrapAuthSession()
      .then((scope) => {
        if (!cancelled) setApiTokenScope(scope);
        return { ok: true as const, scope };
      })
      .catch((error) => ({ ok: false as const, error }));
    const readDetailProjection = () => withMvpDetailReadbackTimeout(readMvpStateWithRetry(projection));
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
      ? readMvpStateWithRetry(projection)
        : readMvpStateWithRetry("summary")
        .then((summaryState) => {
          summaryStateForFallback = summaryState;
          if (!cancelled && !detailReady) {
            // Keep detail status as loading so every save/run control remains
            // fail-closed until the authenticated UI projection is ready.
            setMvpState(summaryState);
            setAutomationRows(toAutomationRows(summaryState.automations ?? []));
            setFeedbackReadback(summaryState.feedbacks ?? []);
            setReceipt("MVP summary readback 済みです。詳細readbackを確認中です。");
          }
          return readDetailState();
        })
        .catch(() => readDetailState());
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
        if (summaryStateForFallback && isSummaryDegradedMvpBlocker(blocker) && projectOptionsFromState(summaryStateForFallback).length > 0) {
          setMvpState(summaryStateForFallback);
          setMvpLoadStatus("degraded");
          setMvpLoadBlocker(blocker);
          setAutomationRows(toAutomationRows(summaryStateForFallback.automations ?? []));
          setFeedbackReadback(summaryStateForFallback.feedbacks ?? []);
          setReceipt("MVP summaryを表示中です。詳細readback待ち / 保存・送信・定期実行変更なし。");
          return;
        }
        setMvpLoadStatus("error");
        setMvpLoadBlocker(blocker);
        const message = error instanceof Error ? error.message : "";
        if (/^(?:auth_session|mvp_state)_http_(?:401|423)$/.test(message) || /private_ingress_or_sso_required|server_auth_session_secret_missing/.test(message)) {
          setApiAccessRequired(true);
          setReceipt("安全な管理セッションを確立できません。private ingressまたはSSOの設定を確認してください。");
          return;
        }
        setReceipt("Local Agent は待機中です。MVP API未接続のためローカル表示です。");
      });
    return () => { cancelled = true; };
  }, [route]);
  React.useEffect(() => {
    mvpFetch("/api/mvp/feedback", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        // The authentication gate owns the unauthenticated/locked state. Do not
        // let this secondary readback replace its actionable guidance.
        if (response.status === 401 || response.status === 423) return;
        if (!response.ok || json.ok === false) throw new Error("feedback_readback_failed");
        setFeedbackReadback(Array.isArray(json.feedbacks) ? json.feedbacks : []);
      })
      .catch(() => {
        setReceipt("Feedback readbackに失敗しました。空のキューとは断定せず、直前の表示を維持します。");
      });
  }, []);
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
    setFeedbackReadback
  }), [route, automationRows, createdTemplates, mvpState, mvpLoadStatus, feedbackReadback]);

  const retryAuthSession = async () => {
    setAccessChecking(true);
    try {
      const scope = await bootstrapAuthSession();
      const state = await readMvpStateWithRetry("ui", { fresh: true });
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
      setMvpLoadBlocker(mvpStateErrorBlocker(error));
      const message = error instanceof Error ? error.message : "";
      if (/auth_session_http_(?:401|423)|mvp_state_http_(?:401|423)|private_ingress_or_sso_required|server_auth_session_secret_missing/.test(message)) {
        setReceipt("安全な管理セッションを確立できません。private ingressまたはSSOの設定後に再確認してください。");
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
      const state = await readMvpStateWithRetry();
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
    const ownerSsoLoginUrl = "https://aos-admin-ingress.zeabur.app/auth/login";
    return (
      <main className="main">
        <section>
          <PageTitle title="Automation OS" desc="この画面はprivate ingress / SSOで保護されています。" />
          <Panel title="安全な管理セッション" controlId="shell.auth-session.panel">
            <p className="muted">APIキーはブラウザへ入力しません。サーバーがSecret StoreまたはKeychainから認証情報を取得し、private ingress / SSOで確認できた場合だけHttpOnly・Secure cookieを発行します。cookieやtokenはブラウザ保存領域・URL・録画・artifactへ入りません。</p>
            <p className="muted">最初に公開ingressでGoogle認証を完了してください。許可アカウントはnichika2000823@gmail.comです。認証後、この画面へ戻って状態を再確認します。</p>
            <div className="button-row">
              <a className="btn primary" data-control-id="shell.auth-session.open-owner-sso" href={ownerSsoLoginUrl} target="_blank" rel="noreferrer">Google認証を開始</a>
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
      <FeedbackWidget route={route} setReceipt={setReceipt} setMvpState={setMvpState} readOnlyEvidenceMode={mvpLoadStatus !== "ready"} />
    </div>
  );
}

function Sidebar({ route, isOwner }: { route: string; isOwner: boolean }) {
  const currentPath = routePath(route);
  const nav = [
    ["ホーム", "#/", Home],
    ["チャット", "#/chat", MessageSquare],
    ["会社", "#/projects", FolderKanban],
    ["実行履歴", "#/runs", Activity],
    ["承認", "#/approvals", ClipboardCheck],
    ["テンプレート", "#/templates", LayoutTemplate],
    ["プラグイン", "#/plugins", Network],
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
    { label: "会社一覧", route: "#/projects", keywords: "company 会社 project プロジェクト 顧客 client 自動化" },
    { label: "実行履歴", route: "#/runs", keywords: "run worker queue 実行 履歴" },
    { label: "承認", route: "#/approvals", keywords: "approval 承認 停止 外部操作" },
    { label: "テンプレート", route: "#/templates", keywords: "template テンプレート skills skill 雛形" },
    { label: "プラグイン", route: "#/plugins", keywords: "plugin プラグイン MCP CLI API 認証 接続 ツール" },
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
        <div className="top-receipt" role="status" data-freshness={receiptIsCurrent ? "current" : "stale"} title={receipt}>
          <span>{receipt}</span>
          <small>{receiptIsCurrent ? "この画面" : "前の画面"} / {receiptAge}</small>
        </div>
        <div className="muted" data-control-id="shell.auth.scope" aria-label="管理セッションの権限範囲">
          {apiTokenScope === "read" ? "認証: 読み取り専用" : apiTokenScope === "write" ? "認証: 書き込み許可" : apiTokenScope === "unrestricted" ? "認証: ローカル保護なし" : "認証: 権限範囲未確認"}
        </div>
      </div>
      <div className="top-actions">
        {mvpSyncing && <span className="muted" role="status" data-control-id="shell.top-header.sync-status">状態を同期中（表示は前回確認済み）</span>}
        <IconButton controlId="shell.top-header.sync" label={mvpSyncing ? "同期中" : "同期"} disabled={mvpSyncing} onClick={() => { void onSync(); }}><RefreshCw size={16} /></IconButton>
        <Button controlId="shell.top-header.new-automation" ariaLabel={canStartAutomation ? "新しい自動化" : companyCount === 0 && mvpLoadStatus === "ready" ? "会社を登録" : "確認中"} variant="primary" icon={<Plus size={15} />} disabled={mvpLoadStatus !== "ready"} onClick={() => openAutomationCreator(mvpState, setReceipt)}>{canStartAutomation ? "新しい自動化" : companyCount === 0 && mvpLoadStatus === "ready" ? "会社を登録" : "確認中"}</Button>
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

function FeedbackFixQueue({ feedbacks, state, setReceipt, setFeedbackReadback, canTriage = false }: { feedbacks: MvpState["feedbacks"]; state: MvpState; setReceipt: (value: string) => void; setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>>; canTriage?: boolean }) {
  const feedback = feedbackItemsFromState({ ...state, feedbacks });
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
        ? "summary表示 / 詳細readback待ち"
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
    ? "APIのfresh state readbackを待機しています。保存・実行・外部操作はまだ開始できません。"
    : model.mvpLoadStatus === "error"
      ? "APIのreadbackを再取得してください。未確認のbackend・runtimeを実行可能とは扱いません。"
      : model.mvpLoadStatus === "degraded"
        ? "summaryを確認できます。詳細readbackが戻るまでno-effectの手動確認だけを使い、保存・送信・定期実行変更は行いません。"
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
      <p className="muted">初見のサイトでも、固定されたクリック手順ではなく、現在の画面の意味・状態・対象候補を読み直して進めます。ここではまだブラウザ起動、投稿、送信、削除、認証、課金は実行しません。</p>
      <div className="action-note" role="status" data-control-id="web-admission.status" data-readback-phase={runtimePhase} data-exact-blocker={runtimeBlocker}>state readback: {stateReadbackPhase} / phase={runtimePhase} / blocker={runtimeBlocker} / 設定済みbackend: {configuredBackendLabel} / runtime readback surface: {model.mvpLoadStatus === "ready" ? runtime?.surface ?? "未確認" : "未確認"} / runtime={runtimeLabel} / role={model.mvpLoadStatus === "ready" ? runtime?.runtimeRole ?? "unknown" : "unknown"} / registered workflow {model.mvpLoadStatus === "ready" ? registeredWorkflowCount : 0}件 / company: {selectedProject} / external_action=false</div>
      {workflowInventory?.sets && (
        <div className="preview-box" data-control-id="web-admission.workflow-inventory">
          <strong>登録集合の意味</strong>
          <p className="muted">Browser/portable {workflowInventory.sets.registered_browser_workflows?.length ?? 0}件 / Company catalog {workflowInventory.sets.company_automation_catalog_workflows?.length ?? 0}件 / Browser lane {workflowInventory.sets.browser_lane_workflows?.length ?? 0}件。YouTubeの一時laneなど、実行workflowとlane専用項目は別集合として表示しています。</p>
        </div>
      )}
      <div className="preview-box" data-control-id="web-admission.lane-binding">
        <strong>Browser Useのprofile / port対応（AOS登録値）</strong>
        <p className="muted">ここに表示するprofileは秘密情報を含まない論理参照名、portはworkflow-ownedの予約portです。lifecycle（scheduled / single-use / temporary）も併記します。「使用中」「ログイン済み」「実行可能」とは解釈しません。実プロセスのlistenは別表の実測process port、認証状態と画面readbackはMac workerが同一Runで返した場合だけ反映します。</p>
        <div className="lane-binding-summary" data-control-id="web-admission.lane-binding.summary" role="status">
          <span><strong>設定済みbackend:</strong> {configuredBackendLabel}</span>
          <span><strong>state readback:</strong> {stateReadbackPhase}</span>
          <span><strong>runtime readback surface:</strong> {model.mvpLoadStatus === "ready" ? runtime?.surface ?? "未確認" : "未確認"}</span>
          <span><strong>runtime:</strong> {runtimeLabel}</span>
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
        ])} /> : <p className="muted">Browser Useの登録Lane定義はありません。固定値を補って表示せず、AOS inventoryのreadback待ちです。</p>}
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
        ])} /> : <p className="muted">同一ホストで検出されたBrowser Use Chromeはありません。これはAOS予約値が使用中・ログイン済み・実行可能という意味ではありません。</p>}
        <p className="muted">process readbackはprofile / portの同一ホスト実測、登録binding、Browser Use canonical room registryのowner readbackを分けて示します。room ownerが表示されてもAOSがforeign roomを回収・利用できる意味ではありません。ログイン状態、画面状態、外部効果、同一Runの完了は別証跡が必要です。{processReadback?.exactBlocker ? ` exact blocker=${processReadback.exactBlocker}` : " external_action=false"} / room={processReadback?.roomReadback?.status ?? "unknown"} / active rooms={processReadback?.roomReadback?.activeRoomCount ?? "未確認"}</p>
        {portableRemoteWorker?.status === "present" && <p className="muted">portable remote workerのプロセス存在とHeartbeat HTTP受理を分離表示しています。heartbeat・queue claim・receipt・source syncは別に確認します。read-only境界: effects={portableRemoteWorker.effects ?? "unknown"} / mode={portableRemoteWorker.mode ?? "unknown"} / transport={workerTransportLabel}。queue scope={workerScope?.status ?? "unknown"}{workerScope?.exactBlocker ? ` / exact blocker=${workerScope.exactBlocker}` : ""}。</p>}
        {workerScope?.status === "mismatch" && <p className="muted">AOS queue と Mac worker が別会社scopeを見ています。endpoint/companyを同じ対象へ揃えるまで claim は実行しません。remote origin={workerScope.remoteOrigins?.join(", ") || "未確認"}。</p>}
        <p className="muted">判定境界: {runtime?.summary ?? "runtime readbackなし"} / {runtime?.exactBlocker ? `exact blocker=${runtime.exactBlocker}` : "external_action=false"}</p>
      </div>
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
  setFeedbackReadback: React.Dispatch<React.SetStateAction<MvpState["feedbacks"]>>;
};

function TruthfulLanesPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const companyRuns = (model.mvpState.runs ?? []).filter((run) => (run.company_id ?? run.project_id) === companyId);
  const observedLanes = [...new Set(companyRuns.map((run) => String(run.lane ?? "").trim()).filter(Boolean))];
  const registeredLanes = model.mvpState.browser_use_runtime?.lanes ?? [];
  const selectedBackend = model.mvpState.web_operation_backend?.backend ?? model.mvpState.browser_use_runtime?.backend ?? "unknown";
  const selectedBackendLabel = selectedBackend === "chrome_plugin" ? "Chrome Plugin" : selectedBackend === "browser_use_cli" ? "Browser Use CLI" : selectedBackend === "playwright" ? "Playwright" : selectedBackend;
  return (
    <section>
      <ProjectTabs mvpState={model.mvpState} />
      <PageTitle title={companyName} desc="Lane readback" />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <Panel title="登録済みLane定義" controlId="truthful.lanes.registry.panel">
        <p className="muted">現在のAOS選択backend={selectedBackendLabel}。登録Lane定義のcanonical browser surface=Browser Use CLIは別のworkflow-owned契約として表示しています。下表のrunnerはプロセス起動中・ログイン済み・実行可能とは解釈しません。Playwright等のrunner名が残る行は、現在のAOS選択面へ移行済みという意味ではありません。実際の会社Runで観測されたLaneは下の表に分けて表示します。</p>
        {registeredLanes.length ? <DataTable controlId="truthful.lanes.registry.table" headers={["Lane", "Workflow", "lifecycle", "論理profile", "予約port (AOS)", "Runner契約", "process readback", "Live readback", "定義状態"]} rows={registeredLanes.map((lane: BrowserUseLaneBinding) => [lane.id ?? "-", lane.workflowId ?? "-", lane.lifecycle ?? "-", <code>{lane.profileRef ?? lane.profileName ?? "-"}</code>, lane.reservedPort == null ? "-" : String(lane.reservedPort), lane.runnerKind ?? lane.executionContract ?? "-", `${publicBrowserUseLaneProcessReadbackStatus(lane)}${lane.processPid ? ` / pid=${lane.processPid}` : ""}`, publicBrowserUseLaneReadbackStatus(lane), `${lane.ownership ?? "workflow_owned"} / ${lane.bindingStatus ?? lane.status ?? "registered"}`])} /> : <p className="muted">登録済みLane定義はありません。</p>}
      </Panel>
      <Panel title="永続化済みLane情報" controlId="truthful.lanes.panel">
        {observedLanes.length ? (
          <DataTable controlId="truthful.lanes.table" headers={["Lane", "Run数"]} rows={observedLanes.map((lane) => [lane, String(companyRuns.filter((run) => run.lane === lane).length)])} />
        ) : <p className="muted">この会社のRunで観測された永続化Lane情報はありません。Lane作成・ブラウザ起動・ロック解除APIは未実装のため、操作ボタンは表示しません。</p>}
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
        {memory.length ? <DataTable controlId="truthful.memory.info.table" headers={["項目", "内容"]} rows={memory.map((item) => [item.title ?? item.key, item.body ?? "-"])} /> : <ReadbackState title="保存済み情報はありません" detail="会社別永続化APIのreadbackにデータがありません。ローカルだけの編集結果やプレースホルダーは表示していません。" nextAction="この会社の自動化やChatから、保存対象を明示して作成する" />}
      </Panel>
    </section>
  );
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
      <PageTitle title={companyName} desc={isSecurity ? "Security / 権限・secret・接続境界" : "Integrations / 接続参照と再認証要求"} />
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      {isSecurity && <div className="notice-row" role="note">Securityは閲覧専用です。接続の追加・再認証・ローカル参照の無効化は「連携」画面で行います。</div>}
      <Panel title={isSecurity ? "Security / 接続境界（閲覧専用）" : "Integrations / 会社別接続inventory"} controlId={isSecurity ? "truthful.security.refs.panel" : "truthful.integrations.refs.panel"}>
        {canManage && inventoryStatus === "loading" ? <ReadbackState title="接続inventoryを確認中" detail="会社別APIから最新の接続参照を読み込んでいます。" tone="info" /> : canManage && inventoryStatus === "error" ? <ReadbackState title="接続inventoryを確認できません" detail="未確認状態を接続済みとは表示していません。右上の同期で、最新の会社scopeを再取得してください。" tone="attention" /> : canManage && accountRefs.length ? <DataTable controlId="truthful.integrations.refs.table" headers={["サービス", "アカウント参照", "OAuth", "Scope", "期限", "最終検証", "状態", "操作"]} rows={accountRefs.map((item) => [
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
  const receipt = parseJsonRecord(metadata.receipt);
  const candidates = [
    proof?.external_action_executed,
    proof?.externalActionExecuted,
    metadata.external_action_executed,
    metadata.externalActionExecuted,
    receipt.external_action_executed,
    receipt.externalActionExecuted
  ];
  return candidates.find((value): value is boolean => typeof value === "boolean");
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
        {proofs.length ? <DataTable controlId="truthful.artifacts.proofs.table" headers={["ID", "Run", "種類", "状態", "作成日時"]} rows={proofs.map((proof) => [proof.id, proof.run_id ?? "-", proof.proof_type ?? proof.kind ?? "-", proof.status ?? "stored", proof.created_at ?? "-"])} /> : <ReadbackState title="保存済みProofはありません" detail="この会社に現在確認できる証跡がありません。固定サンプルや架空KPIは表示していません。" nextAction="Runを実行した後、同一Runのreceiptとsource syncを確認する" />}
        <p className="muted" data-control-id="truthful.artifacts.completion-boundary">保存済みProofはreadbackの記録です。provider receipt・source sync・reconciliationが揃うまで業務完了をclaimしません。</p>
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
  const runMetadata = parseJsonRecord(run.metadata_json);
  const runBlocker = runBlockerValue(run, model.mvpState) ?? "-";
  const publicRunBlocker = publicRunBlockerSummary(run, model.mvpState) || publicRunBlockerSummary(run);
  const proofExternalActionExecuted = proofs
    .map((proof) => proofExternalActionState(proof))
    .find((value): value is boolean => typeof value === "boolean");
  const externalActionExecuted = typeof runMetadata.external_action_executed === "boolean"
    ? runMetadata.external_action_executed
    : typeof run.external_action_executed === "boolean"
      ? run.external_action_executed
      : proofExternalActionExecuted;
  const externalActionLabel = externalActionExecuted === false ? "なし（未実行）" : externalActionExecuted === true ? "あり（要確認）" : "未確認";
  return (
    <section>
      <PageTitle title={`実行詳細: ${run.id}`} desc="永続化済みreadbackのみ表示" />
      <Panel title="Run" controlId="truthful.run-detail.run.panel">
        <DataTable controlId="truthful.run-detail.run.table" headers={["自動化", "状態", "待機開始", "開始", "確認事項", "停止理由", "外部効果"]} rows={[[run.automation_name ?? run.automation_id ?? "-", <StatusBadge status={isReadOnlyNoEffectReadbackComplete(run, model.mvpState) ? "waiting" : run.status === "blocked" ? "blocked" : run.status === "running" ? "running" : "waiting"} label={publicRunStatusForRun(run, model.mvpState)} />, run.queued_at ?? "-", run.started_at ?? "-", publicRunBlocker, publicBlockerSummary(runBlocker), externalActionLabel]]} />
      </Panel>
      <Panel title="確認記録" controlId="truthful.run-detail.proof.panel"><DataTable controlId="truthful.run-detail.proof.table" headers={["ID", "種類", "状態", "業務完了判定"]} rows={proofs.length ? proofs.map((proof) => [proof.id, proof.proof_type ?? proof.kind ?? "-", publicProofStatus(proof.status), "未claim"]) : [["保存済み確認記録なし", "-", "-", "未claim"]]} /><p className="muted">確認記録はreadbackの記録です。provider receipt・source sync・reconciliationが揃うまで業務完了をclaimしません。</p></Panel>
      <div className="button-row">
        <Button controlId="truthful.run-detail.open-recovery" onClick={() => go(`#/projects/${encodeURIComponent(companyId)}/recovery`)}>会社別の復旧画面を開く</Button>
      </div>
      <p className="muted">再試行・キャンセルは会社別Recovery画面で、権限・idempotency・終端状態をサーバー確認した後に実行できます。</p>
    </section>
  );
}

function TruthfulRecoveryPage({ model }: { model: AppModel }) {
  const route = useRoute();
  const companyId = projectSlugFromRoute(route);
  const companyName = projectLabelFromState(model.mvpState, companyId);
  const jobs = (model.mvpState.jobs ?? []).filter((job) => String(job.company_id ?? "") === companyId);
  const attempts = model.mvpState.job_attempts ?? [];
  const canMutateJob = ["owner", "admin", "operator"].includes(projectOptionsFromState(model.mvpState).find((company) => company.id === companyId)?.role ?? "viewer");
  const [mutatingJobId, setMutatingJobId] = useState<string | null>(null);
  const [note, setNote] = useState("会社別のdurable job readbackから復旧候補を確認しています。");
  const retryIdempotencyRef = useRef<Record<string, string>>({});
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
      <PageTitle title={`${companyName} / 復旧`} desc="永続化されたdurable jobの状態確認と、許可された再試行・キャンセル" >
        <Button controlId="truthful.recovery.refresh" icon={<RefreshCw size={15} />} onClick={() => { void refresh(); }}>再読込</Button>
      </PageTitle>
      <ProjectScopeNotice projectId={companyId} mvpState={model.mvpState} />
      <div className="action-note" role="status">{note}</div>
      <div className="cards four">
        <MetricCard controlId="truthful.recovery.metric.recovery" title="要確認Job" value={String(recoveryJobs.length)} sub="failed / timeout / reconciliation" status={recoveryJobs.length ? "blocked" : "enabled"} />
        <MetricCard controlId="truthful.recovery.metric.pending" title="待機Job" value={String(pendingJobs.length)} sub="queued / leased" status={pendingJobs.length ? "waiting" : "enabled"} />
        <MetricCard controlId="truthful.recovery.metric.attempts" title="試行記録" value={String(attempts.filter((attempt) => String(attempt.company_id ?? "") === companyId || jobs.some((job) => job.id === attempt.job_id)).length)} sub="保存済みattempt" status="enabled" />
        <MetricCard controlId="truthful.recovery.metric.external" title="外部操作" value="実行しない" sub="復旧画面の安全境界" status="enabled" />
      </div>
      <Panel title="復旧候補" controlId="truthful.recovery.jobs.panel">
        <p className="muted">ここで行うのは会社別durable jobの状態遷移だけです。外部投稿・送信・再ログイン・Browser Useの起動は実行しません。再試行はサーバー側のidempotencyと権限検証を通ります。</p>
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
          ["reconciliation_required", "外部readback待ち", "外部効果の有無を確認せず再実行しない"],
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
  const requestedCompanyId = useMemo(() => chatRouteContext(route).companyId || chatRouteContext(route).projectId, [route]);
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
  const [authWizardPluginId, setAuthWizardPluginId] = useState<string | null>(null);
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
    const seenPluginNames = new Set<string>();
    const addPlugin = (item: CapabilityItem & { catalogKind: "plugin" }) => {
      const key = normalizedPluginName(item.name);
      if (seenPluginNames.has(key)) return;
      seenPluginNames.add(key);
      items.push(item);
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
        catalogSource: "recommended",
        installHint: "Zeabur上のCodex App ServerでPluginを追加後、会社認証を開始します。",
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
  React.useEffect(() => {
    if (!selectedCompanyId || !canManageCompany || codexAuth?.status !== "pending") return;
    const timer = window.setInterval(() => { void loadCodexAuth(selectedCompanyId); }, 5000);
    return () => { window.clearInterval(timer); };
  }, [selectedCompanyId, canManageCompany, codexAuth?.status]);
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
    return platform && (name === platform || name.includes(platform) || (platform === "drive" && name.includes("google-drive")) || (platform === "calendar" && name.includes("google-calendar")) || (platform === "mail" && name.includes("gmail")));
  });
  const companyAuthStatus = (item: CapabilityItem & { catalogKind: string }) => {
    if (item.catalogSource === "recommended" || item.status === "catalog_available") return "未追加・追加可能";
    if (item.catalogKind !== "plugin") return item.state.connected ? "接続済み" : item.state.verified ? "検証済み" : item.state.configured ? "カタログ確認済み" : "未確認";
    const ref = matchingConnection(item);
    if (ref && integrationStatusBadge(ref).label === "verified") return "会社認証済み";
    if (ref) return "再認証・検証待ち";
    return selectedCompanyId ? "会社認証が必要" : "会社未選択";
  };
  const pluginItems = catalog.filter((item) => item.catalogKind === "plugin");
  const wizardItem = pluginItems.find((item) => item.id === authWizardPluginId)
    ?? pluginItems.find((item) => {
      const ref = matchingConnection(item);
      const catalogOnly = item.catalogSource === "recommended" || item.status === "catalog_available";
      return catalogOnly || !ref || integrationStatusBadge(ref).label !== "verified";
    })
    ?? pluginItems[0]
    ?? null;
  const buildPluginAuthSteps = (item: CapabilityItem & { catalogKind: string }) => {
    const ref = matchingConnection(item);
    const catalogOnly = item.catalogSource === "recommended" || item.status === "catalog_available";
    const companySelected = Boolean(selectedCompanyId);
    const companyVerified = Boolean(ref && integrationStatusBadge(ref).label === "verified");
    const authUrls = pluginAuthUrls[item.id] ?? [];
    const actionableAuthUrls = authUrls.filter(isActionablePluginAuthUrl);
    const authSurfaceBlocker = authUrls.length > 0 && actionableAuthUrls.length === 0
      ? pluginAuthUrlBlocker(authUrls[0]) ?? "official_auth_surface_not_actionable"
      : null;
    const registryPlugin = (zeaburRegistry?.pluginRegistry?.installed ?? []).find((plugin) => (plugin.name ?? "").trim().toLowerCase() === item.name.trim().toLowerCase());
    const registryVerified = Boolean(registryPlugin?.authStatus === "verified" || zeaburRegistry?.connectorAuth?.[item.name.trim().toLowerCase()] === "verified");
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
        detail: !companySelected ? "会社選択後に進めます。" : catalogOnly ? "公式Codex App Serverへ追加します。" : "Pluginは追加済みです。"
      },
      {
        key: "oauth",
        label: "公式認証を承認",
        status: !companySelected || catalogOnly ? "pending" : companyVerified || registryVerified ? "done" : authSurfaceBlocker ? "blocked" : authUrls.length > 0 || busy ? "active" : "active",
        detail: companyVerified ? "公式認証と会社scopeの検証済みreadbackがあります。" : registryVerified ? "公式Provider側の認証済みreadbackがあります。下でAOSの会社scopeへ紐付けます。" : authSurfaceBlocker ? "Providerから接続・承認操作のない詳細ページだけが返されたため停止しています。" : authUrls.length > 0 ? "下の公式認証リンクを開き、必要な承認を画面で完了してください。" : "「公式認証を開始」を押して認証URLを発行します。"
      },
      {
        key: "scope",
        label: "会社scopeを検証",
        status: !companySelected || catalogOnly ? "pending" : companyVerified ? "done" : authSurfaceBlocker ? "blocked" : ref ? "active" : "pending",
        detail: companyVerified ? "会社scopeの接続参照が検証済みです。" : authSurfaceBlocker ? "認証操作が提供されるまで会社scopeのreadbackは開始しません。" : ref ? "承認後に「認証状態を再確認」で会社scopeを読み直します。" : "公式認証後に会社scopeのreadbackを確認します。"
      }
    ];
    const completed = steps.filter((step) => step.status === "done").length;
    return { steps, completed, complete: companySelected && !catalogOnly && companyVerified, ref, catalogOnly, authUrls, actionableAuthUrls, authSurfaceBlocker, registryVerified };
  };
  const pollPluginAuthReadback = async (item: CapabilityItem & { catalogKind: string }) => {
    if (!selectedCompanyId) return;
    const generation = (pluginAuthPollGeneration.current[item.id] ?? 0) + 1;
    pluginAuthPollGeneration.current[item.id] = generation;
    setPluginAuthPoll((current) => ({
      ...current,
      [item.id]: { status: "polling", attempt: 0, exactBlocker: null }
    }));
    const maxAttempts = 20;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (pluginAuthPollGeneration.current[item.id] !== generation) return;
      try {
        const [connectionsResponse, registryResponse] = await Promise.all([
          mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/connection-account-refs`, { cache: "no-store" }),
          mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/connector-registry`, { cache: "no-store" })
        ]);
        const connectionsBody = await connectionsResponse.json().catch(() => ({}));
        const registryBody = await registryResponse.json().catch(() => ({}));
        if (!connectionsResponse.ok || !connectionsBody.ok) throw new Error(connectionsBody.error ?? "company_connection_inventory_read_failed");
        if (!registryResponse.ok || !registryBody.registry) throw new Error(registryBody.exactBlocker ?? registryBody.error ?? "zeabur_connector_registry_read_failed");
        const refs = Array.isArray(connectionsBody.refs) ? connectionsBody.refs : [];
        const registry = registryBody.registry as ZeaburConnectorRegistryReadback;
        setAccountRefs(refs);
        setAccountRefsStatus("ready");
        setZeaburRegistry(registry);
        setZeaburRegistryStatus("ready");
        setPluginAuthPoll((current) => ({
          ...current,
          [item.id]: { status: "polling", attempt, exactBlocker: registry.exactBlocker ?? null }
        }));
        const itemName = item.name.trim().toLowerCase();
        const matchingRef = refs.find((ref: any) => {
          const platform = String(ref.platform ?? "").toLowerCase();
          return platform && (itemName === platform || itemName.includes(platform) || (platform === "drive" && itemName.includes("google-drive")) || (platform === "calendar" && itemName.includes("google-calendar")) || (platform === "mail" && itemName.includes("gmail")));
        });
        const verifiedRef = Boolean(matchingRef && integrationStatusBadge(matchingRef).label === "verified");
        const registryPlugin = (registry.pluginRegistry?.installed ?? []).find((plugin) => (plugin.name ?? "").trim().toLowerCase() === itemName);
        const registryVerified = registryPlugin?.authStatus === "verified" || registry.connectorAuth?.[itemName] === "verified";
        // The remote registry proves the Codex App Server connector state, but
        // it is not the company-scoped AOS connection inventory. Do not let a
        // registry-only result unlock the company auth gate.
        if (verifiedRef) {
          setPluginAuthPoll((current) => ({
            ...current,
            [item.id]: { status: "verified", attempt, exactBlocker: null }
          }));
          model.setReceipt(`${item.name}: 公式認証の完了を会社scopeのfresh readbackで確認しました。`);
          return;
        }
        if (registryVerified) {
          setPluginAuthPoll((current) => ({
            ...current,
            [item.id]: { status: "polling", attempt, exactBlocker: "company_connection_ref_missing" }
          }));
        }
      } catch (error) {
        const blocker = publicBlockerSummary(error instanceof Error ? error.message : "plugin_auth_readback_failed");
        setPluginAuthPoll((current) => ({
          ...current,
          [item.id]: { status: "polling", attempt, exactBlocker: blocker }
        }));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    }
    if (pluginAuthPollGeneration.current[item.id] !== generation) return;
    setPluginAuthPoll((current) => ({
      ...current,
      [item.id]: { status: "blocked", attempt: maxAttempts, exactBlocker: "zeabur_connector_auth_not_verified" }
    }));
    model.setReceipt(`${item.name}: 公式画面は開きましたが、会社scopeのverified readbackがまだありません。認証状態は未完了として扱います。`);
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
      model.setReceipt(`${item.name}: 既に確認済みの認証不可URLは再送しません（${knownAuthSurfaceBlocker}）。Providerの接続・承認操作を含む公式認証URLが提供されるまで待ってください。`);
      return;
    }
    const existingRef = matchingConnection(item);
    const pluginId = item.id.split(":").pop() ?? item.name;
    const marketplaceName = pluginId.includes("@") ? pluginId.split("@").pop() : "openai-curated";
    setBusyToolId(item.id);
    void mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/plugins/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plugin_name: item.name, marketplace_name: marketplaceName })
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.exactBlocker ?? body.error ?? "codex_app_server_plugin_install_failed");
      await loadCompanyConnections(selectedCompanyId);
      const urls = Array.isArray(body.auth?.authorization_urls) ? body.auth.authorization_urls.filter((value: unknown): value is string => typeof value === "string" && value.length > 0) : [];
      if (urls.length > 0) {
        setPluginAuthUrls((current) => ({ ...current, [item.id]: urls.slice(0, 2) }));
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
        void pollPluginAuthReadback(item);
        model.setReceipt(opened
          ? `${item.name}: 公式認証画面を開きました。必要な承認は公式画面で完了してください。完了後は会社scopeを自動確認します。`
          : `${item.name}: 公式認証URLを用意しました。下のリンクから承認してください。完了後は会社scopeを自動確認します。`);
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
        void pollPluginAuthReadback(item);
        model.setReceipt(`${item.name}: 公式認証URLは発行されませんでした。会社scopeの再認証要求を保存しました。公式Provider側の認証後、「認証状態を再確認」を押してください。`);
        return;
      }
      model.setReceipt(`${item.name}: Zeabur Codex App ServerへのPlugin追加を完了しました。認証は不要、または認証readback待ちです。`);
    }).catch((error) => {
      model.setReceipt(`${item.name}: Plugin追加・会社認証を開始できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "plugin_install_failed")}）。`);
    }).finally(() => setBusyToolId(null));
  };
  const refreshPluginAuth = async (item: CapabilityItem & { catalogKind: string }) => {
    if (!selectedCompanyId) {
      model.setReceipt(`${item.name}: 先に会社を選択してください。`);
      return;
    }
    setAccountRefsStatus("loading");
    setZeaburRegistryStatus("loading");
    try {
      await loadCompanyConnections(selectedCompanyId);
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/codex/app-server/connector-registry`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.registry) throw new Error(body.exactBlocker ?? body.error ?? "plugin_auth_readback_failed");
      const registry = body.registry as ZeaburConnectorRegistryReadback;
      setZeaburRegistry(registry);
      setZeaburRegistryStatus("ready");
      setPluginAuthUrls((current) => ({ ...current, [item.id]: current[item.id] ?? [] }));
      pluginAuthPollGeneration.current[item.id] = (pluginAuthPollGeneration.current[item.id] ?? 0) + 1;
      const connectionsResponse = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/connection-account-refs`, { cache: "no-store" });
      const connectionsBody = await connectionsResponse.json().catch(() => ({}));
      if (!connectionsResponse.ok || !connectionsBody.ok) throw new Error(connectionsBody.error ?? "company_connection_inventory_read_failed");
      const refs = Array.isArray(connectionsBody.refs) ? connectionsBody.refs : [];
      const itemName = item.name.trim().toLowerCase();
      const matchingRef = refs.find((ref: any) => {
        const platform = String(ref.platform ?? "").toLowerCase();
        return platform && (itemName === platform || itemName.includes(platform) || (platform === "drive" && itemName.includes("google-drive")) || (platform === "calendar" && itemName.includes("google-calendar")) || (platform === "mail" && itemName.includes("gmail")));
      });
      const verifiedRef = Boolean(matchingRef && integrationStatusBadge(matchingRef).label === "verified");
      const registryPlugin = (registry.pluginRegistry?.installed ?? []).find((plugin) => (plugin.name ?? "").trim().toLowerCase() === itemName);
      const registryVerified = registryPlugin?.authStatus === "verified" || registry.connectorAuth?.[itemName] === "verified";
      // A remote connector registry and the AOS company connection inventory
      // are separate authorities. Company auth is verified only by the
      // matching, revisioned company connection reference.
      const verified = verifiedRef;
      setPluginAuthPoll((current) => ({
        ...current,
        [item.id]: { status: verified ? "verified" : "blocked", attempt: 1, exactBlocker: verified ? null : (registryVerified ? "company_connection_ref_missing" : (registry.exactBlocker ?? "zeabur_connector_auth_not_verified")) }
      }));
      model.setReceipt(`${item.name}: 認証状態と会社scopeを再確認しました。表示が「会社認証済み」になるまで外部操作は実行しません。`);
    } catch (error) {
      setZeaburRegistryStatus("error");
      model.setReceipt(`${item.name}: 認証状態を再確認できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "plugin_auth_readback_failed")}）。`);
    }
  };
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
      const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(selectedCompanyId)}/connectors/gmail/read-only-canary`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error ?? "gmail_read_only_canary_failed");
      setGmailCanary(body.readback ?? body);
      setGmailCanaryStatus("ready");
      model.setReceipt(`Gmail read-only canary: ${body.readback?.status ?? "unknown"}。Gmail本文の取得・保存はしていません。`);
    } catch (error) {
      setGmailCanary(null);
      setGmailCanaryStatus("error");
      model.setReceipt(`Gmail read-only canaryを確認できませんでした（${publicBlockerSummary(error instanceof Error ? error.message : "readback_failed")}）。`);
    }
  };
  const kindLabel = (kind: string) => ({ plugin: "Plugin", skill: "Skill", mcp: "MCP", cli: "CLI", api: "API" }[kind] ?? kind);
  const statusLabel = (item: CapabilityItem & { catalogKind: string }) => item.catalogSource === "recommended" || item.status === "catalog_available" ? "追加可能" : item.state.connected ? "接続済み" : item.state.verified ? "検証済み" : item.state.enabled ? "有効" : item.status === "missing" ? "未提供" : "要確認";
  const wizard = wizardItem ? buildPluginAuthSteps(wizardItem) : null;
  const wizardAuthPoll = wizardItem ? pluginAuthPoll[wizardItem.id] : null;
  const wizardStepLabel = (status: "done" | "active" | "pending" | "blocked") => ({ done: "完了", active: "次に実行", pending: "待機", blocked: "必要" }[status]);
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
      <PageTitle title="プラグイン / Skills / MCP / CLI" desc="会社別の接続状態と、Chatから使う優先順位を管理" />
      <Panel title="Plugin共通認証ウィザード" controlId="truthful.plugins.auth-wizard.panel">
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
                {pluginItems.map((item) => <option key={item.id} value={item.id}>{item.name} ({companyAuthStatus(item)})</option>)}
              </select>
            </label>
            <div className={`plugin-auth-wizard-summary ${wizard.complete ? "is-complete" : ""}`}>
              <strong>{wizard.complete ? "認証完了" : `${wizard.completed}/4 完了`}</strong>
              <span>{wizard.complete ? `会社「${selectedCompany?.label ?? selectedCompanyId}」で利用できます。` : selectedCompanyId ? `${wizardItem.name}を会社「${selectedCompany?.label ?? selectedCompanyId}」へ接続します。` : "まず会社を選択してください。"}</span>
            </div>
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
              disabled={!selectedCompanyId || wizard.complete || Boolean(wizard.authSurfaceBlocker) || wizard.registryVerified || busyToolId === wizardItem.id}
              onClick={() => startPluginAddAndAuth(wizardItem)}
            >
              {wizard.authSurfaceBlocker ? "認証画面待ち" : busyToolId === wizardItem.id ? "認証開始中…" : wizard.registryVerified ? "会社scopeを下で紐付け" : wizard.catalogOnly ? "Pluginを追加して認証を開始" : wizard.ref ? "公式認証を再要求" : "公式認証を開始"}
            </Button>
            <Button
              controlId="truthful.plugins.auth-wizard.refresh"
              disabled={!selectedCompanyId || busyToolId === wizardItem.id}
              onClick={() => { void refreshPluginAuth(wizardItem); }}
            >認証状態を再確認</Button>
          </div>
          {wizard.authUrls.length > 0 ? <div className="plugin-auth-links" role="status" aria-live="polite">
            <strong>{wizard.authSurfaceBlocker ? "Providerから返された詳細ページ" : "公式認証画面"}</strong>
            <p className="muted">{wizard.authSurfaceBlocker ? "このリンクには接続・承認操作がないため、認証画面として扱いません。" : "ポップアップが開かなかった場合は、以下のリンクを開いて承認してください。承認後はAOSが会社scopeを自動確認します。"}</p>
            {wizard.authUrls.map((url, index) => <a data-control-id={`truthful.plugins.auth-wizard.link.${`${wizardItem.id}-${index}`}`} key={`${wizardItem.id}:wizard-auth:${index}`} href={url} target="_blank" rel="noreferrer">{wizardItem.name} {isActionablePluginAuthUrl(url) ? "公式認証画面" : "Plugin詳細（認証操作なし）"}{wizard.authUrls.length > 1 ? ` ${index + 1}` : ""}</a>)}
          </div> : null}
          {wizardAuthPoll?.status === "polling" ? <ReadbackState title="公式認証の完了を自動確認中" detail={`会社scope・Plugin registryをfresh readbackしています（${wizardAuthPoll.attempt}/20）。認証済みとはまだclaimしていません。`} tone="info" nextAction="公式画面の承認を完了する" /> : null}
          {wizardAuthPoll?.status === "verified" ? <ReadbackState title="会社scopeのverified readbackを確認済み" detail="公式認証の完了がAOS側のfresh readbackに反映されています。" tone="success" nextAction="必要ならread-only canaryを実行する" /> : null}
          {wizardAuthPoll?.status === "blocked" ? <ReadbackState title={wizardAuthPoll.exactBlocker === "official_auth_surface_not_actionable" ? "認証画面が提供されていません" : "認証完了の反映待ち"} detail={wizardAuthPoll.exactBlocker === "official_auth_surface_not_actionable" ? "Providerから接続・承認操作のないPlugin詳細ページが返されました。AOSはPendingのpollを開始していません。" : `公式認証画面は開きましたが、AOS側にverified readbackがありません（${wizardAuthPoll.exactBlocker ?? "zeabur_connector_auth_not_verified"}）。未認証として扱います。`} tone="attention" nextAction={wizardAuthPoll.exactBlocker === "official_auth_surface_not_actionable" ? "Providerの実際の認証URLが提供されるまで待つ" : "公式画面の承認を確認してから「認証状態を再確認」を押す"} /> : null}
          {selectedCompanyId && !wizard.catalogOnly && wizard.registryVerified && !wizard.complete ? <div className="plugin-company-scope-link" role="group" aria-label="会社scopeへ紐付け">
            <p className="muted">Provider側の承認済みreadbackを確認しました。追加の再認証ではなく、AOSの会社1へ接続アカウントとscopeを紐付けます。これは秘密値ではなくアカウント参照だけを保存します。</p>
            {wizard.ref ? <p className="muted">既存の会社接続参照: <strong>{wizard.ref.account_ref ?? wizard.ref.accountRef ?? "未確認"}</strong>（現在は未verified。公式画面の同じアカウント参照を確認して入力してください）</p> : null}
            <label>公式アカウント参照（メール等）
              <input data-control-id="truthful.plugins.auth-wizard.account-ref" value={companyAccountRef} onChange={(event) => setCompanyAccountRef(event.target.value)} placeholder="例: your-account@example.com" autoComplete="email" />
            </label>
            <label>会社scope（カンマ区切り）
              <input data-control-id="truthful.plugins.auth-wizard.scopes" value={companyAccountScopes} onChange={(event) => setCompanyAccountScopes(event.target.value)} placeholder="read,write" />
            </label>
            <Button controlId="truthful.plugins.auth-wizard.link-company-scope" variant="primary" disabled={busyToolId === wizardItem.id} onClick={() => { void linkPluginCompanyScope(wizardItem); }}>{busyToolId === wizardItem.id ? "会社へ紐付け中…" : "公式認証を会社へ紐付け"}</Button>
          </div> : null}
          <p className="plugin-auth-wizard-boundary">外部効果: 認証画面を開くまで。承認・送信・データ取得は、公式画面と別のreadbackで明示確認します。</p>
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
          <div><strong>会社scope</strong><span>{toolPreference?.companyIds?.length ? toolPreference.companyIds.join(", ") : "選択会社のreadback待ち"}</span></div>
          <div><strong>fallback</strong><span>{toolPreference?.fallbackPolicy === "no_implicit_fallback" ? "黙って下位候補へ切替えない" : "未確認"}</span></div>
        </div>
        {toolPreference?.selected ? <p className="muted">現在の候補: {toolPreference.selected.label ?? "-"} / {kindLabel(toolPreference.selected.kind ?? "")} / {toolPreference.selected.status ?? "unknown"} / {toolPreference.selected.reason ?? ""}</p> : <ReadbackState title="Chatの候補をまだ確定できません" detail="依頼文と会社scopeが揃った同一Chat Runで、Plugin→同率2位候補の順に選びます。" tone="info" nextAction="会社を選択してChatから依頼する" />}
        {toolPreference?.connectorExecution ? <p className="muted">connector配置: {toolPreference.connectorExecution.owner ?? "none"} / {toolPreference.connectorExecution.status ?? "unknown"} / blocker={toolPreference.connectorExecution.exactBlocker ?? "なし"} / Mac既定面={toolPreference.connectorExecution.macWorkerDefaultSurface ?? "chrome_plugin_profile2"} / fallback={toolPreference.connectorExecution.fallbackPolicy ?? "explicit_only"}</p> : null}
      </Panel>
      <Panel title="Zeabur Codex App Server registry" controlId="truthful.plugins.zeabur-registry.panel">
        <p className="muted">Plugin/MCP/connectorの正本は接続先Codex App Serverです。AOSサイト内へPluginを移植せず、Zeabur側のfresh registry readbackだけを表示します。Mac Workerの既定実行面はChrome Plugin / Profile 2です。</p>
        {zeaburRegistryStatus === "loading" ? <ReadbackState title="Zeabur registry確認中" detail="接続先のPlugin registry・MCP設定・connector認証のreadbackを取得しています。" tone="info" nextAction="readback完了を待つ" />
          : zeaburRegistry ? <DataTable controlId="truthful.plugins.zeabur-registry.readback" headers={["項目", "値"]} rows={[
            ["service", zeaburRegistry.target?.serviceName ?? "codex-app-server"],
            ["runtime / Codex login", `${zeaburRegistry.appServer?.runtimeStatus ?? "unknown"} / ${zeaburRegistry.appServer?.codexLogin ?? "unknown"}`],
            ["installed Plugin", (zeaburRegistry.pluginRegistry?.installed ?? []).map((item) => `${item.name ?? "-"} (${item.authStatus ?? "unknown"})`).join(", ") || "なし"],
            ["available Plugin", (zeaburRegistry.pluginRegistry?.available ?? []).length
              ? `${(zeaburRegistry.pluginRegistry?.available ?? []).slice(0, 24).map((item) => item.name ?? "-").join(", ")}${(zeaburRegistry.pluginRegistry?.available ?? []).length > 24 ? " …" : ""}`
              : "なし"],
            ["MCP registry", `${zeaburRegistry.mcpRegistry?.configuredCount ?? 0} configured / verified=${String(zeaburRegistry.mcpRegistry?.verified ?? false)}`],
            ["Gmail / Supabase auth", `${zeaburRegistry.connectorAuth?.gmail ?? "unknown"} / ${zeaburRegistry.connectorAuth?.supabase ?? "unknown"}`],
            ["exact blocker", zeaburRegistry.exactBlocker ?? "なし"],
          ]} /> : <ReadbackState title="Zeabur registryを確認できません" detail="AOSは接続先registryの証拠がない限り、Plugin/MCP/connectorを実行可能とは表示しません。Mac connectorへも暗黙fallbackしません。" tone="attention" nextAction="Zeabur側のregistry readback syncを設定する" />}
      </Panel>
      <Panel title="専用Codexサービス認証" controlId="truthful.plugins.codex-auth.panel">
        <p className="muted">専用Codex App Serverの認証だけを開始します。パスワード・OTP・CAPTCHA・デバイスコードはブラウザ上でユーザーが入力し、AOSは秘密値を保存しません。</p>
        {codexAuthStatus === "loading" ? <ReadbackState title="Codex認証状態を確認中" detail="常駐AOSサービスが保持する同一App Server接続を確認しています。" tone="info" nextAction="readback完了を待つ" />
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
                  ? "表示されたコードをユーザーが公式画面へ入力（入力後は自動確認）"
                  : "認証フローを開始して表示コードを発行"],
            ["認証状態の確認", codexAuth?.status === "pending" ? "5秒ごとに公式statusを再確認" : codexAuthVerified ? "認証済み（自動確認は完了）" : "必要時のみ再確認"],
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
      <Panel title="Gmail read-only canary" controlId="truthful.plugins.gmail-canary.panel">
        <p className="muted">AOSはGmail本文を取得・保存しません。Codex App Server / MCPの接続・会社scope・Plugin優先ルールだけを確認するadmissionです。provider receiptはまだ発行しません。</p>
        <div className="button-row">
          <Button controlId="truthful.plugins.gmail-canary.run" variant="primary" disabled={!selectedCompanyId || gmailCanaryStatus === "loading"} onClick={() => { void runGmailCanary(); }}>{gmailCanaryStatus === "loading" ? "確認中…" : "read-only canaryを確認"}</Button>
          <span className="muted">外部効果: false / data read: false / data persisted: false</span>
        </div>
        {gmailCanary ? <DataTable controlId="truthful.plugins.gmail-canary.readback" headers={["項目", "値"]} rows={[
          ["status", gmailCanary.status ?? "unknown"],
          ["company", gmailCanary.companyId ?? selectedCompanyId ?? "-"],
          ["selected tool", gmailCanary.selectedTool ? `${gmailCanary.selectedTool.label ?? "-"} / ${gmailCanary.selectedTool.kind ?? "-"} / ${gmailCanary.selectedTool.status ?? "-"}` : "なし"],
          ["exact blocker", gmailCanary.exactBlocker ?? "なし"],
          ["external_action_executed", String(gmailCanary.externalActionExecuted ?? false)],
          ["data read / persisted", `${String(gmailCanary.dataRead ?? false)} / ${String(gmailCanary.dataPersisted ?? false)}`],
          ["next action", gmailCanary.nextAction ?? "-"],
        ]} /> : <ReadbackState title="canary未実行" detail="会社を選択してread-only admissionを実行すると、同一時点の接続境界だけを表示します。" tone="info" nextAction="会社scopeを選び、canaryを確認する" />}
      </Panel>
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
      </Panel>
      <Panel title={`利用できるツール (${filteredCatalog.length})`} controlId="truthful.plugins.catalog.panel">
        {filteredCatalog.length ? <div className="plugin-grid">
          {filteredCatalog.map((item) => {
            const ref = matchingConnection(item);
            const catalogOnly = item.catalogSource === "recommended" || item.status === "catalog_available";
            const canAuth = item.catalogKind === "plugin" && !catalogOnly;
            const auth = item.catalogKind === "plugin" ? buildPluginAuthSteps(item) : null;
            return <article className="plugin-card" key={`${item.catalogKind}:${item.id}`} data-control-id={`truthful.plugins.card.${item.id}`}>
              <div className="plugin-card-heading"><span className="plugin-icon">{item.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.name}</strong><span>{kindLabel(item.catalogKind)} / {item.kind}</span></div><StatusBadge status={item.state.connected ? "enabled" : item.state.verified ? "approved" : item.status === "missing" ? "blocked" : "draft"} label={statusLabel(item)} /></div>
              <p className="muted">{item.path}</p>
              <p className="plugin-auth">{companyAuthStatus(item)}{ref?.last_verified_at ? ` / ${ref.last_verified_at}` : ""}</p>
              {auth ? <div className="plugin-card-progress"><strong>共通認証 {auth.completed}/4</strong><span>{auth.complete ? "認証完了" : auth.steps.find((step) => step.status === "active" || step.status === "blocked")?.label ?? "確認待ち"}</span></div> : null}
              <div className="button-row">
                {catalogOnly && <Button controlId={`truthful.plugins.add-auth.${item.id}`} variant="primary" disabled={!selectedCompanyId || busyToolId === item.id} onClick={() => startPluginAddAndAuth(item)}>{busyToolId === item.id ? "認証開始中…" : "追加して認証"}</Button>}
                {canAuth && <Button controlId={`truthful.plugins.auth.${item.id}`} variant="primary" disabled={!selectedCompanyId || busyToolId === item.id} onClick={() => startPluginAddAndAuth(item)}>{busyToolId === item.id ? "認証開始中…" : ref ? "再認証を要求" : "追加して認証"}</Button>}
                {auth && <Button controlId={`truthful.plugins.auth-wizard.${item.id}`} onClick={() => setAuthWizardPluginId(item.id)}>認証手順</Button>}
                <Button controlId={`truthful.plugins.details.${item.id}`} onClick={() => model.setReceipt(`${item.name}: ${item.catalogKind} inventoryを表示中。実行・外部効果はありません。`)}>詳細</Button>
              </div>
            </article>;
          })}
        </div> : <ReadbackState title="一致するツールがありません" detail="現在のCodex inventoryにないPluginを接続済みとは表示しません。" tone="attention" nextAction="検索条件を変えるか、Codex側のPlugin/MCP inventoryを更新する" />}
      </Panel>
      <Panel title="Codex surface readback" controlId="truthful.plugins.surfaces.panel">
        {surfaces.length ? <DataTable controlId="truthful.plugins.surfaces.table" headers={["Surface", "Kind", "Status", "Configured", "Enabled", "Connected"]} rows={surfaces.map((surface) => [surface.name, surface.kind, getCapabilitySurfaceStatus(surface), getCapabilitySurfaceState(surface).configured ? "yes" : "no", getCapabilitySurfaceState(surface).enabled ? "yes" : "no", getCapabilitySurfaceState(surface).connected ? "yes" : "no"])} /> : <ReadbackState title="Capability readbackがありません" detail="静的なPlugin候補や、接続済みに見える状態は表示していません。現在は機能の存在ではなく、検証済みのsurfaceだけを正本とします。" tone="attention" nextAction="Codex surfaceのfresh readbackを取得する" />}
      </Panel>
      <Panel title="Chrome Extension readback" controlId="truthful.plugins.chrome.panel">
        {selectedBackend !== "chrome_plugin" ? <ReadbackState title="Chrome Pluginは現在の選択面ではありません" detail={`現在の選択backend=${selectedBackend ?? "未確認"}。Chrome Pluginのreadbackを実行面として表示していません。`} tone="info" nextAction="Adminのbackend設定と次回run開始時のbindingを確認する" />
          : chromeReadback ? <><p>Chrome Plugin / Profile 2: {publicBrowserUseRuntimeStatus(runtime)} / blocker={chromeReadbackBlocker ?? "なし"}</p><p className="muted">status={chromeReadback.status ?? "unknown"} / refresh={chromeReadback.refreshStatus ?? "unknown"} / captured={chromeReadback.capturedAt ?? "未確認"} / {publicBrowserUseRuntimeNextCheck(runtime)}</p></>
          : <ReadbackState title="Chrome Extensionのreadbackがありません" detail="選択backendはChrome Pluginですが、Profile 2のruntime readbackがありません。推測で接続済みとは表示しません。" tone="attention" nextAction="Chrome Plugin trusted bridgeとProfile 2のfresh readbackを確認する" />}
      </Panel>
    </section>
  );
}

function TruthfulProductionStatusPage({ model }: { model: AppModel }) {
  const readiness = model.mvpState.production_readiness_readback;
  const browser = model.mvpState.browserHealth;
  const workerSummary = workerStatusSummary(model.mvpState.worker);
  const readinessRows = readiness && typeof readiness === "object"
    ? Object.entries(readiness).filter(([key]) => ["status", "production_ready", "goal_complete", "blocker", "next_action", "checked_at", "source"].includes(key)).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value ?? "-")])
    : [];
  return (
    <section>
      <PageTitle title="本番状態" desc="現在のAPI readback。deployや外部検証は実行しません。" />
      <div className="cards four">
        <MetricCard controlId="truthful.production.metric.persistence" title="Persistence" value={String(model.mvpState.persistence?.adapter ?? "未確認")} sub="現在のAPI readback" status={model.mvpState.persistence?.adapter ? "enabled" : "waiting"} />
        <MetricCard controlId="truthful.production.metric.worker" title="Worker" value={model.mvpState.worker?.status ?? "未確認"} sub={`${workerSummary.label} / ${workerSummary.freshness}`} status={model.mvpState.worker?.heartbeat_fresh ? "enabled" : model.mvpState.worker?.readback_status === "stored" ? "draft" : "blocked"} />
        <MetricCard controlId="truthful.production.metric.chrome" title="Chrome lane" value={publicChromeLaneStatus(browser?.chromeExtension)} sub={publicChromeLaneBlocker(browser?.chromeExtension)} status={browser?.chromeExtension?.status === "ready" ? "enabled" : browser?.chromeExtension?.targetScopedAvailable === true ? "draft" : "blocked"} />
        <MetricCard controlId="truthful.production.metric.goal" title="Goal Complete" value={readiness?.goal_complete === true ? "true" : "false"} sub="readbackがtrueになるまで未完了" status={readiness?.goal_complete === true ? "approved" : "blocked"} />
      </div>
      <Panel title="Production readiness readback" controlId="truthful.production.readback.panel">{readinessRows.length ? <DataTable controlId="truthful.production.readback.table" headers={["項目", "値"]} rows={readinessRows} /> : <ReadbackState title="Production readinessを確認できません" detail="過去の固定Run IDや確認件数は現在値として表示していません。本番準備完了とは扱いません。" tone="attention" nextAction="承認済みrevisionとfresh production readbackを取得する" />}</Panel>
      <Panel title="Hard stops" controlId="truthful.production.hard-stops.panel"><CheckList items={["production deployは未実行", "外部投稿・送信・削除は未実行", "real credential / secret mutationは未実行", "production claimは実証跡が揃うまで禁止"]} /></Panel>
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
  if (!hasOwnerAdminAccess(model.mvpState)) return <ProjectUnavailablePage reason="Admin diagnosticsはOwner membershipだけが閲覧できます。" />;
  const diagnosticText = (value: unknown) => redactSensitiveText(redactDisplayPaths(JSON.stringify(value ?? {}, null, 2)));
  const runtime = model.mvpState.browser_use_runtime;
  const workerNeedsAttention = model.mvpState.worker?.heartbeat_fresh !== true || Boolean(model.mvpState.worker?.exact_blocker);
  const runtimeNeedsAttention = runtime?.status !== "verified" || Boolean(runtime?.exactBlocker);
  const adminNextAction = workerNeedsAttention
    ? { label: "Workerのheartbeatを再確認", route: "#/system/pc-status", detail: model.mvpState.worker?.exact_blocker ? publicBlockerSummary(model.mvpState.worker.exact_blocker) : "Mac Workerのfresh readbackが必要です。" }
    : runtimeNeedsAttention
      ? { label: "Chrome Pluginのreadbackを確認", route: "#/plugins", detail: runtime?.exactBlocker ? publicBlockerSummary(runtime.exactBlocker) : "選択中の実行面が未確認です。" }
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
          <div><strong>今すぐ必要なこと</strong><span>{adminNextAction.detail}</span></div>
          <Button controlId="admin.next-action.open" variant="primary" onClick={() => go(adminNextAction.route)}>{adminNextAction.label}</Button>
        </div>
        <Panel title="全automationのWeb操作バックエンド" controlId="admin.web-operation-backend.panel">
          <p className="muted">AOSのグローバル設定です。変更は次回run開始時に固定され、既存runのbackendは変更しません。Chrome plugin選択時はProfile 2を使い、対応adapterが未登録ならBrowser Use CLIへフォールバックせず停止します。</p>
          <div className="form-row">
            <label htmlFor="admin-web-operation-backend">実行面</label>
            <select id="admin-web-operation-backend" data-control-id="admin.web-operation-backend.select" aria-label="ウェブ操作バックエンド" value={backendChoice} disabled={backendSaving || status !== "ready"} onChange={(event) => setBackendChoice(event.target.value)}>
              <option value="chrome_plugin">Chrome plugin</option>
              <option value="browser_use_cli">Browser Use CLI</option>
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
      <FeedbackFixQueue feedbacks={model.feedbackReadback} state={model.mvpState} setReceipt={model.setReceipt} setFeedbackReadback={model.setFeedbackReadback} canTriage={hasOwnerAdminAccess(model.mvpState)} />
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
      || currentPath === "#/system/pc-status"
      || currentPath.endsWith("/automations")
    );
  const canRenderCachedCompanySurface = hasCachedCompanyScope
    && (currentPath === "#/projects" || currentPath === "#/projects/" || currentPath.includes("/projects/"));
  const canRenderCachedReadOnlySurface = hasCachedCompanyScope
    && (canRenderCachedCompanySurface || currentPath === "#/chat" || canRenderDegradedReadOnlySurface);
  const stateDependentRoute = currentPath !== "#/admin";
  if (stateDependentRoute && model.mvpLoadStatus !== "ready" && !canRenderCachedReadOnlySurface) {
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
      {model.mvpLoadStatus !== "ready" && <div className="action-note warning" role="status">{model.mvpLoadStatus === "degraded" ? `表示中の会社一覧は直近のsummary readbackです。詳細readbackが遅延または未完了です（blocker=${model.mvpLoadBlocker ?? "mvp_state_detail_readback_pending"}）。保存・実行は最新確認が終わるまで待機します。` : "表示中の会社一覧は直近のsummary readbackです。最新の詳細状態を確認中のため、保存・実行は最新確認が終わるまで待機します。"}</div>}
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
                  <div className="project-directory-head"><div><strong>{label}</strong><span>{role} / company scope</span></div><StatusBadge status={projectBlocked ? "blocked" : projectQueued ? "waiting" : "enabled"} label={projectBlocked ? "要確認" : projectQueued ? "実行待ち" : "監視中"} /></div>
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

function FeedbackWidget({ route, setReceipt, setMvpState, readOnlyEvidenceMode = false }: { route: string; setReceipt: (value: string) => void; setMvpState: React.Dispatch<React.SetStateAction<MvpState>>; readOnlyEvidenceMode?: boolean }) {
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
            <textarea id="feedback-panel-comment" ref={commentRef} data-control-id="feedback.panel.comment" aria-describedby="feedback-panel-comment-help" value={comment} disabled={busy || readOnlyEvidenceMode} onChange={(event) => setComment(event.target.value)} placeholder="どこが使いにくいか、期待した動き、実際の動きを書いてください。" />
          </label>
          <label className="feedback-confirm" htmlFor="feedback-panel-sensitive-confirm">
            <input id="feedback-panel-sensitive-confirm" data-control-id="feedback.panel.sensitive-confirm" type="checkbox" checked={sensitiveConfirmed} disabled={readOnlyEvidenceMode} onChange={(event) => setSensitiveConfirmed(event.target.checked)} />
            secret、password、token、本人確認コードが画面に映っていないことを確認しました
          </label>
          <p id="feedback-panel-comment-help" className="muted">{readOnlyEvidenceMode ? "read-only evidence mode: 最新のMVP state readbackが確認できるまで保存しません。" : "password、token、private key、本人確認コードが画面に映っている時は送らないでください。"}</p>
          <div className="button-row">
            <Button controlId="feedback.panel.submit" variant="primary" icon={<MessageSquare size={14} />} disabled={busy || readOnlyEvidenceMode || !sensitiveConfirmed} onClick={submit}>{busy ? "送信中..." : "送信"}</Button>
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
    return { label: status.includes("approval") ? "承認待ち" : "実行待ち", tone: "info", detail: status.includes("approval") ? "外部操作前に承認で停止しています。" : "QueueからWorkerの取得を待っています。" };
  }
  return { label: "未確認", tone: "neutral", detail: "最新のRun readbackが必要です。" };
}

function runBusinessCompletionVerified(run: any): boolean {
  if (run?.business_completion_verified === true || run?.completion_verified === true) return true;
  const metadata = parseJsonRecord(run?.metadata_json);
  return metadata.business_completion_verified === true;
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
  const workerWaiting = runtime?.status === "readback_pending" || model.mvpState.worker?.heartbeat_fresh === false;
  const workerBlocked = runtime?.status === "blocked" || Boolean(runtime?.exactBlocker) || Boolean(model.mvpState.worker?.exact_blocker);
  const waitingCount = waitingApprovalCount ?? waitingApprovals.length;
  const blockedCount = blockedRunCount ?? blockedRuns.length;
  const queuedRunCountFallback = queuedRunCount ?? queuedRuns.length;
  const workerQueueCurrentCount = typeof model.mvpState.worker?.queue_current_count === "number"
    ? Math.max(0, model.mvpState.worker.queue_current_count)
    : queuedRunCountFallback;
  const workerQueueHistoricalCount = typeof model.mvpState.worker?.queue_historical_count === "number"
    ? Math.max(0, model.mvpState.worker.queue_historical_count)
    : 0;
  const priority = waitingCount
    ? { tone: "attention" as PublicStateTone, label: "承認待ち", title: `${waitingCount}件の外部操作が承認待ちです`, detail: "承認されるまで投稿・送信・応募などの外部操作は安全に停止しています。", action: "承認キューを確認", route: "#/approvals" }
    : blockedCount
      ? { tone: "attention" as PublicStateTone, label: "要確認", title: `${blockedCount}件のRunに確認が必要です`, detail: "同じ原因のRunをまとめて確認し、外部効果が不明なものは再実行しません。", action: "要確認のRunを見る", route: "#/runs" }
      : workerBlocked
        ? { tone: "attention" as PublicStateTone, label: "Worker要確認", title: "Workerの実行経路に確認が必要です", detail: runtime?.exactBlocker ?? "Mac workerのexact blockerを確認してください。", action: "PC状態を見る", route: "#/system/pc-status" }
        : workerWaiting
          ? { tone: "info" as PublicStateTone, label: "Worker確認待ち", title: "Mac workerの同一Run readbackを待っています", detail: "現在はcontrol-planeの状態です。Workerのheartbeat、claim、receipt、source syncを別々に確認します。", action: "PC状態を見る", route: "#/system/pc-status" }
          : workerQueueCurrentCount
            ? { tone: "info" as PublicStateTone, label: "実行待ち", title: `${workerQueueCurrentCount}件がWorkerの取得を待っています`, detail: "Queue投入だけでは業務完了と扱いません。Worker claimと同一Run readbackが必要です。", action: "実行履歴を見る", route: "#/runs" }
            : workerQueueHistoricalCount
              ? { tone: "info" as PublicStateTone, label: "履歴確認", title: `履歴queue ${workerQueueHistoricalCount}件は再利用しません`, detail: "過去のqueued記録は現行実行ではありません。状態変化後に新しいidempotencyでread-only確認を行います。", action: "実行履歴を見る", route: "#/runs" }
              : { tone: "success" as PublicStateTone, label: "監視中", title: "AOSは安全な状態監視を継続しています", detail: "外部効果は明示承認と同一Runのreceiptが揃うまで実行・完了扱いにしません。", action: "自動化を確認", route: "#/projects" };
  const visibleDetail = priority.tone === "attention" && (priority.label === "Worker要確認" || priority.label === "Worker確認待ち")
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
    { label: "要確認", value: String(stopped), detail: stopped ? "今日の停止理由と次の操作を確認" : blockedCount ? `今日なし / 未解消 ${blockedCount}件` : "現在の停止Runなし", tone: stopped || blockedCount ? "attention" : "success" },
    { label: "承認待ち", value: String(waitingCount), detail: waitingCount ? "外部操作前で停止中" : "確認待ちはありません", tone: waitingCount ? "attention" : "success" },
    { label: "登録自動化", value: String(automationCount), detail: "定期実行の登録数", tone: automationCount ? "success" : "neutral" }
  ];
  return (
    <Panel title={`今日のdigest / ${jstDateLabel()}`} controlId="home.today-digest.panel">
      <div className="today-digest-grid" aria-label="今日のAOS digest">
        {metrics.map((metric) => <div className={`today-digest-item ${metric.tone}`} key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <small>{metric.detail}</small>
        </div>)}
      </div>
      <p className="today-digest-note">今日の件数はJSTのRun更新時刻を基準にしています。候補発見・キュー登録・外部効果・業務完了は別状態として扱います。</p>
    </Panel>
  );
}

function HomeCompanyBrief({ companies }: { companies: Array<{ id: string; label: string }> }) {
  const [period, setPeriod] = useState<"morning" | "evening">(() => new Date().getHours() >= 15 ? "evening" : "morning");
  const [readbacks, setReadbacks] = useState<Record<string, { status: "ready" | "error"; bundle?: any; exactBlocker?: string }>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const loadInFlightRef = useRef(false);
  const companyKey = companies.map((company) => company.id).join(",");
  const load = async (requestedPeriod = period) => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setRefreshing(true);
    setStatus("loading");
    const entries = await Promise.all(companies.map(async (company) => {
      try {
        const response = await mvpFetch(`/api/v1/companies/${encodeURIComponent(company.id)}/brief?brief_type=${requestedPeriod}&business_date=${encodeURIComponent(jstDateKey(new Date()) ?? "unknown-date")}&timezone=Asia%2FTokyo`, { cache: "no-store" });
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
  React.useEffect(() => {
    if (companies.length === 0) {
      setReadbacks({});
      setStatus("ready");
      return;
    }
    void load(period);
  }, [companyKey, period]);
  return <Panel title="会社別Brief / 朝・夜 readback" controlId="home.company-brief.panel">
    <p className="muted">会社ごとの登録automationをAOS DBから分離して読み取り、朝は当日の確認、夜は当日の結果確認に使う表示面です。通知送信や外部actionはまだ行いません。</p>
    <div className="button-row" role="group" aria-label="会社別Briefの期間">
      <Button controlId="home.company-brief.morning" variant={period === "morning" ? "primary" : "secondary"} onClick={() => setPeriod("morning")}>朝Brief</Button>
      <Button controlId="home.company-brief.evening" variant={period === "evening" ? "primary" : "secondary"} onClick={() => setPeriod("evening")}>夜Brief</Button>
      <Button controlId="home.company-brief.refresh" icon={<RefreshCw size={14} />} disabled={refreshing} onClick={() => { void load(period); }}>{refreshing ? "確認中" : "fresh readback"}</Button>
    </div>
    {status === "loading" ? <ReadbackState title="会社別Briefを確認中" detail="各会社の登録automationを同時にreadbackしています。" tone="info" nextAction="readback完了を待つ" />
      : status === "error" ? <ReadbackState title="一部の会社Briefを確認できません" detail="会社ごとのexact blockerを下に表示しています。確認できない会社の値は推測しません。" tone="attention" nextAction="会社scopeとAOS serverのhealthをfresh確認する" />
        : null}
    <div className="section-grid" data-control-id="home.company-brief.companies">
      {companies.map((company) => {
        const entry = readbacks[company.id];
        const briefCompany = entry?.bundle?.companies?.find((item: any) => item.company_id === company.id);
        const items = Array.isArray(briefCompany?.items) ? briefCompany.items : [];
        const automationItems = items.filter((item: any) => String(item?.record_id ?? "").startsWith("mvp_automation:"));
        const auxiliaryItems = Math.max(0, items.length - automationItems.length);
        return <div className="preview-box" key={company.id} data-control-id={`home.company-brief.company.${company.id}`}>
          <strong>{company.label}</strong>
          {entry?.status === "error" ? <p className="muted">readback未確認 / exact blocker={entry.exactBlocker ?? "unknown"}</p> : <>
            <p className="muted">登録automation {automationItems.length}件 / 補助readback {auxiliaryItems}件 / 状態={briefCompany?.status ?? "未確認"} / excluded={entry?.bundle?.counts?.excluded_records ?? 0}</p>
            <div data-control-id={`home.company-brief.items.${company.id}`}>
              {automationItems.length ? automationItems.map((item: any) => <div key={item.record_id} className="job-classification-note">
                <strong>{item.title}</strong><span>{item.summary}</span><small>次: {item.next_action ?? "未設定"}</small>
              </div>) : <p className="muted">表示対象の登録automationはありません。</p>}
            </div>
          </>}
        </div>;
      })}
    </div>
    <p className="muted" role="status" data-control-id="home.company-brief.boundary">source=AOS DB / read_only=true / delivery=not_attempted / external_action=false</p>
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
    <summary>Browser Use / Workerの詳細を開く</summary>
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
        <Panel title="API readback" controlId="home.api-readback.panel">
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
        <PageTitle title="ホーム" desc="summaryを表示中です。詳細readbackは未確認です。" />
        <div className="action-note warning" role="status" data-control-id="home.degraded-readback">詳細readback={model.mvpLoadBlocker ?? "pending"}。保存・送信・定期実行変更は停止中です。確認できるのはsummaryとno-effect導線だけです。</div>
        <div className="cards degraded-summary" data-control-id="home.degraded-summary">
          <MetricCard controlId="home.degraded-summary.companies" title="会社" value={`${companyOptions.length}社`} sub="summary readback" status="draft" />
          <MetricCard controlId="home.degraded-summary.runs" title="Run" value={`${runSummary.total_count ?? 0}件`} sub={`停止=${runSummary.blocked_count ?? 0}`} status="draft" />
          <MetricCard controlId="home.degraded-summary.approvals" title="承認" value={`${approvalSummary.waiting_count ?? 0}件`} sub={`期限切れ=${approvalSummary.expired_count ?? 0}`} status="draft" />
          <MetricCard controlId="home.degraded-summary.external" title="外部効果" value="未実行" sub="external_action=false" status="enabled" />
        </div>
        <Panel title="今できること" controlId="home.degraded-next.panel">
          <p className="muted">詳細状態が戻るまで、no-effectの手動確認だけを案内します。応募送信・投稿・保存・承認変更は開始しません。</p>
          <div className="button-row">
            {firstCompany && <Button controlId="home.degraded.automations" variant="primary" onClick={() => go(`#/projects/${firstCompany.id}/automations`)}>登録automation / 手動確認</Button>}
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
      sub: `active Run ${queuedRunCount} / fresh queue ${homeQueueCurrentCount} / historical ${homeQueueHistoricalCount} / blocked ${blockedRunCount}`,
      status: queuedRunCount ? "running" : blockedRunCount ? "blocked" : "enabled"
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
      <PageTitle title="ホーム" desc="すべての会社と自動化の状態を確認できます。">
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
        <Panel title="最新Runの進行" controlId="home.latest-run.panel">
          {latestRun ? <>
            <div className="latest-run-meta"><strong>{latestRun.automation_name ?? latestRun.automation_id ?? latestRun.id}</strong><span>{latestRun.id}</span></div>
            <RunTimeline run={latestRun} proofCount={proofCountForRun(latestRun, mvpState.proofs ?? [])} />
          </> : <div className="empty-state"><strong>まだRunはありません</strong><span>自動化を作ると、Queue・Worker・Proofの進行をここで確認できます。</span></div>}
        </Panel>
          <Panel title="承認待ち" controlId="home.pending-approvals.panel">
          <div className="approval-widget">
            <strong>承認待ち {waitingApprovalCount}件</strong>
            <span>{expiredApprovalCount ? `期限切れ ${expiredApprovalCount}件 / ` : ""}承認されるまで外部操作は安全に停止</span>
            <span>active Run {queuedRunCount}件 / fresh queue {homeQueueCurrentCount}件 / historical {homeQueueHistoricalCount}件</span>
            <Button controlId="home.approvals.open" variant="primary" onClick={() => go("#/approvals")}>承認キューを開く</Button>
          </div>
          </Panel>
      </div>
      <HomeCompanyBrief companies={companyOptions} />
      <details className="home-secondary-details" data-control-id="home.secondary-details">
        <summary>詳細・履歴・技術情報を開く</summary>
        <div className="home-secondary-details-body">
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
  const [plannerProgress, setPlannerProgress] = useState<PlannerProgress | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(requestedProjectId || rememberedProject());
  const [selectedAutomationId, setSelectedAutomationId] = useState("");
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
  const submittedPromptRef = useRef("");
  const plannerRequestGeneration = useRef(0);
  const plannerAbortRef = useRef<AbortController | null>(null);
  const activePlannerJobRef = useRef("");
  const createIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
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
  const selectedChatSession = chatSessions.find((session) => session.id === chatSessionId);
  const requestThreadId = selectedChatSession ? (selectedChatSession.codex_thread_id ?? "") : chatThreadId;
  const presentationProfile = mvpState.presentation_profiles?.find((profile) => profile.id === targetProject);
  const targetAutomations = (mvpState.automations ?? []).filter((automation) => String(automation.project_id ?? automation.company_id ?? "") === targetProject);
  const selectedAutomation = targetAutomations.find((automation) => automation.id === selectedAutomationId) ?? targetAutomations[0];
  const plannerAdapter = plannerReadback?.planner_adapter ?? "client_deterministic_preview";
  const plannerMode = plannerReadback?.planner_mode ?? "not_requested";
  const plannerPublicBlocker = plannerReadback?.exact_blocker ? publicBlockerSummary(plannerReadback.exact_blocker) : null;
  const chatScopeLabel = targetProject ? projectLabelFromState(mvpState, targetProject) : "未選択";
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
      void readMvpStateWithRetry("ui")
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
  const canCreatePlan = plannerReadback?.can_create === true && targetProjectIsVerified;
  const isCreateAutomationPlan = plannerReadback?.planner_operation === "create_automation";
  const isManageWorkflowPlan = plannerReadback?.planner_operation === "manage_workflow";
  const canAdjustSchedule = isManageWorkflowPlan
    && plannerReadback?.planner_mode === "ready_to_schedule"
    && targetProjectIsVerified
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
    setChatThreadId(requestThreadId);
    if (!chatSessionId) clearChatThread(selectedProjectId);
    setMessages([{ id: "welcome", role: "assistant", text: "リセットしました。前の計画や選択は引き継がず、新しい自動化として考えます。" }]);
    setReceipt("チャットをリセットしました。新しい自動化リクエストを入力できます。");
    setChatNote(`リセット完了: platform=0 / plan=false / ${actionStamp()}`);
    promptRef.current?.focus();
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
    if (!selectedAutomationId || !targetAutomations.some((automation) => automation.id === selectedAutomationId)) {
      setSelectedAutomationId(targetAutomations[0]?.id ?? "");
    }
  }, [selectedAutomationId, targetAutomations.map((automation) => automation.id).join("|")]);
  const clearVisibleConversation = (session?: ChatSessionReadback) => {
    setPrompt("");
    setRequestText("");
    submittedPromptRef.current = "";
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
  const resumeChat = (thread: ChatThreadReadback) => {
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
          // A chat adjustment must not activate a schedule that does not yet
          // have an explicit persisted enabled state. Keep an existing active
          // schedule active, but save a new/unknown schedule as paused.
          enabled: currentSchedule?.enabled === true,
          expected_revision: Number(currentSchedule?.revision ?? 1)
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.exactBlocker || body.exact_blocker || body.error || `schedule_adjust_http_${response.status}`);
      const freshState = await readMvpState("ui", { fresh: true });
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
        <Button controlId="chat.reset" icon={<RefreshCw size={14} />} onClick={resetChat} disabled={planning || creating}>会話をリセット</Button>
      </PageTitle>
      {model.mvpLoadStatus !== "ready" && canonicalProjects.length > 0 && <div className="action-note warning" role="status">
        直近のsummary readbackを表示しています。会社scopeと確認用ショートカットは使えますが、詳細readbackが完了するまで保存・実行は停止しています。
      </div>}
      <div className="chat-context" role="region" aria-label="Chatの会社scopeと状態">
        <strong>会社scope: {chatScopeLabel}</strong>
        <span data-control-id="chat.app-server.status" aria-label={`Codex App Server接続状態: ${appServerStatusLabel}`}>Codex App Server: {appServerStatusLabel}</span>
        <Button controlId="chat.app-server.probe" variant="secondary" disabled={appServerProbeLoading} onClick={() => { void probeCodexAppServer(); }}>
          {appServerProbeLoading ? "確認中" : "接続状態を確認"}
        </Button>
        <span>status: {plannerProgress ? plannerProgressLabel(chatStatus) : chatStatus}</span>
        {requestedChatContext.context && <span>context: {requestedChatContext.context}</span>}
        {requestedChatContext.runId && <span>run: {requestedChatContext.runId}</span>}
        {requestedChatContext.scheduleId && <span>schedule: {requestedChatContext.scheduleId}</span>}
        {(plannerReadback?.chat_job_id || plannerProgress?.jobId) && <span>job: {plannerReadback?.chat_job_id ?? plannerProgress?.jobId}</span>}
        {(plannerReadback?.chat_thread_id || chatThreadId || plannerProgress?.threadId) && <span>thread: {plannerReadback?.chat_thread_id ?? chatThreadId ?? plannerProgress?.threadId}</span>}
      </div>
      <label className="chat-input">
        保存先の会社
        <select data-control-id="chat.project-select" aria-label="保存先の会社" value={selectedProjectId} disabled={planning || creating || model.mvpLoadStatus !== "ready"} onChange={(event) => {
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
          <input data-control-id="chat.session-name" aria-label="新しい会話名" value={newChatSessionName} disabled={planning || creating || !targetProjectIsVerified} onChange={(event) => setNewChatSessionName(event.target.value.slice(0, 120))} placeholder="例: 週次レポート改善" />
        </label>
        <Button controlId="chat.session-create" icon={<Plus size={14} />} onClick={() => { void createNamedChatSession(); }} disabled={!newChatSessionName.trim() || planning || creating || !targetProjectIsVerified}>新しい会話を作成</Button>
      </div>
      {chatSessionId && <p className="muted chat-session-note">この会社の会話をセッション単位で分離しています。Codex App Server threadは選択中のセッションへ紐づきます。</p>}
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
      <div className="action-note" role="status" aria-live="off">{chatNote}</div>
      {plannerError && <div className="notice-row" role="alert">{plannerError}</div>}
      {presentationProfile && <div className="notice-row" role="note">
        表示プロファイル: {presentationProfile.label} / {presentationProfile.explanation ?? "このプロジェクトのreadbackに合わせて表示します。"}
      </div>}
      {mvpState.browser_use_runtime && <div className="notice-row" role="note">
        {selectedRuntimeSurfaceLabel}: {publicBrowserUseRuntimeStatus(mvpState.browser_use_runtime)} / {mvpState.browser_use_runtime.summary ?? "runtime readback待ち"} / {mvpState.browser_use_runtime.fallbackPolicy ?? "readback待ち"} / registered lanes {mvpState.browser_use_runtime.lanes?.length ?? 0}
      </div>}
      <div className={`scope-gate ${targetProjectIsVerified ? "ready" : "attention"}`} data-control-id="chat.scope-gate" role="status">
        <div><strong>{targetProjectIsVerified ? `作成対象: ${chatScopeLabel}` : "作成対象の会社を選んでください"}</strong><span>{targetProjectIsVerified ? "この会社scopeに保存・readbackします。外部効果は別承認です。" : "会社未選択のままではplanner・保存・実行に進みません。"}</span></div>
        {!targetProjectIsVerified && <Button controlId="chat.scope-gate.open-projects" onClick={() => go("#/projects")}>会社一覧を開く</Button>}
      </div>
      {Boolean(targetProject) && <Panel title="会社scopeの相談・実演準備" controlId="chat.company-consultation.panel">
        <div className="button-row">
          <span className="muted">登録元とAOSの候補をfresh readbackし、Chatで相談するための読み取り専用 projectionです。</span>
          <Button controlId="chat.company-consultation.refresh" disabled={companyConsultationRefreshing || model.mvpLoadStatus !== "ready"} onClick={() => { void loadCompanyConsultation(); }}>{companyConsultationRefreshing ? "確認中" : "最新状態を確認"}</Button>
        </div>
        {companyConsultation.status === "loading" && <p className="muted">会社scopeの候補と出所を確認しています。</p>}
        {companyConsultation.status === "error" && <p className="muted">相談projectionを確認できませんでした: {publicBlockerSummary(companyConsultation.exactBlocker)}</p>}
        {companyConsultation.status === "ready" && companyConsultation.readback && <>
          <div className="notice-row" role="status">
            <strong>選択状態: {companyConsultation.readback.selection_state === "selected" ? "会社1 / localhostを選択済み" : "未解決"}</strong>
            <span>{companyConsultation.readback.selection_state === "selected" ? "Ownerが選択した会社scopeを正本として保持しています。外部操作は別の承認・証跡ゲートです。" : "Ownerの明示判断が必要です。候補を自動推薦・確定せず、外部操作は開始しません。"}</span>
            <span>blocker: {publicBlockerSummary(companyConsultation.readback.exact_blocker)} / external_action=false</span>
          </div>
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
          <p className="muted">Chat相談={companyConsultation.readback.chat.consultation_available ? "利用可能" : "停止"} / read-only実演={companyConsultation.readback.chat.read_only_demo_available ? "利用可能" : "停止"} / company-scoped登録={companyConsultation.readback.chat.company_scoped_registration_ready ? "利用可能" : "停止"} / provider・source sync・reconciliation・cleanup=未実行</p>
          {companyConsultation.readback.snapshot?.input_fingerprint && <p className="muted">snapshot: {companyConsultation.readback.snapshot.snapshot_id ?? "未確認"} / fingerprint: {companyConsultation.readback.snapshot.input_fingerprint.slice(0, 16)}…</p>}
        </>}
      </Panel>}
      <details className="chat-advanced-diagnostics" data-control-id="chat.advanced-diagnostics">
        <summary>システム状態・Web操作の詳細を表示</summary>
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
            <p className="muted">source: {plannerAdapter} / mode: {plannerMode}{plannerPublicBlocker ? ` / ${plannerPublicBlocker}` : ""}</p>
            {plannerReadback?.tool_preference && <p className="muted">tool preference: Plugin first / MCP・CLI・API tied second / selected={plannerReadback.tool_preference.selected?.label ?? "未選択"} ({plannerReadback.tool_preference.selected?.status ?? "unknown"}) / company={plannerReadback.tool_preference.companyIds?.join(", ") || "未確認"}</p>}
            {plannerReadback?.chat_job_id && <p className="muted">job: {plannerReadback.chat_job_id} / thread: {plannerReadback.chat_thread_id ?? "未接続"} / turn: {plannerReadback.chat_turn_id ?? "未確定"}</p>}
            <p>{plannerReadback?.server_reply}</p>
            {plannerReadback?.web_operation_intake?.applicable && (
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
        : `target-bound approvalを保存しました。approval=${activeAdmission.approval_id} / worker receipt/readback待ち / external_action=false`);
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
          <div className={`job-progress-item ${todayBusinessSuccessCount === null ? "pending" : todayBusinessSuccessCount > 0 ? "success" : "attention"}`} data-control-id="job-application.progress.success"><span>今日の成功応募</span><strong>{todayBusinessSuccessCount === null ? "未確認" : `${todayBusinessSuccessCount}件`}</strong><small>{todayBusinessSuccessCount === null ? "fresh readback待ち" : "reconciled（業務完了proofあり）のみ"}</small></div>
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
    {readback.status === "loading" ? <ReadbackState title="求人digestを確認中" detail="AOS DBの候補・target admission・Sheets mirror状態を読み取っています。" tone="info" nextAction="readback完了を待つ" />
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
    : registeredFallbackItems.length ? "詳細readback待ち / no-effect手動実行のみ" : "詳細readback待ち";
  React.useEffect(() => {
    setSelectedPortableWorkflowId((current) => current && manualTargetItems.some((item) => item.id === current) ? current : (manualTargetItems[0]?.id ?? ""));
  }, [activeProject, registeredReadbackStatus, registeredReadback.automations, mvpState.registered_workflow_ids, mvpState.registered_workflows]);
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
      const response = await mvpFetch(`/api/mvp/registered-automations?project_id=${encodeURIComponent(activeProject)}`, { cache: "no-store", signal: controller.signal });
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
  React.useEffect(() => {
    setPageNote(`${projectName} 定期実行を開きました。押した操作の結果はここにも表示します / ${actionStamp()}`);
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
      <PageTitle title={projectName} desc="定期実行">
        <Button controlId="projects.job-admission.open" disabled={!activeProject || !canMutateCompany} onClick={() => go(`#/projects/${activeProject}/job-admission`)}>応募登録</Button>
        <Button controlId="projects.new" icon={<Plus size={15} />} variant="primary" disabled={!canMutateCompany} onClick={() => { setPageNote(`新規追加: チャットへ移動します / ${actionStamp()}`); go(chatHref({ companyId: activeProject, context: "project-automations" })); }}>新規追加</Button>
      </PageTitle>
      <div className="action-note" role="status">{pageNote}</div>
      {!canMutateCompany && <div className="action-note warning" role="status">この画面は直近のsummaryを先に表示しています。最新の詳細readbackが完了するまで、保存・定期実行変更・応募登録は停止しています。</div>}
      {!activeProject && <div className="action-note warning" role="status">会社を選択してから応募登録・自動化の作成を行ってください。会社IDが未確認の状態では保存や実行に進みません。</div>}
      <ProjectScopeNotice projectId={activeProject} mvpState={mvpState} />
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
              ? "詳細readback待ちですが、会社scopeで対象IDを確認済みです。no-effect手動実行だけ登録できます（外部操作は開始しません）"
              : "AOSのno-effect手動実行を登録します（外部操作は開始しません）"
            : `手動実行は停止中: ${publicBlockerSummary(selectedManualTarget.manual_trigger?.exact_blocker ?? "実行条件未確認")}`}</small>}
          {selectedManualRunReadback && <a
            data-control-id="projects.registered.quick-run.same-run-readback"
            href={`#/projects/${encodeURIComponent(activeProject)}/runs/${encodeURIComponent(selectedManualRunReadback.runId)}`}
          >同一Runを確認: status={selectedManualRunReadback.status}</a>}
        </div> : <div className="quick-action-empty" role="status">
          <strong>{registeredReadbackStatus === "loading" ? "実行対象を確認中" : "手動実行できる対象はありません"}</strong>
          <span>{registeredReadbackStatus === "loading" ? "登録済みautomationのfresh readbackを待っています。" : publicBlockerSummary(registeredReadback.exact_boundary ?? "registered_portable_workflow_not_available")}</span>
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
      <Panel title="自動化一覧" controlId="projects.automation.panel">
        <details className="home-secondary-details" data-control-id="projects.automation.details">
          <summary>保存済みautomationの詳細一覧を開く（{visibleAutomationRows.length}件）</summary>
          <div className="home-secondary-details-body">
            <DataTable controlId="projects.automation.table" headers={["タスク名", "説明", "スケジュール", "実行契約", "Lane", "最終実行", "ステータス", "操作"]} rows={visibleAutomationRows.length ? visibleAutomationRows.map((a) => [a.name, a.desc, <div data-control-id={`projects.automation.schedule.${a.id}`}><strong>{a.schedule}</strong><small>next {a.next_run_at} / version {a.schedule_version}</small></div>, <div data-control-id={`projects.automation.execution.${a.id}`}><strong>{a.execution_label}</strong><small>{a.scheduler_effect}</small></div>, displayedAutomationLane(a.lane, selectedBackend), a.last, <StatusBadge status={a.status} />, <div className="row-actions"><IconButton controlId={`projects.automation.edit.${a.id}`} label={`${a.name}を編集`} onClick={() => { setPageNote(`${a.name}: 編集画面へ移動します / ${actionStamp()}`); go(`#/projects/${activeProject}/automations/${a.id}/edit`); }}><Edit3 size={14} /></IconButton><IconButton controlId={`projects.automation.archive.${a.id}`} label={`${a.name}をアーカイブ`} disabled={Boolean(archivingId) || !canMutateCompany} onClick={() => archiveAutomation(a)}>{archivingId === a.id ? <Clock size={14} /> : <Archive size={14} />}</IconButton></div>]) : [["このプロジェクトの自動化はまだありません", "チャットから追加できます", "-", "実行契約未確認", "-", "-", <StatusBadge status="draft" />, <Button controlId="projects.automation.create" disabled={!canMutateCompany} onClick={() => { setPageNote(`作成する: チャットへ移動します / ${actionStamp()}`); go(chatHref({ companyId: activeProject, context: "project-automations" })); }}>作成する</Button>]]} />
          </div>
        </details>
      </Panel>
      {activeProject && (
        <Panel title="Codex App登録済み自動化" controlId="projects.registered.panel">
          <div className="action-note" role="status">
            <strong>{registeredSummaryLabel}</strong>
            <span>{registeredGateLabel}</span>
            <small>詳細一覧は必要な時だけ開けます。外部作用はこの画面から開始しません。</small>
            {registeredReadbackStatus === "error" && <small>確認事項: {publicBlockerSummary(registeredReadback.exact_boundary ?? "registered_automation_readback_unavailable")}。正規Bridgeのfresh readback後にread-only可否を再判定します。</small>}
            <div className="button-row compact">
              <Button controlId="projects.registered.refresh" onClick={() => { void loadRegisteredReadback(); }} disabled={registeredReadbackRefreshing || !activeProject} icon={<RefreshCw size={14} />}>{registeredReadbackRefreshing ? "再確認中" : "登録状態を再確認"}</Button>
            </div>
          </div>
          <details className="home-secondary-details" data-control-id="projects.registered.details">
            <summary>登録Automationの詳細・proof・laneを開く</summary>
            <div className="home-secondary-details-body">
              <p className="muted">{projectName}の登録6本をAOSで共通管理します。現在のAOS選択backend={publicWebOperationBackendLabel(selectedBackend)}です。Codex AppはUI/トリガー、AOSがスケジュールとRunの正本、登録workflowのcanonical laneはBrowser Use CLIとして別管理します。選択backendへの実行bindingはRun開始時に確認し、外部作用の完了はworker receipt/readbackでのみ確認します。</p>
              <DataTable
                controlId="projects.registered.table"
                headers={["名前", "状態", "Browser Use Lane", "実行クラス", "判定", "Blocker / Proof", "操作"]}
                rows={registeredReadbackStatus === "loading"
              ? [["Codex App登録自動化のreadbackを取得中", "loading", "-", "-", "-", "APIのfresh source-of-truthを待機中", <StatusBadge status="waiting" label="readback取得中" />]]
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
  const builderConfig = builderConfigForAutomationType(builderType);
  const builderKind = builderConfig.kindLabel;
  const builderTitle = `${builderKind} 自動化仕様`;
  const automationName = persistedAutomation?.name ?? builderConfig.automationName;
  const executionMode = String(persistedAutomation?.execution_mode ?? "unverified");
  const executionLabel = String(persistedAutomation?.execution_label ?? "実行契約未確認（保存のみ）");
  const schedulerEffect = String(persistedAutomation?.scheduler_effect ?? "not_configured");
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
    enabled: persistedSchedule ? persistedSchedule.enabled === true : false
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
      enabled: persistedSchedule ? persistedSchedule.enabled === true : false
    });
  }, [automationId, persistedSchedule?.revision, persistedSchedule?.kind, persistedSchedule?.expression, persistedSchedule?.timezone, persistedSchedule?.enabled, persistedSpec?.updated_at, builderDraft.schedule]);
  const saveBuilder = async () => {
    if (!builderTypeSupported) {
      noteBuilder(`未認識のautomation_type=${builderType}です。SNSとして置き換えず、正本の型を確認するまで保存しません。`);
      return;
    }
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
    if (!builderTypeSupported) {
      noteBuilder(`未認識のautomation_type=${builderType}です。定期実行の更新は未確認のまま保存しません。`);
      return;
    }
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
      setScheduleDraft({
        kind: normalizeScheduleKind(savedSchedule?.kind ?? result.schedule?.kind),
        expression: String(savedSchedule?.expression ?? result.schedule?.expression ?? ""),
        timezone: String(savedSchedule?.timezone ?? result.schedule?.timezone ?? scheduleDraft.timezone),
        enabled: savedSchedule ? savedSchedule.enabled === true : result.schedule?.enabled === true
      });
      const enabled = savedSchedule ? savedSchedule.enabled === true : result.schedule?.enabled === true;
      noteBuilder(`定期実行を${enabled ? "有効化" : "停止中の下書きとして"}保存しました。revision=${savedSchedule?.revision ?? result.schedule?.revision ?? "?"} / next=${savedSchedule?.next_run_at ?? result.schedule?.nextRunAt ?? "未計算"} / external_action=false`);
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
        <Button controlId="builder.save" onClick={saveBuilder} disabled={saving || !builderTypeSupported}>{saving ? "保存確認中" : "下書きとして保存"}</Button>
        <Button
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
        </Button>
      </PageTitle>
      <ProjectScopeNotice projectId={activeProject} mvpState={mvpState} />
      {!builderTypeSupported && <div className="notice-row" role="alert">この自動化の型（<code>{builderType}</code>）は現在のBuilderで確認できません。SNSとして表示・保存せず、正本のautomation_typeを確認してください。</div>}
      <div className="builder-grid">
        <div>
          <Panel title="基本設定" controlId="builder.basic.panel">
            <div className="form-grid">
              <label>自動化名<input data-control-id="builder.name" aria-label="自動化名" value={builderDraft.name} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, name: event.target.value }))} /></label>
              <label>プロジェクト<input data-control-id="builder.project" aria-label="プロジェクト" value={projectName} readOnly /></label>
              <label>Lane<input data-control-id="builder.lane" aria-label="Lane" value={builderDraft.lane} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, lane: event.target.value }))} /></label>
              <label>スケジュール希望（仕様メモ）<input data-control-id="builder.schedule" aria-label="スケジュール希望（仕様メモ）" value={builderDraft.schedule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, schedule: event.target.value }))} /></label>
              <label>承認ポリシー<input data-control-id="builder.approval-policy" aria-label="承認ポリシー" value={builderDraft.approval_policy} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, approval_policy: event.target.value }))} /></label>
              <label>リトライルール<input data-control-id="builder.retry-rule" aria-label="リトライルール" value={builderDraft.retry_rule} onChange={(event) => setBuilderDraft((draft) => ({ ...draft, retry_rule: event.target.value }))} /></label>
            </div>
          </Panel>
          <Panel title="ワークフロー手順" controlId="builder.steps.panel">
            {steps.map((s, i) => <div className="workflow-row" key={s}><span className="drag">::</span><strong>{i + 1}. {s}</strong><small>{enabled[i] ? "有効" : "無効"}</small></div>)}
          </Panel>
          <Panel title="定期実行の実設定" controlId="builder.schedule.panel">
            <p className="muted">仕様メモではなく、会社スコープのschedule APIへrevision付きで保存します。次回実行が未計算の場合は成功と扱いません。</p>
            <div className="form-grid">
              <label>実行種別<select data-control-id="builder.schedule.kind" aria-label="定期実行の種別" value={scheduleDraft.kind} disabled={scheduleSaving || !persistedAutomation || !builderTypeSupported} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, kind: normalizeScheduleKind(event.target.value) }))}>
                <option value="manual">手動</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="cron">Cron</option>
              </select></label>
              <label>実行式<input data-control-id="builder.schedule.expression" aria-label="定期実行の実行式" value={scheduleDraft.expression} disabled={scheduleSaving || !persistedAutomation || !builderTypeSupported || scheduleDraft.kind === "manual"} placeholder={scheduleDraft.kind === "cron" ? "0 9 * * *" : "09:00"} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, expression: event.target.value }))} /></label>
              <label>Timezone<input data-control-id="builder.schedule.timezone" aria-label="定期実行のTimezone" value={scheduleDraft.timezone} disabled={scheduleSaving || !persistedAutomation || !builderTypeSupported} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, timezone: event.target.value }))} /></label>
              <label className="checkbox-label"><input data-control-id="builder.schedule.enabled" aria-label="定期実行を有効にする" type="checkbox" checked={scheduleDraft.enabled} disabled={scheduleSaving || !persistedAutomation || !builderTypeSupported} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, enabled: event.target.checked }))} /> 有効にする（明示的に次回実行を作成）</label>
            </div>
            <div className="button-row">
              <Button controlId="builder.schedule.save" variant="primary" onClick={saveSchedule} disabled={scheduleSaving || !persistedAutomation || !builderTypeSupported}>{scheduleSaving ? "定期実行を保存中" : "定期実行を保存"}</Button>
            </div>
            <div className="action-note" role="status">{persistedAutomation ? `revision=${persistedSchedule?.revision ?? "新規(1)"} / status=${persistedSchedule?.status ?? (scheduleDraft.enabled ? "有効化前" : "停止中の下書き")} / next=${persistedSchedule?.next_run_at ?? "未計算"}` : "自動化本体を保存すると、実設定を編集できます。新規scheduleは停止中の下書きから始まります。"}</div>
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
    const normalizedStatus = String(approval.status ?? "").toLowerCase();
    const knownStatus = ["pending", "waiting", "approved", "rejected"].includes(normalizedStatus);
    const expired = isApprovalExpired(normalizedStatus, approval.expires_at);
    const executionLabel = expired
      ? "期限切れ（承認の有効期限超過）"
      : normalizedStatus === "pending" || normalizedStatus === "waiting"
        ? "承認待ち"
      : normalizedStatus === "approved"
        ? "承認済み"
        : normalizedStatus === "rejected"
          ? "却下"
          : String(approval.execution_label ?? fallbackParts[2] ?? (approval.external_action_allowed === false ? "外部操作なし" : "未確認"));
    const approvalLabel = expired
      ? "期限切れ"
      : normalizedStatus === "pending" || normalizedStatus === "waiting"
        ? "承認待ち"
      : normalizedStatus === "approved"
        ? "承認済み"
        : normalizedStatus === "rejected"
          ? "却下"
          : "要確認";
    const exactBinding = Boolean(approval.action_kind && approval.payload_hash && approval.policy_version);
    const durableBound = Boolean(approval.job_id && exactBinding);
    const portableBound = Boolean(!approval.job_id && exactBinding && approval.run_id);
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
    revision: Number(approval.decision_revision ?? 1),
    actionKind: String(approval.action_kind ?? ""),
    targetAccount: String(approval.target_account_ref_id ?? "なし"),
    payloadHash: String(approval.payload_hash ?? ""),
    policyVersion: String(approval.policy_version ?? "")
    };
  });
  const visibleApprovals = persistedApprovals.filter((approval) => approval.status === "waiting" || approval.expired || !approval.knownStatus);
  const approvedApprovals = persistedApprovals.filter((approval) => approval.status === "approved");
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
    if (!item?.id || !item.decisionEligible || !canDecideApproval) {
      setReceipt(item ? "承認状態または権限を確認できないため、承認操作を停止しました。外部送信・投稿は実行していません。" : "承認候補はありません。外部送信・投稿は実行していません。");
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
      setMvpState(result.state ?? await readMvpState("ui", { fresh: true }));
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
      <PageTitle title="承認キュー" desc="会社別の承認待ち、承認済み、期限切れを状態に応じて確認します。" />
      <div className="action-note" role="status">{approvalStatusNote || `承認候補 ${visibleApprovals.length}件 / 承認済み ${approvedApprovals.length}件 / external_action=false`}</div>
      <Panel title="Standing Approval（常時許可）の範囲" controlId="approvals.standing-approval.panel">
        <div className="action-note" role="status" data-control-id="approvals.standing-approval.readback">対象範囲: 未確認（現行の承認source readbackにStanding Approval項目がありません）</div>
        <p className="muted">常時許可の存在・対象・期限は、正規の承認sourceで確認できるまで有効とは扱いません。求人応募やその他の外部効果へ、未確認の常時許可を自動適用しません。</p>
      </Panel>
      <div className="split">
        <Panel title="承認待ち / 期限切れ" className="list-panel" controlId="approvals.list.panel">
          {visibleApprovals.length ? visibleApprovals.map((a, i) => <button data-control-id={`approvals.row.${a.id ?? i}`} key={a.id ?? a.content} className={`list-row approval-row ${i === selectedIndex ? "selected" : ""}`} onClick={() => { setSelected(i); setApprovalStatusNote(`${a.kind}: ${a.content} を選択 / ${actionStamp()}`); }}><span>{a.kind}</span><strong>{a.content}</strong><small>{a.project} / {a.lane}</small><div className="approval-facts"><span>Action: {a.actionLabel}</span><span>Target: {a.targetLabel}</span><span>状態: {a.executionLabel}</span></div><StatusBadge status={a.status} label={a.approvalLabel} /></button>) : (
            <div className="empty-state">
              <strong>{approvedApprovals.length ? `承認済み ${approvedApprovals.length}件 / 承認待ちはありません` : "承認待ちはありません"}</strong>
              <span>{approvedApprovals.length ? "承認済みのため、再度承認するボタンは表示しません。続きは対象Runのreceipt/readbackで確認します。" : "API readback上、外部操作前の確認待ちは0件です。"}</span>
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
              <div className="preview-box">{item.content} の全文プレビューです。{item.expired ? "承認期限を過ぎたため、この承認は無効です。内容を確認して必要なら新しい承認を作成してください。" : "送信前に人間が承認し、必要なら編集します。"} 外部投稿・送信・応募・公開は承認と証跡なしに実行しません。</div>
              {(item.bound || item.portableBound) && <DataTable controlId={`approvals.binding.${item.id}`} headers={["Binding", "Value"]} rows={[
                ["Binding type", item.portableBound ? "portable run/action" : "durable job"],
                ["Action", item.actionKind],
                ["Target", item.targetAccount],
                ["Payload SHA-256", item.payloadHash],
                ["Policy", item.policyVersion],
                ["Decision revision", String(item.revision)]
              ]} />}
              {editing && <label>修正メモ<textarea data-control-id="approvals.edit" aria-label="承認修正メモ" value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label>}
              {canDecideApproval && item.decisionEligible ? <div className="button-row"><Button controlId="approvals.approve" variant="primary" icon={<Check size={15} />} onClick={approveSelected}>承認</Button><Button controlId="approvals.edit-button" icon={<Edit3 size={15} />} onClick={() => { setEditing(true); setApprovalStatusNote(`${item.kind}: 編集欄を開きました / ${actionStamp()}`); setReceipt(`${item.kind} の編集欄を開きました。`); }}>編集</Button><Button controlId="approvals.reject" variant="danger" onClick={rejectSelected}>却下</Button></div> : <p className="muted" data-control-id="approvals.read-only">{item.expired ? "期限切れのため操作できません。内容を確認し、新しい承認を作成してください。" : "承認状態または会社権限を確認できないため、承認操作は表示していません。"}</p>}
            </>
          ) : (
            <>
              <h3>{approvedApprovals.length ? "承認済みです" : "承認待ちはありません"}</h3>
              <p className="muted">API readback / 承認済み {approvedApprovals.length}件 / external_action=false</p>
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
  const runs = mvpState.runs ?? [];
  const jobs = mvpState.jobs ?? [];
  const proofs = mvpState.proofs ?? [];
  const route = useRoute();
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [blockerFilter, setBlockerFilter] = useState(() => {
    const query = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
    return safeRouteValue(new URLSearchParams(query).get("blocker"), 240);
  });
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
    if (statusFilter === "active") return isRunActiveStatus(run.status);
    if (statusFilter === "blocked") return isRunStoppedStatus(run.status);
    if (statusFilter === "completed") return isRunCompletedStatus(run.status);
    return true;
  };
  const blockerMatches = (run: any) => !blockerFilter || runBlockerFilterKey(run, mvpState) === blockerFilter;
  const publicRunHistoryBlocker = (run: any) => publicRunBlockerSummary(run, mvpState) || publicRunBlockerSummary(run);
  const filteredRuns = runs.filter((run) => statusMatches(run) && (projectFilter === "all" || projectForRun(run) === projectFilter) && blockerMatches(run));
  const activeRuns = runs.filter((run) => isRunActiveStatus(run.status));
  const activeRunsForProject = activeRuns.filter((run) => projectFilter === "all" || projectForRun(run) === projectFilter);
  const blockedRuns = runs.filter((run) => isRunStoppedStatus(run.status));
  const stoppedRuns = blockedRuns;
  const completedRuns = runs.filter((run) => isRunCompletedStatus(run.status));
  const blockerOptions = [...new Map(blockedRuns.map((run) => [runBlockerFilterKey(run, mvpState), blockerGroupLabel(run, mvpState)]))].sort((a, b) => a[1].localeCompare(b[1], "ja"));
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
  const selectedJobRole = projectOptionsFromState(mvpState).find((company) => company.id === selectedJobCompanyId)?.role ?? "viewer";
  const canMutateJob = ["owner", "admin", "operator"].includes(selectedJobRole);
  const refresh = async () => {
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
    const query = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
    setBlockerFilter(safeRouteValue(new URLSearchParams(query).get("blocker"), 240));
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
            ...projectOptionsFromState(mvpState).map((option) => [option.id, option.label])
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
          ["承認待ち", String((mvpState.approvals ?? []).filter((approval) => isApprovalWaiting(approval.status, approval.expires_at)).length), "外部操作の前に人間確認が必要な件数"],
          ["安全境界", "外部操作なし", "投稿・送信・削除・認証・課金は承認なしに実行しません"]
        ]} />
      </Panel>
      <BlockerTriage runs={blockedRuns} collapsed />
      <div className="split">
        <Panel title="履歴" className="list-panel" controlId="runs.history.panel">
          <DataTable controlId="runs.history.table" headers={["記録", "自動化", "状態", "開始待ち", "確認事項", "記録数"]} rows={filteredRuns.slice(0, 20).map((run) => [
            <button data-control-id={`runs.row.run-link.${run.id}`} className="link-button" onClick={() => { setSelectedRunId(run.id); setActionNote(`履歴を選択しました / ${publicRunStatusForRun(run, mvpState)} / ${actionStamp()}`); }}>{run.id}</button>,
            run.automation_name ?? run.automation_id,
            <StatusBadge status={isRunCompletedStatus(run.status) ? "approved" : isReadOnlyNoEffectReadbackComplete(run, mvpState) ? "waiting" : isRunStoppedStatus(run.status) ? "blocked" : run.status === "running" ? "running" : "waiting"} label={publicRunStatusForRun(run, mvpState)} />,
            run.queued_at ?? "-",
            publicRunHistoryBlocker(run),
            String(proofCountForRun(run, proofs))
          ])} />
        </Panel>
        <aside className="side-panel wide">
          <h3>確認記録</h3>
          {selectedRun ? <p className="muted">{selectedRun.id} / {publicRunStatusForRun(selectedRun, mvpState)}{detailLoading ? " / 読込中" : ""}</p> : <p className="muted">履歴はまだありません。</p>}
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
  const workerTransportLabel = workerTransport?.heartbeatStatus === "ok"
    ? `受理済み / ${relativeAgeLabel(workerTransport.lastSuccessfulHeartbeatAt ?? workerTransport.heartbeatAt ?? null)}`
    : workerTransport?.heartbeatStatus === "blocked"
      ? `blocked / ${workerTransport.heartbeatExactBlocker ?? "transport blocker不明"}`
      : "未確認";
  const [pcNote, setPcNote] = useState("PC状態を開きました。再確認結果はここにも表示します。");
  const refresh = async () => {
    try {
      const state = await readMvpState("ui", { fresh: true });
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
        <MetricCard controlId="pc.metric.local-agent" title="Local Agent" value={workerSummary.fresh ? "heartbeat確認済み" : workerSummary.stored ? "API readback" : "要確認"} sub={`${workerSummary.nextAction} / ${workerSummary.freshness}`} status={workerSummary.fresh ? "enabled" : workerSummary.stored ? "draft" : "blocked"} />
        <MetricCard controlId="pc.metric.heartbeat" title="Heartbeat" value={workerSummary.fresh ? "fresh" : workerSummary.stored ? "未取得" : "stale"} sub={workerSummary.freshness} status={workerSummary.fresh ? "enabled" : workerSummary.stored ? "draft" : "blocked"} />
        <MetricCard controlId="pc.metric.queue" title="Queue" value={String(worker?.queue_depth ?? 0)} sub={queueDisplay} status={queueCurrentCount > 0 ? "running" : queueHistoricalCount > 0 || queueUnknownCount > 0 ? "draft" : "enabled"} />
        <MetricCard controlId="pc.metric.last-run" title="Last Run" value={worker?.last_run_id ? "あり" : "なし"} sub={worker?.last_run_id ?? "未実行"} status={worker?.last_run_id ? "enabled" : "waiting"} />
      </div>
      <Panel title="Local Agent readback" controlId="pc.readback.panel"><DataTable controlId="pc.readback.table" headers={["項目", "状態", "次に見ること"]} rows={[["接続状態", workerSummary.fresh ? "接続確認済み" : workerSummary.stored ? "API保存済み / heartbeat未確認" : "要確認", workerSummary.nextAction], ["Worker", worker?.status ?? "unknown", worker?.id ?? "unknown"], ["Queue scope", workerScope?.status ?? "未確認", `AOS=${worker?.queue_scope?.company_ids?.join(", ") || workerScope?.controlPlaneCompanyIds?.join(", ") || "未確認"} / worker=${workerScope?.remoteWorkerCompanyIds?.join(", ") || "未確認"}`], ["Heartbeat", workerSummary.freshness, workerSummary.blocker ?? (workerSummary.stored ? "Mac heartbeat未取得" : "問題なし")], ["Heartbeat transport", workerTransportLabel, workerTransport?.claimStatus === "idle" ? "claimなし。queue claim/receipt/source syncは未完了" : workerTransport?.heartbeatExactBlocker ?? "同一Runのclaim/receiptを確認"], ["Queue", String(worker?.queue_depth ?? 0), worker?.next_action ?? (worker?.queue_scope?.source === "local_sqlite" ? "ローカルSQLite queueです。remote workerの本番scopeとは別物です。" : "外部操作は各workflowの承認境界で停止")], ["Portable remote worker process", portableRemoteWorker?.status ?? "未確認", portableRemoteWorker?.status === "present" ? `effects=${portableRemoteWorker.effects ?? "unknown"}。process存在だけではheartbeat・queue claim・receipt・source syncを完了扱いにしません。` : "同一ホストprocess readbackを確認してください。"], ["Browser Use live resource", processReadback?.unregisteredBrowserProcessCount != null ? `未登録 ${processReadback.unregisteredBrowserProcessCount}件 / mismatch ${processReadback.bindingMismatchCount ?? 0}件` : "未確認", processReadback?.exactBlocker ?? workerScope?.exactBlocker ?? "登録profile/portの同一Run readbackを確認してください。"]]} /></Panel>
      <Panel title="実行中ローカルタスク" controlId="pc.running.panel"><DataTable controlId="pc.running.table" headers={["Run", "Automation", "開始時刻", "ステータス", "確認事項"]} rows={(mvpState.runs ?? []).filter((run) => isRunActiveStatus(run.status) || isRunStoppedStatus(run.status)).slice(0, 8).map((run) => [run.id, run.automation_name ?? run.automation_id, run.started_at ?? run.queued_at ?? "-", <StatusBadge status={isReadOnlyNoEffectReadbackComplete(run, mvpState) ? "waiting" : isRunStoppedStatus(run.status) ? "blocked" : run.status === "running" ? "running" : "waiting"} label={publicRunStatusForRun(run, mvpState)} />, publicRunBlockerSummary(run, mvpState)])} /></Panel>
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
