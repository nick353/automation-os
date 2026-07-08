import { runUrlCapture, type UrlCaptureInput } from "../obsidian/urlCapture.js";

type CliOptions = UrlCaptureInput & {
  help?: boolean;
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run obsidian:url-capture -- --url=https://example.com [--source-title=TITLE] [--vault=/path/to/vault] [--timeout-ms=10000] [--max-bytes=524288]");
    process.exit(0);
  }
  const result = await runUrlCapture(options);
  const stream = result.ok || result.status === "blocked" ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "blocked") process.exitCode = 2;
  if (result.status === "rejected") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }, null, 2));
  process.exitCode = 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const [key, inlineValue] = arg.split(/=(.*)/s, 2);
    const value = inlineValue ?? args[index + 1];
    const consumedSeparateValue = inlineValue === undefined;
    if (value === undefined) throw new Error(`Missing value for ${arg}`);

    if (key === "--url") options.url = value;
    else if (key === "--source-title") options.sourceTitle = value;
    else if (key === "--vault") options.vaultPath = value;
    else if (key === "--captured-at") options.capturedAt = value;
    else if (key === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, key);
    else if (key === "--max-bytes") options.maxBytes = parsePositiveInteger(value, key);
    else throw new Error(`Unknown argument: ${arg}`);

    if (consumedSeparateValue) index += 1;
  }
  return options;
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}
