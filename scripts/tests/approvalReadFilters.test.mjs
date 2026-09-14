import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../apps/web/src/approvalReadFilters.ts", import.meta.url), "utf8");

test("approval query is company/run scoped, encoded, and fixed to limit 20", () => {
  assert.match(source, /params\.set\("run_id", filters\.runId\)/);
  assert.match(source, /params\.set\("limit", "20"\)/);
  assert.match(source, /encodeURIComponent\(filters\.companyId\)/);
  assert.match(source, /if \(filters\.status\)/);
  assert.match(source, /if \(filters\.actionKind\)/);
});

test("response validation is fail-closed for scope, metadata, count, and rows", () => {
  for (const pattern of [/body\.ok !== true/, /scope\.enforced !== true/, /scope\.company_id !== filters\.companyId/, /query\.limit !== 20/, /query\.run_id !== filters\.runId/, /!Number\.isInteger\(body\.count\)/, /!Array\.isArray\(body\.approvals\)/]) assert.match(source, pattern);
  assert.match(source, /approval_readback_contract_mismatch/);
});
