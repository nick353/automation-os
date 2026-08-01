import { constants as fsConstants, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseAutomationKernelDefinitionV1,
  parseAutomationKernelEffectReceiptInputV1,
  type AutomationKernelDefinitionV1,
  type AutomationKernelEffectReceiptInputV1,
  type AutomationKernelLogInputV1,
  type AutomationKernelSnapshotV1
} from "./contracts.js";
import {
  buildAutomationKernelTimelineEntry,
  hashAutomationKernelValue,
  projectAutomationKernelSnapshotV1,
  reduceAutomationKernelDefinitionV1,
  type AutomationKernelReducedTimelineEntryV1
} from "./reducer.js";

export class AutomationKernelRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationKernelRepositoryError";
  }
}

export type AutomationKernelClaimResult = {
  definition: AutomationKernelDefinitionV1;
  snapshot: AutomationKernelSnapshotV1;
  timeline_entry: AutomationKernelReducedTimelineEntryV1;
  legacy_projection: ReturnType<typeof projectAutomationKernelSnapshotV1>;
  artifact_path: string;
};

export type AutomationKernelReceiptResult = AutomationKernelClaimResult;

export type AutomationKernelLock = {
  path: string;
  release: () => void;
};

const defaultKernelRoot = resolve(process.cwd(), "work", "automation-kernel");
export function automationKernelRoot(input?: string): string {
  const requested = resolve(input ?? process.env.AUTOMATION_OS_AUTOMATION_KERNEL_ROOT ?? defaultKernelRoot);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
    throw new AutomationKernelRepositoryError("kernel_root_symlink_forbidden");
  }
  if (!existsSync(requested)) mkdirSync(requested, { recursive: true, mode: 0o700 });
  const real = realpathSync(requested);
  assertPrivateDirectory(real);
  return real;
}

export function kernelDirectory(kernelId: string, root = automationKernelRoot()): string {
  const normalizedKernelId = parseKernelId(kernelId);
  const resolvedRoot = automationKernelRoot(root);
  const dir = resolve(resolvedRoot, normalizedKernelId);
  assertPathInsideRoot(resolvedRoot, dir);
  return dir;
}

export function definitionPath(kernelId: string, root?: string): string {
  return resolve(kernelDirectory(kernelId, root), "definition.json");
}

export function timelinePath(kernelId: string, root?: string): string {
  return resolve(kernelDirectory(kernelId, root), "timeline.jsonl");
}

export function kernelLockPath(kernelId: string, root?: string): string {
  return resolve(kernelDirectory(kernelId, root), ".automation-kernel.lock");
}

export function ensureKernelDefinition(input: { definition: unknown; root?: string }): AutomationKernelDefinitionV1 {
  const definition = parseAutomationKernelDefinitionV1(input.definition);
  const root = automationKernelRoot(input.root);
  const dir = kernelDirectory(definition.kernel_id, root);
  ensureDirectory(dir, root);
  const path = definitionPath(definition.kernel_id, input.root);
  const contents = `${JSON.stringify(definition, null, 2)}\n`;
  if (existsSync(path)) {
    assertPathInsideRoot(root, path);
    const existing = parseAutomationKernelDefinitionV1(readJson(path, root));
    if (hashAutomationKernelValue(existing) !== hashAutomationKernelValue(definition)) {
      throw new AutomationKernelRepositoryError("kernel_definition_conflict");
    }
    return existing;
  }
  writeImmutableTextFile(path, contents, root);
  return definition;
}

export function loadKernelDefinition(input: { kernelId: string; root?: string }): AutomationKernelDefinitionV1 {
  const root = automationKernelRoot(input.root);
  const path = definitionPath(input.kernelId, input.root);
  if (!existsSync(path)) throw new AutomationKernelRepositoryError("kernel_definition_missing");
  return parseAutomationKernelDefinitionV1(readJson(path, root));
}

export function readKernelSnapshot(input: { kernelId: string; root?: string }): AutomationKernelSnapshotV1 {
  const definition = loadKernelDefinition(input);
  const timeline = readKernelTimeline({ kernelId: input.kernelId, root: input.root });
  return reduceAutomationKernelDefinitionV1(definition, timeline);
}

export function readKernelTimeline(input: { kernelId: string; root?: string }): AutomationKernelReducedTimelineEntryV1[] {
  const root = automationKernelRoot(input.root);
  const path = timelinePath(input.kernelId, input.root);
  if (!existsSync(path)) return [];
  const definition = loadKernelDefinition(input);
  const lines = readStrictTextFile(path, root)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = lines.map((line) => parseTimelineLine(line));
  let expectedSequence = 1;
  let expectedPrevious = hashAutomationKernelValue(definition);
  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) throw new AutomationKernelRepositoryError("kernel_timeline_sequence_gap");
    if (entry.previous_entry_hash !== expectedPrevious) throw new AutomationKernelRepositoryError("kernel_timeline_previous_hash_mismatch");
    const expectedHash = hashAutomationKernelValue({
      schema_version: entry.schema_version,
      kernel_id: entry.kernel_id,
      sequence: entry.sequence,
      entry_kind: entry.entry_kind,
      previous_entry_hash: entry.previous_entry_hash,
      created_at: entry.created_at,
      payload: entry.payload
    });
    if (entry.entry_hash !== expectedHash) throw new AutomationKernelRepositoryError("kernel_timeline_entry_hash_mismatch");
    expectedPrevious = entry.entry_hash;
    expectedSequence += 1;
  }
  return entries;
}

export function acquireKernelLock(input: { kernelId: string; root?: string; owner?: string }): AutomationKernelLock {
  const kernelId = parseKernelId(input.kernelId);
  const root = automationKernelRoot(input.root);
  const lockPath = resolve(kernelDirectory(kernelId, root), ".automation-kernel.lock");
  ensureDirectory(dirname(lockPath), root);

  const owner = sanitizeOwner(input.owner ?? "kernel");
  const token = randomUUID();
  const acquiredAt = new Date().toISOString();
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (isEexist(error)) throw new AutomationKernelRepositoryError("kernel_locked");
    throw error;
  }

  const stat = fstatSync(fd);
  const record = {
    pid: process.pid,
    owner,
    token,
    kernel_id: kernelId,
    acquired_at: acquiredAt,
    inode: stat.ino,
    device: stat.dev
  };
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    chmodPrivate(lockPath, 0o600);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      releaseKernelLock(fd, lockPath, record);
      fd = -1;
    }
  };
}

export function claimKernelEffect(input: {
  definition: unknown;
  root?: string;
  kernelId?: string;
  effectId?: string;
  claimedBy: string;
  createdAt: string;
  unitId?: string;
}): AutomationKernelClaimResult {
  const definition = ensureKernelDefinition({ definition: input.definition, root: input.root });
  const lock = acquireKernelLock({ kernelId: definition.kernel_id, root: input.root, owner: input.claimedBy });
  try {
    const snapshot = readKernelSnapshot({ kernelId: definition.kernel_id, root: input.root });
    const effectId = input.effectId ?? snapshot.next_effect_id;
    if (!effectId) throw new AutomationKernelRepositoryError("kernel_no_claimable_effect");
    const effect = snapshot.effects.find((candidate) => candidate.effect_id === effectId);
    if (!effect) throw new AutomationKernelRepositoryError("kernel_effect_missing");
    if (snapshot.next_effect_id !== effectId) throw new AutomationKernelRepositoryError(`kernel_effect_not_next_claimable:${effectId}`);
    const continuation = effect.payload.continuation && typeof effect.payload.continuation === "object" ? effect.payload.continuation : null;
    const unitId = normalizeUnitId(input.unitId);
    if (continuation && !unitId) throw new AutomationKernelRepositoryError(`kernel_effect_unit_id_required:${effectId}`);
    if (unitId && effect.unit_ids.includes(unitId)) throw new AutomationKernelRepositoryError(`kernel_effect_unit_id_duplicate:${effectId}`);
    const replayable = effect.status === "claimed" && effect.active_unit_id === null && effect.last_outcome === "succeeded" && effect.stage_terminal === false;
    if (effect.status !== "pending" && !replayable) throw new AutomationKernelRepositoryError(`kernel_effect_claim_conflict:${effectId}`);
    return appendKernelLogEntryLocked({
      definition,
      root: input.root,
      logInput: {
        event_type: "effect_claimed",
        effect_id: effectId,
        claimed_by: input.claimedBy,
        claim_id: stableClaimId(definition.kernel_id, effectId, nextSequence(definition.kernel_id, input.root)),
        heartbeat_owner: "caller",
        ...(unitId ? { unit_id: unitId } : {})
      },
      createdAt: input.createdAt
    });
  } finally {
    lock.release();
  }
}

export function recordKernelHeartbeat(input: {
  kernelId: string;
  root?: string;
  ownerToken: string;
  createdAt: string;
}): AutomationKernelClaimResult {
  return appendKernelLogEntry({
    kernelId: input.kernelId,
    root: input.root,
    logInput: {
      event_type: "heartbeat_recorded",
      heartbeat_owner: "caller",
      owner_token: input.ownerToken
    },
    createdAt: input.createdAt
  });
}

export function recordKernelReceipt(input: {
  kernelId: string;
  root?: string;
  effectId: string;
  effectClass: AutomationKernelEffectReceiptInputV1["effect_class"];
  outcome: AutomationKernelEffectReceiptInputV1["outcome"];
  externalActionExecuted: boolean;
  summary: string;
  evidence?: Record<string, unknown>;
  createdAt: string;
  unitId?: string;
  stageTerminal?: boolean;
}): AutomationKernelReceiptResult {
  const lock = acquireKernelLock({ kernelId: input.kernelId, root: input.root, owner: "receipt" });
  try {
    const snapshot = readKernelSnapshot({ kernelId: input.kernelId, root: input.root });
    const effect = snapshot.effects.find((candidate) => candidate.effect_id === input.effectId);
    if (!effect) throw new AutomationKernelRepositoryError("kernel_effect_missing");
    if (effect.status !== "claimed") throw new AutomationKernelRepositoryError(`kernel_receipt_effect_not_claimed:${input.effectId}`);
    if (effect.effect_class !== input.effectClass) throw new AutomationKernelRepositoryError(`kernel_receipt_effect_class_mismatch:${input.effectId}`);
    const unitId = normalizeUnitId(input.unitId);
    const stageTerminal = input.stageTerminal ?? true;
    const continuation = effect.payload.continuation && typeof effect.payload.continuation === "object" ? effect.payload.continuation : null;
    if (continuation && !unitId) throw new AutomationKernelRepositoryError(`kernel_receipt_unit_id_required:${input.effectId}`);
    if (unitId && effect.active_unit_id !== unitId) throw new AutomationKernelRepositoryError(`kernel_receipt_without_active_unit:${input.effectId}`);
    if (!continuation && stageTerminal === false) throw new AutomationKernelRepositoryError(`kernel_receipt_stage_terminal_required:${input.effectId}`);
    return appendKernelLogEntryLocked({
      definition: loadKernelDefinition({ kernelId: input.kernelId, root: input.root }),
      root: input.root,
      logInput: {
        event_type: "effect_receipt_recorded",
        effect_id: input.effectId,
        receipt_id: stableReceiptId(input.kernelId, input.effectId, nextSequence(input.kernelId, input.root)),
        effect_class: input.effectClass,
        outcome: input.outcome,
        external_action_executed: input.externalActionExecuted,
        summary: input.summary,
        evidence: input.evidence ?? {},
        ...(unitId ? { unit_id: unitId } : {}),
        stage_terminal: stageTerminal
      },
      createdAt: input.createdAt
    });
  } finally {
    lock.release();
  }
}

export function projectKernelReadback(input: { kernelId: string; root?: string }): AutomationKernelSnapshotV1 {
  return readKernelSnapshot({ kernelId: input.kernelId, root: input.root });
}

export function automationKernelArtifactPath(input: { kernelId: string; root?: string; suffix?: string }): string {
  const base = kernelDirectory(input.kernelId, input.root);
  const suffix = input.suffix ?? "claim-result.json";
  const path = resolve(base, suffix);
  assertPathInsideRoot(base, path);
  return path;
}

export function writeKernelArtifact(input: {
  kernelId: string;
  root?: string;
  artifact: unknown;
  suffix?: string;
}): string {
  const root = automationKernelRoot(input.root);
  const path = automationKernelArtifactPath({ kernelId: input.kernelId, root: input.root, suffix: input.suffix });
  writeImmutableTextFile(path, `${JSON.stringify(input.artifact, null, 2)}\n`, root);
  return path;
}

function appendKernelLogEntry(input: {
  kernelId: string;
  root?: string;
  logInput: AutomationKernelLogInputV1;
  createdAt: string;
}): AutomationKernelClaimResult {
  const definition = loadKernelDefinition({ kernelId: input.kernelId, root: input.root });
  const lock = acquireKernelLock({ kernelId: definition.kernel_id, root: input.root, owner: "timeline" });
  try {
    return appendKernelLogEntryLocked({
      definition,
      root: input.root,
      logInput: input.logInput,
      createdAt: input.createdAt
    });
  } finally {
    lock.release();
  }
}

function appendKernelLogEntryLocked(input: {
  definition: AutomationKernelDefinitionV1;
  root?: string;
  logInput: AutomationKernelLogInputV1;
  createdAt: string;
}): AutomationKernelClaimResult {
  const existing = readKernelTimeline({ kernelId: input.definition.kernel_id, root: input.root });
  const previousEntryHash = existing.at(-1)?.entry_hash ?? hashAutomationKernelValue(input.definition);
  const sequence = existing.length + 1;
  const entryKind = input.logInput.event_type === "effect_receipt_recorded" ? "effect_receipt" : input.logInput.event_type === "heartbeat_recorded" ? "heartbeat" : "kernel_event";
  const payload = input.logInput as Record<string, unknown>;
  const entry = buildAutomationKernelTimelineEntry({
    kernelId: input.definition.kernel_id,
    sequence,
    entryKind,
    previousEntryHash,
    createdAt: input.createdAt,
    payload
  });
  appendTimelineEntry(input.definition.kernel_id, input.root, entry);
  const snapshot = reduceAutomationKernelDefinitionV1(input.definition, [...existing, entry]);
  return {
    definition: input.definition,
    snapshot,
    timeline_entry: entry,
    legacy_projection: projectAutomationKernelSnapshotV1(snapshot),
    artifact_path: automationKernelArtifactPath({ kernelId: input.definition.kernel_id, root: input.root })
  };
}

function nextSequence(kernelId: string, root?: string): number {
  return readKernelTimeline({ kernelId, root }).length + 1;
}

function appendTimelineEntry(
  kernelId: string,
  root: string | undefined,
  entry: AutomationKernelReducedTimelineEntryV1
): void {
  const resolvedRoot = automationKernelRoot(root);
  const path = timelinePath(kernelId, root);
  ensureDirectory(dirname(path), resolvedRoot);
  if (existsSync(path)) assertPrivateRegularFile(path);
  const line = `${JSON.stringify(entry)}\n`;
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    assertOpenFileMatchesPath(fd, path);
    writeSync(fd, line);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    assertOpenFileMatchesPath(fd, path);
  } finally {
    closeSync(fd);
  }
}

function readJson(path: string, root: string): unknown {
  return JSON.parse(readStrictTextFile(path, root)) as unknown;
}

function parseTimelineLine(line: string): AutomationKernelReducedTimelineEntryV1 {
  const value = JSON.parse(line) as AutomationKernelReducedTimelineEntryV1;
  if (value.schema_version !== "automation_kernel.timeline.v1") throw new AutomationKernelRepositoryError("kernel_timeline_schema_version_invalid");
  return value;
}

function parseKernelId(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(normalized)) {
    throw new AutomationKernelRepositoryError("kernel_id_invalid");
  }
  return normalized;
}

function stableClaimId(kernelId: string, effectId: string, sequence: number): string {
  return `claim_${hashAutomationKernelValue({ kernelId, effectId, sequence }).slice(0, 16)}`;
}

function stableReceiptId(kernelId: string, effectId: string, sequence: number): string {
  return `receipt_${hashAutomationKernelValue({ kernelId, effectId, sequence }).slice(0, 16)}`;
}

function ensureDirectory(path: string, root: string): void {
  assertPathInsideRoot(root, path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodPrivate(path, 0o700);
  assertPrivateDirectory(path);
}

function writeImmutableTextFile(path: string, contents: string, root: string): void {
  ensureDirectory(dirname(path), root);
  if (existsSync(path)) {
    const existing = readStrictTextFile(path, root);
    if (existing === contents) return;
    throw new AutomationKernelRepositoryError("kernel_artifact_conflict");
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (isEexist(error)) {
      const existing = readStrictTextFile(path, root);
      if (existing === contents) return;
      throw new AutomationKernelRepositoryError("kernel_artifact_conflict");
    }
    throw error;
  }
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    assertOpenFileMatchesPath(fd, path);
  } finally {
    closeSync(fd);
  }
}

function releaseKernelLock(fd: number, lockPath: string, record: Record<string, unknown>): void {
  try {
    const current = readLockRecord(lockPath, dirname(dirname(lockPath)));
    const fdStat = fstatSync(fd);
    const fileStat = lstatSync(lockPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || fileStat.uid !== currentUid()) throw new AutomationKernelRepositoryError("kernel_lock_invalid_on_release");
    const inodeMatch = fdStat.ino === fileStat.ino && fdStat.dev === fileStat.dev;
    const tokenMatch = current?.token === record.token && current?.pid === record.pid;
    if (!inodeMatch) throw new AutomationKernelRepositoryError("kernel_lock_inode_changed");
    if (!tokenMatch) throw new AutomationKernelRepositoryError("kernel_lock_token_changed");
    unlinkSync(lockPath);
  } finally {
    closeSync(fd);
  }
}

function readLockRecord(lockPath: string, root: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readStrictTextFile(lockPath, root)) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

function sanitizeOwner(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "_").slice(0, 80) || "unknown";
}

function normalizeUnitId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) throw new AutomationKernelRepositoryError("kernel_unit_id_invalid");
  return normalized;
}

function assertPathInsideRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new AutomationKernelRepositoryError("kernel_path_escape");
  }
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  const segments = relativePath.split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new AutomationKernelRepositoryError("kernel_symlink_forbidden");
  }
}

function readStrictTextFile(path: string, root: string): string {
  assertPathInsideRoot(root, path);
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assertOpenFileMatchesPath(fd, path);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function chmodPrivate(path: string, mode: number): void {
  chmodSync(path, mode);
  const observed = lstatSync(path).mode & 0o777;
  if (observed !== mode) throw new AutomationKernelRepositoryError("kernel_permissions_invalid");
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AutomationKernelRepositoryError("kernel_directory_invalid");
  if (stat.uid !== currentUid()) throw new AutomationKernelRepositoryError("kernel_directory_owner_invalid");
  if ((stat.mode & 0o077) !== 0) throw new AutomationKernelRepositoryError("kernel_directory_permissions_invalid");
}

function assertPrivateRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AutomationKernelRepositoryError("kernel_file_invalid");
  if (stat.uid !== currentUid()) throw new AutomationKernelRepositoryError("kernel_file_owner_invalid");
  if ((stat.mode & 0o077) !== 0) throw new AutomationKernelRepositoryError("kernel_file_permissions_invalid");
}

function assertOpenFileMatchesPath(fd: number, path: string): void {
  const fdStat = fstatSync(fd);
  const pathStat = lstatSync(path);
  if (!fdStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()) throw new AutomationKernelRepositoryError("kernel_file_invalid");
  if (fdStat.uid !== currentUid() || pathStat.uid !== currentUid()) throw new AutomationKernelRepositoryError("kernel_file_owner_invalid");
  if (fdStat.nlink !== 1 || pathStat.nlink !== 1) throw new AutomationKernelRepositoryError("kernel_file_hardlink_forbidden");
  if (fdStat.ino !== pathStat.ino || fdStat.dev !== pathStat.dev) throw new AutomationKernelRepositoryError("kernel_file_inode_changed");
  if ((fdStat.mode & 0o077) !== 0 || (pathStat.mode & 0o077) !== 0) throw new AutomationKernelRepositoryError("kernel_file_permissions_invalid");
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : lstatSync(process.cwd()).uid;
}

function isEexist(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST";
}
