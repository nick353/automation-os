import { makeId, nowIso } from "../db/client.js";

export type AdvisorSeed = {
  id: string;
  topic: string;
  source: string;
  summary: string;
  recommendation: string;
  triggerContext: string;
  confidence: number;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export function seedResearchKnowledge(now = nowIso()): AdvisorSeed[] {
  return [
    {
      id: makeId("adv"),
      topic: "Runway MCP alternatives",
      source: "seed/research-watchtower",
      summary: "When Runway MCP is unavailable, detect browser automation, upload queue, and export-state alternatives before stopping the run.",
      recommendation: "Offer a lane switch to Playwright CLI with isolated profile and evidence capture.",
      triggerContext: "runway_mcp_unavailable",
      confidence: 0.86,
      createdAt: now,
      metadata: { tools: ["Playwright CLI", "Chrome CDP", "local export watcher"] }
    },
    {
      id: makeId("adv"),
      topic: "Codex App recurring automation drift",
      source: "seed/current-codex-audit",
      summary: "Registered prompt, app DB state, local docs, and receipts can drift unless imported read-only and compared.",
      recommendation: "Show asset inventory deltas before changing recurring workflow behavior.",
      triggerContext: "codex_asset_import",
      confidence: 0.91,
      createdAt: now,
      metadata: { roots: [".codex/automations", ".codex/sessions", "skills", "plugin/cache"] }
    },
    {
      id: makeId("adv"),
      topic: "Parallel dangerous commits",
      source: "seed/approval-gate",
      summary: "Dangerous actions can run in parallel after explicit approval, but shared resources must be surfaced before commit.",
      recommendation: "Group approvals by approval_group_id and display resource_locks collisions in the lane matrix.",
      triggerContext: "approval_queue_pending",
      confidence: 0.88,
      createdAt: now,
      metadata: { dangerous: ["Post", "Send", "Publish", "Submit", "Save", "Sheets", "Calendar", "Etsy"] }
    }
  ];
}
