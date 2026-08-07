export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[]) => CommandResult;
export type AsyncCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export function validateLocalTargetUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("browser_target_must_be_local");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!["http:", "https:"].includes(parsed.protocol) || !localHosts.has(parsed.hostname)) {
    throw new Error("browser_target_must_be_local");
  }
  return parsed.toString();
}
