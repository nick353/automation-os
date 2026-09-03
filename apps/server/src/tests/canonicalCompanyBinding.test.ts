import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCanonicalCompanyBinding } from "../runs/canonicalCompanyBinding.js";

const freshBinding = {
  authorityCompanyId: "company_a",
  authorityFresh: true,
  sourceCompanyId: "company_a",
  sourceFresh: true,
  workerCompanyId: "company_a",
  workerFresh: true,
  runtimeCompanyId: "company_a",
  runtimeFresh: true
} as const;

test("source A with worker/runtime B is a scope mismatch and never permits effects", () => {
  const result = evaluateCanonicalCompanyBinding({
    ...freshBinding,
    workerCompanyId: "company_b",
    runtimeCompanyId: "company_b"
  });

  assert.equal(result.status, "mismatch");
  assert.equal(result.canonicalScope, null);
  assert.equal(result.bindingMatch, false);
  assert.equal(result.exactBlocker, "portable_worker_company_scope_mismatch");
  assert.equal(result.externalActionAllowed, false);
  assert.equal(result.effectfulAdmissionAllowed, false);
  assert.equal(result.canaryAdmissionAllowed, false);
});

test("all required fresh bindings match the authority without granting canary admission", () => {
  const result = evaluateCanonicalCompanyBinding(freshBinding);

  assert.equal(result.status, "matched");
  assert.equal(result.canonicalScope, "company_a");
  assert.equal(result.bindingMatch, true);
  assert.equal(result.exactBlocker, null);
  assert.equal(result.externalActionAllowed, false);
  assert.equal(result.effectfulAdmissionAllowed, false);
  assert.equal(result.canaryAdmissionAllowed, false);
});

test("missing or stale observations keep the canonical scope unknown", () => {
  const missing = evaluateCanonicalCompanyBinding({
    ...freshBinding,
    runtimeCompanyId: null
  });
  const stale = evaluateCanonicalCompanyBinding({
    ...freshBinding,
    workerFresh: false
  });

  for (const result of [missing, stale]) {
    assert.equal(result.status, "unknown");
    assert.equal(result.canonicalScope, null);
    assert.equal(result.bindingMatch, false);
    assert.equal(result.exactBlocker, "canonical_company_scope_unknown");
    assert.equal(result.externalActionAllowed, false);
  }
});

test("matching observations without fresh authority do not infer a canonical company by majority", () => {
  const result = evaluateCanonicalCompanyBinding({
    sourceCompanyId: "company_a",
    sourceFresh: true,
    workerCompanyId: "company_a",
    workerFresh: true,
    runtimeCompanyId: "company_a",
    runtimeFresh: true
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.canonicalScope, null);
  assert.equal(result.exactBlocker, "canonical_company_scope_unknown");
  assert.equal(result.externalActionAllowed, false);
});

test("the pure guard does not mutate observations and keeps effect permission false", () => {
  const input = { ...freshBinding, externalActionExecuted: true };
  const before = { ...input };
  const result = evaluateCanonicalCompanyBinding(input);

  assert.deepEqual(input, before);
  assert.equal(result.externalActionExecuted, true);
  assert.equal(result.externalActionAllowed, false);
  assert.equal(result.effectfulAdmissionAllowed, false);
  assert.equal(result.canaryAdmissionAllowed, false);
});
