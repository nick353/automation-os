import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../apps/web/src/ApprovalReadbackPanel.tsx", import.meta.url), "utf8");

test("panel exposes the required read-only states and fields", () => {
  for (const label of ["Run未指定では検索しません", "承認照会は未確認です", "一致する承認は0件です", "上限到達、続きの有無は未確認", "GET /api/v1/companies/:companyId/approvals"]) assert.match(source, new RegExp(label));
  for (const field of ["id", "run_id", "action_kind", "target_account_ref_id", "payload_hash", "policy_version", "expires_at", "decision_revision", "consumed_at", "consumed_by_attempt_id"]) assert.match(source, new RegExp(field));
  assert.match(source, /旧APIやmvpState一覧にはfallback/);
});

test("slow response protection and no mutation controls are explicit", () => {
  assert.match(source, /generation\.current/);
  assert.match(source, /AbortController/);
  assert.match(source, /window\.setTimeout\(\(\) =>/);
  assert.match(source, /approval_readback_timeout/);
  assert.match(source, /window\.clearTimeout\(timeoutHandle\)/);
  assert.match(source, /if \(companyId && initialRunId\.trim\(\)\) void search\(\)/);
  assert.match(source, /業務Run IDを確認しました。承認照会を実行してください/);
  assert.doesNotMatch(source, /method:\s*["'](POST|PATCH|PUT|DELETE)["']/);
  assert.doesNotMatch(source, /data-control-id="approvals\.(approve|reject|execute)/);
});
