import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectPresentationProfileOverride, buildProjectPresentationProfile, parseProjectPresentationProfileOverride, restoreProjectPresentationProfile } from "../projects/presentationProfile.js";

test("mixed-company profiles preserve saved preferences and optional blank fields", () => {
  const derived = buildProjectPresentationProfile({ id: "company", name: "Company", automations: [
    { name: "Job Application Manager" }, { name: "Daily AI" }, { name: "Backup" }
  ] });
  assert.equal(derived.kind, "operations");
  const override = parseProjectPresentationProfileOverride({ label: "My dashboard", kind: "research", purpose: "", browserUseLane: "", stopBoundary: "" });
  const restored = restoreProjectPresentationProfile(derived, { body: JSON.stringify(override), revision: 4 });
  assert.equal(restored.id, "company");
  assert.equal(restored.kind, "research");
  assert.equal(restored.label, "My dashboard");
  assert.equal(restored.revision, 4);
  assert.equal(restored.purpose, "");
  assert.throws(() => parseProjectPresentationProfileOverride({ label: "" }), /label_invalid/);
  const invalid = restoreProjectPresentationProfile(derived, { body: "not json", revision: 5 });
  assert.equal(invalid.revision, 5);
  assert.ok(invalid.exactBlocker);
  assert.deepEqual(restoreProjectPresentationProfile(derived), derived);
});

test("project presentation profiles choose widgets from the automation catalog", () => {
  const jobs = buildProjectPresentationProfile({
    id: "jobs",
    name: "求人管理",
    automations: [{ name: "Job Application Manager", goal: "求人候補を確認" }]
  });
  const commerce = buildProjectPresentationProfile({
    id: "shop",
    name: "NisenPrints",
    automations: [{ name: "Etsy product", goal: "PrintifyとEtsyの商品準備" }]
  });
  assert.equal(jobs.kind, "jobs");
  assert.ok(jobs.widgets.includes("funnel"));
  assert.equal(commerce.kind, "commerce");
  assert.ok(commerce.widgets.includes("evidence_timeline"));
});

test("project presentation profile overrides are bounded and revisioned", () => {
  const derived = buildProjectPresentationProfile({ id: "research", name: "調査", automations: [] });
  const override = parseProjectPresentationProfileOverride({
    kind: "research",
    label: "週次リサーチ",
    freshnessSlaMinutes: 120,
    primaryMetrics: ["新規情報", "停止中"],
    widgets: ["kpi", "timeline", "failure_table"],
    preferredGrouping: "week",
    explanation: "鮮度と停止理由を優先する"
  });
  const persisted = applyProjectPresentationProfileOverride(derived, override, 3);
  assert.equal(persisted.source, "persisted_project_profile");
  assert.equal(persisted.revision, 3);
  assert.equal(persisted.label, "週次リサーチ");
  assert.throws(() => parseProjectPresentationProfileOverride({ widgets: ["unknown_widget"] }), /project_profile_widgets_invalid/);
  assert.throws(() => parseProjectPresentationProfileOverride({ unexpected: true }), /project_profile_unknown_field:unexpected/);
});
