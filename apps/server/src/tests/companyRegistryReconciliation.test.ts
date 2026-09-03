import assert from "node:assert/strict";
import test from "node:test";

const { CompanyRegistryReconciliationError, canonicalCompanyId, reconcileCompanyRegistry } = await import("../companies/registryReconciliation.js");

const key = "company-registry-test-run-key";

function record(input: Partial<{
  recordId: string;
  companyId: unknown;
  identityKey: string;
  safeFields: Record<string, unknown>;
  expectedSafeFields: Record<string, unknown>;
}> = {}) {
  return {
    recordId: input.recordId ?? "record-1",
    companyId: input.companyId ?? "company-a",
    identityKey: input.identityKey ?? "automation:one",
    safeFields: input.safeFields ?? { automation_id: "automation-one", status: "active" },
    ...(input.expectedSafeFields === undefined ? {} : { expectedSafeFields: input.expectedSafeFields })
  };
}

test("company_id is lossless and exact; it never trims or case-folds", () => {
  assert.equal(canonicalCompanyId("company-a"), "company-a");
  assert.throws(() => canonicalCompanyId(" company-a"), (error) => error instanceof CompanyRegistryReconciliationError && error.code === "company_id_invalid");
  assert.notEqual(canonicalCompanyId("COMPANY-A"), canonicalCompanyId("company-a"));
  assert.throws(() => canonicalCompanyId(42), (error) => error instanceof CompanyRegistryReconciliationError && error.code === "company_id_invalid");
});

test("classifies every record once and separates match_class from change_class", () => {
  const report = reconcileCompanyRegistry({
    fingerprintKey: key,
    knownCompanies: [{ companyId: "company-a" }, { companyId: "company-b" }],
    records: [
      record({ recordId: "matched", companyId: "company-a", expectedSafeFields: { automation_id: "automation-one", status: "active" } }),
      record({ recordId: "changed", companyId: "company-b", expectedSafeFields: { automation_id: "automation-one", status: "paused" } }),
      record({ recordId: "missing", companyId: "" }),
      record({ recordId: "orphan", companyId: "company-unknown" }),
      record({ recordId: "duplicate-a", companyId: "company-a", identityKey: "automation:duplicate" }),
      record({ recordId: "duplicate-b", companyId: "company-a", identityKey: "automation:duplicate" })
    ]
  });
  assert.equal(report.summary.total, 6);
  assert.deepEqual(report.summary.by_match_class, { matched: 2, missing_company: 1, duplicate: 2, conflict: 0, orphan: 1 });
  assert.deepEqual(report.summary.by_change_class, { unchanged: 1, changed: 1, not_applicable: 4 });
  assert.equal(new Set(report.records.map((item) => item.record_id)).size, report.records.length);
  assert.ok(report.records.every((item) => item.proposed_action === "none"));
  assert.ok(report.records.filter((item) => item.match_class === "duplicate").every((item) => item.actionability === "human_decision_required"));
});

test("duplicate and conflict never select a canonical record or auto-resolve", () => {
  const report = reconcileCompanyRegistry({
    fingerprintKey: key,
    knownCompanies: [{ companyId: "company-a" }],
    records: [
      record({ recordId: "same-1", identityKey: "automation:same", safeFields: { automation_id: "a", status: "active" } }),
      record({ recordId: "same-2", identityKey: "automation:same", safeFields: { automation_id: "a", status: "active" } }),
      record({ recordId: "conflict-1", identityKey: "automation:conflict", safeFields: { automation_id: "a", status: "active" } }),
      record({ recordId: "conflict-2", identityKey: "automation:conflict", safeFields: { automation_id: "a", status: "paused" } })
    ]
  });
  assert.deepEqual(report.records.map((item) => item.match_class), ["conflict", "conflict", "duplicate", "duplicate"]);
  assert.ok(report.records.every((item) => item.actionability === "human_decision_required"));
  assert.ok(report.records.every((item) => item.proposed_action === "none"));
});

test("cross-company records stay separate even when safe fields match", () => {
  const report = reconcileCompanyRegistry({
    fingerprintKey: key,
    knownCompanies: [{ companyId: "company-a" }, { companyId: "company-b" }],
    records: [
      record({ recordId: "company-a-record", companyId: "company-a", safeFields: { provider: "same", account_ref: "same", status: "active" } }),
      record({ recordId: "company-b-record", companyId: "company-b", safeFields: { provider: "same", account_ref: "same", status: "active" } })
    ]
  });
  assert.deepEqual(report.records.map((item) => item.company_id), ["company-a", "company-b"]);
  assert.ok(report.records.every((item) => item.match_class === "matched"));
});

test("scope mismatch and invalid company IDs fail closed without fallback matching", () => {
  const report = reconcileCompanyRegistry({
    fingerprintKey: key,
    knownCompanies: [{ companyId: "company-a" }, { companyId: "company-b" }],
    scopeCompanyIds: ["company-a"],
    records: [
      record({ recordId: "scope-mismatch", companyId: "company-b" }),
      record({ recordId: "blank", companyId: "" }),
      record({ recordId: "whitespace", companyId: " company-a" })
    ]
  });
  assert.equal(report.records.find((item) => item.record_id === "scope-mismatch")?.reason_codes[0], "scope_mismatch");
  assert.equal(report.records.find((item) => item.record_id === "scope-mismatch")?.actionability, "human_decision_required");
  assert.equal(report.records.find((item) => item.record_id === "blank")?.match_class, "missing_company");
  assert.equal(report.records.find((item) => item.record_id === "whitespace")?.match_class, "missing_company");
});

test("result is deterministic regardless of input order and never exposes secret sentinels", () => {
  const first = [
    record({ recordId: "b", safeFields: { account_ref: "account-b", status: "active" } }),
    record({ recordId: "a", safeFields: { account_ref: "secret-token-sentinel", status: "active" } })
  ];
  const reportA = reconcileCompanyRegistry({ fingerprintKey: key, knownCompanies: [{ companyId: "company-a" }], records: first });
  const reportB = reconcileCompanyRegistry({ fingerprintKey: key, knownCompanies: [{ companyId: "company-a" }], records: [...first].reverse() });
  assert.deepEqual(reportA, reportB);
  assert.doesNotMatch(JSON.stringify(reportA), /secret-token-sentinel/u);
});

test("secret-like fields and unsupported fields are rejected without echoing values", () => {
  assert.throws(
    () => reconcileCompanyRegistry({ fingerprintKey: key, knownCompanies: [{ companyId: "company-a" }], records: [record({ safeFields: { access_token: "secret-token-sentinel" } })] }),
    (error) => error instanceof CompanyRegistryReconciliationError && error.code === "secret_field_forbidden" && !error.message.includes("secret-token-sentinel")
  );
  assert.throws(
    () => reconcileCompanyRegistry({ fingerprintKey: key, knownCompanies: [{ companyId: "company-a" }], records: [record({ safeFields: { display_name: "not-allowlisted" } })] }),
    (error) => error instanceof CompanyRegistryReconciliationError && error.code === "safe_field_not_allowed"
  );
});

test("reconciliation is pure and reports no mutation capability", () => {
  const input = {
    fingerprintKey: key,
    knownCompanies: [{ companyId: "company-a" }],
    records: [record()]
  } as const;
  const before = structuredClone(input);
  const report = reconcileCompanyRegistry(input);
  assert.deepEqual(input, before);
  assert.deepEqual(report.mutation, { attempted: false, allowed: false });
  assert.deepEqual(report.fingerprint, { algorithm: "HMAC-SHA256", key_scope: "run_scoped_not_returned" });
});
