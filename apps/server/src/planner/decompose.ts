import { splitGoalIntoActionableSegments } from "./responseConditions.js";

export type PlannedTask = {
  id: string;
  name: string;
  laneRole: string;
  resources: string[];
  dangerousAction: boolean;
  parallelSafe: boolean;
};

const resourceHints: Array<[RegExp, string]> = [
  [/daily ai|x\.com|twitter|linkedin|投稿|publish/i, "social_publish"],
  [/nisenprints|etsy|pinterest/i, "commerce_publish"],
  [/calendar/i, "calendar_write"],
  [/sheets|spreadsheet/i, "sheets_write"],
  [/runway|mcp|video/i, "runway_mcp"],
  [/research|調査|watchtower/i, "research_cache"]
];

export function decomposeGoal(goal: string): PlannedTask[] {
  const source = splitGoalIntoActionableSegments(goal);

  return source.map((segment, index) => {
    const nonCommitWork = isNonCommitWork(segment);
    const resources = nonCommitWork
      ? ["local_worker"]
      : resourceHints
          .filter(([pattern]) => pattern.test(segment))
          .map(([, resource]) => resource);
    const dangerousAction = !nonCommitWork && /post|send|publish|submit|save|投稿|承認|送信|保存|公開/i.test(segment);
    return {
      id: `task-${index + 1}`,
      name: segment,
      laneRole: inferLaneRole(segment),
      resources: [...new Set(resources.length ? resources : ["local_worker"])],
      dangerousAction,
      parallelSafe: true
    };
  });
}

function isNonCommitWork(segment: string): boolean {
  const analysisIntent = /レビュー|review|下書き|draft|分析|analyze|調査|確認|添削|実装|修正|設計|コード|code|executor|workerengine|test|テスト/i.test(segment);
  const commitIntent = /送信|公開|publish|submit|save|保存|post\b|投稿する|投稿して|投稿を実行/i.test(segment);
  return analysisIntent && !commitIntent;
}

function inferLaneRole(segment: string): string {
  if (/daily ai/i.test(segment)) return "Daily AI Runner";
  if (/nisenprints|etsy|pinterest/i.test(segment)) return "NisenPrints Commerce";
  if (/runway|video|mcp/i.test(segment)) return "Runway MCP Alternative";
  if (/research|調査/i.test(segment)) return "Research Watchtower";
  return "Local Worker";
}
