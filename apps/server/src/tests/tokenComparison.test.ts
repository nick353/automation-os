import assert from "node:assert/strict";
import test from "node:test";
import { secureTokenEqual } from "../security/tokenComparison.js";

test("secureTokenEqual accepts only the exact token", () => {
  assert.equal(secureTokenEqual("synthetic-write-token", "synthetic-write-token"), true);
  assert.equal(secureTokenEqual("synthetic-write-token", "synthetic-read-token"), false);
  assert.equal(secureTokenEqual("synthetic-write-token-extra", "synthetic-write-token"), false);
  assert.equal(secureTokenEqual("", "synthetic-write-token"), false);
});

test("secureTokenEqual does not expose token material in its result", () => {
  const result = secureTokenEqual("synthetic-secret-value", "other-value");
  assert.equal(typeof result, "boolean");
  assert.equal(String(result).includes("synthetic-secret-value"), false);
});
