import fs from "node:fs";
import path from "node:path";

const INTERMEDIATE_PHASES = new Set(["start", "open", "readback"]);

export function validateCanaryReceipts({
  receipts,
  expectedRunId,
  expectedRequestedSession,
  expectedEffectiveSession,
  expectedPort,
  expectedFinalPath,
  expectedProfile,
  expectedPid,
}) {
  const checks = [];
  let terminalReceiptCount = 0;
  const entries = Array.isArray(receipts) ? receipts : [];
  const phases = entries.map((entry) => String(entry?.phase || ""));
  const finalizeCount = phases.filter((phase) => phase === "finalize").length;
  if (finalizeCount > 1) {
    return {
      checks: [{ ok: false, exact_blocker: "browser_use_canary_duplicate_final_receipt", phases }],
      terminal_receipt_count: finalizeCount,
      ok: false,
      exact_blocker: "browser_use_canary_duplicate_final_receipt",
    };
  }
  const lifecycleValid = phases.length >= 4
    && phases[0] === "start"
    && phases[1] === "open"
    && phases.at(-1) === "finalize"
    && phases.filter((phase) => phase === "start").length === 1
    && phases.filter((phase) => phase === "open").length === 1
    && phases.filter((phase) => phase === "finalize").length === 1
    && phases.slice(2, -1).length >= 1
    && phases.slice(2, -1).every((phase) => phase === "readback");
  if (!lifecycleValid) {
    return {
      checks: [{ ok: false, exact_blocker: "browser_use_canary_receipt_lifecycle_invalid", phases }],
      terminal_receipt_count: finalizeCount,
      ok: false,
      exact_blocker: "browser_use_canary_receipt_lifecycle_invalid",
    };
  }
  for (const entry of entries) {
    const phase = String(entry?.phase || "");
    const receiptPath = String(entry?.receipt_path || "");
    if (!receiptPath) {
      if (INTERMEDIATE_PHASES.has(phase) && entry?.finalized !== true) continue;
      checks.push({ ok: false, phase, exact_blocker: "browser_use_canary_receipt_missing" });
      continue;
    }
    if (phase !== "finalize" || entry?.finalized !== true) {
      checks.push({ ok: false, phase, receipt_path: receiptPath, exact_blocker: "browser_use_canary_receipt_event_invalid" });
      continue;
    }
    terminalReceiptCount += 1;
    if (!fs.existsSync(receiptPath)) {
      checks.push({ ok: false, phase, receipt_path: receiptPath, exact_blocker: "browser_use_canary_receipt_missing" });
      continue;
    }
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      const profile = String(receipt?.paths?.profile || "");
      const profileRoot = "/Users/nichikatanaka/.codex/browser-use/profiles/single-use";
      const lockPaths = Array.isArray(receipt?.cleanup?.locks_retained) ? receipt.cleanup.locks_retained : [];
      const locksRemoved = Array.isArray(receipt?.cleanup?.locks_removed) ? receipt.cleanup.locks_removed : [];
      const profileBound = profile.startsWith(`${profileRoot}/${expectedRunId}-`) && !profile.includes("..") && path.isAbsolute(profile);
      const cleanup = receipt?.cleanup || {};
      const readback = receipt?.guard_readback || {};
      const requestedSessionBound = receipt?.requested_session === expectedRequestedSession;
      const effectiveSessionBound = !expectedEffectiveSession || receipt?.session === expectedEffectiveSession;
      const descriptorBound = (!expectedProfile || receipt?.paths?.profile === expectedProfile)
        && (!Number.isInteger(expectedPid) || receipt?.pid === expectedPid)
        && receipt?.guard_readback?.preflight === true
        && receipt?.start_time;
      checks.push({
        ok: receiptPath === expectedFinalPath
          && receipt?.schema === "browser-use-receipt.v1"
          && receipt?.run_id === expectedRunId
          && requestedSessionBound
          && effectiveSessionBound
          && descriptorBound
          && receipt?.start_time
          && receipt?.requested_session === expectedRequestedSession
          && receipt?.port === expectedPort
          && receipt?.finalized === true
          && receipt?.authority_summary?.side_effect_scope === "bounded_recording"
          && receipt?.exit?.code === 0
          && !receipt?.exit?.exact_blocker
          && profileBound
          && cleanup.status === "cleaned"
          && cleanup.profile_removed === true
          && cleanup.download_dir_removed === true
          && locksRemoved.length === 2
          && lockPaths.length === 0
          && readback.post_command_state_readback === true,
        phase,
        receipt_path: receiptPath,
        run_id: receipt?.run_id || "",
        requested_session: receipt?.requested_session || "",
        session: receipt?.session || "",
        port: receipt?.port ?? null,
        pid: receipt?.pid ?? null,
        profile,
        profile_bound: profileBound,
        descriptor_bound: descriptorBound,
        lock_paths_retained: lockPaths,
        locks_removed: locksRemoved,
        finalized: receipt?.finalized === true,
        cleanup,
        guard_readback: {
          post_command_state_readback: readback.post_command_state_readback === true,
          process_identity_verified: readback.process_identity_verified === true,
          listener_verified: readback.listener_verified === true,
        },
        exact_blocker: receiptPath !== expectedFinalPath
          ? "browser_use_canary_receipt_final_path_mismatch"
          : !requestedSessionBound || !effectiveSessionBound
            ? "browser_use_canary_receipt_session_binding_failed"
            : !descriptorBound ? "browser_use_canary_receipt_descriptor_binding_failed" : "",
      });
    } catch {
      checks.push({ ok: false, phase, receipt_path: receiptPath, exact_blocker: "browser_use_canary_receipt_parse_failed" });
    }
  }
  const ok = terminalReceiptCount === 1 && checks.length === 1 && checks.every((entry) => entry.ok === true);
  return {
    checks,
    terminal_receipt_count: terminalReceiptCount,
    ok,
    exact_blocker: ok ? "" : terminalReceiptCount === 0 ? "browser_use_canary_final_receipt_missing" : terminalReceiptCount > 1 ? "browser_use_canary_duplicate_final_receipt" : "browser_use_canary_receipt_binding_failed",
  };
}
