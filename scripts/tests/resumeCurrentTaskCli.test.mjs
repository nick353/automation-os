import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildResumePlan, main } from "../resume-current-task.mjs";

const healthy = {
  taskId: "task-1",
  sourceThreadId: "thread-1",
  generation: "gen-1",
  lastTerminalTurnId: "turn-1",
  resumeIntent: "continue",
  status: { effectKnown: true, providerActive: true },
  identity: { ownerId: "owner-1", sourceThreadId: "thread-1" },
  ownership: { owned: true },
};

test("builds a read-only eligible plan with the source-thread Job policy", () => {
  const plan = buildResumePlan(healthy, "job");
  assert.equal(plan.schema, "resume_current_task_plan.v1");
  assert.equal(plan.decision, "eligible");
  assert.equal(plan.reason, "ready");
  assert.equal(plan.same_thread_only, true);
  assert.equal(plan.adapter.applicationResumeLane, "direct_application");
  assert.equal(plan.adapter.handoffPolicy, "source_return_only");
  assert.equal(plan.adapter.applicationAuthority, "companion_local_owner_run");
  assert.equal(plan.application_resume_lane, "direct_application");
  assert.equal(plan.source_resume_required, false);
  assert.equal(plan.handoff_metadata_ignored_for_application, true);
  assert.deepEqual(plan.planned_side_effect_order, [
    "cleanup_owner_only",
    "create_fresh_session",
    "send_thread_continuation",
  ]);
  assert.equal(plan.external_action_executed, false);
  assert.equal(plan.read_only, true);
  assert.match(plan.idempotency_key, /^[a-f0-9]{64}$/u);
});

test("a stale source handoff field does not block a direct Job application plan", () => {
  const plan = buildResumePlan({
    ...healthy,
    source_status: "handoff_completed",
    implementation_allowed: false,
  }, "job");
  assert.equal(plan.decision, "eligible");
  assert.equal(plan.reason, "ready");
  assert.equal(plan.application_resume_lane, "direct_application");
  assert.equal(plan.handoff_metadata_ignored_for_application, true);
});

test("an explicit source-return plan still requires the signed admission", () => {
  const plan = buildResumePlan({
    ...healthy,
    resumeIntent: "return_no_output_to_source",
    source_status: "handoff_completed",
    implementation_allowed: false,
  }, "job");
  assert.equal(plan.decision, "blocked");
  assert.equal(plan.reason, "handoff_gate_active");
  assert.equal(plan.application_resume_lane, "source_return");
  assert.equal(plan.source_resume_required, true);
});

test("missing identity and blockers fail closed without echoing the input", () => {
  const plan = buildResumePlan({
    taskId: "task-2",
    status: { operation_effect_unknown: true },
    secret: "must-not-be-printed",
  });
  assert.equal(plan.decision, "blocked");
  assert.equal(plan.reason, "unknown_effect");
  assert.equal(plan.identity_complete, false);
  assert.ok(plan.missing_identity_fields.includes("generation"));
  assert.equal("secret" in plan, false);
  assert.deepEqual(plan.planned_side_effect_order, []);
});

test("CLI reads a private JSON snapshot and writes only a bounded plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-plan-cli."));
  try {
    const inputPath = path.join(root, "input.json");
    const outputPath = path.join(root, "plan.json");
    fs.writeFileSync(inputPath, JSON.stringify(healthy), { mode: 0o600 });
    const chunks = [];
    const result = main(["--input", inputPath, "--output", outputPath, "--task-type", "note"], {}, {
      stdout: { write(value) { chunks.push(value); } },
    });
    assert.equal(result.task_type, "note");
    assert.equal(result.read_only, true);
    assert.equal(chunks.length, 1);
    const stored = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.deepEqual(stored, result);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
