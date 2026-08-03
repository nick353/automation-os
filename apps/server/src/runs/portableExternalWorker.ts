import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { redactWorkerOutput, safeWorkerEnvironment } from "../security/processEnvironment.js";

export const PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED = "portable_external_adapter_not_configured" as const;
export const PORTABLE_EXTERNAL_ADAPTER_INVALID = "portable_external_adapter_invalid" as const;
export const PORTABLE_EXTERNAL_WORKER_TIMEOUT = "portable_external_worker_timeout" as const;

export type PortableExternalWorkerResult = {
  status: "complete" | "partial" | "blocked";
  exactBlocker: string | null;
  externalActionExecuted: boolean;
  stdoutTail: string;
  stderrTail: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  response: Record<string, unknown> | null;
};

function boundedTimeoutMs(): number {
  const value = Number(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS ?? "900000");
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 3_600_000) : 900_000;
}

function parseResponse(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // The adapter may log human-readable progress before its final JSON receipt.
    }
  }
  return null;
}

export async function runPortableExternalWorker(input: {
  workflowId: string;
  runId: string;
  stepId: string;
  sourceTrigger: string;
  idempotencyKey: string;
}): Promise<PortableExternalWorkerResult> {
  const command = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER?.trim() ?? "";
  if (!command) {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }
  if (!isAbsolute(command) || !existsSync(command) || !statSync(command).isFile()) {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_ADAPTER_INVALID,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }

  const args = [
    "--workflow-id", input.workflowId,
    "--run-id", input.runId,
    "--step-id", input.stepId,
    "--source-trigger", input.sourceTrigger,
    "--idempotency-key", input.idempotencyKey
  ];
  const child = spawn(command, args, {
    cwd: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR?.trim() || process.cwd(),
    env: safeWorkerEnvironment(process.env, {
      overrides: {
        AUTOMATION_OS_PORTABLE_EXTERNAL_WORKFLOW_ID: input.workflowId,
        AUTOMATION_OS_PORTABLE_EXTERNAL_RUN_ID: input.runId,
        AUTOMATION_OS_PORTABLE_EXTERNAL_STEP_ID: input.stepId,
        AUTOMATION_OS_PORTABLE_EXTERNAL_SOURCE_TRIGGER: input.sourceTrigger,
        AUTOMATION_OS_PORTABLE_EXTERNAL_IDEMPOTENCY_KEY: input.idempotencyKey
      }
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
    let settled = false;
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish({ code: null, signal: "SIGTERM", timedOut: true });
    }, boundedTimeoutMs());
    child.once("error", () => {
      clearTimeout(timer);
      finish({ code: null, signal: null, timedOut: false });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, timedOut: false });
    });
  });
  const response = parseResponse(stdout);
  const externalActionExecuted = response?.external_action_executed === true;
  const responseStatus = response?.status === "complete" || response?.status === "partial" || response?.status === "blocked"
    ? response.status
    : null;
  const exactBlocker = result.timedOut
    ? PORTABLE_EXTERNAL_WORKER_TIMEOUT
    : typeof response?.exact_blocker === "string" && response.exact_blocker.trim()
      ? response.exact_blocker
      : result.code === 0 && responseStatus
        ? null
        : "portable_external_worker_exit_nonzero";
  return {
    status: responseStatus ?? (result.code === 0 ? "partial" : "blocked"),
    exactBlocker,
    externalActionExecuted,
    stdoutTail: redactWorkerOutput(stdout),
    stderrTail: redactWorkerOutput(stderr),
    exitStatus: result.code,
    signal: result.signal,
    response
  };
}
