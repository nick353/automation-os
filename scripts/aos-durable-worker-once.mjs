#!/usr/bin/env node
import { initDb } from "../apps/server/dist/db/client.js";
import { runDurableDryRunWorkerOnce } from "../apps/server/dist/runs/durableDryRunWorker.js";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "").trim() : "";
};
const companyId = valueFor("--company") || process.env.AOS_TRIGGER_COMPANY_ID?.trim() || "";
const serviceUserId = valueFor("--service-user") || process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID?.trim() || "";
if (!companyId || !serviceUserId) {
  console.error("aos_durable_worker_arguments_missing: use --company and --service-user");
  process.exitCode = 2;
} else {
  initDb();
  const result = runDurableDryRunWorkerOnce({ companyId, serviceUserId });
  console.log(JSON.stringify({ schema: "aos.durable_worker_once.v1", company_id: companyId, ...result, external_action_executed: false }));
}
