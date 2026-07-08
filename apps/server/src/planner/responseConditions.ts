const segmentSeparators = /[。,\n]+/;
const guardedWorkActionPattern = /保存|送信|投稿|公開|同期|実行|実装|修正|作成|削除|save|send|post|publish|sync|execute|run|implement|fix|create|delete/i;

export function splitGoalIntoActionableSegments(goal: string): string[] {
  const segments = goal
    .split(segmentSeparators)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const source = segments.length > 0 ? segments : [goal.trim() || "Operate automation run"];
  const merged: string[] = [];

  for (const segment of source) {
    if (isResponseConditionSegment(segment) && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}。${segment}`;
      continue;
    }
    merged.push(segment);
  }

  return merged;
}

export function normalizeActionableObjective(input: string): string {
  const docsExistenceKey = canonicalDocsExistenceCheckKey(input);
  if (docsExistenceKey) return docsExistenceKey;

  const actionableSegments = splitGoalIntoActionableSegments(input).map(removeTrailingResponseCondition).filter(Boolean);
  const text = (actionableSegments.length ? actionableSegments.join(" ") : input)
    .toLowerCase()
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/[。、,.\s]+$/g, "")
    .trim();
  return text || input.toLowerCase().replace(/[ \t\r\n]+/g, " ").trim();
}

function canonicalDocsExistenceCheckKey(input: string): string | undefined {
  if (guardedWorkActionPattern.test(input)) return undefined;
  const path = input.match(/\bdocs\/[^\s、。,.]+\.md\b/i)?.[0].toLowerCase();
  if (!path) return undefined;
  const hasExistenceIntent = /(存在(?:だけを)?確認|存在確認|存在だけを確認|存在したら|存在するか|存在有無|exists?|existence)/i.test(input);
  const hasReadonlyCheckIntent = /(read-only|readonly)[^\n、。,.]*(確認|check|verify)|(確認|check|verify)[^\n、。,.]*(read-only|readonly)/i.test(input);
  if (!hasExistenceIntent && !hasReadonlyCheckIntent) return undefined;
  return `docs-existence:${path}`;
}

function removeTrailingResponseCondition(segment: string): string {
  const parts = segment
    .split(segmentSeparators)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return segment.trim();
  return parts.filter((part) => !isResponseConditionSegment(part)).join("。").trim();
}

function isResponseConditionSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return false;
  const hasCondition = /^(?:存在したら|あれば|あったら|見つかったら|なければ|なかったら|存在しなければ|見つからなければ|できたら|完了したら|失敗したら)/i.test(
    text
  );
  const hasResponseShape = /(?:1文|一文|短く|簡潔|返答|回答|終了|報告|答え)/i.test(text);
  const hasWorkAction = guardedWorkActionPattern.test(text);
  return hasCondition && hasResponseShape && !hasWorkAction;
}
