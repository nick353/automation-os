import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runtimeModule = pathToFileURL(path.join(os.homedir(), ".codex", "runtime", "session-handoff", "goal-handoff-fork.mjs"));
const { browserRouteBootstrapPrompt } = await import(runtimeModule.href);

test("planned handoff resolves an adaptive two-extension route before preflight and freezes it after dispatch", () => {
  const prompt = browserRouteBootstrapPrompt();
  assert.match(prompt, /\.social-flow\/web-operation-backend\.json/u);
  assert.match(prompt, /preferred default, not the final route/u);
  assert.match(prompt, /browser_route_decision\.v2/u);
  assert.match(prompt, /active run or owned-tab backend/u);
  assert.match(prompt, /effectful workflow-adapter availability/u);
  assert.match(prompt, /AOS Chrome Companion for normal work/u);
  assert.match(prompt, /immutable run snapshot resolved_backend/u);
  assert.match(prompt, /terminal and external_effect=false or reconciled/u);
  assert.match(prompt, /implicit runtime fallback/u);
  assert.equal(prompt.includes("use only /Users/nichikatanaka/.local/bin/codex-browser-use"), false);
});
