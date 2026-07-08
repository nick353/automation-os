import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupAutomationManagedProcesses,
  findAutomationManagedProcesses,
  parseEtimeSeconds,
  parsePsRows
} from "../browser/processHygiene.js";

test("parses ps etime values", () => {
  assert.equal(parseEtimeSeconds("00:31"), 31);
  assert.equal(parseEtimeSeconds("06:48"), 408);
  assert.equal(parseEtimeSeconds("01:02:03"), 3723);
  assert.equal(parseEtimeSeconds("1-03:04:14"), 97454);
  assert.equal(parseEtimeSeconds("bad"), null);
});

test("finds only Automation OS managed stale browser and daemon processes", () => {
  const rows = parsePsRows(`
812 1 812 22:10:00 /usr/local/bin/node /tmp/node_modules/playwright-core/lib/entry/cliDaemon.js aos-ges6q4
900 1 900 00:02:00 /usr/local/bin/node /tmp/node_modules/playwright-core/lib/entry/cliDaemon.js aos-new
1001 1 1001 07:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-A --remote-debugging-port=51234
1002 1 1002 07:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/Users/nichikatanaka/.daily-ai-playwright-chrome
1003 1 1003 07:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9339 --user-data-dir=/Users/nichikatanaka/.sns-multi-poster-ukiyoe-playwright-chrome
1004 1 1004 07:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default https://example.com
1005 1 1005 00:05:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9335 --user-data-dir=/Users/nichikatanaka/.nisenprints-playwright-chrome
  `);

  const matches = findAutomationManagedProcesses(rows, { maxAgeSeconds: 6 * 60 * 60 });
  assert.deepEqual(matches.map((row) => row.pid), [812, 1001, 1002]);
  assert.equal(matches.find((row) => row.pid === 1002)?.laneId, "daily-ai-playwright-cli");
  assert.equal(matches.some((row) => row.pid === 1003), false);
  assert.equal(matches.some((row) => row.pid === 1004), false);
  assert.equal(matches.some((row) => row.pid === 1005), false);
});

test("visible registered lanes require explicit include flag", () => {
  const rows = parsePsRows(
    "1003 1 1003 07:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9339 --user-data-dir=/Users/nichikatanaka/.sns-multi-poster-ukiyoe-playwright-chrome"
  );

  assert.equal(findAutomationManagedProcesses(rows, { maxAgeSeconds: 0 }).length, 0);
  assert.equal(findAutomationManagedProcesses(rows, { maxAgeSeconds: 0, includeVisibleLanes: true }).length, 1);
});

test("cleanup terminates matched pids and reports dry run without killing", () => {
  const psOutput = `
812 1 812 22:10:00 /usr/local/bin/node /tmp/node_modules/playwright-core/lib/entry/cliDaemon.js aos-ges6q4
1001 1 1001 07:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-A --remote-debugging-port=51234
  `;
  const killed: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const alive = new Set([812, 1001]);
  const killImpl = (pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 0) {
      if (alive.has(pid)) return;
      throw new Error("ESRCH");
    }
    killed.push({ pid, signal });
    alive.delete(pid);
  };

  const dry = cleanupAutomationManagedProcesses({ psOutput, dryRun: true });
  assert.equal(dry.mode, "scan");
  assert.deepEqual(dry.matched.map((row) => row.pid), [812, 1001]);
  assert.equal(killed.length, 0);

  const cleaned = cleanupAutomationManagedProcesses({ psOutput, killImpl, sleepImpl: () => {} });
  assert.equal(cleaned.mode, "cleanup");
  assert.deepEqual(killed.map((item) => item.pid), [812, 1001]);
});
