import assert from "node:assert/strict";
import test from "node:test";
import { buildRegisteredWorkflowInventoryReadback } from "../workflowInventory.js";

test("workflow inventory distinguishes browser, company catalog, and lane registries", () => {
  const readback = buildRegisteredWorkflowInventoryReadback();

  assert.equal(readback.status, "ok");
  assert.deepEqual(readback.sets.registered_browser_workflows, [
    "daily-ai-research-publish-run",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "prompt-transfer-ukiyoe",
    "sns-multi-poster-ukiyoe",
    "x-authenticated-browser-lane"
  ]);
  assert.deepEqual(readback.sets.company_automation_catalog_workflows, [
    "daily-ai-research-publish-run",
    "daily-backup-safety-check",
    "email-review-reply",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "obsidian-project-memory-audit"
  ]);
  assert.deepEqual(readback.sets.browser_lane_workflows, [
    "daily-ai-research-publish-run",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "prompt-transfer-ukiyoe",
    "sns-multi-poster-ukiyoe",
    "x-authenticated-browser-lane",
    "youtube-visible-transcript-capture"
  ]);
  assert.equal(readback.relationships.browser_and_portable_match, true);
  assert.equal(readback.relationships.catalog_and_adapter_match, true);
  assert.deepEqual(readback.relationships.browser_and_catalog_overlap, [
    "daily-ai-research-publish-run",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest"
  ]);
  assert.deepEqual(readback.relationships.browser_only, [
    "prompt-transfer-ukiyoe",
    "sns-multi-poster-ukiyoe",
    "x-authenticated-browser-lane"
  ]);
  assert.deepEqual(readback.relationships.catalog_only, [
    "daily-backup-safety-check",
    "email-review-reply",
    "obsidian-project-memory-audit"
  ]);
  assert.deepEqual(readback.relationships.lane_only, ["youtube-visible-transcript-capture"]);
  assert.equal(readback.browser_lane_bindings.length, 7);
  assert.deepEqual(
    readback.browser_lane_bindings.find((lane) => lane.workflow_id === "job-application-manager"),
    {
      lane_id: "job-application-manager-browser-use-cli-scheduled",
      workflow_id: "job-application-manager",
      runner_kind: "job_manager_registered",
      canonical_browser_surface: "browser_use_cli",
      visibility: "visible",
      lifecycle: "scheduled",
      profile_ref: "scheduled/automation-3",
      profile_name: "automation-3",
      reserved_port: 19881,
      port_status: "reserved",
      ownership: "workflow_owned",
      binding_status: "registered",
      live_readback_status: "not_claimed"
    }
  );
  assert.deepEqual(
    readback.browser_lane_bindings.find((lane) => lane.workflow_id === "youtube-visible-transcript-capture"),
    {
      lane_id: "youtube-visible-transcript-browser-use-cli-temporary",
      workflow_id: "youtube-visible-transcript-capture",
      runner_kind: "youtube_transcript_registered",
      canonical_browser_surface: "browser_use_cli",
      visibility: "visible",
      lifecycle: "temporary",
      profile_ref: "temporary/youtube-visible-transcript",
      profile_name: "youtube-visible-transcript",
      reserved_port: 20080,
      port_status: "reserved",
      ownership: "workflow_owned",
      binding_status: "registered",
      live_readback_status: "not_claimed"
    }
  );
  assert.equal(readback.external_action_executed, false);
});
