import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IAB_CONTRACT_VERSION,
  IAB_HANDLER_RECEIPT_SCHEMA,
  IAB_READONLY_CONTRACT_SCHEMA,
  computeIabReceiptHash,
  createTrustedStateRootProvenance,
  normalizeIabTargetRequest
} from "../browser/iabReadOnlyBridge.js";
import {
  CANONICAL_IAB_MAX_JSON_BYTES,
  readCanonicalIabOwnerDiagnostics
} from "../browser/iabCanonicalLoader.js";

const now = new Date("2026-07-22T00:00:00.000Z");

function writeJson(path: string, value: unknown, mode = 0o644): void {
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function fixtureDocuments() {
  const issuedAt = new Date(now.getTime() - 10_000).toISOString();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const identity = {
    generation: "generation-a",
    project_id: "project-a",
    thread_id: "thread-a",
    session_id: "session-a",
    turn_id: "turn-a",
    nonce: "nonce-a",
    stage: "read",
    attempt: 1
  };
  const targetBase = {
    url: "https://example.com/a?z=2&b=1",
    http_method: "GET",
    operation: "read_dom",
    redirect_scope: "same-origin"
  };
  const target = normalizeIabTargetRequest(targetBase);
  assert.equal(target.ok, true);
  const provenance = createTrustedStateRootProvenance({ generation: identity.generation, issued_at: issuedAt });
  const contract = {
    schema: IAB_READONLY_CONTRACT_SCHEMA,
    contract_version: IAB_CONTRACT_VERSION,
    contract_id: "contract-a",
    issued_at: issuedAt,
    expires_at: expiresAt,
    ...identity,
    target: { ...targetBase, target_request_sha256: target.value.target_request_sha256 },
    proof: { screenshot_required: true, dom_readback_required: true },
    cleanup: { required: true },
    external_action: false,
    provenance
  };
  const receiptWithoutHash = {
    schema: IAB_HANDLER_RECEIPT_SCHEMA,
    contract_version: IAB_CONTRACT_VERSION,
    contract_id: contract.contract_id,
    receipt_id: "receipt-a",
    issued_at: issuedAt,
    expires_at: expiresAt,
    ...identity,
    target: contract.target,
    proof: { status: "verified", dom_readback: true, screenshot: { status: "present", path: "screenshot.png", artifact_sha256: "a".repeat(64) } },
    cleanup: { status: "verified", no_residual_processes: true, no_external_action: true },
    external_action: false,
    provenance
  };
  const receipt = { ...receiptWithoutHash, receipt_hash_sha256: computeIabReceiptHash(receiptWithoutHash as never) };
  return { contract, receipt };
}

function fixtureRoot(): { root: string; iab: string; contractPath: string; receiptPath: string } {
  const root = mkdtempSync(join(tmpdir(), "automation-os-iab-canonical-"));
  const iab = join(root, "iab");
  mkdirSync(iab);
  chmodSync(root, 0o700);
  return { root, iab, contractPath: join(iab, "readonly-contract.json"), receiptPath: join(iab, "handler-receipt.json") };
}

function read(root: string, extra: Record<string, unknown> = {}) {
  return readCanonicalIabOwnerDiagnostics({ enabled: true, rootPath: root, allowTestRoot: true, now, ...extra });
}

test("canonical reader is default-off and rejects non-canonical root overrides", () => {
  const root = fixtureRoot();
  try {
    assert.equal(readCanonicalIabOwnerDiagnostics().exact_blocker, "iab_canonical_loader_disabled");
    assert.equal(readCanonicalIabOwnerDiagnostics({ enabled: true, rootPath: root.root }).exact_blocker, "iab_canonical_root_override_forbidden");
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("missing contract and receipt are blocked without fabricating documents", () => {
  const root = fixtureRoot();
  try {
    assert.deepEqual(read(root.root), {
      state: "blocked",
      contract_version: "v1",
      receipt_fresh: false,
      consumed: false,
      provenance: "blocked",
      generation: "unknown",
      proof: "invalid",
      cleanup: "invalid",
      age_ms: null,
      binding: "unknown",
      exact_blocker: "iab_canonical_contract_missing",
      existing_workflows_unchanged: false,
      source: "canonical_state_root"
    });

    const docs = fixtureDocuments();
    writeJson(root.contractPath, docs.contract);
    assert.equal(read(root.root).exact_blocker, "iab_canonical_receipt_missing");
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("symlink and unsafe-mode receipts are unreadable", () => {
  const root = fixtureRoot();
  const external = join(root.root, "outside-receipt.json");
  try {
    const docs = fixtureDocuments();
    writeJson(root.contractPath, docs.contract);
    writeJson(external, docs.receipt, 0o600);
    symlinkSync(external, root.receiptPath);
    assert.equal(read(root.root).exact_blocker, "iab_canonical_receipt_unreadable");

    rmSync(root.receiptPath);
    writeJson(root.receiptPath, docs.receipt, 0o644);
    assert.equal(read(root.root).exact_blocker, "iab_canonical_receipt_unreadable");
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("malformed and invalid contracts fail closed with an exact blocker", () => {
  const root = fixtureRoot();
  try {
    const docs = fixtureDocuments();
    writeFileSync(root.contractPath, "{not-json", { encoding: "utf8", mode: 0o600 });
    chmodSync(root.contractPath, 0o600);
    writeJson(root.receiptPath, docs.receipt, 0o600);
    assert.equal(read(root.root).exact_blocker, "iab_canonical_contract_invalid");

    writeJson(root.contractPath, { schema: "wrong" }, 0o600);
    assert.equal(read(root.root).exact_blocker, "iab_contract_schema_invalid");
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("valid canonical files return only the safe owner projection", () => {
  const root = fixtureRoot();
  try {
    const docs = fixtureDocuments();
    writeJson(root.contractPath, docs.contract);
    writeJson(root.receiptPath, docs.receipt, 0o600);
    const projection = read(root.root);
    assert.deepEqual(projection, {
      state: "blocked",
      contract_version: "v1",
      receipt_fresh: true,
      consumed: false,
      provenance: "trusted_state_root",
      generation: "match",
      proof: "verified",
      cleanup: "verified",
      age_ms: 10_000,
      binding: "matched",
      exact_blocker: "iab_existing_workflows_unchanged_unverified",
      existing_workflows_unchanged: false,
      source: "canonical_state_root"
    });
    const serialized = JSON.stringify(projection);
    for (const secret of ["contract-a", "receipt-a", "nonce-a", "screenshot.png", "example.com", "a".repeat(64)]) {
      assert.equal(serialized.includes(secret), false);
    }

    const oversized = "{" + "x".repeat(CANONICAL_IAB_MAX_JSON_BYTES) + "}";
    writeFileSync(root.contractPath, oversized, { encoding: "utf8", mode: 0o600 });
    chmodSync(root.contractPath, 0o600);
    assert.equal(read(root.root).exact_blocker, "iab_canonical_contract_unreadable");
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});
