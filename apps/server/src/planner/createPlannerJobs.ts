import { insert, makeId, nowIso, querySql, sqlValue } from "../db/client.js";
import { CodexAppServerClient } from "../codex/appServerClient.js";
import { createCodexAppServerPlannerResponse, createPlannerResponse, type CreatePlannerMessage, type CreatePlannerResult } from "./createPlanner.js";

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
  metadata: Record<string, unknown>;
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
};

type CreatePlannerJobProcessOptions = {
  appServerClient?: CodexAppServerClient;
};

let sharedAppServerClient: CodexAppServerClient | null = null;

export function enqueueCreatePlannerJob(input: {
  messages: CreatePlannerMessage[];
  currentDraft?: string;
  metadata?: Record<string, unknown>;
}): CreatePlannerJob {
  const now = nowIso();
  const id = makeId("create_planner_job");
  insert("create_planner_jobs", {
    id,
    status: "queued",
    messages_json: input.messages,
    current_draft: input.currentDraft ?? "",
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

export async function processQueuedCreatePlannerJobs(limit = 1, options: CreatePlannerJobProcessOptions = {}): Promise<CreatePlannerJob[]> {
  const rows = querySql<CreatePlannerJobRow>(
    `SELECT * FROM create_planner_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(10, Math.floor(limit))) || 1}`
  );
  const processed: CreatePlannerJob[] = [];
  for (const row of rows) {
    processed.push(await processCreatePlannerJob(row, options));
  }
  return processed;
}

async function processCreatePlannerJob(row: CreatePlannerJobRow, options: CreatePlannerJobProcessOptions = {}): Promise<CreatePlannerJob> {
  const startedAt = nowIso();
  querySql(
    `UPDATE create_planner_jobs
     SET status='running', started_at=COALESCE(started_at, ${sqlValue(startedAt)}), updated_at=${sqlValue(startedAt)}
     WHERE id=${sqlValue(row.id)} AND status='queued'
     RETURNING id`
  );

  const messages = parseJson<CreatePlannerMessage[]>(row.messages_json, []);
  const currentDraft = row.current_draft ?? "";
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  const transport = metadata.transport === "codex_app_server" ? "codex_app_server" : "codex_exec";
  try {
    const resultWithMetadata = transport === "codex_app_server"
      ? await createCodexAppServerPlannerResponse({
          messages,
          currentDraft,
          threadId: typeof metadata.codexThreadId === "string" ? metadata.codexThreadId : undefined,
          context: typeof metadata.contextSnapshot === "string" ? metadata.contextSnapshot : undefined,
          client: options.appServerClient ?? getSharedAppServerClient()
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
    querySql(
      `UPDATE create_planner_jobs SET metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(row.id)} RETURNING id`
    );
    const completedAt = nowIso();
    const status: CreatePlannerJobStatus = result.source === "local_codex" || result.source === "codex_app_server" ? "completed" : "blocked";
    const blocker = status === "completed" ? "" : result.exactBlocker || "codex_planner_failed";
    querySql(
      `UPDATE create_planner_jobs
       SET status=${sqlValue(status)},
           result_json=${sqlValue(result)},
           exact_blocker=${sqlValue(blocker || null)},
           completed_at=${sqlValue(completedAt)},
           updated_at=${sqlValue(completedAt)}
       WHERE id=${sqlValue(row.id)}
       RETURNING id`
    );
  } catch (error) {
    const completedAt = nowIso();
    const blocker = error instanceof Error ? error.message : "codex_planner_failed";
    querySql(
      `UPDATE create_planner_jobs
       SET status='blocked',
           exact_blocker=${sqlValue(blocker)},
           completed_at=${sqlValue(completedAt)},
           updated_at=${sqlValue(completedAt)}
       WHERE id=${sqlValue(row.id)}
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
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {})
  };
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
