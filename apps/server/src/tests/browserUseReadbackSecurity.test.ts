import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const canonicalHelperPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";

test("canonical Browser Use readback masks form controls and never reads element.value", () => {
  const helper = readFileSync(canonicalHelperPath, "utf8");
  assert.match(helper, /const isFormControl = \['INPUT', 'TEXTAREA', 'SELECT'\]/u);
  assert.match(helper, /\[入力値は非表示\]/u);
  assert.doesNotMatch(helper, /element\.value/u);
});
