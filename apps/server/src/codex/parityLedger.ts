import { trustedBridgeActions } from "../bridge/trustedBridge.js";
import { getCodexCapabilities } from "./capabilities.js";

export type CodexAppParityLedgerItem = {
  capability: string;
  currentSurface: string;
  status: "covered" | "covered_local" | "blocked" | "blocked_by_executor" | "gap";
  executionBoundary: string;
  latestProof: string;
  nextSafeAddition: string;
};

export type CodexAppParityLedger = {
  generatedAt: string;
  items: CodexAppParityLedgerItem[];
};

export type CodexParitySystemCheck = {
  id: string;
  kind?: string;
  status: string;
  artifact_uri?: string | null;
  summary: string;
  metadata_json: unknown;
};

export type CodexParityBridgeExecution = {
  id: string;
  capability_id: string;
  status: string;
  executor_status: string;
  summary: string;
  created_at: string;
  updated_at: string;
  metadata_json: unknown;
};

const protectedExternalCapabilityIds = new Set(
  trustedBridgeActions.filter((action) => action.riskLevel === "protected" || action.riskLevel === "external").map((action) => action.id)
);

const completionReceiptKeys = [
  "receipt",
  "receipt_uri",
  "receiptUri",
  "receipt_url",
  "receiptUrl",
  "artifact_uri",
  "artifactUri",
  "artifact_url",
  "artifactUrl",
  "proof_uri",
  "proofUri"
] as const;

export function buildCodexAppParityLedger(input: {
  capabilities: ReturnType<typeof getCodexCapabilities>;
  checks: CodexParitySystemCheck[];
  bridgeExecutions: CodexParityBridgeExecution[];
  generatedAt?: string;
}): CodexAppParityLedger {
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    items: buildCodexAppParityLedgerItems(input)
  };
}

export function buildCodexAppParityLedgerItems(input: {
  capabilities: ReturnType<typeof getCodexCapabilities>;
  checks: CodexParitySystemCheck[];
  bridgeExecutions: CodexParityBridgeExecution[];
}): CodexAppParityLedgerItem[] {
  const latestBrowserUseCheck = input.checks.find(isBrowserUseCliCheck);
  const latestLocalScreenCheck = input.checks.find((check) => !isBrowserUseCliCheck(check) && check.kind !== "local_codex_worker");
  const browserUseLedger = classifyBrowserUseCheck(latestBrowserUseCheck);
  const localScreenLedger = classifyLocalScreenCheck(latestLocalScreenCheck);
  const latestBridgeExecution = input.bridgeExecutions.find((execution) => protectedExternalCapabilityIds.has(execution.capability_id));
  const protectedExternalLedger = classifyProtectedExternalExecution(latestBridgeExecution);
  const summary = input.capabilities.summary;
  return [
    {
      capability: "Skills / Plugins / Automations",
      currentSurface: "Sources, Skills, Automation Control Panel, Skill Registry",
      status: "covered",
      executionBoundary: "read-only inventory; execution stays in registered workflows",
      latestProof: `skills=${summary.skills + summary.agentSkills}, plugins=${summary.plugins}, automations=${summary.automations}`,
      nextSafeAddition: "show stale or missing roots without executing anything"
    },
    {
      capability: "Browser Use local screen checks",
      currentSurface: "Sources, system_checks, Browser Use result panel",
      status: browserUseLedger.status,
      executionBoundary: "local URL only; unique sessions clean up; CDP/profile lanes are preserved",
      latestProof: browserUseLedger.latestProof,
      nextSafeAddition: "keep blocked and artifact-missing checks visible instead of promoting them"
    },
    {
      capability: "Local screen checks",
      currentSurface: "Sources, system_checks, Proof Inbox",
      status: localScreenLedger.status,
      executionBoundary: "local URL only; proof is DOM snapshot, screenshot, and console artifact",
      latestProof: localScreenLedger.latestProof,
      nextSafeAddition: "show latest check age and console error count"
    },
    {
      capability: "Protected external actions",
      currentSurface: "Approvals, Trusted Bridge executor ledger",
      status: protectedExternalLedger.status,
      executionBoundary: "approval is not execution; executor receipt must prove completion",
      latestProof: protectedExternalLedger.latestProof,
      nextSafeAddition: "keep approval separate from executor completion proof"
    },
    {
      capability: "Git / terminal / worktree / cloud threads / Computer Use / IDE sync",
      currentSurface: "Sources and Obsidian ledger as read-only audit rows only",
      status: "gap",
      executionBoundary: "read-only audit row; not an executor connection; no Git, terminal, worktree, cloud, Computer Use, or IDE writes",
      latestProof: "gap row only; no executor connected",
      nextSafeAddition: "add read-only audit rows first; keep executor wiring out until a separate trusted executor contract exists"
    },
    {
      capability: "Obsidian control surface",
      currentSurface: "Sources, generated vault notes",
      status: "covered",
      executionBoundary: "generated files only; handwritten notes are preserved",
      latestProof: "obsidian export status JSON and generated markdown frontmatter",
      nextSafeAddition: "include this parity ledger in recurring export verification"
    }
  ];
}

function classifyLocalScreenCheck(check: CodexParitySystemCheck | undefined): Pick<CodexAppParityLedgerItem, "status" | "latestProof"> {
  if (!check) return { status: "gap", latestProof: "none" };
  const artifactUri = check.artifact_uri ?? "none";
  const latestProof = [
    `id=${check.id}`,
    `status=${check.status}`,
    `artifact_uri=${artifactUri}`,
    `summary=${shortSnippet(check.summary, 160)}`
  ].join(", ");
  if (check.status === "ok" && Boolean(check.artifact_uri)) {
    return { status: "covered_local", latestProof };
  }
  if (check.status === "blocked") return { status: "blocked", latestProof };
  return { status: "gap", latestProof };
}

function isBrowserUseCliCheck(check: CodexParitySystemCheck): boolean {
  const metadata = readSystemCheckMetadata(check);
  return metadata.driver === "browser_use_cli";
}

function classifyBrowserUseCheck(check: CodexParitySystemCheck | undefined): Pick<CodexAppParityLedgerItem, "status" | "latestProof"> {
  if (!check) return { status: "gap", latestProof: "none" };
  const metadata = readSystemCheckMetadata(check);
  const cleanupStatus = metadata.cleanupStatus ?? "none";
  const cleanupReason = metadata.cleanupReason ?? "none";
  const artifactUri = check.artifact_uri ?? "none";
  const latestProof = [
    `id=${check.id}`,
    `status=${check.status}`,
    `artifact_uri=${artifactUri}`,
    `cleanup.status=${cleanupStatus}`,
    `cleanup.reason=${cleanupReason}`,
    `summary=${shortSnippet(check.summary, 160)}`
  ].join(", ");
  const hasAcceptedCleanup =
    cleanupStatus === "ok" ||
    cleanupStatus === "completed" ||
    cleanupReason === "cdp_profile_lane_preserved" ||
    cleanupReason === "cdp_profile_lane_is_owned_by_external_browser";
  if (check.status === "ok" && Boolean(check.artifact_uri) && hasAcceptedCleanup) {
    return { status: "covered_local", latestProof };
  }
  if (check.status === "blocked") return { status: "blocked", latestProof };
  return { status: "gap", latestProof };
}

function readSystemCheckMetadata(check: CodexParitySystemCheck): {
  driver: string;
  cleanupStatus?: string;
  cleanupReason?: string;
} {
  const metadata = parseRecord(check.metadata_json);
  const nestedMetadata = parseRecord(metadata.metadata);
  const cleanup = parseRecord(nestedMetadata.cleanup ?? metadata.cleanup);
  return {
    driver: String(nestedMetadata.driver ?? metadata.driver ?? ""),
    cleanupStatus: optionalLowerString(cleanup.status),
    cleanupReason: optionalLowerString(cleanup.reason)
  };
}

function classifyProtectedExternalExecution(
  execution: CodexParityBridgeExecution | undefined
): Pick<CodexAppParityLedgerItem, "status" | "latestProof"> {
  if (!execution) return { status: "gap", latestProof: "none" };
  const status = execution.status.toLowerCase();
  const executorStatus = execution.executor_status.toLowerCase();
  const receipt = findCompletionReceipt(parseRecord(execution.metadata_json));
  const latestProof = [
    `id=${execution.id}`,
    `capability_id=${execution.capability_id}`,
    `status=${execution.status}`,
    `executor_status=${execution.executor_status}`,
    `receipt=${receipt ? shortSnippet(formatMetadataValue(receipt.value), 160) : "missing"}`,
    `updated_at=${execution.updated_at}`,
    `created_at=${execution.created_at}`,
    `summary=${shortSnippet(execution.summary, 160)}`
  ].join(", ");
  if (status === "completed" && executorStatus === "connected" && receipt) {
    return { status: "covered", latestProof };
  }
  if (status === "blocked" || executorStatus !== "connected" || (status === "completed" && executorStatus === "connected" && !receipt)) {
    return { status: "blocked_by_executor", latestProof };
  }
  return { status: "gap", latestProof };
}

function findCompletionReceipt(metadata: Record<string, unknown>): { key: string; value: unknown } | undefined {
  const nestedMetadata = parseRecord(metadata.metadata);
  for (const source of [metadata, nestedMetadata]) {
    for (const key of completionReceiptKeys) {
      if (hasReceiptValue(source[key])) return { key, value: source[key] };
    }
  }
  return undefined;
}

function hasReceiptValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== "string" || value.trim() !== "");
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return parseJson<Record<string, unknown>>(value, {});
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalLowerString(value: unknown): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function shortSnippet(value: unknown, maxLength: number): string {
  const raw = formatMetadataValue(value)
    .replace(/\s+/g, " ")
    .trim();
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(0, maxLength - 1))}...`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
