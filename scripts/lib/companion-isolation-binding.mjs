import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const fail = () => { throw new Error("companion_isolation_binding_invalid"); };
async function canonical(file, missingAllowed = false) {
  if (typeof file !== "string" || !isAbsolute(file)) fail();
  try { return await realpath(file); } catch (error) {
    if (!missingAllowed || error.code !== "ENOENT") throw error;
    return resolve(await realpath(dirname(file)), basename(file));
  }
}

export async function validateCompanionIsolationBinding(env) {
  const file = env.AOS_CHROME_COMPANION_ISOLATION_BINDING_PATH;
  const hash = env.AOS_CHROME_COMPANION_ISOLATION_BINDING_SHA256;
  if (!file || !/^[a-f0-9]{64}$/.test(hash || "")) fail();
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222)) fail();
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== hash) fail();
  const binding = JSON.parse(bytes.toString("utf8"));
  if (binding.schema !== "aos.companion_isolation_binding.v1" || !/^[a-f0-9-]{36}$/.test(binding.instanceId || "")) fail();
  const temporaryRoot = await canonical(binding.dataDir);
  if (!inside(await realpath(tmpdir()), temporaryRoot) || !inside(temporaryRoot, await realpath(file))) fail();
  const installed = resolve(homedir(), "Library/Application Support/AOS Chrome Companion");
  const fields = {
    sourceRoot: "AOS_CHROME_COMPANION_ROOT", dataDir: "AOS_CHROME_COMPANION_DATA_DIR",
    socketPath: "AOS_CHROME_COMPANION_SOCKET", secretPath: "AOS_CHROME_COMPANION_SECRET_FILE",
    issuerSecretPath: "AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE",
  };
  for (const [field, key] of Object.entries(fields)) {
    const expected = await canonical(binding[field], field === "socketPath");
    const actual = await canonical(env[key], field === "socketPath");
    if (expected !== binding[field] || actual !== expected || actual === installed || inside(installed, actual)) fail();
    if (!["sourceRoot", "dataDir"].includes(field) && !inside(temporaryRoot, actual)) fail();
  }
  return binding;
}
