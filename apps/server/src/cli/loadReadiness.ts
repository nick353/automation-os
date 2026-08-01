import { runLoadReadiness, parseLoadReadinessArgs } from "../loadReadiness.js";

try {
  const options = parseLoadReadinessArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: npm run qa:load -- [--url=URL ...] [--concurrency=N] [--duration-ms=MS] [--timeout-ms=MS] [--output=PATH] [--allow-production-hosts]",
        "",
        "Defaults to a safe local endpoint set when no URL is supplied.",
        "Requests use HEAD only, do not follow redirects, and never send credentials.",
        "If AUTOMATION_OS_READ_TOKEN (or QA/REPLAY read token) is set, it is sent only as a readback header."
      ].join("\n")
    );
    process.exit(0);
  }
  const readToken = [
    process.env.AUTOMATION_OS_READ_TOKEN,
    process.env.AUTOMATION_OS_QA_READ_TOKEN,
    process.env.AUTOMATION_OS_REPLAY_READ_TOKEN
  ].find((value) => typeof value === "string" && value.trim())?.trim();
  if (readToken) options.readToken = readToken;
  const report = await runLoadReadiness(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.ok,
        status: report.status,
        exactBlocker: report.exactBlocker,
        summary: report.summary,
        evidencePath: report.evidencePath,
        requestCount: report.requestCount,
        successCount: report.successCount,
        failureCount: report.failureCount,
        latencyMs: report.latencyMs
      },
      null,
      2
    )}\n`
  );
  if (!report.ok) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown_error"
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
