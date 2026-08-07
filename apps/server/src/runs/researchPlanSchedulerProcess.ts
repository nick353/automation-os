import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchPlanSchedulerOnceResult } from "../index.js";

export type SchedulerExecFileOptions = {
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGTERM";
  maxBuffer: number;
};

export type SchedulerExecFile = (
  file: string,
  args: string[],
  options: SchedulerExecFileOptions,
  callback: (error: unknown | null, stdout: string, stderr: string) => void
) => void;

export type ResearchPlanSchedulerProcessResult =
  | { status: "completed"; exactBlocker: null; result: ResearchPlanSchedulerOnceResult }
  | { status: "blocked"; exactBlocker: string };

export type ResearchPlanSchedulerProcessOptions = {
  now?: Date;
  allowedCompanyIds?: readonly string[];
  scopeRoles?: readonly string[];
  timeoutMs?: number;
  execFileImpl?: SchedulerExecFile;
  fileExists?: (path: string) => boolean;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

const defaultExecFile: SchedulerExecFile = (file, args, options, callback) => {
  nodeExecFile(file, args, options, (error, stdout, stderr) => {
    callback(error, stdout, stderr);
  });
};

export function runResearchPlanSchedulerInChild(
  options: ResearchPlanSchedulerProcessOptions = {}
): Promise<ResearchPlanSchedulerProcessResult> {
  const executable = resolveSchedulerCli(options.fileExists ?? existsSync);
  if (!executable) {
    return Promise.resolve({ status: "blocked", exactBlocker: "research_plan_scheduler_cli_missing" });
  }

  const timeoutMs = boundedTimeout(options.timeoutMs ?? process.env.AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_TIMEOUT_MS);
  const now = options.now ?? new Date();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOMATION_OS_SCHEDULER_NOW: now.toISOString(),
    AUTOMATION_OS_POSTGRES_SCHEMA_ASSUMED_CURRENT: "1"
  };
  if (options.allowedCompanyIds) {
    env.AUTOMATION_OS_SCHEDULER_ALLOWED_COMPANY_IDS = JSON.stringify(
      options.allowedCompanyIds.map((value) => value.trim()).filter(Boolean)
    );
  } else {
    delete env.AUTOMATION_OS_SCHEDULER_ALLOWED_COMPANY_IDS;
  }
  if (options.scopeRoles) {
    env.AUTOMATION_OS_SCHEDULER_SCOPE_ROLES = options.scopeRoles.map((value) => value.trim()).filter(Boolean).join(",");
  } else {
    delete env.AUTOMATION_OS_SCHEDULER_SCOPE_ROLES;
  }

  return new Promise((resolveResult) => {
    (options.execFileImpl ?? defaultExecFile)(
      executable.command,
      executable.args,
      {
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: 256 * 1024
      },
      (error, stdout) => {
        if (isTimeout(error)) {
          resolveResult({ status: "blocked", exactBlocker: "research_plan_scheduler_child_timeout" });
          return;
        }
        const payload = parseJsonLine(stdout);
        if (error) {
          resolveResult({ status: "blocked", exactBlocker: "research_plan_scheduler_child_exit_nonzero" });
          return;
        }
        if (!payload) {
          resolveResult({ status: "blocked", exactBlocker: "research_plan_scheduler_child_invalid_output" });
          return;
        }
        if (isBlockedPayload(payload)) {
          resolveResult({ status: "blocked", exactBlocker: payload.exactBlocker });
          return;
        }
        if (!isCompletedPayload(payload)) {
          resolveResult({ status: "blocked", exactBlocker: "research_plan_scheduler_child_invalid_output" });
          return;
        }
        resolveResult({ status: "completed", exactBlocker: null, result: payload.result });
      }
    );
  });
}

function resolveSchedulerCli(fileExists: (path: string) => boolean): { command: string; args: string[] } | undefined {
  const compiledCli = resolve(moduleDir, "../cli/researchPlanSchedulerOnce.js");
  if (fileExists(compiledCli)) {
    return { command: process.execPath, args: [compiledCli] };
  }
  const sourceCli = resolve(moduleDir, "../cli/researchPlanSchedulerOnce.ts");
  if (!fileExists(sourceCli)) return undefined;
  const loaderArgs = process.execArgv.filter((arg) => /^(?:--import|--loader|--require)(?:=|$)/u.test(arg));
  return { command: process.execPath, args: [...loaderArgs, sourceCli] };
}

function boundedTimeout(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(parsed)));
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return candidate.code === "ETIMEDOUT" || candidate.killed === true || candidate.signal === "SIGTERM";
}

function parseJsonLine(stdout: string): unknown {
  for (const line of stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).reverse()) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // Ignore non-JSON diagnostics and keep looking for the final safe payload.
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBlockedPayload(value: unknown): value is { ok: false; exactBlocker: string } {
  return isRecord(value) && value.ok === false && typeof value.exactBlocker === "string" && value.exactBlocker.trim() !== "";
}

function isCompletedPayload(value: unknown): value is { ok: true; result: ResearchPlanSchedulerOnceResult } {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) return false;
  const result = value.result;
  return ["checked", "started", "skipped", "blocked"].every((key) => typeof result[key] === "number")
    && Array.isArray(result.runIds)
    && Array.isArray(result.blockedWorkflowIds)
    && Array.isArray(result.blockedDueKeys)
    && Array.isArray(result.blockers);
}
