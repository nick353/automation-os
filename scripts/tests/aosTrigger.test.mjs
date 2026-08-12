import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const script = join(root, "scripts", "aos-trigger.mjs");
const execFileAsync = promisify(execFile);

function envWithoutTokens(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.AOS_TRIGGER_TOKEN;
  delete env.AUTOMATION_OS_WRITE_TOKEN;
  delete env.AOS_TRIGGER_TOKEN_FILE;
  return env;
}

async function runTrigger(args, env = envWithoutTokens()) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env, maxBuffer: 256 * 1024 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error;
    return {
      status: typeof failure.status === "number"
        ? failure.status
        : typeof failure.code === "number" ? failure.code : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? "")
    };
  }
}

function jsonStdout(result) {
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout.trim());
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("loopback trigger may run without a token and preserves no-effect response", async () => {
  let request;
  const { server, baseUrl } = await listen((req, res) => {
    request = req;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, schema: "aos.automation_trigger.v1", external_action_executed: false }));
  });
  try {
    const loopbackEnv = envWithoutTokens({ AOS_TRIGGER_TOKEN: "sentinel-loopback-token" });
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], loopbackEnv);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonStdout(result).external_action_executed, false);
    assert.equal(request?.headers.authorization, undefined);
    assert.match(request?.headers["idempotency-key"] ?? "", /^aos-trigger-/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("loopback hostname variants remain in the loopback branch", async () => {
  for (const baseUrl of ["http://localhost:1", "http://[::1]:1"]) {
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], envWithoutTokens());
    const body = jsonStdout(result);
    assert.notEqual(body.exact_blocker, "aos_trigger_machine_token_required", baseUrl);
    assert.equal(body.external_action_executed, false, baseUrl);
  }
});

test("optional input bundle is carried through the no-effect trigger without being echoed", async () => {
  let requestBody = "";
  const { server, baseUrl } = await listen((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, schema: "aos.portable_workflow_trigger.v1", accepted: true, queued: true, portable: true, worker_protocol: "mac_worker_polling_required", external_action_executed: false }));
    });
  });
  const bundleDir = fs.mkdtempSync(join(tmpdir(), "aos-trigger-bundle-"));
  const bundlePath = join(bundleDir, "input-bundle.json");
  fs.writeFileSync(bundlePath, `${JSON.stringify({ source_snapshot_id: "snapshot-1", bucket: "japan_targeted", remaining: 1 })}\n`, { mode: 0o600 });
  try {
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl, "--input-bundle-file", bundlePath], envWithoutTokens());
    assert.equal(result.status, 0, result.stderr);
    const request = JSON.parse(requestBody);
    assert.equal(request.execution_mode, "preflight_no_effect");
    assert.equal(request.external_action_allowed, false);
    assert.deepEqual(request.input_bundle, { source_snapshot_id: "snapshot-1", bucket: "japan_targeted", remaining: 1 });
    assert.doesNotMatch(result.stdout, /snapshot-1|japan_targeted/iu);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("input bundle files fail closed when they are not private regular files", async () => {
  const bundleDir = fs.mkdtempSync(join(tmpdir(), "aos-trigger-untrusted-bundle-"));
  const bundlePath = join(bundleDir, "input-bundle.json");
  fs.writeFileSync(bundlePath, JSON.stringify({ bucket: "japan_targeted" }), { mode: 0o644 });
  try {
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--input-bundle-file", bundlePath], envWithoutTokens());
    assert.equal(result.status, 2);
    assert.equal(jsonStdout(result).exact_blocker, "aos_trigger_input_bundle_file_untrusted");
    assert.doesNotMatch(result.stdout, /japan_targeted/iu);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("remote trigger requires HTTPS and a machine token before fetch", async () => {
  const httpResult = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", "http://example.test"], envWithoutTokens());
  assert.equal(httpResult.status, 2);
  assert.equal(jsonStdout(httpResult).exact_blocker, "aos_trigger_remote_tls_required");

  const missingTokenEnv = envWithoutTokens({ AOS_TRIGGER_ALLOWED_ORIGIN: "https://example.test" });
  const missingToken = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", "https://example.test"], missingTokenEnv);
  assert.equal(missingToken.status, 2);
  assert.equal(jsonStdout(missingToken).exact_blocker, "aos_trigger_machine_token_required");
});

test("remote token is origin-bound before it can be attached to a request", async () => {
  const missingTrust = await runTrigger(
    ["--company", "company-a", "--automation", "automation-a", "--base-url", "https://example.test"],
    envWithoutTokens({ AOS_TRIGGER_TOKEN: "sentinel-token" })
  );
  assert.equal(missingTrust.status, 2);
  assert.equal(jsonStdout(missingTrust).exact_blocker, "aos_trigger_remote_origin_not_trusted");
  assert.doesNotMatch(missingTrust.stdout, /sentinel-token/iu);

  const wrongTrust = await runTrigger(
    ["--company", "company-a", "--automation", "automation-a", "--base-url", "https://example.test"],
    envWithoutTokens({ AOS_TRIGGER_TOKEN: "sentinel-token", AOS_TRIGGER_ALLOWED_ORIGIN: "https://other.example" })
  );
  assert.equal(wrongTrust.status, 2);
  assert.equal(jsonStdout(wrongTrust).exact_blocker, "aos_trigger_remote_origin_not_trusted");
  assert.doesNotMatch(wrongTrust.stdout, /sentinel-token/iu);
});

test("URL components and unavailable token files fail closed without echoing input", async () => {
  const cases = [
    ["https://user:pass@example.test", "aos_trigger_base_url_invalid"],
    ["https://example.test/app?token=secret", "aos_trigger_base_url_invalid"],
    ["https://example.test/app#secret", "aos_trigger_base_url_invalid"],
    ["ftp://example.test", "aos_trigger_base_url_invalid"],
    ["not a url", "aos_trigger_base_url_invalid"]
  ];
  for (const [baseUrl, blocker] of cases) {
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], envWithoutTokens({ AOS_TRIGGER_TOKEN: "sentinel-token" }));
    const body = jsonStdout(result);
    assert.equal(body.exact_blocker, blocker, baseUrl);
    assert.equal(body.external_action_executed, false, baseUrl);
    assert.doesNotMatch(result.stdout, /sentinel-token|secret|pass/iu, baseUrl);
  }

  const missingFile = join(tmpdir(), "aos-trigger-token-file-does-not-exist");
  const result = await runTrigger(
    ["--company", "company-a", "--automation", "automation-a", "--base-url", "https://example.test", "--token-file", missingFile],
    envWithoutTokens({ AOS_TRIGGER_ALLOWED_ORIGIN: "https://example.test" })
  );
  const body = jsonStdout(result);
  assert.equal(body.exact_blocker, "aos_trigger_token_file_unavailable");
  assert.equal(body.external_action_executed, false);
  assert.doesNotMatch(result.stdout, new RegExp(missingFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("redirects are never followed and reflected tokens are not returned", async () => {
  let requestCount = 0;
  const { server, baseUrl } = await listen((req, res) => {
    requestCount += 1;
    if (req.url?.includes("redirect")) {
      res.writeHead(302, { location: "http://example.test/credential-exfiltration" });
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, schema: "aos.automation_trigger.v1", authorization: "sentinel-token", nested: { token: "sentinel-token" }, external_action_executed: false }));
  });
  try {
    const redirect = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", `${baseUrl}/redirect`], envWithoutTokens());
    assert.equal(redirect.status, 2);
    assert.equal(jsonStdout(redirect).exact_blocker, "aos_trigger_redirect_forbidden");
    assert.equal(requestCount, 1);

    const reflectedEnv = envWithoutTokens();
    reflectedEnv.AOS_TRIGGER_TOKEN = "sentinel-token";
    const reflected = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], reflectedEnv);
    assert.equal(reflected.status, 0, reflected.stderr);
    const reflectedBody = jsonStdout(reflected);
    assert.equal(reflectedBody.external_action_executed, false);
    assert.doesNotMatch(reflected.stdout, /sentinel-token|authorization|nested|token/iu);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP failure and oversized response remain stable no-effect blockers", async () => {
  const { server, baseUrl } = await listen((req, res) => {
    if (req.url?.includes("large")) {
      res.setHeader("content-length", String(70 * 1024));
      res.end("x".repeat(70 * 1024));
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "server_failure", external_action_executed: false }));
  });
  try {
    const failure = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], envWithoutTokens());
    assert.equal(failure.status, 1);
    assert.equal(jsonStdout(failure).external_action_executed, false);
    const large = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", `${baseUrl}/large`], envWithoutTokens());
    assert.equal(large.status, 2);
    assert.equal(jsonStdout(large).exact_blocker, "aos_trigger_response_too_large");
    assert.equal(jsonStdout(large).external_action_executed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("successful trigger responses require the canonical no-effect contract", async () => {
  const responses = [
    { body: "not-json", blocker: "aos_trigger_response_not_json" },
    { body: JSON.stringify({ ok: false, schema: "aos.automation_trigger.v1", external_action_executed: false }), blocker: "aos_trigger_response_contract_invalid" },
    { body: JSON.stringify({ ok: true, schema: "aos.automation_trigger.v1" }), blocker: "aos_trigger_response_contract_invalid" },
    { body: JSON.stringify({ ok: true, schema: "aos.automation_trigger.v1", external_action_executed: "false" }), blocker: "aos_trigger_response_contract_invalid" }
  ];
  for (const expected of responses) {
    const { server, baseUrl } = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(expected.body);
    });
    try {
      const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], envWithoutTokens());
      assert.equal(result.status, 2, expected.blocker);
      const body = jsonStdout(result);
      assert.equal(body.exact_blocker, expected.blocker);
      assert.equal(body.external_action_executed, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("portable AOS trigger responses are accepted as the provider-neutral no-effect contract", async () => {
  const { server, baseUrl } = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      schema: "aos.portable_workflow_trigger.v1",
      accepted: true,
      queued: true,
      portable: true,
      workflow_id: "daily-ai-research-publish-run",
      worker_protocol: "mac_worker_polling_required",
      external_action_executed: false,
      company_scope: { enforced: true, company_id: "company-a" },
    }));
  });
  try {
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], envWithoutTokens());
    assert.equal(result.status, 0, result.stderr);
    const body = jsonStdout(result);
    assert.equal(body.schema, "aos.portable_workflow_trigger.v1");
    assert.equal(body.workflow_id, "daily-ai-research-publish-run");
    assert.equal(body.worker_protocol, "mac_worker_polling_required");
    assert.equal(body.external_action_executed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stalled trigger requests stop at the configured deadline", async () => {
  const { server, baseUrl } = await listen(() => {
    // Intentionally leave the response open; the CLI must abort locally.
  });
  try {
    const env = envWithoutTokens({ AOS_TRIGGER_TIMEOUT_MS: "250" });
    const result = await runTrigger(["--company", "company-a", "--automation", "automation-a", "--base-url", baseUrl], env);
    assert.equal(result.status, 2);
    assert.equal(jsonStdout(result).exact_blocker, "aos_trigger_request_timeout");
    assert.equal(jsonStdout(result).external_action_executed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
