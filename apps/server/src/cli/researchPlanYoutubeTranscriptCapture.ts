import { execSql, initDb, insert, makeId, nowIso, querySql, sqlValue } from "../db/client.js";
import { getResearchPlan, markResearchPlanSourceCapture, type ResearchPlanSnapshot } from "../planner/researchPlanner.js";
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
    annotateYouTubeCaptureFailure(plan.runId, result);
    runObsidianAutoExportBestEffort(result.status === "rejected" ? "research-youtube-transcript-rejected" : "research-youtube-transcript-blocked");
    console.log(JSON.stringify({ ok: false, status: result.status, plan: updatedPlan, capture: result }, null, 2));
    process.exit(0);
  }

  const proof = storeYouTubeVisibleSourceProof(plan.runId, result);
  enforceResearchPlanCompletionBoundary(plan.runId, plan);
  const updatedPlan = markResearchPlanSourceCapture(plan.id, "youtube", {
    ok: true,
    status: "captured",
    proofId: proof.id,
    artifactPath: result.files.manifest,
    summary: result.sourceTitle
  }) ?? getResearchPlan(plan.id) ?? plan;
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

function annotateYouTubeCaptureFailure(runId: string, result: Extract<YouTubeTranscriptCaptureResult, { ok: false }>) {
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
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
     WHERE id=${sqlValue(runId)};`
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

function storeYouTubeVisibleSourceProof(runId: string, capture: Extract<YouTubeTranscriptCaptureResult, { ok: true }>) {
  const proofType = "visible_source_snapshot:youtube";
  const existing = querySql<{ id: string; proof_type: string; uri: string }>(
    `SELECT id, proof_type, uri FROM proofs
     WHERE run_id=${sqlValue(runId)}
       AND proof_type=${sqlValue(proofType)}
       AND uri=${sqlValue(capture.files.manifest)}
     LIMIT 1`
  )[0];
  if (existing) return { id: existing.id, proofType: existing.proof_type, uri: existing.uri };
  const now = nowIso();
  const proof = {
    id: makeId("proof"),
    proofType,
    uri: capture.files.manifest,
    createdAt: now
  };
  insert("proofs", {
    id: proof.id,
    run_id: runId,
    step_id: null,
    proof_type: proof.proofType,
    label: "YouTube transcript visible source snapshot",
    uri: proof.uri,
    size_bytes: capture.transcriptBytes,
    created_at: proof.createdAt,
    metadata_json: {
      sourceKey: "youtube",
      captureId: capture.captureId,
      artifactDir: capture.artifactDir,
      currentUrl: capture.currentUrl,
      requestedUrl: capture.requestedUrl,
      sourceTitle: capture.sourceTitle,
      segmentCount: capture.segmentCount,
      transcriptBytes: capture.transcriptBytes,
      ingestPath: capture.ingest.path,
      lane: "youtube_visible_transcript_cdp",
      apiBillingRequired: false,
      readOnly: true
    }
  });
  return proof;
}

function enforceResearchPlanCompletionBoundary(runId: string, plan: ResearchPlanSnapshot) {
  const requiredProofs = requiredResearchPlanProofs(plan);
  const approvalBoundarySources = billingRequiredResearchSourceKeys(plan);
  const current = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  if (!current) return;
  const metadata = parseJson<Record<string, unknown>>(current.metadata_json, {});
  const presentProofs = querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${sqlValue(runId)}`).map((proof) => proof.proof_type);
  const missingProofs = requiredProofs.filter((proof) => !presentProofs.includes(proof));
  const shouldHoldPartial = (missingProofs.length > 0 || approvalBoundarySources.length > 0) && current.status === "complete";
  execSql(
    `UPDATE runs
     SET status=${sqlValue(shouldHoldPartial ? "partial" : current.status)},
         updated_at=${sqlValue(nowIso())},
         metadata_json=${sqlValue({
           ...metadata,
           research_plan_required_proofs: requiredProofs,
           research_plan_missing_proofs: missingProofs,
           research_plan_billing_boundary_sources: approvalBoundarySources,
           proof_gate: {
             ...(typeof metadata.proof_gate === "object" && metadata.proof_gate ? metadata.proof_gate : {}),
             ok: missingProofs.length === 0 && approvalBoundarySources.length === 0,
             missing: missingProofs,
             present: presentProofs,
             reason: "research_plan_visible_source_proof_required"
           },
           ...(shouldHoldPartial ? { stop_reason: "research_plan_visible_source_proof_missing" } : {})
         })}
     WHERE id=${sqlValue(runId)};`
  );
}

function requiredResearchPlanProofs(plan: ResearchPlanSnapshot): string[] {
  return enabledResearchSourceKeys(plan).flatMap((key) => {
    if (key === "web") return ["readable_source_snapshot:web"];
    if (key === "youtube") return ["visible_source_snapshot:youtube"];
    return [];
  });
}

function enabledResearchSourceKeys(plan: ResearchPlanSnapshot): string[] {
  return plan.sources.filter((source) => source.enabled).map((source) => source.key);
}

function billingRequiredResearchSourceKeys(plan: ResearchPlanSnapshot): string[] {
  return plan.sources
    .filter((source) => source.enabled && (source.metadata?.apiBillingRequired === true || source.metadata?.billingRequired === true))
    .map((source) => source.key);
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
