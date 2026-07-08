import { spawn } from "node:child_process";
import { redactSensitiveText } from "../obsidian/redaction.js";

export type CreatePlannerMessage = {
  role: "assistant" | "user";
  text: string;
};

export type CreatePlannerProvider = "auto" | "codex" | "openai" | "local";

export type CreatePlannerResult = {
  source: "local_codex" | "openai" | "local_fallback";
  intent?: "answer_question" | "plan_workflow";
  exactBlocker?: string;
  model?: string;
  title: string;
  reply: string;
  command: string;
  visibleSteps: string[];
  backendChecks: string[];
  answered: string[];
  openQuestions: string[];
  nextAction: string;
  executionDecision: "ask_more" | "save_plan" | "demo_first" | "ready_to_start" | "ready_to_schedule";
  confidence: "low" | "medium" | "high";
};

const fallbackQuestions = {
  cadence: "いつ動かし、失敗したら何分後に再確認しますか？",
  permission: "どこまで自動で進めてよく、どこで止めたいですか？",
  proof: "正本にする画面・URL・DB・保存ファイルと、完了証拠はどれにしますか？"
};

export async function createPlannerResponse(input: {
  messages: CreatePlannerMessage[];
  currentDraft?: string;
  providerOverride?: CreatePlannerProvider;
}): Promise<CreatePlannerResult> {
  const messages = normalizePlannerMessages(input.messages);
  const provider = input.providerOverride ?? plannerProvider();
  if (provider === "local") return buildLocalPlanner(messages, "local_planner_selected");
  if (provider === "codex") {
    try {
      return await callCodexPlanner(messages, input.currentDraft);
    } catch (error) {
      const blocker = error instanceof Error ? error.message : "codex_planner_failed";
      return buildLocalPlanner(messages, blocker);
    }
  }
  if (provider === "auto" && !process.env.OPENAI_API_KEY) return buildLocalPlanner(messages, "openai_api_key_missing");
  if (provider !== "openai" && provider !== "auto") return buildLocalPlanner(messages, "local_planner_selected");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return buildLocalPlanner(messages, "openai_api_key_missing");
  }
  try {
    const result = await callOpenAiPlanner(apiKey, messages, input.currentDraft);
    return result;
  } catch (error) {
    const blocker = error instanceof Error && error.name === "AbortError"
      ? "openai_planner_timeout"
      : error instanceof Error
        ? error.message
        : "openai_planner_failed";
    return buildLocalPlanner(messages, blocker);
  }
}

function plannerProvider() {
  const raw = (process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER ?? "auto").trim().toLowerCase();
  return raw === "codex" || raw === "openai" || raw === "local" ? raw : "auto";
}

export function buildLocalPlanner(messages: CreatePlannerMessage[], exactBlocker = "local_planner"): CreatePlannerResult {
  const userMessages = messages.filter((message) => message.role === "user");
  const latestUserText = userMessages.at(-1)?.text ?? "";
  const conversationText = userMessages.map((message) => message.text).join("\n");
  const lower = conversationText.toLowerCase();
  const facts = detectFacts(conversationText);
  const hasConcreteCadence = hasConcreteCadenceRequest(conversationText);
  const isScheduled = /毎朝|毎日|毎週|定期|schedule|daily|weekly|朝|夜|\b\d{1,2}\s*時|\b\d{1,2}:\d{2}\b/u.test(lower);
  const isSubmit = /応募|申請|送信|submit|apply|フォーム/u.test(lower)
    || (/予約/u.test(conversationText) && !isScheduled);
  const isPublish = isPublishIntent(conversationText);
  const isResearch = /調査|確認|比較|探し|探す|research|watch|チェック|監視/u.test(lower);
  const isSecretStorageOnly = isSecretStorageOnlyRequest(conversationText);
  const isCorrectionAnswerOnly = isCorrectionAnswerOnlyRequest(latestUserText);
  const isCapabilityQuestion = isCapabilityQuestionRequest(latestUserText);
  const isPromptTransferBlockerQuestion = isPromptTransferStatusQuestion(conversationText);
  const isContinuationCandidate = isContinuationRequest(conversationText);
  const isReadOnlyReviewCandidate = isReadOnlyReviewRequest(conversationText) || isPromptTransferBlockerQuestion;
  const explicitReadOnlyContinuation = /読むだけ|読み取りだけ|確認だけ|理由だけ|実行しない|開始しない|動かさず|read-?only/i.test(conversationText);
  const isReadOnlyReview = isReadOnlyReviewCandidate && (!isContinuationCandidate || explicitReadOnlyContinuation);
  const isUiImprovement = isUiImprovementRequest(conversationText, { hasExternalAction: isSubmit || isPublish });
  const isVagueAutomationCreation = isVagueAutomationCreationRequest(latestUserText);
  const isRunContinuation = !isUiImprovement && !isReadOnlyReview && isContinuationCandidate;
  const continuationTarget = extractContinuationTarget(conversationText);
  const hasExternalAction = isSubmit || isPublish;
  const hasExplicitSafeBoundary = /投稿や購入はしない|投稿.*しない|公開.*しない|購入.*しない|送信.*しない|応募.*直前で止め|送信.*直前で止め|投稿.*直前で止め|公開.*直前で止め|読み取り|読むだけ|確認だけ|保存する|保存だけ|証跡|スクショ|URL/iu.test(conversationText);
  const registeredAdjustment = isRunContinuation || isReadOnlyReview ? null : detectRegisteredWorkflowAdjustment(conversationText);
  const isScheduleOnlyRegisteredAdjustment = Boolean(registeredAdjustment && isScheduled && !hasExternalAction);
  const canSaveScheduleOnlyRegisteredAdjustment = Boolean(isScheduleOnlyRegisteredAdjustment && hasConcreteCadence && facts.retry);
  const needsCadenceQuestion = isScheduled ? !hasConcreteCadence : false;
  const needsPermissionQuestion = hasExternalAction ? !facts.permission : !hasExplicitSafeBoundary && !facts.permission;
  const needsProofQuestion = !(facts.proof && facts.source);
  const subject = isSecretStorageOnly
    ? "認証情報の保存"
    : isCapabilityQuestion || isCorrectionAnswerOnly
      ? "Createチャット"
    : isUiImprovement
      ? "Createチャットと画面表示"
      : isReadOnlyReview
        ? summarizeReadOnlySubject(conversationText)
      : registeredAdjustment
    ? registeredAdjustment.subject
    : summarizePlannerSubject(conversationText);
  const actionLabel = isPublish ? "投稿・公開" : isSubmit ? "送信・応募" : isResearch ? "調査・確認" : "実行";
  const answered = (isSecretStorageOnly
    ? ["保存対象", "自動実行しない範囲"]
    : isCapabilityQuestion || isCorrectionAnswerOnly
      ? ["通常質問への回答", "登録workflowの状態確認", "実行計画の作成", "定期実行の調整", "履歴と失敗理由の確認", "証跡付きの実演"]
    : isUiImprovement
      ? ["改善対象の画面", "期待する会話品質"]
      : isReadOnlyReview
        ? ["読み取りだけで確認する範囲", "正本候補"]
      : [
    facts.cadence ? "実行タイミング" : null,
    facts.retry ? "失敗時の扱い" : null,
    facts.permission ? "自動で進める範囲" : null,
    facts.source ? "正本候補" : null,
    facts.proof ? "完了証拠" : null
  ]).filter((label): label is string => Boolean(label));
  const openQuestions = isSecretStorageOnly || isCapabilityQuestion || isCorrectionAnswerOnly || isUiImprovement || isReadOnlyReview || canSaveScheduleOnlyRegisteredAdjustment
    ? []
    : isScheduleOnlyRegisteredAdjustment
      ? [
          hasConcreteCadence && facts.retry ? null : fallbackQuestions.cadence
        ].filter((question): question is string => Boolean(question))
    : [
    needsCadenceQuestion ? fallbackQuestions.cadence : null,
    needsPermissionQuestion ? fallbackQuestions.permission : null,
    needsProofQuestion ? fallbackQuestions.proof : null
  ].filter((question): question is string => Boolean(question));
  const visibleSteps = [
    "目的と完了条件を確認",
    "正本になる画面やデータを読む",
    isScheduled ? "実行タイミングと失敗時の再開条件を決める" : "手動開始から実演して、定期化するか決める",
    hasExternalAction
      ? isSubmit
        ? "応募・送信確定前に会社名、求人URL、入力内容、確認画面を証跡化して止める"
        : "送信・投稿の直前に課金だけ止める境界を置く"
      : "読み取りと保存だけで安全に確認する",
    isResearch ? "見たURL・画面・保存結果を証跡として残す" : "実行結果・画面・後片付けを証跡として残す",
    "小さく実行して結果を確認"
  ];
  const uiImprovementSteps = [
    "違和感のある画面と会話を再現する",
    "固定応答・誤分類・表示崩れを分ける",
    "文言と分岐を小さく直す",
    "本番画面で同じ会話を送り直す",
    "スクショとDOMで表示を確認する"
  ];
  const secretStorageSteps = [
    "秘密情報だけを検出して保存する",
    "チャット本文と保存結果から値を伏せる",
    "自動実行は開始しない",
    "保存済み状態だけを確認する"
  ];
  const readOnlyReviewSteps = [
    "正本になる画面や保存記録を読む",
    "現在の状態と止まっている理由を分ける",
    "不足している確認を短く列挙する",
    "実行や投稿は開始しない",
    "次に必要な操作だけを提案する"
  ];
  const capabilitySteps = [
    "質問にそのまま答える",
    "登録済みworkflowの状態、履歴、失敗理由を確認する",
    "やりたい作業を保存できる計画にする",
    "定期実行の時刻、再試行、停止境界を整理する",
    "保存、実演、開始、定期化を分ける",
    "実行後にrun、画面、ログ、cleanup証跡を確認する"
  ];
  const registeredAdjustmentSteps = registeredAdjustment
    ? isScheduleOnlyRegisteredAdjustment
      ? [
          "対象workflowを読み分ける",
          "実行時刻とリトライ条件を保存する",
          "次回実行予定とRuns反映を確認する",
          "失敗時のexact blockerを残す"
        ]
      : [
        "対象workflowを読み分ける",
        "workflowごとに停止境界を分ける",
        "画面から保存できる調整案にする",
        "1件ずつ小さく実行してRunsで確認する",
        "外部投稿・応募・送信の確定前で止める",
        "証跡とexact blockerを残す"
      ]
    : undefined;
  const continuationSteps = [
    "止まった履歴と保存記録を読む",
    "不足している確認を1つに絞る",
    "手順を修正して小さく再実行する",
    "新しい保存記録で完了判定する"
  ];
  const backendChecks = [
    "source-of-truthを固定して古い履歴を混ぜない",
    "登録workflow変更はSchedule保存・次回予定・Runs反映まで確認する",
    "重い処理はバックグラウンドrunとして開始する",
    "worker pickup待ちと再起動後readbackを分けて確認する",
    "run_idごとにURL・画面・ログ・cleanup証跡を残す",
    "失敗時はexact blockerを保存して同じ場所から再開する"
  ];
  const decision: CreatePlannerResult["executionDecision"] = isSecretStorageOnly
    ? "save_plan"
    : isCapabilityQuestion || isCorrectionAnswerOnly
      ? "demo_first"
    : isUiImprovement
      ? "demo_first"
    : isReadOnlyReview
      ? "demo_first"
    : isRunContinuation && openQuestions.length === 0
    ? "demo_first"
    : openQuestions.length > 1
    ? "ask_more"
    : openQuestions.length === 1
      ? "save_plan"
      : isScheduled
        ? "ready_to_schedule"
        : "demo_first";
  const askMoreNextAction = openQuestions[0]
    ? `まず「${openQuestions[0]}」を確認して、計画を更新します。`
    : "足りない条件を1つずつ聞いて、計画を更新します。";
  const nextAction = isSecretStorageOnly
      ? "値を伏せて保存し、実行は開始しません。"
    : isCorrectionAnswerOnly
      ? "今は動かさず、できることと現在の境界だけを答えます。"
    : isCapabilityQuestion
      ? "やりたい操作を1つ送ると、読むだけ・保存・実演・開始・定期化のどれかに分けます。"
    : isUiImprovement
      ? "本番画面で会話を再現し、違和感を分けて小さく直します。"
    : canSaveScheduleOnlyRegisteredAdjustment
      ? "変更内容を保存し、次回予定とRuns反映を確認します。"
    : isScheduleOnlyRegisteredAdjustment
      ? "実行時刻と失敗時の扱いを確認してから保存します。"
    : registeredAdjustment
      ? "対象workflowごとの停止境界を保存し、1件ずつRunsで確認します。"
    : isReadOnlyReview
      ? "実行を始めず、現在の状態と不足している確認だけを読み直します。"
    : decision === "ask_more"
      ? askMoreNextAction
    : isRunContinuation
      ? "不足している確認を1つだけ見直し、保存記録を残してから再実行します。"
    : decision === "ready_to_schedule"
      ? "保存して画面で実演し、問題なければ定期実行にします。"
      : "保存して一度小さく実演し、証跡を確認してから開始します。";
  const questionBlock = openQuestions.length
    ? ["確認したいこと", ...openQuestions.map((question) => `・${question}`)].join("\n")
    : ["確認できたこと", ...answered.map((label) => `・${label}`), "この内容で一度小さく試せます。"].join("\n");
  const summary = isSecretStorageOnly
    ? "これは、秘密情報を保存するだけで、実行を始めない相談です。"
    : isCapabilityQuestion || isCorrectionAnswerOnly
      ? "このチャットは、相談、計画、保存、実演、開始、定期化、履歴確認を同じ画面で扱う入口です。"
    : isUiImprovement
      ? "これは、Createチャットと画面表示の違和感を実際の会話で再現し、直すための相談です。"
    : isReadOnlyReview
      ? `これは、${subject}を実行せずに読み取り、今の状態と次の確認だけを整理する相談です。`
    : isRunContinuation
      ? `これは、${subject}の止まった実行結果を読み直して、次の一手へ戻す相談です。`
    : hasExternalAction
      ? registeredAdjustment
        ? `これは、${subject}をローカルCodexへ戻らず画面から調整できるようにする相談です。`
        : `これは、${subject}について、状況確認から判断、必要な${actionLabel}までを1本にする自動化です。`
      : isResearch
      ? `これは、${subject}の情報を集めて判断し、証拠を残す自動化です。`
      : `これは、${subject}を小さな手順に分けて実行できる形にする相談です。`;
  const publicSteps = isSecretStorageOnly
    ? secretStorageSteps
    : isCapabilityQuestion || isCorrectionAnswerOnly
      ? capabilitySteps
    : isUiImprovement
      ? uiImprovementSteps
      : registeredAdjustmentSteps ?? (isReadOnlyReview ? readOnlyReviewSteps : isRunContinuation ? continuationSteps : visibleSteps);
  const registeredAdjustmentBlock = registeredAdjustment
    ? [
        "対象ごとの調整",
        ...registeredAdjustment.targets.map((target) => `・${target.label}: ${target.boundary}`)
      ].join("\n")
    : null;
  const metaReply = buildMetaPlannerReply(latestUserText, subject, openQuestions, exactBlocker);
  const promptTransferStatusReply = isPromptTransferBlockerQuestion
    ? [
        "Prompt Transferは、Sheetsへ書き込む前の認証情報で止まっています。",
        "理由: `GOOGLE_SERVICE_ACCOUNT_JSON` または `GOOGLE_APPLICATION_CREDENTIALS` がこの実行環境にありません。",
        "今はSheetsには書き込みません。承認済みsecret laneが用意されたら、対象範囲を再確認してからcommit/readbackを取ります。"
      ].join("\n")
    : null;
  const replyParts = isCorrectionAnswerOnly
    ? [
        "分かりました。今は動かしません。",
        "このチャットでできることだけを整理します。",
        ["できること", ...publicSteps.map((step) => `・${step}`)].join("\n"),
        "投稿、応募、送信、公開、Sheets書き込み、課金、checkout、CAPTCHA/OTP/本人確認は、必要な証跡と人間確認なしでは進めません。",
        ["次の一手", nextAction].join("\n")
      ]
    : isCapabilityQuestion
    ? [
        "できます。このチャットは、質問への回答、登録済み自動化の確認、計画作成、保存、実演、開始、定期化、履歴確認まで扱えます。",
        ["できること", ...publicSteps.map((step) => `・${step}`)].join("\n"),
        "ただし、課金・購入・支払い・checkout、CAPTCHA/OTP/本人確認はここで自動突破せず、人間確認で止めます。",
        ["次の一手", nextAction].join("\n")
      ]
    : isVagueAutomationCreation
      ? [
          "作れます。まだ対象が空なので、先に何を自動化するかだけ決めます。",
          [
            "まず教えてほしいこと",
            "・どの画面、URL、ファイル、DBを見ますか？",
            "・何が見えたら完了ですか？",
            "・保存だけ、実演まで、開始までのどこまで進めますか？"
          ].join("\n"),
          ["仮の進め方", publicSteps.slice(0, 4).join(" → ")].join("\n"),
          ["次の一手", "対象を1文で送ってください。送られた内容を、読むだけ・保存・実演・開始・定期化に分けます。"].join("\n")
        ]
    : [
        promptTransferStatusReply ?? metaReply ?? `${answered.length >= 3 ? "だいぶ具体化できました。" : "いいです。"}${summary}`,
        registeredAdjustmentBlock,
        questionBlock,
        ["進め方", publicSteps.join(" → ")].join("\n"),
        ["次の一手", nextAction].join("\n")
      ];
  return {
    source: "local_fallback",
    intent: isSecretStorageOnly || isCapabilityQuestion || isCorrectionAnswerOnly ? "answer_question" : "plan_workflow",
    exactBlocker,
    title: isRunContinuation ? "止まった実行を次の一手へ戻す" : isSecretStorageOnly ? "認証情報だけを安全に保存する" : isCapabilityQuestion || isCorrectionAnswerOnly ? "Createチャットでできること" : isUiImprovement ? "Createチャットと画面表示を改善する" : isReadOnlyReview ? `${subject}の現在状態を確認する` : isScheduled ? `${subject}の定期実行を設計する` : `${subject}を実行手順に分解する`,
    command: isRunContinuation
      ? `${continuationTarget ? `${continuationTarget}の` : ""}不足している確認を見直して再実行`
      : isCapabilityQuestion || isCorrectionAnswerOnly
        ? "Createチャットでできることを確認"
      : conversationText.trim() || "毎日の作業を相談しながら自動化したい",
    reply: replyParts.filter((part): part is string => Boolean(part)).join("\n\n"),
    visibleSteps: publicSteps,
    backendChecks,
    answered,
    openQuestions,
    nextAction,
    executionDecision: decision,
    confidence: openQuestions.length ? "medium" : "high"
  };
}

function buildMetaPlannerReply(latestUserText: string, subject: string, openQuestions: string[], exactBlocker: string) {
  if (!/テンプレート|同じ回答|毎回同じ|同じ文章|決まった文|決まった返事|定型文|柔軟に返/u.test(latestUserText)) return null;
  const missing = openQuestions[0] ? `今足りないのは「${openQuestions[0]}」です。` : "必要条件はかなり揃っています。";
  const plannerReason = exactBlocker === "openai_api_key_missing"
    ? "外部AIキーが未設定なので、今は保存済みのルールで安全に整理しています。"
    : exactBlocker.startsWith("openai_")
      ? "外部AIが一時的に使えなかったため、今は簡易計画で返しています。"
      : exactBlocker === "local_planner_selected"
        ? "設定で簡易計画を使っているため、保存済みのルールで整理しています。"
        : "今は簡易計画で返しています。";
  return [
    `テンプレートだけではありません。${plannerReason}`,
    `${subject}について新しく分かった条件を入れると、質問・流れ・開始可否を変えます。${missing}`
  ].join("\n");
}

function normalizePlannerMessages(messages: CreatePlannerMessage[]) {
  return messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.text === "string")
    .slice(-16)
    .map((message) => ({
      role: message.role,
      text: redactSensitiveText(message.text).slice(0, 4000)
    }));
}

function detectFacts(text: string) {
  const lower = text.toLowerCase();
  return {
    cadence: /毎朝|毎日|毎週|定期|schedule|daily|weekly|朝|夜|手動開始|今すぐ|一回|\b\d{1,2}\s*時|\b\d{1,2}:\d{2}\b/u.test(lower),
    retry: /失敗|止ま|再開|再試行|リトライ|retry|blocked|error|エラー|\d+\s*分後/u.test(lower),
    permission: /投稿まで|送信まで|応募まで|公開まで|進めて|自動で|止めたい|止めて|直前で止め|条件|許可|していい|してよい/u.test(lower),
    proof: /url|スクショ|画面|db|保存|証拠|証跡|ログ|readback|確認記録/u.test(lower),
    source: /正本|source|queue|キュー|sheet|sheets|db|url|画面|ファイル|daily ai|nisenprints|x\.com|\bX\b|twitter|youtube|etsy|printify/iu.test(text)
  };
}

function hasConcreteCadenceRequest(text: string): boolean {
  return /手動開始|今すぐ|一回|\b\d{1,2}\s*時|\b\d{1,2}:\d{2}\b/iu.test(text);
}

function isPublishIntent(text: string): boolean {
  if (/投稿やSNSの話ではありません|SNSの話ではありません|投稿.*ではありません|公開.*ではありません|投稿.*しない|公開.*しない|購入.*しない|postしない|publishしない|no post|do not post/iu.test(text)) return false;
  return /投稿|公開|publish|post|sns|x\.com|\bX\b|twitter|instagram|threads|pinterest|etsy/iu.test(text);
}

function isContinuationRequest(text: string): boolean {
  return /履歴からの続き相談|実行結果|止まった理由|不足している確認|保存記録|run[_ -]?id|途中で止ま|前回の続き|直前のrun|前の相談|保存済みの結果|run summary|summaryから/u.test(text);
}

function isUiImprovementRequest(text: string, options: { hasExternalAction?: boolean } = {}): boolean {
  const explicitUiIntent = /UI|UX|見た目|使いにく|違和感|導線|レイアウト|表示崩れ|文言|文字.*(大き|小さ|折り返し|切れ|途切れ|崩れ)|折り返し|途切れ|Createチャット|チャット.*改善|Codex app/u.test(text);
  if (explicitUiIntent) return true;
  if (options.hasExternalAction) return false;
  return /UI|UX|見た目|使いにく|違和感|導線|ボタン|フォーム|レイアウト|表示崩れ|文言|文字.*(大き|小さ|折り返し|切れ|途切れ|崩れ)|折り返し|途切れ|Createチャット|チャット.*改善|Codex app/u.test(text);
}

function isSecretStorageOnlyRequest(text: string): boolean {
  return /(api[_\s-]*key|APIキー|token|トークン|secret|秘密|認証情報|DATABASE_URL|接続文字列|GOOGLE_SERVICE_ACCOUNT_JSON|GOOGLE_APPLICATION_CREDENTIALS|private[_\s-]*key)/iu.test(text)
    && /保存したいだけ|保存だけ|実行はしない|実行しない|開始はしない|起動しない/u.test(text);
}

function isCorrectionAnswerOnlyRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const rejectsPlan = /違います|違う|そうではない|それではない/u.test(normalized);
  const explicitlyStopsAction = /今は動かさない|動かさないで|開始しない|実行しない|保存しない|まだやらない/u.test(normalized);
  const asksForStatusOrCapability = /できること|何ができる|なにができる|何までできる|どこまでできる|状況|説明|教えて|書き出|一覧/u.test(normalized);
  const asksToRun = /動かして|開始して|実行して|保存して|投稿して|応募して|送信して|公開して/u.test(normalized)
    && !/動かさない|開始しない|実行しない|保存しない|投稿しない|応募しない|送信しない|公開しない/u.test(normalized);
  return rejectsPlan && explicitlyStopsAction && asksForStatusOrCapability && !asksToRun;
}

function isCapabilityQuestionRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/増やしたい|改善|直したい|修正|追加したい|できるようにしたい|柔軟にしたい|使えるようにしたい/u.test(normalized)) return false;
  const asksCapability = /何ができる|なにができる|何までできる|どこまでできる|どんなことまでできる|どういうことができる|できること|機能|全部書き出|全て書き出|すべて書き出|一覧|チャットで何ができる|チャットでできること/u.test(normalized);
  const rejectsPreviousPlan = /違います|違う|そうではない|それではない|実行手順ではなく|計画ではなく|手順ではなく/u.test(normalized);
  const asksForCapabilitiesOnly = /このチャット|チャット機能|できること|機能|全部|全て|すべて|一覧/u.test(normalized);
  const explicitListRequest = /書き出|一覧|できること|何ができる|なにができる|何までできる|どこまでできる|どんなことまでできる|どういうことができる/u.test(normalized);
  if (asksCapability && asksForCapabilitiesOnly) return true;
  return rejectsPreviousPlan && asksForCapabilitiesOnly && explicitListRequest;
}

function isVagueAutomationCreationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (!/自動化/u.test(normalized)) return false;
  if (!/(作って|作りたい|作成して|作成したい|組んで|追加して)$/u.test(normalized)) return false;
  return !/https?:\/\/|毎朝|毎日|毎週|定期|\b\d{1,2}\s*時|\b\d{1,2}:\d{2}\b|応募|投稿|公開|保存|確認|調査|価格|ニュース|Daily AI|NisenPrints|YouTube|Prompt Transfer|SNS|X\b|Twitter|Etsy|Printify/iu.test(normalized);
}

function isReadOnlyReviewRequest(text: string): boolean {
  const hasReadOnlyIntent = /読むだけ|読み取りだけ|確認したいだけ|確認だけ|調べるだけ|状態を知りたい|今の状態|exact blocker|blockerを確認|動かさず|実行しない|開始しない|理由だけ|read-?only/i.test(text);
  const diagnosticIntent = /失敗を見て|失敗.*原因|ロック原因|lock原因|修正方針|検証を提案|原因なら|提案して|失敗理由/u.test(text);
  const startIntent = /開始したい|実行したい|応募したい|送信したい|投稿したい|公開したい|保存したい/u.test(text);
  if (!hasReadOnlyIntent && !(diagnosticIntent && !startIntent)) return false;
  if (/変更したいわけではなく|変更したい訳ではなく|変更ではなく|変更しない|調整ではなく|保存しない|実行しない|開始しない/u.test(text)) return true;
  if (diagnosticIntent && !startIntent) return true;
  return !/保存したい|調整したい|変更したい|投稿したい|公開したい|送信したい|応募したい/u.test(text);
}

function isPromptTransferStatusQuestion(text: string): boolean {
  return /prompt\s*transfer|転記|sheets?/iu.test(text)
    && /停止理由|止まった理由|止まってる理由|失敗理由|なぜ止ま|理由だけ|書かないで|書き込まないで|実行しない|開始しない/iu.test(text);
}

function summarizePlannerSubject(text: string): string {
  const cleaned = text
    .replace(/^\s*(投稿はしない|投稿しない|公開はしない|公開しない|postしない|publishしない|no post|do not post)[。.!?！？\s]*/iu, "")
    .replace(/\s+/g, " ")
    .replace(/[。.!?！？].*$/u, "")
    .trim();
  if (!cleaned) return "この作業";
  const targets = extractWorkflowTargets(cleaned);
  if (targets.length > 1) return targets.map((target) => target.label).join("・");
  if (targets.length === 1) return targets[0].label;
  if (/aiニュース|AIニュース|ニュース/u.test(cleaned) && /投稿|公開|publish|post/u.test(cleaned)) return "AIニュース調査と投稿確認";
  if (/aiニュース|AIニュース|ニュース/u.test(cleaned)) return "AIニュース調査";
  if (/求人|応募|job|application/i.test(cleaned)) return "求人応募";
  if (/x\.com|\bX\b|twitter|linkedin|sns/i.test(cleaned)) return "SNS投稿";
  if (/画像|image|生成/u.test(cleaned)) return "画像生成";
  return cleanPlannerSubject(cleaned);
}

function cleanPlannerSubject(text: string): string {
  const withoutRequestTail = text
    .replace(/を?(作りたい|作って|作成したい|作成して|したい|してください|してほしい|する)$/u, "")
    .replace(/(自動化)を?(作りたい|作って|作成したい|作成して)$/u, "$1")
    .replace(/[、,]\s*(投稿や購入はしない|投稿はしない|購入はしない|実行しない|保存だけ).*$/u, "")
    .replace(/[をの]\s*$/u, "")
    .trim();
  const clipped = withoutRequestTail.slice(0, 40).replace(/自$/u, "自動化");
  return clipped.replace(/[をの]\s*$/u, "").trim() || "この作業";
}

function summarizeReadOnlySubject(text: string): string {
  return summarizePlannerSubject(text)
    .replace(/を?(確認|調査|チェック)(したい|する)?$/u, "")
    .replace(/の?exact blocker$/iu, "のexact blocker")
    .trim() || "この作業";
}

function detectRegisteredWorkflowAdjustment(text: string) {
  const matchedTargets = extractWorkflowTargets(text);
  const wantsAdjustment = hasAdjustmentIntent(text);
  if (!wantsAdjustment || matchedTargets.length === 0) return null;
  return {
    subject: matchedTargets.length === 1
      ? `${matchedTargets[0].label}の登録workflow`
      : `${matchedTargets.map((target) => target.label).join("・")}の登録workflow`,
    targets: matchedTargets
  };
}

function extractWorkflowTargets(text: string) {
  const targets = [
    {
      patterns: [/daily\s*ai/i, /Daily AI/u, /デイリーAI/u],
      label: "Daily AI",
      boundary: "投稿・公開の直前でURL、投稿本文、画面、run証跡を確認してから進める"
    },
    {
      patterns: [/sns/i, /social/i, /instagram/i, /threads/i, /pinterest/i, /\bX\b/u, /twitter/i],
      label: "SNS",
      boundary: "各SNSの投稿確定前にcomposer、添付画像、本文、投稿先アカウントを証跡化して止める"
    },
    {
      patterns: [/nisenprints/i, /etsy/i, /printify/i],
      label: "NisenPrints",
      boundary: "商品作成、Printify、Etsy、Pinterestの公開確定前にプレビューと保存結果を確認する"
    },
    {
      patterns: [/応募/u, /求人/u, /job/i, /application/i, /submit/i, /apply/i],
      label: "応募",
      boundary: "応募・送信確定前に会社名、求人URL、入力内容、確認画面を証跡化して止める"
    },
    {
      patterns: [/転記/u, /prompt\s*transfer/i, /sheets?/i],
      label: "転記",
      boundary: "Sheets書き込み前後の差分、対象Docs、対象Sheet、保存readbackを確認する"
    },
    {
      patterns: [/youtube/i, /transcript/i, /文字起こし/u],
      label: "YouTube",
      boundary: "transcript取得、保存artifact、Obsidian反映、Daily AI候補化の可否をreadbackする"
    }
  ];
  return targets.filter((target) => target.patterns.some((pattern) => pattern.test(text)));
}

function hasAdjustmentIntent(text: string): boolean {
  if (/調整ではなく|変更しない|読むだけ|確認したいだけ|保存しない|実行しない/u.test(text)) return false;
  if (/定期実行.*(変えたい|変更したい|変更|変える|して|する)|毎朝.*(変えたい|変更したい|変更|変える|して|する)|(?:^|[^\d])\d{1,2}\s*時.*(変えたい|変更したい|変更|変える|して|する)|時刻.*(変えたい|変更したい|変更|変える|して|する)/u.test(text)) return true;
  if (extractWorkflowTargets(text).length > 0 && /毎朝|毎日|毎週|定期|(?:^|[^\d])\d{1,2}\s*時|\d{1,2}:\d{2}/u.test(text) && /(して|する|設定|保存|変え|変更)/u.test(text)) return true;
  return /調整|変更点|保存できる|保存したい|分けたい|まとめて相談|停止境界|外部.*確定.*前|画面から/u.test(text)
    || (/登録済み|workflow/u.test(text) && /変更点|変更したい|変えたい|保存できる|保存したい|分けたい|停止境界|止める形/u.test(text));
}

function extractContinuationTarget(text: string) {
  const match = text.match(/対象:\s*([^\n]+)/u);
  return match?.[1]?.trim().slice(0, 40) ?? "";
}

async function callOpenAiPlanner(apiKey: string, messages: CreatePlannerMessage[], currentDraft?: string): Promise<CreatePlannerResult> {
  const model = process.env.OPENAI_PLANNER_MODEL ?? process.env.AUTOMATION_OS_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const timeoutMs = boundedTimeout(process.env.AUTOMATION_OS_OPENAI_PLANNER_TIMEOUT_MS, 8_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: plannerSystemPrompt() },
        { role: "user", content: JSON.stringify({ messages, currentDraft: currentDraft ? redactSensitiveText(currentDraft).slice(0, 4000) : "" }) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "automation_os_create_plan",
          strict: true,
          schema: plannerJsonSchema()
        }
      }
    })
  }).finally(() => clearTimeout(timer));
  if (!response.ok) {
    throw new Error(`openai_${response.status}`);
  }
  const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string; type?: string }> }> };
  const outputText = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).map((content) => content.text ?? "").join("\n") ?? "";
  const parsed = JSON.parse(outputText) as Omit<CreatePlannerResult, "source" | "model">;
  return sanitizePlannerResult({ ...parsed, source: "openai", model }, messages);
}

async function callCodexPlanner(messages: CreatePlannerMessage[], currentDraft?: string): Promise<CreatePlannerResult> {
  const bin = process.env.AUTOMATION_OS_CODEX_PLANNER_BIN ?? process.env.AUTOMATION_OS_CODEX_BIN ?? "codex";
  const timeoutMs = boundedTimeout(process.env.AUTOMATION_OS_CODEX_PLANNER_TIMEOUT_MS, 25_000);
  const prompt = [
    plannerSystemPrompt(),
    "必ずJSONだけを返してください。Markdown、説明文、コードブロックは禁止です。",
    "JSON Schema:",
    JSON.stringify(plannerJsonSchema()),
    "Input:",
    JSON.stringify({ messages, currentDraft: currentDraft ? redactSensitiveText(currentDraft).slice(0, 4000) : "" })
  ].join("\n\n");
  const stdout = await runCodexPlanner(bin, ["exec", "--sandbox", "read-only", "--cd", process.cwd(), prompt], timeoutMs);
  const parsed = JSON.parse(extractJsonObject(stdout)) as Omit<CreatePlannerResult, "source">;
  return sanitizePlannerResult({ ...parsed, source: "local_codex", model: "codex-cli" }, messages);
}

function runCodexPlanner(bin: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_CREATE_PLANNER_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("codex_planner_timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.includes("command not found") ? "codex_planner_unavailable" : `codex_planner_exit_${code ?? "unknown"}`));
    });
  });
}

function extractJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("codex_planner_json_missing");
}

function boundedTimeout(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(3_000, Math.min(60_000, parsed));
}

function sanitizePlannerResult(result: CreatePlannerResult, messages?: CreatePlannerMessage[]): CreatePlannerResult {
  const fallback = buildLocalPlanner(messages?.length ? messages : [{ role: "user", text: result.command || "" }], "openai_schema_sanitized");
  const localSafetyResult = externallyStablePlannerResult(result, fallback);
  if (localSafetyResult) return localSafetyResult;
  const requestedExecutionDecision = ["ask_more", "save_plan", "demo_first", "ready_to_start", "ready_to_schedule"].includes(result.executionDecision)
    ? result.executionDecision
    : fallback.executionDecision;
  const shouldUseFallbackSafety = requestedExecutionDecision === "ready_to_schedule" && fallback.openQuestions.length > 0 && fallback.executionDecision !== "ready_to_schedule";
  const executionDecision = shouldUseFallbackSafety ? fallback.executionDecision : requestedExecutionDecision;
  const confidence = ["low", "medium", "high"].includes(result.confidence) ? result.confidence : fallback.confidence;
  const backendChecks = mergeBackendChecks(
    stringArrayOr(result.backendChecks, fallback.backendChecks, 8, 160),
    executionDecision === "ready_to_schedule" ? fallback.backendChecks : []
  );
  return {
    source: result.source,
    exactBlocker: result.exactBlocker,
    model: result.model,
    intent: result.intent === "answer_question" ? "answer_question" : "plan_workflow",
    title: stringOr(result.title, fallback.title, 90),
    reply: stringOr(result.reply, fallback.reply, 2400),
    command: stringOr(result.command, fallback.command, 1200),
    visibleSteps: stringArrayOr(result.visibleSteps, fallback.visibleSteps, 8, 120),
    backendChecks,
    answered: stringArrayOr(result.answered, fallback.answered, 8, 80),
    openQuestions: shouldUseFallbackSafety ? fallback.openQuestions : stringArrayOr(result.openQuestions, fallback.openQuestions, 5, 180),
    nextAction: shouldUseFallbackSafety ? fallback.nextAction : stringOr(result.nextAction, fallback.nextAction, 240),
    executionDecision,
    confidence
  };
}

function externallyStablePlannerResult(result: CreatePlannerResult, fallback: CreatePlannerResult): CreatePlannerResult | null {
  const commandText = fallback.command || result.command || "";
  const localIsCapabilityAnswer = fallback.intent === "answer_question";
  const localIsSecretOnly = fallback.title === "認証情報だけを安全に保存する";
  const localIsUiImprovement = fallback.title === "Createチャットと画面表示を改善する";
  const localIsVagueAutomationCreation = fallback.intent === "plan_workflow"
    && fallback.openQuestions.length > 0
    && /新しい自動化/u.test(fallback.title)
    && /対象が空/u.test(fallback.reply);
  const explicitReadOnlyBoundary = /読むだけ|読み取りだけ|確認だけ|理由だけ|投稿や購入はしない|投稿.*しない|公開.*しない|購入.*しない|送信.*しない|実行しない|開始しない|動かさず|書かないで|read-?only/iu.test(commandText);
  const localIsReadOnly = fallback.openQuestions.length === 0
    && (explicitReadOnlyBoundary
      || /現在状態を確認する/u.test(fallback.title)
      || fallback.visibleSteps.includes("実行や投稿は開始しない"));
  const localHasDangerousStopBoundary = fallback.openQuestions.length === 0
    && fallback.visibleSteps.some((step) => /応募・送信確定前|送信・投稿の直前|外部投稿・応募・送信の確定前/u.test(step));

  if (!localIsCapabilityAnswer && !localIsSecretOnly && !localIsUiImprovement && !localIsVagueAutomationCreation && !localIsReadOnly && !localHasDangerousStopBoundary) {
    return null;
  }

  return {
    ...fallback,
    source: result.source,
    exactBlocker: result.exactBlocker,
    model: result.model,
    backendChecks: mergeBackendChecks(fallback.backendChecks, stringArrayOr(result.backendChecks, [], 8, 160))
  };
}

function mergeBackendChecks(primary: string[], required: string[]) {
  return [...new Set([...required, ...primary])].slice(0, 8);
}

function stringOr(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === "string" ? redactSensitiveText(value).trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function stringArrayOr(value: unknown, fallback: string[], maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => typeof item === "string" ? redactSensitiveText(item).trim() : "")
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
  return items.length ? items : fallback;
}

function plannerSystemPrompt() {
  return [
    "あなたはAutomation OSの作成画面のplannerです。",
    "日本語で、会話履歴を踏まえて、追加質問、計画更新、実行判断を動的に返します。",
    "まだ不足がある場合はopenQuestionsに入れ、実行可能性はexecutionDecisionで返します。",
    "単なる質問や、このチャットでできることを聞く内容は、intentをanswer_questionにして、保存・実演・開始を促す計画にしません。",
    "履歴や実行結果が含まれる場合は、止まった理由、不足している証跡、次の再実行前確認を反映して計画を更新します。",
    "外部投稿、送信、応募、公開、削除、保存は必要な文脈と証跡設計がある時だけ計画に入れます。",
    "課金、購入、支払い、決済、checkoutだけはhard stopです。",
    "秘密値、token、API key、cookie、個人情報は出力しません。",
    "画面に出るreplyとvisibleStepsは人間の言葉にし、内部用語はbackendChecksだけに入れます。"
  ].join("\n");
}

function plannerJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "title", "reply", "command", "visibleSteps", "backendChecks", "answered", "openQuestions", "nextAction", "executionDecision", "confidence"],
    properties: {
      intent: { type: "string", enum: ["answer_question", "plan_workflow"] },
      title: { type: "string" },
      reply: { type: "string" },
      command: { type: "string" },
      visibleSteps: { type: "array", items: { type: "string" } },
      backendChecks: { type: "array", items: { type: "string" } },
      answered: { type: "array", items: { type: "string" } },
      openQuestions: { type: "array", items: { type: "string" } },
      nextAction: { type: "string" },
      executionDecision: { type: "string", enum: ["ask_more", "save_plan", "demo_first", "ready_to_start", "ready_to_schedule"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] }
    }
  };
}
