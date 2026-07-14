import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function assertSourceIncludes(source: string, snippets: string[]): void {
  for (const snippet of snippets) {
    assert.ok(source.includes(snippet), `missing source snippet: ${snippet}`);
  }
}

test("run detail endpoint fetches run-scoped rows beyond dashboard limits", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(serverSource, /app\.get\("\/api\/runs\/:id"/);
  assert.match(serverSource, /export function getRunDetail/);
  assert.match(serverSource, /FROM run_steps WHERE run_id/);
  assert.match(serverSource, /FROM proofs WHERE run_id/);
  assert.match(serverSource, /FROM worker_events WHERE run_id/);
  assert.match(serverSource, /LIMIT 500/);
  assert.match(serverSource, /LIMIT 1000/);
  assert.match(serverSource, /LIMIT 2000/);
  assert.match(appSource, /fetchApiJson<RunDetail>\(`\/api\/runs\/\$\{encodeURIComponent\(currentRunId\)\}`/);
  assert.match(appSource, /const selectedSteps = detailForCurrentRun\?\.steps \?\? \[\]/);
  assert.match(appSource, /const selectedProofs = detailForCurrentRun\?\.proofs/);
  assert.match(appSource, /const selectedWorkerEvents = detailForCurrentRun\?\.workerEvents \?\? \[\]/);
});

test("proof viewer endpoint is id based and blocks unsafe raw paths", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const viewerSource = serverSource.slice(serverSource.indexOf("app.get(\"/api/proofs/:id/view\""), serverSource.indexOf("app.post(\"/api/import/codex-assets\""));
  const resolverSource = serverSource.slice(serverSource.indexOf("export function getProofView"), serverSource.indexOf("function publicProofViewBase"));
  const targetSource = serverSource.slice(serverSource.indexOf("function resolveProofTarget"), serverSource.indexOf("function proofTargetString"));
  const previewSource = serverSource.slice(serverSource.indexOf("function redactProofPreview"), serverSource.indexOf("function imageMetadata"));

  assert.match(viewerSource, /getProofView\(req\.params\.id\)/);
  assert.match(resolverSource, /SELECT \* FROM proofs WHERE id=/);
  assert.match(targetSource, /\^https\?:\\\/\\\//);
  assert.match(targetSource, /unsupported_uri_scheme/);
  assert.match(targetSource, /absolute_path_requires_file_uri/);
  assert.match(targetSource, /isTempPath\(candidate\)/);
  assert.match(targetSource, /realpathSync\(candidate\)/);
  assert.match(serverSource, /const proofArtifactRootNames = \["data\/artifacts", "artifacts", "output\/playwright", "\.playwright-cli"\]/);
  assert.match(serverSource, /SELECT DISTINCT project_root FROM registered_workflows/);
  assert.match(serverSource, /for \(const projectRoot of registeredWorkflowProjectRoots\(\)\) \{/);
  assert.match(serverSource, /addProofArtifactRoots\(roots, projectRoot\)/);
  assert.match(serverSource, /const candidate = resolvePath\(realProjectRoot, dir\)/);
  assert.match(serverSource, /if \(realArtifactRoot === realProjectRoot\) continue/);
  assert.match(serverSource, /if \(!isPathInsideRoot\(realProjectRoot, realArtifactRoot\)\) continue/);
  assert.match(serverSource, /roots\.add\(realArtifactRoot\)/);
  const addRootsSource = serverSource.slice(serverSource.indexOf("function addProofArtifactRoots"), serverSource.indexOf("function isPathInsideRoot"));
  assert.doesNotMatch(addRootsSource, /roots\.add\(realProjectRoot\)|roots\.add\(projectRoot\)/);
  assert.match(resolverSource, /file_too_large/);
  assert.match(resolverSource, /proofViewMaxBytes/);
  assert.match(resolverSource, /preview_kind: "image"/);
  assert.match(serverSource, /base64_included: false/);
  assert.doesNotMatch(resolverSource, /toString\("base64"\)|base64,/);
  assert.match(serverSource, /import \{ redactSensitiveText \} from "\.\/obsidian\/redaction\.js"/);
  assert.match(previewSource, /redactSensitiveText\(value\)/);
  assert.match(previewSource, /\[redacted-path\]/);
  assert.match(previewSource, /\[redacted-url\]/);
  assert.match(appSource, /fetchApiJson<ProofView>\(viewerUrl/);
});

test("run detail display redacts raw local paths and URLs from proof previews", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const runsSource = appSource.slice(appSource.indexOf("function RunsPage"), appSource.indexOf("function LanesPage"));
  const displayRedactionSource = appSource.slice(appSource.indexOf("function redactDisplayPaths"), appSource.indexOf("function publicRunStatus"));
  const proofPreviewSource = serverSource.slice(serverSource.indexOf("export function redactProofPreview"), serverSource.indexOf("function imageMetadata"));

  assertSourceIncludes(proofPreviewSource, [
    String.raw`.replace(/file:(?:\\\/){3}Users(?:\\\/)[^\n\r"'<>]+/g, "[redacted-file-uri]")`,
    String.raw`.replace(/file:(?:\/\/\/|\/\/|(?:\\\/){2,3})Users\/[^\n\r"'<>]+/g, "[redacted-file-uri]")`,
    String.raw`.replace(/\/Users\/[^\n\r"'<>]+/g, "[redacted-path]")`,
    String.raw`.replace(/(?:\/private)?\/tmp\/[^\n\r"'<>]+/g, "[redacted-path]")`,
    String.raw`Documents\/New project\/[^\n\r"'<>]+`,
    String.raw`data\/artifacts`,
    String.raw`output\/playwright`,
    String.raw`\.playwright-cli`,
    String.raw`.replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]")`
  ]);
  assert.match(runsSource, /redactDisplayPaths\(proof\.summary\)/);
  assert.match(runsSource, /redactDisplayPaths\(proofView\.preview\)/);
  assert.doesNotMatch(runsSource, /proof\.artifact_uri/);
  assert.match(displayRedactionSource, /\/Users/);
  assert.match(displayRedactionSource, /Documents\\\/New project/);
  assert.match(displayRedactionSource, /data\\\/artifacts/);
  assert.match(displayRedactionSource, /output\\\/playwright/);
  assert.match(displayRedactionSource, /https\?:/);
  assert.match(proofPreviewSource, /\/Users/);
  assert.match(proofPreviewSource, /Documents\\\/New project/);
  assert.match(proofPreviewSource, /data\\\/artifacts/);
  assert.match(proofPreviewSource, /output\\\/playwright/);
});

test("dashboard refresh and polling correct stale selected run ids", () => {
  const appSource = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");

  assert.match(appSource, /function resolveSelectedRunId\(current: string \| null, runs: any\[\], actionableRuns: any\[\] = \[\]\): string \| null/);
  assert.match(appSource, /if \(!runs\.length\) return null/);
  assert.match(appSource, /if \(current && runs\.some\(\(run\) => run\.id === current\)\) return current/);
  assert.match(appSource, /function runDispositionRank\(run: any\)/);
  assert.match(appSource, /const candidates = actionableRuns\.length \? actionableRuns : runs/);
  assert.match(appSource, /return typeof latestRunId === "string" \? latestRunId : null/);

  const correctionCalls = appSource.match(/setSelectedRunId\(\(current\) => resolveSelectedRunId\(current, state\.runs \?\? \[\], state\.actionableRuns \?\? \[\]\)\)/g) ?? [];
  assert.equal(correctionCalls.length, 2);

  assert.match(appSource, /const refresh = async \(\) => \{[\s\S]*setSelectedRunId\(\(current\) => resolveSelectedRunId\(current, state\.runs \?\? \[\], state\.actionableRuns \?\? \[\]\)\)/);
  assert.match(appSource, /window\.setInterval\(\(\) => \{[\s\S]*setSelectedRunId\(\(current\) => resolveSelectedRunId\(current, state\.runs \?\? \[\], state\.actionableRuns \?\? \[\]\)\)[\s\S]*\}, 30000\)/);
});
