import { createHash } from "node:crypto";
import { getWebOperationContract, type WebOperationIntentKind } from "./webOperationContract.js";

export const WEB_OPERATION_INTAKE_SCHEMA_V1 = "automation_os_web_operation_intake.v1" as const;

export type WebOperationIntakeStatus = "not_applicable" | "needs_input" | "ready_for_read" | "approval_required" | "blocked";

export type WebOperationIntakeV1 = {
  schema: typeof WEB_OPERATION_INTAKE_SCHEMA_V1;
  applicable: boolean;
  status: WebOperationIntakeStatus;
  operation: WebOperationIntentKind | null;
  site_or_url: string | null;
  account_ref: string | null;
  semantic_target: string | null;
  payload_hash: string | null;
  payload_present: boolean;
  scope: string | null;
  missing_fields: string[];
  questions: string[];
  fixed_locator_detected: boolean;
  exact_blocker: string | null;
  next_stage: "not_applicable" | "clarify" | "read" | "approval";
  external_action_executed: false;
  readback_required: true;
  no_replay: true;
  web_operation_contract: ReturnType<typeof getWebOperationContract>;
};

const OPERATION_LABELS: Array<{ operation: WebOperationIntentKind; pattern: RegExp }> = [
  { operation: "read", pattern: /読む|閲覧|確認|調査|検索|読み取り|read|review|inspect/iu },
  { operation: "create", pattern: /作成|新規|登録|create/iu },
  { operation: "update", pattern: /更新|編集|変更|保存|update|edit/iu },
  { operation: "publish", pattern: /投稿|公開|publish|post/iu },
  { operation: "submit", pattern: /送信|応募|申請|submit|apply|フォーム/iu },
  { operation: "delete", pattern: /削除|delete/iu }
];

const PLACEHOLDER = /^(?:\s*|未入力|ここに.*|例[:：].*|なし|none|n\/a)$/iu;

const FIELD_LABEL_SOURCES = [
  "目的", "purpose", "サイトまたはURL", "操作先", "サイト", "URL", "site(?:\\s+or\\s+url)?",
  "会社とアカウント", "サービスとアカウント", "利用アカウント", "会社", "account(?:\\s+ref)?", "account",
  "対象(?:（[^\\n]*）)?", "操作対象", "対象ページ", "target",
  "内容(?:（[^\\n]*）)?", "本文", "投稿文", "メッセージ", "文章", "payload", "content",
  "公開先・送信先・対象範囲", "対象範囲", "公開先", "送信先", "送付先", "宛先", "チャンネル", "channel", "audience", "destination", "scope",
] as const;
const FIELD_LABEL_PATTERN = FIELD_LABEL_SOURCES.join("|");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineValue(text: string, labels: string[]): string {
  const label = labels.join("|");
  const match = text.match(new RegExp(
    `(?:^|\\n)\\s*(?:[-*・]\\s*)?(?:\\*\\*)?(?:${label})(?:\\*\\*)?\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*・]\\s*)?(?:\\*\\*)?(?:${FIELD_LABEL_PATTERN})(?:\\*\\*)?\\s*[:：]|$)`,
    "iu",
  ));
  const value = match?.[1]?.trim() ?? "";
  return PLACEHOLDER.test(value) ? "" : value.slice(0, 1000);
}

function normalizedUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s<>"']+/iu);
  if (!match) return value ? value.slice(0, 240) : null;
  try {
    return new URL(match[0]).origin;
  } catch {
    return null;
  }
}

function firstUrlFromText(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s<>"'「」『』【】]+/iu);
  if (!match) return null;
  return normalizedUrl(match[0].replace(/[.,!?;:、。。，；：）」』】]+$/u, ""));
}

function operationFromText(text: string, purpose: string): WebOperationIntentKind | null {
  if (/\b(?:read|create|update|publish|submit|delete)\s*\/\s*(?:read|create|update|publish|submit|delete)\b/iu.test(purpose)) return null;
  const explicit = purpose.match(/^\s*(read|create|update|publish|submit|delete)\s*$/iu)?.[1]?.toLowerCase();
  if (explicit && ["read", "create", "update", "publish", "submit", "delete"].includes(explicit)) {
    return explicit as WebOperationIntentKind;
  }
  const candidates = OPERATION_LABELS
    .filter((candidate) => candidate.pattern.test(purpose || text))
    .map((candidate) => candidate.operation);
  return new Set(candidates).size === 1 ? candidates[0] : null;
}

function targetFromText(target: string): string | null {
  return target || null;
}

function isApplicable(text: string): boolean {
  return /目的\s*[:：]|サイトまたはURL\s*[:：]|操作先\s*[:：]|操作対象\s*[:：]|会社とアカウント\s*[:：]|サービスとアカウント\s*[:：]|投稿文\s*[:：]|公開先・送信先・対象範囲\s*[:：]|宛先\s*[:：]/iu.test(text)
    || /https?:\/\/|ブラウザ|browser|ウェブ|web|サイト|ページ|投稿|公開|応募|送信|削除|ログイン/iu.test(text);
}

function hasFixedLocator(text: string): boolean {
  return /selector|css\s*selector|xpath|dom\s*order|nth-child|querySelector|click\s*\(|要素番号|クリック順/iu.test(text);
}

export function buildWebOperationIntake(rawText: string): WebOperationIntakeV1 {
  const text = String(rawText || "").trim().slice(0, 12_000);
  const applicable = isApplicable(text);
  const contract = getWebOperationContract();
  if (!applicable) {
    return {
      schema: WEB_OPERATION_INTAKE_SCHEMA_V1,
      applicable: false,
      status: "not_applicable",
      operation: null,
      site_or_url: null,
      account_ref: null,
      semantic_target: null,
      payload_hash: null,
      payload_present: false,
      scope: null,
      missing_fields: [],
      questions: [],
      fixed_locator_detected: false,
      exact_blocker: null,
      next_stage: "not_applicable",
      external_action_executed: false,
      readback_required: true,
      no_replay: true,
      web_operation_contract: contract
    };
  }

  const redactedText = text.replace(/(?:password|token|secret|api[_-]?key|authorization|cookie|otp|security[_-]?code)\s*[:=]\s*[^\s,;]+/giu, "[redacted]");
  const purpose = lineValue(redactedText, ["目的", "purpose"]);
  const site = normalizedUrl(lineValue(redactedText, ["サイトまたはURL", "操作先", "サイト", "URL", "site(?:\\s+or\\s+url)?"])) ?? firstUrlFromText(redactedText);
  const account = lineValue(redactedText, ["会社とアカウント", "サービスとアカウント", "利用アカウント", "会社", "account(?:\\s+ref)?", "account"]);
  const operation = operationFromText(redactedText, purpose);
  const target = targetFromText(lineValue(redactedText, ["対象(?:（[^\n]*）)?", "操作対象", "対象ページ", "target"]));
  const payload = lineValue(redactedText, ["内容(?:（[^\n]*）)?", "本文", "投稿文", "メッセージ", "文章", "payload", "content"]);
  const scope = lineValue(redactedText, ["公開先・送信先・対象範囲", "対象範囲", "公開先", "送信先", "送付先", "宛先", "チャンネル", "channel", "audience", "destination", "scope"]);
  const fixedLocatorDetected = hasFixedLocator(redactedText);
  const missingFields: string[] = [];
  if (!operation) missingFields.push("operation");
  if (!site) missingFields.push("site_or_url");
  if (!account) missingFields.push("account_ref");
  if (!target) missingFields.push("semantic_target");
  if (operation && operation !== "read" && !payload) missingFields.push("payload");
  if (operation && operation !== "read" && !scope) missingFields.push("scope");

  const questions = missingFields.map((field) => ({
    operation: "目的を read / create / update / publish / submit / delete のどれかで指定してください。",
    site_or_url: "操作するサイト名またはURLを指定してください。",
    account_ref: "会社名と、使用するサービス・アカウントを指定してください。",
    semantic_target: "固定selectorではなく、画面上の意味で対象を指定してください。",
    payload: "本文・画像・ファイル・応募内容など、操作に使う内容を指定してください。",
    scope: "公開先・送信先・対象範囲を指定してください。"
  }[field])).filter((question): question is string => Boolean(question));

  let status: WebOperationIntakeStatus = missingFields.length ? "needs_input" : operation === "read" ? "ready_for_read" : "approval_required";
  let exactBlocker: string | null = null;
  let nextStage: WebOperationIntakeV1["next_stage"] = missingFields.length ? "clarify" : operation === "read" ? "read" : "approval";
  if (fixedLocatorDetected) {
    status = "blocked";
    exactBlocker = "web_operation_fixed_locator_rejected";
    nextStage = "clarify";
    questions.unshift("selector・XPath・DOM順・固定クリック順は使わず、現在画面の意味と候補を指定してください。");
  }

  return {
    schema: WEB_OPERATION_INTAKE_SCHEMA_V1,
    applicable: true,
    status,
    operation,
    site_or_url: site,
    account_ref: account,
    semantic_target: target,
    payload_hash: payload && operation !== "read" ? sha256(payload) : null,
    payload_present: Boolean(payload),
    scope,
    missing_fields: missingFields,
    questions: [...new Set(questions)],
    fixed_locator_detected: fixedLocatorDetected,
    exact_blocker: exactBlocker,
    next_stage: nextStage,
    external_action_executed: false,
    readback_required: true,
    no_replay: true,
    web_operation_contract: contract
  };
}
