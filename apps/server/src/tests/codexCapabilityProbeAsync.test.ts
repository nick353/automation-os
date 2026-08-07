import assert from "node:assert/strict";
import test from "node:test";
import { clearCapabilityProbeCache, probeCodexMcpSurfaceAsync } from "../codex/capabilityProbe.js";

test("async MCP probe returns an exact timeout blocker without waiting for the child indefinitely", async () => {
  clearCapabilityProbeCache();
  const startedAt = Date.now();
  const result = await probeCodexMcpSurfaceAsync({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    timeoutMs: 25,
    ttlMs: 0
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "mcp_probe_timeout");
  assert.ok(Date.now() - startedAt < 1_500);
});

test("async MCP probe deduplicates concurrent read-only probes", async () => {
  clearCapabilityProbeCache();
  let calls = 0;
  const runner = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: "ok" as const, exactBlocker: null, stdout: "[]" };
  };

  const [first, second] = await Promise.all([
    probeCodexMcpSurfaceAsync({ command: "fake-codex", ttlMs: 60_000, runner }),
    probeCodexMcpSurfaceAsync({ command: "fake-codex", ttlMs: 60_000, runner })
  ]);

  assert.equal(calls, 1);
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(first.state.connected, false);
  assert.equal(second.state.connected, false);
});

test("MCP probe command falls back to the configured official Codex CLI", async () => {
  clearCapabilityProbeCache();
  const previousProbeCommand = process.env.AUTOMATION_OS_CODEX_MCP_PROBE_COMMAND;
  const previousCodexBin = process.env.AUTOMATION_OS_CODEX_BIN;
  const previousCliPath = process.env.CODEX_CLI_PATH;
  process.env.AUTOMATION_OS_CODEX_MCP_PROBE_COMMAND = " ";
  process.env.AUTOMATION_OS_CODEX_BIN = " ";
  process.env.CODEX_CLI_PATH = "/opt/official-codex";
  let command = "";
  try {
    const result = await probeCodexMcpSurfaceAsync({
      args: ["mcp", "list"],
      ttlMs: 0,
      runner: async (observedCommand) => {
        command = observedCommand;
        return { status: "ok", exactBlocker: null, stdout: "[]" };
      }
    });
    assert.equal(command, "/opt/official-codex");
    assert.equal(result.status, "ok");
  } finally {
    if (previousProbeCommand === undefined) delete process.env.AUTOMATION_OS_CODEX_MCP_PROBE_COMMAND;
    else process.env.AUTOMATION_OS_CODEX_MCP_PROBE_COMMAND = previousProbeCommand;
    if (previousCodexBin === undefined) delete process.env.AUTOMATION_OS_CODEX_BIN;
    else process.env.AUTOMATION_OS_CODEX_BIN = previousCodexBin;
    if (previousCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCliPath;
  }
});
