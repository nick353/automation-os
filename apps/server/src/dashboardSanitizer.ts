type JsonObject = Record<string, unknown>;

type DashboardRow = Record<string, unknown> & {
  metadata_json?: unknown;
};

type PublicRunContract = {
  workflow?: string;
  mode?: string;
  beginnerLabel?: string;
  beginnerDescription?: string;
  visibleSteps?: string[];
};

export function sanitizeDashboardRows<T extends DashboardRow>(rows: T[]): T[] {
  return rows.map((row) => {
    const sanitized: JsonObject = { ...row };
    if ("metadata_json" in sanitized) {
      sanitized.metadata_json = JSON.stringify(sanitizeDashboardMetadata(sanitized.metadata_json));
    }
    addPublicProofViewerFields(sanitized);
    addPublicConnectionFlags(sanitized);
    scrubInternalRowFields(sanitized);
    return sanitized as T;
  });
}

export function sanitizeDashboardMetadata(value: unknown): JsonObject {
  const metadata = parseJson<JsonObject>(value, {});
  const summary = buildRunContractSummary(metadata);
  const sanitized: JsonObject = { ...metadata };
  const publicBrowserUseResult = buildPublicBrowserUseResult(metadata);
  const publicPlaywrightResult = buildPublicPlaywrightResult(metadata);

  if (isObject(sanitized.run_contract)) {
    sanitized.run_contract = publicRunContract(sanitized.run_contract);
  }
  if (summary) {
    sanitized.run_contract_summary = summary;
  }
  if (isObject(sanitized.plan)) {
    sanitized.plan = sanitizePlan(sanitized.plan);
  }
  if (isObject(sanitized.research_plan_snapshot)) {
    sanitized.research_plan_snapshot = publicResearchPlanSnapshot(sanitized.research_plan_snapshot);
  }
  if ("proof_gate" in sanitized) {
    sanitized.proof_gate = publicProofGate(metadata.proof_gate);
  }
  if (isObject(sanitized.youtube_capture)) {
    sanitized.youtube_capture = publicYouTubeCapture(sanitized.youtube_capture);
  }
  delete sanitized.proof_summary;
  delete sanitized.research_plan_required_proofs;
  delete sanitized.research_plan_missing_proofs;
  delete sanitized.research_plan_present_proofs;
  delete sanitized.research_plan_proof_summary;
  scrubInternalRowFields(sanitized);
  if (publicBrowserUseResult) {
    sanitized.browser_use_result = publicBrowserUseResult;
  }
  if (publicPlaywrightResult) {
    sanitized.playwright_result = publicPlaywrightResult;
  }

  return sanitized;
}

function sanitizePlan(plan: JsonObject): JsonObject {
  const sanitized: JsonObject = { ...plan };
  if (isObject(sanitized.runContract)) {
    sanitized.runContract = publicRunContract(sanitized.runContract);
  }
  return sanitized;
}

function buildRunContractSummary(metadata: JsonObject): JsonObject | undefined {
  if (!isObject(metadata.run_contract)) return undefined;
  const contract = metadata.run_contract;
  const proofGate = isObject(metadata.proof_gate) ? metadata.proof_gate : {};
  const requiredProofs = stringArray(contract.requiredProofs);
  const visibleSteps = stringArray(contract.visibleSteps);
  const presentProofs = new Set(stringArray(proofGate.present));
  const done = requiredProofs.filter((proofType) => presentProofs.has(proofType)).length;
  const total = requiredProofs.length;
  const missingVisibleSteps = visibleStepsForProofs(
    requiredProofs.filter((proofType) => !presentProofs.has(proofType)),
    requiredProofs,
    visibleSteps
  );

  return {
    ...publicRunContract(contract),
    ...(missingVisibleSteps.length ? { missingVisibleSteps, nextVisibleStep: missingVisibleSteps[0] } : {}),
    progress: {
      done,
      total,
      ok: proofGate.ok === true
    }
  };
}

function publicRunContract(contract: JsonObject): PublicRunContract {
  return {
    ...(typeof contract.workflow === "string" ? { workflow: contract.workflow } : {}),
    ...(typeof contract.mode === "string" ? { mode: contract.mode } : {}),
    ...(typeof contract.beginnerLabel === "string" ? { beginnerLabel: contract.beginnerLabel } : {}),
    ...(typeof contract.beginnerDescription === "string" ? { beginnerDescription: contract.beginnerDescription } : {}),
    ...(stringArray(contract.visibleSteps).length ? { visibleSteps: stringArray(contract.visibleSteps) } : {})
  };
}

function publicProofGate(proofGate: unknown): JsonObject {
  const missing = isObject(proofGate) ? publicProofGateMissingLabels(proofGate.missing) : [];
  return {
    ok: isObject(proofGate) ? proofGate.ok === true : false,
    ...(missing.length ? { missing } : {})
  };
}

const publicProofTypeLabels: Record<string, string> = {
  actual_execution_or_manual_verification: "実行確認",
  cleanup_proof: "片付け確認",
  daily_ai_publish: "Daily AI投稿確認",
  daily_ai_runner_exit_0: "Daily AI実行完了",
  direct_engagement: "反応確認",
  direct_publish: "投稿確認",
  etsy_current_sync: "Etsy同期",
  etsy_current_listings_snapshot: "Etsy一覧確認",
  etsy_listing_discovered: "Etsyリスト確認",
  external_post_not_executed: "外部投稿確認",
  full_flow_completion: "全体完了確認",
  generation_manifest_verified: "生成記録確認",
  gemini_video_qa_completion_alignment: "動画確認",
  local_queue_synced: "ローカル同期",
  nisenprints_runner_exit_0: "NisenPrints実行完了",
  pinterest_pin_url_verified: "Pinterest URL確認",
  pinterest_pin_verified: "Pinterest確認",
  printify_product_same_id: "Printify同一商品",
  printify_status_checked: "Printify状態確認",
  resume_stage_verified: "再開位置確認",
  same_product_id_verified: "同一商品確認",
  sns_multi_poster_external_post_not_executed: "SNS投稿確認",
  sns_multi_poster_input_required: "SNS入力確認",
  stale_rows_pruned: "古い行の整理",
  submitted_confirmed_readback: "応募送信確認",
  visible_source_snapshot: "画面で見える確認記録",
  worker_receipt: "処理記録"
};

function publicProofGateMissingLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => publicProofGateMissingLabel(String(item))).filter(Boolean))].slice(0, 6);
}

function publicProofGateMissingLabel(value: string): string {
  if (!value) return "";
  if (publicProofTypeLabels[value]) return publicProofTypeLabels[value];
  if (/visible[_:-]?source[_:-]?snapshot|source[_:-]?snapshot/i.test(value)) return "画面で見える確認記録";
  if (/actual[_:-]?execution|manual[_:-]?verification/i.test(value)) return "実行確認";
  if (/billing|purchase|payment|checkout|invoice|subscription/i.test(value)) return "課金・支払い確認";
  if (/auth|login|captcha|otp|security|identity|human[_:-]?input/i.test(value)) return "人間入力確認";
  if (/runner|exit[_:-]?0|completed[_:-]?before[_:-]?timeout/i.test(value)) return "実行完了確認";
  if (/publish|post|pin|submit|send|external/i.test(value)) return "外部反映確認";
  if (/cleanup/i.test(value)) return "片付け確認";
  return "確認記録";
}

function publicResearchPlanSnapshot(snapshot: JsonObject): JsonObject {
  return {
    ...(typeof snapshot.id === "string" ? { id: snapshot.id } : {}),
    ...(typeof snapshot.title === "string" ? { title: snapshot.title } : {}),
    ...(typeof snapshot.status === "string" ? { status: snapshot.status } : {}),
    ...(stringArray(snapshot.visibleFlow).length ? { visibleFlow: stringArray(snapshot.visibleFlow) } : {})
  };
}

function publicYouTubeCapture(capture: JsonObject): JsonObject {
  return {
    ...(typeof capture.status === "string" ? { status: capture.status } : {}),
    ...(typeof capture.exactBlocker === "string" ? { needsReview: true } : {}),
    ...(typeof capture.summary === "string" ? { summary: redactPublicText(capture.summary) } : {})
  };
}

function buildPublicBrowserUseResult(metadata: JsonObject): JsonObject | undefined {
  const nested = isObject(metadata.metadata) ? metadata.metadata : {};
  const driver = typeof nested.driver === "string" ? nested.driver : metadata.driver;
  if (driver !== "browser_use_cli") return undefined;
  const connection = isObject(nested.connectionStrategy) ? nested.connectionStrategy : isObject(metadata.connectionStrategy) ? metadata.connectionStrategy : {};
  const cleanup = isObject(nested.cleanup) ? nested.cleanup : isObject(metadata.cleanup) ? metadata.cleanup : {};
  const evidenceCount = [nested.screenshotPath, nested.statePath, nested.logPath, metadata.screenshotPath, metadata.statePath, metadata.logPath]
    .filter((item) => typeof item === "string" && item.length > 0).length;
  return {
    driver: "browser_use_cli",
    evidenceCount,
    connectionMode: typeof connection.mode === "string" ? connection.mode : undefined,
    cleanupStatus: typeof cleanup.status === "string" ? cleanup.status : undefined
  };
}

function buildPublicPlaywrightResult(metadata: JsonObject): JsonObject | undefined {
  const nested = isObject(metadata.metadata) ? metadata.metadata : {};
  const driver = typeof nested.driver === "string" ? nested.driver : metadata.driver;
  if (driver !== "playwright_cli") return undefined;
  const evidenceCount = [
    nested.screenshotPath,
    nested.domPath,
    nested.consolePath,
    metadata.screenshotPath,
    metadata.domPath,
    metadata.consolePath
  ].filter((item) => typeof item === "string" && item.length > 0).length;
  return {
    driver: "playwright_cli",
    evidenceCount,
    cleanupStatus: typeof nested.cleanupStatus === "string" ? nested.cleanupStatus : undefined
  };
}

function addPublicConnectionFlags(row: JsonObject): void {
  if (row.cdp_port || row.browser_use_cdp_url) {
    row.connection_configured = true;
  }
  if (row.cdp_port || row.profile_dir || row.profile_strategy === "cdp_profile_lane") {
    row.playwright_configured = true;
    row.browser_driver = "playwright_cli";
  }
  if (row.browser_use_session || row.browser_use_cdp_url || row.browser_use_profile) {
    row.browser_use_configured = row.playwright_configured ? false : true;
  }
}

function addPublicProofViewerFields(row: JsonObject): void {
  if (typeof row.id !== "string" || typeof row.proof_type !== "string") return;
  row.can_open = true;
  row.viewer_url = `/api/proofs/${encodeURIComponent(row.id)}/view`;
  delete row.metadata_json;
  delete row.metadata;
}

function scrubInternalRowFields(row: JsonObject): void {
  const sensitiveKeys = [
    "approvalBoundary",
    "artifactPath",
    "browser_use_cdp_url",
    "browser_use_profile",
    "browser_use_session",
    "browserUseCdpUrl",
    "browserUseProfile",
    "browserUseSession",
    "cdpUrl",
    "cdp_port",
    "cdpPort",
    "command",
    "cleanupCommand",
    "consolePath",
    "codexBin",
    "domPath",
    "filePath",
    "host",
    "logPath",
    "metadata",
    "path",
    "pid",
    "profile",
    "profile_dir",
    "profileDir",
    "prompt_uri",
    "promptUri",
    "proofBoundary",
    "result_uri",
    "resultUri",
    "screenshotPath",
    "session",
    "signal",
    "sourceOfTruth",
    "source_refs",
    "startCommand",
    "statePath",
    "stderr_tail",
    "stdout_tail",
    "targetUrl",
    "target_url",
    "uri",
    "workdir"
  ];
  const sensitiveKeySet = new Set(sensitiveKeys);
  for (const key of sensitiveKeySet) {
    delete row[key];
  }
  for (const [key, value] of Object.entries(row)) {
    if (sensitiveKeySet.has(key)) {
      delete row[key];
      continue;
    }
    row[key] = scrubInternalValue(value, sensitiveKeySet);
  }
}

function scrubInternalValue(value: unknown, sensitiveKeys: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubInternalValue(item, sensitiveKeys));
  }
  if (isObject(value)) {
    scrubInternalRowFields(value);
    return value;
  }
  if (typeof value === "string") {
    return redactPublicText(value);
  }
  return value;
}

function redactPublicText(value: string): string {
  return value
    .replace(/file:(?:\\\/){3}Users(?:\\\/)[^\n\r"'<>]+/g, "[redacted-file-uri]")
    .replace(/file:(?:\/\/\/|\/\/|(?:\\\/){2,3})Users\/[^\n\r"'<>]+/g, "[redacted-file-uri]")
    .replace(/file:\/\/[^\s"'<>]+/g, "[redacted-file-uri]")
    .replace(/\/Users\/[^\n\r"'<>]+/g, "[redacted-path]")
    .replace(/\/Users(?=[\s\n\r"'<>]|$)/g, "[redacted-path]")
    .replace(/(?:\/private)?\/tmp\/[^\n\r"'<>]+/g, "[redacted-path]")
    .replace(/(?:^|[\s"'(])Documents\/New project\/[^\n\r"'<>]+/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-path]`;
    })
    .replace(/(?:^|[\s"'(])data\/artifacts(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])artifacts(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])output\/playwright(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/(?:^|[\s"'(])\.playwright-cli(?:\/[^\n\r"'<>]+)?/g, (match) => {
      const prefix = match.match(/^[\s"'(]/)?.[0] ?? "";
      return `${prefix}[redacted-artifact]`;
    })
    .replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]");
}

function visibleStepsForProofs(missingProofs: string[], requiredProofs: string[], visibleSteps: string[]): string[] {
  if (!missingProofs.length || !visibleSteps.length) return [];
  const steps = missingProofs
    .map((proofType) => {
      const index = requiredProofs.indexOf(proofType);
      if (index < 0) return undefined;
      return visibleSteps[Math.min(index, visibleSteps.length - 1)];
    })
    .filter((step): step is string => typeof step === "string" && step.length > 0);
  return [...new Set(steps)];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (isObject(value)) return value as T;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
