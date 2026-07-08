import { runAutomationHealth } from "../automationHealth.js";

function optionValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const report = runAutomationHealth({
  automationRoot: optionValue("automation-root"),
  dbPath: optionValue("db"),
  outputRoot: optionValue("output-root")
});

process.stdout.write(
  `${JSON.stringify(
    {
      summary: report.summary,
      report_path: report.report_path
    },
    null,
    2
  )}\n`
);
