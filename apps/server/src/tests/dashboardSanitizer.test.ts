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

test("frontend does not derive NisenPrints progress from contract requiredProofs", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.equal(source.includes("requiredProofs"), false);
  assert.equal(source.includes("Missing proof"), false);
  assert.match(source, /run_contract_summary/);
  assert.match(source, /contractProgress/);
  assert.match(source, /missingVisibleSteps/);
});

test("frontend chooses current run from actionableRuns instead of raw dashboard history", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /actionableRuns\?: Row\[\]/);
  assert.match(source, /resolveSelectedRunId\(current, body\.runs, body\.actionableRuns \?\? \[\]\)/);
  assert.match(source, /const dashboardActionableRuns = dashboard\.actionableRuns \?\? \[\]/);
  assert.match(source, /const currentRun = selectedRun;/);
  assert.equal(source.includes("selectedRun ?? dashboard.runs[0]"), false);
  assert.equal(source.includes("dashboard.runs.find((run) => run.id === selectedRunId) ?? dashboard.runs[0]"), false);
});

test("frontend home shows idle state instead of falling back to historical steps", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /const hasCurrentRun = Boolean\(props\.currentRun\)/);
  assert.match(source, /className=\{`grid dashboard-main-grid \$\{hasCurrentRun \? "" : "dashboard-main-grid--idle"\}`\}/);
  assert.match(source, /\{hasCurrentRun && \(\s*<Panel title="流れ"/);
  assert.match(source, /steps=\{props\.runSteps\}/);
  assert.match(source, /emptyText="なし"/);
  assert.doesNotMatch(source, /<Panel title="流れ"[\s\S]*steps=\{hasCurrentRun \? props\.runSteps : \[\]\}/);
  assert.equal(source.includes("props.runSteps.length ? props.runSteps : props.dashboard.steps"), false);
});

test("frontend primary nav uses beginner task buckets", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const primaryNavSource = source.slice(source.indexOf("const primaryNav"), source.indexOf("const advancedNav"));

  assert.match(primaryNavSource, /\["Dashboard", "今", Activity\]/);
  assert.match(primaryNavSource, /\["Create", "作る", MessageCircle\]/);
  assert.match(primaryNavSource, /\["Schedule", "定期", RefreshCcw\]/);
  assert.match(primaryNavSource, /\["Approvals", "確認", ShieldCheck\]/);
  assert.match(primaryNavSource, /\["Runs", "履歴", Play\]/);
  assert.doesNotMatch(primaryNavSource, /"ホーム"|"新規作成"|"実行履歴"|"承認"/);
});

test("frontend sidebar status copy avoids internal lane and partial wording", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const sidebarStatusSource = source.slice(source.indexOf("<aside className=\"sidebar\">"), source.indexOf("</aside>"));

  assert.match(sidebarStatusSource, /title=\{loading \? "同期中" : "OK"\}/);
  assert.match(sidebarStatusSource, /<span className="status-dot" aria-hidden="true" \/>/);
  assert.match(sidebarStatusSource, /className="sr-only">\{loading \? "同期中" : "OK"\}/);
  assert.match(styles, /\.online \.status-dot/);
  assert.doesNotMatch(styles, /\.online span/);
  assert.match(sidebarStatusSource, /<summary title="診断" aria-label="診断">\s*<Database size=\{16\} \/>\s*<span className="sr-only">診断<\/span>\s*<\/summary>/);
  assert.doesNotMatch(sidebarStatusSource, /<summary>診断<\/summary>/);
  assert.doesNotMatch(sidebarStatusSource, /<Metric label="使用中"/);
  assert.doesNotMatch(sidebarStatusSource, /<Metric label="進行中"/);
  assert.match(sidebarStatusSource, /<Metric label="承認待ち" value=\{String\(status\.pending\)\} warn=\{status\.pending > 0\} \/>/);
  assert.match(sidebarStatusSource, /<Metric label="確認が必要" value=\{String\(status\.partial\)\} warn=\{status\.partial > 0\} \/>/);
  assert.match(source, /partial: "確認が必要"/);
  assert.match(source, /execute_playwright: "画面確認"/);
  assert.match(source, /execute_nisenprints_registered: "NisenPrints実行"/);
  assert.match(source, /execute_prompt_transfer_registered: "転記実行"/);
  assert.match(source, /execute_sns_multi_poster_registered: "SNS投稿実行"/);
  assert.match(source, /human_input_required_with_evidence: "人間入力待ち"/);
  assert.doesNotMatch(sidebarStatusSource, /使用中レーン|途中停止|稼働中/);
  assert.doesNotMatch(source.slice(source.indexOf("const statusLabels"), source.indexOf("const workerModeLabels")), /partial: "途中停止"/);
});

test("frontend normal dashboard copy excludes internal terms", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const dashboardSource = source.slice(source.indexOf("function DashboardView"), source.indexOf("function ResumeContractCard"));
  const normalDashboardCopy = dashboardSource.slice(dashboardSource.indexOf("return ("), dashboardSource.indexOf("<details className=\"advanced-section\">"));

  assert.match(normalDashboardCopy, /<Panel title="今"/);
  assert.match(normalDashboardCopy, /<Panel title="定期"/);
  assert.match(normalDashboardCopy, /<Panel title="確認"/);
  assert.match(normalDashboardCopy, /<Panel title="流れ"/);
  assert.match(normalDashboardCopy, /<summary title="操作" aria-label="操作">\s*<Sparkles size=\{16\} \/>\s*<span className="sr-only">操作<\/span>\s*<\/summary>/);
  assert.doesNotMatch(normalDashboardCopy, /<summary>操作<\/summary>/);
  assert.doesNotMatch(normalDashboardCopy, /Obsidian|作業再開|作業ノート|proof|artifact|DB|Bridge|CDP|profile|runner|sidecar|Gemini|レーン|処理ログ|子Codex|内部証跡|provenance_json|last_started_at|exactBlocker/);
});

test("frontend separates quick start input from create planning copy", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /placeholder="すぐ開始する短い指示"/);
  assert.match(source, /aria-label="すぐ開始する短い指示"/);
  assert.match(source, /const \[command, setCommand\] = useState\(""\)/);
  assert.doesNotMatch(source, /restoredCreateSession\?\.command \?\? ""/);
  assert.match(source, /<h2>作る<\/h2>/);
  assert.doesNotMatch(source, /ここは相談と計画づくり用です。すぐ開始する短い指示は上の入力を使います。/);
  assert.match(source, /aria-label="相談して計画する内容"/);
  assert.doesNotMatch(source, /setCommand\(resolveCreateMessageCommand\(displayText, storedSecrets, advice\.command\)\)/);
  assert.equal(source.includes('aria-label="新規作成の相談内容"'), false);
});

test("frontend keeps compact home copy beginner friendly and internal terms in details", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const cardSource = source.slice(source.indexOf("function ObsidianSyncCard"), source.indexOf("function CreateView"));
  const normalCardSource = cardSource.slice(cardSource.indexOf("<div className=\"obsidian-sync-title\">"), cardSource.indexOf("<details className=\"internal-details obsidian-sync-details\">"));
  const detailsSource = cardSource.slice(cardSource.indexOf("<details className=\"internal-details obsidian-sync-details\">"));

  assert.match(source, /<strong>作業ノート<\/strong>/);
  assert.match(source, /作業ノートは最新です。最終更新/);
  assert.match(source, /function displayGeneratedFileCheckPublic/);
  assert.match(cardSource, /diagnostics = false/);
  assert.match(cardSource, /\{diagnostics && <details className="internal-details obsidian-sync-details">/);
  assert.doesNotMatch(normalCardSource, /Bridge|証跡|完了判断|前回理由/);
  assert.doesNotMatch(normalCardSource, /generatedFileCheckText/);
  assert.match(normalCardSource, /publicGeneratedFileCheckText/);
  assert.match(detailsSource, /外部操作の完了判断には使いません。/);
  assert.doesNotMatch(normalCardSource, /開発者向け診断/);
});

test("frontend keeps NisenPrints quick start cards compact with details steps", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");

  assert.match(source, /<article className="quick-start-card" key=\{quickStart\.key\}>/);
  assert.match(source, /<section className="quick-start-band compact">/);
  assert.match(source, /className="quick-start-start"/);
  assert.equal(source.includes('className="quick-start-card"\n              key={quickStart.key}\n              onClick='), false);
  assert.match(css, /\.quick-start-card \{\s*min-height: 154px;/);
  assert.match(css, /\.quick-start-start \{/);
  assert.match(css, /border-radius: 8px;/);
});

test("frontend falls back to generic user-facing labels instead of raw internals", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /completed: "完了"/);
  assert.match(source, /execute_codex: "Codex read-only実行"/);
  assert.match(source, /execute_child_codex: "別のAI作業"/);
  assert.match(source, /worker_receipt: "処理記録"/);
  assert.match(source, /codex_readonly_execution: "Codex read-only完了"/);
  assert.match(source, /codex_readonly_blocked: "Codex read-only停止"/);
  assert.match(source, /child_codex_result: "別のAI作業結果"/);
  assert.match(source, /child_codex_blocked: "別のAI作業停止"/);
  assert.match(source, /worker_completed: "処理完了"/);
  assert.match(source, /direct_publish: "投稿確認"/);
  assert.match(source, /return statusLabels\[value\] \?\? "状態不明"/);
  assert.match(source, /return proofTypeLabels\[value\] \?\? "確認記録"/);
  assert.match(source, /return eventTypeLabels\[value\] \?\? "処理ログ"/);
  assert.match(source, /return map\[value\] \?\? "操作に失敗しました"/);
  assert.match(source, /return displayCreatePlanText\(value\);/);
  assert.match(source, /\.replace\(\/Browser Use\/gi, "画面確認"\)/);
  assert.match(source, /\.replace\(\/\\bARTIFACTS\?\\b\/gi, "保存記録"\)/i);
  assert.doesNotMatch(source, /replace\(\s*\/_\//);
});

test("frontend run detail keeps child AI work in developer diagnostics", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const runsViewSource = source.slice(source.indexOf("function RunsView"), source.indexOf("function ApprovalsView"));

  assert.match(source, /childRuns: Row\[\]/);
  assert.match(source, /children: Row\[\]/);
  assert.match(runsViewSource, /<details className="internal-details">/);
  assert.match(runsViewSource, /<summary title="詳細" aria-label="詳細">詳細<\/summary>/);
  assert.match(source, /function ChildCodexRuns/);
  assert.match(source, /指示文と結果の保存場所は内部記録に保存済みです。/);
  assert.doesNotMatch(source, /prompt: \{String\(child\.prompt_uri/);
  assert.doesNotMatch(source, /result: \{String\(child\.result_uri/);
  assert.match(source, /この履歴には別のAI作業の結果はまだありません。保存記録だけの履歴とは別に表示します。/);
  assert.doesNotMatch(runsViewSource, /<h3>子Codex<\/h3>/);
});

test("frontend public UI source does not render raw internal details", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const createView = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const sourcesView = source.slice(source.indexOf("function SourcesView"), source.indexOf("function CodexParityLedgerPanel"));
  const parityView = source.slice(source.indexOf("function CodexParityLedgerPanel"), source.indexOf("function BrowserUseResultPanel"));
  const browserUseView = source.slice(source.indexOf("function BrowserUseResultPanel"), source.indexOf("function SkillsView"));
  const runSummaryView = source.slice(source.indexOf("function RunSummary"), source.indexOf("function Metric"));
  const laneView = source.slice(source.indexOf("function LaneMatrix"), source.indexOf("function ResearchTable"));
  const childView = source.slice(source.indexOf("function ChildCodexRuns"), source.indexOf("function WorkerEvents"));
  const drawerView = source.slice(source.indexOf("function DetailDrawer"), source.indexOf("function MarkdownPreview"));
  const publicUi = [
    createView,
    sourcesView,
    parityView,
    browserUseView,
    runSummaryView,
    laneView,
    childView,
    drawerView
  ].join("\n");

  assert.doesNotMatch(publicUi, /<pre>\{JSON\.stringify/);
  assert.doesNotMatch(publicUi, /target: \{|session: \{|cdp: \{|profile: \{|screenshot: \{|state: \{|log: \{|prompt: \{|result: \{|pid: \{|mode: \{/);
  assert.doesNotMatch(publicUi, /proofBoundary|sourceOfTruth|approvalBoundary|backendChecks\.map|prompt_uri|result_uri/);
  assert.doesNotMatch(publicUi, /browser_use_session|browser_use_cdp_url|browser_use_profile|profile_dir|cdp_port/);
  assert.doesNotMatch(publicUi, /proof\.uri/);
  assert.match(publicUi, /内部記録に保存済み/);
  assert.match(publicUi, /接続情報は内部記録に保存済み/);
});

test("frontend shows automation migration ledger only in Sources with short public copy", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const appRender = source.slice(source.indexOf("{activeView === \"Sources\""), source.indexOf("{activeView === \"Skills\""));
  const dashboardView = source.slice(source.indexOf("function DashboardView"), source.indexOf("function ResumeContractCard"));
  const scheduleView = source.slice(source.indexOf("function ScheduleView"), source.indexOf("function ApprovalsView"));
  const panelSource = source.slice(source.indexOf("function AutomationMigrationLedgerPanel"), source.indexOf("function BrowserUseResultPanel"));
  const visibleCopy = panelSource.replace(/summary\.[A-Za-z]+/g, "summary.value");

  assert.match(source, /codexAutomationMigrationLedger\?: Row/);
  assert.match(appRender, /codexAutomationMigrationLedger=\{dashboard\.codexAutomationMigrationLedger \?\? \{ items: \[\], summary: \{\} \}\}/);
  assert.match(panelSource, /<Panel title="移行状況" action=\{`\$\{total\}件`\}>/);
  assert.match(panelSource, /<span>移行済み<\/span>/);
  assert.match(panelSource, /<span>予定確認<\/span>/);
  assert.match(panelSource, /<span>実行確認<\/span>/);
  assert.match(panelSource, /<span>確認済み<\/span>/);
  assert.match(panelSource, /<span>要確認<\/span>/);
  assert.doesNotMatch(`${dashboardView}\n${scheduleView}`, /AutomationMigrationLedgerPanel|codexAutomationMigrationLedger|移行状況/);
  assert.doesNotMatch(visibleCopy, /raw path|json|provenance|proof|artifact|DB|CDP|profile|runner|sidecar|Gemini/);
});

test("frontend sources view keeps heavy source panels collapsed behind short details", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
  const sourcesView = source.slice(source.indexOf("function SourcesView"), source.indexOf("function CodexParityLedgerPanel"));
  const initialSources = sourcesView.slice(sourcesView.indexOf("return ("), sourcesView.indexOf("<details className=\"sources-more\">"));
  const visibleInitialSources = initialSources.replace(/onBridgeAction|bridge-obsidian_export/g, "");
  const workerSetupSource = source.slice(source.indexOf("function LocalWorkerSetupPanel"), source.indexOf("function CapabilityBacklogPanel"));
  const collapsedSources = sourcesView.slice(sourcesView.indexOf("<details className=\"sources-more\">"), sourcesView.indexOf("<div className=\"grid bottom-grid sources-detail-grid\">"));
  const browserUseResultSource = source.slice(source.indexOf("function BrowserUseResultPanel"), source.indexOf("function SkillsView"));

  assert.match(sourcesView, /<section className="grid bottom-grid sources-view">/);
  assert.match(sourcesView, /<LocalWorkerSetupPanel worker=\{localWorker\} \/>/);
  assert.match(workerSetupSource, /<Panel title="Mac worker"/);
  assert.match(workerSetupSource, /本番PostgreSQL接続を保存/);
  assert.match(workerSetupSource, /接続情報を保存/);
  assert.match(workerSetupSource, /接続を確認/);
  assert.match(workerSetupSource, /workerを起動/);
  assert.match(styles, /\.worker-setup-panel/);
  assert.match(packageJson, /"worker:production-proof": "npm run build:server && node apps\/server\/dist\/cli\/workerProductionPickupProof\.js"/);
  assert.match(sourcesView, /<details className="sources-more">/);
  assert.match(collapsedSources, /<summary>詳細<\/summary>/);
  assert.match(source, /function ResearchPlanList/);
  assert.match(sourcesView, /<Panel title="計画" action=\{`\$\{researchPlans\.length\}件`\}>/);
  assert.match(sourcesView, /<Panel title="操作" action=\{`\$\{bridgeCatalog\.length\}件`\}>/);
  assert.match(sourcesView, /<Panel title="外部" action=\{`\$\{bridgeExecutions\.length\}件`\}>/);
  assert.match(sourcesView, /<Panel title="保存" action=\{`\$\{knowledgeNotes\.length\}件`\}>/);
  assert.doesNotMatch(initialSources, /CodexParityLedgerPanel|AssetInventory|BrowserUseResultPanel|ResearchPlanList|ResearchTable|BridgeActionList|BridgeExecutionList|KnowledgeNotes/);
  assert.doesNotMatch(visibleInitialSources, /proof|artifact|DB|CDP|profile|runner|sidecar|Gemini|Browser Use|Research Plans|Bridge/);
  assert.doesNotMatch(workerSetupSource, /DATABASE_URL|POSTGRES_URI|AUTOMATION_OS_DATABASE_URL|auth\.json|OPENAI_API_KEY|CODEX_API_KEY|pid|codexBin/);
  assert.doesNotMatch(browserUseResultSource, /Browser Use実行結果|Browser Useで|証跡/);
});

test("frontend builds create advice from sanitized chat text", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");

  assert.match(source, /async function refreshCreatePlanner\(nextMessages: ChatMessage\[\], currentDraft: string\)/);
  assert.match(source, /fetchApiJson<\{ ok\?: boolean; plan\?: CreatePlannerPlan \}>\("\/api\/create\/plan"/);
  assert.match(source, /const historyForPlanner = \[\.\.\.createMessages, nextUserMessage\];/);
  assert.match(source, /advice = await refreshCreatePlanner\(historyForPlanner, createDraft\.command\);/);
  assert.match(source, /advice = automationAdvice\(displayText, mergedSecrets, createMessages\);/);
  assert.match(source, /function deepPlanningAdvice\(text: string, secrets: SecretSummary\[\] = \[\], history: ChatMessage\[\] = \[\]\)/);
  assert.match(source, /だいぶ具体化できました。/);
  assert.match(source, /確認したいこと/);
  assert.match(source, /intent\?: "answer_question" \| "plan_workflow"/);
  assert.match(source, /const answerOnly = props\.draft\.intent === "answer_question"/);
  assert.match(source, /advice\.intent === "answer_question"/);
  assert.match(source, /!answerOnly && <section className="decision-guidance"/);
  assert.match(source, /!answerOnly && <div className="visible-plan"/);
  assert.match(source, /!answerOnly && <div className="research-plan-actions"/);
  assert.match(source, /openQuestions\.map\(\(question\) => `・\$\{question\}`\)/);
  assert.match(source, /進め方/);
  assert.match(source, /次の一手/);
  assert.match(source, /正本にする画面・URL・DB・保存ファイルと、完了証拠はどれにしますか/);
  assert.match(source, /相談の整理/);
  assert.match(source, /確認できたこと/);
  assert.match(source, /未確認/);
  assert.match(source, /visibleSteps = \[/);
  assert.match(source, /目的と完了条件を確認/);
  assert.match(source, /小さく実行して結果を確認/);
  assert.match(styles, /\.chat-message div\s*\{[\s\S]*?white-space: pre-line;[\s\S]*?\}/);
  assert.match(styles, /\.conversation-brief/);
  assert.doesNotMatch(source, /Codex appの相談に近い形/);
  assert.doesNotMatch(source, /const advice = automationAdvice\(text, mergedSecrets\);/);
  assert.match(styles, /@media \(max-width: 1180px\)/);
});

test("frontend keeps initial home free of success notice copy", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const noticeStateSource = source.slice(source.indexOf("const [notice"), source.indexOf("const [selectedRunId"));
  const initialRefreshSource = source.slice(source.indexOf("useEffect(() => {"), source.indexOf("  useEffect(() => {", source.indexOf("useEffect(() => {") + 1));
  const noticeRenderSource = source.slice(source.indexOf("{(loading || notice) && ("), source.indexOf("{activeView === \"Dashboard\""));

  assert.match(noticeStateSource, /useState\(""\)/);
  assert.match(initialRefreshSource, /refresh\(false\);/);
  assert.doesNotMatch(initialRefreshSource, /refresh\(\);/);
  assert.match(noticeRenderSource, /\{\(loading \|\| notice\) && \(/);
  assert.match(source, /setNotice\("最新の状態に更新しました"\)/);
});

test("frontend dashboard shows local Mac worker status without internals", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const dashboardView = source.slice(source.indexOf("function DashboardView"), source.indexOf("function MiniSchedule"));
  const workerView = source.slice(source.indexOf("function LocalWorkerStatus"), source.indexOf("function MiniSchedule"));
  const workerStatusSource = serverSource.slice(serverSource.indexOf("function buildLocalWorkerStatus"), serverSource.indexOf("type PublicRegisteredWorkflowCheckKind"));

  assert.match(source, /localWorker\?: Row/);
  assert.match(dashboardView, /<Panel title="Mac worker"/);
  assert.match(workerView, /最終確認/);
  assert.match(workerView, /Mac workerはまだ確認できていません。/);
  assert.match(workerStatusSource, /worker:production-proof:stored/);
  assert.match(workerStatusSource, /worker:loop:stored/);
  assert.match(styles, /\.local-worker-status/);
  assert.doesNotMatch(workerView, /pid|codexBin|DATABASE_URL|POSTGRES_URI|auth\.json|OPENAI_API_KEY|CODEX_API_KEY/);
  assert.doesNotMatch(workerStatusSource, /DATABASE_URL|POSTGRES_URI|auth\.json|OPENAI_API_KEY|CODEX_API_KEY/);
});

test("frontend dashboard shows production readback without environment internals", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const dashboardView = source.slice(source.indexOf("function DashboardView"), source.indexOf("function DeploymentReadbackStatus"));
  const deploymentView = source.slice(source.indexOf("function DeploymentReadbackStatus"), source.indexOf("function LocalWorkerStatus"));

  assert.match(source, /deployment\?: Row/);
  assert.match(source, /deployment: \{\}/);
  assert.match(dashboardView, /<Panel title="本番"/);
  assert.match(dashboardView, /DeploymentReadbackStatus deployment=\{props\.dashboard\.deployment \?\? \{\}\}/);
  assert.match(deploymentView, /commit\.slice\(0, 7\)/);
  assert.match(deploymentView, /assets: \{assetLabel\}/);
  assert.match(deploymentView, /planner: \{plannerProvider\}/);
  assert.match(deploymentView, /計画: \{plannerModeLabel\}/);
  assert.match(deploymentView, /OpenAI API: \{openAiApiReady \? "キー設定済み" : "使わない"\}/);
  assert.match(deploymentView, /Codex bin: \{codexBinConfigured \? "明示設定" : "既定"\}/);
  assert.match(styles, /\.deployment-status/);
  assert.match(styles, /\.deployment-main/);
  assert.doesNotMatch(deploymentView, /DATABASE_URL|POSTGRES_URI|PASSWORD|SECRET|TOKEN|API_KEY|process\.env|\/src\/dist|webDistDir/);
});

test("worker loop keeps picked-up run count in the stopped heartbeat", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/cli/workerLoop.ts"), "utf8");

  assert.match(source, /let lastProcessed = 0;/);
  assert.match(source, /lastProcessed = summaries\.length;/);
  assert.match(source, /lastRunIds = summaries\.map/);
  assert.match(source, /host: hostname\(\)/);
  assert.match(source, /processed: lastProcessed/);
  assert.match(source, /runIds: lastRunIds/);
  assert.doesNotMatch(source, /lifecycle: "stopped"[\s\S]{0,120}processed: 0/);
});

test("dashboard only uses pid stale checks for same-host worker heartbeats", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const workerStatusSource = source.slice(source.indexOf("function buildLocalWorkerStatus"), source.indexOf("function buildLaunchdLocalWorkerStatus"));

  assert.match(workerStatusSource, /heartbeatHost/);
  assert.match(workerStatusSource, /sameHostHeartbeat/);
  assert.match(workerStatusSource, /hostname\(\)/);
  assert.match(workerStatusSource, /heartbeatHost !== "" && heartbeatHost === hostname\(\)/);
  assert.match(workerStatusSource, /sameHostHeartbeat && pid !== undefined && !processIsAlive\(pid\)/);
});

test("production worker pickup proof fails closed without leaking database secrets", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/cli/workerProductionPickupProof.ts"), "utf8");
  const storedSource = readFileSync(resolve(process.cwd(), "apps/server/src/cli/workerProductionFromStoredSecret.ts"), "utf8");
  const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");

  assert.match(source, /production_database_url_missing/);
  assert.match(source, /production_worker_pickup_proof/);
  assert.match(source, /workerProductionPickupProof/);
  assert.match(source, /workerLoop\.js/);
  assert.match(source, /processed >= 1/);
  assert.match(source, /runIds\.includes\(created\.runId\)/);
  assert.doesNotMatch(source, /console\.log\([^)]*DATABASE_URL/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL[^;\n]*(?:console|stdout|summary|writeFileSync)/);
  assert.doesNotMatch(source, /POSTGRES_URI/);
  assert.doesNotMatch(source, /AUTOMATION_OS_WRITE_TOKEN/);
  assert.match(storedSource, /stored_postgres_secret_missing/);
  assert.match(storedSource, /stored_postgres_secret_invalid_url/);
  assert.match(storedSource, /validUrl: false/);
  assert.match(storedSource, /validatePostgresUrl\(databaseUrl\)/);
  assert.match(storedSource, /AUTOMATION_OS_DATABASE_URL: validatedDatabaseUrl/);
  assert.match(storedSource, /DATABASE_URL: validatedDatabaseUrl/);
  assert.match(storedSource, /readStoredSecretByKind\("postgres"\)/);
  assert.doesNotMatch(storedSource, /AUTOMATION_OS_DATABASE_URL: databaseUrl/);
  assert.doesNotMatch(storedSource, /DATABASE_URL: process\.env\.DATABASE_URL/);
  assert.match(packageJson, /worker:production-proof:stored/);
  assert.match(packageJson, /worker:loop:stored/);
  assert.doesNotMatch(storedSource, /console\.log\([^)]*databaseUrl/);
  const postgresValidationSource = readFileSync(resolve(process.cwd(), "apps/server/src/cli/postgresUrlValidation.ts"), "utf8");
  assert.match(postgresValidationSource, /value\.trim\(\)/);
  assert.match(postgresValidationSource, /parsed\.protocol !== "postgres:" && parsed\.protocol !== "postgresql:"/);
  assert.match(postgresValidationSource, /!parsed\.hostname/);
  const readStoredPostgresSource = readFileSync(resolve(process.cwd(), "apps/server/src/cli/readStoredPostgresSecret.ts"), "utf8");
  assert.match(readStoredPostgresSource, /validatePostgresUrl\(value\)/);
  assert.doesNotMatch(readStoredPostgresSource, /\^postgres\(\?:ql\)\?:/);
});

test("frontend keeps create start disabled until sanitized draft is reflected", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const createMessageSource = source.slice(source.indexOf("async function sendCreateMessage"), source.indexOf("  useEffect(() => {"));
  const primaryNavSource = source.slice(source.indexOf("<nav className=\"primary-nav\">"), source.indexOf("<details className=\"advanced-nav\">"));
  const topbarSource = source.slice(source.indexOf("<header className=\"topbar\">"), source.indexOf("<div className={isErrorNotice(notice)"));
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const busySetIndex = createMessageSource.indexOf('setBusyKey("secret-save")');
  const sanitizeIndex = createMessageSource.indexOf("await saveAndSanitizeMessage(text, optimisticText)");
  const draftIndex = createMessageSource.indexOf("setCreateDraft(advice)");
  const secretCommandIndex = createMessageSource.indexOf('if (storedSecrets.length) setCommand(resolveCreateMessageCommand(displayText, storedSecrets, ""))');
  const busyClearIndex = createMessageSource.indexOf('setBusyKey((current) => current === "secret-save" ? null : current)');

  assert.ok(busySetIndex >= 0 && sanitizeIndex >= 0 && busySetIndex < sanitizeIndex);
  assert.ok(draftIndex >= 0 && secretCommandIndex >= 0 && busyClearIndex > secretCommandIndex && secretCommandIndex > draftIndex);
  assert.doesNotMatch(createMessageSource, /setCommand\(resolveCreateMessageCommand\(displayText, storedSecrets, advice\.command\)\)/);
  assert.doesNotMatch(createMessageSource, /setCommand\(advice\.command\)/);
  assert.match(primaryNavSource, /disabled=\{label === "Create" && busyKey === "secret-save"\}/);
  assert.match(topbarSource, /disabled=\{busyKey === "start" \|\| busyKey === "secret-save"\}/);
  assert.match(createViewSource, /const createMessageBusy = props\.busyKey === "secret-save";/);
  assert.match(createViewSource, /props\.busyKey === "research-plan-regularize"/);
  assert.match(createViewSource, /onClick=\{props\.onReset\} disabled=\{createActionBusy\}/);
  assert.match(createViewSource, /disabled=\{createActionBusy \|\| !props\.input\.trim\(\)\}/);
  assert.match(createViewSource, /disabled=\{createActionBusy \|\| !props\.draft\.command\.trim\(\)\}/);
  assert.match(createViewSource, /const scheduleAction = \{/);
  assert.match(createViewSource, /onClick: props\.onRegularize/);
  assert.match(createViewSource, /visibleActionCards\.map/);
  assert.match(createViewSource, /decisionGuidance\.recommended === action\.key/);
  assert.doesNotMatch(createViewSource, /<button type="button" disabled>\s*定期実行にする/);
});

test("frontend schedule view keeps compact public workflow labels", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const miniScheduleSource = source.slice(source.indexOf("function MiniSchedule"), source.indexOf("function ResumeContractCard"));
  const scheduleViewSource = source.slice(source.indexOf("function ScheduleView"), source.indexOf("function ApprovalsView"));
  const workflowNameSource = source.slice(source.indexOf("function displayWorkflowName"), source.indexOf("function displayWorkflowSchedule"));
  const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 700px)"));

  assert.match(source, /registeredWorkflows=\{dashboard\.registeredWorkflows\}/);
  assert.match(source, /async function runSchedulerOnce\(\)/);
  assert.match(source, /function extractResponseRunId\(body: Row\)/);
  assert.match(source, /const responseRunId = extractResponseRunId\(body\);/);
  assert.match(source, /if \(responseRunId\) setSelectedRunId\(responseRunId\);/);
  assert.match(source, /typeof nestedRun\.runId === "string"/);
  assert.match(source, /fetchApiJson<Row>\("\/api\/registered-workflows\/scheduler\/run-once"/);
  assert.match(source, /const blocked = Number\(body\.blocked \?\? 0\);/);
  assert.match(source, /const runIds = Array\.isArray\(body\.runIds\)/);
  assert.match(source, /if \(started > 0\) \{/);
  assert.match(source, /setActiveView\("Runs", false\);/);
  assert.match(source, /setNotice\(blocked > 0 \? `\$\{started\}件開始しました。確認が必要な予定が\$\{blocked\}件あります。` : `\$\{started\}件開始しました。履歴で進行状況を確認できます。`\)/);
  assert.match(source, /確認が必要な予定が\$\{blocked\}件あります。履歴と詳細に理由を保存しました。/);
  assert.match(source, /今すぐ動かせる予定はありません。各行の再生ボタンなら個別に一回実行できます。/);
  assert.doesNotMatch(source, /確認が必要な定期が\$\{blocked\}件あります/);
  assert.match(source, /busyKey === "scheduler-run-once"/);
  assert.match(source, /aria-label="今すぐ確認"/);
  assert.ok(source.includes('onRegisteredStart={(id) => post(`/api/registered-workflows/${encodeURIComponent(id)}/start`, "キューに入れました"'));
  assert.ok(source.includes("/api/registered-workflows/${encodeURIComponent(id)}/start"));
  assert.ok(source.includes("onRegisteredToggle={(workflow) => {"));
  assert.ok(source.includes("${paused ? \"resume\" : \"pause\"}"));
  assert.match(source, /async function updateRegisteredSchedule/);
  assert.match(source, /method: "PATCH"/);
  assert.ok(source.includes("/api/registered-workflows/${encodeURIComponent(id)}/schedule"));
  assert.ok(source.includes("onRegisteredSchedule={updateRegisteredSchedule}"));
  assert.ok(source.includes("productionGuard={dashboard.productionGuard ?? {}}"));
  assert.ok(source.includes("operatorWriteTokenReady={operatorWriteTokenReady}"));
  assert.match(source, /function ScheduleView/);
  assert.match(scheduleViewSource, /productionGuard: Row/);
  assert.match(scheduleViewSource, /operatorWriteTokenReady: boolean/);
  assert.match(scheduleViewSource, /const writeLocked = productionGuard\.required === true && productionGuard\.mode === "locked"/);
  assert.match(scheduleViewSource, /const writeTokenMissing = productionGuard\.required === true && productionGuard\.mode === "token_required" && !operatorWriteTokenReady/);
  assert.match(scheduleViewSource, /const writeDisabled = writeLocked \|\| writeTokenMissing/);
  assert.match(scheduleViewSource, /本番の実行ボタンは停止中です。Zeaburに実行用tokenを設定すると、ここから本番の保存先へ入り/);
  assert.match(scheduleViewSource, /このブラウザに操作tokenを保存すると、再生ボタンから本番の保存先へ送れます。/);
  assert.match(scheduleViewSource, /aria-label="操作token"/);
  assert.match(scheduleViewSource, /このブラウザは操作できます。/);
  assert.match(source, /const operatorWriteTokenStorageKey = "automation-os:operator-write-token:v1"/);
  assert.match(source, /function readStoredOperatorWriteToken/);
  assert.match(source, /headers\.set\("x-automation-os-token", token\)/);
  assert.match(scheduleViewSource, /disabled=\{writeDisabled \|\| busyKey === "scheduler-run-once"\}/);
  assert.match(scheduleViewSource, /disabled=\{writeDisabled \|\| busyKey === `registered-\$\{workflow\.id\}`\}/);
  assert.match(scheduleViewSource, /disabled=\{writeDisabled \|\| busyKey === `registered-toggle-\$\{workflow\.id\}`\}/);
  assert.match(scheduleViewSource, /disabled=\{writeDisabled \|\| scheduleBusy\}/);
  assert.match(source, /activeView === "Schedule"/);
  assert.match(source, /function isActiveRegisteredWorkflow/);
  assert.match(source, /function isPausedRegisteredWorkflow/);
  assert.match(source, /function isManagedRegisteredWorkflow/);
  assert.match(source, /toLowerCase\(\) === "active"/);
  assert.match(source, /toLowerCase\(\) === "paused"/);
  assert.match(source, /function displayWorkflowName\(workflow: Row\)/);
  assert.match(source, /function displayPublicAutomationName\(value\?: string\)/);
  assert.match(source, /return "Daily AI"/);
  assert.match(source, /job\[-_ \]\?application/);
  assert.match(source, /return "応募後"/);
  assert.match(source, /return "SNS"/);
  assert.match(source, /return "X"/);
  assert.match(source, /return "転記"/);
  assert.match(source, /return "朝チェック"/);
  const publicNameSource = source.slice(source.indexOf("function displayPublicAutomationName"), source.indexOf("function displayApprovalTitle"));
  assert.ok(publicNameSource.indexOf("/post[- ]application|follow[- ]up|応募後/i") < publicNameSource.indexOf("/job[-_ ]?application|job application|submit queue|応募/i"));
  assert.match(source, /const managedWorkflows = registeredWorkflows\.filter\(isManagedRegisteredWorkflow\)\.sort/);
  assert.ok(scheduleViewSource.indexOf("className={`schedule-check-chip") < scheduleViewSource.indexOf("<strong>{displayWorkflowName(workflow)}</strong>"));
  assert.ok(scheduleViewSource.indexOf("<strong>{displayWorkflowName(workflow)}</strong>") < scheduleViewSource.indexOf('className="schedule-time"'));
  assert.ok(scheduleViewSource.indexOf('className="schedule-time"') < scheduleViewSource.indexOf('className="schedule-row-actions"'));
  assert.ok(scheduleViewSource.indexOf('className="schedule-row-actions"') < scheduleViewSource.indexOf('title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "変更"}'));
  assert.ok(scheduleViewSource.indexOf('title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "変更"}') < scheduleViewSource.indexOf('title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : paused ? "再開" : "停止"}'));
  assert.ok(scheduleViewSource.indexOf('title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : paused ? "再開" : "停止"}') < scheduleViewSource.indexOf('title={writeLocked ? lockTitle : writeTokenMissing ? tokenTitle : "一回実行"}'));
  assert.match(scheduleViewSource, /<strong>\{displayWorkflowName\(workflow\)\}<\/strong>/);
  assert.match(scheduleViewSource, /<small>\{displayWorkflowMetaSummary\(workflow\)\}<\/small>/);
  assert.match(source, /onOpenRun=\{\(id\) => \{/);
  assert.match(source, /setSelectedRunId\(id\);/);
  assert.match(source, /setActiveView\("Runs", false\);/);
  assert.match(source, /function workflowLastRunId\(workflow: Row\)/);
  assert.match(scheduleViewSource, /const lastRunId = workflowLastRunId\(workflow\);/);
  assert.match(scheduleViewSource, /className="schedule-row-result schedule-row-result-link"/);
  assert.match(scheduleViewSource, /onClick=\{\(\) => onOpenRun\(lastRunId\)\}/);
  assert.match(scheduleViewSource, /aria-label=\{`\$\{displayWorkflowName\(workflow\)\}の前回の履歴を見る`\}/);
  assert.match(scheduleViewSource, /<small className="schedule-row-result">\{displayWorkflowLastActionSummary\(workflow\)\}<\/small>/);
  assert.match(scheduleViewSource, /<div className="schedule-row-actions" role="group" aria-label=\{`\$\{displayWorkflowName\(workflow\)\}の操作`\}>/);
  assert.match(styles, /\.schedule-row\s*\{[\s\S]*?grid-template-columns: 54px minmax\(0, 1fr\) minmax\(64px, auto\) auto;/);
  assert.match(styles, /\.schedule-row-main\s*\{[\s\S]*?display: grid;[\s\S]*?gap: 3px;[\s\S]*?\}/);
  assert.match(styles, /\.schedule-row-main small\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
  assert.match(styles, /\.schedule-row-main \.schedule-row-result\s*\{[\s\S]*?color: var\(--muted\);[\s\S]*?\}/);
  assert.match(styles, /\.schedule-row-result-link\s*\{[\s\S]*?display: inline-flex;[\s\S]*?background: transparent;[\s\S]*?text-align: left;[\s\S]*?\}/);
  assert.match(styles, /\.schedule-row-result-link span\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
  assert.match(styles, /\.schedule-check-chip\s*\{[\s\S]*?min-width: 44px;[\s\S]*?max-width: 54px;[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
  assert.match(styles, /\.schedule-row-actions\s*\{[\s\S]*?display: inline-flex;[\s\S]*?gap: 8px;[\s\S]*?justify-self: end;[\s\S]*?\}/);
  assert.match(mobileStyles, /\.schedule-row\s*\{[\s\S]*?grid-template-columns: 48px minmax\(0, 1fr\);[\s\S]*?gap: 10px;[\s\S]*?align-items: start;[\s\S]*?padding: 12px 0;[\s\S]*?\}/);
  assert.match(mobileStyles, /\.schedule-row-actions\s*\{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: auto;[\s\S]*?align-self: center;[\s\S]*?\}/);
  assert.match(mobileStyles, /\.schedule-edit\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 36px 36px;[\s\S]*?justify-content: stretch;[\s\S]*?\}/);
  assert.match(mobileStyles, /\.schedule-edit select,\s*\.schedule-edit input\s*\{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?width: 100%;[\s\S]*?\}/);
  assert.match(mobileStyles, /\.schedule-edit button\[type="submit"\]\s*\{[\s\S]*?grid-column: 2;[\s\S]*?\}/);
  assert.match(mobileStyles, /\.schedule-edit button\[type="button"\]\s*\{[\s\S]*?grid-column: 3;[\s\S]*?\}/);
  assert.match(source, /function displayWorkflowScheduleShort\(workflow: Row\)/);
  assert.ok(source.includes('title={displayWorkflowSchedule(workflow)}'));
  assert.ok(source.includes('{displayWorkflowScheduleShort(workflow)}'));
  assert.match(source, /className="sr-only">\{displayWorkflowSchedule\(workflow\)\}/);
  assert.match(source, /typeof workflow\.schedule_label === "string"/);
  assert.match(source, /const needsCheck = Boolean\(workflow\.needs_check\);/);
  assert.match(source, /const paused = isPausedRegisteredWorkflow\(workflow\);/);
  assert.match(source, /function displayWorkflowCheckLabel\(workflow: Row\)/);
  assert.match(source, /displayWorkflowCheckLabel\(workflow\)/);
  assert.match(source, /function displayWorkflowTrustLabel\(workflow: Row\)/);
  assert.match(source, /function displayWorkflowFreshnessLabel\(workflow: Row\)/);
  assert.match(source, /function displayWorkflowMetaSummary\(workflow: Row\)/);
  assert.match(source, /function displayWorkflowLastActionSummary\(workflow: Row\)/);
  assert.match(source, /workflow\.last_action_label/);
  assert.match(source, /workflow\.last_run_id/);
  assert.match(source, /workflow\.last_result_label/);
  assert.match(source, /workflow\.next_action_label/);
  assert.match(source, /次: \$\{next\}/);
  const workflowMetaSource = source.slice(source.indexOf("function displayWorkflowMetaSummary"), source.indexOf("function workflowCheckTone"));
  assert.match(workflowMetaSource, /displayWorkflowTrustLabel\(workflow\)/);
  assert.match(workflowMetaSource, /displayWorkflowFreshnessLabel\(workflow\)/);
  assert.match(workflowMetaSource, /displayWorkflowBoundaryTitle\(workflow\)/);
  assert.match(source, /function workflowCheckTone\(workflow: Row\)/);
  assert.match(source, /workflowCheckTone\(workflow\)/);
  assert.match(source, /workflow\.check_label/);
  assert.match(source, /workflow\.check_kind/);
  assert.match(source, /workflow\.trust_label/);
  assert.match(source, /workflow\.trust_kind/);
  assert.match(source, /workflow\.freshness_label/);
  assert.match(source, /workflow\.freshness_kind/);
  assert.match(source, /workflow\.boundary_label/);
  assert.match(source, /displayWorkflowStateTitle\(workflow\)/);
  assert.doesNotMatch(scheduleViewSource, /latestRunAt|latestRun_at|evidenceUpdatedAt|evidence_updated_at/);
  assert.doesNotMatch(miniScheduleSource, /trust_label|trust_kind|freshness_label|freshness_kind|latestRunAt|latestRun_at|evidenceUpdatedAt|evidence_updated_at/);
  assert.doesNotMatch(scheduleViewSource, /paused \? "停止" : needsCheck \? "確認" : "OK"/);
  assert.match(source, /title=\{writeLocked \? lockTitle : writeTokenMissing \? tokenTitle : paused \? "再開" : "停止"\}/);
  assert.match(source, /aria-label=\{`\$\{displayWorkflowName\(workflow\)\}を\$\{paused \? "再開" : "停止"\}`\}/);
  assert.match(source, /title=\{writeLocked \? lockTitle : writeTokenMissing \? tokenTitle : "変更"\}/);
  assert.match(source, /aria-label=\{`\$\{displayWorkflowName\(workflow\)\}の予定を変更`\}/);
  assert.match(source, /<option value="daily">毎日<\/option>/);
  assert.match(source, /<option value="weekly">毎週<\/option>/);
  assert.match(source, /aria-label="時刻"/);
  assert.match(source, /aria-label="曜日"/);
  assert.match(source, /title=\{writeLocked \? lockTitle : writeTokenMissing \? tokenTitle : "保存"\}/);
  assert.match(source, /title=\{writeLocked \? lockTitle : writeTokenMissing \? tokenTitle : "一回実行"\}/);
  assert.match(source, /aria-label=\{`\$\{displayWorkflowName\(workflow\)\}を一回実行`\}/);
  assert.match(source, /const needsCheck = active\.filter\(\(workflow\) => Boolean\(workflow\.needs_check\)\);/);
  assert.match(miniScheduleSource, /className="mini-schedule compact"/);
  assert.match(miniScheduleSource, /const paused = workflows\.filter\(isPausedRegisteredWorkflow\);/);
  assert.match(miniScheduleSource, /停止 \$\{paused\.length\}件/);
  assert.match(miniScheduleSource, /title="予定"/);
  assert.match(miniScheduleSource, /<span className="sr-only">予定はありません<\/span>/);
  assert.match(miniScheduleSource, /<span>稼働中<\/span>/);
  assert.match(miniScheduleSource, /<span>要確認<\/span>/);
  assert.match(miniScheduleSource, /<span>朝チェック<\/span>/);
  assert.doesNotMatch(miniScheduleSource, /<span>予定<\/span>|<span>確認<\/span>|<span>朝<\/span>/);
  assert.doesNotMatch(miniScheduleSource, /確認が必要<\/span>/);
  assert.doesNotMatch(miniScheduleSource, /<Empty text="まだありません。"/);
  assert.doesNotMatch(miniScheduleSource, /動く予定/);
  assert.doesNotMatch(source, /function displayRegisteredLastStarted/);
  assert.doesNotMatch(miniScheduleSource, /provenance_json|exactBlocker|last_started_at|lastStartedAt|displayRegisteredLastStarted/);
  assert.doesNotMatch(scheduleViewSource, /<strong>\{workflow\.name\}<\/strong>/);
  assert.doesNotMatch(scheduleViewSource, /readiness|runner_status|last_started_at|lastStartedAt|displayRegisteredLastStarted\(workflow\)/);
  assert.doesNotMatch(scheduleViewSource, /title="[^"]*(scheduler|run-once|runner|provenance|exactBlocker)[^"]*"/i);
  assert.doesNotMatch(scheduleViewSource, /aria-label="[^"]*(scheduler|run-once|runner|provenance|exactBlocker)[^"]*"/i);
  assert.doesNotMatch(scheduleViewSource, /provenance_json|schedule_json|source_refs_json|start_command_json|project_root|scheduleControl|scheduleOverride|RRULE/);
  assert.doesNotMatch(scheduleViewSource, /\/Users|data\/artifacts|raw path|json|provenance|proof|artifact|DB|CDP|profile|runner|sidecar|Gemini|exactBlocker/);
});

test("server dashboard registered workflows expose only public row keys", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const registeredWorkflowApiSource = source.slice(source.indexOf('app.get("/api/registered-workflows"'), source.indexOf('app.get("/api/browser/health"'));
  const dashboardSource = source.slice(source.indexOf("export function getDashboard"), source.indexOf("function publicRegisteredWorkflow"));
  const approvalInboxSource = source.slice(source.indexOf("function buildApprovalInbox"), source.indexOf("function publicRegisteredWorkflow"));
  const publicWorkflowSource = source.slice(source.indexOf("function publicRegisteredWorkflow"), source.indexOf("function indexMigrationLedgerByRegisteredWorkflowId"));
  const returnSource = publicWorkflowSource.slice(publicWorkflowSource.indexOf("return {"), publicWorkflowSource.indexOf("  };", publicWorkflowSource.indexOf("return {")) + 4);
  const approvalReturnSource = approvalInboxSource.slice(approvalInboxSource.indexOf("return {"), approvalInboxSource.indexOf("  };", approvalInboxSource.indexOf("return {")) + 4);
  const returnedKeys = [...returnSource.matchAll(/^\s{4}([a-zA-Z_]+):/gm)].map((match) => match[1]);
  const approvalReturnedKeys = [...approvalReturnSource.matchAll(/^\s{6}([a-zA-Z_]+):/gm)].map((match) => match[1]);

  assert.match(registeredWorkflowApiSource, /res\.json\(\{ workflows: publicRegisteredWorkflowRows\(initRegisteredWorkflows\(\)\) \}\)/);
  assert.match(registeredWorkflowApiSource, /res\.json\(\{ workflows: publicRegisteredWorkflowRows\(refreshRegisteredWorkflows\(\)\) \}\)/);
  assert.match(registeredWorkflowApiSource, /workflow: publicRegisteredWorkflowById\(workflow\.id\)/);
  assert.match(registeredWorkflowApiSource, /runId: publicRun\.runId/);
  assert.match(registeredWorkflowApiSource, /status: publicRun\.status/);
  assert.match(registeredWorkflowApiSource, /workflow: publicRegisteredWorkflowById\(workflow\.id\),[\s\S]*run: publicRun/);
  assert.match(registeredWorkflowApiSource, /\bworkerProtocol,/);
  assert.match(registeredWorkflowApiSource, /const workerProtocol = dbBackend === "postgres" \? "mac_worker_polling_required" : "local_worker_loop_required"/);
  assert.match(registeredWorkflowApiSource, /recordRunAwaitingWorkerLoop\(run\.runId, "registered_workflow_manual_start"\)/);
  assert.doesNotMatch(registeredWorkflowApiSource, /startWorkerOnceDetached\(run\.runId, "registered_workflow_manual_start"\)/);
  assert.doesNotMatch(source, /local_worker_inline/);
  assert.match(source, /recordRunAwaitingWorkerLoop\(runId, "create_run_start"\)/);
  assert.doesNotMatch(registeredWorkflowApiSource, /res\.json\(\{ workflows: initRegisteredWorkflows\(\) \}\)|res\.json\(\{ workflows: refreshRegisteredWorkflows\(\) \}\)|res\.json\(\{ workflow, run, startCommand: command \}\)/);
  assert.match(dashboardSource, /const codexAutomationMigrationLedger = buildCodexAutomationMigrationLedger/);
  assert.match(dashboardSource, /registeredWorkflows: publicRegisteredWorkflows/);
  assert.match(dashboardSource, /productionGuard: getProductionWriteGuardStatus\(\)/);
  assert.match(dashboardSource, /const approvalInboxRows = latestPendingApprovalInboxRows\(rawApprovalInboxRows as ApprovalInboxSourceRow\[\]\)/);
  assert.match(dashboardSource, /WITH pending_approvals AS/);
  assert.match(dashboardSource, /ranked_approvals AS/);
  assert.match(dashboardSource, /json_extract\(runs\.metadata_json, '\$\.registeredWorkflowId'\)/);
  assert.match(dashboardSource, /ROW_NUMBER\(\) OVER \(PARTITION BY workflow_key ORDER BY created_at DESC, id DESC\)/);
  assert.doesNotMatch(dashboardSource, /WHERE approvals\.status='pending'[\s\S]{0,300}LIMIT 200/);
  assert.match(dashboardSource, /LIMIT 12/);
  assert.match(dashboardSource, /runs\.metadata_json AS run_metadata_json/);
  assert.match(dashboardSource, /approvals\.created_at/);
  assert.match(dashboardSource, /approvals: buildApprovalInbox\(approvalInboxRows\)/);
  assert.match(dashboardSource, /approvalInbox: buildApprovalInbox\(approvalInboxRows\)/);
  assert.match(dashboardSource, /externalPreflightChecklist: buildExternalPreflightChecklist\(\)/);
  assert.match(dashboardSource, /codexAutomationMigrationLedger,/);
  assert.match(source, /function latestPendingApprovalInboxRows/);
  assert.match(source, /function approvalInboxWorkflowKey/);
  assert.match(source, /registeredWorkflowId/);
  assert.match(source, /registered_workflow_id/);
  assert.match(source, /workflowId/);
  assert.match(source, /workflow_id/);
  assert.match(source, /AUTOMATION_OS_REGISTERED_WORKFLOW_ID/);
  assert.match(source, /return inboxRows\.slice\(0, 12\)/);
  assert.deepEqual(approvalReturnedKeys, ["id", "run_id", "task_label", "status", "action_kind", "action_label", "boundary_label", "execution_label", "decision_enabled"]);
  assert.doesNotMatch(approvalReturnSource, /title|objective|resource_locks|metadata|proof|artifact|runner|provenance|exactBlocker|path|json/);
  assert.match(approvalInboxSource, /function buildExternalPreflightChecklist/);
  assert.match(approvalInboxSource, /\{ key: "billing_only_hard_stop", label: "課金・購入・支払い・決済だけ停止", state: "ok" \}/);
  assert.doesNotMatch(approvalInboxSource.slice(approvalInboxSource.indexOf("function buildExternalPreflightChecklist"), approvalInboxSource.indexOf("function publicApprovalTaskLabel")), /title|objective|resource_locks|metadata|proof|artifact|runner|provenance|exactBlocker|path|json/);
  assert.deepEqual(returnedKeys, [
    "id",
    "name",
    "status",
    "schedule_label",
    "boundary_label",
    "needs_check",
    "check_kind",
    "check_label",
    "trust_kind",
    "trust_label",
    "freshness_kind",
    "freshness_label",
    "safety_kind",
    "safety_label",
    "last_action_label",
    "last_result_label",
    "next_action_label",
    "last_run_id",
    "next_action_view"
  ]);
  assert.match(returnSource, /id: workflow\.id/);
  assert.match(returnSource, /name: publicWorkflowName\(workflow\)/);
  assert.match(returnSource, /status: paused \? "paused" : workflow\.status/);
  assert.match(returnSource, /schedule_label: effectiveSchedule\.label/);
  assert.match(returnSource, /boundary_label: publicRegisteredWorkflowBoundaryLabel\(workflow\)/);
  assert.match(returnSource, /needs_check:/);
  assert.match(returnSource, /check_kind: checkKind/);
  assert.match(returnSource, /check_label: publicCheckLabel\(checkKind\)/);
  assert.match(returnSource, /trust_kind: trustKind/);
  assert.match(returnSource, /trust_label: publicTrustLabel\(trustKind\)/);
  assert.match(returnSource, /freshness_kind: freshnessKind/);
  assert.match(returnSource, /freshness_label: publicFreshnessLabel\(freshnessKind\)/);
  assert.match(returnSource, /safety_kind: safetyKind/);
  assert.match(returnSource, /safety_label: publicSafetyLabel\(safetyKind\)/);
  assert.match(returnSource, /last_action_label: lastAction\.action/);
  assert.match(returnSource, /last_result_label: lastAction\.result/);
  assert.match(returnSource, /next_action_label: lastAction\.next/);
  assert.match(returnSource, /last_run_id: lastRunId/);
  assert.match(returnSource, /next_action_view: publicRegisteredWorkflowNextActionView\(lastAction\.next, lastRunId\)/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowNextActionView/);
  assert.doesNotMatch(returnSource, /latestRunAt|evidenceUpdatedAt|remainingBlocker|proof|artifact|provenance_json|source_refs_json|start_command_json|project_root|runner_status|runner_kind|schedule_json|scheduleControl/);
  assert.match(source, /type PublicRegisteredWorkflowCheckKind = "none" \| "billing" \| "boundary" \| "proof" \| "runner" \| "schedule"/);
  assert.match(source, /type PublicRegisteredWorkflowTrustKind = "high" \| "medium" \| "low" \| "unknown"/);
  assert.match(source, /type PublicRegisteredWorkflowFreshnessKind = "fresh" \| "recent" \| "stale" \| "unknown"/);
  assert.match(source, /type PublicRegisteredWorkflowSafetyKind = "billing_only" \| "review"/);
  assert.match(source, /type PublicRegisteredWorkflowBoundaryKind = "post" \| "submit" \| "send" \| "auth" \| "save" \| "review" \| "external"/);
  assert.match(publicWorkflowSource, /function registeredWorkflowCheckKind/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowRows/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowById/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowLastAction/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowLedgerByWorkflowId/);
  assert.match(publicWorkflowSource, /runs: querySql<CodexAutomationMigrationRunRow>/);
  assert.match(publicWorkflowSource, /proofs: querySql<CodexAutomationMigrationProofRow>/);
  assert.match(publicWorkflowSource, /approvals: querySql<CodexAutomationMigrationApprovalRow>/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowTrustKind/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowFreshnessKind/);
  assert.match(publicWorkflowSource, /function publicCheckLabel/);
  assert.match(publicWorkflowSource, /function publicRegisteredWorkflowBoundaryLabel/);
  assert.match(publicWorkflowSource, /if \(isResearchPlanRegisteredWorkflow\(workflow\)\) return "review";/);
  assert.match(publicWorkflowSource, /if \(isResearchPlanRegisteredWorkflow\(workflow\)\) return "朝チェック";/);
  assert.match(publicWorkflowSource, /command\.source === "research_plan"/);
  assert.match(publicWorkflowSource, /投稿可・課金停止/);
  assert.match(publicWorkflowSource, /応募可・課金停止/);
  assert.match(publicWorkflowSource, /送信可・課金停止/);
  assert.match(publicWorkflowSource, /人間入力を証跡化/);
  assert.match(publicWorkflowSource, /保存可・課金停止/);
  assert.match(publicWorkflowSource, /確認/);
  assert.match(publicWorkflowSource, /function publicWorkflowName/);
  assert.match(publicWorkflowSource, /return "SNS"/);
  assert.match(publicWorkflowSource, /return "X"/);
  assert.match(publicWorkflowSource, /return "転記"/);
});

test("frontend mini schedule shows a short morning summary without internals", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const miniScheduleSource = source.slice(source.indexOf("function MiniSchedule"), source.indexOf("function ResumeContractCard"));
  const morningWorkflowSource = source.slice(source.indexOf("function isMorningCheckWorkflow"), source.indexOf("function displayWorkflowSchedule"));

  assert.match(miniScheduleSource, /const morningWorkflow = active\.find\(isMorningCheckWorkflow\);/);
  assert.match(miniScheduleSource, /const morningSummary = morningWorkflow \? displayMorningWorkflowSummary\(morningWorkflow\) : null;/);
  assert.match(miniScheduleSource, /<strong>\{morningSummary\}<\/strong>/);
  assert.match(miniScheduleSource, /title="朝チェック"/);
  assert.match(miniScheduleSource, /<span>朝チェック<\/span>/);
  assert.match(morningWorkflowSource, /workflow\.schedule_label/);
  assert.match(morningWorkflowSource, /return "確認";/);
  assert.match(morningWorkflowSource, /\\b09:00\\b/);
  assert.doesNotMatch(`${miniScheduleSource}\n${morningWorkflowSource}`, /workflow\.name|provenance_json|last_started_at|proof|artifact|DB|CDP|profile|runner|sidecar|Gemini|exactBlocker/);
});

test("frontend home keeps empty and navigation text minimal", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const dashboardSource = source.slice(source.indexOf("function DashboardView"), source.indexOf("function MiniSchedule"));
  const topbarSource = source.slice(source.indexOf("<header className=\"topbar\">"), source.indexOf("{activeView === \"Dashboard\""));
  const panelSource = source.slice(source.indexOf("function Panel"), source.indexOf("function Timeline"));
  const approvalQueueSource = source.slice(source.indexOf("function ApprovalQueue"), source.indexOf("function ReceiptTable"));

  assert.match(topbarSource, /<summary title="診断" aria-label="診断">\s*<Database size=\{16\} \/>\s*<span className="sr-only">診断<\/span>\s*<\/summary>/);
  assert.doesNotMatch(topbarSource, /<summary>診断<\/summary>/);
  assert.match(dashboardSource, /<Panel title="今" action="" actionLabel="履歴"/);
  assert.match(dashboardSource, /<Panel title="定期" action="" actionLabel="定期"/);
  assert.match(dashboardSource, /<Panel title="確認" action="" actionLabel="確認"/);
  assert.match(dashboardSource, /\{hasCurrentRun && \(\s*<Panel title="流れ" action="" actionLabel="履歴"/);
  assert.match(dashboardSource, /<summary title="操作" aria-label="操作">\s*<Sparkles size=\{16\} \/>\s*<span className="sr-only">操作<\/span>\s*<\/summary>/);
  assert.doesNotMatch(dashboardSource, /<summary>操作<\/summary>/);
  assert.match(dashboardSource, /<summary title="診断" aria-label="診断">\s*<Database size=\{16\} \/>\s*<span className="sr-only">診断<\/span>\s*<\/summary>/);
  assert.doesNotMatch(dashboardSource, /<summary>診断<\/summary>/);
  assert.match(dashboardSource, /emptyText="なし"/);
  assert.doesNotMatch(dashboardSource, /今はありません。|待ちなし。/);
  assert.match(panelSource, /className=\{action \? undefined : "icon-only"\}/);
  assert.match(panelSource, /\{action && <span>\{action\}<\/span>\}/);
  assert.match(approvalQueueSource, /props\.full \? "承認待ちはありません。" : "0"/);
});

test("frontend create initial state is generic and not NisenPrints-specific", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const initialMessages = source.slice(source.indexOf("const initialCreateMessages"), source.indexOf("function asJson"));
  const suggestions = source.slice(source.indexOf("const createSuggestions"), source.indexOf("const initialCreatePrompt"));
  const createView = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const savedSecretsEffect = source.slice(source.indexOf("id: \"assistant-saved-secrets\""), source.indexOf("  }, [dashboard.secrets]"));
  const adviceSource = source.slice(source.indexOf("function automationAdvice"), source.indexOf("export default function App"));
  const genericAdvice = adviceSource.slice(adviceSource.lastIndexOf("return {"));
  const initialDraft = source.match(/restoredCreateSession\?\.draft \?\? automationAdvice\(initialCreatePrompt\)/)?.[0] ?? "";
  const initialCreateSurface = [initialMessages, suggestions, createView.match(/placeholder="[^"]+"/)?.[0] ?? "", savedSecretsEffect, initialDraft, genericAdvice].join("\n");

  assert.match(source, /const initialCreatePrompt = "毎日の作業を相談しながら自動化したい";/);
  assert.match(initialDraft, /automationAdvice\(initialCreatePrompt\)/);
  assert.doesNotMatch(initialCreateSurface, /NisenPrints|Etsy|Printify|Obsidian/);
  assert.doesNotMatch(source, /保存済み: \{secretLabels\((props\.secrets|dashboard\.secrets)\)\.join/);
  assert.match(initialCreateSurface, /毎朝の確認作業を自動化したい/);
  assert.match(initialCreateSurface, /申請や予約の状況を見て次の対応を決めたい/);
});

test("frontend create save includes pending composer input before saving", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const appSource = source.slice(source.indexOf("export default function App"), source.indexOf("function CreateView"));
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));

  assert.match(appSource, /async function saveCreatePlan\(\)/);
  assert.match(appSource, /const pendingInput = createInput\.trim\(\)/);
  assert.match(appSource, /const draft = await sendCreateMessage\(pendingInput\)/);
  assert.match(appSource, /return saveResearchPlanForDraft\("research-plan-save", draft\)/);
  assert.match(appSource, /onSavePlan=\{saveCreatePlan\}/);
  assert.match(createViewSource, /aria-label="相談を送信"/);
  assert.match(createViewSource, /<textarea/);
  assert.match(createViewSource, /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(createViewSource, /event\.preventDefault\(\)/);
  assert.doesNotMatch(createViewSource, /if \(event\.key === "Enter"\) void props\.onSend\(\)/);
});

test("frontend run detail prefers fresher dashboard status over stale detail snapshot", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helperSource = source.slice(source.indexOf("function newerRunSnapshot"), source.indexOf("function isRunDetail"));
  const appSource = source.slice(source.indexOf("export default function App"), source.indexOf("function CreateView"));

  assert.match(helperSource, /function newerRunSnapshot\(detailRun\?: Row, dashboardRun\?: Row\)/);
  assert.match(helperSource, /dashboardTime > detailTime/);
  assert.match(appSource, /const selectedRunDetailRun = selectedRunDetail\?\.run\?\.id === selectedRunId \? selectedRunDetail\.run : undefined/);
  assert.match(appSource, /const selectedRun = newerRunSnapshot\(selectedRunDetailRun, dashboardSelectedRun\)/);
  assert.doesNotMatch(appSource, /selectedRunDetail\?\.run\?\.id === selectedRunId \? selectedRunDetail\.run : dashboardSelectedRun/);
});

test("frontend worker result uses newest worker event instead of stale started event", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helperSource = source.slice(source.indexOf("function buildWorkerResultSummary"), source.indexOf("function workerEventBlockerSummary"));

  assert.match(helperSource, /filter\(\(event\) => \["worker_completed", "worker_blocked", "worker_started", "worker_once_blocked"\]/);
  assert.match(helperSource, /sort\(\(a, b\) => Date\.parse\(String\(b\.created_at \?\? ""\)\) - Date\.parse\(String\(a\.created_at \?\? ""\)\)\)\[0\]/);
  assert.doesNotMatch(helperSource, /\[\.\.\.events\]\.reverse\(\)\.find/);
});

test("frontend create advice can still concretize explicit Etsy Printify and Obsidian input", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const adviceSource = source.slice(source.indexOf("function automationAdvice"), source.indexOf("export default function App"));
  const printifyBranchIndex = adviceSource.indexOf("/printify|publishing|固着|商品id|product_id|product id/");
  const etsyBranchIndex = adviceSource.indexOf("/etsy|listing|リスティング|正本|公開リスト/");

  assert.match(adviceSource, /\/printify\|publishing\|固着\|商品id\|product_id\|product id\//);
  assert.match(adviceSource, /command: "NisenPrints Printify recovery 途中復旧"/);
  assert.ok(printifyBranchIndex >= 0 && etsyBranchIndex >= 0 && printifyBranchIndex < etsyBranchIndex);
  assert.match(adviceSource, /\/etsy\|listing\|リスティング\|正本\|公開リスト\//);
  assert.match(adviceSource, /command: "NisenPrints Etsy Sync current listings 正本同期"/);
  assert.match(adviceSource, /\/obsidian\|wiki\|vault\//);
  assert.match(adviceSource, /command: "Obsidian Wiki ingest compile lint automation"/);
});

test("frontend generic create advice does not name saved provider keys", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fallbackSource = source.slice(source.indexOf("function deepPlanningAdvice"), source.indexOf("function savedSecretAdvice"));
  const appSource = source.slice(source.indexOf("export default function App"), source.indexOf("function Header"));

  assert.doesNotMatch(fallbackSource, /secretLabels\(secrets\)\.join/);
  assert.doesNotMatch(appSource, /assistant-saved-secrets|前回保存した認証情報があるので、必要な自動化/);
  assert.doesNotMatch(fallbackSource, /Etsy APIキー|Printify APIキー|Obsidian/);
});

test("frontend Obsidian sync card keeps executor boundary out of normal copy", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const cardSource = source.slice(source.indexOf("function ObsidianSyncCard"), source.indexOf("function CreateView"));
  const normalCardSource = cardSource.slice(cardSource.indexOf("<div className=\"obsidian-sync-title\">"), cardSource.indexOf("<details className=\"internal-details obsidian-sync-details\">"));
  const detailsSource = cardSource.slice(cardSource.indexOf("<details className=\"internal-details obsidian-sync-details\">"));

  assert.match(source, /function displayGeneratedFileCheck/);
  assert.match(source, /生成ファイル確認/);
  assert.match(cardSource, /generatedFileCheck/);
  assert.match(cardSource, /generatedFileCheckFailed/);
  assert.match(cardSource, /const ok = obsidian\.ok === true && !generatedFileCheckFailed/);
  assert.match(cardSource, /const failed = obsidian\.ok === false \|\| generatedFileCheckFailed/);
  assert.doesNotMatch(normalCardSource, /Bridge|証跡|完了判断|前回理由/);
  assert.match(detailsSource, /外部操作の完了判断には使いません。/);
});

test("frontend treats secret-only create messages as credential storage, not automation commands", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const createMessageSource = source.slice(source.indexOf("async function sendCreateMessage"), source.indexOf("  useEffect(() => {"));

  assert.match(source, /import \{ isSecretStorageOnlyMessage, resolveCreateMessageCommand \} from "\.\/createMessageSecrets\.js";/);
  assert.match(createMessageSource, /const secretOnlyMessage = isSecretStorageOnlyMessage\(displayText, storedSecrets\);/);
  assert.match(source, /function savedSecretAdvice/);
  assert.match(createMessageSource, /let advice = secretOnlyMessage \? savedSecretAdvice\(\) : automationAdvice\(displayText, mergedSecrets, createMessages\);/);
  assert.match(createMessageSource, /if \(!secretOnlyMessage\) \{\s*try \{\s*advice = await refreshCreatePlanner\(historyForPlanner, createDraft\.command\);/);
  assert.match(createMessageSource, /if \(storedSecrets\.length\) setCommand\(resolveCreateMessageCommand\(displayText, storedSecrets, ""\)\)/);
  assert.doesNotMatch(createMessageSource, /setCommand\(resolveCreateMessageCommand\(displayText, storedSecrets, advice\.command\)\)/);
  assert.match(source, /次に作りたい自動化をそのまま教えてください/);
  assert.match(source, /disabled=\{createActionBusy \|\| !props\.draft\.command\.trim\(\)\}/);
  assert.doesNotMatch(createMessageSource, /setCommand\(advice\.title\);/);
});

test("frontend create secret-only helper clears command only for credential-only input", () => {
  const stored = [{ label: "OpenAI APIキー" }];
  const secretOnly = "OpenAI APIキーは [保存済み: OpenAI APIキー] です";
  const withConsultation = "OpenAI APIキーは [保存済み: OpenAI APIキー] です。これを使って投稿文を作りたいです";
  const fallbackCommand = "OpenAI APIキーは [保存済み: OpenAI APIキー] です。これを使って投稿文を作りたいです";

  assert.equal(resolveCreateMessageCommand(secretOnly, stored, fallbackCommand), "");
  assert.equal(resolveCreateMessageCommand(withConsultation, stored, fallbackCommand), fallbackCommand);
});

test("frontend hides credential snapshot values in knowledge notes", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const summarySource = source.slice(source.indexOf("function knowledgeNoteSummary"), source.indexOf("function ApprovalQueue"));

  assert.match(summarySource, /note\.note_type === "credential_snapshot"/);
  assert.match(summarySource, /note\.source_ref === "stored_secrets"/);
  assert.match(summarySource, /保存済みの認証情報があります。値は表示しません。/);
  assert.doesNotMatch(summarySource, /maskedValue/);
});

test("frontend create tab can start a fresh consultation", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const resetSource = source.slice(source.indexOf("function resetCreateComposer"), source.indexOf("async function sendCreateMessage"));
  const primaryNavSource = source.slice(source.indexOf("<nav className=\"primary-nav\">"), source.indexOf("<details className=\"advanced-nav\">"));
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));

  assert.match(resetSource, /setCreateMessages\(initialCreateMessages\)/);
  assert.match(resetSource, /setCreateDraft\(automationAdvice\(initialCreatePrompt, dashboard\.secrets\)\)/);
  assert.match(resetSource, /clearCreateDraftSession\(\)/);
  assert.doesNotMatch(primaryNavSource, /resetCreateComposer/);
  assert.match(createViewSource, /新しい相談/);
  assert.match(createViewSource, /onClick=\{props\.onReset\}/);
  assert.match(styles, /\.text-button\.compact/);
});

test("frontend persists create draft sessions without unsent input", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const appSource = source.slice(source.indexOf("export default function App"), source.indexOf("function CreateView"));
  const persistenceEffect = appSource.slice(appSource.indexOf("writeCreateDraftSession(session);"), appSource.indexOf("}, [command, createDraft, createMessages, researchSources, serverCreateSessionChecked])"));

  assert.match(source, /const createDraftSessionStorageKey = "automation-os:create-draft-session:v1";/);
  assert.match(source, /function readCreateDraftSession\(\): CreateDraftSession \| null/);
  assert.match(source, /function writeCreateDraftSession\(session: CreateDraftSession\)/);
  assert.match(source, /function clearCreateDraftSession\(\)/);
  assert.match(source, /async function readServerCreateDraftSession\(\): Promise<CreateDraftSession \| null>/);
  assert.match(source, /function writeServerCreateDraftSession\(session: CreateDraftSession\)/);
  assert.match(source, /fetchApiJson<\{ session\?: Row \| null \}>\("\/api\/create\/session"/);
  assert.match(source, /fetchApiJson\("\/api\/create\/session", \{/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /id: typeof item\.id === "string" \? item\.id : `server-create-\$\{index\}`/);
  assert.match(source, /function isChatMessage\(value: unknown\): value is ChatMessage/);
  assert.match(source, /function isCreateDraft\(value: unknown\): value is CreateDraft/);
  assert.match(appSource, /const \[restoredCreateSession\] = useState\(\(\) => readCreateDraftSession\(\)\)/);
  assert.match(appSource, /const \[serverCreateSessionChecked, setServerCreateSessionChecked\] = useState\(Boolean\(restoredCreateSession\)\)/);
  assert.match(appSource, /restoredCreateSession\?\.messages \?\? initialCreateMessages/);
  assert.match(appSource, /restoredCreateSession\?\.draft \?\? automationAdvice\(initialCreatePrompt\)/);
  assert.match(appSource, /restoredCreateSession\?\.researchSources \?\? initialResearchSources/);
  assert.match(appSource, /readServerCreateDraftSession\(\)\s*\.then\(\(session\) =>/);
  assert.match(appSource, /setServerCreateSessionChecked\(true\)/);
  assert.match(persistenceEffect, /writeCreateDraftSession\(session\)/);
  assert.match(persistenceEffect, /if \(serverCreateSessionChecked\) writeServerCreateDraftSession\(session\)/);
  assert.doesNotMatch(persistenceEffect, /createInput/);
});

test("frontend primary nav keeps collapsed labels accessible", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const primaryNavSource = source.slice(source.indexOf("<nav className=\"primary-nav\">"), source.indexOf("<details className=\"advanced-nav\">"));

  assert.match(primaryNavSource, /title=\{text\}/);
  assert.match(primaryNavSource, /aria-label=\{text\}/);
  assert.match(primaryNavSource, /aria-current=\{label === activeView \? "page" : undefined\}/);
  assert.match(primaryNavSource, /<Icon size=\{18\} aria-hidden="true" \/>/);
  assert.match(primaryNavSource, /<span className="nav-item-label">\{text\}<\/span>/);
});

test("frontend primary nav hides inactive labels on mobile", () => {
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const mobileSource = styles.slice(styles.indexOf("@media (max-width: 1000px)"), styles.indexOf("@media (max-width: 360px)"));
  const tinySource = styles.slice(styles.indexOf("@media (max-width: 360px)"));

  assert.match(mobileSource, /\.primary-nav \.nav-item \{\s*min-height: 38px;\s*gap: 5px;\s*\}/);
  assert.match(mobileSource, /\.primary-nav \.nav-item-label \{\s*display: inline;\s*font-size: 13px;\s*\}/);
  assert.match(mobileSource, /\.sidebar \.primary-nav \{\s*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);\s*\}/);
  assert.match(tinySource, /\.primary-nav \.nav-item\.active \.nav-item-label \{\s*display: inline;\s*\}/);
  assert.doesNotMatch(tinySource, /(^|\n)\s*\.nav-item \{\s*justify-content: flex-start;/);
});

test("frontend create flow is editable and asks before scheduling", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const resumeCardSource = source.slice(source.indexOf("function ResumeContractCard"), source.indexOf("function NextActionsPanel"));
  const resumeVisibleCopy = resumeCardSource.slice(resumeCardSource.indexOf("<section"), resumeCardSource.indexOf("<details"));

  assert.match(source, /import \{[\s\S]*ChevronDown[\s\S]*Pencil[\s\S]*Plus[\s\S]*\} from "lucide-react";/);
  assert.match(createViewSource, /const visibleSteps = normalizeVisibleSteps\(props\.draft\.visibleSteps, plan\.visibleFlow\);/);
  assert.match(createViewSource, /className="visible-flow"/);
  assert.match(createViewSource, /aria-label="フロー項目の操作"/);
  assert.match(createViewSource, /<Pencil size=\{14\} \/>/);
  assert.match(createViewSource, /<Plus size=\{15\} \/>/);
  assert.match(createViewSource, /<ChevronDown size=\{18\} \/>/);
  assert.match(createViewSource, /props\.onVisibleStepsChange\(nextSteps\)/);
  assert.match(createViewSource, /props\.onVisibleStepsChange\(visibleSteps\.map/);
  assert.match(source, /const \[createPlanDirty, setCreatePlanDirty\] = useState\(false\);/);
  assert.match(source, /&& !createPlanDirty/);
  assert.match(source, /sameResearchSources\(activeResearchPlan\.sources, researchSources\)/);
  assert.match(source, /function toggleResearchSource\(key: ResearchSourceKey\)/);
  assert.match(source, /setActiveResearchPlan\(null\);/);
  assert.match(source, /setCreatePlanDirty\(true\);/);
  assert.match(source, /function currentCreateSessionPayload\(\)/);
  assert.match(source, /const messages = compactCreateMessages\(createMessages\);/);
  assert.match(source, /messages: messages\.map\(\(message\) => \(\{ role: message\.role, text: message\.text \}\)\)/);
  assert.match(source, /body: JSON\.stringify\(\{ createSession: currentCreateSessionPayload\(\) \}\)/);
  assert.match(createViewSource, /定期にする/);
  assert.match(createViewSource, /title: "見る"/);
  assert.match(createViewSource, /buttonLabel: "見る"/);
  assert.match(createViewSource, /actionLabel: "ローカルで実演"/);
  assert.match(createViewSource, /title: "開始"/);
  assert.match(createViewSource, /buttonLabel: "開始"/);
  assert.match(createViewSource, /actionLabel: "実行"/);
  assert.doesNotMatch(createViewSource, /この内容で開始/);
  assert.match(styles, /\.visible-flow/);
  assert.match(styles, /\.visible-step-tools/);
  assert.match(styles, /\.schedule-prompt/);
  assert.match(styles, /\.create-advanced-settings/);
  assert.match(styles, /\.create-diagnostics/);
  assert.match(resumeCardSource, /<details className="internal-details resume-contract-details icon-only-details">/);
  assert.match(resumeCardSource, /<summary title="診断" aria-label="診断">\s*<Database size=\{16\} \/>\s*<span className="sr-only">診断<\/span>\s*<\/summary>/);
  assert.doesNotMatch(resumeCardSource, /<summary>開発者向け診断<\/summary>/);
  assert.doesNotMatch(resumeVisibleCopy, /latest artifact|readFirst|resume contract|path/);
});

test("frontend create first screen keeps source and diagnostic internals collapsed", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const initialCreateScreen = createViewSource.slice(createViewSource.indexOf("return ("), createViewSource.indexOf("<details className=\"create-advanced-settings\">"));

  assert.doesNotMatch(initialCreateScreen, /<span className="plan-label">提案<\/span>/);
  assert.match(createViewSource, /<div className="sr-only">\s*保存済みの認証情報があります\s*<\/div>/);
  assert.match(initialCreateScreen, /<strong>流れ<\/strong>/);
  assert.match(initialCreateScreen, /<div className="research-plan-actions">/);
  assert.match(initialCreateScreen, /<strong>\{action\.title\}<\/strong>/);
  assert.match(createViewSource, /title: "保存"/);
  assert.match(createViewSource, /title: "見る"/);
  assert.match(createViewSource, /title: "開始"/);
  assert.match(createViewSource, /<details className="create-advanced-settings">/);
  assert.match(createViewSource, /<summary>詳細<\/summary>/);
  assert.match(createViewSource, /<details className="create-diagnostics icon-only-details">/);
  assert.match(createViewSource, /<summary title="診断" aria-label="診断">\s*<Database size=\{16\} \/>\s*<span className="sr-only">診断<\/span>\s*<\/summary>/);
  assert.doesNotMatch(createViewSource, /<summary>開発者向け診断<\/summary>/);
  assert.match(createViewSource, /<strong>確認に使う場所<\/strong>/);
  assert.match(createViewSource, /<strong>内部確認<\/strong>/);
  assert.doesNotMatch(initialCreateScreen, /Research Planner|調査ソース|MCP|API|裏側の確認|Browser Use|Automation OS画面|source-of-truth|proof boundary|read-only|ローカルrun|research_plan_snapshot/);
});

test("frontend create view hides internal proof and source wording from first-run copy", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const sourceStateSource = source.slice(source.indexOf("function sourceProofState"), source.indexOf("function captureResultLines"));
  const captureResultLinesSource = source.slice(source.indexOf("function captureResultLines"), source.indexOf("function isActiveRegisteredWorkflow"));
  const startResearchSource = source.slice(source.indexOf("async function startResearchPlan"), source.indexOf("async function regularizeResearchPlan"));

  assert.match(sourceStateSource, /label: "未確認"/);
  assert.match(sourceStateSource, /label: "未接続"/);
  assert.match(sourceStateSource, /label: "確認済み"/);
  assert.match(sourceStateSource, /label: "確認が必要"/);
  assert.match(sourceStateSource, /URLから確認記録を保存/);
  assert.match(sourceStateSource, /専用ブラウザで見るだけ確認/);
  assert.match(source, /function displayCreatePlanText/);
  assert.match(createViewSource, /displayCreatePlanText\(source\.mode\)/);
  assert.match(createViewSource, /displayCreatePlanText\(source\.boundary\)/);
  assert.match(createViewSource, /保存は開始前の計画だけ、実演はローカル画面の確認だけです。完了には、実行結果と保存記録の確認が別に必要です。/);
  assert.match(createViewSource, /記録だけの状態では、外部操作や手動確認が終わったとは扱いません。/);
  assert.match(createViewSource, /確認元・確認記録・承認条件は内部に保存/);
  assert.match(source, /function createDecisionGuidance/);
  assert.match(createViewSource, /aria-label="おすすめの次の操作"/);
  assert.match(source, /function createPlannerImmediateLabel/);
  assert.match(source, /function createPlannerLlmLabel/);
  assert.match(createViewSource, /createPlannerImmediateLabel\(props\.draft\)/);
  assert.match(createViewSource, /createPlannerLlmLabel\(props\.draft\)/);
  assert.match(source, /即時: 簡易計画/);
  assert.match(source, /LLM: Mac worker待機中/);
  assert.match(source, /LLM: Mac worker \/ Codex CLI/);
  const queueDecisionSource = source.slice(source.indexOf("function shouldQueueCreatePlannerJob"), source.indexOf("async function ensureResearchPlan"));
  assert.match(queueDecisionSource, /plan\.source === "local_fallback" && plan\.exactBlocker === "openai_api_key_missing"/);
  assert.doesNotMatch(queueDecisionSource, /productionGuard|operatorWriteTokenReady|token_required/);
  assert.match(source, /まだ聞きたいことがあります/);
  assert.match(source, /まず保存できます/);
  assert.match(source, /一度見てから進めます/);
  assert.match(source, /定期化できます/);
  assert.match(source, /おすすめ/);
  assert.match(source, /未確認の条件が残っています。/);
  assert.match(startResearchSource, /ローカル実行を作成しました/);
  assert.match(startResearchSource, /開始前の計画は、完了記録とは別に扱います。/);
  assert.match(source, /専用ブラウザで見える範囲を確認/);
  assert.match(source, /公式の字幕や台本をブラウザで読む/);
  assert.match(source, /初期設定では使いません/);
  assert.match(source, /画面で見える内容を確認元の候補にします/);
  assert.match(captureResultLinesSource, /内部記録に保存済み/);
  assert.doesNotMatch(createViewSource, /source-of-truth|read-only|receipt-only|run\/proof\/artifact\/DB\/readback|proof missing|proof saved|not connected|ローカルrun|run作成|research_plan_snapshot/);
  assert.doesNotMatch(createViewSource, /専用ブラウザ\/CDP\/Google profile|Show transcript|Data API captions\.download|API課金前提/);
  assert.doesNotMatch(sourceStateSource, /proof missing|proof saved|not connected|read-only proof|receipt-only|source-of-truth|run\/proof\/artifact\/DB\/readback/);
  assert.doesNotMatch(captureResultLinesSource, /exactBlocker:|artifact:|proof:|summary:/);
  assert.doesNotMatch(startResearchSource, /ローカルrun|research_plan_snapshot|receipt-only|run\/proof\/artifact\/DB\/readback/);
  assert.doesNotMatch(startResearchSource, /停止理由:.*exactBlocker|body\.exactBlocker \? `停止理由/);
});

test("frontend create view connects YouTube router signals to existing transcript capture", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const helperSource = source.slice(source.indexOf("function detectedYouTubeUrlFromRoute"), source.indexOf("function researchPlanSourceProofSummary"));

  assert.match(helperSource, /route\.id !== "youtube_transcript_capture"/);
  assert.match(helperSource, /route\.signals/);
  assert.match(helperSource, /youtube\\\.com/);
  assert.match(createViewSource, /const detectedYouTubeUrl = detectedYouTubeUrlFromRoute/);
  assert.match(createViewSource, /props\.onCaptureSource\("youtube", detectedYouTubeUrl\)/);
  assert.match(createViewSource, /台本を取得/);
  assert.match(createViewSource, /value=\{sourceUrls\[source\.key\] \?\? ""\}/);
  assert.match(createViewSource, /props\.onCaptureSource\(source\.key, sourceUrls\[source\.key\] \?\? ""\)/);
});

test("frontend create plan display copy keeps source jargon out of the first screen", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const previewSource = source.slice(source.indexOf("function previewResearchPlan"), source.indexOf("export default function App"));
  const createViewSource = source.slice(source.indexOf("function CreateView"), source.indexOf("function RunsView"));
  const displayFunctionSource = source.slice(source.indexOf("function displayCreatePlanText"), source.indexOf("function displayBridgeReceiptSummary"));
  const renderedCreateSurface = [previewSource, createViewSource]
    .join("\n")
    .replace(displayFunctionSource, "");

  assert.ok(displayFunctionSource.includes("専用ブラウザ\\/CDP\\/Google profileで見える範囲をread-only確認"));
  assert.ok(displayFunctionSource.includes("\"専用ブラウザで見える範囲を確認\""));
  assert.ok(displayFunctionSource.includes("公式Show transcript\\/公開字幕をブラウザで読む"));
  assert.ok(displayFunctionSource.includes("\"公式の字幕や台本をブラウザで読む\""));
  assert.ok(displayFunctionSource.includes("Data API captions\\.downloadは認可が必要なため初期実装では使わない"));
  assert.ok(displayFunctionSource.includes("\"初期設定では使いません\""));
  assert.ok(displayFunctionSource.includes("API課金前提にせず、見えている画面を正本候補にする"));
  assert.ok(displayFunctionSource.includes("\"画面で見える内容を確認元の候補にします\""));
  assert.match(renderedCreateSurface, /専用ブラウザで見える範囲を確認/);
  assert.match(renderedCreateSurface, /公式の字幕や台本をブラウザで読む/);
  assert.match(renderedCreateSurface, /初期設定では使いません/);
  assert.doesNotMatch(renderedCreateSurface, /専用ブラウザ\/CDP\/Google profile|Show transcript|Data API captions\.download|API課金前提/);
});

test("frontend runs normal view keeps history minimal", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const taskNameSource = source.slice(source.indexOf("function displayTaskName"), source.indexOf("function displayApprovalTitle"));
  const runsViewSource = source.slice(source.indexOf("function RunsView"), source.indexOf("function ScheduleView"));
  const normalRunsSource = runsViewSource.slice(runsViewSource.indexOf("return ("), runsViewSource.indexOf("<details className=\"internal-details\">"));
  const detailsSource = runsViewSource.slice(runsViewSource.indexOf("<details className=\"internal-details\">"));

  assert.match(source, /function displayRunCardStatus/);
  assert.match(source, /const runningRunStatuses = new Set\(\["queued", "running", "in_progress", "started"\]\)/);
  assert.match(taskNameSource, /qa visible flow\|receipt\[- \]only/i);
  assert.match(taskNameSource, /return "確認作業";/);
  assert.match(runsViewSource, /<Panel title="履歴" action=\{`\$\{props\.runs\.length\}件`\}>/);
  assert.match(runsViewSource, /<h3>進行中<\/h3>/);
  assert.match(runsViewSource, /<summary>古い履歴 <span>\{runGroups\.archive\.length\}<\/span><\/summary>/);
  assert.match(runsViewSource, /<Panel title="詳細" action=\{props\.selectedRun \? displayRunCardStatus\(classifyRun\(props\.selectedRun\)\) : "なし"\}>/);
  assert.match(normalRunsSource, /<Empty text="履歴から実行を選んでください。" \/>/);
  assert.match(normalRunsSource, /<RunSummary\s+run=\{props\.selectedRun\}\s+meta=\{meta\}\s+proofCount=\{props\.proofs\.length\}\s+stepCount=\{props\.steps\.length\}\s+eventCount=\{props\.events\.length\}/);
  assert.match(normalRunsSource, /onRefresh=\{\(\) => props\.onRefreshRun\(props\.selectedRun as Row\)\}/);
  assert.match(normalRunsSource, /onOpenProof=\{props\.proofs\[0\] \? \(\) => props\.onSelectProof\(props\.proofs\[0\]\) : undefined\}/);
  assert.match(normalRunsSource, /onOpenApprovals=\{props\.onOpenApprovals\}/);
  assert.match(normalRunsSource, /onContinueInCreate=\{\(\) => props\.onContinueInCreate\(props\.selectedRun as Row\)\}/);
  assert.match(normalRunsSource, /<Timeline steps=\{props\.steps\} \/>/);
  assert.ok(normalRunsSource.indexOf('<Empty text="履歴から実行を選んでください。" />') < normalRunsSource.indexOf("<RunSummary"));
  assert.match(source, /function missingProofLabels\(proofGate: Row\)/);
  assert.match(source, /function runBlockerSummary/);
  assert.match(source, /function runNextActionSummary/);
  assert.match(source, /async function continueRunInCreate\(run: Row\)/);
  assert.match(source, /function buildRunContinuationPrompt/);
  assert.match(source, /履歴からの続き相談です。/);
  assert.match(source, /await refreshCreatePlanner\(historyForPlanner, createDraft\.command\)/);
  assert.match(source, /実行結果を読み込んで計画を更新しました/);
  assert.match(source, /不足している確認を新しい保存記録として残します。/);
  assert.match(source, /void continueRunInCreate\(run\);/);
  assert.match(source, /function buildRunFollowUpActions/);
  assert.match(source, /function buildCreateOriginSummary\(meta: Row\)/);
  assert.match(source, /function buildWorkerResultSummary\(events: Row\[\]\)/);
  assert.match(source, /あなたの確認待ちです。/);
  assert.match(source, /一部だけ確認できています。完了には不足分があります。/);
  assert.match(source, /実行結果か手動確認の記録を追加してください。/);
  assert.match(source, /承認画面で内容を確認してください。/);
  assert.match(source, /保存記録を見る/);
  assert.match(source, /承認を確認/);
  assert.match(source, /状態を更新/);
  assert.match(source, /作るで続き相談/);
  assert.match(source, /aria-label="作るから渡された相談"/);
  assert.match(source, /作るで相談した内容/);
  assert.match(source, /workerが最初に見ること/);
  assert.match(source, /create_session_source/);
  assert.match(source, /create_session_next_action/);
  assert.match(styles, /\.run-create-origin/);
  assert.match(source, /aria-label="Mac workerの処理結果"/);
  assert.match(source, /Mac workerが処理しました。/);
  assert.match(source, /Mac workerが途中で止まりました。/);
  assert.match(source, /Mac workerが処理中です。/);
  assert.match(source, /local_worker: "Mac worker"/);
  assert.match(source, /const adapterKey = String\(meta\.adapter \?\? meta\.worker_mode \?\? meta\.execution_mode \?\? ""\);/);
  assert.match(source, /止まった理由を確認して、作るで続き相談してください。/);
  assert.match(styles, /\.run-worker-result/);
  assert.match(source, /aria-label="次にできる操作"/);
  assert.match(source, /ログインや本人確認など、人間の入力が必要です。/);
  assert.match(source, /時間内に確認が終わりませんでした。/);
  assert.match(source, /実行に使う接続やローカル作業環境の確認が必要です。/);
  assert.match(source, /proofTypeLabels\[String\(item\)\]/);
  assert.match(detailsSource, /<ReceiptTable proofs=\{props\.proofs\} onSelect=\{props\.onSelectProof\} \/>/);
  assert.match(detailsSource, /<WorkerEvents events=\{props\.events\} \/>/);
  assert.match(detailsSource, /<ChildCodexRuns children=\{props\.children\} \/>/);
  assert.doesNotMatch(normalRunsSource, /処理ログ|実行方式|Codex read-only|証拠のみ|receipt only|KB|<Metric label="開始"/);
  assert.doesNotMatch(runsViewSource, /あとで見る履歴|履歴のみ・保存記録のみ|保存記録のみ/);
});

test("frontend proof drawer reads viewer endpoint and avoids raw proof metadata", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const drawerSource = source.slice(source.indexOf("function DetailDrawer"), source.indexOf("function MarkdownPreview"));
  const receiptSource = source.slice(source.indexOf("function ReceiptTable"), source.indexOf("function ChildCodexRuns"));
  const effectSource = source.slice(source.indexOf("useEffect(() => {\n    if (!selectedProof)"), source.indexOf("useEffect(() => {\n    if (!selectedRunId)"));

  assert.match(receiptSource, /proof\.can_open \? "表示できます" : "保存記録あり"/);
  assert.match(effectSource, /selectedProof\.viewer_url/);
  assert.match(effectSource, /`\/api\/proofs\/\$\{encodeURIComponent\(String\(selectedProof\.id\)\)\}\/view`/);
  assert.match(drawerSource, /proofView\?:? ProofView|proofView: ProofView/);
  assert.match(source, /function proofConfirmationText\(proof: Row, proofView\?: ProofView \| null\)/);
  assert.ok(
    source.indexOf("/queue|sync|list|status|readable|visible_source|source_snapshot/i") <
      source.indexOf('/screenshot|screen|image/i'),
    "source/readable proof labels must not be captured by generic screenshot wording",
  );
  assert.match(drawerSource, /className="proof-human-summary"/);
  assert.match(drawerSource, /proofConfirmationText\(proof, proofView\)/);
  assert.match(drawerSource, /proofPreviewSummary\(proofView\)/);
  assert.match(drawerSource, /className="proof-fact-grid"/);
  assert.match(drawerSource, /<ProofPreview proofView=\{proofView\} \/>/);
  assert.match(drawerSource, /displayProofBlockedReason\(proofView\.blocked_reason\)/);
  assert.match(drawerSource, /className="proof-preview proof-image-card"/);
  assert.match(drawerSource, /画像本文は表示しません。保存形式・寸法・履歴との接続だけを確認できます。/);
  assert.match(styles, /\.proof-human-summary/);
  assert.match(styles, /\.proof-image-card/);
  assert.match(styles, /\.proof-image-placeholder/);
  assert.doesNotMatch(drawerSource, /metadata_json|asJson<Row>\(proof|proofMeta|proof\.uri|proof\.path|screenshotPath/);
});

test("server dashboard sanitizes step, knowledge, and skill payload rows", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const dashboardSource = source.slice(source.indexOf("export function getDashboard"), source.indexOf("export function getRunDetail"));

  assert.match(dashboardSource, /"SELECT \* FROM run_steps ORDER BY started_at DESC LIMIT 20"/);
  assert.match(dashboardSource, /steps: sanitizeDashboardRows\(rawSteps\)/);
  assert.match(dashboardSource, /"SELECT \* FROM knowledge_notes ORDER BY updated_at DESC LIMIT 8"/);
  assert.match(dashboardSource, /knowledgeNotes: sanitizeDashboardRows\(rawKnowledgeNotes\)/);
  assert.match(dashboardSource, /"SELECT id, run_id, name, draft_markdown, created_at FROM skills ORDER BY created_at DESC LIMIT 8"/);
  assert.match(dashboardSource, /skills: sanitizeDashboardRows\(rawSkills\)/);
});

test("frontend run summary keeps decision copy short", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const summarySource = source.slice(source.indexOf("function RunSummary"), source.indexOf("function Metric"));
  const normalSummarySource = summarySource.slice(summarySource.indexOf("return ("), summarySource.indexOf("<details className=\"internal-details run-meta-details\">"));
  const metaDetailsSource = summarySource.slice(summarySource.indexOf("<details className=\"internal-details run-meta-details\">"));
  const researchPlanSnapshotSource = summarySource.slice(summarySource.indexOf("<details className=\"internal-details remaining-steps research-plan-snapshot\">"));

  assert.match(summarySource, /title: "確認", body: `次: \$\{displayNextStep\}`/);
  assert.match(summarySource, /title: "進行中", body: workerResult \? "Mac worker処理中" : queuedWorkerBody/);
  assert.match(summarySource, /function buildQueuedWorkerBody\(worker: Row\)/);
  assert.match(summarySource, /return "Mac worker処理中 \/ 順番待ち"/);
  assert.match(summarySource, /title: "保存", body: "完了ではありません"/);
  assert.match(summarySource, /title: "古い履歴", body: "操作不要"/);
  assert.match(summarySource, /title: "完了", body: "操作不要"/);
  assert.match(summarySource, /buildRunHumanReport/);
  assert.match(normalSummarySource, /<ReportItem label="結論" value=\{humanReport\.conclusion\} \/>/);
  assert.match(normalSummarySource, /<ReportItem label="見たもの" value=\{humanReport\.seen\} \/>/);
  assert.match(normalSummarySource, /<ReportItem label="実行したこと" value=\{humanReport\.did\} \/>/);
  assert.match(normalSummarySource, /<ReportItem label="止まった理由" value=\{humanReport\.blocker\} \/>/);
  assert.match(normalSummarySource, /<ReportItem label="証跡" value=\{humanReport\.proof\} \/>/);
  assert.match(normalSummarySource, /<ReportItem label="次の一手" value=\{humanReport\.next\} \/>/);
  assert.doesNotMatch(normalSummarySource, /displayTaskName\(run\.objective\)|保存のための記録です|追加の完了判断|再開対象から外した履歴|この実行は完了として扱っています|実行方式|<Metric label="開始"/);
  assert.match(metaDetailsSource, /<Metric label="開始"/);
  assert.match(metaDetailsSource, /<Metric label="実行方式"/);
  assert.match(researchPlanSnapshotSource, /<summary title="診断" aria-label="診断">\s*<Database size=\{16\} \/>\s*<span className="sr-only">診断<\/span>\s*<\/summary>/);
  assert.doesNotMatch(researchPlanSnapshotSource, /<summary>開発者向け診断<\/summary>/);
});

test("frontend approvals normal copy keeps boundary but avoids executor jargon", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const approvalTitleSource = source.slice(source.indexOf("function displayApprovalTitle"), source.indexOf("function displayStepTime"));
  const approvalSubtitleSource = source.slice(source.indexOf("function displayApprovalSubtitle"), source.indexOf("function displayRunCardStatus"));
  const approvalsViewSource = source.slice(source.indexOf("function ApprovalsView"), source.indexOf("function LanesView"));
  const approvalQueueSource = source.slice(source.indexOf("function ApprovalQueue"), source.indexOf("function ReceiptTable"));
  const dashboardRenderSource = source.slice(source.indexOf("{activeView === \"Approvals\""), source.indexOf("{activeView === \"Lanes\""));
  const dashboardViewSource = source.slice(source.indexOf("function DashboardView"), source.indexOf("function ResumeContractCard"));

  assert.match(approvalTitleSource, /replace\(\/実行の承認\[:：\]\?\\s\*\/g, ""\)/);
  assert.match(approvalTitleSource, /replace\(\/\^Bridge approval\[:：\]\?\\s\*\/i, ""\)/);
  assert.match(approvalTitleSource, /const taskName = displayTaskName\(cleaned\);/);
  assert.match(approvalTitleSource, /const visibleTask = taskName === value \? displayCreatePlanText\(cleaned\) : taskName;/);
  assert.doesNotMatch(approvalTitleSource, /if \(taskName === "確認"\) return "確認";/);
  assert.doesNotMatch(approvalTitleSource, /return taskName === value \? value/);
  assert.match(approvalSubtitleSource, /return "まだ動かしていません";/);
  assert.match(approvalSubtitleSource, /return "確認が必要です";/);
  assert.doesNotMatch(approvalSubtitleSource, /resource_locks|対象:|外部操作はまだ未実行です/);
  assert.match(dashboardRenderSource, /approvals=\{dashboard\.approvalInbox \?\? dashboard\.approvals\}/);
  assert.match(dashboardViewSource, /approvals=\{\(props\.dashboard\.approvalInbox \?\? props\.dashboard\.approvals\)\.slice\(0, 5\)\}/);
  assert.match(approvalsViewSource, /<Panel title="確認" action=\{`\$\{approvals\.filter/);
  assert.match(approvalQueueSource, /displayApprovalPublicTitle\(approval\)/);
  assert.match(approvalQueueSource, /className="approval-chip-row"/);
  assert.match(approvalQueueSource, /displayApprovalActionLabel\(approval\)/);
  assert.match(approvalQueueSource, /return "action-approval";/);
  assert.doesNotMatch(approvalQueueSource, /return "approval";/);
  assert.match(approvalQueueSource, /displayApprovalBoundaryLabel\(approval\)/);
  assert.match(approvalQueueSource, /displayApprovalExecutionLabel\(approval\)/);
  assert.match(approvalQueueSource, />\s*承認\s*<\/button>/);
  assert.match(approvalQueueSource, />\s*却下\s*<\/button>/);
  assert.match(approvalQueueSource, />\s*取消\s*<\/button>/);
  assert.doesNotMatch(`${approvalsViewSource}\n${approvalQueueSource}`, /trusted-bridge|resource_locks|外部操作Bridge|Bridge approval:|実行の承認:|raw proof|artifact|runner|provenance|exactBlocker|DB|CDP|profile|sidecar|Gemini/);
});

test("frontend topbar start stores secrets before posting sanitized command", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const startRunSource = source.slice(source.indexOf("async function startRun"), source.indexOf("async function startCommand"));

  assert.match(source, /async function readApiJson/);
  assert.match(source, /async function fetchApiJson/);
  assert.match(source, /let response: Response;/);
  assert.match(source, /throw new Error\(userError\(fallbackError\)\);/);
  assert.doesNotMatch(source, /response\.json\(\)/);
  assert.doesNotMatch(source, /if \(error instanceof Error\) throw error/);
  assert.match(source, /async function saveAndSanitizeMessage/);
  assert.match(source, /fetchApiJson<Row>\("\/api\/secrets\/from-message"/);
  assert.match(startRunSource, /saveAndSanitizeMessage\(rawCommand\)/);
  assert.match(startRunSource, /const safeCommand = sanitizedText\.trim\(\);/);
  assert.match(startRunSource, /setCommand\(safeCommand\);/);
  assert.match(startRunSource, /fetchApiJson<Row>\("\/api\/runs\/start"/);
  assert.match(startRunSource, /body: JSON\.stringify\(\{ command: safeCommand \}\)/);
  assert.match(startRunSource, /savedSecretNotice\(storedSecrets\)/);
  assert.doesNotMatch(startRunSource, /body: JSON\.stringify\(\{ command: (nextCommand|rawCommand) \}\)/);
  assert.doesNotMatch(source, /className="command-secret-strip"/);
});

test("frontend normal notices do not expose raw exact blockers", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const postSource = source.slice(source.indexOf("async function post"), source.indexOf("async function runSchedulerOnce"));
  const demoSource = source.slice(source.indexOf("async function demoResearchPlan"), source.indexOf("async function startResearchPlan"));
  const startResearchSource = source.slice(source.indexOf("async function startResearchPlan"), source.indexOf("async function regularizeResearchPlan"));

  assert.match(postSource, /詳細は診断に保存しました/);
  assert.match(demoSource, /詳細は診断に保存しました/);
  assert.match(startResearchSource, /詳細は診断に保存しました/);
  assert.doesNotMatch(postSource, /停止理由:.*exactBlocker|body\.exactBlocker \? `停止理由/);
  assert.doesNotMatch(demoSource, /停止理由:.*exactBlocker|body\.exactBlocker \? `停止理由/);
  assert.doesNotMatch(startResearchSource, /停止理由:.*exactBlocker|body\.exactBlocker \? `停止理由/);
});

test("frontend action receipts connect button results to runs and saved records", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const receiptTypeSource = source.slice(source.indexOf("type ActionReceipt"), source.indexOf("type SecretSummary"));
  const appSource = source.slice(source.indexOf("export default function App"), source.indexOf("function ActionReceiptBanner"));
  const receiptSource = source.slice(source.indexOf("function ActionReceiptBanner"), source.indexOf("function DashboardView"));

  assert.match(receiptTypeSource, /runId\?: string/);
  assert.match(receiptTypeSource, /planId\?: string/);
  assert.match(receiptTypeSource, /checkId\?: string/);
  assert.match(receiptTypeSource, /workflowId\?: string/);
  assert.match(source, /function extractResponsePlanId\(body: Row\)/);
  assert.match(source, /function extractResponseCheckId\(body: Row\)/);
  assert.match(source, /function extractResponseWorkflowId\(body: Row\)/);
  assert.match(appSource, /const \[actionReceipt, setActionReceipt\] = useState<ActionReceipt \| null>\(null\)/);
  assert.match(appSource, /const quickActionsDetailsRef = useRef<HTMLDetailsElement \| null>\(null\)/);
  assert.match(appSource, /function recordActionReceipt/);
  assert.match(appSource, /function closeQuickActionMenu\(\)/);
  assert.match(appSource, /quickActionsDetailsRef\.current\.open = false/);
  assert.match(appSource, /<ActionReceiptBanner/);
  assert.match(appSource, /onDismiss=\{\(\) => setActionReceipt\(null\)\}/);
  assert.match(appSource, /function clearTransientViewFeedback\(viewChanged: boolean\)/);
  assert.match(appSource, /clearTransientViewFeedback\(viewChanged\)/);
  assert.match(appSource, /const noticeToClear = notice/);
  assert.match(appSource, /const receiptIdToClear = actionReceipt\?\.id \?\? ""/);
  assert.match(appSource, /setNotice\(\(current\) => current === noticeToClear \? "" : current\)/);
  assert.match(appSource, /current\?\.id === receiptIdToClear/);
  assert.match(appSource, /current\.tone === "ok" \|\| current\.tone === "info"/);
  assert.match(appSource, /recordActionReceipt\(\{\s*tone: "ok",\s*title: "計画を保存しました"/);
  assert.match(appSource, /title: "ローカル実行を作成しました"/);
  assert.match(appSource, /runId: body\.runId/);
  assert.match(appSource, /recordActionReceipt\(\{\s*tone: "info",\s*title: "今すぐ動かせる予定はありません"/);
  assert.match(appSource, /recordActionReceipt\(\{\s*tone: "ok",\s*title: "予定を保存しました"/);
  assert.match(receiptSource, /aria-label="直前の操作記録"/);
  assert.match(appSource, /<details className="advanced-actions icon-only-details" ref=\{quickActionsDetailsRef\}>/);
  assert.match(receiptSource, /履歴 \$\{compactId\(receipt\.runId\)\}/);
  assert.match(receiptSource, /計画 \$\{compactId\(receipt\.planId\)\}/);
  assert.match(receiptSource, /確認 \$\{compactId\(receipt\.checkId\)\}/);
  assert.match(receiptSource, /定期 \$\{compactId\(receipt\.workflowId\)\}/);
  assert.match(receiptSource, /履歴を見る/);
  assert.match(receiptSource, /aria-label="直前の操作記録を閉じる"/);
  assert.match(receiptSource, /onClick=\{onDismiss\}/);
  assert.doesNotMatch(receiptSource, /exactBlocker|artifact|raw path|\/Users|provenance_json/);
  assert.match(styles, /\.action-receipt\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto auto auto;/);
  assert.match(styles, /\.action-receipt-dismiss\s*\{[\s\S]*?width: 32px;/);
  assert.match(styles, /\.action-receipt-dismiss:focus-visible\s*\{[\s\S]*?outline: 3px solid/);
  assert.match(styles, /@media \(max-width: 1000px\)[\s\S]*?\.action-receipt\s*\{[\s\S]*?grid-template-columns: 1fr;/);
});

test("server dashboard caches expensive capability and browser health scans outside tests", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const dashboardSource = source.slice(source.indexOf("let dashboardExpensiveSnapshotCache"), source.indexOf("export function getDashboard"));
  const getDashboardSource = source.slice(source.indexOf("export function getDashboard"), source.indexOf("type PublicRegisteredWorkflowCheckKind"));

  assert.match(dashboardSource, /dashboardExpensiveSnapshotCache/);
  assert.match(dashboardSource, /AUTOMATION_OS_DASHBOARD_CAPABILITY_CACHE_MS \?\? 300000/);
  assert.match(dashboardSource, /process\.env\.NODE_TEST_CONTEXT\s*\?\s*0/);
  assert.match(dashboardSource, /getCodexCapabilities\(\)/);
  assert.match(dashboardSource, /getBrowserHealth\(\)/);
  assert.match(getDashboardSource, /const \{ codexCapabilities, browserHealth \} = getDashboardExpensiveSnapshot\(\);/);
  assert.doesNotMatch(getDashboardSource, /getCodexCapabilities\(\);/);
  assert.match(getDashboardSource, /browserHealth/);
});

test("server health exposes deployment readback without secrets", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const healthRouteSource = source.slice(source.indexOf('app.get("/api/health"'), source.indexOf("let researchPlanSchedulerTimer"));
  const deploymentSource = source.slice(source.indexOf("function getPackageVersion"), source.indexOf("let dashboardExpensiveSnapshotCache"));
  const getDashboardSource = source.slice(source.indexOf("export function getDashboard"), source.indexOf("function buildLocalWorkerStatus"));

  assert.match(healthRouteSource, /deployment: getDeploymentReadback\(\)/);
  assert.match(getDashboardSource, /deployment: getDashboardDeploymentReadback\(\)/);
  assert.match(deploymentSource, /function getDeploymentReadback\(\)/);
  assert.match(deploymentSource, /function getDashboardDeploymentReadback\(\)/);
  assert.match(deploymentSource, /delete \(assets as \{ webDistDir\?: string \}\)\.webDistDir/);
  assert.match(deploymentSource, /AUTOMATION_OS_DEPLOY_COMMIT/);
  assert.match(deploymentSource, /ZEABUR_GIT_COMMIT/);
  assert.match(deploymentSource, /spawnSync\("git", \["rev-parse", "HEAD"\]/);
  assert.match(deploymentSource, /const plannerProvider = process\.env\.AUTOMATION_OS_CREATE_PLANNER_PROVIDER \?\? "auto"/);
  assert.match(deploymentSource, /plannerProvider,/);
  assert.match(deploymentSource, /aiRuntime: \{/);
  assert.match(deploymentSource, /const codexPlannerSelected = plannerProvider === "codex"/);
  assert.match(deploymentSource, /const codexBinConfigured = Boolean\(process\.env\.AUTOMATION_OS_CODEX_PLANNER_BIN \|\| process\.env\.AUTOMATION_OS_CODEX_BIN\)/);
  assert.match(deploymentSource, /const openAiPlannerReady = \(plannerProvider === "auto" \|\| plannerProvider === "openai"\) && openAiKeyConfigured/);
  assert.match(deploymentSource, /const subscriptionPlannerReady = !openAiPlannerReady && plannerProvider !== "openai"/);
  assert.match(deploymentSource, /plannerExecutionMode/);
  assert.match(deploymentSource, /hostedPlannerReady: openAiPlannerReady/);
  assert.match(deploymentSource, /codexPlannerSelected/);
  assert.match(deploymentSource, /subscriptionPlannerReady/);
  assert.match(deploymentSource, /subscriptionRoute: "codex_cli_or_app_local"/);
  assert.match(deploymentSource, /apiRoute: "openai_platform_key"/);
  assert.match(deploymentSource, /blocker: plannerExecutionMode === "blocked" \? "openai_api_key_required_for_forced_openai_planner" : ""/);
  assert.match(deploymentSource, /assets: getServedAssetNames\(\)/);
  assert.doesNotMatch(deploymentSource, /DATABASE_URL|POSTGRES_URI|PASSWORD|SECRET|TOKEN|API_KEY/);
});

test("production QA records deployment and served asset readback", () => {
  const source = readFileSync(resolve(process.cwd(), "scripts/productionQa.mjs"), "utf8");

  assert.match(source, /deployment: null/);
  assert.match(source, /assets: null/);
  assert.match(source, /result\.deployment = sanitizeDeploymentReadback\(parsed\.deployment\)/);
  assert.match(source, /await checkServedAssets\(\)/);
  assert.match(source, /writeFileSync\(join\(outDir, "index\.html"\), html\)/);
  assert.match(source, /missing_js_asset/);
  assert.match(source, /missing_css_asset/);
  assert.match(source, /function sanitizeDeploymentReadback/);
  assert.doesNotMatch(source, /DATABASE_URL|POSTGRES_URI|PASSWORD|SECRET|TOKEN|API_KEY/);
});

test("production replay QA records video-backed Create chat and route readback", () => {
  const source = readFileSync(resolve(process.cwd(), "scripts/productionReplayQa.mjs"), "utf8");
  const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");

  assert.match(packageJson, /"qa:production:replay": "node scripts\/productionReplayQa\.mjs"/);
  assert.match(source, /artifactRoot: basename\(outDir\)/);
  assert.doesNotMatch(source, /outDir,\n/);
  assert.match(source, /recordVideo/);
  assert.match(source, /videoExists/);
  assert.match(source, /create_ui_video_missing/);
  assert.match(source, /create-chat-ui-video-replay/);
  assert.match(source, /create-plan-api-replay/);
  assert.match(source, /route-visual-readback/);
  assert.match(source, /#home", "#create", "#schedule", "#runs", "#sources"/);
  assert.match(source, /AUTOMATION_OS_REPLAY_ALLOW_WRITE/);
  assert.match(source, /AUTOMATION_OS_REPLAY_WRITE_TOKEN/);
  assert.match(source, /AUTOMATION_OS_REPLAY_WRITE_WORKFLOWS/);
  assert.match(source, /write_actions_disabled_for_replay_qa/);
  assert.match(source, /production-write-guard-readback/);
  assert.match(source, /limited-write-run-readback/);
  assert.match(source, /__replay_write_guard_probe_never_registered__/);
  assert.doesNotMatch(source, /firstWorkflow/);
  assert.match(source, /production_write_guard_did_not_block_without_token/);
  assert.match(source, /write_workflow_allowlist_missing/);
  assert.match(source, /limited_write_start_failed/);
  assert.match(source, /headers\["x-automation-os-token"\] = writeToken/);
  assert.match(source, /sourceReadback/);
  assert.match(source, /plannerExecutionMode/);
  assert.match(source, /aiRuntimeBlocker/);
  assert.match(source, /playwrightCliStatus/);
  assert.match(source, /browserUseCliStatus/);
  assert.match(source, /Zeabur remains the control plane/);
  assert.match(source, /planning execution belongs to the Mac worker/);
  assert.match(source, /Browser automation, screenshots, local CDP lanes, cleanup, and external-service proof capture stay on the Mac worker/);
  assert.match(source, /sanitizeArtifactValue/);
  assert.match(source, /truncated-depth/);
  assert.match(source, /truncated \$/);
  assert.match(source, /conversation-brief\.answer-only/);
  assert.match(source, /latestHasBadPlanningPhrase/);
  assert.match(source, /horizontal_overflow/);
  assert.match(source, /function classifyError/);
  assert.match(source, /function writeErrorArtifact/);
  assert.match(source, /function summarizeApiBody/);
  assert.match(source, /function compactCreateReadback/);
  assert.match(source, /fetch_failed:\$\{route\}/);
});

test("frontend releases busy state before background dashboard refresh after actions", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const refreshSource = source.slice(source.indexOf("async function refresh"), source.indexOf("async function post"));
  const postSource = source.slice(source.indexOf("async function post"), source.indexOf("async function saveAndSanitizeMessage"));
  const startRunSource = source.slice(source.indexOf("async function startRun"), source.indexOf("async function startCommand"));

  assert.match(source, /type RefreshOptions = \{/);
  assert.match(refreshSource, /if \(!options\.background\) setLoading\(true\);/);
  assert.match(refreshSource, /前回データを表示中です/);
  assert.match(postSource, /void refresh\(false, \{ background: true, staleNotice: true \}\);/);
  assert.doesNotMatch(postSource, /await refresh\(false\)/);
  assert.match(postSource, /finally \{[\s\S]*?setBusyKey\(null\);[\s\S]*?\}/);
  assert.match(startRunSource, /void refresh\(false, \{ background: true, staleNotice: true \}\);/);
  assert.doesNotMatch(startRunSource, /await refresh\(false\)/);
});

test("frontend sends protected bridge actions to approvals and keeps proof drawer route-scoped", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const postSource = source.slice(source.indexOf("async function post"), source.indexOf("async function saveAndSanitizeMessage"));
  const drawerStart = source.indexOf("const drawerProof");
  const drawerSource = source.slice(drawerStart, source.indexOf("<div className=\"app-shell\">", drawerStart));

  assert.match(postSource, /const approvalRequired = body\.status === "approval_required"[\s\S]*body\.status === "waiting_approval"[\s\S]*body\.run\?\.status === "waiting_approval";/);
  assert.match(postSource, /setActiveView\("Approvals", false\);/);
  assert.match(postSource, /承認画面で内容を確認してください/);
  assert.match(postSource, /runId: approvalRequired \? undefined : responseRunId \?\? undefined/);
  assert.match(source, /if \(activeView !== "Runs"\) setSelectedProof\(null\);/);
  assert.match(drawerSource, /const drawerProof = activeView === "Runs" \? selectedProof : null;/);
  assert.match(drawerSource, /const drawerSkill = activeView === "Skills" \? selectedSkill : null;/);
  assert.match(source, /\{\(drawerProof \|\| drawerSkill\) && \(/);
});

test("frontend labels bridge executions as external execution and adds lane summary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const lanesSource = source.slice(source.indexOf("function LanesView"), source.indexOf("function SourcesView"));
  const sourcesSource = source.slice(source.indexOf("function SourcesView"), source.indexOf("function CodexParityLedgerPanel"));

  assert.match(sourcesSource, /<Panel title="外部" action=\{`\$\{bridgeExecutions\.length\}件`\}>/);
  assert.match(source, /<Empty text="外部実行はまだありません。" \/>/);
  assert.match(source, /const attentionLaneStatuses = new Set\(\["active", "blocked"\]\);/);
  assert.match(source, /const attentionLaneHealthValues = new Set\(\["collision", "approval_required", "failed", "error", "unhealthy", "blocked"\]\);/);
  assert.match(source, /function laneNeedsAttention/);
  assert.match(source, /if \(attentionLaneStatuses\.has\(status\)\) return true;/);
  assert.match(source, /if \(!status \|\| status === "idle"\) return false;/);
  assert.match(source, /return attentionLaneHealthValues\.has\(health\);/);
  assert.match(lanesSource, /const active = lanes\.filter/);
  assert.match(lanesSource, /const attentionLanes = lanes\.filter\(laneNeedsAttention\);/);
  assert.match(lanesSource, /const configured = lanes\.filter/);
  assert.match(lanesSource, /<span>使用中<\/span>/);
  assert.match(lanesSource, /<span>要確認<\/span>/);
  assert.match(lanesSource, /<span>接続設定<\/span>/);
  assert.match(lanesSource, /<LaneFocusList lanes=\{attentionLanes\} \/>/);
  assert.match(lanesSource, /<summary>監査詳細<\/summary>/);
  assert.match(lanesSource, /<LaneMatrix lanes=\{lanes\} \/>/);
  assert.match(source, /<Empty text="要確認のレーンはありません。" \/>/);
});

test("frontend keeps runs and skills views within middle width layouts", () => {
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");

  assert.match(styles, /\.panel \{[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.create-view \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(0, 390px\);/);
  assert.match(styles, /\.obsidian-sync-actions \{[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.obsidian-sync-actions \{[\s\S]*?flex-wrap: wrap;/);
  assert.match(
    styles,
    /@media \(max-width: 1180px\) \{[\s\S]*?\.create-view,\s*\.runs-view,\s*\.skills-view \{[\s\S]*?grid-template-columns: 1fr;/
  );
  assert.match(styles, /@media \(max-width: 520px\) \{[\s\S]*?\.local-worker-main,\s*\.deployment-main \{[\s\S]*?flex-direction: column;/);
});

test("frontend Browser Use result view keeps current receipts and cleanup reasons clear", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const cleanupSource = source.slice(source.indexOf("function displayCleanupStatus"), source.indexOf("function displayShortDateTime"));
  const bridgeActionSource = source.slice(source.indexOf("function BridgeActionList"), source.indexOf("function BridgeExecutionList"));

  assert.match(source, /function toBrowserUseResult/);
  assert.match(cleanupSource, /cleanup\.reason === "browser_use_cli_missing"/);
  assert.match(cleanupSource, /実行できませんでした/);
  assert.match(cleanupSource, /cleanup\.reason === "cdp_profile_lane_preserved"/);
  assert.match(cleanupSource, /専用レーンを保持/);
  assert.doesNotMatch(cleanupSource, /if \(cleanup\.status === "skipped"\) return "片付け不要";/);
  assert.match(bridgeActionSource, /if \(!latestByCapability\.has\(String\(receipt\.capability_id\)\)\)/);
  assert.doesNotMatch(bridgeActionSource, /new Map\(receipts\.map/);
  assert.match(styles, /\.browser-use-result-head \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(styles, /\.browser-use-result-head \{[\s\S]*?min-width: 0;/);
});

test("frontend lane matrix exposes public Playwright and visibility columns", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const styles = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const connectionSource = source.slice(source.indexOf("function displayLaneConnection"), source.indexOf("function displayLaneVisibility"));
  const laneSource = source.slice(source.indexOf("function LaneMatrix"), source.indexOf("function ResearchTable"));
  const laneMobileTheadBlock = styles.slice(styles.indexOf(".lane-matrix-table thead {"), styles.indexOf(".lane-matrix-table tr {"));

  assert.match(connectionSource, /Playwright専用/);
  assert.match(connectionSource, /専用プロファイル/);
  assert.match(source, /Playwrightで確認しました/);
  assert.match(source, /> Playwright<\/button>/);
  assert.doesNotMatch(source, /> Browser Use<\/button>/);
  assert.match(laneSource, /<th>ブラウザ<\/th>/);
  assert.match(laneSource, /<th>プロファイル<\/th>/);
  assert.match(laneSource, /<th>可視性<\/th>/);
  assert.match(laneSource, /<th>実行\/更新<\/th>/);
  assert.doesNotMatch(laneSource, /lane\.browser_use_session/);
  assert.doesNotMatch(laneSource, /lane\.browser_use_cdp_url/);
  assert.doesNotMatch(laneSource, /lane\.browser_use_profile/);
  assert.doesNotMatch(laneSource, /lane\.profile_dir/);
  assert.doesNotMatch(laneSource, /lane\.cdp_port/);
  assert.match(laneSource, /displayLaneRunName/);
  assert.match(laneSource, /displayShortDateTime\(lane\.updated_at\)/);
  assert.match(laneSource, /displayLaneVisibility/);
  assert.match(styles, /\.lane-matrix-table \{[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.lane-matrix-table th,\s*\.lane-matrix-table td \{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.lane-matrix-table td:nth-child\(12\)::before \{ content: "ロック"; \}/);
  assert.match(styles, /\.lane-matrix-table tr \{[\s\S]*?margin-bottom: 8px;/);
  assert.doesNotMatch(styles, /\.lane-matrix-table \{[\s\S]*?min-width: 1320px;/);
  assert.match(laneMobileTheadBlock, /position: absolute;/);
  assert.doesNotMatch(laneMobileTheadBlock, /display: none;/);
  assert.match(styles, /\.lane-detail-cell,\s*\.lane-path-cell,\s*\.lane-run-cell \{[\s\S]*?word-break: break-word;/);
});
