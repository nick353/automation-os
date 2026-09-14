import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const appPath = resolve("apps/web/src/App.tsx");
const source = readFileSync(appPath, "utf8");
// Export existing components only in the in-memory test bundle. No production
// exports, database, browser session or network access are needed for SSR.
const bundle = await build({
  stdin: { contents: source + "\nexport { ProjectUnavailablePage, TruthfulRecoveryPage, ApprovalsPage, RunsPage, mvpFetch, connectionMutationReadbackConfirmed };", loader: "tsx", resolveDir: dirname(appPath), sourcefile: appPath },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
  plugins: [{ name: "omit-test-css", setup(b) { b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "text" })); } }],
  logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(appPath), module, module.exports);
const components = module.exports;
test("connection mutation requires fresh matching readback before reporting success", () => {
  const item = {id:"fixture-ref", revision:2};
  const confirmed = components.connectionMutationReadbackConfirmed;
  assert.equal(confirmed(undefined, item, "revoke"), false);
  assert.equal(confirmed([], item, "revoke"), false);
  assert.equal(confirmed([{...item, status:"revoked"}], item, "revoke"), false);
  assert.equal(confirmed([{...item, revision:3, status:"active"}], item, "revoke"), false);
  assert.equal(confirmed([{...item, revision:"bad", status:"revoked"}], item, "revoke"), false);
  assert.equal(confirmed([{id:"other", revision:3, status:"revoked"}], item, "revoke"), false);
  assert.equal(confirmed([{...item, revision:3, status:"revoked"}], item, "revoke"), true);
  assert.equal(confirmed([{...item, revision:3, status:"verified", oauthState:"connected"}], item, "reconnect"), false);
  assert.equal(confirmed([{...item, revision:3, status:"reconnect_required", oauthState:"connected"}], item, "reconnect"), false);
  assert.equal(confirmed([{...item, revision:3, status:"reconnect_required", oauthState:"reauthorization_required"}], item, "reconnect"), true);
  assert.equal(confirmed([{...item, revision:3, status:"reconnect_required", oauth_state:"reauthorization_required"}], item, "reconnect"), true);
});
const company = "company_fixture_readonly";
const model = (extra = {}) => ({ mvpState: { companies: [{ id: company, name: "Fixture company", role: "viewer" }], runs: [], jobs: [], approvals: [], ...extra }, setReceipt() {}, setMvpState() {} });
const render = (name, props) => renderToStaticMarkup(React.createElement(components[name], props));
function withWindowFixture(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; });
}

test("loading and failed company readbacks render distinct status without execution controls", () => {
  const loading = render("ProjectUnavailablePage", { loading: true, reason: "fixture loading" });
  assert.match(loading, /data-readback-phase="loading"/);
  assert.doesNotMatch(loading, /home.company-scope.back/);
  const failed = render("ProjectUnavailablePage", { reason: "fixture failure", blocker: "fixture_read_failed" });
  assert.match(failed, /data-readback-phase="error"/);
  assert.match(failed, /fixture_read_failed/);
  assert.match(failed, /home.company-scope.back/);
});

test("viewer recovery renders failed job as read-only without retry or cancel controls", () => {
  globalThis.location = { hash: `#/projects/${company}/recovery` };
  const fixture = model({ jobs: [{ id: "fixture-job", company_id: company, status: "timed_out", attempt_count: 1 }] });
  const html = render("TruthfulRecoveryPage", { model: fixture });
  assert.match(html, /truthful.recovery.read-only.fixture-job/);
  assert.match(html, /閲覧のみ/);
  assert.doesNotMatch(html, /data-control-id="truthful.recovery.(?:retry|cancel)\./);
  fixture.mvpState.companies[0].role = "owner";
  const owner = render("TruthfulRecoveryPage", { model: fixture });
  assert.match(owner, /data-control-id="truthful.recovery.retry.fixture-job"/);
  assert.match(owner, /data-control-id="truthful.recovery.cancel.fixture-job"/);
});

test("viewer approval renders the pending item without decision controls", () => {
  globalThis.location = { hash: "#/approvals" };
  const fixture = model({ approvals: [{ id: "fixture-approval", company_id: company, status: "pending", title: "Fixture pending approval", external_action_allowed: false }] });
  const html = render("ApprovalsPage", { model: fixture });
  assert.match(html, /approvals.read-only/);
  assert.doesNotMatch(html, /data-control-id="approvals.(?:approve|reject|edit-button)"/);
  fixture.mvpState.companies[0].role = "owner";
  const owner = render("ApprovalsPage", { model: fixture });
  assert.match(owner, /data-control-id="approvals.approve"/);
  assert.match(owner, /data-control-id="approvals.reject"/);
});

test("viewer run details hide durable job actions that are available to owner", () => {
  globalThis.location = { hash: "#/runs" };
  const fixture = model({
    runs: [{ id: "fixture-run", company_id: company, name: "Fixture run", status: "failed" }],
    jobs: [{ id: "fixture-job", run_id: "fixture-run", company_id: company, status: "timed_out" }],
  });
  const html = render("RunsPage", { model: fixture });
  assert.match(html, /runs.job.read-only.fixture-job/);
  assert.doesNotMatch(html, /data-control-id="runs.job.(?:retry|cancel)\./);
  fixture.mvpState.companies[0].role = "owner";
  const owner = render("RunsPage", { model: fixture });
  assert.match(owner, /data-control-id="runs.job.retry.fixture-job"/);
  assert.match(owner, /data-control-id="runs.job.cancel.fixture-job"/);
});

test("empty recovery and approvals show no invented job or pending approval", () => {
  globalThis.location = { hash: `#/projects/${company}/recovery` };
  const recovery = render("TruthfulRecoveryPage", { model: model() });
  assert.match(recovery, /復旧候補はありません/);
  assert.doesNotMatch(recovery, /data-control-id="truthful.recovery.(?:retry|cancel)\./);
  globalThis.location = { hash: "#/approvals" };
  const approvals = render("ApprovalsPage", { model: model() });
  assert.match(approvals, /承認待ちはありません/);
  assert.doesNotMatch(approvals, /data-control-id="approvals.(?:approve|reject)"/);
});

test("company-scoped Runs keeps empty results separate from another company's records", () => {
  globalThis.location = { hash: `#/runs?company_id=${company}` };
  const fixture = model({
    company_scope: { enforced: true, company_ids: [company] },
    runs: [{ id: "in-scope", company_id: company, name: "Scoped run", status: "failed" }, { id: "foreign", company_id: "other-company", name: "Foreign run", status: "failed" }]
  });
  const html = render("RunsPage", { model: fixture });
  assert.match(html, /in-scope/);
  assert.doesNotMatch(html, /foreign/);
  assert.doesNotMatch(html, /会社別Runs readbackを取得できません/);
});

test("company-scoped Runs shows unavailable instead of global records when scope readback is absent", () => {
  globalThis.location = { hash: `#/runs?company_id=${company}` };
  const html = render("RunsPage", { model: model({ runs: [{ id: "global-only", company_id: company, status: "failed" }] }) });
  assert.match(html, /data-readback-phase="loading"/);
  assert.match(html, /会社別Runs readbackを確認しています/);
  assert.doesNotMatch(html, /global-only/);
});

test("company-scoped Runs renders a confirmed empty result distinctly", () => {
  globalThis.location = { hash: `#/runs?company_id=${company}` };
  const html = render("RunsPage", { model: model({ company_scope: { enforced: true, company_ids: [company] }, runs: [] }) });
  assert.match(html, /履歴はまだありません/);
  assert.doesNotMatch(html, /会社別Runs readbackを確認しています/);
  assert.doesNotMatch(html, /会社別Runs readbackを取得できません/);
});

test("company-scoped Runs does not count another company's pending approvals", () => {
  globalThis.location = { hash: `#/runs?company_id=${company}` };
  const html = render("RunsPage", {
    model: model({
      company_scope: { enforced: true, company_ids: [company] },
      approvals: [{ id: "foreign-approval", company_id: "other-company", status: "pending" }],
      runs: []
    })
  });
  assert.match(html, /承認待ち<\/td><td data-label="状態">0<\/td>/);
  assert.doesNotMatch(html, /foreign-approval/);
});

test("state read timeout aborts once, reports an exact error and clears its timer", async (t) => {
  let timeout;
  let calls = 0;
  const cleared = [];
  withWindowFixture(t, {
    setTimeout(callback, ms) { assert.equal(ms, 30_000); timeout = callback; return 47; },
    clearTimeout(id) { cleared.push(id); },
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls += 1;
    assert.equal(init.credentials, "include");
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("fixture abort", "AbortError")), { once: true }));
  });
  const pending = components.mvpFetch("/api/mvp/state");
  timeout();
  await assert.rejects(pending, /mvp_state_request_timeout/);
  assert.equal(calls, 1);
  assert.deepEqual(cleared, [47]);
});

test("state read network failure is preserved without an implicit retry", async (t) => {
  let calls = 0;
  const cleared = [];
  const failure = new TypeError("fixture network failure");
  withWindowFixture(t, {
    setTimeout() { return 48; }, clearTimeout(id) { cleared.push(id); },
  });
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw failure; });
  await assert.rejects(components.mvpFetch("/api/mvp/state"), (error) => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(cleared, [48]);
});
