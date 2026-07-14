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
  assert.equal(row.playwright_configured, true);
  assert.equal(row.browser_driver, "playwright_cli");
  assert.equal(row.browser_use_configured, false);
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

test("sanitizes Daily AI Playwright CLI lane as Playwright configured without Browser Use fallback", () => {
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
          driver: "playwright_cli",
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

  assert.equal(row.playwright_configured, true);
  assert.equal(row.browser_driver, "playwright_cli");
  assert.equal(row.browser_use_configured, false);
  assert.deepEqual(metadata.playwright_result, {
    driver: "playwright_cli",
    evidenceCount: 2,
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
  assert.match(source, /function ProductionStatusPage/);
  assert.doesNotMatch(source, /function DashboardView|function CreateView|function RunsView|function SourcesView/);
});

test("frontend sends only sanitized planning text to the server planner", () => {
  const source = readAppSource();
  const chatSource = appSection(source, "function ChatPage", "function AutomationsPage");

  assert.match(chatSource, /const redactedActivePrompt = redactSensitiveText\(activePrompt\)/);
  assert.match(chatSource, /requestChatPlan\(redactedActivePrompt, selectedPlatforms\)/);
  assert.match(chatSource, /const redactedDraft = redactSensitiveText\(draftPrompt\)/);
  assert.match(chatSource, /requestChatPlan\(redactedDraft, selectedPlatforms\)/);
  assert.match(chatSource, /external_action_allowed: false/);
  assert.match(chatSource, /create_approval: true/);
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
  assert.match(appSource, /title="オペレーター確認"/);
  assert.match(appSource, /type="password"/);
});

test("frontend selects actionable runs and repairs stale selections on refresh and polling", () => {
  const source = readAppSource();
  const helperSource = appSection(source, "function runDispositionRank", "function newerRunSnapshot");
  const runsSource = appSection(source, "function RunsPage", "function LanesPage");

  assert.match(helperSource, /actionableRuns\.length \? actionableRuns : runs/);
  assert.match(helperSource, /runDispositionRank\(a\) - runDispositionRank\(b\)/);
  assert.match(runsSource, /setSelectedRunId\(\(current\) => resolveSelectedRunId\(current, state\.runs \?\? \[\], state\.actionableRuns \?\? \[\]\)\)/);
  assert.match(runsSource, /window\.setInterval/);
  assert.match(runsSource, /30000/);
});

test("frontend loads run-scoped details and prefers the newest run snapshot", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function LanesPage");

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
  const runsSource = appSection(source, "function RunsPage", "function LanesPage");

  assert.match(runsSource, /`\/api\/proofs\/\$\{encodeURIComponent\(selectedProofId\)\}\/view`/);
  assert.match(runsSource, /fetchApiJson<ProofView>\(viewerUrl\)/);
  assert.match(runsSource, /setSelectedProofId\(proof\.id\)/);
  assert.doesNotMatch(runsSource, /proof\?\.viewer_url|proof\.viewer_url/);
  assert.doesNotMatch(runsSource, /proof\.artifact_uri|proof\.uri|proof\.path|metadata_json/);
});

test("frontend redacts local paths URLs and secrets before run-detail display", () => {
  const source = readAppSource();
  const redactionSource = appSection(source, "function redactDisplayPaths", "function publicRunStatus");
  const runsSource = appSection(source, "function RunsPage", "function LanesPage");

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
  const runsSource = appSection(source, "function RunsPage", "function LanesPage");

  assert.match(source, /function publicRunStatus/);
  assert.match(source, /function publicBlockerSummary/);
  assert.match(runsSource, /label=\{publicRunStatus\(run\.status\)\}/);
  assert.match(runsSource, /publicBlockerSummary\(run\.exact_blocker\)/);
  assert.doesNotMatch(runsSource, /label=\{run\.status\}/);
  assert.doesNotMatch(runsSource, /\{run\.exact_blocker \?\? "-"/);
});

test("frontend normal history hides worker diagnostics and raw preview objects", () => {
  const source = readAppSource();
  const runsSource = appSection(source, "function RunsPage", "function LanesPage");

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
  const chatSource = appSection(source, "function ChatPage", "function AutomationsPage");

  assert.match(chatSource, /const resetChat = \(\) =>/);
  assert.match(chatSource, /setPrompt\(""\)/);
  assert.match(chatSource, /setRequestText\(""\)/);
  assert.match(chatSource, /setSelectedPlatforms\(\[\]\)/);
  assert.match(chatSource, /setPlannerReadback\(null\)/);
  assert.match(chatSource, /approval_policy: plan\.approvalPolicy/);
  assert.match(chatSource, /external_action_allowed: false/);
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
  const healthSource = appSection(source, 'app.get("/api/health"', "let researchPlanSchedulerTimer");

  assert.match(cacheSource, /getCodexCapabilities\(\)/);
  assert.match(cacheSource, /getBrowserHealth\(\)/);
  assert.match(cacheSource, /AUTOMATION_OS_DASHBOARD_CAPABILITY_CACHE_MS/);
  assert.match(healthSource, /deployment: getDeploymentReadback\(\)/);
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
  assert.match(replaySource, /AUTOMATION_OS_REPLAY_ALLOW_WRITE/);
  assert.match(replaySource, /production_write_guard_did_not_block_without_token/);
  assert.match(replaySource, /write_workflow_allowlist_missing/);
  assert.match(replaySource, /sanitizeArtifactValue/);
});
