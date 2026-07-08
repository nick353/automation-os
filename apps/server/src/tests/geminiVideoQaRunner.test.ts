import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGeminiVideoQaCli } from "../browser/geminiVideoQaRunner.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "automation-os-gemini-video-qa-"));
  const videoPath = join(root, "recording.webm");
  const outputPath = join(root, "gemini-video-qa.json");
  const manifestPath = join(root, "recording-qa-manifest.json");
  writeFileSync(videoPath, "webm");
  writeFileSync(manifestPath, "{}\n");
  return { root, videoPath, outputPath, manifestPath };
}

function args(input: ReturnType<typeof fixture>): string[] {
  return ["--video", input.videoPath, "--output", input.outputPath, "--manifest", input.manifestPath, "--target-url", "http://127.0.0.1:5173/#schedule"];
}

function readQa(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function geminiResponse(payload: Record<string, unknown>, init: ResponseInit = { status: 200 }): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(payload) }]
          }
        }
      ]
    }),
    init
  );
}

test("Gemini video QA runner writes successful validator-compatible JSON", async () => {
  const input = fixture();
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const code = await runGeminiVideoQaCli(
    args(input),
    { GEMINI_API_KEY: "secret-key", AUTOMATION_OS_GEMINI_VIDEO_QA_MODEL: "gemini-test" },
    async (url, init) => {
      requestUrl = url;
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "secret-key");
      return geminiResponse({
        status: "ok",
        verdict: "pass",
        completion_gate_alignment: "match",
        completion_gate_matches: true,
        summary: "The recording matches the target."
      });
    }
  );

  assert.equal(code, 0);
  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  assert.match(JSON.stringify(requestBody), /"mime_type":"video\/webm"/);
  const qa = readQa(input.outputPath);
  assert.equal(qa.provider, "gemini");
  assert.equal(qa.model, "gemini-test");
  assert.equal(qa.kind, "gemini_video_qa");
  assert.equal(qa.status, "ok");
  assert.equal(qa.verdict, "pass");
  assert.equal(qa.completion_gate_alignment, "match");
  assert.equal(qa.completion_gate_matches, true);
  assert.equal(qa.exact_blocker, null);
  assert.equal(qa.video_artifact_uri, input.videoPath);
  assert.equal(qa.target_url, "http://127.0.0.1:5173/#schedule");
});

test("Gemini video QA runner exits zero for completion mismatch with valid QA JSON", async () => {
  const input = fixture();
  const code = await runGeminiVideoQaCli(
    args(input),
    { GEMINI_API_KEY: "secret-key" },
    async () =>
      geminiResponse({
        status: "blocked",
        verdict: "mismatch",
        completion_gate_alignment: "mismatch",
        completion_gate_matches: false,
        summary: "The recording shows the wrong target.",
        exact_blocker: "browser_use_recording_target_mismatch",
        repair_owner: "runner"
      })
  );

  assert.equal(code, 0);
  const qa = readQa(input.outputPath);
  assert.equal(qa.status, "blocked");
  assert.equal(qa.verdict, "mismatch");
  assert.equal(qa.completion_gate_alignment, "mismatch");
  assert.equal(qa.completion_gate_matches, false);
  assert.equal(qa.exact_blocker, "browser_use_recording_target_mismatch");
  assert.equal(qa.repair_owner, "runner");
});

test("Gemini video QA runner blocks without leaking missing API key value", async () => {
  const input = fixture();
  let called = false;
  const code = await runGeminiVideoQaCli(args(input), {}, async () => {
    called = true;
    return geminiResponse({});
  });

  assert.equal(code, 2);
  assert.equal(called, false);
  const output = readFileSync(input.outputPath, "utf8");
  assert.doesNotMatch(output, /secret|GEMINI_API_KEY/);
  const qa = JSON.parse(output) as Record<string, unknown>;
  assert.equal(qa.status, "blocked");
  assert.equal(qa.exact_blocker, "gemini_api_key_missing");
});

test("Gemini video QA runner writes blocked JSON for malformed Gemini response", async () => {
  const input = fixture();
  const code = await runGeminiVideoQaCli(args(input), { GEMINI_API_KEY: "secret-key" }, async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] })));

  assert.equal(code, 2);
  const qa = readQa(input.outputPath);
  assert.equal(qa.status, "blocked");
  assert.equal(qa.verdict, "blocked");
  assert.equal(qa.completion_gate_alignment, "blocked");
  assert.equal(qa.completion_gate_matches, false);
  assert.equal(qa.exact_blocker, "gemini_response_json_parse_failed");
  assert.equal(qa.video_artifact_uri, input.videoPath);
});

test("Gemini video QA runner blocks well-formed JSON without explicit pass fields", async () => {
  const input = fixture();
  const code = await runGeminiVideoQaCli(args(input), { GEMINI_API_KEY: "secret-key" }, async () => geminiResponse({ summary: "Looks fine." }));

  assert.equal(code, 0);
  const qa = readQa(input.outputPath);
  assert.equal(qa.status, "blocked");
  assert.equal(qa.verdict, "blocked");
  assert.equal(qa.completion_gate_alignment, "blocked");
  assert.equal(qa.completion_gate_matches, false);
  assert.equal(qa.exact_blocker, "gemini_response_schema_invalid");
});

test("Gemini video QA runner blocks explicit blockers even with pass-like fields", async () => {
  const input = fixture();
  const code = await runGeminiVideoQaCli(
    args(input),
    { GEMINI_API_KEY: "secret-key" },
    async () =>
      geminiResponse({
        status: "ok",
        verdict: "pass",
        completion_gate_alignment: "match",
        completion_gate_matches: true,
        exact_blocker: "gemini_video_qa_visible_issue"
      })
  );

  assert.equal(code, 0);
  const qa = readQa(input.outputPath);
  assert.equal(qa.status, "blocked");
  assert.equal(qa.completion_gate_matches, false);
  assert.equal(qa.exact_blocker, "gemini_video_qa_visible_issue");
});

test("Gemini video QA runner blocks oversized videos and keeps video path matched", async () => {
  const input = fixture();
  writeFileSync(input.videoPath, "too-large");
  const code = await runGeminiVideoQaCli(args(input), { GEMINI_API_KEY: "secret-key", AUTOMATION_OS_GEMINI_VIDEO_QA_MAX_BYTES: "4" }, async () => {
    throw new Error("fetch should not run");
  });

  assert.equal(code, 2);
  const qa = readQa(input.outputPath);
  assert.equal(qa.exact_blocker, "gemini_video_artifact_too_large");
  assert.equal(qa.video_artifact_uri, input.videoPath);
});

test("Gemini video QA runner defaults to current video understanding model", async () => {
  const input = fixture();
  const code = await runGeminiVideoQaCli(
    args(input),
    { GEMINI_API_KEY: "secret-key" },
    async (url) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
      return geminiResponse({
        status: "ok",
        verdict: "pass",
        completion_gate_alignment: "match",
        completion_gate_matches: true
      });
    }
  );

  assert.equal(code, 0);
  const qa = readQa(input.outputPath);
  assert.equal(qa.model, "gemini-3.5-flash");
});
