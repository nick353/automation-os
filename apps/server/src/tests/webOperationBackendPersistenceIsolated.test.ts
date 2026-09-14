import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Set both persistence targets before importing the application modules.
const fixtureRoot = mkdtempSync(join(tmpdir(), "aos-backend-persistence-"));
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_DB = join(fixtureRoot, "fixture.sqlite");
process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(fixtureRoot, "backend.json");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URI;
const { dbBackend, dbPath } = await import("../db/client.js");
const { readWebOperationBackendSettingAsync, writeWebOperationBackendSettingAsync } = await import("../runs/webOperationBackendSettings.js");

test("isolated backend save persists revision and rejects stale writes without changing the mirror", async () => {
  assert.equal(dbBackend, "sqlite");
  assert.equal(dbPath, join(fixtureRoot, "fixture.sqlite"));
  const initial = await readWebOperationBackendSettingAsync();
  const saved = await writeWebOperationBackendSettingAsync({
    backend: "aos_chrome_companion", actorUserId: "fixture-owner", expectedRevision: initial.revision,
  });
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal(saved.backend, "aos_chrome_companion");
  assert.equal(saved.chrome_profile.directory, "Profile 2");
  assert.deepEqual(await readWebOperationBackendSettingAsync(), saved);
  const mirrorPath = process.env.AOS_WEB_OPERATION_BACKEND_CONFIG!;
  const beforeConflict = readFileSync(mirrorPath, "utf8");
  const mirror = JSON.parse(beforeConflict);
  assert.equal(mirror.revision, saved.revision);
  assert.equal(mirror.backend, saved.backend);
  await assert.rejects(writeWebOperationBackendSettingAsync({
    backend: "chrome_plugin", actorUserId: "fixture-stale-owner", expectedRevision: initial.revision,
  }), /web_operation_backend_revision_conflict/);
  assert.deepEqual(await readWebOperationBackendSettingAsync(), saved);
  assert.equal(readFileSync(mirrorPath, "utf8"), beforeConflict);
});
