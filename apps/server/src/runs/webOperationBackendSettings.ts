import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSqlAsync, initDb, nowIso, querySql, querySqlAsync, runSqlTransaction, runSqlTransactionAsync, upsert, sqlValue, type SqlValue } from "../db/client.js";
import { webOperationBackendAdapterCoverage, type WebOperationAdapter } from "./webOperationBackendAdapters.js";

export const WEB_OPERATION_BACKEND_SETTINGS_SCHEMA = "aos_web_operation_backend_setting.v1";
export const WEB_OPERATION_BACKEND_SNAPSHOT_SCHEMA = "aos_web_operation_backend_snapshot.v1";
export const WEB_OPERATION_BACKEND_CONFIG_SCHEMA = "web_operation_backend_config.v1";
export const WEB_OPERATION_ROUTE_DECISION_SCHEMA = "browser_route_decision.v2";
export const DEFAULT_WEB_OPERATION_BACKEND = "chrome_plugin" as const;
export const DEFAULT_CHROME_PROFILE = {
  id: "profile2",
  name: "Profile 2",
  directory: "Profile 2",
  surface: "signed_chrome_extension_profile2"
} as const;
/**
 * Profile 2 is the fixed browser-authentication source for the Chrome Plugin
 * lane. This is an internal auth binding, not a provider token or a manually
 * configured company connection reference.
 */
export const CHROME_PLUGIN_PROFILE2_AUTH_REF = "auth:chrome-profile2" as const;
export const WEB_OPERATION_BACKENDS = ["chrome_plugin", "browser_use_cli", "playwright", "aos_chrome_companion"] as const;
export type WebOperationBackend = (typeof WEB_OPERATION_BACKENDS)[number];
export type WebOperationBrowserSurface = "signed_chrome_extension_profile2" | "aos_chrome_companion_profile_instance" | "browser_use_cli" | "playwright";

export const AOS_CHROME_COMPANION_BROWSER_SURFACE = "aos_chrome_companion_profile_instance" as const;

/** Explicit Companion surface metadata. It is opt-in and never changes the
 * current/default official Chrome selector. */
export function browserSurfaceForAosChromeCompanion(): WebOperationBrowserSurface {
  return AOS_CHROME_COMPANION_BROWSER_SURFACE;
}

export type WebOperationBackendSetting = {
  schema: typeof WEB_OPERATION_BACKEND_SETTINGS_SCHEMA;
  id: "global";
  backend: WebOperationBackend;
  revision: number;
  chrome_profile: typeof DEFAULT_CHROME_PROFILE;
  source: "aos_global_setting";
  updated_at: string;
  updated_by: string | null;
  exact_blocker: string | null;
};

export type WebOperationBackendSnapshot = {
  schema: typeof WEB_OPERATION_BACKEND_SNAPSHOT_SCHEMA;
  requested_backend: WebOperationBackend;
  resolved_backend: WebOperationBackend;
  revision: number;
  source: "aos_global_setting";
  fallback_allowed: false;
  chrome_profile: typeof DEFAULT_CHROME_PROFILE;
  browser_surface: string;
  exact_blocker: string | null;
  routing_mode?: "configured_exact" | "companion_first_auto" | "adaptive_two_extension";
  route_decision_schema?: typeof WEB_OPERATION_ROUTE_DECISION_SCHEMA;
  preferred_backend?: WebOperationBackend;
  configured_backend?: WebOperationBackend;
  route_reason?: WebOperationBackendRouteReason;
  route_adapter?: WebOperationAdapter | null;
  route_operation_class?: WebOperationOperationClass;
  route_admission_status?: "ready" | "blocked";
  route_decision_scope?: "browser_stage";
  route_frozen_after_dispatch?: true;
  reroute_after_terminal_no_effect_only?: true;
  extension_requirement?: WebOperationExtensionRequirement;
  continuity_backend?: WebOperationBackend | null;
  official_extension_required?: boolean;
};

export type WebOperationOperationClass = "normal" | "read_only" | "effect";
export type WebOperationExtensionRequirement = "automatic" | "official_extension" | "companion_extension" | "browser_use_cli";

export type WebOperationBackendRouteReason =
  | "explicit_non_chrome_backend"
  | "official_extension_explicitly_required"
  | "companion_extension_explicitly_required"
  | "active_run_continuity_preserved"
  | "active_run_continuity_conflict"
  | "companion_primary_for_normal_work"
  | "companion_effect_adapter_available"
  | "official_effect_adapter_compatibility"
  | "no_effectful_two_extension_adapter";

export type WebOperationBackendRouteDecision = {
  schema: typeof WEB_OPERATION_ROUTE_DECISION_SCHEMA;
  routing_mode: "adaptive_two_extension";
  preferred_backend: WebOperationBackend;
  configured_backend: WebOperationBackend;
  selected_backend: WebOperationBackend;
  route_reason: WebOperationBackendRouteReason;
  adapter: WebOperationAdapter | null;
  operation_class: WebOperationOperationClass;
  admission_status: "ready" | "blocked";
  exact_blocker: string | null;
  decision_scope: "browser_stage";
  frozen_after_dispatch: true;
  reroute_after_terminal_no_effect_only: true;
  extension_requirement: WebOperationExtensionRequirement;
  continuity_backend: WebOperationBackend | null;
  official_extension_required: boolean;
};

type SettingRow = {
  id?: string;
  backend?: string;
  revision?: number | string;
  chrome_profile_id?: string;
  chrome_profile_name?: string;
  chrome_profile_directory?: string;
  chrome_surface?: string;
  updated_at?: string;
  updated_by?: string | null;
};

function canonicalBackend(value: unknown): WebOperationBackend {
  const candidate = String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
  if ((WEB_OPERATION_BACKENDS as readonly string[]).includes(candidate)) return candidate as WebOperationBackend;
  throw new Error(`web_operation_backend_unknown:${candidate || "empty"}`);
}

export function resolveWebOperationBackend(value: unknown, environment: NodeJS.ProcessEnv = process.env): WebOperationBackend {
  return canonicalBackend(value || environment.AOS_WEB_OPERATION_BACKEND || DEFAULT_WEB_OPERATION_BACKEND);
}

/**
 * Resolve the concrete browser surface from the immutable per-run backend
 * snapshot. Keeping this mapping in one place prevents admission, action-plan,
 * intent, and receipt artifacts from silently describing different runners.
 */
export function browserSurfaceForWebOperationBackend(
  backend: WebOperationBackend,
  chromeProfileSurface: string = DEFAULT_CHROME_PROFILE.surface,
): WebOperationBrowserSurface {
  if (backend === "chrome_plugin") {
    if (chromeProfileSurface !== DEFAULT_CHROME_PROFILE.surface) {
      throw new Error("web_operation_chrome_profile_surface_invalid");
    }
    return DEFAULT_CHROME_PROFILE.surface;
  }
  if (backend === "aos_chrome_companion") return AOS_CHROME_COMPANION_BROWSER_SURFACE;
  return backend;
}

function adapterMode(
  adapter: WebOperationAdapter,
  backend: "chrome_plugin" | "aos_chrome_companion",
): "effectful" | "entrypoint_only" | "not_bound" {
  const coverage = webOperationBackendAdapterCoverage().find((item) => item.adapter === adapter);
  if (!coverage) return "not_bound";
  return backend === "chrome_plugin" ? coverage.chrome_plugin_mode : coverage.aos_chrome_companion_mode;
}

/**
 * Decide between the two installed Chrome extensions before an attempt starts.
 * The selected backend is frozen for that attempt. A separate signed state
 * machine may start one official-Extension attempt only after a terminal
 * Companion no-effect receipt and cleanup; it never rewrites this snapshot.
 */
export function routeCompanionFirstWebOperationBackend(input: {
  configuredBackend: WebOperationBackend;
  adapter?: WebOperationAdapter | null;
  operationClass?: WebOperationOperationClass;
  extensionRequirement?: WebOperationExtensionRequirement;
  continuityBackend?: WebOperationBackend | null;
  preserveActiveRunContinuity?: boolean;
  requiresOfficialExtension?: boolean;
}): WebOperationBackendRouteDecision {
  const configuredBackend = input.configuredBackend;
  const adapter = input.adapter ?? null;
  const operationClass = input.operationClass ?? "normal";
  const extensionRequirement = input.extensionRequirement
    ?? (input.requiresOfficialExtension === true ? "official_extension" : "automatic");
  const officialExtensionRequired = extensionRequirement === "official_extension";
  const continuityBackend = input.continuityBackend ?? null;
  const preserveActiveRunContinuity = input.preserveActiveRunContinuity === true && continuityBackend !== null;
  const decision = (
    selectedBackend: WebOperationBackend,
    routeReason: WebOperationBackendRouteReason,
    admissionStatus: "ready" | "blocked" = "ready",
    exactBlocker: string | null = null,
  ): WebOperationBackendRouteDecision => ({
    schema: WEB_OPERATION_ROUTE_DECISION_SCHEMA,
    routing_mode: "adaptive_two_extension",
    preferred_backend: configuredBackend,
    configured_backend: configuredBackend,
    selected_backend: selectedBackend,
    route_reason: routeReason,
    adapter,
    operation_class: operationClass,
    admission_status: admissionStatus,
    exact_blocker: exactBlocker,
    decision_scope: "browser_stage",
    frozen_after_dispatch: true,
    reroute_after_terminal_no_effect_only: true,
    extension_requirement: extensionRequirement,
    continuity_backend: continuityBackend,
    official_extension_required: officialExtensionRequired,
  });
  const effectAdapterBlocker = (backend: "chrome_plugin" | "aos_chrome_companion") => {
    if (operationClass !== "effect" || !adapter || adapterMode(adapter, backend) === "effectful") return null;
    return `web_operation_${backend}_effect_adapter_unavailable:${adapter}`;
  };

  if (preserveActiveRunContinuity) {
    const requirementBackend = extensionRequirement === "official_extension"
      ? "chrome_plugin"
      : extensionRequirement === "companion_extension"
        ? "aos_chrome_companion"
        : extensionRequirement === "browser_use_cli"
          ? "browser_use_cli"
        : null;
    if (requirementBackend && continuityBackend !== requirementBackend) {
      return decision(
        continuityBackend,
        "active_run_continuity_conflict",
        "blocked",
        `web_operation_active_run_continuity_conflict:${continuityBackend}:${requirementBackend}`,
      );
    }
    if (continuityBackend === "chrome_plugin" || continuityBackend === "aos_chrome_companion") {
      const blocker = effectAdapterBlocker(continuityBackend);
      return decision(
        continuityBackend,
        "active_run_continuity_preserved",
        blocker ? "blocked" : "ready",
        blocker,
      );
    }
    return decision(continuityBackend, "active_run_continuity_preserved");
  }

  if (extensionRequirement === "official_extension") {
    const blocker = effectAdapterBlocker("chrome_plugin");
    return decision(
      "chrome_plugin",
      "official_extension_explicitly_required",
      blocker ? "blocked" : "ready",
      blocker,
    );
  }
  if (extensionRequirement === "companion_extension") {
    const blocker = effectAdapterBlocker("aos_chrome_companion");
    return decision(
      "aos_chrome_companion",
      "companion_extension_explicitly_required",
      blocker ? "blocked" : "ready",
      blocker,
    );
  }
  if (extensionRequirement === "browser_use_cli") {
    return decision("browser_use_cli", "explicit_non_chrome_backend");
  }

  if (configuredBackend === "browser_use_cli" || configuredBackend === "playwright") {
    return decision(configuredBackend, "explicit_non_chrome_backend");
  }
  if (operationClass !== "effect") {
    return decision("aos_chrome_companion", "companion_primary_for_normal_work");
  }
  if (adapter && adapterMode(adapter, "aos_chrome_companion") === "effectful") {
    return decision("aos_chrome_companion", "companion_effect_adapter_available");
  }
  if (adapter && adapterMode(adapter, "chrome_plugin") === "effectful") {
    return decision("chrome_plugin", "official_effect_adapter_compatibility");
  }
  return decision(
    configuredBackend === "chrome_plugin" ? "chrome_plugin" : "aos_chrome_companion",
    "no_effectful_two_extension_adapter",
    "blocked",
    `web_operation_no_effectful_two_extension_adapter:${adapter || "unknown"}`,
  );
}

export function browserAuthRefForBackendSnapshot(snapshot: WebOperationBackendSnapshot): string | null {
  const profile = snapshot.chrome_profile;
  if (snapshot.resolved_backend !== "chrome_plugin"
    || profile.id !== DEFAULT_CHROME_PROFILE.id
    || profile.name !== DEFAULT_CHROME_PROFILE.name
    || profile.directory !== DEFAULT_CHROME_PROFILE.directory
    || profile.surface !== DEFAULT_CHROME_PROFILE.surface) {
    return null;
  }
  return CHROME_PLUGIN_PROFILE2_AUTH_REF;
}

function mirrorPath(): string {
  return process.env.AOS_WEB_OPERATION_BACKEND_CONFIG?.trim()
    || process.env.AUTOMATION_OS_WEB_OPERATION_BACKEND_CONFIG?.trim()
    || join(homedir(), ".social-flow", "web-operation-backend.json");
}

function profileFromRow(row: SettingRow | undefined) {
  return {
    id: row?.chrome_profile_id?.trim() || DEFAULT_CHROME_PROFILE.id,
    name: row?.chrome_profile_name?.trim() || DEFAULT_CHROME_PROFILE.name,
    directory: row?.chrome_profile_directory?.trim() || DEFAULT_CHROME_PROFILE.directory,
    surface: row?.chrome_surface?.trim() || DEFAULT_CHROME_PROFILE.surface
  } as typeof DEFAULT_CHROME_PROFILE;
}

type MirrorRow = {
  schema?: string;
  source?: string;
  backend?: unknown;
  revision?: unknown;
  route_authority?: unknown;
  routing_mode?: unknown;
  preferred_backend?: unknown;
  backend_role?: unknown;
  browser_surface?: unknown;
  preferred_browser_surface?: unknown;
  browser_surface_role?: unknown;
  chrome_profile_surface_role?: unknown;
  routing_policy?: unknown;
  chrome_profile?: unknown;
  updated_at?: unknown;
};

export function shouldAdoptNewerBackendMirror(currentRevision: number, mirror: MirrorRow | null): boolean {
  const mirrorRevision = Number(mirror?.revision);
  return (mirror?.source === "codex_chat" || mirror?.source === "automation_os")
    && Number.isSafeInteger(mirrorRevision)
    && mirrorRevision > currentRevision;
}

function readBackendMirror(): MirrorRow | null {
  const path = mirrorPath();
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as MirrorRow;
    if (!value || value.schema !== WEB_OPERATION_BACKEND_CONFIG_SCHEMA) return null;
    const revision = Number(value.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) return null;
    canonicalBackend(value.backend);
    return value;
  } catch {
    return null;
  }
}

function profileFromMirror(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CHROME_PROFILE;
  const profile = value as Record<string, unknown>;
  return {
    id: String(profile.id || DEFAULT_CHROME_PROFILE.id),
    name: String(profile.name || DEFAULT_CHROME_PROFILE.name),
    directory: String(profile.directory || DEFAULT_CHROME_PROFILE.directory),
    surface: String(profile.surface || DEFAULT_CHROME_PROFILE.surface),
  } as typeof DEFAULT_CHROME_PROFILE;
}

async function upsertAsync(table: string, row: Record<string, SqlValue>, conflictColumn = "id"): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((column) => sqlValue(row[column]));
  const updates = columns
    .filter((column) => column !== conflictColumn)
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");
  await execSqlAsync(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")}) `
    + `ON CONFLICT(${conflictColumn}) DO UPDATE SET ${updates};`
  );
}

function toSetting(row: SettingRow | undefined): WebOperationBackendSetting {
  const backend = canonicalBackend(row?.backend || DEFAULT_WEB_OPERATION_BACKEND);
  return {
    schema: WEB_OPERATION_BACKEND_SETTINGS_SCHEMA,
    id: "global",
    backend,
    revision: Math.max(1, Number(row?.revision ?? 1) || 1),
    chrome_profile: profileFromRow(row),
    source: "aos_global_setting",
    updated_at: row?.updated_at || nowIso(),
    updated_by: row?.updated_by || null,
    exact_blocker: null
  };
}

export function readWebOperationBackendSetting(): WebOperationBackendSetting {
  initDb();
  const row = querySql<SettingRow>("SELECT * FROM web_operation_settings WHERE id='global' LIMIT 1;")[0];
  if (row) {
    const current = toSetting(row);
    const mirror = readBackendMirror();
    const mirrorRevision = Number(mirror?.revision);
    // The current selector mirror is the local Chrome/Profile 2 source of
    // truth.  Adopt a newer schema-valid mirror from either the official AOS
    // writer or the Codex chat writer, then persist it into the control-plane
    // row.  Without this, a restarted AOS process can resurrect an older DB
    // revision and make every worker advertise stale routing metadata.
    if (mirror && shouldAdoptNewerBackendMirror(current.revision, mirror)) {
      const adopted: WebOperationBackendSetting = {
        ...current,
        backend: canonicalBackend(mirror.backend),
        revision: mirrorRevision,
        chrome_profile: profileFromMirror(mirror.chrome_profile),
        updated_at: String(mirror.updated_at || nowIso()),
        updated_by: mirror.source === "codex_chat" ? "codex_chat" : "automation_os",
        exact_blocker: null,
      };
      upsert("web_operation_settings", {
        id: "global",
        backend: adopted.backend,
        revision: adopted.revision,
        chrome_profile_id: adopted.chrome_profile.id,
        chrome_profile_name: adopted.chrome_profile.name,
        chrome_profile_directory: adopted.chrome_profile.directory,
        chrome_surface: adopted.chrome_profile.surface,
        updated_at: adopted.updated_at,
        updated_by: adopted.updated_by,
      });
      writeWebOperationBackendMirror(adopted);
      return adopted;
    }
    // Repair a stale or chat-owned mirror after every AOS read.  The newer
    // selector mirror has already been adopted above; otherwise the DB row is
    // authoritative.
    if (!mirror || mirror.source !== "automation_os"
      || Number(mirror.revision) !== current.revision
      || String(mirror.backend || "") !== current.backend) {
      writeWebOperationBackendMirror(current);
    }
    return current;
  }
  const setting = toSetting(undefined);
  upsert("web_operation_settings", {
    id: "global",
    backend: setting.backend,
    revision: setting.revision,
    chrome_profile_id: setting.chrome_profile.id,
    chrome_profile_name: setting.chrome_profile.name,
    chrome_profile_directory: setting.chrome_profile.directory,
    chrome_surface: setting.chrome_profile.surface,
    updated_at: setting.updated_at,
    updated_by: null
  });
  writeWebOperationBackendMirror(setting);
  return setting;
}

/**
 * Async HTTP boundary counterpart to readWebOperationBackendSetting. The
 * synchronous helper remains for worker/CLI callers, while public settings
 * requests use the pooled PostgreSQL connection instead of spawning a child
 * process on the server event loop.
 */
export async function readWebOperationBackendSettingAsync(): Promise<WebOperationBackendSetting> {
  const row = (await querySqlAsync<SettingRow>("SELECT * FROM web_operation_settings WHERE id='global' LIMIT 1;"))[0];
  if (row) {
    const current = toSetting(row);
    const mirror = readBackendMirror();
    const mirrorRevision = Number(mirror?.revision);
    if (mirror && shouldAdoptNewerBackendMirror(current.revision, mirror)) {
      const adopted: WebOperationBackendSetting = {
        ...current,
        backend: canonicalBackend(mirror.backend),
        revision: mirrorRevision,
        chrome_profile: profileFromMirror(mirror.chrome_profile),
        updated_at: String(mirror.updated_at || nowIso()),
        updated_by: mirror.source === "codex_chat" ? "codex_chat" : "automation_os",
        exact_blocker: null,
      };
      await upsertAsync("web_operation_settings", {
        id: "global",
        backend: adopted.backend,
        revision: adopted.revision,
        chrome_profile_id: adopted.chrome_profile.id,
        chrome_profile_name: adopted.chrome_profile.name,
        chrome_profile_directory: adopted.chrome_profile.directory,
        chrome_surface: adopted.chrome_profile.surface,
        updated_at: adopted.updated_at,
        updated_by: adopted.updated_by,
      });
      writeWebOperationBackendMirror(adopted);
      return adopted;
    }
    if (!mirror || mirror.source !== "automation_os"
      || Number(mirror.revision) !== current.revision
      || String(mirror.backend || "") !== current.backend) {
      writeWebOperationBackendMirror(current);
    }
    return current;
  }
  const setting = toSetting(undefined);
  await upsertAsync("web_operation_settings", {
    id: "global",
    backend: setting.backend,
    revision: setting.revision,
    chrome_profile_id: setting.chrome_profile.id,
    chrome_profile_name: setting.chrome_profile.name,
    chrome_profile_directory: setting.chrome_profile.directory,
    chrome_surface: setting.chrome_profile.surface,
    updated_at: setting.updated_at,
    updated_by: null
  });
  writeWebOperationBackendMirror(setting);
  return setting;
}

export function writeWebOperationBackendSetting(input: {
  backend: unknown;
  actorUserId: string;
  expectedRevision?: number;
}): WebOperationBackendSetting {
  const current = readWebOperationBackendSetting();
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new Error(`web_operation_backend_revision_conflict:expected=${input.expectedRevision}:actual=${current.revision}`);
  }
  const backend = canonicalBackend(input.backend);
  const setting: WebOperationBackendSetting = {
    ...current,
    backend,
    revision: current.revision + 1,
    updated_at: nowIso(),
    updated_by: input.actorUserId,
    exact_blocker: null
  };
  try {
    runSqlTransaction([{
      sql: backendSettingUpdateSql(setting, current.revision),
      expectChanges: 1,
    }]);
  } catch (error) {
    throw normalizeBackendRevisionConflict(error, current.revision, () => readWebOperationBackendSetting().revision);
  }
  writeWebOperationBackendMirror(setting);
  return setting;
}

export async function writeWebOperationBackendSettingAsync(input: {
  backend: unknown;
  actorUserId: string;
  expectedRevision?: number;
}): Promise<WebOperationBackendSetting> {
  const current = await readWebOperationBackendSettingAsync();
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new Error(`web_operation_backend_revision_conflict:expected=${input.expectedRevision}:actual=${current.revision}`);
  }
  const backend = canonicalBackend(input.backend);
  const setting: WebOperationBackendSetting = {
    ...current,
    backend,
    revision: current.revision + 1,
    updated_at: nowIso(),
    updated_by: input.actorUserId,
    exact_blocker: null
  };
  try {
    await runSqlTransactionAsync([{
      sql: backendSettingUpdateSql(setting, current.revision),
      expectChanges: 1,
    }]);
  } catch (error) {
    if (String(error instanceof Error ? error.message : error).startsWith("sql_transaction_expected_changes:")) {
      let actualRevision = "unknown";
      try { actualRevision = String((await readWebOperationBackendSettingAsync()).revision); } catch { /* preserve the CAS blocker */ }
      throw normalizeBackendRevisionConflict(error, current.revision, () => Number(actualRevision));
    }
    throw error;
  }
  writeWebOperationBackendMirror(setting);
  return setting;
}

function backendSettingUpdateSql(setting: WebOperationBackendSetting, expectedRevision: number): string {
  return `UPDATE web_operation_settings SET backend=${sqlValue(setting.backend)}, revision=${sqlValue(setting.revision)}, `
    + `chrome_profile_id=${sqlValue(setting.chrome_profile.id)}, chrome_profile_name=${sqlValue(setting.chrome_profile.name)}, `
    + `chrome_profile_directory=${sqlValue(setting.chrome_profile.directory)}, chrome_surface=${sqlValue(setting.chrome_profile.surface)}, `
    + `updated_at=${sqlValue(setting.updated_at)}, updated_by=${sqlValue(setting.updated_by)} `
    + `WHERE id='global' AND revision=${sqlValue(expectedRevision)};`;
}

function normalizeBackendRevisionConflict(error: unknown, expectedRevision: number, readActualRevision: () => number): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith("sql_transaction_expected_changes:")) return error instanceof Error ? error : new Error(message);
  let actualRevision = "unknown";
  try {
    const value = readActualRevision();
    if (Number.isSafeInteger(value) && value > 0) actualRevision = String(value);
  } catch { /* preserve the deterministic conflict family */ }
  return new Error(`web_operation_backend_revision_conflict:expected=${expectedRevision}:actual=${actualRevision}`);
}

export function writeWebOperationBackendMirror(setting: WebOperationBackendSetting): { path: string; written: boolean; exact_blocker: string | null } {
  const path = mirrorPath();
  const payload = {
    schema: WEB_OPERATION_BACKEND_CONFIG_SCHEMA,
    source: "automation_os",
    backend: setting.backend,
    revision: setting.revision,
    route_authority: "adaptive_two_extension_resolver",
    routing_mode: "adaptive_two_extension",
    preferred_backend: setting.backend,
    backend_role: "preferred_backend_not_final_route",
    browser_surface: browserSurfaceForWebOperationBackend(setting.backend, setting.chrome_profile.surface),
    preferred_browser_surface: browserSurfaceForWebOperationBackend(setting.backend, setting.chrome_profile.surface),
    browser_surface_role: "preferred_surface_not_run_proof",
    chrome_profile_surface_role: "profile_metadata_only_not_route_authority",
    routing_policy: {
      decision_scope: "browser_stage_before_skill_or_preflight",
      explicit_user_or_workflow_requirement_wins: true,
      preserve_active_run_backend: true,
      normal_default: "aos_chrome_companion",
      effect_adapter_resolution: "effectful_adapter_required",
      official_surface_requirement: "chrome_plugin",
      no_post_dispatch_fallback: true,
      reroute_after_terminal_no_effect_only: true,
      safe_surface_handoff_schema: "aos.safe_extension_surface_handoff.v1",
      safe_surface_handoff_direction: "aos_chrome_companion_to_chrome_plugin_once",
      proactive_visual_readback_required: true,
      human_verification_detection: "rendered_actionable_control_plus_visual_confirmation",
      passive_security_branding_not_blocker: true,
      unsafe_handoff_conditions: [
        "operation_effect_unknown",
        "reconciliation_required",
        "semantic_visual_conflict",
        "auth_or_human_verification",
        "target_or_owner_ambiguity"
      ]
    },
    chrome_profile: setting.chrome_profile,
    updated_at: setting.updated_at
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    return { path, written: true, exact_blocker: null };
  } catch (error) {
    return { path, written: false, exact_blocker: `web_operation_backend_mirror_write_failed:${error instanceof Error ? error.message : String(error)}` };
  }
}

export function buildWebOperationBackendRunSnapshot(backendOverride?: WebOperationBackend): { web_operation_backend: WebOperationBackendSnapshot } {
  const setting = readWebOperationBackendSetting();
  const backend = backendOverride ?? setting.backend;
  return {
    web_operation_backend: {
      schema: WEB_OPERATION_BACKEND_SNAPSHOT_SCHEMA,
      requested_backend: backend,
      resolved_backend: backend,
      revision: setting.revision,
      source: setting.source,
      fallback_allowed: false,
      chrome_profile: setting.chrome_profile,
      browser_surface: browserSurfaceForWebOperationBackend(backend, setting.chrome_profile.surface),
      exact_blocker: null
    }
  };
}

export function buildCompanionFirstWebOperationBackendRunSnapshot(input: {
  adapter?: WebOperationAdapter | null;
  operationClass?: WebOperationOperationClass;
  extensionRequirement?: WebOperationExtensionRequirement;
  continuityBackend?: WebOperationBackend | null;
  preserveActiveRunContinuity?: boolean;
  requiresOfficialExtension?: boolean;
} = {}): { web_operation_backend: WebOperationBackendSnapshot } {
  const setting = readWebOperationBackendSetting();
  const decision = routeCompanionFirstWebOperationBackend({
    configuredBackend: setting.backend,
    adapter: input.adapter,
    operationClass: input.operationClass,
    extensionRequirement: input.extensionRequirement,
    continuityBackend: input.continuityBackend,
    preserveActiveRunContinuity: input.preserveActiveRunContinuity,
    requiresOfficialExtension: input.requiresOfficialExtension,
  });
  const backend = decision.selected_backend;
  return {
    web_operation_backend: {
      schema: WEB_OPERATION_BACKEND_SNAPSHOT_SCHEMA,
      requested_backend: backend,
      resolved_backend: backend,
      revision: setting.revision,
      source: setting.source,
      fallback_allowed: false,
      chrome_profile: setting.chrome_profile,
      browser_surface: browserSurfaceForWebOperationBackend(backend, setting.chrome_profile.surface),
      exact_blocker: decision.exact_blocker,
      route_decision_schema: decision.schema,
      routing_mode: decision.routing_mode,
      preferred_backend: decision.preferred_backend,
      configured_backend: decision.configured_backend,
      route_reason: decision.route_reason,
      route_adapter: decision.adapter,
      route_operation_class: decision.operation_class,
      route_admission_status: decision.admission_status,
      route_decision_scope: decision.decision_scope,
      route_frozen_after_dispatch: decision.frozen_after_dispatch,
      reroute_after_terminal_no_effect_only: decision.reroute_after_terminal_no_effect_only,
      extension_requirement: decision.extension_requirement,
      continuity_backend: decision.continuity_backend,
      official_extension_required: decision.official_extension_required,
    }
  };
}

/**
 * Async HTTP-boundary counterpart to buildWebOperationBackendRunSnapshot.
 * Approval and target-admission routes use the PostgreSQL async boundary;
 * calling the synchronous snapshot helper there can surface a generic
 * internal_error during a cold or invalidated database connection.
 */
export async function buildWebOperationBackendRunSnapshotAsync(backendOverride?: WebOperationBackend): Promise<{ web_operation_backend: WebOperationBackendSnapshot }> {
  const setting = await readWebOperationBackendSettingAsync();
  const backend = backendOverride ?? setting.backend;
  return {
    web_operation_backend: {
      schema: WEB_OPERATION_BACKEND_SNAPSHOT_SCHEMA,
      requested_backend: backend,
      resolved_backend: backend,
      revision: setting.revision,
      source: setting.source,
      fallback_allowed: false,
      chrome_profile: setting.chrome_profile,
      browser_surface: browserSurfaceForWebOperationBackend(backend, setting.chrome_profile.surface),
      exact_blocker: null
    }
  };
}

export function webOperationBackendEnvironment(snapshot: unknown): Record<string, string> {
  const value = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
  const backend = resolveWebOperationBackend(value.requested_backend || value.resolved_backend);
  const profile = value.chrome_profile && typeof value.chrome_profile === "object"
    ? value.chrome_profile as Record<string, unknown>
    : DEFAULT_CHROME_PROFILE;
  return {
    AOS_WEB_OPERATION_BACKEND: backend,
    AOS_WEB_OPERATION_BACKEND_REVISION: String(value.revision ?? "1"),
    AOS_WEB_OPERATION_BACKEND_SOURCE: String(value.source ?? ""),
    AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: String(value.fallback_allowed ?? ""),
    AOS_CHROME_PROFILE_ID: String(profile.id ?? DEFAULT_CHROME_PROFILE.id),
    AOS_CHROME_PROFILE_NAME: String(profile.name ?? DEFAULT_CHROME_PROFILE.name),
    AOS_CHROME_PROFILE_DIRECTORY: String(profile.directory ?? DEFAULT_CHROME_PROFILE.directory),
    AOS_CHROME_PROFILE_SURFACE: browserSurfaceForWebOperationBackend(
      backend,
      String(profile.surface ?? DEFAULT_CHROME_PROFILE.surface),
    ),
    AOS_WEB_OPERATION_BACKEND_CONFIG: mirrorPath()
  };
}

export function webOperationBackendReadback() {
  const setting = readWebOperationBackendSetting();
  const mirror = writeWebOperationBackendMirror(setting);
  return {
    setting,
    allowed_backends: WEB_OPERATION_BACKENDS.map((backend) => ({
      id: backend,
      label: backend === "chrome_plugin" ? "Chrome plugin" : backend === "browser_use_cli" ? "Browser Use CLI" : backend === "aos_chrome_companion" ? "AOS Chrome Companion" : "Playwright",
      selection_status: "selectable",
      execution_note: "run開始時にworkflow adapterとcurrent laneを再確認"
    })),
    adapter_coverage: webOperationBackendAdapterCoverage(),
    local_sync: mirror,
    external_action_executed: false
  };
}

export async function webOperationBackendReadbackAsync() {
  const setting = await readWebOperationBackendSettingAsync();
  const mirror = writeWebOperationBackendMirror(setting);
  return {
    setting,
    allowed_backends: WEB_OPERATION_BACKENDS.map((backend) => ({
      id: backend,
      label: backend === "chrome_plugin" ? "Chrome plugin" : backend === "browser_use_cli" ? "Browser Use CLI" : backend === "aos_chrome_companion" ? "AOS Chrome Companion" : "Playwright",
      selection_status: "selectable",
      execution_note: "run開始時にworkflow adapterとcurrent laneを再確認"
    })),
    adapter_coverage: webOperationBackendAdapterCoverage(),
    local_sync: mirror,
    external_action_executed: false
  };
}
