import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readControlledAuditResult, isSuccessfulAuditHandoff, isReadOnlyDiagnosticConfig } from "../../.codex/automation-kernel/runners/aos-companion-2.mjs";
import { readPendingRootActionAudit } from "../aos-hourly-companion-audit.mjs";

const PROJECT_ROOT = "/Users/nichikatanaka/Documents/Codex/automation-os";
const MANIFEST_PATH = path.join(PROJECT_ROOT, ".codex/automation-kernel/manifests/aos-companion-2.json");
const CONFIG_PATH = path.join(PROJECT_ROOT, ".codex/automation-kernel/runners/aos-companion-2.config.json");
const AUTOMATION_PATH = "/Users/nichikatanaka/.codex/automations/aos-companion-controller/automation.toml";
const AUDIT_ENTRYPOINT = path.join(PROJECT_ROOT, "scripts/aos-hourly-companion-audit.mjs");

function registeredPrompt() {
  const source = fs.readFileSync(AUTOMATION_PATH, "utf8");
  const line = source.split("\n").find((item) => item.startsWith("prompt = "));
  assert.ok(line, "registered automation prompt is missing");
  return JSON.parse(line.slice("prompt = ".length));
}

test("diagnostic recovery is restricted to the exact read-only CLI, not any internal command", () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH));
  assert.equal(isReadOnlyDiagnosticConfig(config), true);
  for (const override of [
    { automation_id: "other" }, { effect_class: "external_non_idempotent" }, { needs_chrome: true },
    { cwd: "/tmp" }, { command: ["/bin/sh", AUDIT_ENTRYPOINT] },
    { command: [config.command[0], "/tmp/another.mjs"] }, { command: [...config.command, "--execute"] },
  ]) assert.equal(isReadOnlyDiagnosticConfig({ ...config, ...override }), false);
});

test("registered Companion Root adapter matches the manifest runner", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const runnerPath = path.resolve(PROJECT_ROOT, manifest.runner.path);
  const prompt = registeredPrompt();
  const auditSource = fs.readFileSync(AUDIT_ENTRYPOINT, "utf8");

  assert.equal(manifest.id, "aos-companion-2");
  assert.equal(runnerPath, path.join(PROJECT_ROOT, ".codex/automation-kernel/runners/aos-companion-2.mjs"));
  assert.equal(fs.statSync(runnerPath).isFile(), true);
  assert.equal(config.automation_id, manifest.id);
  assert.equal(path.resolve(config.command[1]), path.join(PROJECT_ROOT, "scripts/aos-hourly-companion-audit.mjs"));
  assert.ok(config.stage_timeout_seconds <= 120, "the child audit must terminalize before the official Root heartbeat boundary");
  assert.match(auditSource, /executionReceipt\?\.rootActionRequired === true/u);
  assert.match(prompt, /^AOS Companion毎時監査/u);
  assert.match(prompt, /runScheduledCompanionController/u);
  assert.match(prompt, /timeout_ms[:=]240000/u);
  assert.match(prompt, /collectorがcursorで全ページ/u);
  assert.match(prompt, /送信は公式send_message_to_threadのみ/u);
  assert.match(prompt, /公式wait_threads\/read_threadで確認/u);
  assert.match(prompt, /未確認なら同じtask\/turn\/keyのread-only照合/u);
  assert.match(prompt, /次回を待つためturnを保持せず/u);
  assert.equal(prompt.includes(`runnerPath:"${runnerPath}"`), false);
});

test("registered Companion Root preserves a controlled audit blocker", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "aos-companion-runner-"));
  const auditPath = path.join(dir, "aos-hourly-companion-audit.v1.json");
  fs.writeFileSync(auditPath, JSON.stringify({
    schema: "aos.hourly_companion_audit.v1",
    readOnly: true,
    externalActionExecuted: false,
    executionReceipt: { status: "blocked", exactBlocker: "active_reconciliation", externalActionExecuted: false },
  }));
  assert.deepEqual(readControlledAuditResult(dir), {
    status: "blocked",
    exact_blocker: "active_reconciliation",
    path: auditPath,
  });
  fs.writeFileSync(auditPath, JSON.stringify({
    schema: "aos.hourly_companion_audit.v1",
    readOnly: true,
    externalActionExecuted: true,
    executionReceipt: { status: "blocked", exactBlocker: "active_reconciliation", externalActionExecuted: true },
  }));
  assert.equal(readControlledAuditResult(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registered Companion Root keeps an actionable audit as a non-terminal Root handoff", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "aos-companion-runner-root-action-"));
  const auditPath = path.join(dir, "aos-hourly-companion-audit.v1.json");
  fs.writeFileSync(auditPath, JSON.stringify({
    schema: "aos.hourly_companion_audit.v1",
    readOnly: true,
    externalActionExecuted: false,
    executionReceipt: {
      status: "inspected",
      complete: false,
      auditOnly: true,
      rootActionRequired: true,
      externalActionExecuted: false,
    },
  }));
  assert.deepEqual(readControlledAuditResult(dir), {
    status: "root_action_required",
    exact_blocker: "official_app_post_audit_callback_required",
    root_action_required: true,
    audit_status: "inspected",
    handoff_only: true,
    path: auditPath,
  });
  const controlled = readControlledAuditResult(dir);
  const normal = { exit_status: 2, residual_owned_processes: 0 };
  assert.equal(isSuccessfulAuditHandoff(normal, controlled), true);
  // 2026-09-06 01:56 natural Root: the production supervisor used false,
  // not numeric 0, and a normal handoff was incorrectly made a failed stage.
  assert.equal(isSuccessfulAuditHandoff({ ...normal, residual_owned_processes: false }, controlled), true);
  assert.equal(isSuccessfulAuditHandoff(normal, controlled, true), false);
  for (const changed of [{ exit_status: 1 }, { spawn_error: "failed" }, { signal: "SIGTERM" },
    { timed_out: true }, { owned_process_cleanup_required: true }, { residual_owned_processes: 1 },
    { residual_owned_processes: undefined }, { residual_owned_processes: null },
    { residual_owned_processes: "0" }, { residual_owned_processes: true }, { ownership_scan_error: "unknown" }]) {
    assert.equal(isSuccessfulAuditHandoff({ ...normal, ...changed }, controlled), false);
  }
  const original = JSON.parse(fs.readFileSync(auditPath));
  for (const changed of [{ status: "blocked" }, { status: "failed" }, { auditOnly: false },
    { externalActionExecuted: true }, { exactBlocker: "active_reconciliation" },
    { stageReceipts: { fresh_status: { status: "failed" } } }]) {
    fs.writeFileSync(auditPath, JSON.stringify({ ...original, executionReceipt: { ...original.executionReceipt, ...changed } }));
    assert.equal(isSuccessfulAuditHandoff(normal, readControlledAuditResult(dir)), false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hourly audit keeps an unfinalized Root callback pending across a no-change tick", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "aos-companion-pending-root-"));
  const auditPath = path.join(dir, "aos-hourly-companion-audit.v1.json");
  fs.writeFileSync(auditPath, JSON.stringify({
    schema: "aos.hourly_companion_audit.v1",
    externalActionExecuted: false,
    executionReceipt: { rootActionRequired: true, externalActionExecuted: false },
    runId: "prior-run",
  }));
  assert.equal(readPendingRootActionAudit(dir).pending, true);
  const receiptPath = path.join(dir, "controller-receipt.json");
  fs.writeFileSync(receiptPath, "{}\n");
  fs.writeFileSync(auditPath, JSON.stringify({
    schema: "aos.hourly_companion_audit.v1",
    externalActionExecuted: false,
    executionReceipt: { rootActionRequired: true, externalActionExecuted: false },
    controllerReceiptPath: receiptPath,
    runId: "prior-run",
  }));
  assert.equal(readPendingRootActionAudit(dir).pending, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
