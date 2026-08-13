import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("all Company 1 Codex App automations are thin AOS trigger bridges with schedule parity", () => {
  const companyId = "company_2560580981cedfd106b66245";
  const schedules = [
    ["automation_813091820198928c10c54297", "07:30"],
    ["automation_c304872764579ce2db1c5c90", "07:30"],
    ["automation_90303bb7919647e5005004ed", "09:00"],
    ["automation_ce9e7a5e79370da25ec4bf0e", "09:00"],
    ["automation_79f86fe8189154f9ea62f0ef", "08:30"],
    ["automation_e977435478c5c01ad1f47a49", "MON 09:30"]
  ].map(([id, expression]) => ({ id, company_id: companyId, automation_status: "active", schedule_status: "active", enabled: true, expression, timezone: "Asia/Tokyo" }));
  const output = execFileSync(process.execPath, [join(root, "scripts", "aos-codex-app-trigger-parity-readback.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AOS_TRIGGER_PARITY_COMPANY_ID: companyId, AOS_PARITY_SCHEDULES_JSON: JSON.stringify(schedules) }
  });
  const result = JSON.parse(output);
  assert.equal(result.status, "matched", output);
  assert.equal(result.registered_count, 6, output);
  assert.equal(result.aos_count, 6, output);
  assert.equal(result.aos_source.kind, "fixture", output);
  assert.equal(result.external_action_executed, false, output);
  assert.ok(result.entries.every((entry) => entry.status === "matched"), output);
});

test("local diagnostic scope drift is fail-closed instead of a false zero-registration gap", () => {
  const expectedCompanyId = "company_local_scope";
  const schedules = [{ id: "automation_local", company_id: expectedCompanyId, automation_status: "active", schedule_status: "active", enabled: true, expression: "07:30", timezone: "Asia/Tokyo" }];
  const completed = spawnSync(process.execPath, [join(root, "scripts", "aos-codex-app-trigger-parity-readback.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AOS_TRIGGER_PARITY_COMPANY_ID: expectedCompanyId, AOS_PARITY_SCHEDULES_JSON: JSON.stringify(schedules) }
  });
  const output = completed.stdout;
  const result = JSON.parse(output);
  assert.equal(completed.status, 2, output);
  assert.equal(result.status, "blocked", output);
  assert.equal(result.exact_blocker, "aos_local_diagnostic_scope_not_authorized_for_claim", output);
  assert.equal(result.entries.at(-1)?.historical_parity_blocker, "aos_scope_alignment_required", output);
  assert.equal(result.registered_count, 0, output);
  assert.ok(result.registered_total_count >= 6, output);
  assert.ok(result.registered_company_ids.includes("company_2560580981cedfd106b66245"), output);
  assert.equal(result.external_action_executed, false, output);
});

test("the parity checker defaults to the current registered production company, never the stale local scope", () => {
  const source = readFileSync(join(root, "scripts", "aos-codex-app-trigger-parity-readback.mjs"), "utf8");
  assert.match(source, /company_2560580981cedfd106b66245/u);
  assert.doesNotMatch(source, /\|\|\s*["']company_9588eaafb46d7cbaead81811["']/u);
});
