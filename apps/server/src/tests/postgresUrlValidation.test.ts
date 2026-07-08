import { deepStrictEqual, strictEqual } from "node:assert/strict";
import test from "node:test";

import { validatePostgresUrl } from "../cli/postgresUrlValidation.js";

test("accepts explicit postgres url", () => {
  const result = validatePostgresUrl("postgresql://user:pass@host:5432/db");
  if (!result.ok) {
    throw new Error(`validation failed: ${result.reason}`);
  }
  strictEqual(result.value, "postgresql://user:pass@host:5432/db");
});

test("rejects non-url", () => {
  const result = validatePostgresUrl("not-a-real-url");
  deepStrictEqual(result, { ok: false, reason: "url_parse_failed" });
});

test("accepts template reference when environment variable exists", () => {
  const previous = process.env.POSTGRES_URI;
  process.env.POSTGRES_URI = "postgresql://user:pass@localhost:5432/db";
  const result = validatePostgresUrl("${POSTGRES_URI}");
  if (previous === undefined) {
    delete process.env.POSTGRES_URI;
  } else {
    process.env.POSTGRES_URI = previous;
  }

  if (!result.ok) {
    throw new Error(`expected template ref to be resolved, got ${result.reason}`);
  }
  strictEqual(result.value, "postgresql://user:pass@localhost:5432/db");
});

test("accepts composite template reference with multiple variables", () => {
  const previousUsername = process.env.POSTGRES_USERNAME;
  const previousPassword = process.env.POSTGRES_PASSWORD;
  const previousHost = process.env.POSTGRES_HOST;
  const previousPort = process.env.POSTGRES_PORT;
  const previousDatabase = process.env.POSTGRES_DATABASE;

  process.env.POSTGRES_USERNAME = "user";
  process.env.POSTGRES_PASSWORD = "pass";
  process.env.POSTGRES_HOST = "localhost";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DATABASE = "automation_os";
  const result = validatePostgresUrl("postgresql://${POSTGRES_USERNAME}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}");

  if (previousUsername === undefined) delete process.env.POSTGRES_USERNAME; else process.env.POSTGRES_USERNAME = previousUsername;
  if (previousPassword === undefined) delete process.env.POSTGRES_PASSWORD; else process.env.POSTGRES_PASSWORD = previousPassword;
  if (previousHost === undefined) delete process.env.POSTGRES_HOST; else process.env.POSTGRES_HOST = previousHost;
  if (previousPort === undefined) delete process.env.POSTGRES_PORT; else process.env.POSTGRES_PORT = previousPort;
  if (previousDatabase === undefined) delete process.env.POSTGRES_DATABASE; else process.env.POSTGRES_DATABASE = previousDatabase;

  if (!result.ok) {
    throw new Error(`expected template refs to be resolved, got ${result.reason}`);
  }
  strictEqual(result.value, "postgresql://user:pass@localhost:5432/automation_os");
});

test("rejects template reference when variable is missing", () => {
  const previous = process.env.POSTGRES_URI_MISSING;
  delete process.env.POSTGRES_URI_MISSING;
  const result = validatePostgresUrl("${POSTGRES_URI_MISSING}");
  if (previous !== undefined) {
    process.env.POSTGRES_URI_MISSING = previous;
  }

  deepStrictEqual(result, { ok: false, reason: "template_reference_missing:POSTGRES_URI_MISSING" });
});
