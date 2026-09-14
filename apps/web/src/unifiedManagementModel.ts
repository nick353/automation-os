export type UserWorkStatus = "preparing" | "executed" | "completion_verified";

export type WorkDefinition = {
  id: string;
  companyId: string;
  name: string;
  automationId?: string;
  workflowId?: string;
  scheduleLabel?: string;
  nextRunAt?: string | null;
  status: UserWorkStatus;
  nextAction?: string;
};

export const USER_WORK_STATUS_LABEL: Record<UserWorkStatus, string> = {
  preparing: "準備中",
  executed: "実行済み",
  completion_verified: "完了確認済み",
};

export function userWorkStatusLabel(status: UserWorkStatus): string {
  return USER_WORK_STATUS_LABEL[status];
}

export function resolveUserWorkStatus(input: {
  readbackReady?: boolean;
  runStatus?: string | null;
  businessCompletion?: boolean | null;
}): UserWorkStatus {
  if (!input.readbackReady) return "preparing";
  if (input.businessCompletion === true || ["complete", "completed", "success"].includes(String(input.runStatus ?? "").toLowerCase())) {
    return "completion_verified";
  }
  if (input.runStatus) return "executed";
  return "preparing";
}

export function unifiedManagementNavigation() {
  return [
    { label: "ホーム", route: "#/" },
    { label: "チャット", route: "#/chat" },
    { label: "会社 / 仕事", route: "#/projects" },
    { label: "履歴", route: "#/runs" },
    { label: "承認", route: "#/approvals" },
    { label: "設定・接続", route: "#/plugins" },
  ] as const;
}
