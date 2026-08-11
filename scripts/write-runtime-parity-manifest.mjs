#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
const outputPath = join(repoRoot, "apps", "server", "dist", "runtime-parity-manifest.json");

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) entries.push(...walkFiles(path));
    else if (entry.isFile()) entries.push(path);
  }
  return entries;
}

const inputs = [];
for (const [label, root] of [
  ["server-dist", join(repoRoot, "apps", "server", "dist")],
  ["web-dist", join(repoRoot, "apps", "web", "dist")]
]) {
  for (const path of walkFiles(root)) {
    if (path === outputPath) continue;
    const bytes = readFileSync(path);
    inputs.push({
      label,
      path: relative(repoRoot, path),
      size: bytes.byteLength,
      sha256: sha256Bytes(bytes)
    });
  }
}

for (const name of ["package.json", "package-lock.json", "zbpack.json"]) {
  const path = join(repoRoot, name);
  if (!existsSync(path) || !statSync(path).isFile()) continue;
  const bytes = readFileSync(path);
  inputs.push({ label: "build-input", path: name, size: bytes.byteLength, sha256: sha256Bytes(bytes) });
}

inputs.sort((left, right) => `${left.label}\0${left.path}`.localeCompare(`${right.label}\0${right.path}`));
const canonical = inputs.map((entry) => `${entry.label}\0${entry.path}\0${entry.size}\0${entry.sha256}`).join("\n");
const manifest = {
  schema: "automation_os_runtime_parity_manifest.v1",
  artifact_hash: sha256Bytes(Buffer.from(canonical, "utf8")),
  file_count: inputs.length,
  inputs,
  generated_at: new Date().toISOString(),
  generated_by: "scripts/write-runtime-parity-manifest.mjs"
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  schema: manifest.schema,
  artifact_hash: manifest.artifact_hash,
  file_count: manifest.file_count,
  output: relative(repoRoot, outputPath)
}));
