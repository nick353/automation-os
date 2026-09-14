import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNisenInventory } from "../nisenprints-inventory-readback.mjs";

const companyId = "company_2560580981cedfd106b66245";
const product = { id: "6a4a09f08295538b61036f1b", title: "Existing fixture", visible: true,
  external: { id: "4532823269", handle: "https://www.etsy.com/listing/4532823269/existing-fixture" } };
function fixture() {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "aos-nisen-inventory-"));
  const dir = path.join(projectRoot, "artifacts", "publish_manifests");
  mkdirSync(dir, { recursive: true });
  const source = path.join(dir, "2026-06-25-224048-3da7-fuji-firefly-river-onsen-gray-tabby-cat.json");
  writeFileSync(source, JSON.stringify({ printify_product_id: product.id, etsy_listing_id: product.external.id,
    final_status: "pinterest_posted", resume_stage: "completed", historical_only: true }));
  return { projectRoot, source };
}
test("existing product gets two provider reads and same-run local source sync, never new publication", async () => {
  const f = fixture();
  const before = readFileSync(f.source, "utf8");
  const calls = [];
  const args = { ...f, runId: "run_inventory_fixture", companyId, readCredential: () => "fixture-secret",
    requestJson: async (route, token) => { assert.equal(token, "fixture-secret"); calls.push(route);
      return route === "/shops.json" ? [{ id: 21066723, sales_channel: "etsy" }] : product; } };
  const result = await runNisenInventory(args);
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, ["/shops.json", `/shops/21066723/products/${product.id}.json`]);
  assert.equal(result.same_run_source_sync, true);
  assert.equal(result.external_action_executed, false);
  assert.equal(result.full_publish_workflow_completed, false);
  assert.equal(result.new_publication_completed, false);
  assert.equal(readFileSync(f.source, "utf8"), before);
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  const sameRun = await runNisenInventory(args);
  assert.equal(sameRun.artifact_sha256, result.artifact_sha256);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(readFileSync(result.artifact_path, "utf8")).run_id, args.runId);
});
for (const scenario of ["foreign_company", "wrong_listing", "hidden_product", "auth_error", "source_changed"]) {
  test(`inventory blocks ${scenario} without publishing or claiming source sync`, async () => {
    const f = fixture();
    let calls = 0;
    const result = await runNisenInventory({ ...f, runId: `run_${scenario}`, companyId: scenario === "foreign_company" ? "foreign" : companyId,
      readCredential: () => "fixture-secret", requestJson: async (route) => {
        calls += 1;
        if (scenario === "auth_error") throw new Error("printify_auth_required");
        if (route === "/shops.json") return [{ id: 21066723, sales_channel: "etsy" }];
        if (scenario === "source_changed") writeFileSync(f.source, "{}");
        return scenario === "wrong_listing" ? { ...product, external: { ...product.external, id: "999" } }
          : scenario === "hidden_product" ? { ...product, visible: false } : product;
      } });
    assert.equal(result.status, "blocked");
    assert.equal(result.same_run_source_sync, false);
    assert.equal(result.external_action_executed, false);
    assert.equal(result.full_publish_workflow_completed, false);
    if (scenario === "foreign_company") assert.equal(calls, 0);
  });
}
