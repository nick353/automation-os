#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeAosChromeCompanionReadOnly,
  resolveCompanionInstallRoot,
} from "./aos-chrome-companion-adapter.mjs";

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  const value = inline !== undefined
    ? String(inline.slice(name.length + 1)).trim()
    : index >= 0
      ? String(process.argv[index + 1] || "").trim()
      : "";
  if (required && !value) throw new Error(`canary_argument_required:${name}`);
  return value;
}

function credentialFreeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("canary_url_invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("canary_url_not_allowed");
  }
  return parsed;
}

function boundedId(value, field) {
  if (!value || value.length > 240) throw new Error(`canary_${field}_invalid`);
  return value;
}

async function connectWithoutStartingBroker(environment) {
  const root = await resolveCompanionInstallRoot(environment);
  const modulePath = join(root, "src", "client", "broker-client.mjs");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.BrokerClient?.connect !== "function") throw new Error("companion_broker_client_invalid");
  return module.BrokerClient.connect({ issuer: "aos", autoStart: false, env: environment });
}

const outputBase = {
  schema: "aos.chrome_companion.real_readonly_canary.v1",
  read_only: true,
  external_action_executed: false,
  mutation_dispatch_attempted: false,
  replay_allowed: false,
};

let client = null;
try {
  const url = credentialFreeUrl(argument("--url"));
  const taskId = boundedId(argument("--task-id"), "task_id");
  const profileInstanceId = argument("--profile-instance-id", { required: false });
  const runId = boundedId(
    argument("--run-id", { required: false })
      || process.env.AOS_CHROME_COMPANION_RUN_ID
      || `companion-real-readonly-${Date.now()}-${randomUUID().slice(0, 8)}`,
    "run_id",
  );
  client = await connectWithoutStartingBroker(process.env);
  const receipt = await executeAosChromeCompanionReadOnly({
    mode: "read_only",
    runId,
    taskId,
    profileInstanceId: profileInstanceId || undefined,
    target: { url: url.href },
    allowedOrigins: [url.origin],
    reuseTaskTab: true,
    keepTaskTab: true,
    maxTextChars: 30_000,
  }, { client });
  process.stdout.write(`${JSON.stringify({ ...outputBase, ...receipt }, null, 2)}\n`);
  process.exitCode = receipt.result === "verified" ? 0 : 2;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ...outputBase,
    result: "blocked",
    exact_blocker: {
      code: String(error?.code || "companion_real_readonly_canary_failed"),
      message: String(error?.message || error).replace(/\s+/gu, " ").slice(0, 400),
    },
  }, null, 2)}\n`);
  process.exitCode = 2;
} finally {
  try { client?.close(); } catch { /* preserve the read-only receipt */ }
}
