import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { getMvpStateReadback } from "../index.js";

export type MvpStateReadback = ReturnType<typeof getMvpStateReadback>;

export type MvpStateExecFileOptions = {
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGTERM";
  maxBuffer: number;
};

export type MvpStateExecFile = (
  file: string,
  args: string[],
  options: MvpStateExecFileOptions,
  callback: (error: unknown | null, stdout: string, stderr: string) => void
) => void;

export type MvpStateProcessResult =
  | { status: "completed"; exactBlocker: null; state: MvpStateReadback }
  | { status: "blocked"; exactBlocker: string };

export type MvpStateProcessOptions = {
  companyId?: string;
  timeoutMs?: number;
  execFileImpl?: MvpStateExecFile;
  fileExists?: (path: string) => boolean;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const defaultExecFile: MvpStateExecFile = (file, args, options, callback) => {
  nodeExecFile(file, args, options, (error, stdout, stderr) => {
    callback(error, stdout, stderr);
  });
};

export function runMvpStateInChild(options: MvpStateProcessOptions = {}): Promise<MvpStateProcessResult> {
  const executable = resolveMvpStateCli(options.fileExists ?? existsSync);
  if (!executable) {
    return Promise.resolve({ status: "blocked", exactBlocker: "mvp_state_cli_missing" });
  }

  const timeoutMs = boundedTimeout(options.timeoutMs ?? process.env.AUTOMATION_OS_MVP_STATE_TIMEOUT_MS);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOMATION_OS_POSTGRES_SCHEMA_ASSUMED_CURRENT: "1"
  };
  if (options.companyId?.trim()) env.AUTOMATION_OS_MVP_STATE_COMPANY_ID = options.companyId.trim();
  else delete env.AUTOMATION_OS_MVP_STATE_COMPANY_ID;

  return new Promise((resolveResult) => {
    try {
      (options.execFileImpl ?? defaultExecFile)(
        executable.command,
        executable.args,
        {
          env,
          encoding: "utf8",
          timeout: timeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: MAX_BUFFER_BYTES
        },
        (error, stdout) => {
          if (isTimeout(error)) {
            resolveResult({ status: "blocked", exactBlocker: "mvp_state_child_timeout" });
            return;
          }
          const payload = parseJsonLine(stdout);
          if (error) {
            resolveResult({ status: "blocked", exactBlocker: "mvp_state_child_exit_nonzero" });
            return;
          }
          if (!payload) {
            resolveResult({ status: "blocked", exactBlocker: "mvp_state_child_invalid_output" });
            return;
          }
          if (isBlockedPayload(payload)) {
            resolveResult({ status: "blocked", exactBlocker: payload.exactBlocker });
            return;
          }
          if (!isCompletedPayload(payload)) {
            resolveResult({ status: "blocked", exactBlocker: "mvp_state_child_invalid_output" });
            return;
          }
          resolveResult({ status: "completed", exactBlocker: null, state: payload.state });
        }
      );
    } catch {
      resolveResult({ status: "blocked", exactBlocker: "mvp_state_child_spawn_failed" });
    }
  });
}

function resolveMvpStateCli(fileExists: (path: string) => boolean): { command: string; args: string[] } | undefined {
  const compiledCli = resolve(moduleDir, "../cli/mvpStateReadOnce.js");
  if (fileExists(compiledCli)) return { command: process.execPath, args: [compiledCli] };
  const sourceCli = resolve(moduleDir, "../cli/mvpStateReadOnce.ts");
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

function isCompletedPayload(value: unknown): value is { ok: true; state: MvpStateReadback } {
  return isRecord(value) && value.ok === true && isRecord(value.state);
}
