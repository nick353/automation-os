#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CliOptions = {
  videoPath: string;
  outputPath: string;
  manifestPath: string;
  targetUrl: string;
  model: string;
  endpointBase: string;
  maxVideoBytes: number;
};

type QaRecord = {
  provider: "gemini";
  model: string;
  kind: "gemini_video_qa";
  status: string;
  verdict: string;
  completion_gate_alignment: string;
  completion_gate_matches: boolean;
  video_artifact_uri: string;
  target_url: string;
  summary: string;
  exact_blocker: string | null;
  repair_owner: string | null;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const defaultModel = "gemini-3.5-flash";
const defaultEndpointBase = "https://generativelanguage.googleapis.com/v1beta";
const defaultMaxVideoBytes = 20 * 1024 * 1024;

export async function runGeminiVideoQaCli(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Promise<number> {
  const options = parseArgs(args, env);
  const apiKey = firstNonEmpty(env.GEMINI_API_KEY);

  if (!apiKey) {
    writeQa(options.outputPath, blockedRecord(options, "gemini_api_key_missing"));
    return 2;
  }

  try {
    const stat = statVideo(options.videoPath);
    if (!stat) {
      writeQa(options.outputPath, blockedRecord(options, "gemini_video_artifact_missing_or_empty"));
      return 2;
    }
    if (!stat.isFile() || stat.size <= 0) {
      writeQa(options.outputPath, blockedRecord(options, "gemini_video_artifact_missing_or_empty"));
      return 2;
    }
    if (stat.size > options.maxVideoBytes) {
      writeQa(options.outputPath, blockedRecord(options, "gemini_video_artifact_too_large"));
      return 2;
    }

    const videoBytes = readFileSync(options.videoPath);
    const response = await fetchImpl(geminiUrl(options), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(buildGeminiRequest(options, videoBytes))
    });

    if (!response.ok) {
      writeQa(options.outputPath, blockedRecord(options, `gemini_http_${response.status}`));
      return 2;
    }

    const responseJson = (await response.json()) as unknown;
    const qaJson = parseGeminiQaJson(responseJson);
    if (!qaJson) {
      writeQa(options.outputPath, blockedRecord(options, "gemini_response_json_parse_failed"));
      return 2;
    }

    writeQa(options.outputPath, normalizeGeminiQa(options, qaJson));
    return 0;
  } catch {
    writeQa(options.outputPath, blockedRecord(options, "gemini_video_qa_runner_failed"));
    return 2;
  }
}

function parseArgs(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing_value_for_${arg.slice(2)}`);
    values.set(arg, value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = firstNonEmpty(values.get(`--${key}`));
    if (!value) throw new Error(`missing_required_arg_${key}`);
    return value;
  };
  return {
    videoPath: resolve(required("video")),
    outputPath: resolve(required("output")),
    manifestPath: resolve(required("manifest")),
    targetUrl: required("target-url"),
    model: firstNonEmpty(env.AUTOMATION_OS_GEMINI_VIDEO_QA_MODEL) ?? defaultModel,
    endpointBase: firstNonEmpty(env.AUTOMATION_OS_GEMINI_VIDEO_QA_ENDPOINT_BASE) ?? defaultEndpointBase,
    maxVideoBytes: positiveInt(env.AUTOMATION_OS_GEMINI_VIDEO_QA_MAX_BYTES, defaultMaxVideoBytes)
  };
}

function buildGeminiRequest(options: CliOptions, videoBytes: Buffer): Record<string, unknown> {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You are a visual QA auditor for a Browser Use automation recording.",
              "Return only strict JSON with these fields:",
              "status, verdict, completion_gate_alignment, completion_gate_matches, summary, exact_blocker, repair_owner.",
              "Use status=ok, verdict=pass, completion_gate_alignment=match, completion_gate_matches=true only when the recording visibly matches the target URL and does not contradict completion.",
              "If it is stalled, wrong target, incomplete, or contradictory, return status=blocked or mismatch and set completion_gate_matches=false with an exact_blocker.",
              `target_url: ${options.targetUrl}`,
              `manifest_path: ${options.manifestPath}`
            ].join("\n")
          },
          {
            inline_data: {
              mime_type: mimeTypeForVideo(options.videoPath),
              data: videoBytes.toString("base64")
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };
}

function parseGeminiQaJson(responseJson: unknown): Record<string, unknown> | null {
  const text = extractText(responseJson);
  if (!text) return null;
  const parsed = parseJsonObject(text);
  return parsed;
}

function extractText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    const parts = candidate.content.parts;
    const text = parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n").trim();
    if (text) return text;
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeGeminiQa(options: CliOptions, raw: Record<string, unknown>): QaRecord {
  const status = stringValue(raw.status).toLowerCase();
  const verdict = stringValue(raw.verdict || raw.result || raw.outcome).toLowerCase();
  const alignment = stringValue(raw.completion_gate_alignment || raw.completionGateAlignment || raw.gate_alignment).toLowerCase();
  const explicitCompletionMatch = raw.completion_gate_matches === true || raw.completionGateMatches === true;
  const mismatch =
    raw.completion_gate_matches === false ||
    raw.completionGateMatches === false ||
    fieldIsBad(status) ||
    fieldIsBad(verdict) ||
    fieldIsBad(alignment);
  const exactBlocker = stringValue(raw.exact_blocker || raw.exactBlocker || raw.blocker);

  if (mismatch) {
    return {
      ...baseRecord(options),
      status: status || "blocked",
      verdict: verdict || "mismatch",
      completion_gate_alignment: alignment || "mismatch",
      completion_gate_matches: false,
      summary: stringValue(raw.summary || raw.notes) || "Gemini video QA did not match the completion gate.",
      exact_blocker: exactBlocker || "gemini_video_qa_completion_mismatch",
      repair_owner: stringValue(raw.repair_owner || raw.repairOwner || raw.owner) || "runner"
    };
  }

  const schemaIsGood = explicitCompletionMatch && fieldIsGood(status) && fieldIsGood(verdict) && fieldIsGood(alignment) && !exactBlocker;
  if (!schemaIsGood) {
    return {
      ...baseRecord(options),
      summary: stringValue(raw.summary || raw.notes) || "Gemini video QA response did not include an explicit passing completion gate.",
      exact_blocker: exactBlocker || "gemini_response_schema_invalid",
      repair_owner: stringValue(raw.repair_owner || raw.repairOwner || raw.owner) || "runner"
    };
  }

  return {
    ...baseRecord(options),
    status,
    verdict,
    completion_gate_alignment: alignment,
    completion_gate_matches: true,
    summary: stringValue(raw.summary || raw.notes) || "Gemini video QA matched the Browser Use recording.",
    exact_blocker: null,
    repair_owner: stringValue(raw.repair_owner || raw.repairOwner || raw.owner) || null
  };
}

function baseRecord(options: CliOptions): QaRecord {
  return {
    provider: "gemini",
    model: options.model,
    kind: "gemini_video_qa",
    status: "blocked",
    verdict: "blocked",
    completion_gate_alignment: "blocked",
    completion_gate_matches: false,
    video_artifact_uri: options.videoPath,
    target_url: options.targetUrl,
    summary: "",
    exact_blocker: "gemini_video_qa_runner_failed",
    repair_owner: "automation-os"
  };
}

function blockedRecord(options: CliOptions, blocker: string): QaRecord {
  return {
    ...baseRecord(options),
    summary: `Gemini video QA runner blocked: ${blocker}`,
    exact_blocker: blocker,
    repair_owner: "automation-os"
  };
}

function writeQa(path: string, record: QaRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function geminiUrl(options: CliOptions): string {
  return `${options.endpointBase.replace(/\/+$/, "")}/models/${encodeURIComponent(options.model)}:generateContent`;
}

function mimeTypeForVideo(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

function statVideo(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function fieldIsBad(value: string): boolean {
  return /fail|failed|blocked|mismatch|conflict|veto|reject|error/.test(value);
}

function fieldIsGood(value: string): boolean {
  return /^(ok|pass|passed|success|succeeded|complete|completed|match|matched|aligned)$/.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runGeminiVideoQaCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 2;
    });
}
