import assert from "node:assert/strict";
import test from "node:test";
import { nisenPrintsRunContracts, resolveRunContract } from "../runs/runContracts.js";

test("keeps NisenPrints full sync pruning and incremental append in separate modes", () => {
  const contracts = Object.values(nisenPrintsRunContracts);

  assert.equal(contracts.length, 3);
  for (const contract of contracts) {
    assert.equal(contract.allowedScope.includes("full_sync_pruning") && contract.allowedScope.includes("incremental_append"), false);
  }
  assert.ok(nisenPrintsRunContracts.nisenprints_etsy_sync.allowedScope.includes("full_sync_pruning"));
  assert.ok(!nisenPrintsRunContracts.nisenprints_etsy_sync.allowedScope.includes("incremental_append"));
  assert.ok(nisenPrintsRunContracts.nisenprints_full_publish_run.allowedScope.includes("incremental_append"));
  assert.ok(!nisenPrintsRunContracts.nisenprints_full_publish_run.allowedScope.includes("full_sync_pruning"));
});

test("requires same product recovery and forbids creating a new Printify product", () => {
  const contract = nisenPrintsRunContracts.nisenprints_printify_recovery;

  assert.ok(contract.allowedScope.includes("same_product_id_required"));
  assert.ok(contract.forbiddenActions.includes("new_product_creation"));
});

test("defaults ambiguous NisenPrints commands to Printify recovery", () => {
  assert.equal(resolveRunContract("NisenPrints を確認して")?.mode, "nisenprints_printify_recovery");
  assert.equal(resolveRunContract("NisenPrints Etsy Sync current listings")?.mode, "nisenprints_etsy_sync");
  assert.equal(resolveRunContract("NisenPrints Printify recovery 公開状態を確認")?.mode, "nisenprints_printify_recovery");
});

test("routes stale row and local queue cleanup intents to Etsy Sync", () => {
  assert.equal(resolveRunContract("NisenPrints stale row を prune して")?.mode, "nisenprints_etsy_sync");
  assert.equal(resolveRunContract("NisenPrints remove stale rows from queue/listings")?.mode, "nisenprints_etsy_sync");
  assert.equal(resolveRunContract("NisenPrints pinterest_queue.tsv を current source wins で修復")?.mode, "nisenprints_etsy_sync");
});

test("does not attach NisenPrints contracts to generic Etsy, Printify, Pinterest, or Browser Use commands", () => {
  assert.equal(resolveRunContract("Pinterestに投稿して"), undefined);
  assert.equal(resolveRunContract("Browser UseでPinterest画面確認"), undefined);
  assert.equal(resolveRunContract("Etsy価格を調べて"), undefined);
  assert.equal(resolveRunContract("Printifyの一般的な画面確認"), undefined);
});

test("does not attach NisenPrints contracts to code maintenance review commands", () => {
  assert.equal(resolveRunContract("NisenPrints contract routing 修正をレビュー"), undefined);
  assert.equal(resolveRunContract("NisenPrints workerEngine proof gate test を確認"), undefined);
});
