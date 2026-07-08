import { makeId, nowIso } from "../db/client.js";

const billingHardStopWords = [
  "billing",
  "purchase",
  "payment",
  "checkout",
  "paid",
  "subscription",
  "invoice",
  "課金",
  "購入",
  "支払い",
  "決済",
  "請求"
];

export type ApprovalRequest = {
  id: string;
  runId?: string;
  title: string;
  requestedBy: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  priority: "low" | "medium" | "high";
  approvalGroupId: string;
  resourceLocks: string[];
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
};

export function requiresApproval(input: { action: string; resources?: string[]; dangerousAction?: boolean }): boolean {
  const haystack = `${input.action} ${(input.resources ?? []).join(" ")}`
    .toLowerCase()
    .replace(/billing[-_\s]*only/g, "policy")
    .replace(/billing[-_\s]*purchase[-_\s]*payment[-_\s]*checkout[-_\s]*hard[-_\s]*stop/g, "policy")
    .replace(/billing[-_\s]*only[-_\s]*hard[-_\s]*stop/g, "policy")
    .replace(/課金停止/g, "policy")
    .replace(/課金・購入・支払い・決済だけ停止/g, "policy");
  return billingHardStopWords.some((word) => haystack.includes(word));
}

export function createApprovalRequest(input: {
  runId?: string;
  title: string;
  requestedBy?: string;
  resourceLocks?: string[];
  approvalGroupId?: string;
  priority?: ApprovalRequest["priority"];
}): ApprovalRequest {
  return {
    id: makeId("app"),
    runId: input.runId,
    title: input.title,
    requestedBy: input.requestedBy ?? "system",
    status: "pending",
    priority: input.priority ?? "medium",
    approvalGroupId: input.approvalGroupId ?? makeId("approval_group"),
    resourceLocks: input.resourceLocks ?? [],
    createdAt: nowIso()
  };
}

export function decideApproval(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "cancelled",
  note?: string
): ApprovalRequest {
  if (approval.status !== "pending") {
    throw new Error(`Approval ${approval.id} is already ${approval.status}`);
  }
  return {
    ...approval,
    status: decision,
    decidedAt: nowIso(),
    decisionNote: note
  };
}
