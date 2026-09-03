import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("dashboard does not turn an unverified capability into a no-blocker claim", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function publicCapabilityBlocker\(surface\?: \{ status\?: string; exactBlocker\?: string \| null \}\)/);
  assert.match(source, /if \(surface\?\.status === "ready" \|\| surface\?\.status === "available"\) return "なし"/);
  assert.match(source, /return "未確認";/);
  assert.doesNotMatch(source, /exactBlocker \?\? "none"/);
  assert.doesNotMatch(source, /exactBlocker \?\? "no blocker reported"/);
});

test("production Chrome metric separates target-scoped availability from foreground readiness", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function publicChromeLaneStatus\(surface\?: \{ status\?: string; targetScopedAvailable\?: boolean \}\)/);
  assert.match(source, /targetScopedAvailable === true && surface\.status !== "ready"/);
  assert.match(source, /target-scoped利用可/);
  assert.match(source, /foreground操作: \$\{foreground\} \/ target-scoped: 利用可/);
  assert.match(source, /targetScopedExactBlocker/);
  assert.match(source, /status=\{browser\?\.chromeExtension\?\.status === "ready" \? "enabled" : browser\?\.chromeExtension\?\.targetScopedAvailable === true \? "draft" : "blocked"\}/);
});

test("Plugin add invokes the Zeabur Codex App Server install/auth handoff", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");

  assert.match(source, /truthful\.plugins\.add-auth\.\$\{item\.id\}/);
  assert.match(source, /const startPluginAddAndAuth =/);
  assert.match(source, /codex\/app-server\/plugins\/install/);
  assert.match(source, /body\.auth\?\.authorization_urls/);
  assert.match(source, /const actionableUrls = urls\.filter\(isActionablePluginAuthUrl\)/);
  assert.match(source, /official_auth_surface_not_actionable/);
  assert.match(source, /const knownAuthUrls = pluginAuthUrls\[item\.id\] \?\? \[\]/);
  assert.match(source, /knownAuthSurfaceBlocker/);
  assert.match(source, /既に確認済みの認証不可URLは再送しません/u);
  assert.match(source, /Boolean\(wizard\.authSurfaceBlocker\)/);
  assert.match(source, /認証画面待ち/u);
  assert.match(source, /window\.open\(actionableUrls\[0\]/);
  assert.match(source, /Plugin詳細（認証操作なし）/u);
  assert.match(serverSource, /\/api\/v1\/companies\/:companyId\/codex\/app-server\/plugins\/install/);
  assert.match(serverSource, /client\.installPlugin\(/);
  assert.match(serverSource, /codex_app_server_remote_required_for_plugin_install/);
  assert.match(serverSource, /external_oauth_action_executed: false/);
});

test("Plugins screen exposes company-scope binding when provider auth is verified", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulPluginsPage");
  const end = source.indexOf("function TruthfulProductionStatusPage", start);
  assert.ok(start >= 0 && end > start, "plugins page source missing");
  const pluginsSource = source.slice(start, end);

  assert.match(pluginsSource, /const registryVerified = Boolean\(/);
  assert.match(pluginsSource, /companyVerified \|\| registryVerified \? "done"/);
  assert.match(pluginsSource, /wizard\.registryVerified && !wizard\.complete/);
  assert.match(pluginsSource, /Provider側の承認済みreadbackを確認しました。追加の再認証ではなく/u);
  assert.match(pluginsSource, /既存の会社接続参照/u);
  assert.doesNotMatch(pluginsSource, /selectedCompanyId && !wizard\.ref && !wizard\.catalogOnly/);
});

test("job target admission UI uses the API source readback instead of claiming production", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /応募対象を登録\（target-bound admission\）/);
  assert.match(source, /readback\.source_of_truth \?\? readback\.source_of_truth_backend/);
  assert.match(source, /body\.source_of_truth \?\? body\.source_of_truth_backend/);
  assert.doesNotMatch(source, /source=\{readback\.status === "ready" \? "production_aos_database"/);
  assert.doesNotMatch(source, /応募対象を本番AOSへ登録しました/);
});

test("target-bound application approval uses the portable approval route and payload", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const approve = async () => {");
  const end = source.indexOf("const field =", start);
  assert.ok(start >= 0 && end > start, "target admission approval source missing");
  const approvalSource = source.slice(start, end);

  assert.match(approvalSource, /`\/api\/mvp\/approvals\/\$\{encodeURIComponent\(activeAdmission\.approval_id\)\}`/);
  assert.match(approvalSource, /decision: "approve"/);
  assert.doesNotMatch(approvalSource, /\/api\/v1\/companies\/.*\/approvals\//);
  assert.doesNotMatch(approvalSource, /decision: "approved"/);
  assert.doesNotMatch(approvalSource, /if-match/);
});

test("target admission trigger changes idempotency after a no-effect retry", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const trigger = async () => {");
  const end = source.indexOf("const approve = async () =>", start);
  assert.ok(start >= 0 && end > start, "target admission trigger source missing");
  const triggerSource = source.slice(start, end);

  assert.match(triggerSource, /activeAdmission\.attempt/);
  assert.match(triggerSource, /activeAdmission\.idempotency_key/);
});

test("target admission registration fail-closes until fresh target evidence is complete", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const registrationBlocker = (() => {");
  const end = source.indexOf("const register = async () =>", start);
  assert.ok(start >= 0 && end > start, "target admission registration gate source missing");
  const gateSource = source.slice(start, end);

  assert.match(gateSource, /readback\.status !== "ready"/);
  assert.match(gateSource, /!form\.candidate_key\.trim\(\)/);
  assert.match(gateSource, /!form\.job_url\.trim\(\) && !form\.job_id\.trim\(\)/);
  assert.match(gateSource, /form\.resume_sha256\.trim\(\)/);
  assert.match(gateSource, /hasPayloadPair/);
  assert.match(gateSource, /hasInputBundlePair/);
  assert.match(gateSource, /Date\.parse\(form\.source_snapshot_expires_at\) <= Date\.now\(\)/);
  assert.match(source, /controlId="job-target-admission\.register"[^>]*disabled=\{Boolean\(busy\) \|\| Boolean\(registrationBlocker\)\}/);
  assert.match(source, /candidate_key: form\.candidate_key/);
  assert.match(source, /field\("candidate_key", "candidate_key", "supply ledgerのcandidate_key"\)/);
});

test("portable registered workflow controls separate read-only preflight from effectful run admission", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const requestPortableRun = async (item: any) => {");
  const end = source.indexOf("const toggleRegisteredSchedule = async", start);
  assert.ok(start >= 0 && end > start, "portable registered workflow source missing");
  const portableSource = source.slice(start, end);

  assert.match(portableSource, /if \(item\.can_run !== true\)/);
  assert.match(portableSource, /AOSキュー登録なし/);
  assert.match(portableSource, /const requestPortablePreflight = async/);
  assert.match(portableSource, /read_only_stage: "reference_readback"/);
  assert.match(source, /disabled=\{Boolean\(registeredRequestingId\) \|\| registeredReadbackStatus !== "ready" \|\| item\.can_preflight !== true\}/);
  assert.match(source, /read-only確認/);
  assert.doesNotMatch(portableSource, /fetch\(`\/api\/portable-workflows[\s\S]*?item\.can_run/);
});

test("registered manual run uses the provider-neutral no-effect trigger", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const requestManualTrigger = async (item: any) => {");
  const end = source.indexOf("const requestPortablePreflight", start);
  assert.ok(start >= 0 && end > start, "manual trigger source missing");
  const manualSource = source.slice(start, end);
  assert.match(manualSource, /registeredReadbackStatus !== "ready"/);
  assert.match(manualSource, /item\.manual_trigger\?\.available !== true/);
  assert.match(manualSource, /\/api\/v1\/companies\/\$\{encodeURIComponent\(activeProject\)\}\/automations\/\$\{encodeURIComponent\(item\.id\)\}\/trigger/);
  assert.match(manualSource, /"idempotency-key": idempotencyKey/);
  assert.match(manualSource, /execution_mode: "preflight_no_effect"/);
  assert.match(manualSource, /external_action_allowed: false/);
  assert.match(manualSource, /external_action=false/);
  assert.match(source, /selectedManualTarget\?\.manual_trigger\?\.available !== true/);
  assert.match(source, /data-control-id=\{`projects\.registered\.manual-run\.\$\{item\.id\}`\}/);
  assert.match(source, /aria-label=\{`\$\{item\.name \?\? item\.id\}: 手動実行`\}/);
  assert.match(source, /onClick=\{\(\) => requestManualTrigger\(item\)\}/);
  assert.doesNotMatch(manualSource, /item\.can_run !== true/);
});

test("registered quick actions use the same selected automation target", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function AutomationsPage");
  const end = source.indexOf("function BuilderPage", start);
  assert.ok(start >= 0 && end > start, "automation page source missing");
  const automationSource = source.slice(start, end);

  assert.match(automationSource, /data-control-id="projects\.registered\.quick-run\.select"/);
  assert.match(automationSource, /setSelectedPortableWorkflowId\(event\.target\.value\)/);
  assert.match(automationSource, /requestPortablePreflight\(selectedManualTarget\)/);
  assert.match(automationSource, /requestManualTrigger\(selectedManualTarget\)/);
  assert.match(automationSource, /aria-label="手動実行する自動化"/);
});

test("registered workflow start readback follows the selected web-operation backend", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../src/index.ts"), "utf8");
  const start = source.indexOf('app.post("/api/registered-workflows/:id/start"');
  const end = source.length;
  assert.ok(start >= 0 && end > start, "registered workflow start route missing");
  const routeSource = source.slice(start, end);
  assert.match(routeSource, /const selectedBackend = portableStarted\.webOperationBackendRunSnapshot\.web_operation_backend;/);
  assert.match(routeSource, /backend: selectedBackend\.resolved_backend/);
  assert.match(routeSource, /browser_surface: selectedBackend\.browser_surface/);
  assert.doesNotMatch(routeSource, /browser_surface:\s*"browser_use_cli"/);
});

test("registered workflow UI does not promote historical proof while read-only preflight is blocked", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const describeRegistered = (item: any) => {");
  const end = source.indexOf("const archiveAutomation", start);
  assert.ok(start >= 0 && end > start, "registered workflow description source missing");
  const describeSource = source.slice(start, end);

  assert.match(describeSource, /item\.latest_proof\?\.same_run_receipt === true/);
  assert.doesNotMatch(describeSource, /item\.can_preflight === true && item\.latest_proof/);
  assert.match(describeSource, /historical_not_current/);
  assert.match(describeSource, /read-only preflight ready/);
  assert.match(describeSource, /registeredGateSummary/);
  assert.match(source, /effectful gate=blocked/);
  assert.match(source, /item\.latest_proof\?\.same_run_receipt === true \? "approved" : "blocked"/);
  assert.match(source, /proof=historical_not_current/);
  assert.match(source, /read-only preflight=admitted/);
});

test("registered workflow UI separates manual no-effect availability from effectful blocker", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const registeredGateSummary = (item: any) => {");
  const end = source.indexOf("const describeRegistered", start);
  assert.ok(start >= 0 && end > start, "registered gate summary source missing");
  const gateSource = source.slice(start, end);
  assert.match(gateSource, /item\.manual_trigger\?\.available === true/);
  assert.match(gateSource, /manual no-effect=available/);
  assert.match(gateSource, /manual no-effect=blocked/);
  assert.match(gateSource, /return `\$\{preflight\} \/ \$\{manual\} \/ \$\{effectful\}`/);
});

test("registered manual trigger preserves trigger success and performs one same-run readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("const requestManualTrigger = async (item: any) => {");
  const end = source.indexOf("const requestPortablePreflight", start);
  assert.ok(start >= 0 && end > start, "manual trigger source missing");
  const manualSource = source.slice(start, end);
  assert.match(manualSource, /fetchApiJson<RunDetail>\(`\/api\/runs\/\$\{encodeURIComponent\(runId\)\}`\)/);
  assert.match(manualSource, /same-run readback=PENDING_CONFIRMATION/);
  assert.match(manualSource, /setRegisteredRunReadbacks/);
  assert.match(source, /data-control-id="projects\.registered\.quick-run\.same-run-readback"/);
  assert.match(source, /同一Runを確認: status=/);
});

test("registered workflow UI distinguishes readback loading from unavailable", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.match(source, /registeredReadbackStatus.*loading/);
  assert.match(source, /Codex App登録自動化のreadbackを取得中/);
  assert.match(source, /registered_automation_readback_timeout/);
  assert.match(source, /status=\{registeredReadbackStatus\}/);
  assert.match(source, /signal: controller\.signal/);
});

test("registered automation readback has a safe manual refresh and never reuses stale admission", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function AutomationsPage");
  const end = source.indexOf("function BuilderPage", start);
  assert.ok(start >= 0 && end > start, "automation page source missing");
  const automationSource = source.slice(start, end);
  assert.match(automationSource, /const registeredReadbackRequestRef = useRef\(0\)/);
  assert.match(automationSource, /registeredReadbackAbortRef\.current\?\.abort\(\)/);
  assert.match(automationSource, /setRegisteredReadbackStatus\("loading"\)/);
  assert.match(automationSource, /setRegisteredReadback\(\{\}\)/);
  assert.match(automationSource, /controlId="projects\.registered\.refresh"/);
  assert.match(automationSource, /registeredReadbackRefreshing \? "再確認中" : "登録状態を再確認"/);
  assert.match(automationSource, /registeredReadbackStatus !== "ready" \|\| item\.can_preflight !== true/);
  assert.match(automationSource, /registeredReadbackStatus !== "ready" \|\| !item\.portable\?\.supported/);
});

test("Home first fold keeps the next action visible and collapses technical summaries", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function HomePage");
  const end = source.indexOf("function ChatPage", start);
  assert.ok(start >= 0 && end > start, "Home page source missing");
  const homeSource = source.slice(start, end);
  const detailsIndex = homeSource.indexOf('<details className="home-secondary-details"');
  const setupIndex = homeSource.indexOf("<SetupProgress", detailsIndex);
  const cardsIndex = homeSource.indexOf('<div className="cards four">', detailsIndex);
  assert.ok(detailsIndex > 0, "Home secondary details boundary missing");
  assert.ok(setupIndex > detailsIndex, "setup progress must be inside secondary details");
  assert.ok(cardsIndex > detailsIndex, "metric cards must be inside secondary details");
  const firstFold = homeSource.slice(0, detailsIndex);
  assert.match(firstFold, /<HomePriorityPanel/);
  assert.match(firstFold, /<HomeTodayDigest/);
  assert.match(firstFold, /controlId="home\.latest-run\.panel"/);
  assert.match(firstFold, /controlId="home\.pending-approvals\.panel"/);
  assert.doesNotMatch(firstFold, /<SetupProgress/);
  assert.doesNotMatch(firstFold, /className="cards four"/);
});

test("common web-operation entry point distinguishes initial state readback from missing runtime", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function WebOperationAdmissionPanel");
  const end = source.indexOf("type AppModel", start);
  assert.ok(start >= 0 && end > start, "common web operation panel source missing");
  const panelSource = source.slice(start, end);

  assert.match(panelSource, /stateReadbackPhase = model\.mvpLoadStatus === "loading"/);
  assert.match(panelSource, /API fresh source-of-truth確認中/);
  assert.match(panelSource, /API readback要確認/);
  assert.match(panelSource, /state readback: \{stateReadbackPhase\}/);
  assert.match(panelSource, /保存・実行・外部操作はまだ開始できません/);
  assert.match(panelSource, /model\.mvpLoadStatus === "ready" \? runtime\?\.surface/);
});

test("Chat runtime notice names the selected backend instead of hardcoding Browser Use", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function ChatPage");
  const end = source.indexOf("function TemplatesPage", start);
  assert.ok(start >= 0 && end > start, "Chat page source missing");
  const chatSource = source.slice(start, end);
  assert.match(chatSource, /const selectedBackend = mvpState\.web_operation_backend\?\.backend/);
  assert.match(chatSource, /const selectedRuntimeSurfaceLabel = publicWebOperationBackendLabel\(selectedBackend\)/);
  assert.match(chatSource, /\{selectedRuntimeSurfaceLabel\}: \{publicBrowserUseRuntimeStatus\(mvpState\.browser_use_runtime\)\}/);
  assert.doesNotMatch(chatSource, /Browser Use: \{publicBrowserUseRuntimeStatus/);
  assert.match(chatSource, /chat\.app-server\.probe/);
  assert.match(chatSource, /\/api\/codex\/app-server\/probe/);
  assert.match(chatSource, /external_action=\$\{externalAction\}/);
});

test("Chat reflects the fresh Codex App Server probe in its visible connection state", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function ChatPage");
  const end = source.indexOf("function TemplatesPage", start);
  assert.ok(start >= 0 && end > start, "Chat page source missing");
  const chatSource = source.slice(start, end);

  assert.match(chatSource, /appServerProbeReadback/);
  assert.match(chatSource, /appServerProbeStatus === "ok"/);
  assert.match(chatSource, /setAppServerProbeReadback\(\{ status, exactBlocker: blocker === "none" \? null : blocker, externalActionExecuted: externalAction \}\)/);
  assert.match(chatSource, /void readMvpStateWithRetry\("ui"\)/);
  assert.match(chatSource, /state readback未確認=\$\{publicBlockerSummary\(exact\)\}/);
  assert.match(chatSource, /Codex App Server接続状態: \$\{appServerStatusLabel\}/);
});

test("state-dependent routes fail closed until the initial MVP readback is ready", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function renderPage");
  const end = source.indexOf("function ProjectDirectoryPage", start);
  assert.ok(start >= 0 && end > start, "page router source missing");
  const routerSource = source.slice(start, end);

  assert.match(routerSource, /const stateDependentRoute = currentPath !== "#\/admin"/);
  assert.match(routerSource, /stateDependentRoute && model\.mvpLoadStatus !== "ready"/);
  assert.match(routerSource, /scopeLabel="MVP state"/);
  assert.match(source, /mvp_state_readback_pending/);
  assert.match(source, /mvp_state_readback_unavailable/);
});

test("No-Go blocker summaries preserve a safe exact blocker and readback phases are explicit", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.match(source, /function publicBlockerSummary\(value: unknown\)/);
  assert.match(source, /portable_remote_read_only_business_completion_proof_pending/);
  assert.match(source, /read-only確認は完了しました（外部操作なし）/);
  assert.match(source, /Mac workerのBrowser Use同一Run readback待ち（認証・画面状態は未確認）/);
  assert.match(source, /同一Runのreceiptが未確認です（外部効果は未確認）/);
  assert.match(source, /function publicRunStatusForRun\(run: any, mvpState\?: MvpState\)/);
  assert.match(source, /if \(!raw\) return "未確認"/);
  assert.match(source, /const safe = redactSensitiveText\(raw\)/);
  assert.match(source, /\["none", "no_blocker", "no blocker", "null", "undefined"\]\.includes\(normalized\)/);
  assert.match(source, /Browser is not available:/);
  assert.match(source, /現行証跡ではありません/);
  assert.match(source, /Chrome Plugin・Profile 2の接続先が現行Bridgeと一致していません/);
  assert.match(source, /Chromeのforeground接続期限切れで停止しました/);
  assert.match(source, /このRunのworker readbackだけを確認/);
  assert.match(source, /正規Bridgeのfresh readbackを確認してからread-only Runを再実行/);
  assert.match(source, /Chromeの現在タブを取得できません/);
  assert.match(source, /Profile 2で対象タブを選択してから/);
  assert.match(source, /Chromeの対象タブを読み取るためのhandle取得がタイムアウトしました/);
  assert.match(source, /手動実行の接続準備が完了していません/);
  assert.match(source, /AOS本番の認証が必要です/);
  assert.match(source, /応募アカウントが未接続です/);
  assert.match(source, /応募の対象範囲が未承認です/);
  assert.match(source, /外部応募の承認待ちです/);
  assert.match(source, /専用Codexサービスのログイン承認待ちです/);
  assert.match(source, /function runBlockerFilterKey\(run: any, mvpState\?: MvpState\)/);
  assert.match(source, /return "__chrome__"/);
  assert.match(source, /blocker=\$\{safe\}/);

  const panelSource = source.slice(source.indexOf("function WebOperationAdmissionPanel"), source.indexOf("type AppModel"));
  assert.match(panelSource, /const runtimePhase = model\.mvpLoadStatus === "loading"/);
  assert.match(panelSource, /const runtimeBlocker = runtimePhase === "loading"/);
  assert.match(panelSource, /data-readback-phase=\{runtimePhase\}/);
  assert.match(panelSource, /data-exact-blocker=\{runtimeBlocker\}/);
  assert.match(panelSource, /web_operation_runtime_readback_unverified/);
});

test("Runs exposes the same-run worker readback wait instead of a blank blocker", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.match(source, /portable_preflight_run_waiting_for_worker_readback/);
  assert.match(source, /Mac workerの同一Run readback待ち \/ 次: worker claimまたはexact blockerを確認/);
  assert.match(source, /metadata\.remote_worker_claim/);
  assert.match(source, /metadata\.portable_workflow_invocation/);
  assert.match(source, /readOnlyStage === "reference_readback"/);
});

test("Runs exposes a per-run worker company scope mismatch", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.match(source, /portable_worker_company_scope_mismatch/);
  assert.match(source, /Runの会社scopeとMac worker対象会社が不一致です \/ 次: 正本にする会社・endpointを確認してscopeを揃えてからread-only Runを開始/);
  assert.match(source, /remoteWorkerCompanyIds/);
  assert.match(source, /runCompanyScopeId\(run, mvpState\)/);
});

test("read-only evidence mode disables feedback persistence without disabling backend selection", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.match(source, /readOnlyEvidenceMode=\{mvpLoadStatus !== "ready"\}/);
  assert.match(source, /blocker=mvp_state_readback_not_ready/);
  assert.match(source, /disabled=\{busy \|\| readOnlyEvidenceMode \|\| !sensitiveConfirmed\}/);
  assert.match(source, /value="chrome_plugin"/);
  assert.match(source, /value="browser_use_cli"/);
  assert.match(source, /value="playwright"/);
  assert.match(source, /disabled=\{backendSaving \|\| status !== "ready"\}/);
  assert.doesNotMatch(source, /admin-web-operation-backend[^\n]*readOnlyEvidenceMode/);
});

test("Admin backend readback cannot be overwritten by a stale diagnostics load", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function OwnerAdminPage");
  const end = source.indexOf("function ProjectUnavailablePage", start);
  assert.ok(start >= 0 && end > start, "Owner Admin source missing");
  const adminSource = source.slice(start, end);

  assert.match(adminSource, /const loadVersionRef = useRef\(0\);/);
  assert.match(adminSource, /const loadVersion = \+\+loadVersionRef\.current;/);
  assert.match(adminSource, /if \(loadVersion !== loadVersionRef\.current\) return;/);
  assert.match(adminSource, /loadVersionRef\.current \+= 1;/);
  assert.match(adminSource, /setBackendSetting\(readback\);/);
  assert.match(adminSource, /fresh readback=ok/);
});

test("Feedback triage controls match the server Owner-only permission boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function FeedbackFixQueue");
  const end = source.indexOf("function WebOperationAdmissionPanel", start);
  assert.ok(start >= 0 && end > start, "feedback queue source missing");
  const feedbackSource = source.slice(start, end);

  assert.match(feedbackSource, /canTriage\?: boolean/);
  assert.match(feedbackSource, /if \(!canTriage\)/);
  assert.match(feedbackSource, /canTriage \? <Button controlId=\{`home\.feedback\.queue\.triage\.\$\{item\.id\}`\}/);
  assert.match(feedbackSource, /Owner専用・表示のみ/);
  assert.match(source, /canTriage=\{hasOwnerAdminAccess\(model\.mvpState\)\}/);
});

test("company automation list projects the selected backend into its lane display", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function AutomationsPage");
  const end = source.indexOf("function BuilderPage", start);
  assert.ok(start >= 0 && end > start, "company automation page source missing");
  const pageSource = source.slice(start, end);

  assert.match(pageSource, /const selectedBackend = mvpState\.web_operation_backend\?\.backend/);
  assert.match(pageSource, /displayedAutomationLane\(a\.lane, selectedBackend\)/);
});

test("initial company readback has staged loading and a bounded truthful timeout", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function ProjectUnavailablePage");
  const end = source.indexOf("function openFeedbackFor", start);
  assert.ok(start >= 0 && end > start, "company readback loading component source missing");
  const loadingSource = source.slice(start, end);

  assert.match(loadingSource, /loadingSeconds >= 8/);
  assert.match(loadingSource, /loadingSeconds >= 30/);
  assert.match(loadingSource, /data-control-id="home\.company-scope\.readback-state"/);
  assert.match(loadingSource, /古い記録や未確認のproofは表示していません/);
  assert.match(loadingSource, /read-only stateの確認に30秒以上かかっています/);
  assert.match(source, /ProjectUnavailablePage loading reason="会社一覧をAPIから確認しています。"/);
});

test("Recovery screen synchronizes its note with the current MVP readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulRecoveryPage");
  const end = source.indexOf("function TruthfulPluginsPage", start);
  assert.ok(start >= 0 && end > start, "recovery page source missing");
  const recoverySource = source.slice(start, end);

  assert.match(recoverySource, /model\.mvpLoadStatus === "ready"/);
  assert.match(recoverySource, /会社別durable job readback確認済み/);
  assert.match(recoverySource, /model\.mvpLoadStatus === "error"/);
  assert.match(recoverySource, /Recovery readback未確認/);
  assert.match(recoverySource, /external_action=false/);
  assert.match(recoverySource, /const canCancel = \["timed_out"\]/);
  assert.match(recoverySource, /照合待ちのため操作なし/);
  assert.doesNotMatch(recoverySource, /const canCancel = \["reconciliation_required", "timed_out"\]/);
});

test("Runs and Recovery do not cancel reconciliation-required jobs", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const runsSource = source.slice(source.indexOf("function RunsPage"), source.indexOf("function PcStatusPage"));
  assert.match(runsSource, /\["queued", "leased", "timed_out"\]\.includes\(selectedJob\.status\)/);
  assert.doesNotMatch(runsSource, /\["queued", "leased", "reconciliation_required", "timed_out"\]\.includes\(selectedJob\.status\)/);
});

test("Run detail does not let stored Proof imply business completion", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulRunDetailPage");
  const end = source.indexOf("function TruthfulRecoveryPage", start);
  assert.ok(start >= 0 && end > start, "run detail page source missing");
  const runDetailSource = source.slice(start, end);

  assert.match(runDetailSource, /"業務完了判定"/);
  assert.match(runDetailSource, /externalActionExecuted === false/);
  assert.match(runDetailSource, /確認記録はreadbackの記録です/);
  assert.match(runDetailSource, /provider receipt・source sync・reconciliation/);
  assert.match(source, /function proofExternalActionState\(proof: any\)/);
  assert.match(runDetailSource, /const proofExternalActionExecuted = proofs/);
  assert.match(runDetailSource, /: proofExternalActionExecuted;/);
});

test("Run detail parses metadata before reading the external-effect boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulRunDetailPage");
  const end = source.indexOf("function TruthfulRecoveryPage", start);
  assert.ok(start >= 0 && end > start, "run detail page source missing");
  const runDetailSource = source.slice(start, end);
  const metadataDeclaration = runDetailSource.indexOf("const runMetadata = parseJsonRecord(run.metadata_json);");
  const metadataRead = runDetailSource.indexOf("runMetadata.external_action_executed");
  assert.ok(metadataDeclaration >= 0, "run detail must parse optional metadata safely");
  assert.ok(metadataRead > metadataDeclaration, "metadata must be declared before it is read");
});

test("Run blocker readback preserves the same-run worker receipt blocker", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const detailStart = source.indexOf("function TruthfulRunDetailPage");
  const detailEnd = source.indexOf("function TruthfulRecoveryPage", detailStart);
  assert.ok(detailStart >= 0 && detailEnd > detailStart, "run detail page source missing");
  const runDetailSource = source.slice(detailStart, detailEnd);
  assert.match(source, /function runBlockerValue\(run: any, mvpState\?: MvpState\)/);
  assert.match(source, /metadata\.remote_worker_receipt/);
  assert.match(source, /remoteReceipt\.exact_blocker/);
  assert.match(runDetailSource, /const runBlocker = runBlockerValue\(run, model\.mvpState\) \?\? "-"/);
});

test("Plugins screen projects the selected Chrome Plugin runtime readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulPluginsPage");
  const end = source.indexOf("function TruthfulProductionStatusPage", start);
  assert.ok(start >= 0 && end > start, "plugins page source missing");
  const pluginsSource = source.slice(start, end);

  assert.match(pluginsSource, /const selectedBackend = runtime\?\.backend \?\? model\.mvpState\.web_operation_backend\?\.backend/);
  assert.match(pluginsSource, /const chromeReadback = runtime\?\.chromePluginReadback/);
  assert.match(pluginsSource, /Chrome Plugin \/ Profile 2/);
  assert.match(pluginsSource, /refresh=\{chromeReadback\.refreshStatus/);
  assert.match(pluginsSource, /Chrome Pluginは現在の選択面ではありません/);
  assert.match(pluginsSource, /推測で接続済みとは表示しません/);
});

test("Plugins screen does not present a rejected device code as usable", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulPluginsPage");
  const end = source.indexOf("function TruthfulProductionStatusPage", start);
  assert.ok(start >= 0 && end > start, "plugins page source missing");
  const pluginsSource = source.slice(start, end);
  assert.match(pluginsSource, /codexAuth\?\.status === "blocked" && codexAuth\?\.exactBlocker === "codex_device_auth_failed"/);
  assert.match(pluginsSource, /前の認証コードは拒否されたため無効です/);
  assert.match(pluginsSource, /codexAuth\?\.status === "pending"/);
  assert.match(pluginsSource, /const codexAuthCodeVisible = codexAuthStatus !== "loading"/);
  assert.match(pluginsSource, /codexAuthCodeVisible \? codexAuth\?\.userCode : "未発行"/);
  assert.match(pluginsSource, /codexAuthReadGeneration\.current \+= 1/);
  assert.match(pluginsSource, /setCodexAuthConnection\(null\);/);
  assert.match(pluginsSource, /setCodexAuth\(null\);/);
});

test("Lanes distinguishes the selected backend from the registered Browser Use lane contract", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulLanesPage");
  const end = source.indexOf("function TruthfulMemoryPage", start);
  assert.ok(start >= 0 && end > start, "lanes page source missing");
  const lanesSource = source.slice(start, end);

  assert.match(lanesSource, /const selectedBackend = model\.mvpState\.web_operation_backend\?\.backend/);
  assert.match(lanesSource, /現在のAOS選択backend=\{selectedBackendLabel\}/);
  assert.match(lanesSource, /canonical browser surface=Browser Use CLI/);
  assert.match(lanesSource, /workflow-owned契約として表示しています/);
});

test("company automation registry distinguishes the selected backend from its canonical lane", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function AutomationsPage");
  const end = source.indexOf("function BuilderPage", start);
  assert.ok(start >= 0 && end > start, "Automations page source missing");
  const pageSource = source.slice(start, end);

  assert.match(pageSource, /const selectedBackend = mvpState\.web_operation_backend\?\.backend/);
  assert.match(pageSource, /現在のAOS選択backend=\{publicWebOperationBackendLabel\(selectedBackend\)\}/);
  assert.match(pageSource, /登録workflowのcanonical laneはBrowser Use CLIとして別管理/);
  assert.doesNotMatch(pageSource, /Mac workerがBrowser Use CLI\/MCPの実行層です/);
});

test("approval UI fail-closes unknown status and permission states", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const statusStart = source.indexOf("function normalizeApprovalStatus");
  const statusEnd = source.indexOf("function detectSchedule", statusStart);
  const approvalsStart = source.indexOf("function ApprovalsPage");
  const approvalsEnd = source.indexOf("function RunsPage", approvalsStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart, "approval status normalizer missing");
  assert.ok(approvalsStart >= 0 && approvalsEnd > approvalsStart, "approvals page source missing");
  const statusSource = source.slice(statusStart, statusEnd);
  const approvalsSource = source.slice(approvalsStart, approvalsEnd);

  assert.match(statusSource, /const normalized = String\(status \?\? ""\)\.toLowerCase\(\)/);
  assert.match(statusSource, /if \(normalized === "approved"\) return "approved"/);
  assert.match(statusSource, /return "blocked"/);
  assert.doesNotMatch(statusSource, /return "approved";\s*\}/);
  assert.match(approvalsSource, /const knownStatus = \["pending", "waiting", "approved", "rejected"\]\.includes/);
  assert.match(approvalsSource, /decisionEligible: knownStatus/);
  assert.match(approvalsSource, /approval\.status === "waiting" \|\| approval\.expired \|\| !approval\.knownStatus/);
  assert.match(approvalsSource, /const approvedApprovals = persistedApprovals\.filter\(\(approval\) => approval\.status === "approved"\)/);
  assert.match(approvalsSource, /承認済みのため、再度承認するボタンは表示しません/);
  assert.match(approvalsSource, /!item\.decisionEligible \|\| !canDecideApproval/);
  assert.match(approvalsSource, /承認状態または会社権限を確認できないため、承認操作は表示していません/);
});

test("Artifacts and Performance keep durable status separate from business completion", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const artifactsSource = source.slice(source.indexOf("function TruthfulArtifactsPage"), source.indexOf("function TruthfulRunDetailPage"));
  const performanceSource = source.slice(source.indexOf("function TruthfulPerformancePage"), source.indexOf("function dateInputValue"));

  assert.match(artifactsSource, /保存済みProofはreadbackの記録です/);
  assert.match(artifactsSource, /provider receipt・source sync・reconciliation/);
  assert.match(performanceSource, /durable Job statusの集計です/);
  assert.match(performanceSource, /業務完了をclaimしません/);
});

test("Builder fail-closes schedule controls for an unverified automation type", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function BuilderPage");
  const end = source.indexOf("function ApprovalsPage", start);
  assert.ok(start >= 0 && end > start, "builder page source missing");
  const builderSource = source.slice(start, end);

  assert.match(builderSource, /builder\.schedule\.kind[\s\S]*disabled=\{scheduleSaving \|\| !persistedAutomation \|\| !builderTypeSupported\}/);
  assert.match(builderSource, /builder\.schedule\.timezone[\s\S]*disabled=\{scheduleSaving \|\| !persistedAutomation \|\| !builderTypeSupported\}/);
  assert.match(builderSource, /controlId="builder\.schedule\.save"[\s\S]*disabled=\{scheduleSaving \|\| !persistedAutomation \|\| !builderTypeSupported\}/);
  assert.match(builderSource, /実行経路はまだ確認できていません。保存済み仕様を実行済みとは扱いません/);
});

test("initial UI state uses a smaller projection while normal readbacks stay full", () => {
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  assert.match(appSource, /readMvpStateWithRetry\(projection\)/);
  assert.match(appSource, /if \(projection !== "full"\) query\.set\("projection", projection\)/);
  assert.match(appSource, /query\.set\("fresh", "1"\)/);
  assert.match(serverSource, /req\.query\.projection === "summary"[\s\S]*req\.query\.projection === "ui"/);
  assert.match(serverSource, /projectMvpStateForUi\(result\.state\)/);
});

test("Chat can show a cached summary before detail readback while keeping mutations fail-closed", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /const canRenderCachedReadOnlySurface = hasCachedCompanyScope/);
  assert.match(source, /canRenderCachedCompanySurface \|\| currentPath === "#\/chat"/);
  assert.match(source, /readMvpStateWithRetry\("summary"\)[\s\S]*return readDetailState\(\)/);
  assert.match(source, /直近のsummary readbackを表示しています。会社scopeと確認用ショートカットは使えますが、詳細readbackが完了するまで保存・実行は停止しています/);
  assert.match(source, /targetProjectIsVerified = model\.mvpLoadStatus === "ready"/);
});

test("Chat detail readback uses its bounded projection instead of the broad UI fan-out", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");

  assert.match(source, /const projection = routeName === "#\/"[\s\S]*routeName === "#\/chat" \? "chat" : "ui"/);
  assert.match(source, /readMvpStateWithRetry\(projection\)/);
  assert.match(serverSource, /req\.query\.projection === "chat"[\s\S]*projection,[\s\S]*readPostgresMvpState/);
});

test("compact quick actions wrap without creating horizontal overflow", () => {
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");

  assert.match(styles, /\.button-row\.compact \{[\s\S]*?max-width: 100%;[\s\S]*?flex-wrap: wrap;/);
  assert.match(styles, /\.quick-action-row \.button-row \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 0;/);
});

test("worker readback separates persisted state age from Mac heartbeat freshness", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function relativeAgeLabel\(value: unknown\)/);
  assert.match(source, /状態記録: \$\{age\} \/ Mac heartbeat未確認/);
  assert.match(source, /heartbeat: \$\{age\} \/ stale/);
  assert.match(source, /heartbeat: \$\{age\} \/ fresh/);
  assert.match(source, /freshness: "未確認"/);
});

test("PC queue readback does not present historical queued records as current candidates", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function PcStatusPage");
  const end = source.indexOf("function TemplatesPage", start);
  assert.ok(start >= 0 && end > start, "PC status source missing");
  const pcSource = source.slice(start, end);
  assert.match(pcSource, /queue_historical_count/);
  assert.match(pcSource, /queueCurrentCount/);
  assert.match(pcSource, /historical=/);
  assert.match(pcSource, /worker\?\.next_action/);
});

test("Home priority separates current queue from historical queued records", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function HomePriorityPanel");
  const end = source.indexOf("function HomeTodayDigest", start);
  assert.ok(start >= 0 && end > start, "Home priority source missing");
  const panelSource = source.slice(start, end);
  assert.match(panelSource, /queue_current_count/);
  assert.match(panelSource, /queue_historical_count/);
  assert.match(panelSource, /履歴queue \$\{workerQueueHistoricalCount\}件は再利用しません/);
  assert.match(panelSource, /新しいidempotencyでread-only確認/);
  assert.match(source, /active Run \$\{queuedRunCount\} \/ fresh queue \$\{homeQueueCurrentCount\} \/ historical \$\{homeQueueHistoricalCount\}/);
});

test("job digest separates target, candidates, success, salary, duplicate, and cumulative proof", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function JobApplicationDigestPanel");
  const end = source.indexOf("const REGISTERED_AUTOMATION_LABELS", start);
  assert.ok(start >= 0 && end > start, "job digest source missing");
  const digestSource = source.slice(start, end);
  assert.match(digestSource, /今日の目標/);
  assert.match(digestSource, /成功応募/);
  assert.match(digestSource, /reconciledのみ/);
  assert.match(digestSource, /条件適合=/);
  assert.match(digestSource, /累計1,000件の進捗/);
  assert.match(digestSource, /給与根拠不足=/);
  assert.match(digestSource, /年収換算未確認=/);
  assert.match(digestSource, /重複除外=/);
  assert.match(digestSource, /account_ref・authority・承認・provider receipt・source sync・reconciliation・cleanup/);
});

test("job Sheet population audit is collapsed, explicit, read-only, and never auto-called", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function JobSheetPopulationAuditPanel");
  const end = source.indexOf("const REGISTERED_AUTOMATION_LABELS", start);
  assert.ok(start >= 0 && end > start, "Sheet population audit source missing");
  const auditSource = source.slice(start, end);
  assert.match(auditSource, /<details data-control-id="job-application\.sheet-population-audit\.details">/);
  assert.match(auditSource, /native Sheet readbackを入力して確認/);
  assert.match(auditSource, /controlId="job-application\.sheet-population-audit\.reload"/);
  assert.match(auditSource, /job-application-sheet-mirror-population-audit/);
  assert.doesNotMatch(auditSource, /React\.useEffect/);
  assert.doesNotMatch(auditSource, /job-application-sheet-mirror-sync/);
  assert.doesNotMatch(auditSource, /job-application\.sheet-population-audit\.(apply|repair|write|delete)/);
});

test("selected Chrome Plugin status does not inherit Browser Use process blockers", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function isChromePluginRuntime\(runtime: MvpState\["browser_use_runtime"\]\)/);
  assert.match(source, /runtime\?\.backend === "chrome_plugin"/);
  assert.match(source, /runtime\?\.surface === "signed_chrome_extension_profile2"/);
  assert.match(source, /pluginReadback\?\.status === "ready" \|\| runtime\.status === "verified"/);
  assert.match(source, /Chrome Plugin trusted bridgeとProfile 2のfresh readbackを確認/);
  assert.match(source, /Chrome Plugin authority・Profile 2・receipt・cleanup/);
});

test("company-root routes stay company-scoped instead of falling through to global Home", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.ok(source.includes("if (/^#\\/projects\\/[^/]+$/u.test(currentPath)) return <AutomationsPage model={model} />;"));
  assert.ok(!source.includes("if (/^#\\/projects\\/[^/]+$/u.test(currentPath)) return <HomePage model={model} />;"));
});

test("runs history shows stored completed runs in its initial view", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const runsSource = source.slice(source.indexOf("function RunsPage"), source.indexOf("function PcStatusPage"));

  assert.match(source, /value === "complete" \|\| value === "completed"/);
  assert.match(source, /function publicRunBlockerSummary\(run: any, mvpState\?: MvpState\)/);
  assert.match(runsSource, /const \[statusFilter, setStatusFilter\] = useState\("all"\)/);
  assert.match(runsSource, /const filteredRuns = runs\.filter\(\(run\) => statusMatches\(run\)/);
  assert.match(runsSource, /isRunCompletedStatus\(run\.status\)/);
  assert.match(runsSource, /controlId="runs\.history\.table"/);
  assert.match(runsSource, /publicRunBlockerSummary\(run, mvpState\)/);
});

test("Run timeline does not mark business completion from Run status alone", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function runBusinessCompletionVerified\(run: any\): boolean/);
  assert.match(source, /const businessCompletionVerified = runBusinessCompletionVerified\(run\);/);
  assert.match(source, /const currentIndex = businessCompletionVerified\n\s*\? 4\n\s*: \["completed", "complete", "success", "succeeded"\]\.includes\(raw\)\n\s*\? 3/);
  assert.match(source, /businessCompletionVerified \? "業務完了verified" : "業務完了未claim"/);
});

test("builder controls expose stable accessible names for browser QA and keyboard users", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  for (const label of [
    "自動化名",
    "プロジェクト",
    "Lane",
    "スケジュール希望（仕様メモ）",
    "承認ポリシー",
    "リトライルール",
    "定期実行の種別",
    "定期実行の実行式",
    "定期実行のTimezone",
    "定期実行を有効にする"
  ]) {
    assert.match(source, new RegExp(`aria-label=\\"${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\"`));
  }
  assert.match(source, /\["all", "全プロジェクト"\]/);
  assert.doesNotMatch(source, /\["all", "全Project"\]/);
});

test("performance and job admission inputs expose explicit accessible names", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /aria-label="開始日" data-control-id="truthful\.performance\.filter\.from"/);
  assert.match(source, /aria-label="終了日" data-control-id="truthful\.performance\.filter\.to"/);
  assert.match(source, /aria-label="表示対象の自動化" data-control-id="truthful\.performance\.filter\.automation"/);
  assert.match(source, /aria-label=\{label\} data-control-id=\{`job-target-admission\.\$\{key\}`\}/);
  assert.match(source, /aria-label="workflow_id" data-control-id="job-target-admission\.workflow_id"/);
  assert.match(source, /aria-label="求人対象bucket" data-control-id="job-target-admission\.bucket"/);
  assert.match(source, /id="admin-web-operation-backend"[^>]*aria-label="ウェブ操作バックエンド"/);
  assert.match(source, /disabled=\{backendSaving \|\| status !== "ready"\} onChange=\{/);
  assert.match(source, /web_operation_backend_post_save_readback_mismatch/);
  assert.match(source, /fresh readback=ok/);
});

test("initial MVP readback retries transient transport failures without hiding auth blockers", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function isRetryableMvpStateError\(error: unknown\)/);
  assert.match(source, /mvp_state_http_\(\?:408\|429\|500\|502\|503\|504\)/);
  assert.match(source, /mvp_state_request_timeout/);
  assert.match(source, /mvp_state_detail_readback_timeout/);
  assert.match(source, /const MVP_DETAIL_READBACK_TIMEOUT_MS = 20_000/);
  assert.match(source, /withMvpDetailReadbackTimeout\(readMvpStateWithRetry\(projection\)\)/);
  assert.match(source, /const readDetailState = async \(\) => \{[\s\S]*const auth = await authPromise;[\s\S]*return readDetailProjection\(\);/);
  assert.match(source, /async function readMvpStateWithRetry\(projection: "full" \| "ui" \| "summary" \| "chat" = "ui", options: \{ fresh\?: boolean \} = \{ fresh: true \}\)/);
  assert.match(source, /const state = await readMvpStateWithRetry\("ui", \{ fresh: true \}\);/);
});

test("frontend exposes one provider-neutral adaptive web operation entry point", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function WebOperationAdmissionPanel");
  const end = source.indexOf("type AppModel", start);
  assert.ok(start >= 0 && end > start, "common web operation panel source missing");
  const panelSource = source.slice(start, end);
  assert.match(panelSource, /live semantic candidate/);
  assert.match(panelSource, /固定CSS\/XPath\/DOM順は権威にしない/);
  assert.match(panelSource, /候補が0件・複数件/);
  assert.match(panelSource, /同一Runのreceipt、source-of-truth sync、cleanup/);
  assert.match(panelSource, /web-admission\.prompt-template/);
  assert.match(panelSource, /COMMON_WEB_OPERATION_PROMPT_TEMPLATE/);
  assert.match(panelSource, /サイト固有のselectorやクリック順は不要です/);
  assert.match(panelSource, /external_action=false/);
  assert.match(panelSource, /controlId="web-admission\.chat"/);
  assert.match(panelSource, /controlId="web-admission\.approvals"/);
  assert.match(source, /<WebOperationAdmissionPanel model=\{model\} \/>/);
  assert.match(source, /<WebOperationAdmissionPanel model=\{model\} projectId=\{targetProject\} \/>/);
  assert.match(source, /requestedChatContext\.context !== "web-operation-admission"/);
  assert.match(source, /setPrompt\(COMMON_WEB_OPERATION_PROMPT_TEMPLATE\)/);
  assert.match(source, /まだ外部操作は実行していません/);
  assert.match(source, /web_operation_intake/);
  assert.match(source, /chat\.web-operation-intake/);
  assert.match(source, /固定selector・XPath・DOM順は権威にせず/);
});

test("frontend exposes the workflow-owned Browser Use profile and reserved port binding without claiming a live process", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const panelSource = source.slice(source.indexOf("function WebOperationAdmissionPanel"), source.indexOf("type AppModel"));

  assert.match(panelSource, /web-admission\.lane-binding/);
  assert.match(panelSource, /web-admission\.lane-binding\.summary/);
  assert.match(panelSource, /web-admission\.lane-binding\.table/);
  assert.match(panelSource, /web-admission\.process-readback/);
  assert.match(panelSource, /web-admission\.process-readback\.table/);
  assert.match(panelSource, /profileRef/);
  assert.match(panelSource, /reservedPort/);
  assert.match(panelSource, /lifecycle/);
  assert.match(panelSource, /予約port \(AOS\)/);
  assert.match(panelSource, /実測process port/);
  assert.match(panelSource, /queue scope/);
  assert.match(panelSource, /controlPlaneCompanyIds\?\.join\(\", \"\) \|\| \"未確認\"/);
  assert.match(panelSource, /remoteWorkerCompanyIds\?\.join\(\", \"\) \|\| \"未確認\"/);
  assert.match(panelSource, /web-admission\.scope-alignment/);
  assert.match(panelSource, /Queue \/ Workerのscope候補/);
  assert.match(panelSource, /alignmentCandidates/);
  assert.match(panelSource, /alignmentDecisionRequired/);
  assert.match(panelSource, /web-admission\.scope-alignment\.plan/);
  assert.match(panelSource, /自動切替なし/);
  assert.match(panelSource, /database backend/);
  assert.match(panelSource, /AOS queue と Mac worker が別会社scope/);
  assert.match(source, /processReadbackStatus/);
  assert.match(source, /process検出（profile\/port一致）/);
  assert.match(source, /未登録Browserあり（照合待ち）/);
  assert.match(source, /profile \/ port不一致（照合待ち）/);
  assert.match(source, /foreign \/ process bindingを変更せず/);
  assert.match(panelSource, /ownership/);
  assert.match(panelSource, /bindingStatus/);
  assert.match(source, /liveReadbackStatus/);
  assert.match(panelSource, /実プロセスのlistenは別表の実測process port、認証状態と画面readbackはMac workerが同一Runで返した場合だけ/);
  assert.match(source, /予約のみ/);
  assert.match(source, /Mac workerの同一Run readback待ち/);
  assert.match(panelSource, /runtimeRole/);
  assert.match(panelSource, /登録集合の意味/);
  assert.match(panelSource, new RegExp("Browser/portable"));
  assert.match(panelSource, /Company catalog/);
  assert.match(panelSource, /Browser lane/);
  assert.match(panelSource, /同一ホストprocess/);
  assert.match(panelSource, /未登録Browser/);
  assert.match(panelSource, /heartbeat・queue claim・receipt・source sync/);
  assert.match(panelSource, /web-admission\.operational-readback/);
  assert.match(panelSource, /認証・外部作用・業務完了のreadback/);
  assert.match(source, /同一Run認証readback済み/);
  assert.match(source, /provider receipt必須/);
  assert.match(source, /業務完了未claim/);
  assert.match(panelSource, /businessCompletion\?\.exactBlocker/);
  assert.match(source, /Browser Use Lane/);
  assert.match(source, /profileName/);
});

test("PC status separates persisted heartbeat from same-host remote worker and Browser Use process readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function PcStatusPage");
  const end = source.indexOf("function TemplatesPage", start);
  assert.ok(start >= 0 && end > start, "PC status source missing");
  const pcSource = source.slice(start, end);

  assert.match(pcSource, /Portable remote worker process/);
  assert.match(pcSource, /Queue scope/);
  assert.match(pcSource, /local_sqlite/);
  assert.match(pcSource, /heartbeat・queue claim・receipt・source sync/);
  assert.match(pcSource, /Browser Use live resource/);
  assert.match(pcSource, /unregisteredBrowserProcessCount/);
});

test("job candidate stages are truthful and the initial list is bounded", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const manifestSource = readFileSync(resolve(process.cwd(), "apps/web/src/controlManifest.ts"), "utf8");
  const helperStart = source.indexOf("function candidateDisplayStage");
  const helperEnd = source.indexOf("function JobApplicationDigestPanel", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "candidate stage helper missing");
  const helperSource = source.slice(helperStart, helperEnd);

  assert.equal((helperSource.match(/return "/g) ?? []).length, 3, "candidate stage helper must have one of three stages");
  assert.match(helperSource, /if \(status === "reconciled"\) return "応募完了";/);
  assert.match(helperSource, /if \(status === "eligible"\) return "応募準備";/);
  assert.match(helperSource, /return "発見";/);

  const panelStart = source.indexOf("function JobApplicationDigestPanel");
  const panelEnd = source.indexOf("const SHEET_POPULATION_AUDIT_SCHEMA", panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart, "job digest panel source missing");
  const panelSource = source.slice(panelStart, panelEnd);
  assert.match(panelSource, /const stage = candidateDisplayStage\(candidate\.status\);/);
  assert.match(panelSource, /return \[candidate\.companyName \?\? "-",[\s\S]*stage\] as any\[\];/);
  assert.match(panelSource, /const previewCandidateRows = candidateRows\.slice\(0, 3\);/);
  assert.match(panelSource, /const detailCandidateRows = candidateRows\.slice\(3\);/);
  assert.match(panelSource, /data-control-id="job-application\.digest\.candidate-preview"/);
  assert.match(panelSource, /<details className="job-candidate-details" data-control-id="job-application\.digest\.candidate-details">/);
  assert.doesNotMatch(panelSource, /<details[^>]*open/);
  assert.match(panelSource, /応募完了はreconciled以外に推測しません。/);

  for (const id of [
    "job-application.digest.candidate-stage",
    "job-application.digest.candidate-preview",
    "job-application.digest.candidate-details"
  ]) {
    assert.match(manifestSource, new RegExp(`id: "${id}"[^\\n]*disposition: "real_read"`));
  }
});

test("literal rendered control ids are covered by the control manifest", () => {
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const manifestSource = readFileSync(resolve(process.cwd(), "apps/web/src/controlManifest.ts"), "utf8");
  const renderedIds = [...appSource.matchAll(/(?:data-control-id|controlId)="([^"]+)"/g)].map((match) => match[1]);
  const manifestIds = [...manifestSource.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1]);
  const matches = (id: string, pattern: string) => {
    if (!pattern.includes("*")) return id === pattern;
    const expression = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")).join(".*")}$`);
    return expression.test(id);
  };
  const missing = [...new Set(renderedIds)].filter((id) => !manifestIds.some((pattern) => matches(id, pattern)));
  assert.deepEqual(missing, [], `unclassified literal control ids: ${missing.join(", ")}`);
});
