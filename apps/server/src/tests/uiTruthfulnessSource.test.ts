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

test("frontend exposes one provider-neutral adaptive web operation entry point", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function WebOperationAdmissionPanel");
  const end = source.indexOf("type AppModel", start);
  assert.ok(start >= 0 && end > start, "common web operation panel source missing");
  const panelSource = source.slice(start, end);
  assert.match(panelSource, /live semantic candidate/);
  assert.match(panelSource, /固定CSS\/XPath\/DOM順は権威にしない/);
  assert.match(panelSource, /候補が0件・複数件/);
  assert.match(panelSource, /同一Runのreceipt、source-of-truth sync、cleanup/);
  assert.match(panelSource, /web-admission\.prompt-template/);
  assert.match(panelSource, /COMMON_WEB_OPERATION_PROMPT_TEMPLATE/);
  assert.match(panelSource, /サイト固有のselectorやクリック順は不要です/);
  assert.match(panelSource, /external_action=false/);
  assert.match(panelSource, /controlId="web-admission\.chat"/);
  assert.match(panelSource, /controlId="web-admission\.approvals"/);
  assert.match(source, /<WebOperationAdmissionPanel model=\{model\} \/>/);
  assert.match(source, /<WebOperationAdmissionPanel model=\{model\} projectId=\{targetProject\} \/>/);
  assert.match(source, /requestedChatContext\.context !== "web-operation-admission"/);
  assert.match(source, /setPrompt\(COMMON_WEB_OPERATION_PROMPT_TEMPLATE\)/);
  assert.match(source, /まだ外部操作は実行していません/);
  assert.match(source, /web_operation_intake/);
  assert.match(source, /chat\.web-operation-intake/);
  assert.match(source, /固定selector・XPath・DOM順は権威にせず/);
});

test("frontend exposes the workflow-owned Browser Use profile and reserved port binding without claiming a live process", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const panelSource = source.slice(source.indexOf("function WebOperationAdmissionPanel"), source.indexOf("type AppModel"));

  assert.match(panelSource, /web-admission\.lane-binding/);
  assert.match(panelSource, /web-admission\.lane-binding\.summary/);
  assert.match(panelSource, /web-admission\.lane-binding\.table/);
  assert.match(panelSource, /web-admission\.process-readback/);
  assert.match(panelSource, /web-admission\.process-readback\.table/);
  assert.match(panelSource, /profileRef/);
  assert.match(panelSource, /reservedPort/);
  assert.match(panelSource, /lifecycle/);
  assert.match(panelSource, /予約port \(AOS\)/);
  assert.match(panelSource, /実測process port/);
  assert.match(panelSource, /queue scope/);
  assert.match(panelSource, /web-admission\.scope-alignment/);
  assert.match(panelSource, /Queue \/ Workerのscope候補/);
  assert.match(panelSource, /alignmentCandidates/);
  assert.match(panelSource, /alignmentDecisionRequired/);
  assert.match(panelSource, /web-admission\.scope-alignment\.plan/);
  assert.match(panelSource, /自動切替なし/);
  assert.match(panelSource, /database backend/);
  assert.match(panelSource, /AOS queue と Mac worker が別会社scope/);
  assert.match(source, /processReadbackStatus/);
  assert.match(source, /process検出（profile\/port一致）/);
  assert.match(source, /未登録Browserあり（照合待ち）/);
  assert.match(source, /profile \/ port不一致（照合待ち）/);
  assert.match(source, /foreign \/ process bindingを変更せず/);
  assert.match(panelSource, /ownership/);
  assert.match(panelSource, /bindingStatus/);
  assert.match(source, /liveReadbackStatus/);
  assert.match(panelSource, /実プロセスのlistenは別表の実測process port、認証状態と画面readbackはMac workerが同一Runで返した場合だけ/);
  assert.match(source, /予約のみ/);
  assert.match(source, /Mac workerの同一Run readback待ち/);
  assert.match(panelSource, /runtimeRole/);
  assert.match(panelSource, /登録集合の意味/);
  assert.match(panelSource, new RegExp("Browser/portable"));
  assert.match(panelSource, /Company catalog/);
  assert.match(panelSource, /Browser lane/);
  assert.match(panelSource, /同一ホストprocess/);
  assert.match(panelSource, /未登録Browser/);
  assert.match(panelSource, /heartbeat・queue claim・receipt・source sync/);
  assert.match(panelSource, /web-admission\.operational-readback/);
  assert.match(panelSource, /認証・外部作用・業務完了のreadback/);
  assert.match(source, /同一Run認証readback済み/);
  assert.match(source, /provider receipt必須/);
  assert.match(source, /業務完了未claim/);
  assert.match(panelSource, /businessCompletion\?\.exactBlocker/);
  assert.match(source, /Browser Use Lane/);
  assert.match(source, /profileName/);
});

test("PC status separates persisted heartbeat from same-host remote worker and Browser Use process readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const start = source.indexOf("function PcStatusPage");
  const end = source.indexOf("function TemplatesPage", start);
  assert.ok(start >= 0 && end > start, "PC status source missing");
  const pcSource = source.slice(start, end);

  assert.match(pcSource, /Portable remote worker process/);
  assert.match(pcSource, /Queue scope/);
  assert.match(pcSource, /local_sqlite/);
  assert.match(pcSource, /heartbeat・queue claim・receipt・source sync/);
  assert.match(pcSource, /Browser Use live resource/);
  assert.match(pcSource, /unregisteredBrowserProcessCount/);
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
