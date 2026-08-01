import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  type Stats
} from "node:fs";
import { resolve, join, relative, sep } from "node:path";

import {
  CANONICAL_TRUSTED_STATE_ROOT,
  IAB_CONTRACT_VERSION,
  type TrustedStateRootEvidence
} from "./iabReadOnlyBridge.js";
import {
  projectIabOwnerDiagnostics,
  type IabOwnerDiagnostics
} from "./iabOwnerDiagnostics.js";

/**
 * The canonical reader is intentionally opt-in.  Keeping the default off
 * means importing this module cannot cause a state-root read by itself.
 */
export const CANONICAL_IAB_READER_DEFAULT_ENABLED = false as const;

/** Keep untrusted state-root JSON bounded before parsing it. */
export const CANONICAL_IAB_MAX_JSON_BYTES = 256 * 1024;

const IAB_DIRECTORY_NAME = "iab";
const CONTRACT_FILE_NAME = "readonly-contract.json";
const RECEIPT_FILE_NAME = "handler-receipt.json";

export type CanonicalIabOwnerDiagnostics = IabOwnerDiagnostics & {
  source: "canonical_state_root";
};

export type CanonicalIabLoaderOptions = {
  /** The reader is default-off and must be explicitly enabled. */
  enabled?: boolean;
  now?: Date;
  /**
   * Internal fixture-only root injection.  Production callers must omit this
   * option; a non-canonical root is rejected unless allowTestRoot is true.
   */
  rootPath?: string;
  /** Internal test-only gate for rootPath. */
  allowTestRoot?: boolean;
};

type FileReadSuccess = { ok: true; value: unknown; stat: Stats };
type FileReadFailure = { ok: false; exact_blocker: string };
type FileReadResult = FileReadSuccess | FileReadFailure;

function blocked(exact_blocker: string): CanonicalIabOwnerDiagnostics {
  return {
    state: "blocked",
    contract_version: IAB_CONTRACT_VERSION,
    receipt_fresh: false,
    consumed: false,
    provenance: "blocked",
    generation: "unknown",
    proof: "invalid",
    cleanup: "invalid",
    age_ms: null,
    binding: "unknown",
    exact_blocker,
    existing_workflows_unchanged: false,
    source: "canonical_state_root"
  };
}

function currentUid(): number | null {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function modeBits(mode: number): number {
  return mode & 0o7777;
}

function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink && a.size === b.size;
}

function readError(kind: "contract" | "receipt"): FileReadFailure {
  return { ok: false, exact_blocker: `iab_canonical_${kind}_unreadable` };
}

function missingError(kind: "contract" | "receipt"): FileReadFailure {
  return { ok: false, exact_blocker: `iab_canonical_${kind}_missing` };
}

/**
 * Read one JSON file after lstat/stat checks and an O_NOFOLLOW open.  The
 * second fstat protects the bounded read from a path replacement race.  This
 * function has no write-capable filesystem operation.
 */
function readBoundedJson(filePath: string, kind: "contract" | "receipt", uid: number): FileReadResult {
  let listed: Stats;
  let stated: Stats;
  try {
    listed = lstatSync(filePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? missingError(kind) : readError(kind);
  }
  if (listed.isSymbolicLink() || !listed.isFile()) return readError(kind);

  try {
    stated = statSync(filePath);
  } catch {
    return readError(kind);
  }
  if (stated.isSymbolicLink() || !stated.isFile() || !sameStat(listed, stated)) return readError(kind);
  if (stated.uid !== uid || stated.nlink !== 1) return readError(kind);
  // The handler receipt has a strict owner-only mode requirement.  The
  // contract remains owner-controlled by the 0700 root, but group/other write
  // bits are still rejected to avoid treating a mutable file as trusted.
  if (kind === "receipt" ? modeBits(stated.mode) !== 0o600 : (modeBits(stated.mode) & 0o022) !== 0) return readError(kind);
  if (!Number.isSafeInteger(stated.size) || stated.size <= 0 || stated.size > CANONICAL_IAB_MAX_JSON_BYTES) return readError(kind);

  let fd: number;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
  } catch {
    return readError(kind);
  }

  try {
    const opened = fstatSync(fd);
    if (opened.isSymbolicLink() || !opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || !sameStat(stated, opened)) return readError(kind);
    if (kind === "receipt" ? modeBits(opened.mode) !== 0o600 : (modeBits(opened.mode) & 0o022) !== 0) return readError(kind);
    if (!Number.isSafeInteger(opened.size) || opened.size <= 0 || opened.size > CANONICAL_IAB_MAX_JSON_BYTES) return readError(kind);

    // Read exactly the fstat-bounded size.  A one-byte probe detects growth
    // without allocating an unbounded buffer.
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return readError(kind);
      offset += count;
    }
    const probe = Buffer.alloc(1);
    if (readSync(fd, probe, 0, 1, opened.size) > 0) return readError(kind);
    const after = fstatSync(fd);
    if (!sameStat(opened, after)) return readError(kind);

    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return { ok: false, exact_blocker: `iab_canonical_${kind}_invalid` };
    }
    // Return the stat(2) result that was captured before opening.  The fstat
    // result above only guards the read; provenance evidence is derived from
    // lstat/stat observations, never from document contents or caller input.
    return { ok: true, value, stat: stated };
  } catch {
    return readError(kind);
  } finally {
    closeSync(fd);
  }
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.includes("\u0000");
}

function validateDirectory(
  directoryPath: string,
  uid: number,
  expected: "root" | "iab"
): { ok: true; stat: Stats } | { ok: false; exact_blocker: string } {
  let listed: Stats;
  let stated: Stats;
  try {
    listed = lstatSync(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, exact_blocker: `iab_canonical_${expected === "root" ? "root" : "iab_directory"}_missing` };
    return { ok: false, exact_blocker: `iab_canonical_${expected === "root" ? "root" : "iab_directory"}_unreadable` };
  }
  if (listed.isSymbolicLink() || !listed.isDirectory()) return { ok: false, exact_blocker: `iab_canonical_${expected === "root" ? "root" : "iab_directory"}_unreadable` };
  try {
    stated = statSync(directoryPath);
  } catch {
    return { ok: false, exact_blocker: `iab_canonical_${expected === "root" ? "root" : "iab_directory"}_unreadable` };
  }
  if (stated.isSymbolicLink() || !stated.isDirectory() || !sameStat(listed, stated) || stated.uid !== uid) {
    return { ok: false, exact_blocker: stated.uid !== uid ? "iab_canonical_root_unowned" : `iab_canonical_${expected === "root" ? "root" : "iab_directory"}_unreadable` };
  }
  if (expected === "root" && modeBits(stated.mode) !== 0o700) return { ok: false, exact_blocker: "iab_canonical_root_unreadable" };
  if (expected === "iab" && (modeBits(stated.mode) & 0o022) !== 0) return { ok: false, exact_blocker: "iab_canonical_iab_directory_unreadable" };
  return { ok: true, stat: stated };
}

function trustedEvidence(rootStat: Stats, receiptStat: Stats): TrustedStateRootEvidence | null {
  const virtualReceiptPath = join(CANONICAL_TRUSTED_STATE_ROOT, IAB_DIRECTORY_NAME, RECEIPT_FILE_NAME);
  if (!pathWithinRoot(CANONICAL_TRUSTED_STATE_ROOT, virtualReceiptPath) || resolve(virtualReceiptPath) !== virtualReceiptPath) return null;
  if (modeBits(rootStat.mode) !== 0o700 || modeBits(receiptStat.mode) !== 0o600 || receiptStat.nlink !== 1) return null;
  return {
    canonical_root: CANONICAL_TRUSTED_STATE_ROOT,
    realpath: CANONICAL_TRUSTED_STATE_ROOT,
    uid: rootStat.uid,
    mode: modeBits(rootStat.mode),
    receipt_realpath: virtualReceiptPath,
    receipt_mode: modeBits(receiptStat.mode),
    receipt_is_symlink: false,
    receipt_link_count: 1,
    is_symlink: false,
    atomic_origin: true
  };
}

function effectiveRoot(options: CanonicalIabLoaderOptions): { ok: true; path: string } | { ok: false; exact_blocker: string } {
  if (options.rootPath === undefined) return { ok: true, path: CANONICAL_TRUSTED_STATE_ROOT };
  if (typeof options.rootPath !== "string" || options.rootPath.length === 0) return { ok: false, exact_blocker: "iab_canonical_root_override_invalid" };
  if (options.rootPath !== CANONICAL_TRUSTED_STATE_ROOT && options.allowTestRoot !== true) return { ok: false, exact_blocker: "iab_canonical_root_override_forbidden" };
  return { ok: true, path: options.rootPath === CANONICAL_TRUSTED_STATE_ROOT ? CANONICAL_TRUSTED_STATE_ROOT : resolve(options.rootPath) };
}

/**
 * Load owner-safe diagnostics from the fixed canonical IAB state root.
 *
 * This returns the lossy owner projection directly.  It never returns either
 * parsed document, and blocked paths never fabricate a receipt or contract.
 */
export function readCanonicalIabOwnerDiagnostics(options: CanonicalIabLoaderOptions = {}): CanonicalIabOwnerDiagnostics {
  if (options.enabled !== true) return blocked("iab_canonical_loader_disabled");
  if (options.now !== undefined && (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime()))) return blocked("iab_canonical_now_invalid");

  const root = effectiveRoot(options);
  if (!root.ok) return blocked(root.exact_blocker);
  const uid = currentUid();
  if (uid === null) return blocked("iab_canonical_root_ownership_unverifiable");

  const rootResult = validateDirectory(root.path, uid, "root");
  if (!rootResult.ok) return blocked(rootResult.exact_blocker);
  const iabPath = join(root.path, IAB_DIRECTORY_NAME);
  if (!pathWithinRoot(root.path, iabPath)) return blocked("iab_canonical_iab_directory_unreadable");
  const iabResult = validateDirectory(iabPath, uid, "iab");
  if (!iabResult.ok) return blocked(iabResult.exact_blocker);

  const contractPath = join(iabPath, CONTRACT_FILE_NAME);
  const receiptPath = join(iabPath, RECEIPT_FILE_NAME);
  if (!pathWithinRoot(root.path, contractPath) || !pathWithinRoot(root.path, receiptPath)) return blocked("iab_canonical_path_invalid");

  const contract = readBoundedJson(contractPath, "contract", uid);
  if (!contract.ok) return blocked(contract.exact_blocker);
  const receipt = readBoundedJson(receiptPath, "receipt", uid);
  if (!receipt.ok) return blocked(receipt.exact_blocker);

  const evidence = trustedEvidence(rootResult.stat, receipt.stat);
  if (!evidence) return blocked("iab_canonical_provenance_unavailable");
  const projection = projectIabOwnerDiagnostics({
    contract: contract.value,
    receipt: receipt.value,
    now: options.now,
    // A state-root reader has no independent proof that existing workflows
    // were left untouched.  Keep that owner-facing gate blocked rather than
    // asserting a cross-workflow fact on the caller's behalf.
    existingWorkflowsUnchanged: false,
    trustedStateRootEvidence: evidence
  });
  return { ...projection, source: "canonical_state_root" };
}

// Names used by callers that describe this as a loader rather than a reader.
export const loadCanonicalIabOwnerDiagnostics = readCanonicalIabOwnerDiagnostics;
export const getCanonicalIabOwnerDiagnostics = readCanonicalIabOwnerDiagnostics;
