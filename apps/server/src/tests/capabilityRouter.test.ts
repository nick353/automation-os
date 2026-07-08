import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCapabilityRouterSnapshot } from "../codex/capabilityRouter.js";
import { getCodexCapabilities, type CodexCapabilitiesSummary } from "../codex/capabilities.js";
import { listTrustedBridgeActions } from "../bridge/trustedBridge.js";

test("capability router recommends existing capture routes and records missing discovery gaps", () => {
  const snapshot = buildCapabilityRouterSnapshot({
    command: "このYouTube https://www.youtube.com/watch?v=dQw4w9WgXcQ と X https://x.com/example/status/123 を調べて、価格と画像promptも作って",
    capabilities: fixtureCapabilities(),
    bridgeActions: listTrustedBridgeActions()
  });
  const routeIds = snapshot.recommendedRoutes.map((route) => route.id);
  const gapIds = snapshot.gapBacklog.map((gap) => gap.id);
  const youtubeRoute = snapshot.recommendedRoutes.find((route) => route.id === "youtube_transcript_capture");

  assert.ok(routeIds.includes("youtube_transcript_capture"));
  assert.deepEqual(youtubeRoute?.signals, ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  assert.ok(routeIds.includes("x_authenticated_capture"));
  assert.ok(routeIds.includes("price_checker"));
  assert.ok(routeIds.includes("web_to_image_prompts"));
  assert.ok(gapIds.includes("chat_capability_router"));
  assert.ok(gapIds.includes("youtube_discovery"));
  assert.ok(gapIds.includes("x_discovery_review_queue"));
  assert.equal(snapshot.gapBacklog.every((gap) => gap.action?.kind === "create" && gap.action.view === "Create" && Boolean(gap.action.command)), true);
  assert.equal(snapshot.counts.gaps > 0, true);
});

test("capability router does not recommend routes without command context", () => {
  const snapshot = buildCapabilityRouterSnapshot({
    capabilities: fixtureCapabilities(),
    bridgeActions: listTrustedBridgeActions()
  });

  assert.deepEqual(snapshot.recommendedRoutes, []);
  assert.equal(snapshot.primaryAction, "このRouterの結果をCreate、Run開始、Goal resumeの入口で必ず表示・保存する");
});

test("capability inventory keeps supervisor helpers for audit but hides them from suggestions", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-capability-router-"));
  const automationsRoot = join(root, "automations");
  mkdirSync(join(automationsRoot, "automation-live-supervisor"), { recursive: true });
  mkdirSync(join(automationsRoot, "automation-live-supervisor-2"), { recursive: true });
  mkdirSync(join(automationsRoot, "automation-child-launcher-bridge"), { recursive: true });
  mkdirSync(join(automationsRoot, "daily-ai-research-publish-run"), { recursive: true });
  writeFileSync(join(automationsRoot, "automation-live-supervisor", "automation.toml"), "id = \"automation-live-supervisor\"\n");
  writeFileSync(join(automationsRoot, "automation-live-supervisor-2", "automation.toml"), "id = \"automation-live-supervisor-2\"\n");
  writeFileSync(join(automationsRoot, "automation-child-launcher-bridge", "automation.toml"), "id = \"automation-child-launcher-bridge\"\n");
  writeFileSync(join(automationsRoot, "daily-ai-research-publish-run", "automation.toml"), "id = \"daily-ai-research-publish-run\"\n");
  const previousRoot = process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT;
  process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT = automationsRoot;
  try {
    const capabilities = getCodexCapabilities();
    const automationNames = capabilities.capabilities.automations.map((automation) => automation.name);
    assert.deepEqual(automationNames, [
      "automation-child-launcher-bridge",
      "automation-live-supervisor",
      "automation-live-supervisor-2",
      "daily-ai-research-publish-run"
    ]);
    const hiddenNames = capabilities.capabilities.automations.filter((automation) => automation.hiddenFromSuggestions).map((automation) => automation.name);
    assert.deepEqual(hiddenNames, [
      "automation-child-launcher-bridge",
      "automation-live-supervisor",
      "automation-live-supervisor-2"
    ]);
  } finally {
    if (previousRoot === undefined) delete process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT;
    else process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT = previousRoot;
  }
});

function fixtureCapabilities(): CodexCapabilitiesSummary {
  const generatedAt = "2026-06-20T00:00:00.000Z";
  return {
    generatedAt,
    roots: {
      codexSkills: { path: "/tmp/skills", exists: true },
      agentSkills: { path: "/tmp/agent-skills", exists: true },
      pluginsCache: { path: "/tmp/plugins", exists: false },
      automations: { path: "/tmp/automations", exists: false }
    },
    summary: {
      skills: 4,
      agentSkills: 0,
      plugins: 0,
      automations: 0,
      mcp: 0
    },
    capabilities: {
      browser: { id: "browser-in-app", name: "Browser / In-App Browser", path: "plugin://Browser", status: "requires_bridge", kind: "browser_bridge" },
      chrome: { id: "chrome-extension", name: "Chrome extension lane", path: "plugin://Chrome", status: "requires_bridge", kind: "browser_bridge" },
      mcp: { id: "mcp-tools", name: "MCP tools exposed by Codex runtime", path: "codex-runtime://mcp", status: "available_with_codex_runtime", kind: "mcp" },
      cli: { id: "codex-cli", name: "Codex CLI", path: "command://codex", status: "available_with_codex_runtime", kind: "cli" },
      appServer: { id: "automation-os-server", name: "Automation OS local API server", path: "http://127.0.0.1", status: "available", kind: "app_server" },
      skills: [
        { id: "skill:pdf", name: "pdf", path: "/tmp/skills/pdf", status: "read_only_indexed", kind: "codex_skill" },
        { id: "skill:price-checker", name: "price-checker", path: "/tmp/skills/price-checker", status: "read_only_indexed", kind: "agent_skill" },
        { id: "skill:video-frame-reader", name: "video-frame-reader", path: "/tmp/skills/video-frame-reader", status: "read_only_indexed", kind: "agent_skill" },
        { id: "skill:web-to-image-prompts", name: "web-to-image-prompts", path: "/tmp/skills/web-to-image-prompts", status: "read_only_indexed", kind: "codex_skill" }
      ],
      plugins: [],
      automations: []
    },
    notes: []
  };
}
