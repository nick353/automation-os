import { initDb } from "../db/client.js";
import { closeSharedAppServerClient, processQueuedCreatePlannerJobs } from "../planner/createPlannerJobs.js";
import { runWorkerOnce } from "../runs/workerEngine.js";

initDb();
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length);
try {
  const summaries = await runWorkerOnce(runId);
  const plannerJobs = runId ? [] : await processQueuedCreatePlannerJobs(1);
  console.log(JSON.stringify({ summaries, plannerJobs }, null, 2));
} finally {
  closeSharedAppServerClient();
}
