#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const databasePath = resolve(process.env.AUTOMATION_OS_DB || join(repositoryRoot, "data", "automation-os.sqlite"));
const contractSchema = "company_binding_readiness.v1";

if (!existsSync(databasePath)) {
  emitBlocked("aos_sqlite_missing");
}

try {
  const {
    buildCompanyBindingReadinessV1,
    DEFAULT_CODEX_TRIGGER_COMPANY_ID
  } = await import(
    pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "runs", "companyBindingReadiness.js")).href
  );
  const { buildCompanyBindingReconciliationV1 } = await import(
    pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "runs", "companyBindingReconciliation.js")).href
  );
  const { buildCanonicalCompanyConsultationV1 } = await import(
    pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "runs", "canonicalCompanyConsultation.js")).href
  );
  const { readRegisteredAutomationSources } = await import(
    pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "runs", "registeredAutomationSourceReadback.js")).href
  );
  const before = fileFingerprint(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");

  const localCompanies = db.prepare(`
    SELECT company_id, COUNT(*) AS automation_count
    FROM mvp_automations
    WHERE trim(company_id)!=''
    GROUP BY company_id
    ORDER BY company_id
  `).all().map((row) => ({
    company_id: String(row.company_id),
    automation_count: Number(row.automation_count),
    provenance: "local_diagnostic_sql_readonly_readback"
  }));
  const schedules = db.prepare(`
    SELECT schedule.id, schedule.company_id, schedule.automation_id, automation.name AS automation_name,
           schedule.kind, schedule.expression, schedule.timezone, schedule.enabled, schedule.status,
           schedule.revision, schedule.next_run_at, schedule.last_run_at
    FROM mvp_automation_schedules schedule
    JOIN mvp_automations automation
      ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
    ORDER BY schedule.company_id, schedule.id
  `).all().map((row) => ({
    id: String(row.id),
    company_id: String(row.company_id),
    automation_id: String(row.automation_id),
    automation_name: row.automation_name == null ? null : String(row.automation_name),
    kind: String(row.kind),
    expression: row.expression == null ? null : String(row.expression),
    timezone: String(row.timezone),
    enabled: row.enabled === 1,
    status: String(row.status),
    revision: Number(row.revision),
    next_run_at: row.next_run_at == null ? null : String(row.next_run_at),
    last_run_at: row.last_run_at == null ? null : String(row.last_run_at),
    catch_up_policy: null
  }));
  const accountRefs = db.prepare(`
    SELECT id, company_id, platform, status, verification_status
    FROM company_connection_account_refs
    ORDER BY company_id, id
  `).all().map((row) => ({
    id: String(row.id),
    company_id: String(row.company_id),
    platform: String(row.platform),
    status: String(row.status),
    verification_status: String(row.verification_status)
  }));

  const serviceUserId = String(process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID || "").trim();
  const serviceIdentityConfigured = serviceUserId.length > 0 && Boolean(
    db.prepare(`
      SELECT users.id
      FROM users
      JOIN company_memberships ON company_memberships.user_id=users.id
      WHERE users.id=? AND users.kind='service' AND users.status='active'
        AND company_memberships.role='operator' AND company_memberships.status='active'
      LIMIT 1
    `).get(serviceUserId)
  );
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? null;
  const counts = Object.fromEntries([
    ["companies", countRows(db, "companies")],
    ["mvp_automations", countRows(db, "mvp_automations")],
    ["mvp_automation_schedules", countRows(db, "mvp_automation_schedules")],
    ["runs", countRows(db, "runs")],
    ["proofs", countRows(db, "proofs")],
    ["durable_jobs", countRows(db, "durable_jobs")],
    ["durable_schedule_occurrences", countRows(db, "durable_schedule_occurrences")],
    ["worker_events", countRows(db, "worker_events")],
    ["task_effect_ledger", countRows(db, "task_effect_ledger")]
  ]);
  db.close();
  const after = fileFingerprint(databasePath);
  const triggerCompanyId = String(
    process.env.AOS_TRIGGER_PARITY_COMPANY_ID || DEFAULT_CODEX_TRIGGER_COMPANY_ID
  ).trim();
  const graphReceiptStatus = ["none", "fresh", "stale_or_tampered"].includes(process.env.AOS_GRAPH_RECEIPT_STATUS || "")
    ? process.env.AOS_GRAPH_RECEIPT_STATUS
    : "stale_or_tampered";
  const readiness = buildCompanyBindingReadinessV1({
    now: process.env.AOS_COMPANY_BINDING_READINESS_NOW || new Date().toISOString(),
    trigger_company_id: triggerCompanyId,
    trigger_provenance: "codex_app_registered_automation_toml_readonly_readback",
    local_companies: localCompanies,
    schedules,
    account_refs: accountRefs,
    service_identity: {
      configured: serviceIdentityConfigured,
      source: serviceUserId
        ? "environment_plus_active_operator_membership_readonly_readback"
        : "missing_environment_service_identity"
    },
    canonical_company_id: null,
    canonical_authority_fresh: false,
    source_company_id: localCompanies.length === 1 ? localCompanies[0].company_id : null,
    source_authority_fresh: localCompanies.length === 1,
    worker_company_id: null,
    worker_authority_fresh: false,
    runtime_company_id: null,
    runtime_authority_fresh: false,
    provider_authority_fresh: false,
    browser_authority_fresh: false,
    provider_receipt_contract_ready: false,
    source_sync_contract_ready: false,
    reconciliation_contract_ready: false,
    cleanup_contract_ready: false,
    brief_home_readback_available: true,
    brief_delivery_configured: false,
    chat_consultation_available: true,
    chat_read_only_demo_available: true,
    chat_approval_preview_available: true,
    chat_registration_ready: false,
    graph_receipt_status: graphReceiptStatus,
    database: {
      backend: "sqlite",
      path: databasePath,
      before,
      after,
      integrity,
      counts,
      stable: before.file_id === after.file_id && before.sha256 === after.sha256
    }
  });
  const registeredSourceReadback = readRegisteredAutomationSources({
    root: resolve(process.env.CODEX_AUTOMATIONS_ROOT || join(homedir(), ".codex", "automations"))
  });
  const referenceObservations = Object.fromEntries(localCompanies.map((company) => {
    const companyAccounts = accountRefs.filter((account) => account.company_id === company.company_id);
    return [company.company_id, {
      service_identity_configured: serviceIdentityConfigured,
      service_identity_source: serviceUserId
        ? "environment_plus_active_operator_membership_readonly_readback"
        : "missing_environment_service_identity",
      account_ref_count: companyAccounts.length,
      verified_account_ref_count: companyAccounts.filter((account) => account.status === "active" && account.verification_status === "verified").length,
      account_platforms: companyAccounts.map((account) => account.platform),
      provider_authority_fresh: false,
      browser_authority_fresh: false,
      brief_home_readback_available: true,
      brief_delivery_configured: false,
      chat_consultation_available: true,
      chat_read_only_demo_available: true,
      chat_approval_preview_available: true,
      chat_registration_ready: false
    }];
  }));
  const reconciliation = buildCompanyBindingReconciliationV1({
    now: process.env.AOS_COMPANY_BINDING_READINESS_NOW || new Date().toISOString(),
    requested_company_id: process.env.AOS_COMPANY_BINDING_RECONCILIATION_COMPANY_ID || null,
    trigger_company_id: triggerCompanyId,
    trigger_provenance: "codex_app_registered_automation_toml_readonly_readback",
    trigger_sources: registeredSourceReadback.entries,
    local_companies: localCompanies.map((company) => ({
      ...company,
      name: null,
      status: null,
      automation_ids: schedules.filter((schedule) => schedule.company_id === company.company_id).map((schedule) => schedule.automation_id),
      schedule_ids: schedules.filter((schedule) => schedule.company_id === company.company_id).map((schedule) => schedule.id)
    })),
    reference_observations: referenceObservations
  });
  const companyId = String(
    process.env.AOS_COMPANY_BINDING_RECONCILIATION_COMPANY_ID || reconciliation.requested_company_id || "all"
  ).trim() || "all";
  const consultation = buildCanonicalCompanyConsultationV1({
    reconciliation,
    snapshot: {
      snapshot_id: `company-binding-reconciliation:${companyId}:${reconciliation.generated_at}`,
      captured_at: reconciliation.generated_at,
      provenance: "aos_cli_company_binding_reconciliation_readonly_readback",
      fresh: true
    }
  });
  const result = {
    ...readiness,
    company_binding_reconciliation: reconciliation,
    canonical_company_consultation: consultation,
    contract_version: contractSchema,
    readback_kind: "local_sqlite_readonly_diagnostic",
    trigger_scope: {
      company_id: triggerCompanyId || null,
      provenance: "codex_app_registered_automation_toml_readonly_readback",
      registered_automations: readRegisteredAutomations()
    },
    source_scope: {
      kind: "local_sqlite_diagnostic",
      canonical_selection: "not_selected",
      protected_aos_endpoint_read: false
    },
    external_effects: {
      provider_called: false,
      browser_started: false,
      notification_sent: false,
      external_action_executed: false,
      secrets_read: false,
      graph_receipt_replayed: false
    }
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.production_ready ? 0 : 2;
} catch (error) {
  emitBlocked(errorCode(error));
}

function countRows(db, table) {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
  } catch {
    return null;
  }
}

function fileFingerprint(path) {
  const stat = statSync(path);
  return {
    file_id: `${stat.dev}:${stat.ino}`,
    size_bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
  };
}

function readRegisteredAutomations() {
  const root = resolve(process.env.CODEX_AUTOMATIONS_ROOT || join(homedir(), ".codex", "automations"));
  if (!existsSync(root)) return { root, count: 0, entries: [] };
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, path: join(root, entry.name, "automation.toml") }))
    .filter((entry) => existsSync(entry.path))
    .map((entry) => {
      const source = readFileSync(entry.path, "utf8");
      return {
        id: field(source, "id") || entry.id,
        status: field(source, "status"),
        rrule: field(source, "rrule"),
        company_id: source.match(/--company\s+([A-Za-z0-9_:-]+)/u)?.[1] ?? null,
        automation_id: source.match(/--automation\s+([A-Za-z0-9_:-]+)/u)?.[1] ?? null,
        path: entry.path
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { root, count: entries.length, entries };
}

function field(source, name) {
  return source.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "mu"))?.[1] ?? null;
}

function errorCode(error) {
  return String(error?.message || "aos_company_binding_readiness_readback_failed")
    .replace(/[^a-z0-9_:-]/giu, "_")
    .slice(0, 160);
}

function emitBlocked(exactBlocker) {
  process.stdout.write(`${JSON.stringify({
    schema: contractSchema,
    status: "blocked",
    production_ready: false,
    exact_blocker: exactBlocker,
    external_action_executed: false,
    secrets_read: false,
    next_action: "Repair or authorize the exact listed company-binding blocker, then rerun this read-only readiness check."
  }, null, 2)}\n`);
  process.exit(2);
}
