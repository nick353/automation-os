import { cleanDevData, initDb } from "../db/client.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const allow = process.env.AUTOMATION_OS_ALLOW_CLEAN_DEV_DATA === "1";

if (!dryRun && (!force || !allow)) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "clean_dev_data_requires_force_and_env",
        required: ["--force", "AUTOMATION_OS_ALLOW_CLEAN_DEV_DATA=1"],
        hint: "Use --dry-run to inspect without deleting data."
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} else {
  initDb();
  const result = cleanDevData({ dryRun });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
