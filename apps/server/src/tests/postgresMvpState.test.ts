import assert from "node:assert/strict";
import test from "node:test";
// This projection test must not classify an unrelated host worker as its fixture worker.
process.env.AUTOMATION_OS_READ_LIVE_PROCESS_TABLE = "0";
import {
  readPostgresMvpState,
  type PostgresMvpStateQueryClient
} from "../runs/postgresMvpState.js";

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
