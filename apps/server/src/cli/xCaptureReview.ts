import { runXCaptureReview } from "../obsidian/xCaptureReview.js";

type CliOptions = {
  vaultPath?: string;
  outputRoot?: string;
  reviewedAt?: string;
  help?: boolean;
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run x-capture:review -- [--vault=/path/to/vault] [--output-root=/path/to/output] [--reviewed-at=ISO]");
    process.exit(0);
  }
  const result = runXCaptureReview({
    vaultPath: options.vaultPath,
    outputRoot: options.outputRoot,
    reviewedAt: options.reviewedAt
  });
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

    if (key === "--vault") options.vaultPath = value;
    else if (key === "--output-root") options.outputRoot = value;
    else if (key === "--reviewed-at") options.reviewedAt = value;
    else throw new Error(`Unknown argument: ${arg}`);

    if (consumedSeparateValue) index += 1;
  }
  return options;
}
