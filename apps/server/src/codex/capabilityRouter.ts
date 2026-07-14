import type { CodexCapabilitiesSummary } from "./capabilities.js";
import type { TrustedBridgeAction } from "../bridge/trustedBridge.js";

export type CapabilityRouteStatus = "ready" | "partial" | "missing";
export type CapabilityRouteAuthority = "catalog" | "runtime" | "connected";
export type CapabilityRouteProof = "none" | "read_only" | "receipt";
export type CapabilityRoute = {
  id: string;
  label: string;
  status: CapabilityRouteStatus;
  lane: string;
  nextAction: string;
  evidence: string[];
  signals: string[];
  authority: CapabilityRouteAuthority;
  proof: CapabilityRouteProof;
};

export type CapabilityGap = {
  id: string;
  label: string;
  priority: "high" | "medium" | "low";
  status: "not_connected" | "partly_connected" | "manual_only" | "legacy_lane";
  why: string;
  nextAction: string;
  action: {
    kind: "create";
    label: string;
    view: "Create" | "Sources" | "Runs";
    command?: string;
    routeId?: string;
  };
};

export type CapabilityRouterSnapshot = {
  generatedAt: string;
  command: string;
  primaryAction: string;
  recommendedRoutes: CapabilityRoute[];
  gapBacklog: CapabilityGap[];
  counts: {
    ready: number;
    partial: number;
    missing: number;
    gaps: number;
  };
};

type RouterInput = {
  command?: string;
  capabilities: CodexCapabilitiesSummary;
  bridgeActions: TrustedBridgeAction[];
};

export function buildCapabilityRouterSnapshot(input: RouterInput): CapabilityRouterSnapshot {
  const command = normalizeCommand(input.command);
  const context = analyzeCommand(command);
  const routes = buildRoutes(input, context);
  const gaps = buildGapBacklog(input, context);
  const sortedRoutes = routes.sort(routeRank).slice(0, 8);
  return {
    generatedAt: new Date().toISOString(),
    command,
    primaryAction: choosePrimaryAction(sortedRoutes, gaps),
    recommendedRoutes: sortedRoutes,
    gapBacklog: gaps.sort(gapRank).slice(0, 14),
    counts: {
      ready: routes.filter((route) => route.status === "ready").length,
      partial: routes.filter((route) => route.status === "partial").length,
      missing: routes.filter((route) => route.status === "missing").length,
      gaps: gaps.length
    }
  };
}

function buildRoutes(input: RouterInput, context: CommandContext): CapabilityRoute[] {
  if (!context.hasCommand) return [];

  const routes: CapabilityRoute[] = [];
  const skillNames = new Set(input.capabilities.capabilities.skills.map((skill) => cleanName(skill.name)));
  const bridgeIds = new Set(input.bridgeActions.map((action) => action.id));
  const chromeState = input.capabilities.capabilities.chrome.state;
  const automationOsApiState = input.capabilities.capabilities.automationOsApi.state;
  const browserConnected = chromeState.connected;

  if (context.urls.length > 0) {
    routes.push({
      id: "web_url_capture",
      label: "Webリンクを保存して読む",
      status: "ready",
      lane: "Web capture",
      nextAction: "Research PlannerのWeb確認またはObsidian URL保存に回す",
      evidence: ["取得結果", "保存先ノート", "停止理由"],
      signals: context.urls.map((url) => url.host),
      authority: "catalog",
      proof: "read_only"
    });
  }

  if (context.youtubeUrls.length > 0) {
    routes.push({
      id: "youtube_transcript_capture",
      label: "YouTube台本を取得する",
      status: "ready",
      lane: "YouTube transcript lane",
      nextAction: "公式の台本表示からテキストを取得して調査証跡にする",
      evidence: ["台本テキスト", "取得manifest", "停止理由"],
      signals: context.youtubeUrls.map((url) => url.href),
      authority: "catalog",
      proof: "read_only"
    });
  }

  if (context.xStatusUrls.length > 0) {
    routes.push({
      id: "x_authenticated_capture",
      label: "X投稿を読み取り保存する",
      status: browserConnected ? "ready" : "partial",
      lane: "X read-only lane",
      nextAction: "投稿URLをX captureへ渡し、レビューキューへ接続する",
      evidence: ["投稿本文", "capture manifest", "レビュー候補"],
      signals: context.xStatusUrls.map((url) => url.href),
      authority: browserConnected ? "connected" : "catalog",
      proof: browserConnected ? "read_only" : "none"
    });
  }

  if (context.pdfUrls.length > 0 || context.hasPdfIntent) {
    routes.push({
      id: "pdf_skill",
      label: "PDFを読む・確認する",
      status: skillNames.has("pdf") || skillNames.has("\"pdf\"") ? "partial" : "missing",
      lane: "PDF skill",
      nextAction: "PDF SkillをAutomation OSの添付/URL入力から呼べるようにする",
      evidence: ["抽出テキスト", "ページ画像確認", "レイアウト所見"],
      signals: context.pdfUrls.map((url) => url.href).concat(context.hasPdfIntent ? ["pdf-intent"] : []),
      authority: "catalog",
      proof: "read_only"
    });
  }

  if (context.hasImagePromptIntent && skillNames.has("web-to-image-prompts")) {
    routes.push({
      id: "web_to_image_prompts",
      label: "画像生成promptを作る",
      status: "partial",
      lane: "Prompt brief skill",
      nextAction: "Web/スクショ/調査結果をvisual briefへ変換する",
      evidence: ["参照元", "visual brief", "生成prompt"],
      signals: ["image-prompt-intent"],
      authority: "catalog",
      proof: "none"
    });
  }

  if (context.hasPriceIntent && skillNames.has("price-checker")) {
    routes.push({
      id: "price_checker",
      label: "価格を確認する",
      status: "partial",
      lane: "Price checker skill",
      nextAction: "Playwright版価格確認runnerへ移植してから実行導線に入れる",
      evidence: ["価格候補", "画面確認", "cleanup"],
      signals: ["price-intent"],
      authority: "catalog",
      proof: "none"
    });
  }

  if (context.hasVideoIntent && skillNames.has("video-frame-reader")) {
    routes.push({
      id: "video_frame_reader",
      label: "録画を読んで失敗箇所を見る",
      status: "partial",
      lane: "Video frame reader",
      nextAction: "最新の録画/スクショ列を読み、失敗stageを診断する",
      evidence: ["キーフレーム", "画面所見", "修復対象"],
      signals: ["video-intent"],
      authority: "catalog",
      proof: "none"
    });
  }

  if (context.hasKnowledgeIntent && bridgeIds.has("second_brain_process")) {
    routes.push({
      id: "second_brain_process",
      label: "保存したメモを整理する",
      status: automationOsApiState.connected ? "ready" : "partial",
      lane: "Second Brain bridge",
      nextAction: "Obsidian inboxを安全に分類候補へ進める",
      evidence: ["処理件数", "更新候補", "停止理由"],
      signals: ["knowledge-intent"],
      authority: automationOsApiState.connected ? "connected" : "runtime",
      proof: "receipt"
    });
  }

  if (context.hasReuseIntent) {
    routes.push({
      id: "skill_factory",
      label: "成功した作業を再利用化する",
      status: "partial",
      lane: "Skill Factory",
      nextAction: "完了runからSkill下書きを作り、手動昇格待ちにする",
      evidence: ["完了run", "下書き", "必要証跡"],
      signals: ["reuse-intent"],
      authority: "catalog",
      proof: "none"
    });
  }

  return routes;
}

function buildGapBacklog(input: RouterInput, context: CommandContext): CapabilityGap[] {
  const skillNames = new Set(input.capabilities.capabilities.skills.map((skill) => cleanName(skill.name)));
  const pluginNames = new Set(input.capabilities.capabilities.plugins.map((plugin) => cleanName(plugin.name)));
  const gaps: CapabilityGap[] = [
    {
      id: "chat_capability_router",
      label: "チャットから能力を自動選択する",
      priority: "high",
      status: "partly_connected",
      why: "通常チャットがResearch Planner中心で、Skill/bridge/connector全体へ自動振り分けしきれていない",
      nextAction: "このRouterの結果をCreate、Run開始、Goal resumeの入口で必ず表示・保存する",
      action: createGapAction("自動で使える道具を選んで、この依頼を実行して")
    },
    {
      id: "youtube_discovery",
      label: "YouTubeを自分で探して台本化する",
      priority: "high",
      status: context.hasYouTubeIntent && context.youtubeUrls.length === 0 ? "not_connected" : "partly_connected",
      why: "動画リンクから台本取得はあるが、検索して候補を選ぶ導線がない",
      nextAction: "YouTube検索候補取得、評価、台本取得、比較要約を1つのResearch sourceにする",
      action: createGapAction("YouTubeで候補を探して、台本化できる動画を比較して")
    },
    {
      id: "x_discovery_review_queue",
      label: "Xから良い投稿を探してレビューする",
      priority: "high",
      status: context.hasXIntent && context.xStatusUrls.length === 0 ? "not_connected" : "partly_connected",
      why: "投稿URL captureとreview CLIはあるが、検索・候補収集・チャット起動がつながっていない",
      nextAction: "X検索/URL収集をread-onlyで実装し、X Capture Review Queueへ流す",
      action: createGapAction("Xで関連投稿を探して、良さそうな候補をレビューキューに整理して")
    },
    {
      id: "reddit_mcp_api_sources",
      label: "Reddit・連携先・公式APIを実captureにする",
      priority: "high",
      status: "not_connected",
      why: "Research Plannerのsource名はあるが、Web/YouTube以外のcapture proofがない",
      nextAction: "Reddit公開スレッド、MCP inventory、API契約確認をsource別proofとして追加する",
      action: createGapAction("Reddit、公式API、連携先から公開情報を調べて、証跡付きで整理して")
    },
    {
      id: "price_checker_playwright",
      label: "価格チェックをPlaywright化する",
      priority: "medium",
      status: skillNames.has("price-checker") ? "legacy_lane" : "not_connected",
      why: "price-checker SkillはあるがBrowser Use前提で、現在のprimary laneとずれている",
      nextAction: "Playwright CLIで価格・スクショ・DOM・cleanup proofを保存するrunnerへ移植する",
      action: createGapAction("この商品の価格をPlaywrightで確認して、証跡付きで保存して")
    },
    {
      id: "image_prompt_pipeline",
      label: "調査結果から画像promptを作る",
      priority: "medium",
      status: skillNames.has("web-to-image-prompts") ? "manual_only" : "not_connected",
      why: "画像prompt SkillはあるがDaily AI/NisenPrints/SNSの制作導線に接続されていない",
      nextAction: "Research resultからvisual briefを生成し、NisenPrints/Daily AI/SNSへ渡す",
      action: createGapAction("調査結果から画像生成プロンプトとvisual briefを作って")
    },
    {
      id: "video_failure_diagnosis",
      label: "録画から失敗stageを診断する",
      priority: "medium",
      status: skillNames.has("video-frame-reader") ? "manual_only" : "not_connected",
      why: "録画/Gemini QAは補助証跡だが、失敗時の自動診断導線が薄い",
      nextAction: "失敗runの録画/スクショ列をVideo Frame Readerへ渡すrepair hintを作る",
      action: createGapAction("最新の失敗録画とスクショから、どのstageで止まったか診断して")
    },
    {
      id: "reflector_overseer_loop",
      label: "完了後に未統合能力を自動で拾う",
      priority: "medium",
      status: skillNames.has("reflector") || skillNames.has("overseer") ? "manual_only" : "not_connected",
      why: "Reflector/Overseerはあるが、毎回の完了後レビューに自動接続されていない",
      nextAction: "完了/blocked時にCapability gapとSkill改善候補を生成してSTATE/Obsidianへ残す",
      action: createGapAction("直近の完了/停止runを振り返って、未統合能力とSkill改善候補を出して")
    }
  ];

  if (pluginNames.has("gmail") || pluginNames.has("google-drive") || pluginNames.has("google-calendar")) {
    gaps.push({
      id: "workspace_connectors_router",
      label: "Gmail/Drive/Calendarを用途別に使う",
      priority: "medium",
      status: "manual_only",
      why: "connectorは見えているが、応募後・資料・予定のread-only確認へ自動提案されない",
      nextAction: "求人返信、添付資料、面接予定をread-only inventoryからWorkflowへ渡す",
      action: createGapAction("Gmail、Drive、Calendarから応募後の返信・資料・予定を確認して整理して")
    });
  }
  if (pluginNames.has("canva") || pluginNames.has("shopify") || pluginNames.has("supabase")) {
    gaps.push({
      id: "commerce_design_connectors_router",
      label: "Canva/Shopify/Supabaseを必要時だけ提案する",
      priority: "low",
      status: "manual_only",
      why: "connectorはあるが、NisenPrintsや商品管理へ安全に接続する判断層がない",
      nextAction: "課金/購入/支払い/checkoutだけを停止し、それ以外はreadback証跡つきでWorkflowへ渡す",
      action: createGapAction("Canva、Shopify、Supabaseの使える情報を確認して、商品制作導線へつなげて")
    });
  }
  return gaps;
}

function createGapAction(command: string): CapabilityGap["action"] {
  return {
    kind: "create",
    label: "作成へ",
    view: "Create",
    command
  };
}

type CommandContext = {
  hasCommand: boolean;
  urls: URL[];
  youtubeUrls: URL[];
  xStatusUrls: URL[];
  pdfUrls: URL[];
  hasYouTubeIntent: boolean;
  hasXIntent: boolean;
  hasPdfIntent: boolean;
  hasPriceIntent: boolean;
  hasImagePromptIntent: boolean;
  hasVideoIntent: boolean;
  hasKnowledgeIntent: boolean;
  hasReuseIntent: boolean;
};

function analyzeCommand(command: string): CommandContext {
  const urls = extractUrls(command);
  const lower = command.toLowerCase();
  return {
    hasCommand: command.length > 0,
    urls,
    youtubeUrls: urls.filter((url) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)),
    xStatusUrls: urls.filter((url) => /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname) && /\/status\//.test(url.pathname)),
    pdfUrls: urls.filter((url) => url.pathname.toLowerCase().endsWith(".pdf")),
    hasYouTubeIntent: /youtube|youtu\.be|動画|台本|字幕/i.test(command),
    hasXIntent: /\bx\b|twitter|ツイート|投稿|スレッド/i.test(lower),
    hasPdfIntent: /pdf|履歴書|職務経歴書|資料|契約書/i.test(command),
    hasPriceIntent: /価格|値段|price|料金|商品/i.test(command),
    hasImagePromptIntent: /画像|prompt|プロンプト|サムネ|visual|ビジュアル|nisenprints/i.test(lower),
    hasVideoIntent: /録画|動画|video|gemini|画面確認|失敗箇所/i.test(command),
    hasKnowledgeIntent: /obsidian|メモ|知識|整理|second brain|振り返/i.test(lower),
    hasReuseIntent: /skill|スキル|再利用|テンプレ|自動化にして|workflow|ワークフロー/i.test(lower)
  };
}

function extractUrls(command: string): URL[] {
  return [...command.matchAll(/https?:\/\/[^\s"'<>）)]+/g)]
    .flatMap((match) => {
      try {
        return [new URL(match[0])];
      } catch {
        return [];
      }
    });
}

function choosePrimaryAction(routes: CapabilityRoute[], gaps: CapabilityGap[]): string {
  const ready = routes.find((route) => route.status === "ready");
  if (ready) return ready.nextAction;
  const partial = routes.find((route) => route.status === "partial");
  if (partial) return partial.nextAction;
  return gaps[0]?.nextAction ?? "使える能力を確認して、未接続の導線をbacklogに残す";
}

function routeRank(a: CapabilityRoute, b: CapabilityRoute): number {
  const statusRank = { ready: 0, partial: 1, missing: 2 };
  const authorityRank = { connected: 0, runtime: 1, catalog: 2 };
  const proofRank = { receipt: 0, read_only: 1, none: 2 };
  return (
    statusRank[a.status] - statusRank[b.status] ||
    authorityRank[a.authority] - authorityRank[b.authority] ||
    proofRank[a.proof] - proofRank[b.proof] ||
    a.label.localeCompare(b.label)
  );
}

function gapRank(a: CapabilityGap, b: CapabilityGap): number {
  const priorityRank = { high: 0, medium: 1, low: 2 };
  return priorityRank[a.priority] - priorityRank[b.priority] || a.label.localeCompare(b.label);
}

function cleanName(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function normalizeCommand(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 2000) : "";
}
