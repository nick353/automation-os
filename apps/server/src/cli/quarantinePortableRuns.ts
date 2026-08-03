import { quarantineLegacyRuns } from "../runs/portableWorkerIsolation.js";

const runIds = process.argv.filter((arg) => arg.startsWith("--run-id=")).map((arg) => arg.slice("--run-id=".length));
const result = quarantineLegacyRuns(runIds);
process.stdout.write(`${JSON.stringify({ ok: true, external_action_executed: false, ...result })}\n`);
