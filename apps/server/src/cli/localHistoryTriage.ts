import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dbBackend, execSql, initDb, querySql, sqlValue } from "../db/client.js";

const outDir = resolve(readArgValue("--out-dir") ?? `data/artifacts/local-history-triage-${timestamp()}`);
const write = process.argv.includes("--write");

if (dbBackend !== "sqlite") {
  finish({ ok: false, blocker: "local_history_triage_requires_sqlite", database: { backend: dbBackend } }, 2);
}

initDb();
mkdirSync(outDir, { recursive: true });

type RunRow = {
  id: string;
  name: string;
  status: string;
  updated_at: string;
  metadata_json: string;
};

const rows = querySql<RunRow>(`
  SELECT id, name, status, updated_at, metadata_json
  FROM runs
  WHERE status IN ('blocked','partial','waiting_approval')
    AND COALESCE(json_extract(metadata_json,'$.resume_suppressed'), 0) != 1
  ORDER BY updated_at DESC
`);

const triaged = rows.map((row) => {
  const metadata = parseJson(row.metadata_json);
  const workflowId = String(metadata.registeredWorkflowId ?? metadata.registered_workflow_id ?? metadata.workflowId ?? metadata.workflow_id ?? "");
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: row.updated_at,
    workflowId: workflowId || null,
    category: categorize(row.name, workflowId),
    blocker: String(metadata.blocker ?? metadata.stop_reason ?? metadata.remainingBlocker ?? metadata.proof_gate?.missing?.join?.(",") ?? ""),
    recommendedAction: "local_history_archive",
    reason: "Production PostgreSQL has no pending runs; this is local SQLite historical noise unless explicitly restarted as a new production run."
  };
});

const writeCandidates = triaged.filter((row) => row.recommendedAction === "local_history_archive");
if (write) {
  for (const row of writeCandidates) {
    const current = rows.find((candidate) => candidate.id === row.id);
    const metadata = parseJson(current?.metadata_json);
    metadata.resume_suppressed = true;
    metadata.local_history_triage = {
      archivedAt: new Date().toISOString(),
      reason: row.reason,
      previousStatus: row.status,
      category: row.category
    };
    execSql(`UPDATE runs SET metadata_json=${sqlValue(metadata)} WHERE id=${sqlValue(row.id)};`);
  }
}

const summary = {
  ok: true,
  mode: write ? "write" : "dry-run",
  database: { backend: dbBackend },
  totalActionableHistory: triaged.length,
  archived: write ? writeCandidates.length : 0,
  archiveCandidates: writeCandidates.length,
  categories: countBy(triaged.map((row) => row.category)),
  outDir,
  reportPath: join(outDir, "summary.json")
};

writeFileSync(join(outDir, "summary.json"), JSON.stringify({ ...summary, runs: triaged }, null, 2));
console.log(JSON.stringify(summary, null, 2));

function categorize(name: string, workflowId: string) {
  const text = `${name} ${workflowId}`.toLowerCase();
  if (/job|application|submit|follow/.test(text)) return "jobs";
  if (/daily ai/.test(text)) return "daily_ai";
  if (/nisen|etsy|printify|pinterest/.test(text)) return "nisenprints";
  if (/\bx\b|twitter/.test(text)) return "x";
  if (/prompt|transfer|sheets|ukiyoe/.test(text)) return "prompt_transfer";
  if (/sns/.test(text)) return "sns";
  if (/youtube|transcript|動画/.test(text)) return "youtube";
  return "other";
}

function parseJson(value: string | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function readArgValue(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function finish(summary: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(code);
}
