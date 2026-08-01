#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { runBrowserUseCliStage } from "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";
import { validateCanaryReceipts } from "./browserUseCanaryReceipt.mjs";

const requestedRunId = String(process.env.AUTOMATION_KERNEL_RUN_ID || process.env.AUTOMATION_OS_RUN_ID || "").trim();
const artifactRoot = String(process.env.AUTOMATION_KERNEL_ARTIFACT_DIR || "").trim();
let runId = requestedRunId;
let automationId = "automation-os-iab";
let stageId = "workflow";
let session = `${automationId}-${runId || "missing-run"}`.replace(/[^A-Za-z0-9._:-]+/gu, "-").slice(0, 120);
let attempt = 1;
let reservedPort = 19980;
const requestedExpiresAt = String(process.env.AUTOMATION_BROWSER_USE_EXPIRES_AT || "").trim();
let expiresAt = requestedExpiresAt;
let idempotencyKey = `${automationId}:${runId}:${stageId}:${attempt}`;
const manifestPath = "/Users/nichikatanaka/Documents/Codex/automation-os/.codex/automation-kernel/manifests/automation-os-iab.json";
const helperPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";
const adapterPath = "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";
const canaryPath = new URL(import.meta.url);
const runtimeConfigPath = "/Users/nichikatanaka/.codex/browser-use/browser-use-runtime.toml";
const approvalAnchorPath = "/Users/nichikatanaka/Documents/Codex/automation-os/work/goal-orchestration/browser-use-runtime-approval-anchor-r18.v1.json";
function fileDigest(filePath) {
  return fs.existsSync(filePath) ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") : "";
}
const manifestDigest = fs.existsSync(manifestPath)
  ? crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex")
  : "";
const helperDigest = fs.existsSync(helperPath)
  ? crypto.createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex")
  : "";
const adapterDigest = fileDigest(adapterPath);
const canaryDigest = fileDigest(canaryPath);
const runtimeConfigDigest = fileDigest(runtimeConfigPath);
let bindingDigest = "";

function readPinnedJson(filePath) {
  if (!filePath.startsWith("/") || !fs.constants.O_NOFOLLOW) return null;
  try {
    const resolved = fs.realpathSync(filePath);
    if (resolved !== filePath) return null;
    const parent = fs.lstatSync(path.dirname(resolved));
    const uid = process.getuid?.();
    if (parent.isSymbolicLink() || !parent.isDirectory() || (uid !== undefined && parent.uid !== uid) || (parent.mode & 0o022) !== 0) return null;
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) return null;
      const bytes = fs.readFileSync(fd);
      return { value: JSON.parse(bytes.toString("utf8")), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), dev: stat.dev, ino: stat.ino };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readApprovedPacket() {
  const anchorRecord = readPinnedJson(approvalAnchorPath);
  const anchor = anchorRecord?.value;
  if (!anchor || anchor.schema !== "automation_os_browser_use_runtime_approval_anchor.v1" || anchor.authorization_status !== "approved_by_security_reviewer_r2" || !/^[a-f0-9]{64}$/u.test(String(anchor.packet_sha256 || "")) || !String(anchor.packet_path || "").startsWith("/Users/nichikatanaka/Documents/Codex/automation-os/work/goal-orchestration/")) return null;
  const packetRecord = readPinnedJson(String(anchor.packet_path));
  if (!packetRecord || packetRecord.sha256 !== anchor.packet_sha256) return null;
  return { packet: packetRecord.value, packetPath: String(anchor.packet_path), packetSha: packetRecord.sha256, anchorDigest: anchorRecord.sha256, anchorDev: anchorRecord.dev, anchorIno: anchorRecord.ino };
}

const approval = readApprovedPacket();
const approvalPacket = approval?.packet || null;
const approvalPacketPath = approval?.packetPath || "";
const approvalPacketSha = approval?.packetSha || "";
const approvalAnchorDigest = approval?.anchorDigest || "";
const approvalAnchorDev = approval?.anchorDev ?? null;
const approvalAnchorIno = approval?.anchorIno ?? null;
let approvalClaim = null;
const packetBinding = approvalPacket?.fresh_binding;
const packetScope = approvalPacket?.scope;
if (packetBinding && packetScope) {
  runId = String(packetBinding.run_id || "");
  automationId = String(packetScope.automation_id || "");
  stageId = String(packetScope.stage_id || "");
  session = String(packetBinding.session || "");
  attempt = Number(packetBinding.attempt);
  reservedPort = Number(packetScope.port);
  expiresAt = String(packetBinding.expires_at || "");
  idempotencyKey = String(packetBinding.idempotency_key || "");
}
const requestedBindingMismatch = (requestedRunId && requestedRunId !== runId) || (requestedExpiresAt && requestedExpiresAt !== expiresAt);
bindingDigest = crypto.createHash("sha256").update(JSON.stringify({
  automation_id: automationId,
  run_id: runId,
  stage_id: stageId,
  session,
  attempt,
  idempotency_key: idempotencyKey,
  expires_at: expiresAt,
  allowed_origin: "https://example.com",
  port: reservedPort,
  manifest_digest: manifestDigest,
  helper_digest: helperDigest,
})).digest("hex");
function runtimeApprovalMatches() {
  const binding = approvalPacket?.fresh_binding;
  const scope = approvalPacket?.scope;
  const hashes = approvalPacket?.current_hashes;
  return Boolean(approvalPacket
    && ["pending_runtime_security_approval", "approved_by_security_reviewer_r2"].includes(approvalPacket.authorization_status)
    && binding?.run_id === runId
    && binding?.session === session
    && binding?.attempt === attempt
    && binding?.idempotency_key === idempotencyKey
    && binding?.expires_at === expiresAt
    && binding?.binding_digest === bindingDigest
    && scope?.automation_id === automationId
    && scope?.stage_id === stageId
    && scope?.allowed_origin === "https://example.com"
    && scope?.port === reservedPort
    && JSON.stringify(scope?.command) === JSON.stringify(["open", "https://example.com"])
    && JSON.stringify(scope?.post_commands) === JSON.stringify([["state"], ["get", "title"], ["get", "url"]])
    && hashes?.helper?.sha256 === helperDigest
    && hashes?.adapter?.sha256 === adapterDigest
    && hashes?.canary?.sha256 === canaryDigest
    && hashes?.manifest?.sha256 === manifestDigest
    && hashes?.runtime_config?.sha256 === runtimeConfigDigest
    && /^[a-f0-9]{64}$/u.test(approvalPacketSha)
    && approvalAnchorDigest.length === 64
    && Number.isInteger(approvalAnchorDev)
    && Number.isInteger(approvalAnchorIno)
    && requestedBindingMismatch !== true);
}

function claimApprovalAnchor() {
  const claimPath = `${approvalAnchorPath}.${runId}.claim.json`;
  const claim = {
    schema: "automation_os_browser_use_runtime_approval_claim.v1",
    anchor_path: approvalAnchorPath,
    anchor_sha256: approvalAnchorDigest,
    anchor_dev: approvalAnchorDev,
    anchor_ino: approvalAnchorIno,
    packet_path: approvalPacketPath,
    packet_sha256: approvalPacketSha,
    run_id: runId,
    session,
    attempt,
    idempotency_key: idempotencyKey,
    claimed_at: new Date().toISOString(),
  };
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(claimPath, flags, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) throw new Error("browser_use_runtime_approval_claim_identity_invalid");
    const bytes = Buffer.from(`${JSON.stringify(claim)}\n`, "utf8");
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    return { path: claimPath, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), inode: stat.ino, device: stat.dev };
  } finally {
    fs.closeSync(fd);
  }
}

function safeSummary(value) {
  return {
    schema: "automation_os_browser_use_readonly_canary.v1",
    status: value?.status || "blocked",
    exact_blocker: value?.exact_blocker || "",
    browser_surface: value?.browser_surface || "browser_use_cli",
    run_id: value?.run_id || runId,
    stage_id: value?.stage_id || stageId,
    session: value?.session || session,
    attempt,
    idempotency_key: idempotencyKey,
    expires_at: expiresAt,
    binding_digest: bindingDigest,
    reserved_port: reservedPort,
    manifest_digest: manifestDigest,
    helper_digest: helperDigest,
    adapter_digest: adapterDigest,
    canary_digest: canaryDigest,
    runtime_config_digest: runtimeConfigDigest,
    approval_packet: approvalPacketPath,
    approval_anchor_sha256: approvalAnchorDigest,
    approval_anchor_claim: approvalClaim,
    approval_status: approvalPacket?.authorization_status || "",
    command_count: value?.command_count || 0,
    artifact_uri: value?.artifact_uri || "",
    cleanup_verified: value?.cleanup_verified === true,
    external_action_executed: false,
    secrets_emitted: false
  };
}

function findUrlCandidate(value) {
  if (typeof value === "string") {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/gu) || [];
    return matches.find((candidate) => {
      try {
        const url = new URL(candidate);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }) || "";
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findUrlCandidate(entry);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = findUrlCandidate(entry);
      if (found) return found;
    }
  }
  return "";
}

function readbackOriginCheck(value) {
  if (value?.semantic_readback && typeof value.semantic_readback === "object") {
    return {
      ok: value.semantic_readback.url === "https://example.com/"
        && value.semantic_readback.origin === "https://example.com"
        && value.semantic_readback.redirect_count === 0
        && value.semantic_readback.final_dns_resolution?.public_only === true,
      final_origin_digest: value.semantic_readback.origin_sha256 || "",
      exact_blocker: value.semantic_readback.url === "https://example.com/" ? "" : "browser_use_canary_final_url_invalid",
    };
  }
  const raw = value?.captured_readback?.["2"] || "";
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch { /* browser CLI may emit a text line */ }
  const candidate = findUrlCandidate(parsed);
  if (!candidate) return { ok: false, exact_blocker: "browser_use_canary_final_url_missing" };
  try {
    const url = new URL(candidate);
    const origin = url.origin;
    return {
      ok: origin === "https://example.com",
      final_origin_digest: crypto.createHash("sha256").update(origin).digest("hex"),
      exact_blocker: origin === "https://example.com" ? "" : "browser_use_canary_redirect_origin_not_allowed",
    };
  } catch {
    return { ok: false, exact_blocker: "browser_use_canary_final_url_invalid" };
  }
}

const expiresAtMs = Date.parse(expiresAt);
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(runId) || !artifactRoot.startsWith("/") || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || !runtimeApprovalMatches()) {
  process.stdout.write(`${JSON.stringify(safeSummary({ exact_blocker: "browser_use_canary_runtime_approval_packet_mismatch" }))}\n`);
  process.exitCode = 2;
} else {
  let claimError = "";
  try {
    approvalClaim = claimApprovalAnchor();
  } catch (error) {
    claimError = error?.message || "browser_use_runtime_approval_claim_failed";
  }
  if (claimError) {
    process.stdout.write(`${JSON.stringify(safeSummary({ exact_blocker: claimError }))}\n`);
    process.exitCode = 2;
  } else {
  const result = await runBrowserUseCliStage({
    automationId,
    runId,
    stageId,
    session,
    mode: "public",
    lifecycle: "single-use",
    port: reservedPort,
    authorityDigest: bindingDigest,
    expiresAt,
    allowedOrigins: ["https://example.com"],
    command: ["open", "https://example.com"],
    postCommands: [["state"], ["get", "title"], ["get", "url"]],
    artifactDir: path.join(path.resolve(artifactRoot), "browser-use-stage"),
    timeoutMs: 180_000
  });
  const summary = safeSummary(result);
  if (result?.semantic_readback && typeof result.semantic_readback === "object") summary.semantic_readback = result.semantic_readback;
  summary.redirect_origin_check = readbackOriginCheck(result);
  if (result?.status === "completed" && summary.redirect_origin_check.ok !== true) {
    summary.status = "blocked";
    summary.exact_blocker = summary.redirect_origin_check.exact_blocker;
    summary.cleanup_verified = false;
  }
  const effectiveSession = String(result?.start_descriptor?.effective_session || "");
  const descriptor = result?.start_descriptor || {};
  const descriptorProfile = String(descriptor.profile || "");
  const descriptorPid = Number(descriptor?.process?.pid);
  const descriptorBindingValid = descriptor.requested_session === session
    && descriptor.effective_session === effectiveSession
    && descriptor.port === reservedPort
    && descriptor.expires_at === expiresAt
    && descriptor.helper_sha256 === helperDigest
    && descriptorProfile.startsWith(`/Users/nichikatanaka/.codex/browser-use/profiles/single-use/${runId}-`)
    && Number.isInteger(descriptorPid);
  const receiptValidation = validateCanaryReceipts({
    receipts: result?.receipts,
    expectedRunId: runId,
    expectedRequestedSession: session,
    expectedEffectiveSession: effectiveSession,
    expectedPort: reservedPort,
    expectedFinalPath: String(result?.final_receipt?.path || ""),
    expectedProfile: descriptorProfile,
    expectedPid: descriptorPid,
  });
  const receiptChecks = receiptValidation.checks;
  summary.receipt_checks = receiptChecks;
  summary.final_receipt_count = receiptValidation.terminal_receipt_count;
  if (result?.status === "completed" && !descriptorBindingValid) {
    summary.status = "blocked";
    summary.exact_blocker = "browser_use_canary_descriptor_binding_failed";
    summary.cleanup_verified = false;
  } else if (result?.status === "completed" && receiptValidation.ok !== true) {
    summary.status = "blocked";
    summary.exact_blocker = receiptValidation.exact_blocker;
    summary.cleanup_verified = false;
  }
  const summaryPath = path.join(path.resolve(artifactRoot), "browser-use-readonly-canary-summary.v1.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ ...summary, summary_path: summaryPath })}\n`);
  process.exitCode = summary.status === "completed" && summary.cleanup_verified === true ? 0 : 1;
  }
}
