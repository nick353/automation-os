export type CodexBinEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_CODEX_BIN = "codex";

/**
 * Resolve the Codex executable without exposing or copying any credential
 * environment values into a child process contract.
 */
export function resolveCodexBin(
  explicitEnvironmentNames: readonly string[] = [],
  environment: CodexBinEnvironment = process.env
): string {
  for (const name of [...explicitEnvironmentNames, "AUTOMATION_OS_CODEX_BIN", "CODEX_CLI_PATH"]) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return DEFAULT_CODEX_BIN;
}
