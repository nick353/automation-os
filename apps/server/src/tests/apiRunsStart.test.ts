import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-api-runs-start-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(tempRoot, "secrets");

const { app } = await import("../index.js");
const db = await import("../db/client.js");
const secrets = await import("../secrets/secretStore.js");

function canonicalUserTableHash(): string {
  const tables = db.querySql<{ name: string; sql: string | null }>(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  const snapshot = tables.map((table) => {
    const columns = db.querySql<{ name: string; pk: number }>(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`);
    const orderedColumns = [...columns].sort((a, b) => a.pk - b.pk || a.name.localeCompare(b.name));
    const columnNames = orderedColumns.map((column) => column.name);
    const orderBy = orderedColumns.filter((column) => column.pk > 0).map((column) => quoteSqlIdentifier(column.name));
    const fallbackOrderBy = columnNames.map((column) => quoteSqlIdentifier(column));
    const orderClause = orderBy.length > 0 ? orderBy.join(", ") : fallbackOrderBy.join(", ");
    const rowSql = columnNames.length > 0
      ? `SELECT ${columnNames.map(quoteSqlIdentifier).join(", ")} FROM ${quoteSqlIdentifier(table.name)}${orderClause ? ` ORDER BY ${orderClause}` : ""}`
      : `SELECT * FROM ${quoteSqlIdentifier(table.name)}${orderClause ? ` ORDER BY ${orderClause}` : ""}`;
    const rows = db.querySql<Record<string, unknown>>(rowSql).map((row) => stableCanonicalValue(row));
    return {
      name: table.name,
      sql: table.sql ? table.sql.replace(/\s+/g, " ").trim() : null,
      columns: orderedColumns.map((column) => ({ name: column.name, pk: column.pk })),
      rows
    };
  });
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableCanonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableCanonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

test("POST /api/runs/start sanitizes raw API keys before creating the run", async () => {
  db.initDb();
  db.resetDemoData();

  const token = "sk-apiBoundary1234567890abcdefghijklmnopqrstuvwxyzABCD";
  const response = await postJson("/api/runs/start", { command: `  X publish token=${token}  ` });
  const body = JSON.parse(response.body) as { runId: string; workerProtocol?: string; run: { objective: string } };

  assert.equal(response.status, 202);
  assert.equal(body.workerProtocol, "local_worker_loop_required");
  assert.equal(secrets.readStoredSecret("secret_openai_api_key"), token);

  const run = db.querySql<{ name: string; objective: string; metadata_json: string }>(
    `SELECT name, objective, metadata_json FROM runs WHERE id=${db.sqlValue(body.runId)} LIMIT 1`
  )[0];
  const step = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM run_steps WHERE run_id=${db.sqlValue(body.runId)} LIMIT 1`
  )[0];
  const approvals = db.querySql<{ title: string }>(`SELECT title FROM approvals WHERE run_id=${db.sqlValue(body.runId)} ORDER BY created_at ASC`);
  const metadata = JSON.parse(run.metadata_json) as {
    command: string;
    plan: { command: string };
    worker_protocol?: string;
    worker_loop?: { requiredCommand?: string };
    route_decision?: { phase?: string; fingerprint?: string };
    route_decision_fingerprint?: string | null;
    route_readback?: null;
    execution_routing?: { fingerprint?: string };
  };
  const stepMetadata = JSON.parse(step.metadata_json) as {
    route_decision?: { phase?: string; fingerprint?: string };
    route_decision_fingerprint?: string | null;
    route_readback?: null;
  };
  const persistedStartFields = JSON.stringify({
    responseBody: body,
    runName: run.name,
    runObjective: run.objective,
    metadataCommand: metadata.command,
    planCommand: metadata.plan.command,
    approvalTitles: approvals.map((approval) => approval.title)
  });

  assert.equal(run.objective, "X publish token=[保存済み: OpenAI APIキー]");
  assert.equal(body.run.objective, run.objective);
  assert.equal(metadata.command, run.objective);
  assert.equal(metadata.plan.command, run.objective);
  assert.equal(metadata.worker_protocol, "local_worker_loop_required");
  assert.equal(metadata.worker_loop?.requiredCommand, "npm run worker:loop");
  assert.equal(metadata.route_decision?.phase, "route_decision");
  assert.equal(metadata.route_decision_fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(metadata.execution_routing?.fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(metadata.route_readback, null);
  assert.equal(stepMetadata.route_decision?.phase, "route_decision");
  assert.equal(stepMetadata.route_decision_fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(stepMetadata.route_readback, null);
  assert.equal(approvals.length, 0);
  assert.equal(persistedStartFields.includes(token), false);
});

test("GET /api/runs/:id returns execution routing readback from stored metadata", async () => {
  db.initDb();
  db.resetDemoData();

  const startResponse = await postJson("/api/runs/start", { command: "Codex server backend readback test" });
  const startBody = JSON.parse(startResponse.body) as { runId: string };
  const detailResponse = await requestJson("GET", `/api/runs/${encodeURIComponent(startBody.runId)}`);
  const detailBody = JSON.parse(detailResponse.body) as {
    executionRouting: Record<string, unknown> | null;
    run: { metadata_json: string };
  };
  const runMetadata = JSON.parse(detailBody.run.metadata_json) as {
    execution_routing?: Record<string, unknown>;
    route_decision?: Record<string, unknown>;
    route_decision_fingerprint?: string | null;
    route_readback?: null;
  };
  const routeDecision = runMetadata.route_decision as { fingerprint?: string } | undefined;

  assert.equal(detailResponse.status, 200);
  assert.deepEqual(detailBody.executionRouting, runMetadata.execution_routing ?? null);
  assert.equal(runMetadata.route_readback, null);
  assert.equal(runMetadata.route_decision_fingerprint, routeDecision?.fingerprint ?? null);
});

test("production write guard blocks state-changing API calls without a configured token", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  delete process.env.AUTOMATION_OS_WRITE_TOKEN;
  const beforeHash = canonicalUserTableHash();

  try {
    const response = await postJson("/api/runs/start", { command: "safe local smoke" });
    const body = JSON.parse(response.body) as { error: string; exactBlocker: string };
    const runs = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;
    const afterHash = canonicalUserTableHash();

    assert.equal(response.status, 423);
    assert.equal(body.error, "production_write_locked");
    assert.equal(body.exactBlocker, "production_write_locked");
    assert.equal(runs, 0);
    assert.equal(afterHash, beforeHash);
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("production write guard allows state-changing API calls with the configured token", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "test-write-token";

  try {
    const response = await postJson("/api/runs/start", { command: "safe local smoke" }, { "x-automation-os-token": "test-write-token" });
    const body = JSON.parse(response.body) as { runId: string };
    const runs = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;

    assert.equal(response.status, 202);
    assert.equal(typeof body.runId, "string");
    assert.equal(runs, 1);
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("production write guard and JSON parsing apply to early MVP automation routes", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "test-write-token";
  const request = {
    id: "guarded-mvp-automation",
    project_id: "project-a",
    automation_type: "safe-local-demo",
    name: "Guarded MVP automation",
    desc: "parser and guard regression",
    goal: "save a local draft",
    schedule: "09:00",
    cadence: "daily",
    lane: "Lane 1",
    risk_level: "high",
    approval_policy: "required_before_external_post",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { source: "test", external_action_allowed: false }
  };

  try {
    const blocked = await postJson("/api/mvp/automations", request);
    assert.equal(blocked.status, 401);
    assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_automations WHERE id='guarded-mvp-automation'")[0].count, 0);

    const allowed = await postJson("/api/mvp/automations", request, { "x-automation-os-token": "test-write-token" });
    const body = JSON.parse(allowed.body) as { automation: { id: string; name: string; builder_spec: Record<string, unknown> } };
    assert.equal(allowed.status, 201);
    assert.equal(body.automation.id, request.id);
    assert.equal(body.automation.name, request.name);
    assert.equal(body.automation.builder_spec.external_action_allowed, false);
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("production API access guard protects operator readbacks while health stays public", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequireApi = process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = "1";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "test-operator-token";

  try {
    const health = await requestJson("GET", "/api/health");
    const blocked = await requestJson("GET", "/api/mvp/state");
    const blockedMixedCase = await requestJson("GET", "/API/mvp/state");
    const blockedBody = JSON.parse(blocked.body) as { error: string };
    const allowed = await requestJson("GET", "/api/mvp/state", {}, { "x-automation-os-token": "test-operator-token" });
    const mixedCaseWithToken = await requestJson("GET", "/API/mvp/state", {}, { "x-automation-os-token": "test-operator-token" });
    const mixedCasePost = await postJson("/API/mvp/automations", { id: "mixed-case-bypass" }, { "x-automation-os-token": "test-operator-token" });

    assert.equal(health.status, 200);
    assert.equal(blocked.status, 401);
    assert.equal(blockedMixedCase.status, 401);
    assert.equal(blockedBody.error, "production_api_token_required");
    assert.equal(allowed.status, 200);
    assert.equal(mixedCaseWithToken.status, 404);
    assert.equal(mixedCasePost.status, 404);
    assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_automations WHERE id='mixed-case-bypass'")[0].count, 0);
  } finally {
    if (previousRequireApi === undefined) delete process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = previousRequireApi;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("production API access guard defaults closed without PORT and resists path variants", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequireApi = process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  const previousPort = process.env.PORT;
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  delete process.env.AUTOMATION_OS_WRITE_TOKEN;
  delete process.env.PORT;
  delete process.env.NODE_TEST_CONTEXT;

  try {
    const locked = await requestJson("GET", "/api/mvp/state");
    const lockedBody = JSON.parse(locked.body) as { error: string };
    assert.equal(locked.status, 423);
    assert.equal(lockedBody.error, "production_api_locked");

    for (const path of ["/api", "/api/", "/api//mvp/state", "/api/%6dvp/state", "/%61pi/mvp/state"]) {
      const response = await requestJson("GET", path);
      assert.equal(response.status, 423, `${path} must remain locked`);
    }

    process.env.AUTOMATION_OS_WRITE_TOKEN = "default-closed-token";
    const missing = await requestJson("GET", "/api/mvp/state");
    const allowed = await requestJson("GET", "/api/mvp/state", {}, { "x-automation-os-token": "default-closed-token" });
    assert.equal(missing.status, 401);
    assert.equal(allowed.status, 200);
  } finally {
    if (previousRequireApi === undefined) delete process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = previousRequireApi;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  }
});

test("POST /api/create/plan returns a planner result without OpenAI and bypasses write lock", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";
  delete process.env.AUTOMATION_OS_WRITE_TOKEN;
  delete process.env.OPENAI_API_KEY;

  try {
    const response = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "毎朝9時にDaily AIを確認したい" },
        { role: "assistant", text: "失敗時の扱いを確認します。" },
        { role: "user", text: "失敗したら30分後に再確認。URLとスクショとDBを証跡にして、投稿はURLが取れないなら止めます。" }
      ]
    });
    const body = JSON.parse(response.body) as { ok: boolean; plan: { source: string; openQuestions: string[]; answered: string[]; executionDecision: string } };
    const runs = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.plan.source, "local_fallback");
    assert.equal(body.plan.answered.includes("実行タイミング"), true);
    assert.equal(body.plan.answered.includes("完了証拠"), true);
    assert.equal(Array.isArray(body.plan.openQuestions), true);
    assert.notEqual(body.plan.executionDecision, "ask_more");
    assert.equal(runs, 0);
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan accepts content-shaped chat messages", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const response = await postJson("/api/create/plan", {
      messages: [
        { role: "user", content: "Mac workerの説明文がスマホで折り返し崩れしています。どこを直して、どう検証すればいいですか？" }
      ]
    });
    const body = JSON.parse(response.body) as { plan: { title: string; executionDecision: string; nextAction: string } };

    assert.equal(response.status, 200);
    assert.equal(body.plan.title, "Createチャットと画面表示を改善する");
    assert.equal(body.plan.executionDecision, "demo_first");
    assert.match(body.plan.nextAction, /本番画面で会話を再現/);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan accepts conversation content payloads", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const response = await postJson("/api/create/plan", {
      conversation: [
        {
          role: "user",
          content: "Daily AIのLinkedInだけ英語カルーセルにして、Xは日本語カードのままに調整したい。次の定期実行から反映したい。"
        }
      ]
    });
    const body = JSON.parse(response.body) as { plan: { title: string; command: string; reply: string; visibleSteps: string[] } };

    assert.equal(response.status, 200);
    assert.match(body.plan.title, /Daily AI/);
    assert.match(body.plan.command, /LinkedInだけ英語カルーセル/);
    assert.match(body.plan.reply, /Daily AI/);
    assert.equal(body.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), true);
    assert.notEqual(body.plan.title, "この作業を実行手順に分解する");
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan answers template quality questions without hijacking plain only requests", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const metaResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "毎朝の確認作業を自動化したい" },
        { role: "user", text: "テンプレートだけですか？同じ文章ばかりです。" }
      ]
    });
    const plainResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "まず保存だけしたいです。開始はまだしないでください。" }
      ]
    });
    const flexibleOperationResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "定型業務を柔軟に運用できるよう保存したいです。" }
      ]
    });
    const metaBody = JSON.parse(metaResponse.body) as { plan: { reply: string } };
    const plainBody = JSON.parse(plainResponse.body) as { plan: { reply: string } };
    const flexibleOperationBody = JSON.parse(flexibleOperationResponse.body) as { plan: { reply: string } };

    assert.equal(metaResponse.status, 200);
    assert.match(metaBody.plan.reply, /テンプレートだけではありません/);
    assert.equal(plainResponse.status, 200);
    assert.doesNotMatch(plainBody.plan.reply, /テンプレートだけではありません/);
    assert.equal(flexibleOperationResponse.status, 200);
    assert.doesNotMatch(flexibleOperationBody.plan.reply, /テンプレートだけではありません/);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan keeps multi-workflow adjustment targets separate", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const response = await postJson("/api/create/plan", {
      messages: [
        {
          role: "user",
          text: "登録済みのDaily AIとSNSと応募を、外部投稿や応募確定の直前で止める形に調整したい。ローカルCodexに戻らず、この画面から変更点を相談して保存できるようにしたい。"
        }
      ]
    });
    const body = JSON.parse(response.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string } };

    assert.equal(response.status, 200);
    assert.match(body.plan.title, /Daily AI・SNS・応募の登録workflow/);
    assert.match(body.plan.reply, /Daily AI:/);
    assert.match(body.plan.reply, /SNS:/);
    assert.match(body.plan.reply, /応募:/);
    assert.match(body.plan.reply, /ローカルCodexへ戻らず/);
    assert.equal(body.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), true);
    assert.match(body.plan.nextAction, /対象workflowごとの停止境界/);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan does not over-detect registered workflow adjustment", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const normalChangeResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIの通常相談です。投稿文を変更したい。" }
      ]
    });
    const registeredReadResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "登録済みのDaily AIを確認したい。" }
      ]
    });
    const continuationResponse = await postJson("/api/create/plan", {
      messages: [
        {
          role: "user",
          text: [
            "履歴からの続き相談です。",
            "対象: Daily AI",
            "止まった理由: 外部投稿の境界で止まった。",
            "保存記録: composer画面。",
            "正本: 保存記録。",
            "完了証拠: readback。",
            "自動で進める範囲: 同じ範囲。",
            "実行タイミング: 手動開始。"
          ].join("\n")
        }
      ]
    });
    const nisenprintsCodexResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "NisenPrintsをローカルCodexに戻らず調整したい。" }
      ]
    });
    const workflowReadResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIのworkflowを確認したい。" }
      ]
    });
    const localCodexReadResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIをローカルCodexで確認したい。" }
      ]
    });
    const localCodexNoReturnReadResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIをローカルCodexに戻らず確認したい。" }
      ]
    });
    const normalChangeBody = JSON.parse(normalChangeResponse.body) as { plan: { visibleSteps: string[]; nextAction: string } };
    const registeredReadBody = JSON.parse(registeredReadResponse.body) as { plan: { visibleSteps: string[]; nextAction: string } };
    const continuationBody = JSON.parse(continuationResponse.body) as { plan: { title: string; visibleSteps: string[]; nextAction: string } };
    const nisenprintsCodexBody = JSON.parse(nisenprintsCodexResponse.body) as { plan: { title: string; reply: string } };
    const workflowReadBody = JSON.parse(workflowReadResponse.body) as { plan: { visibleSteps: string[]; nextAction: string } };
    const localCodexReadBody = JSON.parse(localCodexReadResponse.body) as { plan: { visibleSteps: string[]; nextAction: string } };
    const localCodexNoReturnReadBody = JSON.parse(localCodexNoReturnReadResponse.body) as { plan: { visibleSteps: string[]; nextAction: string } };

    assert.equal(normalChangeResponse.status, 200);
    assert.equal(normalChangeBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.doesNotMatch(normalChangeBody.plan.nextAction, /対象workflowごとの停止境界/);
    assert.equal(registeredReadResponse.status, 200);
    assert.equal(registeredReadBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.doesNotMatch(registeredReadBody.plan.nextAction, /対象workflowごとの停止境界/);
    assert.equal(continuationResponse.status, 200);
    assert.equal(continuationBody.plan.title, "止まった実行を次の一手へ戻す");
    assert.equal(continuationBody.plan.visibleSteps.includes("止まった履歴と保存記録を読む"), true);
    assert.doesNotMatch(continuationBody.plan.nextAction, /対象workflowごとの停止境界/);
    assert.equal(nisenprintsCodexResponse.status, 200);
    assert.match(nisenprintsCodexBody.plan.title, /NisenPrintsの登録workflow/);
    assert.doesNotMatch(nisenprintsCodexBody.plan.title, /SNS/);
    assert.match(nisenprintsCodexBody.plan.reply, /NisenPrints:/);
    assert.doesNotMatch(nisenprintsCodexBody.plan.reply, /SNS:/);
    assert.equal(workflowReadResponse.status, 200);
    assert.equal(workflowReadBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.doesNotMatch(workflowReadBody.plan.nextAction, /対象workflowごとの停止境界/);
    assert.equal(localCodexReadResponse.status, 200);
    assert.equal(localCodexReadBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.doesNotMatch(localCodexReadBody.plan.nextAction, /対象workflowごとの停止境界/);
    assert.equal(localCodexNoReturnReadResponse.status, 200);
    assert.equal(localCodexNoReturnReadBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.doesNotMatch(localCodexNoReturnReadBody.plan.nextAction, /対象workflowごとの停止境界/);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan handles Codex-like mixed chat intents without template drift", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const codexExactResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Codexのexact blockerを確認したい。投稿やSNSの話ではありません。" }
      ]
    });
    const readOnlyAdjustmentResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIを調整ではなく確認したい。今の状態を読むだけです。" }
      ]
    });
    const longMixedResponse = await postJson("/api/create/plan", {
      messages: [
        {
          role: "user",
          text: "登録済みのDaily AI、NisenPrints、求人応募、YouTube transcript captureをこの画面でまとめて相談したい。各workflowで、どこまで自動で進めるか、どこで止めるか、何を証跡にするかを分けたい。"
        }
      ]
    });
    const continuationResponse = await postJson("/api/create/plan", {
      messages: [
        {
          role: "user",
          text: [
            "summaryから前回の続き相談です。",
            "対象: Daily AI",
            "止まった理由: link_card_not_reflected",
            "保存記録: composer screenshot と run summary",
            "正本: posting_queue.tsv",
            "完了証拠: X URL と LinkedIn URL readback",
            "実行タイミング: 今すぐ手動開始。"
          ].join("\n")
        }
      ]
    });
    const readOnlyContinuationResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "前回の続きです。run_id abc123 の保存記録と不足している確認だけ読みたい。実行しないで。" }
      ]
    });
    const readOnlyBeforeChangeResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIを変更したいわけではなく、今の状態をread-onlyで確認したい。実行しないで。" }
      ]
    });
    const uiResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "CreateチャットのUI改善相談です。文字が大きすぎて折り返しが変で、Codex appみたいに柔軟に会話できるようにしたい。" }
      ]
    });
    const secretOnlyResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "OpenAI APIキー sk-test1234567890abcdefghijklmnopqrstuvwxyz を保存したいだけ。実行はしない。" }
      ]
    });
    const jobBoundaryResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "求人応募を20件やりたい。ただし応募確定ボタンの直前で止めて、会社名とURLと入力内容を見せて。" }
      ]
    });
    const scheduleChangeResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIの定期実行を毎朝8時に変えたい。失敗したら30分後に1回だけ再試行して。" }
      ]
    });
    const scheduleReservationChangeResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIの毎朝8時の予約を変更したい。失敗したら30分後に再試行して。" }
      ]
    });
    const incompleteScheduleChangeResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIの定期実行を変更したい。" }
      ]
    });
    const longUiComplaintResponse = await postJson("/api/create/plan", {
      messages: [
        {
          role: "user",
          text: "今の問題は、Automation OSのCreateチャットが毎回同じような質問をして、こちらの意図を分けられていないことです。読むだけ、保存だけ、実行したい、定期化したい、前回の続き、登録済みworkflowの変更を全部同じにしないで、画面から自然に相談できるようにしてください。"
        }
      ]
    });
    const capabilityQuestionResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "RunwayMCP" },
        { role: "assistant", text: "いつ動かし、失敗したら何分後に再確認しますか？" },
        { role: "user", text: "違います。このチャットができることを書き出してください全て" }
      ]
    });
    const statusCapabilityQuestionResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "RunwayMCP" },
        { role: "assistant", text: "いつ動かし、失敗したら何分後に再確認しますか？" },
        { role: "user", text: "今の状況としてこのチャットはどんなことまでできる？" }
      ]
    });
    const correctionNoRunCapabilityResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "RunwayMCPを毎日動かして" },
        { role: "assistant", text: "いつ動かし、失敗したら何分後に再確認しますか？" },
        { role: "user", text: "違う、今は動かさないで。まず何ができるかだけ説明して" }
      ]
    });
    const capabilityImprovementResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "このチャットでできることを増やしたい。UI改善相談です。" }
      ]
    });
    const youtubeTranscriptScheduleResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "YouTube文字起こしを毎朝8時に変えたい。失敗したら30分後に再試行して。" }
      ]
    });
    const promptTransferResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Prompt Transferで文字をSheetsへ転記するworkflowを変更したい。" }
      ]
    });
    const noPostResearchResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "毎朝8時にAIニュースを3件調べて、要約をObsidianに保存する自動化を作りたい。投稿はしない。" }
      ]
    });
    const noPostPrefixResearchResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "投稿はしない。毎朝8時にAIニュースを3件調べて、要約をObsidianに保存する自動化を作りたい。" }
      ]
    });
    const jobFailureReviewResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "さっきのJob Application Managerの失敗を見て、ロックが原因なら修正方針と次に実行する検証を提案して。" }
      ]
    });
    const readOnlyAutomationResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "毎朝9時に公式サイトの価格を確認して、変化があったらスクショとURLを保存する自動化を作りたい。投稿や購入はしない。" }
      ]
    });
    const dangerousBoundaryResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "求人応募を自動化したい。応募ボタンを押す直前で止めて、URL、画面、入力内容を証跡にして。" }
      ]
    });
    const promptTransferFailureReasonResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Prompt Transferが止まってる理由だけ教えて。Sheetsには書かないで" }
      ]
    });
    const serviceAccountSecretOnlyResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "GOOGLE_SERVICE_ACCOUNT_JSON={\"private_key\":\"abc\"} これは保存だけ。転記はまだやらないで" }
      ]
    });
    const incompleteAutomationResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "新しい自動化を作って" }
      ]
    });
    const codexExactBody = JSON.parse(codexExactResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[] } };
    const readOnlyAdjustmentBody = JSON.parse(readOnlyAdjustmentResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[] } };
    const longMixedBody = JSON.parse(longMixedResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[] } };
    const continuationBody = JSON.parse(continuationResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[] } };
    const readOnlyContinuationBody = JSON.parse(readOnlyContinuationResponse.body) as { plan: { title: string; command: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[] } };
    const readOnlyBeforeChangeBody = JSON.parse(readOnlyBeforeChangeResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[] } };
    const uiBody = JSON.parse(uiResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string } };
    const secretOnlyBody = JSON.parse(secretOnlyResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string } };
    const jobBoundaryBody = JSON.parse(jobBoundaryResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[] } };
    const scheduleChangeBody = JSON.parse(scheduleChangeResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[]; executionDecision: string } };
    const scheduleReservationChangeBody = JSON.parse(scheduleReservationChangeResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[]; executionDecision: string } };
    const incompleteScheduleChangeBody = JSON.parse(incompleteScheduleChangeResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[]; nextAction: string; openQuestions: string[]; executionDecision: string } };
    const longUiComplaintBody = JSON.parse(longUiComplaintResponse.body) as { plan: { title: string; visibleSteps: string[] } };
    const capabilityQuestionBody = JSON.parse(capabilityQuestionResponse.body) as { plan: { title: string; command: string; intent?: string; reply: string; visibleSteps: string[]; openQuestions: string[]; nextAction: string } };
    const statusCapabilityQuestionBody = JSON.parse(statusCapabilityQuestionResponse.body) as { plan: { title: string; command: string; intent?: string; reply: string; visibleSteps: string[]; openQuestions: string[]; nextAction: string } };
    const correctionNoRunCapabilityBody = JSON.parse(correctionNoRunCapabilityResponse.body) as { plan: { title: string; command: string; intent?: string; reply: string; openQuestions: string[] } };
    const capabilityImprovementBody = JSON.parse(capabilityImprovementResponse.body) as { plan: { title: string; intent?: string; visibleSteps: string[] } };
    const youtubeTranscriptScheduleBody = JSON.parse(youtubeTranscriptScheduleResponse.body) as { plan: { title: string; visibleSteps: string[] } };
    const promptTransferBody = JSON.parse(promptTransferResponse.body) as { plan: { title: string; visibleSteps: string[] } };
    const noPostResearchBody = JSON.parse(noPostResearchResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[] } };
    const noPostPrefixResearchBody = JSON.parse(noPostPrefixResearchResponse.body) as { plan: { title: string; reply: string; visibleSteps: string[] } };
    const jobFailureReviewBody = JSON.parse(jobFailureReviewResponse.body) as { plan: { title: string; nextAction: string; openQuestions: string[]; visibleSteps: string[] } };
    const readOnlyAutomationBody = JSON.parse(readOnlyAutomationResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };
    const dangerousBoundaryBody = JSON.parse(dangerousBoundaryResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };
    const promptTransferFailureReasonBody = JSON.parse(promptTransferFailureReasonResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };
    const serviceAccountSecretOnlyBody = JSON.parse(serviceAccountSecretOnlyResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };
    const incompleteAutomationBody = JSON.parse(incompleteAutomationResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };

    assert.equal(codexExactResponse.status, 200);
    assert.doesNotMatch(codexExactBody.plan.title, /SNS投稿/);
    assert.doesNotMatch(codexExactBody.plan.reply, /投稿・公開/);
    assert.equal(codexExactBody.plan.visibleSteps.includes("送信・投稿の直前に課金だけ止める境界を置く"), false);
    assert.equal(codexExactBody.plan.visibleSteps.includes("実行や投稿は開始しない"), true);
    assert.equal(readOnlyAdjustmentResponse.status, 200);
    assert.match(readOnlyAdjustmentBody.plan.title, /現在状態を確認する/);
    assert.equal(readOnlyAdjustmentBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.equal(readOnlyAdjustmentBody.plan.visibleSteps.includes("実行や投稿は開始しない"), true);
    assert.deepEqual(readOnlyAdjustmentBody.plan.openQuestions, []);
    assert.doesNotMatch(readOnlyAdjustmentBody.plan.reply, /対象ごとの調整/);
    assert.doesNotMatch(readOnlyAdjustmentBody.plan.nextAction, /対象workflowごとの停止境界/);
    assert.equal(longMixedResponse.status, 200);
    assert.match(longMixedBody.plan.title, /Daily AI・NisenPrints・応募・YouTube/);
    assert.match(longMixedBody.plan.reply, /Daily AI:/);
    assert.match(longMixedBody.plan.reply, /NisenPrints:/);
    assert.match(longMixedBody.plan.reply, /応募:/);
    assert.match(longMixedBody.plan.reply, /YouTube:/);
    assert.equal(longMixedBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), true);
    assert.equal(continuationResponse.status, 200);
    assert.equal(continuationBody.plan.title, "止まった実行を次の一手へ戻す");
    assert.match(continuationBody.plan.reply, /止まった実行結果を読み直して/);
    assert.equal(continuationBody.plan.visibleSteps.includes("止まった履歴と保存記録を読む"), true);
    assert.equal(readOnlyContinuationResponse.status, 200);
    assert.match(readOnlyContinuationBody.plan.title, /現在状態を確認する/);
    assert.doesNotMatch(readOnlyContinuationBody.plan.title, /次の一手へ戻す/);
    assert.doesNotMatch(readOnlyContinuationBody.plan.command, /再実行/);
    assert.equal(readOnlyContinuationBody.plan.visibleSteps.includes("実行や投稿は開始しない"), true);
    assert.deepEqual(readOnlyContinuationBody.plan.openQuestions, []);
    assert.match(readOnlyContinuationBody.plan.nextAction, /実行を始めず/);
    assert.equal(readOnlyBeforeChangeResponse.status, 200);
    assert.match(readOnlyBeforeChangeBody.plan.title, /現在状態を確認する/);
    assert.equal(readOnlyBeforeChangeBody.plan.visibleSteps.includes("実行や投稿は開始しない"), true);
    assert.deepEqual(readOnlyBeforeChangeBody.plan.openQuestions, []);
    assert.doesNotMatch(readOnlyBeforeChangeBody.plan.nextAction, /保存して|開始|停止境界/);
    assert.equal(uiResponse.status, 200);
    assert.equal(uiBody.plan.title, "Createチャットと画面表示を改善する");
    assert.match(uiBody.plan.reply, /Createチャットと画面表示の違和感/);
    assert.equal(uiBody.plan.visibleSteps.includes("固定応答・誤分類・表示崩れを分ける"), true);
    assert.match(uiBody.plan.nextAction, /本番画面で会話を再現/);
    assert.equal(secretOnlyResponse.status, 200);
    assert.equal(secretOnlyBody.plan.title, "認証情報だけを安全に保存する");
    assert.match(secretOnlyBody.plan.reply, /実行を始めない/);
    assert.equal(secretOnlyBody.plan.visibleSteps.includes("自動実行は開始しない"), true);
    assert.doesNotMatch(secretOnlyBody.plan.reply, /sk-test1234567890/);
    assert.equal(jobBoundaryResponse.status, 200);
    assert.match(jobBoundaryBody.plan.title, /応募|求人応募/);
    assert.doesNotMatch(jobBoundaryBody.plan.title, /Createチャットと画面表示/);
    assert.match(jobBoundaryBody.plan.reply, /送信・応募|応募/);
    assert.equal(jobBoundaryBody.plan.visibleSteps.includes("応募・送信確定前に会社名、求人URL、入力内容、確認画面を証跡化して止める"), true);
    assert.equal(jobBoundaryBody.plan.openQuestions.includes("どこまで自動で進めてよく、どこで止めたいですか？"), false);
    assert.equal(scheduleChangeResponse.status, 200);
    assert.match(scheduleChangeBody.plan.title, /Daily AIの登録workflow/);
    assert.equal(scheduleChangeBody.plan.visibleSteps.includes("実行時刻とリトライ条件を保存する"), true);
    assert.equal(scheduleChangeBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.deepEqual(scheduleChangeBody.plan.openQuestions, []);
    assert.equal(scheduleChangeBody.plan.executionDecision, "ready_to_schedule");
    assert.match(scheduleChangeBody.plan.nextAction, /次回予定とRuns反映/);
    assert.doesNotMatch(scheduleChangeBody.plan.reply, /どこまで自動で進めてよく/);
    assert.equal(scheduleReservationChangeResponse.status, 200);
    assert.match(scheduleReservationChangeBody.plan.title, /Daily AIの登録workflow/);
    assert.equal(scheduleReservationChangeBody.plan.visibleSteps.includes("実行時刻とリトライ条件を保存する"), true);
    assert.equal(scheduleReservationChangeBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), false);
    assert.deepEqual(scheduleReservationChangeBody.plan.openQuestions, []);
    assert.equal(scheduleReservationChangeBody.plan.executionDecision, "ready_to_schedule");
    assert.equal(incompleteScheduleChangeResponse.status, 200);
    assert.match(incompleteScheduleChangeBody.plan.title, /Daily AIの登録workflow/);
    assert.equal(incompleteScheduleChangeBody.plan.visibleSteps.includes("実行時刻とリトライ条件を保存する"), true);
    assert.equal(incompleteScheduleChangeBody.plan.openQuestions.includes("いつ動かし、失敗したら何分後に再確認しますか？"), true);
    assert.notEqual(incompleteScheduleChangeBody.plan.executionDecision, "ready_to_schedule");
    assert.match(incompleteScheduleChangeBody.plan.nextAction, /実行時刻と失敗時の扱いを確認/);
    assert.equal(longUiComplaintResponse.status, 200);
    assert.equal(longUiComplaintBody.plan.title, "Createチャットと画面表示を改善する");
    assert.equal(longUiComplaintBody.plan.visibleSteps.includes("固定応答・誤分類・表示崩れを分ける"), true);
    assert.equal(capabilityQuestionResponse.status, 200);
    assert.equal(capabilityQuestionBody.plan.title, "Createチャットでできること");
    assert.equal(capabilityQuestionBody.plan.intent, "answer_question");
    assert.deepEqual(capabilityQuestionBody.plan.openQuestions, []);
    assert.match(capabilityQuestionBody.plan.reply, /質問への回答、登録済み自動化の確認、計画作成/);
    assert.doesNotMatch(capabilityQuestionBody.plan.reply, /確認したいこと|進め方|だいぶ具体化できました/);
    assert.equal(capabilityQuestionBody.plan.visibleSteps.includes("登録済みworkflowの状態、履歴、失敗理由を確認する"), true);
    assert.match(capabilityQuestionBody.plan.nextAction, /読むだけ・保存・実演・開始・定期化/);
    assert.doesNotMatch(capabilityQuestionBody.plan.title, /RunwayMCP/);
    assert.doesNotMatch(capabilityQuestionBody.plan.command, /RunwayMCP/);
    assert.equal(statusCapabilityQuestionResponse.status, 200);
    assert.equal(statusCapabilityQuestionBody.plan.title, "Createチャットでできること");
    assert.equal(statusCapabilityQuestionBody.plan.intent, "answer_question");
    assert.deepEqual(statusCapabilityQuestionBody.plan.openQuestions, []);
    assert.doesNotMatch(statusCapabilityQuestionBody.plan.title, /RunwayMCP/);
    assert.doesNotMatch(statusCapabilityQuestionBody.plan.reply, /いつ動かし|確認したいこと|実行手順に分解/);
    assert.equal(correctionNoRunCapabilityResponse.status, 200);
    assert.equal(correctionNoRunCapabilityBody.plan.title, "Createチャットでできること");
    assert.equal(correctionNoRunCapabilityBody.plan.intent, "answer_question");
    assert.deepEqual(correctionNoRunCapabilityBody.plan.openQuestions, []);
    assert.match(correctionNoRunCapabilityBody.plan.reply, /今は動かしません/);
    assert.match(correctionNoRunCapabilityBody.plan.reply, /できること/);
    assert.doesNotMatch(correctionNoRunCapabilityBody.plan.reply, /いつ動かし|確認したいこと|実行手順に分解/);
    assert.doesNotMatch(correctionNoRunCapabilityBody.plan.command, /RunwayMCPを毎日動かして/);
    assert.equal(capabilityImprovementResponse.status, 200);
    assert.equal(capabilityImprovementBody.plan.intent, "plan_workflow");
    assert.equal(capabilityImprovementBody.plan.title, "Createチャットと画面表示を改善する");
    assert.equal(capabilityImprovementBody.plan.visibleSteps.includes("固定応答・誤分類・表示崩れを分ける"), true);
    assert.equal(youtubeTranscriptScheduleResponse.status, 200);
    assert.match(youtubeTranscriptScheduleBody.plan.title, /YouTubeの登録workflow/);
    assert.doesNotMatch(youtubeTranscriptScheduleBody.plan.title, /Createチャットと画面表示/);
    assert.equal(youtubeTranscriptScheduleBody.plan.visibleSteps.includes("実行時刻とリトライ条件を保存する"), true);
    const naturalDailyScheduleResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIを毎朝8時にして、失敗したら30分後に再確認して。" }
      ]
    });
    const missingTimeDailyScheduleResponse = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIを毎朝にして、失敗したら30分後に再確認して。" }
      ]
    });
    const naturalDailyScheduleBody = JSON.parse(naturalDailyScheduleResponse.body) as {
      plan: {
        title: string;
        reply: string;
        openQuestions: string[];
        executionDecision: string;
      }
    };
    const missingTimeDailyScheduleBody = JSON.parse(missingTimeDailyScheduleResponse.body) as {
      plan: {
        title: string;
        openQuestions: string[];
        executionDecision: string;
        nextAction: string;
      }
    };
    assert.equal(naturalDailyScheduleResponse.status, 200);
    assert.match(naturalDailyScheduleBody.plan.title, /Daily AIの登録workflow/);
    assert.deepEqual(naturalDailyScheduleBody.plan.openQuestions, []);
    assert.equal(naturalDailyScheduleBody.plan.executionDecision, "ready_to_schedule");
    assert.doesNotMatch(naturalDailyScheduleBody.plan.reply, /いつ動かし|確認したいこと|実行手順に分解/);
    assert.equal(missingTimeDailyScheduleResponse.status, 200);
    assert.match(missingTimeDailyScheduleBody.plan.title, /Daily AIの登録workflow/);
    assert.equal(missingTimeDailyScheduleBody.plan.openQuestions.includes("いつ動かし、失敗したら何分後に再確認しますか？"), true);
    assert.notEqual(missingTimeDailyScheduleBody.plan.executionDecision, "ready_to_schedule");
    assert.match(missingTimeDailyScheduleBody.plan.nextAction, /実行時刻と失敗時の扱いを確認/);
    assert.equal(promptTransferResponse.status, 200);
    assert.match(promptTransferBody.plan.title, /転記の登録workflow/);
    assert.doesNotMatch(promptTransferBody.plan.title, /Createチャットと画面表示/);
    assert.equal(promptTransferBody.plan.visibleSteps.includes("workflowごとに停止境界を分ける"), true);
    assert.equal(noPostResearchResponse.status, 200);
    assert.match(noPostResearchBody.plan.title, /AIニュース調査/);
    assert.doesNotMatch(noPostResearchBody.plan.reply, /必要な投稿・公開/);
    assert.equal(noPostResearchBody.plan.visibleSteps.includes("送信・投稿の直前に課金だけ止める境界を置く"), false);
    assert.equal(noPostResearchBody.plan.visibleSteps.includes("読み取りと保存だけで安全に確認する"), true);
    assert.equal(noPostPrefixResearchResponse.status, 200);
    assert.match(noPostPrefixResearchBody.plan.title, /AIニュース調査/);
    assert.doesNotMatch(noPostPrefixResearchBody.plan.title, /投稿はしない/);
    assert.doesNotMatch(noPostPrefixResearchBody.plan.reply, /必要な投稿・公開/);
    assert.equal(noPostPrefixResearchBody.plan.visibleSteps.includes("読み取りと保存だけで安全に確認する"), true);
    assert.equal(jobFailureReviewResponse.status, 200);
    assert.match(jobFailureReviewBody.plan.title, /応募.*現在状態を確認する|求人応募.*現在状態を確認する/);
    assert.deepEqual(jobFailureReviewBody.plan.openQuestions, []);
    assert.equal(jobFailureReviewBody.plan.visibleSteps.includes("実行や投稿は開始しない"), true);
    assert.doesNotMatch(jobFailureReviewBody.plan.nextAction, /いつ動かし/);
    assert.equal(readOnlyAutomationResponse.status, 200);
    assert.deepEqual(readOnlyAutomationBody.plan.openQuestions, []);
    assert.doesNotMatch(readOnlyAutomationBody.plan.title, /自の|自動化を作りたい|投稿や購入はしない/);
    assert.doesNotMatch(readOnlyAutomationBody.plan.reply, /必要な投稿・公開/);
    assert.doesNotMatch(readOnlyAutomationBody.plan.reply, /確認したいこと/);
    assert.equal(readOnlyAutomationBody.plan.visibleSteps.includes("読み取りと保存だけで安全に確認する"), true);
    assert.equal(dangerousBoundaryResponse.status, 200);
    assert.deepEqual(dangerousBoundaryBody.plan.openQuestions, []);
    assert.match(dangerousBoundaryBody.plan.reply, /送信・応募/);
    assert.match(dangerousBoundaryBody.plan.reply, /求人URL/);
    assert.doesNotMatch(dangerousBoundaryBody.plan.reply, /いつ動かし/);
    assert.equal(promptTransferFailureReasonResponse.status, 200);
    assert.match(promptTransferFailureReasonBody.plan.title, /転記.*現在状態を確認する/);
    assert.deepEqual(promptTransferFailureReasonBody.plan.openQuestions, []);
    assert.match(promptTransferFailureReasonBody.plan.reply, /GOOGLE_SERVICE_ACCOUNT_JSON|GOOGLE_APPLICATION_CREDENTIALS/);
    assert.match(promptTransferFailureReasonBody.plan.reply, /Sheets/);
    assert.match(promptTransferFailureReasonBody.plan.reply, /書き込みません/);
    assert.equal(promptTransferFailureReasonBody.plan.visibleSteps.includes("実行や投稿は開始しない"), true);
    assert.equal(serviceAccountSecretOnlyResponse.status, 200);
    assert.equal(serviceAccountSecretOnlyBody.plan.title, "認証情報だけを安全に保存する");
    assert.deepEqual(serviceAccountSecretOnlyBody.plan.openQuestions, []);
    assert.match(serviceAccountSecretOnlyBody.plan.reply, /実行を始めない/);
    assert.doesNotMatch(serviceAccountSecretOnlyBody.plan.title, /private|GOOGLE_SERVICE_ACCOUNT_JSON/);
    assert.doesNotMatch(serviceAccountSecretOnlyBody.plan.reply, /abc|private_key/);
    assert.equal(incompleteAutomationResponse.status, 200);
    assert.match(incompleteAutomationBody.plan.title, /新しい自動化を実行手順に分解する/);
    assert.doesNotMatch(incompleteAutomationBody.plan.title, /作ってを|をを/);
    assert.ok(incompleteAutomationBody.plan.openQuestions.length > 0);
    assert.match(incompleteAutomationBody.plan.reply, /対象が空なので/);
    assert.match(incompleteAutomationBody.plan.reply, /まず教えてほしいこと/);
    assert.doesNotMatch(incompleteAutomationBody.plan.reply, /いいです。これは|確認したいこと|だいぶ具体化できました/);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("Create schedule adjustment covers registered workflow, Schedule, worker pickup, and readback boundaries", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const planResponse = await postJson("/api/create/plan", {
      conversation: [
        { role: "user", content: "Daily AIを毎朝8時にして、失敗したら30分後に再確認して。" }
      ]
    });
    const planBody = JSON.parse(planResponse.body) as {
      plan: {
        title: string;
        visibleSteps: string[];
        backendChecks: string[];
        openQuestions: string[];
        executionDecision: string;
        nextAction: string;
        reply: string;
      };
    };

    assert.equal(planResponse.status, 200);
    assert.match(planBody.plan.title, /Daily AIの登録workflow/);
    assert.equal(planBody.plan.executionDecision, "ready_to_schedule");
    assert.deepEqual(planBody.plan.openQuestions, []);
    assert.equal(planBody.plan.visibleSteps.includes("実行時刻とリトライ条件を保存する"), true);
    assert.equal(planBody.plan.visibleSteps.includes("次回実行予定とRuns反映を確認する"), true);
    assert.equal(planBody.plan.backendChecks.includes("登録workflow変更はSchedule保存・次回予定・Runs反映まで確認する"), true);
    assert.equal(planBody.plan.backendChecks.includes("worker pickup待ちと再起動後readbackを分けて確認する"), true);
    assert.match(planBody.plan.nextAction, /次回予定とRuns反映/);
    assert.doesNotMatch(planBody.plan.reply, /いつ動かし|確認したいこと|実行手順に分解/);

    const scheduleResponse = await requestJson("PATCH", "/api/registered-workflows/daily-ai-research-publish-run/schedule", {
      frequency: "daily",
      time: "08:00"
    });
    const scheduleBody = JSON.parse(scheduleResponse.body) as { workflow: { id: string; schedule_label: string; next_action_label: string } };
    const scheduledWorkflow = db.querySql<{ schedule_json: string; provenance_json: string }>(
      "SELECT schedule_json, provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run' LIMIT 1;"
    )[0];
    const scheduleProvenance = JSON.parse(scheduledWorkflow.provenance_json) as {
      scheduleControl?: { scheduleOverride?: { frequency?: string; time?: string; updatedAt?: string } };
    };

    assert.equal(scheduleResponse.status, 200);
    assert.equal(scheduleBody.workflow.id, "daily-ai-research-publish-run");
    assert.equal(scheduleBody.workflow.schedule_label, "毎日 08:00");
    assert.equal(scheduledWorkflow.schedule_json.includes("BYHOUR=9"), true);
    assert.equal(scheduleProvenance.scheduleControl?.scheduleOverride?.frequency, "daily");
    assert.equal(scheduleProvenance.scheduleControl?.scheduleOverride?.time, "08:00");
    assert.equal(typeof scheduleProvenance.scheduleControl?.scheduleOverride?.updatedAt, "string");

    const startResponse = await postJson("/api/registered-workflows/daily-ai-research-publish-run/start", {});
    const startBody = JSON.parse(startResponse.body) as {
      accepted?: boolean;
      runId?: string;
      workerProtocol?: string;
      nextAction?: string;
      run: { runId: string; status: string };
      workflow: { id: string; schedule_label: string; last_run_id?: string | null; next_action_view?: string | null };
    };
    const run = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(startBody.run.runId)} LIMIT 1;`
    )[0];
    const step = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM run_steps WHERE run_id=${db.sqlValue(startBody.run.runId)} LIMIT 1;`
    )[0];
    const runMetadata = JSON.parse(run.metadata_json) as {
      registered_workflow_id?: string;
      registered_workflow_start?: { source?: string; runnerKind?: string };
      worker_protocol?: string;
      worker_mode?: string;
      worker_loop?: { status?: string; requiredCommand?: string };
      proof_gate?: unknown;
      route_decision?: { phase?: string; fingerprint?: string };
      route_decision_fingerprint?: string | null;
      route_readback?: null;
      execution_routing?: { fingerprint?: string };
    };
    const stepMetadata = JSON.parse(step.metadata_json) as {
      route_decision?: { phase?: string; fingerprint?: string };
      route_decision_fingerprint?: string | null;
      route_readback?: null;
    };
    const workerEventCount = db.querySql<{ count: number }>(
      `SELECT count(*) AS count FROM worker_events WHERE run_id=${db.sqlValue(startBody.run.runId)} AND event_type='queued_for_worker_loop';`
    )[0].count;
    const refreshReadbackResponse = await postJson("/api/registered-workflows/refresh", {});
    const refreshReadbackBody = JSON.parse(refreshReadbackResponse.body) as { workflows: Array<{ id: string; schedule_label: string; last_run_id?: string | null; next_action_view?: string | null }> };
    const dailyReadback = refreshReadbackBody.workflows.find((workflow) => workflow.id === "daily-ai-research-publish-run");
    const serializedReadback = JSON.stringify(refreshReadbackBody);

    assert.equal(startResponse.status, 202);
    assert.equal(startBody.accepted, true);
    assert.equal(startBody.runId, startBody.run.runId);
    assert.equal(startBody.run.status, "queued");
    assert.equal(run.status, "queued");
    assert.equal(startBody.workerProtocol, "local_worker_loop_required");
    assert.match(String(startBody.nextAction), /npm run worker:loop/);
    assert.equal(startBody.workflow.schedule_label, "毎日 08:00");
    assert.equal(runMetadata.registered_workflow_id, "daily-ai-research-publish-run");
    assert.deepEqual(runMetadata.registered_workflow_start, {
      source: "manual",
      runnerKind: "daily_ai_registered"
    });
    assert.equal(runMetadata.worker_protocol, "local_worker_loop_required");
    assert.equal(runMetadata.worker_mode, "queued_for_local_worker_loop");
    assert.equal(runMetadata.worker_loop?.status, "waiting_for_pickup");
    assert.equal(runMetadata.worker_loop?.requiredCommand, "npm run worker:loop");
    assert.equal(runMetadata.proof_gate, undefined);
    assert.equal(runMetadata.route_decision?.phase, "route_decision");
    assert.equal(runMetadata.route_decision_fingerprint, runMetadata.route_decision?.fingerprint);
    assert.equal(runMetadata.execution_routing?.fingerprint, runMetadata.route_decision?.fingerprint);
    assert.equal(runMetadata.route_readback, null);
    assert.equal(stepMetadata.route_decision?.phase, "route_decision");
    assert.equal(stepMetadata.route_decision_fingerprint, runMetadata.route_decision?.fingerprint);
    assert.equal(stepMetadata.route_readback, null);
    assert.equal(workerEventCount, 1);
    assert.equal(refreshReadbackResponse.status, 200);
    assert.ok(dailyReadback);
    assert.equal(dailyReadback.schedule_label, "毎日 08:00");
    assert.equal(dailyReadback.last_run_id, startBody.run.runId);
    assert.equal(dailyReadback.next_action_view, "Runs");
    assert.doesNotMatch(serializedReadback, /proof_gate|metadata_json|\/Users\/nichikatanaka|worker_loop|requiredCommand|exactBlocker/);

    const restartedReadback = JSON.parse(execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        "const { Readable } = await import('node:stream');",
        "const { app } = await import('./apps/server/dist/index.js');",
        "const result = await new Promise((resolve, reject) => {",
        "  const req = Readable.from([]);",
        "  req.method = 'GET';",
        "  req.url = '/api/registered-workflows';",
        "  req.headers = { 'content-type': 'application/json', 'content-length': '0' };",
        "  const chunks = [];",
        "  const headers = new Map();",
        "  const res = {",
        "    statusCode: 200,",
        "    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); return this; },",
        "    getHeader(name) { return headers.get(String(name).toLowerCase()); },",
        "    removeHeader(name) { headers.delete(String(name).toLowerCase()); },",
        "    end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString('utf8') }); return this; }",
        "  };",
        "  app.handle(req, res, reject);",
        "});",
        "const body = JSON.parse(result.body);",
        "const daily = body.workflows.find((workflow) => workflow.id === 'daily-ai-research-publish-run');",
        "console.log(JSON.stringify({ status: result.status, daily }));"
      ].join("\n")
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? "",
        AUTOMATION_OS_SECRET_DIR: process.env.AUTOMATION_OS_SECRET_DIR ?? ""
      },
      encoding: "utf8"
    })) as {
      status?: number;
      daily?: { schedule_label?: string; last_run_id?: string | null; next_action_view?: string | null };
    };

    assert.equal(restartedReadback.status, 200);
    assert.equal(restartedReadback.daily?.schedule_label, "毎日 08:00");
    assert.equal(restartedReadback.daily?.last_run_id, startBody.run.runId);
    assert.equal(restartedReadback.daily?.next_action_view, "Runs");

    const dueNow = new Date();
    const dueTime = "00:00";
    const createdYesterday = new Date(dueNow.getTime() - 24 * 60 * 60 * 1000).toISOString();
    await requestJson("PATCH", "/api/registered-workflows/daily-ai-research-publish-run/schedule", {
      frequency: "daily",
      time: dueTime
    });
    db.execSql(`
      UPDATE registered_workflows
      SET created_at=${db.sqlValue(createdYesterday)}
      WHERE id='daily-ai-research-publish-run';
    `);

    const schedulerResponse = await postJson("/api/registered-workflows/scheduler/run-once", {});
    const schedulerBody = JSON.parse(schedulerResponse.body) as { started: number; runIds: string[] };
    const schedulerRunRows = schedulerBody.runIds.length
      ? db.querySql<{ id: string; status: string; metadata_json: string }>(
          `SELECT id, status, metadata_json FROM runs WHERE id IN (${schedulerBody.runIds.map((runId) => db.sqlValue(runId)).join(", ")});`
        )
      : [];
    const dailySchedulerRun = schedulerRunRows.find((row) => {
      const metadata = JSON.parse(row.metadata_json) as {
        registered_workflow_id?: string;
        registered_workflow_start?: { source?: string; dueKey?: string };
        worker_loop?: { status?: string };
      };
      return metadata.registered_workflow_id === "daily-ai-research-publish-run"
        && metadata.registered_workflow_start?.source === "scheduler"
        && metadata.registered_workflow_start.dueKey?.endsWith(dueTime);
    });
    const dailySchedulerMetadata = dailySchedulerRun
      ? JSON.parse(dailySchedulerRun.metadata_json) as { worker_loop?: { status?: string }; proof_gate?: unknown }
      : undefined;

    assert.equal(schedulerResponse.status, 200);
    assert.ok(schedulerBody.started >= 1);
    assert.ok(dailySchedulerRun);
    assert.equal(dailySchedulerRun.status, "queued");
    assert.equal(dailySchedulerMetadata?.worker_loop?.status, "waiting_for_pickup");
    assert.equal(dailySchedulerMetadata?.proof_gate, undefined);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("Create planner schema allows answer-question intent for external planners", () => {
  const source = readFileSync(join(process.cwd(), "apps/server/src/planner/createPlanner.ts"), "utf8");
  const schemaSource = source.slice(source.indexOf("function plannerJsonSchema"));
  const promptSource = source.slice(source.indexOf("function plannerSystemPrompt"), source.indexOf("function plannerJsonSchema"));

  assert.match(schemaSource, /required: \["intent", "title", "reply"/);
  assert.match(schemaSource, /intent: \{ type: "string", enum: \["answer_question", "plan_workflow"\] \}/);
  assert.match(promptSource, /intentをanswer_question/);
});

test("POST /api/create/plan downgrades unsafe external planner schedule decisions", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test1234567890abcdefghijklmnopqrstuvwxyz";

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        title: "Daily AIの登録workflowの定期実行を設計する",
        reply: "保存して次回予定に反映します。",
        command: "Daily AIの定期実行を変更したい。",
        visibleSteps: ["対象workflowを読み分ける", "実行時刻とリトライ条件を保存する"],
        backendChecks: [],
        answered: [],
        openQuestions: [],
        nextAction: "変更内容を保存し、次回予定とRuns反映を確認します。",
        executionDecision: "ready_to_schedule",
        confidence: "high"
      })
    }), { status: 200, headers: { "content-type": "application/json" } });

    const response = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIの定期実行を変更したい。" }
      ]
    });
    const body = JSON.parse(response.body) as { plan: { source: string; executionDecision: string; openQuestions: string[]; nextAction: string } };

    assert.equal(response.status, 200);
    assert.equal(body.plan.source, "openai");
    assert.notEqual(body.plan.executionDecision, "ready_to_schedule");
    assert.equal(body.plan.openQuestions.includes("いつ動かし、失敗したら何分後に再確認しますか？"), true);
    assert.match(body.plan.nextAction, /実行時刻と失敗時の扱いを確認/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan preserves required schedule backend checks for external planners", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test1234567890abcdefghijklmnopqrstuvwxyz";

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        title: "Daily AIの登録workflowの定期実行を設計する",
        reply: "毎朝8時に保存して次回予定に反映します。",
        command: "Daily AIを毎朝8時にして、失敗したら30分後に再確認して。",
        visibleSteps: ["対象workflowを読み分ける", "実行時刻とリトライ条件を保存する"],
        backendChecks: ["Schedule保存を確認"],
        answered: ["毎朝8時", "失敗時は30分後に再確認"],
        openQuestions: [],
        nextAction: "変更内容を保存し、次回予定とRuns反映を確認します。",
        executionDecision: "ready_to_schedule",
        confidence: "high"
      })
    }), { status: 200, headers: { "content-type": "application/json" } });

    const response = await postJson("/api/create/plan", {
      messages: [
        { role: "user", text: "Daily AIを毎朝8時にして、失敗したら30分後に再確認して。" }
      ]
    });
    const body = JSON.parse(response.body) as { plan: { source: string; executionDecision: string; backendChecks: string[]; openQuestions: string[] } };

    assert.equal(response.status, 200);
    assert.equal(body.plan.source, "openai");
    assert.equal(body.plan.executionDecision, "ready_to_schedule");
    assert.deepEqual(body.plan.openQuestions, []);
    assert.equal(body.plan.backendChecks.includes("Schedule保存を確認"), true);
    assert.equal(body.plan.backendChecks.includes("登録workflow変更はSchedule保存・次回予定・Runs反映まで確認する"), true);
    assert.equal(body.plan.backendChecks.includes("worker pickup待ちと再起動後readbackを分けて確認する"), true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/create/plan stabilizes safety-critical external planner drift", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test1234567890abcdefghijklmnopqrstuvwxyz";

  const plannerReplies = [
    {
      intent: "answer_question",
      title: "UI改善の相談",
      reply: "相談できます。",
      command: "このチャットでできることを増やしたい。UI改善相談です。",
      visibleSteps: ["相談する"],
      backendChecks: [],
      answered: [],
      openQuestions: ["どの画面ですか？"],
      nextAction: "追加情報をください。",
      executionDecision: "ask_more",
      confidence: "medium"
    },
    {
      intent: "plan_workflow",
      title: "価格監視",
      reply: "確認したいことがあります。",
      command: "毎朝9時に公式サイトの価格を確認して、変化があったらスクショとURLを保存する自動化を作りたい。投稿や購入はしない。",
      visibleSteps: ["質問する"],
      backendChecks: [],
      answered: [],
      openQuestions: ["どこまで自動で進めますか？"],
      nextAction: "確認してください。",
      executionDecision: "ask_more",
      confidence: "medium"
    },
    {
      intent: "plan_workflow",
      title: "求人応募",
      reply: "いつ動かしますか？",
      command: "求人応募を自動化したい。応募ボタンを押す直前で止めて、URL、画面、入力内容を証跡にして。",
      visibleSteps: ["応募する"],
      backendChecks: [],
      answered: [],
      openQuestions: ["どこまで自動で進めてよく、どこで止めたいですか？"],
      nextAction: "確認してください。",
      executionDecision: "ask_more",
      confidence: "medium"
    },
    {
      intent: "plan_workflow",
      title: "保存用の実行計画を作成",
      reply: "sk-test1234567890abcdefghijklmnopqrstuvwxyz を保存して使います。",
      command: "GOOGLE_SERVICE_ACCOUNT_JSON={\"private_key\":\"abc\"} これは保存だけ。転記はまだやらないで",
      visibleSteps: ["保存して実行する"],
      backendChecks: [],
      answered: [],
      openQuestions: ["どのworkflowに使いますか？"],
      nextAction: "確認してください。",
      executionDecision: "ask_more",
      confidence: "medium"
    },
    {
      intent: "plan_workflow",
      title: "実行計画",
      reply: "実行手順に分解します。",
      command: "このチャットができることを書き出してください全て",
      visibleSteps: ["計画する"],
      backendChecks: [],
      answered: [],
      openQuestions: ["いつ動かしますか？"],
      nextAction: "確認してください。",
      executionDecision: "ask_more",
      confidence: "medium"
    },
    {
      intent: "answer_question",
      title: "Createチャットでできること",
      reply: "質問への回答です。",
      command: "今の状況としてこのチャットはどんなことまでできる？",
      visibleSteps: ["質問に答える"],
      backendChecks: [],
      answered: ["質問への回答"],
      openQuestions: [],
      nextAction: "続けてください。",
      executionDecision: "ready_to_start",
      confidence: "high"
    },
    {
      intent: "plan_workflow",
      title: "ニュース要約の定期保存",
      reply: "OpenAI plannerの具体案を残します。",
      command: "毎朝9時にhttps://example.com/newsを確認して要約をObsidianに保存する。スクショとURLを証跡にして、自動で進めてよい。失敗したら30分後に再確認する。",
      visibleSteps: ["ニュースを読む", "要約を保存する"],
      backendChecks: ["外部plannerの具体案を保持"],
      answered: ["毎朝9時", "Obsidian保存"],
      openQuestions: [],
      nextAction: "保存して実演します。",
      executionDecision: "ready_to_schedule",
      confidence: "high"
    },
    {
      intent: "answer_question",
      title: "新しい自動化の作成を開始する案内",
      reply: "新しい自動化を作れます。まず対象を教えてください。",
      command: "新しい自動化を作って",
      visibleSteps: ["質問する"],
      backendChecks: [],
      answered: [],
      openQuestions: ["何を自動化しますか？"],
      nextAction: "対象を教えてください。",
      executionDecision: "ask_more",
      confidence: "medium"
    }
  ];
  let replyIndex = 0;

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      output_text: JSON.stringify(plannerReplies[replyIndex++])
    }), { status: 200, headers: { "content-type": "application/json" } });

    const uiResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "このチャットでできることを増やしたい。UI改善相談です。" }]
    });
    const readOnlyResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "毎朝9時に公式サイトの価格を確認して、変化があったらスクショとURLを保存する自動化を作りたい。投稿や購入はしない。" }]
    });
    const boundaryResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "求人応募を自動化したい。応募ボタンを押す直前で止めて、URL、画面、入力内容を証跡にして。" }]
    });
    const secretResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "GOOGLE_SERVICE_ACCOUNT_JSON={\"private_key\":\"abc\"} これは保存だけ。転記はまだやらないで" }]
    });
    const capabilityResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "このチャットができることを書き出してください全て" }]
    });
    const capabilityQuestionOnlyResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "今の状況としてこのチャットはどんなことまでできる？" }]
    });
    const ordinaryReadSaveResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "毎朝9時にhttps://example.com/newsを確認して要約をObsidianに保存する。スクショとURLを証跡にして、自動で進めてよい。失敗したら30分後に再確認する。" }]
    });
    const incompleteAutomationResponse = await postJson("/api/create/plan", {
      messages: [{ role: "user", text: "新しい自動化を作って" }]
    });

    const uiBody = JSON.parse(uiResponse.body) as { plan: { source: string; intent?: string; title: string; openQuestions: string[] } };
    const readOnlyBody = JSON.parse(readOnlyResponse.body) as { plan: { openQuestions: string[]; visibleSteps: string[] } };
    const boundaryBody = JSON.parse(boundaryResponse.body) as { plan: { openQuestions: string[]; visibleSteps: string[]; reply: string } };
    const secretBody = JSON.parse(secretResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };
    const capabilityBody = JSON.parse(capabilityResponse.body) as { plan: { intent?: string; title: string; reply: string; openQuestions: string[] } };
    const capabilityQuestionOnlyBody = JSON.parse(capabilityQuestionOnlyResponse.body) as { plan: { intent?: string; title: string; reply: string; openQuestions: string[] } };
    const ordinaryReadSaveBody = JSON.parse(ordinaryReadSaveResponse.body) as { plan: { title: string; reply: string; openQuestions: string[]; visibleSteps: string[] } };
    const incompleteAutomationBody = JSON.parse(incompleteAutomationResponse.body) as { plan: { intent?: string; title: string; reply: string; openQuestions: string[] } };

    assert.equal(uiBody.plan.source, "openai");
    assert.equal(uiBody.plan.intent, "plan_workflow");
    assert.equal(uiBody.plan.title, "Createチャットと画面表示を改善する");
    assert.deepEqual(uiBody.plan.openQuestions, []);
    assert.deepEqual(readOnlyBody.plan.openQuestions, []);
    assert.equal(readOnlyBody.plan.visibleSteps.includes("読み取りと保存だけで安全に確認する"), true);
    assert.deepEqual(boundaryBody.plan.openQuestions, []);
    assert.equal(boundaryBody.plan.visibleSteps.includes("応募・送信確定前に会社名、求人URL、入力内容、確認画面を証跡化して止める"), true);
    assert.match(boundaryBody.plan.reply, /求人URL/);
    assert.equal(secretBody.plan.title, "認証情報だけを安全に保存する");
    assert.deepEqual(secretBody.plan.openQuestions, []);
    assert.equal(secretBody.plan.visibleSteps.includes("自動実行は開始しない"), true);
    assert.doesNotMatch(secretBody.plan.reply, /sk-test1234567890|private_key|abc/);
    assert.equal(capabilityBody.plan.intent, "answer_question");
    assert.equal(capabilityBody.plan.title, "Createチャットでできること");
    assert.deepEqual(capabilityBody.plan.openQuestions, []);
    assert.match(capabilityBody.plan.reply, /質問への回答、登録済み自動化の確認、計画作成/);
    assert.doesNotMatch(capabilityBody.plan.reply, /いつ動かし|確認したいこと|実行手順に分解/);
    assert.equal(capabilityQuestionOnlyBody.plan.intent, "answer_question");
    assert.equal(capabilityQuestionOnlyBody.plan.title, "Createチャットでできること");
    assert.deepEqual(capabilityQuestionOnlyBody.plan.openQuestions, []);
    assert.match(capabilityQuestionOnlyBody.plan.reply, /質問への回答/);
    assert.doesNotMatch(capabilityQuestionOnlyBody.plan.reply, /いつ動かし|確認したいこと|実行手順に分解/);
    assert.equal(ordinaryReadSaveBody.plan.title, "ニュース要約の定期保存");
    assert.match(ordinaryReadSaveBody.plan.reply, /OpenAI plannerの具体案を残します/);
    assert.deepEqual(ordinaryReadSaveBody.plan.openQuestions, []);
    assert.deepEqual(ordinaryReadSaveBody.plan.visibleSteps, ["ニュースを読む", "要約を保存する"]);
    assert.equal(incompleteAutomationBody.plan.intent, "plan_workflow");
    assert.match(incompleteAutomationBody.plan.title, /新しい自動化を実行手順に分解する/);
    assert.ok(incompleteAutomationBody.plan.openQuestions.length > 0);
    assert.match(incompleteAutomationBody.plan.reply, /対象が空なので/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("POST /api/capability-router/plan returns a route snapshot and bypasses write lock", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  delete process.env.AUTOMATION_OS_WRITE_TOKEN;

  try {
    const response = await postJson("/api/capability-router/plan", { command: "Daily AIの画像生成を確認" });
    const body = JSON.parse(response.body) as { command?: string; recommendedRoutes?: unknown[]; counts?: Record<string, unknown> };
    const runs = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;

    assert.equal(response.status, 200);
    assert.equal(body.command, "Daily AIの画像生成を確認");
    assert.equal(Array.isArray(body.recommendedRoutes), true);
    assert.equal(typeof body.counts, "object");
    assert.equal(runs, 0);
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("GET /api/capability-router/backlog and POST /api/codex/capabilities/probe stay read-only", async () => {
  db.initDb();
  db.resetDemoData();

  const beforeRuns = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;
  const beforeApprovals = db.querySql<{ count: number }>("SELECT count(*) AS count FROM approvals")[0].count;
  const beforeBridgeActions = db.querySql<{ count: number }>("SELECT count(*) AS count FROM bridge_actions")[0].count;

  const backlogResponse = await requestJson("GET", "/api/capability-router/backlog");
  const probeResponse = await postJson("/api/codex/capabilities/probe", {});
  const backlogBody = JSON.parse(backlogResponse.body) as { counts?: Record<string, unknown> };
  const probeBody = JSON.parse(probeResponse.body) as { probe: { cached: boolean; ok: boolean; exactBlocker: string | null } };

  const afterRuns = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;
  const afterApprovals = db.querySql<{ count: number }>("SELECT count(*) AS count FROM approvals")[0].count;
  const afterBridgeActions = db.querySql<{ count: number }>("SELECT count(*) AS count FROM bridge_actions")[0].count;

  assert.equal(backlogResponse.status, 200);
  assert.equal(typeof backlogBody.counts, "object");
  assert.equal(probeResponse.status, 200);
  assert.equal(typeof probeBody.probe.ok, "boolean");
  assert.equal(typeof probeBody.probe.cached, "boolean");
  assert.equal(beforeRuns, afterRuns);
  assert.equal(beforeApprovals, afterApprovals);
  assert.equal(beforeBridgeActions, afterBridgeActions);
});

test("POST /api/secrets/from-message returns immediately for non-secret chat text", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM stored_secrets");

  const response = await postJson("/api/secrets/from-message", { text: "NisenPrintsの定期実行を設計したい" });
  const body = JSON.parse(response.body) as { sanitizedText?: string; stored?: unknown[] };
  const secretsCount = db.querySql<{ count: number }>("SELECT count(*) AS count FROM stored_secrets")[0].count;

  assert.equal(response.status, 200);
  assert.equal(body.sanitizedText, "NisenPrintsの定期実行を設計したい");
  assert.deepEqual(body.stored, []);
  assert.equal(secretsCount, 0);
});

test("POST /api/runs/start stores secret-only commands without starting a run", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM stored_secrets");
  const token = "sk-startSecretOnly1234567890abcdefghijklmnopqrstuvwxyz";

  const response = await postJson("/api/runs/start", { command: `OpenAI APIキーは ${token} です。保存だけ` });
  const body = JSON.parse(response.body) as {
    status?: string;
    exactBlocker?: string;
    sanitizedText?: string;
    stored?: Array<{ kind: string; state?: string; availableToRunner?: boolean }>;
  };
  const runsCount = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;

  assert.equal(response.status, 200);
  assert.equal(body.status, "stored");
  assert.equal(body.exactBlocker, "secret_stored_run_not_started");
  assert.equal(body.stored?.[0]?.kind, "openai");
  assert.equal(body.stored?.[0]?.state, "stored");
  assert.equal(body.stored?.[0]?.availableToRunner, true);
  assert.match(body.sanitizedText ?? "", /\[保存済み: OpenAI APIキー\]/);
  assert.doesNotMatch(JSON.stringify(body), /startSecretOnly/);
  assert.equal(runsCount, 0);
});

test("POST /api/create/plan turns run outcomes into a continuation plan", async () => {
  db.initDb();
  db.resetDemoData();
  const previousPlannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
  process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = "local";

  try {
    const response = await postJson("/api/create/plan", {
      messages: [
        {
          role: "user",
          text: [
            "履歴からの続き相談です。",
            "対象: Daily AI",
            "状態: partial",
            "結論: 一部だけ確認できています。完了には不足分があります。",
            "止まった理由: 画面で見える確認記録がまだ不足しています。",
            "不足している確認: 画面で見える確認記録",
            "実行タイミング: 手動開始で小さく再確認します。",
            "自動で進める範囲: このrunと同じ範囲で、課金・購入・支払い・決済だけ停止します。",
            "正本: 履歴、保存記録、画面で見える確認結果を使います。",
            "完了証拠: 不足している確認を新しい保存記録として残します。"
          ].join("\n")
        }
      ]
    });
    const body = JSON.parse(response.body) as { ok: boolean; plan: { title: string; command: string; reply: string; visibleSteps: string[]; nextAction: string; executionDecision: string; openQuestions: string[] } };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.plan.title, "止まった実行を次の一手へ戻す");
    assert.equal(body.plan.command, "Daily AIの不足している確認を見直して再実行");
    assert.equal(body.plan.visibleSteps.includes("止まった履歴と保存記録を読む"), true);
    assert.match(body.plan.reply, /止まった履歴と保存記録を読む → 不足している確認を1つに絞る/);
    assert.match(body.plan.nextAction, /不足している確認/);
    assert.equal(body.plan.executionDecision, "demo_first");
    assert.deepEqual(body.plan.openQuestions, []);
  } finally {
    if (previousPlannerProvider === undefined) delete process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER;
    else process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER = previousPlannerProvider;
  }
});

test("PATCH /api/create/session persists sanitized conversation state without starting a run", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  delete process.env.AUTOMATION_OS_WRITE_TOKEN;

  try {
    const rawSecret = "sk-createSession1234567890abcdefghijklmnopqrstuvwxyz";
    const response = await requestJson("PATCH", "/api/create/session", {
      messages: [
        { role: "user", text: `Daily AIを毎朝確認したい token=${rawSecret}` },
        { role: "assistant", text: "正本と証跡を確認します。" }
      ],
      draft: {
        title: "Daily AI確認",
        command: `Daily AIを確認 token=${rawSecret}`,
        reply: `秘密は保存しません ${rawSecret}`,
        visibleSteps: ["DBを読む", `token=${rawSecret}`],
        backendChecks: ["run/job/proofを確認"],
        answered: ["実行タイミング"],
        openQuestions: ["失敗時の通知先"],
        nextAction: `次は保存 ${rawSecret}`,
        executionDecision: "demo_first",
        confidence: "medium",
        plannerSource: "local_fallback",
        plannerModel: "local",
        plannerBlocker: `none ${rawSecret}`
      },
      researchSources: { web: true, localDb: true },
      command: `Daily AIを確認 token=${rawSecret}`
    });
    const body = JSON.parse(response.body) as { ok: boolean; session: { messages: Array<{ text: string }>; draft: Record<string, unknown>; command: string } };
    const stored = await requestJson("GET", "/api/create/session");
    const storedBody = JSON.parse(stored.body) as { ok: boolean; session: { messages: Array<{ text: string }>; draft: Record<string, unknown>; command: string } };
    const runs = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;
    const persistedText = JSON.stringify({ response: body, stored: storedBody });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(stored.status, 200);
    assert.equal(storedBody.ok, true);
    assert.equal(runs, 0);
    assert.equal(persistedText.includes(rawSecret), false);
    assert.match(persistedText, /\[redacted-token\]/);
    assert.equal(storedBody.session.draft.title, "Daily AI確認");
    assert.equal(storedBody.session.draft.executionDecision, "demo_first");
    assert.equal(storedBody.session.messages.length, 2);
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

test("POST /api/runs/start stores sanitized Create session context before any worker pickup", async () => {
  db.initDb();
  db.resetDemoData();
  const rawSecret = "sk-createRun1234567890abcdefghijklmnopqrstuvwxyz";

  const response = await postJson("/api/runs/start", {
    command: "checkout payment approval smoke for saved Create session",
    createSession: {
      messages: [
        { role: "user", text: `API課金を増やさず実行したい token=${rawSecret}` },
        { role: "assistant", text: "Mac workerが拾えるrunを作ります。" }
      ],
      draft: {
        title: "ローカルCodex worker連携",
        command: `保存済み相談からworker jobを作る token=${rawSecret}`,
        reply: "run metadataへ会話を残します。",
        visibleSteps: ["保存済み相談を読む", "runを作る", "Mac workerが拾う"],
        backendChecks: ["create_session_snapshot", "worker_queue"],
        answered: ["実行エンジン"],
        openQuestions: [],
        nextAction: "履歴でrunを確認する",
        executionDecision: "ready_to_start",
        confidence: "high",
        plannerSource: "local_fallback"
      },
      researchSources: { web: false, localDb: true },
      command: `保存済み相談からworker jobを作る token=${rawSecret}`
    }
  });
  const body = JSON.parse(response.body) as { runId: string; workerProtocol?: string; nextAction?: string; run: { status: string } };
  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(body.runId)} LIMIT 1`)[0];
  const step = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM run_steps WHERE run_id=${db.sqlValue(body.runId)} LIMIT 1`)[0];
  const metadataText = run.metadata_json;
  const metadata = JSON.parse(metadataText) as {
    create_session_source?: string;
    create_session_title?: string;
    create_session_execution_decision?: string;
    create_session_snapshot?: { messages: Array<{ text: string }>; draft: { command: string; visibleSteps: string[] } };
    worker_protocol?: string;
    worker_loop?: { requiredCommand?: string };
    route_decision?: { phase?: string; fingerprint?: string };
    route_decision_fingerprint?: string | null;
    route_readback?: null;
    execution_routing?: { fingerprint?: string };
  };
  const stepMetadata = JSON.parse(step.metadata_json) as {
    route_decision?: { phase?: string; fingerprint?: string };
    route_decision_fingerprint?: string | null;
    route_readback?: null;
  };

  assert.equal(response.status, 202);
  assert.equal(body.run.status, "waiting_approval");
  assert.equal(body.workerProtocol, undefined);
  assert.match(String(body.nextAction), /承認画面/);
  assert.equal(metadata.create_session_source, "create_view");
  assert.equal(metadata.create_session_title, "ローカルCodex worker連携");
  assert.equal(metadata.create_session_execution_decision, "ready_to_start");
  assert.equal(metadata.create_session_snapshot?.messages.length, 2);
  assert.deepEqual(metadata.create_session_snapshot?.draft.visibleSteps, ["保存済み相談を読む", "runを作る", "Mac workerが拾う"]);
  assert.equal(metadata.worker_protocol, undefined);
  assert.equal(metadata.worker_loop, undefined);
  assert.equal(metadata.route_decision?.phase, "route_decision");
  assert.equal(metadata.route_decision_fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(metadata.execution_routing?.fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(metadata.route_readback, null);
  assert.equal(stepMetadata.route_decision?.phase, "route_decision");
  assert.equal(stepMetadata.route_decision_fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(stepMetadata.route_readback, null);
  assert.equal(metadataText.includes(rawSecret), false);
  assert.match(metadataText, /\[redacted-token\]/);
});

test("Create planner jobs queue work for Mac worker and store Codex planner results", async () => {
  db.initDb();
  db.resetDemoData();
  const fakeCodex = join(tempRoot, "fake-codex-planner.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({
  intent: "plan_workflow",
  title: "Mac workerで作った計画",
  reply: "Mac workerのCodexで相談を整理しました。",
  command: "Daily AIを毎朝9時に確認し、失敗時は30分後に再確認する",
  visibleSteps: ["正本を読む", "手動実演する", "定期化する"],
  backendChecks: ["worker_job_readback", "create_plan_result_saved"],
  answered: ["実行タイミング", "失敗時の扱い"],
  openQuestions: [],
  nextAction: "保存して実演します。",
  executionDecision: "demo_first",
  confidence: "high"
}));
`);
  chmodSync(fakeCodex, 0o755);
  const previousBin = process.env.AUTOMATION_OS_CODEX_PLANNER_BIN;
  process.env.AUTOMATION_OS_CODEX_PLANNER_BIN = fakeCodex;

  try {
    const queuedResponse = await postJson("/api/create/plan/jobs", {
      messages: [
        { role: "user", text: "Daily AIを毎朝9時に確認して、失敗したら30分後に再確認する計画を詳しく作って。" }
      ],
      currentDraft: "Daily AI"
    });
    const queuedBody = JSON.parse(queuedResponse.body) as {
      job: { id: string; status: string; exactBlocker?: string };
      plan: { exactBlocker?: string; title: string };
    };
    assert.equal(queuedResponse.status, 200);
    assert.equal(queuedBody.job.status, "queued");
    assert.equal(queuedBody.plan.exactBlocker, "mac_worker_planner_queued");

    const { processQueuedCreatePlannerJobs } = await import("../planner/createPlannerJobs.js");
    const processed = await processQueuedCreatePlannerJobs(1);
    assert.equal(processed.length, 1);
    assert.equal(processed[0].status, "completed");
    assert.equal(processed[0].result?.source, "local_codex");
    assert.equal(processed[0].result?.title, "Mac workerで作った計画");

    const readback = await requestJson("GET", `/api/create/plan/jobs/${queuedBody.job.id}`);
    const readbackBody = JSON.parse(readback.body) as {
      job: { id: string; status: string; result: { title: string; source: string } };
      plan: { title: string; source: string };
    };
    assert.equal(readback.status, 200);
    assert.equal(readbackBody.job.status, "completed");
    assert.equal(readbackBody.job.result.source, "local_codex");
    assert.equal(readbackBody.plan.title, "Mac workerで作った計画");
  } finally {
    if (previousBin === undefined) delete process.env.AUTOMATION_OS_CODEX_PLANNER_BIN;
    else process.env.AUTOMATION_OS_CODEX_PLANNER_BIN = previousBin;
  }
});

test("Create planner jobs bypass production write guard because they only queue Mac worker planning", async () => {
  db.initDb();
  db.resetDemoData();
  const previousRequire = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "test-write-token";

  try {
    const queuedResponse = await postJson("/api/create/plan/jobs", {
      messages: [
        { role: "user", text: "OpenAI APIなしでMac workerに詳しいCreate計画を作らせたい" }
      ],
      currentDraft: "OpenAI APIなし"
    });
    const guardedResponse = await postJson("/api/runs/start", { command: "safe local smoke" });
    const queuedBody = JSON.parse(queuedResponse.body) as {
      job: { status: string };
      plan: { exactBlocker?: string };
    };
    const guardedBody = JSON.parse(guardedResponse.body) as { error: string };

    assert.equal(queuedResponse.status, 200);
    assert.equal(queuedBody.job.status, "queued");
    assert.equal(queuedBody.plan.exactBlocker, "mac_worker_planner_queued");
    assert.equal(guardedResponse.status, 401);
    assert.equal(guardedBody.error, "production_write_token_required");
  } finally {
    if (previousRequire === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequire;
    if (previousToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousToken;
  }
});

function postJson(path: string, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return requestJson("POST", path, payload, extraHeaders);
}

function requestJson(method: string, path: string, payload: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = method === "GET" ? "" : JSON.stringify(payload);
    const req = Readable.from(body ? [Buffer.from(body)] : []) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...extraHeaders
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
