import { readFileSync } from "node:fs";
import { runObsidianIngest, type ObsidianIngestInput } from "../obsidian/ingest.js";

type CliOptions = ObsidianIngestInput & {
  help?: boolean;
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run obsidian:ingest -- --source-type=article [--source-url=URL] [--source-title=TITLE] [--text=TEXT] [--vault=/path/to/vault]");
    process.exit(0);
  }
  const input: ObsidianIngestInput = {
    sourceUrl: options.sourceUrl,
    sourceTitle: options.sourceTitle,
    sourceType: options.sourceType,
    text: options.text ?? readFileSync(0, "utf8"),
    vaultPath: options.vaultPath,
    capturedAt: options.capturedAt,
    statusFile: options.statusFile
  };
  const result = runObsidianIngest(input);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
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

    if (key === "--source-url") options.sourceUrl = value;
    else if (key === "--source-title") options.sourceTitle = value;
    else if (key === "--source-type") options.sourceType = value;
    else if (key === "--text") options.text = value;
    else if (key === "--vault") options.vaultPath = value;
    else if (key === "--captured-at") options.capturedAt = value;
    else if (key === "--status-file") options.statusFile = value;
    else throw new Error(`Unknown argument: ${arg}`);

    if (consumedSeparateValue) index += 1;
  }
  return options;
}
