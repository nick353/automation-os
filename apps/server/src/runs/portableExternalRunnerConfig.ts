import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The AOS-owned portable runner is the default adapter boundary.  A caller
 * may still provide an explicitly configured runner for a controlled rollout,
 * but an empty explicit value intentionally disables the default instead of
 * silently selecting a different executable.
 */
export const DEFAULT_PORTABLE_EXTERNAL_RUNNER_RELATIVE_PATH = "scripts/aos-portable-browser-use-runner.mjs" as const;
export const DEFAULT_PORTABLE_EXTERNAL_BUSINESS_RUNNER_RELATIVE_PATH = "scripts/aos-portable-business-runner.mjs" as const;

function externalEffectsEnabled(environment: NodeJS.ProcessEnv): boolean {
  return /^(?:1|true|yes|on|enabled)$/iu.test(String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS || "").trim());
}

export function resolvePortableExternalRunner(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (Object.prototype.hasOwnProperty.call(environment, "AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER")) {
    return String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER ?? "").trim();
  }
  const configuredDefault = String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER ?? "").trim();
  if (configuredDefault) return configuredDefault;
  return resolve(cwd, externalEffectsEnabled(environment)
    ? DEFAULT_PORTABLE_EXTERNAL_BUSINESS_RUNNER_RELATIVE_PATH
    : DEFAULT_PORTABLE_EXTERNAL_RUNNER_RELATIVE_PATH);
}

export function portableExternalRunnerConfigured(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): boolean {
  const command = resolvePortableExternalRunner(environment, cwd);
  if (!command) return false;
  try {
    return Boolean(statSync(command).isFile());
  } catch {
    return existsSync(join(cwd, DEFAULT_PORTABLE_EXTERNAL_RUNNER_RELATIVE_PATH)) && command === resolve(cwd, DEFAULT_PORTABLE_EXTERNAL_RUNNER_RELATIVE_PATH);
  }
}
