import { redactSensitiveText } from "../obsidian/redaction.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const baseEnvironmentKeys = new Set([
  "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "TERM", "USER", "LOGNAME",
  "PWD", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "PYTHON", "PYTHON3"
]);

// These values configure the trusted worker itself. They are intentionally
// enumerated instead of copying every AUTOMATION_OS_* variable: operator
// tokens, API keys, cookies, and secret-store payloads must not cross a
// worker->command boundary by accident.
const workerEnvironmentKeys = new Set([
  "AUTOMATION_OS_DB",
  "AUTOMATION_OS_SECRET_DIR",
  "AUTOMATION_OS_WORKER_STATE_PATH",
  "AUTOMATION_OS_WORKER_WORKSPACE_ROOT",
  "AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS",
  "AUTOMATION_OS_WORKER_LOOP_MAX_CYCLES",
  "AUTOMATION_OS_DURABLE_SERVICE_USER_ID",
  "AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA",
  "AUTOMATION_OS_CHILD_CODEX_BIN",
  "AUTOMATION_OS_CODEX_BIN",
  "AUTOMATION_OS_CHILD_CODEX_CWD",
  "AUTOMATION_OS_CODEX_APP_SERVER_COMMAND",
  "AUTOMATION_OS_CREATE_PLANNER_PROVIDER",
  "AUTOMATION_OS_CODEX_TIMEOUT_MS",
  "AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS",
  "AUTOMATION_OS_WORKER_KILL_GRACE_MS",
  "AUTOMATION_OS_ARTIFACT_ROOT",
  "AUTOMATION_OS_NODE_BIN",
  "AUTOMATION_OS_PLAYWRIGHT_CLI",
  "AUTOMATION_OS_BROWSER_CHECK_URL",
  "AUTOMATION_OS_REGISTERED_STALE_AFTER_MS",
  "AUTOMATION_OS_EXECUTE_CODEX",
  "AUTOMATION_OS_STAGE_TIMEOUT_MS",
  "AUTOMATION_OS_BROWSER_SURFACE",
  "AUTOMATION_OS_BROWSER_DRIVER",
  "AUTOMATION_OS_BROWSER_ADAPTER",
  "AUTOMATION_OS_BROWSER_HELPER",
  "AUTOMATION_OS_BROWSER_RUNTIME_CONFIG",
  "AUTOMATION_OS_BROWSER_NO_FALLBACK",
  "AUTOMATION_OS_BROWSER_SESSION",
  "AUTOMATION_OS_BROWSER_PROFILE",
  "AUTOMATION_OS_BROWSER_PORT",
  "AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER",
  "AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR",
  "AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS",
  "AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS",
  "AUTOMATION_OS_PORTABLE_EXTERNAL_CODEX_TIMEOUT_MS"
]);

const sensitiveEnvironmentName = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|CREDENTIAL|DATABASE_URL|POSTGRES(?:QL)?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/iu;

type WorkspacePathErrors = {
  rootInvalid: string;
  pathInvalid: string;
  outside: string;
};

const workerWorkspacePathErrors: WorkspacePathErrors = {
  rootInvalid: "worker_workspace_root_invalid",
  pathInvalid: "worker_cwd_invalid",
  outside: "worker_cwd_outside_workspace"
};

/**
 * Resolve a worker path after symlink resolution and keep it under the
 * worker-owned workspace root.  This is intentionally shared by child Codex
 * and App Server callers so an environment override cannot bypass the
 * boundary used by only one of the two paths.
 */
export function resolveBoundedWorkspacePath(
  value: string | undefined,
  workspaceRootValue: string | undefined,
  errors: WorkspacePathErrors
): string {
  const rootCandidate = resolve(workspaceRootValue?.trim() || process.cwd());
  const pathCandidate = resolve(value?.trim() || rootCandidate);
  let root: string;
  let path: string;
  try {
    root = realpathSync(rootCandidate);
  } catch {
    throw new Error(errors.rootInvalid);
  }
  try {
    path = realpathSync(pathCandidate);
  } catch {
    throw new Error(errors.pathInvalid);
  }
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(errors.outside);
  }
  return path;
}

export function resolveWorkerWorkspacePath(value?: string, workspaceRootValue?: string): string {
  return resolveBoundedWorkspacePath(value, workspaceRootValue, workerWorkspacePathErrors);
}

export function safeWorkerEnvironment(
  input: NodeJS.ProcessEnv,
  options: { databaseUrl?: string; overrides?: Record<string, string | undefined> } = {}
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const workspaceRoot = input.AUTOMATION_OS_WORKER_WORKSPACE_ROOT
    ? resolveWorkerWorkspacePath(undefined, input.AUTOMATION_OS_WORKER_WORKSPACE_ROOT)
    : undefined;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    if (!(baseEnvironmentKeys.has(key) || workerEnvironmentKeys.has(key) || key.startsWith("LC_"))) continue;
    if (key === "AUTOMATION_OS_WORKER_WORKSPACE_ROOT") {
      output[key] = workspaceRoot ?? resolveWorkerWorkspacePath(undefined, value);
      continue;
    }
    if (key === "AUTOMATION_OS_CHILD_CODEX_CWD") {
      output[key] = resolveWorkerWorkspacePath(value, workspaceRoot);
      continue;
    }
    output[key] = value;
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (typeof value !== "string" || !value) continue;
    if (sensitiveEnvironmentName.test(key) && !workerEnvironmentKeys.has(key)) continue;
    if (key === "AUTOMATION_OS_WORKER_WORKSPACE_ROOT") {
      output[key] = resolveWorkerWorkspacePath(undefined, value);
      continue;
    }
    if (key === "AUTOMATION_OS_CHILD_CODEX_CWD") {
      output[key] = resolveWorkerWorkspacePath(value, workspaceRoot);
      continue;
    }
    output[key] = value;
  }
  if (options.databaseUrl?.trim()) {
    output.AUTOMATION_OS_DATABASE_URL = options.databaseUrl;
    output.DATABASE_URL = options.databaseUrl;
  }
  return output;
}

export function redactWorkerOutput(value: string | Buffer | null | undefined, maxChars = 4_000): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "";
  const redacted = redactSensitiveText(text)
    .replace(/\b(AUTOMATION_OS_DATABASE_URL|DATABASE_URL)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/\b(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
  return redacted.length > maxChars ? redacted.slice(-maxChars) : redacted;
}
