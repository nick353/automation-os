import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  parseAutomationKernelDefinitionV1,
  type AutomationKernelDefinitionV1,
  type AutomationKernelEffectClassV1,
  type JsonObject
} from "./contracts.js";
import { hashAutomationKernelValue } from "./reducer.js";

export type AutomationKernelRegisteredEntrypointV1 = { path: string; cwd: string; command?: string };
export type AutomationKernelProfileV1 = "light" | "full";
export type AutomationKernelManifestStageV1 = {
  id: string;
  effect_class: AutomationKernelEffectClassV1;
  kernel_profile: AutomationKernelProfileV1;
  owner: string;
  lane: string;
  browser_surface?: string;
  needs_chrome: boolean;
  chrome_lease: JsonObject | null;
  replay: string;
  required: boolean;
  fan_out: JsonObject | null;
  continuation: JsonObject | null;
  always_run?: boolean;
  entrypoints?: string[];
  approval_required?: boolean;
};
export type AutomationKernelWorkflowManifestV1 = {
  schema: "automation_kernel_manifest.v1";
  id: string;
  kind: string;
  root: string;
  registered_entrypoint?: AutomationKernelRegisteredEntrypointV1;
  runner?: JsonObject;
  entrypoints?: JsonObject[];
  authority_paths: string[];
  artifact_roots: string[];
  result_contract: JsonObject;
  chrome_lease_contract: JsonObject;
  browser_use?: JsonObject;
  ownership_contract?: JsonObject;
  gmail_contract?: JsonObject;
  stages: AutomationKernelManifestStageV1[];
  domain_gates: JsonObject[];
};
export type AutomationKernelWorkflowManifestCompileResultV1 = {
  manifest: AutomationKernelWorkflowManifestV1;
  definition: AutomationKernelDefinitionV1;
  workflow_id: string;
  run_id: string;
  kernel_id: string;
  manifest_sha256: string;
};

export class AutomationKernelManifestError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationKernelManifestError";
  }
}

const topLevelFields = new Set([
  "schema", "id", "kind", "root", "registered_entrypoint", "runner", "entrypoints",
  "authority_paths", "artifact_roots", "result_contract", "chrome_lease_contract",
  "browser_use", "ownership_contract", "gmail_contract", "stages", "domain_gates"
]);
const stageFields = new Set([
  "id", "effect_class", "kernel_profile", "owner", "lane", "browser_surface", "needs_chrome", "chrome_lease", "replay",
  "required", "fan_out", "continuation", "entrypoints", "approval_required", "always_run"
]);
const requiredResultFields = new Set([
  "schema", "workflow_id", "run_id", "terminal_status", "selected_stages", "stage_results",
  "exact_blocker", "restart_stage", "artifact_uris", "cleanup_proof"
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const browserUseHelperPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";
const browserUseRuntimeConfigPath = "/Users/nichikatanaka/.codex/browser-use/browser-use-runtime.toml";
const browserUseScheduledProfileRoot = "/Users/nichikatanaka/.codex/browser-use/profiles/scheduled";
const browserUseSingleUseProfileRoot = "/Users/nichikatanaka/.codex/browser-use/profiles/single-use";
const browserUseScheduledPortRange = { start: 19880, end: 19899 } as const;
const browserUseSingleUsePortRange = { start: 19980, end: 19999 } as const;

export function parseAutomationKernelManifestFileV1(file: string): AutomationKernelWorkflowManifestV1 {
  return parseAutomationKernelManifestTextV1(readFileSync(resolve(file), "utf8"));
}

export function parseAutomationKernelManifestTextV1(text: string): AutomationKernelWorkflowManifestV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AutomationKernelManifestError("automation_kernel_manifest_json_invalid");
  }
  return normalizeManifest(parsed);
}

export function compileAutomationKernelManifestV1(
  manifest: AutomationKernelWorkflowManifestV1,
  runId: string,
  selectedStageIds?: string[]
): AutomationKernelWorkflowManifestCompileResultV1 {
  const normalizedRunId = boundedRunId(runId);
  const selectedStages = selectManifestStages(manifest, selectedStageIds);
  const plainKernelId = `${manifest.id}:${normalizedRunId}`;
  const kernelId = plainKernelId.length <= 120 && idPattern.test(plainKernelId)
    ? plainKernelId
    : `${manifest.id}:${createHash("sha256").update(normalizedRunId).digest("hex").slice(0, 24)}`;
  const manifestSha256 = hashAutomationKernelValue(manifest);
  const definition = parseAutomationKernelDefinitionV1({
    schema_version: "automation_kernel.v1",
    kernel_id: kernelId,
    title: `${manifest.id} / ${normalizedRunId}`.slice(0, 160),
    heartbeat_owner: "caller",
    effects: selectedStages.map((stage, index) => ({
      effect_id: stage.id,
      effect_class: stage.effect_class,
      summary: stage.id,
        payload: {
        schema: "automation_kernel_manifest.stage.v1",
        workflow_id: manifest.id,
        run_id: normalizedRunId,
        manifest_sha256: manifestSha256,
        stage_index: index + 1,
        stage_id: stage.id,
        owner: stage.owner,
        lane: stage.lane,
        ...(stage.browser_surface ? { browser_surface: stage.browser_surface } : {}),
        effect_class: stage.effect_class,
        kernel_profile: stage.kernel_profile,
        needs_chrome: stage.needs_chrome,
        chrome_lease: stage.chrome_lease,
        replay: stage.replay,
        required: stage.required,
        always_run: stage.always_run,
        fan_out: stage.fan_out,
        continuation: stage.continuation,
        ...(stage.entrypoints ? { entrypoints: stage.entrypoints } : {}),
        ...(stage.approval_required !== undefined ? { approval_required: stage.approval_required } : {})
      }
    })),
    metadata: {
      schema: manifest.schema,
      workflow_id: manifest.id,
      run_id: normalizedRunId,
      manifest_sha256: manifestSha256,
      manifest_kind: manifest.kind,
      root: manifest.root,
      registered_entrypoint: manifest.registered_entrypoint ?? null,
      runner: manifest.runner ?? null,
      entrypoints: manifest.entrypoints ?? null,
      authority_paths: manifest.authority_paths,
      artifact_roots: manifest.artifact_roots,
      result_contract: manifest.result_contract,
      chrome_lease_contract: manifest.chrome_lease_contract,
      browser_use: manifest.browser_use ?? null,
      ownership_contract: manifest.ownership_contract ?? null,
      gmail_contract: manifest.gmail_contract ?? null,
      domain_gates: manifest.domain_gates,
      selected_stage_ids: selectedStages.map((stage) => stage.id),
      compiler_schema_version: "automation_kernel_manifest.compiler.v1"
    }
  });
  return { manifest, definition, workflow_id: manifest.id, run_id: normalizedRunId, kernel_id: kernelId, manifest_sha256: manifestSha256 };
}

export function compileAutomationKernelManifestTextV1(text: string, runId: string, selectedStageIds?: string[]): AutomationKernelWorkflowManifestCompileResultV1 {
  return compileAutomationKernelManifestV1(parseAutomationKernelManifestTextV1(text), runId, selectedStageIds);
}

function selectManifestStages(
  manifest: AutomationKernelWorkflowManifestV1,
  selectedStageIds?: string[]
): AutomationKernelManifestStageV1[] {
  const declaredIds = new Set(manifest.stages.map((stage) => stage.id));
  const requiredIds = new Set(manifest.stages.filter((stage) => stage.required).map((stage) => stage.id));
  const requested = selectedStageIds === undefined
    ? requiredIds
    : new Set(selectedStageIds.map((stageId) => boundedId(stageId, "automation_kernel_selected_stage_id", 120)));
  if (requested.size === 0) throw new AutomationKernelManifestError("automation_kernel_selected_stages_required");
  for (const stageId of requested) {
    if (!declaredIds.has(stageId)) throw new AutomationKernelManifestError(`automation_kernel_selected_stage_unknown:${stageId}`);
  }
  for (const stageId of requiredIds) {
    if (!requested.has(stageId)) throw new AutomationKernelManifestError(`automation_kernel_required_stage_not_selected:${stageId}`);
  }
  return manifest.stages.filter((stage) => requested.has(stage.id));
}

function normalizeManifest(value: unknown): AutomationKernelWorkflowManifestV1 {
  const body = objectValue(value, "automation_kernel_manifest_required");
  rejectUnknown(body, topLevelFields, "automation_kernel_manifest_unknown_field");
  if (body.schema !== "automation_kernel_manifest.v1") throw new AutomationKernelManifestError("automation_kernel_manifest_schema_invalid");
  const id = boundedId(body.id, "automation_kernel_manifest_id", 120);
  const root = absolutePath(body.root, "automation_kernel_manifest_root");
  assertDirectory(root, "automation_kernel_manifest_root_invalid");
  const registeredEntrypoint = body.registered_entrypoint === undefined ? undefined : parseRegisteredEntrypoint(body.registered_entrypoint, root);
  const runner = body.runner === undefined ? undefined : parseRunner(body.runner, root);
  const entrypoints = body.entrypoints === undefined ? undefined : parseEntrypoints(body.entrypoints, root);
  if (!registeredEntrypoint && !entrypoints) throw new AutomationKernelManifestError("automation_kernel_manifest_entrypoint_required");
  const authorityPaths = stringArray(body.authority_paths, "automation_kernel_manifest_authority_paths");
  if (authorityPaths.length === 0) throw new AutomationKernelManifestError("automation_kernel_manifest_authority_paths_required");
  for (const authority of authorityPaths) assertRegularFile(resolveReference(root, authority), "automation_kernel_manifest_authority_missing");
  const artifactRoots = stringArray(body.artifact_roots, "automation_kernel_manifest_artifact_roots");
  for (const artifactRoot of artifactRoots) resolveReference(root, artifactRoot);
  const resultContract = objectValue(body.result_contract, "automation_kernel_manifest_result_contract");
  validateResultContract(resultContract);
  const chromeLeaseContract = objectValue(body.chrome_lease_contract, "automation_kernel_manifest_chrome_lease_contract");
  validateChromeLeaseContract(chromeLeaseContract);
  const browserUse = body.browser_use === undefined ? undefined : objectValue(body.browser_use, "automation_kernel_manifest_browser_use");
  if (browserUse) validateBrowserUseContract(browserUse);
  const stages = arrayValue(body.stages, "automation_kernel_manifest_stages").map(parseStage);
  if (stages.length === 0) throw new AutomationKernelManifestError("automation_kernel_manifest_stages_required");
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) throw new AutomationKernelManifestError("automation_kernel_manifest_stage_id_duplicate");
  if (browserUse) validateBrowserUseStageBinding(browserUse, chromeLeaseContract, stages);
  const domainGates = arrayValue(body.domain_gates, "automation_kernel_manifest_domain_gates").map((gate) => objectValue(gate, "automation_kernel_manifest_domain_gate_invalid"));
  return {
    schema: "automation_kernel_manifest.v1",
    id,
    kind: nonemptyString(body.kind, "automation_kernel_manifest_kind"),
    root,
    ...(registeredEntrypoint ? { registered_entrypoint: registeredEntrypoint } : {}),
    ...(runner ? { runner } : {}),
    ...(entrypoints ? { entrypoints } : {}),
    authority_paths: authorityPaths,
    artifact_roots: artifactRoots,
    result_contract: resultContract,
    chrome_lease_contract: chromeLeaseContract,
    ...(browserUse ? { browser_use: browserUse } : {}),
    ...(body.ownership_contract !== undefined ? { ownership_contract: objectValue(body.ownership_contract, "automation_kernel_manifest_ownership_contract") } : {}),
    ...(body.gmail_contract !== undefined ? { gmail_contract: objectValue(body.gmail_contract, "automation_kernel_manifest_gmail_contract") } : {}),
    stages,
    domain_gates: domainGates
  };
}

function parseRegisteredEntrypoint(value: unknown, root: string): AutomationKernelRegisteredEntrypointV1 {
  const body = objectValue(value, "automation_kernel_manifest_registered_entrypoint");
  rejectUnknown(body, new Set(["path", "cwd", "command"]), "automation_kernel_manifest_registered_entrypoint_unknown_field");
  const file = absolutePath(body.path, "automation_kernel_manifest_registered_entrypoint_path");
  const cwd = absolutePath(body.cwd, "automation_kernel_manifest_registered_entrypoint_cwd");
  assertRegularFile(file, "automation_kernel_manifest_registered_entrypoint_missing");
  assertDirectory(cwd, "automation_kernel_manifest_registered_entrypoint_cwd_missing");
  assertInsideRoot(root, cwd, "automation_kernel_manifest_registered_entrypoint_cwd_outside_root");
  return {
    path: file,
    cwd,
    ...(body.command === undefined
      ? {}
      : { command: nonemptyString(body.command, "automation_kernel_manifest_registered_entrypoint_command") })
  };
}

function parseRunner(value: unknown, root: string): JsonObject {
  const body = objectValue(value, "automation_kernel_manifest_runner");
  rejectUnknown(body, new Set(["path", "symbol"]), "automation_kernel_manifest_runner_unknown_field");
  const runnerPath = nonemptyString(body.path, "automation_kernel_manifest_runner_path");
  assertRegularFile(resolveReference(root, runnerPath), "automation_kernel_manifest_runner_missing");
  return { path: runnerPath, symbol: nonemptyString(body.symbol, "automation_kernel_manifest_runner_symbol") };
}

function parseEntrypoints(value: unknown, root: string): JsonObject[] {
  const entries = arrayValue(value, "automation_kernel_manifest_entrypoints").map((entry) => {
    const body = objectValue(entry, "automation_kernel_manifest_entrypoint_invalid");
    rejectUnknown(body, new Set(["id", "command", "runner"]), "automation_kernel_manifest_entrypoint_unknown_field");
    const runner = body.runner === undefined ? undefined : nonemptyString(body.runner, "automation_kernel_manifest_entrypoint_runner");
    if (runner) assertRegularFile(resolveReference(root, runner), "automation_kernel_manifest_entrypoint_runner_missing");
    return { id: boundedId(body.id, "automation_kernel_manifest_entrypoint_id", 120), command: nonemptyString(body.command, "automation_kernel_manifest_entrypoint_command"), ...(runner ? { runner } : {}) };
  });
  if (entries.length === 0) throw new AutomationKernelManifestError("automation_kernel_manifest_entrypoints_required");
  return entries;
}

function parseStage(value: unknown): AutomationKernelManifestStageV1 {
  const body = objectValue(value, "automation_kernel_manifest_stage_invalid");
  rejectUnknown(body, stageFields, "automation_kernel_manifest_stage_unknown_field");
  const stage: AutomationKernelManifestStageV1 = {
    id: boundedId(body.id, "automation_kernel_manifest_stage_id", 120),
    effect_class: effectClass(body.effect_class),
    kernel_profile: kernelProfile(body.effect_class, body.kernel_profile),
    owner: nonemptyString(body.owner, "automation_kernel_manifest_stage_owner"),
    lane: nonemptyString(body.lane, "automation_kernel_manifest_stage_lane"),
    ...(body.browser_surface === undefined ? {} : { browser_surface: nonemptyString(body.browser_surface, "automation_kernel_manifest_stage_browser_surface") }),
    needs_chrome: booleanValue(body.needs_chrome, "automation_kernel_manifest_stage_needs_chrome"),
    chrome_lease: body.chrome_lease == null ? null : objectValue(body.chrome_lease, "automation_kernel_manifest_stage_chrome_lease"),
    replay: nonemptyString(body.replay, "automation_kernel_manifest_stage_replay"),
    required: booleanValue(body.required, "automation_kernel_manifest_stage_required"),
    fan_out: body.fan_out == null ? null : objectValue(body.fan_out, "automation_kernel_manifest_stage_fan_out"),
    continuation: body.continuation == null ? null : objectValue(body.continuation, "automation_kernel_manifest_stage_continuation"),
    ...(body.entrypoints === undefined ? {} : { entrypoints: stringArray(body.entrypoints, "automation_kernel_manifest_stage_entrypoints") }),
    ...(body.approval_required === undefined ? {} : { approval_required: booleanValue(body.approval_required, "automation_kernel_manifest_stage_approval_required") }),
    ...(body.always_run === undefined ? {} : { always_run: booleanValue(body.always_run, "automation_kernel_manifest_stage_always_run") })
  };
  validateStageChrome(stage);
  if (stage.continuation) validateStageContinuation(stage);
  return stage;
}

function validateChromeLeaseContract(contract: JsonObject): void {
  const common: Record<string, unknown> = {
    mode: "jit_exclusive", scope: "stage", receipt_ttl_seconds: 300,
    receipt_scope: "current_session_turn_nonce", fresh_preflight: "required_before_each_stage_invocation", prior_receipt_reuse: "forbidden",
    acquire: "immediately_before_stage", release: "finally_after_terminal_receipt", no_cross_stage_hold: true,
    fallback: "forbidden"
  };
  const surface = String(contract.surface || "");
  const expected: Record<string, unknown> = surface === "in_app_browser"
    ? { schema: "automation_kernel_browser_stage_lease.v1", ...common, surface: "in_app_browser" }
    : surface === "browser_use_cli"
      ? { schema: "automation_kernel_browser_use_stage_lease.v1", ...common, surface: "browser_use_cli" }
      : {
    schema: "automation_kernel_chrome_stage_lease.v1", mode: "jit_exclusive", scope: "stage", receipt_ttl_seconds: 300,
    receipt_scope: "current_session_turn_nonce", fresh_preflight: "required_before_each_stage_invocation", prior_receipt_reuse: "forbidden",
    acquire: "immediately_before_stage", release: "finally_after_terminal_receipt", no_cross_stage_hold: true,
    surface: "signed_chrome_extension_profile2", fallback: "forbidden"
    };
  rejectUnknown(contract, new Set(Object.keys(expected)), "automation_kernel_manifest_chrome_lease_contract_unknown_field");
  for (const [key, value] of Object.entries(expected)) if (contract[key] !== value) throw new AutomationKernelManifestError(`automation_kernel_manifest_chrome_lease_contract_invalid:${key}`);
}

function validateBrowserUseContract(contract: JsonObject): void {
  const allowed = new Set([
    "surface", "helper_path", "runtime_config_path", "mode", "lifecycle", "allowed_origins",
    "profile_root", "reserved_port", "reserved_port_range", "authority_ref", "external_action_scope",
    "recording_required", "proof_policy", "cleanup_policy", "no_fallback"
  ]);
  rejectUnknown(contract, allowed, "automation_kernel_manifest_browser_use_unknown_field");
  if (contract.surface !== "browser_use_cli") throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_surface_invalid");
  const helperPath = absolutePath(contract.helper_path, "automation_kernel_manifest_browser_use_helper_path");
  if (helperPath !== browserUseHelperPath) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_helper_noncanonical");
  assertRegularFile(helperPath, "automation_kernel_manifest_browser_use_helper_missing");
  const runtimeConfigPath = absolutePath(contract.runtime_config_path, "automation_kernel_manifest_browser_use_runtime_config_path");
  if (runtimeConfigPath !== browserUseRuntimeConfigPath) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_runtime_config_noncanonical");
  assertRegularFile(runtimeConfigPath, "automation_kernel_manifest_browser_use_runtime_config_missing");
  if (!(contract.mode === "authorized" || contract.mode === "public")) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_mode_invalid");
  if (!(contract.lifecycle === "scheduled" || contract.lifecycle === "single-use")) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_lifecycle_invalid");
  if (contract.mode === "public" && contract.lifecycle !== "single-use") throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_public_lifecycle_invalid");
  const origins = stringArray(contract.allowed_origins, "automation_kernel_manifest_browser_use_allowed_origins");
  if (origins.length === 0) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_allowed_origins_required");
  for (const origin of origins) validateBrowserUseOrigin(origin);
  const profileRoot = absolutePath(contract.profile_root, "automation_kernel_manifest_browser_use_profile_root");
  if (profileRoot === "/" || profileRoot === "/Users" || profileRoot === "/Users/nichikatanaka") throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_profile_root_too_broad");
  if (String(contract.profile_root).split(sep).includes("..")) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_profile_root_traversal");
  const profileBase = contract.lifecycle === "scheduled" ? browserUseScheduledProfileRoot : browserUseSingleUseProfileRoot;
  assertPathComponentInside(profileBase, profileRoot, "automation_kernel_manifest_browser_use_profile_root_invalid");
  if (existsSync(profileRoot)) {
    const profileStat = lstatSync(profileRoot);
    if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_profile_root_invalid");
  }
  const port = contract.reserved_port;
  const expectedRange = contract.lifecycle === "scheduled" ? browserUseScheduledPortRange : browserUseSingleUsePortRange;
  if (!Number.isSafeInteger(port) || Number(port) < expectedRange.start || Number(port) > expectedRange.end) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_reserved_port_invalid");
  const range = contract.reserved_port_range;
  if (range !== undefined) {
    const rangeBody = objectValue(range, "automation_kernel_manifest_browser_use_reserved_port_range");
    rejectUnknown(rangeBody, new Set(["start", "end"]), "automation_kernel_manifest_browser_use_reserved_port_range_unknown_field");
    if (rangeBody.start !== expectedRange.start || rangeBody.end !== expectedRange.end) {
      throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_reserved_port_range_invalid");
    }
  }
  if (contract.mode === "authorized") {
    const authorityRef = nonemptyString(contract.authority_ref, "automation_kernel_manifest_browser_use_authority_ref");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(authorityRef) || authorityRef.includes("..")) {
      throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_authority_ref_invalid");
    }
  } else if (contract.authority_ref !== undefined && contract.authority_ref !== null) {
    throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_public_authority_ref_forbidden");
  }
  safeIdentifier(contract.external_action_scope, "automation_kernel_manifest_browser_use_external_action_scope");
  safeIdentifier(contract.proof_policy, "automation_kernel_manifest_browser_use_proof_policy");
  safeIdentifier(contract.cleanup_policy, "automation_kernel_manifest_browser_use_cleanup_policy");
  if (typeof contract.recording_required !== "boolean") throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_recording_required_invalid");
  if (contract.no_fallback !== true) throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_no_fallback_required");
}

function validateBrowserUseOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_allowed_origin_invalid");
  }
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:") || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_allowed_origin_invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || isIP(hostname) !== 0) {
    throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_allowed_origin_private");
  }
}

function assertPathComponentInside(base: string, candidate: string, code: string): void {
  const rel = relative(resolve(base), resolve(candidate));
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new AutomationKernelManifestError(code);
}

function safeIdentifier(value: unknown, code: string): string {
  const identifier = nonemptyString(value, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(identifier)) throw new AutomationKernelManifestError(`${code}_invalid`);
  return identifier;
}

function validateBrowserUseStageBinding(browserUse: JsonObject, chromeLeaseContract: JsonObject, stages: AutomationKernelManifestStageV1[]): void {
  const browserStages = stages.filter((stage) => stage.browser_surface !== undefined);
  if (browserStages.length === 0) return;
  if (browserStages.some((stage) => stage.browser_surface !== "browser_use_cli" || stage.lane !== "browser_use_cli" || stage.needs_chrome || stage.chrome_lease !== null)) {
    throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_mixed_surface");
  }
  if (chromeLeaseContract.surface !== "browser_use_cli" || chromeLeaseContract.schema !== "automation_kernel_browser_use_stage_lease.v1") {
    throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_stage_binding_mismatch");
  }
  if (browserUse.surface !== "browser_use_cli") throw new AutomationKernelManifestError("automation_kernel_manifest_browser_use_stage_binding_mismatch");
}

function validateStageChrome(stage: AutomationKernelManifestStageV1): void {
  if (stage.browser_surface === "browser_use_cli") {
    if (stage.needs_chrome || stage.chrome_lease !== null || stage.lane !== "browser_use_cli") {
      throw new AutomationKernelManifestError(`automation_kernel_manifest_browser_use_cli_stage_invalid:${stage.id}`);
    }
    return;
  }
  if (stage.browser_surface === "in_app_browser") {
    if (stage.needs_chrome || stage.chrome_lease !== null || stage.lane !== "in_app_browser") {
      throw new AutomationKernelManifestError(`automation_kernel_manifest_in_app_browser_stage_invalid:${stage.id}`);
    }
    return;
  }
  if (!stage.needs_chrome) {
    if (stage.chrome_lease !== null || stage.lane === "signed_chrome_extension_profile2") throw new AutomationKernelManifestError(`automation_kernel_manifest_non_chrome_stage_lease_invalid:${stage.id}`);
    return;
  }
  if (stage.lane !== "signed_chrome_extension_profile2" || !stage.chrome_lease) throw new AutomationKernelManifestError(`automation_kernel_manifest_chrome_stage_lease_missing:${stage.id}`);
  if (stage.chrome_lease.mode !== "jit_exclusive" || !new Set(["stage", "request"]).has(String(stage.chrome_lease.scope))) throw new AutomationKernelManifestError(`automation_kernel_manifest_chrome_stage_lease_invalid:${stage.id}`);
  const maxWall = stage.chrome_lease.max_wall_seconds;
  if (!Number.isSafeInteger(maxWall) || Number(maxWall) <= 0 || Number(maxWall) > 300) throw new AutomationKernelManifestError(`automation_kernel_manifest_chrome_stage_wall_invalid:${stage.id}`);
  if (!stage.fan_out || stage.fan_out.max_units_per_invocation !== 1) throw new AutomationKernelManifestError(`automation_kernel_manifest_chrome_stage_fan_out_invalid:${stage.id}`);
  if (!stage.continuation || stage.continuation.mode !== "fresh_preflight_per_invocation" || stage.continuation.fresh_preflight_required !== true || stage.continuation.reuse_prior_receipt !== false) throw new AutomationKernelManifestError(`automation_kernel_manifest_chrome_stage_continuation_invalid:${stage.id}`);
}

function validateStageContinuation(stage: AutomationKernelManifestStageV1): void {
  const continuation = stage.continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    throw new AutomationKernelManifestError(`automation_kernel_manifest_stage_continuation_invalid:${stage.id}`);
  }
  if (typeof continuation.unit_id !== "string" || !continuation.unit_id.trim()) {
    throw new AutomationKernelManifestError(`automation_kernel_manifest_stage_continuation_unit_id_required:${stage.id}`);
  }
}

function validateResultContract(contract: JsonObject): void {
  if (contract.schema !== "automation_kernel_result.v2") throw new AutomationKernelManifestError("automation_kernel_manifest_result_contract_schema_invalid");
  const statuses = stringArray(contract.terminal_statuses, "automation_kernel_manifest_result_terminal_statuses");
  if (statuses.length !== 3 || !["succeeded", "blocked", "failed"].every((value) => statuses.includes(value))) throw new AutomationKernelManifestError("automation_kernel_manifest_result_terminal_statuses_invalid");
  const fields = new Set(stringArray(contract.required_fields, "automation_kernel_manifest_result_required_fields"));
  if (fields.size !== requiredResultFields.size || [...requiredResultFields].some((field) => !fields.has(field))) throw new AutomationKernelManifestError("automation_kernel_manifest_result_required_fields_invalid");
  const blocked = new Set(stringArray(contract.blocked_requires, "automation_kernel_manifest_result_blocked_requires"));
  if (!["exact_blocker", "restart_stage", "cleanup_proof"].every((field) => blocked.has(field))) throw new AutomationKernelManifestError("automation_kernel_manifest_result_blocked_fields_invalid");
  nonemptyString(contract.artifact, "automation_kernel_manifest_result_artifact");
}

function resolveReference(root: string, value: string): string {
  const candidate = isAbsolute(value) ? resolve(value) : resolve(root, value);
  if (!isAbsolute(value)) assertInsideRoot(root, candidate, "automation_kernel_manifest_relative_path_escape");
  return candidate;
}
function assertInsideRoot(root: string, candidate: string, code: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new AutomationKernelManifestError(code);
}
function assertRegularFile(file: string, code: string): void {
  if (!existsSync(file)) throw new AutomationKernelManifestError(`${code}:${file}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AutomationKernelManifestError(`${code}:${file}`);
}
function assertDirectory(directory: string, code: string): void {
  if (!existsSync(directory)) throw new AutomationKernelManifestError(`${code}:${directory}`);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AutomationKernelManifestError(`${code}:${directory}`);
}
function absolutePath(value: unknown, code: string): string {
  const path = nonemptyString(value, code);
  if (!isAbsolute(path)) throw new AutomationKernelManifestError(`${code}_not_absolute`);
  return resolve(path);
}
function effectClass(value: unknown): AutomationKernelEffectClassV1 {
  if (value !== "internal_idempotent" && value !== "external_non_idempotent") throw new AutomationKernelManifestError("automation_kernel_manifest_stage_effect_class_invalid");
  return value;
}
function kernelProfile(effectClassValue: unknown, value: unknown): AutomationKernelProfileV1 {
  const effect = effectClass(effectClassValue);
  const selected = value === undefined
    ? (effect === "external_non_idempotent" ? "full" : "light")
    : value;
  if (selected !== "light" && selected !== "full") {
    throw new AutomationKernelManifestError("automation_kernel_manifest_stage_kernel_profile_invalid");
  }
  if (effect === "external_non_idempotent" && selected !== "full") {
    throw new AutomationKernelManifestError("automation_kernel_manifest_external_stage_requires_full_kernel");
  }
  return selected;
}
function boundedId(value: unknown, code: string, max: number): string {
  const id = nonemptyString(value, code);
  if (id.length > max || !idPattern.test(id)) throw new AutomationKernelManifestError(`${code}_invalid`);
  return id;
}
function boundedRunId(value: unknown): string {
  const id = nonemptyString(value, "automation_kernel_manifest_run_id");
  if (id.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new AutomationKernelManifestError("automation_kernel_manifest_run_id_invalid");
  }
  return id;
}
function nonemptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AutomationKernelManifestError(code);
  return value.trim();
}
function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new AutomationKernelManifestError(code);
  return value;
}
function objectValue(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationKernelManifestError(code);
  return value as JsonObject;
}
function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new AutomationKernelManifestError(code);
  return value;
}
function stringArray(value: unknown, code: string): string[] {
  return arrayValue(value, code).map((item) => nonemptyString(item, `${code}_item`));
}
function rejectUnknown(body: JsonObject, allowed: Set<string>, code: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new AutomationKernelManifestError(`${code}:${unknown.sort().join(",")}`);
}
