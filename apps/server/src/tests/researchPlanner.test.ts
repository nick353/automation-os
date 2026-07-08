import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-research-planner-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(tempRoot, "secrets");
process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "0";
process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DEFER_MS = "600000";
process.env.NODE_TEST_CONTEXT = "1";

const {
  app,
  enforceResearchPlanCompletionBoundary,
  resetResearchPlanDemoRunnerForTests,
  resetResearchPlanStartRunnerForTests,
  resetYouTubeTranscriptCaptureRunnerForTests,
  runResearchPlanSchedulerOnce,
  setResearchPlanDemoRunnerForTests,
  setResearchPlanStartRunnerForTests,
  setYouTubeTranscriptCaptureRunnerForTests,
  storeResearchPlanVisibleSourceProof
} = await import("../index.js");
const { createResearchPlan, getResearchPlan, markResearchPlanStarted } = await import("../planner/researchPlanner.js");
const { setUrlCaptureFetchImplForTests } = await import("../obsidian/urlCapture.js");
const db = await import("../db/client.js");

const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";
let successfulResearchPlanStartCounter = 0;

test.beforeEach(() => {
  installSuccessfulResearchPlanStartRunner();
});

test.after(() => {
  setUrlCaptureFetchImplForTests(undefined, undefined);
  resetResearchPlanStartRunnerForTests();
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
});

function deferFixedRegisteredWorkflowSchedulesForResearchTests() {
  db.execSql(`
    UPDATE registered_workflows
    SET status='inactive',
        created_at='2099-01-01T00:00:00.000Z',
        updated_at='2099-01-01T00:00:00.000Z'
    WHERE runner_kind!='research_plan_registered';
  `);
}

function installSuccessfulResearchPlanStartRunner() {
  setResearchPlanStartRunnerForTests(async (command: string, options?: { metadata?: Record<string, unknown> }) => {
    const runId = `run_research_test_success_${++successfulResearchPlanStartCounter}`;
    db.insert("runs", {
      id: runId,
      name: command,
      status: "running",
      objective: command,
      created_at: "2026-06-16T09:00:00.000Z",
      updated_at: "2026-06-16T09:00:00.000Z",
      metadata_json: options?.metadata ?? {}
    });
    return { runId, run: {}, steps: [], approvals: [], proofs: [], children: [] };
  });
}

function delayedResearchPlanStartResult(runId: string) {
  return new Promise<{
    runId: string;
    run: Record<string, unknown>;
    steps: Record<string, unknown>[];
    approvals: Record<string, unknown>[];
    proofs: Record<string, unknown>[];
    children: Record<string, unknown>[];
  }>((resolve) => {
    setTimeout(() => {
      resolve({ runId, run: {}, steps: [], approvals: [], proofs: [], children: [] });
    }, 1_000);
  });
}

function delayedResearchPlanDemoResult(targetUrl = "http://127.0.0.1:5173/#create") {
  return new Promise<Awaited<ReturnType<Parameters<typeof setResearchPlanDemoRunnerForTests>[0]>>>((resolve) => {
    setTimeout(() => {
      resolve({
        id: "system_check_delayed_after_timeout",
        kind: "browser_check",
        driver: "browser_use_cli",
        status: "blocked",
        targetUrl,
        summary: "delayed result after timeout",
        screenshotPath: null,
        recordingPath: null,
        geminiQaPath: null,
        statePath: null,
        logPath: null,
        createdAt: new Date().toISOString(),
        steps: [],
        metadata: { exactBlocker: "delayed_after_timeout" } as any
      });
    }, 1_000);
  });
}

test("Research Planner stores no-cost read-only source policy and starts with a metadata snapshot", async () => {
  db.initDb();
  db.resetDemoData();

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "X publish approval boundary with YouTube transcript research",
    sources: { web: true, x: true, reddit: false, youtube: true, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string; sources: Array<{ key: string; enabled: boolean; boundary: string; metadata: Record<string, unknown> }> } };
  const youtube = created.plan.sources.find((source) => source.key === "youtube");
  const x = created.plan.sources.find((source) => source.key === "x");

  assert.equal(youtube?.enabled, true);
  assert.match(youtube?.boundary ?? "", /captions\.download.*認可/);
  assert.equal(youtube?.metadata.captionsDownload, "not_used_initially");
  assert.equal(x?.metadata.defaultTooling, "dedicated_browser_cdp_profile");
  assert.equal(x?.metadata.apiBillingRequired, false);

  const startResponse = await postJson(`/api/planner/${created.plan.id}/start`, {
    createSession: {
      messages: [
        { role: "user", text: "API課金を増やさず、ローカルCodex workerで実行したい" },
        { role: "assistant", text: "保存済み相談からrunを作ります。" }
      ],
      draft: {
        title: "ローカルCodex worker連携",
        command: "保存済み相談からworker jobを作る",
        reply: "Mac workerへ渡すrunを作ります。",
        visibleSteps: ["保存済み相談を読む", "runを作る", "Mac workerが拾う"],
        backendChecks: ["create_session_snapshot", "worker_queue"],
        answered: ["実行エンジン"],
        openQuestions: ["常駐方法"],
        nextAction: "worker job handoffへ進む",
        executionDecision: "demo_first",
        confidence: "medium",
        plannerSource: "local_fallback"
      },
      researchSources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false },
      command: "保存済み相談からworker jobを作る"
    }
  });
  assert.equal(startResponse.status, 202);
  const started = JSON.parse(startResponse.body) as { runId: string; workerProtocol?: string; plan: { status: string; runId: string } };
  assert.equal(started.workerProtocol, "local_worker_loop_required");
  assert.equal(started.plan.status, "started");
  assert.equal(started.plan.runId, started.runId);

  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json) as {
    research_plan_snapshot?: { id: string; snapshotRole: string; proofBoundary: string[] };
    create_session_source?: string;
    create_session_title?: string;
    create_session_snapshot?: { title: string; messages: Array<{ text: string }>; draft: { visibleSteps: string[] } };
    worker_protocol?: string;
    worker_loop?: { status?: string; launchReason?: string; requiredCommand?: string };
  };
  assert.equal(metadata.research_plan_snapshot?.id, created.plan.id);
  assert.equal(metadata.research_plan_snapshot?.snapshotRole, "pre_start_plan_evidence_not_completion_proof");
  assert.ok(metadata.research_plan_snapshot?.proofBoundary.some((item) => /完了証跡ではない/.test(item)));
  assert.equal(metadata.create_session_source, "create_view");
  assert.equal(metadata.create_session_title, "ローカルCodex worker連携");
  assert.equal(metadata.create_session_snapshot?.title, "ローカルCodex worker連携");
  assert.equal(metadata.create_session_snapshot?.messages.length, 2);
  assert.deepEqual(metadata.create_session_snapshot?.draft.visibleSteps, ["保存済み相談を読む", "runを作る", "Mac workerが拾う"]);
  assert.equal(metadata.worker_protocol, "local_worker_loop_required");
  assert.equal(metadata.worker_loop?.status, "waiting_for_pickup");
  assert.equal(metadata.worker_loop?.launchReason, "research_plan_direct_start");
  assert.equal(metadata.worker_loop?.requiredCommand, "npm run worker:loop");

  const fullMetadata = JSON.parse(run.metadata_json) as {
    research_plan_required_proofs?: string[];
    research_plan_missing_proofs?: string[];
    proof_gate?: { ok: boolean; reason: string };
  };
  assert.deepEqual(fullMetadata.research_plan_required_proofs, ["readable_source_snapshot:web", "visible_source_snapshot:youtube"]);
  assert.deepEqual(fullMetadata.research_plan_missing_proofs, ["readable_source_snapshot:web", "visible_source_snapshot:youtube"]);
  assert.equal(fullMetadata.proof_gate?.ok, false);
  assert.equal(fullMetadata.proof_gate?.reason, "research_plan_visible_source_proof_required");
});

test("Research Planner demo rejects non-local targets before Browser Use can operate them", async () => {
  db.initDb();
  db.resetDemoData();

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "YouTube transcript read-only planning",
    sources: { web: false, x: false, reddit: false, youtube: true, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };

  const demoResponse = await postJson(`/api/planner/${created.plan.id}/demo`, { targetUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(demoResponse.status, 400);
  assert.deepEqual(JSON.parse(demoResponse.body), {
    error: "research_plan_demo_target_must_be_local",
    externalOperation: false
  });

  const checks = db.querySql("SELECT * FROM system_checks");
  assert.equal(checks.length, 0);
});

test("Research Planner start accepts Create handoff while production write guard is locked", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  delete process.env.AUTOMATION_OS_WRITE_TOKEN;

  try {
    const createResponse = await postJson("/api/planner/research-plan", {
      command: "checkout payment approval smoke for Create handoff",
      title: "Create handoff"
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };
    const startResponse = await postJson(`/api/planner/${created.plan.id}/start`, {
      createSession: {
        messages: [{ role: "user", text: "Createから開始したい" }],
        draft: {
          title: "Create handoff",
          command: "checkout payment approval smoke for Create handoff",
          reply: "保存済み相談からrunを作ります。",
          visibleSteps: ["保存済み相談を読む", "runを作る"],
          backendChecks: ["create_session_snapshot"],
          answered: ["保存元"],
          openQuestions: [],
          nextAction: "履歴で確認する",
          executionDecision: "ready_to_start",
          confidence: "high"
        },
        researchSources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false },
        command: "checkout payment approval smoke for Create handoff"
      }
    });
    const body = JSON.parse(startResponse.body) as { runId: string; workerProtocol?: string; plan: { status: string } };
    const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(body.runId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as { create_session_title?: string; worker_protocol?: string; worker_loop?: { launchReason?: string } };

    assert.equal(startResponse.status, 202);
    assert.equal(body.workerProtocol, "local_worker_loop_required");
    assert.equal(body.plan.status, "started");
    assert.equal(metadata.create_session_title, "Create handoff");
    assert.equal(metadata.worker_protocol, "local_worker_loop_required");
    assert.equal(metadata.worker_loop?.launchReason, "research_plan_direct_start");
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("Research Planner start waits for approval without advertising worker pickup", async () => {
  db.initDb();
  db.resetDemoData();
  resetResearchPlanStartRunnerForTests();

  try {
    const createResponse = await postJson("/api/planner/research-plan", {
      command: "checkout payment approval smoke for saved Create session",
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };

    const startResponse = await postJson(`/api/planner/${created.plan.id}/start`, {});
    assert.equal(startResponse.status, 202);
    const body = JSON.parse(startResponse.body) as { runId: string; status: string; workerProtocol?: string; run: { status: string }; nextAction?: string };
    assert.equal(body.status, "waiting_approval");
    assert.equal(body.run.status, "waiting_approval");
    assert.equal(body.workerProtocol, undefined);
    assert.match(body.nextAction ?? "", /承認画面/);

    const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(body.runId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as { worker_protocol?: string; worker_loop?: unknown };
    assert.equal(metadata.worker_protocol, undefined);
    assert.equal(metadata.worker_loop, undefined);
  } finally {
    installSuccessfulResearchPlanStartRunner();
  }
});

test("Research Planner direct start timeout returns blocked without marking the plan started", async () => {
  db.initDb();
  db.resetDemoData();
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = "5";
  setResearchPlanStartRunnerForTests(async () => delayedResearchPlanStartResult("run_research_direct_timeout_delayed"));

  try {
    const command = "Research Planner direct start timeout regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };

    const startResponse = await postJson(`/api/planner/${created.plan.id}/start`, {});
    assert.equal(startResponse.status, 202);
    const body = JSON.parse(startResponse.body) as {
      ok: boolean;
      status: string;
      exactBlocker: string;
      timeoutMs: number;
      plan: { id: string; status: string; runId: string | null };
    };
    assert.equal(body.ok, false);
    assert.equal(body.status, "blocked");
    assert.equal(body.exactBlocker, "research_plan_start_timeout");
    assert.equal(body.timeoutMs, 5);
    assert.equal(body.plan.id, created.plan.id);
    assert.equal(body.plan.status, "planned");
    assert.equal(body.plan.runId, null);

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "planned");
    assert.equal(plan?.runId, null);
    const runCount = db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE objective=${db.sqlValue(command)};`)[0].count;
    assert.equal(runCount, 0);
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner direct start ignores delayed success after timeout", async () => {
  db.initDb();
  db.resetDemoData();
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = "5";
  type ResearchPlanStartRunnerBody = Awaited<ReturnType<Parameters<typeof setResearchPlanStartRunnerForTests>[0]>>;
  let resolveRunner: ((body: ResearchPlanStartRunnerBody) => void) | undefined;
  setResearchPlanStartRunnerForTests(
    async () =>
      new Promise<ResearchPlanStartRunnerBody>((resolve) => {
        resolveRunner = resolve;
      })
  );

  try {
    const command = "Research Planner direct delayed success regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: true, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };

    const startResponse = await postJson(`/api/planner/${created.plan.id}/start`, {});
    assert.equal(startResponse.status, 202);
    const body = JSON.parse(startResponse.body) as { exactBlocker: string; plan: { status: string; runId: string | null } };
    assert.equal(body.exactBlocker, "research_plan_start_timeout");
    assert.equal(body.plan.status, "planned");
    assert.equal(body.plan.runId, null);
    assert.ok(resolveRunner);

    const delayedRunId = "run_research_direct_delayed_success";
    db.insert("runs", {
      id: delayedRunId,
      name: command,
      status: "running",
      objective: command,
      created_at: "2026-06-16T10:01:05.000Z",
      updated_at: "2026-06-16T10:01:05.000Z",
      metadata_json: {}
    });
    resolveRunner({
      runId: delayedRunId,
      run: {},
      steps: [],
      approvals: [],
      proofs: [],
      children: []
    });
    await new Promise((resolve) => setImmediate(resolve));

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "planned");
    assert.equal(plan?.runId, null);
    const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(delayedRunId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as { research_plan_snapshot?: unknown; proof_gate?: unknown; research_plan_missing_proofs?: unknown };
    assert.equal(metadata.research_plan_snapshot, undefined);
    assert.equal(metadata.proof_gate, undefined);
    assert.equal(metadata.research_plan_missing_proofs, undefined);
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner demo timeout stores a blocked system check without marking the plan demoed", async () => {
  db.initDb();
  db.resetDemoData();
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_DEMO_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_DEMO_TIMEOUT_MS = "5";
  setResearchPlanDemoRunnerForTests(async ({ targetUrl = "http://127.0.0.1:5173/#create" } = {}) => delayedResearchPlanDemoResult(targetUrl));

  try {
    const createResponse = await postJson("/api/planner/research-plan", {
      command: "Research Planner demo timeout regression",
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };

    const demoResponse = await postJson(`/api/planner/${created.plan.id}/demo`, { targetUrl: "http://127.0.0.1:5173/#create" });
    assert.equal(demoResponse.status, 202);
    const body = JSON.parse(demoResponse.body) as {
      ok: boolean;
      status: string;
      exactBlocker: string;
      plan: { id: string; status: string; demoCheckId: string | null };
      systemCheck: { id: string; status: string; metadata: { exactBlocker?: string } };
    };
    assert.equal(body.ok, false);
    assert.equal(body.status, "blocked");
    assert.equal(body.exactBlocker, "research_plan_demo_timeout");
    assert.equal(body.plan.status, "planned");
    assert.equal(body.plan.demoCheckId, null);
    assert.equal(body.systemCheck.status, "blocked");
    assert.equal(body.systemCheck.metadata.exactBlocker, "research_plan_demo_timeout");

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "planned");
    assert.equal(plan?.demoCheckId, null);
    const checks = db.querySql<{ status: string; metadata_json: string }>("SELECT status, metadata_json FROM system_checks");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, "blocked");
    const metadata = JSON.parse(checks[0].metadata_json) as { metadata?: { exactBlocker?: string } };
    assert.equal(metadata.metadata?.exactBlocker, "research_plan_demo_timeout");
  } finally {
    resetResearchPlanDemoRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_DEMO_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_DEMO_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner demo blocked result does not mark the plan demoed", async () => {
  db.initDb();
  db.resetDemoData();
  setResearchPlanDemoRunnerForTests(async ({ targetUrl = "http://127.0.0.1:5173/#create" } = {}) => ({
    id: "system_check_demo_blocked",
    kind: "browser_check",
    driver: "browser_use_cli",
    status: "blocked",
    targetUrl,
    summary: "Browser Use local check blocked",
    screenshotPath: null,
    recordingPath: null,
    geminiQaPath: null,
    statePath: null,
    logPath: null,
    createdAt: new Date().toISOString(),
    steps: [],
    metadata: {
      session: "research_plan_demo_blocked",
      driver: "browser_use_cli",
      connectionStrategy: {
        mode: "unique_session",
        session: "research_plan_demo_blocked",
        cdpUrl: null,
        profile: null
      },
      statePath: null,
      screenshotPath: null,
      recordingPath: null,
      geminiQaPath: null,
      logPath: null,
      geminiVideoQa: {
        status: "blocked",
        artifactUri: null,
        videoArtifactUri: null,
        completionVetoOnly: true,
        exactBlocker: "browser_use_local_check_blocked"
      },
      recordingQa: {
        required: true,
        status: "blocked",
        reason: "browser_use_recording_requires_cdp_lane",
        recorderStatus: "unavailable",
        cdpRequired: true,
        plannedVideoPath: null,
        manifestPath: null,
        artifactUri: null,
        videoArtifactUri: null,
        completionVetoOnly: true
      },
      recordingSidecar: {
        attempted: false,
        status: "skipped",
        reason: "browser_use_recording_requires_cdp_lane",
        exactBlocker: null,
        targetUrl,
        targetPageUrl: null,
        command: null
      },
      cleanup: {
        attempted: true,
        status: "blocked",
        reason: "cleanup_blocked",
        command: null
      },
      missingArtifacts: ["screenshotPath"],
      artifactValidationStatus: "blocked",
      profileIsolation: {
        status: "session_only",
        summary: "Browser Use returned a blocked local check."
      },
      exactBlocker: "browser_use_local_check_blocked"
    }
  }));

  try {
    const createResponse = await postJson("/api/planner/research-plan", {
      command: "Research Planner demo blocked regression",
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };

    const demoResponse = await postJson(`/api/planner/${created.plan.id}/demo`, { targetUrl: "http://127.0.0.1:5173/#create" });
    assert.equal(demoResponse.status, 202);
    const body = JSON.parse(demoResponse.body) as {
      ok: boolean;
      status: string;
      exactBlocker: string;
      plan: { id: string; status: string; demoCheckId: string | null };
      systemCheck: { id: string; status: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.status, "blocked");
    assert.equal(body.exactBlocker, "browser_use_local_check_blocked");
    assert.equal(body.plan.status, "planned");
    assert.equal(body.plan.demoCheckId, null);
    assert.equal(body.systemCheck.status, "blocked");

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "planned");
    assert.equal(plan?.demoCheckId, null);
  } finally {
    resetResearchPlanDemoRunnerForTests();
  }
});

test("Research Planner stores custom visible flow from automation creation", async () => {
  db.initDb();
  db.resetDemoData();

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "Gmail follow-up demo",
    visibleFlow: [" Gmailを確認 ", "", "返信するものを見つける", "自動で状況を把握、記録"],
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string; visibleFlow: string[] } };

  assert.deepEqual(created.plan.visibleFlow, ["Gmailを確認", "返信するものを見つける", "自動で状況を把握、記録"]);

  const row = db.querySql<{ visible_flow_json: string }>(`SELECT visible_flow_json FROM research_plans WHERE id=${db.sqlValue(created.plan.id)} LIMIT 1`)[0];
  assert.deepEqual(JSON.parse(row.visible_flow_json), ["Gmailを確認", "返信するものを見つける", "自動で状況を把握、記録"]);
});

test("Research Planner regularizes demoed plans into registered workflows and can start them", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "Gmail follow-up demo",
    visibleFlow: ["Gmailを確認", "返信するものを見つける", "自動で状況を把握、記録"],
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };
  db.execSql(
    `UPDATE research_plans
     SET status='demoed',
         demo_check_id='system_check_regularize_test'
     WHERE id=${db.sqlValue(created.plan.id)};`
  );

  const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
  assert.equal(regularizeResponse.status, 201);
  const regularized = JSON.parse(regularizeResponse.body) as {
    workflow: { id: string; runner_kind: string; start_command_json: string; schedule_json: string; provenance_json: string };
  };
  const startCommand = JSON.parse(regularized.workflow.start_command_json) as { source: string; researchPlanId: string; visibleFlow: string[] };
  const schedule = JSON.parse(regularized.workflow.schedule_json) as { label: string; rrule: string; timezone: string };
  const provenance = JSON.parse(regularized.workflow.provenance_json) as { source: string; codexAppContinuousSync: boolean };

  assert.equal(regularized.workflow.runner_kind, "research_plan_registered");
  assert.equal(startCommand.source, "research_plan");
  assert.equal(startCommand.researchPlanId, created.plan.id);
  assert.deepEqual(startCommand.visibleFlow, ["Gmailを確認", "返信するものを見つける", "自動で状況を把握、記録"]);
  assert.equal(schedule.label, "毎日 09:00");
  assert.equal(schedule.timezone, "Asia/Taipei");
  assert.match(schedule.rrule, /FREQ=DAILY/);
  assert.equal(provenance.source, "research_plan_regularized");
  assert.equal(provenance.codexAppContinuousSync, true);
  db.execSql(
    `UPDATE registered_workflows
     SET provenance_json=${db.sqlValue({ ...provenance, scheduler: { exactBlocker: "stale_manual_start_blocker" } })}
     WHERE id=${db.sqlValue(regularized.workflow.id)};`
  );

  const startResponse = await postJson(`/api/registered-workflows/${regularized.workflow.id}/start`, {});
  assert.equal(startResponse.status, 202);
  const started = JSON.parse(startResponse.body) as { workerProtocol?: string; run: { runId: string; plan: { id: string; status: string } }; workflow: { id: string } };
  assert.equal(started.workerProtocol, "local_worker_loop_required");
  assert.equal(started.workflow.id, regularized.workflow.id);
  assert.equal(started.run.plan.id, created.plan.id);
  assert.equal(started.run.plan.status, "started");

  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.run.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json) as {
    registeredWorkflowId?: string;
    registered_workflow_id?: string;
    workflowId?: string;
    workflow_id?: string;
    registered_workflow_start?: { source?: string; runnerKind?: string };
    research_plan_snapshot?: { visibleFlow: string[]; snapshotRole: string };
    worker_protocol?: string;
    worker_loop?: { status?: string; launchReason?: string; requiredCommand?: string };
  };
  assert.equal(metadata.registeredWorkflowId, regularized.workflow.id);
  assert.equal(metadata.registered_workflow_id, regularized.workflow.id);
  assert.equal(metadata.workflowId, regularized.workflow.id);
  assert.equal(metadata.workflow_id, regularized.workflow.id);
  assert.deepEqual(metadata.registered_workflow_start, {
    source: "manual",
    runnerKind: "research_plan_registered"
  });
  assert.deepEqual(metadata.research_plan_snapshot?.visibleFlow, ["Gmailを確認", "返信するものを見つける", "自動で状況を把握、記録"]);
  assert.equal(metadata.research_plan_snapshot?.snapshotRole, "pre_start_plan_evidence_not_completion_proof");
  assert.equal(metadata.worker_protocol, "local_worker_loop_required");
  assert.equal(metadata.worker_loop?.status, "waiting_for_pickup");
  assert.equal(metadata.worker_loop?.launchReason, "registered_research_plan_manual_start");
  assert.equal(metadata.worker_loop?.requiredCommand, "npm run worker:loop");
  const workflowAfterStart = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
  const provenanceAfterStart = JSON.parse(workflowAfterStart.provenance_json) as { manual?: { lastManualRunId?: string; lastManualStartedAt?: string }; scheduler?: { exactBlocker?: string; lastManualRunId?: string; lastManualStartedAt?: string } };
  assert.equal(provenanceAfterStart.scheduler?.exactBlocker, undefined);
  assert.equal(provenanceAfterStart.manual?.lastManualRunId, started.run.runId);
  assert.equal(typeof provenanceAfterStart.manual?.lastManualStartedAt, "string");
  assert.equal(provenanceAfterStart.scheduler?.lastManualRunId, started.run.runId);
  assert.equal(typeof provenanceAfterStart.scheduler?.lastManualStartedAt, "string");
});

test("Research Planner registered workflow manual start timeout returns blocked without marking the plan started", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = "5";
  setResearchPlanStartRunnerForTests(async () => delayedResearchPlanStartResult("run_research_registered_manual_timeout_delayed"));

  try {
    const command = "Research Planner registered manual start timeout regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };
    db.execSql(
      `UPDATE research_plans
       SET status='demoed',
           demo_check_id='system_check_registered_manual_timeout_test'
       WHERE id=${db.sqlValue(created.plan.id)};`
    );
    const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
    assert.equal(regularizeResponse.status, 201);
    const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };

    const startResponse = await postJson(`/api/registered-workflows/${regularized.workflow.id}/start`, {});
    assert.equal(startResponse.status, 202);
    const body = JSON.parse(startResponse.body) as {
      ok: boolean;
      status: string;
      exactBlocker: string;
      timeoutMs: number;
      workflow: { id: string };
      startCommand: string;
      plan: { id: string; status: string; runId: string | null };
    };
    assert.equal(body.ok, false);
    assert.equal(body.status, "blocked");
    assert.equal(body.exactBlocker, "research_plan_start_timeout");
    assert.equal(body.timeoutMs, 5);
    assert.equal(body.workflow.id, regularized.workflow.id);
    assert.equal(body.startCommand, command);
    assert.equal(body.plan.id, created.plan.id);
    assert.equal(body.plan.status, "demoed");
    assert.equal(body.plan.runId, null);

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "demoed");
    assert.equal(plan?.runId, null);
    const runCount = db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE objective=${db.sqlValue(command)};`)[0].count;
    assert.equal(runCount, 0);
    const workflowAfterBlock = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
    const provenanceAfterBlock = JSON.parse(workflowAfterBlock.provenance_json) as { scheduler?: { exactBlocker?: string; lastManualBlockedAt?: string } };
    assert.equal(provenanceAfterBlock.scheduler?.exactBlocker, "research_plan_start_timeout");
    assert.equal(typeof provenanceAfterBlock.scheduler?.lastManualBlockedAt, "string");
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner registered workflow manual start ignores delayed success after timeout", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = "5";
  type ResearchPlanStartRunnerBody = Awaited<ReturnType<Parameters<typeof setResearchPlanStartRunnerForTests>[0]>>;
  let resolveRunner: ((body: ResearchPlanStartRunnerBody) => void) | undefined;
  setResearchPlanStartRunnerForTests(
    async () =>
      new Promise<ResearchPlanStartRunnerBody>((resolve) => {
        resolveRunner = resolve;
      })
  );

  try {
    const command = "Research Planner registered manual delayed success regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: true, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };
    db.execSql(
      `UPDATE research_plans
       SET status='demoed',
           demo_check_id='system_check_registered_manual_delayed_success_test'
       WHERE id=${db.sqlValue(created.plan.id)};`
    );
    const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
    assert.equal(regularizeResponse.status, 201);
    const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };

    const startResponse = await postJson(`/api/registered-workflows/${regularized.workflow.id}/start`, {});
    assert.equal(startResponse.status, 202);
    const body = JSON.parse(startResponse.body) as { exactBlocker: string; plan: { status: string; runId: string | null } };
    assert.equal(body.exactBlocker, "research_plan_start_timeout");
    assert.equal(body.plan.status, "demoed");
    assert.equal(body.plan.runId, null);
    assert.ok(resolveRunner);

    const delayedRunId = "run_research_registered_manual_delayed_success";
    db.insert("runs", {
      id: delayedRunId,
      name: command,
      status: "running",
      objective: command,
      created_at: "2026-06-16T10:02:05.000Z",
      updated_at: "2026-06-16T10:02:05.000Z",
      metadata_json: {}
    });
    resolveRunner({
      runId: delayedRunId,
      run: {},
      steps: [],
      approvals: [],
      proofs: [],
      children: []
    });
    await new Promise((resolve) => setImmediate(resolve));

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "demoed");
    assert.equal(plan?.runId, null);
    const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(delayedRunId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as { research_plan_snapshot?: unknown; proof_gate?: unknown; research_plan_missing_proofs?: unknown };
    assert.equal(metadata.research_plan_snapshot, undefined);
    assert.equal(metadata.proof_gate, undefined);
    assert.equal(metadata.research_plan_missing_proofs, undefined);
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner scheduler starts due registered plans once", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "X publish approval boundary scheduler test",
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };
  db.execSql(
    `UPDATE research_plans
     SET status='demoed',
         demo_check_id='system_check_scheduler_test'
     WHERE id=${db.sqlValue(created.plan.id)};`
  );
  const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
  assert.equal(regularizeResponse.status, 201);
  const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };
  db.execSql(
    `UPDATE registered_workflows
     SET created_at='2026-06-16T00:00:00.000Z',
         updated_at='2026-06-16T00:00:00.000Z'
     WHERE id=${db.sqlValue(regularized.workflow.id)};`
  );
  deferFixedRegisteredWorkflowSchedulesForResearchTests();

  const first = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00"));
  const second = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:02:00"));
  const row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
  const provenance = JSON.parse(row.provenance_json) as { scheduler?: { lastDueKey?: string; lastRunId?: string; lastStartedAt?: string } };

  assert.equal(first.checked, 1);
  assert.equal(first.started, 1);
  assert.equal(second.checked, 1);
  assert.equal(second.started, 0);
  assert.equal(provenance.scheduler?.lastDueKey, "2026-06-16T09:00");
  assert.equal(provenance.scheduler?.lastRunId, first.runIds[0]);
  assert.equal(typeof provenance.scheduler?.lastStartedAt, "string");
  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(first.runIds[0])} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json) as {
    registeredWorkflowId?: string;
    registered_workflow_id?: string;
    workflowId?: string;
    workflow_id?: string;
    registered_workflow_start?: { source?: string; runnerKind?: string; dueKey?: string };
  };
  assert.equal(metadata.registeredWorkflowId, regularized.workflow.id);
  assert.equal(metadata.registered_workflow_id, regularized.workflow.id);
  assert.equal(metadata.workflowId, regularized.workflow.id);
  assert.equal(metadata.workflow_id, regularized.workflow.id);
  assert.deepEqual(metadata.registered_workflow_start, {
    source: "scheduler",
    runnerKind: "research_plan_registered",
    dueKey: "2026-06-16T09:00"
  });
});

test("Research Planner scheduler uses runtime schedule override for due checks", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "Runtime schedule override scheduler test",
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };
  db.execSql(
    `UPDATE research_plans
     SET status='demoed',
         demo_check_id='system_check_scheduler_override_test'
     WHERE id=${db.sqlValue(created.plan.id)};`
  );
  const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
  assert.equal(regularizeResponse.status, 201);
  const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string; schedule_json: string } };
  assert.match(regularized.workflow.schedule_json, /BYHOUR=9/);
  db.execSql(
    `UPDATE registered_workflows
     SET created_at='2026-06-16T00:00:00.000Z',
         updated_at='2026-06-16T00:00:00.000Z'
     WHERE id=${db.sqlValue(regularized.workflow.id)};`
  );
  deferFixedRegisteredWorkflowSchedulesForResearchTests();

  const updateResponse = await patchJson(`/api/registered-workflows/${regularized.workflow.id}/schedule`, {
    frequency: "daily",
    time: "10:30"
  });
  const updateBody = JSON.parse(updateResponse.body) as { workflow: { schedule_label: string; schedule_json?: string; provenance_json?: string; scheduleControl?: unknown } };
  assert.equal(updateResponse.status, 200);
  assert.equal(updateBody.workflow.schedule_label, "毎日 10:30");
  assert.equal(updateBody.workflow.schedule_json, undefined);
  assert.equal(updateBody.workflow.provenance_json, undefined);
  assert.equal(updateBody.workflow.scheduleControl, undefined);

  const beforeOverrideDue = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:31:00"));
  const afterOverrideDue = await runResearchPlanSchedulerOnce(new Date("2026-06-16T10:31:00"));
  const row = db.querySql<{ schedule_json: string; provenance_json: string }>(`SELECT schedule_json, provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
  const provenance = JSON.parse(row.provenance_json) as { scheduleControl?: { scheduleOverride?: { time?: string } }; scheduler?: { lastDueKey?: string } };

  assert.match(row.schedule_json, /BYHOUR=9/);
  assert.equal(provenance.scheduleControl?.scheduleOverride?.time, "10:30");
  assert.equal(beforeOverrideDue.started, 0);
  assert.equal(afterOverrideDue.started, 1);
  assert.equal(provenance.scheduler?.lastDueKey, "2026-06-16T10:30");
});

test("Research Planner scheduler skips paused registered workflows until resumed", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");

  const command = "Paused Research Planner scheduler regression";
  const createResponse = await postJson("/api/planner/research-plan", {
    command,
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };
  db.execSql(
    `UPDATE research_plans
     SET status='demoed',
         demo_check_id='system_check_scheduler_pause_test'
     WHERE id=${db.sqlValue(created.plan.id)};`
  );
  const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
  assert.equal(regularizeResponse.status, 201);
  const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };
  db.execSql(
    `UPDATE registered_workflows
     SET created_at='2026-06-16T00:00:00.000Z',
         updated_at='2026-06-16T00:00:00.000Z'
     WHERE id=${db.sqlValue(regularized.workflow.id)};`
  );
  deferFixedRegisteredWorkflowSchedulesForResearchTests();

  const pauseResponse = await postJson(`/api/registered-workflows/${regularized.workflow.id}/pause`, {});
  assert.equal(pauseResponse.status, 200);
  const paused = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00"));
  assert.equal(paused.checked, 0);
  assert.equal(paused.started, 0);

  const resumeResponse = await postJson(`/api/registered-workflows/${regularized.workflow.id}/resume`, {});
  assert.equal(resumeResponse.status, 200);
  const resumed = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:02:00"));
  assert.equal(resumed.checked, 1);
  assert.equal(resumed.started, 1);
  const row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
  const provenance = JSON.parse(row.provenance_json) as { scheduleControl?: { paused?: boolean }; scheduler?: { lastRunId?: string } };
  assert.equal(provenance.scheduleControl?.paused, false);
  assert.equal(provenance.scheduler?.lastRunId, resumed.runIds[0]);
});

test("Research Planner scheduler does not double-start the same in-flight due key", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");

  const command = "X publish approval boundary scheduler in-flight duplicate test";
  const createResponse = await postJson("/api/planner/research-plan", {
    command,
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };
  db.execSql(
    `UPDATE research_plans
     SET status='demoed',
         demo_check_id='system_check_scheduler_in_flight_test'
     WHERE id=${db.sqlValue(created.plan.id)};`
  );
  const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
  assert.equal(regularizeResponse.status, 201);
  const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };
  db.execSql(
    `UPDATE registered_workflows
     SET created_at='2026-06-16T00:00:00.000Z',
         updated_at='2026-06-16T00:00:00.000Z'
     WHERE id=${db.sqlValue(regularized.workflow.id)};`
  );
  deferFixedRegisteredWorkflowSchedulesForResearchTests();

  const results = await Promise.all([
    runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00")),
    runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00"))
  ]);
  const started = results.reduce((sum, result) => sum + result.started, 0);
  const skipped = results.reduce((sum, result) => sum + result.skipped, 0);
  const runIds = results.flatMap((result) => result.runIds);
  const runCount = db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE objective=${db.sqlValue(command)};`)[0].count;
  const row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
  const provenance = JSON.parse(row.provenance_json) as { scheduler?: { lastDueKey?: string; lastRunId?: string } };

  assert.equal(started, 1);
  assert.equal(skipped, 1);
  assert.equal(runIds.length, 1);
  assert.equal(runCount, 1);
  assert.equal(provenance.scheduler?.lastDueKey, "2026-06-16T09:00");
  assert.equal(provenance.scheduler?.lastRunId, runIds[0]);
});

test("Research Planner scheduler reports start timeout as blocked without counting it as started", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS = "5";
  setResearchPlanStartRunnerForTests(async () => delayedResearchPlanStartResult("run_research_scheduler_timeout_delayed"));

  try {
    const command = "Research Planner scheduler timeout regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };
    db.execSql(
      `UPDATE research_plans
       SET status='demoed',
           demo_check_id='system_check_scheduler_timeout_test'
       WHERE id=${db.sqlValue(created.plan.id)};`
    );
    const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
    assert.equal(regularizeResponse.status, 201);
    const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };
    db.execSql(
      `UPDATE registered_workflows
       SET created_at='2026-06-16T00:00:00.000Z',
           updated_at='2026-06-16T00:00:00.000Z'
       WHERE id=${db.sqlValue(regularized.workflow.id)};`
    );
    deferFixedRegisteredWorkflowSchedulesForResearchTests();

    const result = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00"));
    assert.equal(result.checked, 1);
    assert.equal(result.started, 0);
    assert.equal(result.blocked, 1);
    assert.deepEqual(result.runIds, []);
    assert.deepEqual(result.blockedWorkflowIds, [regularized.workflow.id]);
    assert.deepEqual(result.blockers, [
      {
        workflowId: regularized.workflow.id,
        dueKey: "2026-06-16T09:00",
        exactBlocker: "research_plan_scheduler_start_timeout"
      }
    ]);

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "demoed");
    assert.equal(plan?.runId, null);
    const runCount = db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE objective=${db.sqlValue(command)};`)[0].count;
    assert.equal(runCount, 0);
    const row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
    const provenance = JSON.parse(row.provenance_json) as { scheduler?: { exactBlocker?: string; lastDueKey?: string; lastBlockedAt?: string } };
    assert.equal(provenance.scheduler?.lastDueKey, "2026-06-16T09:00");
    assert.equal(provenance.scheduler?.exactBlocker, "research_plan_scheduler_start_timeout");
    assert.equal(typeof provenance.scheduler?.lastBlockedAt, "string");
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner scheduler clears current blocker after a later successful start", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS = "5";
  setResearchPlanStartRunnerForTests(async () => delayedResearchPlanStartResult("run_research_scheduler_clear_blocker_delayed"));

  try {
    const command = "Research Planner scheduler clears stale blocker regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };
    db.execSql(
      `UPDATE research_plans
       SET status='demoed',
           demo_check_id='system_check_scheduler_clear_blocker_test'
       WHERE id=${db.sqlValue(created.plan.id)};`
    );
    const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
    assert.equal(regularizeResponse.status, 201);
    const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };
    db.execSql(
      `UPDATE registered_workflows
       SET created_at='2026-06-16T00:00:00.000Z',
           updated_at='2026-06-16T00:00:00.000Z'
       WHERE id=${db.sqlValue(regularized.workflow.id)};`
    );
    deferFixedRegisteredWorkflowSchedulesForResearchTests();

    const blockedResult = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00"));
    assert.equal(blockedResult.blocked, 1);
    let row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
    let provenance = JSON.parse(row.provenance_json) as { scheduler?: { exactBlocker?: string; lastBlockedAt?: string; lastRunId?: string; lastStartedAt?: string } };
    assert.equal(provenance.scheduler?.exactBlocker, "research_plan_scheduler_start_timeout");
    assert.equal(typeof provenance.scheduler?.lastBlockedAt, "string");
    assert.equal(provenance.scheduler?.lastStartedAt, undefined);

    delete process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
    const successfulRunId = "run_research_scheduler_clear_blocker_success";
    setResearchPlanStartRunnerForTests(async () => {
      db.insert("runs", {
        id: successfulRunId,
        name: command,
        status: "running",
        objective: command,
        created_at: "2026-06-17T09:01:05.000Z",
        updated_at: "2026-06-17T09:01:05.000Z",
        metadata_json: {}
      });
      return { runId: successfulRunId, run: {}, steps: [], approvals: [], proofs: [], children: [] };
    });

    const successResult = await runResearchPlanSchedulerOnce(new Date("2026-06-17T09:01:00"));
    assert.equal(successResult.started, 1);
    row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
    provenance = JSON.parse(row.provenance_json) as { scheduler?: { exactBlocker?: string; lastBlockedAt?: string; lastRunId?: string; lastStartedAt?: string } };
    assert.equal(provenance.scheduler?.exactBlocker, undefined);
    assert.equal(typeof provenance.scheduler?.lastBlockedAt, "string");
    assert.equal(provenance.scheduler?.lastRunId, successfulRunId);
    assert.equal(typeof provenance.scheduler?.lastStartedAt, "string");
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner scheduler ignores delayed start success after timeout", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");
  const previousTimeout = process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
  process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS = "5";
  type ResearchPlanStartRunnerBody = Awaited<ReturnType<Parameters<typeof setResearchPlanStartRunnerForTests>[0]>>;
  let resolveRunner: ((body: ResearchPlanStartRunnerBody) => void) | undefined;
  setResearchPlanStartRunnerForTests(
    async () =>
      new Promise<ResearchPlanStartRunnerBody>((resolve) => {
        resolveRunner = resolve;
      })
  );

  try {
    const command = "Research Planner scheduler delayed success regression";
    const createResponse = await postJson("/api/planner/research-plan", {
      command,
      sources: { web: true, x: false, reddit: false, youtube: false, mcp: false, api: false }
    });
    assert.equal(createResponse.status, 201);
    const created = JSON.parse(createResponse.body) as { plan: { id: string } };
    db.execSql(
      `UPDATE research_plans
       SET status='demoed',
           demo_check_id='system_check_scheduler_delayed_success_test'
       WHERE id=${db.sqlValue(created.plan.id)};`
    );
    const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
    assert.equal(regularizeResponse.status, 201);
    const regularized = JSON.parse(regularizeResponse.body) as { workflow: { id: string } };
    db.execSql(
      `UPDATE registered_workflows
       SET created_at='2026-06-16T00:00:00.000Z',
           updated_at='2026-06-16T00:00:00.000Z'
       WHERE id=${db.sqlValue(regularized.workflow.id)};`
    );
    deferFixedRegisteredWorkflowSchedulesForResearchTests();

    const result = await runResearchPlanSchedulerOnce(new Date("2026-06-16T09:01:00"));
    assert.equal(result.checked, 1);
    assert.equal(result.started, 0);
    assert.equal(result.blocked, 1);
    assert.deepEqual(result.runIds, []);
    assert.deepEqual(result.blockedWorkflowIds, [regularized.workflow.id]);
    assert.deepEqual(result.blockers, [
      {
        workflowId: regularized.workflow.id,
        dueKey: "2026-06-16T09:00",
        exactBlocker: "research_plan_scheduler_start_timeout"
      }
    ]);
    assert.ok(resolveRunner);

    const delayedRunId = "run_research_scheduler_delayed_success";
    db.insert("runs", {
      id: delayedRunId,
      name: command,
      status: "running",
      objective: command,
      created_at: "2026-06-16T09:01:05.000Z",
      updated_at: "2026-06-16T09:01:05.000Z",
      metadata_json: {}
    });
    resolveRunner({
      runId: delayedRunId,
      run: {},
      steps: [],
      approvals: [],
      proofs: [],
      children: []
    });
    await new Promise((resolve) => setImmediate(resolve));

    const plan = getResearchPlan(created.plan.id);
    assert.equal(plan?.status, "demoed");
    assert.equal(plan?.runId, null);
    const row = db.querySql<{ provenance_json: string }>(`SELECT provenance_json FROM registered_workflows WHERE id=${db.sqlValue(regularized.workflow.id)} LIMIT 1`)[0];
    const provenance = JSON.parse(row.provenance_json) as { scheduler?: { exactBlocker?: string; lastDueKey?: string; lastRunId?: string; lastStartedAt?: string; lastBlockedAt?: string } };
    assert.equal(provenance.scheduler?.lastDueKey, "2026-06-16T09:00");
    assert.equal(provenance.scheduler?.exactBlocker, "research_plan_scheduler_start_timeout");
    assert.equal(provenance.scheduler?.lastRunId, undefined);
    assert.equal(provenance.scheduler?.lastStartedAt, undefined);
    assert.equal(typeof provenance.scheduler?.lastBlockedAt, "string");

    const workflowReadback = await getJson("/api/registered-workflows");
    assert.equal(workflowReadback.status, 200);
    const matchingWorkflow = (JSON.parse(workflowReadback.body) as {
      workflows: Array<{
        id: string;
        provenance_json?: unknown;
        needs_check?: boolean;
        check_kind?: string;
        check_label?: string;
      }>;
    }).workflows.find((workflow) => workflow.id === regularized.workflow.id);
    assert.ok(matchingWorkflow);
    assert.equal(matchingWorkflow.provenance_json, undefined);
    assert.equal(matchingWorkflow.needs_check, true);
    assert.equal(matchingWorkflow.check_kind, "schedule");
    assert.equal(matchingWorkflow.check_label, "予定");

    const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(delayedRunId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as { research_plan_snapshot?: unknown; proof_gate?: unknown; research_plan_missing_proofs?: unknown };
    assert.equal(metadata.research_plan_snapshot, undefined);
    assert.equal(metadata.proof_gate, undefined);
    assert.equal(metadata.research_plan_missing_proofs, undefined);
  } finally {
    resetResearchPlanStartRunnerForTests();
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS = previousTimeout;
  }
});

test("Research Planner refuses regular scheduling before demo", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows WHERE runner_kind='research_plan_registered';");

  const createResponse = await postJson("/api/planner/research-plan", {
    command: "Gmail follow-up demo",
    sources: { web: false, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(createResponse.body) as { plan: { id: string } };

  const regularizeResponse = await postJson(`/api/planner/${created.plan.id}/regularize`, {});
  assert.equal(regularizeResponse.status, 409);
  assert.deepEqual(JSON.parse(regularizeResponse.body), { error: "research_plan_demo_required" });
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM registered_workflows WHERE runner_kind='research_plan_registered';")[0].count, 0);
});

test("Research Planner YouTube transcript capture proof satisfies connected YouTube proof", async () => {
  db.initDb();
  db.resetDemoData();

  const plan = createResearchPlan({
    command: "X and YouTube visible research",
    sources: { web: false, x: true, reddit: false, youtube: true, mcp: false, api: false }
  });
  const runId = "run_research_youtube_test";
  db.insert("runs", {
    id: runId,
    name: plan.command,
    status: "running",
    objective: plan.command,
    created_at: "2026-06-16T13:00:00.000Z",
    updated_at: "2026-06-16T13:00:00.000Z",
    metadata_json: {}
  });
  markResearchPlanStarted(plan.id, runId);
  enforceResearchPlanCompletionBoundary(runId, getResearchPlan(plan.id));

  const capture = {
    ok: true,
    status: "captured",
    captureId: "youtube_transcript_fake",
    artifactDir: join(tempRoot, "youtube-transcript-fake"),
    requestedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    sourceTitle: "Fake YouTube transcript",
    files: {
      manifest: join(tempRoot, "youtube-transcript-fake", "manifest.json"),
      stageOpen: join(tempRoot, "youtube-transcript-fake", "stage-open.json"),
      stageTranscript: join(tempRoot, "youtube-transcript-fake", "stage-transcript.json"),
      pageRedacted: join(tempRoot, "youtube-transcript-fake", "page-redacted.json"),
      transcriptRedacted: join(tempRoot, "youtube-transcript-fake", "transcript-redacted.txt"),
      ingest: join(tempRoot, "youtube-transcript-fake", "ingest.json")
    },
    ingest: {
      ok: true,
      path: join(tempRoot, "vault", "09_Inbox", "Fake.md"),
      vaultPath: join(tempRoot, "vault"),
      sourceType: "youtube_transcript_capture",
      sourceTitle: "Fake YouTube transcript",
      capturedAt: "2026-06-16T13:00:00.000Z"
    } as any,
    segmentCount: 2,
    transcriptBytes: 123
  } as const;
  const proof = storeResearchPlanVisibleSourceProof(runId, "youtube", capture as any);
  assert.equal(proof.proofType, "visible_source_snapshot:youtube");
  enforceResearchPlanCompletionBoundary(runId, getResearchPlan(plan.id));

  const proofs = db.querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${db.sqlValue(runId)} ORDER BY proof_type ASC`);
  assert.deepEqual(proofs.map((candidate) => candidate.proof_type), ["visible_source_snapshot:youtube"]);

  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json) as {
    research_plan_missing_proofs?: string[];
    proof_gate?: { ok: boolean; missing: string[]; present: string[] };
  };
  assert.deepEqual(metadata.research_plan_missing_proofs, []);
  assert.equal(metadata.proof_gate?.ok, true);
  assert.deepEqual(metadata.proof_gate?.missing, []);
  assert.ok(metadata.proof_gate?.present.includes("visible_source_snapshot:youtube"));
});

test("Research Planner Web URL capture API saves a readable source proof", async () => {
  db.initDb();
  db.resetDemoData();
  const vaultPath = createVault("research-web-capture-success");
  const plan = createResearchPlan({
    command: "Web URL readable research",
    sources: { web: true, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  const runId = "run_research_web_capture";
  db.insert("runs", {
    id: runId,
    name: plan.command,
    status: "running",
    objective: plan.command,
    created_at: "2026-06-16T14:00:00.000Z",
    updated_at: "2026-06-16T14:00:00.000Z",
    metadata_json: {}
  });
  markResearchPlanStarted(plan.id, runId);
  setUrlCaptureFetchImplForTests(
    async () => new Response("<html><head><title>Planner Web Proof</title></head><body><article><p>Readable web proof content.</p></article></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    }),
    async () => ["93.184.216.34"]
  );
  try {
    const response = await postJson(`/api/planner/${plan.id}/capture/web-url`, {
      url: "https://example.com/planner-web-proof",
      vaultPath
    });
    assert.equal(response.status, 201);
    const body = JSON.parse(response.body) as { ok: boolean; run: { metadata_json: string }; proof: { proofType: string; uri: string }; plan: { metadata: Record<string, any> } };
    assert.equal(body.ok, true);
    assert.equal(body.proof.proofType, "readable_source_snapshot:web");
    assert.match(body.proof.uri, /Planner-Web-Proof\.md$/);
    assert.equal(body.plan.metadata.latestCaptures.web.proofState, "proof_saved");
    const runMetadata = JSON.parse(body.run.metadata_json) as { research_plan_missing_proofs?: string[]; proof_gate?: { ok: boolean; present: string[] } };
    assert.deepEqual(runMetadata.research_plan_missing_proofs, []);
    assert.equal(runMetadata.proof_gate?.ok, true);
    assert.ok(runMetadata.proof_gate?.present.includes("readable_source_snapshot:web"));
  } finally {
    setUrlCaptureFetchImplForTests(undefined, undefined);
  }
});

test("Research Planner YouTube transcript capture API passes URL and records saved proof", async () => {
  db.initDb();
  db.resetDemoData();
  const plan = createResearchPlan({
    command: "YouTube URL direct capture",
    sources: { web: false, x: false, reddit: false, youtube: true, mcp: false, api: false }
  });
  const runId = "run_research_youtube_capture_api";
  const detectedUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  db.insert("runs", {
    id: runId,
    name: plan.command,
    status: "running",
    objective: plan.command,
    created_at: "2026-06-16T13:20:00.000Z",
    updated_at: "2026-06-16T13:20:00.000Z",
    metadata_json: {}
  });
  markResearchPlanStarted(plan.id, runId);
  let receivedUrl: string | undefined;
  setYouTubeTranscriptCaptureRunnerForTests(async (input) => {
    receivedUrl = input.url;
    return {
      ok: true,
      status: "captured",
      captureId: "youtube_transcript_api_fake",
      artifactDir: join(tempRoot, "youtube-transcript-api-fake"),
      requestedUrl: input.url ?? "",
      currentUrl: input.url ?? "",
      sourceTitle: "API Fake YouTube transcript",
      files: {
        manifest: join(tempRoot, "youtube-transcript-api-fake", "manifest.json"),
        stageOpen: join(tempRoot, "youtube-transcript-api-fake", "stage-open.json"),
        stageTranscript: join(tempRoot, "youtube-transcript-api-fake", "stage-transcript.json"),
        pageRedacted: join(tempRoot, "youtube-transcript-api-fake", "page-redacted.json"),
        transcriptRedacted: join(tempRoot, "youtube-transcript-api-fake", "transcript-redacted.txt"),
        ingest: join(tempRoot, "youtube-transcript-api-fake", "ingest.json")
      },
      ingest: {
        ok: true,
        path: join(tempRoot, "vault", "09_Inbox", "Api-Fake.md"),
        vaultPath: join(tempRoot, "vault"),
        sourceType: "youtube_transcript_capture",
        sourceTitle: "API Fake YouTube transcript",
        capturedAt: "2026-06-16T13:20:00.000Z"
      } as any,
      segmentCount: 2,
      transcriptBytes: 123
    };
  });
  try {
    const response = await postJson(`/api/planner/${plan.id}/capture/youtube-transcript`, {
      url: detectedUrl
    });
    assert.equal(response.status, 201);
    assert.equal(receivedUrl, detectedUrl);
    const body = JSON.parse(response.body) as {
      ok: boolean;
      proof: { proofType: string };
      plan: { metadata: Record<string, any> };
      capture: { requestedUrl: string };
      run: { metadata_json: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.capture.requestedUrl, detectedUrl);
    assert.equal(body.proof.proofType, "visible_source_snapshot:youtube");
    assert.equal(body.plan.metadata.latestCaptures.youtube.proofState, "proof_saved");
    const runMetadata = JSON.parse(body.run.metadata_json) as { proof_gate?: { ok: boolean; present: string[] } };
    assert.equal(runMetadata.proof_gate?.ok, true);
    assert.ok(runMetadata.proof_gate?.present.includes("visible_source_snapshot:youtube"));
  } finally {
    resetYouTubeTranscriptCaptureRunnerForTests();
  }
});

test("Research Planner Web URL capture API rejects caller-controlled artifact paths", async () => {
  db.initDb();
  db.resetDemoData();
  const plan = createResearchPlan({
    command: "Web URL artifact guard",
    sources: { web: true, x: false, reddit: false, youtube: false, mcp: false, api: false }
  });
  const runId = "run_research_web_artifact_guard";
  db.insert("runs", {
    id: runId,
    name: plan.command,
    status: "running",
    objective: plan.command,
    created_at: "2026-06-16T14:10:00.000Z",
    updated_at: "2026-06-16T14:10:00.000Z",
    metadata_json: {}
  });
  markResearchPlanStarted(plan.id, runId);
  let fetchCalled = false;
  setUrlCaptureFetchImplForTests(async () => {
    fetchCalled = true;
    throw new Error("fetch_should_not_be_called_for_disallowed_file_input");
  }, async () => ["93.184.216.34"]);
  try {
    const response = await postJson(`/api/planner/${plan.id}/capture/web-url`, {
      url: "https://example.com/article",
      artifactRoot: join(tempRoot, "caller-controlled-url-artifacts")
    });
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      status: "rejected",
      exactBlocker: "web_url_capture_file_write_input_not_allowed",
      summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
    });
    assert.equal(fetchCalled, false);
  } finally {
    setUrlCaptureFetchImplForTests(undefined, undefined);
  }
});

test("Research Planner YouTube transcript capture API rejects caller-controlled artifact paths", async () => {
  db.initDb();
  db.resetDemoData();
  const plan = createResearchPlan({
    command: "YouTube visible transcript capture",
    sources: { web: false, x: false, reddit: false, youtube: true, mcp: false, api: false }
  });
  const runId = "run_research_youtube_artifact_guard";
  db.insert("runs", {
    id: runId,
    name: plan.command,
    status: "running",
    objective: plan.command,
    created_at: "2026-06-16T13:30:00.000Z",
    updated_at: "2026-06-16T13:30:00.000Z",
    metadata_json: {}
  });
  markResearchPlanStarted(plan.id, runId);
  let runnerCalled = false;
  setYouTubeTranscriptCaptureRunnerForTests(async () => {
    runnerCalled = true;
    throw new Error("runner_should_not_be_called_for_disallowed_file_input");
  });
  try {
    const response = await postJson(`/api/planner/${plan.id}/capture/youtube-transcript`, {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      artifactRoot: join(tempRoot, "caller-controlled-artifacts")
    });
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      status: "rejected",
      exactBlocker: "youtube_transcript_file_write_input_not_allowed",
      summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
    });
    assert.equal(runnerCalled, false);
  } finally {
    resetYouTubeTranscriptCaptureRunnerForTests();
  }
});

function createVault(name: string): string {
  const vaultPath = join(tempRoot, name);
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  return vaultPath;
}

function postJson(path: string, payload: Record<string, unknown>) {
  return requestJson("POST", path, payload);
}

function patchJson(path: string, payload: Record<string, unknown>) {
  return requestJson("PATCH", path, payload);
}

function requestJson(method: string, path: string, payload: Record<string, unknown>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const bodyBuffer = Buffer.from(body);
    const req = Readable.from([bodyBuffer]) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = {
      "content-type": "application/json",
      "content-length": String(bodyBuffer.byteLength)
    };

    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase());
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };

    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

function getJson(path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = Readable.from([]) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = "GET";
    req.url = path;
    req.headers = {};

    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase());
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };

    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}
