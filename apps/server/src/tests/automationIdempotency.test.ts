import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-idempotency-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const { canonicalJson, hashIdempotencyRequest, runIdempotentSqlMutation } = await import("../automations/idempotency.js");

test("canonical idempotency hashing ignores object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(hashIdempotencyRequest({ a: 1, b: 2 }), hashIdempotencyRequest({ b: 2, a: 1 }));
});

test("idempotent SQL mutation commits resource and receipt once, then replays", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql(`
    INSERT INTO companies (id, slug, name, status, created_at, updated_at) VALUES
      ('company-a', 'company-a', 'Company A', 'active', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'),
      ('company-b', 'company-b', 'Company B', 'active', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
  `);
  db.execSql("DELETE FROM mvp_idempotency_keys; DELETE FROM knowledge_notes WHERE id='idem_resource';");
  const input = {
    companyId: "company-a",
    scope: "automation.create",
    key: "company-a:create:001",
    request: { name: "A", values: [1, 2] },
    resourceSteps: [{
      sql: `INSERT INTO knowledge_notes (id, note_type, title, body, tags_json, source_ref, created_at, updated_at, metadata_json)
            VALUES ('idem_resource', 'test', 'Idempotent', 'body', '[]', NULL, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '{}')`,
      expectChanges: 1
    }],
    response: { ok: true, id: "idem_resource" }
  } as const;
  const first = runIdempotentSqlMutation(input);
  const second = runIdempotentSqlMutation({ ...input, request: { values: [1, 2], name: "A" } });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.response, input.response);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM knowledge_notes WHERE id='idem_resource'")[0].count, 1);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_idempotency_keys WHERE company_id='company-a'")[0].count, 1);
});

test("idempotency key rejects changed payload without exposing payload", () => {
  assert.throws(() => runIdempotentSqlMutation({
    companyId: "company-a",
    scope: "automation.create",
    key: "company-a:create:001",
    request: { name: "B", password: "must-not-appear-in-error" },
    resourceSteps: [],
    response: { ok: true }
  }), (error: unknown) => {
    assert.equal((error as Error).message, "idempotency_key_payload_conflict");
    assert.doesNotMatch((error as Error).message, /must-not-appear/);
    return true;
  });
});

test("pending and incomplete receipts fail closed", () => {
  db.execSql(`
    DELETE FROM mvp_idempotency_keys;
    INSERT INTO mvp_idempotency_keys
      (id, company_id, scope, idempotency_key, request_hash, response_json, status, expires_at, created_at, updated_at)
    VALUES
      ('pending', 'company-a', 'automation.create', 'pending-key', ${db.sqlValue(hashIdempotencyRequest({ a: 1 }))}, '{}', 'pending', NULL, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'),
      ('failed', 'company-a', 'automation.create', 'failed-key', ${db.sqlValue(hashIdempotencyRequest({ a: 1 }))}, '{}', 'failed', NULL, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
  `);
  const base = { companyId: "company-a", scope: "automation.create", request: { a: 1 }, resourceSteps: [], response: { ok: true } };
  assert.throws(() => runIdempotentSqlMutation({ ...base, key: "pending-key" }), /idempotency_request_pending/);
  assert.throws(() => runIdempotentSqlMutation({ ...base, key: "failed-key" }), /idempotency_request_incomplete/);
});

test("resource failure rolls back the idempotency reservation", () => {
  db.execSql("DELETE FROM mvp_idempotency_keys; DELETE FROM knowledge_notes WHERE id='idem_rollback';");
  assert.throws(() => runIdempotentSqlMutation({
    companyId: "company-a",
    scope: "automation.create",
    key: "company-a:create:rollback",
    request: { a: 1 },
    resourceSteps: [{ sql: "UPDATE knowledge_notes SET title='x' WHERE id='idem_rollback'", expectChanges: 1 }],
    response: { ok: true }
  }), /sql_transaction_expected_changes/);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_idempotency_keys WHERE idempotency_key='company-a:create:rollback'")[0].count, 0);
});

test("idempotency scope is isolated by company", () => {
  db.execSql("DELETE FROM mvp_idempotency_keys;");
  for (const companyId of ["company-a", "company-b"]) {
    const result = runIdempotentSqlMutation({
      companyId,
      scope: "memory.create",
      key: "same-key-across-companies",
      request: { companyId },
      resourceSteps: [],
      response: { ok: true, companyId }
    });
    assert.equal(result.replayed, false);
  }
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_idempotency_keys WHERE idempotency_key='same-key-across-companies'")[0].count, 2);
});
