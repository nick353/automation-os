import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { registeredBrowserLanes } from "../runs/laneManager.js";

const execFileAsync = promisify(execFileCallback);
const LIVE_PROCESS_READBACK_TIMEOUT_MS = 2_000;

export const BROWSER_RUNTIME_PROCESS_READBACK_SCHEMA = "aos.browser_runtime_process_readback.v1" as const;

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

type SafeProcessEnv = {
  effects: "read_only" | "unknown";
  mode: "external" | "canary" | "unknown";
  durableOnly: boolean | null;
  workerId: string | null;
  remoteOrigin: string | null;
  remoteCompanyId: string | null;
};

export type PortableRemoteWorkerScopeReadback = {
  status: "matched" | "mismatch" | "unknown" | "absent" | "unavailable";
  controlPlaneCompanyIds: string[];
  remoteWorkerCompanyIds: string[];
  remoteOrigins: string[];
  workerIds: string[];
  alignmentCandidates: Array<{
    scope: "control_plane_queue" | "portable_remote_worker";
    status: "observed" | "not_observed" | "unreadable";
    companyIds: string[];
    origins: string[];
    workerIds: string[];
  }>;
  alignmentDecisionRequired: boolean;
  exactBlocker: "portable_worker_company_scope_mismatch" | "portable_worker_company_scope_unreadable" | null;
  nextAction: string;
};

export type BrowserRuntimeProcessReadbackOptions = {
  psOutput?: string | null;
  envOutputByPid?: Record<string, string | null>;
  workerStatusOutput?: string | null;
  controlPlaneCompanyIds?: string[];
  /** Keep server-side unit projections hermetic; production defaults to live ps readback. */
  readLiveProcessTable?: boolean;
  capturedAt?: string;
};

/**
 * Async counterpart used by HTTP readbacks.  The sync helper remains for
 * worker/CLI callers, but a request must not block the Node event loop while
 * asking macOS for the process table or a worker environment projection.
 */
export async function buildBrowserRuntimeProcessReadbackAsync(options: BrowserRuntimeProcessReadbackOptions = {}) {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const psOutput = options.psOutput === undefined
    ? options.readLiveProcessTable === false ? "" : await readProcessTableAsync()
    : options.psOutput;
  if (psOutput === null) return buildBrowserRuntimeProcessReadback({ ...options, psOutput: null, capturedAt });
  const rows = parseProcessRows(psOutput);
  const remoteWorkerPids = rows
    .filter((row) => /aos-portable-remote-worker\.mjs/u.test(row.command))
    .map((row) => row.pid);
  const envOutputByPid: Record<string, string | null> = { ...(options.envOutputByPid ?? {}) };
  await Promise.all(remoteWorkerPids.map(async (pid) => {
    const key = String(pid);
    if (Object.prototype.hasOwnProperty.call(envOutputByPid, key)) return;
    envOutputByPid[key] = await readSafeProcessEnvAsync(pid);
  }));
  return buildBrowserRuntimeProcessReadback({ ...options, psOutput, envOutputByPid, capturedAt });
}

type PortableRemoteWorkerTransportReadback = {
  status: "available" | "missing" | "invalid" | "unavailable";
  heartbeatStatus: "ok" | "blocked" | "unknown";
  heartbeatExactBlocker: string | null;
  heartbeatAt: string | null;
  lastSuccessfulHeartbeatAt: string | null;
  lastAttemptAt: string | null;
  claimStatus: "claimed" | "idle" | "unknown";
  generationStartedAt: string | null;
  updatedAt: string | null;
  pid: number | null;
  workerId: string | null;
  remoteOrigin: string | null;
  source: "worker_status_file" | "missing" | "invalid" | "unavailable";
};

export function buildBrowserRuntimeProcessReadback(options: BrowserRuntimeProcessReadbackOptions = {}) {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const psOutput = options.psOutput === undefined
    ? options.readLiveProcessTable === false ? "" : readProcessTable()
    : options.psOutput;
  if (psOutput === null) return unavailableReadback(capturedAt);

  const rows = parseProcessRows(psOutput);
  const browserProcesses = dedupeBrowserUseProcesses(rows
    .map((row) => parseBrowserUseProcess(row))
    .filter((row): row is ParsedBrowserUseProcess => row !== null));
  const remoteWorkers = rows
    .filter((row) => /aos-portable-remote-worker\.mjs/u.test(row.command))
    .map((row) => ({
      pid: row.pid,
      ...readSafeProcessEnv(row.pid, options.envOutputByPid?.[String(row.pid)])
    }));
  const workerTransport = readPortableRemoteWorkerTransport(options.workerStatusOutput);

  const registeredLaneReadback = registeredBrowserLanes.map((lane) => {
    const profileRef = publicProfileRef(lane.profileDir) ?? lane.profileDir.split("/").at(-1) ?? "unknown";
    const exact = browserProcesses.find((process) => process.port === lane.reservedPort && process.profileRef === profileRef);
    const portMatch = browserProcesses.find((process) => process.port === lane.reservedPort);
    const profileMatch = browserProcesses.find((process) => process.profileRef === profileRef);
    const mismatch = portMatch ?? profileMatch;
    return {
      laneId: lane.id,
      workflowId: lane.workflowId,
      profileRef,
      reservedPort: lane.reservedPort,
      processStatus: exact ? "present" : mismatch ? "binding_mismatch" : "absent",
      matchingPid: exact?.pid ?? null,
      mismatchPid: exact ? null : mismatch?.pid ?? null
    } as const;
  });

  const publicBrowserProcesses = browserProcesses.map((process) => {
    const exactLane = registeredLaneReadback.find((lane) => lane.profileRef === process.profileRef && lane.reservedPort === process.port);
    const portLane = registeredLaneReadback.find((lane) => lane.reservedPort === process.port);
    const profileLane = registeredLaneReadback.find((lane) => lane.profileRef === process.profileRef);
    const relatedLane = exactLane ?? portLane ?? profileLane;
    return {
      kind: "browser_use_chrome",
      pid: process.pid,
      profileRef: process.profileRef,
      profileName: process.profileName,
      port: process.port,
      processCount: process.processCount,
      laneId: relatedLane?.laneId ?? null,
      workflowId: relatedLane?.workflowId ?? null,
      bindingStatus: exactLane ? "registered" : relatedLane ? "binding_mismatch" : "unregistered",
      ownership: exactLane ? "workflow_owned" : "unknown",
      readbackStatus: "process_present"
    } as const;
  });

  const mismatchCount = publicBrowserProcesses.filter((process) => process.bindingStatus === "binding_mismatch").length;
  const unregisteredCount = publicBrowserProcesses.filter((process) => process.bindingStatus === "unregistered").length;
  const exactBlocker = mismatchCount > 0
    ? "browser_use_live_process_binding_mismatch"
    : unregisteredCount > 0
      ? "browser_use_unregistered_live_process"
      : null;
  const portableEffects = remoteWorkers.length > 0 && remoteWorkers.every((worker) => worker.effects === "read_only")
    ? "read_only"
    : "unknown";
  const portableModes = new Set(remoteWorkers.map((worker) => worker.mode));
  const portableMode = portableModes.size === 1 ? [...portableModes][0] : "unknown";
  const durableOnlyValues = new Set(remoteWorkers.map((worker) => worker.durableOnly).filter((value): value is boolean => value !== null));
  const durableOnly = durableOnlyValues.size === 1 ? [...durableOnlyValues][0] : null;
  const workerScopeReadback = buildPortableRemoteWorkerScopeReadback({
    controlPlaneCompanyIds: options.controlPlaneCompanyIds ?? [],
    remoteWorkers: remoteWorkers.map((worker) => ({
      remoteCompanyId: worker.remoteCompanyId,
      remoteOrigin: worker.remoteOrigin ?? workerTransport.remoteOrigin,
      workerId: worker.workerId ?? workerTransport.workerId
    }))
  });

  return {
    schema: BROWSER_RUNTIME_PROCESS_READBACK_SCHEMA,
    status: "available",
    source: "same_host_ps",
    capturedAt,
    registeredLanes: registeredLaneReadback,
    browserProcesses: publicBrowserProcesses,
    portableRemoteWorker: {
      status: remoteWorkers.length > 0 ? "present" : "absent",
      processCount: remoteWorkers.length,
      pids: remoteWorkers.map((worker) => worker.pid),
      mode: portableMode,
      effects: portableEffects,
      durableOnly,
      processes: remoteWorkers.map((worker) => ({
        pid: worker.pid,
        workerId: worker.workerId ?? workerTransport.workerId,
        remoteOrigin: worker.remoteOrigin ?? workerTransport.remoteOrigin,
        remoteCompanyId: worker.remoteCompanyId,
        mode: worker.mode,
        effects: worker.effects,
        durableOnly: worker.durableOnly
      })),
      scopeReadback: workerScopeReadback,
      transportReadback: workerTransport
    },
    unregisteredBrowserProcessCount: unregisteredCount,
    bindingMismatchCount: mismatchCount,
    exactBlocker,
    nextAction: exactBlocker
      ? "所有者を確認できないBrowser Useプロセスは終了せず、同一Runのroom・authority・recording readbackを確認してください。"
      : workerScopeReadback.exactBlocker
        ? workerScopeReadback.nextAction
        : remoteWorkers.length > 0
          ? "remote workerのプロセス存在は確認済みです。heartbeat、queue claim、同一Runのreceipt/readbackは別に確認してください。"
          : "登録laneを起動する場合は、AOSのworkflow-owned profile/port lockを同一Runで取得してから進めてください。",
    externalActionExecuted: false
  } as const;
}

function unavailableReadback(capturedAt: string) {
  return {
    schema: BROWSER_RUNTIME_PROCESS_READBACK_SCHEMA,
    status: "unavailable",
    source: "unavailable",
    capturedAt,
    registeredLanes: [],
    browserProcesses: [],
    portableRemoteWorker: {
      status: "unknown",
      processCount: 0,
      pids: [],
      mode: "unknown",
      effects: "unknown",
      durableOnly: null,
      processes: [],
      scopeReadback: buildPortableRemoteWorkerScopeReadback({
        controlPlaneCompanyIds: [],
        remoteWorkers: [],
        unavailable: true
      }),
      transportReadback: readPortableRemoteWorkerTransport(null)
    },
    unregisteredBrowserProcessCount: 0,
    bindingMismatchCount: 0,
    exactBlocker: "browser_use_same_host_process_readback_unavailable",
    nextAction: "Mac worker側でprocess identityとprofile/port lockをreadbackし、control planeへ返してください。",
    externalActionExecuted: false
  } as const;
}

function readPortableRemoteWorkerTransport(injectedOutput?: string | null): PortableRemoteWorkerTransportReadback {
  if (injectedOutput === null) return unavailableWorkerTransport("unavailable");
  const output = injectedOutput === undefined
    ? (() => {
      const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
      const artifactRoot = resolve(process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT || join(repoRoot, "data", "artifacts", "portable-remote-worker"));
      const statusPath = join(artifactRoot, "worker-status.v1.json");
      try {
        const stat = lstatSync(statusPath);
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
        return readFileSync(statusPath, "utf8");
      } catch {
        return null;
      }
    })()
    : injectedOutput;
  if (output === null) return unavailableWorkerTransport("missing");
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (!value || value.schema !== "aos.portable_remote_worker_status.v1") return unavailableWorkerTransport("invalid");
    const heartbeatStatus = value.heartbeat_status === "ok" || value.heartbeat_status === "blocked" ? value.heartbeat_status : "unknown";
    const claimStatus = value.claim_status === "claimed" || value.claim_status === "idle" ? value.claim_status : "unknown";
    const safeTimestamp = (key: string) => typeof value[key] === "string" && !Number.isNaN(Date.parse(String(value[key]))) ? String(value[key]) : null;
    const blocker = typeof value.heartbeat_exact_blocker === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value.heartbeat_exact_blocker) ? value.heartbeat_exact_blocker : null;
    const pid = typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
    const workerId = safeIdentifier(typeof value.worker_id === "string" ? value.worker_id : null);
    const remoteOrigin = safeOrigin(typeof value.remote_origin === "string" ? value.remote_origin : null);
    return {
      status: "available",
      heartbeatStatus,
      heartbeatExactBlocker: blocker,
      heartbeatAt: safeTimestamp("heartbeat_at"),
      lastSuccessfulHeartbeatAt: safeTimestamp("last_successful_heartbeat_at"),
      lastAttemptAt: safeTimestamp("last_attempt_at"),
      claimStatus,
      generationStartedAt: safeTimestamp("generation_started_at"),
      updatedAt: safeTimestamp("updated_at"),
      pid,
      workerId,
      remoteOrigin,
      source: "worker_status_file"
    };
  } catch {
    return unavailableWorkerTransport("invalid");
  }
}

function unavailableWorkerTransport(status: "missing" | "invalid" | "unavailable"): PortableRemoteWorkerTransportReadback {
  return {
    status,
    heartbeatStatus: "unknown",
    heartbeatExactBlocker: null,
    heartbeatAt: null,
    lastSuccessfulHeartbeatAt: null,
    lastAttemptAt: null,
    claimStatus: "unknown",
    generationStartedAt: null,
    updatedAt: null,
    pid: null,
    workerId: null,
    remoteOrigin: null,
    source: status
  };
}

function parseProcessRows(output: string): ProcessRow[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    })
    .filter((row): row is ProcessRow => row !== null && Number.isInteger(row.pid) && row.pid > 0);
}

type ParsedBrowserUseProcess = ProcessRow & {
  profileRef: string;
  profileName: string;
  port: number;
  processCount: number;
  pids: number[];
};

function parseBrowserUseProcess(row: ProcessRow): ParsedBrowserUseProcess | null {
  if (!/(?:Google Chrome|Chromium|chrome)/iu.test(row.command)) return null;
  const portMatch = row.command.match(/--remote-debugging-port=(\d+)/u);
  const profileMatch = row.command.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  if (!portMatch || !profileMatch) return null;
  const profilePath = profileMatch[1] ?? profileMatch[2] ?? profileMatch[3] ?? "";
  const profileRef = publicProfileRef(profilePath);
  if (!profileRef) return null;
  return {
    ...row,
    port: Number(portMatch[1]),
    profileRef,
    profileName: profileRef.split("/").at(-1) ?? profileRef,
    processCount: 1,
    pids: [row.pid]
  };
}

function dedupeBrowserUseProcesses(processes: ParsedBrowserUseProcess[]): ParsedBrowserUseProcess[] {
  const groups = new Map<string, ParsedBrowserUseProcess[]>();
  for (const process of processes) {
    const key = `${process.profileRef}\n${process.port}`;
    const group = groups.get(key) ?? [];
    group.push(process);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const primary = group.find((process) => process.ppid === 1) ?? [...group].sort((left, right) => left.pid - right.pid)[0];
      return {
        ...primary,
        processCount: group.length,
        pids: group.map((process) => process.pid).sort((left, right) => left - right)
      };
    })
    .sort((left, right) => left.port - right.port || left.profileRef.localeCompare(right.profileRef));
}

function publicProfileRef(profilePath: string): string | null {
  const normalized = profilePath.replaceAll("\\", "/");
  const marker = "/.browser-use-cli/profiles/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const ref = normalized.slice(markerIndex + marker.length).replace(/[^0-9A-Za-z._/-]/g, "").replace(/^\/+|\/+$/g, "");
  if (!ref || ref.length > 160) return null;
  return ref;
}

function readProcessTable(): string | null {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "");
}

async function readProcessTableAsync(): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: LIVE_PROCESS_READBACK_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    });
    return String(result.stdout ?? "");
  } catch {
    return null;
  }
}

function readSafeProcessEnv(pid: number, injectedOutput?: string | null): SafeProcessEnv {
  const output = injectedOutput === undefined
    ? String(spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "")
    : injectedOutput ?? "";
  const read = (key: string) => output.match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`, "u"))?.[1] ?? null;
  const effects = read("AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS");
  const mode = read("AUTOMATION_OS_PORTABLE_WORKER_MODE");
  const durableOnly = read("AUTOMATION_OS_WORKER_DURABLE_ONLY");
  const workerId = safeIdentifier(read("AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID"));
  const remoteOrigin = safeOrigin(read("AUTOMATION_OS_PORTABLE_REMOTE_URL"));
  const remoteCompanyId = safeIdentifier(read("AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID"));
  return {
    effects: effects === "read_only" ? "read_only" : "unknown",
    mode: mode === "external" || mode === "canary" ? mode : "unknown",
    durableOnly: durableOnly === "1" ? true : durableOnly === "0" ? false : null,
    workerId,
    remoteOrigin,
    remoteCompanyId
  };
}

async function readSafeProcessEnvAsync(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["eww", "-p", String(pid)], {
      encoding: "utf8",
      timeout: LIVE_PROCESS_READBACK_TIMEOUT_MS,
      maxBuffer: 512 * 1024
    });
    return String(result.stdout ?? "");
  } catch {
    return null;
  }
}

function safeIdentifier(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) ? value : null;
}

function safeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildPortableRemoteWorkerScopeReadback(input: {
  controlPlaneCompanyIds?: string[];
  remoteWorkers: Array<{ remoteCompanyId: string | null; remoteOrigin: string | null; workerId: string | null }>;
  unavailable?: boolean;
}): PortableRemoteWorkerScopeReadback {
  const controlPlaneCompanyIds = [...new Set((input.controlPlaneCompanyIds ?? []).filter((value): value is string => Boolean(safeIdentifier(value))))].sort();
  const remoteWorkerCompanyIds = [...new Set(input.remoteWorkers.map((worker) => worker.remoteCompanyId).filter((value): value is string => Boolean(value)))].sort();
  const remoteOrigins = [...new Set(input.remoteWorkers.map((worker) => worker.remoteOrigin).filter((value): value is string => Boolean(value)))].sort();
  const workerIds = [...new Set(input.remoteWorkers.map((worker) => worker.workerId).filter((value): value is string => Boolean(value)))].sort();
  const alignmentCandidates = [
    {
      scope: "control_plane_queue" as const,
      status: controlPlaneCompanyIds.length > 0 ? "observed" as const : "not_observed" as const,
      companyIds: controlPlaneCompanyIds,
      origins: [],
      workerIds: []
    },
    {
      scope: "portable_remote_worker" as const,
      status: input.unavailable || (input.remoteWorkers.length > 0 && remoteWorkerCompanyIds.length === 0)
        ? "unreadable" as const
        : input.remoteWorkers.length > 0
          ? "observed" as const
          : "not_observed" as const,
      companyIds: remoteWorkerCompanyIds,
      origins: remoteOrigins,
      workerIds
    }
  ];
  const withCandidates = (value: Omit<PortableRemoteWorkerScopeReadback, "alignmentCandidates" | "alignmentDecisionRequired">) => ({
    ...value,
    alignmentCandidates,
    alignmentDecisionRequired: value.status === "mismatch"
  });
  if (input.unavailable) {
    return withCandidates({
      status: "unavailable",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      exactBlocker: "portable_worker_company_scope_unreadable",
      nextAction: "同一ホストのworker process readbackを取得し、control planeとworkerの会社scopeを照合してください。"
    });
  }
  if (input.remoteWorkers.length === 0) {
    return withCandidates({
      status: "absent",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      exactBlocker: null,
      nextAction: "remote workerが起動した後に、heartbeat・claim・同一Run receiptを確認してください。"
    });
  }
  if (remoteWorkerCompanyIds.length === 0) {
    return withCandidates({
      status: "unknown",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      exactBlocker: "portable_worker_company_scope_unreadable",
      nextAction: "workerの会社scopeをreadbackできるLaunchAgent/process環境を確認してください。"
    });
  }
  if (controlPlaneCompanyIds.length === 0) {
    return withCandidates({
      status: "unknown",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      exactBlocker: null,
      nextAction: "対象companyを選択して、control planeとworkerの会社scopeを比較してください。"
    });
  }
  const mismatch = remoteWorkerCompanyIds.some((companyId) => !controlPlaneCompanyIds.includes(companyId));
  return withCandidates({
    status: mismatch ? "mismatch" : "matched",
    controlPlaneCompanyIds,
    remoteWorkerCompanyIds,
    remoteOrigins,
    workerIds,
    exactBlocker: mismatch ? "portable_worker_company_scope_mismatch" : null,
    nextAction: mismatch
      ? "control planeのqueue scopeとMac workerのremote company scopeが異なります。同じAOS company/endpointへ揃えてからclaimしてください。"
      : "同じcompany scopeを確認済みです。claim・同一Run receipt・source syncを個別に確認してください。"
  });
}
