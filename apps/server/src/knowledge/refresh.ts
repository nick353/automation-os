import { initDb, nowIso, querySql, upsert } from "../db/client.js";
import { listStoredSecrets } from "../secrets/secretStore.js";

type RunRow = {
  id: string;
  name: string;
  status: string;
  objective: string;
  updated_at: string;
  metadata_json: string;
};

type SystemCheckRow = {
  id: string;
  status: string;
  summary: string;
  target_url: string | null;
  artifact_uri: string | null;
  created_at: string;
  metadata_json: string;
};

type BridgeActionRow = {
  id: string;
  capability_id: string;
  label: string;
  status: string;
  risk_level: string;
  summary: string;
  created_at: string;
  metadata_json: string;
};

type BridgeExecutionRow = {
  id: string;
  capability_id: string;
  approval_id: string | null;
  status: string;
  executor_status: string;
  summary: string;
  created_at: string;
};

export type KnowledgeRefreshResult = {
  ok: true;
  refreshedAt: string;
  notes: Array<{ id: string; title: string; noteType: string }>;
};

export function refreshKnowledgeNotes(): KnowledgeRefreshResult {
  initDb();
  const refreshedAt = nowIso();
  const notes = [
    buildOperatingSnapshot(refreshedAt),
    buildCredentialSnapshot(refreshedAt),
    buildBridgeSnapshot(refreshedAt),
    buildUiVerificationSnapshot(refreshedAt)
  ];

  for (const note of notes) {
    upsert("knowledge_notes", {
      id: note.id,
      note_type: note.noteType,
      title: note.title,
      body: note.body,
      tags_json: note.tags,
      source_ref: note.sourceRef,
      created_at: note.createdAt,
      updated_at: refreshedAt,
      metadata_json: note.metadata
    });
  }

  return {
    ok: true,
    refreshedAt,
    notes: notes.map((note) => ({ id: note.id, title: note.title, noteType: note.noteType }))
  };
}

function buildOperatingSnapshot(now: string) {
  const runs = querySql<RunRow>("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 8");
  const statusMix = countBy(runs, (run) => run.status);
  const latest = runs[0];
  return note({
    id: "knowledge_operating_snapshot",
    noteType: "operating_snapshot",
    title: "Automation OS current operating state",
    body: [
      "## Current run posture",
      "",
      latest ? `- Latest run: ${latest.name} (${latest.status})` : "- Latest run: none",
      `- Status mix: ${Object.entries(statusMix).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
      "",
      "## Rule",
      "",
      "User-facing UI should stay simple: consult, run, approve, and review result. Backend details stay in Data/advanced views."
    ].join("\n"),
    tags: ["automation-os", "state", "beginner-ui"],
    sourceRef: latest?.id ?? "runs",
    createdAt: now,
    metadata: { indexedRuns: runs.length, statusMix }
  });
}

function buildCredentialSnapshot(now: string) {
  const secrets = listStoredSecrets();
  return note({
    id: "knowledge_credentials_snapshot",
    noteType: "credential_snapshot",
    title: "Saved credential reuse policy",
    body: [
      "## Saved credentials",
      "",
      secrets.length ? secrets.map((secret) => `- ${secret.label}: saved, value hidden`).join("\n") : "- none",
      "",
      "## Rule",
      "",
      "When a saved credential exists, the assistant should say it will use the previous key without showing the value."
    ].join("\n"),
    tags: ["secrets", "reuse", "safety"],
    sourceRef: "stored_secrets",
    createdAt: now,
    metadata: { secretKinds: secrets.map((secret) => secret.kind) }
  });
}

function buildBridgeSnapshot(now: string) {
  const actions = querySql<BridgeActionRow>("SELECT * FROM bridge_actions ORDER BY created_at DESC LIMIT 8");
  const executions = querySql<BridgeExecutionRow>("SELECT * FROM bridge_executions ORDER BY created_at DESC LIMIT 8");
  return note({
    id: "knowledge_bridge_snapshot",
    noteType: "bridge_snapshot",
    title: "Trusted Bridge execution and billing-only boundary",
    body: [
      "## Recent bridge actions",
      "",
      actions.length
        ? actions.map((action) => `- ${action.label}: ${action.status} (${action.risk_level}) - ${action.summary}`).join("\n")
        : "- none",
      "",
      "## Recent executor attempts",
      "",
      executions.length
        ? executions.map((execution) => `- ${execution.capability_id}: ${execution.status} / ${execution.executor_status} - ${execution.summary}`).join("\n")
        : "- none",
      "",
      "## Rule",
      "",
      "Safe local checks can run immediately. External writes, sends, publishes, deletes, and authenticated Chrome actions can proceed with source-of-truth evidence and readback; only billing, purchase, payment, checkout, paid subscription, invoice, or 請求 are hard stops. A billing confirmation alone does not mean execution: the executor ledger must show a connected executor and a completed receipt."
    ].join("\n"),
    tags: ["trusted-bridge", "approval", "codex-app-parity"],
    sourceRef: "bridge_actions bridge_executions",
    createdAt: now,
    metadata: { actionCount: actions.length, executionCount: executions.length }
  });
}

function buildUiVerificationSnapshot(now: string) {
  const checks = querySql<SystemCheckRow>("SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 5");
  return note({
    id: "knowledge_ui_verification_snapshot",
    noteType: "ui_verification_snapshot",
    title: "Latest UI verification proof",
    body: [
      "## Recent UI checks",
      "",
      checks.length
        ? checks.map((check) => `- ${check.status}: ${check.summary} (${check.artifact_uri ?? check.target_url ?? "no artifact"})`).join("\n")
        : "- none",
      "",
      "## Rule",
      "",
      "A UI check is complete only when DOM snapshot, screenshot, and console artifacts are captured and console errors are accounted for."
    ].join("\n"),
    tags: ["ui", "playwright-cli", "proof"],
    sourceRef: checks[0]?.id ?? "system_checks",
    createdAt: now,
    metadata: { checkCount: checks.length }
  });
}

function note(input: {
  id: string;
  noteType: string;
  title: string;
  body: string;
  tags: string[];
  sourceRef: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}) {
  return input;
}

function countBy<T>(items: T[], pick: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = pick(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}
