import { runAuthenticatedBrowserCapture, type AuthenticatedBrowserCaptureInput } from "../obsidian/authenticatedBrowserCapture.js";

type CliOptions = AuthenticatedBrowserCaptureInput & {
  help?: boolean;
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run obsidian:x-auth-capture -- --url=https://x.com/user/status/123 [--source-title=TITLE] [--vault=/path/to/vault]");
    process.exit(0);
  }
  const result = await runAuthenticatedBrowserCapture(options);
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
    else throw new Error(`Unknown argument: ${arg}`);

    if (consumedSeparateValue) index += 1;
  }
  return options;
}
