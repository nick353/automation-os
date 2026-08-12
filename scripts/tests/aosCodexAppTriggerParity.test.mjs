import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
