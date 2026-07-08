export function parseYouTubeTranscriptArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const separatorIndex = arg.indexOf("=");
    const rawKey = separatorIndex === -1 ? arg.slice(2) : arg.slice(2, separatorIndex);
    const inlineValue = separatorIndex === -1 ? undefined : arg.slice(separatorIndex + 1);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    parsed[rawKey] = value ?? "";
  }
  return parsed;
}
