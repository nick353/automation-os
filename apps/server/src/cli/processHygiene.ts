import { cleanupAutomationManagedProcesses } from "../browser/processHygiene.js";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
};

const maxAgeMinutes = Number(valueAfter("--max-age-minutes") ?? process.env.AUTOMATION_OS_PROCESS_CLEANUP_MAX_AGE_MINUTES ?? 360);
const maxAgeSeconds = Number.isFinite(maxAgeMinutes) && maxAgeMinutes >= 0 ? Math.floor(maxAgeMinutes * 60) : 6 * 60 * 60;
const dryRun = args.has("--scan") || args.has("--dry-run");
const includeVisibleLanes = args.has("--include-visible-lanes") || process.env.AUTOMATION_OS_PROCESS_CLEANUP_INCLUDE_VISIBLE_LANES === "1";

const result = cleanupAutomationManagedProcesses({
  dryRun,
  maxAgeSeconds,
  includeVisibleLanes
});

console.log(JSON.stringify(result, null, 2));
if (result.status !== "ok" && !dryRun) process.exitCode = 1;
