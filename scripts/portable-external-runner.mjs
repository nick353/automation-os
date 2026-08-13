#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function buildPortableWorkflowSpecs(env = process.env) {
  const home = env.HOME?.trim() || homedir();
  const repoRoot = resolve(env.AUTOMATION_OS_REPO_ROOT?.trim() || join(import.meta.dirname, ".."));
  const codexHome = resolve(env.CODEX_HOME?.trim() || join(home, ".codex"));
  const agentsHome = resolve(env.AUTOMATION_OS_AGENTS_HOME?.trim() || join(home, ".agents"));
  const browserProjectRoot = resolve(env.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT?.trim() || join(home, "Documents", "New project"));
  const nisenprintsProjectRoot = resolve(env.AUTOMATION_OS_NISENPRINTS_PROJECT_ROOT?.trim() || join(home, "Documents", "Etsy"));
  return {
    "job-application-manager": {
      cwd: browserProjectRoot,
    authority: [
      join(codexHome, "skills", "job-application-manager-automation", "SKILL.md"),
      join(codexHome, "skills", "job-application-daily-submit-queue", "SKILL.md")
    ],
    objective: "求人候補の確認から応募までを、現在の応募ルート契約に従って処理する"
  },
  "daily-ai-research-publish-run": {
    cwd: browserProjectRoot,
    authority: [
      join(agentsHome, "skills", "daily-ai-research-publish-run", "SKILL.md"),
      join(codexHome, "automations", "daily-ai-research-publish-run", "automation.toml")
    ],
    objective: "Daily AIの調査・下書き・承認済み公開を、現在の実行契約に従って処理する"
  },
  "nisenprints-daily-product-canva-printify-etsy-pinterest": {
    cwd: nisenprintsProjectRoot,
    authority: [
      join(nisenprintsProjectRoot, "AGENTS.md"),
      join(nisenprintsProjectRoot, ".Codex", "skills", "nisenprints-daily-product-flow", "SKILL.md"),
      join(codexHome, "automations", "nisenprints-daily-product-canva-printify-etsy-pinterest", "automation.toml")
    ],
    objective: "NisenPrintsの商品準備と、承認済みの外部公開処理を現在のフローに従って処理する"
  },
  "prompt-transfer-ukiyoe": {
    cwd: join(agentsHome, "skills", "prompt-transfer-ukiyoe"),
    authority: [
      join(agentsHome, "skills", "prompt-transfer-ukiyoe", "SKILL.md"),
      join(agentsHome, "skills", "prompt-transfer", "SKILL.md")
    ],
    objective: "浮世絵プロンプトをGoogle Sheetsへ転記し、同一runでreadbackする"
  },
  "sns-multi-poster-ukiyoe": {
    cwd: browserProjectRoot,
    authority: [
      join(repoRoot, "docs", "portable-worker-contract.md")
    ],
    objective: "準備済みコンテンツのSNS投稿を、現在のBrowser Use CLI・readback契約に従って処理する"
  },
  "x-authenticated-browser-lane": {
    cwd: browserProjectRoot,
    authority: [
      join(repoRoot, "docs", "portable-worker-contract.md")
    ],
    objective: "Xの認証済みBrowser Use CLI laneを、同一runのreadbackとcleanup付きで処理する"
  }
  };
}

export function portableBrowserUsePaths(env = process.env) {
  const home = env.HOME?.trim() || homedir();
  const codexHome = resolve(env.CODEX_HOME?.trim() || join(home, ".codex"));
  return {
    helper: resolve(env.AUTOMATION_OS_BROWSER_USE_CLI_HELPER?.trim() || join(home, ".local", "bin", "codex-browser-use")),
    stageAdapter: resolve(env.AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER?.trim() || join(codexHome, "skills", "automation-kernel-run", "scripts", "browser-use-cli-stage-adapter.mjs")),
    runtimeConfig: resolve(env.AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG?.trim() || join(home, ".browser-use-cli", "browser-use-runtime.toml"))
  };
}

export const WORKFLOW_SPECS = buildPortableWorkflowSpecs();

let tempRoot;

export function selectCodexBin(env = process.env) {
  const explicit = env.AUTOMATION_OS_CODEX_BIN?.trim() || env.CODEX_CLI_PATH?.trim();
  if (explicit) return explicit;
  const configuredPath = env.AUTOMATION_OS_CODEX_DEFAULT_BIN?.trim();
  if (configuredPath) return configuredPath;
  const pathEntries = String(env.PATH || "").split(delimiter).filter(Boolean);
  return pathEntries.map((entry) => join(entry, "codex")).find((candidate) => statIsFile(candidate)) || "codex";
}

export function buildCodexExecArgs({ cwd, lastMessagePath, prompt }) {
  return [
    "exec",
    "--ephemeral",
    "--sandbox", "danger-full-access",
    "--skip-git-repo-check",
    "--cd", cwd,
    "--output-last-message", lastMessagePath,
    prompt
  ];
}

export function inspectCanonicalBrowserUseCli({
  helperPath,
  stageAdapterPath,
  runtimeConfigPath,
  env = process.env,
  runner = spawnSync
} = {}) {
  const paths = portableBrowserUsePaths(env);
  helperPath ||= paths.helper;
  stageAdapterPath ||= paths.stageAdapter;
  runtimeConfigPath ||= paths.runtimeConfig;
  for (const [label, path] of [
    ["helper", helperPath],
    ["stage_adapter", stageAdapterPath],
    ["runtime_config", runtimeConfigPath]
  ]) {
    if (!statIsFile(path)) {
      return {
        ok: false,
        exact_blocker: `portable_external_browser_use_cli_${label}_missing`,
        helper_path: helperPath,
        stage_adapter_path: stageAdapterPath,
        runtime_config_path: runtimeConfigPath
      };
    }
  }

  const result = runner(helperPath, ["runtime-readback"], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
    timeout: 15_000
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      exact_blocker: "portable_external_browser_use_cli_runtime_unavailable",
      helper_path: helperPath,
      stage_adapter_path: stageAdapterPath,
      runtime_config_path: runtimeConfigPath
    };
  }
  const readback = parseJsonObject(result.stdout ?? "");
  if (!readback || readback.exact_blocker) {
    return {
      ok: false,
      exact_blocker: "portable_external_browser_use_cli_runtime_unavailable",
      helper_path: helperPath,
      stage_adapter_path: stageAdapterPath,
      runtime_config_path: runtimeConfigPath
    };
  }
  if (readback.runtime_drift === true || readback.launch === true) {
    return {
      ok: false,
      exact_blocker: "portable_external_browser_use_cli_runtime_drift",
      helper_path: helperPath,
      stage_adapter_path: stageAdapterPath,
      runtime_config_path: runtimeConfigPath
    };
  }
  return {
    ok: true,
    exact_blocker: null,
    helper_path: helperPath,
    stage_adapter_path: stageAdapterPath,
    runtime_config_path: runtimeConfigPath,
    readback
  };
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const spec = buildPortableWorkflowSpecs()[input.workflow_id];
  if (!spec) finish({
    status: "blocked",
    exact_blocker: "portable_external_workflow_unknown",
    external_action_executed: false
  }, 1);

  const effects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS === "enabled";
  const approvalGranted = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL === "approved";
  if (effects && !approvalGranted) finish({
    status: "blocked",
    exact_blocker: "portable_external_approval_required",
    external_action_executed: false
  }, 1);
  const browserUseCli = inspectCanonicalBrowserUseCli();
  if (!browserUseCli.ok) finish({
    status: "blocked",
    exact_blocker: browserUseCli.exact_blocker,
    external_action_executed: false,
    browser_surface: "browser_use_cli",
    browser_use_cli: browserUseCli
  }, 1);
  const codexBin = selectCodexBin();
  const codexCommandAvailable = statIsFile(codexBin) || (codexBin === "codex" && spawnSync("which", ["codex"], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] }).status === 0);
  if (!codexCommandAvailable) finish({
    status: "blocked",
    exact_blocker: "portable_external_codex_cli_missing",
    external_action_executed: false,
    codex_bin: codexBin
  }, 1);

  tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-external-"));
  const lastMessagePath = join(tempRoot, `${safe(input.run_id)}.last-message.json`);
  try {
    const prompt = buildPrompt({ ...input, spec, effects, approvalGranted });
    const result = spawnSync(codexBin, buildCodexExecArgs({
      cwd: spec.cwd,
      lastMessagePath,
      prompt
    }), {
      cwd: spec.cwd,
      env: {
        ...process.env,
        AUTOMATION_OS_PORTABLE_WORKFLOW_ID: input.workflow_id,
        AUTOMATION_OS_PORTABLE_RUN_ID: input.run_id,
        AUTOMATION_OS_PORTABLE_STEP_ID: input.step_id,
        AUTOMATION_OS_PORTABLE_IDEMPOTENCY_KEY: input.idempotency_key,
        AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: effects ? "enabled" : "read_only",
        AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
        AUTOMATION_OS_BROWSER_USE_CLI_HELPER: browserUseCli.helper_path,
        AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER: browserUseCli.stage_adapter_path,
        AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG: browserUseCli.runtime_config_path,
        BROWSER_USE_CLI_HELPER: browserUseCli.helper_path,
        BROWSER_USE_RUNTIME_CONFIG: browserUseCli.runtime_config_path,
        BROWSER_USE_HOME: process.env.BROWSER_USE_HOME || resolve(browserUseCli.runtime_config_path, ".."),
        AUTOMATION_OS_BROWSER_NO_FALLBACK: "1",
        AUTOMATION_OS_BROWSER_GOAL_ID: process.env.AUTOMATION_OS_BROWSER_GOAL_ID || `aos-goal-${safe(input.run_id)}`,
        AUTOMATION_OS_BROWSER_GOAL_STATE_PATH: process.env.AUTOMATION_OS_BROWSER_GOAL_STATE_PATH || "",
        AUTOMATION_OS_BROWSER_GOAL_TERMINAL: process.env.AUTOMATION_OS_BROWSER_GOAL_TERMINAL || "1"
      },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: Number(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_CODEX_TIMEOUT_MS ?? 3_600_000)
    });
    if (result.error) finish({
      status: "blocked",
      exact_blocker: result.error.code === "ETIMEDOUT"
        ? "portable_external_codex_cli_timeout"
        : "portable_external_codex_cli_failed",
      external_action_executed: false,
      exit_status: result.status,
      signal: result.signal
    }, 1);
    if (result.status !== 0) finish({
      status: "blocked",
      exact_blocker: "portable_external_codex_cli_exit_nonzero",
      external_action_executed: false,
      exit_status: result.status,
      signal: result.signal,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    }, 1);
    const receipt = parseReceipt(readFileSafe(lastMessagePath));
    if (!receipt) finish({
      status: "blocked",
      exact_blocker: "portable_external_worker_receipt_missing",
      external_action_executed: false,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    }, 1);
    finish({
      status: receipt.status,
      exact_blocker: receipt.exact_blocker ?? null,
      external_action_executed: effects && receipt.external_action_executed === true,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      idempotency_key: input.idempotency_key,
      source_trigger: input.source_trigger,
      executor: "codex_cli_portable_worker",
      browser_surface: "browser_use_cli",
      browser_use_cli: browserUseCli,
      connector_gateway: "mcp",
      effects_mode: effects ? "enabled" : "read_only",
      artifacts: Array.isArray(receipt.artifacts) ? receipt.artifacts.slice(0, 20) : [],
      proof_summary: typeof receipt.proof_summary === "string" ? receipt.proof_summary : null
    }, receipt.status === "blocked" || receipt.exact_blocker ? 1 : 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

export function buildPrompt({ workflow_id, run_id, step_id, source_trigger, idempotency_key, spec, effects, approvalGranted = false, browserUseCli = portableBrowserUsePaths() }) {
  const authorityText = spec.authority.map((path) => `- ${path}`).join("\n");
  return [
    "You are the portable Automation OS worker. This is not a Codex App thread and it has no controller identity or first-class-root dependency.",
    "The Automation OS run and idempotency binding below are authoritative. Do not create another run, replay an old receipt, or use a different browser surface.",
    "Read the listed authority files fresh. Treat their workflow-specific safety and completion rules as binding.",
    "",
    `workflow_id=${workflow_id}`,
    `run_id=${run_id}`,
    `step_id=${step_id}`,
    `source_trigger=${source_trigger}`,
    `idempotency_key=${idempotency_key}`,
    `external_effects=${effects ? "enabled" : "read_only"}`,
    `external_approval=${approvalGranted ? "approved" : "not_granted"}`,
    "",
    "Authority files:",
    authorityText,
    "",
    `Objective: ${spec.objective}`,
    "",
    `Browser contract: use only ${browserUseCli.helper_path || browserUseCli.helper} through ${browserUseCli.stage_adapter_path || browserUseCli.stageAdapter} with runtime ${browserUseCli.runtime_config_path || browserUseCli.runtimeConfig}. Do not use Codex in-app browser, Chrome/Profile 2, Playwright, direct CDP, raw browser binaries, or an implicit fallback. The Goal owns one lease; ensure/reuse/resume the same session/profile/port across stages and finalize only at Goal termination.`,
    `Codex account context: ${process.env.AUTOMATION_OS_CODEX_ACCOUNT_REF?.trim() || "configured local CODEX_HOME"}. This is a capability label only; AOS company, root admission, run, receipt, and effect authority remain authoritative.`,
    "Connector contract: use the configured Codex Server/MCP gateway for Gmail, Google Sheets, Calendar, or other connectors when the workflow requires it. Never persist credentials, cookies, tokens, storage state, or authority contents.",
    effects
      ? "External effects are enabled for this explicitly configured worker. Perform only the workflow's non-billing, in-scope action and require target/account/payload/audience/authority/approval match plus provider receipt/source sync/reconciliation/cleanup. Stop and checkpoint on approval, authentication, CAPTCHA, OTP, secret input, identity, security, assessment, payment, or ambiguous-effect blockers; never replay an ambiguous effect."
      : "External effects are disabled for this worker. Perform read-only discovery/preflight and produce a plan/readback; do not submit, apply, post, publish, send, save, upload, purchase, or delete.",
    "",
    "Return only a final JSON object with: status (complete|partial|blocked), exact_blocker (string|null), external_action_executed (boolean), proof_summary (string), artifacts (array of safe artifact paths/URIs), and goal_status (recovering|waiting|blocked|completed), current_stage, last_readback, next_action, restart_point. Do not include secrets or raw credentials in the JSON."
  ].join("\n");
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) continue;
    values[key.slice(2).replaceAll("-", "_")] = args[index + 1] ?? "";
    index += 1;
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) {
    if (!values[key]) finish({ status: "blocked", exact_blocker: `portable_external_${key}_missing`, external_action_executed: false }, 1);
  }
  return values;
}

function parseReceipt(text) {
  const value = parseJsonObject(text);
  if (!value) return null;
  if (!["complete", "partial", "blocked"].includes(value.status)) return null;
  if (typeof value.external_action_executed !== "boolean") return null;
  return value;
}

function parseJsonObject(text) {
  const candidates = text.match(/\{[\s\S]*\}/g) ?? [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(candidates[index]);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      return value;
    } catch {
      // Continue searching for the final JSON object.
    }
  }
  return null;
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function statIsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function tail(value, limit = 4000) {
  const text = value ?? "";
  return text.length > limit ? text.slice(-limit) : text;
}

function finish(value, exitCode) {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(exitCode);
}
