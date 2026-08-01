import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-source-run-binding-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");
const { resolveExactSourceRunBinding } = await import("../cli/sourceRunBinding.js");

test("resolveExactSourceRunBinding fails closed on conflicting snake and camel aliases", () => {
  db.initDb();

  assert.throws(
    () =>
      resolveExactSourceRunBinding({
        expectedWorkflowId: "daily-ai-research-publish-run",
        artifactAutomationOsRunId: "run_snake_alias",
        artifactAutomationOsRunIdCamel: "run_camel_alias"
      }),
    /source_run_id_conflict/
  );
});

test("resolveExactSourceRunBinding fails closed on conflicting stored workflow aliases before mutation", () => {
  db.initDb();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_workflow_alias_conflict",
    company_id: "project-a",
    name: "Workflow alias conflict run",
    status: "blocked",
    objective: "workflow alias conflict",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      registered_workflow_id: "prompt-transfer-ukiyoe"
    }
  });

  let mutationCalled = false;
  assert.throws(
    () => {
      resolveExactSourceRunBinding({
        expectedWorkflowId: "daily-ai-research-publish-run",
        explicitSourceRunId: "run_workflow_alias_conflict"
      });
      mutationCalled = true;
    },
    /source_run_workflow_conflict/
  );
  assert.equal(mutationCalled, false);
});

test("resolveExactSourceRunBinding fails closed on conflicting top-level and nested start workflow aliases before mutation", () => {
  db.initDb();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_nested_workflow_alias_conflict",
    company_id: "project-a",
    name: "Nested workflow alias conflict run",
    status: "blocked",
    objective: "nested workflow alias conflict",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      registered_workflow_start: {
        workflowId: "prompt-transfer-ukiyoe"
      }
    }
  });

  let mutationCalled = false;
  assert.throws(
    () => {
      resolveExactSourceRunBinding({
        expectedWorkflowId: "daily-ai-research-publish-run",
        explicitSourceRunId: "run_nested_workflow_alias_conflict"
      });
      mutationCalled = true;
    },
    /source_run_workflow_conflict/
  );
  assert.equal(mutationCalled, false);
});

test("resolveExactSourceRunBinding fails closed on primary, fallback, and explicit conflicts", () => {
  db.initDb();

  assert.throws(
    () =>
      resolveExactSourceRunBinding({
        expectedWorkflowId: "prompt-transfer-ukiyoe",
        artifactAutomationOsRunId: "run_primary_alias",
        artifactRunIdFallback: "run_fallback_alias",
        allowArtifactRunIdFallback: true,
        explicitSourceRunId: "run_primary_alias"
      }),
    /source_run_id_conflict/
  );

  assert.throws(
    () =>
      resolveExactSourceRunBinding({
        expectedWorkflowId: "prompt-transfer-ukiyoe",
        artifactAutomationOsRunId: "run_primary_alias",
        artifactRunIdFallback: "run_primary_alias",
        allowArtifactRunIdFallback: true,
        explicitSourceRunId: "run_explicit_alias"
      }),
    /source_run_id_conflict/
  );
});

test("resolveExactSourceRunBinding preserves exact workflow mismatch behavior", () => {
  db.initDb();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_workflow_mismatch",
    company_id: "project-a",
    name: "Workflow mismatch run",
    status: "blocked",
    objective: "workflow mismatch",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "prompt-transfer-ukiyoe"
    }
  });

  assert.throws(
    () =>
      resolveExactSourceRunBinding({
        expectedWorkflowId: "daily-ai-research-publish-run",
        explicitSourceRunId: "run_workflow_mismatch"
      }),
    /source_run_workflow_identity_mismatch/
  );
});

test("resolveExactSourceRunBinding accepts same-value workflow duplicates across direct metadata and registered_workflow_start", () => {
  db.initDb();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_same_workflow_aliases",
    company_id: "project-a",
    name: "Same-value source binding run",
    status: "blocked",
    objective: "same-value source binding duplicates accepted",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      registered_workflow_start: {
        registeredWorkflowId: "daily-ai-research-publish-run",
        registered_workflow_id: "daily-ai-research-publish-run",
        workflowId: "daily-ai-research-publish-run",
        workflow_id: "daily-ai-research-publish-run",
        AUTOMATION_OS_REGISTERED_WORKFLOW_ID: "daily-ai-research-publish-run"
      }
    }
  });

  const sourceRun = resolveExactSourceRunBinding({
    expectedWorkflowId: "daily-ai-research-publish-run",
    artifactAutomationOsRunId: "run_same_workflow_aliases",
    artifactAutomationOsRunIdCamel: "run_same_workflow_aliases",
    artifactRunIdFallback: "run_same_workflow_aliases",
    allowArtifactRunIdFallback: true,
    explicitSourceRunId: "run_same_workflow_aliases"
  });

  assert.equal(sourceRun.id, "run_same_workflow_aliases");
  assert.equal(sourceRun.company_id, "project-a");
});
