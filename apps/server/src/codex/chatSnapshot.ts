import { redactSensitiveText } from "../obsidian/redaction.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

type SnapshotRecord = Record<string, unknown>;

type SnapshotTier = {
  name: string;
  automations: number;
  schedules: number;
  runs: number;
  approvals: number;
  presentationProfiles: number;
  registeredWorkflows: number;
};

const tiers: SnapshotTier[] = [
  { name: "full", automations: 120, schedules: 120, runs: 80, approvals: 80, presentationProfiles: 100, registeredWorkflows: 100 },
  { name: "compact", automations: 80, schedules: 80, runs: 50, approvals: 50, presentationProfiles: 50, registeredWorkflows: 60 },
  { name: "reduced", automations: 40, schedules: 40, runs: 24, approvals: 24, presentationProfiles: 24, registeredWorkflows: 32 },
  { name: "minimal", automations: 16, schedules: 16, runs: 12, approvals: 12, presentationProfiles: 12, registeredWorkflows: 16 }
];

/**
 * Keep the App Server context bounded without ever cutting a JSON string in
 * the middle of an object. The planner needs a valid, truthful snapshot even
 * when a project has accumulated a large run/workflow history.
 */
export function serializeAutomationOsChatSnapshot(snapshot: SnapshotRecord, maxBytes = DEFAULT_MAX_BYTES): string {
  const boundedMaxBytes = Number.isFinite(maxBytes) && maxBytes >= 8_192
    ? Math.floor(maxBytes)
    : DEFAULT_MAX_BYTES;
  for (const tier of tiers) {
    const candidate = buildTierSnapshot(snapshot, tier);
    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= boundedMaxBytes) return serialized;
  }

  const compact = buildMinimalSnapshot(snapshot);
  const serialized = JSON.stringify(compact);
  if (Buffer.byteLength(serialized, "utf8") > boundedMaxBytes) {
    throw new Error("automation_os_chat_snapshot_size_exceeded");
  }
  return serialized;
}

function buildTierSnapshot(snapshot: SnapshotRecord, tier: SnapshotTier): SnapshotRecord {
  const freshness = asRecord(snapshot.freshness);
  return {
    ...snapshot,
    companies: boundedArray(snapshot.companies, 100),
    automations: boundedArray(snapshot.automations, tier.automations),
    schedules: boundedArray(snapshot.schedules, tier.schedules),
    runs: boundedArray(snapshot.runs, tier.runs),
    approvals: boundedArray(snapshot.approvals, tier.approvals),
    presentationProfiles: boundedArray(snapshot.presentationProfiles, tier.presentationProfiles),
    registeredWorkflows: boundedArray(snapshot.registeredWorkflows, tier.registeredWorkflows),
    freshness: {
      ...freshness,
      snapshotTruncated: tier.name !== "full",
      snapshotTier: tier.name,
      includedCounts: {
        automations: tier.automations,
        schedules: tier.schedules,
        runs: tier.runs,
        approvals: tier.approvals,
        presentationProfiles: tier.presentationProfiles,
        registeredWorkflows: tier.registeredWorkflows
      }
    }
  };
}

function buildMinimalSnapshot(snapshot: SnapshotRecord): SnapshotRecord {
  const freshness = asRecord(snapshot.freshness);
  return {
    capturedAt: safeScalar(snapshot.capturedAt, ""),
    source: safeScalar(snapshot.source, "automation_os_control_plane_readback"),
    companyScope: boundedArray(snapshot.companyScope, 32),
    companies: compactRows(snapshot.companies, ["id", "name", "status", "role"], 32),
    automations: compactRows(snapshot.automations, ["id", "company_id", "name", "goal", "status", "revision", "schedule", "schedule_status", "next_run_at", "last_run_at", "lane", "risk_level", "approval_policy"], 16),
    schedules: compactRows(snapshot.schedules, ["id", "company_id", "automation_id", "expression", "timezone", "enabled", "status", "revision", "next_run_at", "last_run_at"], 16),
    runs: compactRows(snapshot.runs, ["id", "company_id", "automation_id", "name", "objective", "status", "created_at", "updated_at"], 12),
    approvals: compactRows(snapshot.approvals, ["id", "run_id", "status", "title", "created_at"], 12),
    presentationProfiles: compactRows(snapshot.presentationProfiles, ["id", "kind", "label", "source", "revision", "freshnessSlaMinutes", "browserUseLane", "stopBoundary", "primaryMetrics", "widgets", "preferredGrouping", "explanation"], 12),
    registeredWorkflows: compactRows(snapshot.registeredWorkflows, ["id", "name", "status", "schedule_label", "boundary_label", "needs_check", "check_kind", "trust_kind", "freshness_kind", "safety_kind", "last_action_label", "last_result_label", "next_action_label", "last_run_id", "next_action_view"], 16),
    worker: compactRecord(snapshot.worker, ["status", "label", "detail", "queue_depth", "active_leases", "heartbeat_at", "exact_blocker", "next_action", "external_action_executed"]),
    browserUse: compactRecord(snapshot.browserUse, ["status", "surface", "exact_blocker", "readback_status", "helper", "recording"]),
    freshness: {
      ...freshness,
      snapshotTruncated: true,
      snapshotTier: "minimal",
      includedCounts: { automations: 16, schedules: 16, runs: 12, approvals: 12, presentationProfiles: 12, registeredWorkflows: 16 }
    },
    boundaries: compactRecord(snapshot.boundaries, ["externalActionExecuted", "approvalRequired", "secretsIncluded", "rawPrivatePathsIncluded"])
  };
}

function boundedArray(value: unknown, limit: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function compactRows(value: unknown, keys: string[], limit: number): SnapshotRecord[] {
  return boundedArray(value, limit).map((item) => compactRecord(item, keys));
}

function compactRecord(value: unknown, keys: string[]): SnapshotRecord {
  const input = asRecord(value);
  const output: SnapshotRecord = {};
  for (const key of keys) {
    if (!(key in input)) continue;
    const field = input[key];
    if (Array.isArray(field)) {
      output[key] = field
        .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .slice(0, 16)
        .map((item) => typeof item === "string" ? redactSensitiveText(item).slice(0, 180) : item);
    } else if (typeof field === "string") {
      output[key] = redactSensitiveText(field).slice(0, 600);
    } else if (typeof field === "number" || typeof field === "boolean" || field === null) {
      output[key] = field;
    }
  }
  return output;
}

function asRecord(value: unknown): SnapshotRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SnapshotRecord : {};
}

function safeScalar(value: unknown, fallback: string): string {
  return typeof value === "string" ? redactSensitiveText(value).slice(0, 240) : fallback;
}
