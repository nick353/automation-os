import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-seed-daily-ai-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";

const db = await import("../db/client.js");
const seed = await import("../seedDailyAiDemo.js");

test("seedDailyAiDemo persists Browser Use lane details", () => {
  db.initDb();
  const result = seed.seedDailyAiDemo();

  assert.equal(result.runId, "run_demo_daily_ai");
  assert.equal(result.companyId, "company_demo_daily_ai");
  assert.equal(db.querySql<{ company_id: string }>("SELECT company_id FROM runs WHERE id='run_demo_daily_ai'")[0].company_id, result.companyId);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM approvals WHERE company_id='${result.companyId}'`)[0].count, 1);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM proofs WHERE company_id='${result.companyId}'`)[0].count, result.proofs);
  const lane = db.querySql<{
    cdp_port: number;
    profile_dir: string;
    browser_use_session: string;
    browser_use_cdp_url: string;
    browser_use_profile: string;
    profile_strategy: string;
    lane_visibility: string;
  }>("SELECT * FROM lanes WHERE run_id='run_demo_daily_ai' ORDER BY cdp_port ASC LIMIT 1")[0];

  assert.equal(lane.cdp_port, 9333);
  assert.match(lane.browser_use_session, /^browser-use-/);
  assert.equal(lane.browser_use_cdp_url, "http://127.0.0.1:9333");
  assert.equal(lane.browser_use_profile, lane.profile_dir);
  assert.equal(lane.profile_strategy, "cdp_profile_lane");
  assert.equal(lane.lane_visibility, "visible");
});

test("seedDailyAiDemo refuses destructive reset outside an isolated demo context", () => {
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const previousAllowDemo = process.env.AUTOMATION_OS_ALLOW_DEMO_SEED;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.AUTOMATION_OS_ALLOW_DEMO_SEED;
  try {
    assert.throws(() => seed.seedDailyAiDemo(), /daily_ai_demo_seed_disabled/);
  } finally {
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    if (previousAllowDemo === undefined) delete process.env.AUTOMATION_OS_ALLOW_DEMO_SEED;
    else process.env.AUTOMATION_OS_ALLOW_DEMO_SEED = previousAllowDemo;
  }
});
