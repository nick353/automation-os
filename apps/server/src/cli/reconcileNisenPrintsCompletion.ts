import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dbBackend, dbPath, insert, makeId, nowIso } from "../db/client.js";

const defaultRunSlug = "2026-06-25-210709-ce8b-fuji-hollyhock-summer-onsen-torbie-cat";
const defaultManifestPath = `/Users/nichikatanaka/Documents/Etsy/artifacts/publish_manifests/${defaultRunSlug}.json`;
const defaultStrictProofPath = `/Users/nichikatanaka/Documents/Etsy/artifacts/publish_proofs/${defaultRunSlug}/strict-completion-public-proof.json`;
const manifestPath = resolve(readArgValue("--manifest") ?? defaultManifestPath);
const strictProofPath = resolve(readArgValue("--strict-proof") ?? defaultStrictProofPath);
const outDir = resolve(readArgValue("--out-dir") ?? `data/artifacts/nisenprints/reconciliation-${timestamp()}`);
const commitRequested = process.argv.includes("--commit");

type RunRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type JsonRecord = Record<string, unknown>;

const manifest = readJson(manifestPath);
const strictProof = readJson(strictProofPath);
const latestNisenPrintsRun = readLatestNisenPrintsRun();
const artifactIdentityConsistent = nisenPrintsArtifactIdentityConsistent(manifest, strictProof);
const publicLocalCompletionObserved =
  manifest.ok === true &&
  stringValue(manifest.final_status) === "pinterest_posted" &&
  Boolean(stringValue(manifest.printify_product_id)) &&
  Boolean(stringValue(manifest.etsy_listing_id)) &&
  Boolean(stringValue(manifest.etsy_listing_url)) &&
  Boolean(stringValue(manifest.pinterest_pin_url)) &&
  strictProof.ok === true &&
  strictProof.completion_ok === true &&
  artifactIdentityConsistent;
const strictStageObservationsOk = strictProof.strict_stage_observations_ok === true;
const strictStageMissing = strictStageObservationsOk ? [] : strictStageObservationMissing(strictProof);
const acceptedPartialClassification =
  publicLocalCompletionObserved && !strictStageObservationsOk
    ? "historical_strict_runner_proof_gap"
    : publicLocalCompletionObserved
      ? "historical_runner_exit_proof_gap"
      : null;
const proofType = "nisenprints_completion_reconciliation_readback";
const proofGate = {
  ok: false,
  missing: [
    ...(!publicLocalCompletionObserved ? ["nisenprints_public_local_completion"] : []),
    ...(strictStageObservationsOk ? [] : strictStageMissing),
    "nisenprints_runner_exit_0"
  ],
  present: [
    proofType,
    ...(stringValue(manifest.replacement_asset_source_path) ? ["generation_manifest_verified"] : []),
    ...(stringValue(manifest.etsy_listing_id) && stringValue(manifest.etsy_listing_url) ? ["etsy_listing_published"] : []),
    ...(stringValue(manifest.pinterest_pin_url) ? ["pinterest_pin_url_verified"] : []),
    ...(pinterestLinksToEtsy(manifest, strictProof) ? ["etsy_visit_site_match_verified"] : [])
  ]
};
const reconciliationStatus = strictStageObservationsOk
  ? "project_owned_completion_observed_but_registered_runner_success_not_claimed"
  : "project_owned_public_local_completion_reconciled_with_remaining_strict_gap";
const proofSummary = strictStageObservationsOk
  ? "partial: NisenPrints public-local completion reconciled; Automation OS runner-exit proof remains unavailable for the historical run"
  : "partial: NisenPrints public-local completion reconciled; strict stage observation and Automation OS runner-exit proof remain unavailable for the historical run";
const receipt = {
  ok: publicLocalCompletionObserved,
  workflow: "nisenprints-daily-product-canva-printify-etsy-pinterest",
  stage: "automation_os_nisenprints_completion_reconciliation_receipt",
  generated_at: new Date().toISOString(),
  automation_os_db_mutated: commitRequested,
  strict_registered_success_claimed: false,
  accepted_partial: acceptedPartialClassification !== null,
  accepted_partial_reason: acceptedPartialClassification,
  reconciliation_status: reconciliationStatus,
  registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
  automation_os_latest_run: latestNisenPrintsRun
    ? {
        id: latestNisenPrintsRun.id,
        status: latestNisenPrintsRun.status,
        created_at: latestNisenPrintsRun.created_at,
        updated_at: latestNisenPrintsRun.updated_at
      }
    : null,
  project_run: {
    run_id: stringValue(manifest.run_id),
    manifest_path: manifestPath,
    strict_proof_path: strictProofPath,
    final_status: stringValue(manifest.final_status),
    printify_product_id: stringValue(manifest.printify_product_id),
    etsy_listing_id: stringValue(manifest.etsy_listing_id),
    etsy_listing_url: stringValue(manifest.etsy_listing_url),
    pinterest_pin_url: stringValue(manifest.pinterest_pin_url),
    public_local_completion_observed: publicLocalCompletionObserved,
    strict_stage_observations_ok: strictStageObservationsOk,
    artifact_identity_consistent: artifactIdentityConsistent,
    accepted_partial: acceptedPartialClassification !== null,
    accepted_partial_reason: acceptedPartialClassification,
    strict_proof_classification: stringValue(strictProof.classification),
    strict_stage_missing: strictStageMissing,
    proof_gate: proofGate,
    proof_summary: proofSummary,
    external_actions_performed: false,
    additional_listing_created: false,
    additional_pin_created: false
  },
  next_safe_action:
    "Keep the historical Automation OS NisenPrints runner run preserved. If strict registered completion is required, rerun the registered NisenPrints definition or repair the missing stage observation evidence without creating duplicate Etsy listings or Pinterest pins.",
  stop_conditions: [
    "billing_purchase_payment_checkout",
    "captcha_otp_security_code_identity_verification",
    "printify_etsy_pinterest_auth_gate",
    "duplicate_listing_or_pin_risk_without_manifest_proof"
  ]
};

mkdirSync(outDir, { recursive: true });
const receiptPath = join(outDir, "nisenprints-completion-reconciliation-receipt.json");
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const committedRun = commitRequested && publicLocalCompletionObserved ? commitReconciliationReadback(receiptPath) : null;

console.log(
  JSON.stringify(
    {
      ok: publicLocalCompletionObserved,
      receiptPath,
      receiptUri: pathToFileURL(receiptPath).href,
      committedRun,
      latestAutomationOsRun: receipt.automation_os_latest_run,
      projectRun: {
        run_id: receipt.project_run.run_id,
        proof_gate: receipt.project_run.proof_gate,
        strict_stage_observations_ok: receipt.project_run.strict_stage_observations_ok,
        strict_stage_missing: receipt.project_run.strict_stage_missing,
        etsy_listing_url: receipt.project_run.etsy_listing_url,
        pinterest_pin_url: receipt.project_run.pinterest_pin_url
      },
      nextSafeAction: receipt.next_safe_action
    },
    null,
    2
  )
);
process.exitCode = publicLocalCompletionObserved ? 0 : 1;

function commitReconciliationReadback(receiptPath: string): { runId: string; proofId: string } {
  if (!latestNisenPrintsRun) throw new Error("automation_os_latest_nisenprints_run_missing");
  const runId = makeId("run_nisenprints_reconcile");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_nisenprints_reconcile");
  const eventId = makeId("evt_nisenprints_reconcile");
  const now = nowIso();
  const metadata = {
    registeredWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    reconciliation_run: true,
    reconciliation_of_run_id: latestNisenPrintsRun.id,
    project_run_id: receipt.project_run.run_id,
    project_manifest_path: manifestPath,
    project_strict_proof_path: strictProofPath,
    printify_product_id: receipt.project_run.printify_product_id,
    etsy_listing_id: receipt.project_run.etsy_listing_id,
    etsy_listing_url: receipt.project_run.etsy_listing_url,
    pinterest_pin_url: receipt.project_run.pinterest_pin_url,
    public_local_completion_observed: publicLocalCompletionObserved,
    strict_stage_observations_ok: strictStageObservationsOk,
    artifact_identity_consistent: artifactIdentityConsistent,
    strict_proof_classification: receipt.project_run.strict_proof_classification,
    strict_stage_missing: strictStageMissing,
    external_actions_performed: false,
    additional_listing_created: false,
    additional_pin_created: false,
    strict_registered_success_claimed: false,
    accepted_partial: acceptedPartialClassification !== null,
    accepted_partial_reason: acceptedPartialClassification,
    proof_gate: receipt.project_run.proof_gate,
    proof_summary: receipt.project_run.proof_summary
  };
  insert("runs", {
    id: runId,
    name: "NisenPrints completion reconciliation readback",
    status: "partial",
    objective: "Record project-owned NisenPrints public-local completion readback without claiming strict registered runner success",
    created_at: now,
    updated_at: now,
    metadata_json: metadata
  });
  insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Record NisenPrints completion reconciliation readback",
    status: "blocked",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      adapter: "nisenprints_completion_reconciliation_readback",
      requires_approval: false,
      dangerous_action: false,
      external_actions_performed: false,
      additional_listing_created: false,
      additional_pin_created: false,
      proof_gate: receipt.project_run.proof_gate,
      proof_summary: receipt.project_run.proof_summary
    }
  });
  insert("proofs", {
    id: proofId,
    run_id: runId,
    step_id: stepId,
    proof_type: proofType,
    label: "NisenPrints completion reconciliation readback",
    uri: pathToFileURL(receiptPath).href,
    size_bytes: Buffer.byteLength(readFileSync(receiptPath)),
    created_at: now,
    metadata_json: metadata
  });
  insert("worker_events", {
    id: eventId,
    run_id: runId,
    step_id: stepId,
    lane_id: null,
    event_type: "worker_blocked",
    message: receipt.project_run.proof_summary,
    created_at: now,
    metadata_json: metadata
  });
  return { runId, proofId };
}

function readLatestNisenPrintsRun(): RunRow | null {
  if (dbBackend !== "sqlite") throw new Error("nisenprints_reconciliation_requires_local_sqlite_readback");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare(
          `
          SELECT id, name, status, created_at, updated_at, metadata_json
          FROM runs
          WHERE COALESCE(json_extract(metadata_json,'$.registeredWorkflowId'), json_extract(metadata_json,'$.registered_workflow_id'))='nisenprints-daily-product-canva-printify-etsy-pinterest'
            AND COALESCE(json_extract(metadata_json,'$.reconciliation_run'), 0) != 1
          ORDER BY created_at DESC
          LIMIT 1;
        `
        )
        .get() as RunRow | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function strictStageObservationMissing(strictProof: JsonRecord): string[] {
  const missing = stringArray(strictProof.strict_stage_observation_missing);
  if (missing.length > 0) return missing.map((item) => `strict_stage_observation:${item}`);
  const stageObservations = recordValue(strictProof.stage_observations);
  const missingFromStages = Object.entries(stageObservations ?? {})
    .filter(([, value]) => recordValue(value)?.ok === false || recordValue(value)?.missing === true)
    .map(([stage]) => `strict_stage_observation:${stage}`);
  return missingFromStages.length > 0 ? missingFromStages : ["strict_stage_observation"];
}

function pinterestLinksToEtsy(manifest: JsonRecord, strictProof: JsonRecord): boolean {
  const listingId = stringValue(manifest.etsy_listing_id) || stringValue(strictProof.etsy_listing_id);
  const etsyUrl = stringValue(manifest.etsy_listing_url) || stringValue(strictProof.etsy_listing_url);
  const link = stringValue(strictProof.link) || stringValue(strictProof.etsy_url) || stringValue(manifest.etsy_listing_url);
  return Boolean(listingId && etsyUrl && link.includes(listingId));
}

function nisenPrintsArtifactIdentityConsistent(manifest: JsonRecord, strictProof: JsonRecord): boolean {
  return (
    sameWhenBothPresent(stringValue(manifest.run_id), stringValue(strictProof.run_id)) &&
    sameWhenBothPresent(stringValue(manifest.etsy_listing_id), stringValue(strictProof.etsy_listing_id)) &&
    sameWhenBothPresent(stringValue(manifest.etsy_listing_url), stringValue(strictProof.etsy_listing_url)) &&
    sameWhenBothPresent(stringValue(manifest.pinterest_pin_url), stringValue(strictProof.pinterest_pin_url))
  );
}

function sameWhenBothPresent(left: string, right: string): boolean {
  return !left || !right || left === right;
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function readArgValue(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
