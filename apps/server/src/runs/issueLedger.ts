import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function issueLedgerMetadata(summary: Record<string, unknown>, summaryPath?: string): Record<string, unknown> {
  const records = collectIssueLedgerRecords(summary, summaryPath);
  if (records.length === 0) return {};
  const latest = records[records.length - 1];
  const policy = isRecord(latest.policy) ? latest.policy : {};
  const ledgerPath = summaryPath ? join(dirname(summaryPath), "issue-ledger.jsonl") : "";
  const ledgerUri = ledgerPath && existsSync(ledgerPath) ? pathToFileURL(ledgerPath).href : undefined;
  return {
    issue_ledger_summary: {
      count: records.length,
      latest_blocker: stringValue(latest.blocker_reason) || stringValue(latest.exact_blocker) || stringValue(latest.stop_reason),
      latest_stage: stringValue(latest.stage) || stringValue(latest.current_stage),
      next_safe_action: stringValue(policy.next_safe_action) || stringValue(latest.next_action),
      human_required: booleanValue(policy.human_required),
      external_create_allowed: booleanValue(policy.external_create_allowed),
      repost_allowed: booleanValue(policy.repost_allowed),
      resubmit_allowed: booleanValue(policy.resubmit_allowed),
      issue_ledger_uri: ledgerUri
    }
  };
}

function collectIssueLedgerRecords(summary: Record<string, unknown>, summaryPath?: string): Record<string, unknown>[] {
  const records = recordsFromValue(summary.issue_ledger);
  const ledgerPath = summaryPath ? join(dirname(summaryPath), "issue-ledger.jsonl") : "";
  if (ledgerPath && existsSync(ledgerPath)) records.push(...recordsFromJsonl(ledgerPath));
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordsFromValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordsFromJsonl(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isRecord);
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
