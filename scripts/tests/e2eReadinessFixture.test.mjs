import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  WORKSPACE_ROOT,
  createE2EFixture,
  createE2EFixtureLease,
  inspectE2EFixture,
  cleanupE2EFixture,
  withE2EFixture,
} from "../e2e-readiness-fixture.mjs";

function testRoot(runId) {
  return path.join(WORKSPACE_ROOT, "work", "e2e", runId);
}

test("E2E fixture lifecycle creates an exact ledger and deletes only the approved fixture", () => {
  const runId = `e2e-fixture-test-${process.pid}`;
  const root = testRoot(runId);
  const cleanupReceiptPath = path.join(path.dirname(root), `cleanup-receipt-${runId}.v1.json`);
  try {
    const created = createE2EFixture({ runId, root });
    assert.equal(created.schema, "automation_os_e2e_fixture.v1");
    assert.equal(created.external_action_executed, false);
    assert.equal(inspectE2EFixture({ ledgerPath: created.ledger_path }).resource_count, 3);
    assert.throws(() => cleanupE2EFixture({ ledgerPath: created.ledger_path }), /e2e_fixture_delete_approval_required/);
    const cleaned = cleanupE2EFixture({ ledgerPath: created.ledger_path, deleteApproved: true });
    assert.equal(cleaned.status, "cleaned");
    assert.equal(cleaned.residual_root, false);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(cleanupReceiptPath), true);
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(cleanupReceiptPath)) fs.rmSync(cleanupReceiptPath, { force: true });
  }
});

test("E2E fixture lifecycle rejects broad or outside deletion targets", () => {
  assert.throws(() => createE2EFixture({ runId: "e2e-outside", root: "/tmp/e2e-outside" }), /e2e_fixture_root_outside_allowlist/);
});

test("E2E fixture lifecycle fails closed on tampering and foreign resources", () => {
  const runId = `e2e-fixture-integrity-${process.pid}`;
  const root = testRoot(runId);
  const cleanupReceiptPath = path.join(path.dirname(root), `cleanup-receipt-${runId}.v1.json`);
  try {
    const created = createE2EFixture({ runId, root });
    const resourcePath = path.join(root, "fixture-output.v1.json");
    const original = fs.readFileSync(resourcePath, "utf8");
    fs.appendFileSync(resourcePath, "tampered\n");
    assert.throws(() => inspectE2EFixture({ ledgerPath: created.ledger_path }), /e2e_fixture_resource_hash_mismatch/);
    fs.writeFileSync(resourcePath, original, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "foreign-resource.txt"), "must not be deleted\n", { mode: 0o600 });
    assert.throws(() => cleanupE2EFixture({ ledgerPath: created.ledger_path, deleteApproved: true }), /e2e_fixture_foreign_resource_present/);
    assert.equal(fs.existsSync(path.join(root, "foreign-resource.txt")), true);
    fs.rmSync(path.join(root, "foreign-resource.txt"), { force: true });
    const cleaned = cleanupE2EFixture({ ledgerPath: created.ledger_path, deleteApproved: true });
    assert.equal(cleaned.residual_root, false);
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(cleanupReceiptPath)) fs.rmSync(cleanupReceiptPath, { force: true });
  }
});

test("E2E fixture lease cleans up after failure and bounded timeout", async () => {
  const failureRunId = `e2e-fixture-failure-${process.pid}`;
  const failureRoot = testRoot(failureRunId);
  const failureReceiptPath = path.join(path.dirname(failureRoot), `cleanup-receipt-${failureRunId}.v1.json`);
  await assert.rejects(
    withE2EFixture({ runId: failureRunId, root: failureRoot }, async () => {
      throw new Error("fixture_callback_failure");
    }),
    /fixture_callback_failure/
  );
  assert.equal(fs.existsSync(failureRoot), false);
  assert.equal(fs.existsSync(failureReceiptPath), true);
  fs.rmSync(failureReceiptPath, { force: true });

  const timeoutRunId = `e2e-fixture-timeout-${process.pid}`;
  const timeoutRoot = testRoot(timeoutRunId);
  const timeoutReceiptPath = path.join(path.dirname(timeoutRoot), `cleanup-receipt-${timeoutRunId}.v1.json`);
  await assert.rejects(
    withE2EFixture({ runId: timeoutRunId, root: timeoutRoot, timeoutMs: 10 }, async (_lease, { signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(signal.aborted, true);
    }),
    /e2e_fixture_harness_timeout/
  );
  assert.equal(fs.existsSync(timeoutRoot), false);
  assert.equal(fs.existsSync(timeoutReceiptPath), true);
  fs.rmSync(timeoutReceiptPath, { force: true });
});

test("E2E fixture lease requires explicit deletion approval", () => {
  assert.throws(() => createE2EFixtureLease({ runId: `e2e-fixture-no-approval-${process.pid}` }), /e2e_fixture_delete_approval_required/);
});

test("E2E fixture lease cleans the exact ledger before SIGTERM exit", async () => {
  const runId = `e2e-fixture-sigterm-${process.pid}`;
  const root = testRoot(runId);
  const cleanupReceiptPath = path.join(path.dirname(root), `cleanup-receipt-${runId}.v1.json`);
  const modulePath = path.resolve(new URL("../e2e-readiness-fixture.mjs", import.meta.url).pathname);
  const childCode = `import { createE2EFixtureLease } from ${JSON.stringify(modulePath)};
const lease = createE2EFixtureLease({ runId: ${JSON.stringify(runId)}, root: ${JSON.stringify(root)}, deleteApproved: true, handleSignals: true });
process.stdout.write(JSON.stringify({ root: lease.root }) + "\\n");
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture_sigterm_child_start_timeout")), 5_000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child.kill("SIGTERM");
    const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
    closed = true;
    assert.equal(code, 143);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(cleanupReceiptPath), true);
  } finally {
    if (!closed) child.kill("SIGKILL");
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(cleanupReceiptPath)) fs.rmSync(cleanupReceiptPath, { force: true });
  }
});
