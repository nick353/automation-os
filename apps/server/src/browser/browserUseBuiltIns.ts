import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BrowserUseBuiltInScript = "browserUseRecordingSidecar.js" | "geminiVideoQaRunner.js";

type ResolveBuiltInOptions = {
  moduleUrl?: string;
  roots?: Array<string | undefined>;
};

export function resolveBuiltInBrowserUseScript(fileName: BrowserUseBuiltInScript, options: ResolveBuiltInOptions = {}): string | undefined {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const adjacentPath = resolve(dirname(fileURLToPath(moduleUrl)), fileName);
  if (existsSync(adjacentPath)) return adjacentPath;

  for (const root of uniqueNonEmpty([process.env.AUTOMATION_OS_REPO_ROOT, process.cwd(), ...(options.roots ?? [])])) {
    const distPath = resolve(root, "apps", "server", "dist", "browser", fileName);
    if (existsSync(distPath)) return distPath;
  }
  return undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const resolved = resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}
