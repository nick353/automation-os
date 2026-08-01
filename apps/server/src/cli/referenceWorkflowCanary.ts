import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runReferenceWorkflowCanary } from "../runs/referenceWorkflowCanary.js";

const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputIndex = process.argv.indexOf("--output");
const requestedOutput = outputArg?.slice("--output=".length) || (outputIndex >= 0 ? process.argv[outputIndex + 1] : "");
if (!requestedOutput?.trim()) throw new Error("reference_workflow_canary_output_required");

const receipt = await runReferenceWorkflowCanary();
const output = resolve(requestedOutput);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(receipt, null, 2));
process.stdout.write(`${JSON.stringify({ ok: receipt.ok, output, path_count: receipt.paths.length, external_action_executed: false })}\n`);
if (!receipt.ok) process.exitCode = 2;
