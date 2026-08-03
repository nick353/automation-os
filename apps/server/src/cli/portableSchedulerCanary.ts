import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runPortableSchedulerCanary } from "../runs/portableSchedulerCanary.js";

const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const receipt = runPortableSchedulerCanary();

if (outputArg) {
  const output = resolve(outputArg);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
