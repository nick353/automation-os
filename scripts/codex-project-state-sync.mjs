#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  buildLedger,
  executePreparedHandoff,
  ledgerPaths,
  loadPolicy,
  prepareHandoffPackets,
  reconcilePendingHandoffs,
  recordHooklessTurnObservations,
  writeLedger,
  writeStatus,
} from "./lib/codex-project-state.mjs";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") { args.dryRun = true; continue; }
    if (value === "--policy") {
      args.policy = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--current-thread-id") {
      args.currentThreadId = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`codex_project_state_argument_invalid:${value}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const policyPath = path.resolve(args.policy || path.join(thisDir, "..", "data", "codex-project-state-policy.json"));
  const policy = loadPolicy(policyPath);
  const paths = ledgerPaths(policy);
  const release = acquireLock(paths.lock);
  const startedAt = new Date().toISOString();
  try {
    const currentThreadId = args.currentThreadId || process.env.CODEX_SESSION_ID || "";
    const pendingReconciliation = args.dryRun
      ? { attempted: 0, completed: 0, receipts: [] }
      : await reconcilePendingHandoffs(policy);
    let ledger = buildLedger(policy, { currentThreadId });
    const prepared = args.dryRun
      ? {
          candidate_pool: ledger.counts.handoff_eligible,
          attempted: ledger.counts.handoff_eligible,
          prepared: 0,
          execution_eligible: 0,
          skipped_execution_ineligible: 0,
          packets: [],
        }
      : await prepareHandoffPackets(policy, ledger);
    const newHandoffReceipts = [];
    if (!args.dryRun && policy.handoff.automatic_thread_creation && pendingReconciliation.attempted === 0) {
      for (const packet of prepared.packets.filter((item) => item.execution_eligible)) {
        newHandoffReceipts.push(await executePreparedHandoff(policy, packet.packet_path));
      }
    }
    const handoffReceipts = [...pendingReconciliation.receipts, ...newHandoffReceipts];
    if (handoffReceipts.length > 0) {
      ledger = buildLedger(policy, { currentThreadId, previousLedger: ledger });
    }
    let observer = {
      enabled: policy.hookless_observer.enabled,
      bootstrapped: false,
      observed: 0,
      outcome_receipts_created: 0,
      outcome_receipts_existing: 0,
      events_path: null,
      outcomes_dir: policy.hookless_observer.outcomes_dir,
    };
    if (!args.dryRun) {
      try {
        observer = recordHooklessTurnObservations(policy, ledger);
      } catch (error) {
        observer = {
          enabled: policy.hookless_observer.enabled,
          bootstrapped: false,
          observed: 0,
          outcome_receipts_created: 0,
          outcome_receipts_existing: 0,
          events_path: policy.hookless_observer.events_path,
          outcomes_dir: policy.hookless_observer.outcomes_dir,
          exact_blocker: String(error?.message || error).slice(0, 500),
        };
      }
    }
    const ledgerPath = args.dryRun ? null : writeLedger(policy, ledger);
    const statusPath = writeStatus(policy, {
      status: args.dryRun ? "dry_run_completed" : "completed",
      started_at: startedAt,
      ledger_path: ledgerPath,
      ledger_content_sha256: ledger.content_sha256,
      hooks_used: false,
      thread_activation_used: false,
      thread_creation_used: newHandoffReceipts.length > 0,
      source_tasks_archived: 0,
      counts: ledger.counts,
      handoff: {
        mode: policy.handoff.mode,
        automatic_thread_creation: policy.handoff.automatic_thread_creation,
        candidates: prepared.attempted,
        candidate_pool: prepared.candidate_pool,
        prepared: prepared.prepared,
        execution_eligible: prepared.execution_eligible,
        skipped_execution_ineligible: prepared.skipped_execution_ineligible,
        executed: handoffReceipts.length,
        completed: handoffReceipts.filter((item) => item.status === "completed").length,
        reconciliation_attempted: pendingReconciliation.attempted,
        reconciliation_completed: pendingReconciliation.completed,
      },
      hookless_observer: observer,
    });
    return {
      ok: true,
      schema: "codex_project_state_sync_result.v1",
      ledger_path: ledgerPath,
      status_path: statusPath,
      content_sha256: ledger.content_sha256,
      counts: ledger.counts,
      dry_run: args.dryRun,
      source_tasks_archived: 0,
      handoff: {
        mode: policy.handoff.mode,
        automatic_thread_creation: policy.handoff.automatic_thread_creation,
        candidates: prepared.attempted,
        candidate_pool: prepared.candidate_pool,
        prepared: prepared.prepared,
        execution_eligible: prepared.execution_eligible,
        skipped_execution_ineligible: prepared.skipped_execution_ineligible,
        executed: handoffReceipts.length,
        completed: handoffReceipts.filter((item) => item.status === "completed").length,
        reconciliation_attempted: pendingReconciliation.attempted,
        reconciliation_completed: pendingReconciliation.completed,
      },
      hookless_observer: observer,
      hooks_used: false,
      thread_activation_used: false,
      thread_creation_used: newHandoffReceipts.length > 0,
    };
  } catch (error) {
    writeStatus(policy, {
      status: "blocked",
      started_at: startedAt,
      exact_blocker: String(error?.message || error).slice(0, 500),
      hooks_used: false,
      thread_activation_used: false,
      thread_creation_used: false,
      source_tasks_archived: 0,
    });
    throw error;
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "codex_project_state_sync_result.v1",
      exact_blocker: String(error?.message || error).slice(0, 500),
      hooks_used: false,
      thread_activation_used: false,
      thread_creation_used: false,
      source_tasks_archived: 0,
    })}\n`);
    process.exitCode = 1;
  }
}
