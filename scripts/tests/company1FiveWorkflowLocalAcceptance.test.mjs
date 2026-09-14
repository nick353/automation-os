import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const companyId = "company_2560580981cedfd106b66245";
const artifactPath = resolve("work/aos-company1-five-workflow-local-acceptance-20260908.json");
const fixturePath = resolve("scripts/aos-ui-browser-fixture.mjs");
const appPath = resolve("apps/web/src/App.tsx");
const controlManifestPath = resolve("apps/web/src/controlManifest.ts");
const acceptance = JSON.parse(readFileSync(artifactPath, "utf8"));
const fixtureSource = readFileSync(fixturePath, "utf8");

function loadCommonJs(bundle, requirePath) {
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(requirePath), module, module.exports
  );
  return module.exports;
}

const appSource = readFileSync(appPath, "utf8");
const appBundle = await build({
  stdin: {
    contents: `${appSource}\nexport { ChatPage, BuilderPage, ApprovalsPage, RunsPage, TruthfulRecoveryPage };`,
    loader: "tsx",
    resolveDir: dirname(appPath),
    sourcefile: appPath,
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  packages: "external",
  plugins: [{
    name: "omit-test-css",
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "text" }));
    },
  }],
  logLevel: "silent",
});
const components = loadCommonJs(appBundle, appPath);

const controlManifestBundle = await build({
  entryPoints: [controlManifestPath],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});
const { controlManifest } = loadCommonJs(controlManifestBundle, controlManifestPath);

const workflowRows = acceptance.workflows;
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function withBrowserFixture(hash, callback) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const storage = makeStorage();
  const location = { hash, href: `http://fixture.invalid/${hash}` };
  const window = {
    location,
    sessionStorage: storage,
    localStorage: storage,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
    open() { return null; },
  };
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", { value: location, configurable: true, writable: true });
  try {
    return callback();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
  }
}

function fixtureAutomation(row) {
  return {
    id: row.automation_id,
    company_id: companyId,
    project_id: companyId,
    automation_type: "registered_workflow",
    name: row.label,
    goal: row.builder_input,
    lane: "local",
    approval_policy: "required_before_external_action",
    worker_command_kind: row.worker_command_kind,
    revision: 1,
    current_version_id: `${row.automation_id}_v1`,
    status: "active",
    execution_mode: "read_only",
    execution_label: "simulation only / provider call=0",
    scheduler_effect: "not_configured",
  };
}

function fixtureModel(row, overrides = {}) {
  const automation = fixtureAutomation(row);
  return {
    mvpLoadStatus: "ready",
    mvpLoadBlocker: null,
    automationRows: [],
    createdTemplates: [],
    feedbackReadback: [],
    feedbackReadStatus: "ready",
    setReceipt() {},
    setAutomationRows() {},
    setCreatedTemplates() {},
    setFeedbackReadback() {},
    setMvpState() {},
    mvpState: {
      companies: [{ id: companyId, name: "Company 1 local fixture", role: overrides.role ?? "owner" }],
      automations: [automation],
      builder_specs: [{
        automation_id: row.automation_id,
        spec: {
          schema: "aos.registered_automation_adoption.v1",
          canonicalWorkflowId: row.canonical_workflow_id,
          target_label: `${row.label} fixture target`,
          schedule_hint: "毎日 09:00",
          retry_rule: "same-run readback before retry",
          stages: [{ id: "fixture-readback", title: `${row.canonical_workflow_id} readback`, enabled: true }],
        },
      }],
      schedules: [{
        id: `${row.automation_id}_schedule`,
        company_id: companyId,
        automation_id: row.automation_id,
        kind: "daily",
        expression: "09:00",
        timezone: row.timezone,
        enabled: false,
        revision: 1,
        next_run_at: null,
      }],
      runs: overrides.runs ?? [],
      jobs: overrides.jobs ?? [],
      approvals: overrides.approvals ?? [],
      proofs: [],
      job_attempts: [],
      web_operation_backend: { backend: "aos_chrome_companion" },
      browser_use_runtime: { backend: "aos_chrome_companion", surface: "aos_chrome_companion_profile_instance", status: "ready", lanes: [] },
      codexCapabilities: { appServer: { status: "verified", verified: true, connected: false } },
      presentation_profiles: [],
    },
  };
}

function renderComponent(name, row, model, hash) {
  return withBrowserFixture(hash, () => renderToStaticMarkup(React.createElement(components[name], { model })));
}

class LocalAcceptanceStore {
  constructor(row) {
    this.row = row;
    this.records = new Map();
    this.schedules = new Map();
    this.scheduleReceipts = new Map();
    this.occurrences = new Map();
    this.approvals = new Map();
    this.recoveryAttempts = new Map();
    this.providerCalls = 0;
  }

  persistInput(source, inputText) {
    const key = `${companyId}:${this.row.canonical_workflow_id}`;
    const inputHash = sha256(inputText);
    let record = this.records.get(key);
    const replayed = Boolean(record);
    if (!record) {
      record = {
        schema: "aos.simulation.persisted_workflow_readback.v1",
        simulation: true,
        company_id: companyId,
        workflow_id: this.row.canonical_workflow_id,
        automation_id: this.row.automation_id,
        revision: 1,
        input_sources: [],
        input_hashes: {},
        external_action_executed: false,
        production_completion_claimed: false,
        receipt_kind: "simulation",
      };
      this.records.set(key, record);
    }
    if (!record.input_sources.includes(source)) record.input_sources.push(source);
    record.input_hashes[source] = inputHash;
    return { ...record, replayed };
  }

  readPersisted() {
    return this.records.get(`${companyId}:${this.row.canonical_workflow_id}`) ?? null;
  }

  requestApproval() {
    const approval = {
      schema: "aos.simulation.approval.v1",
      id: `approval_${this.row.canonical_workflow_id}`,
      company_id: companyId,
      workflow_id: this.row.canonical_workflow_id,
      automation_id: this.row.automation_id,
      action_kind: "business_execute",
      status: "pending",
      payload_hash: sha256(`${this.row.canonical_workflow_id}:simulation-payload`),
      external_action_executed: false,
      receipt_kind: "simulation",
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  attemptEffect(approval, expectedWorkflowId = this.row.canonical_workflow_id) {
    if (!approval || approval.status !== "approved") {
      return { status: "blocked", exact_blocker: "approval_required", external_action_executed: false, provider_calls: 0 };
    }
    if (approval.company_id !== companyId || approval.workflow_id !== expectedWorkflowId) {
      return { status: "blocked", exact_blocker: "approval_binding_mismatch", external_action_executed: false, provider_calls: 0 };
    }
    // This phase never has a provider executor. Even a simulated approval is
    // represented as a no-effect receipt, so the test cannot claim production.
    return { status: "simulation", exact_blocker: "simulation_no_provider_executor", external_action_executed: false, provider_calls: 0 };
  }

  saveSchedule({ enabled, expectedRevision, idempotencyKey }) {
    const timezone = this.row.timezone;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); }
    catch { throw new Error("schedule_timezone_invalid"); }
    if (this.scheduleReceipts.has(idempotencyKey)) return { ...this.scheduleReceipts.get(idempotencyKey), replayed: true };
    const current = this.schedules.get(this.row.automation_id) ?? { revision: 0, enabled: false, timezone, expression: "09:00" };
    if (Number(expectedRevision) !== current.revision) throw new Error("schedule_revision_mismatch");
    const next = {
      schema: "aos.simulation.schedule_readback.v1",
      company_id: companyId,
      automation_id: this.row.automation_id,
      timezone,
      expression: current.expression,
      enabled: Boolean(enabled),
      revision: current.revision + 1,
      next_run_at: enabled ? "2026-09-09T00:00:00.000Z" : null,
      external_action_executed: false,
      receipt_kind: "simulation",
      replayed: false,
    };
    this.schedules.set(this.row.automation_id, next);
    this.scheduleReceipts.set(idempotencyKey, next);
    return { ...next };
  }

  dispatchOccurrence(scheduledFor) {
    const schedule = this.schedules.get(this.row.automation_id);
    if (!schedule?.enabled) return { status: "blocked", exact_blocker: "schedule_paused", duplicate: false };
    const key = `${this.row.automation_id}:${scheduledFor}`;
    if (this.occurrences.has(key)) return { status: "replayed", exact_blocker: null, duplicate: true, occurrence_id: this.occurrences.get(key) };
    const occurrenceId = `occurrence_${this.row.canonical_workflow_id}`;
    this.occurrences.set(key, occurrenceId);
    return { status: "queued_simulation", exact_blocker: null, duplicate: false, occurrence_id: occurrenceId };
  }

  recover(externalActionExecuted) {
    const key = this.row.canonical_workflow_id;
    if (externalActionExecuted === null) {
      return { status: "blocked", exact_blocker: "effect_unconfirmed", operation_effect_state: "unknown", no_replay: true, external_action_executed: null, retry_count: this.recoveryAttempts.get(key) ?? 0 };
    }
    if (externalActionExecuted !== false) throw new Error("simulation_receipt_effect_value_invalid");
    const retryCount = this.recoveryAttempts.get(key) ?? 0;
    if (retryCount > 0) return { status: "replayed_readback", exact_blocker: null, no_replay: true, external_action_executed: false, retry_count: retryCount };
    this.recoveryAttempts.set(key, 1);
    return { status: "known_no_effect", exact_blocker: null, no_replay: true, external_action_executed: false, retry_count: 1 };
  }
}

function guideNextAction(row, state) {
  const expected = row.guide_next_actions[state];
  assert.ok(expected, `missing guide mapping for ${row.canonical_workflow_id}:${state}`);
  return {
    workflow_id: row.canonical_workflow_id,
    state,
    route: expected.route,
    action: expected.action,
    simulation: true,
    production_completion_claimed: false,
  };
}

test("five-workflow local acceptance uses the existing isolated fixture and common App contract", () => {
  assert.equal(acceptance.schema, "aos_company1_five_workflow_local_acceptance.v1");
  assert.equal(acceptance.scope.company_id, companyId);
  assert.equal(acceptance.scope.simulation, true);
  assert.equal(acceptance.scope.production_completion_claimed, false);
  assert.equal(acceptance.scope.sso_touched, false);
  assert.equal(acceptance.scope.provider_calls, 0);
  assert.equal(acceptance.scope.external_action_executed, false);
  assert.match(fixtureSource, /connect-src 'none'/u);
  assert.match(fixtureSource, /production_connection: false/u);
  assert.match(fixtureSource, /ISOLATED/u);
  assert.match(fixtureSource, /fixture_request_blocked/u);

  const requiredControls = [
    "chat.prompt", "chat.send", "chat.workflow-readback",
    "builder.save", "builder.schedule.timezone", "builder.schedule.save",
    "approvals.read-only", "truthful.recovery.portable.refresh", "truthful.recovery.portable.retry",
  ];
  const controls = new Map(controlManifest.map((entry) => [entry.id, entry]));
  for (const controlId of requiredControls) {
    const entry = controls.get(controlId);
    assert.ok(entry, `missing common App control contract: ${controlId}`);
    assert.match(entry.source, /App\.tsx|^(?:GET|POST|PATCH|PUT) /u);
    assert.ok(String(entry.readback).length > 0);
  }

  for (const row of workflowRows) {
    const builderHtml = renderComponent("BuilderPage", row, fixtureModel(row), `#/projects/${companyId}/automations/${row.automation_id}/edit`);
    assert.match(builderHtml, /data-control-id="builder\.name"/u);
    assert.match(builderHtml, /data-control-id="builder\.save"/u);
    assert.match(builderHtml, /data-control-id="builder\.schedule\.timezone"/u);
    assert.match(builderHtml, /data-control-id="builder\.schedule\.save"/u);
    assert.match(builderHtml, new RegExp(row.canonical_workflow_id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const chatHtml = renderComponent("ChatPage", row, fixtureModel(row), `#/chat?company_id=${companyId}`);
    assert.match(chatHtml, /data-control-id="chat\.prompt"/u);
    assert.match(chatHtml, /data-control-id="chat\.send"/u);

    const approvalHtml = renderComponent("ApprovalsPage", row, fixtureModel(row, {
      role: "viewer",
      approvals: [{ id: "fixture-approval", company_id: companyId, status: "pending", title: `${row.label} approval`, external_action_allowed: false }],
    }), "#/approvals");
    assert.match(approvalHtml, /data-control-id="approvals\.read-only"/u);
    assert.doesNotMatch(approvalHtml, /data-control-id="approvals\.(?:approve|reject|edit-button)"/u);

    const recoveryHtml = renderComponent("TruthfulRecoveryPage", row, fixtureModel(row, {
      role: "viewer",
      jobs: [{ id: `fixture-job-${row.canonical_workflow_id}`, company_id: companyId, status: "timed_out", attempt_count: 1 }],
    }), `#/projects/${companyId}/recovery`);
    assert.match(recoveryHtml, /data-control-id="truthful\.recovery\.read-only\./u);
    assert.doesNotMatch(recoveryHtml, /data-control-id="truthful\.recovery\.(?:retry|cancel)\./u);
  }
});

test("five workflow local acceptance matrix passes with zero provider calls", async (t) => {
  assert.equal(workflowRows.length, 5);
  for (const row of workflowRows) {
    await t.test(`${row.requested_workflow_id} local simulation`, () => {
      const store = new LocalAcceptanceStore(row);

      const builderReceipt = store.persistInput("builder", row.builder_input);
      const chatReceipt = store.persistInput("chat", row.chat_input);
      const persisted = store.readPersisted();
      assert.equal(builderReceipt.automation_id, row.automation_id);
      assert.equal(chatReceipt.automation_id, row.automation_id);
      assert.equal(chatReceipt.replayed, true);
      assert.deepEqual(persisted.input_sources.sort(), ["builder", "chat"]);
      assert.equal(persisted.company_id, companyId);
      assert.equal(persisted.workflow_id, row.canonical_workflow_id);
      assert.equal(persisted.revision, 1);
      assert.equal(persisted.external_action_executed, false);
      assert.equal(persisted.production_completion_claimed, false);

      const approval = store.requestApproval();
      const missingApproval = store.attemptEffect(null);
      assert.equal(missingApproval.status, "blocked");
      assert.equal(missingApproval.exact_blocker, "approval_required");
      assert.equal(missingApproval.external_action_executed, false);
      const mismatchedApproval = store.attemptEffect({ ...approval, status: "approved", workflow_id: "foreign-workflow" });
      assert.equal(mismatchedApproval.status, "blocked");
      assert.equal(mismatchedApproval.exact_blocker, "approval_binding_mismatch");
      assert.equal(mismatchedApproval.external_action_executed, false);

      const initialSchedule = store.saveSchedule({ enabled: false, expectedRevision: 0, idempotencyKey: `schedule-init:${row.canonical_workflow_id}` });
      assert.equal(initialSchedule.timezone, row.timezone);
      assert.equal(initialSchedule.enabled, false);
      const resumed = store.saveSchedule({ enabled: true, expectedRevision: initialSchedule.revision, idempotencyKey: `schedule-resume:${row.canonical_workflow_id}` });
      const firstOccurrence = store.dispatchOccurrence("2026-09-09T00:00:00.000Z");
      assert.equal(resumed.enabled, true);
      assert.equal(firstOccurrence.duplicate, false);
      const stopped = store.saveSchedule({ enabled: false, expectedRevision: resumed.revision, idempotencyKey: `schedule-stop:${row.canonical_workflow_id}` });
      const stoppedReplay = store.saveSchedule({ enabled: false, expectedRevision: resumed.revision, idempotencyKey: `schedule-stop:${row.canonical_workflow_id}` });
      assert.equal(stopped.enabled, false);
      assert.equal(stoppedReplay.replayed, true);
      const resumedAgain = store.saveSchedule({ enabled: true, expectedRevision: stopped.revision, idempotencyKey: `schedule-resume-again:${row.canonical_workflow_id}` });
      const occurrenceReplay = store.dispatchOccurrence("2026-09-09T00:00:00.000Z");
      assert.equal(resumedAgain.enabled, true);
      assert.equal(occurrenceReplay.duplicate, true);
      assert.equal(store.occurrences.size, 1);

      const knownNoEffect = store.recover(false);
      const knownReplay = store.recover(false);
      const unknownEffect = store.recover(null);
      assert.equal(knownNoEffect.status, "known_no_effect");
      assert.equal(knownNoEffect.external_action_executed, false);
      assert.equal(knownNoEffect.no_replay, true);
      assert.equal(knownReplay.status, "replayed_readback");
      assert.equal(knownReplay.retry_count, 1);
      assert.equal(unknownEffect.status, "blocked");
      assert.equal(unknownEffect.exact_blocker, "effect_unconfirmed");
      assert.equal(unknownEffect.operation_effect_state, "unknown");
      assert.equal(unknownEffect.external_action_executed, null);
      assert.equal(unknownEffect.no_replay, true);
      assert.equal(unknownEffect.retry_count, 1);

      for (const state of ["persisted_readback", "approval_required", "schedule_paused", "effect_unknown"]) {
        const guide = guideNextAction(row, state);
        assert.equal(guide.workflow_id, row.canonical_workflow_id);
        assert.equal(guide.route, row.guide_next_actions[state].route);
        assert.equal(guide.action, row.guide_next_actions[state].action);
        assert.equal(guide.simulation, true);
        assert.equal(guide.production_completion_claimed, false);
      }
      assert.equal(store.providerCalls, 0);
    });
  }
});
