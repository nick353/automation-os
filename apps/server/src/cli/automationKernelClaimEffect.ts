import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  automationKernelArtifactPath,
  automationKernelRoot,
  claimKernelEffect,
  ensureKernelDefinition,
  loadKernelDefinition,
  type AutomationKernelClaimResult
} from "../automationKernel/repository.js";

export type AutomationKernelClaimCliOptions = {
  root?: string;
  definitionFile?: string;
  kernelId?: string;
  effectId?: string;
  out?: string;
  help?: boolean;
};

export function parseAutomationKernelClaimCliArgs(argv: string[]): AutomationKernelClaimCliOptions {
  const options: AutomationKernelClaimCliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--root") {
      options.root = argv[++index];
      continue;
    }
    if (arg.startsWith("--definition-file=")) {
      options.definitionFile = arg.slice("--definition-file=".length);
      continue;
    }
    if (arg === "--definition-file") {
      options.definitionFile = argv[++index];
      continue;
    }
    if (arg.startsWith("--kernel-id=")) {
      options.kernelId = arg.slice("--kernel-id=".length);
      continue;
    }
    if (arg === "--kernel-id") {
      options.kernelId = argv[++index];
      continue;
    }
    if (arg.startsWith("--effect-id=")) {
      options.effectId = arg.slice("--effect-id=".length);
      continue;
    }
    if (arg === "--effect-id") {
      options.effectId = argv[++index];
      continue;
    }
    if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--out") {
      options.out = argv[++index];
    }
  }
  return options;
}

export async function runAutomationKernelClaimCli(
  options: AutomationKernelClaimCliOptions
): Promise<AutomationKernelClaimResult & { ok: boolean; artifact_path: string }> {
  if (options.help) throw new Error("help_requested");
  const root = automationKernelRoot(options.root);
  let definitionSource: unknown | undefined;
  if (options.definitionFile) {
    definitionSource = JSON.parse(readFileSync(resolve(options.definitionFile), "utf8")) as unknown;
  }
  let definition;
  if (definitionSource !== undefined) {
    definition = ensureKernelDefinition({ definition: definitionSource, root });
  } else if (options.kernelId) {
    definition = loadKernelDefinition({ kernelId: options.kernelId, root });
  } else {
    throw new Error("kernel_definition_file_or_kernel_id_required");
  }
  const result = claimKernelEffect({
    definition,
    root,
    effectId: options.effectId,
    claimedBy: "automationKernelClaimCli",
    createdAt: new Date().toISOString()
  });
  const artifactPath = options.out ? resolveWritableKernelArtifactPath(root, options.out) : automationKernelArtifactPath({ kernelId: definition.kernel_id, root });
  mkdirSync(requireDir(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        ok: true,
        kernel_id: definition.kernel_id,
        snapshot: result.snapshot,
        legacy_projection: result.legacy_projection,
        claim_entry: result.timeline_entry,
        heartbeat_owner: "caller",
        caller_owned_heartbeat: true
      },
      null,
      2
    )}\n`
  );
  return { ...result, ok: true, artifact_path: artifactPath };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  try {
    const options = parseAutomationKernelClaimCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        [
          "Usage: node apps/server/dist/cli/automationKernelClaimEffect.js --definition-file=PATH [--kernel-id=ID] [--effect-id=ID] [--root=PATH] [--out=PATH]",
          "",
          "Creates or validates a private file-backed Automation Kernel definition and claims one effect.",
          "Heartbeat remains caller-owned; this CLI only records the claim and writes a JSON artifact."
        ].join("\n")
      );
      process.exit(0);
    }
    const result = await runAutomationKernelClaimCli(options);
    console.log(
      JSON.stringify(
        {
          ok: true,
          kernel_id: result.definition.kernel_id,
          snapshot: result.snapshot,
          legacy_projection: result.legacy_projection,
          artifact_path: result.artifact_path
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }, null, 2));
    process.exitCode = 1;
  }
}

function resolveWritableKernelArtifactPath(root: string, requestedPath: string): string {
  const resolvedRoot = automationKernelRoot(root);
  const path = resolve(requestedPath);
  if (path !== resolvedRoot && !path.startsWith(`${resolvedRoot}/`)) throw new Error("kernel_artifact_path_escape");
  return path;
}

function requireDir(path: string): string {
  return resolve(path, "..");
}
