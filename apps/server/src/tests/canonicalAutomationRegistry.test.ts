import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_COMPANY_ID,
  buildCanonicalAutomationRegistryReadback
} from "../automations/canonicalAutomationRegistry.js";
import { listRegisteredAutomationCatalog } from "../automations/registeredCatalog.js";

test("canonical registry is the six catalog workflows plus the separate Company Brief heartbeat", () => {
  const readback = buildCanonicalAutomationRegistryReadback();
  const catalogIds = listRegisteredAutomationCatalog().map((entry) => entry.canonicalWorkflowId);

  assert.equal(readback.status, "ok");
  assert.equal(readback.companyId, CANONICAL_COMPANY_ID);
  assert.equal(readback.items.length, 7);
  assert.deepEqual(readback.items.slice(0, 6).map((item) => item.id), catalogIds);
  assert.equal(readback.items[6]?.id, "aos-morning-brief");
  assert.equal(readback.items[6]?.plane, "heartbeat");
  assert.equal(readback.items.every((item) => item.companyId === CANONICAL_COMPANY_ID), true);
  assert.equal(readback.items.every((item) => item.effect.externalActionDefault === false), true);
  assert.equal(readback.items.every((item) => item.effect.executedInThisReadback === false), true);
  assert.equal(readback.promotedToRuntimeRegistry, false);
  assert.equal(readback.externalActionExecuted, false);
});

test("execution lanes are adapters and do not silently become canonical registrations", () => {
  const readback = buildCanonicalAutomationRegistryReadback();
  const canonicalIds = new Set(readback.items.map((item) => item.id));

  assert.deepEqual(readback.executionLaneAdapters, [
    "daily-ai-research-publish-run",
    "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "job-application-manager",
    "prompt-transfer-ukiyoe",
    "sns-multi-poster-ukiyoe",
    "x-authenticated-browser-lane"
  ]);
  assert.equal(canonicalIds.has("prompt-transfer-ukiyoe"), false);
  assert.equal(canonicalIds.has("sns-multi-poster-ukiyoe"), false);
  assert.equal(canonicalIds.has("x-authenticated-browser-lane"), false);
});
