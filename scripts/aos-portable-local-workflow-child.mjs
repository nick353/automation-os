#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

// A worker-owned process keeps synchronous Mac adapters off the heartbeat
// event loop. Commands and destinations still come only from fixed adapters.
const root = path.resolve(process.env.AUTOMATION_OS_REPO_ROOT || path.join(import.meta.dirname, ".."));
const allowed = new Set(["daily-backup-safety-check", "obsidian-project-memory-audit", "nisenprints-existing-product-audit", "daily-ai-research-source-sync"]);
let request;
let executionStarted = false;
let result;
try {
  let bytes = "";
  for await (const chunk of process.stdin) {
    bytes += chunk;
    if (bytes.length > 2_000_000) throw new Error("portable_local_child_input_too_large");
  }
  request = JSON.parse(bytes);
  if (request.schema !== "aos.portable_local_child_request.v1" || !allowed.has(request.input?.workflowId)
    || !["read_only", "business_effect"].includes(request.execution_mode)) throw new Error("portable_local_child_input_invalid");
  const local = await import(pathToFileURL(path.join(root, "apps/server/dist/runs/portableLocalWorkflow.js")).href);
  const dailyAi = request.execution_mode === "business_effect" && request.input.workflowId === "daily-ai-research-source-sync"
    ? await import(pathToFileURL(path.join(root, "apps/server/dist/runs/dailyAiResearchSourceSync.js")).href) : null;
  if (!Number.isFinite(request.deadline_ms) || Date.now() >= request.deadline_ms) throw new Error("portable_local_claim_deadline_expired");
  executionStarted = true;
  const receipt = dailyAi ? await dailyAi.runDailyAiResearchSourceSyncBusiness(request.input)
    : request.execution_mode === "business_effect" ? await local.runPortableLocalWorkflowBusiness(request.input)
    : await local.runPortableLocalWorkflowReadOnly(request.input);
  result = { receipt };
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  result = { exact_blocker: /^[a-z][a-z0-9_]{0,159}$/u.test(message) ? message : "portable_local_child_failed" };
}
const response = {
  schema: "aos.portable_local_child_result.v1", run_id: request?.input?.runId,
  workflow_id: request?.input?.workflowId, execution_started: executionStarted, ...result
};
if (typeof process.send === "function") {
  await new Promise((resolve) => process.send(response, () => resolve()));
  process.disconnect();
}
process.exit(result.receipt ? 0 : 1);
