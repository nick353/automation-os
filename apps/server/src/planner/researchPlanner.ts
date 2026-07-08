import { execSql, insert, makeId, nowIso, querySql, sqlValue, type SqlValue } from "../db/client.js";

export type ResearchSourceKey = "web" | "x" | "reddit" | "youtube" | "mcp" | "api";

export type ResearchSourcePlan = {
  key: ResearchSourceKey;
  label: string;
  enabled: boolean;
  mode: string;
  boundary: string;
  metadata: Record<string, unknown>;
};

export type ResearchPlanSnapshot = {
  id: string;
  title: string;
  status: string;
  command: string;
  sources: ResearchSourcePlan[];
  visibleFlow: string[];
  sourceOfTruth: string[];
  proofBoundary: string[];
  approvalBoundary: string[];
  metadata: Record<string, unknown>;
  demoCheckId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateResearchPlanInput = {
  command?: string;
  title?: string;
  sources?: Partial<Record<ResearchSourceKey, boolean>>;
  visibleFlow?: string[];
};

type ResearchPlanRow = {
  id: string;
  title: string;
  status: string;
  command: string;
  sources_json: string;
  visible_flow_json: string;
  source_of_truth_json: string;
  proof_boundary_json: string;
  approval_boundary_json: string;
  metadata_json: string;
  demo_check_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
};

const sourcePolicies: Record<ResearchSourceKey, Omit<ResearchSourcePlan, "enabled">> = {
  web: {
    key: "web",
    label: "Web",
    mode: "公開Webをブラウザで読む",
    boundary: "公開ページの表示内容とURLをsource-of-truthにする",
    metadata: { defaultTooling: "browser_readonly", apiBillingRequired: false }
  },
  x: {
    key: "x",
    label: "X",
    mode: "専用ブラウザ/CDP/Google profileで見える範囲をread-only確認",
    boundary: "API課金前提にせず、見えている投稿・URL・スクリーン状態を正本候補にする",
    metadata: { defaultTooling: "dedicated_browser_cdp_profile", apiBillingRequired: false, readOnly: true }
  },
  reddit: {
    key: "reddit",
    label: "Reddit",
    mode: "ブラウザで公開スレッドをread-only確認",
    boundary: "API課金前提にせず、見えている投稿・コメント・URLを正本候補にする",
    metadata: { defaultTooling: "browser_readonly", apiBillingRequired: false, readOnly: true }
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
    mode: "公式Show transcript/公開字幕をブラウザで読む",
    boundary: "Data API captions.downloadは認可が必要なため初期実装では使わない",
    metadata: {
      defaultTooling: "browser_show_transcript",
      apiBillingRequired: false,
      captionsDownload: "not_used_initially",
      captionsDownloadReason: "requires_authorization",
      readOnly: true
    }
  },
  mcp: {
    key: "mcp",
    label: "MCP",
    mode: "利用可能なMCP/connectorをread-only inventoryとして確認",
    boundary: "課金・購入・支払い・決済だけ既存approval flowへ分離する",
    metadata: { defaultTooling: "mcp_readonly_inventory", billingOnlyHardStop: true, apiBillingRequired: false }
  },
  api: {
    key: "api",
    label: "API",
    mode: "既存の保存済み認証と公式API契約を確認してから使う",
    boundary: "課金・購入・支払い・決済が必要なAPIだけ既存approval flowへ分離する",
    metadata: { defaultTooling: "optional_api_after_contract_check", billingOnlyHardStop: true, apiBillingRequired: false }
  }
};

const defaultSourceSelection: Record<ResearchSourceKey, boolean> = {
  web: true,
  x: true,
  reddit: true,
  youtube: true,
  mcp: false,
  api: false
};

export function createResearchPlan(input: CreateResearchPlanInput): ResearchPlanSnapshot {
  const now = nowIso();
  const command = normalizeCommand(input.command);
  const plan = buildResearchPlanSnapshot({
    id: makeId("research_plan"),
    title: normalizeTitle(input.title, command),
    status: "planned",
    command,
    sources: input.sources,
    visibleFlow: input.visibleFlow,
    demoCheckId: null,
    runId: null,
    createdAt: now,
    updatedAt: now
  });

  insert("research_plans", toResearchPlanInsertRow(plan));
  return plan;
}

export function listResearchPlans(limit = 8): ResearchPlanSnapshot[] {
  return querySql<ResearchPlanRow>(`SELECT * FROM research_plans ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`).map(
    researchPlanFromRow
  );
}

export function getResearchPlan(planId: string): ResearchPlanSnapshot | undefined {
  const row = querySql<ResearchPlanRow>(`SELECT * FROM research_plans WHERE id=${sqlValue(planId)} LIMIT 1`)[0];
  return row ? researchPlanFromRow(row) : undefined;
}

export function markResearchPlanDemoed(planId: string, demoCheckId: string, demoStatus: string): ResearchPlanSnapshot | undefined {
  const plan = getResearchPlan(planId);
  if (!plan) return undefined;
  const updatedAt = nowIso();
  const metadata = {
    ...plan.metadata,
    latestDemo: {
      systemCheckId: demoCheckId,
      status: demoStatus,
      boundary: "local_browser_use_check_only",
      externalOperation: false,
      note: "Demo checks only the local Automation OS screen. It does not operate external websites."
    }
  };
  execSql(
    `UPDATE research_plans
     SET status=${sqlValue("demoed")},
         demo_check_id=${sqlValue(demoCheckId)},
         updated_at=${sqlValue(updatedAt)},
         metadata_json=${sqlValue(metadata)}
     WHERE id=${sqlValue(planId)};`
  );
  return getResearchPlan(planId);
}

export function markResearchPlanStarted(planId: string, runId: string): ResearchPlanSnapshot | undefined {
  const plan = getResearchPlan(planId);
  if (!plan) return undefined;
  const updatedAt = nowIso();
  const metadata = {
    ...plan.metadata,
    startedRunId: runId,
    snapshotRole: "pre_start_plan_evidence_not_completion_proof"
  };
  execSql(
    `UPDATE research_plans
     SET status=${sqlValue("started")},
         run_id=${sqlValue(runId)},
         updated_at=${sqlValue(updatedAt)},
         metadata_json=${sqlValue(metadata)}
     WHERE id=${sqlValue(planId)};`
  );
  return getResearchPlan(planId);
}

export function markResearchPlanSourceCapture(
  planId: string,
  sourceKey: ResearchSourceKey,
  capture: {
    status: string;
    ok: boolean;
    proofId?: string;
    artifactPath?: string;
    exactBlocker?: string;
    summary?: string;
  }
): ResearchPlanSnapshot | undefined {
  const plan = getResearchPlan(planId);
  if (!plan) return undefined;
  const updatedAt = nowIso();
  const latestCaptures =
    typeof plan.metadata.latestCaptures === "object" && plan.metadata.latestCaptures
      ? plan.metadata.latestCaptures as Record<string, unknown>
      : {};
  execSql(
    `UPDATE research_plans
     SET updated_at=${sqlValue(updatedAt)},
         metadata_json=${sqlValue({
           ...plan.metadata,
           latestCaptures: {
             ...latestCaptures,
             [sourceKey]: {
               ...capture,
               capturedAt: updatedAt,
               proofState: capture.ok ? "proof_saved" : capture.status
             }
           }
         })}
     WHERE id=${sqlValue(planId)};`
  );
  return getResearchPlan(planId);
}

export function buildResearchPlanSnapshot(input: {
  id: string;
  title: string;
  status: string;
  command: string;
  sources?: Partial<Record<ResearchSourceKey, boolean>>;
  visibleFlow?: string[];
  demoCheckId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}): ResearchPlanSnapshot {
  const sources = (Object.keys(sourcePolicies) as ResearchSourceKey[]).map((key) => ({
    ...sourcePolicies[key],
    enabled: input.sources?.[key] ?? defaultSourceSelection[key]
  }));
  const enabledLabels = sources.filter((source) => source.enabled).map((source) => source.label);
  const defaultVisibleFlow = [
    "調査対象を確認",
    enabledLabels.length ? `${enabledLabels.join(" / ")} をread-onlyで見る` : "ローカル計画だけを確認",
    "source-of-truthとproof boundaryを確認",
    "課金・購入・支払い・決済だけ停止",
    "開始"
  ];
  return {
    id: input.id,
    title: input.title,
    status: input.status,
    command: input.command,
    sources,
    visibleFlow: sanitizeVisibleFlow(input.visibleFlow, defaultVisibleFlow),
    sourceOfTruth: [
      "公開ページ、公式UI、保存済みローカルartifact、Automation OS DBを正本候補にする",
      "X/YouTube/RedditはAPI課金前提にせず、専用ブラウザ/CDP/Google profileで見える内容を優先する",
      "YouTube台本は公式Show transcript/公開字幕をブラウザで読む"
    ],
    proofBoundary: [
      "research_plan_snapshotは開始前計画証跡であり完了証跡ではない",
      "完了にはrun/proof/artifact/DB/readbackの別証跡が必要",
      "WebはURL capture成功時だけreadable_source_snapshot proof、YouTubeはcapture成功時だけvisible_source_snapshot proofとして保存する",
      "demoはローカルAutomation OS画面のBrowser Use checkだけを証跡化する"
    ],
    approvalBoundary: [
      "課金・購入・支払い・決済だけhard stopにする",
      "送信、投稿、削除、応募、保存、外部サービス書き込みは証跡を残して実行する",
      "Data API captions.downloadは認可が必要なので初期実装では使わない",
      "MCP/APIで課金、購入、支払い、決済が必要な場合だけ既存approval flowへ分離する"
    ],
    metadata: {
      plannerVersion: "research_planner_v1",
      snapshotRole: "pre_start_plan_evidence_not_completion_proof",
      externalOperationInDemo: false,
      youtubeTranscriptPolicy: "browser_show_transcript_or_public_captions_first",
      youtubeCaptionsDownloadPolicy: "not_used_initially_requires_authorization",
      xRedditYoutubeApiBillingPolicy: "not_required_for_initial_readonly_research"
    },
    demoCheckId: input.demoCheckId,
    runId: input.runId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

export function researchPlanFromRow(row: ResearchPlanRow): ResearchPlanSnapshot {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    command: row.command,
    sources: normalizeResearchPlanSources(parseJson<ResearchSourcePlan[]>(row.sources_json, [])),
    visibleFlow: parseJson<string[]>(row.visible_flow_json, []),
    sourceOfTruth: parseJson<string[]>(row.source_of_truth_json, []),
    proofBoundary: parseJson<string[]>(row.proof_boundary_json, []),
    approvalBoundary: normalizeResearchPlanApprovalBoundary(parseJson<string[]>(row.approval_boundary_json, [])),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    demoCheckId: row.demo_check_id,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeResearchPlanSources(sources: ResearchSourcePlan[]): ResearchSourcePlan[] {
  return sources.map((source) => {
    if (source.key !== "mcp" && source.key !== "api") return source;
    const { externalWritesRequireApproval: _externalWritesRequireApproval, ...metadata } = source.metadata;
    return {
      ...source,
      boundary:
        source.key === "mcp"
          ? "課金・購入・支払い・決済だけ既存approval flowへ分離する"
          : "課金・購入・支払い・決済が必要なAPIだけ既存approval flowへ分離する",
      metadata: {
        ...metadata,
        billingOnlyHardStop: true,
        apiBillingRequired: Boolean(metadata.apiBillingRequired)
      }
    };
  });
}

function normalizeResearchPlanApprovalBoundary(boundary: string[]): string[] {
  if (
    boundary.length === 0
    || boundary.some((line) => /計画だけでは実行しない|課金、認可、外部書き込み/.test(line))
  ) {
    return [
      "課金・購入・支払い・決済だけhard stopにする",
      "送信、投稿、削除、応募、保存、外部サービス書き込みは証跡を残して実行する",
      "Data API captions.downloadは認可が必要なので初期実装では使わない",
      "MCP/APIで課金、購入、支払い、決済が必要な場合だけ既存approval flowへ分離する"
    ];
  }
  return boundary;
}

function toResearchPlanInsertRow(plan: ResearchPlanSnapshot): Record<string, SqlValue> {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    command: plan.command,
    sources_json: plan.sources,
    visible_flow_json: plan.visibleFlow,
    source_of_truth_json: plan.sourceOfTruth,
    proof_boundary_json: plan.proofBoundary,
    approval_boundary_json: plan.approvalBoundary,
    metadata_json: plan.metadata,
    demo_check_id: plan.demoCheckId,
    run_id: plan.runId,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt
  };
}

function normalizeCommand(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "Research Planner read-only investigation";
}

function normalizeTitle(value: unknown, command: string): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  return command.slice(0, 72) || "Research Planner";
}

function sanitizeVisibleFlow(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const visibleFlow = value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim().slice(0, 120)] : []);
  return visibleFlow.length ? visibleFlow.slice(0, 12) : fallback;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
