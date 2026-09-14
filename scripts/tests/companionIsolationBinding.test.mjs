import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCompanionIsolationBinding } from "../lib/companion-isolation-binding.mjs";
import { loadCompanionBrokerClient } from "../aos-chrome-companion-adapter.mjs";
import { safeWorkerEnvironment } from "../../apps/server/dist/security/processEnvironment.js";

test("isolation rejects invalid bindings without a broker and preserves worker configuration", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "companion-binding-check-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "companion-binding-outside-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const binding = { schema: "aos.companion_isolation_binding.v1", sourceRoot: await realpath(process.cwd()),
    dataDir: root, socketPath: join(root, "broker.sock"), secretPath: join(root, "secret"),
    issuerSecretPath: join(root, "issuer"), instanceId: randomUUID() };
  await writeFile(binding.secretPath, "test-only");
  await writeFile(binding.issuerSecretPath, "test-only");
  const file = join(root, "binding.json"), bytes = JSON.stringify(binding);
  await writeFile(file, bytes, { mode: 0o400, flag: "wx" });
  const env = { AOS_CHROME_COMPANION_REQUIRE_ISOLATED_PATHS: "1",
    AOS_DAILY_AI_INJECT_COMMIT_FAILURE_ONCE: "1",
    AOS_CHROME_COMPANION_ISOLATION_BINDING_PATH: file,
    AOS_CHROME_COMPANION_ISOLATION_BINDING_SHA256: createHash("sha256").update(bytes).digest("hex"),
    AOS_CHROME_COMPANION_ROOT: binding.sourceRoot, AOS_CHROME_COMPANION_DATA_DIR: root,
    AOS_CHROME_COMPANION_SOCKET: binding.socketPath, AOS_CHROME_COMPANION_SECRET_FILE: binding.secretPath,
    AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: binding.issuerSecretPath };
  assert.deepEqual(await validateCompanionIsolationBinding(env), binding);
  const filtered = safeWorkerEnvironment(env);
  for (const [key, value] of Object.entries(env)) assert.equal(filtered[key], value, key);
  await assert.rejects(loadCompanionBrokerClient({ ...env, AOS_CHROME_COMPANION_REQUIRE_ISOLATED_PATHS: "" }), /isolation/i);
  await assert.rejects(loadCompanionBrokerClient({ ...env, AOS_CHROME_COMPANION_ISOLATION_BINDING_PATH: "" }), /isolation/i);
  await assert.rejects(loadCompanionBrokerClient({ ...env, AOS_CHROME_COMPANION_ISOLATION_BINDING_SHA256: "0".repeat(64) }), /isolation/i);
  await assert.rejects(loadCompanionBrokerClient({ ...env, AOS_CHROME_COMPANION_SOCKET: join(root, "wrong.sock") }), /isolation/i);
  await writeFile(join(outside, "secret"), "test-only");
  const link = join(root, "escape");
  await symlink(join(outside, "secret"), link);
  await assert.rejects(loadCompanionBrokerClient({ ...env, AOS_CHROME_COMPANION_SECRET_FILE: link }), /isolation/i);
});
