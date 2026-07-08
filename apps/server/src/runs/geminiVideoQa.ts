import { pathToFileURL } from "node:url";
import { Proof } from "./proofGate.js";

export type GeminiVideoQaAudit = {
  proofs: Proof[];
  blockers: string[];
  metadata: {
    auditor: "gemini_video_qa";
    status: "absent" | "present" | "blocked";
    audit_count: number;
    blocker_count: number;
    blockers: string[];
    stage_ledger: GeminiVideoQaStageLedgerEntry[];
  };
};

export type GeminiVideoQaStageLedgerEntry = {
  source_key: string;
  stage?: string;
  status?: string;
  verdict?: string;
  completion_gate_alignment?: string;
  completion_gate_matches?: boolean;
  exact_blocker?: string;
  repair_owner?: string;
  artifact_uri?: string;
  video_artifact_uri?: string;
  auxiliary_proof: boolean;
  completion_claimed: boolean;
  contradicts_completion: boolean;
};

type AuditSource = {
  sourceKey: string;
  value: unknown;
  geminiScoped: boolean;
};

type NormalizedAudit = {
  sourceKey: string;
  stage: string;
  status: string;
  verdict: string;
  completionGateAlignment: string;
  exactBlocker: string;
  repairOwner: string;
  artifactUri: string;
  videoArtifactUri: string;
  summary: string;
  raw: Record<string, unknown>;
};

const auditKeys = ["gemini_video_qa", "geminiVideoQa", "visual_audit", "visualAudit", "stage_visual_audits", "stageVisualAudits"] as const;
const nestedAuditKeys = ["audits", "stages", "stage_audits", "stageAudits", "results"] as const;

export function evaluateGeminiVideoQaAudit(input: {
  summary: Record<string, unknown>;
  summaryPath: string;
  workflow: string;
  completionClaimed: boolean;
}): GeminiVideoQaAudit {
  const normalized = collectAuditSources(input.summary)
    .flatMap((source) => normalizeAuditSource(source));
  const uniqueAudits = dedupeNormalizedAudits(normalized);

  if (uniqueAudits.length === 0) {
    return {
      proofs: [],
      blockers: [],
      metadata: {
        auditor: "gemini_video_qa",
        status: "absent",
        audit_count: 0,
        blocker_count: 0,
        blockers: [],
        stage_ledger: []
      }
    };
  }

  const stageLedger = uniqueAudits.map((audit) => buildStageLedgerEntry(audit, input.completionClaimed));
  const blockers = uniqueAudits
    .filter((audit) => input.completionClaimed && auditContradictsCompletion(audit))
    .map((audit) => audit.exactBlocker || `gemini_video_qa_completion_alignment:${audit.stage || "unknown_stage"}`);

  const summaryUri = pathToFileURL(input.summaryPath).href;
  const proofs = uniqueAudits.map((audit, index) => ({
    proofType: "gemini_video_qa",
    label: `Gemini video QA visual audit${audit.stage ? `: ${audit.stage}` : ""}`,
    uri: audit.artifactUri || audit.videoArtifactUri || summaryUri,
    metadata: {
      source: "gemini_video_qa",
      workflow: input.workflow,
      summary_path: input.summaryPath,
      summary_uri: summaryUri,
      audit_index: index,
      source_key: audit.sourceKey,
      stage: audit.stage || undefined,
      status: audit.status || undefined,
      verdict: audit.verdict || undefined,
      completion_gate_alignment: audit.completionGateAlignment || undefined,
      exact_blocker: audit.exactBlocker || undefined,
      repair_owner: audit.repairOwner || undefined,
      video_artifact_uri: audit.videoArtifactUri || undefined,
      artifact_uri: audit.artifactUri || undefined,
      completion_claimed: input.completionClaimed,
      contradicts_completion: auditContradictsCompletion(audit),
      auxiliary_proof: true,
      normalized_stage_ledger: stageLedger[index],
      summary: audit.summary || undefined
    }
  }));

  return {
    proofs,
    blockers,
    metadata: {
      auditor: "gemini_video_qa",
      status: blockers.length > 0 ? "blocked" : "present",
      audit_count: uniqueAudits.length,
      blocker_count: blockers.length,
      blockers,
      stage_ledger: stageLedger
    }
  };
}

function dedupeNormalizedAudits(audits: NormalizedAudit[]): NormalizedAudit[] {
  const seen = new Set<string>();
  const unique: NormalizedAudit[] = [];
  for (const audit of audits) {
    const key = JSON.stringify([audit.stage, audit.artifactUri, audit.videoArtifactUri, audit.exactBlocker, audit.status]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(audit);
  }
  return unique;
}

function collectAuditSources(summary: Record<string, unknown>): AuditSource[] {
  return auditKeys
    .filter((key) => key in summary)
    .map((key) => ({
      sourceKey: key,
      value: summary[key],
      geminiScoped: key.toLowerCase().includes("gemini")
    }));
}

function normalizeAuditSource(source: AuditSource): NormalizedAudit[] {
  const values = expandAuditValues(source.value);
  const sourceGeminiScoped = source.geminiScoped || (isRecord(source.value) && auditMentionsGemini(source.value));
  return values
    .filter(isRecord)
    .map((value) => normalizeAudit(source.sourceKey, sourceGeminiScoped, value))
    .filter((audit): audit is NormalizedAudit => audit !== undefined);
}

function expandAuditValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(expandAuditValues);
  if (!isRecord(value)) return [];

  const nested = nestedAuditKeys.flatMap((key) => {
    const nestedValue = value[key];
    return Array.isArray(nestedValue) ? nestedValue.flatMap(expandAuditValues) : [];
  });
  if (nested.length > 0) return nested;
  return [value];
}

function normalizeAudit(sourceKey: string, geminiScoped: boolean, value: Record<string, unknown>): NormalizedAudit | undefined {
  if (!geminiScoped && !auditMentionsGemini(value)) return undefined;
  return {
    sourceKey,
    stage: stringValue(value.stage) || stringValue(value.stage_id) || stringValue(value.stageName),
    status: stringValue(value.status).toLowerCase(),
    verdict: stringValue(value.verdict || value.result || value.outcome).toLowerCase(),
    completionGateAlignment: stringValue(value.completion_gate_alignment || value.completionGateAlignment || value.gate_alignment).toLowerCase(),
    exactBlocker: stringValue(value.exact_blocker || value.exactBlocker || value.blocker),
    repairOwner: stringValue(value.repair_owner || value.repairOwner || value.owner),
    artifactUri: stringValue(value.artifact_uri || value.artifactUri || value.report_uri || value.reportUri),
    videoArtifactUri: stringValue(value.video_artifact_uri || value.videoArtifactUri || value.video_uri || value.videoUri),
    summary: stringValue(value.summary || value.notes),
    raw: value
  };
}

function auditMentionsGemini(value: Record<string, unknown>): boolean {
  const fields = [value.provider, value.model, value.auditor, value.source, value.tool].map(stringValue).join(" ").toLowerCase();
  return fields.includes("gemini");
}

function auditContradictsCompletion(audit: NormalizedAudit): boolean {
  if (audit.completionGateAlignment && /mismatch|conflict|failed/.test(audit.completionGateAlignment)) return true;
  if (/failed|blocked|mismatch|conflict/.test(audit.status)) return true;
  if (/failed|blocked|mismatch|conflict/.test(audit.verdict)) return true;
  const completionGateMatches = audit.raw.completion_gate_matches ?? audit.raw.completionGateMatches ?? audit.raw.completion_matches;
  return completionGateMatches === false;
}

function buildStageLedgerEntry(audit: NormalizedAudit, completionClaimed: boolean): GeminiVideoQaStageLedgerEntry {
  return {
    source_key: audit.sourceKey,
    stage: audit.stage || undefined,
    status: audit.status || undefined,
    verdict: audit.verdict || undefined,
    completion_gate_alignment: audit.completionGateAlignment || undefined,
    completion_gate_matches: booleanValue(audit.raw.completion_gate_matches ?? audit.raw.completionGateMatches ?? audit.raw.completion_matches),
    exact_blocker: audit.exactBlocker || undefined,
    repair_owner: audit.repairOwner || undefined,
    artifact_uri: audit.artifactUri || undefined,
    video_artifact_uri: audit.videoArtifactUri || undefined,
    auxiliary_proof: true,
    completion_claimed: completionClaimed,
    contradicts_completion: auditContradictsCompletion(audit)
  };
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
