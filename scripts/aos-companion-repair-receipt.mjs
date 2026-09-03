#!/usr/bin/env node

/**
 * Bounded receipt helper for the hourly Companion controller.
 *
 * This helper never edits the Companion source tree and never performs browser,
 * Extension, or task mutations.  The controller captures a before snapshot,
 * applies a matching minimal adapter change, then invokes `verify` to record
 * exactly which allowed files changed and which checks passed.  Keeping this
 * boundary deterministic prevents "repair" from degenerating into an
 * untracked self-modifying run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_SOURCE_ROOT = "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge";
const DEFAULT_ARTIFACT_DIR = process.env.AUTOMATION_KERNEL_ARTIFACT_DIR
  || path.join(process.cwd(), "work", "hourly-companion-repair");
const ALLOWED_PLAYBOOKS = new Set([
  "stale_connection_generation",
  "target_binding",
  "frame_or_locator_readback",
  "signed_reconciliation",
  "capability_adapter_repair",
  "companion_local_review",
  "artifact_refresh",
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { command: argv[0] || "help", changedFiles: [], focusedTests: [], representativeTests: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--source-root") args.sourceRoot = argv[++index];
    else if (token === "--artifact-dir") args.artifactDir = argv[++index];
    else if (token === "--repair-id") args.repairId = argv[++index];
    else if (token === "--playbook-id") args.playbookId = argv[++index];
    else if (token === "--before") args.before = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else if (token === "--changed-file") args.changedFiles.push(argv[++index]);
    else if (token === "--focused-test") args.focusedTests.push(argv[++index]);
    else if (token === "--representative-test") args.representativeTests.push(argv[++index]);
    else if (token === "--schema-check") args.schemaCheck = true;
    else if (token === "--runtime-reflected") args.runtimeReflected = true;
    else if (token === "--continuations-sent") args.continuationsSent = Number(argv[++index] || 0);
    else if (token === "--continuation-skipped") args.continuationsSkipped = Number(argv[++index] || 0);
    else if (token === "--blocker") args.blocker = argv[++index];
    else if (token === "--next-action") args.nextAction = argv[++index];
    else fail(`unknown argument: ${token}`);
  }
  return args;
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return file;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fingerprint(file) {
  try {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return { exists: true, sha256: hash, bytes: fs.statSync(file).size };
  } catch {
    return { exists: false, sha256: null, bytes: 0 };
  }
}

function resolveAllowed(sourceRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    fail(`repair_file_must_be_relative:${relativePath || "missing"}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) fail(`repair_file_outside_source:${relativePath}`);
  const allowed = normalized.startsWith(`src${path.sep}`)
    || normalized.startsWith(`extension${path.sep}`)
    || normalized === "scripts/generate-operation-schema.mjs"
    || normalized === "scripts/sync-control-plane-macos.mjs"
    || /(?:^|[\\/])(?:test|tests|scripts)[\\/].*\.test\.(?:js|mjs|cjs)$/u.test(normalized)
    || normalized === "package.json"
    || normalized === "package-lock.json";
  if (!allowed) fail(`repair_file_not_allowed:${relativePath}`);
  const absolute = path.resolve(sourceRoot, normalized);
  const root = `${path.resolve(sourceRoot)}${path.sep}`;
  if (!absolute.startsWith(root)) fail(`repair_file_outside_source:${relativePath}`);
  return { relative: normalized, absolute };
}

export function captureSnapshot({ sourceRoot = DEFAULT_SOURCE_ROOT, files = [] } = {}) {
  const root = path.resolve(sourceRoot);
  const selected = files.length
    ? files.map((file) => resolveAllowed(root, file))
    : ["src", "extension"].flatMap((directory) => {
      const base = path.join(root, directory);
      if (!fs.existsSync(base)) return [];
      const result = [];
      const stack = [base];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const absolute = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(absolute);
          else if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) {
            result.push(resolveAllowed(root, path.relative(root, absolute)));
          }
        }
      }
      return result;
    }).concat(fs.existsSync(path.join(root, "scripts", "generate-operation-schema.mjs"))
      ? [resolveAllowed(root, "scripts/generate-operation-schema.mjs")]
      : []);
  const snapshot = Object.fromEntries(selected.map(({ relative, absolute }) => [relative, fingerprint(absolute)]));
  return { schema: "aos.companion_source_snapshot.v1", capturedAt: new Date().toISOString(), sourceRoot: root, files: snapshot };
}

function runCheck(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    command: [command, ...args].join(" "),
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    stdout: String(result.stdout || "").slice(-4000),
    stderr: String(result.stderr || "").slice(-4000),
  };
}

export function verifyRepair({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  artifactDir = DEFAULT_ARTIFACT_DIR,
  repairId = `repair-${Date.now()}`,
  playbookId,
  before,
  changedFiles = [],
  focusedTests = [],
  representativeTests = [],
  schemaCheck = false,
  runtimeReflected = false,
  continuationsSent = 0,
  continuationsSkipped = 0,
  blocker = null,
  nextAction = null,
} = {}) {
  if (!ALLOWED_PLAYBOOKS.has(playbookId)) fail(`repair_playbook_not_allowed:${playbookId || "missing"}`);
  if (!before || typeof before !== "object" || !before.files) fail("repair_before_snapshot_required");
  const root = path.resolve(sourceRoot);
  const files = [...new Set(changedFiles)].map((file) => resolveAllowed(root, file));
  if (files.length === 0) fail("repair_changed_files_required");
  const changed = files.map(({ relative, absolute }) => {
    const prior = before.files[relative] || { exists: false, sha256: null, bytes: 0 };
    const current = fingerprint(absolute);
    return { path: relative, before: prior, after: current, changed: prior.exists !== current.exists || prior.sha256 !== current.sha256 };
  });
  const checks = [];
  for (const file of changed.filter((item) => item.changed && /\.(?:js|mjs|cjs)$/u.test(item.path))) {
    checks.push(runCheck(process.execPath, ["--check", path.join(root, file.path)], root));
  }
  if (schemaCheck) checks.push(runCheck("npm", ["run", "schema:check"], root));
  for (const testFile of focusedTests) {
    const { absolute, relative } = resolveAllowed(root, testFile);
    checks.push({ ...runCheck(process.execPath, ["--test", absolute], root), testFile: relative });
  }
  for (const testFile of representativeTests) {
    const { absolute, relative } = resolveAllowed(root, testFile);
    checks.push({ ...runCheck(process.execPath, ["--test", absolute], root), representativeTest: relative });
  }
  const changedFilesResult = changed.filter((item) => item.changed);
  const allChecksPassed = checks.length > 0 && checks.every((check) => check.status === "passed");
  const proofComplete = schemaCheck && focusedTests.length > 0 && representativeTests.length > 0;
  const receipt = {
    schema: "aos.companion_repair_receipt.v1",
    repairId,
    playbookId,
    createdAt: new Date().toISOString(),
    sourceRoot: root,
    readOnlyHelper: true,
    externalActionExecuted: false,
    implementation: {
      attempted: true,
      changedFiles: changedFilesResult,
      noOp: changedFilesResult.length === 0,
    },
    verification: {
      status: allChecksPassed && proofComplete && changedFilesResult.length > 0 ? "passed" : "failed",
      proofComplete,
      checks,
    },
    runtimeReflection: { attempted: runtimeReflected, status: runtimeReflected ? "reported_by_controller" : "deferred" },
    continuations: { sent: Number.isFinite(continuationsSent) ? continuationsSent : 0, skipped: Number.isFinite(continuationsSkipped) ? continuationsSkipped : 0 },
    exactBlocker: blocker,
    nextAction,
  };
  const output = path.resolve(artifactDir, `aos-companion-repair-${repairId}.v1.json`);
  writePrivateJson(output, receipt);
  return { ...receipt, artifactPath: output };
}

function printHelp() {
  process.stdout.write("Usage: aos-companion-repair-receipt.mjs capture|verify [options]\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "capture") {
    const snapshot = captureSnapshot({ sourceRoot: args.sourceRoot, files: args.changedFiles });
    const output = path.resolve(args.output || path.join(args.artifactDir || DEFAULT_ARTIFACT_DIR, "aos-companion-source-before.v1.json"));
    writePrivateJson(output, snapshot);
    process.stdout.write(`${JSON.stringify({ ...snapshot, artifactPath: output })}\n`);
  } else if (args.command === "verify") {
    const before = readJson(args.before);
    const result = verifyRepair({ ...args, before });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.verification.status !== "passed") process.exitCode = 1;
  } else {
    printHelp();
    process.exitCode = 2;
  }
}
