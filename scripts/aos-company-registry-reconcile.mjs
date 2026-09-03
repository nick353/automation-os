#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileCompanyRegistry } from "../apps/server/dist/companies/registryReconciliation.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = resolve(process.env.AUTOMATION_OS_DB?.trim() || join(repositoryRoot, "data", "automation-os.sqlite"));
const databaseUri = `file://${databasePath}?immutable=1`;

if (!existsSync(databasePath)) {
  process.stderr.write("company_registry_reconciliation_db_missing\n");
  process.exitCode = 1;
} else {
  const companies = readRows("SELECT id AS company_id FROM companies ORDER BY id;");
  const automations = readRows("SELECT id AS record_id, company_id, name, worker_command_kind, status FROM mvp_automations ORDER BY id;");
  const schedules = readRows("SELECT id AS record_id, company_id, automation_id, kind AS status FROM mvp_automation_schedules ORDER BY id;");
  const workflows = readRows("SELECT id AS record_id, company_id, runner_kind, status FROM registered_workflows ORDER BY id;");
  const accountRefs = readRows("SELECT id AS record_id, company_id, platform AS provider, account_ref, status FROM company_connection_account_refs ORDER BY id;");

  const globalCatalog = workflows
    .filter((row) => row.company_id === null)
    .map((row) => ({
      workflow_id: row.record_id,
      runner_kind: row.runner_kind,
      status: row.status,
      scope: "global_catalog"
    }));
  const records = [
    ...automations.map((row) => ({
      recordId: `mvp_automation:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `mvp_automation:${row.record_id}`,
    safeFields: { automation_id: row.record_id, name: row.name, runner_kind: row.worker_command_kind, status: row.status }
    })),
    ...schedules.map((row) => ({
      recordId: `mvp_schedule:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `mvp_schedule:${row.record_id}`,
      safeFields: { automation_id: row.automation_id, schedule_id: row.record_id, status: row.status }
    })),
    ...workflows.filter((row) => row.company_id !== null).map((row) => ({
      recordId: `registered_workflow:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `registered_workflow:${row.record_id}`,
      safeFields: { runner_kind: row.runner_kind, status: row.status }
    })),
    ...accountRefs.map((row) => ({
      recordId: `account_ref:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `account_ref:${row.record_id}`,
      safeFields: { account_ref: row.account_ref, provider: row.provider, status: row.status }
    }))
  ];

  const report = reconcileCompanyRegistry({
    records,
    knownCompanies: companies.map((row) => ({ companyId: row.company_id })),
    fingerprintKey: randomBytes(32).toString("hex")
  });
  process.stdout.write(`${JSON.stringify({ ...report, global_catalog: globalCatalog })}\n`);
}

function readRows(sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", databaseUri, sql], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write("company_registry_reconciliation_read_failed\n");
    process.exit(1);
  }
  try {
    const rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    if (!Array.isArray(rows)) throw new Error("not_array");
    return rows;
  } catch {
    process.stderr.write("company_registry_reconciliation_snapshot_invalid\n");
    process.exit(1);
  }
}
