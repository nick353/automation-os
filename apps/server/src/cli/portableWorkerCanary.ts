import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runPortableWorkerCanary } from "../runs/portableWorkerCanary.js";
import { portableWorkflowManifests, type PortableTrigger, type PortableWorkflowId } from "../runs/portableWorkflowContract.js";

const workflowArg = process.argv.find((arg) => arg.startsWith("--workflow="))?.slice("--workflow=".length) ?? "job-application-manager";
const triggerArg = process.argv.find((arg) => arg.startsWith("--trigger="))?.slice("--trigger=".length) ?? "automation_os_scheduler";
const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);

if (!(workflowArg in portableWorkflowManifests)) throw new Error("portable_worker_workflow_required");
if (!["automation_os_scheduler", "automation_os_ui", "codex_app_bridge", "launchd", "github_actions"].includes(triggerArg)) {
  throw new Error("portable_worker_trigger_invalid");
}

const receipt = runPortableWorkerCanary({
  runId: `canary-${Date.now()}`,
  workflowId: workflowArg as PortableWorkflowId,
  sourceTrigger: triggerArg as PortableTrigger,
  idempotencyKey: `portable-canary:${workflowArg}`
});

if (outputArg) {
  const output = resolve(outputArg);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify({ ok: true, ...receipt, external_action_executed: false })}\n`);
