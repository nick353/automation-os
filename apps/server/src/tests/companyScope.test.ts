import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-company-scope-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "user_a";

const { app } = await import("../index.js");
const { querySql, execSql } = await import("../db/client.js");

test("first-use company creation replays a name-only payload and rejects drift or a blank name", async () => {
  const previousActor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  process.env.AUTOMATION_OS_OWNER_USER_ID = "user_first_use";
  try {
    const idempotencyHeaders = { "idempotency-key": "first-use-company-create-retry" };
    const createdResponse = await request("POST", "/api/companies", { name: "初見確認用会社" }, idempotencyHeaders);
    assert.equal(createdResponse.status, 201, createdResponse.body);
    const created = JSON.parse(createdResponse.body) as { ok: boolean; company: { id: string; name: string; slug: string; role: string } };
    assert.equal(created.ok, true);
    assert.equal(created.company.name, "初見確認用会社");
    assert.equal(created.company.slug, created.company.id);
    assert.equal(created.company.role, "owner");

    const replayResponse = await request("POST", "/api/companies", { name: "初見確認用会社" }, idempotencyHeaders);
    assert.equal(replayResponse.status, 201, replayResponse.body);
    const replayed = JSON.parse(replayResponse.body) as { company: { id: string } };
    assert.equal(replayed.company.id, created.company.id);
    const companies = JSON.parse((await request("GET", "/api/companies")).body) as { companies: Array<{ id: string }> };
    assert.deepEqual(companies.companies.map((company) => company.id), [created.company.id]);
    assert.equal(querySql<{ count: number }>(`
      SELECT count(*) AS count FROM mvp_idempotency_keys
      WHERE company_id='${created.company.id}' AND scope='company.create' AND idempotency_key='first-use-company-create-retry'
    `)[0].count, 1);

    const driftResponse = await request("POST", "/api/companies", { name: "別の会社" }, idempotencyHeaders);
    assert.equal(driftResponse.status, 409, driftResponse.body);
    assert.equal(JSON.parse(driftResponse.body).error, "idempotency_key_payload_conflict");

    const blankResponse = await request("POST", "/api/companies", { name: "   " });
    assert.equal(blankResponse.status, 400, blankResponse.body);
    assert.equal(JSON.parse(blankResponse.body).error, "company_name_required");
  } finally {
    if (previousActor === undefined) delete process.env.AUTOMATION_OS_OWNER_USER_ID;
    else process.env.AUTOMATION_OS_OWNER_USER_ID = previousActor;
  }
});

test("companies and automation APIs derive tenant scope from membership", async () => {
  const companyAResponse = await request("POST", "/api/companies", { name: "Company A", slug: "company-a" });
  assert.equal(companyAResponse.status, 201, companyAResponse.body);
  const companyA = JSON.parse(companyAResponse.body).company as { id: string };

  process.env.AUTOMATION_OS_OWNER_USER_ID = "user_b";
  const companyBResponse = await request("POST", "/api/companies", { name: "Company B", slug: "company-b" });
  assert.equal(companyBResponse.status, 201, companyBResponse.body);
  const companyB = JSON.parse(companyBResponse.body).company as { id: string };

  const automationBResponse = await request("POST", "/api/mvp/automations", {
    project_id: companyB.id,
    name: "B private automation"
  }, { "idempotency-key": "company-scope-b-create" });
  assert.equal(automationBResponse.status, 201, automationBResponse.body);
  const automationB = JSON.parse(automationBResponse.body).automation as { id: string };
  const approvalBResponse = await request("POST", "/api/mvp/approvals", {
    company_id: companyB.id,
    project_id: companyB.id,
    title: "B private approval"
  });
  assert.equal(approvalBResponse.status, 201, approvalBResponse.body);
  const approvalB = JSON.parse(approvalBResponse.body).approval as { id: string };
  const feedbackBResponse = await request("POST", "/api/mvp/feedback", {
    company_id: companyB.id,
    project_id: companyB.id,
    comment: "B private feedback"
  });
  assert.equal(feedbackBResponse.status, 201, feedbackBResponse.body);
  const feedbackB = JSON.parse(feedbackBResponse.body).feedback as { feedback_id: string };

  process.env.AUTOMATION_OS_OWNER_USER_ID = "user_a";
  const companyA2Response = await request("POST", "/api/companies", { name: "Company A2", slug: "company-a2" });
  assert.equal(companyA2Response.status, 201, companyA2Response.body);
  const companyA2 = JSON.parse(companyA2Response.body).company as { id: string };
  const automationAResponse = await request("POST", "/api/mvp/automations", {
    company_id: companyA.id,
    project_id: companyA.id,
    name: "A automation"
  }, { "idempotency-key": "company-scope-a-create" });
  assert.equal(automationAResponse.status, 201, automationAResponse.body);
  const automationAState = JSON.parse(automationAResponse.body).state as { companies: Array<{ id: string }> };
  assert.deepEqual(automationAState.companies.map((company) => company.id), [companyA.id, companyA2.id]);

  const companies = JSON.parse((await request("GET", "/api/companies")).body) as { companies: Array<{ id: string }> };
  assert.deepEqual(companies.companies.map((company) => company.id), [companyA.id, companyA2.id]);

  const automations = JSON.parse((await request("GET", "/api/mvp/automations")).body) as {
    automations: Array<{ id: string; company_id: string; project_id: string }>;
  };
  assert.equal(automations.automations.length, 1);
  assert.equal(automations.automations[0].company_id, companyA.id);
  assert.equal(automations.automations[0].project_id, companyA.id);
  assert.doesNotMatch(JSON.stringify(automations), /B private automation/);
  const feedbackReadback = await request("GET", "/api/mvp/feedback");
  assert.equal(feedbackReadback.status, 200, feedbackReadback.body);
  assert.doesNotMatch(feedbackReadback.body, /B private feedback/);
  const forgedFeedbackPatch = await request("PATCH", `/api/mvp/feedback/${feedbackB.feedback_id}`, { status: "triaged" });
  assert.equal(forgedFeedbackPatch.status, 404, forgedFeedbackPatch.body);
  assert.equal(querySql<{ status: string }>(`SELECT status FROM mvp_feedback WHERE feedback_id='${feedbackB.feedback_id}'`)[0].status, "open");

  const explicitBRead = await request("GET", `/api/mvp/automations?company_id=${encodeURIComponent(companyB.id)}`);
  assert.equal(explicitBRead.status, 403);
  assert.equal(JSON.parse(explicitBRead.body).error, "company_scope_forbidden");

  const before = querySql<{ name: string; builder_spec_json: string }>(
    `SELECT name, builder_spec_json FROM mvp_automations WHERE id='${automationB.id}'`
  )[0];
  const forgedPatch = await request("PATCH", `/api/mvp/automations/${automationB.id}`, { name: "stolen" }, {
    "x-automation-os-actor-id": "user_b"
  });
  assert.equal(forgedPatch.status, 404);
  const forgedBuilder = await request("PUT", `/api/mvp/automations/${automationB.id}/builder-spec`, { secret: "changed" });
  assert.equal(forgedBuilder.status, 404);
  const forgedApproval = await request("PATCH", `/api/mvp/approvals/${approvalB.id}`, { decision: "approve" }, {
    "x-automation-os-actor-id": "user_b"
  });
  assert.equal(forgedApproval.status, 404);
  assert.equal(querySql<{ status: string }>(`SELECT status FROM approvals WHERE id='${approvalB.id}'`)[0].status, "pending");
  const after = querySql<{ name: string; builder_spec_json: string }>(
    `SELECT name, builder_spec_json FROM mvp_automations WHERE id='${automationB.id}'`
  )[0];
  assert.deepEqual(after, before);

  const timestamp = new Date().toISOString();
  execSql(`
    INSERT INTO runs (id, company_id, name, status, objective, created_at, updated_at, metadata_json)
    VALUES
      ('run_company_a', '${companyA.id}', 'A scoped run', 'partial', 'A only', '${timestamp}', '${timestamp}', '{}'),
      ('run_company_b', '${companyB.id}', 'B private run', 'partial', 'B only', '${timestamp}', '${timestamp}', '{}'),
      ('run_unassigned', NULL, 'Unassigned run', 'partial', 'admin only', '${timestamp}', '${timestamp}', '{}');
    INSERT INTO proofs (id, company_id, run_id, step_id, proof_type, label, uri, size_bytes, created_at, metadata_json)
    VALUES
      ('proof_company_a', '${companyA.id}', 'run_company_a', NULL, 'text', 'A proof', 'a.txt', 1, '${timestamp}', '{}'),
      ('proof_company_b', '${companyB.id}', 'run_company_b', NULL, 'text', 'B private proof', 'b.txt', 1, '${timestamp}', '{}'),
      ('proof_cross_labeled', '${companyA.id}', 'run_company_b', NULL, 'text', 'Bad cross label', 'bad.txt', 1, '${timestamp}', '{}'),
      ('proof_unassigned', NULL, 'run_unassigned', NULL, 'text', 'Unassigned proof', 'none.txt', 1, '${timestamp}', '{}');
  `);
  const state = JSON.parse((await request("GET", "/api/mvp/state")).body) as {
    runs: Array<{ id: string }>;
    proofs: Array<{ id: string }>;
    company_scope: { company_ids: string[] };
  };
  assert.deepEqual(state.company_scope.company_ids, [companyA.id, companyA2.id]);
  assert.deepEqual(state.runs.map((run) => run.id), ["run_company_a"]);
  assert.deepEqual(state.proofs.map((proof) => proof.id), ["proof_company_a"]);
  assert.doesNotMatch(JSON.stringify(state), /B private|Unassigned run/);

  const preview = JSON.parse((await request("POST", "/api/mvp/worker/preview", {})).body) as {
    picked_count: number;
    by_project: Record<string, number>;
  };
  assert.equal(preview.picked_count, 1);
  assert.deepEqual(preview.by_project, { [companyA.id]: 1 });

  const crossCompanyApproval = await request("POST", "/api/mvp/approvals", {
    company_id: companyA.id,
    project_id: companyA.id,
    run_id: "run_company_b",
    title: "must not link B run"
  });
  assert.equal(crossCompanyApproval.status, 404);
  assert.equal(JSON.parse(crossCompanyApproval.body).error, "run_not_found");

  execSql(`
    INSERT INTO approvals (id, company_id, run_id, title, requested_by, status, priority, approval_group_id, resource_locks_json, created_at)
    VALUES ('approval_cross_company_legacy', '${companyA.id}', 'run_company_b', 'legacy bad link', 'test', 'pending', 'normal', 'legacy', '[]', '${timestamp}');
  `);
  const crossCompanyDecision = await request("PATCH", "/api/mvp/approvals/approval_cross_company_legacy", { decision: "approve" });
  assert.equal(crossCompanyDecision.status, 404);
  assert.equal(JSON.parse(crossCompanyDecision.body).error, "approval_not_found");
  assert.equal(querySql<{ status: string }>("SELECT status FROM approvals WHERE id='approval_cross_company_legacy'")[0].status, "pending");

  execSql(`
    INSERT INTO approvals (id, company_id, run_id, title, requested_by, status, priority, approval_group_id, resource_locks_json, created_at)
    VALUES ('approval_unassigned', NULL, 'run_unassigned', 'unassigned', 'test', 'pending', 'normal', 'legacy', '[]', '${timestamp}');
  `);

  const runNotFoundBodies = await Promise.all([
    request("GET", "/api/runs/run_company_b"),
    request("GET", "/api/runs/run_unassigned"),
    request("GET", "/api/runs/run_missing")
  ]);
  assert.deepEqual(runNotFoundBodies.map((response) => [response.status, response.body]), [
    [404, '{"error":"run_not_found"}'],
    [404, '{"error":"run_not_found"}'],
    [404, '{"error":"run_not_found"}']
  ]);

  const proofNotFoundBodies = await Promise.all([
    request("GET", "/api/proofs/proof_company_b/view"),
    request("GET", "/api/proofs/proof_cross_labeled/view"),
    request("GET", "/api/proofs/proof_unassigned/view"),
    request("GET", "/api/proofs/proof_missing/view")
  ]);
  assert.deepEqual(proofNotFoundBodies.map((response) => [response.status, response.body]), Array.from({ length: 4 }, () => [404, '{"status":"not_found","error":"proof_not_found"}']));

  for (const verb of ["approve", "reject", "cancel"]) {
    for (const approvalId of [approvalB.id, "approval_cross_company_legacy", "approval_unassigned", "approval_missing"]) {
      const response = await request("POST", `/api/approvals/${approvalId}/${verb}`, {});
      assert.equal(response.status, 404, `${verb}:${approvalId}:${response.body}`);
      assert.equal(response.body, '{"error":"approval_not_found"}');
    }
  }
  assert.equal(querySql<{ status: string }>(`SELECT status FROM approvals WHERE id='${approvalB.id}'`)[0].status, "pending");
  assert.equal(querySql<{ status: string }>("SELECT status FROM approvals WHERE id='approval_cross_company_legacy'")[0].status, "pending");

  const skillsBefore = querySql<{ count: number }>("SELECT count(*) AS count FROM skills")[0].count;
  const foreignSkill = await request("POST", "/api/skills/from-run/run_company_b", {});
  assert.equal(foreignSkill.status, 404);
  assert.equal(foreignSkill.body, '{"error":"run_not_found"}');
  assert.equal(querySql<{ count: number }>("SELECT count(*) AS count FROM skills")[0].count, skillsBefore);

  const started = await request("POST", "/api/runs/start", {
    company_id: companyA.id,
    project_id: companyA.id,
    command: "Create a local company-scoped text summary"
  });
  assert.equal(started.status, 202, started.body);
  const startedBody = JSON.parse(started.body) as { run?: { id?: string }; runId?: string };
  const startedRunId = startedBody.run?.id ?? startedBody.runId;
  assert.ok(startedRunId, started.body);
  assert.equal(querySql<{ company_id: string }>(`SELECT company_id FROM runs WHERE id='${startedRunId}'`)[0].company_id, companyA.id);

  const createdPlanResponse = await request("POST", "/api/planner/research-plan", {
    company_id: companyA.id,
    command: "Company A scoped research plan"
  });
  assert.equal(createdPlanResponse.status, 201, createdPlanResponse.body);
  const createdPlan = JSON.parse(createdPlanResponse.body).plan as { id: string; companyId: string };
  assert.equal(createdPlan.companyId, companyA.id);
  execSql(`
    INSERT INTO research_plans (id, company_id, title, status, command, sources_json, visible_flow_json, source_of_truth_json, proof_boundary_json, approval_boundary_json, metadata_json, demo_check_id, run_id, created_at, updated_at)
    VALUES
      ('plan_company_b', '${companyB.id}', 'B private plan', 'planned', 'B private command', '[]', '[]', '[]', '[]', '[]', '{}', NULL, NULL, '${timestamp}', '${timestamp}'),
      ('plan_unassigned', NULL, 'Unassigned plan', 'planned', 'Unassigned command', '[]', '[]', '[]', '[]', '[]', '{}', NULL, NULL, '${timestamp}', '${timestamp}');
    INSERT INTO registered_workflows (id, company_id, name, status, runner_status, runner_kind, project_root, start_command_json, schedule_json, source_refs_json, provenance_json, created_at, updated_at)
    VALUES ('research-plan-company-b-private', '${companyB.id}', 'B private registered research', 'active', 'connected', 'research_plan_registered', '/tmp/company-b', '{"researchPlanId":"plan_company_b","command":"B private command"}', '{"rrule":"FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"}', '[]', '{"source":"test"}', '${timestamp}', '${timestamp}');
  `);
  const registeredList = await request("GET", "/api/registered-workflows");
  assert.equal(registeredList.status, 200, registeredList.body);
  assert.doesNotMatch(registeredList.body, /B private registered research|research-plan-company-b-private/);
  const registeredBefore = querySql<{ provenance_json: string; schedule_json: string }>(
    "SELECT provenance_json, schedule_json FROM registered_workflows WHERE id='research-plan-company-b-private'"
  )[0];
  const registeredRunCountBefore = querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;
  const inaccessibleRegisteredOperations = await Promise.all([
    request("POST", "/api/registered-workflows/research-plan-company-b-private/pause", {}),
    request("POST", "/api/registered-workflows/research-plan-company-b-private/resume", {}),
    request("PATCH", "/api/registered-workflows/research-plan-company-b-private/schedule", { frequency: "daily", time: "10:00" }),
    request("POST", "/api/registered-workflows/research-plan-company-b-private/start", {}),
    request("POST", "/api/registered-workflows/research-plan-missing/pause", {}),
    request("POST", "/api/registered-workflows/research-plan-missing/start", {})
  ]);
  assert.deepEqual(
    inaccessibleRegisteredOperations.map((response) => [response.status, response.body]),
    Array.from({ length: 6 }, () => [404, '{"error":"registered_workflow_not_found"}'])
  );
  assert.deepEqual(
    querySql<{ provenance_json: string; schedule_json: string }>(
      "SELECT provenance_json, schedule_json FROM registered_workflows WHERE id='research-plan-company-b-private'"
    )[0],
    registeredBefore
  );
  assert.equal(querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count, registeredRunCountBefore);
  const planRunCountBefore = querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count;
  const inaccessiblePlanStarts = await Promise.all([
    request("POST", "/api/planner/plan_company_b/start", {}),
    request("POST", "/api/planner/plan_unassigned/start", {}),
    request("POST", "/api/planner/plan_missing/start", {})
  ]);
  assert.deepEqual(inaccessiblePlanStarts.map((response) => [response.status, response.body]), Array.from({ length: 3 }, () => [404, '{"error":"research_plan_not_found"}']));
  assert.equal(querySql<{ count: number }>("SELECT count(*) AS count FROM runs")[0].count, planRunCountBefore);
});

test("feedback screenshot is stored atomically as a tenant-scoped integrity-checked artifact", async () => {
  process.env.AUTOMATION_OS_OWNER_USER_ID = "feedback_owner_a";
  const companyResponse = await request("POST", "/api/companies", { name: "Feedback Company A", slug: "feedback-company-a" });
  assert.equal(companyResponse.status, 201, companyResponse.body);
  const companyId = JSON.parse(companyResponse.body).company.id as string;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const created = await request("POST", "/api/mvp/feedback", {
    company_id: companyId,
    project_id: companyId,
    comment: "Screenshot persistence",
    screenshot_data_url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    sensitive_content_confirmed: true
  });
  assert.equal(created.status, 201, created.body);
  const result = JSON.parse(created.body);
  assert.equal(result.feedback.has_screenshot, true);
  assert.ok(result.feedback.screenshot_artifact_id);
  assert.equal(result.feedback.screenshot.size_bytes, jpeg.length);
  assert.match(result.feedback.screenshot.checksum_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(created.body, /data:image|\/Users\//);
  const stored = querySql<{ company_id: string; feedback_id: string; checksum_sha256: string; size_bytes: number; content_base64: string }>(
    `SELECT company_id, feedback_id, checksum_sha256, size_bytes, content_base64 FROM feedback_artifacts WHERE id='${result.feedback.screenshot_artifact_id}'`
  )[0];
  assert.equal(stored.company_id, companyId);
  assert.equal(stored.feedback_id, result.feedback.feedback_id);
  assert.equal(stored.size_bytes, jpeg.length);
  assert.equal(stored.content_base64, jpeg.toString("base64"));
  const view = await request("GET", result.feedback.screenshot.view_url);
  assert.equal(view.status, 200, view.body);

  const beforeInvalid = querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_feedback")[0].count;
  const invalid = await request("POST", "/api/mvp/feedback", {
    company_id: companyId,
    project_id: companyId,
    comment: "Must roll back",
    screenshot_data_url: "data:image/svg+xml;base64,PHN2Zy8+",
    sensitive_content_confirmed: true
  });
  assert.equal(invalid.status, 415, invalid.body);
  assert.equal(querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_feedback")[0].count, beforeInvalid);

  process.env.AUTOMATION_OS_OWNER_USER_ID = "feedback_owner_b";
  const foreignView = await request("GET", result.feedback.screenshot.view_url);
  assert.equal(foreignView.status, 404, foreignView.body);
});

test("viewer membership is read-only and unscoped tenant writes fail closed", async () => {
  process.env.AUTOMATION_OS_OWNER_USER_ID = "user_viewer";
  const response = await request("POST", "/api/companies", { name: "Viewer Company", slug: "viewer-company" });
  assert.equal(response.status, 201, response.body);
  const company = JSON.parse(response.body).company as { id: string };
  execSql(`UPDATE company_memberships SET role='viewer' WHERE company_id='${company.id}' AND user_id='user_viewer'`);

  const list = await request("GET", `/api/mvp/automations?company_id=${encodeURIComponent(company.id)}`);
  assert.equal(list.status, 200, list.body);

  const write = await request("POST", "/api/mvp/automations", { project_id: company.id, name: "must not write" }, { "idempotency-key": "viewer-write-blocked" });
  assert.equal(write.status, 404, write.body);
  assert.equal(querySql<{ count: number }>(`SELECT count(*) AS count FROM mvp_automations WHERE company_id='${company.id}'`)[0].count, 0);

  const unscoped = await request("POST", "/api/mvp/automations", { name: "missing scope" }, { "idempotency-key": "unscoped-write-blocked" });
  assert.equal(unscoped.status, 400, unscoped.body);
  assert.equal(JSON.parse(unscoped.body).error, "project_id_required");

  await request("GET", "/api/registered-workflows");
  const fixedWorkflowBefore = querySql<{ provenance_json: string }>(
    "SELECT provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'"
  )[0];
  const fixedWorkflowWrite = await request("POST", "/api/registered-workflows/daily-ai-research-publish-run/pause", {});
  assert.equal(fixedWorkflowWrite.status, 404, fixedWorkflowWrite.body);
  assert.deepEqual(
    querySql<{ provenance_json: string }>("SELECT provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0],
    fixedWorkflowBefore
  );

  execSql(`UPDATE company_memberships SET role='operator' WHERE company_id='${company.id}' AND user_id='user_viewer'`);
  const operatorFixedWorkflowWrite = await request("POST", "/api/registered-workflows/daily-ai-research-publish-run/pause", {});
  assert.equal(operatorFixedWorkflowWrite.status, 404, operatorFixedWorkflowWrite.body);
  assert.equal(operatorFixedWorkflowWrite.body, '{"error":"registered_workflow_not_found"}');
  assert.deepEqual(
    querySql<{ provenance_json: string }>("SELECT provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0],
    fixedWorkflowBefore
  );
  execSql(`UPDATE company_memberships SET role='viewer' WHERE company_id='${company.id}' AND user_id='user_viewer'`);

  execSql("UPDATE users SET status='suspended' WHERE id='user_viewer'");
  try {
    const suspendedList = await request("GET", "/api/companies");
    assert.equal(suspendedList.status, 200, suspendedList.body);
    assert.deepEqual(JSON.parse(suspendedList.body).companies, []);
    const suspendedWrite = await request("POST", "/api/mvp/automations", { project_id: company.id, name: "suspended write" }, { "idempotency-key": "suspended-write-blocked" });
    assert.equal(suspendedWrite.status, 404, suspendedWrite.body);
    const suspendedCreateCompany = await request("POST", "/api/companies", { name: "Suspended Company", slug: "suspended-company" });
    assert.equal(suspendedCreateCompany.status, 403, suspendedCreateCompany.body);
  } finally {
    execSql("UPDATE users SET status='active' WHERE id='user_viewer'");
    process.env.AUTOMATION_OS_OWNER_USER_ID = "user_a";
  }
});

test("legacy company membership backfill is per company and only for the explicit legacy owner", async () => {
  const previousActor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  const previousLegacyOwner = process.env.AUTOMATION_OS_LEGACY_OWNER_USER_ID;
  const actorId = "user_explicit_legacy_owner";
  const legacyCompanyId = "project-legacy-partial-membership";
  const timestamp = new Date().toISOString();
  execSql(`
    INSERT INTO mvp_automations (
      id, company_id, project_id, automation_type, name, description, goal, schedule, cadence,
      lane, risk_level, approval_policy, worker_command_kind, create_approval, status,
      builder_spec_json, created_at, updated_at
    ) VALUES (
      'automation_legacy_partial_membership', '', '${legacyCompanyId}', 'scheduled',
      'Legacy partial membership automation', '', '', '', 'manual', 'local', 'low',
      'never', 'none', 0, 'draft', '{}', '${timestamp}', '${timestamp}'
    );
  `);
  assert.ok(querySql("SELECT id FROM company_memberships LIMIT 1")[0], "fixture must already contain an unrelated membership");

  process.env.AUTOMATION_OS_OWNER_USER_ID = actorId;
  process.env.AUTOMATION_OS_LEGACY_OWNER_USER_ID = actorId;
  try {
    const response = await request("GET", "/api/companies");
    assert.equal(response.status, 200, response.body);
    const companies = JSON.parse(response.body).companies as Array<{ id: string; slug: string; name: string; status: string; role: string }>;
    const legacyCompany = companies.find((company) => company.id === legacyCompanyId);
    assert.deepEqual(legacyCompany && {
      id: legacyCompany.id,
      slug: legacyCompany.slug,
      name: legacyCompany.name,
      status: legacyCompany.status,
      role: legacyCompany.role
    }, {
      id: legacyCompanyId,
      slug: legacyCompanyId,
      name: "Project Legacy Partial Membership",
      status: "active",
      role: "owner"
    });
    assert.equal(querySql<{ count: number }>(`
      SELECT count(*) AS count FROM company_memberships
      WHERE company_id='${legacyCompanyId}' AND user_id='${actorId}' AND role='owner' AND status='active'
    `)[0].count, 1);
    assert.equal(querySql<{ count: number }>(`
      SELECT count(*) AS count FROM company_memberships WHERE company_id='${legacyCompanyId}'
    `)[0].count, 1);
    assert.equal(querySql<{ company_id: string }>(`
      SELECT company_id FROM mvp_automations WHERE id='automation_legacy_partial_membership'
    `)[0].company_id, legacyCompanyId);
  } finally {
    if (previousActor === undefined) delete process.env.AUTOMATION_OS_OWNER_USER_ID;
    else process.env.AUTOMATION_OS_OWNER_USER_ID = previousActor;
    if (previousLegacyOwner === undefined) delete process.env.AUTOMATION_OS_LEGACY_OWNER_USER_ID;
    else process.env.AUTOMATION_OS_LEGACY_OWNER_USER_ID = previousLegacyOwner;
  }
});

function request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload)] : []) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = {
      ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
      ...extraHeaders
    };
    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      removeHeader(name: string) { headers.delete(name.toLowerCase()); },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}
