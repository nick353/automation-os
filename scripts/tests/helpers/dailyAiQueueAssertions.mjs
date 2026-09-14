import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Read-only: use the same CSV parser/delimiter as the canonical Python writer,
// without importing the queue store (which can bootstrap or acquire locks).
export function assertDailyAiPublishedQueue(queuePath, proof, expectedText) {
  const parsed = spawnSync("python3", ["-c", "import csv,json,sys\nwith open(sys.argv[1], encoding='utf-8', newline='') as f:\n print(json.dumps(list(csv.reader(f, delimiter='\\t'))))", queuePath], { encoding: "utf8", timeout: 10000 });
  assert.equal(parsed.status, 0, parsed.stderr || String(parsed.error || ""));
  const [headers, ...rows] = JSON.parse(parsed.stdout);
  const required = ["id", "status", "x_text", "x_post_id", "x_post_url", "x_published_at"];
  for (const name of required) assert.equal(headers.filter((header) => header === name).length, 1, `unique header: ${name}`);
  const matches = rows.filter((row) => row[headers.indexOf("id")] === "real-daily-1");
  assert.equal(matches.length, 1, "exactly one target row");
  const row = Object.fromEntries(headers.map((header, index) => [header, matches[0][index]]));
  assert.equal(row.status, "partially_published");
  assert.equal(row.x_text, expectedText);
  assert.equal(row.x_post_id, "42");
  assert.equal(row.x_post_url, "https://x.com/observed/status/42");
  assert.ok(Number.isFinite(Date.parse(row.x_published_at)));
  assert.equal(row.x_published_at, proof.observed_at);
}
