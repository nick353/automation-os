#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const valueAfter = (flag, fallback = "") => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const usage = () =>
  [
    "Usage: node scripts/run_sns_multi_poster_ukiyoe_playwright_cli.mjs [options]",
    "",
    "Options:",
    "  --open-login-lane       Open the persistent visible SNS/X Chrome lane and exit.",
    "  --cdp-url <url>          Use an existing authenticated CDP lane.",
    "  --image-path <path>      Image to post.",
    "  --caption <text>         Caption text to post.",
    "  --run-id <id>            Stable run id for artifacts.",
    "  -h, --help               Show this help and exit without posting.",
  ].join("\n");

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

const sanitizeRunId = (value) =>
  String(value || "sns-multi-poster-run")
    .replace(/[^0-9A-Za-z_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "sns-multi-poster-run";
const asList = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const runId = sanitizeRunId(valueAfter("--run-id", process.env.AUTOMATION_OS_RUN_ID));
const outRoot = resolve(valueAfter("--out-root", join(process.cwd(), "data", "artifacts", "sns-multi-poster-ukiyoe")));
const imagePath = valueAfter("--image-path", process.env.SNS_MULTI_POSTER_IMAGE_PATH || "");
const caption = valueAfter("--caption", process.env.SNS_MULTI_POSTER_CAPTION || "");
const runDir = join(outRoot, "artifacts", "runs", runId);
mkdirSync(runDir, { recursive: true });

const stagePlanPath = join(runDir, "stage-plan.json");
const resultPath = join(runDir, "result.json");
const evidencePath = join(runDir, "human-input-required-with-evidence.json");
const approvedActions = asList(process.env.SNS_MULTI_POSTER_APPROVED_EXTERNAL_ACTIONS || "post,publish");
const hardStops = asList(process.env.SNS_MULTI_POSTER_HARD_STOPS || "billing,purchase,payment");
const requestedAction = String(process.env.SNS_MULTI_POSTER_REQUESTED_ACTION || "post,publish").toLowerCase();
const loginLanePort = Number(process.env.SNS_MULTI_POSTER_CDP_PORT || process.env.AUTOMATION_OS_SNS_MULTI_POSTER_CDP_PORT || 9339);
const loginLaneProfileDir =
  process.env.SNS_MULTI_POSTER_PROFILE_DIR ||
  process.env.AUTOMATION_OS_SNS_MULTI_POSTER_PROFILE_DIR ||
  "/Users/nichikatanaka/.sns-multi-poster-ukiyoe-playwright-chrome";
const loginLaneUrl = valueAfter("--login-url", process.env.SNS_MULTI_POSTER_LOGIN_URL || "https://x.com/home");
const cdpUrl =
  valueAfter("--cdp-url", "") ||
  process.env.SNS_MULTI_POSTER_CDP_URL ||
  process.env.AUTOMATION_OS_SNS_MULTI_POSTER_CDP_URL ||
  `http://127.0.0.1:${loginLanePort}`;
const playwrightBin = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI || "playwright";

const stages = [
  { stage: "validate-input", status: imagePath && caption ? "success" : "blocked" },
  { stage: "policy", status: "success", approved_external_actions: approvedActions, hard_stops: hardStops }
];

const finish = (result, exitCode = 0) => {
  const stagePlan = {
    status: result.status,
    run_id: runId,
    workflow_id: "sns-multi-poster-ukiyoe",
    image_path: imagePath,
    caption_length: caption.length,
    stages,
    external_action_executed: result.external_action_executed === true,
    exact_blocker: result.exact_blocker
  };
  writeFileSync(stagePlanPath, `${JSON.stringify(stagePlan, null, 2)}\n`);
  writeFileSync(resultPath, `${JSON.stringify({ ...result, stage_plan_path: stagePlanPath, result_path: resultPath }, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, stage_plan_path: stagePlanPath, result_path: resultPath }));
  process.exit(exitCode);
};

const cdpVersion = async (rawUrl) => {
  try {
    const response = await fetch(`${normalizeCdpUrl(rawUrl)}/json/version`);
    if (!response.ok) return { ok: false, status: response.status };
    const version = await response.json();
    return { ok: true, version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const openPersistentLoginLane = async () => {
  const versionBefore = await cdpVersion(`http://127.0.0.1:${loginLanePort}`);
  let launched = false;
  let pid = null;
  if (!versionBefore.ok) {
    mkdirSync(loginLaneProfileDir, { recursive: true });
    const chromeBin =
      process.env.AUTOMATION_OS_SNS_MULTI_POSTER_CHROME_BIN ||
      process.env.CHROME_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const child = spawn(
      chromeBin,
      [
        `--remote-debugging-port=${loginLanePort}`,
        `--user-data-dir=${loginLaneProfileDir}`,
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        loginLaneUrl,
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    launched = true;
    pid = child.pid || null;
    await delay(1500);
  }
  const versionAfter = await cdpVersion(`http://127.0.0.1:${loginLanePort}`);
  const payload = {
    status: versionAfter.ok ? "human_input_required" : "blocked",
    exact_blocker: versionAfter.ok
      ? "sns_multi_poster_login_handoff_open"
      : "sns_multi_poster_login_lane_unavailable",
    evidence_reason: "persistent_authenticated_lane_login_handoff",
    cdp_url: `http://127.0.0.1:${loginLanePort}`,
    profile_dir: loginLaneProfileDir,
    login_url: loginLaneUrl,
    launched,
    pid,
    next_action:
      "Log in once in the opened Chrome window. Future SNS/X runs reuse this user-data-dir and CDP port until the service expires the session.",
    version: versionAfter.version,
    external_action_executed: false,
  };
  stages.push({ stage: "persistent-login-lane", status: versionAfter.ok ? "human_input_required" : "blocked", exact_blocker: payload.exact_blocker });
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`);
  finish({
    status: versionAfter.ok ? "blocked" : "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_human_input_required_with_evidence",
    evidence_reason: payload.evidence_reason,
    evidence_path: evidencePath,
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href,
  });
};

if (hasFlag("--open-login-lane") || process.env.SNS_MULTI_POSTER_OPEN_LOGIN_LANE === "1") {
  await openPersistentLoginLane();
}

if (!imagePath || !caption) {
  stages.push({ stage: "input", status: "blocked", exact_blocker: "sns_multi_poster_input_required" });
  finish({
    status: "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_input_required",
    missing_inputs: [...(!imagePath ? ["SNS_MULTI_POSTER_IMAGE_PATH"] : []), ...(!caption ? ["SNS_MULTI_POSTER_CAPTION"] : [])],
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href
  });
}

if (!existsSync(imagePath)) {
  stages.push({ stage: "image-read", status: "blocked", exact_blocker: "sns_multi_poster_image_missing" });
  finish({
    status: "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_image_missing",
    image_path: imagePath,
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href
  });
}

const matchedHardStops = hardStops.filter((stop) => requestedAction.includes(stop));
if (matchedHardStops.length > 0) {
  stages.push({ stage: "hard-stop", status: "blocked", exact_blocker: "sns_multi_poster_billing_purchase_payment_hard_stop" });
  finish({
    status: "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_billing_purchase_payment_hard_stop",
    hard_stops: matchedHardStops,
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href
  });
}

if (!approvedActions.includes("post") || !approvedActions.includes("publish")) {
  stages.push({ stage: "approval-scope", status: "blocked", exact_blocker: "sns_multi_poster_post_publish_not_approved" });
  finish({
    status: "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_post_publish_not_approved",
    approved_external_actions: approvedActions,
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href
  });
}

if (process.env.SNS_MULTI_POSTER_FAKE_POST_SUCCESS === "1") {
  stages.push({ stage: "playwright-cli-post", status: "success", mode: "test-double" });
  finish({
    status: "success",
    run_id: runId,
    external_action_executed: true,
    posted: true,
    published: true,
    platform_results: [
      { platform: "instagram", status: "posted" },
      { platform: "threads", status: "posted_via_instagram" },
      { platform: "facebook", status: "posted_via_instagram" },
      { platform: "pinterest", status: "posted" },
      { platform: "x", status: "posted" }
    ],
    artifact_uri: pathToFileURL(runDir).href
  });
}

const version = spawnSync(playwrightBin, ["--version"], { encoding: "utf8", timeout: 15_000 });
stages.push({
  stage: "playwright-cli",
  status: version.status === 0 ? "success" : "unavailable",
  version: String(version.stdout || "").trim() || undefined,
  stderr_tail: version.status === 0 ? undefined : String(version.stderr || "").slice(-800)
});
const existingCdp = await cdpVersion(cdpUrl);
if (!existingCdp.ok) {
  stages.push({ stage: "authenticated-browser-lane", status: "blocked", exact_blocker: "sns_multi_poster_authenticated_cdp_lane_required" });
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        status: "blocked",
        exact_blocker: "sns_multi_poster_authenticated_cdp_lane_required",
        required_input: "Open/login persistent SNS lane or provide SNS_MULTI_POSTER_CDP_URL / AUTOMATION_OS_SNS_MULTI_POSTER_CDP_URL",
        approved_external_actions: approvedActions,
        hard_stops: hardStops,
        cdp_url: cdpUrl,
        profile_dir: loginLaneProfileDir,
        login_handoff_command: `SNS_MULTI_POSTER_OPEN_LOGIN_LANE=1 node scripts/run_sns_multi_poster_ukiyoe_playwright_cli.mjs --run-id ${runId}`,
        next_action: "Open the persistent login lane, log in once, then rerun the same posting command."
      },
      null,
      2
    )}\n`
  );
  finish({
    status: "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_human_input_required_with_evidence",
    evidence_reason: "authenticated_cdp_lane_required",
    evidence_path: evidencePath,
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href
  });
}

try {
  const postResult = await postToXViaCdp({ cdpUrl, imagePath, caption });
  stages.push(...postResult.stages);
  if (postResult.status === "success") {
    finish({
      status: "success",
      run_id: runId,
      external_action_executed: true,
      posted: true,
      published: true,
      platform_results: [{ platform: "x", status: "posted", url: postResult.postUrl, confirmation: postResult.confirmation }],
      evidence_path: postResult.evidencePath,
      artifact_uri: pathToFileURL(runDir).href
    });
  }
  finishHumanInputRequired(postResult.evidenceReason, postResult.exactBlocker, postResult.evidence);
} catch (error) {
  finishHumanInputRequired("cdp_runner_error", "sns_multi_poster_cdp_runner_error", {
    status: "blocked",
    exact_blocker: "sns_multi_poster_cdp_runner_error",
    cdp_url_present: true,
    error: error instanceof Error ? error.message : String(error)
  });
}

async function postToXViaCdp(input) {
  const attemptPath = join(runDir, "x-cdp-attempt.json");
  const domPath = join(runDir, "x-compose-dom.txt");
  const screenshotPath = join(runDir, "x-compose.png");
  const targetUrl = "https://x.com/compose/post";
  const attempt = {
    platform: "x",
    target_url: targetUrl,
    cdp_url_present: true,
    image_path: input.imagePath,
    caption_length: input.caption.length,
    hard_stop_policy: "billing_purchase_payment_only",
    started_at: new Date().toISOString()
  };
  writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
  const cdp = await openCdpPage(input.cdpUrl, targetUrl);
  let pageUrl = targetUrl;
  let bodyText = "";
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Page.navigate", { url: targetUrl });
    await waitForPageReady(cdp);
    await delay(2_000);
    pageUrl = await currentPageUrl(cdp);
    bodyText = await documentText(cdp);
    writeFileSync(domPath, bodyText.slice(0, 20_000), "utf8");
    await captureScreenshot(cdp, screenshotPath);

    if (looksLoggedOut(pageUrl, bodyText)) {
      return blockedCdpResult("login_or_auth_required", "sns_multi_poster_login_or_auth_required", { pageUrl, bodyText, attemptPath, domPath, screenshotPath });
    }

    const composeReady = await evaluateJson(cdp, composeSurfaceScript());
    if (!composeReady?.ok) {
      return blockedCdpResult("compose_surface_missing", "sns_multi_poster_compose_surface_missing", {
        pageUrl,
        bodyText,
        attemptPath,
        domPath,
        screenshotPath,
        surface: composeReady
      });
    }

    await focusComposer(cdp);
    await cdp.send("Input.insertText", { text: input.caption });
    const uploadNode = await querySelectorNode(cdp, "input[type='file']");
    if (!uploadNode) {
      return blockedCdpResult("image_upload_surface_missing", "sns_multi_poster_image_upload_surface_missing", {
        pageUrl,
        bodyText: await documentText(cdp),
        attemptPath,
        domPath,
        screenshotPath
      });
    }
    await cdp.send("DOM.setFileInputFiles", { nodeId: uploadNode, files: [input.imagePath] });
    await delay(2_500);
    const button = await evaluateJson(cdp, clickPostButtonScript());
    if (!button?.ok) {
      return blockedCdpResult("post_button_missing_or_disabled", "sns_multi_poster_post_button_missing_or_disabled", {
        pageUrl: await currentPageUrl(cdp),
        bodyText: await documentText(cdp),
        attemptPath,
        domPath,
        screenshotPath,
        button
      });
    }
    await delay(8_000);
    pageUrl = await currentPageUrl(cdp);
    bodyText = await documentText(cdp);
    writeFileSync(domPath, bodyText.slice(0, 20_000), "utf8");
    await captureScreenshot(cdp, screenshotPath);
    const postUrl = extractXPostUrl(pageUrl, bodyText);
    const sentConfirmation = hasSentConfirmation(bodyText);
    if (!postUrl && !sentConfirmation) {
      return blockedCdpResult("post_confirmation_unverified", "sns_multi_poster_post_confirmation_unverified", {
        pageUrl,
        bodyText,
        attemptPath,
        domPath,
        screenshotPath
      });
    }
    const successEvidence = writeEvidence("posted", "sns_multi_poster_x_post_verified", {
      platform: "x",
      target_url: targetUrl,
      page_url: pageUrl,
      post_url: postUrl,
      confirmation: postUrl ? "status_url_detected" : "sent_toast_detected",
      attempt_path: attemptPath,
      dom_path: domPath,
      screenshot_path: screenshotPath,
      external_action_executed: true
    });
    return {
      status: "success",
      postUrl,
      confirmation: postUrl ? "status_url_detected" : "sent_toast_detected",
      evidencePath: successEvidence,
      stages: [{ stage: "external-post:x", status: "success", post_url: postUrl, confirmation: postUrl ? "status_url_detected" : "sent_toast_detected" }]
    };
  } finally {
    cdp.close();
  }
}

function blockedCdpResult(evidenceReason, exactBlocker, input) {
  const evidence = {
    status: "blocked",
    exact_blocker: exactBlocker,
    evidence_reason: evidenceReason,
    cdp_url_present: true,
    page_url: input.pageUrl,
    body_text_tail: String(input.bodyText || "").slice(-4000),
    attempt_path: input.attemptPath,
    dom_path: input.domPath,
    screenshot_path: input.screenshotPath,
    surface: input.surface,
    button: input.button,
    external_action_executed: false
  };
  return {
    status: "blocked",
    evidenceReason,
    exactBlocker,
    evidence,
    stages: [{ stage: "external-post:x", status: "blocked", exact_blocker: exactBlocker }]
  };
}

function finishHumanInputRequired(evidenceReason, exactBlocker, evidence) {
  stages.push({ stage: "human-input-evidence", status: "success", exact_blocker: exactBlocker });
  const writtenEvidencePath = writeEvidence("blocked", exactBlocker, evidence);
  finish({
    status: "blocked",
    run_id: runId,
    exact_blocker: "sns_multi_poster_human_input_required_with_evidence",
    evidence_reason: evidenceReason,
    evidence_path: writtenEvidencePath,
    external_action_executed: false,
    artifact_uri: pathToFileURL(runDir).href
  });
}

function writeEvidence(status, exactBlocker, evidence) {
  const payload = {
    status,
    exact_blocker: exactBlocker,
    run_id: runId,
    workflow_id: "sns-multi-poster-ukiyoe",
    approved_external_actions: approvedActions,
    hard_stops: hardStops,
    evidence_path: evidencePath,
    ...evidence
  };
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`);
  return evidencePath;
}

async function openCdpPage(rawCdpUrl, targetUrl) {
  if (typeof WebSocket !== "function") throw new Error("node_websocket_unavailable");
  const baseUrl = normalizeCdpUrl(rawCdpUrl);
  let target = await cdpHttpJson(baseUrl, `/json/new?${encodeURIComponent(targetUrl)}`, "PUT");
  if (!target?.webSocketDebuggerUrl) target = await cdpHttpJson(baseUrl, `/json/new?${encodeURIComponent(targetUrl)}`, "GET");
  if (!target?.webSocketDebuggerUrl) {
    const targets = await cdpHttpJson(baseUrl, "/json/list", "GET");
    target = Array.isArray(targets) ? targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl) : undefined;
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("cdp_page_target_unavailable");
  return connectCdpWebSocket(target.webSocketDebuggerUrl);
}

async function cdpHttpJson(baseUrl, path, method) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { method });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function normalizeCdpUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("cdp_url_missing");
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `http://${value}`;
}

function connectCdpWebSocket(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("cdp_websocket_error")), { once: true });
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`cdp_command_timeout:${method}`));
        }, 20_000);
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      try {
        socket.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
  };
}

async function waitForPageReady(cdp) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const state = await evaluateJson(cdp, "() => document.readyState");
    if (state === "interactive" || state === "complete") return;
    await delay(500);
  }
}

async function evaluateJson(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(${expression})()`,
    awaitPromise: true,
    returnByValue: true
  });
  return result?.result?.value;
}

async function currentPageUrl(cdp) {
  return (await evaluateJson(cdp, "() => location.href")) || "";
}

async function documentText(cdp) {
  return (await evaluateJson(cdp, "() => document.body ? document.body.innerText : ''")) || "";
}

async function captureScreenshot(cdp, path) {
  try {
    const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (result?.data) writeFileSync(path, Buffer.from(result.data, "base64"));
  } catch {
    writeFileSync(path, "");
  }
}

async function querySelectorNode(cdp, selector) {
  const document = await cdp.send("DOM.getDocument", { depth: 1, pierce: true });
  const result = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector });
  return result?.nodeId || undefined;
}

async function focusComposer(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const candidates = [
          '[data-testid="tweetTextarea_0"]',
          '[role="textbox"][contenteditable="true"]',
          'div[contenteditable="true"]'
        ];
        for (const selector of candidates) {
          const element = document.querySelector(selector);
          if (element) {
            element.focus();
            element.click();
            return true;
          }
        }
        return false;
      })()
    `,
    returnByValue: true
  });
}

function composeSurfaceScript() {
  return `() => {
    const textBox = document.querySelector('[data-testid="tweetTextarea_0"], [role="textbox"][contenteditable="true"], div[contenteditable="true"]');
    const fileInput = document.querySelector('input[type="file"]');
    const bodyText = document.body ? document.body.innerText : '';
    return { ok: Boolean(textBox && fileInput), hasTextBox: Boolean(textBox), hasFileInput: Boolean(fileInput), bodyTextTail: bodyText.slice(-1000) };
  }`;
}

function clickPostButtonScript() {
  return `() => {
    const selectors = ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button && button.getAttribute('aria-disabled') !== 'true' && !button.disabled) {
        button.click();
        return { ok: true, selector };
      }
    }
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((item) => /^(Post|ポスト|投稿)$/.test((item.innerText || item.textContent || '').trim()) && item.getAttribute('aria-disabled') !== 'true' && !item.disabled);
    if (button) {
      button.click();
      return { ok: true, selector: 'button:text' };
    }
    return { ok: false, buttonTexts: buttons.map((item) => (item.innerText || item.textContent || '').trim()).filter(Boolean).slice(0, 20) };
  }`;
}

function looksLoggedOut(url, text) {
  return (
    /\/i\/flow\/login|\/i\/jf\/onboarding\/web|\/login|mode=login/i.test(url) ||
    /Log in|Sign in|Sign up|Create account|ログイン|サインイン|認証|電話番号で続ける|メールアドレスまたはユーザー名|verification code|確認コード|CAPTCHA/i.test(text)
  );
}

function extractXPostUrl(url, text) {
  if (/https:\/\/x\.com\/[^/\s]+\/status\/\d+/.test(url)) return url.match(/https:\/\/x\.com\/[^/\s]+\/status\/\d+/)?.[0];
  const match = text.match(/https:\/\/x\.com\/[^/\s]+\/status\/\d+/);
  return match?.[0];
}

function hasSentConfirmation(text) {
  return /Your post was sent|Your Post was sent|ポストを送信しました|投稿を送信しました/i.test(text);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
