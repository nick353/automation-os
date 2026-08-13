export const ENVIRONMENT_PARITY_SCHEMA_V1 = "automation_os_environment_parity.v1" as const;
export type EnvironmentParityV1 = { schema: typeof ENVIRONMENT_PARITY_SCHEMA_V1; source: { name: string; digest: string }; installed_runtime: { name: string; digest: string }; artifact: { name: string; digest: string }; deployment: { name: string; digest: string }; status: "matched" | "blocked"; exact_blocker: "environment_source_runtime_artifact_deployment_parity_mismatch" | null; next_action: string };

export function verifyEnvironmentParity(input: Omit<EnvironmentParityV1, "schema" | "status" | "exact_blocker" | "next_action">): EnvironmentParityV1 {
  const values = [input.source.digest, input.installed_runtime.digest, input.artifact.digest, input.deployment.digest];
  const matched = values.every((value) => value === values[0]);
  return { schema: ENVIRONMENT_PARITY_SCHEMA_V1, ...input, status: matched ? "matched" : "blocked", exact_blocker: matched ? null : "environment_source_runtime_artifact_deployment_parity_mismatch", next_action: matched ? "continue with the declared single source of truth" : "stop before execution; repair source/runtime/artifact/deployment parity" };
}
