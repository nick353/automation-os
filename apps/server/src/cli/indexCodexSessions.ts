import { buildAndWriteRedactedSessionIndex } from "../obsidian/sessionIndex.js";

function argument(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const result = buildAndWriteRedactedSessionIndex({
  sessionsDir: argument("--sessions-dir"),
  outputPath: argument("--output"),
  maxFiles: argument("--max-files") ? Number(argument("--max-files")) : undefined
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  outputPath: result.outputPath,
  scannedFiles: result.scannedFiles,
  indexedEntries: result.indexedEntries,
  skippedFiles: result.skippedFiles,
  coverage: result.coverage
}, null, 2)}\n`);
