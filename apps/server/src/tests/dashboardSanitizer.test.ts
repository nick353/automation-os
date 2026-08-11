import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { sanitizeDashboardMetadata, sanitizeDashboardRows } from "../dashboardSanitizer.js";
import { nisenPrintsRunContracts } from "../runs/runContracts.js";
import { resolveCreateMessageCommand } from "../../../web/src/createMessageSecrets.js";

test("sanitizes NisenPrints run contract internals from dashboard metadata", () => {
  const contract = nisenPrintsRunContracts.nisenprints_etsy_sync;
  const rows = sanitizeDashboardRows([
    {
      id: "run_1",
      metadata_json: JSON.stringify({
        run_contract: contract,
        plan: { runContract: contract },
        proof_gate: { ok: false, present: ["etsy_current_listings_snapshot"], missing: ["local_queue_synced", "stale_rows_pruned"] },
        proof_summary: "partial: missing local_queue_synced, stale_rows_pruned"
      })
    }
  ]);
  const metadata = JSON.parse(String(rows[0].metadata_json));
  const serialized = JSON.stringify(metadata);

  assert.equal(metadata.run_contract.mode, "nisenprints_etsy_sync");
  assert.equal(metadata.run_contract.beginnerLabel, "Etsy同期");
  assert.equal(metadata.run_contract.requiredProofs, undefined);
  assert.equal(metadata.run_contract.sourceOfTruth, undefined);
  assert.equal(metadata.run_contract.allowedScope, undefined);
  assert.equal(metadata.run_contract.forbiddenActions, undefined);
  assert.equal(metadata.plan.runContract.requiredProofs, undefined);
  assert.deepEqual(metadata.run_contract_summary.progress, { done: 1, total: 3, ok: false });
  assert.deepEqual(metadata.run_contract_summary.missingVisibleSteps, ["ローカルqueueを同期する", "古い行が消えたことを確認する"]);
  assert.equal(metadata.run_contract_summary.nextVisibleStep, "ローカルqueueを同期する");
  assert.deepEqual(metadata.proof_gate, { ok: false, missing: ["ローカル同期", "古い行の整理"] });
  assert.equal(metadata.proof_summary, undefined);
  assert.doesNotMatch(serialized, /etsy_current_listings_snapshot/);
  assert.doesNotMatch(serialized, /local_queue_synced/);
  assert.doesNotMatch(serialized, /stale_rows_pruned/);
});

test("sanitizes Research Planner and proof internals from dashboard metadata", () => {
  const rows = sanitizeDashboardRows([
    {
      id: "run_research",
      metadata_json: JSON.stringify({
        research_plan_snapshot: {
          id: "plan_1",
          title: "朝の調査",
          status: "started",
          visibleFlow: ["画面を確認", "結果を記録"],
          snapshotRole: "pre_start_plan_evidence_not_completion_proof",
          sourceOfTruth: ["DB readback"],
          proofBoundary: ["visible_source_snapshot:x"],
          approvalBoundary: ["publish requires approval"],
          metadata: { prompt_uri: "data/artifacts/prompt.txt" }
        },
        research_plan_required_proofs: ["visible_source_snapshot:x"],
        research_plan_missing_proofs: ["visible_source_snapshot:x"],
        research_plan_proof_summary: "missing visible_source_snapshot:x",
        proof_gate: {
          ok: false,
          reason: "research_plan_visible_source_proof_required",
          missing: ["visible_source_snapshot:x"],
          present: ["worker_receipt"]
        },
        proof_summary: "partial: missing visible_source_snapshot:x"
      })
    }
  ]);
  const metadata = JSON.parse(String(rows[0].metadata_json));
  const serialized = JSON.stringify(metadata);

  assert.deepEqual(metadata.research_plan_snapshot, {
    id: "plan_1",
    title: "朝の調査",
    status: "started",
    visibleFlow: ["画面を確認", "結果を記録"]
  });
  assert.deepEqual(metadata.proof_gate, { ok: false, missing: ["画面で見える確認記録"] });
  assert.equal(metadata.proof_summary, undefined);
  assert.equal(metadata.research_plan_required_proofs, undefined);
  assert.equal(metadata.research_plan_missing_proofs, undefined);
  assert.equal(metadata.research_plan_proof_summary, undefined);
  assert.doesNotMatch(serialized, /sourceOfTruth|proofBoundary|approvalBoundary|snapshotRole|visible_source_snapshot|prompt_uri|DB readback|completion_proof/);
});

test("keeps safe Create session handoff summary for run details", () => {
  const rows = sanitizeDashboardRows([
    {
      id: "run_create_handoff",
      metadata_json: JSON.stringify({
        create_session_source: "create_view",
        create_session_title: "ローカルCodex worker連携",
        create_session_next_action: "Mac workerが保存済み相談を読んで実行します。",
        create_session_snapshot: {
          title: "ローカルCodex worker連携",
          command: "sk-createSession1234567890abcdefghijklmnopqrstuvwxyz を使う",
          messages: [
            { role: "user", text: "API課金を増やさずに使いたい" },
            { role: "assistant", text: "Mac workerで実行します。" }
          ],
          draft: {
            command: "secret command",
            visibleSteps: ["保存済み相談を読む", "runを作る", "Mac workerが拾う"],
            nextAction: "Mac workerが保存済み相談を読んで実行します。"
          },
          researchSources: { web: false },
          capturedAt: "2026-06-23T08:00:00.000Z"
        }
      })
    }
  ]);
  const metadata = JSON.parse(String(rows[0].metadata_json));
  const serialized = JSON.stringify(metadata);

  assert.equal(metadata.create_session_source, "create_view");
  assert.equal(metadata.create_session_title, "ローカルCodex worker連携");
  assert.equal(metadata.create_session_snapshot.title, "ローカルCodex worker連携");
  assert.deepEqual(metadata.create_session_snapshot.draft.visibleSteps, ["保存済み相談を読む", "runを作る", "Mac workerが拾う"]);
  assert.equal(metadata.create_session_snapshot.messages.length, 2);
  assert.equal(metadata.create_session_snapshot.command, undefined);
  assert.equal(metadata.create_session_snapshot.draft.command, undefined);
  assert.doesNotMatch(serialized, /sk-createSession|secret command/);
});

test("sanitizes YouTube capture metadata to public review state", () => {
  const metadata = sanitizeDashboardMetadata({
    youtube_capture: {
      status: "blocked",
      exactBlocker: "youtube_transcript_official_panel_not_visible",
      artifactDir: "/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/youtube-transcript-captures/youtube_transcript_fake",
      requestedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      summary: "Blocked while reading https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    }
  });

  assert.deepEqual(metadata.youtube_capture, {
    status: "blocked",
    needsReview: true,
    summary: "Blocked while reading [redacted-url]"
  });
  assert.doesNotMatch(JSON.stringify(metadata), /artifactDir|requestedUrl|youtube_transcript_fake|dQw4w9WgXcQ|official_panel/);
});

test("sanitizes direct dashboard row internals while keeping public flags", () => {
  const rows = sanitizeDashboardRows([
    {
      id: "lane_1",
      uri: "data/artifacts/proof.json",
      path: "/Users/nichikatanaka/private/file.txt",
      target_url: "http://127.0.0.1:5173/#create",
      prompt_uri: "data/artifacts/prompt.txt",
      result_uri: "data/artifacts/result.txt",
      browser_use_session: "session-secret",
      browser_use_cdp_url: "http://127.0.0.1:9333",
      browser_use_profile: "/Users/nichikatanaka/Profile",
      profile_dir: "/Users/nichikatanaka/Profile",
      cdp_port: 9333,
      metadata_json: JSON.stringify({
        metadata: {
          connectionStrategy: { session: "session-secret", cdpUrl: "http://127.0.0.1:9333", profile: "/Users/profile" },
          screenshotPath: "data/artifacts/screen.png",
          statePath: "data/artifacts/state.json",
          logPath: "data/artifacts/log.txt",
          targetUrl: "http://127.0.0.1:5173/#create"
        }
      })
    }
  ]);
  const row = rows[0] as Record<string, unknown>;
  const serialized = JSON.stringify(row);

  assert.equal(row.connection_configured, true);
  assert.equal(row.playwright_configured, undefined);
  assert.equal(row.browser_driver, "browser_use_cli");
  assert.equal(row.browser_use_configured, true);
  assert.equal(row.uri, undefined);
  assert.equal(row.path, undefined);
  assert.equal(row.target_url, undefined);
  assert.equal(row.prompt_uri, undefined);
  assert.equal(row.result_uri, undefined);
  assert.equal(row.browser_use_session, undefined);
  assert.equal(row.browser_use_cdp_url, undefined);
  assert.equal(row.browser_use_profile, undefined);
  assert.equal(row.profile_dir, undefined);
  assert.equal(row.cdp_port, undefined);
  assert.doesNotMatch(serialized, /session-secret|9333|\/Users|data\/artifacts|targetUrl|screenshotPath|statePath|logPath|prompt_uri|result_uri/);
});

test("sanitizes camelCase browser and artifact internals from nested dashboard metadata", () => {
  const metadata = sanitizeDashboardMetadata({
    status: "blocked",
    label: "朝チェック",
    profileDir: "/Users/nichikatanaka/Library/Application Support/Chrome/Profile 2",
    workdir: "/Users/nichikatanaka/Documents/New project",
    browserUseCdpUrl: "http://127.0.0.1:9333/json/version",
    browserUseProfile: "/Users/nichikatanaka/.browser-use/profile",
    browserUseSession: "browser-use-session-secret",
    cdpPort: 9333,
    plan: {
      title: "公開ラベル",
      status: "ready",
      runContract: {
        workflow: "research_plan_registered",
        mode: "normal",
        beginnerLabel: "朝チェック",
        visibleSteps: ["画面を確認"]
      },
      lanes: [
        {
          status: "ok",
          profileDir: "/Users/nichikatanaka/Profile",
          browserUseCdpUrl: "http://127.0.0.1:9445",
          browserUseSession: "lane-secret",
          cdpPort: 9445,
          notes: [
            "saved at data/artifacts/run_1/proof.json",
            "open file:///Users/nichikatanaka/Documents/Codex/automation-os/.playwright-cli/page.html",
            "remote https://example.com/private",
            "screen output/playwright/run.png",
            "tmp /tmp/aos/proof.json"
          ]
        }
      ]
    },
    metadata: {
      profileDir: "/Users/nichikatanaka/Profile",
      artifactPath: "artifacts/run_1/result.json",
      filePath: "file:///Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/run_1/result.json"
    }
  });
  const serialized = JSON.stringify(metadata);

  assert.equal(metadata.status, "blocked");
  assert.equal(metadata.label, "朝チェック");
  assert.equal((metadata.plan as Record<string, unknown>).status, "ready");
  assert.equal((metadata.plan as Record<string, unknown>).title, "公開ラベル");
  assert.match(serialized, /\[redacted-artifact\]/);
  assert.match(serialized, /\[redacted-url\]/);
  assert.match(serialized, /\[redacted-path\]|\[redacted-file-uri\]/);
  assert.doesNotMatch(
    serialized,
    /profileDir|workdir|browserUseCdpUrl|browserUseProfile|browserUseSession|cdpPort|browser-use-session-secret|lane-secret|\/Users|\/tmp|file:\/\/|https?:\/\/|data\/artifacts|artifacts\/|output\/playwright|\.playwright-cli|9333|9445/
  );
});

test("sanitizes proof rows to viewer links without raw file fields", () => {
  const rows = sanitizeDashboardRows([
    {
      id: "proof_1",
      run_id: "run_1",
      proof_type: "screenshot",
      label: "画面確認",
      uri: "data/artifacts/run_1/screen.png",
      path: "/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/run_1/screen.png",
      metadata_json: JSON.stringify({
        path: "/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/run_1/screen.png",
        screenshotPath: "data/artifacts/run_1/screen.png",
        summary: "saved"
      })
    }
  ]);
  const row = rows[0] as Record<string, unknown>;
  const serialized = JSON.stringify(row);

  assert.equal(row.can_open, true);
  assert.equal(row.viewer_url, "/api/proofs/proof_1/view");
  assert.equal(row.uri, undefined);
  assert.equal(row.path, undefined);
  assert.equal(row.metadata_json, undefined);
  assert.doesNotMatch(serialized, /data\/artifacts|\/Users|screenshotPath|summary/);
});

test("sanitizes legacy browser lane metadata as Browser Use CLI configuration", () => {
  const rows = sanitizeDashboardRows([
    {
      id: "daily-ai-playwright",
      workflow_id: "daily-ai-research-publish-run",
      profile_strategy: "cdp_profile_lane",
      cdp_port: 9333,
      profile_dir: "/Users/nichikatanaka/.daily-ai-playwright-chrome",
      browser_use_session: "stale-browser-use-session",
      metadata_json: JSON.stringify({
        metadata: {
          driver: "browser_use_cli",
          screenshotPath: "artifacts/stage-observations/daily-ai.png",
          domPath: "artifacts/stage-observations/daily-ai-dom.json",
          cleanupStatus: "completed"
        }
      })
    }
  ]);
  const row = rows[0] as Record<string, unknown>;
  const metadata = JSON.parse(String(row.metadata_json));
  const serialized = JSON.stringify(row);

  assert.equal(row.playwright_configured, undefined);
  assert.equal(row.browser_driver, "browser_use_cli");
  assert.equal(row.browser_use_configured, true);
  assert.deepEqual(metadata.browser_use_result, {
    driver: "browser_use_cli",
    evidenceCount: 1,
    cleanupStatus: "completed"
  });
  assert.equal(row.cdp_port, undefined);
  assert.equal(row.profile_dir, undefined);
  assert.equal(row.browser_use_session, undefined);
  assert.doesNotMatch(serialized, /stale-browser-use-session|9333|daily-ai-playwright-chrome|stage-observations/);
});

function readAppSource(): string {
  return readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
}

function appSection(source: string, start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test("frontend preserves the current route-page shell instead of restoring legacy views", () => {
  const source = readAppSource();

  assert.match(source, /function HomePage/);
  assert.match(source, /function ChatPage/);
  assert.match(source, /function RunsPage/);
  assert.match(source, /function TruthfulProductionStatusPage/);
  assert.match(source, /function TruthfulRecoveryPage/);
  assert.match(source, /function TruthfulLanesPage/);
  assert.match(source, /function TruthfulArtifactsPage/);
  assert.match(source, /function TruthfulPluginsPage/);
  assert.doesNotMatch(source, /function DashboardView|function CreateView|function RunsView|function SourcesView|function ProductionStatusPage|function RecoveryPage|function LanesPage|function ArtifactsPage|function PluginsPage/);
});

test("frontend sends only sanitized planning text to the server planner", () => {
  const source = readAppSource();
  const chatSource = appSection(source, "function ChatPage", "function BuilderPage");

  assert.match(chatSource, /const redactedActivePrompt = redactSensitiveText\(activePrompt\)/);
  assert.match(source, /async function storeChatSecrets/);
  assert.match(source, /mvpFetch\("\/api\/secrets\/from-message"/);
  assert.match(source, /body: JSON\.stringify\(\{ project_id: projectId, text: rawText \}\)/);
  assert.match(chatSource, /storeChatSecrets\(activePrompt, selectedProjectId\)/);
  assert.match(chatSource, /storeChatSecrets\(draftPrompt, selectedProjectId\)/);
  assert.match(chatSource, /requestChatPlan\(safePrompt, selectedPlatforms, \{/);
  assert.doesNotMatch(chatSource, /requestChatPlan\(activePrompt, selectedPlatforms/);
  assert.doesNotMatch(chatSource, /requestChatPlan\(draftPrompt, selectedPlatforms/);
  assert.doesNotMatch(chatSource, /requestChatPlan\(redactedActivePrompt, selectedPlatforms/);
  assert.match(chatSource, /const safePrompt = secretReadback\.sanitizedText\.trim\(\)/);
  assert.match(chatSource, /external_action_allowed: false/);
  assert.match(chatSource, /create_approval: true/);
});

test("frontend planner uses the supported server contract and never turns API failure into success", () => {
  const source = readAppSource();
  const plannerSource = appSection(source, "async function requestChatPlan", "function App()");
  const chatSource = appSection(source, "function ChatPage", "function BuilderPage");

  assert.match(plannerSource, /mvpFetch\("\/api\/create\/chat"/);
  assert.match(plannerSource, /messages: conversation/);
  assert.match(plannerSource, /codex_thread_id: options\.threadId/);
  assert.match(plannerSource, /throw new Error\(redactSensitiveText\(exact\)\.slice\(0, 180\) \|\| "planner_readback_unavailable"\)/);
  assert.doesNotMatch(source, /\/api\/mvp\/chat\/plan|client_fallback_deterministic|api_unavailable_fallback/);
  assert.match(chatSource, /setPlannerError\(`プランAPIの結果を確認できませんでした/);
  assert.match(chatSource, /setPlanVisible\(false\)/);
  assert.match(plannerSource, /serverPlan\.intent === "plan_workflow"/);
  assert.match(plannerSource, /serverPlan\.operation === "create_automation"/);
  assert.match(plannerSource, /serverPlan\.executionDecision !== "ask_more"/);
  assert.match(chatSource, /disabled=\{!canCreatePlan(?: \|\| creating)?\}/);
  assert.match(chatSource, /publicBlockerSummary\(plannerReadback\.exact_blocker\)/);
  assert.doesNotMatch(chatSource, /` \/ \$\{plannerReadback\.exact_blocker\}`/);
});

test("frontend Chat shortcuts and platform selection expose independent truthful state", () => {
  const source = readAppSource();
  const chatSource = appSection(source, "function ChatPage", "function BuilderPage");

  assert.match(chatSource, /\["システム全体を確認", "定期実行を作成", "既存定期実行を調整", "失敗を確認"\]\.map/);
  assert.match(chatSource, /setPrompt\(shortcut\)/);
  assert.match(chatSource, /setChatNote\(`\$\{shortcut\}を入力欄にセットしました/);
  assert.match(chatSource, /aria-label=\{`投稿先サービス（\$\{selectedPlatforms\.length\}件選択）`\}/);
  assert.match(chatSource, /const next = allPlatformsSelected \? \[\] : platformOptions/);
  assert.match(chatSource, /allPlatformsSelected \? "全て解除" : "全て選択"/);
  assert.match(chatSource, /aria-pressed=\{allPlatformsSelected\}/);
});

test("frontend sync receipt distinguishes company automations from registered workflows", () => {
  const source = readAppSource();
  assert.match(source, /state\.sync_readback/);
  assert.match(source, /company automations=\$\{automationCount\}/);
  assert.match(source, /registered workflows=\$\{registeredCount\}/);
  assert.match(source, /scope=\$\{scope\}/);
  assert.match(source, /capturedAt/);
  assert.doesNotMatch(source, /同期しました。automations=\$\{state\.automations/);
});

test("frontend starts without demo automations and global sync performs an API readback", () => {
  const source = readAppSource();
  const appSource = appSection(source, "function App()", "function Sidebar");
  const headerSource = appSection(source, "function TopHeader", "function ProjectTabs");

  assert.doesNotMatch(source, /seedAutomations/);
  assert.match(appSource, /useState<AutomationRow\[]>\(\[\]\)/);
  assert.match(appSource, /setFeedbackReadback\(state\.feedbacks \?\? \[\]\)/);
  assert.match(appSource, /const syncState = async \(\) =>/);
  assert.match(appSource, /const state = await readMvpState\(\)/);
  assert.match(appSource, /<TopHeader[\s\S]*onSync=\{syncState\}/);
  assert.match(headerSource, /void onSync\(\)/);
});

test("frontend feedback readback uses an explicit empty state instead of silently assuming success", () => {
  const source = readAppSource();
  const appSource = appSection(source, "function App()", "function Sidebar");
  const feedbackSource = appSection(source, "function FeedbackFixQueue", "function TruthfulLanesPage");

  assert.match(appSource, /Feedback readbackに失敗しました。空のキューとは断定せず、直前の表示を維持します。/);
  assert.match(feedbackSource, /open feedbackなし/);
  assert.match(feedbackSource, /現在のreadbackでは未処理feedbackはありません/);
});

test("frontend project switcher is derived from API state records", () => {
  const source = readAppSource();
  const optionSource = appSection(source, "function projectOptionsFromState", "async function fetchApiJson");
  const tabsSource = appSection(source, "function ProjectTabs", "function PageTitle");
  const templatesSource = appSection(source, "function TemplatesPage", "function Panel");
  const builderSource = appSection(source, "function BuilderPage", "function ApprovalsPage");

  assert.match(optionSource, /canonicalCompanies = state\.companies \?\? state\.projects \?\? \[\]/);
  assert.match(optionSource, /for \(const project of canonicalCompanies\)/);
  assert.match(optionSource, /role: String\(project\?\.role \?\? "viewer"\)/);
  assert.doesNotMatch(optionSource, /state\.automations \?\? \[\]/);
  assert.doesNotMatch(optionSource, /row\?\.project_id/);
  assert.doesNotMatch(optionSource, /options\.set\("project-a"/);
  assert.match(tabsSource, /projectOptionsFromState\(mvpState\)/);
  assert.match(tabsSource, /会社はまだ登録されていません/);
  assert.doesNotMatch(tabsSource, /projectSlugs\.map/);
  assert.doesNotMatch(tabsSource, /\[\{ id: activeProject/);
  assert.match(source, /function ProjectUnavailablePage/);
  assert.match(source, /type MvpLoadStatus = "loading" \| "ready" \| "error"/);
  assert.match(source, /currentPath === "#\/projects"/);
  assert.match(source, /projectOptions\.some\(\(project\) => project\.id === requestedProject\)/);
  assert.match(templatesSource, /aria-label="テンプレートの保存先会社"/);
  assert.match(templatesSource, /disabled=\{!selectedProjectIsVerified(?: \|\| saving)?\}/);
  assert.match(templatesSource, /project_id: selectedProjectId/);
  assert.doesNotMatch(templatesSource, /project_id: rememberedProject\(\)/);
  assert.match(builderSource, /company_id: activeProject/);
  assert.match(builderSource, /project_id: activeProject/);
  assert.match(builderSource, /approval_group_id: activeProject/);
  const approvalsSource = appSection(source, "function ApprovalsPage", "function RunsPage");
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");
  assert.match(approvalsSource, /canDecideApproval = \["owner", "admin", "approver"\]\.includes/);
  assert.match(approvalsSource, /approvals\.read-only/);
  assert.match(runsSource, /canMutateJob = \["owner", "admin", "operator"\]\.includes/);
  assert.match(runsSource, /runs\.job\.read-only/);
  assert.doesNotMatch(runsSource, /\["failed", "timed_out", "reconciliation_required"\]\.includes\(selectedJob\.status\)/);
});

test("frontend template catalog preserves distinct automation types", () => {
  const source = readAppSource();
  const templatesSource = appSection(source, "function TemplatesPage", "function Panel");

  assert.match(templatesSource, /name\.includes\("DM"\)[\s\S]*?"dm-reply"/);
  assert.match(templatesSource, /name\.includes\("Runway"\)[\s\S]*?"creative-video"/);
  assert.match(source, /["']creative-video["']:\s*\{/);
  assert.match(source, /kind === "creative-video"[\s\S]*?return "creative-video"/);
});

test("frontend fails closed instead of rendering unknown automation types as SNS", () => {
  const source = readAppSource();
  const slugSource = appSection(source, "function automationSlugForKind", "function explicitAutomationTypeFromPrompt");
  const builderSource = appSection(source, "function builderConfigForAutomationType", "async function requestChatPlan");
  const pageSource = appSection(source, "function BuilderPage", "function ApprovalsPage");

  assert.match(slugSource, /if \(kind === "広告投稿"\) return "ads";/);
  assert.match(slugSource, /return "";/);
  assert.match(builderSource, /function isSupportedAutomationType\(type: string\)/);
  assert.match(builderSource, /kindLabel: "未確認"/);
  assert.match(builderSource, /riskBoundary: "未認識の自動化タイプは保存・承認・定期実行更新を行いません。"/);
  assert.match(pageSource, /const builderTypeSupported = isSupportedAutomationType\(builderType\)/);
  assert.match(pageSource, /if \(!builderTypeSupported\)/);
  assert.match(pageSource, /disabled=\{saving \|\| !builderTypeSupported\}/);
  assert.match(pageSource, /SNSとして表示・保存せず/);
});

test("frontend company pages and successful empty states use canonical API truth", () => {
  const source = readAppSource();
  const optionSource = appSection(source, "function projectOptionsFromState", "async function fetchApiJson");
  const homeSource = appSection(source, "function HomePage", "function ChatPage");
  const companyPages = appSection(source, "function TruthfulLanesPage", "function TruthfulRunDetailPage");
  const automationsSource = appSection(source, "function AutomationsPage", "function BuilderPage");
  const builderSource = appSection(source, "function BuilderPage", "function ApprovalsPage");

  assert.match(optionSource, /function projectLabelFromState\(state: MvpState, id: string\)/);
  assert.match(optionSource, /projectOptionsFromState\(state\)\.find\(\(project\) => project\.id === id\)\?\.label/);
  assert.match(homeSource, /projectLabelFromState\(mvpState, item\.project_id\)/);
  assert.match(homeSource, /自動化はまだ登録されていません/);
  assert.match(homeSource, /会社がまだ登録されていません/);
  assert.doesNotMatch(homeSource, /API readbackで自動化を確認できません/);
  assert.doesNotMatch(companyPages, /const companyName = projectLabelFromId\(/);
  assert.doesNotMatch(automationsSource, /const projectName = projectLabelFromId\(/);
  assert.doesNotMatch(builderSource, /const projectName = projectLabelFromId\(/);
  assert.match(source, /ProjectScopeNotice projectId=\{activeProject\} mvpState=\{mvpState\}/);
});

test("frontend first use creates and confirms a canonical company before automation setup", () => {
  const source = readAppSource();
  const setupSource = appSection(source, "function ProjectDirectoryPage", "function ProjectUnavailablePage");
  const selectionSource = appSection(source, "function rememberedProject", "function projectSlugFromPrompt");
  const homeSource = appSection(source, "function HomePage", "function ChatPage");
  const chatSource = appSection(source, "function ChatPage", "function BuilderPage");
  const templatesSource = appSection(source, "function TemplatesPage", "function Panel");
  const headerSource = appSection(source, "function TopHeader", "function ProjectTabs");
  const sidebarSource = appSection(source, "function Sidebar", "function TopHeader");
  const appSource = appSection(source, "function App()", "function Sidebar");

  assert.match(setupSource, /mvpLoadStatus === "loading"/);
  assert.match(setupSource, /mvpLoadStatus === "error"/);
  assert.match(setupSource, /mvpFetch\("\/api\/companies", \{[\s\S]*method: "POST"/);
  assert.match(setupSource, /stableIdempotencyKey\(companyCreateIdempotencyRef, "company-create", name\)/);
  assert.match(setupSource, /"idempotency-key": createKey/);
  assert.match(setupSource, /body: JSON\.stringify\(\{ name \}\)/);
  assert.match(setupSource, /if \(!response\.ok \|\| result\.ok === false\) throw/);
  assert.match(setupSource, /const state = await readMvpState\(\)/);
  assert.match(setupSource, /!projectOptionsFromState\(state\)\.some\(\(project\) => project\.id === createdCompanyId\)/);
  assert.match(setupSource, /model\.setMvpState\(state\)/);
  assert.match(setupSource, /model\.setAutomationRows\(toAutomationRows\(state\.automations \?\? \[\]\)\)/);
  assert.match(setupSource, /model\.setFeedbackReadback\(state\.feedbacks \?\? \[\]\)/);
  assert.match(setupSource, /rememberProject\(createdCompanyId\);[\s\S]*go\(chatHref\(\{ companyId: createdCompanyId, context: "company-setup" \}\)\)/);
  assert.match(setupSource, /disabled=\{creatingCompany \|\| !companyName\.trim\(\)\}/);
  assert.doesNotMatch(source, /会社登録APIの実装後/);

  assert.match(selectionSource, /options\.length === 1 \? options\[0\]\.id : ""/);
  assert.match(chatSource, /setSelectedProjectId\(\(current\) => \{[\s\S]*const requested = requestedProjectId[\s\S]*resolveProjectSelection\(mvpState, requested \|\| current\)/);
  assert.match(templatesSource, /setSelectedProjectId\(\(current\) => \{[\s\S]*resolveProjectSelection\(model\.mvpState, current\)/);
  assert.match(chatSource, /controlId="chat\.company-required\.open"/);
  assert.match(templatesSource, /controlId="templates\.company-required\.open"/);
  assert.match(homeSource, /controlId="home\.first-use\.register"/);
  assert.match(homeSource, /controlId="home\.first-use\.templates"/);
  assert.match(homeSource, /pristineCompany && companyOptions\.length === 1/);
  assert.match(homeSource, /controlId="home\.first-use\.company-picker\.panel"/);
  assert.match(homeSource, /rememberProject\(project\.id\); go\(chatHref\(\{ companyId: project\.id, context: "home-company-picker" \}\)\)/);
  assert.match(headerSource, /openAutomationCreator\(mvpState, setReceipt\)/);
  assert.match(headerSource, /if \(mvpLoadStatus !== "ready"\)/);
  assert.match(headerSource, /placeholder="画面を検索"/);
  assert.match(headerSource, /className="top-receipt" role="status"/);
  assert.match(sidebarSource, /aria-label=\{label\}/);
  assert.match(sidebarSource, /className="nav-label"/);
  assert.match(appSource, /<form className="access-form" onSubmit=/);
  assert.match(appSource, /autoFocus aria-describedby="operator-token-help operator-token-status"/);
  assert.match(chatSource, /targetProjectIsVerified = model\.mvpLoadStatus === "ready"/);
});

test("frontend hides static operational charts and decorative panel menus", () => {
  const source = readAppSource();
  const performanceSource = appSection(source, "function TruthfulPerformancePage", "function TruthfulArtifactsPage");
  const panelSource = appSection(source, "function Panel", "function MetricCard");

  assert.doesNotMatch(source, /function LineChart|function Bars/);
  assert.match(performanceSource, /analytics\/performance/);
  assert.match(performanceSource, /new AbortController\(\)/);
  assert.match(performanceSource, /analyticsRequestGeneration\.current !== requestGeneration/);
  assert.match(performanceSource, /analyticsStatus === "loading"/);
  assert.match(performanceSource, /analyticsStatus === "error"/);
  assert.match(performanceSource, /analytics\?\.data_state === "empty"/);
  assert.match(performanceSource, /analytics\?\.metrics\?\.outcome\?\.availability !== "available"/);
  assert.match(performanceSource, /performanceSeries\.chartRows\.length/);
  assert.doesNotMatch(performanceSource, /Math\.max\(2/);
  assert.match(performanceSource, /集計の来歴/);
  assert.match(performanceSource, /未計測指標/);
  assert.doesNotMatch(performanceSource, /const runs = \(model\.mvpState\.runs/);
  assert.doesNotMatch(panelSource, /panel-menu-static|MoreHorizontal/);
});

test("frontend exposes only the versioned archive action backed by its server contract", () => {
  const source = readAppSource();
  const automationsSource = appSection(source, "function AutomationsPage", "function BuilderPage");

  assert.doesNotMatch(automationsSource, /\/api\/mvp\/automations\/\$\{encodeURIComponent\(id\)\}\/run/);
  assert.match(automationsSource, /\/api\/v1\/companies\/\$\{encodeURIComponent\(activeProject\)\}\/automations/);
  assert.match(automationsSource, /method: "DELETE"/);
  assert.match(automationsSource, /"if-match": String\(automation\.revision\)/);
  assert.match(automationsSource, /projects\.automation\.archive\.\$\{a\.id\}/);
  assert.doesNotMatch(automationsSource, /projects\.automation\.(?:run|delete|detail)\./);
  assert.doesNotMatch(automationsSource, /projects\.delete\.(?:confirm|cancel)/);
});

test("frontend moves worker diagnostics to the owner-only Admin surface", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");
  const adminSource = appSection(source, "function OwnerAdminPage", "function renderPage");

  assert.doesNotMatch(runsSource, /\/api\/mvp\/worker\/preview|Mac接続|workerSummary/);
  assert.match(adminSource, /\/api\/v1\/admin\/diagnostics/);
  assert.match(adminSource, /hasOwnerAdminAccess/);
  assert.match(runsSource, /外部操作なし/);
  assert.doesNotMatch(runsSource, /\/api\/mvp\/worker\/once|workerを実行|runWorkerOnce/);
});

test("frontend keeps company pages free of internal diagnostics and uses persisted integrations", () => {
  const source = readAppSource();
  const homeSource = appSection(source, "function HomePage", "function ChatPage");
  const memorySource = appSection(source, "function TruthfulMemoryPage", "function TruthfulIntegrationsPage");
  const integrationsSource = appSection(source, "function TruthfulIntegrationsPage", "function TruthfulPerformancePage");
  const runDetailSource = appSection(source, "function TruthfulRunDetailPage", "function TruthfulRecoveryPage");
  const adminSource = appSection(source, "function OwnerAdminPage", "function renderPage");

  assert.doesNotMatch(homeSource, /"Port"|ObsidianSyncCard|workerSummary|exact_blocker/);
  assert.doesNotMatch(memorySource, /secret_ref|two_factor|account_refs/);
  assert.match(integrationsSource, /oauth_state/);
  assert.match(integrationsSource, /last_verified_at/);
  assert.match(integrationsSource, /item\.account_ref \?\? item\.accountRef/);
  assert.match(integrationsSource, /Date\.parse\(expiresAt\) <= Date\.now\(\)/);
  assert.match(integrationsSource, /connection-account-refs/);
  assert.match(integrationsSource, /inventoryStatus/);
  assert.match(integrationsSource, /integrations\.reconnect/);
  assert.match(integrationsSource, /integrations\.revoke/);
  assert.match(runDetailSource, /publicBlockerSummary\(run\.exact_blocker\)/);
  assert.doesNotMatch(runDetailSource, /run\.exact_blocker \?\?/);
  assert.match(adminSource, /PC・Browser・Codex・Obsidian・Worker・Deployment/);
});

test("frontend serializes planner requests and prevents stale responses from overwriting current state", () => {
  const source = readAppSource();
  const chatSource = appSection(source, "function ChatPage", "function BuilderPage");

  assert.match(chatSource, /const \[planning, setPlanning\] = useState\(false\)/);
  assert.match(chatSource, /const plannerRequestGeneration = useRef\(0\)/);
  assert.match(chatSource, /plannerRequestGeneration\.current !== requestGeneration/);
  assert.match(chatSource, /disabled=\{!draftPrompt \|\| planning(?: \|\| creating)?\}/);
  assert.match(chatSource, /disabled=\{!activePrompt \|\| planning(?: \|\| creating)?\}/);
  assert.match(chatSource, /controlId="chat\.reset"[\s\S]*disabled=\{planning \|\| creating\}/);
  assert.match(chatSource, /chat\.platform\.toggle[\s\S]*disabled=\{planning \|\| creating\}/);
  assert.match(chatSource, /controlId="chat\.create"[\s\S]*disabled=\{!canCreatePlan \|\| creating\}/);
});

test("frontend attaches the session-only operator token to API requests", () => {
  const source = readAppSource();
  const headerSource = appSection(source, "function withMvpApiHeaders", "async function mvpFetch");

  assert.match(headerSource, /headers\.set\("x-automation-os-token", token\)/);
  assert.doesNotMatch(headerSource, /authorization/i);
  assert.match(source, /window\.sessionStorage/);
  assert.match(source, /window\.localStorage\.removeItem\(writeTokenStorageKey\)/);
  assert.doesNotMatch(source, /window\.localStorage\.setItem\(writeTokenStorageKey/);
});

test("frontend fails closed behind an operator-token gate on protected production readbacks", () => {
  const source = readAppSource();
  const appSource = appSection(source, "function App()", "function Sidebar");

  assert.match(source, /throw new Error\(`mvp_state_http_\$\{response\.status\}`\)/);
  assert.match(appSource, /mvp_state_http_\(\?:401\|423\)/);
  assert.match(appSource, /setApiAccessRequired\(true\)/);
  assert.match(appSource, /const unlockOperatorAccess = async \(\) =>/);
  assert.match(appSource, /persistWriteToken\(writeToken\);[\s\S]*const state = await readMvpState\(\)/);
  assert.match(appSource, /setApiAccessRequired\(false\)/);
  assert.match(appSource, /readApiTokenCapability/);
  assert.match(appSource, /AUTOMATION_OS_READ_TOKEN/);
  assert.match(appSource, /title="管理者アクセス"/);
  assert.match(appSource, /Automation OS APIキー/);
  assert.match(appSource, /AUTOMATION_OS_WRITE_TOKEN/);
  assert.match(appSource, /認証ヘッダー/);
  assert.match(appSource, /通常のログインパスワードではありません/);
  assert.match(appSource, /確認して開く/);
  assert.match(appSource, /読み取り専用キーを確認しました/);
  assert.doesNotMatch(appSource, /管理者だけが使う確認キーです/);
  assert.match(appSource, /type="password"/);
  assert.match(appSource, /autoComplete="off"/);
});

test("first-use documentation keeps read and write token scopes truthful", () => {
  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
  const envExample = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");

  assert.match(readme, /閲覧・readbackだけなら `AUTOMATION_OS_READ_TOKEN`/);
  assert.match(readme, /作成・更新・実行・承認まで行うなら `AUTOMATION_OS_WRITE_TOKEN`/);
  assert.match(readme, /6項目がChat入力欄へ下書きとして自動入力されます/);
  assert.match(readme, /テンプレートは操作を開始せず/);
  assert.match(readme, /キーはこのタブのsessionStorageだけで扱い/);
  assert.doesNotMatch(readme, /All `\/api\/\*` routes except `\/api\/health` require `AUTOMATION_OS_WRITE_TOKEN`/);
  assert.match(envExample, /GET\/HEAD readbacks accept a read-only token/);
  assert.match(envExample, /state-changing calls require the write token/);
});

test("frontend selects actionable runs and repairs stale selections on refresh and polling", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");

  assert.match(runsSource, /setSelectedRunId\(\(current\) => resolveSelectedRunId\(current, state\.runs \?\? \[\], state\.actionableRuns \?\? \[\]\)\)/);
  assert.match(runsSource, /window\.setInterval/);
  assert.match(runsSource, /30000/);
});

test("frontend loads run-scoped details and prefers the newest run snapshot", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");

  assert.match(source, /function newerRunSnapshot/);
  assert.match(runsSource, /fetchApiJson<RunDetail>\(`\/api\/runs\/\$\{encodeURIComponent\(currentRunId\)\}`\)/);
  assert.match(runsSource, /newerRunSnapshot\(detailForCurrentRun\?\.run, dashboardSelectedRun\)/);
  assert.match(runsSource, /detailForCurrentRun\?\.steps/);
  assert.match(runsSource, /detailForCurrentRun\?\.proofs/);
  assert.match(runsSource, /detailForCurrentRun\?\.workerEvents/);
  assert.match(runsSource, /setSelectedRunDetail\(null\);\s*setSelectedProofId\(null\);\s*setProofView\(null\);\s*setDetailLoading\(true\)/);
});

test("frontend opens proofs only through the id-based viewer", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");

  assert.match(runsSource, /`\/api\/proofs\/\$\{encodeURIComponent\(selectedProofId\)\}\/view`/);
  assert.match(runsSource, /fetchApiJson<ProofView>\(viewerUrl\)/);
  assert.match(runsSource, /setSelectedProofId\(proof\.id\)/);
  assert.doesNotMatch(runsSource, /proof\?\.viewer_url|proof\.viewer_url/);
  assert.doesNotMatch(runsSource, /proof\.artifact_uri|proof\.uri|proof\.path|metadata_json/);
});

test("frontend redacts local paths URLs and secrets before run-detail display", () => {
  const source = readAppSource();
  const redactionSource = appSection(source, "function redactDisplayPaths", "function publicRunStatus");
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");

  assert.match(redactionSource, /redactSensitiveText/);
  assert.match(redactionSource, /\/Users/);
  assert.match(redactionSource, /Documents\\\/New project/);
  assert.match(redactionSource, /data\\\/artifacts/);
  assert.match(redactionSource, /output\\\/playwright/);
  assert.match(redactionSource, /https\?:/);
  assert.match(runsSource, /redactDisplayPaths\(proof\.summary\)/);
  assert.match(runsSource, /redactDisplayPaths\(proofView\.preview\)/);
});

test("frontend history uses public status and blocker labels", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");

  assert.match(source, /function publicRunStatus/);
  assert.match(source, /function publicBlockerSummary/);
  assert.match(runsSource, /label=\{publicRunStatus\(run\.status\)\}/);
  assert.match(runsSource, /publicBlockerSummary\(run\.exact_blocker\)/);
  assert.doesNotMatch(runsSource, /label=\{run\.status\}/);
  assert.doesNotMatch(runsSource, /\{run\.exact_blocker \?\? "-"/);
});

test("frontend normal history hides worker diagnostics and raw preview objects", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function PcStatusPage");

  assert.match(runsSource, /title="実行前の安全確認"/);
  assert.match(runsSource, /外部操作なし/);
  assert.doesNotMatch(runsSource, /JSON\.stringify\(workerPreview/);
  assert.doesNotMatch(runsSource, /workerSummary\.display/);
  assert.doesNotMatch(runsSource, /artifact_uri|sha256/);
});

test("frontend approval screen preserves the human decision boundary", () => {
  const source = readAppSource();
  const approvalsSource = appSection(source, "function ApprovalsPage", "function RunsPage");

  assert.match(approvalsSource, /送信前に人間が承認/);
  assert.match(approvalsSource, /外部投稿・送信・応募・公開は承認と証跡なしに実行しません/);
  assert.match(approvalsSource, /approveSelected/);
  assert.match(approvalsSource, /rejectSelected/);
});

test("frontend create reset starts a clean consultation and creation remains approval gated", () => {
  const source = readAppSource();
  const chatSource = appSection(source, "function ChatPage", "function BuilderPage");

  assert.match(chatSource, /const resetChat = \(\) =>/);
  assert.match(chatSource, /setPrompt\(""\)/);
  assert.match(chatSource, /setRequestText\(""\)/);
  assert.match(chatSource, /setSelectedPlatforms\(\[\]\)/);
  assert.match(chatSource, /setPlannerReadback\(null\)/);
  assert.match(chatSource, /approval_policy: plan\.approvalPolicy/);
  assert.match(chatSource, /external_action_allowed: false/);
});

test("frontend approval flows preserve canonical company scope", () => {
  const source = readAppSource();
  const approvalsSource = appSection(source, "function ApprovalsPage", "function RunsPage");
  const builderSource = appSection(source, "function BuilderPage", "function ApprovalsPage");

  assert.match(approvalsSource, /approval\.company_id \?\? approval\.project_id \?\? ""/);
  assert.match(builderSource, /company_id: activeProject/);
  assert.match(builderSource, /project_id: activeProject/);
  assert.match(builderSource, /approval_group_id: activeProject/);
});

test("frontend create secret-only helper clears commands only for credential-only input", () => {
  const stored = [{ label: "OpenAI APIキー" }];
  const secretOnly = "OpenAI APIキーは [保存済み: OpenAI APIキー] です";
  const withConsultation = "OpenAI APIキーは [保存済み: OpenAI APIキー] です。これを使って投稿文を作りたいです";
  const fallbackCommand = "投稿文を作る";

  assert.equal(resolveCreateMessageCommand(secretOnly, stored, fallbackCommand), "");
  assert.equal(resolveCreateMessageCommand(withConsultation, stored, fallbackCommand), fallbackCommand);
});

test("server worker heartbeat accounting and same-host pid checks remain fail closed", () => {
  const loopSource = readFileSync(resolve(process.cwd(), "apps/server/src/cli/workerLoop.ts"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const workerStatusSource = appSection(serverSource, "function buildLocalWorkerStatus", "function buildLaunchdLocalWorkerStatus");

  assert.match(loopSource, /lastProcessed = summaries\.length/);
  assert.match(loopSource, /lastRunIds = summaries\.map/);
  assert.match(loopSource, /runDurableAutomationSchedulerOnce/);
  assert.match(loopSource, /runDurableDryRunWorkerOnce/);
  assert.match(loopSource, /AUTOMATION_OS_DURABLE_SERVICE_USER_ID/);
  assert.match(loopSource, /durable_service_user_id_missing_with_pending_work/);
  assert.match(loopSource, /durableWorkerCoverageBlocker/);
  assert.match(loopSource, /durable_service_user_invalid_or_unscoped_for_pending_work/);
  assert.match(loopSource, /durable_service_user_scope_incomplete_for_pending_work/);
  assert.match(loopSource, /host: hostname\(\)/);
  assert.match(workerStatusSource, /sameHostHeartbeat/);
  assert.match(workerStatusSource, /heartbeatHost === hostname\(\)/);
  assert.match(workerStatusSource, /sameHostHeartbeat && pid !== undefined && !processIsAlive\(pid\)/);
});

test("server dashboard keeps registered workflow and approval rows public", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const dashboardSource = appSection(source, "export function getDashboard", "function publicRegisteredWorkflow");
  const publicWorkflowSource = appSection(source, "function publicRegisteredWorkflow", "function indexMigrationLedgerByRegisteredWorkflowId");
  const approvalSource = appSection(source, "function buildApprovalInbox", "function publicRegisteredWorkflow");

  assert.match(dashboardSource, /registeredWorkflows: publicRegisteredWorkflows/);
  assert.match(dashboardSource, /approvals: buildApprovalInbox\(approvalInboxRows\)/);
  assert.match(dashboardSource, /approvalInbox: buildApprovalInbox\(approvalInboxRows\)/);
  assert.match(publicWorkflowSource, /boundary_label/);
  assert.match(publicWorkflowSource, /trust_label/);
  assert.match(publicWorkflowSource, /freshness_label/);
  assert.doesNotMatch(publicWorkflowSource.slice(publicWorkflowSource.indexOf("return {"), publicWorkflowSource.indexOf("  };", publicWorkflowSource.indexOf("return {")) + 4), /project_root|start_command_json|source_refs_json|provenance_json/);
  assert.doesNotMatch(approvalSource.slice(approvalSource.indexOf("return {"), approvalSource.indexOf("  };", approvalSource.indexOf("return {")) + 4), /resource_locks|metadata_json|artifact_uri/);
});

test("server dashboard sanitizes step knowledge and skill payload rows", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const dashboardSource = appSection(source, "export function getDashboard", "export function getRunDetail");

  assert.match(dashboardSource, /steps: sanitizeDashboardRows\(rawSteps\)/);
  assert.match(dashboardSource, /knowledgeNotes: sanitizeDashboardRows\(rawKnowledgeNotes\)/);
  assert.match(dashboardSource, /skills: sanitizeDashboardRows\(rawSkills\)/);
});

test("server caches expensive dashboard scans and health readback omits secrets", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const cacheSource = appSection(source, "let dashboardExpensiveSnapshotCache", "export function getDashboard");
  const deploymentSource = appSection(source, "function getPackageVersion", "let dashboardExpensiveSnapshotCache");
  const healthSource = appSection(source, 'app.get("/api/health"', 'app.get("/api/companies"');
  const adminSource = appSection(source, 'app.get("/api/v1/admin/diagnostics"', 'app.get("/api/v1/companies/:companyId/feedback-artifacts');

  assert.match(cacheSource, /getCodexCapabilities\(\)/);
  assert.match(cacheSource, /getBrowserHealth\(\)/);
  assert.match(cacheSource, /AUTOMATION_OS_DASHBOARD_CAPABILITY_CACHE_MS/);
  assert.doesNotMatch(healthSource, /database:|deployment:|productionGuard:|accessGuard:/);
  assert.match(healthSource, /service: "automation-os"/);
  assert.match(adminSource, /deployment: getDashboardDeploymentReadback\(\)/);
  assert.match(adminSource, /ownerCompanies\.length === 0/);
  assert.match(deploymentSource, /AUTOMATION_OS_DEPLOY_COMMIT/);
  assert.match(deploymentSource, /getServedAssetNames\(\)/);
  assert.doesNotMatch(deploymentSource, /process\.env\.(?:DATABASE_URL|POSTGRES_URI|PASSWORD|SECRET|TOKEN|API_KEY)/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin|app\.use\(cors\(|from ["']cors["']/);
  const tokenReaderSource = appSection(source, "function readRequestWriteToken", "function getProductionWriteGuardStatus");
  assert.doesNotMatch(tokenReaderSource, /console\.|logger\.|res\.json/);
});

test("production QA keeps deployment asset and limited-write evidence", () => {
  const qaSource = readFileSync(resolve(process.cwd(), "scripts/productionQa.mjs"), "utf8");
  const replaySource = readFileSync(resolve(process.cwd(), "scripts/productionReplayQa.mjs"), "utf8");

  assert.match(qaSource, /sanitizeDeploymentReadback/);
  assert.match(qaSource, /checkServedAssets/);
  assert.match(qaSource, /missing_js_asset/);
  assert.match(qaSource, /readProductionReadToken/);
  assert.match(qaSource, /buildReadbackHeaders/);
  assert.match(qaSource, /installScopedReadbackRoute/);
  assert.match(qaSource, /redactHarFile/);
  assert.doesNotMatch(qaSource, /extraHTTPHeaders/);
  assert.match(replaySource, /readProductionReadToken/);
  assert.match(replaySource, /installScopedReadbackRoute/);
  assert.match(replaySource, /const failureStart = result\.failures\.length/);
  assert.doesNotMatch(replaySource, /extraHTTPHeaders/);
  assert.match(replaySource, /AUTOMATION_OS_REPLAY_ALLOW_WRITE/);
  assert.match(replaySource, /production_write_guard_did_not_block_without_token/);
  assert.match(replaySource, /write_workflow_allowlist_missing/);
  assert.match(replaySource, /sanitizeArtifactValue/);
});
