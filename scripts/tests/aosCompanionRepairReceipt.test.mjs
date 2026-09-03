import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureSnapshot, verifyRepair } from "../aos-companion-repair-receipt.mjs";

test("captures an allowed source snapshot and rejects traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-repair-snapshot-"));
  fs.mkdirSync(path.join(root, "extension"), { recursive: true });
  fs.writeFileSync(path.join(root, "extension", "service-worker.js"), "export const v = 1;\n");
  const snapshot = captureSnapshot({ sourceRoot: root, files: ["extension/service-worker.js"] });
  assert.equal(snapshot.files["extension/service-worker.js"].exists, true);
  assert.throws(() => captureSnapshot({ sourceRoot: root, files: ["../outside.js"] }), /outside_source|not_allowed/u);
});

test("records changed files, syntax, schema, and focused test proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-repair-verify-"));
  fs.mkdirSync(path.join(root, "extension"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { "schema:check": "node -e \"process.exit(0)\"" } }));
  fs.writeFileSync(path.join(root, "extension", "service-worker.js"), "export const v = 2;\n");
  fs.writeFileSync(path.join(root, "scripts", "focused.test.mjs"), "import test from 'node:test'; test('ok', () => {});\n");
  const before = { files: { "extension/service-worker.js": { exists: true, sha256: "old", bytes: 1 } } };
  const artifactDir = path.join(root, "artifacts");
  const receipt = verifyRepair({
    sourceRoot: root,
    artifactDir,
    repairId: "r-test",
    playbookId: "frame_or_locator_readback",
    before,
    changedFiles: ["extension/service-worker.js"],
    focusedTests: ["scripts/focused.test.mjs"],
    representativeTests: ["scripts/focused.test.mjs"],
    schemaCheck: true,
    continuationsSent: 2,
    continuationsSkipped: 1,
  });
  assert.equal(receipt.implementation.changedFiles.length, 1);
  assert.equal(receipt.verification.status, "passed");
  assert.equal(receipt.continuations.sent, 2);
  assert.equal(fs.existsSync(receipt.artifactPath), true);
  const stored = JSON.parse(fs.readFileSync(receipt.artifactPath, "utf8"));
  assert.equal(stored.externalActionExecuted, false);
});

test("accepts the capability adapter playbook used by a real Companion repair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-capability-repair-receipt-"));
  fs.mkdirSync(path.join(root, "extension"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { "schema:check": "node -e \"process.exit(0)\"" } }));
  fs.writeFileSync(path.join(root, "extension", "service-worker.js"), "export const v = 2;\n");
  fs.writeFileSync(path.join(root, "scripts", "focused.test.mjs"), "import test from 'node:test'; test('ok', () => {});\n");
  const receipt = verifyRepair({
    sourceRoot: root,
    artifactDir: path.join(root, "artifacts"),
    repairId: "capability-adapter",
    playbookId: "capability_adapter_repair",
    before: { files: { "extension/service-worker.js": { exists: true, sha256: "old", bytes: 1 } } },
    changedFiles: ["extension/service-worker.js"],
    focusedTests: ["scripts/focused.test.mjs"],
    representativeTests: ["scripts/focused.test.mjs"],
    schemaCheck: true,
  });
  assert.equal(receipt.playbookId, "capability_adapter_repair");
  assert.equal(receipt.verification.status, "passed");
});
