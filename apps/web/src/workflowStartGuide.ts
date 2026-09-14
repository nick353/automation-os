export const WORKFLOW_START_GUIDE_SCHEMA = "aos.workflow_start_guide.v1" as const;

export const WORKFLOW_START_GUIDE_IDS = [
  "email-review-reply",
  "daily-ai-research-publish-run",
  "nisenprints-daily-product-canva-printify-etsy-pinterest",
  "daily-backup-safety-check",
  "obsidian-project-memory-audit"
] as const;

export type WorkflowStartGuideId = typeof WORKFLOW_START_GUIDE_IDS[number];
export type WorkflowStartGuideState = "ready" | "needs_auth" | "needs_binding" | "needs_readback" | "needs_reconciliation" | "not_registered" | "ambiguous" | "company_mismatch";
export type WorkflowStartGuideExecutionGateInput = {
  status: "loading" | "ready" | "error";
  canRun: boolean;
  canPreflight: boolean;
  exactBlocker: string | null;
};
export type WorkflowStartGuideExecutionGate = {
  status: "unknown" | "ready" | "preflight_only" | "blocked";
  canRun: boolean;
  canPreflight: boolean;
  exactBlocker: string | null;
};

export type WorkflowStartGuideInput = {
  companyId: string | null | undefined;
  companyLabel?: string | null;
  auth?: { verified?: boolean; status?: string; exactBlocker?: string | null };
  worker?: { heartbeatFresh?: boolean; exactBlocker?: string | null; status?: string };
  runtime?: { status?: string; exactBlocker?: string | null };
  executionGate?: WorkflowStartGuideExecutionGateInput;
  automations?: readonly Record<string, unknown>[];
  /** The company-scoped registration API response, kept separate from saved guide records. */
  registeredAutomations?: readonly Record<string, unknown>[];
  /** Company-scoped provider account references, never secret material. */
  accountRefs?: readonly Record<string, unknown>[];
  registeredReadbackStatus?: "loading" | "ready" | "error";
  runs?: readonly Record<string, unknown>[];
};

export type WorkflowStartGuideRegistration = {
  id: string;
  name: string;
  canonicalWorkflowId: string | null;
  status: string | null;
  canRun: boolean;
  canPreflight: boolean;
  exactBlocker: string | null;
};

export type WorkflowStartGuideItem = {
  id: WorkflowStartGuideId;
  canonicalWorkflowId: WorkflowStartGuideId;
  label: string;
  description: string;
  route: string;
  requiresBrowser: boolean;
  state: WorkflowStartGuideState;
  statusLabel: string;
  nextAction: string;
  proofLabel: string;
  externalEffectLabel: string;
  companyEvidence: "company_scope_match" | "company_scope_missing" | "company_scope_mismatch";
  accountEvidence: "account_ref" | "account_unknown";
  connectionEvidence: "verified" | "available_unverified" | "missing" | "not_required" | "unknown";
  executionTarget: {
    state: "unknown" | "not_required" | "unbound" | "bound" | "company_mismatch" | "competing" | "revoked" | "scope_insufficient";
    connectionRefId: string | null;
    accountRef: string | null;
    exactBlocker: string | null;
    nextAction: string;
  };
  approvalRequirement: string;
  automationId: string | null;
  exactBlocker: string | null;
  bindingEvidence: "canonical_id" | "name_or_alias" | "missing" | "conflicting";
  candidateAutomations: Array<{ id: string; name: string; companyId: string | null; canonicalWorkflowId: string | null; status: string | null }>;
  localCheck: {
    supported: boolean;
    label: string;
    exactBlocker: string | null;
  };
  registrationStatus: "registered" | "not_present" | "loading" | "error";
  registeredAutomationId: string | null;
  registeredStatus: string | null;
  registeredCanRun: boolean;
  registeredCanPreflight: boolean;
  registeredExactBlocker: string | null;
  sameRunReadback?: {
    runId: string;
    status: string;
    runUpdatedAt: string;
    proofType: "same_run_receipt_readback";
  };
};

export type WorkflowStartGuide = {
  schema: typeof WORKFLOW_START_GUIDE_SCHEMA;
  companyId: string | null;
  companyLabel: string;
  authVerified: boolean;
  workerFresh: boolean;
  executionGate: WorkflowStartGuideExecutionGate;
  items: WorkflowStartGuideItem[];
  registeredAutomations: WorkflowStartGuideRegistration[];
  externalActionExecuted: false;
};

type Definition = Omit<WorkflowStartGuideItem, "state" | "statusLabel" | "nextAction" | "proofLabel" | "externalEffectLabel" | "automationId" | "exactBlocker" | "canonicalWorkflowId" | "bindingEvidence" | "candidateAutomations" | "companyEvidence" | "accountEvidence" | "connectionEvidence" | "executionTarget" | "registrationStatus" | "registeredAutomationId" | "registeredStatus" | "registeredCanRun" | "registeredCanPreflight" | "registeredExactBlocker" | "sameRunReadback"> & {
  aliases: readonly string[];
};

const definitions: readonly Definition[] = [
  {
    id: "email-review-reply",
    label: "Gmail",
    description: "メール分類・返信案・Calendar候補",
    route: "runs",
    requiresBrowser: false,
    localCheck: { supported: false, label: "ローカル限定チェック対象外", exactBlocker: "local_check_not_supported" },
    approvalRequirement: "provider操作は承認必須（送信前）",
    aliases: ["email-review-reply", "email-review", "メール確認・返信管理", "メール確認・返信管理（AOS approval対応）"]
  },
  {
    id: "daily-ai-research-publish-run",
    label: "Daily AI",
    description: "調査・queue・既存Sheets同期",
    route: "runs",
    requiresBrowser: true,
    localCheck: { supported: false, label: "ローカル限定チェック対象外", exactBlocker: "local_check_not_supported" },
    approvalRequirement: "公開・外部効果は承認必須",
    aliases: ["daily-ai-research-publish-run", "daily-ai-research-source-sync", "daily-ai", "日次AI", "日次AI 研究・公開 実行", "日次AI 研究・公開（AOS staged publish対応）"]
  },
  {
    id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    label: "NisenPrints",
    description: "既存商品監査・商品準備・公開候補",
    route: "runs",
    requiresBrowser: true,
    localCheck: { supported: false, label: "ローカル限定チェック対象外", exactBlocker: "local_check_not_supported" },
    approvalRequirement: "公開・外部効果は承認必須",
    aliases: ["nisenprints-daily-product-canva-printify-etsy-pinterest", "nisenprints-existing-product-audit", "nisenprints-inventory-audit", "nisenprints", "NisenPrints 日次 商品・Canva・Printify・Etsy・Pinterest", "NisenPrints 日次商品・Canva・Printify・Etsy・Pinterest"]
  },
  {
    id: "daily-backup-safety-check",
    label: "Backup",
    description: "snapshot・integrity・cleanup",
    route: "runs",
    requiresBrowser: false,
    localCheck: { supported: true, label: "取得済みローカル情報を確認", exactBlocker: null },
    approvalRequirement: "snapshot確認は承認不要（変更は別途承認）",
    aliases: ["daily-backup-safety-check", "daily-backup", "日次バックアップ スナップショット確認"]
  },
  {
    id: "obsidian-project-memory-audit",
    label: "Obsidian",
    description: "project memoryの読取監査",
    route: "runs",
    requiresBrowser: false,
    localCheck: { supported: true, label: "取得済みローカル情報を確認", exactBlocker: null },
    approvalRequirement: "読取監査は承認不要（Vault更新はしない）",
    aliases: ["obsidian-project-memory-audit", "obsidian", "Obsidianプロジェクト記憶 週次監査"]
  }
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function itemId(item: Record<string, unknown>): string {
  const builderSpec = item.builder_spec ?? item.builderSpec;
  const builder = builderSpec && typeof builderSpec === "object" && !Array.isArray(builderSpec)
    ? builderSpec as Record<string, unknown>
    : null;
  const adapter = builder?.workflowAdapter ?? builder?.workflow_adapter;
  const adapterRecord = adapter && typeof adapter === "object" && !Array.isArray(adapter)
    ? adapter as Record<string, unknown>
    : null;
  return text(
    item.canonicalWorkflowId
      ?? item.canonical_workflow_id
      ?? builder?.canonicalWorkflowId
      ?? builder?.canonical_workflow_id
      ?? adapterRecord?.workflow_id
      ?? item.workflow_id
      ?? item.workflowId
      ?? item.automation_type
      ?? item.id
  );
}

function itemCanonicalId(item: Record<string, unknown>): string {
  const builderSpec = item.builder_spec ?? item.builderSpec;
  const builder = builderSpec && typeof builderSpec === "object" && !Array.isArray(builderSpec)
    ? builderSpec as Record<string, unknown>
    : null;
  const adapter = builder?.workflowAdapter ?? builder?.workflow_adapter;
  const adapterRecord = adapter && typeof adapter === "object" && !Array.isArray(adapter) ? adapter as Record<string, unknown> : null;
  return text(item.canonicalWorkflowId ?? item.canonical_workflow_id ?? builder?.canonicalWorkflowId ?? builder?.canonical_workflow_id ?? adapterRecord?.workflow_id ?? item.workflow_id ?? item.workflowId);
}

function registeredCanonicalId(item: Record<string, unknown>): string {
  const explicit = itemCanonicalId(item);
  if (explicit) return explicit;
  const id = text(item.id);
  return (WORKFLOW_START_GUIDE_IDS as readonly string[]).includes(id) ? id : "";
}

function itemName(item: Record<string, unknown>): string {
  return text(item.name ?? item.label ?? item.title ?? item.description);
}

function itemCompanyId(item: Record<string, unknown>): string {
  return text(item.company_id ?? item.companyId ?? item.project_id ?? item.projectId);
}

function itemBlocker(item: Record<string, unknown>): string | null {
  const blocker = text(item.exact_blocker ?? item.exactBlocker ?? item.blocker ?? item.blocked_action);
  return blocker || null;
}

function registeredSummary(item: Record<string, unknown>): WorkflowStartGuideRegistration {
  return {
    id: text(item.id),
    name: itemName(item) || text(item.id) || "(名前未確認)",
    canonicalWorkflowId: registeredCanonicalId(item) || null,
    status: text(item.status) || null,
    canRun: item.can_run === true || item.canRun === true,
    canPreflight: item.can_preflight === true || item.canPreflight === true,
    exactBlocker: itemBlocker(item)
  };
}

function registeredMatch(definition: Definition, automations: readonly Record<string, unknown>[], companyId: string): Record<string, unknown> | null {
  return automations.find((item) => registeredCanonicalId(item).toLowerCase() === definition.id.toLowerCase()
    && (!itemCompanyId(item) || itemCompanyId(item) === companyId)) ?? null;
}

function bindingStatus(item: Record<string, unknown>): string {
  const lane = item.browser_use_lane ?? item.browserUseLane ?? item.lane;
  const laneRecord = lane && typeof lane === "object" && !Array.isArray(lane) ? lane as Record<string, unknown> : null;
  return text(item.binding_status ?? item.bindingStatus ?? laneRecord?.binding_status ?? laneRecord?.bindingStatus ?? laneRecord?.status);
}

function hasCurrentProof(item: Record<string, unknown>): boolean {
  const proof = item.latest_proof ?? item.latestProof;
  const proofRecord = proof && typeof proof === "object" && !Array.isArray(proof) ? proof as Record<string, unknown> : null;
  return proofRecord?.same_run_receipt === true || proofRecord?.sameRunReceipt === true;
}

type SameRunReadback = NonNullable<WorkflowStartGuideItem["sameRunReadback"]>;

function runMetadata(run: Record<string, unknown>): Record<string, unknown> | null {
  const raw = run.metadata_json ?? run.metadataJson ?? run.metadata;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function runCanonicalId(run: Record<string, unknown>): string {
  const builderSpec = run.builder_spec ?? run.builderSpec;
  const builder = builderSpec && typeof builderSpec === "object" && !Array.isArray(builderSpec)
    ? builderSpec as Record<string, unknown>
    : null;
  const metadata = runMetadata(run);
  return text(run.canonicalWorkflowId
    ?? run.canonical_workflow_id
    ?? run.workflow_id
    ?? run.workflowId
    ?? builder?.canonicalWorkflowId
    ?? builder?.canonical_workflow_id
    ?? run.automation_type
    ?? metadata?.canonicalWorkflowId
    ?? metadata?.canonical_workflow_id
    ?? metadata?.workflow_id
    ?? metadata?.workflowId
    ?? metadata?.automation_type);
}

function runAutomationId(run: Record<string, unknown>): string {
  return text(run.automation_id ?? run.automationId ?? run.registered_automation_id ?? run.registeredAutomationId);
}

function runTimestamp(run: Record<string, unknown>): { raw: string; value: number } | null {
  for (const key of ["updated_at", "updatedAt", "created_at", "createdAt"]) {
    const raw = text(run[key]);
    if (!raw) continue;
    const value = Date.parse(raw);
    if (Number.isFinite(value) && value <= Date.now()) return { raw, value };
    return null;
  }
  return null;
}

function hasRunCandidateFor(definition: Definition, input: WorkflowStartGuideInput, companyId: string): boolean {
  return (input.runs ?? []).some((run) => itemCompanyId(run) === companyId
    && runCanonicalId(run).toLowerCase() === definition.id.toLowerCase());
}

function hasExplicitReadOnlyMarker(metadata: Record<string, unknown> | null): boolean {
  return metadata?.effects_mode === "read_only"
    || metadata?.read_only_stage === "reference_readback"
    || metadata?.read_only_stage === "read_only"
    || metadata?.read_only_stage === true
    || metadata?.readOnlyStage === "read_only"
    || metadata?.readOnlyStage === true;
}

function terminalCompleteStatus(value: unknown): boolean {
  return /^(complete|completed|success|successful|succeeded|done)$/i.test(text(value));
}

function sameRunReadbackFor(
  definition: Definition,
  input: WorkflowStartGuideInput,
  companyId: string,
  automationId: string | null
): SameRunReadback | undefined {
  const matchingRuns = (input.runs ?? []).filter((run) => itemCompanyId(run) === companyId
    && runCanonicalId(run).toLowerCase() === definition.id.toLowerCase());
  if (matchingRuns.some((run) => !runTimestamp(run))) return undefined;
  const candidates = matchingRuns
    .map((run) => ({ run, timestamp: runTimestamp(run) }))
    .sort((left, right) => (right.timestamp?.value ?? 0) - (left.timestamp?.value ?? 0));
  const latest = candidates[0];
  if (!latest?.timestamp) return undefined;
  if (candidates.filter((candidate) => candidate.timestamp?.value === latest.timestamp?.value).length !== 1) return undefined;

  const runId = text(latest.run.id ?? latest.run.run_id ?? latest.run.runId);
  const runAutomation = runAutomationId(latest.run);
  const metadata = runMetadata(latest.run);
  const metadataRunId = text(metadata?.run_id ?? metadata?.runId);
  const expiresAt = text(metadata?.readback_expires_at ?? metadata?.readbackExpiresAt);
  const expiresAtValue = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const bindingRevision = text(metadata?.binding_revision ?? metadata?.bindingRevision);
  const runBindingRevision = text(latest.run.binding_revision ?? latest.run.bindingRevision);
  const status = text(latest.run.status ?? latest.run.state);
  if (!runId || !automationId || !terminalCompleteStatus(status)
    || runAutomation !== automationId
    || (metadataRunId && metadataRunId !== runId)
    || metadata?.same_run_receipt !== true
    || metadata?.readback_verified !== true
    || metadata?.external_action_executed !== false
    || metadata?.operation_effect_state === "unknown"
    || (expiresAt && (!Number.isFinite(expiresAtValue) || expiresAtValue <= Date.now()))
    || (bindingRevision && runBindingRevision && bindingRevision !== runBindingRevision)
    || !hasExplicitReadOnlyMarker(metadata)) return undefined;
  return { runId, status, runUpdatedAt: latest.timestamp.raw, proofType: "same_run_receipt_readback" };
}

function hasAccountEvidence(item: Record<string, unknown>): boolean {
  return Boolean(text(item.account_id ?? item.accountId ?? item.account_ref ?? item.accountRef ?? item.connection_id ?? item.connectionId));
}

function hasVerifiedCompanyAccountRef(input: WorkflowStartGuideInput, definition: Definition, companyId: string): boolean {
  if (definition.id !== "email-review-reply") return false;
  return (input.accountRefs ?? []).some((ref) => {
    const refCompanyId = text(ref.company_id ?? ref.companyId);
    const platform = text(ref.platform).toLowerCase();
    const status = text(ref.status).toLowerCase();
    const verificationStatus = text(ref.verification_status ?? ref.verificationStatus).toLowerCase();
    const oauthState = text(ref.oauth_state ?? ref.oauthState).toLowerCase();
    const revokedAt = ref.revoked_at ?? ref.revokedAt;
    const expiresAt = text(ref.expires_at ?? ref.expiresAt);
    return (!refCompanyId || refCompanyId === companyId)
      && (platform === "gmail" || platform === "mail")
      && status === "verified"
      && verificationStatus === "verified"
      && (oauthState === "connected" || oauthState === "not_applicable")
      && !revokedAt
      && (!expiresAt || (Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now()));
  });
}

type ExecutionTargetState = WorkflowStartGuideItem["executionTarget"]["state"];

function executionTargetFor(item: Record<string, unknown>, definition: Definition, input: WorkflowStartGuideInput, companyId: string): WorkflowStartGuideItem["executionTarget"] & { connectionEvidence: WorkflowStartGuideItem["connectionEvidence"] } {
  const raw = item.execution_target ?? item.executionTarget;
  const target = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const allowed = new Set<ExecutionTargetState>(["unknown", "not_required", "unbound", "bound", "company_mismatch", "competing", "revoked", "scope_insufficient"]);
  if (target) {
    const rawState = text(target.state) as ExecutionTargetState;
    const state = allowed.has(rawState) ? rawState : "unknown";
    const rawEvidence = text(target.connection_evidence ?? target.connectionEvidence);
    const connectionEvidence = (["verified", "available_unverified", "missing", "not_required", "unknown"] as const).includes(rawEvidence as any)
      ? rawEvidence as WorkflowStartGuideItem["connectionEvidence"]
      : state === "bound" ? "verified" : state === "not_required" ? "not_required" : "unknown";
    return {
      state,
      connectionRefId: text(target.connection_ref_id ?? target.connectionRefId) || null,
      accountRef: text(target.account_ref ?? target.accountRef) || null,
      exactBlocker: text(target.exact_blocker ?? target.exactBlocker) || null,
      nextAction: text(target.next_action ?? target.nextAction) || "実行対象のfresh readbackを確認してください。",
      connectionEvidence
    };
  }
  if (definition.id !== "email-review-reply") return { state: "not_required", connectionRefId: null, accountRef: null, exactBlocker: null, nextAction: "このworkflowはGmail execution targetを要求しません。", connectionEvidence: "not_required" };
  const verified = hasVerifiedCompanyAccountRef(input, definition, companyId);
  return { state: "unknown", connectionRefId: null, accountRef: null, exactBlocker: null, nextAction: "Workflow実行先のconnection ref bindingをfresh readbackで確認してください。", connectionEvidence: verified ? "verified" : "unknown" };
}

function registeredMatches(definition: Definition, automations: readonly Record<string, unknown>[], companyId: string): { matches: Record<string, unknown>[]; mismatched: Record<string, unknown>[] } {
  const aliases = new Set(definition.aliases.map((alias) => alias.toLowerCase()));
  const matches: Record<string, unknown>[] = [];
  const mismatched: Record<string, unknown>[] = [];
  for (const item of automations) {
    const id = itemId(item).toLowerCase();
    const name = itemName(item).toLowerCase();
    const keywordMatch = definition.id === "email-review-reply"
      ? /メール確認|gmail|calendar/i.test(name)
      : definition.id === "daily-ai-research-publish-run"
        ? /daily\s*ai|日次ai/i.test(name)
        : definition.id === "nisenprints-daily-product-canva-printify-etsy-pinterest"
          ? /nisenprints/i.test(name)
          : definition.id === "daily-backup-safety-check"
            ? /backup|バックアップ/i.test(name)
            : definition.id === "obsidian-project-memory-audit"
              ? /obsidian/i.test(name)
              : false;
    if (!aliases.has(id) && !aliases.has(name) && !keywordMatch) continue;
    if (itemCompanyId(item) && itemCompanyId(item) !== companyId) mismatched.push(item);
    else matches.push(item);
  }
  const savedMatches = matches.filter((item) => item._guide_source === "saved");
  const savedMismatched = mismatched.filter((item) => item._guide_source === "saved");
  return {
    matches: savedMatches.length ? savedMatches : matches,
    mismatched: savedMatches.length ? savedMismatched : mismatched
  };
}

function buildItem(definition: Definition, input: WorkflowStartGuideInput): WorkflowStartGuideItem {
  const companyId = text(input.companyId);
  const base = {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    route: definition.route,
    requiresBrowser: definition.requiresBrowser,
    canonicalWorkflowId: definition.id,
    automationId: null as string | null,
    exactBlocker: null as string | null,
    bindingEvidence: "missing" as const,
    // A selected company id is only the requested scope. It is not proof that
    // a candidate registration belongs to that company.
    companyEvidence: "company_scope_missing" as const,
    accountEvidence: "account_unknown" as const,
    connectionEvidence: "unknown" as const,
    executionTarget: { state: "unknown" as const, connectionRefId: null, accountRef: null, exactBlocker: null, nextAction: "実行対象のfresh readbackを確認してください。" },
    approvalRequirement: definition.approvalRequirement,
    candidateAutomations: [] as Array<{ id: string; name: string; companyId: string | null; canonicalWorkflowId: string | null; status: string | null }>,
    localCheck: definition.localCheck
    ,registrationStatus: "not_present" as const
    ,registeredAutomationId: null as string | null
    ,registeredStatus: null as string | null
    ,registeredCanRun: false
    ,registeredCanPreflight: false
    ,registeredExactBlocker: null as string | null
  };
  const registrationStatus = input.registeredReadbackStatus ?? "ready";
  const registration = registrationStatus === "ready"
    ? registeredMatch(definition, input.registeredAutomations ?? [], companyId)
    : null;
  const registrationFields = registration
    ? { registrationStatus: "registered" as const, registeredAutomationId: text(registration.id) || null, registeredStatus: text(registration.status) || null, registeredCanRun: registration.can_run === true || registration.canRun === true, registeredCanPreflight: registration.can_preflight === true || registration.canPreflight === true, registeredExactBlocker: itemBlocker(registration) }
    : { registrationStatus: registrationStatus === "loading" ? "loading" as const : registrationStatus === "error" ? "error" as const : "not_present" as const, registeredAutomationId: null, registeredStatus: null, registeredCanRun: false, registeredCanPreflight: false, registeredExactBlocker: registrationStatus === "error" ? (text(input.executionGate?.exactBlocker) || "registered_automation_readback_unavailable") : null };
  const withRegistration = <T extends WorkflowStartGuideItem>(item: T): T => {
    const registered = { ...item, ...registrationFields } as T;
    const boundAutomationId = text(registered.automationId) || null;
    const sameRunReadback = companyId && boundAutomationId
      ? sameRunReadbackFor(definition, input, companyId, boundAutomationId)
      : undefined;
    if (!sameRunReadback) return registered;
    return {
      ...registered,
      sameRunReadback,
      statusLabel: registered.exactBlocker ? registered.statusLabel : "同一Run readback確認済み",
      proofLabel: "同一Run readback確認済み（Run ID: " + sameRunReadback.runId + " / Run更新時刻: " + sameRunReadback.runUpdatedAt + "）",
      externalEffectLabel: "外部効果なし（同一Run readback確認済み）",
      nextAction: registered.exactBlocker ? registered.nextAction : "結果をRunsで確認（同一Run readback確認済み）"
    } as T;
  };
  if (!companyId) return withRegistration({ ...base, state: "needs_readback", statusLabel: "会社未確認", nextAction: "会社1のfresh state readbackを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: "company_scope_missing" });
  if (input.auth?.verified !== true) return withRegistration({ ...base, state: "needs_auth", statusLabel: "認証readback待ち", nextAction: "Company 1の保護stateを再読込", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: input.auth?.exactBlocker ?? "owner_sso_required" });
  const { matches, mismatched } = registeredMatches(definition, input.automations ?? [], companyId);
  const candidates = matches.map((item) => ({
    id: text(item.id) || "(id未確認)",
    name: itemName(item) || "(名前未確認)",
    companyId: itemCompanyId(item) || null,
    canonicalWorkflowId: itemCanonicalId(item) || null,
    status: text(item.status) || null
  }));
  const canonicalMatches = matches.filter((item) => itemCanonicalId(item).toLowerCase() === definition.id.toLowerCase());
  // A company may retain paused or draft copies of the same canonical
  // workflow. Once the persisted target readback identifies exactly one
  // bound canonical copy, use that copy and keep the stale candidates only as
  // informational evidence. Multiple bound copies (or multiple unbound
  // canonical copies) remain ambiguous and fail closed below.
  const boundCanonicalMatches = canonicalMatches.filter((item) => executionTargetFor(item, definition, input, companyId).state === "bound");
  const canonicalMatchCandidates = boundCanonicalMatches.length === 1 ? boundCanonicalMatches : canonicalMatches;
  const bindingEvidence = canonicalMatchCandidates.length === 1 ? "canonical_id" : canonicalMatchCandidates.length > 1 || matches.length > 1 ? "conflicting" : matches.length === 1 ? "name_or_alias" : "missing";
  const companyEvidence = matches.length === 0
    ? mismatched.length > 0 ? "company_scope_mismatch" as const : "company_scope_missing" as const
    : matches.every((item) => itemCompanyId(item) === companyId) ? "company_scope_match" as const : "company_scope_missing" as const;
  const match = canonicalMatchCandidates[0] ?? matches[0];
  const target = match ? executionTargetFor(match, definition, input, companyId) : executionTargetFor({}, definition, input, companyId);
  const accountEvidence = hasAccountEvidence(match ?? {}) || target.connectionEvidence === "verified" ? "account_ref" : "account_unknown";
  const withEvidence = (item: WorkflowStartGuideItem): WorkflowStartGuideItem => ({ ...item, companyEvidence, bindingEvidence, candidateAutomations: candidates, connectionEvidence: target.connectionEvidence, executionTarget: target, accountEvidence });
  if (mismatched.length > 0 && matches.length === 0) return withRegistration(withEvidence({ ...base, companyEvidence: "company_scope_mismatch", state: "company_mismatch", statusLabel: "会社不一致", nextAction: "同じ会社scopeの登録readbackを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: "company_binding_mismatch" }));
  if (matches.some((item) => !itemCompanyId(item))) return withRegistration(withEvidence({ ...base, state: "needs_readback", statusLabel: "会社scope未確認", nextAction: "同じ会社scopeの登録readbackを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: "company_scope_missing" }));
  if (boundCanonicalMatches.length > 1 || (boundCanonicalMatches.length === 0 && canonicalMatches.length > 1) || (canonicalMatches.length === 0 && matches.length > 1)) return withRegistration(withEvidence({ ...base, state: "ambiguous", statusLabel: "候補が複数", nextAction: "候補一覧でcanonical workflow IDと会社scopeを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: "registered_workflow_ambiguous" }));
  if (matches.length === 0) return withRegistration(withEvidence({ ...base, state: "not_registered", statusLabel: "登録未確認", nextAction: "canonical workflow ID付きの登録readbackを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: "registered_workflow_missing" }));
  const automationId = text(match.id) || null;
  const blocker = itemBlocker(match);
  const binding = bindingStatus(match).toLowerCase();
  const currentProof = !hasRunCandidateFor(definition, input, companyId) && hasCurrentProof(match);
  if (target.state === "company_mismatch") return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: "company_mismatch", statusLabel: "実行先の会社不一致", nextAction: target.nextAction, proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: target.exactBlocker ?? "execution_target_company_mismatch" }));
  if (["competing", "revoked", "scope_insufficient"].includes(target.state)) return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: "needs_binding", statusLabel: target.state === "competing" ? "実行先が競合" : target.state === "revoked" ? "実行先が失効" : "実行先scope不足", nextAction: target.nextAction, proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: target.exactBlocker ?? "execution_target_not_ready" }));
  if (target.state === "unbound") return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: "needs_binding", statusLabel: "実行先未設定", nextAction: target.nextAction, proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: target.exactBlocker ?? "execution_target_unbound" }));
  if (definition.requiresBrowser && ["mismatch", "binding_mismatch", "unregistered", "missing", "not_claimed"].some((value) => binding.includes(value))) {
    return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: "needs_binding", statusLabel: "resource束縛待ち", nextAction: "同一Runのworkflow-owned AOS Chrome Companion resourceを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: blocker ?? "browser_use_live_resource_unregistered" }));
  }
  if (input.worker?.heartbeatFresh !== true && definition.requiresBrowser) {
    return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: "needs_readback", statusLabel: "Worker確認待ち", nextAction: "Mac workerのfresh heartbeat/readbackを確認", proofLabel: "未確認", externalEffectLabel: "外部操作なし", exactBlocker: input.worker?.exactBlocker ?? "mac_worker_heartbeat_stale" }));
  }
  // Runtime blockers describe the Browser Use lane. Provider-neutral and
  // local workflows must not inherit a browser blocker merely because the
  // selected runtime is unavailable.
  if (blocker || (definition.requiresBrowser && input.runtime?.exactBlocker)) {
    return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: "needs_reconciliation", statusLabel: "要照合", nextAction: "同じRunのreceipt・対象readbackを照合（再送しない）", proofLabel: currentProof ? "同一Run proofあり" : "未確認", externalEffectLabel: "外部効果は未確認", exactBlocker: blocker ?? input.runtime?.exactBlocker ?? "unknown_readback" }));
  }
  return withRegistration(withEvidence({ ...base, automationId, accountEvidence, state: currentProof ? "ready" : "needs_readback", statusLabel: currentProof ? "同一Run proof確認済み" : "readback確認待ち", nextAction: currentProof ? "結果をRunsで確認" : "Runsで同一Runのreceipt/readbackを確認", proofLabel: currentProof ? "同一Run proofあり" : "未確認", externalEffectLabel: "外部効果は未確認", exactBlocker: currentProof ? null : "unknown_readback" }));
}

export function buildWorkflowStartGuide(input: WorkflowStartGuideInput): WorkflowStartGuide {
  const companyId = text(input.companyId) || null;
  const executionGateInput = input.executionGate;
  const executionGateStatus = executionGateInput?.status === "ready"
    ? executionGateInput.canRun ? "ready" : executionGateInput.canPreflight ? "preflight_only" : "blocked"
    : "unknown";
  return {
    schema: WORKFLOW_START_GUIDE_SCHEMA,
    companyId,
    companyLabel: text(input.companyLabel) || "会社未選択",
    authVerified: input.auth?.verified === true,
    workerFresh: input.worker?.heartbeatFresh === true,
    executionGate: {
      status: executionGateStatus,
      canRun: executionGateInput?.status === "ready" && executionGateInput.canRun,
      canPreflight: executionGateInput?.status === "ready" && executionGateInput.canPreflight,
      exactBlocker: executionGateInput?.exactBlocker ?? null
    },
    items: definitions.map((definition) => buildItem(definition, input)),
    registeredAutomations: (input.registeredAutomations ?? []).map(registeredSummary),
    externalActionExecuted: false
  };
}
