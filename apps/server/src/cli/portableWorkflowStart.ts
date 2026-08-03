import { initDb } from "../db/client.js";
import { isPortableWorkflowTrigger, startPortableWorkflowRun } from "../runs/portableWorkflowEntrypoint.js";
import type { PortableTrigger, PortableWorkflowId } from "../runs/portableWorkflowContract.js";

function argument(name: string): string {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3).trim() ?? "";
}

const workflowId = argument("workflow") as PortableWorkflowId;
const sourceTrigger = argument("trigger") as PortableTrigger;
const idempotencyKey = argument("idempotency-key");

if (!workflowId || !sourceTrigger || !idempotencyKey || !isPortableWorkflowTrigger(sourceTrigger)) {
  console.error(JSON.stringify({
    ok: false,
    exact_blocker: "portable_workflow_start_arguments_invalid",
    usage: "--workflow=<portable-workflow-id> --trigger=<automation_os_scheduler|codex_app_bridge|launchd|github_actions> --idempotency-key=<key>",
    external_action_executed: false
  }));
  process.exit(2);
}

try {
  initDb();
  const result = await startPortableWorkflowRun({ workflowId, sourceTrigger, idempotencyKey });
  console.log(JSON.stringify({ ok: true, ...result, external_action_executed: false }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    exact_blocker: error instanceof Error ? error.message : "portable_workflow_start_failed",
    external_action_executed: false
  }));
  process.exit(1);
}
