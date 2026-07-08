import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildOpenXLearningChromeCommand, xLearningLane } from "../browser/xLearningLane.js";
import { getXLearningChromeHealth } from "../browser/xLearningHealth.js";
import {
  parseRuntimeEvaluateByValue,
  runAuthenticatedBrowserCapture,
  validateCaptureUrl,
  type AuthenticatedBrowserCdpClient
} from "../obsidian/authenticatedBrowserCapture.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-x-auth-capture-"));
const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";

test.after(() => {
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
});

test("X learning lane command is fixed to port 9336 and the dedicated profile without fallback ports", () => {
  const command = buildOpenXLearningChromeCommand("/Applications/Test Chrome.app/Contents/MacOS/Google Chrome");
  const serialized = [command.bin, ...command.args].join(" ");

  assert.equal(command.laneName, "x_learning_authenticated_cdp");
  assert.equal(command.port, 9336);
  assert.equal(command.profileDir, "/Users/nichikatanaka/.x-learning-playwright-chrome");
  assert.ok(command.args.includes("--remote-debugging-port=9336"));
  assert.ok(command.args.includes("--user-data-dir=/Users/nichikatanaka/.x-learning-playwright-chrome"));
  assert.ok(command.args.includes("--profile-directory=Default"));
  assert.ok(command.args.includes("https://x.com/home"));
  assert.doesNotMatch(serialized, /9333|9334|9335|9222/u);
});

test("X learning health checks only the fixed 9336 json/version endpoint", async () => {
  const seen: string[] = [];
  const result = await getXLearningChromeHealth(async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ Browser: "Chrome/Test", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/browser/test" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.port, 9336);
  assert.equal(result.profileDir, xLearningLane.profileDir);
  assert.deepEqual(seen, ["http://127.0.0.1:9336/json/version"]);
});

test("authenticated browser capture allows only X/Twitter read URLs and rejects posting or account surfaces", () => {
  assert.equal(validateCaptureUrl("https://x.com/example/status/123").ok, true);
  assert.equal(validateCaptureUrl("https://twitter.com/example/status/123").ok, true);
  assert.equal(validateCaptureUrl("https://x.com/i/web/status/123").ok, true);

  const rejected = [
    ["https://example.com/example/status/123", "x_auth_capture_host_blocked"],
    ["https://developer.x.com/example/status/123", "x_auth_capture_host_blocked"],
    ["https://mobile.twitter.com/example/status/123", "x_auth_capture_host_blocked"],
    ["http://x.com/example/status/123", "x_auth_capture_scheme_blocked"],
    ["https://x.com/intent/tweet?text=hello", "x_auth_capture_forbidden_path"],
    ["https://x.com/intent/post?text=hello", "x_auth_capture_forbidden_path"],
    ["https://twitter.com/intent/post?text=hello", "x_auth_capture_forbidden_path"],
    ["https://x.com/intent/follow?screen_name=example", "x_auth_capture_forbidden_path"],
    ["https://x.com/compose/post", "x_auth_capture_forbidden_path"],
    ["https://x.com/i/flow/login", "x_auth_capture_forbidden_path"],
    ["https://x.com/settings/account", "x_auth_capture_forbidden_path"],
    ["https://x.com/messages", "x_auth_capture_forbidden_path"],
    ["https://x.com/notifications", "x_auth_capture_forbidden_path"],
    ["https://x.com/home", "x_auth_capture_forbidden_path"],
    ["https://x.com/search?q=test", "x_auth_capture_unsupported_read_path"],
    ["https://x.com/explore", "x_auth_capture_unsupported_read_path"],
    ["https://x.com/i/bookmarks", "x_auth_capture_unsupported_read_path"],
    ["https://x.com/search/status/123", "x_auth_capture_unsupported_read_path"],
    ["https://x.com/explore/status/123", "x_auth_capture_unsupported_read_path"],
    ["https://x.com/bookmarks/status/123", "x_auth_capture_unsupported_read_path"],
    ["https://x.com/status/status/123", "x_auth_capture_unsupported_read_path"]
  ];

  for (const [url, exactBlocker] of rejected) {
    const result = validateCaptureUrl(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.exactBlocker, exactBlocker, url);
  }
});

test("Runtime.evaluate parser returns by-value results and rejects ambiguous CDP envelopes", () => {
  const page = {
    title: "Thread title",
    currentUrl: "https://x.com/example/status/123",
    textCandidates: [{ method: "data-testid=tweetText", selector: "[data-testid='tweetText']", text: "body" }]
  };

  assert.deepEqual(parseRuntimeEvaluateByValue({ result: { result: { type: "object", value: page } } }), page);

  const rejected = [
    [{ result: { exceptionDetails: { text: "boom" }, result: { type: "object", value: page } } }, "x_auth_capture_runtime_evaluate_exception"],
    [{}, "x_auth_capture_runtime_evaluate_missing_result"],
    [{ result: {} }, "x_auth_capture_runtime_evaluate_missing_remote_object"],
    [{ result: { result: { type: "object", objectId: "remote-1" } } }, "x_auth_capture_runtime_evaluate_object_id_only"]
  ] as const;

  for (const [envelope, message] of rejected) {
    assert.throws(() => parseRuntimeEvaluateByValue(envelope), { message });
  }
});

test("authenticated browser capture extracts fake CDP text, writes redacted artifacts, and creates an Obsidian note", async () => {
  const vaultPath = createVault("fake-cdp");
  const artifactRoot = join(tempRoot, "fake-cdp-artifacts");
  const cdpClient = new FakeCdpClient({
    title: "Thread sample_value_1234567890ABCDEF",
    currentUrl: "https://x.com/example/status/123?access_token=sample-token",
    bodyText: "Account menu Sidebar Trends Notifications Messages nav must not be saved.",
    documentText: "Fallback document text must not be saved.",
    textCandidates: [
      {
        method: "data-testid=tweetText",
        selector: "article [data-testid='tweetText']",
        text: "Useful thread text with Bearer sample_value_1234567890ABCDEF and email test@example.com."
      }
    ]
  });

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123?access_token=sample-token",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:00:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, true);
  assert.equal(cdpClient.openedUrl, "https://x.com/example/status/123?access_token=sample-token");
  assert.equal(cdpClient.closed, true);
  if (!result.ok) throw new Error("expected capture success");

  assert.equal(result.ingest.sourceType, "authenticated_browser_capture");
  assert.equal(existsSync(result.files.manifest), true);
  assert.equal(existsSync(result.files.stageOpen), true);
  assert.equal(existsSync(result.files.stageExtract), true);
  assert.equal(existsSync(result.files.pageRedacted), true);
  assert.equal(existsSync(result.files.bodyRedacted), true);
  assert.equal(existsSync(result.files.ingest), true);

  const combined = [
    readFileSync(result.files.manifest, "utf8"),
    readFileSync(result.files.stageOpen, "utf8"),
    readFileSync(result.files.stageExtract, "utf8"),
    readFileSync(result.files.pageRedacted, "utf8"),
    readFileSync(result.files.bodyRedacted, "utf8"),
    readFileSync(result.files.ingest, "utf8"),
    readFileSync(result.ingest.path, "utf8")
  ].join("\n");

  assert.match(combined, /source_type: "authenticated_browser_capture"/);
  assert.match(combined, /x_auth_capture_screenshot_skipped_dom_redaction_not_proven/);
  assert.match(combined, /access_token=\[redacted\]/);
  assert.match(combined, /\[redacted-token\]/);
  assert.match(combined, /\[redacted-email\]/);
  assert.doesNotMatch(combined, /sample-token/);
  assert.doesNotMatch(combined, /sample_value_1234567890ABCDEF/);
  assert.doesNotMatch(combined, /test@example\.com/);
  assert.doesNotMatch(combined, /Account menu|Sidebar|Trends|Notifications|Messages|nav must not be saved|Fallback document text/);
  assert.doesNotMatch(combined, /<html|<body|localStorage|cookie/iu);
});

test("authenticated browser capture accepts article.innerText fallback when primary tweetText candidates are empty", async () => {
  const vaultPath = createVault("article-fallback");
  const artifactRoot = join(tempRoot, "article-fallback-artifacts");
  const cdpClient = new FakeCdpClient({
    title: "Fallback article",
    currentUrl: "https://x.com/example/status/123",
    textCandidates: [
      {
        method: "article.innerText:fallback",
        selector: "article",
        text: "Article fallback body with useful captured text."
      }
    ]
  });

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:04:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, true);
  assert.equal(cdpClient.closed, true);
  if (!result.ok) throw new Error("expected capture success");

  const combined = [
    readFileSync(result.files.stageExtract, "utf8"),
    readFileSync(result.files.bodyRedacted, "utf8"),
    readFileSync(result.ingest.path, "utf8")
  ].join("\n");

  assert.match(combined, /Article fallback body with useful captured text/);
  assert.match(combined, /article\.innerText:fallback/);
  assert.match(combined, /"rawCandidateCount": 1/);
  assert.match(combined, /"acceptedCandidateCount": 1/);
});

test("authenticated browser capture retries no text candidates once and accepts article.innerText fallback", async () => {
  const vaultPath = createVault("retry-article-fallback");
  const artifactRoot = join(tempRoot, "retry-article-fallback-artifacts");
  const cdpClient = new SequenceCdpClient([
    {
      title: "Retry fallback first",
      currentUrl: "https://x.com/example/status/123",
      textCandidates: []
    },
    {
      title: "Retry fallback second",
      currentUrl: "https://x.com/example/status/123",
      textCandidates: [
        {
          method: "article.innerText:fallback",
          selector: "article",
          text: "Article fallback body captured on bounded retry."
        }
      ]
    }
  ]);

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:09:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, true);
  assert.equal(cdpClient.evaluateCalls, 2);
  assert.equal(cdpClient.closed, true);
  if (!result.ok) throw new Error("expected capture success");

  const stageExtract = JSON.parse(readFileSync(result.files.stageExtract, "utf8")) as {
    extractionAttemptCount?: number;
    extractionAttempts?: Array<{ candidateStats?: { rawCandidateCount?: number }; wouldBlocker?: string | null }>;
  };
  const manifest = JSON.parse(readFileSync(result.files.manifest, "utf8")) as {
    extractionAttemptCount?: number;
    extractionAttempts?: unknown[];
  };
  const stageAndManifest = [
    readFileSync(result.files.stageExtract, "utf8"),
    readFileSync(result.files.manifest, "utf8")
  ].join("\n");

  assert.equal(stageExtract.extractionAttemptCount, 2);
  assert.equal(manifest.extractionAttemptCount, 2);
  assert.equal(stageExtract.extractionAttempts?.[0]?.candidateStats?.rawCandidateCount, 0);
  assert.equal(stageExtract.extractionAttempts?.[0]?.wouldBlocker, "x_auth_capture_no_text_candidates");
  assert.equal(stageExtract.extractionAttempts?.[1]?.candidateStats?.rawCandidateCount, 1);
  assert.equal(stageExtract.extractionAttempts?.[1]?.wouldBlocker, null);
  assert.equal(manifest.extractionAttempts?.length, 2);
  assert.match(readFileSync(result.files.bodyRedacted, "utf8"), /Article fallback body captured on bounded retry/);
  assert.doesNotMatch(stageAndManifest, /Article fallback body captured on bounded retry/);
});

test("authenticated browser capture retries no text candidates at most three attempts", async () => {
  const vaultPath = createVault("retry-no-text-max");
  const artifactRoot = join(tempRoot, "retry-no-text-max-artifacts");
  const emptyPage = {
    title: "Retry no text",
    currentUrl: "https://x.com/example/status/123",
    textCandidates: []
  };
  const cdpClient = new SequenceCdpClient([emptyPage, emptyPage, emptyPage, emptyPage]);

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:10:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "x_auth_capture_no_text_candidates");
  assert.equal(cdpClient.evaluateCalls, 3);
  assert.equal(cdpClient.closed, true);
  if (result.ok) throw new Error("expected capture blocker");

  const stageExtract = JSON.parse(readFileSync(result.files?.stageExtract ?? "", "utf8")) as {
    extractionAttemptCount?: number;
    extractionAttempts?: Array<{ candidateStats?: { rawCandidateCount?: number }; wouldBlocker?: string | null }>;
  };
  const manifest = JSON.parse(readFileSync(result.files?.manifest ?? "", "utf8")) as {
    extractionAttemptCount?: number;
    extractionAttempts?: unknown[];
  };

  assert.equal(stageExtract.extractionAttemptCount, 3);
  assert.equal(manifest.extractionAttemptCount, 3);
  assert.equal(stageExtract.extractionAttempts?.length, 3);
  assert.equal(manifest.extractionAttempts?.length, 3);
  for (const attempt of stageExtract.extractionAttempts ?? []) {
    assert.equal(attempt.candidateStats?.rawCandidateCount, 0);
    assert.equal(attempt.wouldBlocker, "x_auth_capture_no_text_candidates");
  }
  assert.equal(existsSync(result.files?.pageRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.bodyRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.ingest ?? ""), false);
});

test("authenticated browser capture blocks without saving account, sidebar, trends, or nav text when allowlist containers are empty", async () => {
  const vaultPath = createVault("empty-allowlist");
  const artifactRoot = join(tempRoot, "empty-allowlist-artifacts");
  const cdpClient = new FakeCdpClient({
    title: "Empty allowlist",
    currentUrl: "https://x.com/example/status/123",
    bodyText: "Account Sidebar Trends Home Explore Notifications Messages nav outside tweet text.",
    documentText: "More sidebar and account text outside the tweet body.",
    textCandidates: [
      {
        method: "document.body.innerText",
        selector: "body",
        text: "Account Sidebar Trends Home Explore Notifications Messages nav outside tweet text."
      },
      {
        method: "data-testid=tweetText",
        selector: "article [lang]",
        text: "Account Sidebar Trends Home Explore Notifications Messages crossed pair text."
      },
      {
        method: "article-lang",
        selector: "article [lang]",
        text: "Account Sidebar Trends Home Explore Notifications Messages article lang text."
      }
    ]
  });

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:05:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "x_auth_capture_non_allowlisted_text_candidates");
  assert.equal(cdpClient.evaluateCalls, 1);
  assert.equal(cdpClient.closed, true);
  if (result.ok) throw new Error("expected capture blocker");

  const combined = [
    readFileSync(result.files?.manifest ?? "", "utf8"),
    readFileSync(result.files?.stageOpen ?? "", "utf8"),
    readFileSync(result.files?.stageExtract ?? "", "utf8")
  ].join("\n");

  assert.match(combined, /x_auth_capture_non_allowlisted_text_candidates/);
  assert.match(combined, /"rawCandidateCount": 3/);
  assert.match(combined, /"acceptedCandidateCount": 0/);
  assert.match(combined, /"nonAllowlistedCandidateCount": 3/);
  assert.match(combined, /"extractionAttemptCount": 1/);
  assert.doesNotMatch(combined, /Account|Sidebar|Trends|Home|Explore|Notifications|Messages|nav outside|tweet body|crossed pair text|article lang text/);
  assert.equal(existsSync(result.files?.pageRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.bodyRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.ingest ?? ""), false);
});

test("authenticated browser capture blocks article fallback mixed with non-allowlisted text candidates without saving either text", async () => {
  const vaultPath = createVault("fallback-mixed-allowlist");
  const artifactRoot = join(tempRoot, "fallback-mixed-allowlist-artifacts");
  const cdpClient = new FakeCdpClient({
    title: "Fallback mixed allowlist",
    currentUrl: "https://x.com/example/status/123",
    textCandidates: [
      {
        method: "article.innerText:fallback",
        selector: "article",
        text: "Allowed fallback body should not be saved when mixed with bad candidates."
      },
      {
        method: "document.body.innerText",
        selector: "body",
        text: "Account Sidebar Trends body text should not be saved."
      }
    ]
  });

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:07:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "x_auth_capture_non_allowlisted_text_candidates");
  if (result.ok) throw new Error("expected capture blocker");

  const combined = [
    readFileSync(result.files?.manifest ?? "", "utf8"),
    readFileSync(result.files?.stageExtract ?? "", "utf8")
  ].join("\n");

  assert.match(combined, /"rawCandidateCount": 2/);
  assert.match(combined, /"acceptedCandidateCount": 1/);
  assert.match(combined, /"nonAllowlistedCandidateCount": 1/);
  assert.doesNotMatch(combined, /Allowed fallback body|Account Sidebar Trends/);
  assert.equal(existsSync(result.files?.pageRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.bodyRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.ingest ?? ""), false);
});

test("authenticated browser capture blocks mixed allowlisted and non-allowlisted text candidates without saving either text", async () => {
  const vaultPath = createVault("mixed-allowlist");
  const artifactRoot = join(tempRoot, "mixed-allowlist-artifacts");
  const cdpClient = new FakeCdpClient({
    title: "Mixed allowlist",
    currentUrl: "https://x.com/example/status/123",
    textCandidates: [
      {
        method: "data-testid=tweetText",
        selector: "article [data-testid='tweetText']",
        text: "Allowed tweet body should not be saved when mixed with bad candidates."
      },
      {
        method: "data-testid=tweetText",
        selector: "article [lang]",
        text: "Account Sidebar Trends crossed pair should not be saved."
      }
    ]
  });

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:06:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "x_auth_capture_non_allowlisted_text_candidates");
  if (result.ok) throw new Error("expected capture blocker");

  const combined = [
    readFileSync(result.files?.manifest ?? "", "utf8"),
    readFileSync(result.files?.stageExtract ?? "", "utf8")
  ].join("\n");

  assert.match(combined, /"rawCandidateCount": 2/);
  assert.match(combined, /"acceptedCandidateCount": 1/);
  assert.match(combined, /"nonAllowlistedCandidateCount": 1/);
  assert.doesNotMatch(combined, /Allowed tweet body|Account Sidebar Trends/);
  assert.equal(existsSync(result.files?.pageRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.bodyRedacted ?? ""), false);
  assert.equal(existsSync(result.files?.ingest ?? ""), false);
});

test("authenticated browser capture preserves Runtime.evaluate parser blockers at the evaluate boundary", async () => {
  const vaultPath = createVault("runtime-evaluate-blocker");
  const artifactRoot = join(tempRoot, "runtime-evaluate-blocker-artifacts");
  const cdpClient = new ThrowingEvaluateCdpClient("x_auth_capture_runtime_evaluate_object_id_only");

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T07:00:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "x_auth_capture_runtime_evaluate_object_id_only");
  assert.equal(cdpClient.closed, true);
  if (result.ok) throw new Error("expected capture blocker");

  const stageExtract = JSON.parse(readFileSync(result.files?.stageExtract ?? "", "utf8")) as { exactBlocker?: string; summary?: string };
  assert.equal(stageExtract.exactBlocker, "x_auth_capture_runtime_evaluate_object_id_only");
  assert.equal(stageExtract.summary, "x_auth_capture_runtime_evaluate_object_id_only");
});

test("authenticated browser capture extraction expression keeps fallback scoped and avoids prohibited full-page or action APIs", async () => {
  const cdpClient = new CaptureExpressionCdpClient();

  const result = await runAuthenticatedBrowserCapture({
    url: "https://x.com/example/status/123",
    vaultPath: createVault("capture-expression"),
    artifactRoot: join(tempRoot, "capture-expression-artifacts"),
    capturedAt: "2026-06-14T07:08:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "x_auth_capture_runtime_evaluate_object_id_only");
  assert.match(cdpClient.expression, /article \[data-testid='tweetText'\]/u);
  assert.match(cdpClient.expression, /primaryCandidates\.some\(\(candidate\) => candidate\.text\)/u);
  assert.match(cdpClient.expression, /method: "article\.innerText:fallback"/u);
  assert.match(cdpClient.expression, /selector: "article"/u);
  assert.doesNotMatch(cdpClient.expression, /document\.body\.innerText|document\.documentElement\.innerText/u);
  assert.doesNotMatch(cdpClient.expression, /localStorage|cookie|click|dispatchEvent|submit|input/iu);
});

class FakeCdpClient implements AuthenticatedBrowserCdpClient {
  openedUrl = "";
  closed = false;
  evaluateCalls = 0;

  constructor(private readonly page: Record<string, unknown>) {}

  async openUrl(url: string): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    this.openedUrl = url;
    return { targetId: "target-fake", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/fake" };
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluateCalls += 1;
    assert.match(expression, /document\.title/u);
    assert.match(expression, /querySelectorAll/u);
    assert.match(expression, /data-testid=['"]tweetText/u);
    assert.match(expression, /article\.innerText:fallback/u);
    assert.match(expression, /primaryCandidates\.some\(\(candidate\) => candidate\.text\)/u);
    assert.match(expression, /article/u);
    assert.doesNotMatch(expression, /document\.body\.innerText|document\.documentElement\.innerText/u);
    assert.doesNotMatch(expression, /localStorage|cookie|click|dispatchEvent|submit|input/iu);
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class SequenceCdpClient implements AuthenticatedBrowserCdpClient {
  openedUrl = "";
  closed = false;
  evaluateCalls = 0;

  constructor(private readonly pages: Record<string, unknown>[]) {}

  async openUrl(url: string): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    this.openedUrl = url;
    return { targetId: "target-fake", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/fake" };
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluateCalls += 1;
    assert.match(expression, /document\.title/u);
    assert.match(expression, /querySelectorAll/u);
    assert.match(expression, /data-testid=['"]tweetText/u);
    assert.match(expression, /article\.innerText:fallback/u);
    assert.doesNotMatch(expression, /document\.body\.innerText|document\.documentElement\.innerText/u);
    assert.doesNotMatch(expression, /localStorage|cookie|click|dispatchEvent|submit|input/iu);
    return this.pages[Math.min(this.evaluateCalls - 1, this.pages.length - 1)] ?? {};
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class CaptureExpressionCdpClient implements AuthenticatedBrowserCdpClient {
  expression = "";

  async openUrl(): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    return { targetId: "target-fake", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/fake" };
  }

  async evaluate(expression: string): Promise<unknown> {
    this.expression = expression;
    throw new Error("x_auth_capture_runtime_evaluate_object_id_only");
  }
}

class ThrowingEvaluateCdpClient implements AuthenticatedBrowserCdpClient {
  closed = false;

  constructor(private readonly message: string) {}

  async openUrl(): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    return { targetId: "target-fake", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/fake" };
  }

  async evaluate(): Promise<unknown> {
    throw new Error(this.message);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createVault(name: string): string {
  const vaultPath = join(tempRoot, name);
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  return vaultPath;
}
