import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { execSql, initDb, nowIso, sqlValue } from "../db/client.js";

export type CodexAsset = {
  id: string;
  sourceType: string;
  name: string;
  path: string;
  kind: "file" | "directory" | "missing";
  sizeBytes: number;
  modifiedAt: string | null;
  importedAt: string;
  metadata: Record<string, unknown>;
};

const roots = [
  { sourceType: "codex_automations", path: "/Users/nichikatanaka/.codex/automations" },
  { sourceType: "codex_sessions", path: "/Users/nichikatanaka/.codex/sessions" },
  { sourceType: "codex_skills", path: "/Users/nichikatanaka/.codex/skills" },
  { sourceType: "agents_skills", path: "/Users/nichikatanaka/.agents/skills" },
  { sourceType: "plugin_cache", path: "/Users/nichikatanaka/.codex/plugins/cache" }
];

function assetId(path: string): string {
  return `asset_${createHash("sha1").update(path).digest("hex").slice(0, 16)}`;
}

async function scanRoot(sourceType: string, rootPath: string, maxEntries: number): Promise<CodexAsset[]> {
  const importedAt = nowIso();
  if (!existsSync(rootPath)) {
    return [
      {
        id: assetId(rootPath),
        sourceType,
        name: basename(rootPath),
        path: rootPath,
        kind: "missing",
        sizeBytes: 0,
        modifiedAt: null,
        importedAt,
        metadata: { readable: false }
      }
    ];
  }

  const assets: CodexAsset[] = [];
  const stack = [rootPath];
  while (stack.length && assets.length < maxEntries) {
    const current = stack.pop()!;
    const stats = await lstat(current);
    const kind = stats.isDirectory() ? "directory" : "file";
    assets.push({
      id: assetId(current),
      sourceType,
      name: basename(current),
      path: current,
      kind,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      importedAt,
      metadata: { readonly_import: true, root: rootPath }
    });
    if (kind === "directory") {
      const entries = await readdir(current);
      for (const entry of entries.sort().reverse()) stack.push(join(current, entry));
    }
  }

  if (stack.length > 0) {
    assets.push({
      id: assetId(`${rootPath}:truncated`),
      sourceType,
      name: `${basename(rootPath)} import truncated`,
      path: rootPath,
      kind: "directory",
      sizeBytes: 0,
      modifiedAt: null,
      importedAt,
      metadata: { readonly_import: true, truncated: true, remaining_stack: stack.length, max_entries: maxEntries }
    });
  }

  return assets;
}

export async function importCodexAssets(options: { maxEntriesPerRoot?: number } = {}): Promise<{
  imported: number;
  bySource: Record<string, number>;
}> {
  initDb();
  const maxEntries = options.maxEntriesPerRoot ?? 2500;
  const allAssets: CodexAsset[] = [];
  for (const root of roots) {
    allAssets.push(...(await scanRoot(root.sourceType, root.path, maxEntries)));
  }

  execSql("DELETE FROM codex_assets;");
  const chunks: CodexAsset[][] = [];
  for (let i = 0; i < allAssets.length; i += 250) chunks.push(allAssets.slice(i, i + 250));
  for (const chunk of chunks) {
    const values = chunk
      .map(
        (asset) =>
          `(${[
            sqlValue(asset.id),
            sqlValue(asset.sourceType),
            sqlValue(asset.name),
            sqlValue(asset.path),
            sqlValue(asset.kind),
            sqlValue(asset.sizeBytes),
            sqlValue(asset.modifiedAt),
            sqlValue(asset.importedAt),
            sqlValue(asset.metadata)
          ].join(", ")})`
      )
      .join(",\n");
    execSql(
      `INSERT INTO codex_assets (id, source_type, name, path, kind, size_bytes, modified_at, imported_at, metadata_json) VALUES ${values};`
    );
  }

  const bySource = allAssets.reduce<Record<string, number>>((acc, asset) => {
    acc[asset.sourceType] = (acc[asset.sourceType] ?? 0) + 1;
    return acc;
  }, {});
  return { imported: allAssets.length, bySource };
}
