import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

let chromium;
try {
  ({ chromium } = loadPlaywright());
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    exact_blocker: "playwright_node_module_missing",
    message: "Install Playwright or run with NODE_PATH pointing at a bundled node_modules that contains playwright.",
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
}

const baseUrl = (process.env.AUTOMATION_OS_PRODUCTION_URL || process.argv[2] || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-").replace(/-$/u, "");
const outDir = resolve(process.env.AUTOMATION_OS_REPLAY_QA_OUTPUT_DIR || join("/tmp", `automation-os-production-replay-qa-${stamp}`));
const allowWrite = process.env.AUTOMATION_OS_REPLAY_ALLOW_WRITE === "1";
const writeToken = (process.env.AUTOMATION_OS_WRITE_TOKEN || process.env.AUTOMATION_OS_REPLAY_WRITE_TOKEN || "").trim();
const writeWorkflowAllowlist = new Set(
  (process.env.AUTOMATION_OS_REPLAY_WRITE_WORKFLOWS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
const writeGuardProbeWorkflowId = "__replay_write_guard_probe_never_registered__";
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "videos"), { recursive: true });

const result = {
  ok: false,
  workflow: "automation-os-production-record-replay-qa",
  run_id: `replay_qa_${stamp}`,
  baseUrl,
  artifactRoot: basename(outDir),
  generatedAt: new Date().toISOString(),
  allowWrite,
  writeTokenAvailable: Boolean(writeToken),
  writeWorkflowAllowlist: [...writeWorkflowAllowlist],
  stages: [],
  api: {},
  ui: {},
  createReplay: null,
  registeredWorkflowReadback: null,
  failures: [],
  blockers: [],
  recommendations: []
};

await stage("api-readback", async () => {
  result.api.health = await getJson("/api/health");
  result.api.dashboard = await getPreferredApi([
    "/api/dashboard",
    "/api/mvp/state"
  ]);
  result.api.registeredWorkflows = await getPreferredApi([
    "/api/registered-workflows",
    "/api/mvp/registered-automations?project_id=project-a"
  ]);
  result.api.browserHealth = await getPreferredApi([
    "/api/browser/health",
    "/api/mvp/feedback"
  ], { optional: true });
  if (!result.api.dashboard.ok) result.blockers.push({ exact_blocker: "dashboard_unavailable", detail: "Neither /api/dashboard nor /api/mvp/state could be read." });
  if (!result.api.registeredWorkflows.ok) result.blockers.push({ exact_blocker: "registered_automations_unavailable", detail: "Neither /api/registered-workflows nor /api/mvp/registered-automations could be read." });
  result.registeredWorkflowReadback = {
    count: extractAutomationRows(rawBody(result.api.registeredWorkflows)).length,
    ids: extractAutomationRows(rawBody(result.api.registeredWorkflows)).map((row) => row.id).filter(Boolean),
    statuses: extractAutomationRows(rawBody(result.api.registeredWorkflows)).map((row) => ({
      id: row.id,
      status: row.status,
      runnerStatus: row.runnerStatus || row.last,
      boundary: row.boundaryLabel || row.boundary
    }))
  };
  if (!result.api.health.ok) fail("api_health_unreachable");
  if (!result.api.dashboard.ok && !result.api.registeredWorkflows.ok) fail("api_mvp_compatibility_unreachable");
  if (!result.api.registeredWorkflows.ok || !result.registeredWorkflowReadback.count) fail("registered_workflows_empty");
});

await stage("create-plan-api-replay", async () => {
  const createPlanRoutes = [
    "/api/create/plan",
    "/api/create/plan/jobs"
  ];
  const postCreatePlan = async (payload) => {
    let lastEntry = null;
    for (const route of createPlanRoutes) {
      const entry = await postJson(route, payload);
      lastEntry = { route, entry };
      if (entry.ok) {
        return { ...entry, selectedRoute: route, requestedRoutes: [...createPlanRoutes] };
      }
      if (entry.status !== 404) {
        return { ...entry, selectedRoute: route, requestedRoutes: [...createPlanRoutes] };
      }
    }
    return {
      ...(lastEntry?.entry || {}),
      ok: false,
      selectedRoute: lastEntry?.route || null,
      requestedRoutes: [...createPlanRoutes],
      compatibilityMode: true
    };
  };
  const cases = {
    capabilityQuestion: await postCreatePlan({
      messages: [
        { role: "user", text: "RunwayMCP" },
        { role: "assistant", text: "いつ動かし、失敗したら何分後に再確認しますか？" },
        { role: "user", text: "今の状況としてこのチャットはどんなことまでできる？" }
      ]
    }),
    correctionQuestion: await postCreatePlan({
      messages: [
        { role: "user", text: "RunwayMCP" },
        { role: "assistant", text: "いつ動かし、失敗したら何分後に再確認しますか？" },
        { role: "user", text: "違います。このチャットができることを書き出してください全て" }
      ]
    }),
    improvementRequest: await postCreatePlan({
      messages: [
        { role: "user", text: "このチャットでできることを増やしたい。UI改善相談です。" }
      ]
    }),
    registeredWorkflowAdjustment: await postCreatePlan({
      messages: [
        { role: "user", text: "Daily AIを毎朝8時にして、失敗したら30分後に再確認して。" }
      ]
    }),
    newReadOnlyAutomation: await postCreatePlan({
      messages: [
        { role: "user", text: "毎朝9時に公式サイトの価格を確認して、変化があったらスクショとURLを保存する自動化を作りたい。投稿や購入はしない。" }
      ]
    }),
    incompleteAutomationCreation: await postCreatePlan({
      messages: [
        { role: "user", text: "新しい自動化を作って" }
      ]
    }),
    dangerousExternalActionBoundary: await postCreatePlan({
      messages: [
        { role: "user", text: "求人応募を自動化したい。応募ボタンを押す直前で止めて、URL、画面、入力内容を証跡にして。" }
      ]
    }),
    secretOnlyStorage: await postCreatePlan({
      messages: [
        { role: "user", text: "OPENAI_API_KEY=sk-test1234567890abcdef1234567890abcdef1234567890 保存だけして。実行しないで。" }
      ]
    }),
    failureRepair: await postCreatePlan({
      messages: [
        { role: "user", text: "Job Application Managerの失敗を見て、原因と修正方針を教えて。まだ実行しない。" }
      ]
    })
  };
  result.api.createPlanCases = Object.fromEntries(Object.entries(cases).map(([name, entry]) => {
    const plan = rawBody(entry)?.plan || {};
    return [name, {
      ok: entry.ok,
      status: entry.status,
      intent: plan.intent,
      title: plan.title,
      openQuestionCount: Array.isArray(plan.openQuestions) ? plan.openQuestions.length : null,
      badTemplatePhrase: /いつ動かし|確認したいこと|実行手順に分解/.test(plan.reply || ""),
      replyHead: typeof plan.reply === "string" ? sanitizeDetail(plan.reply.slice(0, 240)) : ""
    }];
  }));

  const capability = result.api.createPlanCases.capabilityQuestion;
  const correction = result.api.createPlanCases.correctionQuestion;
  const improvement = result.api.createPlanCases.improvementRequest;
  const readOnlyAutomation = result.api.createPlanCases.newReadOnlyAutomation;
  const incompleteAutomation = result.api.createPlanCases.incompleteAutomationCreation;
  const dangerousBoundary = result.api.createPlanCases.dangerousExternalActionBoundary;
  const secretOnly = result.api.createPlanCases.secretOnlyStorage;
  if (capability.intent !== "answer_question" || capability.badTemplatePhrase) fail("create_capability_question_not_answer_only");
  if (correction.intent !== "answer_question" || correction.badTemplatePhrase) fail("create_correction_question_not_answer_only");
  if (improvement.intent !== "plan_workflow") fail("create_improvement_not_plan_workflow");
  if (readOnlyAutomation.intent !== "plan_workflow" || readOnlyAutomation.openQuestionCount !== 0) fail("create_read_only_automation_not_ready");
  if (incompleteAutomation.intent !== "plan_workflow" || incompleteAutomation.openQuestionCount < 1) fail("create_incomplete_automation_did_not_ask");
  if (incompleteAutomation.badTemplatePhrase) fail("create_incomplete_automation_template_drift");
  if (dangerousBoundary.intent !== "plan_workflow" || dangerousBoundary.openQuestionCount !== 0) fail("create_dangerous_boundary_not_ready");
  if (secretOnly.intent !== "plan_workflow" || secretOnly.openQuestionCount !== 0 || /sk-test/u.test(secretOnly.replyHead || "") || secretOnly.title !== "認証情報だけを安全に保存する") fail("create_secret_only_boundary_failed");
});

await stage("production-write-guard-readback", async () => {
  const blocked = await postJson(`/api/registered-workflows/${encodeURIComponent(writeGuardProbeWorkflowId)}/start`, {}, { includeWriteToken: false });
  const productionGuardRequired = rawBody(result.api.health)?.productionGuard?.required === true;
  const expectedStatus = productionGuardRequired ? [401, 423] : [401, 423, 404];
  result.api.writeGuardProbe = {
    workflowId: writeGuardProbeWorkflowId,
    ok: expectedStatus.includes(blocked.status),
    status: blocked.status,
    exactBlocker: rawBody(blocked)?.exactBlocker || rawBody(blocked)?.error || blocked.exact_blocker || "",
    bodyArtifact: blocked.bodyArtifact
  };
  if (!expectedStatus.includes(blocked.status)) fail("production_write_guard_did_not_block_without_token");
});

await stage("limited-write-run-readback", async () => {
  if (!allowWrite) return;
  if (!writeToken) {
    result.blockers.push({
      exact_blocker: "write_token_missing_for_limited_replay",
      detail: "AUTOMATION_OS_REPLAY_ALLOW_WRITE=1 was set, but no write token was provided through AUTOMATION_OS_REPLAY_WRITE_TOKEN or AUTOMATION_OS_WRITE_TOKEN."
    });
    fail("write_token_missing_for_limited_replay");
    return;
  }
  if (writeWorkflowAllowlist.size === 0) {
    result.blockers.push({
      exact_blocker: "write_workflow_allowlist_missing",
      detail: "Set AUTOMATION_OS_REPLAY_WRITE_WORKFLOWS to a comma-separated list of workflow ids before queueing production workflow starts."
    });
    fail("write_workflow_allowlist_missing");
    return;
  }
  const registeredWorkflows = extractAutomationRows(rawBody(result.api.registeredWorkflows));
  const workflows = Array.isArray(registeredWorkflows) ? registeredWorkflows : [];
  const selected = workflows.filter((workflow) => writeWorkflowAllowlist.has(workflow.id));
  const missingWorkflowIds = [...writeWorkflowAllowlist].filter((workflowId) => !selected.some((workflow) => workflow.id === workflowId));
  if (missingWorkflowIds.length) {
    for (const workflowId of missingWorkflowIds) fail(`write_workflow_not_found:${workflowId}`);
    return;
  }
  result.api.limitedWriteStarts = [];
  for (const workflow of selected) {
    const start = await postJson(`/api/registered-workflows/${encodeURIComponent(workflow.id)}/start`, {}, { includeWriteToken: true });
    const body = rawBody(start) || {};
    const runId = typeof body.runId === "string" ? body.runId : typeof body.run?.runId === "string" ? body.run.runId : "";
    const readback = runId ? await getJson(`/api/runs/${encodeURIComponent(runId)}`) : null;
    result.api.limitedWriteStarts.push({
      workflowId: workflow.id,
      startStatus: start.status,
      accepted: body.accepted === true,
      runId,
      queuedStatus: body.status || body.run?.status || "",
      workerProtocol: body.workerProtocol || "",
      nextAction: typeof body.nextAction === "string" ? sanitizeDetail(body.nextAction) : "",
      startBodyArtifact: start.bodyArtifact,
      readbackStatus: readback?.status ?? 0,
      readbackArtifact: readback?.bodyArtifact || ""
    });
    if (start.status !== 202 || body.accepted !== true || !runId) fail(`limited_write_start_failed:${workflow.id}`);
  }
});

await stage("route-visual-readback", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { label: "desktop", width: 1440, height: 1000 },
      { label: "mobile", width: 390, height: 844 }
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      let consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      for (const route of ["#home", "#create", "#schedule", "#runs", "#sources"]) {
        consoleErrors = [];
        const routeLabel = route.replace("#", "");
        await page.goto(`${baseUrl}/${route}`, { waitUntil: "networkidle" });
        await page.screenshot({ path: join(outDir, `${viewport.label}-${routeLabel}.png`), fullPage: true });
        const dom = await page.evaluate(() => ({
          url: location.href,
          bodyText: document.body.innerText.slice(0, 4000),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          headings: Array.from(document.querySelectorAll("h1,h2,h3")).map((el) => el.textContent || "").slice(0, 20)
        }));
        const routeArtifact = `${viewport.label}-${routeLabel}.json`;
        writeFileSync(join(outDir, routeArtifact), `${JSON.stringify({ viewport, route, dom, consoleErrors }, null, 2)}\n`);
        result.ui[`${viewport.label}:${routeLabel}`] = {
          url: dom.url,
          scrollWidth: dom.scrollWidth,
          clientWidth: dom.clientWidth,
          horizontalOverflow: dom.scrollWidth > dom.clientWidth,
          consoleErrorCount: consoleErrors.length,
          headings: dom.headings,
          artifact: routeArtifact,
          screenshot: `${viewport.label}-${routeLabel}.png`
        };
        if (dom.scrollWidth > dom.clientWidth) fail(`horizontal_overflow:${viewport.label}:${routeLabel}`);
        if (consoleErrors.length) fail(`console_errors:${viewport.label}:${routeLabel}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await stage("create-chat-ui-video-replay", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 530, height: 844 },
    recordVideo: { dir: join(outDir, "videos"), size: { width: 530, height: 844 } }
  });
  const page = await context.newPage();
  const video = page.video();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  let readback = null;
  try {
    await page.goto(`${baseUrl}/#create`, { waitUntil: "networkidle" });
    const freshButton = page.getByRole("button", { name: /新しい相談/u }).first();
    if (await freshButton.count()) {
      await freshButton.click();
      await page.waitForTimeout(500);
    }
    await sendCreate(page, "RunwayMCP");
    await sendCreate(page, "今の状況としてこのチャットはどんなことまでできる？");
    await sendCreate(page, "違います。このチャットができることを書き出してください全て");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, "create-chat-ui-video-replay-final.png"), fullPage: true });
    readback = await page.evaluate(() => {
      const latestAssistant = Array.from(document.querySelectorAll(".chat-message.assistant, [data-role=\"assistant\"], .assistant"))
        .map((el) => el.textContent || "")
        .pop() || document.body.innerText;
      return {
        url: location.href,
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).map((el) => el.textContent || ""),
        hasAnswerOnly: Boolean(document.querySelector(".conversation-brief.answer-only")),
        hasDecisionGuidance: Boolean(document.querySelector(".decision-guidance")),
        hasVisiblePlan: Boolean(document.querySelector(".visible-plan")),
        hasActionCards: Boolean(document.querySelector(".research-plan-actions")),
        latestHasCapabilityAnswer: /質問への回答|登録済み自動化の確認|履歴確認/u.test(latestAssistant),
        latestHasBadPlanningPhrase: /いつ動かし|確認したいこと|実行手順に分解/u.test(latestAssistant),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyText: document.body.innerText.slice(0, 5000)
      };
    });
  } finally {
    await context.close();
    await browser.close();
  }
  const videoPath = video ? await video.path().catch((error) => {
    writeErrorArtifact("create-chat-video-path", error);
    return "";
  }) : "";
  const videoExists = Boolean(videoPath && existsSync(videoPath));
  if (consoleErrors.length) {
    writeFileSync(join(outDir, "create-chat-ui-video-replay-console.json"), `${JSON.stringify({ consoleErrors }, null, 2)}\n`);
  }
  result.createReplay = {
    ...compactCreateReadback(readback),
    consoleErrorCount: consoleErrors.length,
    consoleErrorsArtifact: consoleErrors.length ? "create-chat-ui-video-replay-console.json" : "",
    screenshot: "create-chat-ui-video-replay-final.png",
    video: videoPath ? relativeArtifact(videoPath) : "",
    videoExists
  };
  if (!videoExists) fail("create_ui_video_missing");
  if (!readback?.hasAnswerOnly) fail("create_ui_answer_only_panel_missing");
  if (readback?.hasDecisionGuidance || readback?.hasVisiblePlan || readback?.hasActionCards) fail("create_ui_answer_question_still_shows_plan_actions");
  if (!readback?.latestHasCapabilityAnswer || readback?.latestHasBadPlanningPhrase) fail("create_ui_latest_answer_template_drift");
  if (readback && readback.scrollWidth > readback.clientWidth) fail("create_ui_horizontal_overflow");
  if (consoleErrors.length) fail("create_ui_console_errors");
});

if (!allowWrite) {
  result.blockers.push({
    exact_blocker: "write_actions_disabled_for_replay_qa",
    detail: "Registered workflow starts, scheduler mutations, external posting, sending, applying, billing, checkout, CAPTCHA, OTP, and identity verification were not executed. Set AUTOMATION_OS_REPLAY_ALLOW_WRITE=1 with AUTOMATION_OS_REPLAY_WRITE_WORKFLOWS only for an explicit write-run window with the production write token available."
  });
}

const healthBody = rawBody(result.api.health);
const aiRuntime = healthBody?.deployment?.aiRuntime ?? {};
if (aiRuntime.blocker) {
  result.recommendations.push({
    priority: "P0",
    area: "hosted-planner",
    issue: aiRuntime.blocker,
    action: "Use the Mac worker subscription planner lane, or connect a separate OpenAI Platform key only if hosted planning is explicitly required.",
    sourceReadback: {
      plannerExecutionMode: typeof aiRuntime.plannerExecutionMode === "string" ? aiRuntime.plannerExecutionMode : "",
      aiRuntimeBlocker: typeof aiRuntime.blocker === "string" ? aiRuntime.blocker : "",
      operatorInstruction: "Zeabur remains the control plane; planning execution belongs to the Mac worker unless hosted planning is explicitly configured."
    }
  });
}
if (aiRuntime.plannerExecutionMode === "mac_worker_subscription") {
  result.recommendations.push({
    priority: "P1",
    area: "planner-lane",
    issue: "Create planning is routed to the Mac worker subscription lane when no OpenAI API key is configured.",
    action: "Keep the Mac worker heartbeat visible and avoid presenting Zeabur as a standalone hosted AI planner.",
    sourceReadback: {
      plannerExecutionMode: aiRuntime.plannerExecutionMode,
      aiRuntimeBlocker: typeof aiRuntime.blocker === "string" ? aiRuntime.blocker : "",
      operatorInstruction: "The production UI may show saved state and planner job status, but subscription-backed planning is picked up by the Mac worker."
    }
  });
}

const browserHealthBody = rawBody(result.api.browserHealth);
if (browserHealthBody?.playwrightCli?.status === "missing") {
  result.recommendations.push({
    priority: "P0",
    area: "browser-lane",
    issue: "Zeabur cannot run local Playwright/browser automation itself.",
    action: "Keep browser execution on the Mac worker and make the UI say when the Mac worker is required.",
    sourceReadback: {
      playwrightCliStatus: String(browserHealthBody?.playwrightCli?.status || ""),
      browserUseCliStatus: String(browserHealthBody?.browserUseCli?.status || ""),
      operatorInstruction: "Browser automation, screenshots, local CDP lanes, cleanup, and external-service proof capture stay on the Mac worker."
    }
  });
}

result.ok = result.failures.length === 0;
writeFileSync(join(outDir, "replay-summary.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

async function stage(name, fn) {
  const startedAt = new Date().toISOString();
  const stageEntry = { name, startedAt, status: "running" };
  result.stages.push(stageEntry);
  try {
    await fn();
    stageEntry.status = "ok";
  } catch (error) {
    stageEntry.status = "blocked";
    stageEntry.exact_blocker = classifyError(name, error);
    stageEntry.errorArtifact = writeErrorArtifact(name, error);
    fail(`${name}:${stageEntry.exact_blocker}`);
  } finally {
    stageEntry.finishedAt = new Date().toISOString();
  }
}

async function getJson(route) {
  try {
    const response = await fetch(`${baseUrl}${route}`);
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep body null and let the caller record the invalid response.
    }
    const bodyArtifact = writeJsonArtifact(`api-${route.replace(/[^0-9A-Za-z]+/gu, "-") || "root"}.json`, body ?? { raw: text.slice(0, 2000) });
    const entry = {
      ok: response.ok && Boolean(body),
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      body: summarizeApiBody(route, body),
      bodyArtifact,
      bodyHead: sanitizeDetail(text.slice(0, 500))
    };
    Object.defineProperty(entry, "rawBody", { value: body, enumerable: false });
    return entry;
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      body: null,
      bodyHead: "",
      exact_blocker: `fetch_failed:${route}`,
      errorArtifact: writeErrorArtifact(`fetch-${route.replace(/[^0-9A-Za-z]+/gu, "-")}`, error)
    };
  }
}

async function postJson(route, payload, options = {}) {
  try {
    const headers = { "content-type": "application/json" };
    if (options.includeWriteToken && writeToken) headers["x-automation-os-token"] = writeToken;
    const response = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep body null and let assertions fail with a useful status/body head.
    }
    const bodyArtifact = writeJsonArtifact(`post-${route.replace(/[^0-9A-Za-z]+/gu, "-") || "root"}-${Date.now()}.json`, body ?? { raw: text.slice(0, 2000) });
    const entry = {
      ok: response.ok && Boolean(body),
      status: response.status,
      body: summarizePostBody(route, body),
      bodyArtifact,
      bodyHead: sanitizeDetail(text.slice(0, 500))
    };
    Object.defineProperty(entry, "rawBody", { value: body, enumerable: false });
    return entry;
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      bodyHead: "",
      exact_blocker: `fetch_failed:${route}`,
      errorArtifact: writeErrorArtifact(`fetch-${route.replace(/[^0-9A-Za-z]+/gu, "-")}`, error)
    };
  }
}

async function sendCreate(page, text) {
  const startButtons = [
    page.getByRole("button", { name: "新しい自動化" }).first(),
    page.getByRole("button", { name: "新しい相談" }).first()
  ];
  for (const button of startButtons) {
    if (await button.count()) {
      await button.click();
      await page.waitForTimeout(800);
      break;
    }
  }
  const candidates = [
    "textarea[aria-label=\"相談して計画する内容\"]",
    "textarea[aria-label=\"自動化リクエスト\"]",
    "textarea[placeholder*=\"相談\"]",
    "textarea[placeholder*=\"自動化\"]",
    "textarea",
    "input[aria-label=\"相談して計画する内容\"]",
    "input[aria-label=\"自動化リクエスト\"]",
    "input[placeholder*=\"相談\"]",
    "input[placeholder*=\"自動化\"]",
    "input[aria-label=\"画面検索\"]",
    "input[placeholder*=\"MVP state readback\"]",
    "input[type=\"text\"]"
  ];
  let input = null;
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      input = locator;
      break;
    }
  }
  if (!input) throw new Error("create_chat_input_not_found");
  await input.scrollIntoViewIfNeeded();
  await input.fill(text);
  await page.waitForTimeout(250);
  const sendButtons = page.getByRole("button", { name: /相談を送信|送信|実行|作成/u });
  const buttonCount = await sendButtons.count();
  let clicked = false;
  for (let index = 0; index < buttonCount; index += 1) {
    const button = sendButtons.nth(index);
    if (await button.isEnabled()) {
      await button.click();
      clicked = true;
      break;
    }
  }
  if (!clicked && buttonCount) {
    await input.press("Enter");
  } else {
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1800);
}

function fail(exactBlocker) {
  if (!result.failures.includes(exactBlocker)) result.failures.push(exactBlocker);
}

function classifyError(stageName, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/browserType\.launch|MachPortRendezvousServer|Target page, context or browser has been closed/u.test(message)) {
    return "playwright_launch_failed";
  }
  if (/fetch failed/u.test(message)) return `fetch_failed:${stageName}`;
  if (/Timeout/u.test(message)) return `timeout:${stageName}`;
  return `${stageName}_failed`;
}

function writeErrorArtifact(name, error) {
  const safeName = name.replace(/[^0-9A-Za-z._-]+/gu, "-").replace(/^-|-$/gu, "") || "error";
  const path = join(outDir, `${safeName}-error.txt`);
  const message = sanitizeDetail(error instanceof Error ? `${error.stack || error.message}` : String(error));
  writeFileSync(path, `${message}\n`, "utf8");
  return relativeArtifact(path);
}

function sanitizeDetail(value) {
  return value
    .replace(/\/Users\/[^\n\r"'<> ]+/gu, "[redacted-path]")
    .replace(/(?:\/private)?\/tmp\/[^\n\r"'<> ]+/gu, "[redacted-path]")
    .replace(/file:\/\/[^\s"'<>]+/gu, "[redacted-file-uri]")
    .replace(/https?:\/\/[^\s"'<>]+/gu, "[redacted-url]");
}

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire("playwright");
  } catch (localError) {
    const bundledModuleRoot = process.env.AUTOMATION_OS_PLAYWRIGHT_NODE_MODULES
      || join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
    const bundledPackage = join(bundledModuleRoot, "playwright", "package.json");
    if (existsSync(bundledPackage)) {
      return createRequire(bundledPackage)("playwright");
    }
    throw localError;
  }
}

function rawBody(entry) {
  return entry?.rawBody ?? null;
}

function writeJsonArtifact(name, value) {
  const safeName = name.replace(/[^0-9A-Za-z._-]+/gu, "-").replace(/^-|-$/gu, "") || "artifact.json";
  const path = join(outDir, safeName);
  writeFileSync(path, `${JSON.stringify(sanitizeArtifactValue(value), null, 2)}\n`, "utf8");
  return safeName;
}

function sanitizeArtifactValue(value, depth = 0) {
  if (depth > 8) return "[truncated-depth]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 200).map((item) => sanitizeArtifactValue(item, depth + 1));
    if (value.length > 200) items.push(`[truncated ${value.length - 200} items]`);
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeArtifactValue(item, depth + 1)]));
  }
  if (typeof value === "string") {
    const sanitized = sanitizeDetail(value);
    return sanitized.length > 20000 ? `${sanitized.slice(0, 20000)}...[truncated]` : sanitized;
  }
  return value;
}

function relativeArtifact(path) {
  const rel = relative(outDir, path);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : basename(path);
}

function summarizeApiBody(route, body) {
  if (!body || typeof body !== "object") return null;
  if (route === "/api/health") {
    return {
      ok: body.ok === true,
      database: body.database,
      productionGuard: body.productionGuard,
      deployment: body.deployment ? {
        commit: body.deployment.commit,
        version: body.deployment.version,
        plannerProvider: body.deployment.plannerProvider,
        aiRuntime: body.deployment.aiRuntime,
        assets: body.deployment.assets ? {
          indexFound: body.deployment.assets.indexFound,
          js: body.deployment.assets.js,
          css: body.deployment.assets.css
        } : undefined
      } : undefined
    };
  }
  if (route === "/api/dashboard") {
    return {
      runsCount: Array.isArray(body.runs) ? body.runs.length : 0,
      actionableRunsCount: Array.isArray(body.actionableRuns) ? body.actionableRuns.length : 0,
      registeredWorkflowsCount: Array.isArray(body.registeredWorkflows) ? body.registeredWorkflows.length : 0,
      localWorker: summarizeLocalWorker(body.localWorker)
    };
  }
  if (route === "/api/registered-workflows") {
    return {
      workflows: Array.isArray(body.workflows)
        ? body.workflows.map((row) => ({
            id: row.id,
            title: row.title || row.name,
            status: row.status,
            runnerStatus: row.runnerStatus,
            boundary: row.boundaryLabel || row.boundary
          }))
        : []
    };
  }
  if (route.startsWith("/api/mvp/registered-automations")) {
    return {
      count: typeof body.automation_count === "number" ? body.automation_count : 0,
      workflows: Array.isArray(body.automations)
        ? body.automations.map((row) => ({
            id: row.id,
            title: row.title || row.name,
            status: row.status,
            runnerStatus: row.last,
            boundary: row.boundaryLabel || row.boundary
          }))
        : []
    };
  }
  if (route === "/api/browser/health") {
    return {
      playwrightCli: body.playwrightCli ? { status: body.playwrightCli.status, available: body.playwrightCli.available } : undefined,
      browserUseCli: body.browserUseCli ? { status: body.browserUseCli.status, available: body.browserUseCli.available } : undefined,
      browserUseRecordingQa: body.browserUseRecordingQa ? { status: body.browserUseRecordingQa.status, exactBlocker: body.browserUseRecordingQa.exactBlocker } : undefined
    };
  }
  return body;
}

async function getPreferredApi(routes, options = {}) {
  const { optional = false } = options;
  const attempts = [];
  let lastEntry = null;
  for (const route of routes) {
    attempts.push(route);
    const entry = await getJson(route);
    lastEntry = entry;
    if (entry.ok) {
      const selected = { ...entry, requestedRoute: routes[0], selectedRoute: route, candidates: attempts };
      if (entry.rawBody) {
        Object.defineProperty(selected, "rawBody", { value: entry.rawBody, enumerable: false });
      }
      return selected;
    }
    if (entry.status === 404 || entry.status === 0) continue;
  }
  const failEntry = {
    ...(lastEntry || {}),
    ok: false,
    requestedRoute: routes[0],
    selectedRoute: null,
    candidates: attempts,
    compatibilityMode: true
  };
  if (lastEntry?.rawBody) {
    Object.defineProperty(failEntry, "rawBody", { value: lastEntry.rawBody, enumerable: false });
  }
  if (!optional || attempts.length === 0) {
    return failEntry;
  }
  return {
    ...failEntry,
    ok: false,
    compatibilityMode: true
  };
}

function extractAutomationRows(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body.automations)) return body.automations;
  if (Array.isArray(body.workflows)) return body.workflows;
  if (body.body && typeof body.body === "object") {
    if (Array.isArray(body.body.automations)) return body.body.automations;
    if (Array.isArray(body.body.workflows)) return body.body.workflows;
  }
  return [];
}

function summarizePostBody(route, body) {
  if (!body || typeof body !== "object") return null;
  if (route === "/api/create/plan") {
    const plan = body.plan || {};
    return {
      ok: body.ok,
      plan: {
        intent: plan.intent,
        title: plan.title,
        executionDecision: plan.executionDecision,
        openQuestionCount: Array.isArray(plan.openQuestions) ? plan.openQuestions.length : null,
        visibleStepCount: Array.isArray(plan.visibleSteps) ? plan.visibleSteps.length : null
      }
    };
  }
  return body;
}

function summarizeLocalWorker(worker) {
  if (!worker || typeof worker !== "object") return null;
  return {
    status: worker.status,
    label: worker.label,
    detail: typeof worker.detail === "string" ? sanitizeDetail(worker.detail).slice(0, 160) : "",
    processed: typeof worker.processed === "number" ? worker.processed : undefined,
    usesApiKey: worker.usesApiKey === true
  };
}

function compactCreateReadback(readback) {
  if (!readback) return {};
  return {
    url: readback.url,
    headings: readback.headings,
    hasAnswerOnly: readback.hasAnswerOnly,
    hasDecisionGuidance: readback.hasDecisionGuidance,
    hasVisiblePlan: readback.hasVisiblePlan,
    hasActionCards: readback.hasActionCards,
    latestHasCapabilityAnswer: readback.latestHasCapabilityAnswer,
    latestHasBadPlanningPhrase: readback.latestHasBadPlanningPhrase,
    scrollWidth: readback.scrollWidth,
    clientWidth: readback.clientWidth
  };
}
