import assert from "node:assert/strict";
import test from "node:test";
import {
  registeredWorkflowDefinitionFingerprint,
  registeredWorkflowScheduleFingerprint
} from "../registeredWorkflows.js";

const base = {
  id: "daily-ai-research-publish-run",
  status: "active",
  runner_kind: "daily_ai_registered",
  start_command_json: JSON.stringify({ command: "Daily AI registered workflow run full flow", source: "fixed_automation_os_entrypoint" }),
  source_refs_json: JSON.stringify([{ type: "automation_toml", path: "/tmp/daily-ai/automation.toml" }]),
  provenance_json: JSON.stringify({
    source: "fixed_native_registration",
    completionBoundary: "approved_publish_requires_readback",
    safetyContract: { externalActionExecutedByRehearsal: false },
    codexAppContinuousSync: false
  }),
  schedule_json: JSON.stringify({ kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" })
};

test("registered definition fingerprint ignores mutable scheduler overlays", () => {
  const withRuntimeOverlay = {
    ...base,
    provenance_json: JSON.stringify({
      ...JSON.parse(base.provenance_json),
      scheduler: { lastRunAt: "2026-08-15T10:00:00.000Z" },
      scheduleControl: { paused: false, updatedAt: "2026-08-15T10:01:00.000Z" }
    })
  };
  assert.equal(
    registeredWorkflowDefinitionFingerprint(base),
    registeredWorkflowDefinitionFingerprint(withRuntimeOverlay)
  );
});

test("registered definition and schedule fingerprints still change for source changes", () => {
  assert.notEqual(
    registeredWorkflowDefinitionFingerprint(base),
    registeredWorkflowDefinitionFingerprint({ ...base, runner_kind: "job_submit_registered" })
  );
  assert.notEqual(
    registeredWorkflowScheduleFingerprint(base),
    registeredWorkflowScheduleFingerprint({ ...base, schedule_json: JSON.stringify({ kind: "cron", rrule: "FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0" }) })
  );
});
