import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { evaluateCanonicalCompanyBinding } from "../runs/canonicalCompanyBinding.js";

const root = process.cwd();
const source = (relativePath: string): string => readFileSync(resolve(root, relativePath), "utf8");

type BindingFixture = {
  authorityCompanyId: string;
  authorityFresh: boolean;
  sourceCompanyId: string;
  sourceFresh: boolean;
  workerCompanyId: string;
  workerFresh: boolean;
  runtimeCompanyId: string;
  runtimeFresh: boolean;
};

const freshBinding: BindingFixture = {
  authorityCompanyId: "company_a",
  authorityFresh: true,
  sourceCompanyId: "company_a",
  sourceFresh: true,
  workerCompanyId: "company_a",
  workerFresh: true,
  runtimeCompanyId: "company_a",
  runtimeFresh: true
};

function fakeAdapterDispatch(input: BindingFixture): { adapterCalls: number; status: string; blocker: string | null } {
  const binding = evaluateCanonicalCompanyBinding(input);
  if (!binding.bindingMatch) {
    return { adapterCalls: 0, status: "blocked", blocker: binding.exactBlocker };
  }
  // This is a test-only adapter. The production guard deliberately does not
  // grant effect permission; this models the separate pre-effect seam only.
  return { adapterCalls: 1, status: "fake_adapter_called", blocker: null };
}

test("synthetic mismatch stops before the fake effect adapter", () => {
  const result = fakeAdapterDispatch({
    ...freshBinding,
    workerCompanyId: "company_b",
    runtimeCompanyId: "company_b"
  });

  assert.deepEqual(result, {
    adapterCalls: 0,
    status: "blocked",
    blocker: "portable_worker_company_scope_mismatch"
  });
});

test("synthetic match reaches the fake adapter exactly once without changing production permission", () => {
  const binding = evaluateCanonicalCompanyBinding(freshBinding);
  const result = fakeAdapterDispatch(freshBinding);

  assert.equal(binding.effectfulAdmissionAllowed, false);
  assert.deepEqual(result, { adapterCalls: 1, status: "fake_adapter_called", blocker: null });
});

test("portable HTTP and worker entrypoints are mapped to the observed external seam", () => {
  const indexSource = source("apps/server/src/index.ts");
  const entrypointSource = source("apps/server/src/runs/portableWorkflowEntrypoint.ts");
  const engineSource = source("apps/server/src/runs/workerEngine.ts");
  const externalWorkerSource = source("apps/server/src/runs/portableExternalWorker.ts");

  assert.match(indexSource, /app\.post\("\/api\/v1\/companies\/:companyId\/automations\/:automationId\/trigger"[\s\S]*?startPortableWorkflowRun\(/u);
  assert.match(indexSource, /app\.post\("\/api\/portable-workflows\/:id\/run"[\s\S]*?startPortableWorkflowRun\(/u);
  assert.match(entrypointSource, /const result = await startCommandRun\(/u);
  assert.equal((engineSource.match(/runPortableExternalWorker\(/gu) ?? []).length, 1);
  assert.match(engineSource, /return completePortableExternalWorkerStep\(/u);
  assert.match(engineSource, /const result = await runPortableExternalWorker\(/u);
  assert.match(externalWorkerSource, /const child = spawn\(command, args,/u);
});

test("durable external queue has a distinct coordinator seam", () => {
  const queueSource = source("apps/server/src/runs/durableQueue.ts");

  assert.match(queueSource, /export function enqueueAutomationExternalEffect\(/u);
  assert.match(queueSource, /export async function processClaimedDurableExternalJobOnce\(/u);
  assert.match(queueSource, /result = await input\.coordinator\.execute\(/u);
  assert.match(queueSource, /before_provider_call:/u);
});
