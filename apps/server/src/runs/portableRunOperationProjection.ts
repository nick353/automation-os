import { createHash } from "node:crypto";
import { portableBusinessTargetDigest } from "./portableExternalApprovalBinding.js";
export type PortableProjectionRecord = Record<string, unknown>;
export type PortableRunOperationProjection = {
  same_run: boolean; run_id: string | null; company_id: string | null; approval_id: string | null;
  execution_mode: string | null; execution_mode_label: string;
  planned_operation_scope: { status: "planned" | "missing" | "mismatch"; operation: string | null; account_ref: string | null; target_key: string | null; payload_hash: string | null; source_snapshot_id: string | null; vault_path: string | null; repository: string | null; branch: string | null; provenance: Record<string, string> };
  observed_results: { status: "observed" | "not_run" | "not_acquired"; source: "same_run_receipt" | "none"; operation: string | null; maintenance: boolean | null; export: boolean | null; git_sync: boolean | null; provenance: Record<string, string> };
  missing: string[]; mismatches: string[];
};

const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const rec = (v: unknown): PortableProjectionRecord => v && typeof v === "object" && !Array.isArray(v) ? v as PortableProjectionRecord : {};
const sha = (v: unknown) => { const s = text(v); return s && /^[a-f0-9]{64}$/u.test(s) ? s : null; };
const json = (v: unknown) => { if (typeof v !== "string") return rec(v); try { return rec(JSON.parse(v)); } catch { return {}; } };

export function buildPortableRunOperationProjection(input: { run: PortableProjectionRecord; approval?: PortableProjectionRecord | null; receipt?: PortableProjectionRecord | null; registeredContract?: PortableProjectionRecord | null }): PortableRunOperationProjection {
  const run = input.run, metadata = json(run.metadata_json), invocation = rec(metadata.portable_workflow_invocation);
  const bundleRecord = rec(metadata.portable_input_bundle), bundle = rec(bundleRecord.input);
  const binding = rec(metadata.portable_target_bound_approval_binding), bindingTarget = rec(binding.target);
  const source = rec(metadata.source_snapshot), approval = input.approval, receipt = input.receipt;
  const runId = text(run.id), companyId = text(run.company_id ?? run.project_id), metadataApprovalId = text(metadata.approval_id), approvalId = text(approval?.id);
  const mismatches: string[] = [];
  if (!metadataApprovalId || !approvalId || metadataApprovalId !== approvalId) mismatches.push("approval_id_binding");
  for (const [field, value, expected] of [["approval.run_id", approval ? text(approval.run_id) : null, runId], ["approval.company_id", approval ? text(approval.company_id) : null, companyId], ["receipt.run_id", receipt ? text(receipt.run_id) : null, runId], ["receipt.company_id", receipt ? text(receipt.company_id) : null, companyId]] as const) if (value !== null && value !== expected) mismatches.push(field);
  const pick = (...candidates: Array<[unknown, string]>): [string | null, string | null] => {
    for (const [value, path] of candidates) { const selected = text(value); if (selected) return [selected, path]; }
    return [null, null];
  };
  const pickHash = (...candidates: Array<[unknown, string]>): [string | null, string | null] => {
    for (const [value, path] of candidates) { const selected = sha(value); if (selected) return [selected, path]; }
    return [null, null];
  };
  const [operation, operationPath] = pick([bundle.operation, "run.portable_input_bundle.input.operation"], [invocation.operation, "run.portable_workflow_invocation.operation"], [binding.operation, "run.portable_target_bound_approval_binding.operation"]);
  const [accountRef, accountRefPath] = pick([bundle.account_ref, "run.portable_input_bundle.input.account_ref"], [bindingTarget.account_ref, "run.portable_target_bound_approval_binding.target.account_ref"]);
  const [targetKey, targetKeyPath] = pick([bundle.target_key, "run.portable_input_bundle.input.target_key"], [bindingTarget.target_key, "run.portable_target_bound_approval_binding.target.target_key"]);
  const [payloadHash, payloadHashPath] = pickHash([bundle.payload_hash, "run.portable_input_bundle.input.payload_hash"], [bindingTarget.payload_hash, "run.portable_target_bound_approval_binding.target.payload_hash"]);
  const [sourceSnapshotId, sourceSnapshotIdPath] = pick([bundle.source_snapshot_id, "run.portable_input_bundle.input.source_snapshot_id"], [source.source_snapshot_id, "run.source_snapshot.source_snapshot_id"], [bindingTarget.source_snapshot_id, "run.portable_target_bound_approval_binding.target.source_snapshot_id"]);
  const [vaultPath, vaultPathPath] = pick([bundle.vault_path, "run.portable_input_bundle.input.vault_path"], [source.vault_path, "run.source_snapshot.vault_path"]);
  const [repository, repositoryPath] = pick([bundle.repository, "run.portable_input_bundle.input.repository"], [source.repository, "run.source_snapshot.repository"]);
  const [branch, branchPath] = pick([bundle.branch, "run.portable_input_bundle.input.branch"], [source.branch, "run.source_snapshot.branch"]);
  const provenance: Record<string, string> = {};
  for (const [key, value, path] of [["operation", operation, operationPath], ["account_ref", accountRef, accountRefPath], ["target_key", targetKey, targetKeyPath], ["payload_hash", payloadHash, payloadHashPath], ["source_snapshot_id", sourceSnapshotId, sourceSnapshotIdPath], ["vault_path", vaultPath, vaultPathPath], ["repository", repository, repositoryPath], ["branch", branch, branchPath]] as const) if (value && path) provenance[key] = path;
  const required: Array<[string, unknown]> = [["account_ref", accountRef], ["target_key", targetKey], ["payload_hash", payloadHash], ["source_snapshot_id", sourceSnapshotId]];
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (approval && sha(approval.payload_hash) && payloadHash && sha(approval.payload_hash) !== payloadHash) mismatches.push("approval.payload_hash");
  if (text(source.source_snapshot_id) && sourceSnapshotId && text(source.source_snapshot_id) !== sourceSnapshotId) mismatches.push("source_snapshot_id");
  const version = text(run.automation_version_id ?? invocation.registered_automation_version_id), digest = sha(run.target_digest ?? invocation.target_digest), runPayload = sha(run.payload_hash ?? invocation.payload_hash);
  if (input.registeredContract) {
    const contract = rec(input.registeredContract), contractVersion = text(contract.automation_version_id ?? contract.version_id), contractDigest = sha(contract.target_digest), contractPayload = sha(contract.payload_hash);
    if (contractVersion && version && contractVersion !== version) mismatches.push("registeredContract.version");
    if (contractDigest && digest && contractDigest !== digest) mismatches.push("registeredContract.digest");
    if (contractPayload && runPayload && contractPayload !== runPayload) mismatches.push("registeredContract.payload");
  }
  const canonicalBundle = bundleRecord.created_at && runId && text(invocation.workflow_id) ? `${JSON.stringify({ schema: "automation_os_portable_workflow_input_bundle.v1", workflow_id: text(invocation.workflow_id), run_id: runId, input: bundle, created_at: bundleRecord.created_at }, null, 2)}\n` : null;
  const computedBundleSha = canonicalBundle ? createHash("sha256").update(canonicalBundle).digest("hex") : null;
  if (text(bundleRecord.run_id) && text(bundleRecord.run_id) !== runId) mismatches.push("portable_input_bundle.run_id");
  if (text(bundleRecord.sha256) && computedBundleSha && text(bundleRecord.sha256) !== computedBundleSha) mismatches.push("portable_input_bundle.sha256");
  const inputBound = Boolean(text(bundleRecord.run_id) === runId && text(bundleRecord.sha256) === computedBundleSha);
  const computedTargetDigest = Object.keys(bundle).length ? portableBusinessTargetDigest(bundle) : null;
  const bindingChecks: Array<[string, unknown, unknown]> = [["portable_target_bound_approval_binding.workflow_id", binding.workflow_id, invocation.workflow_id], ["portable_target_bound_approval_binding.input_bundle_sha256", binding.input_bundle_sha256, bundleRecord.sha256], ["portable_target_bound_approval_binding.target_digest", binding.target_digest, computedTargetDigest], ["portable_target_bound_approval_binding.target.account_ref", bindingTarget.account_ref, bundle.account_ref], ["portable_target_bound_approval_binding.target.target_key", bindingTarget.target_key, bundle.target_key], ["portable_target_bound_approval_binding.target.source_snapshot_id", bindingTarget.source_snapshot_id, bundle.source_snapshot_id]];
  for (const [field, value, expected] of bindingChecks) if (value === undefined || expected === undefined || value !== expected) mismatches.push(field);
  const storeBinding = Boolean(text(binding.run_id) === runId && text(binding.company_id) === companyId && !bindingChecks.some(([field]) => mismatches.includes(field)));
  const sameRunBinding = Boolean(runId && companyId && metadataApprovalId && approvalId && metadataApprovalId === approvalId && text(approval?.run_id) === runId && text(approval?.company_id) === companyId && inputBound && storeBinding);
  const plannedStatus: "planned" | "missing" | "mismatch" = (mismatches.length || (bundleRecord.input && !inputBound)) ? "mismatch" : (operation && accountRef && targetKey && payloadHash && sourceSnapshotId ? "planned" : "missing");
  const receiptSame = Boolean(receipt && text(receipt.run_id) === runId && text(receipt.company_id) === companyId && !mismatches.some((m) => m.startsWith("receipt.")));
  const ar = rec(receipt?.adapter_result);
  const observed: PortableRunOperationProjection["observed_results"] = receiptSame ? { status: "observed", source: "same_run_receipt", operation: text(ar.operation), maintenance: typeof ar.maintenance_ok === "boolean" ? ar.maintenance_ok as boolean : null, export: typeof ar.export_ok === "boolean" ? ar.export_ok as boolean : null, git_sync: typeof ar.git_sync_ok === "boolean" ? ar.git_sync_ok as boolean : null, provenance: { operation: "receipt.adapter_result.operation", maintenance: "receipt.adapter_result.maintenance_ok", export: "receipt.adapter_result.export_ok", git_sync: "receipt.adapter_result.git_sync_ok" } } : { status: ["waiting_approval", "approval_required", "queued", "pending"].includes(String(run.status)) ? "not_run" : "not_acquired", source: "none", operation: null, maintenance: null, export: null, git_sync: null, provenance: {} };
  const business = text(invocation.effect_stage) === "business_execute" || text(metadata.effect_stage) === "business_execute";
  return { same_run: Boolean(sameRunBinding && !mismatches.length), run_id: runId, company_id: companyId, approval_id: approvalId, execution_mode: text(invocation.execution_mode ?? metadata.execution_mode), execution_mode_label: business || text(invocation.execution_mode) === "business_effect" ? "業務実行" : text(invocation.execution_mode) === "read_only" ? "読取専用" : "実行種別未確認", planned_operation_scope: { status: plannedStatus, operation, account_ref: accountRef, target_key: targetKey, payload_hash: payloadHash, source_snapshot_id: sourceSnapshotId, vault_path: vaultPath, repository, branch, provenance }, observed_results: observed, missing, mismatches };
}
