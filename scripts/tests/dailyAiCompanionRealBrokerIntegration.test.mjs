import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { CompanionBroker } from "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge/src/broker/broker.mjs";
import { connectPeer } from "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge/src/client/connect.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge/src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge/src/shared/build-info.mjs";
import { ensureBrokerSecret } from "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge/src/shared/security.mjs";
import { prepareDailyAiPublishPayload } from "/Users/nichikatanaka/Documents/New project/scripts/daily_ai_payload_binding.mjs";
import { issuePortableExternalEffectAuthorityV1 } from "../..//apps/server/dist/runs/portableExternalEffectAuthority.js";
import { runPortableExternalWorker } from "../../apps/server/dist/runs/portableExternalWorker.js";
import { assertDailyAiPublishedQueue } from "./helpers/dailyAiQueueAssertions.mjs";

const row = { id: "real-daily-1", x_text: "real broker provider body", linkedin_text: "", status: "drafted" };
const intent = { provider_identity: "observed", entry_url: "https://x.com/home", route: { surface: "aos_chrome_companion_profile_instance" }, action_plan: { payload: { body: row.x_text }, steps: [{ action: "fill_target", payload_key: "body", target: { semantic_query: "composer" } }, { action: "submit", target: { semantic_query: "Post" } }], readback: { semantic_query: "real broker provider body", expected: "present" } } };

function once(peer, predicate) { return new Promise((resolve) => { const off = peer.onMessage((message) => { if (predicate(message)) { off(); resolve(message); } }); }); }
function runCommit(requestPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["/Users/nichikatanaka/Documents/New project/src/social_flow/daily_ai_provider_commit.py", "--request", requestPath], { env: { ...process.env, PYTHONPATH: "/Users/nichikatanaka/Documents/New project/src" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `commit:${code}`)));
  });
}

test("registered DailyAI entrypoint uses real empty broker, extracts provider proof, and resumes queue sync without repost", async (t) => {
  const root = fs.realpathSync(await mkdtemp(join(tmpdir(), "aos-daily-ai-real-broker-")));
  const sourceRoot = fs.realpathSync("/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge");
  const instanceId = randomUUID();
  const isolationBinding = { schema: "aos.companion_isolation_binding.v1", sourceRoot, dataDir: root,
    socketPath: join(root, "broker.sock"), secretPath: join(root, "secret"), issuerSecretPath: join(root, "issuer"), instanceId };
  const bindingPath = join(root, "isolation-binding.json");
  const bindingBytes = JSON.stringify(isolationBinding);
  await writeFile(bindingPath, bindingBytes, { mode: 0o400, flag: "wx" });
  const bindingHash = createHash("sha256").update(bindingBytes).digest("hex");
  let assertionsPassed = false;
  const diagnosticPath = join(root, "diagnostic.json");
  const redact = (value) => String(value ?? "").replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]").replace(/((?:token|secret|password|authorization|cookie)[\"']?\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
  const phase = (name) => {
    diagnostic.phases ??= [];
    diagnostic.phases.push({ name, at: new Date().toISOString() });
    fs.writeFileSync(diagnosticPath, JSON.stringify(diagnostic, (key, value) => key === "stdout" || key === "stderr" ? redact(value) : value, 2), { mode: 0o600 });
  };
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: root, AOS_CHROME_COMPANION_SOCKET: join(root, "broker.sock"), AOS_CHROME_COMPANION_SECRET_FILE: join(root, "secret"), AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: join(root, "issuer") };
  await writeFile(env.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE, "daily-ai-real-issuer\n", { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret, issuerSecrets: { aos: "daily-ai-real-issuer" }, statePath: join(root, "ledger.json"), instanceId });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const hello = once(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "daily-ai-real-profile", extensionRuntimeId: "daily-ai-real-runtime", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await hello;
  let browserDispatches = 0;
  let submitted = false;
  const semanticResolutions = [];
  const diagnostic = { brokerConnectionAt: new Date().toISOString(), firstBrokerRequestAt: null, commandRequests: [], testStartedAt: new Date().toISOString() };
  Object.assign(diagnostic, { root, testPid: process.pid, testPpid: process.ppid, cwd: process.cwd() });
  phase("broker_connected");
  console.log(`Diagnostic evidence: ${diagnosticPath}`);
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    const method = message.method, tabId = message.params?.tabId;
    diagnostic.firstBrokerRequestAt ||= new Date().toISOString(); diagnostic.commandRequests.push({ method, at: new Date().toISOString() });
    phase(`broker_request:${method}`);
    if (method === "tabs.list") return extension.send({ kind: "command.result", operationId: message.operationId, result: [{ id: 77, url: "https://x.com/home", title: "X", windowId: 1 }] });
    if (method === "tabs.create") return extension.send({ kind: "command.result", operationId: message.operationId, result: { id: 77, url: message.params.url, title: "X", windowId: 1 } });
    if (method === "tabs.groupTask" || method === "tabs.configure" || method === "tabs.navigate") return extension.send({ kind: "command.result", operationId: message.operationId, result: { id: tabId || 77, url: message.params.url || "https://x.com/home", title: "X", windowId: 1, groupId: 9 } });
    if (method === "tabs.close") return extension.send({ kind: "command.result", operationId: message.operationId, result: { closed: true, tabId } });
    if (method === "page.type") return extension.send({ kind: "command.result", operationId: message.operationId, result: { typed: true, value: message.params.text } });
    if (method === "visual.inspectTarget") {
      const text = String(message.params?.locator?.text || "");
      const known = text === "composer" || text === "Post";
      semanticResolutions.push({ method, text, matched: known });
      return extension.send({ kind: "command.result", operationId: message.operationId, result: known
        ? { frameId: 0, url: "https://x.com/home", topLevelUrl: "https://x.com/home", pageInstanceId: `document-77-${submitted}`, element: { role: text === "composer" ? "textbox" : "button", name: text }, rect: { x: 1, y: 1, width: 80, height: 30 }, point: { x: 20, y: 15 }, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, semanticGuard: { id: `guard-${text}`, methods: ["page.type", "page.click"] } }
        : { frameId: 0, url: "https://x.com/home", topLevelUrl: "https://x.com/home", pageInstanceId: `document-77-${submitted}`, element: null, rect: null, point: null, viewport: { width: 1200, height: 800, devicePixelRatio: 1 } } });
    }
    if (method === "page.click") { browserDispatches += 1; submitted = true; return extension.send({ kind: "command.result", operationId: message.operationId, result: { clicked: true, tabId: 77, frameId: 0, url: "https://x.com/home", pageInstanceId: "document-77-false", mutationDispatchAttempted: true } }); }
    if (method === "page.snapshot") { const url = submitted ? "https://x.com/observed/status/42" : "https://x.com/home"; return extension.send({ kind: "command.result", operationId: message.operationId, result: { frameId: 0, topLevelUrl: url, url, text: submitted ? row.x_text : "composer", author: submitted ? "observed" : "", links: submitted ? [url] : [], pageInstanceId: `document-77-${submitted}`, frames: [{ frameId: 0, url, topLevelUrl: url, pageInstanceId: `document-77-${submitted}`, textChars: submitted ? row.x_text.length : 8, controlCount: 2 }] } }); }
    if (method === "page.query") {
      const query = String(message.params?.query || "");
      const known = query === "composer" || query === row.x_text || query === "Post";
      return extension.send({ kind: "command.result", operationId: message.operationId, result: { query, count: known ? 1 : 0, matches: known ? [{ role: query === "composer" ? "textbox" : "button", name: query, frameId: 0, pageInstanceId: `document-77-${submitted}`, url: submitted ? "https://x.com/observed/status/42" : "https://x.com/home" }] : [], frameId: 0, pageInstanceId: `document-77-${submitted}` } });
    }
    if (method === "page.screenshot") return extension.send({ kind: "command.result", operationId: message.operationId, result: { kind: "screenshot", tabId: 77, url: "https://x.com/observed/status/42", capturedAt: new Date().toISOString(), dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" } });
    return extension.send({ kind: "command.result", operationId: message.operationId, result: { found: true, tabId: 77 } });
  });
  const binding = prepareDailyAiPublishPayload({ row, platform: "x", targetKey: "real-daily-1:x" });
  const runId = "run-real-daily", stepId = "step-real-daily", taskId = "task-real-daily", approvalId = "approval-real-daily", idempotencyKey = `${runId}-idempotency`;
  const queue = join(root, "queue.tsv");
  await writeFile(queue, `id\tstatus\tx_text\tlinkedin_text\tx_post_id\tx_post_url\tx_published_at\tlinkedin_post_url\nreal-daily-1\tdrafted\t${row.x_text}\t\t\t\t\t\n`);
  const queueBefore = await readFile(queue);
  const bundleValue = { schema: "automation_os_portable_workflow_input_bundle.v1", workflow_id: "daily-ai-research-publish-run", run_id: runId, input: { account_ref: "daily-ai-account", target_key: binding.target_key, content_key: row.id, payload_hash: binding.payload_hash, source_snapshot_id: "real-source" } };
  const runRoot = join(root, runId); await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const bundleBytes = `${JSON.stringify(bundleValue, null, 2)}\n`, bundlePath = join(runRoot, "portable-input-bundle.v1.json"); await writeFile(bundlePath, bundleBytes, { mode: 0o600 });
  const target = { account_ref: bundleValue.input.account_ref, target_key: bundleValue.input.target_key, payload_hash: bundleValue.input.payload_hash, content_key: bundleValue.input.content_key, source_snapshot_id: bundleValue.input.source_snapshot_id };
  const authorityValue = issuePortableExternalEffectAuthorityV1({ companyId: "company_1", workflowId: bundleValue.workflow_id, runId, stepId, effectStage: "business_effect", approvalId, idempotencyKey, targetDigest: createHash("sha256").update(JSON.stringify(target)).digest("hex"), inputBundleSha256: createHash("sha256").update(bundleBytes).digest("hex"), payloadHash: binding.payload_hash, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  t.after(async () => {
    try { extension.close(); } finally {
      await broker.close();
      phase("test_broker_closed");
      if (assertionsPassed) await rm(root, { recursive: true, force: true });
    }
  });
  diagnostic.brokerConnectionAt = new Date().toISOString(); const workerEnv = { AOS_CHROME_COMPANION_ROOT: "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge", AUTOMATION_OS_ARTIFACT_ROOT: root, DAILY_AI_QUEUE_PATH: queue, AOS_CHROME_COMPANION_DATA_DIR: env.AOS_CHROME_COMPANION_DATA_DIR, AOS_CHROME_COMPANION_SOCKET: env.AOS_CHROME_COMPANION_SOCKET, AOS_CHROME_COMPANION_SECRET_FILE: env.AOS_CHROME_COMPANION_SECRET_FILE, AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: env.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE, AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled", AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS: "1500", AOS_DAILY_AI_INJECT_COMMIT_FAILURE_ONCE: "1" };
  workerEnv.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS = "30000";
  Object.assign(workerEnv, { AOS_CHROME_COMPANION_ROOT: sourceRoot,
    AOS_CHROME_COMPANION_REQUIRE_ISOLATED_PATHS: "1",
    AOS_CHROME_COMPANION_ISOLATION_BINDING_PATH: bindingPath,
    AOS_CHROME_COMPANION_ISOLATION_BINDING_SHA256: bindingHash });
  const previous = new Map(Object.keys(workerEnv).map((key) => [key, process.env[key]])); Object.assign(process.env, workerEnv);
  const workerInput = { workflowId: bundleValue.workflow_id, runId, stepId, sourceTrigger: "automation_os_scheduler", idempotencyKey, approvalGranted: true, inputBundlePath: bundlePath, companionTaskId: taskId, effectAuthority: authorityValue, webOperationIntent: { provider_identity: "observed", operation: "publish", account_ref: bundleValue.input.account_ref, allowed_origins: ["https://x.com"], entry_url: intent.entry_url, target: { semantic_query: "Post" }, payload_hash: binding.payload_hash, action_plan: { schema: "automation_os_web_operation_action_plan.v1", payload: { content: row.x_text }, payload_hash: binding.payload_hash, readback: { semantic_query: row.x_text, expected: "present" }, steps: [{ action: "open", url: intent.entry_url }, { action: "fill_target", payload_key: "content", target: { semantic_query: "composer" } }, { action: "click_target", target: { semantic_query: "Post" } }] } }, webOperationBackend: { requested_backend: "aos_chrome_companion", resolved_backend: "aos_chrome_companion", revision: 1, browser_surface: "aos_chrome_companion_profile_instance", fallback_allowed: false } };
  let first, second, proof;
  try {
    diagnostic.intentEnvironmentKeys = Object.keys(workerEnv).filter((key) => key.includes("INTENT"));
    diagnostic.workerTimeoutMs = 30000;
    phase("before_worker_await");
    first = await runPortableExternalWorker(workerInput); diagnostic.firstWorkerResultAt = new Date().toISOString(); diagnostic.firstWorker = { status: first.status, exactBlocker: first.exactBlocker, runnerPath: first.diagnostics?.runnerPath, cwd: first.diagnostics?.cwd, childPid: first.diagnostics?.childPid, childPpid: first.diagnostics?.childPpid, spawnedAt: first.diagnostics?.spawnedAt, childExitedAt: first.diagnostics?.childExitedAt, processGroupCleanupAt: first.diagnostics?.processGroupCleanupAt, processGroupCleanupVerified: first.processGroupCleanup?.verified === true, stdout: first.stdoutTail, stderr: first.stderrTail, intentPath: first.webOperationIntentPath, intentHash: first.webOperationIntentSha256, intentExists: first.webOperationIntentPath ? fs.existsSync(first.webOperationIntentPath) : false };
    const brokerIdentityPath = join(root, runId, "business-run", "daily-ai", "companion-broker-identity.v1.json");
    const brokerIdentity = JSON.parse(await readFile(brokerIdentityPath, "utf8"));
    assert.equal(brokerIdentity.expected_instance_id, instanceId);
    assert.equal(brokerIdentity.observed_instance_id, instanceId);
    assert.equal(brokerIdentity.expected_build_id, INSTALL_BUILD_ID);
    assert.equal(brokerIdentity.observed_build_id, INSTALL_BUILD_ID);
    assert.equal(brokerIdentity.build_match, true);
    assert.ok(Number.isFinite(Date.parse(brokerIdentity.observed_at)));
    assert.ok(Date.parse(brokerIdentity.observed_at) <= Date.parse(diagnostic.firstBrokerRequestAt));
    diagnostic.brokerIdentity = brokerIdentity;
    assert.equal(first.status, "blocked", `${first.exactBlocker}\n${first.stderrTail}`);
    assert.equal(first.exactBlocker, "daily_ai_companion_queue_commit_injected_failure");
    const persistedReceipt = JSON.parse(await readFile(join(root, runId, "business-run", "daily-ai", "daily-ai-companion-receipt.json"), "utf8"));
    assert.equal(persistedReceipt.postflight_sync?.injected, true);
    assert.equal(persistedReceipt.cleanup_verified, true);
    assert.equal(persistedReceipt.no_replay, true);
    assert.deepEqual(await readFile(queue), queueBefore);
    assert.equal(browserDispatches, 1);
    assert.ok(first.webOperationIntentPath && first.webOperationIntentSha256); assert.equal(createHash("sha256").update(await readFile(first.webOperationIntentPath)).digest("hex"), first.webOperationIntentSha256);
    const proofPath = persistedReceipt.provider_readback_path; assert.ok(proofPath); const proofBefore = await readFile(proofPath); proof = JSON.parse(proofBefore.toString("utf8")); assert.equal(proof.verified, true); assert.equal(proof.observed_author, "observed"); assert.equal(proof.screenshot_refs[0].mime_type, "image/png"); assert.equal(proof.screenshot_refs[0].sha256, createHash("sha256").update(Buffer.from(proof.screenshot_refs[0].image_bytes_base64, "base64")).digest("hex"));
    const commandsBeforeResume = diagnostic.commandRequests.length;
    second = await runPortableExternalWorker(workerInput); assert.equal(second.status, "complete", `${second.exactBlocker}\n${second.stderrTail}`); assert.equal(second.response?.status, "complete");
    assert.equal(diagnostic.commandRequests.length, commandsBeforeResume, "saved-proof resume must not issue extension commands");
    assert.deepEqual(await readFile(proofPath), proofBefore);
  } finally {
    try {
    diagnostic.finishedAt = new Date().toISOString(); diagnostic.secondWorker = second ? { status: second.status, exactBlocker: second.exactBlocker, childPid: second.diagnostics?.childPid, childExitedAt: second.diagnostics?.childExitedAt, processGroupCleanupAt: second.diagnostics?.processGroupCleanupAt, processGroupCleanupVerified: second.processGroupCleanup?.verified === true, stdout: second.stdoutTail, stderr: second.stderrTail } : null;
    diagnostic.artifactFiles = fs.existsSync(root) ? fs.readdirSync(join(root, runId)).sort() : [];
    phase("worker_await_finished");
    } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
  assert.deepEqual(semanticResolutions.map(({ text, matched }) => [text, matched]), [["composer", true], ["composer", true], ["Post", true]]);
  assert.equal(browserDispatches, 1);
  assert.equal(diagnostic.commandRequests.filter(({ method }) => method === "page.type").length, 1);
  assert.equal(diagnostic.commandRequests.filter(({ method }) => method === "page.submit").length, 0);
  const finalReceipt = JSON.parse(await readFile(join(root, runId, "business-run", "daily-ai", "daily-ai-companion-receipt.json"), "utf8")); assert.equal(finalReceipt.resumed_from_proof, undefined); assert.equal(finalReceipt.operation.queue_path, queue); assert.equal(finalReceipt.operation.content_key, row.id); assert.equal(finalReceipt.adapter_receipt.cleanup_verified, true); assert.equal(finalReceipt.adapter_receipt.cleanup.session_closed, true); assert.equal(finalReceipt.adapter_receipt.cleanup.task_tab_cleanup.status, "completed"); assert.equal(finalReceipt.provider_readback.screenshot_refs[0].sha256, proof.screenshot_refs[0].sha256);
  assertDailyAiPublishedQueue(queue, proof, row.x_text);
  assertionsPassed = true;
});
