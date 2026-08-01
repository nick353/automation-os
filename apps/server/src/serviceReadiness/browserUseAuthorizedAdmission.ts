import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  authoritySha256,
  loadBrowserUseAuthority,
  parseBrowserUseAuthority,
  type BrowserUseAuthorityEnvelopeV1,
  type BrowserUseAuthorityExpectation,
  type BrowserUseAuthorityV1
} from "./browserUseAuthority.js";
import {
  buildServiceReadinessBrowserUseRuntimeBindingV1,
  deriveServiceReadinessRootId,
  type ServiceReadinessBrowserUseRuntimeBindingV1,
  type ServiceReadinessReferenceWorkflowId
} from "./runtimeBinding.js";

export const BROWSER_USE_AUTHORIZED_ADMISSION_SCHEMA_V1 = "browser_use_authorized_admission.v1" as const;
export const BROWSER_USE_AUTHORIZED_CLAIM_SCHEMA_V1 = "browser_use_authorized_claim.v1" as const;
export const BROWSER_USE_AUTHORIZED_AUTHORITY_FILE = "authority.json" as const;
export const BROWSER_USE_AUTHORIZED_ENVELOPE_FILE = "envelope.json" as const;
export const BROWSER_USE_AUTHORIZED_CLAIM_FILE = "claim.json" as const;
const APPROVAL_MAX_AGE_MS = 5 * 60 * 1000;

type AuthorizedAdmissionPaths = {
  run_root: string;
  authority_path: string;
  envelope_path: string;
  claim_path: string;
};

export type BrowserUseAuthorizedAdmissionInput = {
  run_root: string;
  authority: BrowserUseAuthorityV1;
  expected: BrowserUseAuthorityExpectation;
  workflow_id: ServiceReadinessReferenceWorkflowId;
  attempt_id: string;
  profile_root: string;
  reserved_port: number;
  lock_path: string;
};

export type BrowserUseAuthorizedAdmissionV1 = {
  schema: typeof BROWSER_USE_AUTHORIZED_ADMISSION_SCHEMA_V1;
  browser_surface: "browser_use_cli";
  mode: "authorized";
  authority_path: string;
  envelope_path: string;
  claim_path: string;
  authority_sha256: string;
  envelope_sha256: string;
  authority_id: string;
  nonce: string;
  run_id: string;
  session: string;
  stage_id: string;
  attempt: number;
  attempt_id: string;
  idempotency_key: string;
  runtime_binding: ServiceReadinessBrowserUseRuntimeBindingV1;
  adapter_handoff_allowed: false;
  helper_launched: false;
  external_action_executed: false;
  prior_claim_reuse: false;
};

function fail(code: string): never {
  throw new Error(code);
}

function assertOwnedDirectory(path: string, code: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(code);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (uid !== null && info.uid !== uid)) fail(code);
}

function assertRunRoot(runRoot: string): string {
  if (!isAbsolute(runRoot) || runRoot.split(sep).includes("..")) fail("browser_use_authorized_run_root_invalid");
  assertOwnedDirectory(runRoot, "browser_use_authorized_run_root_invalid");
  let canonical = "";
  try {
    canonical = realpathSync(runRoot);
  } catch {
    fail("browser_use_authorized_run_root_invalid");
  }
  if (!isAbsolute(canonical) || canonical.split(sep).includes("..")) fail("browser_use_authorized_run_root_invalid");
  assertSafeParentChain(canonical);
  return canonical;
}

function assertSafeParentChain(runRoot: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let current = dirname(runRoot);
  while (true) {
    let info;
    try {
      info = lstatSync(current);
    } catch {
      fail("browser_use_authorized_parent_invalid");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail("browser_use_authorized_parent_invalid");
    if (uid !== null && info.uid !== uid && info.uid !== 0) fail("browser_use_authorized_parent_owner_invalid");
    const mode = info.mode & 0o7777;
    const groupOrWorldWritable = (mode & 0o022) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    if (groupOrWorldWritable && !sticky) fail("browser_use_authorized_parent_mode_invalid");
    if (current === "/") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function openRunRootGuard(runRoot: string): number {
  let fd: number;
  try {
    fd = openSync(runRoot, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || (uid !== null && info.uid !== uid)) fail("browser_use_authorized_run_root_invalid");
    return fd;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser_use_")) throw error;
    fail("browser_use_authorized_run_root_invalid");
  }
}

function pathsForRunRoot(runRootInput: string): AuthorizedAdmissionPaths {
  const runRoot = assertRunRoot(runRootInput);
  return {
    run_root: runRoot,
    authority_path: join(runRoot, BROWSER_USE_AUTHORIZED_AUTHORITY_FILE),
    envelope_path: join(runRoot, BROWSER_USE_AUTHORIZED_ENVELOPE_FILE),
    claim_path: join(runRoot, BROWSER_USE_AUTHORIZED_CLAIM_FILE)
  };
}

function assertDirectChild(runRoot: string, filePath: string, code: string): void {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath || relative(runRoot, filePath).split(sep).length !== 1) fail(code);
}

function assertFreshApproval(authority: BrowserUseAuthorityV1): void {
  if (authority.approval.source !== "current-user-turn") fail("browser_use_authorized_current_turn_approval_required");
  const approvedAt = Date.parse(authority.approval.approved_at);
  const now = Date.now();
  if (!Number.isFinite(approvedAt) || approvedAt > now || now - approvedAt > APPROVAL_MAX_AGE_MS) fail("browser_use_authorized_approval_stale");
}

function writeNoReplace(path: string, body: string, code: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== null && info.uid !== uid)) fail(code);
    const bytes = Buffer.from(body, "utf8");
    writeSync(fd, bytes, 0, bytes.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncParent(dirname(path));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof Error && error.message.startsWith("browser_use_")) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") fail("browser_use_authorized_claim_replay_forbidden");
    fail(code);
  }
}

function fsyncParent(parent: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch {
    fail("browser_use_authorized_parent_fsync_failed");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sha256Bytes(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function envelopeFor(authority: BrowserUseAuthorityV1, digest: string): BrowserUseAuthorityEnvelopeV1 {
  return {
    schema: "browser_use_authority_envelope.v1",
    issuer: "automation_os_root",
    authority_sha256: digest,
    authority_id: authority.authority_id,
    nonce: authority.nonce,
    run_id: authority.run_id,
    session: authority.session,
    stage_id: authority.stage_id,
    attempt: authority.attempt
  };
}

export function createBrowserUseAuthorizedAuthorityFiles(input: BrowserUseAuthorizedAdmissionInput): {
  paths: AuthorizedAdmissionPaths;
  authority_sha256: string;
  envelope_sha256: string;
} {
  const paths = pathsForRunRoot(input.run_root);
  const rootFd = openRunRootGuard(paths.run_root);
  try {
  assertDirectChild(paths.run_root, paths.authority_path, "browser_use_authorized_authority_path_invalid");
  assertDirectChild(paths.run_root, paths.envelope_path, "browser_use_authorized_envelope_path_invalid");
  assertDirectChild(paths.run_root, paths.claim_path, "browser_use_authorized_claim_path_invalid");
  const authority = parseBrowserUseAuthority(input.authority, input.expected);
  assertFreshApproval(authority);
  const authorityBody = `${JSON.stringify(authority)}\n`;
  writeNoReplace(paths.authority_path, authorityBody, "browser_use_authorized_authority_write_failed");
  const authorityDigest = authoritySha256(paths.authority_path);
  const envelopeBody = `${JSON.stringify(envelopeFor(authority, authorityDigest))}\n`;
  writeNoReplace(paths.envelope_path, envelopeBody, "browser_use_authorized_envelope_write_failed");
  const loaded = loadBrowserUseAuthority({
    authorityPath: paths.authority_path,
    expected: input.expected,
    envelope: JSON.parse(readFileSync(paths.envelope_path, "utf8")) as BrowserUseAuthorityEnvelopeV1
  });
  return { paths, authority_sha256: loaded.authority_sha256, envelope_sha256: sha256Bytes(envelopeBody) };
  } finally {
    fsyncSync(rootFd);
    closeSync(rootFd);
  }
}

export function claimBrowserUseAuthorizedAdmission(input: BrowserUseAuthorizedAdmissionInput): BrowserUseAuthorizedAdmissionV1 {
  const paths = pathsForRunRoot(input.run_root);
  const rootFd = openRunRootGuard(paths.run_root);
  try {
  const authorityDigest = authoritySha256(paths.authority_path);
  const envelope = JSON.parse(readFileSync(paths.envelope_path, "utf8")) as BrowserUseAuthorityEnvelopeV1;
  const loaded = loadBrowserUseAuthority({ authorityPath: paths.authority_path, expected: input.expected, envelope });
  assertFreshApproval(loaded.authority);
  const envelopeBody = `${JSON.stringify(envelope)}\n`;
  const claim = {
    schema: BROWSER_USE_AUTHORIZED_CLAIM_SCHEMA_V1,
    authority_sha256: authorityDigest,
    envelope_sha256: sha256Bytes(envelopeBody),
    authority_id: loaded.authority.authority_id,
    nonce: loaded.authority.nonce,
    run_id: loaded.authority.run_id,
    session: loaded.authority.session,
    stage_id: loaded.authority.stage_id,
    attempt: loaded.authority.attempt,
    attempt_id: input.attempt_id,
    idempotency_key: loaded.authority.idempotency_key,
    claimed_at: new Date().toISOString(),
    adapter_handoff_allowed: false,
    helper_launched: false,
    external_action_executed: false,
    prior_claim_reuse: false
  } as const;
  writeNoReplace(paths.claim_path, `${JSON.stringify(claim)}\n`, "browser_use_authorized_claim_write_failed");
  const persistedClaim = readFileSync(paths.claim_path, "utf8");
  if (sha256Bytes(persistedClaim) !== sha256Bytes(`${JSON.stringify(claim)}\n`)) fail("browser_use_authorized_claim_readback_mismatch");
  const runtimeBinding = buildServiceReadinessBrowserUseRuntimeBindingV1({
    root_id: deriveServiceReadinessRootId(loaded.authority.run_id),
    workflow_id: input.workflow_id,
    run_id: loaded.authority.run_id,
    stage_id: loaded.authority.stage_id,
    attempt_id: input.attempt_id,
    authority_digest: authorityDigest,
    requested_session_id: loaded.authority.session,
    effective_session_id: null,
    profile_root: input.profile_root,
    reserved_port: input.reserved_port,
    lock_path: input.lock_path,
    process_identity: null,
    readback_status: "required",
    mode: "authorized"
  });
  return Object.freeze({
    schema: BROWSER_USE_AUTHORIZED_ADMISSION_SCHEMA_V1,
    browser_surface: "browser_use_cli",
    mode: "authorized",
    authority_path: paths.authority_path,
    envelope_path: paths.envelope_path,
    claim_path: paths.claim_path,
    authority_sha256: authorityDigest,
    envelope_sha256: claim.envelope_sha256,
    authority_id: loaded.authority.authority_id,
    nonce: loaded.authority.nonce,
    run_id: loaded.authority.run_id,
    session: loaded.authority.session,
    stage_id: loaded.authority.stage_id,
    attempt: loaded.authority.attempt,
    attempt_id: input.attempt_id,
    idempotency_key: loaded.authority.idempotency_key,
    runtime_binding: runtimeBinding,
    adapter_handoff_allowed: false,
    helper_launched: false,
    external_action_executed: false,
    prior_claim_reuse: false
  });
  } finally {
    fsyncSync(rootFd);
    closeSync(rootFd);
  }
}
