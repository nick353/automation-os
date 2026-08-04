import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import pg from "pg";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dbBackend, execSql, initDb, insert, makeId, nowIso, querySql, querySqlBatch, runSqlTransaction, sqlValue, upsert } from "./db/client.js";
import { importCodexAssets } from "./ingest/codexAssets.js";
import { seedDailyAiDemo } from "./seedDailyAiDemo.js";
import { seedResearchKnowledge } from "./planner/advisor.js";
import { sanitizeDashboardRows } from "./dashboardSanitizer.js";
import { getBrowserHealth } from "./browser/health.js";
import { buildBrowserUseRuntimeSnapshot } from "./browser/runtimeSnapshot.js";
import { applyProjectPresentationProfileOverride, buildProjectPresentationProfile, parseProjectPresentationProfileOverride, type ProjectPresentationProfile } from "./projects/presentationProfile.js";
import { readCanonicalIabOwnerDiagnostics } from "./browser/iabCanonicalLoader.js";
import {
  readReferenceBrowserUseWorkflowAdaptersV1,
  readReferenceIabWorkflowAdaptersV1
} from "./serviceReadiness/workflowAdapters.js";
import { buildBlockedCompanyReleaseReadinessV1 } from "./serviceReadiness/companyReleaseReadiness.js";
import { buildBlockedCompanyReleaseEvidenceV1 } from "./serviceReadiness/releaseEvidence.js";
import {
  runBrowserUseLocalCheck,
  runBrowserUseLocalCheckAsync,
  type BrowserUseLocalCheckOptions,
  type BrowserUseLocalCheckResult
} from "./browser/browserUseLocalCheck.js";
import { runLocalBrowserBridgeCheckAsync, type BrowserBridgeCheckResult } from "./browser/localCheck.js";
import {
  createBridgeReceipt,
  createProtectedBridgeApproval,
  findTrustedBridgeAction,
  listTrustedBridgeActions,
  storeBridgeReceipt
} from "./bridge/trustedBridge.js";
import { getCodexCapabilities } from "./codex/capabilities.js";
import { buildCanonicalExecutionRoutingMetadata, buildExecutionRoutingSnapshot } from "./codex/executionRouting.js";
import { getLatestCapabilityProbeSnapshot, probeCodexMcpSurface } from "./codex/capabilityProbe.js";
import { getLatestAppServerProbeSnapshot, probeCodexAppServerSurface } from "./codex/appServerProbe.js";
import { buildCapabilityRouterSnapshot } from "./codex/capabilityRouter.js";
import { serializeAutomationOsChatSnapshot } from "./codex/chatSnapshot.js";
import {
  buildCodexAppParityLedger,
  type CodexParityBridgeExecution,
  type CodexParitySystemCheck
} from "./codex/parityLedger.js";
import {
  buildCodexAutomationMigrationLedger,
  type CodexAutomationMigrationApprovalRow,
  type CodexAutomationMigrationLedgerItem,
  type CodexAutomationMigrationProofRow,
  type CodexAutomationMigrationRunRow
} from "./codex/automationMigrationLedger.js";
import { refreshKnowledgeNotes } from "./knowledge/refresh.js";
import { createPlannerResponse, buildLocalPlanner, type CreatePlannerMessage } from "./planner/createPlanner.js";
import { cancelCreatePlannerJob, enqueueCreatePlannerJob, getCreatePlannerJob, listCreateChatThreads, type CreatePlannerJob } from "./planner/createPlannerJobs.js";
import { createSkillDraft } from "./planner/skillFactory.js";
import {
  createResearchPlan,
  getResearchPlan,
  markResearchPlanDemoed,
  markResearchPlanSourceCapture,
  researchPlanFromRow,
  type ResearchPlanSnapshot,
  type ResearchSourceKey
} from "./planner/researchPlanner.js";
import {
  commitResearchPlanCaptureAtomic,
  commitResearchPlanStartedAtomic,
  rollbackPreparedResearchPlanRunAtomic
} from "./planner/researchPlanLineage.js";
import { getRunWorkerProgressState, resolveWorkerAdapterPolicy, startCommandRun, type RunWorkerProgressState } from "./runs/workerEngine.js";
import {
  cancelDurableJob,
  enqueueAutomationDryRun,
  getDurableJob,
  listDurableJobAttempts,
  listDurableJobs,
  listDurableScheduleOccurrences,
  readRunArtifact,
  retryDurableJob,
  DurableQueueError
} from "./runs/durableQueue.js";
import {
  BoundApprovalError,
  createBoundApproval,
  decideBoundApproval,
  listBoundApprovals
} from "./approvals/repository.js";
import { registeredBrowserLaneForWorkflow, visibleBrowserLaneForRecordReplay } from "./runs/laneManager.js";
import { selectActionQueueRuns, selectResumeCandidateRun } from "./runs/selectors.js";
import { isSecretStorageOnlyText, listStoredSecrets, saveSecretsFromMessage } from "./secrets/secretStore.js";
import { secureTokenEqual } from "./security/tokenComparison.js";
import {
  getObsidianExportStatus,
  runObsidianAutoExportBestEffort,
  runObsidianExportNow,
  startObsidianAutonomyLoops,
  startPeriodicObsidianExport,
  stopObsidianAutonomyLoops,
  stopPeriodicObsidianExport
} from "./obsidian/autoExport.js";
import { runObsidianIngest } from "./obsidian/ingest.js";
import { redactSensitiveText } from "./obsidian/redaction.js";
import { runUrlCapture, type UrlCaptureResult } from "./obsidian/urlCapture.js";
import { runYouTubeTranscriptCapture, type YouTubeTranscriptCaptureResult } from "./obsidian/youtubeTranscriptCapture.js";
import { runSecondBrainProcessor } from "./obsidian/secondBrainProcessor.js";
import { customObsidianExportError, customObsidianExportSummary, guardObsidianVaultPath } from "./obsidian/vaultGuard.js";
import {
  fixedRegisteredWorkflows,
  getRegisteredWorkflowForCompanies,
  getRegisteredWorkflowStartCommand,
  getRegisteredWorkflowEffectiveSchedule,
  initRegisteredWorkflows,
  isRegisteredWorkflowSchedulePaused,
  listRegisteredWorkflowsForCompanies,
  refreshRegisteredWorkflows,
  registerResearchPlanWorkflow,
  setRegisteredWorkflowScheduleOverride,
  setRegisteredWorkflowSchedulePaused,
  type RegisteredWorkflowDefinition,
  type RegisteredWorkflowRow
} from "./registeredWorkflows.js";
import { getResumeContract } from "./resumeContract.js";
import {
  createCompanyForActor,
  currentActorUserId,
  listActorCompanies,
  recordCompanyAudit,
  requireCompanyAccess,
  requireExistingCompanyAccess,
  requireExistingServiceIdentity,
  updateCompanyForActor,
  type CompanyRole
} from "./companies/repository.js";
import { findScopedApproval, findScopedProof, findScopedRun, scopedCompanyPredicate } from "./companies/scopedResources.js";
import {
  AutomationContractError,
  parseAutomationCreate,
  parseAutomationPatch,
  parseAutomationSchedule,
  parseCompanyConnectionAccountRef,
  parseCompanyMemory,
  requireIdempotencyKey
} from "./automations/contracts.js";
import {
  AutomationRepositoryError,
  archiveAutomationRecord,
  createAutomationRecord,
  getAutomationRecord,
  listAutomationRecords,
  listAutomationSchedules,
  listAutomationVersions,
  listCompanyConnectionRefs,
  listCompanyMemory,
  requestCompanyConnectionReconnect,
  revokeCompanyConnectionRef,
  saveAutomationSchedule,
  saveCompanyConnectionRef,
  saveCompanyMemory,
  setAutomationSchedulePaused,
  updateAutomationRecord,
  type AutomationRecord
} from "./automations/repository.js";
import { IdempotencyError } from "./automations/idempotency.js";
import { buildCompanyAnalytics, CompanyAnalyticsError } from "./analytics/companyAnalytics.js";
import { computeNextAutomationOccurrence } from "./runs/automationScheduler.js";
import {
  PORTABLE_WORKER_CANARY_MODE,
  PORTABLE_WORKER_EXTERNAL_MODE,
  portableWorkflowIdForWorkerAdapter,
  portableWorkerExecutionMode
} from "./runs/portableWorkflowWorker.js";
import { startPortableWorkflowRun } from "./runs/portableWorkflowEntrypoint.js";
import { portableWorkflowManifests } from "./runs/portableWorkflowContract.js";

export const app = express();
app.set("case sensitive routing", true);
const port = Number(process.env.AUTOMATION_OS_PORT ?? process.env.PORT ?? 8787);
const host = process.env.HOST ?? (!process.env.PORT ? process.env.AUTOMATION_OS_HOST : undefined) ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const webDistDir = resolvePath(process.env.AUTOMATION_OS_WEB_DIST_DIR ?? join(process.cwd(), "dist"));
const webIndexPath = join(webDistDir, "index.html");
let youtubeTranscriptCaptureRunner = runYouTubeTranscriptCapture;
let researchPlanDemoRunner = runBrowserUseLocalCheckAsync;
let researchPlanStartRunner = startCommandRun;

app.use(productionApiAccessGuard);

const defaultJsonBodyParser = express.json({ limit: "1mb" });
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/api/mvp/feedback") {
    readSmallJsonBody(req, res, next);
    return;
  }
  if (req.method === "POST" && /^\/api\/planner\/[^/]+\/capture\/youtube-transcript$/u.test(req.path)) {
    readSmallJsonBody(req, res, next);
    return;
  }
  defaultJsonBodyParser(req, res, next);
});

app.use(productionWriteGuard);
app.use(ownerDiagnosticsGuard);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "automation-os",
    time: nowIso()
  });
});

app.get("/api/companies", (_req, res) => {
  initDb();
  const actor_user_id = currentActorUserId();
  const companies = listActorCompanies(actor_user_id);
  res.json({ ok: true, actor_user_id, companies, count: companies.length });
});

app.post("/api/companies", (req, res) => {
  try {
    initDb();
    const company = createCompanyForActor(req.body ?? {}, currentActorUserId(), req.header("idempotency-key")?.trim());
    res.status(201).json({ ok: true, company, receipt: { action: "company.created", company_id: company.id } });
  } catch (error) {
    sendCompanyScopeError(res, error, "company_create_failed");
  }
});

app.patch("/api/companies/:companyId", (req, res) => {
  try {
    initDb();
    const company = updateCompanyForActor(String(req.params.companyId ?? "").trim(), req.body ?? {});
    res.json({ ok: true, company, receipt: { action: "company.updated", company_id: company.id } });
  } catch (error) {
    sendCompanyScopeError(res, error, "company_update_failed");
  }
});

app.get("/api/v1/companies/:companyId/automations", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const includeArchived = String(req.query.include_archived ?? "") === "true";
    const automations = listAutomationRecords(companyId, includeArchived).map(automationApiView);
    res.json({ ok: true, automations, count: automations.length, company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_list_failed");
  }
});

app.get("/api/v1/companies/:companyId/analytics/performance", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const now = new Date();
    const from = typeof req.query.from === "string" && req.query.from.trim()
      ? req.query.from
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = typeof req.query.to === "string" && req.query.to.trim() ? req.query.to : now.toISOString();
    const automationId = typeof req.query.automation_id === "string" && req.query.automation_id.trim()
      ? req.query.automation_id.trim()
      : null;
    if (automationId && !getAutomationRecord(companyId, automationId, true)) {
      res.status(404).json({ ok: false, error: "analytics_automation_not_found", exactBlocker: "analytics_automation_not_found" });
      return;
    }
    const analytics = buildCompanyAnalytics({ companyId, from, to, automationId });
    res.json({ ok: true, ...analytics, company_scope: { enforced: true, company_id: companyId }, external_action_executed: false });
  } catch (error) {
    const code = error instanceof CompanyAnalyticsError
      ? error.code
      : error instanceof Error && (error.message === "company_scope_forbidden" || error.message === "company_not_found")
        ? error.message
        : "company_analytics_read_failed";
    if (code === "company_scope_forbidden" || code === "company_not_found") {
      res.status(404).json({ ok: false, error: "company_analytics_not_found", exactBlocker: "company_analytics_not_found" });
      return;
    }
    res.status(error instanceof CompanyAnalyticsError ? 400 : 500).json({ ok: false, error: code, exactBlocker: code });
  }
});

app.post("/api/v1/companies/:companyId/automations", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const idempotencyKey = requireIdempotencyKey(req.header("idempotency-key"));
    const definition = parseAutomationCreate(req.body);
    const automation = createAutomationRecord({
      companyId,
      actorUserId: currentActorUserId(),
      definition,
      idempotencyKey,
      idempotencyRequest: req.body
    });
    res.status(201).json({
      ok: true,
      automation: automationApiView(automation),
      receipt: automationReceipt("automation.created", automation),
      external_action_executed: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_create_failed");
  }
});

app.get("/api/v1/companies/:companyId/automations/:automationId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const automation = getAutomationRecord(companyId, String(req.params.automationId ?? "").trim(), true);
    if (!automation) throw new AutomationRepositoryError("automation_not_found");
    res.json({
      ok: true,
      automation: automationApiView(automation),
      schedule: listAutomationSchedules(companyId, automation.id)[0] ?? null,
      deep_link: `#/projects/${encodeURIComponent(companyId)}/automations/${encodeURIComponent(automation.id)}/edit`,
      company_scope: { enforced: true, company_id: companyId }
    });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_read_failed");
  }
});

app.patch("/api/v1/companies/:companyId/automations/:automationId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const patch = parseAutomationPatch(req.body, req.header("if-match"));
    const automation = updateAutomationRecord({
      companyId,
      actorUserId: currentActorUserId(),
      automationId: String(req.params.automationId ?? "").trim(),
      patch
    });
    res.json({ ok: true, automation: automationApiView(automation), receipt: automationReceipt("automation.updated", automation), external_action_executed: false });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_patch_failed");
  }
});

app.get("/api/v1/companies/:companyId/automations/:automationId/versions", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const versions = listAutomationVersions(companyId, String(req.params.automationId ?? "").trim());
    res.json({ ok: true, versions, count: versions.length, company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_versions_read_failed");
  }
});

app.delete("/api/v1/companies/:companyId/automations/:automationId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin"]);
    const expectedRevision = expectedRevisionFrom(req);
    const automation = archiveAutomationRecord({
      companyId,
      actorUserId: currentActorUserId(),
      automationId: String(req.params.automationId ?? "").trim(),
      expectedRevision
    });
    res.json({ ok: true, automation: automationApiView(automation), receipt: automationReceipt("automation.archived", automation), external_action_executed: false });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_archive_failed");
  }
});

app.put("/api/v1/companies/:companyId/automations/:automationId/schedule", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const parsedSchedule = parseAutomationSchedule(req.body);
    const nextRunAt = parsedSchedule.enabled && parsedSchedule.kind !== "manual"
      ? computeNextAutomationOccurrence({
          kind: parsedSchedule.kind,
          expression: parsedSchedule.expression,
          timezone: parsedSchedule.timezone
        }, nowIso())
      : null;
    const savedSchedule = saveAutomationSchedule({
      companyId,
      actorUserId: currentActorUserId(),
      automationId: String(req.params.automationId ?? "").trim(),
      schedule: parsedSchedule,
      nextRunAt
    });
    const schedule = listAutomationSchedules(companyId, savedSchedule.automationId).find((item) => item.id === savedSchedule.id) ?? savedSchedule;
    res.json({ ok: true, schedule, receipt: { action: "automation.schedule_saved", company_id: companyId, automation_id: schedule.automationId, schedule_id: schedule.id, pinned_version_id: schedule.automationVersionId, revision: schedule.revision } });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_schedule_save_failed");
  }
});

app.get("/api/v1/companies/:companyId/automations/:automationId/schedule", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const automationId = String(req.params.automationId ?? "").trim();
    const automation = getAutomationRecord(companyId, automationId, true);
    if (!automation) throw new AutomationRepositoryError("automation_not_found");
    res.json({ ok: true, schedule: listAutomationSchedules(companyId, automationId)[0] ?? null, company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_schedule_read_failed");
  }
});

for (const paused of [true, false]) {
  const action = paused ? "pause" : "resume";
  app.post(`/api/v1/companies/:companyId/automations/:automationId/${action}`, (req, res) => {
    try {
      initDb();
      const companyId = String(req.params.companyId ?? "").trim();
      requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
      const schedule = setAutomationSchedulePaused({
        companyId,
        actorUserId: currentActorUserId(),
        automationId: String(req.params.automationId ?? "").trim(),
        scheduleId: requiredBodyString(req.body?.schedule_id, "automation_schedule_id_required"),
        expectedRevision: expectedRevisionFrom(req),
        paused
      });
      res.json({ ok: true, schedule, receipt: { action: `automation.schedule_${paused ? "paused" : "resumed"}`, company_id: companyId, automation_id: schedule.automationId, schedule_id: schedule.id, revision: schedule.revision } });
    } catch (error) {
      sendAutomationApiError(res, error, `automation_schedule_${action}_failed`);
    }
  });
}

app.post("/api/v1/companies/:companyId/automations/:automationId/dry-runs", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const idempotencyHeader = req.header("idempotency-key");
    if (!idempotencyHeader?.trim()) throw new AutomationContractError("idempotency_key_required");
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const job = enqueueAutomationDryRun({
      companyId,
      actorUserId: currentActorUserId(),
      automationId: String(req.params.automationId ?? "").trim(),
      idempotencyKey,
      payload: req.body ?? {}
    });
    res.status(202).json({
      ok: true,
      dry_run: true,
      queued: true,
      job: durableJobApiView(job),
      run: {
        id: job.runId,
        status: "queued",
        company_id: job.companyId,
        automation_id: job.automationId,
        automation_version_id: job.automationVersionId
      },
      receipt: durableJobReceipt("automation.dry_run.enqueued", job),
      external_action_executed: false,
      company_scope: { enforced: true, company_id: companyId }
    });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_dry_run_failed");
  }
});

app.get("/api/v1/companies/:companyId/jobs", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined || rawLimit === ""
      ? 200
      : Number(rawLimit);
    if (!Number.isFinite(limit)) throw new DurableQueueError("durable_job_limit_invalid");
    const jobs = listDurableJobs(companyId, limit).map(durableJobApiView);
    res.json({ ok: true, jobs, count: jobs.length, company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    if (error instanceof Error && error.message === "company_scope_forbidden") {
      res.status(404).json({ ok: false, error: "company_not_found", exactBlocker: "company_not_found" });
      return;
    }
    sendDurableQueueError(res, error, "durable_job_list_failed");
  }
});

app.get("/api/v1/companies/:companyId/jobs/:jobId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const job = getDurableJob(companyId, String(req.params.jobId ?? "").trim());
    if (!job) throw new DurableQueueError("durable_job_not_found");
    res.json({ ok: true, job: durableJobApiView(job), attempts: listDurableJobAttempts(companyId, job.id).map(durableAttemptApiView), company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    if (error instanceof Error && error.message === "company_scope_forbidden") {
      res.status(404).json({ ok: false, error: "durable_job_not_found", exactBlocker: "durable_job_not_found" });
      return;
    }
    sendDurableQueueError(res, error, "durable_job_read_failed");
  }
});

app.post("/api/v1/companies/:companyId/jobs/:jobId/retry", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const idempotencyHeader = req.header("idempotency-key");
    if (!idempotencyHeader?.trim()) throw new DurableQueueError("idempotency_key_required");
    const job = retryDurableJob({
      companyId,
      actorUserId: currentActorUserId(),
      jobId: String(req.params.jobId ?? "").trim(),
      idempotencyKey: idempotencyHeader
    });
    res.json({ ok: true, job: durableJobApiView(job), receipt: durableJobReceipt("durable_job.retry_queued", job), company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    if (error instanceof Error && error.message === "company_scope_forbidden") {
      res.status(404).json({ ok: false, error: "durable_job_not_found", exactBlocker: "durable_job_not_found" });
      return;
    }
    sendDurableQueueError(res, error, "durable_job_retry_failed");
  }
});

app.get("/api/v1/companies/:companyId/artifacts/:artifactId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const artifact = readRunArtifact(companyId, String(req.params.artifactId ?? "").trim());
    if (!artifact) throw new DurableQueueError("artifact_not_found");
    if (!new Set(["application/json", "text/plain"]).has(artifact.mimeType.toLowerCase())) {
      throw new DurableQueueError("artifact_mime_not_viewable");
    }
    res.setHeader("content-type", artifact.mimeType);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "sandbox; default-src 'none'");
    res.setHeader("x-artifact-id", artifact.id);
    res.setHeader("x-artifact-sha256", artifact.checksumSha256);
    res.setHeader("cache-control", "private, no-store");
    res.status(200).send(artifact.contentText);
  } catch (error) {
    if (error instanceof Error && error.message === "company_scope_forbidden") {
      res.status(404).json({ ok: false, error: "artifact_not_found", exactBlocker: "artifact_not_found" });
      return;
    }
    sendDurableQueueError(res, error, "artifact_read_failed");
  }
});

app.get("/api/v1/companies/:companyId/approvals", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    res.json({ ok: true, approvals: listBoundApprovals(companyId).map(boundApprovalApiView), company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendBoundApprovalError(res, error, "approval_list_failed");
  }
});

app.post("/api/v1/companies/:companyId/approvals", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const approval = createBoundApproval({
      companyId,
      requestedByUserId: currentActorUserId(),
      jobId: requiredBodyString(req.body?.job_id, "durable_job_id_required"),
      stepId: typeof req.body?.step_id === "string" ? req.body.step_id : null,
      title: requiredBodyString(req.body?.title, "approval_title_required"),
      actionKind: requiredBodyString(req.body?.action_kind, "approval_action_kind_required"),
      targetAccountRefId: typeof req.body?.target_account_ref_id === "string" ? req.body.target_account_ref_id : null,
      payloadHash: requiredBodyString(req.body?.payload_hash, "approval_payload_hash_required"),
      policyVersion: requiredBodyString(req.body?.policy_version, "approval_policy_version_required"),
      expiresAt: requiredBodyString(req.body?.expires_at, "approval_expiry_required"),
      priority: typeof req.body?.priority === "string" ? req.body.priority : "normal"
    });
    res.status(201).json({ ok: true, approval: boundApprovalApiView(approval), company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendBoundApprovalError(res, error, "approval_create_failed");
  }
});

app.patch("/api/v1/companies/:companyId/approvals/:approvalId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "approver"]);
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "rejected") throw new BoundApprovalError("approval_decision_invalid");
    const expectedRevision = Number(req.header("if-match") ?? req.body?.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BoundApprovalError("approval_expected_revision_required");
    const approval = decideBoundApproval({ companyId, approvalId: String(req.params.approvalId ?? "").trim(), actorUserId: currentActorUserId(), decision, expectedRevision, note: typeof req.body?.note === "string" ? req.body.note : null });
    res.json({ ok: true, approval: boundApprovalApiView(approval), company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendBoundApprovalError(res, error, "approval_decision_failed");
  }
});

app.post("/api/v1/companies/:companyId/jobs/:jobId/cancel", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const job = cancelDurableJob({
      companyId,
      actorUserId: currentActorUserId(),
      jobId: String(req.params.jobId ?? "").trim()
    });
    res.json({
      ok: true,
      job: durableJobApiView(job),
      receipt: durableJobReceipt("durable_job.cancelled", job),
      company_scope: { enforced: true, company_id: companyId }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "company_scope_forbidden") {
      res.status(404).json({ ok: false, error: "durable_job_not_found", exactBlocker: "durable_job_not_found" });
      return;
    }
    sendDurableQueueError(res, error, "durable_job_cancel_failed");
  }
});

app.get("/api/v1/companies/:companyId/memory", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId);
    const entries = listCompanyMemory(companyId);
    res.json({ ok: true, entries, count: entries.length, company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendAutomationApiError(res, error, "company_memory_read_failed");
  }
});

app.get("/api/v1/companies/:companyId/presentation-profile", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    const company = requireCompanyAccess(companyId);
    const profile = buildPersistedProjectPresentationProfile(company, readMvpAutomations([companyId]));
    const memory = listCompanyMemory(companyId).find((entry) => entry.key === "project_profile");
    res.json({
      ok: true,
      profile,
      revision: memory?.revision ?? 0,
      source: profile.source,
      company_scope: { enforced: true, company_id: companyId }
    });
  } catch (error) {
    sendAutomationApiError(res, error, "project_profile_read_failed");
  }
});

app.put("/api/v1/companies/:companyId/presentation-profile", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    const company = requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const override = parseProjectPresentationProfileOverride(body.profile ?? body.presentation_profile ?? {});
    const existing = listCompanyMemory(companyId).find((entry) => entry.key === "project_profile");
    const expectedRevision = body.expected_revision === undefined || body.expected_revision === null
      ? null
      : Number(body.expected_revision);
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new Error("project_profile_expected_revision_invalid");
    let mergedOverride = override;
    if (existing) {
      let previousOverride: ReturnType<typeof parseProjectPresentationProfileOverride>;
      try {
        previousOverride = parseProjectPresentationProfileOverride(JSON.parse(existing.body));
      } catch (error) {
        const exactBlocker = error instanceof Error ? error.message : "project_profile_existing_invalid";
        throw new Error(`project_profile_existing_invalid:${exactBlocker}`);
      }
      mergedOverride = { ...previousOverride, ...override };
    }
    const memory = saveCompanyMemory({
      companyId,
      actorUserId: currentActorUserId(),
      memory: {
        key: "project_profile",
        kind: "custom",
        title: "Project presentation profile",
        body: JSON.stringify(mergedOverride),
        expectedRevision
      }
    });
    const profile = buildPersistedProjectPresentationProfile(company, readMvpAutomations([companyId]));
    res.json({
      ok: true,
      profile,
      revision: memory.revision,
      receipt: { action: existing ? "project_profile.updated" : "project_profile.created", company_id: companyId, revision: memory.revision },
      company_scope: { enforced: true, company_id: companyId },
      external_action_executed: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "project_profile_save_failed");
  }
});

app.put("/api/v1/companies/:companyId/memory/:memoryKey", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const memoryKey = String(req.params.memoryKey ?? "").trim();
    const exists = listCompanyMemory(companyId).some((entry) => entry.key === memoryKey);
    const memory = saveCompanyMemory({
      companyId,
      actorUserId: currentActorUserId(),
      memory: parseCompanyMemory({ ...req.body, key: memoryKey }, exists)
    });
    res.json({ ok: true, memory, receipt: { action: exists ? "company_memory.updated" : "company_memory.created", company_id: companyId, memory_id: memory.id, revision: memory.revision } });
  } catch (error) {
    sendAutomationApiError(res, error, "company_memory_save_failed");
  }
});

app.get("/api/v1/companies/:companyId/connection-account-refs", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin"]);
    const refs = listCompanyConnectionRefs(companyId);
    res.json({ ok: true, refs, count: refs.length, secret_material_included: false, company_scope: { enforced: true, company_id: companyId } });
  } catch (error) {
    sendAutomationApiError(res, error, "company_connection_refs_read_failed");
  }
});

app.put("/api/v1/companies/:companyId/connection-account-refs/:platform/:accountRef", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin"]);
    const platform = String(req.params.platform ?? "").trim();
    const accountRef = String(req.params.accountRef ?? "").trim();
    const exists = listCompanyConnectionRefs(companyId).some((item) => item.platform === platform && item.accountRef === accountRef);
    const connection = saveCompanyConnectionRef({
      companyId,
      actorUserId: currentActorUserId(),
      connection: parseCompanyConnectionAccountRef({ ...req.body, platform, account_ref: accountRef }, exists)
    });
    res.json({ ok: true, connection, receipt: { action: exists ? "company_connection.updated" : "company_connection.created", company_id: companyId, connection_id: connection.id, revision: connection.revision }, secret_material_included: false });
  } catch (error) {
    sendAutomationApiError(res, error, "company_connection_ref_save_failed");
  }
});

app.post("/api/v1/companies/:companyId/connection-account-refs/:connectionId/reconnect", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin"]);
    const connection = requestCompanyConnectionReconnect({
      companyId,
      actorUserId: currentActorUserId(),
      connectionId: String(req.params.connectionId ?? "").trim(),
      expectedRevision: connectionExpectedRevisionFrom(req)
    });
    res.json({
      ok: true,
      connection,
      receipt: { action: "company_connection.reconnect_requested", company_id: companyId, connection_id: connection.id, revision: connection.revision },
      human_gate: { required: true, reason: "oauth_reauthorization_required" },
      external_oauth_action_executed: false,
      secret_material_included: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "company_connection_reconnect_failed");
  }
});

app.post("/api/v1/companies/:companyId/connection-account-refs/:connectionId/revoke", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner", "admin"]);
    const connection = revokeCompanyConnectionRef({
      companyId,
      actorUserId: currentActorUserId(),
      connectionId: String(req.params.connectionId ?? "").trim(),
      expectedRevision: connectionExpectedRevisionFrom(req)
    });
    res.json({
      ok: true,
      connection,
      receipt: { action: "company_connection.revoked", company_id: companyId, connection_id: connection.id, revision: connection.revision },
      revocation_scope: "local_connection_reference",
      external_provider_revocation_executed: false,
      secret_material_included: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "company_connection_revoke_failed");
  }
});

app.get("/api/v1/admin/diagnostics", (_req, res) => {
  try {
    initDb();
    const ownerCompanies = listActorCompanies().filter((company) => company.role === "owner");
    if (ownerCompanies.length === 0) throw new Error("owner_admin_required");
    const { codexCapabilities, browserHealth } = getDashboardExpensiveSnapshot();
    const systemChecks = sanitizeDashboardRows(querySql<Record<string, unknown>>("SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 50"));
    res.json({
      ok: true,
      actor_user_id: currentActorUserId(),
      owner_company_ids: ownerCompanies.map((company) => company.id),
      pc: { local_worker: buildLocalWorkerStatus(systemChecks), scheduler: getSchedulerStatus(), system_checks: systemChecks },
      browser: browserHealth,
      iab: readCanonicalIabOwnerDiagnostics({ enabled: true }),
      workflow_adapters: {
        canonical_browser_use: readReferenceBrowserUseWorkflowAdaptersV1(),
        legacy_iab_compatibility: readReferenceIabWorkflowAdaptersV1()
      },
      company_release_readiness: buildBlockedCompanyReleaseReadinessV1(),
      company_release_evidence: buildBlockedCompanyReleaseEvidenceV1(),
      codex: {
        summary: codexCapabilities.summary,
        browser: codexCapabilities.capabilities.browser,
        chrome: codexCapabilities.capabilities.chrome,
        app_server: codexCapabilities.capabilities.appServer,
        mcp: codexCapabilities.capabilities.mcp,
        notes: codexCapabilities.notes
      },
      obsidian: getObsidianExportStatus(),
      deployment: getDashboardDeploymentReadback(),
      guards: { write: getProductionWriteGuardStatus(), access: getProductionApiAccessGuardStatus() },
      external_action_executed: false
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "owner_admin_read_failed";
    res.status(code === "owner_admin_required" ? 403 : 500).json({ ok: false, error: code, exactBlocker: code });
  }
});

app.get("/api/v1/companies/:companyId/feedback-artifacts/:artifactId", (req, res) => {
  try {
    initDb();
    const companyId = String(req.params.companyId ?? "").trim();
    requireCompanyAccess(companyId, ["owner"]);
    const artifact = readFeedbackArtifact(companyId, String(req.params.artifactId ?? "").trim());
    if (!artifact) {
      res.status(404).json({ ok: false, error: "feedback_artifact_not_found", exactBlocker: "feedback_artifact_not_found" });
      return;
    }
    res.setHeader("content-type", artifact.mimeType);
    res.setHeader("content-length", String(artifact.content.length));
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "sandbox; default-src 'none'");
    res.setHeader("x-artifact-id", artifact.id);
    res.setHeader("x-artifact-sha256", artifact.checksumSha256);
    res.setHeader("cache-control", "private, no-store");
    res.status(200).send(artifact.content);
  } catch (error) {
    if (error instanceof Error && error.message === "company_scope_forbidden") {
      res.status(404).json({ ok: false, error: "feedback_artifact_not_found", exactBlocker: "feedback_artifact_not_found" });
      return;
    }
    const code = error instanceof Error ? error.message : "feedback_artifact_read_failed";
    res.status(code.includes("invalid") ? 400 : code.includes("integrity") ? 409 : 500).json({ ok: false, error: code, exactBlocker: code });
  }
});

app.get("/api/mvp/feedback", (req, res) => {
  initDb();
  try {
    const scope = resolveCompanyScope(req, false);
    const feedbacks = readMvpFeedbacks(scope.companyIds);
    res.json({
      ok: true,
      feedbacks,
      count: feedbacks.length,
      open_count: feedbacks.filter((item) => item.status === "open").length,
      triaged: feedbacks.filter((item) => item.status === "triaged").length,
      company_scope: { enforced: true, company_ids: scope.companyIds }
    });
  } catch (error) {
    sendCompanyScopeError(res, error, "feedback_read_failed");
  }
});

app.get("/api/mvp/state", (req, res) => {
  initDb();
  try {
    const scope = resolveCompanyScope(req, false);
    res.json(getMvpStateReadback(scope.companyIds));
  } catch (error) {
    sendCompanyScopeError(res, error, "company_state_read_failed");
  }
});

app.post("/api/mvp/worker/preview", (req, res) => {
  initDb();
  const projectId = typeof req.body?.project_id === "string" && req.body.project_id.trim() ? req.body.project_id.trim() : "all";
  try {
    const available = listActorCompanies();
    if (projectId !== "all") requireCompanyAccess(projectId, ["owner", "admin", "operator"]);
    const companyIds = projectId === "all" ? available.map((company) => company.id) : [projectId];
    res.json(buildMvpWorkerPreview(projectId, getMvpStateReadback(companyIds)));
  } catch (error) {
    sendCompanyScopeError(res, error, "worker_preview_scope_failed");
  }
});

app.post("/api/mvp/worker/once", (req, res) => {
  initDb();
  const projectId = typeof req.body?.project_id === "string" && req.body.project_id.trim() ? req.body.project_id.trim() : "all";
  let companyIds: string[];
  try {
    const available = listActorCompanies();
    if (projectId !== "all") requireCompanyAccess(projectId, ["owner", "admin", "operator"]);
    companyIds = projectId === "all" ? available.map((company) => company.id) : [projectId];
  } catch (error) {
    sendCompanyScopeError(res, error, "worker_once_scope_failed");
    return;
  }
  const state = getMvpStateReadback(companyIds);
  const worker = state.worker;
  const preview = buildMvpWorkerPreview(projectId, state);
  const exactBlocker = worker.exact_blocker ?? preview.exact_blocker ?? "mac_worker_state_missing";
  res.json({
    ok: true,
    read_only: true,
    picked: false,
    exact_blocker: exactBlocker,
    next_action: worker.next_action ?? preview.next_action ?? "MVP stateを再読込してworker状態を確認してください。",
    processed_runs: [],
    run: null,
    state,
    workerProtocol: "read_only_preflight",
    external_action_executed: false
  });
});

app.get("/api/mvp/automations", (req, res) => {
  initDb();
  let companyIds: string[];
  try {
    companyIds = resolveCompanyScope(req, false).companyIds;
  } catch (error) {
    sendCompanyScopeError(res, error, "automation_list_scope_failed");
    return;
  }
  const automations = readMvpAutomations(companyIds);
  res.json({
    ok: true,
    automations,
    builder_specs: automations.map((item) => ({
      automation_id: item.id,
      project_id: item.project_id,
      updated_at: item.updated_at,
      spec: item.builder_spec
    })),
    state: getMvpStateReadback(companyIds),
    company_scope: { enforced: true, company_ids: companyIds }
  });
});

app.post("/api/mvp/automations", (req, res) => {
  try {
    initDb();
    const companyId = requestedCompanyId(req);
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const idempotencyKey = requireIdempotencyKey(req.header("idempotency-key"));
    const requestedId = typeof req.body?.id === "string" && req.body.id.trim() ? req.body.id.trim() : undefined;
    const automation = createAutomationRecord({
      companyId,
      actorUserId: currentActorUserId(),
      definition: parseAutomationCreate(legacyAutomationDefinition(req.body)),
      automationId: requestedId,
      idempotencyKey,
      idempotencyRequest: req.body
    });
    res.status(201).json({
      ok: true,
      automation: automationApiView(automation),
      receipt: automationReceipt("automation.created", automation),
      state: getMvpStateReadback(actorCompanyIds()),
      external_action_executed: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_create_failed");
  }
});

app.patch("/api/mvp/automations/:automationId", (req, res) => {
  try {
    initDb();
    const automationId = typeof req.params.automationId === "string" ? req.params.automationId.trim() : "";
    if (!automationId) {
      res.status(400).json({ ok: false, error: "automation_id_required", exactBlocker: "automation_id_required" });
      return;
    }
    const current = readMvpAutomationScope(automationId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!current) {
      res.status(404).json({ ok: false, error: "automation_not_found", exactBlocker: "automation_not_found" });
      return;
    }
    const requestedScope = requestedCompanyId(req, false);
    if (requestedScope && requestedScope !== current.company_id) throw new Error("automation_company_mismatch");
    const automation = updateAutomationRecord({
      companyId: current.company_id,
      actorUserId: currentActorUserId(),
      automationId,
      patch: parseAutomationPatch(legacyAutomationPatch(req.body), req.header("if-match"))
    });
    res.json({
      ok: true,
      automation: automationApiView(automation),
      receipt: automationReceipt("automation.updated", automation),
      state: getMvpStateReadback(actorCompanyIds()),
      external_action_executed: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "automation_patch_failed");
  }
});

app.put("/api/mvp/automations/:automationId/builder-spec", (req, res) => {
  try {
    initDb();
    const automationId = typeof req.params.automationId === "string" ? req.params.automationId.trim() : "";
    if (!automationId) {
      res.status(400).json({ ok: false, error: "automation_id_required", exactBlocker: "automation_id_required" });
      return;
    }
    const current = readMvpAutomationScope(automationId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!current) {
      res.status(404).json({ ok: false, error: "automation_not_found", exactBlocker: "automation_not_found" });
      return;
    }
    const expectedRevision = expectedRevisionFrom(req);
    const nextSpec = req.body?.spec && typeof req.body.spec === "object" ? req.body.spec : req.body?.builder_spec;
    const automation = updateAutomationRecord({
      companyId: current.company_id,
      actorUserId: currentActorUserId(),
      automationId,
      patch: parseAutomationPatch({ expected_revision: expectedRevision, builder_spec: nextSpec })
    });
    res.json({
      ok: true,
      automation_id: automationId,
      spec: automation.builderSpec,
      automation: automationApiView(automation),
      receipt: automationReceipt("automation.updated", automation),
      state: getMvpStateReadback(actorCompanyIds()),
      external_action_executed: false
    });
  } catch (error) {
    sendAutomationApiError(res, error, "builder_spec_save_failed");
  }
});

let researchPlanSchedulerTimer: ReturnType<typeof setInterval> | undefined;
const researchPlanSchedulerInFlightDueKeys = new Set<string>();

app.post("/api/mvp/feedback", (req, res) => {
  initDb();
  const body = req.body ?? {};
  let companyId: string;
  try {
    companyId = requestedCompanyId(req);
    requireCompanyAccess(companyId, ["owner", "admin", "operator", "viewer"]);
  } catch (error) {
    sendCompanyScopeError(res, error, "feedback_create_failed");
    return;
  }
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (!comment) {
    res.status(400).json({ ok: false, error: "feedback_comment_required", exactBlocker: "feedback_comment_required" });
    return;
  }
  const route = typeof body.route === "string" ? body.route : "#/";
  const pageTitle = typeof body.page_title === "string" ? body.page_title : "Automation OS";
  const requestedArtifactUri = typeof body.capture?.artifact_uri === "string"
    ? body.capture.artifact_uri
    : typeof body.capture?.url === "string"
      ? body.capture.url
      : `${route}#feedback`;
  const screenshotDataUrl = typeof body.screenshot_data_url === "string" ? body.screenshot_data_url : null;
  if (screenshotDataUrl && body.sensitive_content_confirmed !== true) {
    res.status(400).json({ ok: false, error: "feedback_screenshot_sensitive_confirmation_required", exactBlocker: "feedback_screenshot_sensitive_confirmation_required" });
    return;
  }
  const feedbackId = makeId("feedback");
  let screenshot: ReturnType<typeof parseFeedbackScreenshotDataUrl> = null;
  try {
    screenshot = screenshotDataUrl ? parseFeedbackScreenshotDataUrl(screenshotDataUrl) : null;
  } catch (error) {
    const code = error instanceof Error ? error.message : "feedback_screenshot_invalid";
    const status = code === "feedback_screenshot_too_large" ? 413 : code === "feedback_screenshot_mime_not_allowed" ? 415 : 400;
    res.status(status).json({ ok: false, error: code, exactBlocker: code });
    return;
  }
  const screenshotArtifactId = screenshot ? makeId("feedback_artifact") : null;
  const artifactUri = screenshotArtifactId
    ? `/api/v1/companies/${encodeURIComponent(companyId)}/feedback-artifacts/${encodeURIComponent(screenshotArtifactId)}`
    : requestedArtifactUri;
  const createdAt = nowIso();
  const payload = {
    company_id: companyId,
    project_id: companyId,
    route,
    page_title: pageTitle,
    comment,
    artifact_uri: artifactUri,
    has_screenshot: Boolean(screenshot),
    screenshot_artifact_id: screenshotArtifactId,
    viewport: body.capture?.viewport ?? null,
    workflow_context: body.workflow_context ?? null,
    category: typeof body.category === "string" ? body.category : "bug",
    severity: typeof body.severity === "string" ? body.severity : "medium",
    fix_target: typeof body.fix_target === "string" ? body.fix_target : "ui",
    sensitive_content_confirmed: Boolean(body.sensitive_content_confirmed)
  };
  const feedback = {
    id: feedbackId,
    company_id: companyId,
    feedback_id: feedbackId,
    status: "open",
    route,
    page_title: pageTitle,
    comment,
    artifact_uri: artifactUri,
    has_screenshot: screenshot ? 1 : 0,
    screenshot_artifact_id: screenshotArtifactId,
    viewport_json: JSON.stringify(body.capture?.viewport ?? {}),
    workflow_context_json: JSON.stringify(body.workflow_context ?? {}),
    category: payload.category,
    severity: payload.severity,
    fix_target: payload.fix_target,
    captured_at: typeof body.capture?.captured_at === "string" ? body.capture.captured_at : createdAt,
    created_at: createdAt,
    payload_json: JSON.stringify(payload)
  };
  runSqlTransaction([
    ...(screenshot && screenshotArtifactId ? [{
      sql: `INSERT INTO feedback_artifacts (id, company_id, feedback_id, kind, mime_type, checksum_sha256, size_bytes, content_base64, status, created_at, updated_at) VALUES (${sqlValue(screenshotArtifactId)}, ${sqlValue(companyId)}, ${sqlValue(feedbackId)}, 'screenshot', ${sqlValue(screenshot.mimeType)}, ${sqlValue(screenshot.checksumSha256)}, ${screenshot.sizeBytes}, ${sqlValue(screenshot.contentBase64)}, 'available', ${sqlValue(createdAt)}, ${sqlValue(createdAt)})`,
      expectChanges: 1
    }] : []),
    {
      sql: `INSERT INTO mvp_feedback (id, company_id, feedback_id, status, route, page_title, comment, artifact_uri, has_screenshot, screenshot_artifact_id, viewport_json, workflow_context_json, category, severity, fix_target, captured_at, created_at, payload_json) VALUES (${sqlValue(feedback.id)}, ${sqlValue(feedback.company_id)}, ${sqlValue(feedback.feedback_id)}, ${sqlValue(feedback.status)}, ${sqlValue(feedback.route)}, ${sqlValue(feedback.page_title)}, ${sqlValue(feedback.comment)}, ${sqlValue(feedback.artifact_uri)}, ${feedback.has_screenshot}, ${sqlValue(feedback.screenshot_artifact_id)}, ${sqlValue(feedback.viewport_json)}, ${sqlValue(feedback.workflow_context_json)}, ${sqlValue(feedback.category)}, ${sqlValue(feedback.severity)}, ${sqlValue(feedback.fix_target)}, ${sqlValue(feedback.captured_at)}, ${sqlValue(feedback.created_at)}, ${sqlValue(feedback.payload_json)})`,
      expectChanges: 1
    }
  ]);
  res.status(201).json({
    ok: true,
    feedback: {
      ...feedback,
      has_screenshot: Boolean(screenshot),
      screenshot_artifact_id: screenshotArtifactId,
      screenshot: screenshot ? { id: screenshotArtifactId, mime_type: screenshot.mimeType, checksum_sha256: screenshot.checksumSha256, size_bytes: screenshot.sizeBytes, view_url: artifactUri } : null
    },
    state: getMvpStateReadback(actorCompanyIds()),
    inbox_forward: { status: "local", sink: "mvp_feedback" },
    external_action_executed: false
  });
});

app.post("/api/mvp/approvals", (req, res) => {
  try {
    initDb();
    const body = req.body ?? {};
    const companyId = requestedCompanyId(req);
    requireCompanyAccess(companyId, ["owner", "admin", "approver"]);
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "MVP 承認待ち";
  const requestedBy = typeof body.requested_by === "string" && body.requested_by.trim() ? body.requested_by.trim() : "local-ui";
  const approvalGroupId = typeof body.approval_group_id === "string" && body.approval_group_id.trim() ? body.approval_group_id.trim() : `mvp_ui_${makeId("approval_group")}`;
  const resourceLocks = Array.isArray(body.resource_locks)
    ? body.resource_locks.map((lock: unknown) => String(lock).trim()).filter(Boolean)
    : [];
  const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim() : "normal";
  const runId = typeof body.run_id === "string" && body.run_id.trim() ? body.run_id.trim() : null;
  if (runId) {
    const run = findScopedRun(runId, [companyId]);
    if (!run) {
      res.status(404).json({ ok: false, error: "run_not_found", exactBlocker: "run_not_found" });
      return;
    }
  }
  const approvalId = makeId("approval");
  const createdAt = nowIso();
  insert("approvals", {
    id: approvalId,
    company_id: companyId,
    run_id: runId,
    title,
    requested_by: requestedBy,
    status: "pending",
    priority,
    approval_group_id: approvalGroupId,
    resource_locks_json: JSON.stringify(resourceLocks),
    created_at: createdAt,
    decided_at: null,
    decision_note: null
  });
  res.status(201).json({
    ok: true,
    approval: {
      id: approvalId,
      company_id: companyId,
      run_id: runId,
      title,
      requested_by: requestedBy,
      status: "pending",
      priority,
      approval_group_id: approvalGroupId,
      resource_locks_json: resourceLocks,
      created_at: createdAt,
      decided_at: null,
      decision_note: null
    },
    state: getMvpStateReadback(actorCompanyIds()),
    external_action_executed: false
  });
  } catch (error) {
    sendCompanyScopeError(res, error, "approval_create_failed");
  }
});

app.patch("/api/mvp/feedback/:feedbackId", (req, res) => {
  initDb();
  const feedbackId = typeof req.params.feedbackId === "string" ? req.params.feedbackId.trim() : "";
  const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
  if (!feedbackId) {
    res.status(400).json({ ok: false, error: "feedback_id_required", exactBlocker: "feedback_id_required" });
    return;
  }
  if (!["open", "triaged"].includes(status)) {
    res.status(400).json({ ok: false, error: "feedback_status_invalid", exactBlocker: "feedback_status_invalid" });
    return;
  }
  const existingRows = querySql<{ id: string; company_id: string; feedback_id: string; status: string }>(
    `SELECT id, company_id, feedback_id, status FROM mvp_feedback
     WHERE feedback_id=${sqlValue(feedbackId)}
       AND ${scopedCompanyPredicate("company_id", actorCompanyIds(["owner"]))}
     LIMIT 1`
  );
  const existing = existingRows[0];
  if (!existing) {
    res.status(404).json({ ok: false, error: "feedback_not_found", exactBlocker: "feedback_not_found" });
    return;
  }
  execSql(`UPDATE mvp_feedback SET status=${sqlValue(status)} WHERE feedback_id=${sqlValue(feedbackId)} AND company_id=${sqlValue(existing.company_id)};`);
  res.json({
    ok: true,
    feedback_id: feedbackId,
    status,
    updated_at: nowIso()
  });
});

app.patch("/api/mvp/approvals/:approvalId", async (req, res, next) => {
  try {
    const approvalId = typeof req.params.approvalId === "string" ? req.params.approvalId.trim() : "";
    const decision = typeof req.body?.decision === "string" ? req.body.decision.trim() : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!approvalId) {
      res.status(400).json({ ok: false, error: "approval_id_required", exactBlocker: "approval_id_required" });
      return;
    }
    if (!["approve", "reject"].includes(decision)) {
      res.status(400).json({ ok: false, error: "approval_decision_invalid", exactBlocker: "approval_decision_invalid" });
      return;
    }
    const allowedCompanyIds = actorCompanyIds(["owner", "admin", "approver"]);
    const existing = findScopedApproval(approvalId, allowedCompanyIds);
    if (!existing) {
      res.status(404).json({ ok: false, error: "approval_not_found", exactBlocker: "approval_not_found" });
      return;
    }
    const status = decision === "approve" ? "approved" : "rejected";
    const result = await decideStoredApproval(approvalId, status, allowedCompanyIds);
    if (result.statusCode && result.statusCode !== 200) {
      res.status(result.statusCode).json(result.body);
      return;
    }
    if (note) {
      execSql(`UPDATE approvals SET decision_note = ${sqlValue(note)} WHERE id = ${sqlValue(approvalId)} AND company_id=${sqlValue(existing.company_id)};`);
    }
    res.json({
      ok: true,
      approval_id: approvalId,
      decision,
      state: getMvpStateReadback(actorCompanyIds()),
      approval: querySql(`SELECT * FROM approvals WHERE id=${sqlValue(approvalId)} AND company_id=${sqlValue(existing.company_id)} LIMIT 1`)[0] ?? null,
      external_action_executed: false
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("company_")) {
      sendTenantResourceError(res, error, "approval_not_found", "approval_update_failed");
      return;
    }
    next(error);
  }
});

app.get("/api/mvp/registered-automations", (req, res) => {
  try {
    initDb();
    const companyId = requestedCompanyId(req);
    requireCompanyAccess(companyId);
    res.json(buildCompanyRegisteredAutomationReadback(companyId));
  } catch (error) {
    sendCompanyScopeError(res, error, "registered_automation_read_failed");
  }
});

app.post("/api/mvp/registered-automations/:id/run", (req, res) => {
  try {
    initDb();
    const projectId = requestedCompanyId(req);
    requireCompanyAccess(projectId, ["owner", "admin", "operator"]);
    const result = buildCompanyRegisteredAutomationRunResponse(req.params.id, projectId);
    if (result.statusCode) {
      res.status(result.statusCode).json(result.body);
      return;
    }
    res.json(result.body);
  } catch (error) {
    sendCompanyScopeError(res, error, "registered_automation_run_failed");
  }
});

app.post("/api/portable-workflows/:id/run", async (req, res, next) => {
  try {
    initDb();
    initRegisteredWorkflows();
    const projectId = requestedCompanyId(req);
    requireCompanyAccess(projectId, ["owner", "admin", "operator"]);
    const fixedWorkflow = fixedRegisteredWorkflows.find((item) => item.id === req.params.id);
    if (!fixedWorkflow) {
      res.status(404).json({ ok: false, error: "portable_workflow_not_found", exact_blocker: "portable_workflow_not_found", external_action_executed: false });
      return;
    }
    const workflow = getRegisteredWorkflowForCompanies(req.params.id, [projectId]);
    if (!workflow) {
      res.status(404).json({ ok: false, error: "registered_workflow_not_found", exact_blocker: "registered_workflow_not_found", external_action_executed: false });
      return;
    }
    if (String(workflow.status).toLowerCase() !== "active") {
      res.status(409).json({ ok: false, error: "registered_workflow_inactive", exact_blocker: "registered_workflow_inactive", external_action_executed: false });
      return;
    }
    const requestedKey = typeof req.body?.idempotency_key === "string"
      ? req.body.idempotency_key.trim()
      : typeof req.get("idempotency-key") === "string" ? req.get("idempotency-key")!.trim() : "";
    const idempotencyKey = requestedKey || `ui:${workflow.id}:${currentActorUserId()}:${Date.now()}`;
    if (idempotencyKey.length > 240 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      res.status(400).json({ ok: false, error: "portable_idempotency_key_invalid", exact_blocker: "portable_idempotency_key_invalid", external_action_executed: false });
      return;
    }
    const started = await startPortableWorkflowRun({
      workflowId: workflow.id as Parameters<typeof startPortableWorkflowRun>[0]["workflowId"],
      sourceTrigger: "automation_os_ui",
      idempotencyKey,
      companyId: projectId
    });
    const mode = portableWorkerExecutionMode();
    res.status(202).json({
      ok: true,
      accepted: true,
      replayed: started.replayed,
      runId: started.runId,
      status: started.status ?? "queued",
      workflow: publicRegisteredWorkflowById(workflow.id),
      portable: {
        workflow_id: workflow.id,
        source_trigger: "automation_os_ui",
        execution_mode: mode,
        app_dependency: false,
        browser_surface: "browser_use_cli",
        connector_gateway: "mcp",
        external_runner_configured: Boolean(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER?.trim()),
        external_action_executed: false
      },
      workerProtocol: "mac_worker_polling_required",
      nextAction: mode === PORTABLE_WORKER_EXTERNAL_MODE
        ? "Mac worker loopが本番DBから拾い、portable external adapterのreceiptを保存します。"
        : "canaryとしてrun binding/readbackを確認します。外部操作を開始するにはMac側portable external adapterの設定が必要です。"
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", (_req, res) => {
  if (dbBackend !== "postgres") initDb();
  res.json(getDashboard());
});

app.get("/api/codex/capabilities", (_req, res) => {
  res.json(getCodexCapabilitiesReadback());
});

app.post("/api/codex/capabilities/probe", (_req, res) => {
  const probe = probeCodexMcpSurface();
  res.json(getCodexCapabilitiesReadback({ mcpProbe: probe, forceRefresh: true }));
});

app.post("/api/codex/app-server/probe", async (_req, res, next) => {
  try {
    const probe = await probeCodexAppServerSurface();
    res.json({
      ok: probe.ok,
      probe,
      matrix: getCodexCapabilitiesReadback({ appServerProbe: probe, forceRefresh: true }).matrix
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/capability-router/backlog", (_req, res) => {
  const capabilities = getCodexCapabilitiesCache().cache.capabilities;
  res.json(
    buildCapabilityRouterSnapshot({
      capabilities,
      bridgeActions: listTrustedBridgeActions()
    })
  );
});

app.post("/api/capability-router/plan", (req, res) => {
  const capabilities = getCodexCapabilitiesCache().cache.capabilities;
  res.json(
    buildCapabilityRouterSnapshot({
      command: typeof req.body?.command === "string" ? req.body.command : "",
      capabilities,
      bridgeActions: listTrustedBridgeActions()
    })
  );
});

app.post("/api/create/plan", async (req, res, next) => {
  try {
    const messages = normalizeCreatePlannerRequestMessages(req.body);
    const currentDraft = typeof req.body?.currentDraft === "string" ? req.body.currentDraft : "";
    const plan = await createPlannerResponse({ messages, currentDraft });
    res.json({ ok: true, plan });
  } catch (error) {
    next(error);
  }
});

app.post("/api/create/plan/jobs", (req, res, next) => {
  try {
    const messages = normalizeCreatePlannerRequestMessages(req.body);
    const currentDraft = typeof req.body?.currentDraft === "string" ? req.body.currentDraft : "";
    const fallbackPlan = buildLocalPlanner(messages, "mac_worker_planner_queued");
    const job = enqueueCreatePlannerJob({
      messages,
      currentDraft,
      metadata: {
        route: "mac_worker_subscription",
        immediatePlanSource: fallbackPlan.source,
        actorUserId: currentActorUserId(),
        companyIds: actorCompanyIds()
      }
    });
    res.json({ ok: true, job: sanitizeCreatePlannerJobForApi(job), plan: fallbackPlan });
  } catch (error) {
    next(error);
  }
});

app.post("/api/create/chat", (req, res, next) => {
  try {
    initDb();
    const messages = normalizeCreatePlannerRequestMessages(req.body);
    if (messages.length === 0) {
      res.status(400).json({ ok: false, error: "chat_message_required", exactBlocker: "chat_message_required" });
      return;
    }
    const requested = requestedCompanyId(req, false);
    const companyIds = requested ? [requireCompanyAccess(requested).id] : actorCompanyIds();
    const requestedSessionId = typeof req.body?.session_id === "string"
      ? req.body.session_id.trim()
      : typeof req.body?.chat_session_id === "string" ? req.body.chat_session_id.trim() : "";
    const session = requestedSessionId
      ? readScopedChatSession(requestedSessionId, companyIds[0] ?? "", currentActorUserId())
      : undefined;
    if (requestedSessionId && !session) {
      res.status(404).json({ ok: false, error: "chat_session_not_found", exactBlocker: "chat_session_not_found" });
      return;
    }
    const bodyThreadId = typeof req.body?.codex_thread_id === "string" ? req.body.codex_thread_id.trim() : "";
    if (session?.codex_thread_id && bodyThreadId && session.codex_thread_id !== bodyThreadId) {
      res.status(409).json({ ok: false, error: "chat_session_thread_mismatch", exactBlocker: "chat_session_thread_mismatch" });
      return;
    }
    const requestedThreadId = session?.codex_thread_id ?? bodyThreadId;
    if (requestedThreadId) assertCreatePlannerThreadAccess(requestedThreadId, companyIds, currentActorUserId());
    const contextSnapshot = buildAutomationOsChatSnapshot(companyIds);
    const job = enqueueCreatePlannerJob({
      messages,
      currentDraft: typeof req.body?.currentDraft === "string" ? req.body.currentDraft : "",
      metadata: {
        route: "mac_worker_codex_app_server",
        transport: "codex_app_server",
        actorUserId: currentActorUserId(),
        companyIds,
        ...(session ? { chatSessionId: session.id } : {}),
        codexThreadId: requestedThreadId || undefined,
        contextCapturedAt: new Date().toISOString(),
        contextSnapshotHash: createHash("sha256").update(contextSnapshot).digest("hex"),
        contextSnapshot
      }
    });
    res.status(202).json({
      ok: true,
      job: sanitizeCreatePlannerJobForApi(job),
      worker_readback: safeStoredWorkerStateForApi(),
      external_action_executed: false
    });
  } catch (error) {
    const exact = error instanceof Error ? error.message : "create_chat_failed";
    if (exact === "codex_thread_scope_forbidden") {
      res.status(404).json({ ok: false, error: "codex_thread_not_found", exactBlocker: "codex_thread_not_found" });
      return;
    }
    next(error);
  }
});

app.get("/api/create/chat/sessions", (req, res, next) => {
  try {
    initDb();
    const projectId = requestedCompanyId(req, true);
    const company = requireCompanyAccess(projectId);
    const sessions = listScopedChatSessions(company.id, currentActorUserId());
    res.json({ ok: true, project_id: company.id, sessions });
  } catch (error) {
    sendTenantResourceError(res, error, "chat_session_not_found", "chat_sessions_list_failed");
  }
});

app.post("/api/create/chat/sessions", (req, res, next) => {
  try {
    initDb();
    const projectId = requestedCompanyId(req, true);
    const company = requireCompanyAccess(projectId);
    const name = sanitizeShortText(
      typeof req.body?.name === "string" ? req.body.name : typeof req.body?.title === "string" ? req.body.title : "",
      120
    );
    if (!name) {
      res.status(400).json({ ok: false, error: "chat_session_name_required", exactBlocker: "chat_session_name_required" });
      return;
    }
    const actorUserId = currentActorUserId();
    if (querySql("SELECT id FROM chat_sessions WHERE company_id=" + sqlValue(company.id) + " AND actor_user_id=" + sqlValue(actorUserId) + " AND name=" + sqlValue(name) + " LIMIT 1")[0]) {
      res.status(409).json({ ok: false, error: "chat_session_name_conflict", exactBlocker: "chat_session_name_conflict" });
      return;
    }
    const suppliedThreadId = typeof req.body?.codex_thread_id === "string" ? req.body.codex_thread_id.trim() : "";
    if (suppliedThreadId) assertCreatePlannerThreadAccess(suppliedThreadId, [company.id], actorUserId);
    const existing = querySql<{ id: string }>("SELECT id FROM chat_sessions WHERE company_id=" + sqlValue(company.id) + " AND actor_user_id=" + sqlValue(actorUserId) + " LIMIT 1");
    const timestamp = nowIso();
    const session = {
      id: makeId("chat_session"),
      company_id: company.id,
      actor_user_id: actorUserId,
      name,
      codex_thread_id: suppliedThreadId || null,
      is_active: existing.length === 0 ? 1 : 0,
      created_at: timestamp,
      updated_at: timestamp
    };
    insert("chat_sessions", session);
    res.status(201).json({ ok: true, session: sanitizeChatSessionForApi(session) });
  } catch (error) {
    sendChatSessionError(res, error, "chat_session_create_failed");
  }
});

app.patch("/api/create/chat/sessions/:id", (req, res, next) => {
  try {
    initDb();
    const projectId = requestedCompanyId(req, true);
    const company = requireCompanyAccess(projectId);
    const actorUserId = currentActorUserId();
    const current = readScopedChatSession(req.params.id, company.id, actorUserId);
    if (!current) {
      res.status(404).json({ ok: false, error: "chat_session_not_found", exactBlocker: "chat_session_not_found" });
      return;
    }
    const name = sanitizeShortText(
      typeof req.body?.name === "string" ? req.body.name : typeof req.body?.title === "string" ? req.body.title : "",
      120
    );
    if (!name) {
      res.status(400).json({ ok: false, error: "chat_session_name_required", exactBlocker: "chat_session_name_required" });
      return;
    }
    const duplicate = querySql("SELECT id FROM chat_sessions WHERE company_id=" + sqlValue(company.id) + " AND actor_user_id=" + sqlValue(actorUserId) + " AND name=" + sqlValue(name) + " AND id!=" + sqlValue(current.id) + " LIMIT 1")[0];
    if (duplicate) {
      res.status(409).json({ ok: false, error: "chat_session_name_conflict", exactBlocker: "chat_session_name_conflict" });
      return;
    }
    const updated = querySql<ChatSessionRow>(
      `UPDATE chat_sessions
       SET name=${sqlValue(name)}, updated_at=${sqlValue(nowIso())}
       WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(company.id)} AND actor_user_id=${sqlValue(actorUserId)}
       RETURNING *`
    )[0];
    res.json({ ok: true, session: sanitizeChatSessionForApi(updated ?? { ...current, name }) });
  } catch (error) {
    sendChatSessionError(res, error, "chat_session_rename_failed");
  }
});

app.post("/api/create/chat/sessions/:id/activate", (req, res, next) => {
  try {
    initDb();
    const projectId = requestedCompanyId(req, true);
    const company = requireCompanyAccess(projectId);
    const actorUserId = currentActorUserId();
    const current = readScopedChatSession(req.params.id, company.id, actorUserId);
    if (!current) {
      res.status(404).json({ ok: false, error: "chat_session_not_found", exactBlocker: "chat_session_not_found" });
      return;
    }
    runSqlTransaction([
      { sql: `UPDATE chat_sessions SET is_active=0, updated_at=${sqlValue(nowIso())} WHERE company_id=${sqlValue(company.id)} AND actor_user_id=${sqlValue(actorUserId)}` },
      { sql: `UPDATE chat_sessions SET is_active=1, updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(company.id)} AND actor_user_id=${sqlValue(actorUserId)}`, expectChanges: 1 }
    ]);
    const activated = readScopedChatSession(current.id, company.id, actorUserId) ?? current;
    res.json({ ok: true, session: sanitizeChatSessionForApi(activated) });
  } catch (error) {
    sendTenantResourceError(res, error, "chat_session_not_found", "chat_session_activate_failed");
  }
});

app.get("/api/create/chat/threads", (req, res, next) => {
  try {
    initDb();
    const requested = requestedCompanyId(req, false);
    const companyIds = requested ? [requireCompanyAccess(requested).id] : actorCompanyIds();
    const threads = listCreateChatThreads({
      companyIds,
      actorUserId: currentActorUserId(),
      limit: typeof req.query?.limit === "string" ? Number(req.query.limit) : 20
    });
    res.json({ ok: true, company_ids: companyIds, threads });
  } catch (error) {
    next(error);
  }
});

app.get("/api/create/plan/jobs/:id", (req, res) => {
  const job = getCreatePlannerJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: "create_planner_job_not_found" });
    return;
  }
  try {
    assertCreatePlannerJobAccess(job);
  } catch {
    res.status(404).json({ ok: false, error: "create_planner_job_not_found", exactBlocker: "create_planner_job_not_found" });
    return;
  }
  res.json({ ok: true, job: sanitizeCreatePlannerJobForApi(job), plan: job.result, worker_readback: safeStoredWorkerStateForApi() });
});

app.post("/api/create/plan/jobs/:id/cancel", (req, res) => {
  const job = getCreatePlannerJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: "create_planner_job_not_found", exactBlocker: "create_planner_job_not_found" });
    return;
  }
  try {
    assertCreatePlannerJobAccess(job);
  } catch {
    res.status(404).json({ ok: false, error: "create_planner_job_not_found", exactBlocker: "create_planner_job_not_found" });
    return;
  }
  if (job.status !== "queued" && job.status !== "running") {
    res.status(409).json({ ok: false, error: "chat_job_not_cancellable", exactBlocker: "chat_job_not_cancellable" });
    return;
  }
  const cancelled = cancelCreatePlannerJob(job.id);
  if (!cancelled || cancelled.status !== "blocked" || cancelled.exactBlocker !== "chat_cancelled_by_user") {
    res.status(409).json({ ok: false, error: "chat_job_not_cancellable", exactBlocker: "chat_job_not_cancellable" });
    return;
  }
  res.json({
    ok: true,
    job: sanitizeCreatePlannerJobForApi(cancelled),
    external_action_executed: false
  });
});

app.get("/api/create/session", (_req, res) => {
  initDb();
  res.json({ ok: true, session: readCreateSession() });
});

app.patch("/api/create/session", (req, res) => {
  initDb();
  const session = sanitizeCreateSessionPayload(req.body);
  saveCreateSession(session);
  res.json({ ok: true, session: readCreateSession() });
});

app.get("/api/codex/automation-migration-ledger", (_req, res) => {
  initDb();
  const registeredWorkflows = initRegisteredWorkflows();
  res.json(
    buildCodexAutomationMigrationLedger({
      registeredWorkflows,
      runs: querySql<CodexAutomationMigrationRunRow>("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 500"),
      proofs: querySql<CodexAutomationMigrationProofRow>("SELECT run_id, proof_type, created_at, metadata_json FROM proofs ORDER BY created_at DESC LIMIT 2000"),
      approvals: querySql<CodexAutomationMigrationApprovalRow>("SELECT id, run_id, status, created_at FROM approvals ORDER BY created_at DESC LIMIT 2000")
    })
  );
});

app.post("/api/codex/capabilities", (_req, res) => {
  res.json(getCodexCapabilitiesReadback({ forceRefresh: true }));
});

app.get("/api/registered-workflows", (_req, res) => {
  initDb();
  initRegisteredWorkflows();
  res.json({ workflows: publicRegisteredWorkflowRows(listRegisteredWorkflowsForCompanies(actorCompanyIds())) });
});

app.post("/api/registered-workflows/refresh", (_req, res) => {
  initDb();
  const companyIds = actorCompanyIds(["owner", "admin"]);
  if (companyIds.length === 0) {
    res.status(403).json({ error: "company_scope_forbidden" });
    return;
  }
  refreshRegisteredWorkflows();
  res.json({ workflows: publicRegisteredWorkflowRows(listRegisteredWorkflowsForCompanies(companyIds)) });
});

app.post("/api/registered-workflows/scheduler/run-once", async (_req, res, next) => {
  try {
    initDb();
    const companyIds = actorCompanyIds(["owner", "admin"]);
    if (companyIds.length === 0) {
      res.status(403).json({ error: "company_scope_forbidden" });
      return;
    }
    const result = await runResearchPlanSchedulerOnce(new Date(), companyIds);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/registered-workflows/rehearsal/run-once", (_req, res) => {
  initDb();
  const companyIds = actorCompanyIds(["owner", "admin"]);
  if (companyIds.length === 0) {
    res.status(403).json({ error: "company_scope_forbidden" });
    return;
  }
  res.json(runRegisteredWorkflowRehearsalCheck(companyIds));
});

app.post("/api/registered-workflows/:id/pause", (req, res) => {
  initDb();
  initRegisteredWorkflows();
  const fixedWorkflow = fixedRegisteredWorkflows.some((item) => item.id === req.params.id);
  const companyIds = actorCompanyIds(fixedWorkflow ? ["owner", "admin"] : ["owner", "admin", "operator"]);
  const workflow = setRegisteredWorkflowSchedulePaused(req.params.id, true, companyIds);
  if (!workflow) {
    res.status(404).json({ error: "registered_workflow_not_found" });
    return;
  }
  maybeAutoExportObsidianAfterResponse("registered-workflow-paused");
  res.json({ workflow: publicRegisteredWorkflowById(workflow.id) });
});

app.post("/api/registered-workflows/:id/resume", (req, res) => {
  initDb();
  initRegisteredWorkflows();
  const fixedWorkflow = fixedRegisteredWorkflows.some((item) => item.id === req.params.id);
  const companyIds = actorCompanyIds(fixedWorkflow ? ["owner", "admin"] : ["owner", "admin", "operator"]);
  const workflow = setRegisteredWorkflowSchedulePaused(req.params.id, false, companyIds);
  if (!workflow) {
    res.status(404).json({ error: "registered_workflow_not_found" });
    return;
  }
  maybeAutoExportObsidianAfterResponse("registered-workflow-resumed");
  res.json({ workflow: publicRegisteredWorkflowById(workflow.id) });
});

app.patch("/api/registered-workflows/:id/schedule", (req, res) => {
  try {
    initDb();
    initRegisteredWorkflows();
    const fixedWorkflow = fixedRegisteredWorkflows.some((item) => item.id === req.params.id);
    const companyIds = actorCompanyIds(fixedWorkflow ? ["owner", "admin"] : ["owner", "admin", "operator"]);
    const workflow = setRegisteredWorkflowScheduleOverride(req.params.id, req.body, companyIds);
    if (!workflow) {
      res.status(404).json({ error: "registered_workflow_not_found" });
      return;
    }
    maybeAutoExportObsidianAfterResponse("registered-workflow-schedule-updated");
    res.json({ workflow: publicRegisteredWorkflowById(workflow.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_schedule";
    if (/^invalid_schedule_/.test(message)) {
      res.status(400).json({ error: message });
      return;
    }
    throw error;
  }
});

app.post("/api/registered-workflows/:id/start", async (req, res, next) => {
  try {
    initDb();
    initRegisteredWorkflows();
    const fixedWorkflow = fixedRegisteredWorkflows.find((item) => item.id === req.params.id);
    const companyIds = actorCompanyIds(fixedWorkflow ? ["owner", "admin"] : ["owner", "admin", "operator"]);
    const workflow = getRegisteredWorkflowForCompanies(req.params.id, companyIds);
    if (!workflow) {
      res.status(404).json({ error: "registered_workflow_not_found" });
      return;
    }
    if (String(workflow.status).toLowerCase() !== "active") {
      res.status(409).json({ error: "registered_workflow_inactive" });
      return;
    }
    const command = getRegisteredWorkflowStartCommand(req.params.id, companyIds);
    if (!command) {
      res.status(404).json({ error: "registered_workflow_not_found" });
      return;
    }
    const runMetadata = {
      ...registeredWorkflowStartMetadata(workflow, { source: "manual", command }),
      ...(fixedWorkflow ? { system_scope: "global", system_admin_actor_user_id: currentActorUserId() } : {})
    };
    if (dbBackend === "postgres" && workflow.id === "daily-ai-research-publish-run") {
      const fastStarted = await startRegisteredPostgresRunFast({ workflow, command, metadata: runMetadata });
      clearRegisteredWorkflowSchedulerBlock(workflow);
      res.status(202).json({
        accepted: true,
        runId: fastStarted.runId,
        status: "queued",
        workflow: publicRegisteredWorkflowById(workflow.id),
        run: {
          runId: fastStarted.runId,
          status: "queued",
          name: command.slice(0, 72) || "Daily AI registered workflow run",
          objective: command
        },
        workerProtocol: "mac_worker_polling_required",
        nextAction: "本番DBに実行を保存しました。Mac worker loopが起動していれば自動で拾います。"
      });
      return;
    }
    if (workflow.runner_kind === "research_plan_registered") {
      if (!workflow.company_id) {
        res.status(404).json({ error: "registered_workflow_not_found" });
        return;
      }
      requireCompanyAccess(workflow.company_id, ["owner", "admin", "operator"]);
      const startCommand = parseJson<{ researchPlanId?: unknown }>(workflow.start_command_json, {});
      const researchPlanId = typeof startCommand.researchPlanId === "string" ? startCommand.researchPlanId : undefined;
      if (!researchPlanId) {
        res.status(409).json({ error: "registered_research_plan_missing_reference" });
        return;
      }
      const plan = getResearchPlan(researchPlanId, [workflow.company_id]);
      if (!plan) {
        res.status(404).json({ error: "research_plan_not_found" });
        return;
      }
      const researchPlanMetadata = {
        ...runMetadata,
        ...researchPlanPreparedRunMetadata(plan),
        execution_routing: buildExecutionRoutingSnapshot({
          command: plan.command,
          source: "manual"
        })
      };
      const started = await withTimeout(
        researchPlanStartRunner(plan.command, { metadata: researchPlanMetadata, deferWorker: true, prepareOnly: true, companyId: workflow.company_id }),
        researchPlanDirectStartTimeoutMs(),
        {
          operation: "research_plan_start",
          exactBlocker: "research_plan_start_timeout"
        }
      );
      if (!started.ok) {
        recordRegisteredWorkflowManualBlock(workflow, started.exactBlocker);
        res.status(202).json({
          ok: false,
          status: "blocked",
          exactBlocker: started.exactBlocker,
          timeoutMs: started.timeoutMs,
          workflow: publicRegisteredWorkflowById(workflow.id),
          startCommand: plan.command,
          plan
        });
        return;
      }
      const body = commitResearchPlanStarted(plan, started.value);
      clearRegisteredWorkflowSchedulerBlock(workflow);
      const runId = extractRunId(body);
      const runStatus = extractRunStatus(body);
      const approvalRequired = runStatus === "waiting_approval";
      if (runId) {
        recordRegisteredWorkflowManualStart(workflow, runId);
        if (!approvalRequired) recordRunAwaitingWorkerLoop(runId, "registered_research_plan_manual_start");
      }
      maybeAutoExportObsidianAfterResponse("registered-research-plan-started");
      const run = publicResearchPlanRunStartSummary(body);
      const workerProtocol = dbBackend === "postgres" ? "mac_worker_polling_required" : "local_worker_loop_required";
      res.status(202).json({
        accepted: true,
        runId: run.runId,
        status: run.status,
        workflow: publicRegisteredWorkflowById(workflow.id),
        run,
        ...(approvalRequired
          ? { nextAction: "承認画面で内容を確認してください。承認後にworker loopが拾える状態になります。" }
          : {
              workerProtocol,
              nextAction: dbBackend === "postgres"
                ? "本番DBに実行を保存しました。Mac worker loopが起動していれば自動で拾います。"
                : "ローカルDBに実行を保存しました。npm run worker:loop を起動すると処理されます。"
            })
      });
      return;
    }
    const run = await startCommandRun(command, { metadata: runMetadata, deferWorker: true });
    recordRegisteredWorkflowManualStart(workflow, run.runId);
    const approvalRequired = extractRunStatus(run as Record<string, unknown>) === "waiting_approval";
    if (!approvalRequired) recordRunAwaitingWorkerLoop(run.runId, "registered_workflow_manual_start");
    maybeAutoExportObsidianAfterResponse("registered-workflow-started");
    const publicRun = publicRunStartSummary(run);
    const workerProtocol = dbBackend === "postgres" ? "mac_worker_polling_required" : "local_worker_loop_required";
    res.status(202).json({
      accepted: true,
      runId: publicRun.runId,
      status: publicRun.status,
      workflow: publicRegisteredWorkflowById(workflow.id),
      run: publicRun,
      ...(approvalRequired
        ? { nextAction: "承認画面で内容を確認してください。承認後にworker loopが拾える状態になります。" }
        : {
            workerProtocol,
            nextAction: dbBackend === "postgres"
              ? "本番DBに実行を保存しました。Mac worker loopが起動していれば自動で拾います。"
              : "ローカルDBに実行を保存しました。npm run worker:loop を起動すると処理されます。"
          })
    });
  } catch (error) {
    if (sendResearchPlanScopeError(res, error)) return;
    next(error);
  }
});

app.get("/api/browser/health", (_req, res) => {
  res.json(getBrowserHealth());
});

app.post("/api/browser/health", (_req, res) => {
  res.json(getBrowserHealth());
});

app.post("/api/bridge/browser-check", async (req, res, next) => {
  try {
    initDb();
    const targetUrl = typeof req.body?.targetUrl === "string" ? req.body.targetUrl : undefined;
    const result = await runLocalBrowserBridgeCheckAsync({ targetUrl });
    storeSystemCheck(result);
    const action = findTrustedBridgeAction("local_browser_check");
    if (action) {
      storeBridgeReceipt(
        createBridgeReceipt({
          action,
          status: result.status,
          target: result.targetUrl,
          summary: result.summary,
          metadata: {
            systemCheckId: result.id,
            driver: result.driver,
            screenshotPath: result.screenshotPath,
            domPath: result.domPath,
            consolePath: result.consolePath,
            consoleErrorCount: result.consoleErrorCount,
            artifactValidationStatus: result.metadata.artifactValidationStatus,
            missingArtifacts: result.metadata.missingArtifacts
          }
        })
      );
    }
    refreshKnowledgeNotes();
    maybeAutoExportObsidian("browser-bridge-check");
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/bridge/browser-use-check", async (req, res, next) => {
  try {
    initDb();
    const { result } = await runBrowserUseBridgeLocalCheck(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/bridge/node-check", async (req, res, next) => {
  try {
    initDb();
    const { result } = await runBrowserUseBridgeLocalCheck(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bridge/actions", (_req, res) => {
  res.json({ actions: listTrustedBridgeActions() });
});

async function runBrowserUseBridgeLocalCheck(
  body: unknown,
  options: { obsidianReason?: string } = {}
): Promise<{ result: BrowserUseLocalCheckResult; receipt?: ReturnType<typeof createBridgeReceipt> }> {
  const request = parseBrowserUseCheckRequest(body);
  const lane = resolveBrowserUseLane(request);
  const fallback = lane || hasExplicitBrowserUseConnectionRequest(request) ? undefined : findLatestSafeBrowserUseCdpFallback();
  const result = await runBrowserUseLocalCheckAsync(buildBrowserUseCheckOptions(request, lane, fallback));
  storeSystemCheck(result);
  recordBrowserUseLaneObservation(lane, result);
  const action = findTrustedBridgeAction("browser_use_local_check");
  const receipt = action
    ? storeBridgeReceipt(
        createBridgeReceipt({
          action,
          status: result.status,
          target: result.targetUrl,
          summary: result.summary,
          metadata: {
            systemCheckId: result.id,
            driver: result.driver,
            session: result.metadata.session,
            screenshotPath: result.screenshotPath,
            statePath: result.statePath,
            logPath: result.logPath,
            connectionStrategy: result.metadata.connectionStrategy,
            profileIsolation: result.metadata.profileIsolation,
            cleanup: result.metadata.cleanup,
            recordingQa: result.metadata.recordingQa,
            laneId: lane?.id,
            runId: lane?.run_id
          }
        })
      )
    : undefined;
  refreshKnowledgeNotes();
  maybeAutoExportObsidian(options.obsidianReason ?? "browser-use-local-check");
  return { result, receipt };
}

const handleBridgeActionRun: RequestHandler = async (req, res, next) => {
  try {
    initDb();
    const bridgeMode = req.path.endsWith("/prepare") ? "prepare" : "run";
    const action = findTrustedBridgeAction(req.params.id);
    if (!action) {
      res.status(404).json({ error: "bridge_action_not_found", id: req.params.id });
      return;
    }
    if (action.status === "approval_required") {
      const receipt = createProtectedBridgeApproval(action);
      refreshKnowledgeNotes();
      maybeAutoExportObsidian("bridge-approval-required");
      res.status(202).json(receipt);
      return;
    }
    if (action.id === "local_browser_check") {
      const targetUrl = typeof req.body?.targetUrl === "string" ? req.body.targetUrl : undefined;
      const result = await runLocalBrowserBridgeCheckAsync({ targetUrl });
      storeSystemCheck(result);
      const receipt = storeBridgeReceipt(
        createBridgeReceipt({
          action,
          status: result.status,
          target: result.targetUrl,
          summary: result.summary,
          metadata: {
            systemCheckId: result.id,
            driver: result.driver,
            screenshotPath: result.screenshotPath,
            domPath: result.domPath,
            consolePath: result.consolePath,
            consoleErrorCount: result.consoleErrorCount,
            artifactValidationStatus: result.metadata.artifactValidationStatus,
            missingArtifacts: result.metadata.missingArtifacts
          }
        })
      );
      refreshKnowledgeNotes();
      maybeAutoExportObsidian("bridge-local-browser-check");
      res.json({ ...receipt, systemCheck: result });
      return;
    }
    if (action.id === "browser_use_local_check") {
      const { result, receipt } = await runBrowserUseBridgeLocalCheck(req.body, { obsidianReason: "bridge-browser-use-local-check" });
      res.json({ ...receipt, systemCheck: result });
      return;
    }
    if (action.id === "codex_inventory") {
      const capabilities = getCodexCapabilities();
      const receipt = storeBridgeReceipt(
        createBridgeReceipt({
          action,
          status: "ok",
          summary: `Codex機能を確認しました: skills=${capabilities.summary.skills}, plugins=${capabilities.summary.plugins}`,
          metadata: { summary: capabilities.summary, roots: capabilities.roots }
        })
      );
      refreshKnowledgeNotes();
      maybeAutoExportObsidian("bridge-codex-inventory");
      res.json({ ...receipt, capabilities });
      return;
    }
    if (action.id === "obsidian_export") {
      const status = runObsidianExportNow("bridge-action");
      const receipt = storeBridgeReceipt(
        createBridgeReceipt({
          action,
          status: status.ok === false ? "blocked" : "ok",
          target: status.outputDir ?? undefined,
          summary: status.ok === false ? "Obsidian更新に失敗しました" : "Obsidianを更新しました",
          metadata: { obsidian: status }
        })
      );
      refreshKnowledgeNotes();
      res.status(status.ok === false ? 500 : 200).json({ ...receipt, obsidian: status });
      return;
    }
    if (action.id === "second_brain_process") {
      const apply = bridgeMode !== "prepare";
      const processor = runSecondBrainProcessor({ apply });
      const blockedReason = processor.results.find((result) => result.file === "." && result.status === "blocked")?.reason;
      const customVaultBlocked = processor.ok === false && blockedReason === customObsidianExportError;
      const processorMetadata = {
        mode: bridgeMode === "prepare" ? "dry_run" : "apply",
        apply: processor.apply,
        ...(customVaultBlocked ? { error: customObsidianExportError, summary: customObsidianExportSummary } : {}),
        scanned: processor.scanned,
        eligible: processor.eligible,
        updated: processor.updated,
        wouldUpdate: processor.wouldUpdate,
        unchanged: processor.unchanged,
        skipped: processor.skipped,
        blocked: processor.blocked,
        statusFile: processor.statusFile ?? null,
        processedAt: processor.processedAt,
        results: processor.results.map((result) => ({
          file: result.file,
          status: result.status,
          reason: result.reason,
          suggestedDestination: result.suggestedDestination,
          backupFile: result.backupFile
        }))
      };
      const receipt = storeBridgeReceipt(
        createBridgeReceipt({
          action,
          status: processor.ok === false ? "blocked" : "ok",
          target: processor.vaultPath,
          summary:
            customVaultBlocked
              ? "Second Brain処理を停止しました: custom vaultには明示許可が必要です"
              : bridgeMode === "prepare"
              ? `Second Brain処理をdry-runしました: wouldUpdate=${processor.wouldUpdate}, unchanged=${processor.unchanged}, skipped=${processor.skipped}, blocked=${processor.blocked}`
              : `Second Brainを処理しました: updated=${processor.updated}, unchanged=${processor.unchanged}, skipped=${processor.skipped}, blocked=${processor.blocked}`,
          metadata: processorMetadata
        })
      );
      refreshKnowledgeNotes();
      if (apply && processor.ok !== false) maybeAutoExportObsidian("bridge-second-brain-process");
      res.status(customVaultBlocked ? 403 : processor.ok === false ? 500 : 200).json({
        ...receipt,
        ...(customVaultBlocked ? { error: customObsidianExportError } : {}),
        secondBrainProcessor: processor
      });
      return;
    }
    const receipt = storeBridgeReceipt(
      createBridgeReceipt({
        action,
        status: "blocked",
        summary: `${action.label} は現在このローカルBridgeでは直接実行できません。`,
        metadata: { bridgeStatus: action.status }
      })
    );
    refreshKnowledgeNotes();
    maybeAutoExportObsidian("bridge-action-blocked");
    res.status(409).json(receipt);
  } catch (error) {
    next(error);
  }
};

app.post("/api/bridge/actions/:id/run", handleBridgeActionRun);
app.post("/api/bridge/actions/:id/prepare", handleBridgeActionRun);

app.post("/api/bridge/actions/:id/execute", (req, res) => {
  initDb();
  const action = findTrustedBridgeAction(req.params.id);
  if (!action) {
    res.status(404).json({ error: "bridge_action_not_found", id: req.params.id });
    return;
  }
  if (action.status !== "approval_required") {
    res.status(400).json({
      error: "bridge_execute_not_required",
      id: action.id,
      summary: `${action.label} は安全操作なので、実行ボタンからそのまま使えます。`
    });
    return;
  }
  const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId : undefined;
  const approval = findBridgeApprovalForAction(action.id, approvalId);
  if (!approval) {
    res.status(403).json({
      error: "bridge_approval_required",
      id: action.id,
      status: "approval_required",
      summary: `${action.label} は課金・購入・支払い・決済の確認が必要です。課金系以外の外部操作は証跡付きで進めます。`
    });
    return;
  }
  if (approval.status !== "approved") {
    res.status(409).json({
      error: "bridge_approval_not_approved",
      id: action.id,
      approvalId: approval.id,
      status: approval.status,
      summary: `${action.label} は課金確認待ちです。課金系以外の外部操作は証跡付きで進めます。`
    });
    return;
  }
  const execution = storeExecutorNotConnectedForApprovedBridgeApproval(approval);
  refreshKnowledgeNotes();
  maybeAutoExportObsidian("bridge-executor-not-connected");
  res.status(409).json({
    error: "bridge_executor_not_connected",
    id: action.id,
    approvalId: approval.id,
    executionId: execution?.id,
    status: "blocked",
    executorStatus: execution?.executorStatus ?? "not_connected",
    summary: execution?.summary ?? `${action.label}は課金確認済みですが、外部実行Bridgeはまだ接続されていません。`
  });
});

app.get("/api/obsidian/status", (_req, res) => {
  res.json(getObsidianExportStatus());
});

app.post("/api/obsidian/ingest", (req, res, next) => {
  try {
    initDb();
    if (hasDisallowedCaptureFileInput(req.body)) {
      res.status(400).json({
        ok: false,
        status: "rejected",
        exactBlocker: "obsidian_ingest_file_write_input_not_allowed",
        summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
      });
      return;
    }
    const result = runObsidianIngest({
      sourceUrl: nonEmptyString(req.body?.sourceUrl),
      sourceTitle: nonEmptyString(req.body?.sourceTitle),
      sourceType: nonEmptyString(req.body?.sourceType),
      text: typeof req.body?.text === "string" ? req.body.text : undefined,
      vaultPath: nonEmptyString(req.body?.vaultPath),
      capturedAt: nonEmptyString(req.body?.capturedAt)
    });
    if (!result.ok) {
      res.status(obsidianIngestErrorStatus(result.error)).json(result);
      return;
    }
    maybeAutoExportObsidian("obsidian-ingested");
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/obsidian/url-capture", async (req, res, next) => {
  try {
    initDb();
    if (hasDisallowedCaptureFileInput(req.body)) {
      res.status(400).json({
        ok: false,
        status: "rejected",
        exactBlocker: "url_capture_file_write_input_not_allowed",
        summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
      });
      return;
    }
    const result = await runUrlCapture({
      url: nonEmptyString(req.body?.url) ?? nonEmptyString(req.body?.sourceUrl),
      sourceTitle: nonEmptyString(req.body?.sourceTitle),
      vaultPath: nonEmptyString(req.body?.vaultPath),
      capturedAt: nonEmptyString(req.body?.capturedAt)
    });
    if (result.status === "rejected") {
      res.status(result.exactBlocker === customObsidianExportError ? 403 : 400).json(result);
      return;
    }
    maybeAutoExportObsidian(result.ok ? "obsidian-url-captured" : "obsidian-url-capture-blocked");
    res.status(result.ok ? 201 : 202).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:id", (req, res) => {
  initDb();
  const detail = getRunDetail(req.params.id, actorCompanyIds());
  if (!detail) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }
  res.json(detail);
});

app.get("/api/proofs/:id/view", (req, res) => {
  initDb();
  const view = getProofView(req.params.id, actorCompanyIds());
  if (view.status === "not_found") {
    res.status(404).json({ status: "not_found", error: "proof_not_found" });
    return;
  }
  res.json(view);
});

app.post("/api/import/codex-assets", async (_req, res, next) => {
  try {
    const body = await importCodexAssets();
    maybeAutoExportObsidian("codex-assets-imported");
    res.json(body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/demo-daily-ai", (_req, res, next) => {
  try {
    const body = seedDailyAiDemo();
    maybeAutoExportObsidian("daily-ai-demo-created");
    res.json(body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/start", async (req, res, next) => {
  try {
    initDb();
    const companyId = requestedCompanyId(req);
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const rawCommand = typeof req.body?.command === "string" ? req.body.command : "";
    const { sanitizedText, stored } = saveSecretsFromMessage(rawCommand, companyId);
    if (isSecretStorageOnlyText(sanitizedText, stored)) {
      res.status(200).json({
        ok: true,
        status: "stored",
        exactBlocker: "secret_stored_run_not_started",
        sanitizedText,
        stored,
        nextAction: "認証情報だけを保存しました。実行する内容を別メッセージで指定してください。"
      });
      return;
    }
    const command = sanitizedText.trim();
    if (!command) {
      res.status(400).json({ error: "command_required" });
      return;
    }
    const body = await startCommandRun(command, { metadata: createSessionRunMetadata(req.body?.createSession), deferWorker: true, companyId });
    const runId = extractRunId(body as Record<string, unknown>);
    const runStatus = extractRunStatus(body as Record<string, unknown>);
    const approvalRequired = runStatus === "waiting_approval";
    if (runId && !approvalRequired) recordRunAwaitingWorkerLoop(runId, "create_run_start");
    maybeAutoExportObsidianAfterResponse("run-started");
    const workerProtocol = dbBackend === "postgres" ? "mac_worker_polling_required" : "local_worker_loop_required";
    res.status(202).json({
      ...(typeof body === "object" && body ? body as Record<string, unknown> : {}),
      ...(approvalRequired
        ? { nextAction: "承認画面で内容を確認してください。承認後にworker loopが拾える状態になります。" }
        : {
            workerProtocol,
            nextAction: dbBackend === "postgres"
              ? "本番DBに実行を保存しました。Mac worker loopが起動していれば自動で拾います。"
              : "ローカルDBに実行を保存しました。npm run worker:loop を起動すると処理されます。"
          })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/planner/research-plan", (req, res, next) => {
  try {
    initDb();
    const companyId = requestedCompanyId(req);
    requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const rawCommand = typeof req.body?.command === "string" ? req.body.command : "";
    const { sanitizedText } = saveSecretsFromMessage(rawCommand, companyId);
    const plan = createResearchPlan({
      companyId,
      command: sanitizedText.trim(),
      title: typeof req.body?.title === "string" ? req.body.title : undefined,
      sources: parseResearchSourceSelection(req.body?.sources),
      visibleFlow: parseVisibleFlowInput(req.body?.visibleFlow)
    });
    maybeAutoExportObsidianAfterResponse("research-plan-created");
    res.status(201).json({ plan });
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("company_") || error.message === "project_id_required")) {
      sendCompanyScopeError(res, error, "research_plan_create_failed");
      return;
    }
    next(error);
  }
});

app.post("/api/planner/:planId/demo", async (req, res, next) => {
  try {
    initDb();
    const plan = getResearchPlan(req.params.planId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!plan || !plan.companyId) {
      res.status(404).json({ error: "research_plan_not_found" });
      return;
    }
    const targetUrl = typeof req.body?.targetUrl === "string" ? req.body.targetUrl : "http://127.0.0.1:5173/#create";
    if (!isLocalResearchDemoTarget(targetUrl)) {
      res.status(400).json({ error: "research_plan_demo_target_must_be_local", externalOperation: false });
      return;
    }
    const boundedDemo = await withTimeout(researchPlanDemoRunner({ targetUrl }), researchPlanDemoTimeoutMs(), {
      operation: "research_plan_demo",
      exactBlocker: "research_plan_demo_timeout"
    });
    if (!boundedDemo.ok) {
      const result = buildTimedOutResearchPlanDemoCheck({ targetUrl, timeoutMs: researchPlanDemoTimeoutMs() });
      storeSystemCheck(result);
      refreshKnowledgeNotes();
      maybeAutoExportObsidian("research-plan-demo-blocked");
      res.status(202).json({
        ok: false,
        status: "blocked",
        exactBlocker: boundedDemo.exactBlocker,
        plan,
        systemCheck: result,
        boundary: "local_browser_use_check_only",
        externalOperation: false
      });
      return;
    }
    const result = boundedDemo.value;
    storeSystemCheck(result);
    if (result.status === "blocked") {
      refreshKnowledgeNotes();
      maybeAutoExportObsidian("research-plan-demo-blocked");
      res.status(202).json({
        ok: false,
        status: "blocked",
        exactBlocker: browserUseDemoBlocker(result),
        plan,
        systemCheck: result,
        boundary: "local_browser_use_check_only",
        externalOperation: false
      });
      return;
    }
    const updatedPlan = markResearchPlanDemoed(plan.id, result.id, result.status);
    refreshKnowledgeNotes();
    maybeAutoExportObsidian("research-plan-demoed");
    res.json({
      plan: updatedPlan,
      systemCheck: result,
      boundary: "local_browser_use_check_only",
      externalOperation: false
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/planner/:planId/start", async (req, res, next) => {
  try {
    initDb();
    const plan = getResearchPlan(req.params.planId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!plan || !plan.companyId) {
      res.status(404).json({ error: "research_plan_not_found" });
      return;
    }
    const started = await withTimeout(
      researchPlanStartRunner(plan.command, {
        metadata: researchPlanPreparedRunMetadata(plan, createSessionRunMetadata(req.body?.createSession)),
        deferWorker: true,
        prepareOnly: true,
        companyId: plan.companyId
      }),
      researchPlanDirectStartTimeoutMs(),
      {
        operation: "research_plan_start",
        exactBlocker: "research_plan_start_timeout"
      }
    );
    if (!started.ok) {
      res.status(202).json({
        ok: false,
        status: "blocked",
        exactBlocker: started.exactBlocker,
        timeoutMs: started.timeoutMs,
        plan
      });
      return;
    }
    const body = commitResearchPlanStarted(plan, started.value);
    const runId = extractRunId(body);
    const runStatus = extractRunStatus(body);
    const approvalRequired = runStatus === "waiting_approval";
    if (runId && !approvalRequired) recordRunAwaitingWorkerLoop(runId, "research_plan_direct_start");
    maybeAutoExportObsidianAfterResponse("research-plan-started");
    const run = publicResearchPlanRunStartSummary(body);
    const workerProtocol = dbBackend === "postgres" ? "mac_worker_polling_required" : "local_worker_loop_required";
    res.status(202).json({
      accepted: true,
      runId: run.runId,
      status: run.status,
      plan: run.plan,
      run,
      ...(approvalRequired
        ? { nextAction: "承認画面で内容を確認してください。承認後にworker loopが拾える状態になります。" }
        : {
            workerProtocol,
            nextAction: dbBackend === "postgres"
              ? "本番DBに実行を保存しました。Mac worker loopが起動していれば自動で拾います。"
              : "ローカルDBに実行を保存しました。npm run worker:loop を起動すると処理されます。"
          })
    });
  } catch (error) {
    if (sendResearchPlanScopeError(res, error)) return;
    next(error);
  }
});

app.post("/api/planner/:planId/regularize", (req, res, next) => {
  try {
    initDb();
    const plan = getResearchPlan(req.params.planId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!plan) {
      res.status(404).json({ error: "research_plan_not_found" });
      return;
    }
    if (!plan.demoCheckId && plan.status !== "demoed") {
      res.status(409).json({ error: "research_plan_demo_required" });
      return;
    }
    const workflow = registerResearchPlanWorkflow(plan, parseScheduleRrule(req.body?.rrule));
    maybeAutoExportObsidianAfterResponse("research-plan-regularized");
    res.status(201).json({ plan, workflow });
  } catch (error) {
    next(error);
  }
});

app.post("/api/planner/:planId/capture/youtube-transcript", async (req, res, next) => {
  try {
    initDb();
    const plan = getResearchPlan(req.params.planId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!plan) {
      res.status(404).json({ error: "research_plan_not_found" });
      return;
    }
    if (plan.status !== "started" || !plan.runId) {
      res.status(409).json({
        error: "research_plan_run_required",
        summary: "YouTube transcript capture can only attach proof after the research plan has started."
      });
      return;
    }
    if (hasDisallowedCaptureFileInput(req.body)) {
      res.status(400).json({
        ok: false,
        status: "rejected",
        exactBlocker: "youtube_transcript_file_write_input_not_allowed",
        summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
      });
      return;
    }
    assertResearchPlanRunCompanyMatch(plan.runId, plan.companyId);
    const runId = plan.runId;
    const captureInput = {
      url: nonEmptyString(req.body?.url) ?? nonEmptyString(req.body?.sourceUrl),
      sourceTitle: nonEmptyString(req.body?.sourceTitle),
      vaultPath: nonEmptyString(req.body?.vaultPath),
      capturedAt: nonEmptyString(req.body?.capturedAt),
      publicCaptionOnly: !process.env.NODE_TEST_CONTEXT
    };
    if (process.env.NODE_TEST_CONTEXT) {
      const body = await runResearchPlanYouTubeTranscriptCapture(plan, captureInput);
      res.status(body.ok ? 201 : body.status === "rejected" ? 400 : 202).json(body);
      return;
    }

    const acceptedAt = nowIso();
    res.status(202).json({
      ok: true,
      status: "accepted",
      runId,
      plan,
      acceptedAt,
      summary: "YouTube transcript capture accepted. Progress and proof are written to the research plan/run in the background."
    });
    const launchTimer = setTimeout(() => {
      launchResearchPlanYouTubeTranscriptCapture(plan.id, captureInput, runId);
    }, 50);
    launchTimer.unref?.();
  } catch (error) {
    if (sendResearchPlanScopeError(res, error)) return;
    next(error);
  }
});

app.post("/api/planner/:planId/capture/web-url", async (req, res, next) => {
  try {
    initDb();
    const plan = getResearchPlan(req.params.planId, actorCompanyIds(["owner", "admin", "operator"]));
    if (!plan) {
      res.status(404).json({ error: "research_plan_not_found" });
      return;
    }
    if (plan.status !== "started" || !plan.runId) {
      res.status(409).json({
        error: "research_plan_run_required",
        summary: "Web URL capture can only attach proof after the research plan has started."
      });
      return;
    }
    if (hasDisallowedCaptureFileInput(req.body)) {
      res.status(400).json({
        ok: false,
        status: "rejected",
        exactBlocker: "web_url_capture_file_write_input_not_allowed",
        summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
      });
      return;
    }
    assertResearchPlanRunCompanyMatch(plan.runId, plan.companyId);
    const result = await runUrlCapture({
      url: nonEmptyString(req.body?.url) ?? nonEmptyString(req.body?.sourceUrl),
      sourceTitle: nonEmptyString(req.body?.sourceTitle),
      vaultPath: nonEmptyString(req.body?.vaultPath),
      capturedAt: nonEmptyString(req.body?.capturedAt)
    });
    if (!result.ok) {
      const updatedPlan = markResearchPlanSourceCapture(plan.id, "web", {
        ok: false,
        status: result.status,
        artifactPath: result.status === "blocked" ? result.manifestFile : undefined,
        exactBlocker: result.exactBlocker,
        summary: result.summary
      }) ?? plan;
      maybeAutoExportObsidianAfterResponse(result.status === "rejected" ? "research-web-url-rejected" : "research-web-url-blocked");
      res.status(result.status === "rejected" ? 400 : 202).json({ ok: false, status: result.status, plan: updatedPlan, capture: result });
      return;
    }
    const committed = commitResearchPlanCaptureAtomic({
      plan,
      sourceKey: "web",
      uri: result.ingest.path,
      label: "Web readable source snapshot",
      sizeBytes: result.bytes,
      proofMetadata: researchPlanCaptureProofMetadata("web", result),
      artifactPath: result.ingest.path,
      summary: result.sourceTitle
    });
    const { proof, plan: updatedPlan } = committed;
    maybeAutoExportObsidianAfterResponse("research-web-url-captured");
    res.status(201).json({
      ok: true,
      status: "captured",
      runId: plan.runId,
      plan: updatedPlan,
      proof,
      capture: result,
      run: querySql(`SELECT * FROM runs WHERE id=${sqlValue(plan.runId)} LIMIT 1`)[0]
    });
  } catch (error) {
    if (sendResearchPlanScopeError(res, error)) return;
    next(error);
  }
});

function readSmallJsonBody(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
      res.status(413).json({ error: "request_body_too_large" });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (res.headersSent) return;
    if (!body.trim()) {
      req.body = {};
      next();
      return;
    }
    try {
      req.body = JSON.parse(body);
      next();
    } catch {
      res.status(400).json({ error: "invalid_json_body" });
    }
  });
  req.on("error", next);
}

type FeedbackScreenshot = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  content: Buffer;
  contentBase64: string;
  checksumSha256: string;
  sizeBytes: number;
};

function parseFeedbackScreenshotDataUrl(value: string): FeedbackScreenshot | null {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) {
    if (/^data:image\//iu.test(value)) throw new Error("feedback_screenshot_mime_not_allowed");
    throw new Error("feedback_screenshot_invalid");
  }
  const mimeType = match[1].toLowerCase() as FeedbackScreenshot["mimeType"];
  const contentBase64 = match[2];
  if (contentBase64.length % 4 !== 0) throw new Error("feedback_screenshot_invalid");
  const content = Buffer.from(contentBase64, "base64");
  if (content.length === 0 || content.toString("base64") !== contentBase64) throw new Error("feedback_screenshot_invalid");
  if (content.length > 700 * 1024) throw new Error("feedback_screenshot_too_large");
  if (!feedbackScreenshotMagicMatches(mimeType, content)) throw new Error("feedback_screenshot_invalid");
  return {
    mimeType,
    content,
    contentBase64,
    checksumSha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.length
  };
}

function feedbackScreenshotMagicMatches(mimeType: FeedbackScreenshot["mimeType"], content: Buffer): boolean {
  if (mimeType === "image/jpeg") return content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mimeType === "image/png") return content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return content.length >= 12 && content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP";
}

function readFeedbackArtifact(companyId: string, artifactId: string): { id: string; mimeType: string; checksumSha256: string; content: Buffer } | null {
  if (!companyId || !artifactId) throw new Error("feedback_artifact_id_invalid");
  const row = querySql<{ id: string; mime_type: string; checksum_sha256: string; size_bytes: number; content_base64: string }>(`
    SELECT id, mime_type, checksum_sha256, size_bytes, content_base64
    FROM feedback_artifacts
    WHERE company_id=${sqlValue(companyId)} AND id=${sqlValue(artifactId)} AND status='available'
    LIMIT 1
  `)[0];
  if (!row) return null;
  const content = Buffer.from(row.content_base64, "base64");
  const checksum = createHash("sha256").update(content).digest("hex");
  if (content.length !== Number(row.size_bytes) || checksum !== row.checksum_sha256 || content.toString("base64") !== row.content_base64) {
    throw new Error("feedback_artifact_integrity_mismatch");
  }
  return { id: row.id, mimeType: row.mime_type, checksumSha256: row.checksum_sha256, content };
}

async function runResearchPlanYouTubeTranscriptCapture(
  plan: ResearchPlanSnapshot,
  input: {
    url?: string;
    sourceTitle?: string;
    vaultPath?: string;
    capturedAt?: string;
  }
): Promise<
  | {
      ok: true;
      status: "captured";
      runId: string;
      plan: ResearchPlanSnapshot;
      proof: ReturnType<typeof storeResearchPlanVisibleSourceProof>;
      capture: Extract<YouTubeTranscriptCaptureResult, { ok: true }>;
      run: unknown;
    }
  | {
      ok: false;
      status: "blocked" | "rejected";
      plan: ResearchPlanSnapshot;
      capture: Extract<YouTubeTranscriptCaptureResult, { ok: false }>;
    }
> {
  if (!plan.runId) throw new Error("research_plan_run_required");
  assertResearchPlanRunCompanyMatch(plan.runId, plan.companyId);
  const result = await youtubeTranscriptCaptureRunner(input);
  if (!result.ok) {
    const updatedPlan = markResearchPlanSourceCapture(plan.id, "youtube", {
      ok: false,
      status: result.status,
      artifactPath: "artifactDir" in result ? result.artifactDir : undefined,
      exactBlocker: result.exactBlocker,
      summary: result.summary
    }) ?? plan;
    annotateYouTubeCaptureFailure(plan.runId, result, plan.companyId);
    maybeAutoExportObsidianAfterResponse(result.status === "rejected" ? "research-youtube-transcript-rejected" : "research-youtube-transcript-blocked");
    return { ok: false, status: result.status, plan: updatedPlan, capture: result };
  }
  const committed = commitResearchPlanCaptureAtomic({
    plan,
    sourceKey: "youtube",
    uri: result.files.manifest,
    label: "YouTube transcript visible source snapshot",
    sizeBytes: result.transcriptBytes,
    proofMetadata: researchPlanCaptureProofMetadata("youtube", result),
    artifactPath: result.files.manifest,
    summary: result.sourceTitle
  });
  const { proof, plan: updatedPlan } = committed;
  maybeAutoExportObsidianAfterResponse("research-youtube-transcript-captured");
  return {
    ok: true,
    status: "captured",
    runId: plan.runId,
    plan: updatedPlan,
    proof,
    capture: result,
    run: querySql(`SELECT * FROM runs WHERE id=${sqlValue(plan.runId)} LIMIT 1`)[0]
  };
}

function launchResearchPlanYouTubeTranscriptCapture(
  planId: string,
  input: {
    url?: string;
    sourceTitle?: string;
    vaultPath?: string;
    capturedAt?: string;
  },
  runId: string
) {
  const workerPath = resolveResearchPlanYouTubeTranscriptCaptureEntrypoint();
  const logDir = join(process.cwd(), "logs");
  mkdirSync(logDir, { recursive: true });
  const launchedAt = nowIso();
  const stdoutLog = join(logDir, `youtube-transcript-capture-${runId}.out.log`);
  const stderrLog = join(logDir, `youtube-transcript-capture-${runId}.err.log`);
  const out = openSync(stdoutLog, "a");
  const err = openSync(stderrLog, "a");
  const inputJsonB64 = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  const child = spawn(process.execPath, [workerPath, `--plan-id=${planId}`, `--input-json-b64=${inputJsonB64}`], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env
  });
  child.once("error", (error) => {
    const result: Extract<YouTubeTranscriptCaptureResult, { ok: false }> = {
      ok: false,
      status: "blocked",
      captureId: makeId("youtube_transcript_launch"),
      requestedUrl: input.url,
      exactBlocker: "youtube_transcript_worker_launch_failed",
      summary: redactSensitiveText(error.message)
    };
    const plan = getResearchPlan(planId);
    markResearchPlanSourceCapture(planId, "youtube", {
      ok: false,
      status: result.status,
      exactBlocker: result.exactBlocker,
      summary: result.summary
    });
    annotateYouTubeCaptureFailure(runId, result, plan?.companyId);
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  return {
    mode: "detached_node_worker",
    pid: child.pid ?? null,
    workerPath,
    stdoutLog,
    stderrLog,
    launchedAt
  };
}

function resolveResearchPlanYouTubeTranscriptCaptureEntrypoint(): string {
  const distPath = join(process.cwd(), "apps", "server", "dist", "cli", "researchPlanYoutubeTranscriptCapture.js");
  if (existsSync(distPath)) return distPath;
  const siblingPath = fileURLToPath(new URL("./cli/researchPlanYoutubeTranscriptCapture.js", import.meta.url));
  if (existsSync(siblingPath)) return siblingPath;
  throw new Error("research_plan_youtube_transcript_capture_entrypoint_missing");
}

app.get("/api/secrets/summary", (req, res) => {
  try {
    initDb();
    const companyId = requestedCompanyId(req);
    const company = requireCompanyAccess(companyId);
    res.json({ secrets: listStoredSecrets(company.id), company_scope: { enforced: true, company_id: company.id } });
  } catch (error) {
    sendCompanyScopeError(res, error, "secret_summary_read_failed");
  }
});

app.post("/api/secrets/from-message", (req, res) => {
  try {
    initDb();
    const companyId = requestedCompanyId(req);
    const company = requireCompanyAccess(companyId, ["owner", "admin", "operator"]);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const result = saveSecretsFromMessage(text, company.id);
    if (result.stored.length > 0) {
      refreshKnowledgeNotes();
      maybeAutoExportObsidianAfterResponse("secrets-updated");
    }
    res.json({ ...result, company_scope: { enforced: true, company_id: company.id } });
  } catch (error) {
    sendCompanyScopeError(res, error, "secret_write_failed");
  }
});

app.post("/api/knowledge/refresh", (_req, res, next) => {
  try {
    initDb();
    const result = refreshKnowledgeNotes();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/approvals/:id/approve", async (req, res, next) => {
  try {
    const result = await decideStoredApproval(req.params.id, "approved", actorCompanyIds(["owner", "admin", "approver"]));
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/approvals/:id/reject", async (req, res, next) => {
  try {
    const result = await decideStoredApproval(req.params.id, "rejected", actorCompanyIds(["owner", "admin", "approver"]));
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/approvals/:id/cancel", async (req, res, next) => {
  try {
    const result = await decideStoredApproval(req.params.id, "cancelled", actorCompanyIds(["owner", "admin", "approver"]));
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/obsidian/export", (req, res, next) => {
  try {
    initDb();
    const vaultPath = typeof req.body?.vaultPath === "string" ? req.body.vaultPath : undefined;
    const outputSubdir = typeof req.body?.outputSubdir === "string" ? req.body.outputSubdir : undefined;
    const docsDir = typeof req.body?.docsDir === "string" ? req.body.docsDir : undefined;
    const vaultGuard = guardObsidianVaultPath(vaultPath);
    const customExportRequested = !vaultGuard.ok || vaultGuard.customVaultRequested || outputSubdir !== undefined || docsDir !== undefined;
    if (customExportRequested && process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT !== "1") {
      res.status(403).json({ error: vaultGuard.ok ? customObsidianExportError : vaultGuard.error });
      return;
    }
    refreshKnowledgeNotes();
    const status = runObsidianExportNow("manual", { vaultPath, outputSubdir, docsDir });
    res.status(status.ok === false ? 500 : 200).json(status);
  } catch (error) {
    next(error);
  }
});

app.post("/api/advisor/research-ingest", (_req, res) => {
  const seeds = seedResearchKnowledge();
  for (const seed of seeds) {
    insert("advisor_events", {
      id: seed.id,
      topic: seed.topic,
      source: seed.source,
      summary: seed.summary,
      recommendation: seed.recommendation,
      trigger_context: seed.triggerContext,
      confidence: seed.confidence,
      created_at: seed.createdAt,
      metadata_json: seed.metadata
    });
  }
  maybeAutoExportObsidian("research-ingested");
  res.json({ ingested: seeds.length, events: seeds });
});

app.post("/api/skills/from-run/:runId", (req, res) => {
  const run = findScopedRun(req.params.runId, actorCompanyIds(["owner", "admin", "operator"]));
  if (!run) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }
  const steps = querySql<{ name: string; status: string }>(`SELECT name, status FROM run_steps WHERE run_id=${sqlValue(run.id)}`);
  const proofs = querySql<{ proofType: string; label: string }>(
    `SELECT proof_type as proofType, label FROM proofs
     WHERE run_id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)}`
  );
  const draft = createSkillDraft({ runId: run.id, runName: run.name, steps, proofs });
  insert("skills", {
    id: draft.id,
    company_id: run.company_id,
    run_id: draft.runId,
    name: draft.name,
    draft_markdown: draft.markdown,
    created_at: draft.createdAt
  });
  maybeAutoExportObsidian("skill-draft-created");
  res.json(draft);
});

export const apiNotFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "api_not_found" });
};

export const apiErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  // Route handlers own the safe, typed 4xx contracts. Anything reaching this
  // boundary is unclassified server failure; never reflect its message,
  // cause, path, provider response, or credential-like text to the client.
  void error;
  res.status(500).json({ error: "internal_error", exactBlocker: "internal_error" });
};

function productionWriteGuard(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) {
  const normalizedPath = normalizedRequestPath(req.path);
  if (!isStateChangingMethod(req.method) || (normalizedPath !== "/api" && !normalizedPath.startsWith("/api/"))) {
    next();
    return;
  }
  if (isReadOnlyPlanningEndpoint(req) || isCreateSessionEndpoint(req) || isCreatePlannerWorkflowEndpoint(req)) {
    next();
    return;
  }
  const guard = getProductionWriteGuardStatus();
  if (!guard.required) {
    next();
    return;
  }
  const providedToken = readRequestWriteToken(req);
  if (guard.tokenConfigured && secureTokenEqual(providedToken, readProductionWriteToken())) {
    next();
    return;
  }
  const error = "production_token_required";
  res.status(401).json({
    ok: false,
    status: "blocked",
    error,
    exactBlocker: error
  });
}

function productionApiAccessGuard(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) {
  const normalizedPath = normalizedRequestPath(req.path);
  const apiPath = normalizedPath === "/api" || normalizedPath.startsWith("/api/");
  if (!apiPath || normalizedPath === "/api/health") {
    next();
    return;
  }
  const guard = getProductionApiAccessGuardStatus();
  if (!guard.required) {
    next();
    return;
  }
  const providedToken = readRequestWriteToken(req);
  const readOnlyRequest = ["GET", "HEAD"].includes(req.method);
  const readToken = readOnlyRequest ? readProductionReadToken() : "";
  if (guard.tokenConfigured && (
    secureTokenEqual(providedToken, readProductionWriteToken())
    || (Boolean(readToken) && secureTokenEqual(providedToken, readToken))
  )) {
    next();
    return;
  }
  const error = "production_token_required";
  res.status(401).json({
    ok: false,
    status: "blocked",
    error,
    exactBlocker: error
  });
}

function ownerDiagnosticsGuard(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) {
  const normalizedPath = normalizedRequestPath(req.path);
  const ownerOnly = normalizedPath === "/api/dashboard"
    || ["/api/codex/", "/api/capability-router/", "/api/browser/", "/api/bridge/", "/api/obsidian/", "/api/secrets/"].some((prefix) => normalizedPath.startsWith(prefix));
  if (!ownerOnly) {
    next();
    return;
  }
  try {
    initDb();
    const companies = listActorCompanies();
    const testBootstrapWithoutMembership = process.env.NODE_TEST_CONTEXT === "1" && companies.length === 0;
    if (!testBootstrapWithoutMembership && !companies.some((company) => company.role === "owner")) throw new Error("owner_admin_required");
    next();
  } catch {
    res.status(403).json({ ok: false, error: "owner_admin_required", exactBlocker: "owner_admin_required" });
  }
}

function normalizedRequestPath(path: string) {
  try {
    return decodeURIComponent(path).toLowerCase().replace(/\/{2,}/g, "/");
  } catch {
    return path.toLowerCase();
  }
}

function isStateChangingMethod(method: string) {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function isReadOnlyPlanningEndpoint(req: Parameters<RequestHandler>[0]) {
  return (
    (req.method === "POST" && (
      req.path === "/api/create/plan"
      || req.path === "/api/create/chat"
      || req.path === "/api/capability-router/plan"
      || req.path === "/api/mvp/feedback"
      || /^\/api\/mvp\/registered-automations\/[^/]+\/run$/u.test(req.path)
    ))
    || (req.method === "PATCH" && (
      /^\/api\/mvp\/feedback\/[^/]+$/u.test(req.path)
    ))
  );
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requestedCompanyId(req: Parameters<RequestHandler>[0], required = true): string {
  const hasBodyCompanyScope = Boolean(req.body && typeof req.body === "object" && (
    Object.prototype.hasOwnProperty.call(req.body, "company_id") || Object.prototype.hasOwnProperty.call(req.body, "project_id")
  ));
  const bodyCompanyId = typeof req.body?.company_id === "string" ? req.body.company_id.trim() : "";
  const bodyProjectId = typeof req.body?.project_id === "string" ? req.body.project_id.trim() : "";
  if (hasBodyCompanyScope && !bodyCompanyId && !bodyProjectId) throw new Error("project_id_required");
  if (bodyCompanyId && bodyProjectId && bodyCompanyId !== bodyProjectId) throw new Error("company_project_scope_mismatch");
  const queryCompanyId = typeof req.query?.company_id === "string" ? req.query.company_id.trim() : "";
  const queryProjectId = typeof req.query?.project_id === "string" ? req.query.project_id.trim() : "";
  const headerCompanyId = req.header("x-automation-os-company-id")?.trim() ?? "";
  const values = [bodyCompanyId || bodyProjectId, queryCompanyId || queryProjectId, headerCompanyId].filter(Boolean);
  if (new Set(values).size > 1) throw new Error("company_project_scope_mismatch");
  const companyId = values[0] ?? "";
  if (!companyId && required) throw new Error("project_id_required");
  return companyId;
}

function automationApiView(automation: AutomationRecord) {
  const execution = automationExecutionContract(automation.workerCommandKind);
  return {
    id: automation.id,
    company_id: automation.companyId,
    project_id: automation.companyId,
    revision: automation.revision,
    current_version_id: automation.currentVersionId,
    automation_type: automation.automationType,
    name: automation.name,
    description: automation.description,
    desc: automation.description,
    goal: automation.goal,
    schedule: "manual",
    cadence: "manual",
    lane: automation.lane,
    risk_level: automation.riskLevel,
    approval_policy: automation.approvalPolicy,
    worker_command_kind: automation.workerCommandKind,
    ...execution,
    create_approval: automation.createApproval,
    builder_spec: automation.builderSpec,
    status: automation.status,
    archived_at: automation.archivedAt,
    created_at: automation.createdAt,
    updated_at: automation.updatedAt,
    deep_link: `#/projects/${encodeURIComponent(automation.companyId)}/automations/${encodeURIComponent(automation.id)}/edit`
  };
}

function automationExecutionContract(workerCommandKind: unknown): {
  execution_mode: "control_plane_dry_run" | "registered_workflow_readback" | "unverified";
  execution_label: string;
  scheduler_effect: "queues_scheduled_dry_run" | "requires_registered_runner_readback" | "not_configured";
  external_action_allowed: false;
} {
  const kind = typeof workerCommandKind === "string" ? workerCommandKind.trim().toLowerCase() : "";
  if (kind === "safe_local_demo") {
    return {
      execution_mode: "control_plane_dry_run",
      execution_label: "制御面の予約・dry-runのみ（外部処理なし）",
      scheduler_effect: "queues_scheduled_dry_run",
      external_action_allowed: false
    };
  }
  if (kind.includes("registered")) {
    return {
      execution_mode: "registered_workflow_readback",
      execution_label: "登録workflow契約（実行readback待ち）",
      scheduler_effect: "requires_registered_runner_readback",
      external_action_allowed: false
    };
  }
  return {
    execution_mode: "unverified",
    execution_label: "実行契約未確認（保存のみ）",
    scheduler_effect: "not_configured",
    external_action_allowed: false
  };
}

function durableJobApiView(job: {
  id: string;
  companyId: string;
  runId: string;
  automationId: string;
  automationVersionId: string;
  scheduleOccurrenceId: string | null;
  kind: string;
  status: string;
  payloadHash: string;
  priority: number;
  maxAttempts: number;
  attemptCount: number;
  availableAt: string;
  concurrencyKey: string;
  maxConcurrency: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  heartbeatAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: job.id,
    company_id: job.companyId,
    run_id: job.runId,
    automation_id: job.automationId,
    automation_version_id: job.automationVersionId,
    schedule_occurrence_id: job.scheduleOccurrenceId,
    kind: job.kind,
    status: job.status,
    payload_hash: job.payloadHash,
    priority: job.priority,
    max_attempts: job.maxAttempts,
    attempt_count: job.attemptCount,
    available_at: job.availableAt,
    concurrency_key: job.concurrencyKey,
    max_concurrency: job.maxConcurrency,
    lease_active: job.status === "leased" && Boolean(job.leaseExpiresAt),
    heartbeat_at: job.heartbeatAt,
    last_error: job.lastError,
    created_at: job.createdAt,
    updated_at: job.updatedAt
  };
}

function durableAttemptApiView(attempt: {
  id: string;
  jobId: string;
  attemptNo: number;
  status: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  errorCode: string | null;
}) {
  return {
    id: attempt.id,
    job_id: attempt.jobId,
    attempt_no: attempt.attemptNo,
    status: attempt.status,
    started_at: attempt.startedAt,
    heartbeat_at: attempt.heartbeatAt,
    finished_at: attempt.finishedAt,
    error: attempt.errorCode
  };
}

function boundApprovalApiView(approval: {
  id: string;
  companyId: string;
  runId: string;
  jobId: string;
  stepId: string | null;
  title: string;
  requestedBy: string;
  status: string;
  priority: string;
  actionKind: string;
  targetAccountRefId: string | null;
  payloadHash: string;
  policyVersion: string;
  expiresAt: string;
  decidedByUserId: string | null;
  decisionRevision: number;
  consumedAt: string | null;
  consumedByAttemptId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}) {
  return {
    id: approval.id,
    company_id: approval.companyId,
    run_id: approval.runId,
    job_id: approval.jobId,
    step_id: approval.stepId,
    title: approval.title,
    requested_by: approval.requestedBy,
    status: approval.status,
    priority: approval.priority,
    action_kind: approval.actionKind,
    target_account_ref_id: approval.targetAccountRefId,
    payload_hash: approval.payloadHash,
    policy_version: approval.policyVersion,
    expires_at: approval.expiresAt,
    decided_by_user_id: approval.decidedByUserId,
    decision_revision: approval.decisionRevision,
    consumed_at: approval.consumedAt,
    consumed_by_attempt_id: approval.consumedByAttemptId,
    created_at: approval.createdAt,
    decided_at: approval.decidedAt,
    decision_note: approval.decisionNote
  };
}

function legacyAutomationDefinition(body: any) {
  return {
    automation_type: body?.automation_type ?? "sns-post",
    name: body?.name ?? "SNS投稿",
    description: body?.description ?? body?.desc ?? "",
    goal: body?.goal ?? "",
    lane: body?.lane ?? "local",
    risk_level: body?.risk_level ?? "high",
    approval_policy: body?.approval_policy ?? "required_before_external_action",
    worker_command_kind: body?.worker_command_kind ?? "safe_local_demo",
    create_approval: body?.create_approval ?? true,
    builder_spec: body?.builder_spec ?? {}
  };
}

function legacyAutomationPatch(body: any) {
  const patch: Record<string, unknown> = {};
  const fields = ["automation_type", "name", "goal", "lane", "risk_level", "approval_policy", "worker_command_kind", "create_approval", "builder_spec", "expected_revision"];
  for (const field of fields) {
    if (body && Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
  }
  if (body && (Object.prototype.hasOwnProperty.call(body, "description") || Object.prototype.hasOwnProperty.call(body, "desc"))) {
    patch.description = body.description ?? body.desc;
  }
  return patch;
}

function automationReceipt(action: string, automation: AutomationRecord) {
  return {
    action,
    company_id: automation.companyId,
    automation_id: automation.id,
    automation_version_id: automation.currentVersionId,
    revision: automation.revision,
    deep_link: `#/projects/${encodeURIComponent(automation.companyId)}/automations/${encodeURIComponent(automation.id)}/edit`
  };
}

function durableJobReceipt(action: string, job: {
  id: string;
  companyId: string;
  runId: string;
  automationId: string;
  automationVersionId: string;
  status: string;
}) {
  return {
    action,
    company_id: job.companyId,
    job_id: job.id,
    run_id: job.runId,
    automation_id: job.automationId,
    automation_version_id: job.automationVersionId,
    status: job.status
  };
}

function expectedRevisionFrom(req: Parameters<RequestHandler>[0]): number {
  const value = req.header("if-match") ?? req.body?.expected_revision ?? req.query?.expected_revision;
  const revision = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new AutomationContractError("automation_expected_revision_required");
  return Number(revision);
}

function connectionExpectedRevisionFrom(req: Parameters<RequestHandler>[0]): number {
  const value = req.header("if-match") ?? req.body?.expected_revision ?? req.query?.expected_revision;
  const revision = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new AutomationContractError("company_connection_ref_expected_revision_required");
  return Number(revision);
}

function requiredBodyString(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new AutomationContractError(code);
  return normalized;
}

function sendAutomationApiError(res: Parameters<RequestHandler>[1], error: unknown, fallback: string): void {
  const code = error instanceof AutomationContractError
    || error instanceof AutomationRepositoryError
    || error instanceof IdempotencyError
    ? error.code
    : error instanceof Error ? error.message : fallback;
  const status = code === "company_scope_forbidden"
    ? 404
    : code.endsWith("_not_found") || code === "automation_not_found"
      ? 404
      : code.includes("conflict") || code.includes("pending") || code.includes("incomplete") || code === "automation_archived"
        ? 409
        : code.includes("required") || code.includes("invalid") || code.includes("unknown_field") || code.includes("forbidden")
          ? 400
          : 500;
  res.status(status).json({ ok: false, error: code, exactBlocker: code });
}

function sendDurableQueueError(res: Parameters<RequestHandler>[1], error: unknown, fallback: string): void {
  const code = error instanceof DurableQueueError ? error.code : error instanceof Error ? error.message : fallback;
  const status = code === "artifact_mime_not_viewable"
    ? 415
    : code === "durable_job_not_found" || code === "artifact_not_found" || code === "artifact_integrity_mismatch"
    ? 404
    : code.endsWith("_required") || code.endsWith("_invalid")
      ? 400
      : code.includes("conflict")
        || code.includes("terminal")
        || code.includes("expired")
        || code.includes("fence")
        || code.includes("retryable")
        || code.includes("attempt_not_found")
        || code.includes("kind_not_dry_run")
        ? 409
        : 500;
  res.status(status).json({ ok: false, error: code, exactBlocker: code });
}

function sendBoundApprovalError(res: Parameters<RequestHandler>[1], error: unknown, fallback: string): void {
  const code = error instanceof BoundApprovalError ? error.code : error instanceof Error ? error.message : fallback;
  if (code === "company_scope_forbidden") {
    res.status(404).json({ ok: false, error: "approval_not_found", exactBlocker: "approval_not_found" });
    return;
  }
  const status = code === "company_scope_forbidden" || code.endsWith("_not_found")
    ? 404
    : code.includes("conflict") || code.includes("pending") || code.includes("expired") || code.includes("consumable") || code.includes("binding_mismatch")
      ? 409
      : code.includes("required") || code.includes("invalid") || code.includes("future")
        ? 400
        : 500;
  res.status(status).json({ ok: false, error: code, exactBlocker: code });
}

function resolveCompanyScope(req: Parameters<RequestHandler>[0], requireSelected: boolean): { companyIds: string[]; roles: Record<string, CompanyRole> } {
  const companies = listActorCompanies();
  const requested = requestedCompanyId(req, requireSelected);
  const selected = requested ? requireCompanyAccess(requested) : null;
  const scoped = selected ? [selected] : companies;
  return {
    companyIds: scoped.map((company) => company.id),
    roles: Object.fromEntries(scoped.map((company) => [company.id, company.role]))
  };
}

function actorCompanyIds(allowedRoles?: readonly CompanyRole[]): string[] {
  return listActorCompanies()
    .filter((company) => !allowedRoles || allowedRoles.includes(company.role))
    .map((company) => company.id);
}

function sendCompanyScopeError(
  res: Parameters<RequestHandler>[1],
  error: unknown,
  fallback: string
): void {
  const message = error instanceof Error ? error.message : fallback;
  const status = message === "company_scope_forbidden"
    ? 403
    : message === "company_slug_conflict" || message === "automation_company_mismatch" || message === "company_project_scope_mismatch" || message === "idempotency_key_payload_conflict" || message === "idempotency_request_pending" || message === "idempotency_request_incomplete"
      ? 409
      : message === "company_not_found" || message === "automation_not_found"
        ? 404
        : message === "project_id_required" || message.startsWith("company_") || message.startsWith("idempotency_")
          ? 400
          : 500;
  res.status(status).json({ ok: false, error: message, exactBlocker: message });
}

function sendTenantResourceError(
  res: Parameters<RequestHandler>[1],
  error: unknown,
  notFoundError: string,
  fallback: string
): void {
  if (error instanceof Error && error.message === "company_scope_forbidden") {
    res.status(404).json({ ok: false, error: notFoundError, exactBlocker: notFoundError });
    return;
  }
  sendCompanyScopeError(res, error, fallback);
}

function sendChatSessionError(
  res: Parameters<RequestHandler>[1],
  error: unknown,
  fallback: string
): void {
  const message = error instanceof Error ? error.message : "";
  if (/chat_sessions/i.test(message) && /(unique|duplicate|constraint)/i.test(message)) {
    res.status(409).json({ ok: false, error: "chat_session_name_conflict", exactBlocker: "chat_session_name_conflict" });
    return;
  }
  sendTenantResourceError(res, error, "chat_session_not_found", fallback);
}

function sendResearchPlanScopeError(res: Parameters<RequestHandler>[1], error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "research_plan_run_company_mismatch"
    || message === "research_plan_run_not_found"
    || message === "research_plan_run_company_required"
  ) {
    res.status(404).json({ error: "research_plan_not_found" });
    return true;
  }
  return false;
}

function isCreateSessionEndpoint(req: Parameters<RequestHandler>[0]) {
  return req.path === "/api/create/session" && (req.method === "PATCH" || req.method === "POST");
}

function isCreatePlannerWorkflowEndpoint(req: Parameters<RequestHandler>[0]) {
  if (req.method !== "POST") return false;
  return req.path === "/api/create/plan/jobs"
    || req.path === "/api/create/chat"
    || req.path === "/api/planner/research-plan"
    || /^\/api\/planner\/[^/]+\/(?:demo|start|regularize)$/u.test(req.path);
}

function readRequestWriteToken(req: Parameters<RequestHandler>[0]) {
  const header = req.header("x-automation-os-token") || req.header("authorization");
  if (!header) return "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

function readProductionWriteToken(env = process.env) {
  return typeof env.AUTOMATION_OS_WRITE_TOKEN === "string" ? env.AUTOMATION_OS_WRITE_TOKEN.trim() : "";
}

function readProductionReadToken(env = process.env) {
  for (const name of ["AUTOMATION_OS_READ_TOKEN", "AUTOMATION_OS_QA_READ_TOKEN", "AUTOMATION_OS_REPLAY_READ_TOKEN"]) {
    const token = env[name];
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return "";
}

function getProductionWriteGuardStatus() {
  const explicit = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const required = explicit === "1" || (explicit !== "0" && Boolean(process.env.PORT) && !process.env.NODE_TEST_CONTEXT);
  return {
    required,
    tokenConfigured: Boolean(readProductionWriteToken()),
    mode: required ? (readProductionWriteToken() ? "token_required" : "locked") : "off"
  };
}

function getProductionApiAccessGuardStatus() {
  const explicit = process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  const required = explicit === "1" || (explicit !== "0" && !process.env.NODE_TEST_CONTEXT);
  const writeTokenConfigured = Boolean(readProductionWriteToken());
  const readTokenConfigured = Boolean(readProductionReadToken());
  return {
    required,
    tokenConfigured: writeTokenConfigured || readTokenConfigured,
    readTokenConfigured,
    mode: required ? (writeTokenConfigured || readTokenConfigured ? "read_or_write_token_required" : "locked") : "off"
  };
}

if (existsSync(webIndexPath)) {
  app.use(express.static(webDistDir));
  app.get("*", (req, res, next) => {
    const normalizedPath = req.path.toLowerCase();
    if (normalizedPath === "/api" || normalizedPath.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(webIndexPath);
  });
}

app.use((req, res, next) => {
  const normalizedPath = req.path.toLowerCase();
  if (normalizedPath === "/api" || normalizedPath.startsWith("/api/")) {
    apiNotFoundHandler(req, res, next);
    return;
  }
  next();
});
app.use(apiErrorHandler);

export function startServer() {
  const server = app.listen(port, host, () => {
    const backgroundStartupDisabled =
      process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS === "0" &&
      process.env.AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS === "0";
    if (!process.env.NODE_TEST_CONTEXT && !backgroundStartupDisabled) {
      const backgroundStartup = setTimeout(() => {
        runObsidianAutoExportBestEffort("startup-recovery");
        startPeriodicObsidianExport();
        startObsidianAutonomyLoops();
        startResearchPlanScheduler();
      }, 100);
      backgroundStartup.unref?.();
    }
    console.log(`Automation OS server listening on http://${host}:${port}`);
  });
  server.on("close", () => {
    stopPeriodicObsidianExport();
    stopObsidianAutonomyLoops();
    stopResearchPlanScheduler();
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}

let packageVersionCache: string | null = null;

function getPackageVersion() {
  if (packageVersionCache !== null) return packageVersionCache;
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    packageVersionCache = typeof packageJson.version === "string" ? packageJson.version : "";
  } catch {
    packageVersionCache = "";
  }
  return packageVersionCache;
}

function getGitCommitFromEnv() {
  const candidates = [
    process.env.AUTOMATION_OS_DEPLOY_COMMIT,
    process.env.ZEABUR_GIT_COMMIT,
    process.env.ZEABUR_GIT_COMMIT_SHA,
    process.env.GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_COMMIT
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function getGitCommitFromWorktree() {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 1000
    });
    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

function getServedAssetNames() {
  try {
    const html = readFileSync(webIndexPath, "utf8");
    const js = html.match(/src="([^"]+index-[^"]+\.js)"/u)?.[1] ?? "";
    const css = html.match(/href="([^"]+index-[^"]+\.css)"/u)?.[1] ?? "";
    return {
      webDistDir,
      indexFound: true,
      js: js ? js.split("/").pop() ?? js : "",
      css: css ? css.split("/").pop() ?? css : ""
    };
  } catch {
    return {
      webDistDir,
      indexFound: false,
      js: "",
      css: ""
    };
  }
}

function getDeploymentReadback() {
  const envCommit = getGitCommitFromEnv();
  const gitCommit = envCommit || getGitCommitFromWorktree();
  const plannerProvider = process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER ?? "auto";
  const openAiKeyConfigured = Boolean(process.env[["OPENAI", "API", "KEY"].join("_")]);
  const codexPlannerSelected = plannerProvider === "codex";
  const codexBinConfigured = Boolean(process.env.AUTOMATION_OS_CODEX_PLANNER_BIN || process.env.AUTOMATION_OS_CODEX_BIN);
  const openAiPlannerReady = (plannerProvider === "auto" || plannerProvider === "openai") && openAiKeyConfigured;
  const subscriptionPlannerReady = !openAiPlannerReady && plannerProvider !== "openai";
  const plannerExecutionMode = openAiPlannerReady
    ? "hosted_openai_api"
    : subscriptionPlannerReady
      ? "mac_worker_subscription"
      : "blocked";
  return {
    commit: gitCommit,
    commitSource: envCommit ? "env" : gitCommit ? "git" : "unknown",
    version: getPackageVersion(),
    plannerProvider,
    aiRuntime: {
      hostedPlannerReady: openAiPlannerReady,
      openAiApiReady: openAiKeyConfigured,
      codexPlannerSelected,
      codexBinConfigured,
      subscriptionPlannerReady,
      plannerExecutionMode,
      subscriptionRoute: "codex_cli_or_app_local",
      apiRoute: "openai_platform_key",
      blocker: plannerExecutionMode === "blocked" ? "openai_api_key_required_for_forced_openai_planner" : ""
    },
    nodeEnv: process.env.NODE_ENV ?? "",
    assets: getServedAssetNames()
  };
}

function getDashboardDeploymentReadback() {
  const deployment = getDeploymentReadback();
  const assets = { ...deployment.assets };
  delete (assets as { webDistDir?: string }).webDistDir;
  return {
    ...deployment,
    assets
  };
}

let dashboardExpensiveSnapshotCache: {
  key: string;
  expiresAt: number;
  codexCapabilities: ReturnType<typeof getCodexCapabilities>;
  browserHealth: ReturnType<typeof getBrowserHealth>;
} | null = null;

type CodexCapabilitiesProbeReadback = {
  ok: boolean;
  cached: boolean;
  generatedAt: string;
  exactBlocker: string | null;
  matrix: ReturnType<typeof getCodexCapabilities>;
};

let codexCapabilitiesCache: {
  key: string;
  expiresAt: number;
  capabilities: ReturnType<typeof getCodexCapabilities>;
} | null = null;

function getCodexCapabilitiesReadback(options: {
  mcpProbe?: ReturnType<typeof probeCodexMcpSurface> | null;
  appServerProbe?: Awaited<ReturnType<typeof probeCodexAppServerSurface>> | null;
  forceRefresh?: boolean;
} = {}) {
  const { cache, cached } = getCodexCapabilitiesCache({
    forceRefresh: options.forceRefresh ?? false,
    appServerProbe: options.appServerProbe ?? null
  });
  return {
    ...cache.capabilities,
    matrix: cache.capabilities,
    probe: buildCodexCapabilitiesProbe(cache.capabilities, cached, options.mcpProbe ?? getLatestCapabilityProbeSnapshot())
  };
}

function getCodexCapabilitiesCache(options: {
  forceRefresh?: boolean;
  appServerProbe?: Awaited<ReturnType<typeof probeCodexAppServerSurface>> | null;
} = {}) {
  const key = [
    process.cwd(),
    process.env.AUTOMATION_OS_CAPABILITIES_HOME ?? "",
    process.env.AUTOMATION_OS_CODEX_ROOT ?? "",
    process.env.AUTOMATION_OS_AGENTS_ROOT ?? "",
    process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS ?? "",
    process.env.AUTOMATION_OS_AGENT_SKILL_ROOTS ?? "",
    process.env.AUTOMATION_OS_CODEX_PLUGIN_ROOTS ?? "",
    process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT ?? ""
  ].join("\n");
  const ttlMs = process.env.NODE_TEST_CONTEXT
    ? 0
    : Number(process.env.AUTOMATION_OS_CODEX_CAPABILITIES_CACHE_MS ?? 300000);
  const now = Date.now();
  if (!options.forceRefresh && ttlMs > 0 && codexCapabilitiesCache?.key === key && codexCapabilitiesCache.expiresAt > now) {
    return { cache: codexCapabilitiesCache, cached: true };
  }
  const capabilities = getCodexCapabilities({
    mcpProbe: getLatestCapabilityProbeSnapshot(now),
    appServerProbe: options.appServerProbe ?? getLatestAppServerProbeSnapshot()
  });
  const cache = {
    key,
    expiresAt: now + Math.max(0, ttlMs),
    capabilities
  };
  codexCapabilitiesCache = cache;
  return { cache, cached: false };
}

function buildCodexCapabilitiesProbe(
  capabilities: ReturnType<typeof getCodexCapabilities>,
  cached: boolean,
  probe: ReturnType<typeof getLatestCapabilityProbeSnapshot>
): CodexCapabilitiesProbeReadback {
  if (!probe) {
    return {
      ok: false,
      cached,
      generatedAt: capabilities.generatedAt,
      exactBlocker: "probe_required",
      matrix: capabilities
    };
  }
  return {
    ok: probe.status === "ok",
    cached,
    generatedAt: probe.generatedAt,
    exactBlocker: probe.exactBlocker,
    matrix: capabilities
  };
}

function getDashboardExpensiveSnapshot() {
  const key = [
    process.cwd(),
    process.env.AUTOMATION_OS_CAPABILITIES_HOME ?? "",
    process.env.AUTOMATION_OS_CODEX_ROOT ?? "",
    process.env.AUTOMATION_OS_AGENTS_ROOT ?? "",
    process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS ?? "",
    process.env.AUTOMATION_OS_AGENT_SKILL_ROOTS ?? "",
    process.env.AUTOMATION_OS_CODEX_PLUGIN_ROOTS ?? "",
    process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT ?? "",
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI ?? "",
    process.env.AUTOMATION_OS_BROWSER_USE_CLI ?? ""
  ].join("\n");
  const ttlMs = process.env.NODE_TEST_CONTEXT
    ? 0
    : Number(process.env.AUTOMATION_OS_DASHBOARD_CAPABILITY_CACHE_MS ?? 300000);
  const now = Date.now();
  if (ttlMs > 0 && dashboardExpensiveSnapshotCache?.key === key && dashboardExpensiveSnapshotCache.expiresAt > now) {
    return dashboardExpensiveSnapshotCache;
  }
  const snapshot = {
    key,
    expiresAt: now + Math.max(0, ttlMs),
    codexCapabilities: getCodexCapabilities(),
    browserHealth: getBrowserHealth()
  };
  dashboardExpensiveSnapshotCache = snapshot;
  return snapshot;
}

export function getDashboard(companyIds?: string[]) {
  if (dbBackend === "postgres" && process.env.AUTOMATION_OS_DASHBOARD_FULL_POSTGRES !== "1") return getPostgresFastDashboard();
  normalizeReceiptOnlyRuns();
  const { codexCapabilities, browserHealth } = getDashboardExpensiveSnapshot();
  const registeredWorkflows = filterRegisteredWorkflowList(initRegisteredWorkflows());
  const [
    rawRuns,
    rawActionQueueRuns,
    rawMigrationRuns,
    rawMigrationProofs,
    rawMigrationApprovals,
    rawApprovalInboxRows,
    rawSystemChecks,
    rawBridgeExecutions,
    rawSteps,
    rawLanes,
    rawProofs,
    rawChildRuns,
    rawWorkerEvents,
    rawAdvisorEvents,
    rawBridgeActions,
    rawKnowledgeNotes,
    rawAssetSummary,
    rawAssets,
    rawSkills,
    rawResearchPlans,
    rawSecrets,
    rawMvpAutomations
  ] = querySqlBatch([
    "SELECT * FROM runs ORDER BY created_at DESC LIMIT 20",
    "SELECT * FROM runs ORDER BY updated_at DESC LIMIT 500",
    "SELECT * FROM runs ORDER BY updated_at DESC LIMIT 500",
    "SELECT run_id, proof_type, created_at, metadata_json FROM proofs ORDER BY created_at DESC LIMIT 2000",
    "SELECT id, run_id, status, created_at FROM approvals ORDER BY created_at DESC LIMIT 2000",
    `
    WITH pending_approvals AS (
      SELECT
        approvals.id,
        approvals.run_id,
        approvals.status,
        approvals.title,
        approvals.requested_by,
        approvals.resource_locks_json,
        approvals.created_at,
        runs.name AS run_name,
        runs.objective AS run_objective,
        runs.metadata_json AS run_metadata_json,
        COALESCE(
          NULLIF(trim(json_extract(runs.metadata_json, '$.registeredWorkflowId')), ''),
          NULLIF(trim(json_extract(runs.metadata_json, '$.registered_workflow_id')), ''),
          NULLIF(trim(json_extract(runs.metadata_json, '$.workflowId')), ''),
          NULLIF(trim(json_extract(runs.metadata_json, '$.workflow_id')), ''),
          NULLIF(trim(json_extract(runs.metadata_json, '$.AUTOMATION_OS_REGISTERED_WORKFLOW_ID')), '')
        ) AS workflow_key
      FROM approvals
      LEFT JOIN runs ON runs.id=approvals.run_id
      WHERE approvals.status='pending'
    ),
    ranked_approvals AS (
      SELECT
        *,
        CASE
          WHEN workflow_key IS NULL THEN NULL
          ELSE ROW_NUMBER() OVER (PARTITION BY workflow_key ORDER BY created_at DESC, id DESC)
        END AS workflow_rank
      FROM pending_approvals
    )
    SELECT
      id,
      run_id,
      status,
      title,
      requested_by,
      resource_locks_json,
      created_at,
      run_name,
      run_objective,
      run_metadata_json
    FROM ranked_approvals
    WHERE workflow_key IS NULL OR workflow_rank=1
    ORDER BY created_at DESC, id DESC
    LIMIT 12
  `,
    "SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 20",
    "SELECT * FROM bridge_executions ORDER BY created_at DESC LIMIT 50",
    "SELECT * FROM run_steps ORDER BY started_at DESC LIMIT 20",
    `
      SELECT lanes.*, runs.name AS run_name, runs.status AS run_status
      FROM lanes
      LEFT JOIN runs ON runs.id=lanes.run_id
      ORDER BY
        CASE lanes.status
          WHEN 'active' THEN 0
          WHEN 'blocked' THEN 1
          WHEN 'idle' THEN 2
          ELSE 3
        END,
        lanes.updated_at DESC,
        lanes.cdp_port ASC
      LIMIT 50
    `,
    "SELECT * FROM proofs ORDER BY created_at DESC LIMIT 12",
    "SELECT * FROM child_runs ORDER BY created_at DESC LIMIT 20",
    "SELECT * FROM worker_events ORDER BY created_at DESC LIMIT 16",
    "SELECT * FROM advisor_events ORDER BY created_at DESC LIMIT 8",
    "SELECT * FROM bridge_actions ORDER BY created_at DESC LIMIT 8",
    "SELECT * FROM knowledge_notes ORDER BY updated_at DESC LIMIT 8",
    "SELECT source_type, count(*) as count, sum(size_bytes) as size_bytes FROM codex_assets GROUP BY source_type ORDER BY source_type",
    "SELECT * FROM codex_assets ORDER BY imported_at DESC LIMIT 12",
    "SELECT id, run_id, name, draft_markdown, created_at FROM skills ORDER BY created_at DESC LIMIT 8",
    "SELECT * FROM research_plans ORDER BY updated_at DESC LIMIT 8",
    "SELECT id, kind, label, masked_value, updated_at FROM stored_secrets ORDER BY updated_at DESC",
    companyScopedAutomationSql(companyIds)
  ]);
  const approvalInboxRows = latestPendingApprovalInboxRows(rawApprovalInboxRows as ApprovalInboxSourceRow[]);
  const codexAutomationMigrationLedger = buildCodexAutomationMigrationLedger({
    registeredWorkflows,
    runs: rawMigrationRuns as CodexAutomationMigrationRunRow[],
    proofs: rawMigrationProofs as CodexAutomationMigrationProofRow[],
    approvals: rawMigrationApprovals as CodexAutomationMigrationApprovalRow[]
  });
  const capabilityRouter = buildCapabilityRouterSnapshot({
    capabilities: codexCapabilities,
    bridgeActions: listTrustedBridgeActions()
  });
  const migrationLedgerByWorkflowId = indexMigrationLedgerByRegisteredWorkflowId(codexAutomationMigrationLedger.items);
  const publicRegisteredWorkflows = registeredWorkflows.map((workflow) => publicRegisteredWorkflow(workflow, migrationLedgerByWorkflowId.get(workflow.id)));
  const actionQueueRuns = selectActionQueueRuns(rawActionQueueRuns);
  const systemChecks = sanitizeDashboardRows(rawSystemChecks);
  const localWorker = buildLocalWorkerStatus(rawSystemChecks);
  const bridgeExecutions = sanitizeDashboardRows(rawBridgeExecutions);
  const body = {
    runs: sanitizeDashboardRows(rawRuns),
    actionableRuns: sanitizeDashboardRows(actionQueueRuns),
    steps: sanitizeDashboardRows(rawSteps),
    lanes: sanitizeDashboardRows(rawLanes),
    approvals: buildApprovalInbox(approvalInboxRows),
    approvalInbox: buildApprovalInbox(approvalInboxRows),
    externalPreflightChecklist: buildExternalPreflightChecklist(),
    proofs: sanitizeDashboardRows(rawProofs),
    childRuns: sanitizeDashboardRows(rawChildRuns),
    workerEvents: sanitizeDashboardRows(rawWorkerEvents),
    advisorEvents: rawAdvisorEvents,
    systemChecks,
    localWorker,
    schedulerStatus: getSchedulerStatus(),
    productionGuard: getProductionWriteGuardStatus(),
    deployment: getDashboardDeploymentReadback(),
    bridgeActionCatalog: listTrustedBridgeActions(),
    bridgeActions: sanitizeDashboardRows(rawBridgeActions),
    bridgeExecutions,
    knowledgeNotes: sanitizeDashboardRows(rawKnowledgeNotes),
    researchPlans: rawResearchPlans.map((row) => researchPlanFromRow(row as Parameters<typeof researchPlanFromRow>[0])),
    assetSummary: rawAssetSummary,
    assets: sanitizeDashboardRows(rawAssets),
    skills: sanitizeDashboardRows(rawSkills),
    registeredWorkflows: publicRegisteredWorkflows,
    automations: (rawMvpAutomations as Array<Record<string, unknown>>).map((row) => {
      const execution = automationExecutionContract(row.worker_command_kind);
      return {
        id: String(row.id ?? ""),
        company_id: String(row.company_id ?? row.project_id ?? ""),
        project_id: String(row.project_id ?? row.company_id ?? ""),
        automation_type: String(row.automation_type ?? "sns-post"),
        name: String(row.name ?? ""),
        desc: String(row.description ?? row.desc ?? ""),
        goal: String(row.goal ?? ""),
        schedule: String(row.schedule ?? "09:00"),
        cadence: String(row.cadence ?? "daily"),
        lane: String(row.lane ?? "Lane 1"),
        risk_level: String(row.risk_level ?? "high"),
        approval_policy: String(row.approval_policy ?? "required_before_external_post"),
        worker_command_kind: String(row.worker_command_kind ?? "safe_local_demo"),
        ...execution,
        create_approval: row.create_approval === 1 || row.create_approval === true,
        status: String(row.status ?? "draft"),
        builder_spec: safeJsonParse<Record<string, unknown>>(typeof row.builder_spec_json === "string" ? row.builder_spec_json : "{}", {}),
        created_at: String(row.created_at ?? ""),
        updated_at: String(row.updated_at ?? "")
      };
    }),
    builder_specs: (rawMvpAutomations as Array<Record<string, unknown>>).map((row) => ({
      automation_id: String(row.id ?? ""),
      project_id: String(row.project_id ?? row.company_id ?? ""),
      updated_at: String(row.updated_at ?? ""),
      spec: safeJsonParse<Record<string, unknown>>(typeof row.builder_spec_json === "string" ? row.builder_spec_json : "{}", {})
    })),
    secrets: rawSecrets.map((row) => ({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? ""),
      label: String(row.label ?? ""),
      maskedValue: String(row.masked_value ?? ""),
      updatedAt: String(row.updated_at ?? "")
    })),
    obsidian: getObsidianExportStatus(),
    resumeContract: getResumeContract(),
    executionRouting: buildExecutionRoutingSnapshot({
      command: "dashboard_readback",
      source: "manual",
      capabilities: codexCapabilities
    }),
    codexCapabilities: {
      summary: codexCapabilities.summary,
      browser: codexCapabilities.capabilities.browser,
      chrome: codexCapabilities.capabilities.chrome,
      automationOsApi: codexCapabilities.capabilities.automationOsApi,
      appServer: codexCapabilities.capabilities.appServer,
      mcp: codexCapabilities.capabilities.mcp,
      notes: codexCapabilities.notes
    },
    codexParityLedger: buildCodexAppParityLedger({
      capabilities: codexCapabilities,
      checks: rawSystemChecks as Array<CodexParitySystemCheck & Record<string, unknown>>,
      bridgeExecutions: rawBridgeExecutions as Array<CodexParityBridgeExecution & Record<string, unknown>>
    }),
    codexAutomationMigrationLedger,
    capabilityRouter,
    browserHealth
  };
  return { ...body, nextActions: buildNextActions({ ...body, runs: actionQueueRuns }) };
}

function buildPersistedProjectPresentationProfile(
  company: { id: string; name: string },
  automations: Array<Record<string, unknown>>
): ProjectPresentationProfile {
  const derived = buildProjectPresentationProfile({
    id: company.id,
    name: company.name,
    automations: automations.filter((automation) => String(automation.company_id ?? automation.project_id ?? "") === company.id)
  });
  const memory = listCompanyMemory(company.id).find((entry) => entry.key === "project_profile");
  if (!memory) return derived;
  try {
    const override = parseProjectPresentationProfileOverride(JSON.parse(memory.body));
    return applyProjectPresentationProfileOverride(derived, override, memory.revision);
  } catch (error) {
    const exactBlocker = error instanceof Error ? error.message : "project_profile_invalid";
    return { ...derived, source: "persisted_project_profile", revision: memory.revision, exactBlocker };
  }
}

function getMvpStateReadback(companyIds: string[]) {
  const allowed = listActorCompanies().filter((company) => companyIds.includes(company.id));
  const scopedIds = allowed.map((company) => company.id);
  const capturedAt = nowIso();
  const companyPredicate = scopedCompanyPredicate("company_id", scopedIds);
  const runs = sanitizeDashboardRows(querySql(`SELECT * FROM runs WHERE ${companyPredicate} ORDER BY created_at DESC LIMIT 500`));
  const runIds = runs.map((row) => sqlValue(String((row as Record<string, unknown>).id ?? ""))).filter((value) => value !== "''");
  const runPredicate = runIds.length > 0 ? `run_id IN (${runIds.join(", ")})` : "1=0";
  const approvals = sanitizeDashboardRows(querySql(`
    SELECT approvals.* FROM approvals
    LEFT JOIN runs ON runs.id=approvals.run_id AND runs.company_id=approvals.company_id
    WHERE ${scopedCompanyPredicate("approvals.company_id", scopedIds)}
      AND (approvals.run_id IS NULL OR runs.id IS NOT NULL)
    ORDER BY approvals.created_at DESC LIMIT 500
  `));
  const proofs = sanitizeDashboardRows(querySql(`
    SELECT proofs.* FROM proofs
    JOIN runs ON runs.id=proofs.run_id AND runs.company_id=proofs.company_id
    WHERE ${scopedCompanyPredicate("proofs.company_id", scopedIds)}
    ORDER BY proofs.created_at DESC LIMIT 500
  `));
  const automations = readMvpAutomations(scopedIds);
  initRegisteredWorkflows();
  const registeredWorkflows = listRegisteredWorkflowsForCompanies(scopedIds);
  const feedbacks = readMvpFeedbacks(scopedIds);
  const presentationProfiles = allowed.map((company) => buildPersistedProjectPresentationProfile(company, automations));
  const durableJobs = scopedIds.flatMap((companyId) => listDurableJobs(companyId, 500));
  const durableAttempts = durableJobs.flatMap((job) => listDurableJobAttempts(job.companyId, job.id));
  const scheduleOccurrences = scopedIds.flatMap((companyId) => listDurableScheduleOccurrences(companyId, 500));
  const queuedJobs = durableJobs.filter((job) => job.status === "queued");
  const leasedJobs = durableJobs.filter((job) => job.status === "leased");
  const latestHeartbeat = durableJobs.map((job) => job.heartbeatAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const storedWorkerState = readStoredWorkerState();
  const storedWorkerStatus = storedWorkerState?.status === "blocked" || storedWorkerState?.status === "running"
    ? storedWorkerState.status
    : null;
  const workerStatus = storedWorkerStatus ?? (leasedJobs.length > 0 ? "running" : "idle");
  return {
    projects: allowed.map((company) => ({ id: company.id, project_id: company.id, name: company.name, status: company.status, role: company.role })),
    companies: allowed,
    automations,
    presentation_profiles: presentationProfiles,
    builder_specs: automations.map((automation) => ({
      automation_id: automation.id,
      company_id: automation.company_id,
      project_id: automation.project_id,
      updated_at: automation.updated_at,
      spec: automation.builder_spec
    })),
    schedules: scopedIds.flatMap((companyId) => listAutomationSchedules(companyId).map((schedule) => ({
      ...schedule,
      company_id: schedule.companyId,
      project_id: schedule.companyId,
      automation_id: schedule.automationId,
      automation_version_id: schedule.automationVersionId,
      next_run_at: schedule.nextRunAt,
      last_run_at: schedule.lastRunAt,
      paused_at: schedule.pausedAt,
      created_at: schedule.createdAt,
      updated_at: schedule.updatedAt
    }))),
    runs,
    jobs: durableJobs.map(durableJobApiView),
    job_attempts: durableAttempts.map(durableAttemptApiView),
    schedule_occurrences: scheduleOccurrences.map((occurrence) => ({
      id: occurrence.id,
      company_id: occurrence.companyId,
      schedule_id: occurrence.scheduleId,
      occurrence_key: occurrence.occurrenceKey,
      scheduled_for: occurrence.scheduledFor,
      status: occurrence.status,
      job_id: occurrence.jobId,
      created_at: occurrence.createdAt,
      updated_at: occurrence.updatedAt
    })),
    actionableRuns: sanitizeDashboardRows(selectActionQueueRuns(runs as Array<{ status?: unknown; metadata_json?: unknown; project_id?: unknown; objective?: unknown; name?: unknown }>)),
    steps: sanitizeDashboardRows(querySql(`SELECT * FROM run_steps WHERE ${runPredicate} ORDER BY started_at DESC LIMIT 500`)),
    lanes: sanitizeDashboardRows(querySql(`SELECT * FROM lanes WHERE ${runPredicate} ORDER BY updated_at DESC LIMIT 500`)),
    approvals,
    approvalInbox: approvals,
    proofs,
    childRuns: sanitizeDashboardRows(querySql(`SELECT * FROM child_runs WHERE parent_run_id IN (${runIds.length > 0 ? runIds.join(", ") : "''"}) ORDER BY created_at DESC LIMIT 500`)),
    workerEvents: sanitizeDashboardRows(querySql(`SELECT * FROM worker_events WHERE ${runPredicate} ORDER BY created_at DESC LIMIT 500`)),
    project_memory: scopedIds.flatMap((companyId) => listCompanyMemory(companyId).map((entry) => ({
      ...entry,
      company_id: entry.companyId,
      project_id: entry.companyId,
      memory_key: entry.key,
      archived_at: entry.archivedAt,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt
    }))),
    feedbacks,
    feedback_summary: {
      source: "mvp_feedback",
      captured_at: feedbacks[0]?.created_at ?? nowIso(),
      count: feedbacks.length,
      open_count: feedbacks.filter((item) => item.status === "open").length,
      triaged_count: feedbacks.filter((item) => item.status === "triaged").length
    },
    registeredWorkflows: [],
    registered_workflow_ids: registeredWorkflows.map((workflow) => workflow.id),
    sync_readback: {
      schema: "mvp_sync_readback.v1",
      captured_at: capturedAt,
      company_ids: scopedIds,
      automation_ids: automations.map((automation) => automation.id),
      registered_workflow_ids: registeredWorkflows.map((workflow) => workflow.id),
      automation_count: automations.length,
      registered_workflow_count: registeredWorkflows.length,
      runs_count: runs.length
    },
    researchPlans: [],
    knowledgeNotes: [],
    assets: [],
    assetSummary: [],
    skills: [],
    secrets: [],
    bridgeActions: [],
    bridgeExecutions: [],
    advisorEvents: [],
    company_scope: { enforced: true, company_ids: scopedIds, actor_user_id: currentActorUserId() },
    worker: {
      id: "durable-company-queue",
      status: workerStatus,
      label: workerStatus === "blocked" ? "Mac worker要確認" : "会社別durable queue",
      detail: storedWorkerState?.exactBlocker
        ? `Mac worker readback: ${storedWorkerState.exactBlocker}`
        : `queued ${queuedJobs.length} / leased ${leasedJobs.length}`,
      queue_depth: queuedJobs.length,
      active_leases: leasedJobs.length,
      heartbeat_at: storedWorkerState?.updatedAt ?? latestHeartbeat,
      last_run_id: durableJobs[0]?.runId ?? null,
      readback_status: "stored",
      exact_blocker: storedWorkerState?.exactBlocker ?? null,
      next_action: storedWorkerState?.nextAction
        ?? (queuedJobs.length > 0 ? "登録済みservice workerのclaimを待っています。" : "待機中のjobはありません。"),
      external_action_executed: false
    },
    browser_use_runtime: buildBrowserUseRuntimeSnapshot(),
    updated_at: capturedAt
  };
}

function readMvpFeedbacks(companyIds: string[] = actorCompanyIds(["owner"])) {
  initDb();
  return querySql<{
    id: string;
    company_id: string;
    feedback_id: string;
    status: string;
    route: string;
    page_title: string;
    comment: string;
    artifact_uri: string;
    has_screenshot: number;
    screenshot_artifact_id: string | null;
    viewport_json: string;
    workflow_context_json: string;
    category: string;
    severity: string;
    fix_target: string;
    captured_at: string;
    created_at: string;
    payload_json: string;
  }>(`SELECT * FROM mvp_feedback WHERE ${scopedCompanyPredicate("company_id", companyIds)} ORDER BY created_at DESC LIMIT 500`).map((row) => ({
    id: row.id,
    company_id: row.company_id,
    project_id: row.company_id,
    feedback_id: row.feedback_id,
    status: row.status,
    route: row.route,
    page_title: row.page_title,
    comment: row.comment,
    artifact_uri: row.artifact_uri,
    has_screenshot: row.has_screenshot === 1,
    screenshot_artifact_id: row.screenshot_artifact_id,
    viewport: safeJsonParse<Record<string, unknown>>(row.viewport_json, {}),
    workflow_context: safeJsonParse<Record<string, unknown>>(row.workflow_context_json, {}),
    category: row.category,
    severity: row.severity,
    fix_target: row.fix_target,
    captured_at: row.captured_at,
    created_at: row.created_at,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {})
  }));
}

function readMvpAutomations(companyIds?: string[]) {
  initDb();
  const scopedIds = companyIds ?? actorCompanyIds();
  return scopedIds.flatMap((companyId) => {
    const schedules = new Map(listAutomationSchedules(companyId).map((schedule) => [schedule.automationId, schedule]));
    return listAutomationRecords(companyId).map((automation) => {
      const view = automationApiView(automation);
      const schedule = schedules.get(automation.id);
      return schedule ? {
        ...view,
        schedule: schedule.expression ?? schedule.kind,
        cadence: schedule.kind,
        schedule_status: schedule.status,
        schedule_revision: schedule.revision,
        pinned_schedule_version_id: schedule.automationVersionId,
        next_run_at: schedule.nextRunAt,
        last_run_at: schedule.lastRunAt
      } : view;
    });
  });
}

function companyScopedAutomationSql(companyIds?: string[]): string {
  if (companyIds === undefined) return "SELECT * FROM mvp_automations ORDER BY updated_at DESC LIMIT 500";
  if (companyIds.length === 0) return "SELECT * FROM mvp_automations WHERE 1=0";
  const values = companyIds.map((companyId) => sqlValue(companyId)).join(", ");
  return `SELECT * FROM mvp_automations WHERE company_id IN (${values}) ORDER BY updated_at DESC LIMIT 500`;
}

function readMvpAutomationScope(automationId: string, companyIds: readonly string[]): { id: string; company_id: string; project_id: string } | undefined {
  const row = querySql<{ id: string; company_id: string; project_id: string }>(
    `SELECT id, company_id, project_id FROM mvp_automations
     WHERE id=${sqlValue(automationId)} AND ${scopedCompanyPredicate("company_id", companyIds)}
     LIMIT 1`
  )[0];
  if (!row) return undefined;
  return row;
}

function buildMvpWorkerState(dashboard: ReturnType<typeof getDashboard>) {
  const localWorker = dashboard.localWorker as
    | {
      status?: string;
      label?: string;
      detail?: string;
      nextAction?: string;
      updatedAt?: string | null;
      processed?: number;
      usesApiKey?: boolean;
      exactBlocker?: string | null;
    }
    | undefined;
  const runs = Array.isArray(dashboard.runs) ? dashboard.runs : [];
  const actionQueueRuns = selectActionQueueRuns(runs as Array<{ status?: unknown; metadata_json?: unknown; project_id?: unknown; objective?: unknown; name?: unknown }>);
  const missing = !localWorker || localWorker.status === "missing";
  const heartbeatTimestamp = localWorker?.updatedAt ? Date.parse(localWorker.updatedAt) : Number.NaN;
  const heartbeatNow = Date.now();
  const heartbeatInFuture = Number.isFinite(heartbeatTimestamp) && heartbeatTimestamp > heartbeatNow + 30_000;
  const heartbeatAgeSeconds = Number.isFinite(heartbeatTimestamp) && !heartbeatInFuture
    ? Math.max(0, Math.floor((heartbeatNow - heartbeatTimestamp) / 1000))
    : null;
  const configuredStaleSeconds = Number(process.env.AUTOMATION_OS_WORKER_HEARTBEAT_STALE_SECONDS ?? 300);
  const staleAfterSeconds = Number.isFinite(configuredStaleSeconds) && configuredStaleSeconds >= 30
    ? configuredStaleSeconds
    : 300;
  const stale = !missing && (
    localWorker?.status === "idle"
    || heartbeatInFuture
    || heartbeatAgeSeconds === null
    || heartbeatAgeSeconds > staleAfterSeconds
  );
  const readbackStatus = missing ? "heartbeat_missing" : stale ? "heartbeat_stale" : "fresh";
  const exactBlocker = localWorker?.exactBlocker ?? (missing ? "mac_worker_state_missing" : stale ? "mac_worker_heartbeat_stale" : null);
  return {
    id: "local_codex_worker",
    status: localWorker?.status === "ok" ? "ok" : localWorker?.status === "running" ? "running" : localWorker?.status === "blocked" ? "blocked" : "unknown",
    heartbeat_at: localWorker?.updatedAt ?? null,
    queue_depth: actionQueueRuns.length,
    last_run_id: runs[0]?.id ? String(runs[0].id) : null,
    heartbeat_age_seconds: heartbeatAgeSeconds,
    heartbeat_fresh: !missing && !stale,
    readback_status: readbackStatus,
    exact_blocker: exactBlocker,
    next_action: localWorker?.nextAction ?? "MVP stateを再読込してworker状態を確認してください。",
    external_action_executed: false
  };
}

function buildMvpWorkerPreview(
  projectId = "all",
  dashboard: { runs?: Record<string, unknown>[]; worker?: { exact_blocker?: string | null; next_action?: string } } = getDashboard()
) {
  const runs = Array.isArray(dashboard.runs) ? dashboard.runs : [];
  const actionQueueRuns = selectActionQueueRuns(runs as Array<{ status?: unknown; metadata_json?: unknown; project_id?: unknown; objective?: unknown; name?: unknown }>);
  const projectScopedRuns = projectId === "all"
    ? actionQueueRuns
    : actionQueueRuns.filter((run) => deriveRunProjectId(run) === projectId);
  const byProject = projectScopedRuns.reduce<Record<string, number>>((acc, run) => {
    const key = deriveRunProjectId(run) || "unassigned";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const highRiskCount = projectScopedRuns.filter((run) => {
    const status = String((run as { status?: unknown }).status ?? "");
    return status === "blocked" || status === "waiting_approval" || status === "approval_required" || Boolean((run as { exact_blocker?: unknown }).exact_blocker);
  }).length;
  const worker = dashboard.worker ?? buildMvpWorkerState(dashboard as ReturnType<typeof getDashboard>);
  return {
    ok: true,
    read_only: true,
    project_id: projectId,
    picked_count: projectScopedRuns.length,
    by_project: byProject,
    high_risk_count: highRiskCount,
    exact_blocker: worker.exact_blocker,
    next_action: worker.next_action,
    external_action_executed: false
  };
}

function deriveRunProjectId(run: { company_id?: unknown; project_id?: unknown; metadata_json?: unknown; objective?: unknown; name?: unknown }): string {
  const direct = typeof run.company_id === "string" && run.company_id.trim()
    ? run.company_id.trim()
    : typeof run.project_id === "string" ? run.project_id.trim() : "";
  if (direct) return direct;
  const metadata = safeJsonParse<Record<string, unknown>>(typeof run.metadata_json === "string" ? run.metadata_json : "{}", {});
  const metadataProject = firstStringValue(
    metadata.project_id,
    metadata.projectId,
    metadata.project,
    metadata.project_slug,
    metadata.projectSlug
  );
  if (metadataProject) return metadataProject;
  return "";
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function getPostgresFastDashboard() {
  const { codexCapabilities, browserHealth } = getDashboardExpensiveSnapshot();
  const registeredWorkflows = filterRegisteredWorkflowList(initRegisteredWorkflows());
  const [
    rawRuns,
    rawActionQueueRuns,
    rawApprovalInboxRows,
    rawSystemChecks,
    rawSteps,
    rawLanes,
    rawWorkerEvents,
    rawMvpAutomations
  ] = querySqlBatch([
    "SELECT * FROM runs ORDER BY created_at DESC LIMIT 20",
    "SELECT * FROM runs ORDER BY updated_at DESC LIMIT 80",
    `
      SELECT
        approvals.id,
        approvals.run_id,
        approvals.status,
        approvals.title,
        approvals.requested_by,
        approvals.resource_locks_json,
        approvals.created_at,
        runs.name AS run_name,
        runs.objective AS run_objective,
        runs.metadata_json AS run_metadata_json
      FROM approvals
      LEFT JOIN runs ON runs.id=approvals.run_id
      WHERE approvals.status='pending'
      ORDER BY approvals.created_at DESC, approvals.id DESC
      LIMIT 12
    `,
    "SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 20",
    "SELECT * FROM run_steps ORDER BY started_at DESC LIMIT 20",
    `
      SELECT lanes.*, runs.name AS run_name, runs.status AS run_status
      FROM lanes
      LEFT JOIN runs ON runs.id=lanes.run_id
      ORDER BY
        CASE lanes.status
          WHEN 'active' THEN 0
          WHEN 'blocked' THEN 1
          WHEN 'idle' THEN 2
          ELSE 3
        END,
        lanes.updated_at DESC,
        lanes.cdp_port ASC
      LIMIT 50
    `,
    "SELECT * FROM worker_events ORDER BY created_at DESC LIMIT 12",
    "SELECT * FROM mvp_automations ORDER BY updated_at DESC LIMIT 500"
  ]);
  const rawBridgeExecutions: Array<Record<string, unknown>> = [];
  const rawProofs: Array<Record<string, unknown>> = [];
  const rawChildRuns: Array<Record<string, unknown>> = [];
  const rawBridgeActions: Array<Record<string, unknown>> = [];
  const approvalInboxRows = latestPendingApprovalInboxRows(rawApprovalInboxRows as ApprovalInboxSourceRow[]);
  const codexAutomationMigrationLedger = buildCodexAutomationMigrationLedger({
    registeredWorkflows,
    runs: rawActionQueueRuns as CodexAutomationMigrationRunRow[],
    proofs: rawProofs as CodexAutomationMigrationProofRow[],
    approvals: rawApprovalInboxRows as CodexAutomationMigrationApprovalRow[]
  });
  const migrationLedgerByWorkflowId = indexMigrationLedgerByRegisteredWorkflowId(codexAutomationMigrationLedger.items);
  const publicRegisteredWorkflows = registeredWorkflows.map((workflow) => publicRegisteredWorkflow(workflow, migrationLedgerByWorkflowId.get(workflow.id)));
  const actionQueueRuns = selectActionQueueRuns(rawActionQueueRuns);
  const systemChecks = sanitizeDashboardRows(rawSystemChecks);
  const localWorker = buildLocalWorkerStatus(rawSystemChecks);
  const bridgeExecutions = sanitizeDashboardRows(rawBridgeExecutions);
  const body = {
    runs: sanitizeDashboardRows(rawRuns),
    actionableRuns: sanitizeDashboardRows(actionQueueRuns),
    steps: sanitizeDashboardRows(rawSteps),
    lanes: sanitizeDashboardRows(rawLanes),
    approvals: buildApprovalInbox(approvalInboxRows),
    approvalInbox: buildApprovalInbox(approvalInboxRows),
    externalPreflightChecklist: buildExternalPreflightChecklist(),
    proofs: sanitizeDashboardRows(rawProofs),
    childRuns: sanitizeDashboardRows(rawChildRuns),
    workerEvents: sanitizeDashboardRows(rawWorkerEvents),
    advisorEvents: [],
    systemChecks,
    localWorker,
    schedulerStatus: getSchedulerStatus(),
    productionGuard: getProductionWriteGuardStatus(),
    deployment: getDashboardDeploymentReadback(),
    bridgeActionCatalog: listTrustedBridgeActions(),
    bridgeActions: sanitizeDashboardRows(rawBridgeActions),
    bridgeExecutions,
    knowledgeNotes: [],
    researchPlans: [],
    assetSummary: [],
    assets: [],
    skills: [],
    registeredWorkflows: publicRegisteredWorkflows,
    automations: (rawMvpAutomations as Array<Record<string, unknown>>).map((row) => {
      const execution = automationExecutionContract(row.worker_command_kind);
      return {
        id: String(row.id ?? ""),
        project_id: String(row.project_id ?? row.company_id ?? ""),
        automation_type: String(row.automation_type ?? "sns-post"),
        name: String(row.name ?? ""),
        desc: String(row.description ?? row.desc ?? ""),
        goal: String(row.goal ?? ""),
        schedule: String(row.schedule ?? "09:00"),
        cadence: String(row.cadence ?? "daily"),
        lane: String(row.lane ?? "Lane 1"),
        risk_level: String(row.risk_level ?? "high"),
        approval_policy: String(row.approval_policy ?? "required_before_external_post"),
        worker_command_kind: String(row.worker_command_kind ?? "safe_local_demo"),
        ...execution,
        create_approval: row.create_approval === 1 || row.create_approval === true,
        status: String(row.status ?? "draft"),
        builder_spec: safeJsonParse<Record<string, unknown>>(typeof row.builder_spec_json === "string" ? row.builder_spec_json : "{}", {}),
        created_at: String(row.created_at ?? ""),
        updated_at: String(row.updated_at ?? "")
      };
    }),
    builder_specs: (rawMvpAutomations as Array<Record<string, unknown>>).map((row) => ({
      automation_id: String(row.id ?? ""),
      project_id: String(row.project_id ?? row.company_id ?? ""),
      updated_at: String(row.updated_at ?? ""),
      spec: safeJsonParse<Record<string, unknown>>(typeof row.builder_spec_json === "string" ? row.builder_spec_json : "{}", {})
    })),
    secrets: [],
    obsidian: getObsidianExportStatus(),
    resumeContract: getResumeContract(),
    codexCapabilities: {
      summary: codexCapabilities.summary,
      browser: codexCapabilities.capabilities.browser,
      mcp: codexCapabilities.capabilities.mcp
    },
    codexParityLedger: buildCodexAppParityLedger({
      capabilities: codexCapabilities,
      checks: rawSystemChecks as Array<CodexParitySystemCheck & Record<string, unknown>>,
      bridgeExecutions: rawBridgeExecutions as Array<CodexParityBridgeExecution & Record<string, unknown>>
    }),
    codexAutomationMigrationLedger,
    capabilityRouter: buildCapabilityRouterSnapshot({
      capabilities: codexCapabilities,
      bridgeActions: listTrustedBridgeActions()
    }),
    browserHealth
  };
  return { ...body, nextActions: buildNextActions({ ...body, runs: actionQueueRuns }) };
}

function fixedRegisteredWorkflowRows(): RegisteredWorkflowRow[] {
  const timestamp = nowIso();
  return fixedRegisteredWorkflows.map((workflow) => registeredWorkflowDefinitionToRow(workflow, timestamp));
}

function registeredWorkflowDefinitionToRow(workflow: RegisteredWorkflowDefinition, timestamp: string): RegisteredWorkflowRow {
  return {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    runner_status: workflow.runnerStatus,
    runner_kind: workflow.runnerKind,
    project_root: workflow.projectRoot,
    start_command_json: JSON.stringify(workflow.startCommand),
    schedule_json: JSON.stringify(workflow.schedule),
    source_refs_json: JSON.stringify(workflow.sourceRefs),
    provenance_json: JSON.stringify(workflow.provenance),
    created_at: timestamp,
    updated_at: timestamp
  };
}

type StoredWorkerStateReadback = {
  status: string;
  exactBlocker: string | null;
  nextAction: string | null;
  updatedAt: string | null;
  processed: number;
  usesApiKey: boolean;
};

type SafeStoredWorkerStateReadback = Omit<StoredWorkerStateReadback, "usesApiKey">;

function readStoredWorkerState(): StoredWorkerStateReadback | null {
  const statePath = process.env.AUTOMATION_OS_WORKER_STATE_PATH
    ?? resolvePath(process.cwd(), "data", "state", "automation-os-worker.json");
  try {
    const file = statSync(statePath);
    if (!file.isFile() || file.size > 64 * 1024) return null;
    const state = parseJson<Record<string, unknown>>(readFileSync(statePath, "utf8"), {});
    const blocker = typeof state.blocker === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(state.blocker)
      ? state.blocker
      : null;
    const nextAction = typeof state.nextAction === "string"
      ? redactSensitiveText(state.nextAction).slice(0, 500)
      : null;
    const updatedAt = typeof state.updated_at === "string" ? state.updated_at : null;
    const processed = typeof state.processed === "number" && Number.isSafeInteger(state.processed) && state.processed >= 0
      ? state.processed
      : 0;
    return {
      status: typeof state.status === "string" ? state.status : "unknown",
      exactBlocker: blocker,
      nextAction,
      updatedAt,
      processed,
      usesApiKey: state.usesApiKey === true
    };
  } catch {
    return null;
  }
}

function safeStoredWorkerStateForApi(): SafeStoredWorkerStateReadback | null {
  const state = readStoredWorkerState();
  if (!state) return null;
  return {
    status: state.status,
    exactBlocker: state.exactBlocker,
    nextAction: state.nextAction,
    updatedAt: state.updatedAt,
    processed: state.processed
  };
}

function buildLocalWorkerStatus(checks: Array<Record<string, unknown>>) {
  const storedState = readStoredWorkerState();
  const check = checks.find((row) => row.kind === "local_codex_worker");
  if (!check) {
    if (storedState) {
      return {
        status: storedState.status,
        label: storedState.status === "blocked" ? "要確認" : storedState.status === "running" ? "起動中" : "確認",
        detail: storedState.exactBlocker ? `Mac worker readback: ${storedState.exactBlocker}` : "Mac workerの保存状態を読み取りました。",
        nextAction: storedState.nextAction ?? "Mac workerの状態を確認してください。",
        exactBlocker: storedState.exactBlocker,
        updatedAt: storedState.updatedAt,
        processed: storedState.processed,
        usesApiKey: storedState.usesApiKey
      };
    }
    return {
      status: "missing",
      label: "未接続",
      detail: "Mac workerはまだ確認できていません。",
      nextAction: "本番PostgreSQL接続を保存し、npm run worker:production-proof:stored の後で npm run worker:loop:stored を起動してください。",
      exactBlocker: "mac_worker_state_missing",
      updatedAt: null,
      processed: 0,
      usesApiKey: false
    };
  }
  const metadata = parseJson<Record<string, unknown>>(check.metadata_json, {});
  const recordedStatus = String(check.status ?? "unknown");
  const pid = typeof metadata.pid === "number" ? metadata.pid : undefined;
  const heartbeatHost = typeof metadata.host === "string" ? metadata.host : "";
  const sameHostHeartbeat = heartbeatHost !== "" && heartbeatHost === hostname();
  const staleRunningHeartbeat = recordedStatus === "ok" && metadata.lifecycle === "running" && sameHostHeartbeat && pid !== undefined && !processIsAlive(pid);
  const status = staleRunningHeartbeat ? "idle" : recordedStatus;
  const processed = typeof metadata.processed === "number" ? metadata.processed : 0;
  const checkUpdatedAt = Date.parse(String(check.created_at ?? ""));
  const storedUpdatedAt = storedState?.updatedAt ? Date.parse(storedState.updatedAt) : Number.NaN;
  const storedStateIsNewer = Boolean(storedState && Number.isFinite(storedUpdatedAt) && (!Number.isFinite(checkUpdatedAt) || storedUpdatedAt >= checkUpdatedAt));
  const exactBlocker = storedStateIsNewer ? storedState?.exactBlocker ?? null : null;
  const labels: Record<string, string> = {
    running: "起動中",
    ok: "待機中",
    idle: "停止",
    blocked: "要確認"
  };
  const nextActions: Record<string, string> = {
    running: "このまま待てば、次のqueued runをMac側で処理します。",
    ok: "本番DBにqueued runが入ると、このMac workerが拾います。",
    idle: "自動処理したい時は、Macの本番PostgreSQL接続を確認して npm run worker:loop:stored を起動してください。",
    blocked: "Mac側のworkerログを確認し、同じrun_idから再開してください。"
  };
  return {
    status,
    label: labels[status] ?? "確認",
    detail: exactBlocker ? `Mac worker readback: ${exactBlocker}` : staleRunningHeartbeat ? "Mac worker loopは停止しています。" : String(check.summary ?? "Mac workerの状態を記録しました。"),
    nextAction: storedStateIsNewer && storedState?.nextAction ? storedState.nextAction : nextActions[status] ?? "状態を確認してください。",
    exactBlocker,
    updatedAt: check.created_at ?? null,
    processed,
    usesApiKey: metadata.usesApiKey === true
  };
}

function buildLaunchdLocalWorkerStatus() {
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/com.nichikatanaka.automation-os.worker`], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const running = result.status === 0 && /\bstate = running\b/.test(output);
  return {
    status: running ? "ok" : "idle",
    label: running ? "起動中" : "停止",
    detail: running ? "Mac worker loopはLaunchAgentで起動しています。" : "Mac worker loopは停止しています。",
    nextAction: running
      ? "定期実行または手動実行がqueuedになるとworker loopが拾います。"
      : "自動処理したい時は、Macの本番PostgreSQL接続を確認してworkerを起動してください。",
    updatedAt: null,
    processed: 0,
    usesApiKey: false
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync("kill", ["-0", String(pid)], { encoding: "utf8" });
  return result.status === 0;
}

function getSchedulerStatus() {
  const raw = process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS;
  const intervalMs = researchPlanSchedulerIntervalMs();
  const enabled = intervalMs > 0;
  const running = Boolean(researchPlanSchedulerTimer);
  return {
    enabled,
    running,
    intervalMs,
    label: running ? "自動確認中" : (enabled ? "自動確認準備中" : "自動確認停止中"),
    detail: running
      ? "時刻になった定期実行をこの画面のサーバーが確認します。"
      : enabled
        ? "サーバー起動後に時刻ベースの自動確認を開始します。"
      : "安全のため、時刻ベースの自動確認は停止しています。各行の再生ボタンで一回実行できます。",
    source: raw === undefined || raw.trim() === "" ? "default" : "environment"
  };
}

type PublicRegisteredWorkflowCheckKind = "none" | "billing" | "boundary" | "proof" | "runner" | "schedule";
type PublicRegisteredWorkflowTrustKind = "high" | "medium" | "low" | "unknown";
type PublicRegisteredWorkflowFreshnessKind = "fresh" | "recent" | "stale" | "unknown";
type PublicRegisteredWorkflowSafetyKind = "billing_only" | "review";
type PublicRegisteredWorkflowBoundaryKind = "post" | "submit" | "send" | "auth" | "save" | "review" | "external";

type ApprovalInboxSourceRow = {
  id: string;
  run_id: string | null;
  status: string;
  title: string | null;
  requested_by: string | null;
  resource_locks_json: string | null;
  created_at: string;
  run_name: string | null;
  run_objective: string | null;
  run_metadata_json: string | null;
};

type PublicApprovalActionKind = "publish" | "submit" | "send" | "delete" | "purchase" | "auth" | "pii" | "external" | "approval";

function latestPendingApprovalInboxRows(rows: ApprovalInboxSourceRow[]) {
  const seenWorkflowKeys = new Set<string>();
  const inboxRows: ApprovalInboxSourceRow[] = [];
  for (const row of rows) {
    const workflowKey = approvalInboxWorkflowKey(row);
    if (!workflowKey) {
      inboxRows.push(row);
      continue;
    }
    if (seenWorkflowKeys.has(workflowKey)) continue;
    seenWorkflowKeys.add(workflowKey);
    inboxRows.push(row);
  }
  return inboxRows.slice(0, 12);
}

function approvalInboxWorkflowKey(row: ApprovalInboxSourceRow): string | null {
  const metadata = parseJson<Record<string, unknown>>(row.run_metadata_json ?? "{}", {});
  for (const key of ["registeredWorkflowId", "registered_workflow_id", "workflowId", "workflow_id", "AUTOMATION_OS_REGISTERED_WORKFLOW_ID"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function buildApprovalInbox(rows: ApprovalInboxSourceRow[]) {
  return rows.map((row) => {
    const actionKind = publicApprovalActionKind(row);
    return {
      id: row.id,
      run_id: row.run_id,
      task_label: publicApprovalTaskLabel(row),
      status: row.status,
      action_kind: actionKind,
      action_label: publicApprovalActionLabel(actionKind),
      boundary_label: publicApprovalBoundaryLabel(actionKind),
      execution_label: row.status === "approved" ? "承認済み・実行未確認" : "未実行",
      decision_enabled: row.status === "pending"
    };
  });
}

function buildExternalPreflightChecklist() {
  const writeGuard = getProductionWriteGuardStatus();
  return [
    { key: "billing_only_hard_stop", label: "課金・購入・支払い・決済だけ停止", state: "ok" },
    { key: "evidence_required", label: "外部操作は証跡で確認", state: "ok" },
    { key: "production_write_guard", label: writeGuard.required ? "本番操作を保護中" : "ローカル操作", state: "ok" },
    { key: "public_summary", label: "通常画面は公開要約のみ", state: "ok" }
  ];
}

function publicApprovalTaskLabel(row: ApprovalInboxSourceRow) {
  const publicName = publicAutomationName([row.run_name, row.run_objective, row.title].join(" "));
  if (publicName) return publicName;
  return row.requested_by === "trusted-bridge" ? "外部操作" : "確認";
}

function publicApprovalActionKind(row: ApprovalInboxSourceRow): PublicApprovalActionKind {
  const locks = parseJson<string[]>(row.resource_locks_json, []);
  const text = [row.title, row.run_name, row.run_objective, ...locks].join(" ");
  if (/delete|remove|削除/i.test(text)) return "delete";
  if (/purchase|buy|payment|支払|購入/i.test(text)) return "purchase";
  if (/auth|login|otp|captcha|認証|ログイン/i.test(text)) return "auth";
  if (/pii|personal|個人情報/i.test(text)) return "pii";
  if (/submit|application|応募|提出/i.test(text)) return "submit";
  if (/send|reply|email|gmail|送信|返信/i.test(text)) return "send";
  if (/publish|post|sns|x|linkedin|pinterest|公開|投稿/i.test(text)) return "publish";
  if (/external|bridge|social|外部/i.test(text)) return "external";
  return "approval";
}

function publicApprovalActionLabel(kind: PublicApprovalActionKind) {
  const labels: Record<PublicApprovalActionKind, string> = {
    publish: "投稿/公開",
    submit: "応募/提出",
    send: "送信",
    delete: "削除",
    purchase: "購入",
    auth: "認証",
    pii: "個人情報",
    external: "外部操作",
    approval: "承認"
  };
  return labels[kind];
}

function publicApprovalBoundaryLabel(kind: PublicApprovalActionKind) {
  const labels: Record<PublicApprovalActionKind, string> = {
    publish: "投稿可・課金停止",
    submit: "応募可・課金停止",
    send: "送信可・課金停止",
    delete: "削除は証跡化",
    purchase: "課金前停止",
    auth: "人間入力を証跡化",
    pii: "人間入力を証跡化",
    external: "外部操作可・課金停止",
    approval: "実行可・課金停止"
  };
  return labels[kind];
}

function publicRegisteredWorkflow(workflow: ReturnType<typeof initRegisteredWorkflows>[number], ledgerItem?: CodexAutomationMigrationLedgerItem) {
  const provenance = parseJson<{
    scheduler?: { exactBlocker?: unknown };
    approvalBoundary?: unknown;
    completionBoundary?: unknown;
    safetyContract?: unknown;
  }>(workflow.provenance_json, {});
  const paused = isRegisteredWorkflowSchedulePaused(workflow);
  const effectiveSchedule = getRegisteredWorkflowEffectiveSchedule(workflow);
  const checkKind = registeredWorkflowCheckKind(workflow, provenance, ledgerItem);
  const trustKind = publicRegisteredWorkflowTrustKind(checkKind, ledgerItem);
  const freshnessKind = publicRegisteredWorkflowFreshnessKind(ledgerItem, workflow.updated_at);
  const safetyKind = publicRegisteredWorkflowSafetyKind(provenance);
  const lastAction = publicRegisteredWorkflowLastAction({ paused, checkKind, provenance, ledgerItem });
  const lastRunId = typeof ledgerItem?.latestRunId === "string" && ledgerItem.latestRunId.trim()
    ? ledgerItem.latestRunId.trim()
    : null;
  return {
    id: workflow.id,
    name: publicWorkflowName(workflow),
    status: paused ? "paused" : workflow.status,
    schedule_label: effectiveSchedule.label,
    boundary_label: publicRegisteredWorkflowBoundaryLabel(workflow),
    needs_check: checkKind !== "none",
    check_kind: checkKind,
    check_label: publicCheckLabel(checkKind),
    trust_kind: trustKind,
    trust_label: publicTrustLabel(trustKind),
    freshness_kind: freshnessKind,
    freshness_label: publicFreshnessLabel(freshnessKind),
    safety_kind: safetyKind,
    safety_label: publicSafetyLabel(safetyKind),
    last_action_label: lastAction.action,
    last_result_label: lastAction.result,
    next_action_label: lastAction.next,
    last_run_id: lastRunId,
    next_action_view: publicRegisteredWorkflowNextActionView(lastAction.next, lastRunId)
  };
}

function publicRegisteredWorkflowNextActionView(nextAction: string, lastRunId: string | null) {
  if (/承認|確認画面/.test(nextAction)) return "Approvals";
  if (lastRunId && /履歴|理由|進行状況/.test(nextAction)) return "Runs";
  return "Schedule";
}

function publicRegisteredWorkflowLastAction(input: {
  paused: boolean;
  checkKind: PublicRegisteredWorkflowCheckKind;
  provenance: { scheduler?: { exactBlocker?: unknown } };
  ledgerItem?: CodexAutomationMigrationLedgerItem;
}) {
  if (input.paused) {
    return { action: "停止中", result: "予定を止めています", next: "再開すると動かせます" };
  }
  const schedulerBlocked = typeof input.provenance.scheduler?.exactBlocker === "string" && input.provenance.scheduler.exactBlocker.trim();
  if (schedulerBlocked || input.checkKind === "schedule") {
    return { action: "前回の定期確認", result: "確認が必要", next: "履歴で理由を見る" };
  }
  const status = String(input.ledgerItem?.latestRunStatus ?? "").toLowerCase();
  if (!input.ledgerItem?.latestRunId && !status) {
    return { action: "まだ実行なし", result: "待機中", next: "再生で一回実行" };
  }
  if (["running", "queued", "pending"].includes(status)) {
    return { action: "実行中", result: "進行中", next: "履歴で確認" };
  }
  if (["waiting_approval", "approval_required"].includes(status)) {
    return { action: "承認待ち", result: "確認が必要", next: "承認画面で確認" };
  }
  if (["blocked", "failed", "partial", "cancelled"].includes(status) || input.checkKind !== "none") {
    return { action: "前回の実行", result: "確認が必要", next: "履歴で理由を見る" };
  }
  if (input.ledgerItem?.proofConfirmed || input.ledgerItem?.proofGateOk || input.ledgerItem?.actualOperationConfirmed || input.ledgerItem?.scheduledOperationConfirmed) {
    return { action: "前回の実行", result: "完了記録あり", next: "履歴で確認" };
  }
  return { action: "前回の実行", result: "記録を確認中", next: "履歴で確認" };
}

function runRegisteredWorkflowRehearsalCheck(companyIds: readonly string[]) {
  initRegisteredWorkflows();
  const workflows = listRegisteredWorkflowsForCompanies(companyIds);
  const activeWorkflows = workflows.filter((workflow) => String(workflow.status).toLowerCase() === "active");
  const actorUserId = currentActorUserId();
  const companyRunRows = querySql<CodexAutomationMigrationRunRow>(
    `SELECT id, name, status, objective, created_at, updated_at, metadata_json FROM runs WHERE ${scopedCompanyPredicate("company_id", companyIds)} ORDER BY updated_at DESC LIMIT 500`
  );
  const eligibleGlobalRunPredicate = `(
    company_id IS NULL
    AND json_extract(metadata_json, '$.system_scope')='global'
    AND (
      json_extract(metadata_json, '$.system_admin_actor_user_id')=${sqlValue(actorUserId)}
      OR json_extract(metadata_json, '$.scheduler_service_identity.scope')='global_system'
    )
  )`;
  const eligibleGlobalRunRows = querySql<CodexAutomationMigrationRunRow>(`
    SELECT id, name, status, objective, created_at, updated_at, metadata_json
    FROM runs
    WHERE ${eligibleGlobalRunPredicate}
    ORDER BY updated_at DESC
    LIMIT 500
  `);
  const runRows = [...new Map([...companyRunRows, ...eligibleGlobalRunRows].map((run) => [run.id, run])).values()]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const scopedRunIds = runRows.map((run) => sqlValue(run.id));
  const scopedRunPredicate = scopedRunIds.length > 0 ? `run_id IN (${scopedRunIds.join(", ")})` : "1=0";
  const proofRows = querySql<CodexAutomationMigrationProofRow & { uri?: string }>(
    `SELECT run_id, proof_type, created_at, metadata_json, uri FROM proofs WHERE ${scopedRunPredicate} ORDER BY created_at DESC LIMIT 2000`
  );
  const approvalRows = querySql<CodexAutomationMigrationApprovalRow>(
    `SELECT id, run_id, status, created_at FROM approvals WHERE (${scopedCompanyPredicate("company_id", companyIds)} OR ${scopedRunPredicate}) ORDER BY created_at DESC LIMIT 2000`
  );
  const ledger = buildCodexAutomationMigrationLedger({
    registeredWorkflows: activeWorkflows,
    runs: runRows,
    proofs: proofRows,
    approvals: approvalRows
  });
  const stepRows = querySql<{ run_id: string; status: string; metadata_json: string }>(
    `SELECT run_id, status, metadata_json FROM run_steps WHERE ${scopedRunPredicate} ORDER BY completed_at DESC LIMIT 2000`
  );
  const unsafeRunIds = unsafeExternalActionRunIds({ runs: runRows, steps: stepRows, proofs: proofRows });
  const ledgerByWorkflowId = indexMigrationLedgerByRegisteredWorkflowId(ledger.items);
  const runsById = new Map(runRows.map((run) => [run.id, run]));
  const proofRowsByRunId = groupRowsByRunId(proofRows);
  const rows = activeWorkflows.map((workflow) => {
    const provenance = parseJson<{ safetyContract?: unknown }>(workflow.provenance_json, {});
    const ledgerItem = ledgerByWorkflowId.get(workflow.id);
    const publicRow = publicRegisteredWorkflow(workflow, ledgerItem);
    const contract = publicRunnerSafetyContract(provenance);
    const latestRunId = ledgerItem?.latestRunId;
    const unsafe =
      Boolean(latestRunId && unsafeRunIds.has(latestRunId)) ||
      (publicRow.safety_kind !== "review" && !contract);
    return {
      id: publicRow.id,
      name: publicRow.name,
      status: unsafe ? "unsafe" : publicRow.safety_kind === "review" ? "review_required" : "ok",
      safety_kind: publicRow.safety_kind,
      safety_label: publicRow.safety_label
    };
  });
  const failed = rows.filter((row) => row.status === "unsafe").length;
  const reviewRequired = rows.filter((row) => row.status === "review_required").length;
  const referencePaths = buildSafeReferenceWorkflowPaths(activeWorkflows, ledgerByWorkflowId, runsById, proofRowsByRunId);
  const safetyReferencePathsOk = referencePaths.every((path) => path.stages.safety_canary_verified);
  const referencePathsComplete = referencePaths.every((path) => path.status === "complete");
  const result = {
    ok: failed === 0 && reviewRequired === 0 && safetyReferencePathsOk,
    checked: rows.length,
    failed,
    review_required: reviewRequired,
    labels: rows.map((row) => `${row.name}:${row.safety_label}`),
    workflows: rows,
    safety_reference_paths_ok: safetyReferencePathsOk,
    reference_paths_complete: referencePathsComplete,
    reference_paths_ok: referencePathsComplete,
    reference_paths: referencePaths,
    external_action_executed: false
  };
  const status = failed > 0 || !safetyReferencePathsOk ? "blocked" : reviewRequired > 0 ? "review_required" : "ok";
  const systemCheckResult = {
    ok: result.ok,
    checked: result.checked,
    failed: result.failed,
    review_required: result.review_required,
    safety_reference_paths_ok: result.safety_reference_paths_ok,
    reference_paths_complete: result.reference_paths_complete,
    reference_paths_ok: result.reference_paths_ok,
    external_action_executed: false
  };
  insert("system_checks", {
    id: makeId("registered_rehearsal"),
    kind: "registered_workflow_rehearsal",
    status,
    target_url: null,
    summary:
      failed > 0
        ? "定期リハーサルで外部操作の確認が必要です"
        : !safetyReferencePathsOk
          ? "定期リハーサルで参照フローの安全境界が不足しています"
        : reviewRequired > 0
          ? "定期リハーサルに確認が必要です"
          : referencePathsComplete
            ? "定期リハーサルと参照フローの実行証跡を確認しました"
            : "定期リハーサルは外部操作なしで安全停止を確認しました。実運用完了は未確認です",
    artifact_uri: null,
    created_at: nowIso(),
    metadata_json: systemCheckResult
  });
  return result;
}

function buildSafeReferenceWorkflowPaths(
  workflows: RegisteredWorkflowRow[],
  ledgerByWorkflowId: Map<string, CodexAutomationMigrationLedgerItem>,
  runsById: Map<string, CodexAutomationMigrationRunRow>,
  proofRowsByRunId: Map<string, Array<CodexAutomationMigrationProofRow & { uri?: string }>>
) {
  const references = [
    { id: "daily-ai-research-publish-run", name: "Daily AI", adapter: "daily_ai_registered" as const, completion: "approved_publish_requires_readback" },
    { id: "job-application-manager", name: "Job Application Manager", adapter: "job_submit_registered" as const, completion: "approved_submit_requires_readback" },
    { id: "nisenprints-daily-product-canva-printify-etsy-pinterest", name: "NisenPrints", adapter: "nisenprints_registered" as const, completion: "approved_publish_requires_readback" }
  ];
  const canaryPaths = readFreshReferenceWorkflowCanary();
  return references.map((reference) => {
    const workflow = workflows.find((item) => item.id === reference.id);
    const provenance = workflow ? parseJson<any>(workflow.provenance_json, {}) : {};
    const safety = provenance.safetyContract ?? {};
    const policy = resolveWorkerAdapterPolicy(reference.adapter);
    const schedule = workflow ? parseJson<Record<string, unknown>>(workflow.schedule_json, {}) : {};
    const ledgerItem = ledgerByWorkflowId.get(reference.id);
    const currentDefinitionFingerprint = workflow
      ? referenceWorkflowDefinitionFingerprint(workflow)
      : null;
    const currentScheduleFingerprint = workflow
      ? referenceWorkflowScheduleFingerprint(workflow)
      : null;
    const canaryPath = canaryPaths?.get(reference.id);
    const safetyCanaryVerified = Boolean(
      canaryPath &&
      canaryPath.definitionFingerprint === currentDefinitionFingerprint &&
      canaryPath.scheduleFingerprint === currentScheduleFingerprint
    );
    const completionRun = ledgerItem?.latestRunId ? runsById.get(ledgerItem.latestRunId) : undefined;
    const completionRunStart = completionRun
      ? asRecord(parseJson<Record<string, unknown>>(completionRun.metadata_json, {}).registered_workflow_start)
      : {};
    const completionProofs = completionRun ? proofRowsByRunId.get(completionRun.id) ?? [] : [];
    const completionLineageVerified = Boolean(
      workflow &&
      completionRun &&
      completionRunStart.workflow_id === workflow.id &&
      completionRunStart.definition_fingerprint === currentDefinitionFingerprint &&
      completionRunStart.schedule_fingerprint === currentScheduleFingerprint &&
      completionProofs.some((proof) => {
        const proofStart = asRecord(parseJson<Record<string, unknown>>(proof.metadata_json ?? "{}", {}).registered_workflow_start);
        return proofStart.workflow_id === workflow.id &&
          proofStart.definition_fingerprint === currentDefinitionFingerprint &&
          proofStart.schedule_fingerprint === currentScheduleFingerprint;
      })
    );
    const completionVerified =
      ledgerItem?.actualOperationConfirmed === true &&
      ledgerItem.proofConfirmed === true &&
      completionLineageVerified;
    const stages = {
      definition_registered: Boolean(workflow && workflow.status === "active"),
      schedule_registered: schedule.kind === "cron" && typeof schedule.rrule === "string" && schedule.rrule.trim() !== "",
      route_guarded: workflow?.runner_kind === reference.adapter && policy.exactBlocker === "in_app_browser_required",
      approval_boundary: safety.externalActionBoundary === "billing_purchase_payment_checkout_hard_stop"
        && Array.isArray(safety.humanInputRequiredWithEvidence)
        && ["captcha", "otp", "security_code", "identity_verification"].every((item) => safety.humanInputRequiredWithEvidence.includes(item)),
      completion_contract: provenance.completionBoundary === reference.completion,
      no_external_action: safety.externalActionExecutedByRehearsal === false,
      safety_canary_verified: safetyCanaryVerified,
      worker_outcome_verified: ledgerItem?.actualOperationConfirmed === true,
      operation_proof_verified: ledgerItem?.proofConfirmed === true,
      completion_lineage_verified: completionLineageVerified,
      completion_verified: completionVerified
    };
    const contractShapeReady =
      stages.definition_registered &&
      stages.schedule_registered &&
      stages.route_guarded &&
      stages.approval_boundary &&
      stages.completion_contract &&
      stages.no_external_action;
    return {
      id: reference.id,
      name: reference.name,
      status: !contractShapeReady
        ? "blocked"
        : completionVerified
          ? stages.safety_canary_verified
            ? "complete"
            : "contract_shape_ready"
          : stages.safety_canary_verified
            ? "proof_backed_safe_stop_verified"
            : "contract_shape_ready",
      stages
    };
  });
}

function readFreshReferenceWorkflowCanary(): Map<string, { definitionFingerprint: string; scheduleFingerprint: string }> | undefined {
  const receiptPath = process.env.AUTOMATION_OS_REFERENCE_CANARY_RECEIPT?.trim();
  if (!receiptPath || !isAbsolute(receiptPath) || !existsSync(receiptPath)) return undefined;
  try {
    const receipt = parseJson<any>(readFileSync(receiptPath, "utf8"), {});
    const generatedAt = Date.parse(String(receipt.generated_at ?? ""));
    const maxAgeMs = Math.min(
      boundedPositiveInteger(process.env.AUTOMATION_OS_REFERENCE_CANARY_MAX_AGE_MS, 24 * 60 * 60 * 1000),
      24 * 60 * 60 * 1000
    );
    const ageMs = Date.now() - generatedAt;
    if (
      receipt.schema !== "automation_os_reference_workflow_canary.v2" ||
      receipt.ok !== true ||
      receipt.safety_reference_paths_ok !== true ||
      receipt.reference_paths_complete !== false ||
      receipt.external_action_executed !== false ||
      receipt.mode !== "isolated_sqlite_proof_backed_safe_stop_canary" ||
      receipt.scope?.database !== "ephemeral_tmp" ||
      receipt.scope?.artifacts !== "ephemeral_tmp" ||
      receipt.scope?.approval_model !== "billing_only_no_start_approval" ||
      !Number.isFinite(generatedAt) ||
      ageMs < -5 * 60 * 1000 ||
      ageMs > maxAgeMs ||
      !Array.isArray(receipt.paths) ||
      receipt.paths.length !== 3
    ) return undefined;
    const expected = new Map([
      ["daily-ai-research-publish-run", "daily_ai_registered"],
      ["job-application-manager", "job_submit_registered"],
      ["nisenprints-daily-product-canva-printify-etsy-pinterest", "nisenprints_registered"]
    ]);
    const verified = new Map<string, { definitionFingerprint: string; scheduleFingerprint: string }>();
    const runIds = new Set<string>();
    for (const path of receipt.paths) {
      if (!path || typeof path !== "object") return undefined;
      const id = String(path.id ?? "");
      const runId = String(path.run_id ?? "").trim();
      if (
        expected.get(id) !== path.adapter ||
        !runId ||
        runIds.has(runId) ||
        path.status !== "proof_backed_safe_stop_verified" ||
        path.exact_blocker !== "in_app_browser_required" ||
        path.run_blocked !== true ||
        path.step_blocked !== true ||
        path.proof_gate_ok !== false ||
        path.runner_exit_status !== null ||
        path.runner_started !== false ||
        path.runner_completed !== false ||
        path.external_action_executed !== false ||
        path.idempotent_recheck !== true ||
        path.approval_boundary_verified !== true ||
        path.company_scope_verified !== true ||
        path.start_lineage_verified !== true ||
        path.worker_blocked_event_verified !== true ||
        path.safety_proof_verified !== true ||
        path.completion_claimed !== false ||
        path.operation_proof_gate_ok !== false ||
        !/^[a-f0-9]{64}$/.test(String(path.definition_fingerprint ?? "")) ||
        !/^[a-f0-9]{64}$/.test(String(path.schedule_fingerprint ?? ""))
      ) return undefined;
      verified.set(id, {
        definitionFingerprint: String(path.definition_fingerprint),
        scheduleFingerprint: String(path.schedule_fingerprint)
      });
      runIds.add(runId);
    }
    return verified.size === expected.size && runIds.size === expected.size ? verified : undefined;
  } catch {
    return undefined;
  }
}

function referenceWorkflowDefinitionFingerprint(workflow: RegisteredWorkflowRow): string {
  return createHash("sha256").update(JSON.stringify({
    id: workflow.id,
    status: workflow.status,
    runner_kind: workflow.runner_kind,
    start_command_json: workflow.start_command_json,
    source_refs_json: workflow.source_refs_json,
    provenance_json: workflow.provenance_json
  })).digest("hex");
}

function referenceWorkflowScheduleFingerprint(workflow: RegisteredWorkflowRow): string {
  return createHash("sha256").update(JSON.stringify({ schedule_json: workflow.schedule_json })).digest("hex");
}

function proofMetadataHasExternalAction(value: unknown): boolean {
  return externalActionFlagTrue(parseJson<unknown>(value, value));
}

function externalActionFlagTrue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(externalActionFlagTrue);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, item]) => {
    if (key === "externalActionExecutedByRehearsal" && item === true) return true;
    if (/^(billing|payment|purchase).*executed$/i.test(key) && item === true) return true;
    if (/^(billing|payment|purchase).*attempted$/i.test(key) && item === true) return true;
    return externalActionFlagTrue(item);
  });
}

function unsafeExternalActionRunIds(input: {
  runs: Array<{ id: string; metadata_json: string }>;
  steps: Array<{ run_id: string; metadata_json: string }>;
  proofs: Array<{ run_id: string; metadata_json?: string; uri?: string | null }>;
}) {
  const ids = new Set<string>();
  for (const run of input.runs) {
    if (proofMetadataHasExternalAction(run.metadata_json)) ids.add(run.id);
  }
  for (const step of input.steps) {
    if (proofMetadataHasExternalAction(step.metadata_json)) ids.add(step.run_id);
  }
  for (const proof of input.proofs) {
    if (proofMetadataHasExternalAction(proof.metadata_json) || proofArtifactHasExternalAction(proof.uri)) ids.add(proof.run_id);
  }
  return ids;
}

function proofArtifactHasExternalAction(uri: string | null | undefined): boolean {
  if (!uri?.startsWith("file://")) return false;
  try {
    const path = fileURLToPath(uri);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    return proofMetadataHasExternalAction(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function groupRowsByRunId<T extends { run_id: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    grouped.set(row.run_id, [...(grouped.get(row.run_id) ?? []), row]);
  }
  return grouped;
}

function registeredWorkflowAllowlist(): Set<string> | null {
  const raw = process.env.AUTOMATION_OS_REGISTERED_WORKFLOW_ALLOWLIST ?? "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function filterRegisteredWorkflowList<T extends { id: string }>(workflows: T[]): T[] {
  const allowlist = registeredWorkflowAllowlist();
  if (!allowlist) return workflows;
  return workflows.filter((workflow) => allowlist.has(workflow.id));
}

function publicRegisteredWorkflowRows(workflows: ReturnType<typeof initRegisteredWorkflows>) {
  const visibleWorkflows = filterRegisteredWorkflowList(workflows);
  const ledgerByWorkflowId = publicRegisteredWorkflowLedgerByWorkflowId(visibleWorkflows);
  return visibleWorkflows.map((workflow) => publicRegisteredWorkflow(workflow, ledgerByWorkflowId.get(workflow.id)));
}

function publicRegisteredWorkflowById(id: string) {
  const workflows = readRegisteredWorkflowRows();
  const workflow = workflows.find((item) => item.id === id);
  if (!workflow) return null;
  const ledgerByWorkflowId = publicRegisteredWorkflowLedgerByWorkflowId(workflows);
  return publicRegisteredWorkflow(workflow, ledgerByWorkflowId.get(workflow.id));
}

const REGISTERED_AUTOMATION_EXTERNAL_BOUNDARY = "external_post_send_delete_submit_publish_auth_captcha_otp_payment_gate";

function buildScopedRegisteredAutomationLedger(companyId: string, workflows: ReturnType<typeof listRegisteredWorkflowsForCompanies>) {
  const companyPredicate = scopedCompanyPredicate("company_id", [companyId]);
  const runs = querySql<CodexAutomationMigrationRunRow>(`
    SELECT id, name, status, objective, created_at, updated_at, metadata_json
    FROM runs
    WHERE ${companyPredicate}
    ORDER BY updated_at DESC
    LIMIT 500
  `);
  const runIds = runs.map((run) => sqlValue(run.id));
  const runPredicate = runIds.length ? `run_id IN (${runIds.join(", ")})` : "1=0";
  const proofs = querySql<CodexAutomationMigrationProofRow>(`
    SELECT run_id, proof_type, created_at, metadata_json
    FROM proofs
    WHERE ${runPredicate} AND ${companyPredicate.replace("company_id", "proofs.company_id")}
    ORDER BY created_at DESC
    LIMIT 2000
  `);
  const approvals = querySql<CodexAutomationMigrationApprovalRow>(`
    SELECT id, run_id, status, created_at
    FROM approvals
    WHERE ${companyPredicate.replace("company_id", "approvals.company_id")}
    ORDER BY created_at DESC
    LIMIT 2000
  `);
  return indexMigrationLedgerByRegisteredWorkflowId(buildCodexAutomationMigrationLedger({
    registeredWorkflows: workflows,
    runs,
    proofs,
    approvals
  }).items);
}

function buildCompanyRegisteredAutomationReadback(projectId: string) {
  initRegisteredWorkflows();
  const workflows = filterRegisteredWorkflowList(listRegisteredWorkflowsForCompanies([projectId]));
  const ledgerByWorkflowId = buildScopedRegisteredAutomationLedger(projectId, workflows);
  const automations = workflows.map((workflow) => {
    const ledger = ledgerByWorkflowId.get(workflow.id);
    const paused = isRegisteredWorkflowSchedulePaused(workflow);
    const latestProof = ledger && ledger.latestProofTypes.length > 0 && ledger.evidenceUpdatedAt
      ? {
          status: ledger.proofConfirmed ? "confirmed" : "stored",
          checked_at: ledger.evidenceUpdatedAt,
          source_ref: null
        }
      : null;
    return {
      id: workflow.id,
      name: publicWorkflowName(workflow),
      kind: workflow.schedule_json ? parseJson<{ kind?: unknown }>(workflow.schedule_json, {}).kind ?? "registered" : "registered",
      status: paused ? "paused" : workflow.status,
      execution_class: "registered_runner_readback",
      allowed_action: "preflight_readiness_only",
      blocked_action: REGISTERED_AUTOMATION_EXTERNAL_BOUNDARY,
      preflight_status: paused ? "schedule_paused" : "readiness_pass_side_effect_blocked",
      execution_environment: "local runner",
      toml_ref: null,
      cwds: [],
      has_prompt: Boolean(workflow.start_command_json && workflow.start_command_json !== "{}"),
      can_run: false,
      exact_blocker: paused ? "registered_automation_schedule_paused" : "registered_automation_local_runner_not_wired_to_http",
      ui_action: "read-only preflight",
      action_label: "read-only preflight",
      resume_condition: paused
        ? "この定期実行を再開してから、local runnerのreadbackを確認してください。"
        : "local runnerでpreflightを実行し、proof/readbackを確認してください。HTTP APIから外部作用は開始しません。",
      latest_proof: latestProof,
      portable: (() => {
        const portableId = portableWorkflowIdForWorkerAdapter(workflow.runner_kind);
        const manifest = portableId ? portableWorkflowManifests[portableId] : undefined;
        return portableId && manifest
          ? {
              supported: true,
              workflow_id: portableId,
              execution_mode: portableWorkerExecutionMode(),
              external_runner_configured: Boolean(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER?.trim()),
              app_dependency: false,
              browser_surface: manifest.execution.browser_surface,
              connector_gateway: manifest.execution.connector_gateway,
              external_effect_policy: manifest.external_effect_policy,
              manual_endpoint: `/api/portable-workflows/${portableId}/run`,
              schedule_admission: portableWorkerExecutionMode() === PORTABLE_WORKER_CANARY_MODE || portableWorkerExecutionMode() === PORTABLE_WORKER_EXTERNAL_MODE
            }
          : { supported: false, exact_blocker: "portable_workflow_manifest_missing" };
      })()
    };
  });
  return {
    ok: true,
    read_only: true,
    project_id: projectId,
    external_action_executed: false,
    exact_boundary: REGISTERED_AUTOMATION_EXTERNAL_BOUNDARY,
    source_ref: null,
    preflight_source_ref: null,
    latest_proof_source_ref: null,
    inventory_run_id: null,
    preflight_run_id: null,
    latest_proof_run_id: null,
    safety_boundary: "read-only preflight; 外部投稿・応募・削除・送信・公開・認証突破・課金はHTTPから開始しない",
    automation_count: automations.length,
    checks: [
      { id: "company_scoped_registered_workflows", status: "pass" },
      { id: "external_actions_http_blocked", status: "pass" }
    ],
    automations
  };
}

function buildCompanyRegisteredAutomationRunResponse(automationId: string, projectId: string): { statusCode?: number; body: Record<string, unknown> } {
  initRegisteredWorkflows();
  const workflows = filterRegisteredWorkflowList(listRegisteredWorkflowsForCompanies([projectId]));
  const workflow = workflows.find((item) => item.id === automationId);
  if (!workflow) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        read_only: true,
        project_id: projectId,
        automation_id: automationId,
        external_action_executed: false,
        exact_blocker: "registered_automation_not_found"
      }
    };
  }
  const paused = isRegisteredWorkflowSchedulePaused(workflow);
  return {
    body: {
      ok: false,
      read_only: true,
      project_id: projectId,
      automation_id: automationId,
      external_action_executed: false,
      exact_blocker: paused ? "registered_automation_schedule_paused" : "registered_automation_local_runner_not_wired_to_http",
      resume_condition: paused
        ? "この定期実行を再開してから、local runnerのreadbackを確認してください。"
        : "Use the local operator runner and artifact readback instead of server-side HTTP execution.",
      ui_action: "read-only preflight"
    }
  };
}

function readRegisteredWorkflowRows(): ReturnType<typeof initRegisteredWorkflows> {
  return querySql<ReturnType<typeof initRegisteredWorkflows>[number]>("SELECT * FROM registered_workflows ORDER BY id;");
}

function publicRegisteredWorkflowLedgerByWorkflowId(workflows: ReturnType<typeof initRegisteredWorkflows>) {
  const ledger = buildCodexAutomationMigrationLedger({
    registeredWorkflows: workflows,
    runs: querySql<CodexAutomationMigrationRunRow>("SELECT id, name, status, objective, created_at, updated_at, metadata_json FROM runs ORDER BY updated_at DESC LIMIT 500"),
    proofs: querySql<CodexAutomationMigrationProofRow>("SELECT run_id, proof_type, created_at, metadata_json FROM proofs ORDER BY created_at DESC LIMIT 2000"),
    approvals: querySql<CodexAutomationMigrationApprovalRow>("SELECT id, run_id, status, created_at FROM approvals ORDER BY created_at DESC LIMIT 2000")
  });
  return indexMigrationLedgerByRegisteredWorkflowId(ledger.items);
}

function registeredWorkflowCheckKind(
  workflow: ReturnType<typeof initRegisteredWorkflows>[number],
  provenance: { scheduler?: { exactBlocker?: unknown }; approvalBoundary?: unknown; completionBoundary?: unknown },
  ledgerItem?: CodexAutomationMigrationLedgerItem
): PublicRegisteredWorkflowCheckKind {
  if (typeof provenance.scheduler?.exactBlocker === "string" && provenance.scheduler.exactBlocker.trim()) return "schedule";
  if ((ledgerItem?.latestRunStatus === "waiting_approval" || ledgerItem?.latestRunStatus === "approval_required") && billingHardStopText(ledgerItem?.remainingBlocker)) return "billing";
  const ledgerBlockerKind = ledgerItem ? migrationLedgerCheckKind(ledgerItem) : "none";
  if (ledgerBlockerKind !== "none") return ledgerBlockerKind;
  if (workflow.runner_status && workflow.runner_status !== "connected") return "runner";
  return "none";
}

function migrationLedgerCheckKind(item: CodexAutomationMigrationLedgerItem): PublicRegisteredWorkflowCheckKind {
  if (actionableMigrationBlocker(item.remainingBlocker)) return blockerCheckKind(item.remainingBlocker);
  if (item.runnerStatus && item.runnerStatus !== "connected") return "runner";
  if (blockedStatus(item.workflowStatus) || blockedStatus(item.latestRunStatus)) return "runner";
  if (item.missingProofs.some(actionableMigrationBlocker)) return "proof";
  return "none";
}

function blockerCheckKind(value: string | null): PublicRegisteredWorkflowCheckKind {
  const blocker = String(value ?? "").trim();
  if (!blocker) return "none";
  if (/scheduler|schedule|due|timeout/i.test(blocker)) return "schedule";
  if (billingHardStopText(blocker)) return "billing";
  if (/auth_required|login_required|approval/i.test(blocker)) return "proof";
  if (/runner|not_connected|connection|browser_use|cdp/i.test(blocker)) return "runner";
  if (/missing_proofs|proof|artifact|record|evidence|manifest/i.test(blocker)) return "proof";
  if (/boundary|external|publish|submit|send|post|commit/i.test(blocker)) return "boundary";
  return "proof";
}

function billingHardStopText(value: unknown): boolean {
  return /billing|purchase|payment|checkout|課金|購入|支払い|決済/i.test(String(value ?? ""));
}

function hasPublicBoundary(provenance: { approvalBoundary?: unknown; completionBoundary?: unknown }): boolean {
  return typeof provenance.approvalBoundary === "string" || typeof provenance.completionBoundary === "string";
}

function publicCheckLabel(kind: PublicRegisteredWorkflowCheckKind) {
  const labels: Record<PublicRegisteredWorkflowCheckKind, string> = {
    none: "OK",
    billing: "課金確認",
    boundary: "境界",
    proof: "記録",
    runner: "接続",
    schedule: "予定"
  };
  return labels[kind];
}

function publicRegisteredWorkflowTrustKind(
  checkKind: PublicRegisteredWorkflowCheckKind,
  ledgerItem?: CodexAutomationMigrationLedgerItem
): PublicRegisteredWorkflowTrustKind {
  if (checkKind === "runner" || checkKind === "schedule" || checkKind === "proof") return "low";
  if (checkKind === "billing" || checkKind === "boundary") return "medium";
  if (ledgerItem?.proofConfirmed || ledgerItem?.proofGateOk || ledgerItem?.scheduledOperationConfirmed) return "high";
  return "unknown";
}

function publicTrustLabel(kind: PublicRegisteredWorkflowTrustKind) {
  const labels: Record<PublicRegisteredWorkflowTrustKind, string> = {
    high: "信頼",
    medium: "境界",
    low: "要確認",
    unknown: "未確認"
  };
  return labels[kind];
}

function publicRegisteredWorkflowFreshnessKind(
  ledgerItem: CodexAutomationMigrationLedgerItem | undefined,
  workflowUpdatedAt: string
): PublicRegisteredWorkflowFreshnessKind {
  const evidenceUpdatedAt = ledgerItem?.evidenceUpdatedAt && ledgerItem.evidenceUpdatedAt !== workflowUpdatedAt ? ledgerItem.evidenceUpdatedAt : null;
  const evidenceAt = evidenceUpdatedAt ?? ledgerItem?.latestRunAt ?? null;
  if (!evidenceAt) return "unknown";
  const evidenceTime = Date.parse(evidenceAt);
  if (!Number.isFinite(evidenceTime)) return "unknown";
  const ageMs = Date.now() - evidenceTime;
  if (ageMs < 0) return "fresh";
  if (ageMs <= 24 * 60 * 60 * 1000) return "fresh";
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return "recent";
  return "stale";
}

function publicFreshnessLabel(kind: PublicRegisteredWorkflowFreshnessKind) {
  const labels: Record<PublicRegisteredWorkflowFreshnessKind, string> = {
    fresh: "新",
    recent: "最近",
    stale: "古い",
    unknown: "未"
  };
  return labels[kind];
}

function publicRegisteredWorkflowSafetyKind(provenance: { safetyContract?: unknown; approvalBoundary?: unknown; completionBoundary?: unknown }): PublicRegisteredWorkflowSafetyKind {
  const contract = publicRunnerSafetyContract(provenance);
  if (contract?.publicKind === "approval_gated" || contract?.publicKind === "billing_only_hard_stop" || hasPublicBoundary(provenance)) return "billing_only";
  return "review";
}

function publicRegisteredWorkflowBoundaryLabel(workflow: { id: string; name: string; runner_kind?: string | null; start_command_json?: string | null }) {
  const kind = publicRegisteredWorkflowBoundaryKind(workflow);
  const labels: Record<PublicRegisteredWorkflowBoundaryKind, string> = {
    post: "投稿可・課金停止",
    submit: "応募可・課金停止",
    send: "送信可・課金停止",
    auth: "人間入力を証跡化",
    save: "保存可・課金停止",
    review: "確認",
    external: "外部操作可・課金停止"
  };
  return labels[kind];
}

function publicRegisteredWorkflowBoundaryKind(workflow: { id: string; name: string; runner_kind?: string | null; start_command_json?: string | null }): PublicRegisteredWorkflowBoundaryKind {
  if (isResearchPlanRegisteredWorkflow(workflow)) return "review";
  const text = [workflow.id, workflow.name, workflow.runner_kind, workflow.start_command_json].join(" ");
  if (/job[-_ ]?application[-_ ]?follow[-_ ]?up|post[- ]application|follow[- ]up|job_followup|応募後/i.test(text)) return "send";
  if (/job[-_ ]?application|job_submit|submit queue|応募/i.test(text)) return "submit";
  if (/x[-_ ]?authenticated[-_ ]?browser[-_ ]?lane|x authenticated browser lane|\bX\b/i.test(text)) return "auth";
  if (/prompt[-_ ]?transfer|prompt_transfer|転記/i.test(text)) return "save";
  if (/research[-_ ]?plan|research_plan|automation os|morning|朝|毎朝/i.test(text)) return "review";
  if (/daily[-_ ]?ai|daily ai|sns[-_ ]?multi[-_ ]?poster|sns multi poster|\bSNS\b|nisenprints|etsy|printify|pinterest|新規公開/i.test(text)) return "post";
  return "external";
}

function publicRunnerSafetyContract(provenance: { safetyContract?: unknown }): { publicKind?: unknown; publicLabel?: unknown } | undefined {
  return provenance.safetyContract && typeof provenance.safetyContract === "object" && !Array.isArray(provenance.safetyContract)
    ? (provenance.safetyContract as { publicKind?: unknown; publicLabel?: unknown })
    : undefined;
}

function publicSafetyLabel(kind: PublicRegisteredWorkflowSafetyKind) {
  const labels: Record<PublicRegisteredWorkflowSafetyKind, string> = {
    billing_only: "課金停止",
    review: "確認"
  };
  return labels[kind];
}

function publicWorkflowName(workflow: { id: string; name: string; runner_kind?: string | null; start_command_json?: string | null }) {
  if (isResearchPlanRegisteredWorkflow(workflow)) return "朝チェック";
  const text = `${workflow.id} ${workflow.name}`;
  const publicName = publicAutomationName(text);
  if (publicName) return publicName;
  return "定期";
}

function isResearchPlanRegisteredWorkflow(workflow: { runner_kind?: string | null; start_command_json?: string | null }) {
  if (workflow.runner_kind === "research_plan_registered") return true;
  const command = parseJson<{ source?: unknown }>(workflow.start_command_json ?? "{}", {});
  return command.source === "research_plan";
}

function publicAutomationName(value: string) {
  if (/post[- ]application|follow[- ]up|応募後/i.test(value)) return "応募後";
  if (/daily[-_ ]?ai|daily ai/i.test(value)) return "Daily AI";
  if (/job[-_ ]?application|job application|submit queue|応募/i.test(value)) return "応募";
  if (/nisenprints|etsy|printify|pinterest|新規公開/i.test(value)) return "NisenPrints";
  if (/sns[-_ ]?multi[-_ ]?poster|sns multi poster|\bSNS\b/i.test(value)) return "SNS";
  if (/x[-_ ]?authenticated[-_ ]?browser[-_ ]?lane|x authenticated browser lane|\bX\b/i.test(value)) return "X";
  if (/prompt[-_ ]?transfer|ukiyoe|転記/i.test(value)) return "転記";
  if (/automation os|morning|research[-_ ]?plan|朝|毎朝/i.test(value)) return "朝チェック";
  return "";
}

function indexMigrationLedgerByRegisteredWorkflowId(items: CodexAutomationMigrationLedgerItem[]): Map<string, CodexAutomationMigrationLedgerItem> {
  const index = new Map<string, CodexAutomationMigrationLedgerItem>();
  for (const item of items) {
    if (item.registeredWorkflowId) index.set(item.registeredWorkflowId, item);
  }
  return index;
}

function migrationLedgerItemNeedsCheck(item?: CodexAutomationMigrationLedgerItem): boolean {
  if (!item) return false;
  if (actionableMigrationBlocker(item.remainingBlocker)) return true;
  if (item.runnerStatus && item.runnerStatus !== "connected") return true;
  if (blockedStatus(item.workflowStatus) || blockedStatus(item.latestRunStatus)) return true;
  return item.missingProofs.some(actionableMigrationBlocker);
}

function actionableMigrationBlocker(value: string | null): boolean {
  if (!value) return false;
  const blocker = value.trim();
  if (!blocker) return false;
  if (!blocker.startsWith("missing_proofs:")) return true;
  return blocker
    .slice("missing_proofs:".length)
    .split(",")
    .some((proof) => /runner|not_connected|blocked|timeout|failed|error|auth_required|login_required|approval_required/i.test(proof));
}

function blockedStatus(value: string | null): boolean {
  return typeof value === "string" && /blocked|failed|error|not_connected/i.test(value);
}

export function setYouTubeTranscriptCaptureRunnerForTests(runner: typeof runYouTubeTranscriptCapture): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("test_only_youtube_transcript_capture_runner");
  youtubeTranscriptCaptureRunner = runner;
}

export function resetYouTubeTranscriptCaptureRunnerForTests(): void {
  youtubeTranscriptCaptureRunner = runYouTubeTranscriptCapture;
}

export function setResearchPlanDemoRunnerForTests(runner: typeof runBrowserUseLocalCheckAsync): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("test_only_research_plan_demo_runner");
  researchPlanDemoRunner = runner;
}

export function resetResearchPlanDemoRunnerForTests(): void {
  researchPlanDemoRunner = runBrowserUseLocalCheckAsync;
}

export function setResearchPlanStartRunnerForTests(runner: typeof startCommandRun): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("test_only_research_plan_start_runner");
  researchPlanStartRunner = runner;
}

export function resetResearchPlanStartRunnerForTests(): void {
  researchPlanStartRunner = startCommandRun;
}

export function getRunDetail(runId: string, companyIds?: readonly string[]) {
  if (!companyIds) normalizeReceiptOnlyRuns();
  const rawRun = companyIds ? findScopedRun(runId, companyIds) : querySql(`SELECT * FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const run = rawRun ? sanitizeDashboardRows([rawRun])[0] : undefined;
  if (!run) return undefined;
  const companyId = String((rawRun as Record<string, unknown>).company_id ?? "");
  const metadata = parseJson<Record<string, unknown>>(typeof run.metadata_json === "string" ? run.metadata_json : "{}", {});
  const executionRouting =
    metadata.execution_routing && typeof metadata.execution_routing === "object" ? metadata.execution_routing : null;

  return {
    run,
    executionRouting,
    steps: sanitizeDashboardRows(
      querySql(`SELECT * FROM run_steps WHERE run_id=${sqlValue(runId)} ORDER BY COALESCE(started_at, completed_at, '') ASC LIMIT 500`)
    ),
    proofs: sanitizeDashboardRows(querySql(companyIds
      ? `SELECT * FROM proofs WHERE run_id=${sqlValue(runId)} AND company_id=${sqlValue(companyId)} ORDER BY created_at ASC LIMIT 1000`
      : `SELECT * FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC LIMIT 1000`)),
    children: sanitizeDashboardRows(querySql(`SELECT * FROM child_runs WHERE parent_run_id=${sqlValue(runId)} ORDER BY created_at ASC LIMIT 1000`)),
    workerEvents: sanitizeDashboardRows(
      querySql(`SELECT * FROM worker_events WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC LIMIT 2000`)
    )
  };
}

type ProofViewStatus = "ok" | "blocked" | "not_found";
type ProofViewRow = {
  id: string;
  company_id: string;
  run_id: string;
  step_id: string | null;
  proof_type: string;
  label: string;
  uri: string;
  size_bytes: number;
  created_at: string;
  metadata_json: string;
};

const proofPreviewMaxBytes = 64 * 1024;
const proofPreviewMaxChars = 4000;
const proofViewMaxBytes = 1024 * 1024;
const proofTextMimeTypes = new Set(["application/json", "text/plain", "text/markdown", "text/html", "text/css", "text/csv", "application/xml"]);
const proofImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const proofArtifactRootNames = ["data/artifacts", "artifacts", "output/playwright", ".playwright-cli"];

export function getProofView(proofId: string, companyIds?: readonly string[]) {
  const proof = companyIds
    ? findScopedProof(proofId, companyIds) as ProofViewRow | undefined
    : querySql<ProofViewRow>(`SELECT * FROM proofs WHERE id=${sqlValue(proofId)} LIMIT 1`)[0];
  if (!proof) return { status: "not_found" as ProofViewStatus, id: proofId, error: "proof_not_found" };

  const base = publicProofViewBase(proof);
  const target = resolveProofTarget(proof);
  if (!target.ok) return { ...base, status: "blocked" as ProofViewStatus, blocked_reason: target.reason };

  let stats;
  try {
    stats = statSync(target.path);
  } catch {
    return { ...base, status: "blocked" as ProofViewStatus, blocked_reason: "file_unavailable" };
  }
  if (!stats.isFile()) return { ...base, status: "blocked" as ProofViewStatus, blocked_reason: "not_a_file" };
  if (stats.size > proofViewMaxBytes) {
    return {
      ...base,
      status: "blocked" as ProofViewStatus,
      blocked_reason: "file_too_large",
      size_bytes: stats.size,
      max_size_bytes: proofViewMaxBytes
    };
  }

  const mime = proofMimeType(target.path);
  const common = { ...base, status: "ok" as ProofViewStatus, size_bytes: stats.size, mime_type: mime, saved: "保存記録あり" };
  if (proofImageMimeTypes.has(mime)) {
    return { ...common, preview_kind: "image", image: imageMetadata(target.path, mime) };
  }
  if (proofTextMimeTypes.has(mime) || mime.startsWith("text/")) {
    const buffer = readFileSync(target.path);
    return {
      ...common,
      preview_kind: mime === "application/json" ? "json" : "text",
      preview: redactProofPreview(buffer.toString("utf8").slice(0, proofPreviewMaxBytes)),
      truncated: buffer.length > proofPreviewMaxBytes
    };
  }
  return { ...common, status: "blocked" as ProofViewStatus, blocked_reason: "unsupported_file_type", preview_kind: "unsupported" };
}

function publicProofViewBase(proof: ProofViewRow) {
  return {
    id: proof.id,
    run_id: proof.run_id,
    proof_type: proof.proof_type,
    label: proof.label,
    created_at: proof.created_at,
    size_bytes: proof.size_bytes
  };
}

function resolveProofTarget(proof: ProofViewRow): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = proofTargetString(proof);
  if (!raw) return { ok: false, reason: "missing_file_reference" };
  if (/^https?:\/\//i.test(raw)) return { ok: false, reason: "remote_uri_not_allowed" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:\/\//i.test(raw)) return { ok: false, reason: "unsupported_uri_scheme" };

  let candidate: string;
  try {
    candidate = /^file:\/\//i.test(raw) ? fileURLToPath(raw) : raw;
  } catch {
    return { ok: false, reason: "invalid_file_uri" };
  }
  if (!/^file:\/\//i.test(raw) && isAbsolute(raw)) return { ok: false, reason: "absolute_path_requires_file_uri" };
  if (!isAbsolute(candidate)) candidate = resolvePath(process.cwd(), candidate);
  if (isTempPath(candidate)) return { ok: false, reason: "tmp_path_not_allowed" };

  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch {
    return { ok: false, reason: "file_unavailable" };
  }
  if (!isAllowedProofPath(realPath)) return { ok: false, reason: "path_not_allowed" };
  return { ok: true, path: realPath };
}

function proofTargetString(proof: ProofViewRow): string | undefined {
  const uri = typeof proof.uri === "string" ? proof.uri.trim() : "";
  if (uri) return uri;
  const metadata = parseJson<Record<string, unknown>>(proof.metadata_json, {});
  for (const key of ["path", "filePath", "artifactPath", "screenshotPath", "domPath", "consolePath", "statePath", "logPath"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isAllowedProofPath(realPath: string): boolean {
  return allowedProofRoots().some((root) => {
    const rel = relative(root, realPath);
    return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
  });
}

function allowedProofRoots(): string[] {
  const roots = new Set<string>();
  addProofArtifactRoots(roots, process.cwd());
  for (const projectRoot of registeredWorkflowProjectRoots()) {
    addProofArtifactRoots(roots, projectRoot);
  }
  return [...roots];
}

function registeredWorkflowProjectRoots(): string[] {
  try {
    return querySql<{ project_root: string }>("SELECT DISTINCT project_root FROM registered_workflows;")
      .map((row) => (typeof row.project_root === "string" ? row.project_root.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function addProofArtifactRoots(roots: Set<string>, projectRoot: string): void {
  let realProjectRoot: string;
  try {
    realProjectRoot = realpathSync(projectRoot);
  } catch {
    return;
  }
  for (const dir of proofArtifactRootNames) {
    const candidate = resolvePath(realProjectRoot, dir);
    if (!existsSync(candidate)) continue;
    let realArtifactRoot: string;
    try {
      realArtifactRoot = realpathSync(candidate);
    } catch {
      continue;
    }
    if (realArtifactRoot === realProjectRoot) continue;
    if (!isPathInsideRoot(realProjectRoot, realArtifactRoot)) continue;
    roots.add(realArtifactRoot);
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function isTempPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized === "/tmp" || normalized.startsWith("/tmp/") || normalized.startsWith("/private/tmp/");
}

function proofMimeType(filePath: string): string {
  const map: Record<string, string> = {
    ".json": "application/json",
    ".jsonl": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
    ".xml": "application/xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  return map[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function redactProofPreview(value: string): string {
  return redactSensitiveText(value)
    .slice(0, proofPreviewMaxChars)
    .replace(/file:(?:\\\/){3}Users(?:\\\/)[^\n\r"'<>]+/g, "[redacted-file-uri]")
    .replace(/file:(?:\/\/\/|\/\/|(?:\\\/){2,3})Users\/[^\n\r"'<>]+/g, "[redacted-file-uri]")
    .replace(/\/Users\/[^\n\r"'<>]+/g, "[redacted-path]")
    .replace(/(?:\/private)?\/tmp\/[^\n\r"'<>]+/g, "[redacted-path]")
    .replace(/(?:^|[\s"'(])Documents\/New project\/[^\n\r"'<>]+/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-path]`;
    })
    .replace(/(?:^|[\s"'(])data\/artifacts(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])artifacts(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])output\/playwright(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])\.playwright-cli(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]");
}

function imageMetadata(filePath: string, mime: string) {
  const buffer = readFileSync(filePath);
  const dimensions = imageDimensions(buffer, mime);
  return {
    mime_type: mime,
    width: dimensions?.width,
    height: dimensions?.height,
    base64_included: false
  };
}

function imageDimensions(buffer: Buffer, mime: string): { width: number; height: number } | undefined {
  if (mime === "image/png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === "image/jpeg") return jpegDimensions(buffer);
  if (mime === "image/webp") return webpDimensions(buffer);
  return undefined;
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

function normalizeReceiptOnlyRuns() {
  const runs = querySql<{ id: string; status: string; metadata_json: string }>("SELECT id, status, metadata_json FROM runs;");
  for (const run of runs) {
    const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
    const receiptOnly = metadata.worker_mode === "receipt_only";
    const proofGate = metadata.proof_gate;
    const hasProofGate = typeof proofGate === "object" && proofGate !== null;
    const proofGateOk = hasProofGate && (proofGate as { ok?: unknown }).ok === true;
    const failedProofGate = hasProofGate && !proofGateOk;
    const receiptOnlyComplete = receiptOnly && run.status === "complete";
    if (!receiptOnly && !(run.status === "complete" && failedProofGate)) continue;

    const hasProofSummary = typeof metadata.proof_summary === "string" && metadata.proof_summary.length > 0;
    const nextStatus = receiptOnlyComplete || (run.status === "complete" && !proofGateOk) ? "partial" : run.status;
    const forceReceiptOnlyGuard = receiptOnlyComplete && proofGateOk;
    const downgradedComplete = run.status === "complete" && nextStatus === "partial";
    const staleCompleteSummary = hasProofSummary && /^complete\b/.test(String(metadata.proof_summary));
    if (!forceReceiptOnlyGuard && (proofGateOk || (nextStatus === run.status && hasProofGate && hasProofSummary))) continue;
    const presentProofs =
      hasProofGate && Array.isArray((proofGate as { present?: unknown }).present) ? (proofGate as { present: unknown[] }).present : [];

    execSql(
      `UPDATE runs
       SET status=${sqlValue(nextStatus)},
           metadata_json=${sqlValue({
             ...metadata,
             proof_gate: forceReceiptOnlyGuard
               ? {
                   ok: false,
                   missing: ["actual_execution_or_manual_verification"],
                   present: presentProofs
                 }
               : hasProofGate
               ? proofGate
               : {
                   ok: false,
                   missing: ["actual_execution_or_manual_verification"],
                   present: []
                 },
             proof_summary: forceReceiptOnlyGuard
               ? "partial: worker receipts captured, actual execution is not verified"
               : downgradedComplete && staleCompleteSummary
               ? receiptOnly
                 ? "partial: worker receipts captured, actual execution is not verified"
                 : "partial: proof gate is not satisfied"
               : hasProofSummary
               ? metadata.proof_summary
               : receiptOnly
                 ? "partial: worker receipts captured, actual execution is not verified"
                 : "partial: proof gate is not satisfied"
           })},
           updated_at=${sqlValue(nowIso())}
       WHERE id=${sqlValue(run.id)};`
    );
  }
}

export type ResumeSuppressionResult = {
  requested: string[];
  updated: string[];
  missing: string[];
};

export function markRunsResumeSuppressed(
  runIds: string[],
  options: { reason?: string; suppressedAt?: string } = {}
): ResumeSuppressionResult {
  const requested = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) return { requested, updated: [], missing: [] };

  const rows = querySql<{ id: string; metadata_json: string }>(
    `SELECT id, metadata_json FROM runs WHERE id IN (${requested.map((id) => sqlValue(id)).join(", ")});`
  );
  const found = new Set(rows.map((row) => row.id));
  const updated: string[] = [];
  const suppressedAt = options.suppressedAt ?? nowIso();

  for (const row of rows) {
    const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
    execSql(
      `UPDATE runs
       SET metadata_json=${sqlValue({
         ...metadata,
         resume_suppressed: true,
         resume_suppressed_reason: options.reason ?? metadata.resume_suppressed_reason ?? "historical_resume_noise",
         resume_suppressed_at: suppressedAt
       })},
           updated_at=${sqlValue(nowIso())}
       WHERE id=${sqlValue(row.id)};`
    );
    updated.push(row.id);
  }

  return {
    requested,
    updated,
    missing: requested.filter((id) => !found.has(id))
  };
}

type BridgeApprovalRow = {
  id: string;
  status: string;
  requested_by: string;
  approval_group_id: string;
  resource_locks_json: string;
  created_at: string;
};

type BridgeExecutionInput = {
  capabilityId: string;
  approvalId: string;
  status: string;
  executorStatus: string;
  summary: string;
  metadata: Record<string, unknown>;
};

function findBridgeApprovalForAction(actionId: string, approvalId?: string): BridgeApprovalRow | undefined {
  const where = approvalId
    ? `id=${sqlValue(approvalId)} AND requested_by='trusted-bridge'`
    : "requested_by='trusted-bridge'";
  const approvals = querySql<BridgeApprovalRow>(
    `SELECT id, status, requested_by, approval_group_id, resource_locks_json, created_at
     FROM approvals
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT 50;`
  );
  return approvals.find((approval) => {
    const locks = parseJson<string[]>(approval.resource_locks_json, []);
    return locks.includes(`bridge:${actionId}`) && approval.approval_group_id === `bridge_${actionId}`;
  });
}

function storeBridgeExecution(input: BridgeExecutionInput) {
  const now = nowIso();
  const execution = {
    id: makeId("bridge_exec"),
    capabilityId: input.capabilityId,
    approvalId: input.approvalId,
    status: input.status,
    executorStatus: input.executorStatus,
    summary: input.summary,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata
  };
  insert("bridge_executions", {
    id: execution.id,
    capability_id: execution.capabilityId,
    approval_id: execution.approvalId,
    status: execution.status,
    executor_status: execution.executorStatus,
    summary: execution.summary,
    created_at: execution.createdAt,
    updated_at: execution.updatedAt,
    metadata_json: execution.metadata
  });
  return execution;
}

function storeExecutorNotConnectedForApprovedBridgeApproval(approval: BridgeApprovalRow) {
  const actionId = parseJson<string[]>(approval.resource_locks_json, [])
    .find((lock) => lock.startsWith("bridge:"))
    ?.slice("bridge:".length);
  if (!actionId) return undefined;
  const action = findTrustedBridgeAction(actionId);
  if (!action) return undefined;
  const existing = querySql<{
    id: string;
    capability_id: string;
    approval_id: string;
    status: string;
    executor_status: string;
    summary: string;
    created_at: string;
    updated_at: string;
    metadata_json: string;
  }>(
    `SELECT * FROM bridge_executions
     WHERE approval_id=${sqlValue(approval.id)}
       AND capability_id=${sqlValue(action.id)}
       AND executor_status='not_connected'
     ORDER BY created_at DESC
     LIMIT 1;`
  )[0];
  if (existing) {
    return {
      id: existing.id,
      capabilityId: existing.capability_id,
      approvalId: existing.approval_id,
      status: existing.status,
      executorStatus: existing.executor_status,
      summary: existing.summary,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
      metadata: parseJson<Record<string, unknown>>(existing.metadata_json, {})
    };
  }
  return storeBridgeExecution({
    capabilityId: action.id,
    approvalId: approval.id,
    status: "blocked",
    executorStatus: "not_connected",
    summary: `${action.label}は課金確認済みですが、外部実行Bridgeはまだ接続されていません。`,
    metadata: {
      label: action.label,
      riskLevel: action.riskLevel,
      policyDecision: "billing_confirmed_but_executor_not_connected",
      resourceLocks: parseJson<string[]>(approval.resource_locks_json, [])
    }
  });
}

function buildNextActions(body: {
  runs: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  systemChecks: Array<Record<string, unknown>>;
  bridgeExecutions: Array<Record<string, unknown>>;
  secrets: Array<Record<string, unknown>>;
  obsidian: Record<string, unknown>;
  resumeContract?: Record<string, unknown>;
}) {
  const actions: Array<Record<string, unknown>> = [];
  const pendingApproval = body.approvals.find((approval) => approval.status === "pending");
  const partialRun = selectResumeCandidateRun(body.runs);
  const latestCheck = body.systemChecks[0];
  const latestBridgeBlock = body.bridgeExecutions.find((execution) => execution.executor_status === "not_connected");

  if (pendingApproval) {
    actions.push({
      id: "review-approval",
      title: "承認待ちを確認",
      summary: `${displayApprovalTitle(String(pendingApproval.title ?? ""))}は、あなたの確認待ちです。`,
      buttonLabel: "承認を見る",
      view: "Approvals",
      severity: "attention"
    });
  }
  if (!latestCheck || latestCheck.status !== "ok") {
    actions.push({
      id: "check-screen",
      title: "画面を確認",
      summary: "このアプリを開いて、表示崩れやエラーがないか確認できます。",
      buttonLabel: "確認する",
      view: "Sources",
      severity: latestCheck ? "attention" : "normal"
    });
  }
  if (!body.obsidian?.lastSuccessAt) {
    actions.push({
      id: "update-obsidian",
      title: "Obsidianを更新",
      summary: "実行履歴、承認、Bridge状態を知識ベースへ反映します。",
      buttonLabel: "更新する",
      view: "Sources",
      severity: "normal"
    });
  }
  if (partialRun) {
    const publicNextAction = publicNextActionFromRun(partialRun);
    if (publicNextAction) {
      actions.push(publicNextAction);
    } else {
      actions.push({
        id: "review-run",
        title: "途中の実行を確認",
        summary: `${displayTaskName(String(partialRun.name ?? partialRun.objective ?? "実行"))}の続きがあります。`,
        buttonLabel: "履歴を見る",
        view: "Runs",
        severity: "attention"
      });
    }
  }
  if (latestBridgeBlock) {
    actions.push({
      id: "connect-bridge",
      title: "外部実行Bridgeは未接続",
      summary: "承認済みでも、外部サイト操作はまだ実行されません。安全に止まっています。",
      buttonLabel: "状態を見る",
      view: "Sources",
      severity: "normal"
    });
  }
  if (body.secrets.length === 0) {
    actions.push({
      id: "save-key",
      title: "APIキーを保存",
      summary: "新規作成チャットにキーを貼ると、値を隠して保存し次回から再利用します。",
      buttonLabel: "新規作成へ",
      view: "Create",
      severity: "normal"
    });
  }

  return actions.slice(0, 4);
}

function publicNextActionFromRun(run: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  const action = metadata.public_next_action;
  if (!action || typeof action !== "object") return null;
  const candidate = action as Record<string, unknown>;
  const title = nonEmptyString(candidate.title);
  const buttonLabel = nonEmptyString(candidate.buttonLabel);
  const view = nonEmptyString(candidate.view);
  if (!title || !buttonLabel || !view) return null;
  return {
    id: nonEmptyString(candidate.id) ?? `run-next-${String(run.id ?? "unknown")}`,
    title,
    summary: nonEmptyString(candidate.summary) ?? "次の確認へ進めます。",
    buttonLabel,
    view,
    command: nonEmptyString(candidate.command),
    severity: nonEmptyString(candidate.severity) ?? "attention",
    runId: run.id
  };
}

function displayApprovalTitle(title: string): string {
  const normalized = title
    .replace(/^Bridge approval:\s*/i, "")
    .replace(/^Approve command run:\s*/i, "")
    .replace(/\s*\[保存済み:[^\]]+\]/g, "")
    .trim();
  return normalized ? displayTaskName(normalized) : "承認が必要な操作";
}

function displayTaskName(name: string): string {
  const publicName = publicAutomationName(name);
  if (publicName) return publicName;
  if (/etsy sync|current listings|正本同期/i.test(name)) return "Etsy同期";
  if (/printify|recovery|復旧/i.test(name)) return "Printify復旧";
  if (/full publish|新規公開|最後まで/i.test(name)) return "新規公開";
  return name
    .replace(/^NisenPrints\s*/i, "")
    .replace(/\s*正本同期/g, "")
    .replace(/\s*最後まで/g, "")
    .trim() || "実行";
}

type ChatSessionRow = {
  id: string;
  company_id: string;
  actor_user_id: string;
  name: string;
  codex_thread_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
};

function sanitizeChatSessionForApi(session: ChatSessionRow | Record<string, unknown>) {
  const raw = session as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    project_id: String(raw.company_id ?? raw.project_id ?? ""),
    name: redactSensitiveText(String(raw.name ?? "")).slice(0, 120),
    codex_thread_id: typeof raw.codex_thread_id === "string" ? raw.codex_thread_id : null,
    active: Number(raw.is_active ?? 0) === 1,
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? "")
  };
}

function readScopedChatSession(id: string, companyId: string, actorUserId: string): ChatSessionRow | undefined {
  if (!id.trim() || !companyId.trim() || !actorUserId.trim()) return undefined;
  return querySql<ChatSessionRow>(
    `SELECT * FROM chat_sessions
     WHERE id=${sqlValue(id)} AND company_id=${sqlValue(companyId)} AND actor_user_id=${sqlValue(actorUserId)}
     LIMIT 1`
  )[0];
}

function listScopedChatSessions(companyId: string, actorUserId: string) {
  return querySql<ChatSessionRow>(
    `SELECT * FROM chat_sessions
     WHERE company_id=${sqlValue(companyId)} AND actor_user_id=${sqlValue(actorUserId)}
     ORDER BY is_active DESC, updated_at DESC, created_at DESC`
  ).map(sanitizeChatSessionForApi);
}

function parseResearchSourceSelection(value: unknown): Partial<Record<ResearchSourceKey, boolean>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const keys: ResearchSourceKey[] = ["web", "x", "reddit", "youtube", "mcp", "api"];
  const selection: Partial<Record<ResearchSourceKey, boolean>> = {};
  for (const key of keys) {
    if (typeof input[key] === "boolean") selection[key] = input[key];
  }
  return selection;
}

function parseVisibleFlowInput(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const visibleFlow = value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []);
  return visibleFlow.length ? visibleFlow : undefined;
}

type CreateSessionPayload = {
  id: string;
  title: string;
  messages: Array<{ role: "assistant" | "user"; text: string }>;
  draft: Record<string, unknown>;
  researchSources: Record<string, unknown>;
  command: string;
};

function readCreateSession() {
  const row = querySql<{
    id: string;
    title: string;
    messages_json: string;
    draft_json: string;
    research_sources_json: string;
    command: string;
    created_at: string;
    updated_at: string;
  }>("SELECT * FROM create_sessions WHERE id='default' LIMIT 1")[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    messages: parseJson<Array<{ role: string; text: string }>>(row.messages_json, []),
    draft: parseJson<Record<string, unknown>>(row.draft_json, {}),
    researchSources: parseJson<Record<string, unknown>>(row.research_sources_json, {}),
    command: row.command,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function saveCreateSession(session: CreateSessionPayload) {
  const existing = querySql<{ created_at: string }>("SELECT created_at FROM create_sessions WHERE id='default' LIMIT 1")[0];
  const timestamp = nowIso();
  upsert("create_sessions", {
    id: "default",
    title: session.title,
    messages_json: session.messages,
    draft_json: session.draft,
    research_sources_json: session.researchSources,
    command: session.command,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  });
}

function createSessionRunMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const session = sanitizeCreateSessionPayload(value);
  const hasDraft = Object.keys(session.draft).length > 0;
  const hasConversation = session.messages.length > 0 || hasDraft || session.command.trim();
  if (!hasConversation) return {};
  const draft = session.draft as Record<string, unknown>;
  return {
    create_session_source: "create_view",
    create_session_title: session.title,
    create_session_execution_decision: draft.executionDecision,
    create_session_next_action: draft.nextAction,
    create_session_snapshot: {
      title: session.title,
      command: session.command || draft.command,
      messages: session.messages,
      draft,
      researchSources: session.researchSources,
      capturedAt: nowIso()
    }
  };
}

function sanitizeCreateSessionPayload(value: unknown): CreateSessionPayload {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const draft = input.draft && typeof input.draft === "object" ? input.draft as Record<string, unknown> : {};
  const title = sanitizeShortText(typeof draft.title === "string" ? draft.title : typeof input.title === "string" ? input.title : "作る相談", 120);
  const messages = Array.isArray(input.messages)
    ? input.messages
        .flatMap((message): Array<{ role: "assistant" | "user"; text: string }> => {
          if (!message || typeof message !== "object") return [];
          const item = message as Record<string, unknown>;
          const rawText = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
          const text = sanitizeLongText(rawText, 4000);
          if (!text.trim()) return [];
          return [{ role: item.role === "assistant" ? "assistant" : "user", text }];
        })
        .slice(-24)
    : [];
  return {
    id: "default",
    title,
    messages,
    draft: sanitizeCreateDraftForStorage(draft),
    researchSources: input.researchSources && typeof input.researchSources === "object" ? input.researchSources as Record<string, unknown> : {},
    command: sanitizeLongText(typeof input.command === "string" ? input.command : "", 2000)
  };
}

function sanitizeCreateDraftForStorage(draft: Record<string, unknown>): Record<string, unknown> {
  return {
    command: sanitizeLongText(typeof draft.command === "string" ? draft.command : "", 2000),
    title: sanitizeShortText(typeof draft.title === "string" ? draft.title : "作る相談", 120),
    reply: sanitizeLongText(typeof draft.reply === "string" ? draft.reply : "", 4000),
    visibleSteps: sanitizeStringArray(draft.visibleSteps, 12, 240),
    backendChecks: sanitizeStringArray(draft.backendChecks, 12, 240),
    answered: sanitizeStringArray(draft.answered, 12, 120),
    openQuestions: sanitizeStringArray(draft.openQuestions, 12, 240),
    nextAction: sanitizeLongText(typeof draft.nextAction === "string" ? draft.nextAction : "", 1000),
    executionDecision: typeof draft.executionDecision === "string" ? draft.executionDecision : "ask_more",
    confidence: typeof draft.confidence === "string" ? draft.confidence : "medium",
    plannerSource: typeof draft.plannerSource === "string" ? draft.plannerSource : "server_session",
    plannerModel: sanitizeShortText(typeof draft.plannerModel === "string" ? draft.plannerModel : "", 120),
    plannerBlocker: sanitizeShortText(typeof draft.plannerBlocker === "string" ? draft.plannerBlocker : "", 240)
  };
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [sanitizeShortText(entry, maxLength)] : []).slice(0, maxItems);
}

function sanitizeShortText(value: string, maxLength: number): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeLongText(value: string, maxLength: number): string {
  return redactSensitiveText(value).trim().slice(0, maxLength);
}

function parseScheduleRrule(value: unknown): string {
  if (typeof value !== "string") return "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
  return trimmed;
}

type TimeoutBlocker = {
  operation: string;
  exactBlocker: string;
  timeoutMs: number;
};

type BoundedResult<T> = { ok: true; value: T } | ({ ok: false } & TimeoutBlocker);

type ResearchPlanSchedulerOnceResult = {
  checked: number;
  started: number;
  skipped: number;
  blocked: number;
  runIds: string[];
  blockedWorkflowIds: string[];
  blockedDueKeys: string[];
  blockers: Array<{ workflowId: string; dueKey: string; exactBlocker: string }>;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  blocker: Omit<TimeoutBlocker, "timeoutMs">,
  onTimeout?: () => void
): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve({ ok: false, ...blocker, timeoutMs });
    }, timeoutMs);
  });
  const guarded = promise.then<BoundedResult<T>>(
    (value) => ({ ok: true, value }),
    (error) => {
      throw error;
    }
  );
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function researchPlanDemoTimeoutMs(): number {
  return boundedPositiveInteger(process.env.AUTOMATION_OS_RESEARCH_PLAN_DEMO_TIMEOUT_MS, 30_000);
}

function researchPlanSchedulerStartTimeoutMs(): number {
  return boundedPositiveInteger(process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_START_TIMEOUT_MS, 15_000);
}

function researchPlanDirectStartTimeoutMs(): number {
  return boundedPositiveInteger(process.env.AUTOMATION_OS_RESEARCH_PLAN_START_TIMEOUT_MS, 15_000);
}

function boundedPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function buildTimedOutResearchPlanDemoCheck(input: { targetUrl: string; timeoutMs: number }): BrowserUseLocalCheckResult {
  const createdAt = nowIso();
  return {
    id: makeId("system_check"),
    kind: "browser_check",
    driver: "browser_use_cli",
    status: "blocked",
    targetUrl: input.targetUrl,
    summary: `Research Planner demo timed out after ${input.timeoutMs}ms`,
    screenshotPath: null,
    recordingPath: null,
    geminiQaPath: null,
    statePath: null,
    logPath: null,
    createdAt,
    steps: [],
    metadata: {
      session: "research_plan_demo_timeout",
      driver: "browser_use_cli",
      connectionStrategy: {
        mode: "unique_session",
        session: "research_plan_demo_timeout",
        cdpUrl: null,
        profile: null
      },
      statePath: null,
      screenshotPath: null,
      recordingPath: null,
      geminiQaPath: null,
      logPath: null,
      geminiVideoQa: {
        status: "blocked",
        artifactUri: null,
        videoArtifactUri: null,
        completionVetoOnly: true,
        exactBlocker: "research_plan_demo_timeout"
      },
      recordingQa: {
        required: true,
        status: "blocked",
        reason: "browser_use_recording_requires_cdp_lane",
        recorderStatus: "unavailable",
        cdpRequired: true,
        plannedVideoPath: null,
        manifestPath: null,
        artifactUri: null,
        videoArtifactUri: null,
        completionVetoOnly: true
      },
      cleanup: {
        attempted: false,
        status: "skipped",
        reason: "research_plan_demo_timeout",
        command: null
      },
      missingArtifacts: ["screenshotPath", "statePath", "logPath", "recordingQa"],
      artifactValidationStatus: "blocked",
      profileIsolation: {
        status: "session_only",
        summary: "Demo timed out before Browser Use could produce local screen artifacts."
      },
      operation: "research_plan_demo",
      exactBlocker: "research_plan_demo_timeout",
      timeoutMs: input.timeoutMs
    } as BrowserUseLocalCheckResult["metadata"] & { operation: string; exactBlocker: string; timeoutMs: number }
  };
}

function browserUseDemoBlocker(result: BrowserUseLocalCheckResult): string {
  const metadata = result.metadata as BrowserUseLocalCheckResult["metadata"] & { exactBlocker?: unknown };
  return typeof metadata.exactBlocker === "string" && metadata.exactBlocker.trim()
    ? metadata.exactBlocker
    : result.summary || "research_plan_demo_blocked";
}

export async function runResearchPlanSchedulerOnce(
  now = new Date(),
  allowedCompanyIds?: readonly string[]
): Promise<ResearchPlanSchedulerOnceResult> {
  initDb();
  const allowedCompanySet = allowedCompanyIds ? new Set(allowedCompanyIds) : null;
  const workflows = initRegisteredWorkflows().filter((workflow) =>
    String(workflow.status).toLowerCase() === "active"
    && !isRegisteredWorkflowSchedulePaused(workflow)
    && (!allowedCompanySet || (workflow.company_id ? allowedCompanySet.has(workflow.company_id) : fixedRegisteredWorkflows.some((fixed) => fixed.id === workflow.id)))
  );
  const runIds: string[] = [];
  const blockedWorkflowIds: string[] = [];
  const blockedDueKeys: string[] = [];
  const blockers: ResearchPlanSchedulerOnceResult["blockers"] = [];
  let skipped = 0;
  let blocked = 0;
  for (const workflow of workflows) {
    const due = researchPlanWorkflowDue(workflow, now);
    if (!due.ok) {
      skipped += 1;
      continue;
    }
    const command = getRegisteredWorkflowStartCommand(workflow.id);
    if (!command) {
      skipped += 1;
      continue;
    }
    if (!reserveResearchPlanSchedulerDueKey(workflow.id, due.dueKey)) {
      skipped += 1;
      continue;
    }
    try {
      let runMetadata: Record<string, unknown> = registeredWorkflowStartMetadata(workflow, { source: "scheduler", dueKey: due.dueKey, command });
      if (!workflow.company_id) {
        const isFixedGlobalWorkflow = fixedRegisteredWorkflows.some((fixed) => fixed.id === workflow.id && fixed.runnerKind === workflow.runner_kind);
        const portableAdmission = isPortableSchedulerAdmission(workflow);
        const globalServiceUserId = process.env.AUTOMATION_OS_GLOBAL_SYSTEM_SERVICE_USER_ID?.trim() ?? "";
        let globalServiceBlocker = "";
        if (portableAdmission) {
          const portableStarted = await startPortableWorkflowRun({
            workflowId: workflow.id as Parameters<typeof startPortableWorkflowRun>[0]["workflowId"],
            sourceTrigger: "automation_os_scheduler",
            idempotencyKey: `scheduler:${workflow.id}:${due.dueKey}`
          });
          runIds.push(portableStarted.runId);
          recordRegisteredWorkflowSchedulerStart(workflow, due.dueKey, portableStarted.runId, now);
          continue;
        } else if (!isFixedGlobalWorkflow) {
          globalServiceBlocker = "registered_workflow_company_scope_missing";
        } else if (!globalServiceUserId) {
          globalServiceBlocker = "registered_workflow_global_service_identity_missing";
        } else {
          try {
            requireExistingServiceIdentity(globalServiceUserId);
          } catch {
            globalServiceBlocker = "registered_workflow_global_service_identity_invalid";
          }
        }
        if (globalServiceBlocker) {
          blocked += 1;
          blockedWorkflowIds.push(workflow.id);
          blockedDueKeys.push(due.dueKey);
          blockers.push({ workflowId: workflow.id, dueKey: due.dueKey, exactBlocker: globalServiceBlocker });
          recordRegisteredWorkflowSchedulerBlock(workflow, due.dueKey, globalServiceBlocker, now);
          continue;
        }
        runMetadata = {
          ...runMetadata,
          system_scope: "global",
          scheduler_service_identity: { userId: globalServiceUserId, kind: "service", scope: "global_system" }
        };
      }
      if (workflow.runner_kind === "research_plan_registered") {
        const serviceWorkerUserId = process.env.AUTOMATION_OS_SERVICE_WORKER_USER_ID?.trim() ?? "";
        let serviceIdentityBlocker = "";
        if (!workflow.company_id) {
          serviceIdentityBlocker = "registered_workflow_company_scope_missing";
        } else if (!serviceWorkerUserId) {
          serviceIdentityBlocker = "registered_workflow_service_identity_missing";
        } else {
          try {
            requireExistingServiceIdentity(serviceWorkerUserId);
          } catch {
            serviceIdentityBlocker = "registered_workflow_service_identity_invalid";
          }
          try {
            if (serviceIdentityBlocker) throw new Error(serviceIdentityBlocker);
            requireExistingCompanyAccess(workflow.company_id, ["operator"], serviceWorkerUserId);
          } catch {
            if (!serviceIdentityBlocker) serviceIdentityBlocker = "registered_workflow_service_membership_missing";
          }
        }
        if (serviceIdentityBlocker) {
          blocked += 1;
          blockedWorkflowIds.push(workflow.id);
          blockedDueKeys.push(due.dueKey);
          blockers.push({ workflowId: workflow.id, dueKey: due.dueKey, exactBlocker: serviceIdentityBlocker });
          recordRegisteredWorkflowSchedulerBlock(workflow, due.dueKey, serviceIdentityBlocker, now);
          continue;
        }
        const startCommand = parseJson<{ researchPlanId?: unknown }>(workflow.start_command_json, {});
        const researchPlanId = typeof startCommand.researchPlanId === "string" ? startCommand.researchPlanId : undefined;
        const plan = researchPlanId && workflow.company_id ? getResearchPlan(researchPlanId, [workflow.company_id]) : undefined;
        if (!plan) {
          skipped += 1;
          continue;
        }
        const researchPlanMetadata = {
          ...runMetadata,
          ...researchPlanPreparedRunMetadata(plan),
          scheduler_service_identity: { userId: serviceWorkerUserId, kind: "service", scope: "tenant", companyId: workflow.company_id },
          execution_routing: buildExecutionRoutingSnapshot({
            command: plan.command,
            source: "scheduler"
          })
        };
        const started = await withTimeout(
          researchPlanStartRunner(plan.command, { metadata: researchPlanMetadata, deferWorker: true, prepareOnly: true, companyId: workflow.company_id ?? undefined }),
          researchPlanSchedulerStartTimeoutMs(),
          {
            operation: "research_plan_scheduler_start",
            exactBlocker: "research_plan_scheduler_start_timeout"
          }
        );
        if (!started.ok) {
          blocked += 1;
          blockedWorkflowIds.push(workflow.id);
          blockedDueKeys.push(due.dueKey);
          blockers.push({ workflowId: workflow.id, dueKey: due.dueKey, exactBlocker: started.exactBlocker });
          recordRegisteredWorkflowSchedulerBlock(workflow, due.dueKey, started.exactBlocker, now);
          continue;
        }
        const body = commitResearchPlanStarted(plan, started.value);
        const runId = extractRunId(body);
        if (runId) {
          const runStatus = extractRunStatus(body);
          if (runStatus !== "waiting_approval") recordRunAwaitingWorkerLoop(runId, "registered_research_plan_scheduler_start");
          runIds.push(runId);
          recordRegisteredWorkflowSchedulerStart(workflow, due.dueKey, runId, now);
        }
        continue;
      }
      const body = await startCommandRun(command, { metadata: runMetadata, deferWorker: true });
      const runId = body.runId;
      if (runId) {
        if (extractRunStatus(body as Record<string, unknown>) !== "waiting_approval") recordRunAwaitingWorkerLoop(runId, "registered_workflow_scheduler_start");
        runIds.push(runId);
        recordRegisteredWorkflowSchedulerStart(workflow, due.dueKey, runId, now);
      }
    } catch (error) {
      blocked += 1;
      const exactBlocker = error instanceof Error ? error.message : "registered_workflow_scheduler_start_failed";
      blockedWorkflowIds.push(workflow.id);
      blockedDueKeys.push(due.dueKey);
      blockers.push({ workflowId: workflow.id, dueKey: due.dueKey, exactBlocker });
      recordRegisteredWorkflowSchedulerBlock(workflow, due.dueKey, exactBlocker, now);
    } finally {
      releaseResearchPlanSchedulerDueKey(workflow.id, due.dueKey);
    }
  }
  return { checked: workflows.length, started: runIds.length, skipped, blocked, runIds, blockedWorkflowIds, blockedDueKeys, blockers };
}

function isPortableSchedulerAdmission(workflow: Pick<RegisteredWorkflowRow, "id" | "runner_kind" | "company_id">): boolean {
  const mode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE?.trim();
  if (mode !== PORTABLE_WORKER_CANARY_MODE && mode !== PORTABLE_WORKER_EXTERNAL_MODE) return false;
  if (workflow.company_id) return false;
  return portableWorkflowIdForWorkerAdapter(workflow.runner_kind) === workflow.id;
}

function reserveResearchPlanSchedulerDueKey(workflowId: string, dueKey: string): boolean {
  const key = `${workflowId}:${dueKey}`;
  if (researchPlanSchedulerInFlightDueKeys.has(key)) return false;
  researchPlanSchedulerInFlightDueKeys.add(key);
  return true;
}

function releaseResearchPlanSchedulerDueKey(workflowId: string, dueKey: string): void {
  researchPlanSchedulerInFlightDueKeys.delete(`${workflowId}:${dueKey}`);
}

function startResearchPlanScheduler() {
  const intervalMs = researchPlanSchedulerIntervalMs();
  if (intervalMs <= 0 || researchPlanSchedulerTimer) return;
  researchPlanSchedulerTimer = setInterval(() => {
    void runResearchPlanSchedulerOnce().catch((error) => {
      console.error("Research Plan scheduler failed", error);
    });
  }, intervalMs);
  researchPlanSchedulerTimer.unref?.();
}

function stopResearchPlanScheduler() {
  if (!researchPlanSchedulerTimer) return;
  clearInterval(researchPlanSchedulerTimer);
  researchPlanSchedulerTimer = undefined;
}

function researchPlanSchedulerIntervalMs(): number {
  const raw = process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 60_000;
  return Math.floor(parsed);
}

function researchPlanWorkflowDue(workflow: { schedule_json: string; provenance_json: string; created_at: string }, now: Date): { ok: true; dueKey: string } | { ok: false } {
  const schedule = getRegisteredWorkflowEffectiveSchedule(workflow);
  const parsed = parseRecurringRrule(schedule.rrule, workflow.created_at);
  if (!parsed) return { ok: false };
  const scheduled = new Date(now);
  scheduled.setHours(parsed.hour, parsed.minute, 0, 0);
  if (parsed.days && !parsed.days.includes(scheduled.getDay())) return { ok: false };
  if (now < scheduled) return { ok: false };
  const createdAt = new Date(workflow.created_at);
  if (Number.isFinite(createdAt.getTime()) && createdAt > scheduled) return { ok: false };
  const dueKey = `${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, "0")}-${String(scheduled.getDate()).padStart(2, "0")}T${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  const provenance = parseJson<{ scheduler?: { lastDueKey?: unknown } }>(workflow.provenance_json, {});
  return provenance.scheduler?.lastDueKey === dueKey ? { ok: false } : { ok: true, dueKey };
}

function parseRecurringRrule(rrule: string, createdAtValue: string): { hour: number; minute: number; days?: number[] } | undefined {
  const daily = /FREQ=DAILY/.test(rrule);
  const weekly = /FREQ=WEEKLY/.test(rrule);
  if (!daily && !weekly) return undefined;
  const hour = Number(rrule.match(/BYHOUR=(\d{1,2})/)?.[1] ?? "9");
  const minute = Number(rrule.match(/BYMINUTE=(\d{1,2})/)?.[1] ?? "0");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (!weekly) return { hour, minute };
  const days = parseByDay(rrule);
  if (days.length > 0) return { hour, minute, days };
  const createdAt = new Date(createdAtValue);
  return { hour, minute, days: [Number.isFinite(createdAt.getTime()) ? createdAt.getDay() : 1] };
}

function parseByDay(rrule: string): number[] {
  const map: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const raw = rrule.match(/BYDAY=([A-Z,]+)/)?.[1];
  if (!raw) return [];
  return [...new Set(raw.split(",").map((day) => map[day]).filter((day): day is number => typeof day === "number"))];
}

function extractRunId(body: Record<string, unknown>): string | undefined {
  return typeof body.runId === "string" ? body.runId : undefined;
}

function extractRunStatus(body: Record<string, unknown>): string | undefined {
  if (typeof body.status === "string") return body.status;
  const run = body.run;
  if (run && typeof run === "object" && typeof (run as { status?: unknown }).status === "string") return (run as { status: string }).status;
  return undefined;
}

function publicRunStartSummary(value: unknown) {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const nestedRun = typeof record.run === "object" && record.run !== null ? (record.run as Record<string, unknown>) : {};
  return {
    runId: extractRunId(record) ?? null,
    status: typeof nestedRun.status === "string" ? nestedRun.status : typeof record.status === "string" ? record.status : null
  };
}

function publicResearchPlanRunStartSummary(value: unknown) {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const plan = typeof record.plan === "object" && record.plan !== null ? (record.plan as Record<string, unknown>) : {};
  const runId = extractRunId(record) ?? null;
  return {
    ...publicRunStartSummary(record),
    plan: {
      id: typeof plan.id === "string" ? plan.id : null,
      status: typeof plan.status === "string" ? plan.status : null,
      runId
    }
  };
}

function registeredWorkflowStartMetadata(
  workflow: RegisteredWorkflowRow,
  start: { source: "manual" | "scheduler"; dueKey?: string; command: string }
) {
  const routeDecision = buildExecutionRoutingSnapshot({
    command: start.command,
    source: start.source
  });
  return {
    registeredWorkflowId: workflow.id,
    registered_workflow_id: workflow.id,
    workflowId: workflow.id,
    workflow_id: workflow.id,
    registered_workflow_start: {
      source: start.source,
      runnerKind: workflow.runner_kind,
      workflow_id: workflow.id,
      definition_fingerprint: referenceWorkflowDefinitionFingerprint(workflow),
      schedule_fingerprint: referenceWorkflowScheduleFingerprint(workflow),
      ...(start.dueKey ? { dueKey: start.dueKey } : {})
    },
    ...buildCanonicalExecutionRoutingMetadata(routeDecision)
  };
}

function recordRegisteredWorkflowSchedulerStart(workflow: { id: string; provenance_json: string }, dueKey: string, runId: string, now: Date) {
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  const existingScheduler = typeof provenance.scheduler === "object" && provenance.scheduler
    ? provenance.scheduler as Record<string, unknown>
    : {};
  const schedulerWithoutCurrentBlocker = { ...existingScheduler };
  delete schedulerWithoutCurrentBlocker.exactBlocker;
  execSql(
    `UPDATE registered_workflows
     SET provenance_json=${sqlValue({
       ...provenance,
       scheduler: {
         ...schedulerWithoutCurrentBlocker,
         lastDueKey: dueKey,
         lastRunId: runId,
         lastStartedAt: now.toISOString()
       }
     })},
         updated_at=${sqlValue(nowIso())}
     WHERE id=${sqlValue(workflow.id)};`
  );
}

function recordRegisteredWorkflowSchedulerBlock(workflow: { id: string; provenance_json: string }, dueKey: string, exactBlocker: string, now: Date) {
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  execSql(
    `UPDATE registered_workflows
     SET provenance_json=${sqlValue({
       ...provenance,
       scheduler: {
         ...(typeof provenance.scheduler === "object" && provenance.scheduler ? provenance.scheduler : {}),
         lastDueKey: dueKey,
         lastBlockedAt: now.toISOString(),
         exactBlocker
       }
     })},
         updated_at=${sqlValue(nowIso())}
     WHERE id=${sqlValue(workflow.id)};`
  );
}

function clearRegisteredWorkflowSchedulerBlock(workflow: { id: string; provenance_json: string }) {
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  const scheduler = typeof provenance.scheduler === "object" && provenance.scheduler
    ? { ...(provenance.scheduler as Record<string, unknown>) }
    : {};
  delete scheduler.exactBlocker;
  execSql(
    `UPDATE registered_workflows
     SET provenance_json=${sqlValue({
       ...provenance,
       scheduler: {
         ...scheduler,
         lastManualStartedAt: nowIso()
       }
     })},
         updated_at=${sqlValue(nowIso())}
     WHERE id=${sqlValue(workflow.id)};`
  );
}

function recordRegisteredWorkflowManualStart(workflow: { id: string; provenance_json: string }, runId: string) {
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  const now = nowIso();
  const scheduler = typeof provenance.scheduler === "object" && provenance.scheduler
    ? { ...(provenance.scheduler as Record<string, unknown>) }
    : {};
  const manual = typeof provenance.manual === "object" && provenance.manual
    ? { ...(provenance.manual as Record<string, unknown>) }
    : {};
  delete scheduler.exactBlocker;
  execSql(
    `UPDATE registered_workflows
     SET provenance_json=${sqlValue({
       ...provenance,
       scheduler: {
         ...scheduler,
         lastManualRunId: runId,
         lastManualStartedAt: now
       },
       manual: {
         ...manual,
         lastManualRunId: runId,
         lastManualStartedAt: now
       }
     })},
         updated_at=${sqlValue(now)}
     WHERE id=${sqlValue(workflow.id)};`
  );
}

function recordRegisteredWorkflowManualBlock(workflow: { id: string; provenance_json: string }, exactBlocker: string) {
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  execSql(
    `UPDATE registered_workflows
     SET provenance_json=${sqlValue({
       ...provenance,
       scheduler: {
         ...(typeof provenance.scheduler === "object" && provenance.scheduler ? provenance.scheduler : {}),
         lastManualBlockedAt: nowIso(),
         exactBlocker
       }
     })},
         updated_at=${sqlValue(nowIso())}
     WHERE id=${sqlValue(workflow.id)};`
  );
}

function commitResearchPlanStarted(
  plan: NonNullable<ReturnType<typeof getResearchPlan>>,
  body: Record<string, unknown>
): Record<string, unknown> {
  const runId = typeof body.runId === "string" ? body.runId : undefined;
  if (!runId) {
    throw new Error("research_plan_start_missing_run");
  }
  assertResearchPlanRunCompanyMatch(runId, plan.companyId);
  try {
    const updatedPlan = commitResearchPlanStartedAtomic(plan, runId);
    return { ...summarizeResearchPlanRunBody(body, runId), plan: updatedPlan };
  } catch (error) {
    try {
      rollbackPreparedResearchPlanRunAtomic({
        planId: plan.id,
        runId,
        companyId: plan.companyId ?? ""
      });
    } catch (cleanupError) {
      const commitMessage = error instanceof Error ? error.message : "research_plan_start_commit_failed";
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "research_plan_prepared_run_cleanup_failed";
      throw new Error(`${commitMessage};cleanup:${cleanupMessage}`);
    }
    throw error;
  }
}

function researchPlanPreparedRunMetadata(
  plan: Pick<ResearchPlanSnapshot, "id" | "companyId">,
  metadata: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...metadata,
    research_plan_id: plan.id,
    research_plan_company_id: plan.companyId,
    research_plan_start_phase: "prepared_unlinked"
  };
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

function assertResearchPlanRunCompanyMatch(runId: string, companyId?: string | null): void {
  const companyClause = researchPlanRunCompanyClause(companyId);
  const current = querySql<{ company_id: string | null }>(`SELECT company_id FROM runs WHERE id=${sqlValue(runId)}${companyClause} LIMIT 1`)[0];
  if (!current) {
    throw new Error(companyClause ? "research_plan_run_company_mismatch" : "research_plan_run_not_found");
  }
}

function researchPlanRunCompanyClause(companyId?: string | null): string {
  const normalized = typeof companyId === "string" ? companyId.trim() : "";
  return normalized ? ` AND company_id=${sqlValue(normalized)}` : "";
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

export function enforceResearchPlanCompletionBoundary(runId: string, plan: ReturnType<typeof getResearchPlan>, companyId?: string | null) {
  if (!plan) return;
  const requiredProofs = requiredResearchPlanProofs(plan);
  const approvalBoundarySources = billingRequiredResearchSourceKeys(plan);
  if (requiredProofs.length === 0 && approvalBoundarySources.length === 0) return;
  const companyClause = researchPlanRunCompanyClause(companyId ?? plan.companyId ?? undefined);
  const current = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)}${companyClause} LIMIT 1`)[0];
  if (!current) return;
  const metadata = parseJson<Record<string, unknown>>(current.metadata_json, {});
  const presentProofs = querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${sqlValue(runId)}${companyClause}`).map((proof) => proof.proof_type);
  const missingProofs = requiredProofs.filter((proof) => !presentProofs.includes(proof));
  const boundaryMetadata = {
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
    }
  };
  const shouldHoldPartial = (missingProofs.length > 0 || approvalBoundarySources.length > 0) && current.status === "complete";
  execSql(
    `UPDATE runs
     SET status=${sqlValue(shouldHoldPartial ? "partial" : current.status)},
         updated_at=${sqlValue(nowIso())},
         metadata_json=${sqlValue({
           ...boundaryMetadata,
           ...(shouldHoldPartial ? { stop_reason: "research_plan_visible_source_proof_missing" } : {})
         })}
     WHERE id=${sqlValue(runId)}${companyClause};`
  );
}

export function storeResearchPlanVisibleSourceProof(
  runId: string,
  sourceKey: ResearchSourceKey,
  capture: Extract<YouTubeTranscriptCaptureResult, { ok: true }> | Extract<UrlCaptureResult, { ok: true }>,
  companyId?: string | null
) {
  const companyClause = researchPlanRunCompanyClause(companyId);
  const run = querySql<{ company_id: string | null }>(`SELECT company_id FROM runs WHERE id=${sqlValue(runId)}${companyClause} LIMIT 1`)[0];
  if (!run) throw new Error(companyId ? "research_plan_run_company_mismatch" : "research_plan_run_not_found");
  const runCompanyId = run?.company_id?.trim() ?? "";
  if (!runCompanyId) throw new Error("research_plan_run_company_required");
  const now = nowIso();
  const proofType = sourceKey === "web" ? "readable_source_snapshot:web" : `visible_source_snapshot:${sourceKey}`;
  const uri = "files" in capture ? capture.files.manifest : capture.ingest.path;
  const sizeBytes = "transcriptBytes" in capture ? capture.transcriptBytes : capture.bytes;
  const label = sourceKey === "web" ? "Web readable source snapshot" : "YouTube transcript visible source snapshot";
  const existing = querySql<{ id: string; proof_type: string; uri: string }>(
    `SELECT id, proof_type, uri FROM proofs
     WHERE run_id=${sqlValue(runId)}
       AND company_id=${sqlValue(runCompanyId)}
       AND proof_type=${sqlValue(proofType)}
       AND uri=${sqlValue(uri)}
     LIMIT 1`
  )[0];
  if (existing) return { id: existing.id, proofType: existing.proof_type, uri: existing.uri };
  const proof = {
    id: makeId("proof"),
    proofType,
    label,
    uri,
    createdAt: now,
    metadata: {
      sourceKey,
      captureId: capture.captureId,
      artifactDir: "artifactDir" in capture ? capture.artifactDir : undefined,
      currentUrl: "currentUrl" in capture ? capture.currentUrl : capture.finalUrl,
      requestedUrl: "requestedUrl" in capture ? capture.requestedUrl : undefined,
      finalUrl: "finalUrl" in capture ? capture.finalUrl : undefined,
      sourceTitle: capture.sourceTitle,
      segmentCount: "segmentCount" in capture ? capture.segmentCount : undefined,
      transcriptBytes: "transcriptBytes" in capture ? capture.transcriptBytes : undefined,
      contentBytes: "bytes" in capture ? capture.bytes : undefined,
      contentType: "contentType" in capture ? capture.contentType : undefined,
      ingestPath: "ingest" in capture ? capture.ingest.path : undefined,
      lane: sourceKey === "youtube" ? "youtube_visible_transcript_cdp" : "web_url_capture_readonly",
      apiBillingRequired: false,
      readOnly: true
    }
  };
  insert("proofs", {
    id: proof.id,
    company_id: runCompanyId,
    run_id: runId,
    step_id: null,
    proof_type: proof.proofType,
    label: proof.label,
    uri: proof.uri,
    size_bytes: sizeBytes,
    created_at: proof.createdAt,
    metadata_json: proof.metadata
  });
  return proof;
}

function researchPlanCaptureProofMetadata(
  sourceKey: Extract<ResearchSourceKey, "web" | "youtube">,
  capture: Extract<YouTubeTranscriptCaptureResult, { ok: true }> | Extract<UrlCaptureResult, { ok: true }>
): Record<string, unknown> {
  return {
    sourceKey,
    captureId: capture.captureId,
    artifactDir: "artifactDir" in capture ? capture.artifactDir : undefined,
    currentUrl: "currentUrl" in capture ? capture.currentUrl : capture.finalUrl,
    requestedUrl: "requestedUrl" in capture ? capture.requestedUrl : undefined,
    finalUrl: "finalUrl" in capture ? capture.finalUrl : undefined,
    sourceTitle: capture.sourceTitle,
    segmentCount: "segmentCount" in capture ? capture.segmentCount : undefined,
    transcriptBytes: "transcriptBytes" in capture ? capture.transcriptBytes : undefined,
    contentBytes: "bytes" in capture ? capture.bytes : undefined,
    contentType: "contentType" in capture ? capture.contentType : undefined,
    ingestPath: "ingest" in capture ? capture.ingest.path : undefined,
    lane: sourceKey === "youtube" ? "youtube_visible_transcript_cdp" : "web_url_capture_readonly",
    apiBillingRequired: false,
    readOnly: true
  };
}

function summarizeResearchPlanRunBody(body: Record<string, unknown>, runId: string): Record<string, unknown> {
  const run = querySql(`SELECT * FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  return { ...body, run, ...(run ? { status: (run as Record<string, unknown>).status } : {}) };
}

function requiredResearchPlanProofs(plan: ReturnType<typeof getResearchPlan>): string[] {
  return enabledResearchSourceKeys(plan)
    .flatMap((key) => {
      if (key === "web") return ["readable_source_snapshot:web"];
      if (key === "youtube") return ["visible_source_snapshot:youtube"];
      return [];
    });
}

function enabledResearchSourceKeys(plan: ReturnType<typeof getResearchPlan>): string[] {
  if (!plan) return [];
  return plan.sources.filter((source) => source.enabled).map((source) => source.key);
}

function billingRequiredResearchSourceKeys(plan: ReturnType<typeof getResearchPlan>): string[] {
  if (!plan) return [];
  return plan.sources
    .filter((source) => source.enabled && (source.metadata?.apiBillingRequired === true || source.metadata?.billingRequired === true))
    .map((source) => source.key);
}

function isLocalResearchDemoTarget(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    return ["http:", "https:"].includes(parsed.protocol) && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function maybeAutoExportObsidian(reason: string) {
  refreshKnowledgeNotes();
  return runObsidianAutoExportBestEffort(reason);
}

let deferredObsidianExportTimer: ReturnType<typeof setTimeout> | undefined;
let deferredObsidianExportReason = "api_state_change";

function maybeAutoExportObsidianAfterResponse(reason: string) {
  refreshKnowledgeNotes();
  deferredObsidianExportReason = reason;
  if (deferredObsidianExportTimer) clearTimeout(deferredObsidianExportTimer);
  deferredObsidianExportTimer = setTimeout(() => {
    deferredObsidianExportTimer = undefined;
    runObsidianAutoExportBestEffort(deferredObsidianExportReason);
  }, deferredObsidianExportDelayMs());
  deferredObsidianExportTimer.unref?.();
}

function deferredObsidianExportDelayMs(): number {
  const raw = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DEFER_MS;
  if (raw === undefined || raw.trim() === "") return 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1000;
  return Math.floor(parsed);
}

function obsidianIngestErrorStatus(error: string): number {
  if (error === customObsidianExportError) return 403;
  if (error === "obsidian_ingest_text_required" || error === "obsidian_ingest_captured_at_invalid") return 400;
  if (error === "obsidian_inbox_not_directory" || error === "realpath_outside_vault") return 409;
  return 500;
}

function hasDisallowedCaptureFileInput(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const input = body as Record<string, unknown>;
  return ["statusFile", "artifactRoot", "artifactDir", "responseFile", "contentFile", "manifestFile", "blockerFile"].some((key) => key in input);
}

type BrowserUseCheckRequest = {
  laneId?: string;
  targetUrl?: string;
  cdpUrl?: string;
  cdpPort?: number;
  profile?: string;
};

type BrowserUseCdpFallback = {
  cdpUrl: string;
  profile?: string;
};

type BrowserUseLaneRow = {
  id: string;
  run_id: string | null;
  role: string;
  cdp_port: number;
  profile_dir: string;
  workdir: string;
  browser_use_session: string | null;
  browser_use_cdp_url: string | null;
  browser_use_profile: string | null;
  profile_strategy: string | null;
  lane_visibility: string | null;
  status: string;
  health: string;
  updated_at: string;
};

function parseBrowserUseCheckRequest(body: unknown): BrowserUseCheckRequest {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    laneId: nonEmptyString(input.laneId),
    targetUrl: nonEmptyString(input.targetUrl),
    cdpUrl: normalizeCdpUrl(nonEmptyString(input.cdpUrl)),
    cdpPort: normalizeCdpPort(input.cdpPort),
    profile: nonEmptyString(input.profile)
  };
}

function buildBrowserUseCheckOptions(request: BrowserUseCheckRequest, lane?: BrowserUseLaneRow, fallback?: BrowserUseCdpFallback): BrowserUseLocalCheckOptions {
  return {
    targetUrl: request.targetUrl,
    session: lane?.browser_use_session ?? undefined,
    cdpUrl: request.cdpUrl ?? lane?.browser_use_cdp_url ?? cdpUrlFromPort(lane?.cdp_port) ?? fallback?.cdpUrl,
    cdpPort: request.cdpUrl || fallback?.cdpUrl ? undefined : request.cdpPort ?? lane?.cdp_port,
    profile: request.profile ?? lane?.browser_use_profile ?? lane?.profile_dir ?? fallback?.profile
  };
}

function hasExplicitBrowserUseConnectionRequest(request: BrowserUseCheckRequest): boolean {
  return Boolean(request.laneId || request.cdpUrl || request.cdpPort !== undefined || request.profile);
}

function resolveBrowserUseLane(request: BrowserUseCheckRequest): BrowserUseLaneRow | undefined {
  if (!requestCdpIdentifiersAgree(request)) return undefined;

  if (request.laneId) {
    const lane = querySql<BrowserUseLaneRow>(`SELECT * FROM lanes WHERE id=${sqlValue(request.laneId)} LIMIT 1`)[0];
    return lane && browserUseLaneMatchesRequest(lane, request) ? lane : undefined;
  }
  if (!request.cdpUrl && request.cdpPort === undefined && !request.profile) return undefined;

  const lanes = querySql<BrowserUseLaneRow>("SELECT * FROM lanes ORDER BY updated_at DESC LIMIT 200");
  return lanes.find((lane) => browserUseLaneMatchesRequest(lane, request));
}

function browserUseLaneMatchesRequest(lane: BrowserUseLaneRow, request: BrowserUseCheckRequest): boolean {
  const laneCdpUrls = browserUseLaneCdpUrls(lane);
  if (request.cdpUrl && !laneCdpUrls.includes(request.cdpUrl)) return false;
  if (request.cdpPort !== undefined && lane.cdp_port !== request.cdpPort) return false;
  if (request.profile && lane.browser_use_profile !== request.profile && lane.profile_dir !== request.profile) return false;
  return true;
}

function browserUseLaneCdpUrls(lane: BrowserUseLaneRow): string[] {
  return [normalizeCdpUrl(lane.browser_use_cdp_url ?? undefined), cdpUrlFromPort(lane.cdp_port)].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
}

function requestCdpIdentifiersAgree(request: BrowserUseCheckRequest): boolean {
  if (!request.cdpUrl || request.cdpPort === undefined) return true;
  return request.cdpUrl === cdpUrlFromPort(request.cdpPort);
}

function findLatestSafeBrowserUseCdpFallback(): BrowserUseCdpFallback | undefined {
  const checks = querySql<{ status: string; metadata_json: string }>(
    "SELECT status, metadata_json FROM system_checks ORDER BY created_at DESC LIMIT 100"
  );
  for (const check of checks) {
    if (check.status !== "ok") continue;
    const metadata = parseJson<Record<string, unknown>>(check.metadata_json, {});
    const nestedMetadata = asRecord(metadata.metadata);
    const driver = stringValue(metadata.driver) ?? stringValue(nestedMetadata.driver);
    const connectionStrategy = asRecord(nestedMetadata.connectionStrategy ?? metadata.connectionStrategy);
    const recordingQa = asRecord(nestedMetadata.recordingQa ?? metadata.recordingQa);
    const geminiVideoQa = asRecord(nestedMetadata.geminiVideoQa ?? metadata.geminiVideoQa);
    const artifactValidationStatus = stringValue(nestedMetadata.artifactValidationStatus ?? metadata.artifactValidationStatus);
    const cdpUrl = normalizeSafeLocalCdpUrl(stringValue(connectionStrategy.cdpUrl));
    const profile = nonEmptyString(connectionStrategy.profile);

    if (driver !== "browser_use_cli") continue;
    if (stringValue(connectionStrategy.mode) !== "cdp_profile_lane") continue;
    if (stringValue(recordingQa.status) !== "present") continue;
    if (stringValue(geminiVideoQa.status) !== "present") continue;
    if (geminiVideoQa.exactBlocker !== null) continue;
    if (artifactValidationStatus !== "ok") continue;
    if (!cdpUrl) continue;
    if (!isLiveLocalCdpUrl(cdpUrl)) continue;
    return { cdpUrl, profile };
  }
  return undefined;
}

function isLiveLocalCdpUrl(cdpUrl: string): boolean {
  if (process.env.AUTOMATION_OS_BROWSER_USE_SYNC_CDP_PROBE !== "1") return true;
  const result = spawnSync("curl", ["-fsS", "-m", "1", `${cdpUrl.replace(/\/+$/, "")}/json/version`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0;
}

function recordBrowserUseLaneObservation(lane: BrowserUseLaneRow | undefined, result: BrowserUseLocalCheckResult) {
  if (!lane) return;
  const connection = result.metadata.connectionStrategy;
  const profileStrategy = connection.mode;
  const laneVisibility = nonEmptyString(lane.lane_visibility) ?? (connection.mode === "cdp_profile_lane" ? "visible" : "hidden");
  const health = result.status === "ok" ? "good" : "blocked";
  execSql(
    `UPDATE lanes
     SET browser_use_session=${sqlValue(result.metadata.session)},
         browser_use_cdp_url=${sqlValue(connection.cdpUrl)},
         browser_use_profile=${sqlValue(connection.profile)},
         profile_strategy=${sqlValue(profileStrategy)},
         lane_visibility=${sqlValue(laneVisibility)},
         health=${sqlValue(health)},
         updated_at=${sqlValue(result.createdAt)}
     WHERE id=${sqlValue(lane.id)};`
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCdpPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function cdpUrlFromPort(port: number | undefined): string | undefined {
  return port ? `http://127.0.0.1:${port}` : undefined;
}

function normalizeCdpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?$/);
  return match ? `http://127.0.0.1:${match[1]}` : value.replace(/\/+$/, "");
}

function normalizeSafeLocalCdpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?$/);
  return match ? `http://127.0.0.1:${match[1]}` : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function storeSystemCheck(result: BrowserUseLocalCheckResult | BrowserBridgeCheckResult) {
  insert("system_checks", {
    id: result.id,
    kind: result.kind,
    status: result.status,
    target_url: result.targetUrl,
    summary: result.summary,
    artifact_uri: result.screenshotPath ? `file://${result.screenshotPath}` : null,
    created_at: result.createdAt,
    metadata_json: result
  });
}

async function decideStoredApproval(id: string, status: "approved" | "rejected" | "cancelled", companyIds?: readonly string[]) {
  const existing = companyIds ? findScopedApproval(id, companyIds) : querySql<{
    id: string;
    company_id: string | null;
    run_id: string | null;
    status: string;
    requested_by: string;
    approval_group_id: string;
    resource_locks_json: string;
    created_at: string;
  }>(
    `SELECT id, company_id, run_id, status, requested_by, approval_group_id, resource_locks_json, created_at FROM approvals WHERE id=${sqlValue(id)} LIMIT 1`
  )[0];
  if (!existing) {
    return { statusCode: 404, body: { error: "approval_not_found" } };
  }
  if (existing.status !== "pending") {
    return { statusCode: 409, body: { error: "approval_already_decided", id, status: existing.status } };
  }
  const decidedAt = nowIso();
  execSql(
    `UPDATE approvals SET status=${sqlValue(status)}, decided_at=${sqlValue(decidedAt)}, decision_note=${sqlValue(
      status === "approved"
        ? "Approved from Control Panel"
        : status === "cancelled"
          ? "Cancelled from Control Panel"
          : "Rejected from Control Panel"
    )} WHERE id=${sqlValue(id)} AND company_id=${sqlValue(String(existing.company_id ?? ""))};`
  );
  const approval = querySql(`SELECT * FROM approvals WHERE id=${sqlValue(id)} AND company_id=${sqlValue(String(existing.company_id ?? ""))} LIMIT 1`)[0];
  if (status === "approved" && existing.run_id) {
    startWorkerOnceAfterApproval(existing.run_id);
  }
  if (status === "approved" && existing.requested_by === "trusted-bridge") {
    storeExecutorNotConnectedForApprovedBridgeApproval(existing);
  }
  if (status === "cancelled" && existing.run_id) {
    cancelRunAfterApprovalCancel(existing.run_id);
  }
  maybeAutoExportObsidian(`approval-${status}`);
  return { statusCode: 200, body: approval };
}

function startWorkerOnceAfterApproval(runId: string): void {
  recordRunAwaitingWorkerLoop(runId, "approval_decided");
}

function publicFixedRegisteredWorkflowFast(workflow: RegisteredWorkflowDefinition) {
  return {
    id: workflow.id,
    name: workflow.name,
    title: workflow.name,
    status: workflow.status,
    runnerStatus: workflow.runnerStatus,
    runnerKind: workflow.runnerKind,
    projectRoot: workflow.projectRoot,
    startCommand: workflow.startCommand,
    schedule: workflow.schedule,
    sourceRefs: workflow.sourceRefs,
    provenance: workflow.provenance
  };
}

function registeredWorkflowStartMetadataFromDefinition(
  workflow: RegisteredWorkflowDefinition,
  input: { source: "manual" | "scheduler"; dueKey?: string; command: string; executionRouting?: ReturnType<typeof buildExecutionRoutingSnapshot> }
) {
  const routeDecision =
    input.executionRouting ??
    buildExecutionRoutingSnapshot({
      command: input.command,
      source: input.source
    });
  return {
    registered_workflow_start: {
      source: input.source,
      workflowId: workflow.id,
      runnerKind: workflow.runnerKind,
      ...(input.dueKey ? { dueKey: input.dueKey } : {})
    },
    ...buildCanonicalExecutionRoutingMetadata(routeDecision)
  };
}

async function getPostgresRegisteredWorkflowRowFast(id: string): Promise<{ status: string; start_command_json: string } | null> {
  const databaseUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT status, start_command_json FROM registered_workflows WHERE id=$1 LIMIT 1",
      [id]
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

function startCommandFromRegisteredWorkflowRow(row: { start_command_json: string } | null): string | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.start_command_json || "{}") as { command?: unknown };
    return typeof parsed.command === "string" && parsed.command.trim() ? parsed.command : null;
  } catch {
    return null;
  }
}

async function startRegisteredPostgresRunFast(input: {
  workflow: { id: string; runner_kind?: string };
  command: string;
  metadata: Record<string, unknown>;
}): Promise<{ runId: string }> {
  const databaseUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("postgres_database_url_missing");
  const now = nowIso();
  const runId = makeId("run");
  const stepId = `${runId}_step_1`;
  const lane = visibleBrowserLaneForRecordReplay(registeredBrowserLaneForWorkflow(input.workflow.id));
  const adapter = input.workflow.runner_kind ?? "local_worker";
  const routeDecision = buildExecutionRoutingSnapshot({
    command: input.command,
    source: "manual"
  });
  const laneId = `${runId}_${lane?.id ?? "daily-ai-playwright-cli"}`;
  const metadata = {
    command: input.command,
    registered_workflow_start: {
      source: "manual",
      workflowId: input.workflow.id,
      runnerKind: input.workflow.runner_kind
    },
    ...input.metadata,
    ...buildCanonicalExecutionRoutingMetadata(routeDecision),
    ai_adapters: ["playwright_cli"],
    openai_api: "not_required",
    worker_protocol: "mac_worker_polling_required",
    worker_mode: "queued_for_mac_worker",
    worker_loop: {
      status: "waiting_for_pickup",
      launchReason: "registered_workflow_manual_start_fast_postgres",
      queuedAt: now,
      requiredCommand: "npm run worker:loop:stored"
    },
    mac_worker: {
      status: "waiting_for_pickup",
      launchReason: "registered_workflow_manual_start_fast_postgres",
      queuedAt: now,
      requiredCommand: "npm run worker:loop:stored"
    }
  };
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO runs (id, company_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined)
       VALUES ($1, NULL, $2, 'queued', $3, $4, $4, $5, 'automation-os', 0)`,
      [runId, input.command.slice(0, 72) || "Daily AI registered workflow run", input.command, now, JSON.stringify(metadata)]
    );
    await client.query(
      `INSERT INTO lanes
       (id, run_id, role, cdp_port, profile_dir, workdir, browser_use_session, browser_use_cdp_url, browser_use_profile,
        profile_strategy, lane_visibility, status, current_task, progress, health, resource_locks_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'cdp_profile_lane', $10, 'active', $11, 10, 'good', $12, $13)`,
      [
        laneId,
        runId,
        `${input.workflow.id} lane`,
        lane?.cdpPort ?? 0,
        lane?.profileDir ?? `/tmp/automation-os/profiles/${input.workflow.id}`,
        lane?.workdir ?? `/tmp/automation-os/workdirs/${input.workflow.id}`,
        lane?.browserUseSession ?? `browser-use-${input.workflow.id}`,
        lane?.browserUseCdpUrl ?? "",
        lane?.browserUseProfile ?? `/tmp/automation-os/profiles/${input.workflow.id}`,
        lane?.laneVisibility ?? "visible",
        input.command,
        JSON.stringify(lane ? [`browser:${input.workflow.id}`, "registered_workflow"] : ["registered_workflow"]),
        now
      ]
    );
    await client.query(
      `INSERT INTO run_steps (id, run_id, company_id, name, status, lane_id, started_at, completed_at, metadata_json)
       VALUES ($1, $2, NULL, $3, 'queued', $4, $5, NULL, $6)`,
      [
        stepId,
        runId,
        input.command,
        laneId,
        now,
        JSON.stringify({
          resources: lane ? [`browser:${input.workflow.id}`, "registered_workflow"] : ["registered_workflow"],
          dangerous_action: false,
          requires_approval: false,
          collision_with: [],
          collision_override_required: false,
          adapter,
          parallel_safe: false,
          ...buildCanonicalExecutionRoutingMetadata(routeDecision)
        })
      ]
    );
    await client.query(
      `INSERT INTO worker_events (id, run_id, company_id, step_id, lane_id, event_type, message, created_at, metadata_json)
       VALUES ($1, $2, NULL, NULL, NULL, 'queued_for_mac_worker', $3, $4, $5)`,
      [
        makeId("evt"),
        runId,
        "Run saved to production database and waiting for Mac worker pickup",
        now,
        JSON.stringify({
          worker_protocol: "mac_worker_polling_required",
          launch_reason: "registered_workflow_manual_start_fast_postgres",
          required_command: "npm run worker:loop:stored"
        })
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
  return { runId };
}

function startWorkerOnceDetached(runId: string, launchReason: string): void {
  if (process.env.NODE_TEST_CONTEXT === "1" && process.env.AUTOMATION_OS_TEST_ALLOW_DETACHED_WORKER !== "1") return;
  if (dbBackend === "postgres") {
    recordRunAwaitingMacWorker(runId, launchReason);
    return;
  }
  const logDir = join(process.cwd(), "data", "artifacts", "worker-once", runId);
  mkdirSync(logDir, { recursive: true });
  const outPath = join(logDir, "stdout.log");
  const errPath = join(logDir, "stderr.log");
  const workerPath = resolveWorkerOnceEntrypoint();
  const out = openSync(outPath, "a");
  const err = openSync(errPath, "a");
  const child = spawn(process.execPath, [workerPath, `--run-id=${runId}`], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env
  });
  child.once("error", (error) => {
    markWorkerOnceLaunchBlocked(runId, "worker_once_launch_failed", { error: error.message, worker_path: workerPath, stdout_log: outPath, stderr_log: errPath });
  });
  child.once("exit", (code, signal) => {
    if (code === 0) return;
    const current = querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
    if (!current || !["waiting_approval", "queued", "running"].includes(current.status)) return;
    const classification = classifyWorkerOnceExit(runId);
    markWorkerOnceLaunchBlocked(runId, classification.exactBlocker, {
      exit_status: code,
      signal,
      worker_path: workerPath,
      stdout_log: outPath,
      stderr_log: errPath,
      progress: classification.progress,
      launch_reason: launchReason
    });
  });
  child.unref();
  closeSync(out);
  closeSync(err);
}

function recordRunAwaitingMacWorker(runId: string, launchReason: string) {
  recordRunAwaitingWorkerLoop(runId, launchReason);
}

function readRunCompanyId(runId: string): string | null {
  const row = querySql<{ company_id: string | null }>(`SELECT company_id FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  return typeof row?.company_id === "string" && row.company_id.trim() ? row.company_id.trim() : null;
}

function recordRunAwaitingWorkerLoop(runId: string, launchReason: string) {
  const now = nowIso();
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const metadata = parseJson<Record<string, unknown>>(current?.metadata_json, {});
  const postgres = dbBackend === "postgres";
  const workerProtocol = postgres ? "mac_worker_polling_required" : "local_worker_loop_required";
  const workerMode = postgres ? "queued_for_mac_worker" : "queued_for_local_worker_loop";
  const requiredCommand = postgres ? "npm run worker:loop:stored" : "npm run worker:loop";
  execSql(
    `UPDATE runs
     SET metadata_json=${sqlValue({
       ...metadata,
       worker_protocol: workerProtocol,
       worker_mode: workerMode,
       worker_loop: {
         status: "waiting_for_pickup",
         launchReason,
         queuedAt: now,
         requiredCommand
       },
       mac_worker: {
         status: "waiting_for_pickup",
         launchReason,
         queuedAt: now,
         requiredCommand
       }
     })},
         updated_at=${sqlValue(now)}
     WHERE id=${sqlValue(runId)};`
  );
  insert("worker_events", {
    id: makeId("evt"),
    company_id: readRunCompanyId(runId),
    run_id: runId,
    step_id: null,
    lane_id: null,
    event_type: postgres ? "queued_for_mac_worker" : "queued_for_worker_loop",
    message: postgres
      ? "Run saved to production database and waiting for Mac worker pickup"
      : "Run saved to local database and waiting for worker loop pickup",
    created_at: now,
    metadata_json: {
      worker_protocol: workerProtocol,
      launch_reason: launchReason,
      required_command: requiredCommand
    }
  });
}

export function classifyWorkerOnceExit(runId: string): { exactBlocker: string; progress: RunWorkerProgressState } {
  const progress = getRunWorkerProgressState(runId);
  return {
    exactBlocker: progress.progressed ? "worker_once_exited_after_run_progress_without_final_status" : "worker_once_exited_before_run_progress",
    progress
  };
}

function resolveWorkerOnceEntrypoint(): string {
  const distPath = join(process.cwd(), "apps", "server", "dist", "cli", "workerOnce.js");
  if (existsSync(distPath)) return distPath;
  const siblingPath = fileURLToPath(new URL("./cli/workerOnce.js", import.meta.url));
  if (existsSync(siblingPath)) return siblingPath;
  throw new Error("worker_once_entrypoint_missing");
}

function markWorkerOnceLaunchBlocked(runId: string, exactBlocker: string, extra: Record<string, unknown>) {
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const metadata = parseJson<Record<string, unknown>>(current?.metadata_json, {});
  const now = nowIso();
  const workerMode = exactBlocker === "worker_once_exited_after_run_progress_without_final_status" ? "worker_once_after_progress" : "worker_once_launch";
  execSql(
    `UPDATE runs
     SET status='blocked',
         updated_at=${sqlValue(now)},
         metadata_json=${sqlValue({
           ...metadata,
           worker_protocol: "local_worker_v1",
           worker_mode: workerMode,
           proof_gate: { ok: false, missing: [exactBlocker], present: [] },
           proof_summary: `blocked: ${exactBlocker}`,
           exact_blocker: exactBlocker,
           worker_once: extra
         })}
     WHERE id=${sqlValue(runId)} AND status IN ('waiting_approval', 'queued', 'running');
     UPDATE run_steps
     SET status='blocked', completed_at=COALESCE(completed_at, ${sqlValue(now)})
     WHERE run_id=${sqlValue(runId)} AND status IN ('waiting_approval', 'queued', 'running') AND completed_at IS NULL;
     UPDATE lanes
     SET status='blocked', progress=0, health='blocked', updated_at=${sqlValue(now)}
     WHERE run_id=${sqlValue(runId)};`
  );
  insert("worker_events", {
    id: makeId("evt"),
    company_id: readRunCompanyId(runId),
    run_id: runId,
    step_id: null,
    lane_id: null,
    event_type: "worker_once_blocked",
    message: `Worker once blocked: ${exactBlocker}`,
    created_at: now,
    metadata_json: { exact_blocker: exactBlocker, worker_mode: workerMode, worker_once: extra }
  });
}

function cancelRunAfterApprovalCancel(runId: string) {
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  if (!current) return;
  const metadata = parseJson<Record<string, unknown>>(current.metadata_json, {});
  const now = nowIso();
  execSql(
    `UPDATE runs
     SET status='cancelled',
         updated_at=${sqlValue(now)},
         metadata_json=${sqlValue({ ...metadata, stop_reason: "approval_cancelled" })}
     WHERE id=${sqlValue(runId)};
     UPDATE run_steps
     SET status='cancelled', completed_at=COALESCE(completed_at, ${sqlValue(now)})
     WHERE run_id=${sqlValue(runId)} AND status NOT IN ('completed', 'skipped');
     UPDATE lanes
     SET status='idle',
         health='cancelled',
         current_task='cancelled by approval',
         updated_at=${sqlValue(now)}
     WHERE run_id=${sqlValue(runId)};`
  );
  insert("worker_events", {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    company_id: readRunCompanyId(runId),
    run_id: runId,
    step_id: null,
    lane_id: null,
    event_type: "run_cancelled",
    message: "Approval was cancelled from Control Panel",
    created_at: now,
    metadata_json: { stop_reason: "approval_cancelled" }
  });
}

function normalizeCreatePlannerRequestMessages(body: unknown): CreatePlannerMessage[] {
  const candidate = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const rawMessages = Array.isArray(candidate.messages)
    ? candidate.messages
    : Array.isArray(candidate.conversation)
      ? candidate.conversation
      : [];
  return rawMessages
    .map((message) => {
      const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
      return {
        role: record.role === "assistant" ? "assistant" as const : "user" as const,
        text: typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : ""
      };
    })
    .filter((message) => message.text.trim());
}

function sanitizeCreatePlannerJobForApi(job: CreatePlannerJob) {
  const streamText = typeof job.metadata.streamText === "string" ? job.metadata.streamText : "";
  const streamTextLength = typeof job.metadata.streamTextLength === "number" && Number.isFinite(job.metadata.streamTextLength)
    ? Math.max(0, Math.min(24_000, Math.floor(job.metadata.streamTextLength)))
    : Math.min(24_000, streamText.length);
  return {
    id: job.id,
    status: job.status,
    result: job.result,
    exactBlocker: job.exactBlocker,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attemptCount: job.attemptCount,
    metadata: {
      route: typeof job.metadata.route === "string" ? job.metadata.route : "mac_worker_subscription",
      immediatePlanSource: typeof job.metadata.immediatePlanSource === "string" ? job.metadata.immediatePlanSource : undefined,
      transport: typeof job.metadata.transport === "string" ? job.metadata.transport : undefined,
      codexThreadId: typeof job.metadata.codexThreadId === "string" ? job.metadata.codexThreadId : undefined,
      codexTurnId: typeof job.metadata.codexTurnId === "string" ? job.metadata.codexTurnId : undefined,
      contextCapturedAt: typeof job.metadata.contextCapturedAt === "string" ? job.metadata.contextCapturedAt : undefined,
      contextSnapshotHash: typeof job.metadata.contextSnapshotHash === "string" ? job.metadata.contextSnapshotHash : undefined,
      streamTextLength,
      events: Array.isArray(job.metadata.events)
        ? job.metadata.events
          .filter((event) => event && typeof event === "object")
          .slice(-40)
          .map((event) => {
            const safeEvent = { ...(event as Record<string, unknown>) };
            delete safeEvent.delta;
            return safeEvent;
          })
        : []
    }
  };
}

function plannerJobCompanyIds(job: CreatePlannerJob): string[] {
  return Array.isArray(job.metadata.companyIds)
    ? job.metadata.companyIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
}

function assertCreatePlannerJobAccess(job: CreatePlannerJob): void {
  const owner = typeof job.metadata.actorUserId === "string" ? job.metadata.actorUserId : "";
  if (owner && owner !== currentActorUserId()) throw new Error("create_planner_job_not_found");
  const companyIds = plannerJobCompanyIds(job);
  if (companyIds.length > 0 && !companyIds.some((companyId) => actorCompanyIds().includes(companyId))) {
    throw new Error("create_planner_job_not_found");
  }
}

function assertCreatePlannerThreadAccess(threadId: string, companyIds: readonly string[], actorUserId: string): void {
  const normalized = threadId.trim();
  if (!normalized) return;
  const rows = querySql<{ metadata_json: string }>("SELECT metadata_json FROM create_planner_jobs ORDER BY created_at DESC LIMIT 1000");
  const allowed = rows.some((row) => {
    const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
    const owner = typeof metadata.actorUserId === "string" ? metadata.actorUserId : "";
    const boundCompanies = Array.isArray(metadata.companyIds)
      ? metadata.companyIds.filter((value): value is string => typeof value === "string")
      : [];
    return metadata.codexThreadId === normalized
      && owner === actorUserId
      && (boundCompanies.length === 0 || boundCompanies.some((companyId) => companyIds.includes(companyId)));
  });
  if (!allowed) throw new Error("codex_thread_scope_forbidden");
}

function buildAutomationOsChatSnapshot(companyIds: string[]): string {
  const state = getMvpStateReadback(companyIds);
  initRegisteredWorkflows();
  const registeredWorkflows = publicRegisteredWorkflowRows(listRegisteredWorkflowsForCompanies(companyIds));
  const capturedAt = new Date().toISOString();
  return serializeAutomationOsChatSnapshot({
    capturedAt,
    source: "automation_os_control_plane_readback",
    companyScope: companyIds,
    companies: state.companies.map((company) => ({ id: company.id, name: company.name, status: company.status, role: company.role })),
    automations: state.automations.slice(0, 120).map((automation: Record<string, unknown>) => ({
      id: automation.id,
      company_id: automation.company_id,
      name: automation.name,
      goal: automation.goal,
      status: automation.status,
      revision: automation.revision,
      schedule: automation.schedule,
      schedule_status: automation.schedule_status,
      next_run_at: automation.next_run_at,
      last_run_at: automation.last_run_at,
      lane: automation.lane,
      risk_level: automation.risk_level,
      approval_policy: automation.approval_policy
    })),
    presentationProfiles: state.presentation_profiles,
    schedules: state.schedules.slice(0, 120).map((schedule: Record<string, unknown>) => ({
      id: schedule.id,
      company_id: schedule.company_id,
      automation_id: schedule.automation_id,
      expression: schedule.expression,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      status: schedule.status,
      revision: schedule.revision,
      next_run_at: schedule.next_run_at,
      last_run_at: schedule.last_run_at
    })),
    runs: state.runs.slice(0, 80).map((run: Record<string, unknown>) => ({
      id: run.id,
      company_id: run.company_id,
      automation_id: run.automation_id,
      name: run.name,
      objective: run.objective,
      status: run.status,
      created_at: run.created_at,
      updated_at: run.updated_at
    })),
    approvals: state.approvals.slice(0, 80).map((approval: Record<string, unknown>) => ({
      id: approval.id,
      run_id: approval.run_id,
      status: approval.status,
      title: approval.title,
      created_at: approval.created_at
    })),
    worker: state.worker,
    registeredWorkflows,
    browserUse: buildBrowserUseRuntimeSnapshot(),
    freshness: { capturedAt, stalePolicy: "show_stale_and_exact_blocker" },
    boundaries: {
      externalActionExecuted: false,
      approvalRequired: true,
      secretsIncluded: false,
      rawPrivatePathsIncluded: false
    }
  });
}
