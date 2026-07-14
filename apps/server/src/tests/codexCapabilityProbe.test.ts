import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { clearCapabilityProbeCache, probeCodexMcpSurface } from "../codex/capabilityProbe.js";

test("codex MCP probe caches read-only results within TTL", () => {
  clearCapabilityProbeCache();
  let calls = 0;
  let now = 1_000;
  const result = probeCodexMcpSurface({
    command: "fake-codex",
    args: ["mcp", "list"],
    ttlMs: 60_000,
    now: () => now,
    runner: () => {
      calls += 1;
      return {
        pid: 123,
        output: [],
        stdout: JSON.stringify([
          { name: "browser", status: "connected", enabled: true, connected: true }
        ]),
        stderr: "",
        status: 0,
        signal: null
      } as SpawnSyncReturns<string>;
    }
  });

  const cached = probeCodexMcpSurface({
    command: "fake-codex",
    args: ["mcp", "list"],
    ttlMs: 60_000,
    now: () => now,
    runner: () => {
      calls += 1;
      return {
        pid: 123,
        output: [],
        stdout: "should not be used",
        stderr: "",
        status: 0,
        signal: null
      } as SpawnSyncReturns<string>;
    }
  });

  now += 61_000;
  const refreshed = probeCodexMcpSurface({
    command: "fake-codex",
    args: ["mcp", "list"],
    ttlMs: 60_000,
    now: () => now,
    runner: () => {
      calls += 1;
      return {
        pid: 123,
        output: [],
        stdout: JSON.stringify([
          { name: "browser", status: "connected", enabled: true, connected: true }
        ]),
        stderr: "",
        status: 0,
        signal: null
      } as SpawnSyncReturns<string>;
    }
  });

  clearCapabilityProbeCache();

  assert.equal(calls, 2);
  assert.equal(result.status, "ok");
  assert.equal(result.state.connected, true);
  assert.equal(cached.state.connected, true);
  assert.equal(refreshed.state.connected, true);
  assert.equal(result.generatedAt, cached.generatedAt);
  assert.notEqual(result.generatedAt, refreshed.generatedAt);
});

test("codex MCP probe fails closed on malformed output", () => {
  clearCapabilityProbeCache();
  const result = probeCodexMcpSurface({
    command: "fake-codex",
    args: ["mcp", "list"],
    ttlMs: 0,
    runner: () => ({
      pid: 123,
      output: [],
      stdout: "not a valid MCP response",
      stderr: "",
      status: 0,
      signal: null
    } as SpawnSyncReturns<string>)
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "mcp_probe_parse_failed");
  assert.equal(result.state.configured, true);
  assert.equal(result.state.enabled, false);
  assert.equal(result.state.verified, false);
  assert.equal(result.state.connected, false);
  assert.equal(result.entries.length, 0);
  assert.equal(result.parsedFrom, "none");
});
