import { execSql, initDb, nowIso, querySql, sqlValue } from "../db/client.js";
import { scopedCompanyPredicate } from "../companies/scopedResources.js";
import { getResearchPlan, markResearchPlanSourceCapture } from "../planner/researchPlanner.js";
import { commitResearchPlanCaptureAtomic } from "../planner/researchPlanLineage.js";
import { runObsidianAutoExportBestEffort } from "../obsidian/autoExport.js";
import { redactSensitiveText } from "../obsidian/redaction.js";
import { runYouTubeTranscriptCapture, type YouTubeTranscriptCaptureInput, type YouTubeTranscriptCaptureResult } from "../obsidian/youtubeTranscriptCapture.js";

type CliArgs = {
  planId?: string;
  inputJsonB64?: string;
};

try {
  initDb();
  const args = parseArgs(process.argv.slice(2));
  if (!args.planId) throw new Error("plan_id_required");
  const plan = getResearchPlan(args.planId);
  if (!plan?.runId) throw new Error("research_plan_run_required");
  const planCompanyId = normalizeCompanyId(plan.companyId);
  const sourceRunCompanyId = readSourceRunCompanyId(plan.runId, planCompanyId);
  if (!sourceRunCompanyId) throw new Error(planCompanyId ? "research_plan_company_id_mismatch" : "source_run_company_id_missing");
  if (planCompanyId !== sourceRunCompanyId) throw new Error("research_plan_company_id_mismatch");
  const input = parseInput(args.inputJsonB64);
  const result = await runYouTubeTranscriptCapture(input);
  if (!result.ok) {
    const updatedPlan = markResearchPlanSourceCapture(plan.id, "youtube", {
      ok: false,
      status: result.status,
      artifactPath: result.artifactDir,
      exactBlocker: result.exactBlocker,
      summary: result.summary
    }) ?? plan;
    annotateYouTubeCaptureFailure(plan.runId, result, sourceRunCompanyId);
    runObsidianAutoExportBestEffort(result.status === "rejected" ? "research-youtube-transcript-rejected" : "research-youtube-transcript-blocked");
    console.log(JSON.stringify({ ok: false, status: result.status, plan: updatedPlan, capture: result }, null, 2));
    process.exit(0);
  }

  const committed = commitResearchPlanCaptureAtomic({
    plan,
    sourceKey: "youtube",
    uri: result.files.manifest,
    label: "YouTube transcript visible source snapshot",
    sizeBytes: result.transcriptBytes,
    proofMetadata: {
      sourceKey: "youtube",
      captureId: result.captureId,
      artifactDir: result.artifactDir,
      currentUrl: result.currentUrl,
      requestedUrl: result.requestedUrl,
      sourceTitle: result.sourceTitle,
      segmentCount: result.segmentCount,
      transcriptBytes: result.transcriptBytes,
      ingestPath: result.ingest.path,
      lane: "youtube_visible_transcript_cdp",
      apiBillingRequired: false,
      readOnly: true
    },
    artifactPath: result.files.manifest,
    summary: result.sourceTitle
  });
  const { proof, plan: updatedPlan } = committed;
  runObsidianAutoExportBestEffort("research-youtube-transcript-captured");
  console.log(JSON.stringify({ ok: true, status: "captured", runId: plan.runId, plan: updatedPlan, proof, capture: result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }, null, 2));
  process.exitCode = 1;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {};
  for (const arg of argv) {
    const [key, value = ""] = arg.split(/=(.*)/s, 2);
    if (key === "--plan-id") parsed.planId = value;
    else if (key === "--input-json-b64") parsed.inputJsonB64 = value;
  }
  return parsed;
}

function parseInput(value: string | undefined): YouTubeTranscriptCaptureInput {
  if (!value) return {};
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const parsed = JSON.parse(decoded) as Record<string, unknown>;
  return {
    url: stringOrUndefined(parsed.url),
    sourceTitle: stringOrUndefined(parsed.sourceTitle),
    vaultPath: stringOrUndefined(parsed.vaultPath),
    capturedAt: stringOrUndefined(parsed.capturedAt),
    publicCaptionOnly: parsed.publicCaptionOnly === true
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function annotateYouTubeCaptureFailure(runId: string, result: Extract<YouTubeTranscriptCaptureResult, { ok: false }>, companyId?: string | null) {
  const companyClause = researchPlanRunCompanyClause(companyId);
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)}${companyClause} LIMIT 1`)[0];
  if (!current) return;
  const metadata = parseJson<Record<string, unknown>>(current.metadata_json, {});
  const nextAction = youtubeCaptureNextAction(result);
  execSql(
    `UPDATE runs
     SET metadata_json=${sqlValue({
       ...metadata,
       youtube_capture: {
         status: result.status,
         exactBlocker: result.exactBlocker,
         artifactDir: result.artifactDir,
         requestedUrl: result.requestedUrl,
         summary: result.summary
       },
       public_next_action: nextAction
     })},
         updated_at=${sqlValue(nowIso())}
     WHERE id=${sqlValue(runId)}${companyClause};`
  );
}

function youtubeCaptureNextAction(result: Extract<YouTubeTranscriptCaptureResult, { ok: false }>) {
  const needsAlternativeVideo = [
    "youtube_public_captions_empty",
    "youtube_public_captions_tracks_missing",
    "youtube_transcript_segments_not_visible",
    "youtube_transcript_endpoint_requires_youtube_context"
  ].includes(result.exactBlocker);
  return {
    id: "retry-youtube-transcript",
    title: needsAlternativeVideo ? "台本化できる動画を探す" : "YouTube台本を再確認",
    summary: needsAlternativeVideo
      ? "この動画では公開字幕を取得できませんでした。台本化できる別候補を探して比較します。"
      : "公式の台本欄が表示されなかったため、別の取得方法か動画候補の確認に進めます。",
    buttonLabel: "新規作成へ",
    view: "Create",
    command: needsAlternativeVideo
      ? "YouTubeで候補を探して、台本化できる動画を比較して"
      : result.requestedUrl ? `この動画を台本化して要点を調べて ${result.requestedUrl}` : "YouTubeで候補を探して、台本化できる動画を比較して",
    severity: "attention"
  };
}

function readSourceRunCompanyId(runId: string, companyId?: string | null): string | null {
  const companyClause = researchPlanRunCompanyClause(companyId);
  const row = querySql<{ company_id: string | null }>(`SELECT company_id FROM runs WHERE id=${sqlValue(runId)}${companyClause} LIMIT 1`)[0];
  return normalizeCompanyId(row?.company_id);
}

function researchPlanRunCompanyClause(companyId?: string | null): string {
  const normalized = normalizeCompanyId(companyId);
  return normalized ? ` AND ${scopedCompanyPredicate("company_id", [normalized])}` : "";
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeCompanyId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
