import { runSecondBrainProcessor } from "../obsidian/secondBrainProcessor.js";
import { guardObsidianVaultPath } from "../obsidian/vaultGuard.js";

type CliOptions = {
  apply: boolean;
  vaultPath?: string;
};

const options = parseArgs(process.argv.slice(2));
const vaultGuard = guardObsidianVaultPath(options.vaultPath);

if (!vaultGuard.ok) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: vaultGuard.error,
        summary: vaultGuard.summary
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} else {
  const result = runSecondBrainProcessor({ apply: options.apply, vaultPath: options.vaultPath });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--vault") {
      options.vaultPath = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--vault=")) {
      options.vaultPath = arg.slice("--vault=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run second-brain:process -- [--apply] [--vault=/path/to/vault]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
