import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-seed-daily-ai-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const seed = await import("../seedDailyAiDemo.js");

test("seedDailyAiDemo persists Browser Use lane details", () => {
  db.initDb();
  const result = seed.seedDailyAiDemo();

  assert.equal(result.runId, "run_demo_daily_ai");
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
