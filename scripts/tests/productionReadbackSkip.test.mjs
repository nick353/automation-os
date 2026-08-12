import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("production QA does not contact protected routes while the read token is absent", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, productionGuard: { required: true } }));
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><head><link rel="stylesheet" href="/assets/index-test.css"></head><body><script type="module" src="/assets/index-test.js"></script></body></html>');
      return;
    }
    if (request.url === "/assets/index-test.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("console.log('test');");
      return;
    }
    if (request.url === "/assets/index-test.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end("body{color:black}");
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ unexpected: request.url }));
  });
  server.keepAliveTimeout = 100;
  server.headersTimeout = 500;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const outputDir = mkdtempSync(join(tmpdir(), "automation-os-production-qa-skip-"));
  const environment = { ...process.env,
    AUTOMATION_OS_PRODUCTION_URL: `http://127.0.0.1:${port}`,
    AUTOMATION_OS_QA_OUTPUT_DIR: outputDir,
  };
  for (const key of [
    "AUTOMATION_OS_READ_TOKEN",
    "AUTOMATION_OS_QA_READ_TOKEN",
    "AUTOMATION_OS_REPLAY_READ_TOKEN",
    "AUTOMATION_OS_READ_TOKEN_FILE",
    "AUTOMATION_OS_QA_READ_TOKEN_FILE",
    "AUTOMATION_OS_REPLAY_READ_TOKEN_FILE"
  ]) delete environment[key];

  let exitError = null;
  let exitResult = null;
  try {
    exitResult = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/productionQa.mjs"], {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("production QA child timed out"));
      }, 15_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  } catch (error) {
    exitError = error;
  } finally {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(exitError, null);
  assert.deepEqual(exitResult, { code: 1, signal: null });
  const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
  assert.equal(summary.api.length, 1);
  assert.equal(summary.api[0].route, "/api/health");
  assert.equal(summary.api[0].status, 200);
  assert.equal(summary.api[0].failed, false);
  assert.equal(summary.protectedReadback.attempted, false);
  assert.equal(summary.protectedReadback.exact_blocker, "production_read_token_missing");
  assert.deepEqual(requests, ["/api/health", "/", "/assets/index-test.js", "/assets/index-test.css"]);
});

test("production QA retains sanitized deployment parity from the protected dashboard", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, service: "automation-os" }));
      return;
    }
    if (request.url === "/api/dashboard") {
      response.writeHead(200);
      response.end(JSON.stringify({
        runs: [],
        registeredWorkflows: [],
        deployment: {
          commit: "verified-commit",
          commitSource: "env",
          version: "0.1.0",
          plannerProvider: "auto",
          nodeEnv: "production",
          assets: {
            indexFound: true,
            js: "index-runtime.js",
            css: "index-runtime.css",
            webDistDir: "/private/path-that-must-not-escape"
          }
        }
      }));
      return;
    }
    if (request.url === "/api/registered-workflows") {
      response.writeHead(200);
      response.end(JSON.stringify({ workflows: [] }));
      return;
    }
    if (request.url === "/api/browser/health") {
      response.writeHead(200);
      response.end(JSON.stringify({ playwrightCli: { status: "missing" } }));
      return;
    }
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.writeHead(200);
      response.end('<html><head><link rel="stylesheet" href="/assets/index-runtime.css"></head><body><script type="module" src="/assets/index-runtime.js"></script></body></html>');
      return;
    }
    if (request.url === "/assets/index-runtime.js") {
      response.setHeader("content-type", "text/javascript");
      response.writeHead(200);
      response.end("console.log('runtime');");
      return;
    }
    if (request.url === "/assets/index-runtime.css") {
      response.setHeader("content-type", "text/css");
      response.writeHead(200);
      response.end("body{color:black}");
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ ok: false }));
  });
  server.keepAliveTimeout = 100;
  server.headersTimeout = 500;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const outputDir = mkdtempSync(join(tmpdir(), "automation-os-production-qa-deployment-"));
  const environment = {
    ...process.env,
    AUTOMATION_OS_PRODUCTION_URL: `http://127.0.0.1:${port}`,
    AUTOMATION_OS_QA_OUTPUT_DIR: outputDir,
    AUTOMATION_OS_READ_TOKEN: "test-read-token"
  };

  let exitError = null;
  let exitResult = null;
  try {
    exitResult = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/productionQa.mjs"], {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("production QA deployment child timed out"));
      }, 15_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  } catch (error) {
    exitError = error;
  } finally {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(exitError, null);
  assert.deepEqual(exitResult, { code: 1, signal: null });
  const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
  assert.deepEqual(summary.deployment, {
    commit: "verified-commit",
    commitSource: "env",
    version: "0.1.0",
    plannerProvider: "auto",
    nodeEnv: "production",
    assets: {
      indexFound: true,
      js: "index-runtime.js",
      css: "index-runtime.css"
    },
    runtimeParity: {
      status: "",
      schema: "",
      artifactHash: "",
      fileCount: 0,
      generatedAt: "",
      exactBlocker: null
    }
  });
  assert.ok(requests.includes("/api/dashboard"));
});

test("production QA fails closed when the current local and public asset hashes differ", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><head><link rel="stylesheet" href="/assets/index-fixture.css"></head><body><script type="module" src="/assets/index-fixture.js"></script></body></html>');
      return;
    }
    if (request.url === "/assets/index-fixture.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("public-js");
      return;
    }
    if (request.url === "/assets/index-fixture.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end("same-css");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  server.keepAliveTimeout = 100;
  server.headersTimeout = 500;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const outputDir = mkdtempSync(join(tmpdir(), "automation-os-production-qa-parity-"));
  const localWebDist = join(outputDir, "dist");
  mkdirSync(join(localWebDist, "assets"), { recursive: true });
  writeFileSync(join(localWebDist, "assets", "index-fixture.js"), "local-js");
  writeFileSync(join(localWebDist, "assets", "index-fixture.css"), "same-css");
  const environment = {
    ...process.env,
    AUTOMATION_OS_PRODUCTION_URL: `http://127.0.0.1:${port}`,
    AUTOMATION_OS_QA_OUTPUT_DIR: outputDir,
    AUTOMATION_OS_LOCAL_WEB_DIST: localWebDist
  };
  for (const key of [
    "AUTOMATION_OS_READ_TOKEN",
    "AUTOMATION_OS_QA_READ_TOKEN",
    "AUTOMATION_OS_REPLAY_READ_TOKEN",
    "AUTOMATION_OS_READ_TOKEN_FILE",
    "AUTOMATION_OS_QA_READ_TOKEN_FILE",
    "AUTOMATION_OS_REPLAY_READ_TOKEN_FILE"
  ]) delete environment[key];

  let exitError = null;
  let exitResult = null;
  try {
    exitResult = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/productionQa.mjs"], {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("production QA parity child timed out"));
      }, 15_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  } catch (error) {
    exitError = error;
  } finally {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(exitError, null);
  assert.deepEqual(exitResult, { code: 1, signal: null });
  const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
  assert.equal(summary.assets.localParity.status, "mismatch");
  assert.equal(summary.assets.localParity.checks.js.status, "mismatch");
  assert.equal(summary.assets.localParity.checks.css.status, "match");
  assert.ok(summary.failures.includes("public_local_asset_parity_mismatch:js"));
});
