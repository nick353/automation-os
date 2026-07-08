import { insert, makeId, nowIso } from "../db/client.js";
import { createApprovalRequest } from "../runs/approvalGate.js";

export type BridgeActionStatus = "ready" | "approval_required" | "requires_codex_runtime" | "unavailable";
export type BridgeActionRisk = "safe" | "protected" | "external";

export type TrustedBridgeAction = {
  id: string;
  label: string;
  category: string;
  status: BridgeActionStatus;
  riskLevel: BridgeActionRisk;
  visibleSummary: string;
  backendSummary: string;
  buttonLabel: string;
};

export type BridgeActionReceipt = {
  id: string;
  capabilityId: string;
  label: string;
  status: "ok" | "blocked" | "approval_required";
  riskLevel: BridgeActionRisk;
  target?: string;
  summary: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export const trustedBridgeActions: TrustedBridgeAction[] = [
  {
    id: "local_browser_check",
    label: "画面を開いて確認",
    category: "browser",
    status: "ready",
    riskLevel: "safe",
    visibleSummary: "このアプリの画面をPlaywright CLI primaryとして確認します。",
    backendSummary: "Primary local check: Playwright CLIでlocal URLだけを開き、DOM snapshot、screenshot、console logをsystem_checksへ保存します。現在のlocal UI completion proofはPlaywright-owned artifact readbackです。",
    buttonLabel: "確認"
  },
  {
    id: "browser_use_local_check",
    label: "Browser Useで確認",
    category: "browser",
    status: "ready",
    riskLevel: "safe",
    visibleSummary: "Browser Use CLIでローカル画面の録画/Gemini診断を記録します。",
    backendSummary: "Diagnostic recording path: browser-use --session <unique> open/state/screenshot/close をlocal URLだけに実行し、recording/Gemini metadataをsystem_checksとbridge receiptへ保存します。Recording/Geminiは補助 proof または completion veto であり、通常のlocal UI completion proofはPlaywright CLIです。",
    buttonLabel: "確認"
  },
  {
    id: "codex_inventory",
    label: "Codex機能を確認",
    category: "codex",
    status: "ready",
    riskLevel: "safe",
    visibleSummary: "使えるスキル、プラグイン、自動化を一覧化します。",
    backendSummary: "ローカルのCodex/Agent skill、plugin cache、automation.tomlをread-onlyでscanします。",
    buttonLabel: "確認"
  },
  {
    id: "obsidian_export",
    label: "Obsidianを更新",
    category: "knowledge",
    status: "ready",
    riskLevel: "safe",
    visibleSummary: "実行履歴と証拠をObsidianの知識ベースに反映します。",
    backendSummary: "generated_by marker付きMarkdownのみを安全に更新し、既存生成物はbackupします。",
    buttonLabel: "更新"
  },
  {
    id: "second_brain_process",
    label: "Second Brainを処理",
    category: "knowledge",
    status: "ready",
    riskLevel: "safe",
    visibleSummary: "明示opt-inされたObsidianノートだけを内部メタデータ更新します。",
    backendSummary: "Second Brain processorをapplyで実行し、frontmatter/internal fieldsだけを更新します。move/rename/delete/external writeは行いません。",
    buttonLabel: "処理"
  },
  {
    id: "chrome_authenticated_action",
    label: "ログイン済みChrome操作",
    category: "browser",
    status: "ready",
    riskLevel: "protected",
    visibleSummary: "ログインが必要な外部サイトを操作します。課金・購入・支払い・決済だけ停止します。",
    backendSummary: "Chrome extension/profile laneが必要。投稿・送信・公開・削除はstage evidence/readbackを残して進め、billing/purchase/payment/checkoutだけ停止する。",
    buttonLabel: "準備"
  },
  {
    id: "gmail_drive_calendar_action",
    label: "Gmail/Drive/Calendar操作",
    category: "connector",
    status: "ready",
    riskLevel: "protected",
    visibleSummary: "メール、ファイル、予定を扱う操作です。課金・購入・支払い・決済だけ停止します。",
    backendSummary: "Connector actionはsource-of-truth確認から始め、send/create/update/deleteはstage evidence/readbackを残して進め、billing/purchase/payment/checkoutだけ停止する。",
    buttonLabel: "準備"
  },
  {
    id: "supabase_shopify_external_action",
    label: "外部システム変更",
    category: "connector",
    status: "ready",
    riskLevel: "external",
    visibleSummary: "DBやショップ設定を変える操作です。課金・購入・支払い・決済だけ停止します。",
    backendSummary: "Schema/data/store mutations require stage evidence/readback and cleanup proof. The bridge stops only at billing/purchase/payment/checkout.",
    buttonLabel: "準備"
  }
];

export function listTrustedBridgeActions(): TrustedBridgeAction[] {
  return trustedBridgeActions;
}

export function findTrustedBridgeAction(id: string): TrustedBridgeAction | undefined {
  return trustedBridgeActions.find((action) => action.id === id);
}

export function createBridgeReceipt(input: {
  action: TrustedBridgeAction;
  status: BridgeActionReceipt["status"];
  summary: string;
  target?: string;
  metadata?: Record<string, unknown>;
}): BridgeActionReceipt {
  const createdAt = nowIso();
  return {
    id: makeId("bridge"),
    capabilityId: input.action.id,
    label: input.action.label,
    status: input.status,
    riskLevel: input.action.riskLevel,
    target: input.target,
    summary: input.summary,
    createdAt,
    metadata: {
      category: input.action.category,
      visibleSummary: input.action.visibleSummary,
      backendSummary: input.action.backendSummary,
      ...(input.metadata ?? {})
    }
  };
}

export function storeBridgeReceipt(receipt: BridgeActionReceipt): BridgeActionReceipt {
  insert("bridge_actions", {
    id: receipt.id,
    capability_id: receipt.capabilityId,
    label: receipt.label,
    status: receipt.status,
    risk_level: receipt.riskLevel,
    target: receipt.target ?? null,
    summary: receipt.summary,
    created_at: receipt.createdAt,
    metadata_json: receipt.metadata
  });
  return receipt;
}

export function createProtectedBridgeApproval(action: TrustedBridgeAction): BridgeActionReceipt {
  const approval = createApprovalRequest({
    title: `Bridge billing confirmation: ${action.label}`,
    requestedBy: "trusted-bridge",
    resourceLocks: [`bridge:${action.id}`, action.category],
    approvalGroupId: `bridge_${action.id}`,
    priority: "high"
  });
  insert("approvals", {
    id: approval.id,
    run_id: null,
    title: approval.title,
    requested_by: approval.requestedBy,
    status: approval.status,
    priority: approval.priority,
    approval_group_id: approval.approvalGroupId,
    resource_locks_json: approval.resourceLocks,
    created_at: approval.createdAt,
    decided_at: null,
    decision_note: null
  });
  return storeBridgeReceipt(
    createBridgeReceipt({
      action,
      status: "approval_required",
      summary: `${action.label} は課金・購入・支払い・決済の確認待ちとして記録しました。課金系以外の外部操作は証跡付きで進めます。`,
      metadata: {
        approvalId: approval.id,
        protected: true,
        policyDecision: "billing_confirmation_required",
        operation: action.id,
        executorStatus: "not_started"
      }
    })
  );
}
