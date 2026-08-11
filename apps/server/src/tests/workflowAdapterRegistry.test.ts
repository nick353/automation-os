import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
  getWorkflowAdapterDefinition,
  listWorkflowAdapterDefinitions,
  validateWorkflowAdapterContract,
  workflowAdapterIdForReferenceWorkflow,
  workflowAdapterReadback
} from "../providers/workflowAdapterRegistry.js";

test("AOS owns provider-neutral adapter definitions for all six registered workflows", () => {
  const definitions = listWorkflowAdapterDefinitions();
  assert.equal(definitions.length, 6);
  for (const definition of definitions) {
    assert.equal(definition.schema, WORKFLOW_ADAPTER_REGISTRY_SCHEMA);
    assert.equal(definition.execution_authority, "automation_os_control_plane");
    assert.equal(definition.codex_is_not_authority, true);
    assert.equal(definition.default_mode, "preflight_no_effect");
    assert.equal(definition.external_action_default, false);
    if (definition.browser_surface === "browser_use_cli") {
      assert.equal(definition.web_operation_contract_binding?.adaptive_target_resolution, "live_semantic_candidate_unique_match");
      assert.equal(definition.web_operation_contract_binding?.fixed_locator_authority, false);
      assert.equal(definition.web_operation_contract_binding?.fixed_playbook_authority, false);
    } else {
      assert.equal(definition.web_operation_contract_binding, null);
    }
    assert.ok(definition.provider_adapters.length >= 2);
    assert.ok(definition.stages.length > 0);
    assert.ok(definition.stages.every((stage) => stage.external_action_allowed === false));
    const validation = validateWorkflowAdapterContract(definition);
    assert.deepEqual(validation, {
      ok: true,
      status: "ready_for_preflight_no_effect",
      exact_blocker: null,
      errors: []
    });
  }
});

test("all Browser Use workflows bind the same provider-neutral adaptive Web contract", () => {
  const browser = listWorkflowAdapterDefinitions().filter((definition) => definition.browser_surface === "browser_use_cli");
  assert.deepEqual(browser.map((definition) => definition.workflow_id), [
    "daily-ai-research-publish-run",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest"
  ]);
  assert.equal(new Set(browser.map((definition) => definition.web_operation_contract_binding?.schema)).size, 1);
  assert.ok(browser.every((definition) => definition.web_operation_contract_binding?.provider_neutral === true));
});

test("local adapters are bound to the same control plane without fabricating connector capability", () => {
  const local = listWorkflowAdapterDefinitions().filter((definition) => definition.browser_surface === "none");
  assert.deepEqual(local.map((definition) => definition.workflow_id), [
    "email-review-reply",
    "daily-backup-safety-check",
    "obsidian-project-memory-audit"
  ]);
  assert.ok(local.every((definition) => definition.execution_authority === "automation_os_control_plane"));
  assert.ok(local.every((definition) => definition.external_action_default === false));
  assert.ok(local.every((definition) => validateWorkflowAdapterContract(definition).ok));
  assert.match(getWorkflowAdapterDefinition("email-review-reply")?.exact_blockers.join(",") ?? "", /gmail_connector_context_isolation_unavailable/);
});

test("NisenPrints keeps Canva, Printify, Etsy, and Pinterest as separate adapters", () => {
  const definition = getWorkflowAdapterDefinition("nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.ok(definition);
  assert.deepEqual(
    definition.provider_adapters.filter((item) => ["canva", "printify", "etsy", "pinterest"].includes(item.id)).map((item) => item.id),
    ["canva", "printify", "etsy", "pinterest"]
  );
  assert.deepEqual(
    definition.stages.find((stage) => stage.id === "provider_mutations")?.provider_adapter_ids,
    ["canva", "printify"]
  );
  assert.deepEqual(
    definition.stages.find((stage) => stage.id === "etsy_and_pinterest_publish")?.provider_adapter_ids,
    ["etsy", "pinterest"]
  );
});

test("adapter readback is explicit and never grants external action", () => {
  const readback = workflowAdapterReadback("daily-ai-research-publish-run");
  assert.equal(readback.status, "ready_for_preflight_no_effect");
  assert.equal(readback.exact_blocker, null);
  assert.equal(readback.external_action_allowed, false);
  assert.equal(readback.live_effects_ready, false);
  assert.ok(Array.isArray(readback.provider_adapters));
  assert.ok(Array.isArray(readback.stages));
  assert.ok((readback.stages as Array<{ approval_required: boolean }>).some((stage) => stage.approval_required));
  assert.deepEqual(readback.effect_stage_ids, ["publish", "feed_study_and_engagement"]);

  const unknown = workflowAdapterReadback("unknown");
  assert.equal(unknown.status, "blocked");
  assert.equal(unknown.exact_blocker, "workflow_adapter_unknown");
  assert.equal(unknown.external_action_allowed, false);
});

test("reference workflow aliases resolve to canonical AOS adapter ids", () => {
  assert.equal(workflowAdapterIdForReferenceWorkflow("daily-ai"), "daily-ai-research-publish-run");
  assert.equal(workflowAdapterIdForReferenceWorkflow("job-application-manager"), "job-application-manager");
  assert.equal(workflowAdapterIdForReferenceWorkflow("nisenprints"), "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.equal(workflowAdapterIdForReferenceWorkflow("email-review"), "email-review-reply");
  assert.equal(workflowAdapterIdForReferenceWorkflow("daily-backup"), "daily-backup-safety-check");
  assert.equal(workflowAdapterIdForReferenceWorkflow("obsidian"), "obsidian-project-memory-audit");
  assert.equal(workflowAdapterIdForReferenceWorkflow("unknown"), undefined);
});
