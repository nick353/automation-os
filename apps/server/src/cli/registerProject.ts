import { registerProject } from "../projects/projectAuditor.js";

const args = parseArgs(process.argv.slice(2));
const required = ["id", "label", "root"].filter((key) => !args[key]);

if (required.length > 0) {
  console.error(JSON.stringify({ ok: false, error: "missing_required_args", required }, null, 2));
  process.exitCode = 1;
} else {
  const result = registerProject({
    id: String(args.id),
    label: String(args.label),
    root: String(args.root),
    ownerLayer: optionalString(args.ownerLayer),
    registryPath: optionalString(args.registry),
    obsidian: args.obsidian === undefined ? undefined : args.obsidian !== "false",
    relatedProjects: listArg(args.relatedProjects),
    artifactRoots: listArg(args.artifactRoots),
    approvalRequired: listArg(args.approvalRequired),
    humanOnly: listArg(args.humanOnly),
    allowedAutomation: listArg(args.allowedAutomation),
    write: args.write === "true",
    update: args.update === "true"
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (const arg of argv) {
    if (arg === "--write") {
      parsed.write = "true";
      continue;
    }
    if (arg === "--update") {
      parsed.update = "true";
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    parsed[toCamel(match[1])] = match[2];
  }
  return parsed;
}

function toCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function listArg(value: string | undefined): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
