import { validatePostgresUrl } from "./postgresUrlValidation.js";

export type ServerEnvironmentRole = "production" | "recovery" | "legacy";

export type ServerStartupPolicyResult =
  | {
      ok: true;
      role: ServerEnvironmentRole;
      databaseAuthority: "postgres_required" | "legacy";
      databaseSource: "AUTOMATION_OS_DATABASE_URL" | "DATABASE_URL" | null;
    }
  | {
      ok: false;
      role: string;
      exactBlocker:
        | "automation_os_env_role_invalid"
        | "production_postgres_configuration_missing"
        | "production_postgres_configuration_invalid";
      reason?: string;
    };

/**
 * Resolve only the startup boundary. This function never returns a database
 * URL or any credential-shaped value, so it is safe to use in diagnostics.
 *
 * An unset role is intentionally legacy-compatible. Production is opt-in so
 * the existing local recovery LaunchAgent does not silently change behavior.
 */
export function evaluateServerStartupPolicy(env: NodeJS.ProcessEnv = process.env): ServerStartupPolicyResult {
  const role = env.AUTOMATION_OS_ENV_ROLE?.trim() ?? "";
  if (role !== "" && role !== "production" && role !== "recovery") {
    return { ok: false, role, exactBlocker: "automation_os_env_role_invalid" };
  }

  if (role !== "production") {
    return {
      ok: true,
      role: role === "recovery" ? "recovery" : "legacy",
      databaseAuthority: "legacy",
      databaseSource: null
    };
  }

  const candidates: Array<["AUTOMATION_OS_DATABASE_URL" | "DATABASE_URL", string | undefined]> = [
    ["AUTOMATION_OS_DATABASE_URL", env.AUTOMATION_OS_DATABASE_URL],
    ["DATABASE_URL", env.DATABASE_URL]
  ];
  const configured = candidates.find(([, value]) => Boolean(value?.trim()));
  if (!configured) {
    return {
      ok: false,
      role,
      exactBlocker: "production_postgres_configuration_missing"
    };
  }

  const [databaseSource, value] = configured;
  const validation = validatePostgresUrl(value ?? "", env);
  if (!validation.ok) {
    return {
      ok: false,
      role,
      exactBlocker: "production_postgres_configuration_invalid",
      reason: validation.reason
    };
  }

  return {
    ok: true,
    role,
    databaseAuthority: "postgres_required",
    databaseSource
  };
}
