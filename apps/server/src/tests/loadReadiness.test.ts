import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseLoadReadinessArgs, runLoadReadiness, validateLoadTargetUrl } from "../loadReadiness.js";

test("validateLoadTargetUrl rejects production hosts unless explicitly allowed", () => {
  assert.throws(() => validateLoadTargetUrl("https://example.com"), /load_target_url_production_host_blocked/);
  assert.throws(() => validateLoadTargetUrl("http://10.0.0.8/"), /load_target_url_production_host_blocked/);
  assert.throws(() => validateLoadTargetUrl("http://192.168.1.10/"), /load_target_url_production_host_blocked/);
  assert.equal(validateLoadTargetUrl("http://127.0.0.1:8788/"), "http://127.0.0.1:8788/");
  assert.equal(validateLoadTargetUrl("https://example.com", true), "https://example.com/");
});

test("validateLoadTargetUrl rejects credentials and non-http urls", () => {
  assert.throws(() => validateLoadTargetUrl("ftp://127.0.0.1"), /load_target_url_must_use_http/);
  assert.throws(() => validateLoadTargetUrl("https://user:pass@127.0.0.1"), /load_target_url_credentials_not_allowed/);
});

test("parseLoadReadinessArgs supports repeated urls and allow flag", () => {
  const parsed = parseLoadReadinessArgs([
    "--url=http://127.0.0.1:5173/",
    "--target-url",
    "http://127.0.0.1:8787/api/health",
    "--concurrency=2",
    "--duration-ms=15",
    "--timeout-ms=7",
    "--output",
    "/tmp/load.json",
    "--allow-production-hosts"
  ]);

  assert.deepEqual(parsed.targetUrls, ["http://127.0.0.1:5173/", "http://127.0.0.1:8787/api/health"]);
  assert.equal(parsed.concurrency, 2);
  assert.equal(parsed.durationMs, 15);
  assert.equal(parsed.timeoutMs, 7);
  assert.equal(parsed.outputPath, "/tmp/load.json");
  assert.equal(parsed.allowProductionHosts, true);
});

test("runLoadReadiness records latency stats, counts, and redacts evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-load-readiness-"));
  const outputPath = join(root, "evidence.json");
  let clock = 0;
  const seen: Array<{ url: string; method?: string; token?: string }> = [];
  const report = await runLoadReadiness({
    targetUrl: "http://127.0.0.1:5173/?access_token=secret-value",
    concurrency: 1,
    durationMs: 7,
    timeoutMs: 100,
    readToken: "read-token",
    outputPath,
    now: () => clock,
    sleep: async () => {
      clock += 1;
    },
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), method: init?.method, token: headers.get("x-automation-os-token") ?? undefined });
      clock += seen.length === 1 ? 5 : 10;
      return new Response(seen.length === 1 ? "" : null, { status: seen.length === 1 ? 200 : 204 });
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
  assert.equal(report.requestCount > 0, true);
  assert.equal(report.failureCount, 0);
  assert.equal(report.latencyMs.sampleSize, report.requestCount);
  assert.equal(report.latencyMs.p50, 5);
  assert.equal(report.latencyMs.p95, 10);
  assert.equal(report.latencyMs.p99, 10);
  assert.deepEqual(seen.every((entry) => entry.method === "HEAD"), true);
  assert.deepEqual(seen.every((entry) => entry.token === "read-token"), true);
  assert.equal(existsSync(outputPath), true);
  const evidence = readFileSync(outputPath, "utf8");
  assert.match(evidence, /access_token=\[redacted\]/);
  assert.doesNotMatch(evidence, /secret-value/);
});

test("runLoadReadiness blocks production targets without the allow flag", async () => {
  await assert.rejects(
    () =>
      runLoadReadiness({
        targetUrl: "https://example.com/",
        outputPath: join(tmpdir(), "load-readiness-blocked.json"),
        fetchImpl: async () => new Response("", { status: 200 })
      }),
    /load_target_url_production_host_blocked/
  );
});

test("runLoadReadiness treats redirects as failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-load-readiness-redirect-"));
  const report = await runLoadReadiness({
    targetUrl: "http://127.0.0.1:8788/",
    concurrency: 1,
    durationMs: 2,
    timeoutMs: 100,
    outputPath: join(root, "evidence.json"),
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
    sleep: async () => undefined,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/login" } })
  });

  assert.equal(report.ok, false);
  assert.equal(report.failureCount > 0, true);
  assert.equal(report.errorCounts.http_302 > 0, true);
});

test("runLoadReadiness redacts the read token from failure codes and evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-load-readiness-token-"));
  const outputPath = join(root, "evidence.json");
  const report = await runLoadReadiness({
    targetUrl: "http://127.0.0.1:8788/",
    readToken: "synthetic-read-token",
    concurrency: 1,
    durationMs: 2,
    timeoutMs: 100,
    outputPath,
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
    sleep: async () => undefined,
    fetchImpl: async () => {
      throw new Error("upstream failed synthetic-read-token");
    }
  });

  assert.equal(report.ok, false);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-read-token/);
  assert.doesNotMatch(readFileSync(outputPath, "utf8"), /synthetic-read-token/);
});
