import { nowIso } from "../db/client.js";
import {
  runDurableAutomationSchedulerOnce,
  type DurableAutomationSchedulerOnceResult,
  type DurableSchedulerInput
} from "./durableAutomationScheduler.js";

export const NATURAL_SCHEDULER_SOAK_SCHEMA = "aos.natural_scheduler_soak.v1" as const;

export type NaturalSchedulerTickRunner = (
  input: DurableSchedulerInput
) => Promise<DurableAutomationSchedulerOnceResult>;

export type NaturalSchedulerSoakResult = {
  schema: typeof NATURAL_SCHEDULER_SOAK_SCHEMA;
  status: "completed" | "blocked";
  companyId: string;
  startedAt: string;
  completedAt: string;
  requestedCycles: number;
  completedCycles: number;
  intervalMs: number;
  ticks: Array<{
    cycle: number;
    checkedAt: string;
    status: DurableAutomationSchedulerOnceResult["status"];
    runIds: string[];
    exactBlocker: string | null;
    serviceUserSource: DurableAutomationSchedulerOnceResult["serviceUserSource"];
  }>;
  runIds: string[];
  duplicateRunIds: string[];
  exactBlocker: string | null;
  externalActionExecuted: false;
  nextAction: string;
};

/** Execute a bounded sequence of real AOS scheduler ticks. */
export async function runNaturalSchedulerSoak(input: {
  companyId: string;
  cycles?: number;
  intervalMs?: number;
  runTick?: NaturalSchedulerTickRunner;
}): Promise<NaturalSchedulerSoakResult> {
  const companyId = requiredCompanyId(input.companyId);
  const requestedCycles = boundedInteger(input.cycles ?? 3, 1, 5, "natural_scheduler_soak_cycles_invalid");
  const intervalMs = boundedInteger(input.intervalMs ?? 1_000, 0, 10_000, "natural_scheduler_soak_interval_invalid");
  const runTick = input.runTick ?? runDurableAutomationSchedulerOnce;
  const startedAt = nowIso();
  const ticks: NaturalSchedulerSoakResult["ticks"] = [];
  const runIds: string[] = [];
  let exactBlocker: string | null = null;

  for (let cycle = 1; cycle <= requestedCycles; cycle += 1) {
    const result = await runTick({ companyId, now: nowIso() });
    ticks.push({
      cycle,
      checkedAt: result.checkedAt,
      status: result.status,
      runIds: [...result.portableRunIds, ...result.occurrences.flatMap((occurrence) => occurrence.jobId ? [occurrence.jobId] : [])],
      exactBlocker: result.exactBlocker,
      serviceUserSource: result.serviceUserSource
    });
    runIds.push(...result.portableRunIds, ...result.occurrences.flatMap((occurrence) => occurrence.jobId ? [occurrence.jobId] : []));
    if (result.exactBlocker) {
      exactBlocker = result.exactBlocker;
      break;
    }
    if (cycle < requestedCycles && intervalMs > 0) await delay(intervalMs);
  }

  const seen = new Set<string>();
  const duplicateRunIds: string[] = [];
  for (const runId of runIds) {
    if (seen.has(runId) && !duplicateRunIds.includes(runId)) duplicateRunIds.push(runId);
    seen.add(runId);
  }
  const completedAt = nowIso();
  return {
    schema: NATURAL_SCHEDULER_SOAK_SCHEMA,
    status: exactBlocker || duplicateRunIds.length > 0 ? "blocked" : "completed",
    companyId,
    startedAt,
    completedAt,
    requestedCycles,
    completedCycles: ticks.length,
    intervalMs,
    ticks,
    runIds: [...new Set(runIds)],
    duplicateRunIds,
    exactBlocker: exactBlocker ?? (duplicateRunIds.length > 0 ? "natural_scheduler_duplicate_run_detected" : null),
    externalActionExecuted: false,
    nextAction: exactBlocker || duplicateRunIds.length > 0
      ? "同じtickを再送せず、表示されたexact blockerまたは重複原因を修正してから新しいsoakを実行してください。"
      : "自然tickと短期soakが完了しました。worker/providerはこのdurable queueをclaimし、同一Runのreceiptを保存します。"
  };
}

function requiredCompanyId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error("natural_scheduler_company_id_invalid");
  return normalized;
}

function boundedInteger(value: number, min: number, max: number, blocker: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(blocker);
  return value;
}

async function delay(intervalMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
}
