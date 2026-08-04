import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("dashboard does not turn an unverified capability into a no-blocker claim", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function publicCapabilityBlocker\(surface\?: \{ status\?: string; exactBlocker\?: string \| null \}\)/);
  assert.match(source, /if \(surface\?\.status === "ready" \|\| surface\?\.status === "available"\) return "なし"/);
  assert.match(source, /return "未確認";/);
  assert.doesNotMatch(source, /exactBlocker \?\? "none"/);
  assert.doesNotMatch(source, /exactBlocker \?\? "no blocker reported"/);
});

test("worker readback separates persisted state age from Mac heartbeat freshness", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(source, /function relativeAgeLabel\(value: unknown\)/);
  assert.match(source, /状態記録: \$\{age\} \/ Mac heartbeat未確認/);
  assert.match(source, /heartbeat: \$\{age\} \/ stale/);
  assert.match(source, /heartbeat: \$\{age\} \/ fresh/);
  assert.match(source, /freshness: "未確認"/);
});

test("runs history shows stored completed runs in its initial view", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const runsSource = source.slice(source.indexOf("function RunsPage"), source.indexOf("function PcStatusPage"));

  assert.match(runsSource, /const \[statusFilter, setStatusFilter\] = useState\("all"\)/);
  assert.match(runsSource, /const filteredRuns = runs\.filter\(\(run\) => statusMatches\(run\)/);
  assert.match(runsSource, /\["complete", "completed"\]\.includes\(run\.status\)/);
  assert.match(runsSource, /controlId="runs\.history\.table"/);
});

test("builder controls expose stable accessible names for browser QA and keyboard users", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  for (const label of [
    "自動化名",
    "プロジェクト",
    "Lane",
    "スケジュール希望（仕様メモ）",
    "承認ポリシー",
    "リトライルール",
    "定期実行の種別",
    "定期実行の実行式",
    "定期実行のTimezone",
    "定期実行を有効にする"
  ]) {
    assert.match(source, new RegExp(`aria-label=\\"${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\"`));
  }
  assert.match(source, /\["all", "全プロジェクト"\]/);
  assert.doesNotMatch(source, /\["all", "全Project"\]/);
});

test("literal rendered control ids are covered by the control manifest", () => {
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const manifestSource = readFileSync(resolve(process.cwd(), "apps/web/src/controlManifest.ts"), "utf8");
  const renderedIds = [...appSource.matchAll(/(?:data-control-id|controlId)="([^"]+)"/g)].map((match) => match[1]);
  const manifestIds = [...manifestSource.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1]);
  const matches = (id: string, pattern: string) => {
    if (!pattern.includes("*")) return id === pattern;
    const expression = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")).join(".*")}$`);
    return expression.test(id);
  };
  const missing = [...new Set(renderedIds)].filter((id) => !manifestIds.some((pattern) => matches(id, pattern)));
  assert.deepEqual(missing, [], `unclassified literal control ids: ${missing.join(", ")}`);
});
