import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// This projection test must not classify an unrelated host worker as its fixture worker.
process.env.AUTOMATION_OS_READ_LIVE_PROCESS_TABLE = "0";
const previousPortableArtifactRoot = process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT;
const isolatedPortableArtifactRoot = mkdtempSync(join(tmpdir(), "aos-postgres-mvp-state-test-"));
process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT = isolatedPortableArtifactRoot;
test.after(() => {
  if (previousPortableArtifactRoot === undefined) delete process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT;
  else process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT = previousPortableArtifactRoot;
  rmSync(isolatedPortableArtifactRoot, { recursive: true, force: true });
});
import {
  classifyQueuedJobFreshness,
  classifyPostgresMvpStateError,
  postgresMvpStateCacheTtlMs,
  postgresMvpStateQueryTimeoutMs,
  readPostgresMvpState,
  startupMvpStateWarmupOptions,
  type PostgresMvpStateQueryClient
} from "../runs/postgresMvpState.js";

test("full, UI and summary profiles contain usable fields and exact-company persisted overrides", async () => {
  const companyId = "profile_projection_company";
  let memory: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const queryClient: PostgresMvpStateQueryClient = { async query(text) {
    calls.push(text);
    if (text.includes("FROM company_memberships")) return { rows: [{ id: companyId, name: "Company", status: "active", role: "owner" }] };
    if (text.includes("FROM mvp_automations")) return { rows: [{ id: "own", company_id: companyId, name: "Daily AI" }, { id: "foreign", company_id: "other", name: "Jobs" }] };
    if (text.includes("FROM company_memory_entries")) return { rows: memory };
    return { rows: [] };
  } };
  for (const projection of ["full", "ui", "summary"] as const) {
    const read = async () => (await readPostgresMvpState({ companyId, actorUserId: "profile_actor", projection, queryClient, forceFresh: true })).presentation_profiles as any[];
    memory = [{ company_id: "other", memory_key: "project_profile", body: JSON.stringify({ label: "Foreign" }), revision: 8 }];
    let profile = (await read())[0];
    assert.equal(profile.id, companyId);
    assert.equal(profile.company_id, companyId);
    assert.equal(profile.kind, "social", "foreign catalog must not influence this company");
    assert.ok(profile.widgets.length);
    assert.equal(profile.source, "derived_from_project_automation_catalog");
    memory.push({ company_id: companyId, memory_key: "project_profile", body: JSON.stringify({ label: "Saved", kind: "research", preferredGrouping: "week" }), revision: 3 });
    profile = (await read())[0];
    assert.equal(profile.label, "Saved");
    assert.equal(profile.revision, 3);
    assert.equal(profile.preferredGrouping, "week");
    memory[1].body = "broken-json";
    profile = (await read())[0];
    assert.ok(profile.exactBlocker);
    assert.equal(profile.revision, 3);
  }
  assert.ok(calls.every((query) => !/\b(INSERT|UPDATE|DELETE|ALTER)\b/u.test(query)));
  assert.ok(calls.some((query) => query.includes("memory_key='project_profile'") && query.includes("company_id=ANY($1::text[])")));
});

test("startup MVP state warm-up follows the dashboard's default company scope", () => {
  assert.deepEqual(startupMvpStateWarmupOptions({}), {});
  assert.deepEqual(startupMvpStateWarmupOptions({ AUTOMATION_OS_COMPANY_ID: "  company_boot  " }), { companyId: "company_boot" });
  assert.deepEqual(startupMvpStateWarmupOptions({ AUTOMATION_OS_COMPANY_ID: "   " }), {});
});

test("Postgres MVP state query timeout is bounded and configurable", () => {
  const previous = process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS;
  try {
    delete process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS;
    assert.equal(postgresMvpStateQueryTimeoutMs(), 20_000);
    process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS = "45000";
    assert.equal(postgresMvpStateQueryTimeoutMs(), 45_000);
    process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS = "1000";
    assert.equal(postgresMvpStateQueryTimeoutMs(), 20_000);
    process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS = "180000";
    assert.equal(postgresMvpStateQueryTimeoutMs(), 20_000);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS = previous;
  }
});

test("Postgres MVP state uses bounded summary/UI/Chat caches and a shorter full-state cache", () => {
  assert.equal(postgresMvpStateCacheTtlMs("summary"), 60_000);
  assert.equal(postgresMvpStateCacheTtlMs("ui"), 15_000);
  assert.equal(postgresMvpStateCacheTtlMs("chat"), 15_000);
  assert.equal(postgresMvpStateCacheTtlMs("full"), 5_000);
});

test("Postgres MVP state timeout is reduced to one stable read-only blocker", () => {
  assert.equal(classifyPostgresMvpStateError(new Error("Query read timeout")), "mvp_state_postgres_read_timeout");
  assert.equal(classifyPostgresMvpStateError(Object.assign(new Error("connect failed"), { code: "ETIMEDOUT" })), "mvp_state_postgres_read_timeout");
  assert.equal(classifyPostgresMvpStateError(new Error("company_scope_forbidden")), null);
});

test("Postgres MVP state readback bounds a hung query client", async () => {
  const previous = process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS;
  process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS = "5000";
  try {
    const startedAt = Date.now();
    await assert.rejects(
      readPostgresMvpState({
        actorUserId: "actor_hung_state_test",
        companyId: "company_hung_state_test",
        queryClient: { query: async () => await new Promise<{ rows: Array<Record<string, unknown>> }>(() => undefined) }
      }),
      /Query read timeout/
    );
    assert.ok(Date.now() - startedAt < 8_000);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS = previous;
  }
});

test("queued readback distinguishes fresh records from historical records", () => {
  const nowMs = Date.parse("2026-08-15T00:00:00.000Z");
  assert.equal(classifyQueuedJobFreshness({ status: "queued", availableAt: "2026-08-14T12:00:00.000Z", nowMs }), "fresh");
  assert.equal(classifyQueuedJobFreshness({ status: "queued", availableAt: "2026-08-12T00:00:00.000Z", nowMs }), "historical");
  assert.equal(classifyQueuedJobFreshness({ status: "queued", availableAt: "not-a-date", nowMs }), "unknown");
  assert.equal(classifyQueuedJobFreshness({ status: "completed", availableAt: "2026-08-01T00:00:00.000Z", nowMs }), "not_queued");
});

class ReadOnlyQueryClient implements PostgresMvpStateQueryClient {
  calls: Array<{ text: string; values: unknown[] }> = [];

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values });
    if (text.includes("FROM company_memberships")) {
      return {
        rows: [{
          id: "company_test",
          slug: "company-test",
          name: "Company Test",
          status: "active",
          role: "owner",
          created_at: "2026-08-07T00:00:00.000Z",
          updated_at: "2026-08-07T00:00:00.000Z"
        }]
      };
    }
    return { rows: [] };
  }
}

test("all Postgres projections show the saved schedule and shared execution contract instead of legacy manual fields", async () => {
  const companyId = "company_schedule_projection";
  const calls: string[] = [];
  const queryClient: PostgresMvpStateQueryClient = {
    async query(text) {
      calls.push(text);
      if (text.includes("FROM company_memberships")) return { rows: [{ id: companyId, name: "Company", status: "active", role: "owner" }] };
      if (text.includes("FROM mvp_automations")) return { rows: [
        { id: "scheduled", company_id: companyId, name: "Gmail", worker_command_kind: "gmail_registered", status: "active", schedule: "manual", cadence: "manual", revision: 5, current_version_id: "version-5" },
        { id: "manual", company_id: companyId, name: "Draft", worker_command_kind: "safe_local_demo", status: "draft", schedule: "09:00", cadence: "daily" },
        { id: "portable", company_id: companyId, name: "Daily AI", worker_command_kind: "daily_ai_registered", status: "active" }
      ] };
      if (text.includes("FROM mvp_automation_schedules")) return { rows: [
        { id: "foreign-schedule", automation_id: "manual", company_id: "foreign", kind: "daily", expression: "12:00", enabled: 1 },
        { id: "schedule-7", automation_id: "scheduled", company_id: companyId, kind: "daily", expression: "07:30", timezone: "Asia/Tokyo", status: "active", enabled: 1, revision: 7, automation_version_id: "version-5", next_run_at: "2026-09-06T22:30:00Z", last_run_at: "2026-09-05T22:30:00Z" }
      ] };
      return { rows: [] };
    }
  };
  for (const projection of ["summary", "ui", "chat", "full"] as const) {
    const state = await readPostgresMvpState({ actorUserId: "actor_schedule_projection", companyId, queryClient, projection, forceFresh: true });
    const automations = state.automations as Array<Record<string, unknown>>;
    const scheduled = automations.find((row) => row.id === "scheduled")!;
    assert.equal(scheduled.schedule, "07:30", projection);
    assert.equal(scheduled.cadence, "daily");
    assert.equal(scheduled.schedule_enabled, true);
    assert.equal(scheduled.schedule_revision, 7);
    assert.equal(scheduled.schedule_timezone, "Asia/Tokyo");
    assert.equal(scheduled.pinned_schedule_version_id, "version-5");
    assert.equal(scheduled.next_run_at, "2026-09-06T22:30:00Z");
    assert.equal(scheduled.last_run_at, "2026-09-05T22:30:00Z");
    assert.equal(scheduled.execution_mode, "registered_workflow_readback");
    assert.equal(scheduled.status, "active");
    const manual = automations.find((row) => row.id === "manual")!;
    assert.equal(manual.schedule, "manual", "neither a legacy hint nor foreign schedule is an enabled schedule");
    assert.equal(manual.schedule_enabled, false);
    assert.equal(manual.next_run_at, null);
    assert.equal(manual.execution_mode, "control_plane_dry_run");
    const portable = automations.find((row) => row.id === "portable")!;
    assert.equal(portable.execution_mode, "portable_mac_worker_queue");
    assert.equal(portable.external_action_allowed, false);
  }
  assert.ok(calls.every((text) => !/\b(INSERT|UPDATE|DELETE|ALTER)\b/u.test(text)));
});

test("Postgres MVP readback enforces company scope and remains read-only", async () => {
  const client = new ReadOnlyQueryClient();
  const first = await readPostgresMvpState({
    actorUserId: "actor_postgres_state_test",
    companyId: "company_test",
    queryClient: client
  });
  const second = await readPostgresMvpState({
    actorUserId: "actor_postgres_state_test",
    companyId: "company_test",
    queryClient: client
  });

  assert.deepEqual(first.company_scope, {
    enforced: true,
    company_ids: ["company_test"],
    actor_user_id: "actor_postgres_state_test"
  });
  assert.equal(first.external_action_executed, false);
  assert.equal(first.readback_source, "postgres_persistent_read_pool");
  assert.equal((first.readback_cache as { status: string }).status, "fresh");
  assert.equal((second.readback_cache as { status: string }).status, "cached");
  assert.equal(client.calls.length > 1, true);
  assert.equal(
    client.calls.every(({ text }) => !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/iu.test(text)),
    true
  );
  assert.equal(
    client.calls
      .filter(({ text }) => text.includes("FROM company_memberships"))
      .every(({ values }) => values[0] === "actor_postgres_state_test"),
    true
  );
});

test("Postgres MVP diagnostics separate membership, fan-out, mapping, and runtime timing", async () => {
  const timing: import("../runs/postgresMvpState.js").MvpStateReadTiming = {};
  const state = await readPostgresMvpState({
    actorUserId: "actor_postgres_timing_test",
    companyId: "company_test",
    projection: "ui",
    forceFresh: true,
    queryClient: new ReadOnlyQueryClient(),
    timing
  });
  assert.equal((state.company_scope as { company_ids?: string[] })?.company_ids?.[0], "company_test");
  assert.equal(timing.projection, "ui");
  assert.equal(timing.cacheStatus, "fresh");
  assert.equal(typeof timing.membershipMs, "number");
  assert.equal(typeof timing.dbFanoutMs, "number");
  assert.equal(typeof timing.mappingMs, "number");
  assert.equal(typeof timing.runtimeSnapshotMs, "number");
  assert.equal(typeof timing.totalMs, "number");
  assert.ok((timing.queryCount ?? 0) > 0);
  assert.ok((timing.queryTimings ?? []).some((query) => query.label === "company_memberships"));
  assert.ok((timing.queryTimings ?? []).every((query) => query.durationMs >= 0 && query.rowCount >= 0));
});

test("Postgres UI projection avoids detail-only query fan-out while keeping blocker metadata", async () => {
  const client = new ReadOnlyQueryClient();
  await readPostgresMvpState({
    actorUserId: "actor_postgres_ui_columns_test",
    companyId: "company_test",
    queryClient: client,
    projection: "ui"
  });
  const runsQuery = client.calls.find((call) => /FROM runs WHERE/u.test(call.text));
  const stepsQuery = client.calls.find((call) => /FROM run_steps WHERE/u.test(call.text));
  const eventsQuery = client.calls.find((call) => /FROM worker_events WHERE/u.test(call.text));
  assert.ok(runsQuery);
  assert.equal(stepsQuery, undefined);
  assert.equal(eventsQuery, undefined);
  assert.doesNotMatch(runsQuery.text, /SELECT \* FROM runs/u);
  assert.match(runsQuery.text, /metadata_json/u);
});

test("Postgres UI projection keeps a complete company-scoped guide-run candidate set separate from dashboard runs", async () => {
  const companyId = "company_guide_runs";
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: companyId, name: "Guide company", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM mvp_automations")) {
        return { rows: [{ id: "guide-automation", company_id: companyId, name: "Backup", builder_spec_json: JSON.stringify({ canonicalWorkflowId: "daily-backup-safety-check" }) }] };
      }
      if (text.includes("automation_id=ANY($2::text[])")) {
        return {
          rows: [
            { id: "guide-newer-running", company_id: companyId, automation_id: "guide-automation", status: "running", created_at: "2026-09-09T02:00:00.000Z", updated_at: "2026-09-09T02:00:00.000Z", metadata_json: JSON.stringify({ workflow_id: "daily-backup-safety-check" }) },
            { id: "guide-older-complete", company_id: companyId, automation_id: "guide-automation", status: "complete", created_at: "2026-09-09T01:00:00.000Z", updated_at: "2026-09-09T01:00:00.000Z", metadata_json: JSON.stringify({ workflow_id: "daily-backup-safety-check" }) }
          ]
        };
      }
      if (text.includes("FROM runs WHERE")) {
        return { rows: [{ id: "dashboard-run", company_id: companyId, automation_id: "other", status: "complete", created_at: "2026-09-09T03:00:00.000Z", updated_at: "2026-09-09T03:00:00.000Z" }] };
      }
      return { rows: [] };
    }
  };
  const state = await readPostgresMvpState({ actorUserId: "guide-actor", companyId, queryClient: client, projection: "ui", forceFresh: true });
  assert.deepEqual((state.workflowStartGuideRuns as Array<Record<string, unknown>>).map((run) => run.id), ["guide-newer-running", "guide-older-complete"]);
  assert.deepEqual((state.runs as Array<Record<string, unknown>>).map((run) => run.id), ["dashboard-run"]);
});

test("Postgres summary projection returns exact counters without detail fan-out", async () => {
  const client = new ReadOnlyQueryClient();
  const summary = await readPostgresMvpState({
    actorUserId: "actor_postgres_summary_test",
    companyId: "company_test",
    queryClient: client,
    projection: "summary"
  });
  assert.equal(summary.readback_projection, "summary");
  assert.deepEqual(summary.run_summary, {
    total_count: 0,
    blocked_count: 0,
    active_count: 0,
    completed_count: 0,
    today_count: 0,
    today_blocked_count: 0,
    today_active_count: 0,
    today_completed_count: 0
  });
  assert.deepEqual(summary.proof_summary, { total_count: 0 });
  assert.ok(client.calls.some(({ text }) => /COUNT\(\*\).*FROM runs/isu.test(text)));
  assert.equal(client.calls.some(({ text }) => /FROM run_steps|FROM worker_events|FROM durable_job_attempts/iu.test(text)), false);
  assert.equal(client.calls.every(({ text }) => !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/iu.test(text)), true);
});

test("Postgres summary projection does not present historical queued jobs as current work", async () => {
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_summary_queue_freshness", slug: "summary-queue-freshness", name: "Summary Queue Freshness", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM durable_jobs")) {
        if (text.includes("COUNT(*)")) return { rows: [{ total_count: 2, queued_count: 2, leased_count: 0 }] };
        return {
          rows: [
            { status: "queued", available_at: "2026-08-10T00:30:00.000Z", created_at: "2026-08-10T00:30:00.000Z" },
            { status: "queued", available_at: "2026-08-10T00:00:00.000Z", created_at: "2026-08-10T00:00:00.000Z" }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const summary = await readPostgresMvpState({
    actorUserId: "actor_summary_queue_freshness",
    companyId: "company_summary_queue_freshness",
    queryClient: client,
    projection: "summary",
    forceFresh: true
  });
  const worker = summary.worker as Record<string, unknown>;
  const jobSummary = summary.job_summary as Record<string, unknown>;
  assert.equal(worker.queue_depth, 2);
  assert.equal(worker.queue_current_count, 0);
  assert.equal(worker.queue_historical_count, 2);
  assert.equal(worker.queue_unknown_count, 0);
  assert.equal(worker.status, "idle");
  assert.match(String(worker.next_action), /historical queued record/iu);
  assert.equal(jobSummary.queued_count, 2);
  assert.equal(jobSummary.queued_current_count, 0);
  assert.equal(jobSummary.queued_historical_count, 2);
  assert.equal(summary.external_action_executed, false);
});

test("Postgres summary projection reconciles a stale worker check from the fresh worker-status artifact", async () => {
  const statusPath = join(isolatedPortableArtifactRoot, "worker-status.v1.json");
  const liveHeartbeat = new Date(Date.now() - 1_000).toISOString();
  writeFileSync(statusPath, JSON.stringify({
    schema: "aos.portable_remote_worker_status.v1",
    heartbeat_status: "ok",
    heartbeat_exact_blocker: null,
    heartbeat_at: liveHeartbeat,
    last_successful_heartbeat_at: liveHeartbeat,
    last_attempt_at: liveHeartbeat,
    claim_status: "idle",
    remote_origin: "https://automation-os.zeabur.app",
    updated_at: liveHeartbeat
  }) + "\n", { mode: 0o600 });
  chmodSync(statusPath, 0o600);
  const staleHeartbeat = "2026-08-11T00:00:00.000Z";
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_summary_live_worker", slug: "summary-live-worker", name: "Summary Live Worker", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM system_checks")) {
        return {
          rows: [{
            id: "portable-worker-summary-stale",
            kind: "portable_mac_worker",
            status: "blocked",
            created_at: staleHeartbeat,
            metadata_json: JSON.stringify({ company_id: "company_summary_live_worker", heartbeat_at: staleHeartbeat })
          }]
        };
      }
      return { rows: [] };
    }
  };
  try {
    const summary = await readPostgresMvpState({
      actorUserId: "actor_summary_live_worker",
      companyId: "company_summary_live_worker",
      queryClient: client,
      projection: "summary",
      forceFresh: true
    });
    const worker = summary.worker as Record<string, unknown>;
    const liveReadback = worker.live_readback as Record<string, unknown>;
    assert.equal(worker.status, "idle");
    assert.equal(worker.readback_status, "fresh_portable_worker_heartbeat");
    assert.equal(worker.heartbeat_fresh, true);
    assert.equal(worker.exact_blocker, null);
    assert.equal(liveReadback.source, "worker_status_file");
    assert.equal(liveReadback.heartbeat_status, "ok");
    assert.equal(summary.external_action_executed, false);
  } finally {
    rmSync(statusPath, { force: true });
  }
});

test("Postgres summary projection ignores a legacy blocked worker check after fresh portable heartbeat", async () => {
  const liveHeartbeat = new Date(Date.now() - 1_000).toISOString();
  const legacyBlockedAt = "2026-08-11T00:00:00.000Z";
  const statusPath = join(isolatedPortableArtifactRoot, "worker-status.v1.json");
  writeFileSync(statusPath, JSON.stringify({
    schema: "aos.portable_remote_worker_status.v1",
    heartbeat_status: "ok",
    heartbeat_exact_blocker: null,
    heartbeat_at: liveHeartbeat,
    last_successful_heartbeat_at: liveHeartbeat,
    last_attempt_at: liveHeartbeat,
    claim_status: "idle",
    remote_origin: "https://automation-os.zeabur.app",
    updated_at: liveHeartbeat
  }) + "\n", { mode: 0o600 });
  chmodSync(statusPath, 0o600);
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_summary_legacy_check", slug: "legacy-check", name: "Legacy Check", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM system_checks")) {
        return {
          rows: [
            {
              id: "local-codex-worker-legacy",
              kind: "local_codex_worker",
              status: "blocked",
              created_at: legacyBlockedAt,
              metadata_json: JSON.stringify({ company_id: "company_summary_legacy_check" })
            },
            {
              id: "portable-worker-summary-live",
              kind: "portable_mac_worker",
              status: "idle",
              created_at: liveHeartbeat,
              metadata_json: JSON.stringify({ company_id: "company_summary_legacy_check", heartbeat_at: liveHeartbeat })
            }
          ]
        };
      }
      return { rows: [] };
    }
  };
  try {
    const summary = await readPostgresMvpState({
      actorUserId: "actor_summary_legacy_check",
      companyId: "company_summary_legacy_check",
      queryClient: client,
      projection: "summary",
      forceFresh: true
    });
    const worker = summary.worker as Record<string, unknown>;
    assert.equal(worker.status, "idle");
    assert.equal(worker.readback_status, "fresh_portable_worker_heartbeat");
    assert.equal(worker.heartbeat_fresh, true);
    assert.equal(worker.exact_blocker, null);
    assert.equal(summary.external_action_executed, false);
  } finally {
    rmSync(statusPath, { force: true });
  }
});

test("Postgres Chat projection keeps exact company/schedule scope without detail fan-out", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client: PostgresMvpStateQueryClient = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_chat_projection", slug: "chat-projection", name: "Chat Projection", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM mvp_automation_schedules")) {
        return {
          rows: [{
            id: "schedule_chat_projection",
            company_id: "company_chat_projection",
            automation_id: "automation_chat_projection",
            kind: "cron",
            expression: "30 7 * * *",
            timezone: "Asia/Tokyo",
            enabled: true,
            status: "active",
            revision: 2
          }]
        };
      }
      return { rows: [] };
    }
  };
  const chat = await readPostgresMvpState({
    actorUserId: "actor_chat_projection",
    companyId: "company_chat_projection",
    queryClient: client,
    projection: "chat"
  });

  assert.equal(chat.readback_projection, "chat");
  assert.deepEqual(chat.company_scope, {
    enforced: true,
    company_ids: ["company_chat_projection"],
    actor_user_id: "actor_chat_projection"
  });
  assert.deepEqual(chat.schedules, [{
    id: "schedule_chat_projection",
    company_id: "company_chat_projection",
    project_id: "company_chat_projection",
    automation_id: "automation_chat_projection",
    automation_version_id: null,
    kind: "cron",
    expression: "30 7 * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    status: "active",
    revision: 2,
    next_run_at: null,
    last_run_at: null,
    paused_at: null,
    created_at: null,
    updated_at: null
  }]);
  assert.deepEqual(chat.readback_omitted_fields, [
    "full_run_history",
    "approvals",
    "proofs",
    "jobs",
    "memory",
    "feedbacks",
    "browser_runtime_detail"
  ]);
  assert.equal(chat.external_action_executed, false);
  assert.equal(calls.some(({ text }) => /FROM run_steps|FROM worker_events|FROM durable_job_attempts/iu.test(text)), false);
  assert.equal(calls.every(({ text }) => !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/iu.test(text)), true);
});

test("Postgres UI and full projections do not share truncated cache entries", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client: PostgresMvpStateQueryClient = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_projection_cache", slug: "projection-cache", name: "Projection Cache", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM runs WHERE")) {
        return {
          rows: [{
            id: "run_projection_cache",
            company_id: "company_projection_cache",
            status: "complete",
            created_at: "2026-08-07T00:00:00.000Z",
            metadata_json: JSON.stringify({ full_only: true })
          }]
        };
      }
      return { rows: [] };
    }
  };

  const ui = await readPostgresMvpState({
    actorUserId: "actor_projection_cache",
    companyId: "company_projection_cache",
    queryClient: client,
    projection: "ui"
  });
  const full = await readPostgresMvpState({
    actorUserId: "actor_projection_cache",
    companyId: "company_projection_cache",
    queryClient: client,
    projection: "full"
  });

  assert.equal((ui.readback_cache as { status: string }).status, "fresh");
  assert.equal((full.readback_cache as { status: string }).status, "fresh");
  const runCalls = calls.filter((call) => call.text.includes("FROM runs WHERE"));
  assert.equal(runCalls.length, 2);
  assert.match(runCalls[0].text, /jsonb_build_object/u);
  assert.match(runCalls[0].text, /metadata_json/u);
  const proofCalls = calls.filter((call) => call.text.includes("FROM proofs JOIN runs"));
  assert.equal(proofCalls.length, 2);
  assert.match(proofCalls[0].text, /jsonb_build_object/u);
  assert.match(runCalls[1].text, /SELECT \* FROM runs/u);
});

test("Postgres dashboard list readback compacts repeated run receipts", async () => {
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_compact", slug: "compact", name: "Compact", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM runs WHERE")) {
        return {
          rows: [{
            id: "run_compact_postgres",
            company_id: "company_compact",
            status: "blocked",
            created_at: "2026-08-07T00:00:00.000Z",
            metadata_json: JSON.stringify({
              exact_blocker: "chrome_extension_bridge_refresh_requires_active_call",
              external_action_executed: false,
              route_decision: { huge: "x".repeat(20_000) },
              remote_worker_receipt: { huge: "x".repeat(20_000) }
            })
          }]
        };
      }
      return { rows: [] };
    }
  };
  const state = await readPostgresMvpState({
    actorUserId: "actor_postgres_compact_test",
    companyId: "company_compact",
    queryClient: client
  });
  const run = (state.runs as Array<Record<string, unknown>>)[0];
  const metadata = JSON.parse(String(run.metadata_json));

  assert.equal(metadata.exact_blocker, "chrome_extension_bridge_refresh_requires_active_call");
  assert.equal(metadata.external_action_executed, false);
  assert.equal(metadata.route_decision, undefined);
  assert.equal(metadata.remote_worker_receipt, undefined);
  assert.ok(String(run.metadata_json).length < 1_000);
});

test("UI state projection omits duplicate, detail-only, and secondary-read fields", async () => {
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_ui_projection", slug: "ui-projection", name: "UI Projection", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM runs WHERE")) {
        return { rows: [{ id: "run_ui_projection", company_id: "company_ui_projection", status: "blocked", created_at: "2026-08-07T00:00:00.000Z" }] };
      }
      return { rows: [] };
    }
  };
  const full = await readPostgresMvpState({ actorUserId: "actor_ui_projection", companyId: "company_ui_projection", queryClient: client });
  const ui = await readPostgresMvpState({ actorUserId: "actor_ui_projection", companyId: "company_ui_projection", queryClient: client, projection: "ui" });

  assert.ok(Array.isArray(full.actionableRuns));
  assert.ok(Array.isArray(full.approvalInbox));
  assert.ok(Array.isArray(full.workerEvents));
  assert.equal(ui.actionableRuns, undefined);
  assert.equal(ui.approvalInbox, undefined);
  assert.equal(ui.workerEvents, undefined);
  assert.deepEqual(ui.readback_omitted_fields, ["actionableRuns", "approvalInbox", "schedule_occurrences", "steps", "lanes", "workerEvents", "feedbacks"]);
  assert.equal(ui.readback_projection, "ui");
  assert.deepEqual(ui.runs, full.runs);
  assert.equal(ui.external_action_executed, false);
});

test("Postgres MVP readback never claims a stale portable worker heartbeat is fresh", async () => {
  const staleHeartbeat = "2026-08-11T00:00:00.000Z";
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_stale_worker", slug: "stale-worker", name: "Stale Worker", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM system_checks")) {
        return {
          rows: [{
            id: "portable-worker-heartbeat-stale",
            kind: "portable_mac_worker",
            status: "running",
            created_at: staleHeartbeat,
            metadata_json: JSON.stringify({ company_id: "company_stale_worker", heartbeat_at: staleHeartbeat })
          }]
        };
      }
      return { rows: [] };
    }
  };
  const state = await readPostgresMvpState({
    actorUserId: "actor_stale_worker",
    companyId: "company_stale_worker",
    queryClient: client
  });
  const worker = state.worker as Record<string, unknown>;
  assert.equal(worker.status, "blocked");
  assert.equal(worker.readback_status, "portable_worker_heartbeat_stale");
  assert.equal(worker.heartbeat_fresh, false);
  assert.equal(worker.exact_blocker, "portable_worker_heartbeat_stale");
  assert.equal(worker.external_action_executed, false);
});

test("Postgres MVP readback selects a portable worker heartbeat from any visible company", async () => {
  const liveHeartbeat = new Date(Date.now() - 1_000).toISOString();
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return {
          rows: [
            { id: "company_alpha", slug: "alpha", name: "Alpha", status: "active", role: "owner" },
            { id: "company_live_worker", slug: "live-worker", name: "Live Worker", status: "active", role: "owner" }
          ]
        };
      }
      if (text.includes("FROM system_checks")) {
        return {
          rows: [{
            id: "portable-worker-heartbeat-second-company",
            kind: "portable_mac_worker",
            status: "running",
            created_at: liveHeartbeat,
            metadata_json: JSON.stringify({ company_id: "company_live_worker", heartbeat_at: liveHeartbeat })
          }]
        };
      }
      return { rows: [] };
    }
  };

  const state = await readPostgresMvpState({
    actorUserId: "actor_multi_company_worker",
    queryClient: client,
    forceFresh: true
  });
  const worker = state.worker as Record<string, unknown>;
  assert.deepEqual((state.company_scope as Record<string, unknown>).company_ids, ["company_alpha", "company_live_worker"]);
  assert.equal(worker.heartbeat_fresh, true);
  assert.equal(worker.heartbeat_at, liveHeartbeat);
  assert.equal(worker.exact_blocker, null);
  assert.equal(worker.readback_status, "fresh_portable_worker_heartbeat");
});

test("Postgres MVP readback clears a stale heartbeat blocker after fresh live transport readback", async () => {
  const statusPath = join(isolatedPortableArtifactRoot, "worker-status.v1.json");
  const liveHeartbeat = new Date(Date.now() - 1_000).toISOString();
  writeFileSync(statusPath, JSON.stringify({
    schema: "aos.portable_remote_worker_status.v1",
    heartbeat_status: "ok",
    heartbeat_exact_blocker: null,
    heartbeat_at: liveHeartbeat,
    last_successful_heartbeat_at: liveHeartbeat,
    last_attempt_at: liveHeartbeat,
    claim_status: "idle",
    updated_at: liveHeartbeat
  }) + "\n", { mode: 0o600 });
  chmodSync(statusPath, 0o600);
  const staleHeartbeat = "2026-08-11T00:00:00.000Z";
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_live_worker", slug: "live-worker", name: "Live Worker", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM system_checks")) {
        return {
          rows: [{
            id: "portable-worker-heartbeat-live",
            kind: "portable_mac_worker",
            status: "blocked",
            created_at: staleHeartbeat,
            metadata_json: JSON.stringify({ company_id: "company_live_worker", heartbeat_at: staleHeartbeat, exact_blocker: "portable_worker_heartbeat_stale" })
          }]
        };
      }
      return { rows: [] };
    }
  };
  try {
    const state = await readPostgresMvpState({
      actorUserId: "actor_live_worker",
      companyId: "company_live_worker",
      queryClient: client
    });
    const worker = state.worker as Record<string, unknown>;
    assert.equal(worker.status, "idle");
    assert.equal(worker.readback_status, "fresh_portable_worker_heartbeat");
    assert.equal(worker.heartbeat_fresh, true);
    assert.equal(worker.exact_blocker, null);
  } finally {
    rmSync(statusPath, { force: true });
  }
});

test("Postgres MVP readback exposes explicit public fields without internal job or workflow data", async () => {
  const client: PostgresMvpStateQueryClient = {
    async query(text) {
      if (text.includes("FROM company_memberships")) {
        return { rows: [{ id: "company_public", slug: "public", name: "Public", status: "active", role: "owner" }] };
      }
      if (text.includes("FROM durable_jobs")) {
        return {
          rows: [{
            id: "job_public",
            company_id: "company_public",
            run_id: "run_public",
            automation_id: "automation_public",
            automation_version_id: "version_public",
            schedule_occurrence_id: null,
            kind: "safe_local_demo",
            execution_mode: "dry_run",
            external_intent_json: JSON.stringify({ account_ref: "secret-account" }),
            payload_json: JSON.stringify({ password: "secret-password" }),
            payload_hash: "hash_public",
            idempotency_key: "secret-idempotency-key",
            status: "queued",
            priority: 100,
            max_attempts: 1,
            attempt_count: 0,
            available_at: "2026-08-07T00:00:00.000Z",
            concurrency_key: "company_public:automation_public",
            max_concurrency: 1,
            lease_owner: "secret-worker",
            lease_expires_at: null,
            fencing_token: 9,
            heartbeat_at: null,
            provider_called: 0,
            reservation_id: "secret-reservation",
            reconciliation_started_at: null,
            reconciliation_owner: "secret-owner",
            last_error: "safe_error",
            created_at: "2026-08-07T00:00:00.000Z",
            updated_at: "2026-08-07T00:00:00.000Z"
          }]
        };
      }
      if (text.includes("FROM durable_job_attempts")) {
        return {
          rows: [{
            id: "attempt_public",
            company_id: "company_public",
            job_id: "job_public",
            attempt_no: 1,
            service_user_id: "secret-service-user",
            fencing_token: 9,
            status: "running",
            provider_called: 0,
            provider_called_at: null,
            reservation_id: "secret-reservation",
            reconciliation_started_at: null,
            reconciliation_owner: "secret-owner",
            started_at: "2026-08-07T00:00:00.000Z",
            heartbeat_at: "2026-08-07T00:00:01.000Z",
            finished_at: null,
            error_code: "safe_error"
          }]
        };
      }
      if (text.includes("FROM registered_workflows")) {
        return {
          rows: [{
            id: "workflow_public",
            company_id: "company_public",
            name: "公開workflow",
            status: "active",
            runner_status: "connected",
            runner_kind: "mac_worker",
            project_root: "/private/project",
            start_command_json: JSON.stringify({ command: "secret-command" }),
            schedule_json: JSON.stringify({ rrule: "FREQ=DAILY", label: "毎日" }),
            source_refs_json: JSON.stringify([{ path: "/private/source" }]),
            provenance_json: JSON.stringify({ token: "secret-token" })
          }]
        };
      }
      if (text.includes("FROM mvp_feedback")) {
        return {
          rows: [{
            id: "feedback_public",
            company_id: "company_public",
            feedback_id: "feedback_public",
            status: "open",
            route: "#/projects/company_public",
            page_title: "Feedback",
            comment: "確認してください",
            artifact_uri: "/Users/example/private.png",
            has_screenshot: 0,
            screenshot_artifact_id: "artifact_public",
            viewport_json: JSON.stringify({ width: 1200, height: 800, secret: "not-public" }),
            workflow_context_json: JSON.stringify({ project_id: "company_public", token: "secret-token" }),
            category: "ui",
            severity: "medium",
            fix_target: "button",
            captured_at: "2026-08-07T00:00:00.000Z",
            created_at: "2026-08-07T00:00:00.000Z",
            payload_json: JSON.stringify({ project_id: "company_public", comment: "確認してください", password: "secret-password" })
          }]
        };
      }
      return { rows: [] };
    }
  };

  const state = await readPostgresMvpState({
    actorUserId: "actor_postgres_public_contract_test",
    companyId: "company_public",
    queryClient: client
  });
  const job = (state.jobs as Array<Record<string, unknown>>)[0];
  const attempt = (state.job_attempts as Array<Record<string, unknown>>)[0];
  const workflow = (state.registeredWorkflows as Array<Record<string, unknown>>)[0];
  const feedback = (state.feedbacks as Array<Record<string, unknown>>)[0];

  assert.equal(job.payload_json, undefined);
  assert.equal(job.external_intent, undefined);
  assert.equal(job.idempotency_key, undefined);
  assert.equal(job.lease_owner, undefined);
  assert.equal(job.reservation_id, undefined);
  assert.equal(job.fencing_token, undefined);
  assert.equal(job.status, "queued");
  assert.equal(job.queue_freshness, "historical");
  assert.equal(job.payload_hash, "hash_public");
  assert.equal(attempt.service_user_id, undefined);
  assert.equal(attempt.reservation_id, undefined);
  assert.equal(attempt.reconciliation_owner, undefined);
  assert.equal(attempt.error, "safe_error");
  assert.equal(workflow.projectRoot, undefined);
  assert.equal(workflow.startCommand, undefined);
  assert.equal(workflow.sourceRefs, undefined);
  assert.equal(workflow.provenance, undefined);
  assert.deepEqual(workflow.schedule, { rrule: "FREQ=DAILY", label: "毎日" });
  assert.equal(feedback.payload_json, undefined);
  assert.deepEqual(feedback.workflow_context, { project_id: "company_public" });
  assert.deepEqual(feedback.payload, { project_id: "company_public", comment: "確認してください" });
  assert.deepEqual(feedback.viewport, { width: 1200, height: 800 });
  assert.doesNotMatch(JSON.stringify(state), /secret-(?:password|account|worker|owner|reservation|token|command)/u);
});
