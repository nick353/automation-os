import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_FIXTURE_SCHEMA = "automation_os_e2e_fixture.v1";
export const E2E_CLEANUP_SCHEMA = "automation_os_e2e_cleanup.v1";
export const WORKSPACE_ROOT = "/Users/nichikatanaka/Documents/Codex/automation-os";
export const ALLOWED_FIXTURE_ROOTS = Object.freeze([
  path.join(WORKSPACE_ROOT, "work", "e2e"),
  path.join(WORKSPACE_ROOT, "work", "service-readiness", "e2e"),
  path.join(WORKSPACE_ROOT, "outputs", "e2e"),
]);

const IDENTIFIER = /^e2e-[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const RESOURCE_NAMES = Object.freeze([
  "fixture-input.v1.json",
  "fixture-output.v1.json",
  "fixture-receipt.v1.json",
]);
const LEDGER_NAME = "fixture-ledger.v1.json";
const FIXTURE_ENTRIES = Object.freeze(new Set([...RESOURCE_NAMES, LEDGER_NAME]));
const CLEANUP_SIGNALS = Object.freeze(["SIGTERM", "SIGINT"]);

function error(code) {
  const value = new Error(code);
  value.exact_blocker = code;
  return value;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writePrivateJson(filePath, value, { exclusive = true } = {}) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: exclusive ? "wx" : "w" });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw error("e2e_fixture_json_invalid");
  }
}

export function validateFixtureRunId(runId) {
  const value = String(runId || "").trim();
  if (!IDENTIFIER.test(value)) throw error("e2e_fixture_run_id_invalid");
  return value;
}

export function validateFixtureRoot(root, { runId = "" } = {}) {
  const resolved = path.resolve(String(root || ""));
  if (!path.isAbsolute(String(root || "")) || resolved !== path.normalize(resolved)) throw error("e2e_fixture_root_invalid");
  const allowed = ALLOWED_FIXTURE_ROOTS.find((base) => {
    const relative = path.relative(base, resolved);
    return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!allowed || !path.basename(resolved).startsWith("e2e-")) throw error("e2e_fixture_root_outside_allowlist");
  if (runId && path.basename(resolved) !== validateFixtureRunId(runId)) throw error("e2e_fixture_root_run_binding_invalid");
  return resolved;
}

function assertNoSymlinkTree(root) {
  const entries = [root];
  while (entries.length) {
    const current = entries.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw error("e2e_fixture_symlink_rejected");
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(current)) entries.push(path.join(current, name));
  }
}

function assertExactFixtureInventory(root) {
  assertNoSymlinkTree(root);
  const entries = fs.readdirSync(root);
  for (const name of entries) {
    if (!FIXTURE_ENTRIES.has(name)) throw error("e2e_fixture_foreign_resource_present");
    const stat = fs.lstatSync(path.join(root, name));
    if (!stat.isFile() || stat.nlink !== 1) throw error("e2e_fixture_entry_invalid");
  }
  for (const name of FIXTURE_ENTRIES) {
    const filePath = path.join(root, name);
    if (!fs.existsSync(filePath)) throw error("e2e_fixture_entry_missing");
  }
}

export function createE2EFixture({ runId, root = "" } = {}) {
  const id = validateFixtureRunId(runId);
  const resolvedRoot = validateFixtureRoot(root || path.join(WORKSPACE_ROOT, "work", "e2e", id), { runId: id });
  if (fs.existsSync(resolvedRoot)) throw error("e2e_fixture_root_not_fresh");
  fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolvedRoot, 0o700);
  const createdAt = new Date().toISOString();
  const resources = [];
  try {
    for (const [index, name] of RESOURCE_NAMES.entries()) {
      const filePath = path.join(resolvedRoot, name);
      writePrivateJson(filePath, {
        schema: "automation_os_e2e_fixture_resource.v1",
        run_id: id,
        resource_kind: name.replace(/\.v1\.json$/u, ""),
        fixture_only: true,
        sequence: index + 1,
        created_at: createdAt,
      });
      resources.push({ name, kind: "fixture_file", sha256: sha256File(filePath) });
    }
    const ledger = {
      schema: E2E_FIXTURE_SCHEMA,
      status: "created",
      run_id: id,
      fixture_only: true,
      root: resolvedRoot,
      created_at: createdAt,
      ttl_hours: 24,
      external_action_executed: false,
      resources,
      cleanup_contract: {
        delete_approved_required: true,
        exact_root_match_required: true,
        symlink_rejected: true,
        foreign_resource_policy: "never_delete",
      },
    };
    const ledgerPath = path.join(resolvedRoot, LEDGER_NAME);
    writePrivateJson(ledgerPath, ledger);
    assertExactFixtureInventory(resolvedRoot);
    return { ...ledger, ledger_path: ledgerPath };
  } catch (cause) {
    // The catch only removes the exact root this call just created. It never
    // accepts a caller-selected broad path and does not touch user data.
    try { fs.rmSync(resolvedRoot, { recursive: true, force: true }); } catch (_) { /* preserve original blocker */ }
    throw cause;
  }
}

function validateLedger(ledger, ledgerPath) {
  if (!ledger || ledger.schema !== E2E_FIXTURE_SCHEMA || ledger.status !== "created" || ledger.fixture_only !== true) throw error("e2e_fixture_ledger_invalid");
  const id = validateFixtureRunId(ledger.run_id);
  const root = validateFixtureRoot(ledger.root, { runId: id });
  const expectedLedgerPath = path.join(root, LEDGER_NAME);
  if (path.resolve(ledgerPath) !== expectedLedgerPath) throw error("e2e_fixture_ledger_path_binding_invalid");
  if (!Array.isArray(ledger.resources) || ledger.resources.length !== RESOURCE_NAMES.length) throw error("e2e_fixture_resource_ledger_invalid");
  assertExactFixtureInventory(root);
  for (const resource of ledger.resources) {
    if (!RESOURCE_NAMES.includes(resource.name) || !/^[a-f0-9]{64}$/u.test(String(resource.sha256 || ""))) throw error("e2e_fixture_resource_ledger_invalid");
    const resourcePath = path.join(root, resource.name);
    if (path.dirname(resourcePath) !== root || !fs.existsSync(resourcePath)) throw error("e2e_fixture_resource_missing");
    if (sha256File(resourcePath) !== resource.sha256) throw error("e2e_fixture_resource_hash_mismatch");
  }
  return { id, root };
}

export function cleanupE2EFixture({ ledgerPath, deleteApproved = false } = {}) {
  if (deleteApproved !== true) throw error("e2e_fixture_delete_approval_required");
  const resolvedLedgerPath = path.resolve(String(ledgerPath || ""));
  const ledger = readJson(resolvedLedgerPath);
  const { id, root } = validateLedger(ledger, resolvedLedgerPath);
  const parent = path.dirname(root);
  const cleanupPath = path.join(parent, `cleanup-receipt-${id}.v1.json`);
  if (fs.existsSync(cleanupPath)) throw error("e2e_fixture_cleanup_receipt_exists");
  fs.rmSync(root, { recursive: true, force: false });
  const receipt = {
    schema: E2E_CLEANUP_SCHEMA,
    status: "cleaned",
    run_id: id,
    root,
    deleted_resource_names: RESOURCE_NAMES,
    residual_root: fs.existsSync(root),
    external_action_executed: false,
    deleted_at: new Date().toISOString(),
  };
  writePrivateJson(cleanupPath, receipt);
  return { ...receipt, cleanup_path: cleanupPath };
}

/**
 * Own a fixture for a process lifetime. The caller must explicitly approve
 * deletion; signal cleanup is then restricted to the exact ledger/root pair.
 * This is the harness boundary for failure, timeout, and SIGTERM paths.
 */
export function createE2EFixtureLease({ runId, root = "", deleteApproved = false, handleSignals = true } = {}) {
  if (deleteApproved !== true) throw error("e2e_fixture_delete_approval_required");
  const fixture = createE2EFixture({ runId, root });
  let cleaned = false;
  let cleanupReceipt = null;
  const handlers = new Map();
  const detach = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  const cleanup = () => {
    if (cleaned) return cleanupReceipt;
    cleanupReceipt = cleanupE2EFixture({ ledgerPath: fixture.ledger_path, deleteApproved: true });
    cleaned = true;
    detach();
    return cleanupReceipt;
  };
  if (handleSignals) {
    for (const signal of CLEANUP_SIGNALS) {
      const handler = () => {
        try {
          cleanup();
          process.exitCode = signal === "SIGINT" ? 130 : 143;
        } catch (_) {
          process.exitCode = 1;
        } finally {
          process.exit();
        }
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  }
  return {
    ...fixture,
    cleanup,
    detach,
    get cleanup_receipt() { return cleanupReceipt; },
  };
}

/**
 * Run a callback with an exact fixture lease and always clean it up on normal
 * return, rejection, or a bounded timeout. The callback receives an Abort-
 * Signal so a harness can stop work before the fixture is removed.
 */
export async function withE2EFixture({ runId, root = "", timeoutMs = 0 } = {}, callback) {
  if (typeof callback !== "function") throw error("e2e_fixture_callback_required");
  if (timeoutMs !== 0 && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
    throw error("e2e_fixture_timeout_invalid");
  }
  const lease = createE2EFixtureLease({ runId, root, deleteApproved: true, handleSignals: false });
  const controller = new AbortController();
  let timer = null;
  try {
    const work = Promise.resolve().then(() => callback(lease, { signal: controller.signal }));
    if (!timeoutMs) return await work;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(error("e2e_fixture_harness_timeout"));
      }, timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    lease.cleanup();
  }
}

export function inspectE2EFixture({ ledgerPath } = {}) {
  const resolved = path.resolve(String(ledgerPath || ""));
  const ledger = readJson(resolved);
  const { id, root } = validateLedger(ledger, resolved);
  return { status: "created", run_id: id, root, ledger_path: resolved, resource_count: ledger.resources.length, external_action_executed: false };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

async function main(argv = process.argv.slice(2)) {
  const action = argv[0];
  if (action === "create") {
    process.stdout.write(`${JSON.stringify(createE2EFixture({ runId: option(argv, "--run-id"), root: option(argv, "--root") || undefined }))}\n`);
    return 0;
  }
  if (action === "inspect") {
    process.stdout.write(`${JSON.stringify(inspectE2EFixture({ ledgerPath: option(argv, "--ledger") }))}\n`);
    return 0;
  }
  if (action === "cleanup") {
    process.stdout.write(`${JSON.stringify(cleanupE2EFixture({ ledgerPath: option(argv, "--ledger"), deleteApproved: argv.includes("--delete-approved") }))}\n`);
    return 0;
  }
  process.stderr.write("usage: e2e-readiness-fixture.mjs create|inspect|cleanup --run-id/--ledger ...\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((cause) => {
    process.stdout.write(`${JSON.stringify({ status: "blocked", exact_blocker: cause?.exact_blocker || cause?.message || "e2e_fixture_failed" })}\n`);
    process.exitCode = 1;
  });
}
