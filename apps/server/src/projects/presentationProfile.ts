export type ProjectPresentationProfile = {
  id: string;
  kind: "research" | "jobs" | "commerce" | "social" | "operations";
  label: string;
  source: "derived_from_project_automation_catalog" | "persisted_project_profile";
  revision?: number;
  exactBlocker?: string | null;
  purpose?: string;
  freshnessSlaMinutes?: number;
  browserUseLane?: string;
  stopBoundary?: string;
  primaryMetrics: string[];
  widgets: Array<"kpi" | "timeline" | "funnel" | "calendar" | "failure_table" | "evidence_timeline" | "lane_status">;
  preferredGrouping: "day" | "week" | "workflow" | "stage";
  explanation: string;
};

const profileKinds = new Set<ProjectPresentationProfile["kind"]>(["research", "jobs", "commerce", "social", "operations"]);
const profileWidgets = new Set<ProjectPresentationProfile["widgets"][number]>(["kpi", "timeline", "funnel", "calendar", "failure_table", "evidence_timeline", "lane_status"]);
const profileGroupings = new Set<ProjectPresentationProfile["preferredGrouping"]>(["day", "week", "workflow", "stage"]);

export type ProjectPresentationProfileOverride = Partial<Pick<
  ProjectPresentationProfile,
  "kind" | "label" | "purpose" | "freshnessSlaMinutes" | "browserUseLane" | "stopBoundary" | "primaryMetrics" | "widgets" | "preferredGrouping" | "explanation"
>>;

export function parseProjectPresentationProfileOverride(value: unknown): ProjectPresentationProfileOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project_profile_object_required");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["kind", "label", "purpose", "freshnessSlaMinutes", "browserUseLane", "stopBoundary", "primaryMetrics", "widgets", "preferredGrouping", "explanation"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`project_profile_unknown_field:${key}`);
  const output: ProjectPresentationProfileOverride = {};
  if (input.kind !== undefined) {
    const kind = String(input.kind);
    if (!profileKinds.has(kind as ProjectPresentationProfile["kind"])) throw new Error("project_profile_kind_invalid");
    output.kind = kind as ProjectPresentationProfile["kind"];
  }
  for (const key of ["label", "purpose", "browserUseLane", "stopBoundary", "explanation"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || input[key].trim().length === 0 || input[key].length > (key === "explanation" ? 1000 : 240)) throw new Error(`project_profile_${key}_invalid`);
    output[key] = input[key].trim();
  }
  if (input.freshnessSlaMinutes !== undefined) {
    if (!Number.isInteger(input.freshnessSlaMinutes) || Number(input.freshnessSlaMinutes) < 1 || Number(input.freshnessSlaMinutes) > 525600) throw new Error("project_profile_freshness_invalid");
    output.freshnessSlaMinutes = Number(input.freshnessSlaMinutes);
  }
  if (input.primaryMetrics !== undefined) output.primaryMetrics = parseStringList(input.primaryMetrics, "project_profile_metrics_invalid", 12, 80);
  if (input.widgets !== undefined) {
    const widgets = parseStringList(input.widgets, "project_profile_widgets_invalid", 7, 40) as ProjectPresentationProfile["widgets"];
    if (widgets.some((widget) => !profileWidgets.has(widget))) throw new Error("project_profile_widgets_invalid");
    output.widgets = widgets;
  }
  if (input.preferredGrouping !== undefined) {
    const grouping = String(input.preferredGrouping);
    if (!profileGroupings.has(grouping as ProjectPresentationProfile["preferredGrouping"])) throw new Error("project_profile_grouping_invalid");
    output.preferredGrouping = grouping as ProjectPresentationProfile["preferredGrouping"];
  }
  return output;
}

function parseStringList(value: unknown, code: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) throw new Error(code);
  const items = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (items.some((item) => !item || item.length > maxLength)) throw new Error(code);
  return [...new Set(items)];
}

export function applyProjectPresentationProfileOverride(
  derived: ProjectPresentationProfile,
  override: ProjectPresentationProfileOverride,
  revision: number
): ProjectPresentationProfile {
  return {
    ...derived,
    ...override,
    source: "persisted_project_profile",
    revision
  };
}

export function buildProjectPresentationProfile(input: {
  id: string;
  name: string;
  automations: Array<Record<string, unknown>>;
}): ProjectPresentationProfile {
  const text = [input.id, input.name, ...input.automations.flatMap((automation) => [automation.name, automation.goal, automation.automation_type])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/求人|応募|job|application|submit|apply/u.test(text)) {
    return {
      id: input.id,
      kind: "jobs",
      label: "応募・候補管理",
      source: "derived_from_project_automation_catalog",
      primaryMetrics: ["候補件数", "確認待ち", "送信直前", "停止中"],
      widgets: ["kpi", "funnel", "failure_table", "evidence_timeline", "lane_status"],
      preferredGrouping: "stage",
      explanation: "候補から送信直前までの段階と、人間確認が必要な停止点を優先表示します。"
    };
  }
  if (/etsy|printify|商品|commerce|shop|nisenprints/u.test(text)) {
    return {
      id: input.id,
      kind: "commerce",
      label: "商品・公開準備",
      source: "derived_from_project_automation_catalog",
      primaryMetrics: ["商品準備", "公開直前", "既存ID確認", "証跡あり"],
      widgets: ["kpi", "timeline", "failure_table", "evidence_timeline", "lane_status"],
      preferredGrouping: "workflow",
      explanation: "商品準備、各サービスの公開直前、既存IDと証跡を順番に表示します。"
    };
  }
  if (/sns|social|投稿|publish|instagram|twitter|pinterest|daily ai|ニュース/u.test(text)) {
    return {
      id: input.id,
      kind: "social",
      label: "調査・投稿準備",
      source: "derived_from_project_automation_catalog",
      primaryMetrics: ["調査候補", "下書き", "承認待ち", "投稿直前"],
      widgets: ["kpi", "timeline", "calendar", "failure_table", "evidence_timeline"],
      preferredGrouping: "day",
      explanation: "調査から下書き、承認、投稿直前までを時系列と承認状態で表示します。"
    };
  }
  return {
    id: input.id,
    kind: "research",
    label: "調査・状態把握",
    source: "derived_from_project_automation_catalog",
    primaryMetrics: ["新しい情報", "実行件数", "停止中", "データ鮮度"],
    widgets: ["kpi", "timeline", "failure_table", "evidence_timeline", "lane_status"],
    preferredGrouping: "week",
    explanation: "情報源の鮮度、実行履歴、停止理由、確認記録を優先表示します。"
  };
}
