import { insert, makeId, nowIso, querySql, sqlValue } from "../db/client.js";
import { CodexAppServerClient } from "../codex/appServerClient.js";
import { redactSensitiveText } from "../obsidian/redaction.js";
import { createCodexAppServerPlannerResponse, createPlannerResponse, type CreatePlannerMessage, type CreatePlannerResult } from "./createPlanner.js";
import { hostname } from "node:os";

export type CreatePlannerJobStatus = "queued" | "running" | "completed" | "blocked";

export type CreatePlannerJob = {
  id: string;
  status: CreatePlannerJobStatus;
  messages: CreatePlannerMessage[];
  currentDraft: string;
  result?: CreatePlannerResult;
  exactBlocker?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attemptCount?: number;
  metadata: Record<string, unknown>;
};

export type CreateChatThreadReadback = {
  threadId: string;
  latestJobId: string;
  latestStatus: CreatePlannerJobStatus;
  updatedAt: string;
  companyIds: string[];
  messages: CreatePlannerMessage[];
  serverReply?: string;
  resultTitle?: string;
};

type CreatePlannerJobRow = {
  id: string;
  status: string;
  messages_json: string;
  current_draft: string;
  result_json: string;
  exact_blocker?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  metadata_json: string;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  attempt_count?: number | null;
};

export type CreatePlannerJobProcessOptions = {
  appServerClient?: CodexAppServerClient;
  workerId?: string;
  leaseMs?: number;
};

let sharedAppServerClient: CodexAppServerClient | null = null;
const defaultLeaseMs = 10 * 60 * 1000;

export function enqueueCreatePlannerJob(input: {
  messages: CreatePlannerMessage[];
  currentDraft?: string;
  metadata?: Record<string, unknown>;
}): CreatePlannerJob {
  const now = nowIso();
  const id = makeId("create_planner_job");
  const messages = input.messages.map((message) => ({
    role: message.role,
    text: redactSensitiveText(message.text).slice(0, 12_000)
  }));
  insert("create_planner_jobs", {
    id,
    status: "queued",
    messages_json: messages,
    current_draft: redactSensitiveText(input.currentDraft ?? "").slice(0, 12_000),
    result_json: {},
    exact_blocker: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    metadata_json: input.metadata ?? {}
  });
  return getCreatePlannerJob(id) as CreatePlannerJob;
}

export function getCreatePlannerJob(id: string): CreatePlannerJob | undefined {
  if (!id.trim()) return undefined;
  const row = querySql<CreatePlannerJobRow>(
    `SELECT * FROM create_planner_jobs WHERE id=${sqlValue(id)} LIMIT 1`
  )[0];
  return row ? mapCreatePlannerJob(row) : undefined;
}

/**
 * Return only the actor/company-scoped conversation projection needed to
 * resume the web chat.  The App Server owns the actual thread history; the
 * planner job stores a redacted UI projection so a browser reload can recover
 * the same conversation without exposing the prompt snapshot or raw events.
 */
export function listCreateChatThreads(input: {
  companyIds: readonly string[];
  actorUserId: string;
  limit?: number;
}): CreateChatThreadReadback[] {
  const allowedCompanies = new Set(input.companyIds.filter((value) => value.trim()));
  if (allowedCompanies.size === 0) return [];
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20) || 20));
  const rows = querySql<CreatePlannerJobRow>(
    `SELECT * FROM create_planner_jobs ORDER BY updated_at DESC, created_at DESC LIMIT ${Math.min(500, limit * 20)}`
  );
  const byThread = new Map<string, CreateChatThreadReadback>();
  for (const row of rows) {
    const job = mapCreatePlannerJob(row);
    const metadata = job.metadata;
    const owner = typeof metadata.actorUserId === "string" ? metadata.actorUserId : "";
    if (owner && owner !== input.actorUserId) continue;
    const companyIds = plannerJobCompanyIds(metadata);
    if (companyIds.length === 0 || !companyIds.some((companyId) => allowedCompanies.has(companyId))) continue;
    const threadId = typeof metadata.codexThreadId === "string" ? metadata.codexThreadId.trim() : "";
    if (!threadId || byThread.has(threadId)) continue;
    const result = job.result;
    byThread.set(threadId, {
      threadId,
      latestJobId: job.id,
      latestStatus: job.status,
      updatedAt: job.updatedAt,
      companyIds: companyIds.filter((companyId) => allowedCompanies.has(companyId)),
      messages: job.messages.map((message) => ({
        role: message.role,
        text: redactSensitiveText(message.text).slice(0, 12_000)
      })),
      ...(result?.reply ? { serverReply: redactSensitiveText(result.reply).slice(0, 2_400) } : {}),
      ...(result?.title ? { resultTitle: redactSensitiveText(result.title).slice(0, 90) } : {})
    });
    if (byThread.size >= limit) break;
  }
  return [...byThread.values()];
}

export async function processQueuedCreatePlannerJobs(limit = 1, options: CreatePlannerJobProcessOptions = {}): Promise<CreatePlannerJob[]> {
  const workerId = normalizeWorkerId(options.workerId);
  const leaseMs = boundedLeaseMs(options.leaseMs);
  recoverExpiredCreatePlannerLeases();
  const processed: CreatePlannerJob[] = [];
  const maxJobs = Math.max(1, Math.min(10, Math.floor(limit))) || 1;
  for (let index = 0; index < maxJobs; index += 1) {
    const claimed = claimCreatePlannerJob(workerId, leaseMs);
    if (!claimed) break;
    processed.push(await processCreatePlannerJob(claimed, { ...options, workerId, leaseMs }));
  }
  return processed;
}

function recoverExpiredCreatePlannerLeases(): void {
  const now = nowIso();
  querySql(
    `UPDATE create_planner_jobs
     SET status='queued', lease_owner=NULL, lease_expires_at=NULL, updated_at=${sqlValue(now)}
     WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${sqlValue(now)}
     RETURNING id`
  );
}

function claimCreatePlannerJob(workerId: string, leaseMs: number): CreatePlannerJobRow | undefined {
  const startedAt = nowIso();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  return querySql<CreatePlannerJobRow>(
    `UPDATE create_planner_jobs
     SET status='running',
         started_at=COALESCE(started_at, ${sqlValue(startedAt)}),
         updated_at=${sqlValue(startedAt)},
         lease_owner=${sqlValue(workerId)},
         lease_expires_at=${sqlValue(leaseExpiresAt)},
         attempt_count=COALESCE(attempt_count, 0) + 1
     WHERE id=(
       SELECT id FROM create_planner_jobs
       WHERE status='queued'
       ORDER BY created_at ASC, id ASC
       LIMIT 1
     )
       AND status='queued'
     RETURNING *`
  )[0];
}

async function processCreatePlannerJob(row: CreatePlannerJobRow, options: CreatePlannerJobProcessOptions = {}): Promise<CreatePlannerJob> {
  const messages = parseJson<CreatePlannerMessage[]>(row.messages_json, []);
  const currentDraft = row.current_draft ?? "";
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  const transport = metadata.transport === "codex_app_server" ? "codex_app_server" : "codex_exec";
  const workerId = normalizeWorkerId(options.workerId);
  let progressText = typeof metadata.streamText === "string" ? redactSensitiveText(metadata.streamText).slice(-24_000) : "";
  let progressEvents = Array.isArray(metadata.events) ? metadata.events.filter((event) => event && typeof event === "object").slice(-160) : [];
  let lastProgressWriteAt = 0;
  const persistProgress = (event: { method: string; threadId?: string; turnId?: string; itemId?: string; delta?: string; status?: string; capturedAt: string }) => {
    if (event.delta) progressText = `${progressText}${redactSensitiveText(event.delta)}`.slice(-24_000);
    progressEvents = [...progressEvents, event].slice(-160);
    const now = Date.now();
    if (event.method !== "turn/completed" && now - lastProgressWriteAt < 250) return;
    lastProgressWriteAt = now;
    const progressMetadata = {
      ...metadata,
      transport,
      ...(event.threadId ? { codexThreadId: event.threadId } : {}),
      ...(event.turnId ? { codexTurnId: event.turnId } : {}),
      streamText: progressText,
      events: progressEvents
    };
    querySql(
      `UPDATE create_planner_jobs
       SET metadata_json=${sqlValue(progressMetadata)}, updated_at=${sqlValue(nowIso())}
       WHERE id=${sqlValue(row.id)} AND status='running' AND lease_owner=${sqlValue(workerId)}
       RETURNING id`
    );
  };
  try {
    const resultWithMetadata = transport === "codex_app_server"
      ? await createCodexAppServerPlannerResponse({
          messages,
          currentDraft,
          threadId: typeof metadata.codexThreadId === "string" ? metadata.codexThreadId : undefined,
          context: typeof metadata.contextSnapshot === "string" ? metadata.contextSnapshot : undefined,
          client: options.appServerClient ?? getSharedAppServerClient(),
          onEvent: persistProgress
        })
      : null;
    const result = resultWithMetadata?.result ?? await createPlannerResponse({ messages, currentDraft, providerOverride: "codex" });
    const nextMetadata = resultWithMetadata
      ? {
          ...metadata,
          transport,
          codexThreadId: resultWithMetadata.threadId,
          codexTurnId: resultWithMetadata.turnId,
          streamText: resultWithMetadata.streamText.slice(-24_000),
          events: resultWithMetadata.events.slice(-160)
        }
      : { ...metadata, transport };
    const metadataUpdated = querySql(
      `UPDATE create_planner_jobs
       SET metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(nowIso())}
       WHERE id=${sqlValue(row.id)} AND status='running' AND lease_owner=${sqlValue(workerId)}
       RETURNING id`
    );
    if (metadataUpdated.length === 0) return getCreatePlannerJob(row.id) as CreatePlannerJob;
    const completedAt = nowIso();
    const status: CreatePlannerJobStatus = result.source === "local_codex" || result.source === "codex_app_server" ? "completed" : "blocked";
    const blocker = status === "completed" ? "" : result.exactBlocker || "codex_planner_failed";
    const terminal = querySql(
      `UPDATE create_planner_jobs
       SET status=${sqlValue(status)},
           result_json=${sqlValue(result)},
           exact_blocker=${sqlValue(blocker || null)},
           completed_at=${sqlValue(completedAt)},
           updated_at=${sqlValue(completedAt)},
           lease_owner=NULL,
           lease_expires_at=NULL
       WHERE id=${sqlValue(row.id)} AND status='running' AND lease_owner=${sqlValue(workerId)}
       RETURNING id`
    );
    if (terminal.length === 0) return getCreatePlannerJob(row.id) as CreatePlannerJob;
  } catch (error) {
    const completedAt = nowIso();
    const blocker = error instanceof Error ? error.message : "codex_planner_failed";
    querySql(
      `UPDATE create_planner_jobs
       SET status='blocked',
           exact_blocker=${sqlValue(blocker)},
           completed_at=${sqlValue(completedAt)},
           updated_at=${sqlValue(completedAt)},
           lease_owner=NULL,
           lease_expires_at=NULL
       WHERE id=${sqlValue(row.id)} AND status='running' AND lease_owner=${sqlValue(workerId)}
       RETURNING id`
    );
  }

  return getCreatePlannerJob(row.id) as CreatePlannerJob;
}

function getSharedAppServerClient(): CodexAppServerClient {
  if (!sharedAppServerClient) sharedAppServerClient = new CodexAppServerClient();
  return sharedAppServerClient;
}

function mapCreatePlannerJob(row: CreatePlannerJobRow): CreatePlannerJob {
  const result = parseJson<CreatePlannerResult | undefined>(row.result_json, undefined);
  return {
    id: row.id,
    status: normalizeStatus(row.status),
    messages: parseJson<CreatePlannerMessage[]>(row.messages_json, []),
    currentDraft: row.current_draft ?? "",
    result,
    exactBlocker: row.exact_blocker ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {})
  };
}

function normalizeWorkerId(value?: string): string {
  const configured = value?.trim() || process.env.AUTOMATION_OS_WORKER_ID?.trim();
  return (configured || `mac-worker-${hostname()}-${process.pid}`).slice(0, 180);
}

function boundedLeaseMs(value?: number): number {
  const configured = value ?? Number(process.env.AUTOMATION_OS_CREATE_PLANNER_LEASE_MS);
  if (!Number.isFinite(configured)) return defaultLeaseMs;
  return Math.max(30_000, Math.min(15 * 60 * 1000, Math.floor(configured)));
}

function plannerJobCompanyIds(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.companyIds)
    ? metadata.companyIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
}

function normalizeStatus(value: string): CreatePlannerJobStatus {
  return value === "running" || value === "completed" || value === "blocked" ? value : "queued";
}

function parseJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
