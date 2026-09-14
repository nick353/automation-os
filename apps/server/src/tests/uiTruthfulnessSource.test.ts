import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("Chat input reset preserves conversation and separate conversation entry only focuses naming", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const reset = source.slice(source.indexOf("  const resetChat = () => {"), source.indexOf("  const beginSeparateConversation = () => {"));
  const setters = [...new Set(reset.match(/\bset[A-Z]\w+(?=\()/g) ?? [])];
  const values: Record<string, unknown> = {};
  let focused = 0;
  const refs = { plannerAbortRef: { current: null }, activePlannerJobRef: { current: "" }, plannerRequestGeneration: { current: 3 }, submittedPromptRef: { current: "old" }, createIdempotencyRef: { current: "old-key" }, promptRef: { current: { focus() { focused++; } } } };
  const run = new Function("planning", "creating", ...Object.keys(refs), "actionStamp", ...setters, reset + "; resetChat();");
  const call = (busy: boolean) => run(busy, false, ...Object.values(refs), () => "fixture-time", ...setters.map(key => (value: unknown) => { values[key] = value; }));
  call(true);
  assert.deepEqual(values, {});
  call(false);
  assert.equal(values.setPrompt, "");
  assert.equal(values.setPlanVisible, false);
  assert.equal(focused, 1);
  for (const name of ["setChatThreadId", "setChatSessionId", "setMessages"]) assert.equal(name in values, false);
  assert.match(String(values.setReceipt), /保存済み履歴は保持/);
  assert.doesNotMatch(reset, /clearChatThread|requestChatPlan|createChatSession/);
  const separate = source.slice(source.indexOf("  const beginSeparateConversation = () => {"), source.indexOf("  React.useEffect(() => {", source.indexOf("  const beginSeparateConversation = () => {")));
  assert.match(separate, /newChatSessionNameRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(separate, /setChatSessionId|setChatThreadId|setMessages|createChatSession|resetChat\(/);
  assert.match(source, /controlId="chat.reset"[^\n]*onClick=\{beginSeparateConversation\}/);
  assert.match(source, /controlId="chat.reset-input"[^\n]*onClick=\{resetChat\}/);
});

test("Admin membership pending is shown before access denial", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const pending = source.indexOf('scopeLabel="Admin membership"');
  const denial = source.indexOf('if (!hasOwnerAdminAccess(model.mvpState))');
  assert.ok(pending > 0 && denial > pending);
  const guard = source.slice(source.lastIndexOf("\n", pending) + 1, pending);
  assert.match(guard, /model.mvpLoadStatus === "loading"/);
  assert.match(guard, /model.mvpLoadStatus === "degraded" && model.mvpLoadBlocker === "mvp_state_detail_readback_pending"/);
  assert.match(guard, /ProjectUnavailablePage loading/);
  assert.match(source.slice(denial, denial + 220), /Owner membershipだけが閲覧できます/);
});

test("production unknown metrics override approval labels without changing other metrics", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const metric = source.slice(source.indexOf("function MetricCard("), source.indexOf("function MetricCard(") + 600);
  assert.match(metric, /statusLabel\?: string/);
  assert.match(metric, /StatusBadge status=\{status\} label=\{statusLabel\}/);
  const card = (id: string) => source.split("\n").find((line) => line.includes(`controlId="truthful.production.metric.${id}"`)) ?? "";
  assert.match(card("persistence"), /statusLabel=.*readStatus === "loading" \? "確認中" : "未確認"/);
  assert.match(card("chrome"), /statusLabel=\{chromeUnobserved \? "未観測" : undefined\}/);
  assert.match(card("goal"), /statusLabel=.*"完了確認済み".*"未完了".*"未確認"/);
});

test("Feedback waits for authenticated state and retries on route readiness; PC labels cross-company records", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const marker = source.indexOf('    mvpFetch("/api/mvp/feedback", { cache: "no-store" })');
  const start = source.lastIndexOf("  React.useEffect(() => {", marker);
  const end = source.indexOf("  const page = useMemo", marker);
  const effect = source.slice(start, end);
  assert.match(effect, /\[mvpLoadStatus, route\]/);
  for (const mvpLoadStatus of ["loading", "ready"]) {
    const statuses: string[] = []; let calls = 0; let rows: any;
    runInNewContext(transpileModule(effect, {}).outputText, {
      React: { useEffect: (fn: () => unknown) => fn() }, mvpLoadStatus, route: "#/admin",
      setFeedbackReadStatus: (s: string) => statuses.push(s), setFeedbackReadback: (r: any) => { rows = r; }, setReceipt: () => {},
      mvpFetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({ ok: true, feedbacks: [{ id: "same-saved-id", status: "open" }] }) }; }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, mvpLoadStatus === "ready" ? 1 : 0);
    if (mvpLoadStatus === "ready") { assert.deepEqual(statuses, ["loading", "ready"]); assert.equal(rows[0].id, "same-saved-id"); }
  }
  const queue = source.slice(source.indexOf("function FeedbackFixQueue("), source.indexOf("function WebOperationAdmissionPanel("));
  assert.match(queue, /const feedback = readStatus === "ready" \? feedbackItemsFromState/);
  assert.match(queue, /: \[\]/);
  assert.match(queue, /readStatus !== "ready" \? <ReadbackState/);
  assert.match(queue, /未取得や認証失敗を未処理0件とは扱いません/);
  const pc = source.slice(source.indexOf("function PcStatusPage("), source.indexOf("function TemplatesPage("));
  assert.match(pc, /記録上の処理中・待機中Run（現行queueとは別）/);
  assert.match(pc, /run\.company_id \?\? run\.project_id/);
  assert.match(pc, /上のQueue件数はdurable Jobの別集計/);
});

test("Production and Admin preserve observation scope and pending state", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const production = source.slice(source.indexOf("function TruthfulProductionStatusPage("), source.indexOf("function AdminPage("));
  const expression = source.match(/  const chromeUnobserved = ([^;]+);/)![1];
  const unobserved = (chromeExtension: any) => runInNewContext(transpileModule(expression, {}).outputText, { browser: { chromeExtension } });
  assert.equal(unobserved(undefined), true);
  assert.equal(unobserved({ status: "blocked", readback: { capturedAt: null } }), true);
  assert.equal(unobserved({ status: "blocked", readback: { capturedAt: "2026-09-06T12:00:00Z" } }), false);
  assert.equal(unobserved({ status: "ready" }), false);
  assert.equal(unobserved({ status: "blocked", targetScopedAvailable: true }), false);
  assert.match(production, /title="公式Chrome \/ APIホスト観測"/);
  assert.match(production, /readStatus === "loading" \? <ReadbackState title="Production readinessを確認中"/);
  assert.match(production, /tone="info"/);
  assert.match(production, /title="Production readinessを確認できません"/);
  const adminStart = source.indexOf("  const runtime = backendSetting?.setting?.backend");
  assert.ok(adminStart > 0);
  const adminRuntime = source.slice(adminStart, source.indexOf(";", adminStart) + 1);
  for (const backend of ["aos_chrome_companion", "chrome_plugin", "playwright", undefined, "browser_use_cli"]) {
    const runtime = runInNewContext(transpileModule(adminRuntime + "\nruntime;", {}).outputText, {
      backendSetting: { setting: { backend } }, model: { mvpState: { browser_use_runtime: { status: "blocked", exactBlocker: "browser_use_only" } } }
    });
    assert.equal(runtime?.exactBlocker, backend === "browser_use_cli" ? "browser_use_only" : undefined);
  }
  assert.match(source, /label: "PCとWorkerの観測を開く"/);
});

test("Feedback capture scales the full scrolled viewport and bounds image loading", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("async function captureAppScreenshot():"), source.indexOf("async function captureAppScreenshotWithTimeout("))
    .replace('(await import("html2canvas")).default', "renderer");
  let options: any;
  const capture = runInNewContext(transpileModule(fragment + "\ncaptureAppScreenshot;", {}).outputText, {
    window: { innerWidth: 1920, innerHeight: 910, scrollX: 0, scrollY: 711 }, document: { body: {} },
    renderer: async (_element: any, value: any) => { options = value; return { toDataURL: () => "data:image/jpeg;base64,fixture" }; }
  });
  assert.equal((await capture()).error, null);
  assert.equal(options.width, 1920);
  assert.equal(options.height, 910);
  assert.equal(options.width * options.scale, 1200);
  assert.equal(options.y, 711);
  assert.equal(options.scrollY, 711);
  assert.equal(options.imageTimeout, 2500);
  assert.equal(options.ignoreElements({ classList: { contains: (name: string) => name === "feedback-panel" } }), true);
  const failedCapture = runInNewContext(transpileModule(fragment + "\ncaptureAppScreenshot;", {}).outputText, {
    window: { innerWidth: 1920, innerHeight: 910, scrollX: 0, scrollY: 711 }, document: { body: {} },
    renderer: async () => { throw new Error("renderer_unavailable"); }
  });
  const failed = await failedCapture();
  assert.equal(failed.dataUrl, null);
  assert.equal(failed.error, "feedback_screenshot_render_failed");
});

test("Feedback capture deadline is cleared on success and timeout without discarding a slow success", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("async function captureAppScreenshotWithTimeout("), source.indexOf("function approvalDueLabel("));
  for (const timeout of [false, true]) {
    let callback: (() => void) | undefined;
    let resolveCapture: ((value: any) => void) | undefined;
    let deadline = 0;
    const cleared: number[] = [];
    const capture = runInNewContext(transpileModule(fragment + "\ncaptureAppScreenshotWithTimeout;", {}).outputText, {
      captureAppScreenshot: () => new Promise((resolve) => { resolveCapture = resolve; }),
      window: { setTimeout: (fn: () => void, ms: number) => { callback = fn; deadline = ms; return 7; }, clearTimeout: (id: number) => cleared.push(id) }
    });
    const result = capture();
    assert.equal(deadline, 15000);
    if (timeout) callback!(); else resolveCapture!({ dataUrl: "image", error: null });
    const value = await result;
    assert.equal(value.error, timeout ? "feedback_screenshot_timeout" : null);
    assert.deepEqual(cleared, [7]);
  }
});

test("Feedback keeps long routes inside its panel without shrinking the close button", () => {
  const css = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  assert.match(css, /\.feedback-panel\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*overflow-wrap: anywhere;/u);
  assert.match(css, /\.feedback-panel > \*\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;/u);
  assert.match(css, /\.feedback-panel-head > div\s*\{[^}]*min-width: 0;/u);
  assert.match(css, /\.feedback-panel-head > button\s*\{[^}]*flex: 0 0 auto;/u);
});

test("Chat hides only duplicate generic intake questions after exact fixed-runner readback", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helper = source.slice(source.indexOf("function fixedChatWorkflowConfirmed("), source.indexOf("function ChatWorkflowActionsPanel("));
  const confirmed = runInNewContext(transpileModule(helper + "\nfixedChatWorkflowConfirmed;", {}).outputText, {});
  const option = { can_run_once: true };
  const value = { schema: "aos.chat_workflow_options.v1", company_id: "own", job_id: "job", exact_blocker: null, options: [option], actions: [] };
  assert.equal(confirmed(value, "own", "job"), true);
  for (const changed of [null, { ...value, company_id: "other" }, { ...value, job_id: "old" }, { ...value, options: [option, option] },
    { ...value, options: [] }, { ...value, exact_blocker: "not_supported" }, { ...value, options: [{ can_run_once: false }] }]) assert.equal(confirmed(changed, "own", "job"), false);
  const start = source.indexOf("  const visiblePlanQuestions =");
  const fragment = source.slice(start, source.indexOf(";", start) + 1);
  const filter = (fixedWorkflowConfirmed: boolean) => runInNewContext(transpileModule(fragment + "\nvisiblePlanQuestions;", {}).outputText, {
    fixedWorkflowConfirmed, plan: { questions: ["操作するサイト名またはURLを指定してください。", "この送信内容を承認しますか？", "対象の自動化を選んでください。"] },
    plannerReadback: { web_operation_intake: { questions: ["操作するサイト名またはURLを指定してください。"] } }
  });
  assert.deepEqual(Array.from(filter(true)), ["この送信内容を承認しますか？", "対象の自動化を選んでください。"]);
  assert.equal(filter(false).length, 3);
  assert.match(source, /visiblePlanQuestions\.length > 0/);
  assert.match(source, /onReadback\?\.\(null\)/);
});

test("Feedback lost responses are single-flight and survive dialog reopening through exact GET-only recovery", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helpers = source.slice(source.indexOf("type PendingFeedback ="), source.indexOf("function FeedbackWidget("));
  const pending = { id: "feedback_ui_00000000-0000-4000-8000-000000000001", companyId: "own" };
  let responseBody: any = { ok: true, company_scope: { enforced: true, company_ids: ["own"] }, feedbacks: [{ id: pending.id, feedback_id: pending.id, company_id: "own" }] };
  const gets: any[] = [];
  const read = runInNewContext(transpileModule(helpers + "\n({readPendingFeedback, requestSavedFeedback});", {}).outputText, {
    window: { sessionStorage: { getItem: () => JSON.stringify(pending) } },
    mvpFetch: async (url: string, init: any) => { gets.push({ url, init }); return { ok: true, json: async () => responseBody }; }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(read.readPendingFeedback())), pending);
  assert.equal((await read.requestSavedFeedback(pending)).id, pending.id);
  responseBody = { ...responseBody, feedbacks: [] };
  await assert.rejects(read.requestSavedFeedback(pending), /unconfirmed/);
  responseBody = { ...responseBody, feedbacks: [{ id: pending.id, feedback_id: pending.id, company_id: "foreign" }] };
  await assert.rejects(read.requestSavedFeedback(pending), /scope_mismatch/);
  assert.ok(gets.every((call) => !call.init.method && call.init.cache === "no-store" && call.url.includes(`feedback_id=${pending.id}`)));
  const widget = source.slice(source.indexOf("function FeedbackWidget("), source.indexOf("function FeedbackWidget(") + 18000);
  const fragment = widget.slice(widget.indexOf("  const confirmSaved ="), widget.indexOf("  return (\n"));
  const calls: string[] = [];
  const savedRows: any[] = [];
  const context: any = { submitRef: { current: false }, pendingFeedbackRef: { current: null }, readOnlyEvidenceMode: false,
    comment: "Test", sensitiveConfirmed: true, screenshot: null, capture: {}, feedbackContext: null, route: "#/", location: { href: "fixture" }, document: { title: "Test" },
    rememberedProject: () => "own", newIdempotencyKey: () => pending.id, redactSensitiveText: (v: string) => v,
    rememberPending: (v: any) => { context.pendingFeedbackRef.current = v; }, setBusy: () => {}, setReceipt: () => {}, setMvpState: () => {}, close: () => {},
    onSaved: (row: any) => savedRows.push(row),
    requestSavedFeedback: async (v: any) => { assert.equal(v.companyId, "own"); calls.push("GET"); return { id: v.id, company_id: v.companyId }; },
    mvpFetch: async () => { calls.push("POST"); throw new Error("lost_response"); } };
  const actions = runInNewContext(transpileModule(fragment + "\n({submit,reconcile});", {}).outputText, context);
  await Promise.all([actions.submit(), actions.submit()]);
  assert.deepEqual(calls, ["POST"]);
  assert.equal(context.pendingFeedbackRef.current.id, pending.id);
  await actions.submit();
  assert.deepEqual(calls, ["POST"]);
  await actions.reconcile();
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.equal(savedRows.length, 1);
  assert.equal(context.pendingFeedbackRef.current, null);
  const close = widget.slice(widget.indexOf("  const close ="), widget.indexOf("  const skipScreenshot ="));
  assert.doesNotMatch(close, /rememberPending|pendingFeedback/);
});

test("production readback is authorized, read-only, scoped and leaves business acceptance unknown", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const server = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const route = server.slice(server.indexOf('app.get("/api/v1/companies/:companyId/production/readback"'), server.indexOf('app.get("/api/v1/admin/diagnostics"'));
  let handler: any;
  let allowed = true;
  let snapshotReads = 0;
  const context = { app: { get: (_path: string, callback: any) => { handler = callback; } }, dbBackend: "postgres",
    requireCompanyAccessAsync: async (id: string, roles: string[]) => { assert.equal(id, "own"); assert.ok(roles.includes("admin")); if (!allowed) throw new Error("forbidden"); },
    initDb: () => { throw new Error("sync_db_forbidden"); }, nowIso: () => "2026-09-06T11:00:00.000Z",
    getDashboardExpensiveSnapshot: (options: any) => { assert.equal(options.allowStoredSecretRead, false); snapshotReads++; return { browserHealth: { chromeExtension: { status: "unknown" }, unrelated: "private" } }; },
    getDashboardDeploymentReadback: () => ({ version: "test", assets: { js: "index-test.js" } }),
    sendAutomationApiError: (res: any, error: Error) => res.json({ ok: false, error: error.message }) };
  runInNewContext(transpileModule(route, {}).outputText, context);
  let result: any;
  const res = { setHeader: (key: string, value: string) => { assert.equal(key, "Cache-Control"); assert.equal(value, "no-store"); }, json: (value: any) => { result = value; } };
  await handler({ params: { companyId: "own" } }, res);
  assert.equal(result.persistence.adapter, "postgres");
  assert.equal(result.company_scope.company_id, "own");
  assert.equal(result.readiness.goal_complete, null);
  assert.equal(result.readiness.production_ready, null);
  assert.equal(result.external_action_executed, false);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  allowed = false;
  await handler({ params: { companyId: "own" } }, res);
  assert.equal(result.error, "forbidden");
  assert.equal(snapshotReads, 1);
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("async function requestProductionReadback("), source.indexOf("function TruthfulProductionStatusPage("));
  const valid = { ok: true, source: "api_host_runtime", company_scope: { enforced: true, company_id: "own" }, persistence: { adapter: "postgres" }, deployment: {}, checked_at: "now" };
  let body: any = valid;
  const calls: any[] = [];
  const read = runInNewContext(transpileModule(fragment + "\nrequestProductionReadback;", {}).outputText, {
    mvpFetch: async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, json: async () => body }; }
  });
  await read("own");
  body = { ...valid, company_scope: { enforced: true, company_id: "other" } };
  await assert.rejects(read("own"), /mismatch/);
  assert.ok(calls.every((call) => !call.init.method && call.init.cache === "no-store"));
});

test("recovery selection uses the same-company exact Run readback and clears stale loading guidance", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function recoveryRunOptionStatus("), source.indexOf("function TruthfulRecoveryPage("));
  const status = runInNewContext(transpileModule(fragment + "\nrecoveryRunOptionStatus;", {}).outputText, {});
  const run = { id: "own-run", status: "waiting_approval" };
  assert.equal(status(run, { company_id: "own", run_id: run.id, status: "cancelled" }, "own"), "cancelled");
  assert.equal(status(run, { company_id: "foreign", run_id: run.id, status: "cancelled" }, "own"), "waiting_approval");
  assert.equal(status(run, { company_id: "own", run_id: "different", status: "cancelled" }, "own"), "waiting_approval");
  assert.equal(status(run, null, "own"), "waiting_approval");
  const page = source.slice(source.indexOf("function TruthfulRecoveryPage("), source.indexOf("function TruthfulPluginsPage("));
  const readFragment = page.slice(page.indexOf("  const refreshRun ="), page.indexOf("  useEffect(() =>"));
  let finish: (value: any) => void = () => {};
  const context: any = { requestedRunId: "own-run", companyId: "own", recoveryReadGeneration: { current: 0 },
    setRecovery: (value: any) => { context.value = value; }, setRecoveryReadStatus: (value: string) => { context.status = value; },
    setRunNote: (value: string) => { context.note = value; }, setRunReadbackRequired: () => {}, actionStamp: () => "now", publicBlockerSummary: (v: any) => v,
    requestPortableRunRecovery: () => new Promise((resolve) => { finish = resolve; }) };
  const refresh = runInNewContext(transpileModule(readFragment + "\nrefreshRun;", {}).outputText, context);
  const pending = refresh();
  assert.equal(context.status, "loading");
  assert.match(context.note, /own-run.*読み込んでいます/);
  context.requestedRunId = "";
  await refresh();
  assert.equal(context.status, "idle");
  assert.match(context.note, /Runを選ぶ/);
  finish({ company_id: "own", run_id: "own-run", status: "cancelled" });
  await pending;
  assert.equal(context.value, null);
  assert.equal(context.status, "idle");
});

test("artifact rows reject explicit foreign scope and profile readback verifies company and revision", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function companyArtifactProofs("), source.indexOf("function TruthfulArtifactsPage("));
  const filter = runInNewContext(transpileModule(fragment + "\ncompanyArtifactProofs;", {}).outputText, {});
  const state = { automations: [{ id: "a", company_id: "own" }], runs: [{ id: "r", company_id: "own" }, { id: "foreign-r", company_id: "other", automation_id: "a" }],
    proofs: [{ id: "valid", company_id: "own", run_id: "r" }, { id: "foreign", company_id: "other", run_id: "r" },
      { id: "legacy", run_id: "r" }, { id: "foreign-legacy", run_id: "foreign-r" }, { id: "older", company_id: "own", run_id: "not-in-recent-list" }] };
  assert.deepEqual(Array.from(filter(state, "own"), (row: any) => row.id), ["valid", "legacy", "older"]);
  const readFragment = source.slice(source.indexOf("async function requestCompanyPresentationProfile("), source.indexOf("function ProjectPresentationProfilePanel("));
  const valid = { ok: true, company_scope: { enforced: true, company_id: "own" }, revision: 3,
    profile: { id: "own", source: "persisted_project_profile", revision: 3, label: "Saved", primaryMetrics: ["Runs"], widgets: ["kpi"] } };
  let body: any = valid;
  const calls: any[] = [];
  const read = runInNewContext(transpileModule(readFragment + "\nrequestCompanyPresentationProfile;", {}).outputText,
    { mvpFetch: async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, json: async () => body }; } });
  assert.equal((await read("own")).revision, 3);
  for (const changed of [{ company_scope: { enforced: true, company_id: "other" } }, { revision: 4 }, { profile: { ...valid.profile, id: "other" } }]) {
    body = { ...valid, ...changed };
    await assert.rejects(read("own"), /readback_mismatch/);
  }
  assert.ok(calls.every((call) => call.url === "/api/v1/companies/own/presentation-profile" && call.init.cache === "no-store" && !call.init.method));
});

test("profile saves are single-flight and an unknown result permits only GET reconciliation", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const panel = source.slice(source.indexOf("function ProjectPresentationProfilePanel("), source.indexOf("function ProjectPresentationProfileSummary("));
  const fragment = panel.slice(panel.indexOf("  const applyProfile ="), panel.indexOf("  return (\n"));
  const calls: any[] = [];
  let lost = true;
  const context: any = { companyId: "own", canManage: true, readbackRequired: false, mutationRef: { current: false }, scopeRef: { current: "own" },
    profile: { id: "own", revision: 1 }, draft: { kind: "research", label: "Saved", primaryMetrics: "Runs", widgets: "kpi", preferredGrouping: "day", explanation: "Explain" },
    model: { setMvpState: () => {}, setReceipt: () => {} }, setSaving: () => {}, setNote: () => {}, setDraft: () => {}, presentationProfileDraft: (value: any) => value,
    setReadbackRequired: (value: boolean) => { context.readbackRequired = value; },
    requestCompanyPresentationProfile: async (_company: string, init: any = {}) => { calls.push(init.method ?? "GET"); if (lost && init.method) throw new Error("lost_response"); return { id: "own", revision: 2 }; } };
  const actions = runInNewContext(transpileModule(fragment + "\n({save,reconcile});", {}).outputText, context);
  await Promise.all([actions.save(), actions.save()]);
  assert.deepEqual(calls, ["PUT"]);
  assert.equal(context.readbackRequired, true);
  await actions.save();
  assert.equal(calls.length, 1);
  lost = false;
  await actions.reconcile();
  assert.deepEqual(calls, ["PUT", "GET"]);
  assert.equal(context.readbackRequired, false);
});

test("approval decision readback and target preview require the same Run, company, payload and expiry", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function approvalDecisionReadbackMatches("), source.indexOf("function ApprovalsPage("));
  const parser = source.slice(source.indexOf("function parseJsonRecord("), source.indexOf("function proofExternalActionState("));
  const api = runInNewContext(transpileModule(parser + fragment + "\n({matches: approvalDecisionReadbackMatches, target: approvalPortableTarget});", {}).outputText,
    {}, { timeout: 1000 });
  const item = { id: "approval-1", runId: "run-1", project: "company-1", actionKind: "business_execute", portableBound: true,
    targetAccount: "account-1", payloadHash: "a".repeat(64), policyVersion: "portable-policy", expiresAt: "2026-09-06T10:00:00.000Z" };
  const row = { id: item.id, run_id: item.runId, company_id: item.project, action_kind: item.actionKind, status: "approved",
    target_account_ref_id: item.targetAccount, payload_hash: item.payloadHash, policy_version: item.policyVersion, expires_at: item.expiresAt };
  assert.equal(api.matches(row, item, "approve"), true);
  for (const field of ["id", "run_id", "company_id", "action_kind", "target_account_ref_id", "payload_hash", "policy_version", "expires_at", "status"]) {
    assert.equal(api.matches({ ...row, [field]: "changed" }, item, "approve"), false, field);
  }
  const metadata = { approval_id: item.id, portable_target_bound_approval_binding: {
    schema: "automation_os_portable_external_approval_binding.v1", workflow_id: "daily-ai-research-source-sync", run_id: item.runId,
    company_id: item.project, effect_stage: item.actionKind, target: { account_ref: item.targetAccount, target_key: "sheet-1" } },
    portable_input_bundle: { input: { payload_hash: item.payloadHash, target_key: "sheet-1" } } };
  const run = { id: item.runId, company_id: item.project, metadata_json: JSON.stringify(metadata) };
  assert.equal(api.target(item, run).targetKey, "sheet-1");
  assert.equal(api.target(item, { ...run, id: "foreign" }), null);
  assert.equal(api.target(item, { ...run, company_id: "foreign" }), null);
  assert.equal(api.target(item, { ...run, metadata_json: JSON.stringify({ ...metadata, approval_id: "other" }) }), null);
  assert.equal(api.target({ ...item, payloadHash: "b".repeat(64) }, run), null);
  for (const value of [null, [], "invalid-json", 42]) {
    assert.equal(api.target(item, { ...run, metadata_json: JSON.stringify({ ...metadata, portable_target_bound_approval_binding: value }) }), null);
    assert.equal(api.target(item, { ...run, metadata_json: JSON.stringify({ ...metadata, portable_input_bundle: value }) }), null);
  }
  assert.equal(api.target(item, { ...run, metadata_json: "invalid-json" }), null);
  const serializedNested = { ...metadata, portable_target_bound_approval_binding: JSON.stringify(metadata.portable_target_bound_approval_binding),
    portable_input_bundle: JSON.stringify(metadata.portable_input_bundle) };
  assert.equal(api.target(item, { ...run, metadata_json: JSON.stringify(serializedNested) }).targetKey, "sheet-1");
});

test("approval deadlines preserve the timezone and display the actual JST expiry", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function approvalDueLabel("), source.indexOf("const templates ="));
  const label = runInNewContext(transpileModule(fragment + "\napprovalDueLabel;", {}).outputText, {}, { timeout: 1000 });
  assert.match(label("2026-09-06T06:32:42.993Z"), /2026\/09\/06 15:32:42 JST/u);
  assert.equal(label("2026-09-06T15:32:42.993+09:00"), label("2026-09-06T06:32:42.993Z"));
  assert.match(label("2026-09-06T18:00:00.000Z"), /2026\/09\/07 03:00:00 JST/u);
  assert.match(label(null), /期限未設定/u);
  assert.match(label("invalid"), /期限未確認/u);
});

test("approval target readback distinguishes loading, unavailable and mismatched data and keeps long bindings readable", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const page = source.slice(source.indexOf("function ApprovalsPage("), source.indexOf("function RunsPage("));
  assert.match(page, /setApprovalRunReadStatus\("ready"\)/u);
  assert.match(page, /setApprovalRunReadStatus\("error"\)/u);
  assert.match(page, /取得したRunの対象が、この承認の内容と一致しません/u);
  assert.match(page, /同じRunの実行対象を取得できませんでした/u);
  assert.match(page, /className="split approvals-layout"/u);
  assert.match(page, /className="side-panel wide approvals-detail"/u);
  const css = readFileSync(resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");
  assert.match(css, /\.approvals-detail table\s*\{[^}]*min-width: 0;[^}]*table-layout: fixed;/u);
  assert.match(css, /\.approvals-detail td\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/u);
  assert.match(css, /@media \(max-width: 1100px\)\s*\{\s*\.split\.approvals-layout\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/u);
});

test("approval UI posts once, verifies a fresh exact decision, and recovers a lost result using GET only", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const page = source.slice(source.indexOf("function ApprovalsPage("), source.indexOf("function RunsPage("));
  const fragment = page.slice(page.indexOf("  const refreshApprovals ="), page.indexOf("  const approveSelected ="));
  const item = { id: "approval-1", runId: "run-1", project: "company-1", decisionEligible: true, portableBound: true, bound: false,
    kind: "Daily AI", actionKind: "business_execute", targetAccount: "account-1", payloadHash: "a".repeat(64),
    policyVersion: "portable-policy", expiresAt: "2026-09-06T10:00:00.000Z" };
  const requests: any[] = [];
  const notices: string[] = [];
  let stateReads = 0;
  let fail = false;
  let mismatch = false;
  const ctx: any = { item, inFlight: { current: false }, unknownDecision: { current: null }, readbackRequired: false, canDecideApproval: true,
    portableTarget: { targetKey: "sheet-1" }, approvalNote: "Edited memo; not payload", actionStamp: () => "now",
    setBusy() {}, setEditing() {}, setMvpState() {}, setApprovalRun() {}, setApprovalRunReadStatus() {},
    setReadbackRequired: (value: boolean) => { ctx.readbackRequired = value; },
    readCompanyApprovalList: async () => {},
    setReceipt: (value: string) => notices.push(value), setApprovalStatusNote: (value: string) => notices.push(value),
    mvpFetch: async (url: string, options: any) => { requests.push({ url, options }); if (fail) throw Error("lost_response"); return { ok: true, json: async () => ({}) }; },
    readMvpState: async () => { stateReads++; return { approvals: [{ id: item.id, status: mismatch ? "pending" : "approved" }] }; },
    approvalDecisionReadbackMatches: (row: any) => row.status === "approved",
    fetchApiJson: async () => ({ run: { id: item.runId } }),
    fetchExactApprovalRun: async () => ({ id: item.runId }) };
  const api = runInNewContext(transpileModule(fragment + "\n({decide:updateSelectedApproval,refresh:refreshApprovals});", {}).outputText, ctx, { timeout: 1000 });
  await Promise.all([api.decide("approve"), api.decide("approve")]);
  assert.equal(requests.length, 1);
  assert.equal(stateReads, 1);
  assert.equal(requests[0].url, "/api/mvp/approvals/approval-1");
  const posted = JSON.parse(requests[0].options.body);
  assert.equal(posted.note, "Edited memo; not payload");
  assert.equal(posted.expected_binding.run_id, "run-1");
  assert.equal(posted.expected_binding.payload_hash, item.payloadHash);
  assert.equal(posted.expected_binding.expires_at, item.expiresAt);
  assert.ok(notices.some((value) => value.includes("外部効果・完了はまだ確認しておらず")));
  assert.ok(notices.every((value) => !value.includes("external_action=false") && !value.includes("local draft承認")));
  fail = true;
  await api.decide("approve");
  assert.equal(requests.length, 2);
  assert.equal(ctx.readbackRequired, true);
  await api.decide("approve");
  assert.equal(requests.length, 2, "unknown decision must not be replayed");
  fail = false;
  await api.refresh();
  assert.equal(requests.length, 2, "recovery reads do not patch approval");
  assert.equal(ctx.readbackRequired, false);
  mismatch = true;
  await api.decide("approve");
  assert.equal(ctx.readbackRequired, true);
  assert.ok(notices.at(-1)?.includes("未確認"));
});

test("approval deep links filter company and Run and preserve terminal decisions for read-only result navigation", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const page = source.slice(source.indexOf("function ApprovalsPage("), source.indexOf("function RunsPage("));
  const fragment = page.slice(page.indexOf("  const approvalRows ="), page.indexOf("  const selectedCompanyRole ="));
  const items = [
    { id: "wanted", company_id: "c1", run_id: "r1", status: "approved" },
    { id: "other-run", company_id: "c1", run_id: "r2", status: "pending" },
    { id: "other-company", company_id: "c2", run_id: "r1", status: "pending" }
  ];
  const result = runInNewContext(transpileModule(fragment + "\n({visibleApprovals,item});", {}).outputText,
    { mvpState: { approvals: items }, companyApprovalReadback: [], runFilter: "r1", companyFilter: "c1", selected: 0, approvalDueLabel: () => "未確認",
      isApprovalExpired: () => false, normalizeApprovalStatus: (value: string) => value === "approved" ? "approved" : "waiting",
      approvalExecutionLabel: (status: unknown, expired: boolean, binding: any) => expired ? "期限切れ" : String(status), approvalTargetPrefix: () => "対象" }, { timeout: 1000 });
  assert.equal(result.visibleApprovals.length, 1);
  assert.equal(result.item.id, "wanted");
  assert.equal(result.item.decisionEligible, false);
  assert.match(page, /承認メモを編集しても、実行内容や対象は変わりません/);
  assert.match(page, /同じRunの結果を開く/);
  assert.match(source, /controlId="truthful\.run-detail\.open-approval"/);
  assert.match(source, /この処理の実行承認を準備/);
});

test("Obsidian result UI shows only same-run audit rows and identifies old summary-only or incomplete tables", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function verifiedObsidianAuditForRun("), source.indexOf("function TruthfulRunDetailPage("));
  const read = runInNewContext(transpileModule(fragment + "\nverifiedObsidianAuditForRun;", {}).outputText, {
    parseJsonRecord: JSON.parse, isRunCompletedStatus: (status: string) => status === "complete"
  }, { timeout: 1000 });
  const local: any = { audit_only: true, write_performed: false, maintenance_performed: false, git_sync_performed: false,
    audit_summary: { projects: 10, ok: 5, attention: 5, blocked: 0 }, audit_run_id: "run-1", audit_company_id: "company-1",
    audit_generated_at: "2026-09-06T00:00:00.000Z", audit_projects_truncated: false,
    audit_projects: Array.from({ length: 10 }, (_, i) => ({ project_id: `project-${i}`, project_label: `Project ${i}`,
      status: i < 5 ? "attention" : "ok", finding: `Finding ${i}`, state_updated_at: null, latest_activity_at: null, next_action: "Read STATE" })) };
  const receipt: any = { run_id: "run-1", status: "complete", workflow_id: "obsidian-project-memory-audit", effects_mode: "read_only",
    read_only_proof_verified: true, same_run_receipt: true, readback_verified: true, cleanup_verified: true, external_action_executed: false,
    adapter_result: { local_receipt: local } };
  const run = (rec = receipt) => ({ id: "run-1", company_id: "company-1", status: "complete", metadata_json: JSON.stringify({ remote_worker_receipt: rec }) });
  assert.equal(read(run()).projects.length, 10);
  assert.equal(read(run()).summary.attention, 5);
  for (const patch of [{ audit_run_id: "foreign" }, { audit_company_id: "foreign" }, { audit_projects: undefined },
    { audit_projects: local.audit_projects.slice(0, 5) }, { audit_projects: Array(10).fill(local.audit_projects[0]) }]) {
    assert.equal(read(run({ ...receipt, adapter_result: { local_receipt: { ...local, ...patch } } })).projects, null);
  }
  for (const patch of [{ run_id: "foreign" }, { external_action_executed: true }, { effects_mode: "business_effect" }, { cleanup_verified: false }]) {
    assert.equal(read(run({ ...receipt, ...patch })), null);
  }
  assert.equal(read(run({ ...receipt, adapter_result: { local_receipt: { ...local, write_performed: true } } })), null);
  assert.equal(read(run({ ...receipt, adapter_result: { local_receipt: { ...local, audit_summary: { projects: 10, ok: 4, attention: 5, blocked: 0 } } } })), null);
  const large = { ...local, audit_summary: { projects: 25, ok: 20, attention: 5, blocked: 0 }, audit_projects_truncated: true,
    audit_projects: Array.from({ length: 20 }, (_, i) => ({ ...local.audit_projects[i % 10], project_id: `project-${i}` })) };
  assert.equal(read(run({ ...receipt, adapter_result: { local_receipt: large } })).truncated, true);
  assert.match(source, /個別の理由や次の操作を確認するには、新しい読取監査/);
  assert.match(source, /Vault更新・Git同期はしていません/);
  assert.match(source, /先頭20プロジェクトを表示/);
});

test("Chat workflow readback validates the same company/job/schema and never writes while recovering", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("async function requestChatWorkflowActions("), source.indexOf("function ChatWorkflowActionsPanel("));
  const valid = { ok: true, schema: "aos.chat_workflow_options.v1", company_id: "company-1", job_id: "job-1",
    options: [{ automation_id: "registered-1", automation_revision: 2, definition_sha256: "a".repeat(64) }],
    actions: [{ company_id: "company-1", job_id: "job-1" }] };
  let body: any = valid;
  const calls: Array<{ url: string; options: Record<string, any> }> = [];
  const read = runInNewContext(transpileModule(fragment + "\nrequestChatWorkflowActions;", {}).outputText, {
    mvpFetch: async (url: string, options: Record<string, any>) => { calls.push({ url, options }); return { ok: true, json: async () => body }; }
  }, { timeout: 1000 });
  await read("company-1", "job-1");
  assert.equal(calls[0].url, "/api/v1/companies/company-1/chat-jobs/job-1/workflow-actions");
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.cache, "no-store");
  for (const changed of [{ schema: "old" }, { company_id: "foreign" }, { job_id: "foreign" },
    { actions: [{ company_id: "foreign", job_id: "job-1" }] }, { options: [{ automation_id: "a", automation_revision: 0, definition_sha256: "invalid" }] }]) {
    body = { ...valid, ...changed };
    await assert.rejects(read("company-1", "job-1"), /readback_mismatch/);
  }
  assert.ok(calls.every((call) => !call.options.method && !call.options.body));
});

test("Chat one-off action posts only a fixed binding once and confirms its same Run before navigation", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const panel = source.slice(source.indexOf("function ChatWorkflowActionsPanel("), source.indexOf("async function requestChatPlan("));
  const fragment = panel.slice(panel.indexOf("  const perform ="), panel.indexOf("  if (!loading"));
  const selected = { automation_id: "registered-1", automation_revision: 2, definition_sha256: "a".repeat(64), can_run_once: true, can_save_draft: true };
  const saved: any = { ok: true, company_id: "company-1", job_id: "job-1", binding_id: "binding-1", action: "run_once", status: "run_admitted", run_id: "real-run-1", automation_id: selected.automation_id };
  const requests: any[] = [];
  const navigation: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const readRequired: boolean[] = [];
  let readbacks = 0;
  let unmounted = false;
  let mismatch = false;
  let fail = false;
  const context: any = { companyId: "company-1", jobId: "job-1", selected, inFlight: { current: false }, loading: false, readbackRequired: false,
    readback: { company_id: "company-1", job_id: "job-1", actions: [] }, mounted: { current: true },
    model: { mvpLoadStatus: "ready", setReceipt: (value: string) => notices.push(value), setMvpState: () => {}, setAutomationRows: () => {} },
    setBusy: () => {}, onBusy: () => {}, setError: (value: string) => errors.push(value), setReadback: () => {},
    setReadbackRequired: (value: boolean) => readRequired.push(value), publicBlockerSummary: (value: string) => value,
    mvpFetch: async (url: string, options: any) => { requests.push({ url, options }); if (fail) throw new Error("lost_response"); if (unmounted) context.mounted.current = false; return { ok: true, json: async () => saved }; },
    requestChatWorkflowActions: async () => { readbacks += 1; return { actions: [{ ...saved, run_id: mismatch ? "foreign-run" : saved.run_id }] }; },
    go: (value: string) => navigation.push(value)
  };
  const perform = runInNewContext(transpileModule(fragment + "\nperform;", {}).outputText, context, { timeout: 1000 });
  await Promise.all([perform("run_once"), perform("run_once")]);
  assert.equal(requests.length, 1, "concurrent clicks must not race into a second request");
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: "run_once", automation_id: selected.automation_id,
    expected_revision: 2, definition_sha256: "a".repeat(64) });
  assert.equal(requests[0].options.headers["idempotency-key"], "chat-workflow-job-1-run_once");
  assert.equal(readbacks, 1);
  assert.deepEqual(navigation, ["#/projects/company-1/runs/real-run-1"]);
  assert.match(notices[0], /受付は完了ではありません/);
  mismatch = true;
  await perform("run_once");
  assert.match(errors.at(-1) ?? "", /action_readback_mismatch/);
  assert.equal(navigation.length, 1);
  assert.equal(readRequired.at(-1), true);
  context.readbackRequired = true;
  await perform("run_once");
  assert.equal(requests.length, 2, "unknown result must require a GET before a new user action");
  context.readbackRequired = false;
  fail = true;
  await perform("run_once");
  assert.equal(requests.length, 3, "never automatically retry a lost POST response");
  assert.equal(readbacks, 2);
  fail = false; mismatch = false; unmounted = true;
  await perform("run_once");
  assert.equal(navigation.length, 1, "late responses cannot navigate after leaving this company/job");
  assert.equal(readbacks, 2);
});

test("Chat workflow panel keeps ambiguous selection explicit and the generic memo distinct from a real runner", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const panel = source.slice(source.indexOf("function ChatWorkflowActionsPanel("), source.indexOf("async function requestChatPlan("));
  assert.match(panel, /next\.options\.length === 1 \? next\.options\[0\]\.automation_id : ""/);
  assert.match(panel, /chat_workflow_answer_only_no_execution_requested/);
  assert.match(panel, /persisted\.automation_type !== "registered_workflow"/);
  assert.match(panel, /automation\.company_id === companyId/);
  assert.match(panel, /実行・予定有効化はしていません/);
  assert.match(panel, /同じ依頼の結果を再取得/);
  assert.match(source, /仕様メモの下書きを保存/);
  assert.match(source, /key=\{`\$\{targetProject\}:\$\{plannerReadback\.chat_job_id\}`\}/);
  assert.doesNotMatch(panel, /safe_local_demo|PUT|effect_stage|unattended_effect_policy/);
});

test("Builder schedule state comes only from the saved schedule, never the editable hint", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const normalizeSource = source.slice(source.indexOf("function normalizeScheduleKind("), source.indexOf("type MvpState ="));
  const normalize = runInNewContext(transpileModule(normalizeSource + "\nnormalizeScheduleKind;", {}).outputText, {}, { timeout: 1000 });
  assert.equal(normalize(undefined), "manual");
  for (const kind of ["manual", "daily", "weekly", "cron"]) assert.equal(normalize(kind), kind);
  const builder = source.slice(source.indexOf("function BuilderPage("), source.indexOf("function ApprovalsPage("));
  const initial = builder.slice(builder.indexOf("  const [scheduleDraft,"), builder.indexOf("  const builderCreateIdempotencyRef"));
  const effect = builder.slice(builder.indexOf("  React.useEffect(() => {\n    setScheduleDraft("), builder.indexOf("  const saveBuilder ="));
  for (const fragment of [initial, effect]) {
    assert.doesNotMatch(fragment, /schedule_hint|builderDraft|persistedSpec/);
    for (const schedule of [undefined, { kind: "daily", expression: "07:30", timezone: "Asia/Tokyo", enabled: true, revision: 7 }]) {
      let actual: any;
      runInNewContext(transpileModule(fragment, {}).outputText, {
        automationId: "test-1", persistedSchedule: schedule, normalizeScheduleKind: normalize,
        useState: (value: unknown) => { actual = value; return [value, () => {}]; },
        setScheduleDraft: (value: unknown) => { actual = value; },
        React: { useEffect: (fn: () => void) => fn() }
      }, { timeout: 1000 });
      assert.equal(actual.kind, schedule?.kind ?? "manual");
      assert.equal(actual.expression, schedule?.expression ?? "");
      assert.equal(actual.enabled, schedule?.enabled ?? false);
    }
  }
  assert.match(builder, /className="builder-step-title"[\s\S]*?<textarea rows=\{2\} data-control-id=\{`builder\.step\.title/);
});

test("automation list preserves active and paused states and portable execution mode", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const mapper = source.slice(source.indexOf("function toAutomationRows("), source.indexOf("function displayedAutomationLane("));
  const map = runInNewContext(transpileModule(mapper + "\ntoAutomationRows;", {}).outputText, {}, { timeout: 1000 });
  const rows = map([{ id: "a", status: "active", execution_mode: "portable_mac_worker_queue", schedule: "07:30", pinned_schedule_version_id: "v1", next_run_at: "next" }, { id: "b", status: "paused" }, { id: "c", status: "draft" }]);
  assert.equal(rows[0].status, "enabled");
  assert.equal(rows[0].execution_mode, "portable_mac_worker_queue");
  assert.equal(rows[0].schedule, "07:30");
  assert.equal(rows[0].schedule_version, "v1");
  assert.equal(rows[0].next_run_at, "next");
  assert.equal(rows[1].status, "disabled");
  assert.equal(rows[2].status, "draft");
});

test("Builder saves edited content and steps without dropping the registered or planner spec", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const builder = source.slice(source.indexOf("function BuilderPage("), source.indexOf("function ApprovalsPage("));
  const saveSource = builder.slice(builder.indexOf("  const saveBuilder ="), builder.indexOf("  const saveSchedule ="));
  const calls: Array<{ url: string; options: { body: string } }> = [];
  const originalSpec = { source: "chat", planner_job_id: "job-1", workflowAdapter: { workflow_id: "registered-read-only" }, custom: { keep: true }, external_action_allowed: false };
  const draft = { name: "Edited", goal: "Read 5 metadata records, never send", target_label: "Company 1 Gmail", steps: [{ title: " Read metadata ", enabled: true, action_id: "read-1" }, { title: "Summarize", enabled: false }], schedule: "manual", lane: "local", approval_policy: "read-only", retry_rule: "One attempt" };
  const notices: string[] = [];
  const save = runInNewContext(transpileModule(saveSource + "\nsaveBuilder;", {}).outputText, {
    builderEditable: true, registeredWorkflow: false, builderTypeSupported: true, builderType: "email", isGmailExecutionWorkflow: false, gmailConnectionRefsStatus: "idle", gmailTargetDraft: { connectionRefId: "", accountRef: "" }, saving: false, builderDraft: draft,
    persistedSpec: { spec: originalSpec }, persistedAutomation: { revision: 7 }, automationId: "automation-1",
    setSaving: () => {}, noteBuilder: (message: string) => notices.push(message),
    automationSlugForKind: () => "email", mvpFetch: async (url: string, options: { body: string }) => {
      calls.push({ url, options }); return { ok: true, json: async () => ({ state: { automations: [] } }) };
    }, setMvpState: () => {}, setAutomationRows: () => {}, toAutomationRows: (rows: unknown) => rows
  }, { timeout: 1000 });
  await save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/mvp/automations/automation-1");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.expected_revision, 7);
  assert.equal(payload.goal, draft.goal);
  assert.equal(payload.builder_spec.target_label, draft.target_label);
  assert.deepEqual(payload.builder_spec.workflowAdapter, originalSpec.workflowAdapter);
  assert.deepEqual(payload.builder_spec.custom, originalSpec.custom);
  assert.equal(payload.builder_spec.planner_job_id, "job-1");
  assert.equal(payload.builder_spec.steps[0].action_id, "read-1");
  assert.equal(payload.builder_spec.steps[0].title, "Read metadata");
  assert.equal(payload.builder_spec.steps[1].enabled, false);
  assert.equal(payload.builder_spec.external_action_allowed, false);
  assert.equal(draft.steps[0].title, " Read metadata ", "saving does not mutate draft state");
  assert.equal(originalSpec.source, "chat");
  draft.steps[1].title = " ";
  await save();
  assert.equal(calls.length, 1, "blank steps must not create a version");
  assert.match(notices.at(-1) ?? "", /まだ保存していません/);
  for (const field of ["builder.goal", "builder.target-label", "builder.step.title.", "builder.step.enabled.", "builder.step.remove.", "builder.step.add"]) assert.ok(builder.includes(field), field);
  assert.match(builder, /goal: String\(persistedAutomation\?\.goal/);
  assert.match(builder, /JSON\.stringify\(builderDraft\.steps\)/);
});

test("registered Builder reads real stages without making the registered type a new template", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helpers = source.slice(source.indexOf("function registeredWorkflowSteps("), source.indexOf("type ChatWorkflowOption ="));
  const helper = runInNewContext(transpileModule(helpers + "\n({steps: registeredWorkflowSteps, config: registeredWorkflowBuilderConfig});", {}).outputText, {}, { timeout: 1000 });
  const spec = { canonicalWorkflowId: "daily-ai-research-source-sync", stages: [{ id: "research", title: "調査" }, { id: "mirror", name: "既存Sheet同期" }, { id: "readback", enabled: false }, null, { title: " " }] };
  assert.deepEqual(JSON.parse(JSON.stringify(helper.steps(spec))), [{ title: "調査", enabled: true }, { title: "既存Sheet同期", enabled: true }, { title: "readback", enabled: false }]);
  const record = { id: "daily", automation_type: "registered_workflow", name: "Daily AI", approval_policy: "existing_policy" };
  assert.equal(helper.config(record, spec).kindLabel, "登録業務");
  assert.match(helper.config(record, spec).inputSources, /daily-ai-research-source-sync/);
  assert.equal(helper.config(undefined, spec), null);
  assert.equal(helper.config({ automation_type: "registered_workflow" }, spec), null);
  assert.equal(helper.config({ ...record, automation_type: "future_unknown" }, spec), null);
  assert.equal(helper.steps({}).length, 0, "missing stages must not invent template steps");
  const builder = source.slice(source.indexOf("function BuilderPage("), source.indexOf("function ApprovalsPage("));
  assert.match(builder, /const builderEditable = builderTypeSupported \|\| registeredWorkflow/);
  assert.match(builder, /!registeredWorkflow && <Button/);
  assert.match(builder, /処理契約・接続先・承認ポリシー・実予定は変更していません/);
});

test("registered Builder PATCH sends only scoped metadata and confirms persisted values", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const builder = source.slice(source.indexOf("function BuilderPage("), source.indexOf("function ApprovalsPage("));
  const saveSource = builder.slice(builder.indexOf("  const saveBuilder ="), builder.indexOf("  const saveSchedule ="));
  const spec = { canonicalWorkflowId: "daily-ai-research-source-sync", workflowAdapter: { workflow_id: "daily-ai-research-source-sync" }, unattendedEffectPolicy: "fixed_policy", scope: { account_ref: "fixed", publish_allowed: false }, stages: [{ id: "mirror" }] };
  const before = JSON.stringify(spec);
  const draft = { name: " Edited Daily ", goal: " Purpose only ", steps: [], lane: "must-not-save", approval_policy: "must-not-save", retry_rule: "must-not-save" };
  const calls: Array<{ url: string; options: { method: string; body: string } }> = [];
  const notices: string[] = [];
  const state = { automations: [{ id: "automation-1", company_id: "company-1", name: "Edited Daily", goal: "Purpose only", revision: 7, builder_spec: spec }] };
  let stateReads = 0;
  const context = {
    builderEditable: true, registeredWorkflow: true, builderTypeSupported: false, builderType: "registered_workflow", isGmailExecutionWorkflow: false, gmailConnectionRefsStatus: "idle", gmailTargetDraft: { connectionRefId: "", accountRef: "" }, saving: false, builderDraft: draft,
    persistedSpec: { spec }, persistedAutomation: { revision: 6 }, automationId: "automation-1", activeProject: "company-1",
    setSaving: () => {}, noteBuilder: (message: string) => notices.push(message),
    mvpFetch: async (url: string, options: { method: string; body: string }) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; },
    readMvpState: async (projection: string, options: { fresh?: boolean }) => { stateReads += 1; assert.equal(projection, "ui"); assert.equal(options.fresh, true); return state; },
    setMvpState: () => {}, setAutomationRows: () => {}, toAutomationRows: (rows: unknown) => rows
  };
  const save = runInNewContext(transpileModule(saveSource + "\nsaveBuilder;", {}).outputText, context, { timeout: 1000 });
  await save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/companies/company-1/automations/automation-1");
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), { expected_revision: 6, name: "Edited Daily", goal: "Purpose only" });
  assert.equal(stateReads, 1);
  assert.equal(JSON.stringify(spec), before, "registered account/policy/adapter/stages must be untouched");
  assert.match(notices.at(-1) ?? "", /再取得して確認しました/);
  state.automations[0].company_id = "foreign-company";
  await save();
  assert.match(notices.at(-1) ?? "", /registered_metadata_readback_mismatch/);
  context.builderEditable = false;
  const blocked = runInNewContext(transpileModule(saveSource + "\nsaveBuilder;", {}).outputText, context, { timeout: 1000 });
  await blocked();
  assert.equal(calls.length, 2, "unverified type must reject before any request");
});

test("registered Builder can save its real schedule independently from the template editor", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const builder = source.slice(source.indexOf("function BuilderPage("), source.indexOf("function ApprovalsPage("));
  assert.match(builder, /enabled: event\.target\.value === "manual" \? false : draft\.enabled/);
  assert.match(builder, /data-control-id="builder\.schedule\.enabled"[^\n]*disabled=\{[^}]*scheduleDraft\.kind === "manual"/);
  assert.match(builder, /下書き本体も有効化し、予定時刻から実行/);
  const saveSource = builder.slice(builder.indexOf("  const saveSchedule ="), builder.indexOf("  return (\n    <section>"));
  const calls: Array<{ url: string; options: { method: string; body: string } }> = [];
  const notices: string[] = [];
  const schedule = { automation_id: "automation-1", kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: false, revision: 5, next_run_at: null };
  const context = {
    builderEditable: true, builderTypeSupported: false, builderType: "registered_workflow", scheduleSaving: false,
    persistedAutomation: { revision: 6 }, persistedSchedule: { revision: 4 }, automationId: "automation-1", activeProject: "company-1",
    scheduleDraft: { kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: false },
    setScheduleSaving: () => {}, noteBuilder: (message: string) => notices.push(message),
    mvpFetch: async (url: string, options: { method: string; body: string }) => { calls.push({ url, options }); return { ok: true, json: async () => ({ schedule }) }; },
    readMvpState: async () => ({ automations: [], schedules: [schedule] }),
    setMvpState: () => {}, setAutomationRows: () => {}, toAutomationRows: (rows: unknown) => rows,
    setScheduleDraft: () => {}, normalizeScheduleKind: (kind: string) => kind
  };
  await runInNewContext(transpileModule(saveSource + "\nsaveSchedule;", {}).outputText, context, { timeout: 1000 })();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/companies/company-1/automations/automation-1/schedule");
  assert.deepEqual(JSON.parse(calls[0].options.body), { kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: false, expected_revision: 4 });
  assert.match(notices.at(-1) ?? "", /停止中/);
  context.scheduleSaving = true;
  await runInNewContext(transpileModule(saveSource + "\nsaveSchedule;", {}).outputText, context, { timeout: 1000 })();
  assert.equal(calls.length, 1, "in-flight saves are not duplicated");
  context.scheduleSaving = false;
  context.builderEditable = false;
  await runInNewContext(transpileModule(saveSource + "\nsaveSchedule;", {}).outputText, context, { timeout: 1000 })();
  assert.equal(calls.length, 1, "unknown future types remain blocked");
  context.builderEditable = true;
  schedule.enabled = true;
  await runInNewContext(transpileModule(saveSource + "\nsaveSchedule;", {}).outputText, context, { timeout: 1000 })();
  assert.match(notices.at(-1) ?? "", /schedule_readback_mismatch/, "an unchanged or different schedule cannot be reported saved");
  assert.match(notices.at(-1) ?? "", /同じ保存を繰り返さず/);
});

test("Chat draft saving uses the current AOS company, not an unrelated external trigger mapping", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const gate = source.slice(source.indexOf("  const targetProjectIsVerified ="), source.indexOf("  const isCreateAutomationPlan ="));
  const evaluate = (scope: Record<string, unknown>) => runInNewContext(transpileModule(gate + "\ncanCreatePlan;", {}).outputText, {
    model: { mvpLoadStatus: "ready" }, targetProject: "company-1", canonicalProjects: [{ id: "company-1" }],
    plannerReadback: { can_create: true }, ...scope
  }, { timeout: 1000 });
  assert.equal(evaluate({}), true, "an API-confirmed company can save without an external mapping readback");
  assert.equal(evaluate({ companyConsultation: { status: "ready", readback: { canonical_company_id: null, chat: { company_scoped_registration_ready: false } } } }), true);
  assert.equal(evaluate({ model: { mvpLoadStatus: "error" } }), false);
  assert.equal(evaluate({ targetProject: "foreign-company" }), false);
  assert.equal(evaluate({ targetProject: "" }), false);
  assert.equal(evaluate({ plannerReadback: { can_create: false } }), false);
  const create = source.slice(source.indexOf("const createFromChat ="), source.indexOf("const createFromChat =") + 5500);
  assert.match(create, /if \(!targetProjectIsVerified \|\| !projectOptionsFromState/);
  assert.match(create, /project_id: targetProject/);
  assert.match(create, /create_approval: false/);
  assert.match(create, /external_action_allowed: false/);
  assert.match(create, /enabled: false, expected_revision: 1/);
  assert.doesNotMatch(create, /companyConsultation|companyScopedRegistrationReady/);
});

test("a manual Chat draft does not invent a daily schedule or request an execution approval", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const functionSource = source.slice(source.indexOf("function detectSchedule("), source.indexOf("function scheduleKindForPlan("));
  const detect = runInNewContext(transpileModule(functionSource + "\ndetectSchedule;", {}).outputText, {}, { timeout: 1000 });
  for (const prompt of ["1回の手動読み取りでGmailを確認", "定期実行は無効、まだ実行しない", "Gmail手動のみ", "manual-only draft",
    "Gmailを1回確認して", "今回だけGmailを確認して", "Review Gmail once", "AOSの下書きとして保存するだけで、まだ実行しない"]) {
    assert.equal(detect(prompt).cadence, "manual");
    assert.equal(detect(prompt).schedule, "manual");
  }
  assert.equal(detect("毎日9時、手動確認不要").cadence, "daily");
  assert.equal(detect("毎日1回、9:05に確認して").schedule, "09:05");
  assert.equal(detect("毎日1回、9時30分に確認して").cadence, "daily");
  assert.equal(detect("毎日1回、9時30分に確認して").schedule, "09:30");
  assert.equal(detect("毎週1回、日曜日10:15に確認して").schedule, "SUN 10:15");
  assert.equal(detect("毎月1回、12時45分に確認して").schedule, "45 12 1 * *");
  assert.equal(detect("毎週月曜10時").cadence, "weekly");
  const kindSource = source.slice(source.indexOf("function scheduleKindForPlan("), source.indexOf("type ChatScheduleAdjustment"));
  const kind = runInNewContext(transpileModule(kindSource + "\nscheduleKindForPlan;", {}).outputText, {}, { timeout: 1000 });
  assert.equal(kind({ cadence: "manual" }), "manual");
  const create = source.slice(source.indexOf("const createFromChat ="), source.indexOf("const createFromChat =") + 6000);
  assert.match(create, /name: plan\.title\.slice\(0, 80\)/u);
  assert.match(create, /create_approval: false/u);
  assert.match(create, /external_action_allowed: false/u);
});

test("Chat schedule changes require explicit selection and exact persisted target/readback", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const chat = source.slice(source.indexOf("function ChatPage("), source.indexOf("function CommonWebOperationAdmissionPage("));
  assert.doesNotMatch(chat, /targetAutomations\[0\]/);
  assert.match(chat, /setSelectedAutomationId\(""\).*\[targetProject, plannerReadback\?\.chat_job_id\]/);
  assert.match(chat, /data-control-id="chat.schedule-preview"/);
  assert.match(chat, /scheduleAdjustmentPreview\.enabled/);
  const valuesSource = source.slice(source.indexOf("function scheduleKindForPlan("), source.indexOf("type ChatScheduleAdjustment"));
  const scheduleValues = runInNewContext(transpileModule(valuesSource + "\n({preferences: schedulePreferencesFromPrompt, values: plannedChatScheduleValues});", {}).outputText, {}, { timeout: 1000 });
  const helper = source.slice(source.indexOf("function matchesChatScheduleAdjustment("), source.indexOf("function buildAutomationPlan("));
  const matches = runInNewContext(transpileModule(helper + "\nmatchesChatScheduleAdjustment;", {}).outputText, {}, { timeout: 1000 });
  const expected = { companyId: "c1", automationId: "a1", kind: "daily", expression: "09:05", timezone: "Asia/Tokyo", enabled: false, previousRevision: 7 };
  const saved = { company_id: "c1", automation_id: "a1", kind: "daily", expression: "09:05", timezone: "Asia/Tokyo", enabled: false, revision: 8, next_run_at: null };
  assert.equal(matches(saved, expected), true);
  for (const change of [{ company_id: "foreign" }, { automation_id: "a2" }, { revision: 7 }, { revision: 9 }, { expression: "09:00" },
    { enabled: true }, { next_run_at: "2026-09-06T00:05:00Z" }, { next_run_at: undefined }]) assert.equal(matches({ ...saved, ...change }, expected), false);
  assert.equal(matches({ ...saved, enabled: true }, { ...expected, enabled: true }), false, "an active schedule needs a computed next run");
  assert.equal(matches({ ...saved, enabled: true, next_run_at: "2026-09-06T00:05:00Z" }, { ...expected, enabled: true }), true);
  const fragment = source.slice(source.indexOf("  const saveAdjustedSchedule ="), source.indexOf("  const createFromChat ="));
  const requests: any[] = [];
  const notices: string[] = [];
  let state: any = { automations: [{ id: "a1", company_id: "c1" }], schedules: [saved] };
  let reads = 0;
  let fail = false;
  const context: any = { scheduleAdjustmentInFlight: { current: false }, pendingScheduleAdjustment: { current: null },
    scheduleReadbackRequired: false, canAdjustSchedule: true, selectedAutomation: { id: "a1", name: "Selected" }, selectedAutomationId: "a1", targetProject: "c1",
    mvpState: { schedules: [{ ...saved, revision: 7, expression: "08:00" }] }, plan: { schedule: "09:05", cadence: "daily" },
    scheduleKindForPlan: (plan: any) => plan.cadence, plannedChatScheduleValues: scheduleValues.values, matchesChatScheduleAdjustment: matches,
    setReceipt: (value: string) => notices.push(value), setChatNote: () => {}, setCreating: () => {}, setMvpState: () => {},
    setAutomationRows: () => {}, toAutomationRows: () => [], actionStamp: () => "now", publicBlockerSummary: (value: string) => value,
    setScheduleReadbackRequired: (value: boolean) => { context.scheduleReadbackRequired = value; },
    mvpFetch: async (url: string, options: any) => { requests.push({ url, options }); if (fail) throw new Error("lost_response"); return { ok: true, json: async () => ({}) }; },
    readMvpState: async () => { reads += 1; return state; }
  };
  const api = runInNewContext(transpileModule(fragment + "\n({save: saveAdjustedSchedule, read: readAdjustedSchedule});", {}).outputText, context, { timeout: 1000 });
  await Promise.all([api.save(), api.save()]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/companies/c1/automations/a1/schedule");
  assert.deepEqual(JSON.parse(requests[0].options.body), { kind: "daily", expression: "09:05", timezone: "Asia/Tokyo", enabled: false, expected_revision: 7 });
  assert.match(notices.at(-1) ?? "", /保存・再取得.*次回なし/);
  context.selectedAutomationId = "";
  await api.save();
  assert.equal(requests.length, 1, "a stale object is not an explicit selection");
  context.selectedAutomationId = "a1";
  fail = true;
  await api.save();
  assert.equal(context.scheduleReadbackRequired, true);
  assert.match(notices.at(-1) ?? "", /同じ保存を繰り返さず/);
  await api.save();
  assert.equal(requests.length, 2, "unknown results cannot be replayed by clicking again");
  state = { ...state, schedules: [{ ...saved, revision: 7 }] };
  await api.read();
  assert.equal(requests.length, 2, "readback is GET only");
  assert.equal(context.scheduleReadbackRequired, true, "old state cannot resolve a potentially applied save");
  state = { ...state, schedules: [saved] };
  await api.read();
  assert.equal(context.scheduleReadbackRequired, false);
  assert.equal(context.pendingScheduleAdjustment.current, null);
  assert.equal(reads, 3);
  fail = false;
  context.mvpState = { schedules: [] };
  context.plan = { schedule: "manual", cadence: "manual" };
  state = { ...state, schedules: [{ ...saved, kind: "manual", expression: null, revision: 1 }] };
  await api.save();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { kind: "manual", expression: null, timezone: "Asia/Tokyo", enabled: false, expected_revision: 1 });
  assert.match(notices.at(-1) ?? "", /保存・再取得/);
  const base = { cadence: "daily", schedule: "06:15" };
  assert.equal(scheduleValues.values(base, { enabled: true }).enabled, true, "changing only the time preserves active state");
  assert.equal(scheduleValues.values(base, undefined).enabled, false, "a new schedule is paused by default");
  const paused = { ...base, ...scheduleValues.preferences("毎日06:15 Asia/Tokyo。停止中のまま保存し、有効化しないでください。") };
  assert.equal(scheduleValues.values(paused, { enabled: true, timezone: "UTC" }).enabled, false);
  assert.equal(scheduleValues.values(paused, { enabled: true, timezone: "UTC" }).timezone, "Asia/Tokyo");
  const resumed = { ...base, ...scheduleValues.preferences("既存の予定を再開してください。") };
  assert.equal(scheduleValues.values(resumed, { enabled: false }).enabled, true);
  assert.equal(scheduleValues.values({ ...resumed, cadence: "manual" }, { enabled: true }).enabled, false);
  assert.equal(scheduleValues.preferences("予定を再開しないでください").scheduleEnabled, false);
  assert.equal(scheduleValues.preferences("毎日06:15").scheduleEnabled, undefined);
  assert.equal(scheduleValues.preferences("Keep the schedule paused").scheduleEnabled, false);
  assert.equal(scheduleValues.preferences("Enable the schedule").scheduleEnabled, true);
  context.mvpState = { schedules: [{ ...saved, enabled: true, revision: 7 }] };
  context.plan = paused;
  state = { ...state, schedules: [{ ...saved, expression: "06:15" }] };
  await api.save();
  assert.equal(JSON.parse(requests.at(-1).options.body).enabled, false, "explicit pause reaches the saved payload");
  assert.match(notices.at(-1) ?? "", /保存・再取得.*次回なし/);
});

test("resuming a saved Chat plan reads the exact persisted job without replay and fences scope", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const functionSource = source.slice(source.indexOf("async function requestSavedChatPlan("), source.indexOf("async function storeChatSecrets("));
  const calls: Array<{ url: string; method?: string }> = [];
  let responseJob = { id: "job-1", metadata: { codexThreadId: "thread-1" }, status: "completed" };
  const request = runInNewContext(transpileModule(functionSource + "\nrequestSavedChatPlan;", {}).outputText, {
    mvpFetch: async (url: string, options: { method?: string }) => { calls.push({ url, method: options.method }); return { ok: true, json: async () => ({ ok: true, job: responseJob }) }; },
    plannerReadbackFromJob: (job: unknown, prompt: string, platforms: string[], projectId: string) => ({ job, prompt, platforms, projectId })
  }, { timeout: 1000 });
  const thread = { threadId: "thread-1", latestJobId: "job-1", companyIds: ["company-1"], messages: [{ role: "user", text: "Gmailの手動下書き" }, { role: "assistant", text: "保存案" }] };
  const result = await request(thread, "company-1");
  assert.equal(result.prompt, "Gmailの手動下書き");
  assert.equal(result.projectId, "company-1");
  assert.deepEqual(calls, [{ url: "/api/create/plan/jobs/job-1", method: undefined }]);
  await assert.rejects(request(thread, "company-other"), /chat_history_scope_mismatch/);
  assert.equal(calls.length, 1);
  responseJob = { ...responseJob, metadata: { codexThreadId: "foreign-thread" } };
  await assert.rejects(request(thread, "company-1"), /chat_history_plan_readback_mismatch/);
  const mapper = source.slice(source.indexOf("function plannerReadbackFromJob("), source.indexOf("async function requestSavedChatPlan("));
  assert.match(mapper, /job\.status !== "completed"/);
  const resume = source.slice(source.indexOf("const resumeChat ="), source.indexOf("const selectAllPlatforms ="));
  assert.match(resume, /requestSavedChatPlan/);
  assert.match(resume, /plannerRequestGeneration\.current !== requestGeneration/);
  assert.match(resume, /setPlanVisible\(true\)/);
  assert.doesNotMatch(resume, /requestChatPlan\(/);
  assert.match(source, /`chat-automation-create-\$\{plannerReadback\.chat_job_id\}`/);
});

test("Brief keeps the last real delivery separate from current content and answer-only Chat has no creation blocker", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  assert.match(source, /latest_delivery_matches_current === false/);
  assert.match(source, /home\.company-brief\.last-delivery/);
  assert.match(source, /配信後に状態が更新されています/);
  assert.match(source, /serverPlan\.operation === "answer_question" && questions\.length === 0 \? "answer_only"/);
  assert.match(source, /creation_blocker: canCreate \|\| \(serverPlan\.operation === "answer_question" && questions\.length === 0\) \? null/);
  assert.doesNotMatch(source, /内容確認後に保存へ進みます/);
});

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
  assert.match(source, /status=\{chromeUnobserved \? "waiting" : browser\?\.chromeExtension\?\.status === "ready" \? "enabled" : browser\?\.chromeExtension\?\.targetScopedAvailable === true \? "draft" : "blocked"\}/);
});

test("Plugin add invokes the Zeabur Codex App Server install/auth handoff", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");

  assert.match(source, /truthful\.plugins\.add-auth\.\$\{item\.id\}/);
  assert.match(source, /const startPluginAddAndAuth =/);
  assert.match(source, /const serverAuthCapableCount = serverPluginEntries\.filter/);
  assert.match(source, /pluginId: item\.id \?\? item\.name/);
  assert.match(source, /plugin_id: pluginId/);
  assert.match(source, /Codex Server認証ポリシー/);
  assert.doesNotMatch(source, /Codex Server公式認証可/);
  assert.match(source, /codex\/app-server\/plugins\/install/);
  assert.match(source, /body\.auth\?\.authorization_urls/);
  assert.match(source, /const actionableUrls = urls\.filter\(isActionablePluginAuthUrl\)/);
  assert.match(source, /official_auth_surface_not_actionable/);
  assert.match(source, /const knownAuthUrls = pluginAuthUrls\[item\.id\] \?\? \[\]/);
  assert.match(source, /knownAuthSurfaceBlocker/);
  assert.match(source, /deliberate button press may request one fresh provider/u);
  assert.doesNotMatch(source, /disabled=\{!selectedCompanyId \|\| wizard\.complete \|\| Boolean\(wizard\.authSurfaceBlocker\)\}/);
  assert.match(source, /認証URLを再取得/u);
  assert.match(source, /const ensureCodexAppServerAuthForPlugin =/);
  assert.match(source, /codex\/app-server\/auth\/status/);
  assert.match(source, /codex\/app-server\/auth\/start/);
  assert.match(source, /plugins\/access\?plugin_id=/);
  assert.match(source, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(source, /window\.removeEventListener\("focus", onFocus\)/);
  assert.match(source, /attempts >= 12/);
  assert.match(source, /pluginAuthCompany\.current === companyId/);
  assert.match(source, /const verified = verifiedRef && registryVerified/);
  assert.match(source, /window\.open\(actionableUrls\[0\]/);
  assert.match(source, /公式接続・インストールページ/u);
  assert.match(serverSource, /\/api\/v1\/companies\/:companyId\/codex\/app-server\/plugins\/install/);
  assert.match(serverSource, /client\.installPlugin\(/);
  assert.match(serverSource, /codex_app_server_remote_required_for_plugin_install/);
  assert.match(serverSource, /external_oauth_action_executed: false/);
});

test("Plugin installation immediately refreshes registry and keeps auth on the installed identity", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const handler = source.slice(source.indexOf("const startPluginAddAndAuth"), source.indexOf("const refreshPluginAuth"));
  assert.match(handler, /setZeaburRegistry\(body\.registry\)/);
  assert.match(handler, /id: `zeabur:plugin:\$\{body\.plugin\.id\}`/);
  assert.match(handler, /setAuthWizardPluginId\(item\.id\)/);
  assert.ok(handler.indexOf("setZeaburRegistry(body.registry)") < handler.indexOf("await refreshPluginAuth(item)"));
  const server = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const route = server.slice(server.indexOf('app.post("/api/v1/companies/:companyId/codex/app-server/plugins/install"'), server.indexOf('app.post("/api/v1/companies/:companyId/codex/app-server/plugins/company-scope"'));
  assert.ok(route.indexOf("await client.installPlugin") < route.indexOf("registryAfterPluginInstall"));
  assert.match(route, /registry: updatedRecord\.registry/);
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
  assert.match(pluginsSource, /専用Serverには接続済みAppとして登録されています。実APIがトークン失効を返す場合/u);
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

test("Companion recovery guidance is ordered, truthful, and read-only", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const guideStart = source.indexOf("function CompanionRecoveryGuide");
  const guideEnd = source.indexOf("function TruthfulLanesPage", guideStart);
  assert.ok(guideStart >= 0 && guideEnd > guideStart, "Companion recovery guide source missing");
  const guide = source.slice(guideStart, guideEnd);
  for (const text of [
    "Reconnect",
    "Connected",
    "task-owned session",
    "fresh semantic＋visual readback",
    "前回操作の再クリック・再送ではない",
    "Company 1（company_2560580981cedfd106b66245）",
    "接続済みとは断定しません",
    "Owner SSOが必要な場合はReconnectとは別"
  ]) assert.ok(guide.includes(text), `missing guide text: ${text}`);
  assert.ok(guide.indexOf("Reconnect") < guide.indexOf("task-owned session"));
  assert.ok(guide.indexOf("task-owned session") < guide.indexOf("fresh semantic＋visual readback"));
  assert.ok(guide.indexOf("fresh semantic＋visual readback") < guide.indexOf("read-only確認を一回"));
  assert.doesNotMatch(guide, /mvpFetch|fetch\(|createSession|requestSession|onClick=|companion_authorized_transaction/);
  for (const blocker of ["profile_not_connected", "client_transport_disconnected", "extension_transport_disconnected", "unknown_effect", "unknown_effect_ledger_only", "ledger_only", "owner_sso_required"]) {
    assert.match(source, new RegExp(blocker));
  }
  assert.match(source, /home-browser-details[^>]*data-control-id="home\.browser-details"/);
  assert.match(source, /Browser Use \/ Worker \/ Companion復旧の詳細を開く/);
  const manifest = readFileSync(resolve(process.cwd(), "apps/web/src/controlManifest.ts"), "utf8");
  assert.match(manifest, /web-admission\.companion-recovery/);
  const guideText = readFileSync(resolve(process.cwd(), "outputs/aos-user-guide.md"), "utf8");
  assert.ok(guideText.indexOf("Reconnect") < guideText.indexOf("新しいtask-owned sessionを開きます", guideText.indexOf("Reconnect")));
  assert.match(guideText, /前回操作の再クリック・再送/);
  assert.match(guideText, /owner_sso_required.*Reconnectで解除されない/);
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
  assert.match(chatSource, /void readMvpStateWithRetry\("ui"(?:, \{ origin: "codex_probe_refresh" \})?\)/);
  assert.match(chatSource, /state readback未確認=\$\{publicBlockerSummary\(exact\)\}/);
  assert.match(chatSource, /Codex App Server接続状態: \$\{appServerStatusLabel\}/);
  assert.match(chatSource, /planner_operation === "answer_question" && !plan.questions.length/);
  assert.match(chatSource, /visiblePlanQuestions.length > 0 && <div className="question-box">/);
  assert.match(chatSource, /直近の会話で応答確認/);
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
  assert.match(source, /Mac workerのCompanion同一Run readback待ち（認証・画面状態は未確認）/);
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
  assert.match(source, /この処理の実行承認待ちです/);
  assert.match(source, /承認が却下されたため、このRunは実行前に停止しました/);
  assert.match(source, /承認が取り消されたため、このRunは実行前に停止しました/);
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
  assert.match(source, /disabled=\{busy \|\| Boolean\(pendingFeedback\) \|\| readOnlyEvidenceMode \|\| !sensitiveConfirmed\}/);
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
  assert.match(recoverySource, /const selectedRunIsScoped = companyRuns\.some/);
  assert.match(recoverySource, /未照合のRunは表示・操作しません/);
  assert.doesNotMatch(recoverySource, /!companyRuns\.some\(\(run: any\) => run\.id === requestedRunId\).*<option/u);
  assert.doesNotMatch(recoverySource, /const canCancel = \["reconciliation_required", "timed_out"\]/);
});

test("portable recovery GET requires the exact company and Run", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("async function requestPortableRunRecovery("), source.indexOf("function portableRecoveryReason("));
  const calls: string[] = [];
  let row = { schema: "aos.portable_run_recovery.v1", company_id: "company-1", run_id: "run-1", readback_token: "a".repeat(64) };
  const request = runInNewContext(transpileModule(fragment + "\nrequestPortableRunRecovery;", {}).outputText,
    { fetchApiJson: async (path: string) => { calls.push(path); return { recovery: row }; } });
  assert.equal((await request("company-1", "run-1")).run_id, "run-1");
  assert.equal(calls[0], "/api/v1/companies/company-1/runs/run-1/recovery");
  row = { ...row, company_id: "foreign" };
  await assert.rejects(() => request("company-1", "run-1"), /readback_mismatch/u);
  row = { ...row, company_id: "company-1", run_id: "different-run" };
  await assert.rejects(() => request("company-1", "run-1"), /readback_mismatch/u);
});

test("portable recovery submits once and uses GET-only reconciliation after an uncertain response", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const page = source.slice(source.indexOf("function TruthfulRecoveryPage("), source.indexOf("function TruthfulPluginsPage("));
  const readStart = page.indexOf("  const refreshRun =");
  const mutateStart = page.indexOf("  const mutateRun =");
  const fragment = page.slice(readStart, page.indexOf("  useEffect(", readStart))
    + page.slice(mutateStart, page.indexOf("  useEffect(", mutateStart));
  const requests: any[] = [];
  const notes: string[] = [];
  let gets = 0;
  let lostResponse = false;
  let mismatch = false;
  const saved = { schema: "aos.portable_run_recovery.v1", company_id: "company-1", run_id: "run-1",
    readback_token: "a".repeat(64), status: "cancelled", can_cancel: false, can_retry: false,
    requires_fresh_approval: true, retry: { run_id: "child-1", result_confirmed: true } };
  const context: any = { companyId: "company-1", requestedRunId: "run-1", recoveryReadStatus: "ready", canMutateJob: true,
    runReadbackRequired: false, runMutationRef: { current: false }, recoveryReadGeneration: { current: 0 },
    recovery: { ...saved, can_cancel: true, can_retry: true }, actionStamp: () => "now", publicBlockerSummary: (value: unknown) => value,
    setRecovery: (value: any) => { context.recovery = value; },
    setRecoveryReadStatus: (value: string) => { context.recoveryReadStatus = value; },
    setRunReadbackRequired: (value: boolean) => { context.runReadbackRequired = value; },
    setRunActionBusy() {}, setRunNote: (value: string) => notes.push(value),
    requestPortableRunRecovery: async () => { gets++; return mismatch ? { ...saved, retry: { run_id: "wrong-child", result_confirmed: true } } : saved; },
    mvpFetch: async (path: string, options: any) => {
      requests.push({ path, options });
      if (lostResponse) throw Error("lost_response");
      return { ok: true, json: async () => ({ retry_run: { id: "child-1" } }) };
    } };
  const api = runInNewContext(transpileModule(fragment + "\n({mutate:mutateRun,refresh:refreshRun});", {}).outputText, context);
  await Promise.all([api.mutate("cancel"), api.mutate("cancel")]);
  assert.equal(requests.length, 1);
  assert.equal(gets, 1);
  assert.match(notes.at(-1)!, /キャンセル保存/u);
  context.recovery = { ...saved, can_retry: true };
  lostResponse = true;
  await api.mutate("retry");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers["idempotency-key"], "portable-retry-run-1");
  assert.equal(context.runReadbackRequired, true);
  await api.mutate("retry");
  assert.equal(requests.length, 2, "uncertain request is not resent");
  await api.refresh();
  assert.equal(gets, 2);
  assert.equal(requests.length, 2, "readback-only recovery performs no POST");
  assert.equal(context.runReadbackRequired, false);
  assert.equal(context.recovery.retry.run_id, "child-1");
  lostResponse = false;
  mismatch = true;
  context.recovery = { ...saved, can_retry: true };
  await api.mutate("retry");
  assert.equal(context.runReadbackRequired, true, "mismatched child is never reported as confirmed");
});

test("portable recovery carries the selected Run and truthfully explains execution, approval and no replay", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const page = source.slice(source.indexOf("function TruthfulRecoveryPage("), source.indexOf("function TruthfulPluginsPage("));
  assert.match(source, /recovery\?run_id=\$\{encodeURIComponent\(runId\)\}/u);
  assert.match(page, /runMutationRef\.current \|\| runReadbackRequired/u);
  assert.match(page, /同じRunを照合/u);
  assert.match(page, /旧承認は再利用しません/u);
  assert.match(page, /外部結果不明・実行中の処理は再送しません/u);
  assert.match(page, /recoveryReadStatus !== "ready"/u);
  assert.match(page, /再試行Runの結果を開く/u);
  assert.doesNotMatch(page, /title="外部操作" value="実行しない"/u);
});

test("Runs and Recovery do not cancel reconciliation-required jobs", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const runsSource = source.slice(source.indexOf("function RunsPage"), source.indexOf("function PcStatusPage"));
  assert.match(runsSource, /\["queued", "leased", "timed_out"\]\.includes\(selectedJob\.status\)/);
  assert.doesNotMatch(runsSource, /\["queued", "leased", "reconciliation_required", "timed_out"\]\.includes\(selectedJob\.status\)/);
});

test("Run detail fetches an exact company-owned run and exposes only same-run proof viewing", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helper = source.slice(source.indexOf("async function requestCompanyRunDetail("), source.indexOf("function TruthfulRunDetailPage("));
  const calls: string[] = [];
  let fixture: any = {
    run: { id: "run-1", company_id: "company-1" },
    steps: [{ id: "s1", run_id: "run-1", company_id: "company-1" }, { id: "s2", run_id: "other" }],
    proofs: [{ id: "p1", run_id: "run-1", company_id: "company-1", can_open: true }, { id: "p2", run_id: "run-1", company_id: "foreign" }]
  };
  const request = runInNewContext(transpileModule(helper + "\nrequestCompanyRunDetail;", {}).outputText, {
    fetchApiJson: async (url: string) => { calls.push(url); return fixture; }
  }, { timeout: 1000 });
  const result = await request("company-1", "run-1");
  assert.deepEqual(calls, ["/api/v1/companies/company-1/runs/run-1"]);
  assert.equal(result.steps.length, 1);
  assert.equal(result.proofs.length, 1);
  fixture = { ...fixture, run: { id: "run-1", company_id: "foreign" } };
  await assert.rejects(request("company-1", "run-1"), /run_detail_company_scope_mismatch/);
  fixture = { ...fixture, run: { id: "other", company_id: "company-1" } };
  await assert.rejects(request("company-1", "run-1"), /run_detail_company_scope_mismatch/);
  const page = source.slice(source.indexOf("function TruthfulRunDetailPage("), source.indexOf("function TruthfulRecoveryPage("));
  assert.match(page, /view\.id !== selectedProofId \|\| view\.run_id !== runId/);
  assert.match(page, /return \(\) => controller\.abort\(\)/);
  assert.match(page, /proofView\?\.run_id === runId && proofView\.id === selectedProofId/);
  assert.match(page, /runBlocker === "-" \? "なし"/);
  assert.match(page, /安全に開く/);
  assert.doesNotMatch(page, /method: "POST"|window\.open|dangerouslySetInnerHTML/);
});

test("Run detail does not let stored Proof imply business completion", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulRunDetailPage");
  const end = source.indexOf("function TruthfulRecoveryPage", start);
  assert.ok(start >= 0 && end > start, "run detail page source missing");
  const runDetailSource = source.slice(start, end);

  assert.match(runDetailSource, /"業務完了判定"/);
  assert.match(runDetailSource, /externalAction\.executed === false/);
  assert.match(runDetailSource, /確認記録はreadbackの記録です/);
  assert.match(runDetailSource, /provider receipt・source sync・reconciliation/);
  assert.match(source, /function proofExternalActionState\(proof: any\)/);
  assert.match(runDetailSource, /runExternalActionReadback\(run, proofs\)/);
  assert.match(source, /\.\.\.proofs\.map\(proofExternalActionState\)/);
});

test("Run detail polling is serial, bounded, abortable and reads only the same Run", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function watchCompanyRunDetail("), source.indexOf("function verifiedBusinessReceiptForRun("));
  const timers = new Map<number, () => void>();
  const updates: any[] = [];
  const errors: unknown[] = [];
  const calls: string[] = [];
  let statuses = ["queued", "running", "complete"];
  let fail = false;
  let lastId = 0;
  const watch = runInNewContext(transpileModule(fragment + "\nwatchCompanyRunDetail;", {}).outputText, {
    window: { setTimeout: (fn: () => void) => { const id = ++lastId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) },
    isRunActiveStatus: (value: string) => ["queued", "running"].includes(value),
    requestCompanyRunDetail: async (company: string, run: string) => { calls.push(`${company}:${run}`); if (fail) throw new Error("network_lost"); return { run: { id: run, status: statuses.shift() ?? "running" } }; }
  }, { timeout: 1000 });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const tick = async () => { const first = [...timers][0]; if (first) { timers.delete(first[0]); first[1](); } await flush(); };
  const controller = new AbortController();
  const stop = watch("c1", "r1", controller.signal, (detail: any, checkedAt: string, watching: boolean) => updates.push({ status: detail.run.status, checkedAt, watching }), (error: unknown) => errors.push(error));
  await flush();
  assert.equal(calls.length, 1);
  await tick(); await tick();
  assert.deepEqual(updates.map((item) => item.status), ["queued", "running", "complete"]);
  assert.equal(timers.size, 0);
  assert.equal(updates.at(-1).watching, false);
  assert.ok(updates.every((item) => Number.isFinite(Date.parse(item.checkedAt))));
  assert.ok(calls.every((value) => value === "c1:r1"));
  stop();
  statuses = ["queued"];
  const stopError = watch("c1", "r1", controller.signal, (detail: any) => updates.push({ status: detail.run.status }), (error: unknown) => errors.push(error));
  await flush(); fail = true; await tick();
  assert.equal(errors.length, 1);
  assert.equal(updates.at(-1).status, "queued", "last verified data is retained on failure");
  assert.equal(timers.size, 0, "network errors do not start an automatic retry loop");
  stopError(); fail = false; statuses = [];
  const before = calls.length;
  const stopBounded = watch("c1", "r1", controller.signal, () => {}, () => {});
  await flush();
  for (let i = 0; i < 130; i++) await tick();
  assert.equal(calls.length - before, 120);
  assert.equal(timers.size, 0);
  stopBounded();
  const abort = new AbortController();
  const beforeUpdates = updates.length;
  const stopAbort = watch("c1", "r1", abort.signal, (detail: any) => updates.push(detail), () => {});
  abort.abort(); stopAbort(); await flush();
  assert.equal(updates.length, beforeUpdates);
  assert.equal(timers.size, 0);
  assert.doesNotMatch(fragment, /POST|PUT|retry|startRun/);
});

test("Gmail result counts need a same-company read-only receipt and disclose truncated details", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function verifiedGmailReviewForRun("), source.indexOf("function TruthfulRunDetailPage("));
  const verify = runInNewContext(transpileModule(fragment + "\nverifiedGmailReviewForRun;", {}).outputText, {
    parseJsonRecord: (value: string) => JSON.parse(value), isRunCompletedStatus: (value: string) => value === "complete", redactSensitiveText: (value: string) => value
  }, { timeout: 1000 });
  const result: any = { run_id: "r1", company_id: "c1", status: "complete", exact_blocker: null, provider_read_observed: true,
    messages_sent: false, provider_drafts_created: false, external_action_executed: false,
    diagnostics: { fetched_count: 100, item_count: 100, unique_id_count: 100, reply_candidate_count: 0 }, review: { items: Array.from({ length: 20 }, () => ({})) } };
  const receipt: any = { run_id: "r1", status: "complete", workflow_id: "email-review-reply", effects_mode: "read_only",
    read_only_proof_verified: true, same_run_receipt: true, readback_verified: true, cleanup_verified: true, external_action_executed: false,
    adapter_result: { local_receipt: { review: result } } };
  const makeRun = (next = receipt) => ({ id: "r1", company_id: "c1", status: "complete", metadata_json: JSON.stringify({ remote_worker_receipt: next }) });
  const counts = verify(makeRun());
  assert.equal(counts.fetched, 100);
  assert.equal(counts.proposals, 0);
  assert.equal(counts.items, null, "truncated metadata cannot become 100 visible summaries");
  assert.equal(verify({ ...makeRun(), company_id: "other" }), null);
  assert.equal(verify({ ...makeRun(), status: "queued" }), null);
  for (const field of ["read_only_proof_verified", "same_run_receipt", "readback_verified", "cleanup_verified"]) assert.equal(verify(makeRun({ ...receipt, [field]: false })), null);
  assert.equal(verify(makeRun({ ...receipt, external_action_executed: true })), null);
  for (const field of ["messages_sent", "provider_drafts_created", "external_action_executed"]) {
    assert.equal(verify(makeRun({ ...receipt, adapter_result: { local_receipt: { review: { ...result, [field]: true } } } })), null);
  }
  result.diagnostics.reply_candidate_count = 6;
  assert.equal(verify(makeRun()), null);
  result.diagnostics.reply_candidate_count = 1;
  result.review.items = Array.from({ length: 100 }, (_, i) => ({ message_id: `m${i}`, category: "確認", summary: `内容${i}`, reply_candidate: i === 0 ? "未送信の案" : null }));
  assert.equal(verify(makeRun()).items.length, 100);
  assert.equal(verify(makeRun()).items[0].reply, "未送信の案");
  result.review.items[1].message_id = "m0";
  assert.equal(verify(makeRun()).items, null);
  result.review_hash = "a".repeat(64);
  const repairedRows = Array.from({ length: 100 }, (_, i) => ({ message_id: `m${i}`, category: "確認", summary: `内容${i}`, reply_candidate: i === 0 ? "未送信の案" : null }));
  const synced: any = { schema: "aos.gmail_review_source_sync.v1", run_id: "r1", company_id: "c1", source_review_hash: result.review_hash,
    review_result: { ...result, review: { items: repairedRows } } };
  const repairedRun = (value = synced) => ({ ...makeRun(), metadata_json: JSON.stringify({ remote_worker_receipt: receipt, gmail_review_source_sync: value }) });
  assert.equal(verify(repairedRun()).items.length, 100);
  for (const override of [{ run_id: "other" }, { company_id: "other" }, { source_review_hash: "b".repeat(64) },
    { review_result: { ...synced.review_result, messages_sent: true } }]) assert.equal(verify(repairedRun({ ...synced, ...override })).items, null);
});

test("Run business result requires the server-verified same-run receipt and preserves the limited effect scope", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const helpers = source.slice(source.indexOf("function verifiedBusinessReceiptForRun("), source.indexOf("function TruthfulRunDetailPage("));
  const api = runInNewContext(transpileModule(helpers + "\n({verify: verifiedBusinessReceiptForRun, summary: businessReceiptSummary});", {}).outputText, {
    parseJsonRecord: (raw: unknown) => typeof raw === "string" ? JSON.parse(raw) : raw ?? {},
    isRunCompletedStatus: (status: string) => ["complete", "completed"].includes(status)
  }, { timeout: 1000 });
  const receipt: any = {
    run_id: "run-1", status: "complete", workflow_id: "daily-ai-research-source-sync",
    business_proof_verified: true, same_run_receipt: true, same_run_source_sync: true, readback_verified: true, cleanup_verified: true,
    adapter_result: { business_completion_verified: true, remote_verified: true, local_receipt: { full_publish_completed: false, generation_performed: false } },
    approval_receipt: { binding: { company_id: "company-1" } }
  };
  const makeRun = (next: any = receipt) => ({ id: "run-1", status: "complete", company_id: "company-1", metadata_json: JSON.stringify({ remote_worker_receipt: next }) });
  assert.ok(api.verify(makeRun()));
  assert.equal(api.summary(api.verify(makeRun())), "調査・既存Sheets同期を確認（画像生成・公開なし）");
  assert.equal(api.verify({ ...makeRun(), status: "running" }), null);
  assert.equal(api.verify({ ...makeRun(), company_id: "foreign-company" }), null);
  assert.equal(api.verify({ ...makeRun(), metadata_json: "{}" }), null, "complete plus stored proof is insufficient");
  for (const field of ["business_proof_verified", "same_run_receipt", "same_run_source_sync", "readback_verified", "cleanup_verified"]) {
    assert.equal(api.verify(makeRun({ ...receipt, [field]: false })), null, field);
  }
  assert.equal(api.verify(makeRun({ ...receipt, run_id: "foreign-run" })), null);
  assert.equal(api.verify(makeRun({ ...receipt, adapter_result: { ...receipt.adapter_result, remote_verified: false } })), null);
  assert.equal(api.verify(makeRun({ ...receipt, approval_receipt: undefined })), null);
  const page = source.slice(source.indexOf("function TruthfulRunDetailPage("), source.indexOf("function TruthfulRecoveryPage("));
  assert.match(page, /currentDetail \? verifiedBusinessReceiptForRun\(run\) : null/);
  assert.match(page, /あり（照合済み）/);
});

test("Run detail parses metadata before reading the external-effect boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function TruthfulRunDetailPage");
  const end = source.indexOf("function TruthfulRecoveryPage", start);
  assert.ok(start >= 0 && end > start, "run detail page source missing");
  const helperStart = source.indexOf("function runExternalActionReadback(");
  const helperEnd = source.indexOf("function TruthfulArtifactsPage(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "effect readback helper missing");
  const helper = source.slice(helperStart, helperEnd);
  const metadataDeclaration = helper.indexOf("const metadata = parseJsonRecord(run?.metadata_json);");
  const metadataRead = helper.indexOf("metadata.external_action_executed");
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
  assert.match(lanesSource, /登録Lane定義の旧runner名は互換性のため別のworkflow-owned契約/);
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
  assert.match(pageSource, /登録workflowの次回runは選択backendへ束縛されます/);
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

test("Memory and Artifacts distinguish in-flight detail readback from terminal failure", async () => {
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  for (const title of ["保存情報を確認中", "成果物を確認中"]) {
    const marker = ` ? <ReadbackState title="${title}"`;
    const end = source.indexOf(marker);
    assert.ok(end > 0);
    const start = source.lastIndexOf("{model.mvpLoadStatus", end);
    const expression = source.slice(start + 1, end);
    const loading = (status: string, blocker: string | null) => runInNewContext(expression, {
      model: { mvpLoadStatus: status, mvpLoadBlocker: blocker },
    });
    assert.equal(loading("loading", null), true);
    assert.equal(loading("degraded", "mvp_state_detail_readback_pending"), true);
    assert.equal(loading("degraded", "mvp_state_detail_readback_timeout"), false);
    assert.equal(loading("error", "mvp_state_detail_readback_pending"), false);
    assert.equal(loading("ready", null), false);
    assert.match(source.slice(end, end + 500), /model\.mvpLoadStatus !== "ready"/);
  }
  assert.match(source, /\[route, automationRows, createdTemplates, mvpState, mvpLoadStatus, mvpLoadBlocker, feedbackReadback, feedbackReadStatus\]/);
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

  assert.match(builderSource, /builder\.schedule\.kind[\s\S]*disabled=\{scheduleSaving \|\| !persistedAutomation \|\| !builderEditable\}/);
  assert.match(builderSource, /builder\.schedule\.timezone[\s\S]*disabled=\{scheduleSaving \|\| !persistedAutomation \|\| !builderEditable\}/);
  assert.match(builderSource, /controlId="builder\.schedule\.save"[\s\S]*disabled=\{scheduleSaving \|\| !persistedAutomation \|\| !builderEditable\}/);
  assert.match(builderSource, /実行経路はまだ確認できていません。保存済み仕様を実行済みとは扱いません/);
});

test("initial UI state uses a smaller projection while normal readbacks stay full", () => {
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  assert.match(appSource, /readMvpStateWithRetry\(projection, \{ fresh: true, companyId: scopedCompanyId, origin: "route_detail", signal: controller\.signal \}\)/);
  assert.match(appSource, /if \(projection !== "full"\) query\.set\("projection", projection\)/);
  assert.match(appSource, /query\.set\("fresh", "1"\)/);
  assert.match(serverSource, /req\.query\.projection === "summary"[\s\S]*req\.query\.projection === "ui"/);
  assert.match(serverSource, /projectMvpStateForUi\(result\.state\)/);
});

test("Chat can show a cached summary before detail readback while keeping mutations fail-closed", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /const canRenderCachedReadOnlySurface = hasCachedCompanyScope/);
  assert.match(source, /canRenderCachedCompanySurface \|\| currentPath === "#\/chat"/);
  assert.match(source, /readMvpStateWithRetry\("summary", \{ fresh: true, companyId: scopedCompanyId, origin: "route_summary", signal: controller\.signal \}\)[\s\S]*return readDetailState\(\)/);
  assert.match(source, /直近のsummary readbackを表示しています。会社scopeと確認用ショートカットは使えますが、詳細readbackが完了するまで保存・実行は停止しています/);
  assert.match(source, /targetProjectIsVerified = model\.mvpLoadStatus === "ready"/);
});

test("Chat detail readback uses its bounded projection instead of the broad UI fan-out", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");

  assert.match(source, /const projection = routeName === "#\/"[\s\S]*routeName === "#\/chat" \? "chat" : "ui"/);
  assert.match(source, /readMvpStateWithRetry\(projection, \{ fresh: true, companyId: scopedCompanyId, origin: "route_detail", signal: controller\.signal \}\)/);
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
  assert.match(panelSource, /today_blocked_count/);
  assert.match(panelSource, /const historicalBlockedCount = Math\.max\(0, blockedCount - todayBlockedCount\)/);
  assert.match(panelSource, /: todayBlockedCount/);
  assert.doesNotMatch(panelSource, /: blockedCount\s*\?/);
  assert.match(panelSource, /今日の\$\{todayBlockedCount\}件のRun/);
  assert.match(panelSource, /今日の停止Runはありません \/ 過去の停止記録/);
  assert.match(panelSource, /履歴queue \$\{workerQueueHistoricalCount\}件は再利用しません/);
  assert.match(panelSource, /新しいidempotencyでread-only確認/);
  assert.match(source, /記録上未完 Run \$\{queuedRunCount\} \/ fresh queue \$\{homeQueueCurrentCount\} \/ historical \$\{homeQueueHistoricalCount\}/);
  assert.match(source, /status: homeQueueCurrentCount \? "running" : homeTodayBlockedCount \? "blocked" : "enabled"/);
  assert.match(panelSource, /!remoteWorkerVerified && \(runtime\?\.status === "blocked"/);
});

test("Run detail preserves positive proof and shows a missing business receipt as unknown", async () => {
  const { transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const fragment = source.slice(source.indexOf("function parseJsonRecord("), source.indexOf("function TruthfulArtifactsPage("));
  const readback = runInNewContext(transpileModule(fragment + "\nrunExternalActionReadback;", {}).outputText);
  const legacyRun = { metadata_json: JSON.stringify({ exact_blocker: "portable_remote_claim_expired_without_receipt", external_action_executed: false, remote_worker_claim: { execution_mode: "business_effect" } }) };
  assert.equal(readback(legacyRun, []).executed, null);
  assert.equal(readback(legacyRun, []).unknown, true);
  const positive = readback(legacyRun, [{ external_action_executed: false, metadata_json: JSON.stringify({ external_action_executed: true }) }]);
  assert.equal(positive.executed, true);
  assert.equal(positive.unknown, true);
  const readonly = readback({ metadata_json: JSON.stringify({ external_action_executed: false, exact_blocker: "portable_remote_claim_expired_without_receipt", remote_worker_claim: { execution_mode: "read_only" } }) }, []);
  assert.equal(readonly.executed, false);
  assert.equal(readonly.unknown, false);
  const page = source.slice(source.indexOf("function TruthfulRunDetailPage("), source.indexOf("function TruthfulRecoveryPage("));
  assert.match(page, /結果未確認（要照合・再送不可）/);
  assert.match(page, /同じRunのworker記録と実際の保存先を照合/);
  assert.match(source, /ブラウザを使う処理の確認です/);
  assert.doesNotMatch(source, /今すぐ必要なこと/);
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
  assert.match(runsSource, /const publicRunHistoryBlocker = \(run: any\) => publicRunBlockerSummary\(run, viewState\) \|\| publicRunBlockerSummary\(run\);/);
  assert.match(runsSource, /publicRunHistoryBlocker\(run\)/);
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
  assert.match(source, /withMvpDetailReadbackTimeout\([\s\S]*readMvpStateWithRetry\(projection, \{ fresh: true, companyId: scopedCompanyId, origin: "route_detail", signal: controller\.signal \}\)/);
  assert.match(source, /const readDetailState = async \(\) => \{[\s\S]*const auth = await authPromise;[\s\S]*return readDetailProjection\(\);/);
  assert.match(source, /async function readMvpStateWithRetry\(projection: "full" \| "ui" \| "summary" \| "chat" = "ui", options: \{ fresh\?: boolean; companyId\?: string; origin\?: string; signal\?: AbortSignal \} = \{ fresh: true \}\)/);
  assert.match(source, /const routeScopedCompanyId = safeProjectId\(projectSlugFromRoute\(route\)\) \|\| undefined;/);
  assert.match(source, /readMvpStateWithRetry\("ui", \{ fresh: true, companyId: routeScopedCompanyId, origin: "auth_retry" \}\)/);
  assert.match(source, /function assertMvpStateReadbackScope\(state: MvpState, projection:/);
  assert.match(source, /mvp_state_company_scope_mismatch/);
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
  assert.match(source, /workflow-owned resource/);
  assert.match(source, /profileName/);
});

test("PC status separates persisted heartbeat from same-host remote worker and AOS browser resource readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function PcStatusPage");
  const end = source.indexOf("function TemplatesPage", start);
  assert.ok(start >= 0 && end > start, "PC status source missing");
  const pcSource = source.slice(start, end);

  assert.match(pcSource, /Portable remote worker process/);
  assert.match(pcSource, /Queue scope/);
  assert.match(pcSource, /local_sqlite/);
  assert.match(pcSource, /heartbeat・queue claim・receipt・source sync/);
  assert.match(pcSource, /AOS browser resource readback/);
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

test("installed App connection pages remain available for expired provider tokens", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const refresh = source.slice(source.indexOf("const refreshPluginAuth ="), source.indexOf("const latestPluginAuthRefresh"));
  assert.match(refresh, /apps\.map\(\(app: any\) => app\.installUrl\)/);
  assert.match(refresh, /isActionablePluginAuthUrl\(url\)/);
  assert.match(refresh, /setPluginAuthUrls/);
  assert.match(source, /実APIがトークン失効を返す場合/);
  assert.doesNotMatch(source, /Provider側の承認済みreadbackを確認しました/);
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
