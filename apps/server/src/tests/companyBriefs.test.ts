import assert from "node:assert/strict";
import test from "node:test";

const { CompanyBriefError, generateCompanyBriefs } = await import("../briefs/companyBriefs.js");

const base = {
  briefType: "morning" as const,
  businessDate: "2026-09-02",
  timezone: "Asia/Tokyo",
  templateVersion: "v1",
  companies: [
    { companyId: "company-b", displayName: "Company B" },
    { companyId: "company-a", displayName: "Company A" }
  ],
  records: [
    {
      recordId: "record-b",
      companyId: "company-b",
      matchClass: "matched",
      title: "B task",
      summary: "B summary",
      nextAction: "B next"
    },
    {
      recordId: "record-a",
      companyId: "company-a",
      matchClass: "matched",
      title: "A task",
      summary: "A summary"
    }
  ]
};

test("generates explicit morning and evening bundles with stable company isolation", () => {
  const morning = generateCompanyBriefs(base);
  const evening = generateCompanyBriefs({ ...base, briefType: "evening" });
  assert.equal(morning.schema, "aos.local_brief_bundle.v1");
  assert.equal(morning.brief_type, "morning");
  assert.equal(evening.brief_type, "evening");
  assert.deepEqual(morning.companies.map((company) => company.company_id), ["company-a", "company-b"]);
  assert.deepEqual(morning.companies[0]?.items.map((item) => item.record_id), ["record-a"]);
  assert.deepEqual(morning.companies[1]?.items.map((item) => item.record_id), ["record-b"]);
  assert.notEqual(morning.output_fingerprint, evening.output_fingerprint);
  assert.deepEqual(morning.delivery, { attempted: false, status: "not_attempted" });
  assert.deepEqual(morning.mutation, { attempted: false, allowed: false });
});

test("excludes missing-company, duplicate, conflict, and orphan records without an unknown bucket", () => {
  const bundle = generateCompanyBriefs({
    ...base,
    records: [
      ...base.records,
      { recordId: "missing", companyId: null, matchClass: "missing_company", title: "ignored", summary: "ignored" },
      { recordId: "duplicate", companyId: "company-a", matchClass: "duplicate", title: "ignored", summary: "ignored" },
      { recordId: "conflict", companyId: "company-a", matchClass: "conflict", title: "ignored", summary: "ignored" },
      { recordId: "orphan", companyId: "company-x", matchClass: "orphan", title: "ignored", summary: "ignored" }
    ]
  });
  assert.equal(bundle.status, "partial");
  assert.equal(bundle.counts.included_records, 2);
  assert.equal(bundle.counts.excluded_records, 4);
  assert.deepEqual(bundle.exclusions, [
    { record_id: "conflict", reason: "registry_conflict" },
    { record_id: "duplicate", reason: "registry_duplicate" },
    { record_id: "missing", reason: "registry_missing_company" },
    { record_id: "orphan", reason: "registry_orphan" }
  ]);
  assert.ok(bundle.exclusions.every((item) => item.reason !== "registry_unknown"));
});

test("is deterministic regardless of company and record input order", () => {
  const first = generateCompanyBriefs(base);
  const second = generateCompanyBriefs({
    ...base,
    companies: [...base.companies].reverse(),
    records: [...base.records].reverse()
  });
  assert.deepEqual(first, second);
});

test("does not infer invalid company identity or duplicate canonical IDs", () => {
  assert.throws(
    () => generateCompanyBriefs({ ...base, records: [{ ...base.records[0], companyId: " company-a" }] }),
    (error) => error instanceof CompanyBriefError && error.code === "matched_company_id_invalid"
  );
  assert.throws(
    () => generateCompanyBriefs({ ...base, companies: [...base.companies, { companyId: "company-a", displayName: "Other" }] }),
    (error) => error instanceof CompanyBriefError && error.code === "company_id_duplicate"
  );
  assert.throws(
    () => generateCompanyBriefs({ ...base, records: [...base.records, base.records[0]] }),
    (error) => error instanceof CompanyBriefError && error.code === "record_id_duplicate"
  );
});

test("validates date/timezone and rejects sensitive text without echoing it", () => {
  assert.throws(
    () => generateCompanyBriefs({ ...base, businessDate: "2026-02-30" }),
    (error) => error instanceof CompanyBriefError && error.code === "business_date_invalid"
  );
  assert.throws(
    () => generateCompanyBriefs({ ...base, timezone: "Not/AZone" }),
    (error) => error instanceof CompanyBriefError && error.code === "timezone_invalid"
  );
  assert.throws(
    () => generateCompanyBriefs({ ...base, records: [{ ...base.records[0], summary: "Bearer abcdefghijklmnop" }] }),
    (error) => error instanceof CompanyBriefError && error.code === "brief_sensitive_text_forbidden" && !error.message.includes("abcdefghijklmnop")
  );
});

test("empty companies are explicit and no adapter-like dependency is required", () => {
  const bundle = generateCompanyBriefs({ ...base, records: [] });
  assert.equal(bundle.status, "complete");
  assert.deepEqual(bundle.companies.map((company) => company.status), ["empty", "empty"]);
  assert.equal(bundle.counts.generated_companies, 0);
  assert.equal(bundle.counts.empty_companies, 2);
});
