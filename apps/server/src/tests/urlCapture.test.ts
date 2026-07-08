import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runUrlCapture, type UrlCaptureFetch, type UrlCaptureResolver, type UrlCaptureResponse } from "../obsidian/urlCapture.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-url-capture-"));
const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";

test.after(() => {
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
});

test("URL capture fetches HTML, extracts readable text, and ingests url_capture", async () => {
  const vaultPath = createVault("success");
  const artifactRoot = join(tempRoot, "success-artifacts");
  const result = await runUrlCapture({
    url: "https://example.com/article?access_token=sample-token",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-14T06:00:00.000Z",
    fetchImpl: responseFetch({
      "https://example.com/article?access_token=sample-token": new Response("<html><head><title>Capture Title</title></head><body><article><h1>Hello</h1><p>Readable &amp; useful content.</p></article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    }),
    resolveHostnames: publicResolver
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "captured");
  assert.equal(result.ingest.sourceType, "url_capture");
  assert.equal(result.ingest.file, join("09_Inbox", "Capture-Title.md"));
  const markdown = readFileSync(result.ingest.path, "utf8");
  assert.match(markdown, /source_type: "url_capture"/);
  assert.match(markdown, /Readable & useful content/);
  assert.match(markdown, /access_token=\[redacted\]/);
  assert.doesNotMatch(markdown, /sample-token/);
  assert.equal(existsSync(artifactRoot), false);
});

test("URL capture connects to the prevalidated resolved public IP with original Host and SNI", async () => {
  const vaultPath = createVault("resolved-address");
  const seen: Array<{ address: string; hostHeader: string | undefined; servername: string }> = [];
  const result = await runUrlCapture({
    url: "https://rebind.test/article",
    vaultPath,
    capturedAt: "2026-06-14T06:10:00.000Z",
    fetchImpl: async (target, init) => {
      seen.push({
        address: target.address,
        hostHeader: init.headers.host,
        servername: target.servername
      });
      return new Response("<html><head><title>Resolved Address</title></head><body><p>Resolved public address content.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    },
    resolveHostnames: async (hostname) => {
      assert.equal(hostname, "rebind.test");
      return ["93.184.216.34"];
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [
    {
      address: "93.184.216.34",
      hostHeader: "rebind.test",
      servername: "rebind.test"
    }
  ]);
  assert.match(readFileSync(result.ingest.path, "utf8"), /Resolved public address content/);
});

test("URL capture applies timeout to body reads, not only response headers", async () => {
  const vaultPath = createVault("body-timeout");
  const result = await runUrlCapture({
    url: "https://example.com/slow-body",
    vaultPath,
    artifactRoot: join(tempRoot, "body-timeout-artifacts"),
    capturedAt: "2026-06-14T06:20:00.000Z",
    timeoutMs: 25,
    fetchImpl: async () => ({
      status: 200,
      headers: simpleHeaders({ "content-type": "text/plain" }),
      text: () => new Promise((resolve) => setTimeout(() => resolve("late body"), 250))
    }),
    resolveHostnames: publicResolver
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "url_capture_fetch_timeout");
  assert.match(readFileSync(result.ingest.path, "utf8"), /Exact blocker: url_capture_fetch_timeout/);
});

test("URL capture applies timeout while waiting for AsyncIterable body chunks", async () => {
  const vaultPath = createVault("async-body-timeout");
  let returned = false;
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        }
      };
    }
  };

  const result = await runUrlCapture({
    url: "https://example.com/slow-async-body",
    vaultPath,
    artifactRoot: join(tempRoot, "async-body-timeout-artifacts"),
    capturedAt: "2026-06-14T06:25:00.000Z",
    timeoutMs: 25,
    fetchImpl: async () => ({
      status: 200,
      headers: simpleHeaders({ "content-type": "text/plain" }),
      body
    }),
    resolveHostnames: publicResolver
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "url_capture_fetch_timeout");
  assert.equal(returned, true);
  assert.match(readFileSync(result.ingest.path, "utf8"), /Exact blocker: url_capture_fetch_timeout/);
});

test("URL capture redacts explicit sourceTitle and HTML title before response and markdown output", async () => {
  const htmlTitleVault = createVault("html-title-redaction");
  const htmlTitleResult = await runUrlCapture({
    url: "https://example.com/html-title",
    vaultPath: htmlTitleVault,
    capturedAt: "2026-06-14T06:30:00.000Z",
    fetchImpl: responseFetch({
      "https://example.com/html-title": new Response("<html><head><title>Report token-secret-12345</title></head><body><p>Safe title body.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    }),
    resolveHostnames: publicResolver
  });
  assert.equal(htmlTitleResult.ok, true);
  assert.equal(htmlTitleResult.sourceTitle, "Report [redacted-token]");
  const htmlTitleMarkdown = readFileSync(htmlTitleResult.ingest.path, "utf8");
  assert.doesNotMatch(JSON.stringify(htmlTitleResult), /token-secret-12345/);
  assert.doesNotMatch(htmlTitleMarkdown, /token-secret-12345/);
  assert.match(htmlTitleMarkdown, /source_title: "Report \[redacted-token\]"/);

  const sourceTitleVault = createVault("source-title-redaction");
  const sourceTitleResult = await runUrlCapture({
    url: "https://example.com/source-title",
    sourceTitle: "Manual sample_value_1234567890ABCDEF",
    vaultPath: sourceTitleVault,
    capturedAt: "2026-06-14T06:31:00.000Z",
    fetchImpl: responseFetch({
      "https://example.com/source-title": new Response("<html><head><title>Ignored Title</title></head><body><p>Safe source title body.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    }),
    resolveHostnames: publicResolver
  });
  assert.equal(sourceTitleResult.ok, true);
  assert.equal(sourceTitleResult.sourceTitle, "Manual [redacted-token]");
  const sourceTitleMarkdown = readFileSync(sourceTitleResult.ingest.path, "utf8");
  assert.doesNotMatch(JSON.stringify(sourceTitleResult), /sample_value_1234567890ABCDEF/);
  assert.doesNotMatch(sourceTitleMarkdown, /sample_value_1234567890ABCDEF/);
  assert.match(sourceTitleMarkdown, /source_title: "Manual \[redacted-token\]"/);
});

test("URL capture blocks X/Twitter without fetching and writes blocker artifacts plus inbox note", async () => {
  const vaultPath = createVault("twitter-blocked");
  let fetchCount = 0;
  let resolveCount = 0;
  const result = await runUrlCapture({
    url: "https://x.com/example/status/123",
    vaultPath,
    artifactRoot: join(tempRoot, "twitter-artifacts"),
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("should not fetch");
    },
    resolveHostnames: async () => {
      resolveCount += 1;
      throw new Error("X/Twitter URLs must be blocked before DNS");
    }
  });

  assert.equal(fetchCount, 0);
  assert.equal(resolveCount, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "url_capture_x_twitter_blocked");
  assert.equal(existsSync(result.manifestFile), true);
  assert.equal(existsSync(result.blockerFile), true);
  assert.equal(existsSync(result.responseFile), true);
  assert.equal(existsSync(result.contentFile), true);
  const blockerNote = readFileSync(result.ingest.path, "utf8");
  assert.match(blockerNote, /source_type: "url_capture_blocked"/);
  assert.match(blockerNote, /Exact blocker: url_capture_x_twitter_blocked/);
});

test("URL capture blocks X/Twitter intent post URLs before fetch or DNS", async () => {
  const cases = ["https://x.com/intent/post?text=hello", "https://twitter.com/intent/post?text=hello"];

  for (const url of cases) {
    const vaultPath = createVault(`twitter-intent-post-${cases.indexOf(url)}`);
    let fetchCount = 0;
    let resolveCount = 0;
    const result = await runUrlCapture({
      url,
      vaultPath,
      artifactRoot: join(tempRoot, `twitter-intent-post-artifacts-${cases.indexOf(url)}`),
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response("should not fetch");
      },
      resolveHostnames: async () => {
        resolveCount += 1;
        throw new Error("X/Twitter intent URLs must be blocked before DNS");
      }
    });

    assert.equal(fetchCount, 0, url);
    assert.equal(resolveCount, 0, url);
    assert.equal(result.ok, false, url);
    assert.equal(result.status, "blocked", url);
    assert.equal(result.exactBlocker, "url_capture_x_twitter_blocked", url);
  }
});

test("URL capture blocks redirects to X/Twitter before resolving or fetching the redirected host", async () => {
  const vaultPath = createVault("twitter-redirect-blocked");
  const resolvedHosts: string[] = [];
  const fetchedUrls: string[] = [];
  const result = await runUrlCapture({
    url: "https://example.com/redirect-to-x",
    vaultPath,
    artifactRoot: join(tempRoot, "twitter-redirect-artifacts"),
    fetchImpl: async (target) => {
      fetchedUrls.push(target.url.toString());
      return new Response("", {
        status: 302,
        headers: { location: "https://twitter.com/example/status/123?access_token=sample-token" }
      });
    },
    resolveHostnames: async (hostname) => {
      resolvedHosts.push(hostname);
      if (hostname.includes("twitter.com")) throw new Error("redirected X/Twitter host must not be resolved");
      return ["93.184.216.34"];
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "url_capture_x_twitter_blocked");
  assert.deepEqual(fetchedUrls, ["https://example.com/redirect-to-x"]);
  assert.deepEqual(resolvedHosts, ["example.com"]);
  const combined = [readFileSync(result.manifestFile, "utf8"), readFileSync(result.blockerFile, "utf8"), readFileSync(result.ingest.path, "utf8")].join("\n");
  assert.match(combined, /twitter\.com\/example\/status\/123\?access_token=\[redacted\]/);
  assert.doesNotMatch(combined, /sample-token/);
});

test("URL capture rejects private initial targets before fetch", async () => {
  const vaultPath = createVault("private-initial");
  let fetchCount = 0;
  const result = await runUrlCapture({
    url: "http://127.0.0.1:8787/private",
    vaultPath,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("private");
    },
    resolveHostnames: publicResolver
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.exactBlocker, "url_capture_private_address");
  assert.deepEqual(readdirSync(join(vaultPath, "09_Inbox")), []);
});

test("URL capture rejects private IPv6 and IPv4-mapped IPv6 addresses returned by DNS before fetch", async () => {
  const cases = ["::", "::1", "fe80::1", "febf::1", "fc00::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.1.1"];

  for (const address of cases) {
    const vaultPath = createVault(`private-dns-${address.replace(/[^a-z0-9]/giu, "-")}`);
    let fetchCount = 0;
    const result = await runUrlCapture({
      url: `https://private-dns-${cases.indexOf(address)}.test/article`,
      vaultPath,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response("private");
      },
      resolveHostnames: async () => [address]
    });

    assert.equal(fetchCount, 0, address);
    assert.equal(result.ok, false, address);
    assert.equal(result.status, "rejected", address);
    assert.equal(result.exactBlocker, "url_capture_private_address", address);
  }
});

test("URL capture rejects private IPv6 literals before DNS and fetch", async () => {
  const cases = ["http://[::]/private", "http://[::1]/private", "http://[fe80::1]/private", "http://[fc00::1]/private", "http://[::ffff:127.0.0.1]/private", "http://[::ffff:7f00:1]/private"];

  for (const url of cases) {
    const vaultPath = createVault(`private-literal-${cases.indexOf(url)}`);
    let fetchCount = 0;
    let resolveCount = 0;
    const result = await runUrlCapture({
      url,
      vaultPath,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response("private");
      },
      resolveHostnames: async () => {
        resolveCount += 1;
        return ["93.184.216.34"];
      }
    });

    assert.equal(fetchCount, 0, url);
    assert.equal(resolveCount, 0, url);
    assert.equal(result.ok, false, url);
    assert.equal(result.status, "rejected", url);
    assert.equal(result.exactBlocker, "url_capture_private_address", url);
  }
});

test("URL capture blocks redirects to private targets and records exact blocker", async () => {
  const vaultPath = createVault("private-redirect");
  const result = await runUrlCapture({
    url: "https://example.com/redirect",
    vaultPath,
    artifactRoot: join(tempRoot, "redirect-artifacts"),
    fetchImpl: responseFetch({
      "https://example.com/redirect": new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" }
      })
    }),
    resolveHostnames: publicResolver
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "url_capture_private_redirect");
  const manifest = readFileSync(result.manifestFile, "utf8");
  assert.match(manifest, /url_capture_private_redirect/);
  assert.match(readFileSync(result.ingest.path, "utf8"), /source_type: "url_capture_blocked"/);
});

test("URL capture redacts credentials, tokens, and auth-like content in blocked artifacts and notes", async () => {
  const vaultPath = createVault("redaction");
  const jwt = "jwt_sample_123";
  const githubToken = "github_token_sample_123";
  const slackToken = "slack_token_sample_123";
  const awsKey = "aws_key_sample_123";
  const result = await runUrlCapture({
    url: "https://user:pass@example.com/private?access_token=sample-token&id_token=sample-id&safe=ok#code=sample-code&key=sample-key",
    sourceTitle: "Blocked sample_value_1234567890ABCDEF",
    vaultPath,
    artifactRoot: join(tempRoot, "redaction-artifacts"),
    fetchImpl: responseFetch({
      "https://user:pass@example.com/private?access_token=sample-token&id_token=sample-id&safe=ok#code=sample-code&key=sample-key": new Response(`Authorization: Bearer sample_value_1234567890ABCDEF ${jwt} ${githubToken} ${slackToken} ${awsKey}`, {
        status: 403,
        statusText: `Forbidden sample-token ${githubToken}`,
        headers: {
          "content-type": "text/plain",
          "set-cookie": "session=sample-token",
          "x-response-url": "https://example.com/callback?token=response-token#secret=response-secret"
        }
      })
    }),
    resolveHostnames: publicResolver
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  const combined = [
    readFileSync(result.manifestFile, "utf8"),
    readFileSync(result.blockerFile, "utf8"),
    readFileSync(result.responseFile, "utf8"),
    readFileSync(result.contentFile, "utf8"),
    readFileSync(result.ingest.path, "utf8")
  ].join("\n");
  assert.match(combined, /\[redacted-auth\]/);
  assert.match(combined, /access_token=\[redacted\]/);
  assert.match(combined, /id_token=\[redacted\]/);
  assert.match(combined, /#code=\[redacted\]&key=\[redacted\]/);
  assert.match(combined, /safe=ok/);
  assert.match(combined, /\[redacted-token\]/);
  assert.doesNotMatch(combined, /user:pass/);
  assert.doesNotMatch(combined, /sample-token/);
  assert.doesNotMatch(combined, /secret-id/);
  assert.doesNotMatch(combined, /secret-code/);
  assert.doesNotMatch(combined, /secret-key/);
  assert.doesNotMatch(combined, /sample_value_1234567890ABCDEF/);
  assert.equal(combined.includes(jwt), false);
  assert.equal(combined.includes(githubToken), false);
  assert.equal(combined.includes(slackToken), false);
  assert.equal(combined.includes(awsKey), false);
});

test("URL capture redacts rejected raw URLs before returning parse errors", async () => {
  const result = await runUrlCapture({
    url: "ftp://user:pass@example.com/private?access_token=sample-token#code=sample-code",
    vaultPath: createVault("rejected-redaction")
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.exactBlocker, "url_capture_scheme_blocked");
  assert.match(result.requestedUrl ?? "", /\[redacted-auth\]/);
  assert.match(result.requestedUrl ?? "", /access_token=\[redacted\]/);
  assert.match(result.requestedUrl ?? "", /#code=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result), /user:pass|sample-token|secret-code/);
});

function createVault(name: string): string {
  const vaultPath = join(tempRoot, name);
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  return vaultPath;
}

function responseFetch(responses: Record<string, Response>): UrlCaptureFetch {
  return async (target) => {
    const url = target.url.toString();
    const response = responses[url];
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  };
}

function simpleHeaders(values: Record<string, string>): UrlCaptureResponse["headers"] {
  return {
    get(name: string): string | null {
      return values[name.toLowerCase()] ?? null;
    },
    entries(): IterableIterator<[string, string]> {
      return new Map(Object.entries(values)).entries();
    }
  };
}

const publicResolver: UrlCaptureResolver = async () => ["93.184.216.34"];
