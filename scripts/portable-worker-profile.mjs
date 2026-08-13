#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PORTABLE_WORKER_PROFILE_SCHEMA = "aos.portable_worker_profile.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@+/ -]{0,159}$/u;
const SECRET_KEY = /(^|_)(access[_-]?token|api[_-]?token|auth[_-]?token|token|cookie|password|secret|authorization|credential|storage[_-]?state)($|_)/iu;

function valueOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function absolutePath(value, fallback) {
  return resolve(valueOr(value, fallback));
}

export function defaultPortableWorkerProfile(env = process.env, platformHome = homedir()) {
  const home = platformHome || homedir();
  const repoRoot = absolutePath(env.AUTOMATION_OS_REPO_ROOT, join(home, "Documents", "Codex", "automation-os"));
  const browserProjectRoot = absolutePath(env.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT, join(home, "Documents", "New project"));
  const nisenprintsProjectRoot = absolutePath(env.AUTOMATION_OS_NISENPRINTS_PROJECT_ROOT, join(home, "Documents", "Etsy"));
  const codexHome = absolutePath(env.CODEX_HOME, join(home, ".codex"));
  const agentsHome = absolutePath(env.AUTOMATION_OS_AGENTS_HOME, join(home, ".agents"));
  return {
    schema: PORTABLE_WORKER_PROFILE_SCHEMA,
    profile_id: valueOr(env.AUTOMATION_OS_WORKER_PROFILE_ID, "default"),
    remote_url: valueOr(env.AUTOMATION_OS_PORTABLE_REMOTE_URL, "https://automation-os.zeabur.app"),
    company_id: valueOr(env.AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID, "company_2560580981cedfd106b66245"),
    worker_id: valueOr(env.AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID, `mac-${hostname()}`.replace(/[^A-Za-z0-9._:-]/gu, "-")),
    repo_root: repoRoot,
    artifact_root: absolutePath(env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT, join(repoRoot, "data", "artifacts", "portable-remote-worker")),
    codex_home: codexHome,
    agents_home: agentsHome,
    // CODEX_CLI_PATH may be supplied by the host app/launcher. Do not copy
    // that machine-specific absolute path into a profile unless the user
    // explicitly sets AUTOMATION_OS_CODEX_BIN or --codex-bin.
    codex_bin: valueOr(env.AUTOMATION_OS_CODEX_BIN, ""),
    codex_account_ref: valueOr(env.AUTOMATION_OS_CODEX_ACCOUNT_REF, ""),
    browser_use_project_root: browserProjectRoot,
    nisenprints_project_root: nisenprintsProjectRoot,
    browser_use_home: absolutePath(env.AUTOMATION_OS_BROWSER_USE_HOME || env.BROWSER_USE_HOME, join(home, ".browser-use-cli")),
    browser_use_helper: absolutePath(env.AUTOMATION_OS_BROWSER_USE_CLI_HELPER, join(home, ".local", "bin", "codex-browser-use")),
    browser_use_stage_adapter: absolutePath(env.AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER, join(codexHome, "skills", "automation-kernel-run", "scripts", "browser-use-cli-stage-adapter.mjs")),
    browser_use_runtime_config: absolutePath(env.AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG, join(home, ".browser-use-cli", "browser-use-runtime.toml")),
    token_service: valueOr(env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE, "Automation OS Zeabur Trigger"),
    token_file: valueOr(env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_FILE, ""),
    business_runner_job_application: valueOr(env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION, join(browserProjectRoot, "scripts", "browser_use", "job_manager_browser_use_cli_business_runner.mjs")),
    business_runner_daily_ai: valueOr(env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI, join(repoRoot, "scripts", "aos-daily-ai-business-runner.mjs")),
    business_runner_nisenprints: valueOr(env.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS, join(repoRoot, "scripts", "aos-nisenprints-business-runner.mjs"))
  };
}

export function portableBrowserUsePaths(env = process.env, platformHome = homedir()) {
  const home = platformHome || homedir();
  const codexHome = absolutePath(env.CODEX_HOME, join(home, ".codex"));
  const browserHome = absolutePath(env.AUTOMATION_OS_BROWSER_USE_HOME || env.BROWSER_USE_HOME, join(home, ".browser-use-cli"));
  return {
    helper: absolutePath(env.AUTOMATION_OS_BROWSER_USE_CLI_HELPER || env.BROWSER_USE_CLI_HELPER, join(home, ".local", "bin", "codex-browser-use")),
    stageAdapter: absolutePath(env.AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER, join(codexHome, "skills", "automation-kernel-run", "scripts", "browser-use-cli-stage-adapter.mjs")),
    runtimeConfig: absolutePath(env.AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG || env.BROWSER_USE_RUNTIME_CONFIG, join(browserHome, "browser-use-runtime.toml")),
    home: browserHome
  };
}

export function validatePortableWorkerProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("portable_worker_profile_invalid");
  const profile = { ...input };
  if (profile.schema !== PORTABLE_WORKER_PROFILE_SCHEMA) throw new Error("portable_worker_profile_schema_invalid");
  for (const key of Object.keys(profile)) {
    if (!new Set(["token_service", "token_file"]).has(key) && SECRET_KEY.test(key)) throw new Error("portable_worker_profile_secret_like_key");
  }
  for (const key of ["profile_id", "company_id", "worker_id"]) {
    if (typeof profile[key] !== "string" || !SAFE_ID.test(profile[key].trim())) throw new Error(`portable_worker_profile_${key}_invalid`);
    profile[key] = profile[key].trim();
  }
  if (typeof profile.remote_url !== "string") throw new Error("portable_worker_profile_remote_url_invalid");
  let url;
  try { url = new URL(profile.remote_url); } catch { throw new Error("portable_worker_profile_remote_url_invalid"); }
  if (!/^https?:$/u.test(url.protocol) || !url.hostname) throw new Error("portable_worker_profile_remote_url_invalid");
  profile.remote_url = profile.remote_url.replace(/\/+$/u, "");
  for (const key of [
    "repo_root", "artifact_root", "codex_home", "agents_home", "browser_use_project_root", "browser_use_home",
    "nisenprints_project_root", "browser_use_helper", "browser_use_stage_adapter", "browser_use_runtime_config",
    "business_runner_job_application", "business_runner_daily_ai", "business_runner_nisenprints"
  ]) {
    if (typeof profile[key] !== "string" || !isAbsolute(profile[key].trim())) throw new Error(`portable_worker_profile_${key}_invalid`);
    profile[key] = resolve(profile[key]);
  }
  for (const key of ["codex_bin", "token_file"]) {
    if (profile[key] === undefined || profile[key] === null) profile[key] = "";
    if (typeof profile[key] !== "string") throw new Error(`portable_worker_profile_${key}_invalid`);
    if (profile[key].trim() && !isAbsolute(profile[key].trim())) throw new Error(`portable_worker_profile_${key}_invalid`);
    profile[key] = profile[key].trim() ? resolve(profile[key]) : "";
  }
  for (const key of ["token_service", "codex_account_ref"]) {
    if (profile[key] === undefined || profile[key] === null) profile[key] = "";
    if (typeof profile[key] !== "string" || (profile[key].trim() && !SAFE_LABEL.test(profile[key].trim()))) throw new Error(`portable_worker_profile_${key}_invalid`);
    profile[key] = profile[key].trim();
  }
  return profile;
}

export function readPortableWorkerProfile(configPath) {
  const path = resolve(configPath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("portable_worker_profile_file_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("portable_worker_profile_owner_invalid");
  if ((stat.mode & 0o077) !== 0) throw new Error("portable_worker_profile_permissions_invalid");
  return validatePortableWorkerProfile(JSON.parse(readFileSync(path, "utf8")));
}

const ENV_MAP = {
  profile_id: "AUTOMATION_OS_WORKER_PROFILE_ID",
  repo_root: "AUTOMATION_OS_REPO_ROOT",
  artifact_root: "AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT",
  remote_url: "AUTOMATION_OS_PORTABLE_REMOTE_URL",
  company_id: "AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID",
  worker_id: "AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID",
  codex_home: "CODEX_HOME",
  agents_home: "AUTOMATION_OS_AGENTS_HOME",
  codex_bin: "AUTOMATION_OS_CODEX_BIN",
  codex_account_ref: "AUTOMATION_OS_CODEX_ACCOUNT_REF",
  browser_use_project_root: "AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT",
  nisenprints_project_root: "AUTOMATION_OS_NISENPRINTS_PROJECT_ROOT",
  browser_use_home: "BROWSER_USE_HOME",
  browser_use_helper: "AUTOMATION_OS_BROWSER_USE_CLI_HELPER",
  browser_use_stage_adapter: "AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER",
  browser_use_runtime_config: "AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG",
  token_service: "AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE",
  token_file: "AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_FILE",
  business_runner_job_application: "AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION",
  business_runner_daily_ai: "AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI",
  business_runner_nisenprints: "AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS"
};

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function profileShellEnv(profile) {
  const validated = validatePortableWorkerProfile(profile);
  const lines = Object.entries(ENV_MAP)
    .filter(([key]) => validated[key] !== "")
    .map(([key, envKey]) => `export ${envKey}=${shellQuote(validated[key])}`)
  if (validated.browser_use_helper) lines.push(`export BROWSER_USE_CLI_HELPER=${shellQuote(validated.browser_use_helper)}`);
  if (validated.browser_use_runtime_config) lines.push(`export BROWSER_USE_RUNTIME_CONFIG=${shellQuote(validated.browser_use_runtime_config)}`);
  return lines.join("\n");
}

export function writePortableWorkerProfile(outputPath, profile, { force = false } = {}) {
  const path = resolve(outputPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("portable_worker_profile_file_invalid");
    if (!force) throw new Error("portable_worker_profile_exists_use_force");
  }
  const validated = validatePortableWorkerProfile(profile);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  chmodSync(dirname(path), 0o700);
  return { path, profile: validated };
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replaceAll("-", "_");
    const next = args[index + 1];
    if (name === "force" && (!next || next.startsWith("--"))) {
      values[name] = "true";
      continue;
    }
    values[name] = next ?? "";
    index += 1;
  }
  return values;
}

function main() {
  const [command = "readback", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const configPath = args.config || join(homedir(), "Library", "Application Support", "Automation OS", "worker-profile.json");
  if (command === "init") {
    const base = defaultPortableWorkerProfile({ ...process.env, ...Object.fromEntries([
      ["AUTOMATION_OS_WORKER_PROFILE_ID", args.profile_id],
      ["AUTOMATION_OS_PORTABLE_REMOTE_URL", args.remote_url],
      ["AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID", args.company_id],
      ["AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID", args.worker_id],
      ["AUTOMATION_OS_REPO_ROOT", args.repo_root],
      ["AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT", args.browser_use_project_root],
      ["AUTOMATION_OS_NISENPRINTS_PROJECT_ROOT", args.nisenprints_project_root],
      ["CODEX_HOME", args.codex_home],
      ["AUTOMATION_OS_AGENTS_HOME", args.agents_home],
      ["AUTOMATION_OS_CODEX_BIN", args.codex_bin],
      ["AUTOMATION_OS_CODEX_ACCOUNT_REF", args.codex_account_ref],
      ["AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE", args.token_service],
      ["AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_FILE", args.token_file]
    ].filter(([, value]) => value !== undefined && value !== ""))});
    const result = writePortableWorkerProfile(args.output || configPath, base, { force: args.force === "true" || args.force === "1" });
    process.stdout.write(`${JSON.stringify({ ok: true, path: result.path, schema: result.profile.schema, profile_id: result.profile.profile_id, company_id: result.profile.company_id, worker_id: result.profile.worker_id, codex_account_ref: result.profile.codex_account_ref || null })}\n`);
    return;
  }
  const profile = readPortableWorkerProfile(args.config || configPath);
  if (command === "shell-env") {
    process.stdout.write(`${profileShellEnv(profile)}\n`);
    return;
  }
  if (command === "validate" || command === "readback") {
    process.stdout.write(`${JSON.stringify({ ok: true, ...profile, token_file: profile.token_file || null, codex_bin: profile.codex_bin || null })}\n`);
    return;
  }
  throw new Error("portable_worker_profile_command_invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, exact_blocker: error instanceof Error ? error.message : "portable_worker_profile_failed" })}\n`);
    process.exitCode = 1;
  }
}
