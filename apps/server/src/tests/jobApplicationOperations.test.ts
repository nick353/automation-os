import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCandidateRecord,
  buildJobApplicationDigest,
  buildSheetMirrorPayload,
  buildCandidateRecord as recordCandidate,
  auditSheetMirrorPopulation,
  classifyCandidate,
  parseSheetMirrorReadbackInput,
  planSheetMirrorSync,
  sheetMirrorReadbackValues,
  parseCandidateSupplyInput,
  JobApplicationOperationsError
} from "../jobApplications/applicationOperations.js";

const future = "2030-01-01T00:00:00.000Z";
const base = {
  source_snapshot_id: "snapshot_jobs_1",
  source_snapshot_expires_at: future,
  supply_run_id: "run_supply_1",
  job_url: "https://jobs.example.test/marketing/1",
  company_name: "Example AI",
  role: "Marketing Manager",
  language: "en",
  salary_original_min: 5_000_000,
  salary_original_max: 7_000_000,
  salary_currency: "JPY",
  salary_period: "annual",
  salary_source_url: "https://jobs.example.test/marketing/1#salary",
  salary_source_time: "2026-08-19T00:00:00.000Z",
  work_location: "remote_from_japan",
  work_authorization: "japan_visa",
  remote_mode: "remote"
} as const;

test("candidate policy uses the lower salary bound and selects the language-specific resume", () => {
  const input = parseCandidateSupplyInput(base, "2026-08-19T00:00:00.000Z");
  const classification = classifyCandidate(input, [], new Date("2026-08-19T00:00:00.000Z"));
  assert.equal(classification.status, "eligible");
  assert.equal(classification.salaryJpy, 5_000_000);
  assert.equal(classification.resumeLocale, "en-US");
});

test("monthly salary is normalized to an annual JPY amount", () => {
  const input = parseCandidateSupplyInput({ ...base, salary_original_min: 450_000, salary_original_max: 600_000, salary_period: "monthly" }, "2026-08-19T00:00:00.000Z");
  const classification = classifyCandidate(input, [], new Date("2026-08-19T00:00:00.000Z"));
  assert.equal(classification.status, "eligible");
  assert.equal(classification.salaryJpy, 5_400_000);
});

test("hourly salary does not silently become an annual salary", () => {
  const input = parseCandidateSupplyInput({
    ...base,
    salary_original_min: 30,
    salary_original_max: 70,
    salary_currency: "USD",
    salary_period: "hourly",
    fx_to_jpy: 159.21,
    fx_source_url: "https://www.federalreserve.gov/releases/h10/current/",
  }, "2026-08-19T00:00:00.000Z");
  const classification = classifyCandidate(input, [], new Date("2026-08-19T00:00:00.000Z"));
  assert.equal(classification.status, "blocked");
  assert.equal(classification.salaryJpy, null);
  assert.deepEqual(classification.blockers, ["annual_salary_threshold_not_proven_from_hourly_contract_range"]);
});

test("unknown salary period is kept unverified", () => {
  const input = parseCandidateSupplyInput({ ...base, salary_period: "unknown" }, "2026-08-19T00:00:00.000Z");
  const classification = classifyCandidate(input, [], new Date("2026-08-19T00:00:00.000Z"));
  assert.equal(classification.status, "blocked");
  assert.equal(classification.salaryJpy, null);
  assert.deepEqual(classification.blockers, ["salary_period_unverified"]);
});

test("missing salary evidence and unconfirmed work authorization fail closed", () => {
  const input = parseCandidateSupplyInput({ ...base, salary_original_min: null, salary_source_url: null, salary_source_time: null, work_authorization: "unknown" }, "2026-08-19T00:00:00.000Z");
  const classification = classifyCandidate(input, [], new Date("2026-08-19T00:00:00.000Z"));
  assert.equal(classification.status, "blocked");
  assert.deepEqual(classification.blockers, ["salary_evidence_missing", "japan_work_authorization_unconfirmed"]);
});

test("the third same-company-role candidate in the 30-day window is excluded", () => {
  const input = parseCandidateSupplyInput(base, "2026-08-19T00:00:00.000Z");
  const existing = [0, 1].map((index) => {
    const current = buildCandidateRecord("company-a", { ...input, candidateKey: `candidate-${index}` }, classifyCandidate(input, [], new Date("2026-08-19T00:00:00.000Z")), "2026-08-18T00:00:00.000Z");
    return current;
  });
  const classification = classifyCandidate({ ...input, candidateKey: "candidate-3" }, existing, new Date("2026-08-19T00:00:00.000Z"));
  assert.equal(classification.status, "duplicate_excluded");
  assert.ok(classification.blockers.includes("duplicate_company_role_30_day_window"));
});

test("digest keeps candidate discovery, success, stop, and reconciliation counts separate", () => {
  const input = parseCandidateSupplyInput(base, "2026-08-19T00:00:00.000Z");
  const eligible = recordCandidate("company-a", input, classifyCandidate(input), "2026-08-19T00:00:00.000Z");
  const blocked = { ...eligible, candidateKey: "blocked", status: "blocked" as const, blocker: "salary_evidence_missing" };
  const digest = buildJobApplicationDigest({
    candidates: [eligible, blocked],
    admissions: [{ status: "reconciled" }, { status: "submitted" }, { status: "blocked" }],
    sheetMirrors: [{ syncStatus: "prepared", blocker: "sheets_connector_unverified" }],
    delayedQueueCount: 2,
    historicalSuccessCount: 37,
    dateKey: "2026-08-19"
  });
  assert.equal(digest.target, 20);
  assert.equal(digest.cumulative_target, 1_000);
  assert.equal(digest.cumulative_success, 37);
  assert.equal(digest.candidate_count, 2);
  assert.equal(digest.success_count, 1);
  assert.equal(digest.awaiting_reconciliation_count, 1);
  assert.equal(digest.stopped_count, 2);
  assert.equal(digest.salary_evidence_missing_count, 1);
  assert.equal(digest.salary_annual_threshold_unproven_count, 0);
  assert.equal(digest.external_action_executed, false);
});

test("candidate parser rejects unknown fields", () => {
  assert.throws(() => parseCandidateSupplyInput({ ...base, token: "secret" }, "2026-08-19T00:00:00.000Z"), (error: unknown) => error instanceof JobApplicationOperationsError && error.code === "candidate_supply_unknown_field");
});

test("sheet mirror sync requires a complete exact native readback", () => {
  const input = parseCandidateSupplyInput(base, "2026-08-19T00:00:00.000Z");
  const candidate = buildCandidateRecord("company-a", input, classifyCandidate(input), "2026-08-19T00:00:00.000Z");
  const readback = parseSheetMirrorReadbackInput({
    schema: "aos.job_application_sheet_mirror_sync.v1",
    spreadsheet_id: "sheet_123",
    sheet_id: "1255319564",
    sheet_name: "AOS候補",
    range: "A1:T2",
    readback_at: "2026-08-19T00:00:01.000Z",
    rows: [{ row_number: 2, values: sheetMirrorReadbackValues(candidate) }]
  }, "2026-08-19T00:00:02.000Z");
  const plan = planSheetMirrorSync("company-a", [candidate], readback, "2026-08-19T00:00:03.000Z");
  assert.equal(plan.rowsSynced, 1);
  assert.equal(plan.resourceSteps.length, 1);
  assert.throws(() => planSheetMirrorSync("company-a", [candidate], { ...readback, rows: [{ rowNumber: 2, values: [...sheetMirrorReadbackValues(candidate).slice(0, 19), "tampered"] }] }, "2026-08-19T00:00:03.000Z"), (error: unknown) => error instanceof JobApplicationOperationsError && error.code.startsWith("sheet_mirror_sync_readback_mismatch:"));
});

test("internal sheet mirror evidence retains target digest and owner scope without changing native columns", () => {
  const input = parseCandidateSupplyInput(base, "2026-08-19T00:00:00.000Z");
  const candidate = buildCandidateRecord("company-a", input, classifyCandidate(input), "2026-08-19T00:00:00.000Z");
  const row = buildSheetMirrorPayload("company-a", candidate, {
    date_jst: "2026-08-19",
    candidate_key: candidate.candidateKey,
    company: candidate.companyName,
    role: candidate.role,
    job_url: candidate.jobUrl,
    language: candidate.language,
    resume_ref: "profile2:en-US",
    salary_original: "5000000-7000000 JPY",
    salary_period: candidate.salaryPeriod,
    salary_jpy: candidate.salaryJpy,
    salary_source_time: candidate.salarySourceTime,
    status: candidate.status,
    run_id: null,
    receipt_ref: null,
    blocker: candidate.blocker,
    next_action: candidate.nextAction,
    updated_at: candidate.updatedAt
  });
  assert.equal(row.target_digest, candidate.targetDigest);
  assert.equal(row.owner_scope, "company-a");
  assert.equal(Object.keys(row).includes("target_digest"), true);
  assert.equal(Object.keys(row).includes("owner_scope"), true);
});

test("sheet population audit reports drift without deleting or rewriting rows", () => {
  const input = parseCandidateSupplyInput(base, "2026-08-19T00:00:00.000Z");
  const candidate = buildCandidateRecord("company-a", input, classifyCandidate(input), "2026-08-19T00:00:00.000Z");
  const secondCandidate = { ...candidate, candidateKey: "candidate-two" };
  const sheetOnly = Array.from({ length: 20 }, (_, index) => index === 0 ? "sheet-only" : null);
  const blank = Array.from({ length: 20 }, () => null);
  const audit = auditSheetMirrorPopulation("company-a", [candidate, secondCandidate], {
    schema: "aos.job_application_sheet_mirror_sync.v1",
    spreadsheetId: "sheet_123",
    sheetId: "1255319564",
    sheetName: "AOS候補",
    range: "A1:T5",
    readbackAt: "2026-08-19T00:00:01.000Z",
    rows: [
      { rowNumber: 2, values: sheetMirrorReadbackValues(candidate) },
      { rowNumber: 3, values: sheetMirrorReadbackValues(candidate) },
      { rowNumber: 4, values: sheetOnly },
      { rowNumber: 5, values: blank }
    ]
  });
  assert.equal(audit.source_count, 2);
  assert.equal(audit.sheet_row_count, 4);
  assert.equal(audit.sheet_data_row_count, 3);
  assert.equal(audit.blank_row_count, 1);
  assert.deepEqual(audit.source_only_candidate_keys, ["candidate-two"]);
  assert.deepEqual(audit.sheet_only_candidate_keys, ["sheet-only"]);
  assert.deepEqual(audit.duplicate_sheet_candidate_keys, [candidate.candidateKey]);
  assert.equal(audit.population_exact, false);
  assert.equal(audit.external_action_executed, false);
});
