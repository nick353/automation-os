#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { selectResumeBlocker } from "./lib/resume-controller.mjs";
import { buildContinuationIdempotencyKey } from "./lib/hourly-thread-dispatch.mjs";
import { createThreadAlias, projectionCallbacks, readThreadReadbackProjection } from "./lib/thread-readback-projection.mjs";

const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const DEFAULT_SESSION_ROOT = path.join(DEFAULT_CODEX_HOME, "sessions");
const DEFAULT_COMPANION_SOURCE = "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge";
const DEFAULT_COMPANION_INSTALL = "/Users/nichikatanaka/Library/Application Support/AOS Chrome Companion/app";
const DEFAULT_LEARNING_LEDGER = path.join(DEFAULT_CODEX_HOME, "automations", "aos-companion", "learning-ledger.v1.json");
const COMPANION_ARTIFACTS = [
  "extension/service-worker.js",
  // Keep the source contract in the parity set as well as its generated
  // artifacts.  Otherwise a source-only capability change can look healthy
  // until the next generated bundle is rebuilt.
  "src/shared/operation-schema.mjs",
  "extension/operation-schema.generated.js",
  // The broker is part of the installed Companion runtime too.  Tracking it
  // prevents an hourly audit from declaring runtime parity while a resident
  // broker still runs the pre-lane implementation.
  "src/broker/broker.mjs",
  // MCP descriptions and the Companion skill are part of the caller-facing
  // compatibility surface.  If these drift from source, an old session may
  // keep selecting a legacy mutation entrypoint even when the broker is
  // healthy and the signed transaction lane is available.
  "src/mcp/server.mjs",
  "plugins/aos-chrome-companion/skills/aos-chrome-companion/SKILL.md",
];
const MAX_SESSION_BYTES = 48_000;
// Keep the scan bounded while covering the full current seven-day AOS window
// (the live workspace currently has fewer than 100 user-owned sessions).
const MAX_SESSIONS = 200;
const DEFAULT_RECENT_DAYS = 7;
// A live task with an observed failure/restart signal and no new progress for
// this long gets one fresh status attempt even when the audit fingerprint is
// unchanged.  A file mtime by itself is not evidence of a stalled task: old
// session logs are retained for resume, and must not create an hourly loop.
export const DEFAULT_STALLED_TASK_THRESHOLD_MS = 10 * 60_000;
const ACTIVE_TASK_STATUSES = new Set(["active", "running", "in_progress", "inprogress", "in progress", "executing", "working"]);
const COMPANION_MARKERS = [
  "companion",
  "chrome_plugin",
  "session_not_owned",
  "pending operation",
  "pending_operation",
  "stale_generation",
  "authority_payload_tampered",
  "extension_operation_failed",
  "page_execution_timeout",
  "transaction_action_target_page_mismatch",
  "target_page_mismatch",
  "mcp_session_task_binding_missing",
  "page_instance_mismatch",
  "generation_mismatch",
  "frame_mismatch",
  "semantic_snapshot_empty",
  "semantic_snapshot",
  "image_readback",
  "iframe",
  "frame origin",
  "target mismatch",
  "target不一致",
  "connected=false",
  "reconciliation_required",
  "operation_effect_unknown",
  "unknown effect",
  "sent_unverified",
  "send_result_unknown",
  "thread_send_ack_unknown",
  "thread_readback_not_supplied",
  "thread_readback_failed",
  "capability_not_supported",
  "capability_missing",
  "capability_unavailable",
  "companion_capability_handshake_failed",
  "identity_capability_unavailable",
  "timeout",
];
const USER_HELP_MARKERS = [
  "otp",
  "captcha",
  "hcaptcha",
  "recaptcha",
  "本人確認",
  "認証コード",
  "device code",
  "password",
  "決済",
  "payment",
];
const CONTEXT_ONLY_COMPANION_MARKERS = new Set(["companion"]);
// Keep this predicate failure-oriented.  Generic words such as "requires"
// and "waiting" also occur in route/configuration prose and otherwise turn a
// healthy policy line mentioning `chrome_plugin` into a live incident.
const COMPANION_EVIDENCE_CUES = /(?:error|failed|failure|blocked|pending|timeout|timed out|unresolved|mismatch|disconnected|not available|not exposed|not owned|reconciliation_required|operation_effect_unknown|unknown effect|transaction_action_|mcp_session_task_binding_missing|page_instance_mismatch|semantic_snapshot_empty|status\s*[:=]|exact[_ ]blocker\s*[:=])/iu;
const COMPANION_CONTEXT_FAILURE_CUES = /(?:error|failed|failure|blocked|pending|timeout|timed out|unresolved|mismatch|disconnected|not available|not exposed|not owned|reconciliation_required|operation_effect_unknown|unknown effect)/iu;
const USER_HELP_EVIDENCE_CUES = /(?:\bcurrently\b|\bnow\b|\brendered\b|\bvisible\b|\bdisplayed\b|\bwaiting\b|requires?\s+(?:a\s+)?(?:user|human|action)|\benter\b|\binput\b|\bchallenge\b|\bwidget\b|\bverification\b|status\s*[:=])/iu;
const INSTRUCTION_ONLY_CUES = /(?:never|do not|don't|not a (?:gate|proof)|without replay|must not|should not|if .* then|please\b|してください|しないで(?:ください)?|禁止|必ず|すること)/iu;
// User-help is a terminal boundary only when the tail describes an observed
// challenge and an action that is currently required.  A policy sentence
// mentioning "OTP/CAPTCHA" must not become a blocker by keyword alone.
const USER_HELP_REQUIRED_CUES = /(?:requires?\s+(?:a\s+)?(?:user|human)(?:\s+action|\s+intervention)?|(?:user|human)[-\s]+action\s+required|awaiting\s+(?:a\s+)?(?:user|human)|user_help_required\s*[:=]\s*true|human_gate\s*[:=]\s*true|status\s*[:=]\s*(?:blocked|awaiting_user)|(?:otp|captcha|hcaptcha|recaptcha|password|本人確認|認証コード)\b[^\n]{0,120}\b(?:required|enter|input|challenge|verification|widget)\b)/iu;
const USER_HELP_OBSERVATION_CUES = /(?:\bcurrently\b|\bnow\b|\brendered\b|\bvisible\b|\bdisplayed\b|\bwaiting\b|\bawaiting\b|\bshown\b|\bdetected\b|\bpresent\b|\brequired\b|status\s*[:=])/iu;
const USER_HELP_NEGATION_CUES = /(?:no\s+(?:visible|actionable|active|real|actual)\s+(?:widget|challenge|captcha|otp|verification|user)|not\s+(?:required|present|visible|shown|detected|a\s+(?:gate|blocker|challenge))|(?:do|does)\s+not\s+(?:require|show|contain)|without\s+(?:a\s+)?(?:user|human)\s+action|false\s+positive|instruction(?:s)?\s+only)/iu;
const SUMMARY_NOISE_CUES = /(?:internal_chat_message_metadata_passthrough|data:image\/|(?:base64|dataBase64)\s*[:=]|[A-Za-z0-9_-]{180,}|"(?:payload|type|output|structuredContent|content|call_id|status)"\s*:|\\"(?:payload|type|output|structuredContent|content|call_id|status)\\"\s*:)/iu;
const SUMMARY_SIGNAL_CUES = /(?:^|\b)(?:result|changed|verification|remaining blocker|exact[_ ]blocker|next action|status|stop reason|restart point)\s*[:=]?/iu;
const MAX_LATEST_SUMMARY_CHARS = 600;
const MAX_VERIFIER_PROJECTION_BYTES = 32_000;
export const SOFT_ANOMALY_SCHEMA = "aos.companion_soft_anomaly.v1";
export const THREAD_INSPECTION_SCHEMA = "aos.companion_thread_inspection.v1";
export const SOFT_ANOMALY_CONFIRMATION_THRESHOLD = 2;
export const COMPANION_LEARNING_LEDGER_SCHEMA = "aos.companion_learning_ledger.v1";
export const COMPANION_LEARNING_PROTOCOL_SCHEMA = "aos.companion_learning_protocol.v1";
export const COMPANION_LEARNING_OUTCOME_SCHEMA = "aos.companion_learning_outcome.v1";
export const COMPANION_PLAYBOOK_PROPOSAL_SCHEMA = "aos.companion_playbook_proposal.v1";
export const COMPANION_PROACTIVE_REPAIR_SCHEMA = "aos.companion_proactive_repair.v1";
export const COMPANION_VISUAL_INTERACTION_POLICY_SCHEMA = "aos.companion_visual_interaction_policy.v1";
export const MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL = 3;
const SOFT_ANOMALY_ACTIONABILITY = "review_only";
const MAX_SOFT_ANOMALY_EVIDENCE = 3;
// Minor quality signals are intentionally retained alongside hard blockers;
// truncating at four hid useful web-operation friction when a task also had
// drift, a near miss, and a verification gap.
const MAX_SOFT_ANOMALIES_PER_SESSION = 8;
const MAX_SOFT_ANOMALY_FINDINGS = 100;
const MAX_SOFT_ANOMALY_EVIDENCE_CHARS = 240;
const MAX_LIGHTWEIGHT_THREAD_INSPECTIONS = 200;
const MAX_DEEP_THREAD_READS = 50;
const MAX_LEARNING_OUTCOMES = 500;
const MAX_PLAYBOOK_PROPOSALS = 100;
const MAX_LEARNING_TEXT_CHARS = 240;
const MAX_PROACTIVE_REPAIR_CANDIDATES = 20;
const PROACTIVE_SOFT_ANOMALY_TYPES = new Set([
  "recovered_near_miss",
  "unstable_behavior",
  "progress_verification_next_action_gap",
  "web_operation_friction",
  "workflow_deviation",
]);
const PROACTIVE_PLAYBOOK_IDS = new Set([
  "stale_connection_generation",
  "target_binding",
  "frame_or_locator_readback",
  "visual_operation_stability",
]);

// Soft anomalies are intentionally separate from Companion failure markers.
// They describe quality or continuity signals in a recent tail, but never
// authorize a repair, resume, refresh, or replay.
const SOFT_INTENT_DRIFT_CUES = /(?:intent|scope|goal|objective|request|purpose)\s*(?:drift(?:ed)?|mismatch|divergen(?:ce|t)|off[- ]track|misalign(?:ed|ment)|changed)|(?:scope creep|out of scope|wrong task|wrong target|unrelated work|not what (?:the )?user asked|does not match (?:the )?request)|(?:意図|目的|依頼|スコープ|対象).*(?:逸脱|ずれ|不一致|外れ|変わっ|違う|拡大)|(?:依頼と(?:異なる|違う)|ユーザー意図.*(?:不一致|逸脱|ずれ)|目的から逸脱)/iu;
const SOFT_MINOR_DEVIATION_CUES = /(?:slightly\s+(?:off|wrong|different)|not quite(?: right)?|seems?\s+off|a little\s+(?:wrong|different)|unexpected(?:ly)?\s+(?:different|changed)|想定(?:と|から)\s*(?:少し|ちょっと)?(?:違|外れ)|少し(?:ずれ|違|外れ)|ちょっと(?:ずれ|違|おか)|違和感|微妙に(?:違|ずれ))/iu;
const SOFT_WEB_OPERATION_CUES = /(?:\b(?:browser|chrome|web|page|tab|click|double[- ]click|tap|type|input|select|dropdown|scroll|navigate|upload|submit|locator|selector|element|screenshot|visual|semantic|cursor|mouse|frame|iframe)\b|ブラウザ|ウェブ|ページ|タブ|クリック|入力|選択|スクロール|移動|アップロード|送信|要素|セレクタ|画面|カーソル|マウス|操作)/iu;
const SOFT_WEB_FRICTION_CUES = /(?:not\s+(?:clickable|editable|found|selected|reflected|applied)|element\s+(?:not\s+found|missing)|selector\s+(?:not\s+found|failed)|wrong\s+(?:page|target)|no\s+(?:effect|response)|unresponsive|did(?:n['’]t|\s+not)\s+work|could\s+not|can['’]t|cannot|failed|failure|error|timeout|timed\s+out|retry|reconnect|unexpected|mismatch|empty|unclear|stuck|hang(?:ing)?|blocked|not\s+reflected|not\s+applied|反応しな|うまくいか|できな|見つから|対象.*(?:違|不一致)|ページ.*(?:違|不一致)|効かな|反映されな|タイムアウト|再試行|再接続|エラー|失敗|不安定|止ま|詰ま|空|不明)/iu;
const SOFT_NEAR_MISS_CUES = /(?:near[- ]miss|almost fail(?:ed)?|recover(?:ed|y)?(?: after| from)?|self[- ]recover(?:ed|y)?|transient(?:ly)? resolved|retry[^\n]{0,80}(?:succeed|pass|complet)|fallback[^\n]{0,80}(?:succeed|pass|complet)|initial(?:ly)?[^\n]{0,100}(?:fail|timeout|error)[^\n]{0,100}(?:then|after|but)[^\n]{0,100}(?:pass|succeed|complet|resolv))/iu;
const SOFT_FAILURE_CUES = /(?:\bfail(?:ed|ure)?\b|\btimeout\b|\btimed out\b|\berror\b|\balmost fail(?:ed)?\b|\bblocked\b|\bnear[- ]miss\b|(?:失敗|タイムアウト|エラー|未完了|保留))/iu;
const SOFT_RECOVERY_CUES = /(?:\brecover(?:ed|y)\b[^\n]{0,100}(?:pass|succeed|complet|resolv|after|from)|self[- ]recover(?:ed|y)?|recovery[^\n]{0,100}(?:pass|succeed|complet|resolv)|transient[^\n]{0,80}(?:resolv|pass|succeed)|retry[^\n]{0,80}(?:succeed|pass|complet)|fallback[^\n]{0,80}(?:succeed|pass|complet)|(?:then|after|eventually)[^\n]{0,100}(?:pass|succeed|complet|resolv)|(?:復旧|回復|再試行.*(?:成功|通過)|一時的.*解消))/iu;
const SOFT_SUCCESS_CUES = /(?:\bpass(?:ed)?\b|\bsucceed(?:ed|s)?\b|\bcomplete(?:d)?\b|\bresolve(?:d)?\b|\bhealthy\b|connected\s*[:=]\s*true|(?:成功|完了|解消|復旧))/iu;
const SOFT_UNSTABLE_CUES = /(?:\bunstable\b|\bflaky\b|\bintermittent\b|\bflapping\b|\boscillat(?:e|ing)\b|\bnon[- ]deterministic\b|repeated\s+(?:transient\s+)?(?:failure|error|timeout|retry|reconnect)|multiple\s+retries|retry\s*[2-9]\b|attempt\s*[2-9]\b|(?:不安定|断続的|再現性がない|揺らぎ|複数回.*(?:再試行|失敗)))/iu;
const SOFT_TRANSIENT_CUES = /(?:\bretr(?:y|ies)\b|\battempt\s*[2-9]\b|\breconnect(?:ed|ion)?\b|\bagain\b|\bintermittent\b|\bflaky\b|\btransient\b|再試行|再接続|再発)/iu;
const SOFT_PROGRESS_CUES = /(?:\bprogress\s*[:=]|\bimplemented?\s*[:=]|\bchange(?:d)?\s*[:=]|\bwork\s+done\s*[:=]|\bimplementation\s*[:=]|(?:進捗|実装|変更|作業)\s*[:=])/iu;
const SOFT_VERIFICATION_CUES = /(?:\bverification(?:\s+status)?\s*[:=]|\bverified\s*[:=]|\bverification\b|\btests?\s*[:=]|\b(?:検証|確認|テスト)\s*[:=])/iu;
const SOFT_NEXT_ACTION_CUES = /(?:\bnext\s+action(?:\s+now)?\s*[:=]|\bnext\s+step\s*[:=]|(?:次の(?:アクション|対応|手順)|次にすること)\s*[:=])/iu;
const SOFT_PROGRESS_COMPLETE_CUES = /(?:\b(?:progress|implemented?|implementation|change|work\s+done)\s*[:=][^\n]{0,120}\b(?:done|complete|completed|implemented|finished|shipped|成功|完了|実装済み)\b|(?:実装|進捗)\s*[:=][^\n]{0,120}(?:完了|済み))/iu;
const SOFT_VERIFICATION_GAP_CUES = /(?:verification[^\n]{0,120}(?:missing|pending|not\s+(?:run|recorded|verified|confirmed)|unverified|unknown|未確認|未実施|保留|不足)|(?:without|but\s+no|missing|gap\s+(?:in|between)|unrecorded)[^\n]{0,80}verification|progress[^\n]{0,120}(?:without|but\s+no|missing)[^\n]{0,80}verification|(?:検証|確認)[^\n]{0,80}(?:未確認|未実施|保留|不足|欠落))/iu;
const SOFT_NEXT_ACTION_GAP_CUES = /(?:next\s+(?:action|step)[^\n]{0,120}(?:missing|unclear|unknown|not\s+(?:set|recorded|defined)|未定|不明|未記載|欠落)|(?:without|but\s+no|missing|gap\s+(?:in|between)|unrecorded)[^\n]{0,80}next\s+(?:action|step)|(?:次の(?:アクション|対応|手順)|次にすること)[^\n]{0,80}(?:未定|不明|未記載|欠落))/iu;
const SOFT_PROGRESS_GAP_CUES = /(?:progress[^\n]{0,120}(?:missing|unclear|unknown|not\s+(?:recorded|updated)|未記載|不明|欠落)|(?:without|but\s+no|missing|gap\s+(?:in|between)|unrecorded)[^\n]{0,80}progress|(?:進捗)[^\n]{0,80}(?:未記載|不明|欠落))/iu;
const SOFT_ANY_GAP_CUES = /(?:progress\s*\/\s*verification(?:\s*\/\s*next\s+action)?[^\n]{0,100}(?:gap|missing|incomplete|欠落|不足)|(?:gap|missing|incomplete|欠落|不足)[^\n]{0,100}(?:progress|verification|next\s+action)|(?:進捗|検証|次のアクション)[^\n]{0,80}(?:gap|欠落|不足))/iu;
const SOFT_OBSERVED_CUES = /(?:observed|detected|occurred|happened|found|reported|recorded|currently|now|fail(?:ed|ure)?|error|timeout|did(?:n['’]t|\s+not)|result\s*[:=]|status\s*[:=]|progress\s*[:=]|verification\s*[:=]|next\s+action\s*[:=]|実際|検出|発生|記録|現在|失敗|エラー|タイムアウト|反応しな|できな|見つからな|結果\s*[:=]|状態\s*[:=])/iu;
const SOFT_WORKFLOW_CONTEXT_CUES = /(?:companion|aos|task|thread|goal|objective|request|scope|workflow|test|implemented?|implementation|progress|verification|result|status|next\s+action|readback|dispatch|owner|target|effect|handoff|artifact|実装|進捗|検証|結果|状態|次のアクション|依頼|目的|対象|外部効果)/iu;
const SESSION_METADATA_NOISE_CUES = /(?:<\/?entry\b|<\/?environment_context\b|<\/?instructions\b|<permissions(?:\s|>)|<skills_instructions>)/iu;
// Session lines often contain serialized tool output, paths, or historical
// prose.  A bare substring such as `aos-companion` must not be treated as the
// standalone product name, and a cue hundreds of characters away must not be
// attributed to an unrelated marker in the same serialized line.
const COMPANION_WORD_RE = /(?<![-_A-Za-z0-9])companion(?![-_A-Za-z0-9])/iu;
const EVIDENCE_NEARBY_CHARS = 240;
const TOOL_SCHEMA_NOISE_CUES = /(?:exec\s+tool\s+declaration|declare\s+const\s+tools|Promise<CallToolResult>|inputSchema|server\.registerTool)/iu;
const TOOL_SCHEMA_FAILURE_CUES = /(?:low_level_mutation_disabled|operation_effect_unknown|transaction_action_|exact[_ ]blocker\s*[:=]|status\s*[:=]\s*(?:blocked|failed|error))/iu;
const TOOL_LIST_NOISE_CUES = /(?:\[\s*\{\s*["']name["']\s*:|###\s*available\s+skills|<skills_instructions>)/iu;
const SCHEDULER_PROMPT_NOISE_CUES = /(?:\bpromptLength\b|CONNECTOR_PRIORITY_V1|AOS_ADAPTIVE_BROWSER_ROUTE_DECISION_V2)/iu;

function hasNearbyCue(line, marker, cue, window = EVIDENCE_NEARBY_CHARS) {
  const source = String(line || "");
  const needle = String(marker || "").toLowerCase();
  if (!needle) return false;
  const lower = source.toLowerCase();
  let offset = lower.indexOf(needle);
  while (offset >= 0) {
    const start = Math.max(0, offset - window);
    const end = Math.min(source.length, offset + needle.length + window);
    if (cue.test(source.slice(start, end))) return true;
    offset = lower.indexOf(needle, offset + needle.length);
  }
  return false;
}

function hasStandaloneCompanionFailure(line) {
  if (!COMPANION_WORD_RE.test(line)) return false;
  if (!hasNearbyCue(line, "companion", COMPANION_CONTEXT_FAILURE_CUES)) return false;
  return !(INSTRUCTION_ONLY_CUES.test(line)
    && !/(?:\bcurrently\b|\bnow\b|\brendered\b|\bvisible\b|\bdisplayed\b|\bwaiting\b|status\s*[:=])/iu.test(line));
}

function isToolSchemaNoise(line) {
  // A single serialized tool-list line can contain the entire skill catalog,
  // including historical blocker words.  It is metadata, not an observed
  // Companion result, so discard it before marker classification.
  if (TOOL_LIST_NOISE_CUES.test(line)) return true;
  // Scheduler/automation update responses serialize the full prompt and
  // routing fields on one `Script failed` line.  The prompt can mention
  // `chrome_plugin` and historical timeout policy without observing a
  // Companion operation.  Keep lines that also carry a concrete Companion
  // result/error, but discard policy-only scheduler payloads.
  if (SCHEDULER_PROMPT_NOISE_CUES.test(line) && !/(?:Low-level mutation tools are disabled|companion_authorized_transaction|aos_chrome_companion__companion_|Companion\s+(?:error|failed|failure|timeout))/iu.test(line)) return true;
  return TOOL_SCHEMA_NOISE_CUES.test(line) && !TOOL_SCHEMA_FAILURE_CUES.test(line);
}

// These playbooks are intentionally bounded. The hourly controller selects
// one only after the live Companion status/owner check; a root callback then
// performs the implementation or readback and supplies proof. A plan is not
// a terminal candidate: only an unresolved safety/authority boundary may
// leave the task deferred.
const REPAIR_PLAYBOOKS = Object.freeze({
  stale_connection_generation: {
    id: "stale_connection_generation",
    automatic: true,
    action: "fresh Companion status, generation rebind, and one bounded readback",
    stopConditions: ["active lease or pending operation", "unknown effect", "foreign owner", "auth/OTP/CAPTCHA"],
  },
  target_binding: {
    id: "target_binding",
    automatic: true,
    action: "fresh owner check, then rebind task/session/lease/pageInstance/window/frame target",
    stopConditions: ["foreign owner", "ambiguous target", "active mutation with unknown effect"],
  },
  frame_or_locator_readback: {
    id: "frame_or_locator_readback",
    automatic: true,
    action: "fresh screenshot plus semantic readback, then resolve frame/locator and run one focused adapter check",
    stopConditions: ["visual target conflict", "CAPTCHA/OTP/auth", "operation effect unknown"],
  },
  visual_operation_stability: {
    id: "visual_operation_stability",
    automatic: true,
    action: "fresh screenshot, inspect the visible target/point, then perform one visualProof-bound visual.* operation and read back semantically and visually",
    stopConditions: ["visual target conflict", "target moved", "CAPTCHA/OTP/auth", "operation effect unknown", "submit or external-effect control"],
  },
  signed_reconciliation: {
    id: "signed_reconciliation",
    automatic: true,
    action: "one signed timeout reconciliation; never replay the original mutation",
    stopConditions: ["reconciliation still unresolved", "foreign owner", "ambiguous result"],
  },
  send_result_readback: {
    id: "send_result_readback",
    automatic: true,
    action: "one same-target task readback or bounded wait for the existing idempotency key; never resend",
    stopConditions: ["readback unavailable", "foreign owner", "target mismatch", "duplicate key already reserved"],
  },
  capability_adapter_repair: {
    id: "capability_adapter_repair",
    automatic: false,
    action: "capture the current capability/schema contract, implement the smallest matching Companion adapter, then run focused checks and a read-only canary",
    stopConditions: ["capability identity unknown", "source/install authority unavailable", "active lease or pending operation", "external effect or auth gate"],
  },
  companion_local_review: {
    id: "companion_local_review",
    automatic: false,
    action: "fresh status and readback to identify a matching Companion adapter repair",
    stopConditions: ["no matching playbook", "active turn", "external effect ambiguity"],
  },
  artifact_refresh: {
    id: "artifact_refresh",
    automatic: true,
    action: "at a safe boundary perform one supported install/reload, then fresh generation readback",
    stopConditions: ["live lease", "pending operation", "reconciliation", "active browser task", "extension.reload unavailable"],
  },
});

const PLAYBOOK_MARKERS = Object.freeze({
  stale_connection_generation: ["timeout", "stale_generation", "connected=false", "chrome_plugin", "page_execution_timeout", "extension_operation_failed", "generation_mismatch"],
  target_binding: ["session_not_owned", "target mismatch", "target不一致", "foreign owner", "lease", "pageInstance", "page_instance_mismatch", "transaction_action_target_page_mismatch", "target_page_mismatch", "mcp_session_task_binding_missing"],
  frame_or_locator_readback: ["iframe", "frame origin", "semantic", "semantic_snapshot_empty", "selectText", "rich text", "dropdown", "locator", "frame_mismatch"],
  visual_operation_stability: ["visual target", "visual point", "visualProof", "cursor", "coordinate", "click no effect", "operation control"],
  signed_reconciliation: ["reconciliation_required", "operation_effect_unknown", "unknown effect"],
  send_result_readback: ["sent_unverified", "send_result_unknown", "thread_send_ack_unknown", "thread_readback_not_supplied", "thread_readback_failed"],
  capability_adapter_repair: ["capability_not_supported", "capability_missing", "capability_unavailable", "companion_capability_handshake_failed", "identity_capability_unavailable", "not exposed"],
});

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => typeof entry === "string" ? entry : entry?.text)
    .filter((entry) => typeof entry === "string")
    .join(" ");
}

// Goal continuation metadata is injected into a user-message record so the
// next model turn can retain its objective. It is control-plane data, not a
// task observation: words such as `timeout`, `blocked`, and `CAPTCHA` inside
// it must never create a Companion incident or a resume candidate.
function removeInternalControlText(value) {
  return String(value ?? "")
    .replace(/<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/giu, " ")
    .replace(/<codex_internal_context\b[^>]*>[\s\S]*/giu, " ");
}

function toolOutputText(output) {
  if (Array.isArray(output)) {
    // `functions.exec` stores a terminal wrapper and its captured stdout as
    // separate input_text blocks. The stdout can contain test source,
    // previous assistant reports, or this audit's own words; none is a
    // task-observation receipt. Ignore the whole wrapper rather than letting
    // captured prose create a new blocker on the next scan.
    if (output.some((entry) => /^\s*Script\s+(?:completed|running|failed)\b/iu.test(String(entry?.text ?? "")))) return "";
  }
  return textFromContent(output) || (typeof output === "string" ? output : "");
}

function extractSessionLine(line) {
  const source = String(line || "");
  try {
    const record = JSON.parse(source);
    if (typeof record?.message === "string") return removeInternalControlText(record.message);
    const payload = record?.payload;
    // Assistant prose is a report about the task, not an authoritative task
    // observation. Reading it back as evidence makes the audit classify its
    // own words (for example, "blocked" or "timeout") as a new incident on
    // the next tick. Keep user messages and structured tool/event results;
    // exact tool receipts remain available through the latter paths.
    if (payload?.type === "message") {
      if (["assistant", "system", "developer"].includes(String(payload.role || "").toLowerCase())) return "";
      return removeInternalControlText(textFromContent(payload.content));
    }
    if (payload?.type === "custom_tool_call_output" || payload?.type === "function_call_output") {
      return removeInternalControlText(toolOutputText(payload.output));
    }
    if (payload?.type === "event_msg" && payload?.message) return removeInternalControlText(textFromContent(payload.message));
    if (payload?.type === "turn_aborted") return `turn aborted: ${payload.reason || "unknown"}`;
    if (payload?.type === "thread_goal_updated" && payload.goal) {
      return `goal status: ${payload.goal.status || "unknown"}`;
    }
    return "";
  } catch {
    return source;
  }
}

function compactLatestSummary(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/u)
    .map((line) => normalize(extractSessionLine(line)))
    .filter(Boolean)
    .filter((line) => !SUMMARY_NOISE_CUES.test(line))
    .filter((line) => !/^(?:\{|\[|")/u.test(line));
  if (lines.length === 0) return "";
  const signalLines = lines.filter((line) => SUMMARY_SIGNAL_CUES.test(line));
  const selected = (signalLines.length > 0 ? signalLines : lines).slice(-8);
  return normalize(selected.join(" ")).slice(-MAX_LATEST_SUMMARY_CHARS);
}

function softTailEntries(raw) {
  return String(raw || "")
    .split(/\r?\n/u)
    .map((line, index) => ({
      line: index + 1,
      text: normalize(extractSessionLine(line)),
    }))
    .filter((entry) => entry.text)
    // Keep the same payload/schema noise boundary as the existing summary and
    // hard-marker classifier. Soft findings must never use raw tool payloads
    // as evidence merely because they contain a matching word.
    .filter((entry) => !isToolSchemaNoise(entry.text))
    .filter((entry) => !SESSION_METADATA_NOISE_CUES.test(entry.text))
    .filter((entry) => !SUMMARY_NOISE_CUES.test(entry.text));
}

function hasSoftWorkflowContext(entries) {
  return (entries || []).some((entry) => SOFT_WORKFLOW_CONTEXT_CUES.test(String(entry?.text || "")));
}

function isObservedSoftSignal(entry, cue) {
  const source = String(entry?.text || "");
  const match = source.match(cue);
  if (!match) return false;
  // A policy or runbook sentence is not an observation. Preserve the existing
  // instruction-only rule while allowing an observed cue close to the actual
  // anomaly phrase. A status/progress label elsewhere in a long policy line
  // must not legitimize an unrelated instruction at its beginning.
  if (!INSTRUCTION_ONLY_CUES.test(source)) return true;
  const start = Math.max(0, Number(match.index || 0) - 48);
  const end = Math.min(source.length, Number(match.index || 0) + match[0].length + 48);
  return SOFT_OBSERVED_CUES.test(source.slice(start, end));
}

function uniqueSoftEntries(entries) {
  const seen = new Set();
  return (entries || []).filter((entry) => {
    const key = `${entry?.line ?? ""}:${entry?.text ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedSoftEvidence(entries) {
  const seen = new Set();
  return uniqueSoftEntries(entries)
    .sort((left, right) => Number(left?.line || 0) - Number(right?.line || 0))
    .filter((entry) => {
      const locator = `thread_tail:line_${entry.line}`;
      if (seen.has(locator)) return false;
      seen.add(locator);
      return true;
    })
    .slice(0, MAX_SOFT_ANOMALY_EVIDENCE)
    .map((entry) => {
      // compactLatestSummary applies the established redaction/noise rules
      // before an excerpt is emitted. The locator remains useful even when a
      // noisy line has no safe excerpt.
      const excerpt = compactLatestSummary(entry.text).slice(0, MAX_SOFT_ANOMALY_EVIDENCE_CHARS);
      return {
        locator: `thread_tail:line_${entry.line}`,
        line: entry.line,
        ...(excerpt ? { excerpt } : {}),
      };
    });
}

function buildSoftAnomaly(type, entries, {
  severity = "medium",
  confidence = "medium",
  missingDimensions = [],
} = {}) {
  const evidence = boundedSoftEvidence(entries);
  if (evidence.length === 0) return null;
  return {
    schema: SOFT_ANOMALY_SCHEMA,
    type,
    category: type,
    severity,
    confidence,
    actionability: SOFT_ANOMALY_ACTIONABILITY,
    disposition: "report_only",
    automaticRepairCandidate: false,
    repairCandidate: false,
    evidence,
    ...(missingDimensions.length > 0 ? { missingDimensions } : {}),
  };
}

function softDimensionEntries(entries, cue) {
  return entries.filter((entry) => isObservedSoftSignal(entry, cue));
}

function classifySoftGap(entries) {
  const progressEntries = softDimensionEntries(entries, SOFT_PROGRESS_CUES);
  const verificationEntries = softDimensionEntries(entries, SOFT_VERIFICATION_CUES);
  const nextActionEntries = softDimensionEntries(entries, SOFT_NEXT_ACTION_CUES);
  const explicitGapEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_ANY_GAP_CUES));
  const verificationGapEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_VERIFICATION_GAP_CUES));
  const nextActionGapEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_NEXT_ACTION_GAP_CUES));
  const progressGapEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_PROGRESS_GAP_CUES));

  const missingDimensions = new Set();
  const evidence = [
    ...explicitGapEntries,
    ...verificationGapEntries,
    ...nextActionGapEntries,
    ...progressGapEntries,
  ];
  if (verificationGapEntries.length > 0) missingDimensions.add("verification");
  if (nextActionGapEntries.length > 0) missingDimensions.add("next_action");
  if (progressGapEntries.length > 0) missingDimensions.add("progress");

  // A structured, completion-like progress record without any verification
  // record is a useful low-confidence continuity signal. Do not infer gaps
  // from arbitrary prose or from a normal completed task with no labels.
  const progressWithoutVerification = progressEntries.some((entry) => SOFT_PROGRESS_COMPLETE_CUES.test(entry.text))
    && verificationEntries.length === 0;
  if (progressWithoutVerification) {
    missingDimensions.add("verification");
    evidence.push(...progressEntries);
  }

  // An explicitly pending verification is actionable as a review signal even
  // when a next action is present. It does not become a hard blocker.
  const hasGap = evidence.length > 0 || progressWithoutVerification;
  if (!hasGap) return null;
  return buildSoftAnomaly("progress_verification_next_action_gap", evidence, {
    severity: "low",
    confidence: explicitGapEntries.length > 0 || verificationGapEntries.length > 0 || nextActionGapEntries.length > 0 || progressGapEntries.length > 0 ? "high" : "medium",
    missingDimensions: [...missingDimensions],
  });
}

export function classifySoftAnomalies(tail) {
  const entries = softTailEntries(tail);
  const anomalies = [];
  const intentEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_INTENT_DRIFT_CUES));
  const minorDeviationEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_MINOR_DEVIATION_CUES));
  const intent = buildSoftAnomaly("intent_drift", intentEntries, { severity: "medium", confidence: "high" });
  if (intent) anomalies.push(intent);
  const deviation = hasSoftWorkflowContext(minorDeviationEntries)
    ? buildSoftAnomaly("workflow_deviation", minorDeviationEntries, { severity: "low", confidence: "medium" })
    : null;
  if (deviation) anomalies.push(deviation);

  // Detect a single observed web-operation wobble immediately.  It is a
  // quality finding, not permission to mutate: the existing two-adjacent-run
  // confirmation and fresh task-owned readback still gate proactive repair.
  const webFrictionEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_WEB_FRICTION_CUES)
    && SOFT_WEB_OPERATION_CUES.test(String(entry.text || "")));
  const webFriction = webFrictionEntries.length > 0
    ? buildSoftAnomaly("web_operation_friction", webFrictionEntries, {
      severity: "low",
      confidence: webFrictionEntries.length > 1 ? "high" : "medium",
    })
    : null;
  if (webFriction) anomalies.push(webFriction);

  const failureEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_FAILURE_CUES));
  const recoveryEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_RECOVERY_CUES));
  const directNearMissEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_NEAR_MISS_CUES));
  const sequenceNearMissEntries = [];
  for (const recovery of recoveryEntries) {
    const priorFailure = [...failureEntries]
      .reverse()
      .find((failure) => {
        if (Number(failure.line) < Number(recovery.line)) return true;
        if (Number(failure.line) !== Number(recovery.line)) return false;
        const failureMatch = String(failure.text || "").match(SOFT_FAILURE_CUES);
        const recoveryMatch = String(recovery.text || "").match(SOFT_RECOVERY_CUES);
        return Boolean(failureMatch && recoveryMatch)
          && Number(failureMatch.index || 0) < Number(recoveryMatch.index || 0);
      });
    if (!priorFailure) continue;
    const transition = SOFT_TRANSIENT_CUES.test(`${priorFailure.text} ${recovery.text}`)
      || SOFT_SUCCESS_CUES.test(recovery.text);
    if (transition) sequenceNearMissEntries.push(priorFailure, recovery);
  }
  const nearMissEntries = [
    ...directNearMissEntries,
    ...sequenceNearMissEntries,
  ];
  const nearMiss = hasSoftWorkflowContext(nearMissEntries)
    ? buildSoftAnomaly("recovered_near_miss", nearMissEntries, { severity: "medium", confidence: directNearMissEntries.length > 0 ? "high" : "medium" })
    : null;
  if (nearMiss) anomalies.push(nearMiss);

  const explicitUnstableEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_UNSTABLE_CUES));
  const repeatedSignalEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_TRANSIENT_CUES));
  const repeatedFailureEntries = entries.filter((entry) => isObservedSoftSignal(entry, SOFT_FAILURE_CUES));
  const hasRepeatedInstability = repeatedSignalEntries.length >= 2 || repeatedFailureEntries.length >= 2;
  const unstable = (hasSoftWorkflowContext(explicitUnstableEntries)
    || (hasRepeatedInstability && hasSoftWorkflowContext([...repeatedSignalEntries, ...repeatedFailureEntries])))
    ? buildSoftAnomaly("unstable_behavior", [
      ...explicitUnstableEntries,
      ...(hasRepeatedInstability ? [...repeatedSignalEntries, ...repeatedFailureEntries] : []),
    ], { severity: "medium", confidence: explicitUnstableEntries.length > 0 ? "high" : "medium" })
    : null;
  if (unstable) anomalies.push(unstable);

  const gap = classifySoftGap(entries);
  if (gap) anomalies.push(gap);

  return anomalies.slice(0, MAX_SOFT_ANOMALIES_PER_SESSION);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readFirstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    let total = 0;
    const chunkSize = 65_536;
    while (total < 1_048_576) {
      const buffer = Buffer.alloc(chunkSize);
      const bytes = fs.readSync(fd, buffer, 0, chunkSize, total);
      if (!bytes) break;
      const chunk = buffer.subarray(0, bytes).toString("utf8");
      const newline = chunk.indexOf("\n");
      if (newline >= 0) {
        chunks.push(chunk.slice(0, newline));
        break;
      }
      chunks.push(chunk);
      total += bytes;
    }
    const line = chunks.join("");
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function tailText(file, maxBytes = MAX_SESSION_BYTES) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytes).toString("utf8");
      // The bounded read normally starts in the middle of a large JSONL
      // record (reasoning/tool payloads can be many megabytes).  Never feed
      // that partial record to the classifier: its arbitrary prefix can
      // contain unrelated `chrome_plugin`/`timeout` words and create a
      // blocker that was never emitted by the session.
      if (start > 0) {
        const newline = text.indexOf("\n");
        if (newline < 0) return "";
        text = text.slice(newline + 1);
      }
      return text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function walkJsonl(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  return files;
}

export function classifyThreadTail(tail) {
  const raw = String(tail || "");
  const lines = raw.split(/\r?\n/u)
    .map((line) => normalize(extractSessionLine(line)))
    .filter(Boolean)
    .filter((line) => !isToolSchemaNoise(line));
  const hasEvidence = (marker, cue) => lines.some((line) => {
    if (!line.toLowerCase().includes(marker.toLowerCase())) return false;
    if (INSTRUCTION_ONLY_CUES.test(line) && !/(?:\bcurrently\b|\bnow\b|\brendered\b|\bvisible\b|\bdisplayed\b|\bwaiting\b|status\s*[:=])/iu.test(line)) return false;
    return hasNearbyCue(line, marker, cue)
      || hasNearbyCue(line, marker, /(?:status\s*[:=]\s*(?:blocked|failed|error)|exact_blocker\s*[:=])/iu);
  });
  const hasUserHelpEvidence = (marker) => lines.some((line) => {
    if (!line.toLowerCase().includes(marker.toLowerCase())) return false;
    if (USER_HELP_NEGATION_CUES.test(line)) return false;
    if (!USER_HELP_OBSERVATION_CUES.test(line)) return false;
    return USER_HELP_REQUIRED_CUES.test(line) || /(?:\bvisible\b|\brendered\b|\bdisplayed\b)[^\n]{0,80}\b(?:widget|challenge)\b/iu.test(line);
  });
  const companionMarkers = COMPANION_MARKERS.filter((marker) => {
    if (CONTEXT_ONLY_COMPANION_MARKERS.has(marker)) return false;
    return hasEvidence(marker, COMPANION_EVIDENCE_CUES);
  });
  const userHelpMarkers = USER_HELP_MARKERS.filter((marker) => hasUserHelpEvidence(marker));
  const companionContext = lines.some((line) => hasStandaloneCompanionFailure(line));
  // Test the extracted session lines instead of the raw JSONL.  A goal update
  // is serialized as `"goal":{..."status":"blocked"}` and its objective
  // may be much longer than the bounded raw-text window.  `extractSessionLine`
  // already reduces that record to the authoritative `goal status: blocked`
  // signal, so the classifier must use that normalized projection.
  const normalizedLines = lines.join("\n");
  const blocked = /(?:status\s*[:=]\s*blocked|goal[^.]{0,120}\bblocked\b|result[^.]{0,120}\bblocked\b|result\s+未完了)/iu.test(normalizedLines)
    ;
  // Keep the established completion classifier on the bounded raw tail.  The
  // extracted projection intentionally drops some terminal tool records, and
  // using it alone would turn completed history into live work.  Only the
  // explicit Goal-blocked signal above needs the normalized projection.
  const completed = /(?:task_complete|result\s*[:=]\s*(?:complete|completed)|status\s*[:=]\s*completed)/iu.test(normalizedLines)
    || raw.split(/\r?\n/u).some((line) => {
      try {
        const record = JSON.parse(line);
        return record?.type === "task_complete" || record?.payload?.type === "task_complete";
      } catch { return false; }
    });
  // An explicitly interrupted turn is not live work.  Keeping it in a
  // separate paused scope prevents the hourly controller from interpreting a
  // user stop (or an aborted turn) as a stale task that needs a repair/retry.
  const interrupted = /(?:<turn_aborted>|turn\s+(?:aborted|interrupted)\b|status\s*[:=]\s*interrupted\b|中断(?:されました|した|済み)?)/iu.test(normalizedLines)
    || raw.split(/\r?\n/u).some((line) => {
      try {
        const record = JSON.parse(line);
        return record?.type === "turn_aborted" || record?.payload?.type === "turn_aborted";
      } catch { return false; }
    });
  return {
    companionIssue: companionMarkers.length > 0 || companionContext,
    companionMarkers,
    userHelpRequired: userHelpMarkers.length > 0,
    userHelpMarkers,
    blocked,
    completed,
    interrupted,
    stateScope: completed ? "history" : interrupted ? "paused" : "live_candidate",
    latestSummary: compactLatestSummary(tail),
    // Soft anomalies are informational quality signals only. Keep them out of
    // the hard Companion issue, blocker, resume, and repair classifications.
    softAnomalies: classifySoftAnomalies(raw),
  };
}

function isLiveCandidate(item) {
  return Boolean(item)
    && (item.stateScope !== "history" || item.completed !== true)
    && (item.stateScope !== "paused" || item.resumeEligibleAfterProof === true)
    && item.completed !== true
    && (item.interrupted !== true || item.resumeEligibleAfterProof === true);
}

function markerSet(item) {
  return new Set((item?.companionMarkers || []).map((marker) => String(marker).toLowerCase()));
}

function markerMatches(markers, candidates) {
  return candidates.some((candidate) => markers.has(String(candidate).toLowerCase()));
}

function booleanValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function taskThreadId(task) {
  return task?.threadId ?? task?.thread_id ?? task?.id ?? null;
}

function taskHostId(task) {
  return task?.hostId ?? task?.host_id ?? null;
}

// The child audit deliberately exposes opaque aliases in its projection, while
// the post-audit Root must use the real official-App ID for a callback. Keep
// both identities on every candidate so the Root can resolve the alias against
// the same fresh inventory before attempting a read or send.
function candidateThreadAlias(candidate) {
  const threadId = String(candidate?.threadId ?? candidate?.thread_id ?? "").trim();
  if (!threadId) return null;
  return /^t-[a-f0-9]{24}$/u.test(threadId) ? threadId : createThreadAlias(threadId);
}

function taskOwner(task) {
  return task?.owner
    ?? task?.ownerKind
    ?? task?.owner_kind
    ?? task?.threadSource
    ?? task?.thread_source
    ?? task?.source
    ?? null;
}

function taskOwnerIsUser(task, { source = "" } = {}) {
  if (task?.userOwned === false || task?.user_owned === false) return false;
  if (String(task?.threadSource ?? task?.thread_source ?? "").toLowerCase() === "automation") return false;
  if (booleanValue(task?.automationOwned ?? task?.automation_owned)
    || booleanValue(task?.agentOwned ?? task?.agent_owned)
    || task?.agentRole
    || task?.agent_role
    || task?.parentThreadId
    || task?.parent_thread_id) return false;
  const ownerValue = taskOwner(task);
  const owner = typeof ownerValue === "object"
    ? ownerValue?.kind ?? ownerValue?.type ?? ownerValue?.name ?? ""
    : ownerValue;
  if (String(owner ?? "").trim()) return new Set(["user", "user_owned", "user-owned", "human"]).has(String(owner).trim().toLowerCase());
  if (booleanValue(task?.userOwned ?? task?.user_owned)) return true;
  // A task returned by the official Codex App task list is already scoped to
  // the user's account.  The scheduler still removes its own automation task
  // and any explicit child/agent task above; titles and summaries are never
  // used as ownership evidence.
  return source === "codex_app_thread_list" || source === "codex_app_task_list";
}

function taskStatus(task) {
  return normalize(task?.status ?? task?.state ?? task?.lifecycleState ?? task?.lifecycle_state ?? "unknown").toLowerCase() || "unknown";
}

function taskIsActiveStatus(status) {
  return ACTIVE_TASK_STATUSES.has(String(status || "").toLowerCase());
}

function taskTimestampMs(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const numeric = typeof value === "number" || /^[0-9]+(?:\.[0-9]+)?$/u.test(String(value).trim())
    ? Number(value)
    : NaN;
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function taskRevision(task) {
  for (const key of ["revision", "revisionId", "revision_id", "updatedAt", "updated_at", "updatedAtMs", "updated_at_ms", "lastTurnId", "last_turn_id", "version"]) {
    const value = task?.[key];
    if (value === undefined || value === null || String(value) === "") continue;
    if (["updatedAt", "updated_at", "updatedAtMs", "updated_at_ms"].includes(key)) return taskUpdatedAt(task);
    return String(value);
  }
  return null;
}

function taskUpdatedAt(task) {
  for (const key of ["updatedAt", "updated_at", "updatedAtMs", "updated_at_ms", "lastProgressAt", "last_progress_at", "mtime"]) {
    const value = task?.[key];
    if (value === undefined || value === null || String(value) === "") continue;
    const parsed = taskTimestampMs(value);
    if (parsed !== null) return new Date(parsed).toISOString();
  }
  return null;
}

function taskGeneration(task) {
  return task?.generation ?? task?.runtimeGeneration ?? task?.runtime_generation ?? task?.targetIdentity?.generation ?? task?.target_identity?.generation ?? null;
}

function taskSoftAnomalyTypes(task) {
  const values = task?.softAnomalyTypes
    ?? task?.soft_anomaly_types
    ?? task?.softAnomalies
    ?? task?.soft_anomalies
    ?? task?.anomalies
    ?? [];
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map((value) => typeof value === "string" ? value : value?.type ?? value?.category).filter(Boolean).map(String))].sort();
}

function taskActionable(task) {
  if (booleanValue(task?.actionable ?? task?.needsAttention ?? task?.needs_attention)) return true;
  if (task?.actionable === false || task?.needsAttention === false || task?.needs_attention === false) return false;
  return new Set(["blocked", "failed", "error", "needs_attention", "awaiting_user", "waiting_user", "requires_action"]).has(taskStatus(task));
}

function taskStalled(task, { now = Date.now(), thresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS } = {}) {
  if (booleanValue(task?.stalled ?? task?.isStalled ?? task?.is_stalled)) return true;
  if (task?.stalled === false || task?.isStalled === false || task?.is_stalled === false) return false;
  const status = taskStatus(task);
  if (!taskIsActiveStatus(status)) return false;
  const value = task?.lastProgressAt ?? task?.last_progress_at ?? task?.updatedAt ?? task?.updated_at ?? task?.updatedAtMs ?? task?.updated_at_ms;
  const timestamp = taskTimestampMs(value);
  return timestamp !== null && now - timestamp >= Math.max(1_000, Number(thresholdMs) || DEFAULT_STALLED_TASK_THRESHOLD_MS);
}

function previousThreadInspectionMap(previous) {
  if (Array.isArray(previous)) {
    return new Map(previous.map((item) => [String(item?.threadId ?? item?.thread_id ?? ""), item]).filter(([key]) => key));
  }
  if (!previous || typeof previous !== "object") return new Map();
  return new Map(Object.entries(previous).filter(([key, value]) => key && value && typeof value === "object"));
}

function softAnomalyConfirmationForTask(task, previous) {
  const direct = task?.softAnomalyConfirmation ?? task?.soft_anomaly_confirmation;
  if (booleanValue(task?.softAnomalyConfirmed ?? task?.soft_anomaly_confirmed)) return true;
  if (booleanValue(direct?.confirmed)) return true;
  return booleanValue(previous?.softAnomalyConfirmed ?? previous?.soft_anomaly_confirmed)
    || booleanValue(previous?.softAnomalyConfirmation?.confirmed ?? previous?.soft_anomaly_confirmation?.confirmed);
}

function buildThreadInspectionEntries({
  tasks = [],
  previousInspections = null,
  previousInspectionRunAt = null,
  now = Date.now(),
  stalledTaskThresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
  source = "codex_app_thread_list",
  maxTasks = MAX_LIGHTWEIGHT_THREAD_INSPECTIONS,
} = {}) {
  const previous = previousThreadInspectionMap(previousInspections);
  const listed = Array.isArray(tasks) ? tasks : [];
  const eligible = [];
  for (const task of listed) {
    const threadId = taskThreadId(task);
    if (!threadId || !taskOwnerIsUser(task, { source })) continue;
    const previousItem = previous.get(String(threadId));
    const revision = taskRevision(task);
    const updatedAt = taskUpdatedAt(task);
    const generation = taskGeneration(task);
    const status = taskStatus(task);
    const active = taskIsActiveStatus(status);
    const terminal = booleanValue(task?.completed ?? task?.interrupted ?? task?.archived)
      || ["completed", "complete", "done", "closed", "archived", "cancelled", "canceled", "interrupted", "paused"].includes(status)
      || ["history", "paused"].includes(String(task?.stateScope ?? task?.state_scope ?? "").toLowerCase());
    const actionable = !terminal && taskActionable(task);
    const stalled = !terminal && taskStalled(task, { now, thresholdMs: stalledTaskThresholdMs });
    const softAnomalyTypes = taskSoftAnomalyTypes(task);
    const softAnomalyConfirmed = softAnomalyConfirmationForTask(task, previousItem);
    const samePreviousRun = !previousInspectionRunAt
      || !previousItem?.lastSeenAt
      || String(previousItem.lastSeenAt) === String(previousInspectionRunAt);
    const changed = task?.changed !== undefined
      ? booleanValue(task.changed)
      : !previousItem
        || !samePreviousRun
        || revision !== (previousItem.revision ?? null)
        || updatedAt !== (previousItem.updatedAt ?? previousItem.updated_at ?? null)
        || generation !== (previousItem.generation ?? null)
        || status !== String(previousItem.status ?? "unknown").toLowerCase();
    const reasons = [];
    if (changed && !terminal) reasons.push("changed");
    if (stalled) reasons.push("stalled");
    if (actionable) reasons.push("actionable");
    // An active task may still be making progress while its latest turn
    // contains a Companion wobble. Read the current thread within the
    // bounded deep-read cap so a stable-looking task is not invisible to the
    // proactive stability scan. This never authorizes interruption or send.
    if (active && !terminal) reasons.push("active");
    // The official App Server list intentionally keeps lifecycle and latest
    // turn details shallow for inactive/notLoaded tasks.  Those are exactly
    // the checkpoints that can hide a stopped task behind
    // `latestTurnStatus=unknown`; select them for one bounded deep read so
    // the same task can be classified before any relay decision.
    if (!terminal && ["notloaded", "not_loaded", "unknown"].includes(status)) reasons.push("not_loaded");
    if (softAnomalyConfirmed && !terminal) reasons.push("soft_anomaly_confirmed");
    eligible.push({
      task,
      previousInspection: previousItem,
      threadId: String(threadId),
      hostId: taskHostId(task),
      owner: taskOwner(task) || (source === "codex_app_thread_list" || source === "codex_app_task_list" ? "user" : null),
      status,
      revision,
      updatedAt,
      generation,
      actionable,
      stalled,
      active,
      softAnomalyTypes,
      softAnomalyConfirmed,
      changed,
      deepReadEligible: reasons.length > 0,
      deepReadReasons: reasons,
    });
    if (eligible.length >= Math.max(0, Number(maxTasks) || MAX_LIGHTWEIGHT_THREAD_INSPECTIONS)) break;
  }
  return { entries: eligible, listedCount: listed.length, skippedNonUserOwnedCount: Math.max(0, listed.length - eligible.length) };
}

function publicThreadInspectionEntry(entry, { lightweight = null, deepRead = null } = {}) {
  const task = entry?.task ?? {};
  return {
    threadId: entry.threadId,
    hostId: entry.hostId ?? null,
    owner: entry.owner ?? null,
    status: entry.status,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    generation: entry.generation,
    latestTurnStatus: task.latestTurnStatus ?? null,
    goalStatus: task.goalStatus ?? null,
    planStatus: task.planStatus ?? null,
    exactBlocker: task.exactBlocker ?? null,
    actionable: entry.actionable,
    stalled: entry.stalled,
    active: entry.active,
    changed: entry.changed,
    softAnomalyTypes: entry.softAnomalyTypes,
    softAnomalyConfirmed: entry.softAnomalyConfirmed,
    deepReadEligible: entry.deepReadEligible,
    deepReadReasons: entry.deepReadReasons,
    lightweight: lightweight ?? { status: "not_run", exactBlocker: "thread_lightweight_inspection_not_supplied" },
    deepRead: deepRead ?? { status: "not_run", exactBlocker: entry.deepReadEligible ? "thread_deep_read_not_supplied" : "not_a_deep_read_candidate" },
  };
}

function callbackReadback(value, fallbackBlocker) {
  if (value === undefined || value === null) return { status: "not_run", exactBlocker: fallbackBlocker };
  if (value?.isError === true || value?.ok === false || value?.success === false || value?.status === "failed") {
    return { status: "failed", exactBlocker: String(value?.exact_blocker ?? value?.exactBlocker ?? value?.error ?? fallbackBlocker).slice(0, 400) };
  }
  const has = (...keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
  const threadStatus = value?.threadStatus
    ?? value?.thread_status
    ?? value?.lifecycleState
    ?? value?.lifecycle_state
    ?? value?.state
    ?? value?.status
    ?? null;
  const actionableKeys = ["actionable", "needsAttention", "needs_attention"];
  const stalledKeys = ["stalled", "isStalled", "is_stalled"];
  const changedKeys = ["changed", "hasChanged", "has_changed"];
  const softAnomalyKeys = ["softAnomalyTypes", "soft_anomaly_types", "softAnomalies", "soft_anomalies", "anomalies"];
  const softConfirmedKeys = ["softAnomalyConfirmed", "soft_anomaly_confirmed", "softAnomalyConfirmation", "soft_anomaly_confirmation"];
  const latestTurnStatusKeys = ["latestTurnStatus", "latest_turn_status"];
  const goalStatusKeys = ["goalStatus", "goal_status"];
  const planStatusKeys = ["planStatus", "plan_status"];
  const exactBlockerKeys = ["exactBlocker", "exact_blocker"];
  const hasActionable = has(...actionableKeys);
  const hasStalled = has(...stalledKeys);
  const hasChanged = has(...changedKeys);
  const hasSoftAnomalies = has(...softAnomalyKeys);
  const hasSoftConfirmation = has(...softConfirmedKeys);
  const hasLatestTurnStatus = has(...latestTurnStatusKeys);
  const hasGoalStatus = has(...goalStatusKeys);
  const hasPlanStatus = has(...planStatusKeys);
  const hasExactBlocker = has(...exactBlockerKeys);
  const actionableValue = actionableKeys.find((key) => has(key));
  const stalledValue = stalledKeys.find((key) => has(key));
  const changedValue = changedKeys.find((key) => has(key));
  const softConfirmedValue = softConfirmedKeys.find((key) => has(key));
  const latestTurnStatusValue = latestTurnStatusKeys.find((key) => has(key));
  const goalStatusValue = goalStatusKeys.find((key) => has(key));
  const planStatusValue = planStatusKeys.find((key) => has(key));
  const exactBlockerValue = exactBlockerKeys.find((key) => has(key));
  const softConfirmed = softConfirmedValue
    ? typeof value[softConfirmedValue] === "object"
      ? booleanValue(value[softConfirmedValue]?.confirmed)
      : booleanValue(value[softConfirmedValue])
    : false;
  return {
    status: "observed",
    exactBlocker: null,
    threadStatus: threadStatus === null || threadStatus === undefined ? null : String(threadStatus).toLowerCase(),
    threadStatusKnown: threadStatus !== null && threadStatus !== undefined && String(threadStatus) !== "",
    revision: value?.revision ?? value?.revisionId ?? value?.revision_id ?? null,
    revisionKnown: has("revision", "revisionId", "revision_id"),
    updatedAt: value?.updatedAt ?? value?.updated_at ?? null,
    updatedAtKnown: has("updatedAt", "updated_at"),
    generation: value?.generation ?? value?.runtimeGeneration ?? value?.runtime_generation ?? null,
    generationKnown: has("generation", "runtimeGeneration", "runtime_generation"),
    latestTurnStatus: hasLatestTurnStatus ? String(value[latestTurnStatusValue] ?? "").toLowerCase() || "unknown" : null,
    latestTurnStatusKnown: hasLatestTurnStatus,
    goalStatus: hasGoalStatus ? String(value[goalStatusValue] ?? "").toLowerCase() || "unknown" : null,
    goalStatusKnown: hasGoalStatus,
    planStatus: hasPlanStatus ? String(value[planStatusValue] ?? "").toLowerCase() || "unknown" : null,
    planStatusKnown: hasPlanStatus,
    exactBlocker: hasExactBlocker ? value[exactBlockerValue] ?? null : null,
    exactBlockerKnown: hasExactBlocker,
    owner: value?.owner ?? value?.ownerKind ?? value?.owner_kind ?? null,
    ownerKnown: has("owner", "ownerKind", "owner_kind"),
    actionable: hasActionable ? booleanValue(value[actionableValue]) : null,
    actionableKnown: hasActionable,
    stalled: hasStalled ? booleanValue(value[stalledValue]) : null,
    stalledKnown: hasStalled,
    changed: hasChanged ? booleanValue(value[changedValue]) : null,
    changedKnown: hasChanged,
    softAnomalyTypes: hasSoftAnomalies ? taskSoftAnomalyTypes(value) : null,
    softAnomalyTypesKnown: hasSoftAnomalies,
    softAnomalyConfirmed: softConfirmed,
    softAnomalyConfirmedKnown: hasSoftConfirmation,
  };
}

function mergeLightweightThreadReadback(entry, lightweight, {
  now = Date.now(),
  stalledTaskThresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
} = {}) {
  if (!entry || lightweight?.status !== "observed") return entry;
  const task = { ...(entry.task || {}) };
  if (lightweight.threadStatusKnown) task.status = lightweight.threadStatus;
  if (lightweight.revisionKnown) task.revision = lightweight.revision;
  if (lightweight.updatedAtKnown) task.updatedAt = lightweight.updatedAt;
  if (lightweight.generationKnown) task.generation = lightweight.generation;
  if (lightweight.latestTurnStatusKnown) task.latestTurnStatus = lightweight.latestTurnStatus;
  if (lightweight.goalStatusKnown) task.goalStatus = lightweight.goalStatus;
  if (lightweight.planStatusKnown) task.planStatus = lightweight.planStatus;
  if (lightweight.exactBlockerKnown) task.exactBlocker = lightweight.exactBlocker;
  if (lightweight.ownerKnown) task.owner = lightweight.owner;
  if (lightweight.actionableKnown) task.actionable = lightweight.actionable;
  if (lightweight.stalledKnown) task.stalled = lightweight.stalled;
  if (lightweight.changedKnown) task.changed = lightweight.changed;
  if (lightweight.softAnomalyTypesKnown) task.softAnomalyTypes = lightweight.softAnomalyTypes;
  if (lightweight.softAnomalyConfirmedKnown) task.softAnomalyConfirmed = lightweight.softAnomalyConfirmed;

  const status = taskStatus(task);
  const active = taskIsActiveStatus(status);
  const terminal = booleanValue(task?.completed ?? task?.interrupted ?? task?.archived)
    || ["completed", "complete", "done", "closed", "archived", "cancelled", "canceled", "interrupted", "paused"].includes(status)
    || ["history", "paused"].includes(String(task?.stateScope ?? task?.state_scope ?? "").toLowerCase());
  const actionable = !terminal && taskActionable(task);
  const stalled = !terminal && taskStalled(task, { now, thresholdMs: stalledTaskThresholdMs });
  let changed = entry.changed;
  if (lightweight.changedKnown) {
    changed = lightweight.changed;
  } else if (entry.previousInspection) {
    const previous = entry.previousInspection;
    const previousRevision = previous.revision ?? previous.revisionId ?? previous.revision_id ?? null;
    const previousUpdatedAt = previous.updatedAt ?? previous.updated_at ?? null;
    const previousGeneration = previous.generation ?? previous.runtimeGeneration ?? previous.runtime_generation ?? null;
    const previousStatus = String(previous.status ?? previous.state ?? "unknown").toLowerCase();
    changed = Boolean(changed
      || (lightweight.revisionKnown && String(lightweight.revision ?? "") !== String(previousRevision ?? ""))
      || (lightweight.updatedAtKnown && String(lightweight.updatedAt ?? "") !== String(previousUpdatedAt ?? ""))
      || (lightweight.generationKnown && String(lightweight.generation ?? "") !== String(previousGeneration ?? ""))
      || (lightweight.threadStatusKnown && status !== previousStatus));
  }
  const softAnomalyConfirmed = lightweight.softAnomalyConfirmedKnown
    ? lightweight.softAnomalyConfirmed
    : entry.softAnomalyConfirmed;
  const ownerValue = lightweight.ownerKnown ? lightweight.owner : entry.owner;
  const owner = typeof ownerValue === "object"
    ? ownerValue?.kind ?? ownerValue?.type ?? ownerValue?.name ?? ""
    : ownerValue;
  const ownerIsUser = !lightweight.ownerKnown
    || new Set(["user", "user_owned", "user-owned", "human"]).has(String(owner ?? "").trim().toLowerCase());
  const reasons = [];
  if (changed && !terminal) reasons.push("changed");
  if (stalled) reasons.push("stalled");
  if (actionable) reasons.push("actionable");
  if (active && !terminal) reasons.push("active");
  // The official App Server's lightweight projection may expose an inactive
  // task as notLoaded with an unknown latest turn. Preserve that signal after
  // the lightweight callback so the bounded deep read actually runs and can
  // recover a current interrupted/Goal state before any continuation gate.
  if (!terminal && ["notloaded", "not_loaded", "unknown"].includes(status)) reasons.push("not_loaded");
  if (softAnomalyConfirmed && !terminal) reasons.push("soft_anomaly_confirmed");
  return {
    ...entry,
    task,
    owner: ownerValue,
    status,
    revision: lightweight.revisionKnown ? lightweight.revision : entry.revision,
    updatedAt: lightweight.updatedAtKnown ? lightweight.updatedAt : entry.updatedAt,
    generation: lightweight.generationKnown ? lightweight.generation : entry.generation,
    actionable,
    stalled,
    active,
    changed,
    softAnomalyTypes: lightweight.softAnomalyTypesKnown ? lightweight.softAnomalyTypes : entry.softAnomalyTypes,
    softAnomalyConfirmed,
    deepReadEligible: ownerIsUser && reasons.length > 0,
    deepReadReasons: ownerIsUser ? reasons : ["owner_changed_or_non_user"],
  };
}

function mergeDeepThreadReadback(entry, deepReadback, options = {}) {
  if (!entry || deepReadback?.status !== "observed") return entry;
  const meaningfulText = (value) => value !== null && value !== undefined && String(value).trim() !== "" && String(value).toLowerCase() !== "unknown";
  const meaningfulBool = (value) => typeof value === "boolean";
  const meaningfulArray = (value) => Array.isArray(value) && value.length > 0;
  const selective = {
    ...deepReadback,
    threadStatusKnown: deepReadback.threadStatusKnown === true && meaningfulText(deepReadback.threadStatus),
    revisionKnown: deepReadback.revisionKnown === true && meaningfulText(deepReadback.revision),
    updatedAtKnown: deepReadback.updatedAtKnown === true && meaningfulText(deepReadback.updatedAt),
    generationKnown: deepReadback.generationKnown === true && meaningfulText(deepReadback.generation),
    latestTurnStatusKnown: deepReadback.latestTurnStatusKnown === true && meaningfulText(deepReadback.latestTurnStatus),
    goalStatusKnown: deepReadback.goalStatusKnown === true && meaningfulText(deepReadback.goalStatus),
    planStatusKnown: deepReadback.planStatusKnown === true && meaningfulText(deepReadback.planStatus),
    exactBlockerKnown: deepReadback.exactBlockerKnown === true && meaningfulText(deepReadback.exactBlocker),
    ownerKnown: deepReadback.ownerKnown === true && meaningfulText(deepReadback.owner),
    actionableKnown: deepReadback.actionableKnown === true && meaningfulBool(deepReadback.actionable),
    stalledKnown: deepReadback.stalledKnown === true && meaningfulBool(deepReadback.stalled),
    changedKnown: deepReadback.changedKnown === true && meaningfulBool(deepReadback.changed),
    softAnomalyTypesKnown: deepReadback.softAnomalyTypesKnown === true && meaningfulArray(deepReadback.softAnomalyTypes),
    // Official deep projections intentionally do not grant the consecutive
    // soft-anomaly confirmation used by the audit ledger.
    softAnomalyConfirmedKnown: false,
  };
  const merged = mergeLightweightThreadReadback(entry, selective, options);
  // `deepReadEligible` describes the selection made before the read. Keep it
  // stable for the receipt even if the task completes while being inspected;
  // the updated status itself remains the authoritative post-readback state.
  return {
    ...merged,
    deepReadEligible: entry.deepReadEligible,
    deepReadReasons: entry.deepReadReasons,
  };
}

export function buildThreadInspectionPlan(options = {}) {
  const { entries, listedCount, skippedNonUserOwnedCount } = buildThreadInspectionEntries(options);
  const candidates = entries.filter((entry) => entry.deepReadEligible);
  const maxDeepReads = Math.max(0, Number(options.maxDeepReads) || MAX_DEEP_THREAD_READS);
  return {
    schema: THREAD_INSPECTION_SCHEMA,
    source: options.source ?? "codex_app_thread_list",
    mode: "lightweight_all_then_deep_read_candidates",
    listedCount,
    eligibleTaskCount: entries.length,
    skippedNonUserOwnedCount,
    lightweightInspectionCount: entries.length,
    deepReadCandidateCount: candidates.length,
    deepReadLimit: maxDeepReads,
    records: entries.map((entry) => publicThreadInspectionEntry(entry)),
    deepReadCandidates: candidates.slice(0, maxDeepReads).map((entry) => ({
      threadId: entry.threadId,
      hostId: entry.hostId ?? null,
      reasons: entry.deepReadReasons,
    })),
    deepReadTruncated: candidates.length > maxDeepReads,
  };
}

export function selectDeepReadCandidates(tasks = [], options = {}) {
  return buildThreadInspectionPlan({ ...options, tasks }).deepReadCandidates;
}

export async function inspectRecentUserThreads({
  tasks = [],
  inspectThread = null,
  readThread = null,
  previousInspections = null,
  previousInspectionRunAt = null,
  now = Date.now(),
  stalledTaskThresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
  source = "codex_app_thread_list",
  maxTasks = MAX_LIGHTWEIGHT_THREAD_INSPECTIONS,
  maxDeepReads = MAX_DEEP_THREAD_READS,
} = {}) {
  const { entries, listedCount, skippedNonUserOwnedCount } = buildThreadInspectionEntries({
    tasks,
    previousInspections,
    previousInspectionRunAt,
    now,
    stalledTaskThresholdMs,
    source,
    maxTasks,
  });
  const deepReadLimit = Math.max(0, Number(maxDeepReads) || MAX_DEEP_THREAD_READS);
  let lightweightReadCount = 0;
  let deepReadCount = 0;
  const lightweightReadbacks = [];
  for (const entry of entries) {
    let lightweight;
    if (typeof inspectThread === "function") {
      try {
        lightweight = callbackReadback(await inspectThread({
          stage: "lightweight_thread_inspection",
          task: entry.task,
          threadId: entry.threadId,
          hostId: entry.hostId,
          turnLimit: 1,
          includeOutputs: false,
        }), "thread_lightweight_inspection_failed");
      } catch (error) {
        lightweight = { status: "failed", exactBlocker: String(error?.code ?? error?.message ?? "thread_lightweight_inspection_failed").slice(0, 400) };
      }
      if (lightweight.status === "observed") lightweightReadCount += 1;
    } else {
      lightweight = { status: "metadata_only", exactBlocker: "thread_lightweight_inspection_callback_not_supplied" };
    }
    lightweightReadbacks.push(lightweight);
  }
  const observedEntries = entries.map((entry, index) => mergeLightweightThreadReadback(entry, lightweightReadbacks[index], {
    now,
    stalledTaskThresholdMs,
  }));
  let deepReadCandidateIndex = 0;
  const records = [];
  for (const [index, entry] of observedEntries.entries()) {
    const lightweight = lightweightReadbacks[index];
    const deepReadIndex = deepReadCandidateIndex;
    if (entry.deepReadEligible) deepReadCandidateIndex += 1;
    const deepReadAllowed = entry.deepReadEligible && deepReadIndex < deepReadLimit;
    let deepRead = { status: "not_run", exactBlocker: entry.deepReadEligible ? deepReadIndex >= deepReadLimit ? "thread_deep_read_limit_reached" : "thread_deep_read_callback_not_supplied" : "not_a_deep_read_candidate" };
    if (deepReadAllowed && typeof readThread === "function") {
      try {
        deepRead = callbackReadback(await readThread({
          stage: "deep_thread_read",
          task: entry.task,
          threadId: entry.threadId,
          hostId: entry.hostId,
          turnLimit: 8,
          includeOutputs: true,
        }), "thread_deep_read_failed");
      } catch (error) {
        deepRead = { status: "failed", exactBlocker: String(error?.code ?? error?.message ?? "thread_deep_read_failed").slice(0, 400) };
      }
      if (deepRead.status === "observed") deepReadCount += 1;
    }
    let recordEntry = entry;
    if (deepRead.status === "observed") {
      // A deep read is not just a receipt that the API responded. Feed its
      // current task/turn/blocker state back into the inspection record so a
      // Companion wobble found in an active thread becomes a real repair
      // candidate in this same audit. Preserve the two-run soft-anomaly
      // confirmation from the inspection ledger; the bounded official
      // projection intentionally does not grant that confirmation.
      recordEntry = mergeDeepThreadReadback(entry, deepRead, {
        now,
        stalledTaskThresholdMs,
      });
      recordEntry.softAnomalyConfirmed = entry.softAnomalyConfirmed;
      recordEntry.task = {
        ...(recordEntry.task || {}),
        softAnomalyConfirmed: entry.task?.softAnomalyConfirmed,
      };
    }
    records.push(publicThreadInspectionEntry(recordEntry, { lightweight, deepRead }));
  }
  const candidates = observedEntries.filter((entry) => entry.deepReadEligible);
  return {
    schema: THREAD_INSPECTION_SCHEMA,
    source,
    mode: "lightweight_all_then_deep_read_candidates",
    listedCount,
    eligibleTaskCount: entries.length,
    skippedNonUserOwnedCount,
    lightweightInspectionCount: entries.length,
    lightweightReadCount,
    deepReadCandidateCount: candidates.length,
    deepReadAttemptedCount: records.filter((record) => record.deepRead.status !== "not_run" && record.deepRead.status !== "not_a_deep_read_candidate").length,
    deepReadCount,
    deepReadLimit,
    deepReadTruncated: candidates.length > deepReadLimit,
    records,
    deepReadCandidates: candidates.slice(0, deepReadLimit).map((entry) => ({ threadId: entry.threadId, hostId: entry.hostId ?? null, reasons: entry.deepReadReasons })),
    externalActionExecuted: false,
  };
}

/**
 * Convert an explicit fresh deep-read result into a bounded proactive repair.
 * A repeated soft signal alone never enters this function: the root must say
 * that the current issue is Companion-local, identify a known playbook, and
 * provide fresh deep-read confirmation. The returned plan is still subject
 * to the normal owner, idle, same-run E2E, and no-replay gates.
 */
export function buildProactiveRepairPlan(item = {}) {
  const source = item?.proactiveRepair ?? item?.proactive_repair ?? item ?? {};
  const alreadyNormalized = source?.schema === COMPANION_PROACTIVE_REPAIR_SCHEMA
    && source?.automatic === true
    && PROACTIVE_PLAYBOOK_IDS.has(String(source?.playbookId || ""));
  if (alreadyNormalized) return source;

  const companionLocal = item?.proactiveCompanionLocal === true
    || item?.proactive_companion_local === true
    || source?.companionLocal === true
    || source?.companion_local === true;
  const freshDeepRead = item?.proactiveRepairReady === true
    || item?.proactive_repair_ready === true
    || source?.freshDeepRead === true
    || source?.fresh_deep_read === true;
  const softAnomalyConfirmed = item?.softAnomalyConfirmed === true
    || source?.softAnomalyConfirmed === true
    || source?.soft_anomaly_confirmed === true;
  const preventiveCheck = item?.preventiveCheck === true
    || item?.preventive_check === true
    || source?.preventive === true;
  if (!companionLocal || !freshDeepRead || (!softAnomalyConfirmed && !preventiveCheck)) return null;

  const playbookId = String(source?.playbookId ?? item?.proactivePlaybookId ?? item?.proactive_playbook_id ?? "");
  if (!PROACTIVE_PLAYBOOK_IDS.has(playbookId) || !REPAIR_PLAYBOOKS[playbookId]) return null;
  const softAnomalyType = source?.softAnomalyType
    ?? source?.soft_anomaly_type
    ?? item?.softAnomalyType
    ?? item?.soft_anomaly_type
    ?? null;
  if (softAnomalyType && !PROACTIVE_SOFT_ANOMALY_TYPES.has(String(softAnomalyType))) return null;
  const playbook = REPAIR_PLAYBOOKS[playbookId];
  return {
    schema: COMPANION_PROACTIVE_REPAIR_SCHEMA,
    disposition: "proactive_companion_local_repair",
    playbookId,
    automatic: true,
    preventive: true,
    trigger: softAnomalyConfirmed
      ? `confirmed_soft_anomaly:${String(softAnomalyType || "unknown")}`
      : "fresh_preventive_deep_read",
    evidence: "root_owned_fresh_deep_read",
    nextAction: playbook.action,
    stopConditions: playbook.stopConditions,
  };
}

function normalizeProactiveRepairCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const plan = buildProactiveRepairPlan(candidate);
  if (!plan) return null;
  const threadId = candidate.threadId ?? candidate.thread_id;
  if (!threadId) return null;
  return {
    ...candidate,
    threadId: String(threadId),
    companionIssue: true,
    proactiveRepairReady: true,
    proactiveCompanionLocal: true,
    repairPlan: plan,
  };
}

export const COMPANION_BLOCKER_PROGRESS_SCHEMA = "aos.companion_blocker_progress.v1";

const BLOCKER_PROGRESS_REASONS = new Set([
  "unknown_effect",
  "send_result_unknown",
  "thread_readback_unavailable",
  "foreign_owner",
  "target_mismatch",
  "capability_missing",
  "active_reconciliation",
  "external_service_limit",
  "human_auth_required",
]);

function blockerText(item = {}) {
  const values = [
    item?.exactBlocker,
    item?.exact_blocker,
    item?.reason,
    item?.blocker,
    item?.status,
    item?.latestSummary,
    item?.latest_summary,
    item?.resumeAssessment?.reason,
    item?.resume_assessment?.reason,
    ...(Array.isArray(item?.companionMarkers) ? item.companionMarkers : []),
    ...(Array.isArray(item?.markers) ? item.markers : []),
  ];
  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => typeof value === "object" ? JSON.stringify(value) : String(value))
    .join(" ")
    .toLowerCase()
    .slice(0, 4_000);
}

/**
 * Normalize task-level stop signals into the bounded action that can make
 * progress now.  This is deliberately distinct from resume-controller's
 * safety reason: `target_mismatch` and `send_result_unknown` must remain
 * visible instead of collapsing into a generic `foreign_owner`/unknown
 * bucket, otherwise the scheduler cannot select the right readback.
 */
export function classifyOperationalBlocker(item = {}) {
  const source = blockerText(item);
  const has = (pattern) => pattern.test(source);
  if (has(/(?:operation[_ ]effect[_ ]unknown|unknown[_ ]effect|effect[_ ]unknown|result[_ ]unknown|external[_ ]action[_ ]unknown)/u)) return "unknown_effect";
  // A task-level official-App list/read mismatch is neither a send outcome
  // nor permission to retry. Keep it distinct so the scheduler can preserve
  // the task and request one fresh same-target readback on a later tick.
  if (has(/(?:thread[_ ](?:lightweight[_ ]inspection|deep[_ ]read|readback)[_ ](?:failed|unavailable|not[_ ]supplied|not[_ ]confirmed|bounded[_ ]error|callback[_ ]not[_ ]supplied)|thread[_ ]readback[_ ]projection[_ ]bounded[_ ]error|codex[_ ]app[_ ]thread[_ ]readback[_ ]all[_ ]failed)/u)) return "thread_readback_unavailable";
  if (has(/(?:sent[_ ]unverified|send[_ ]result[_ ]unknown|thread[_ ]send[_ ]ack[_ ]unknown|thread[_ ]readback[_ ](?:not[_ ]supplied|failed|unavailable)|message[_ ]readback[_ ]unknown)/u)) return "send_result_unknown";
  if (has(/(?:transaction[_ ]action[_ ]target[_ ]page[_ ]mismatch|target[_ ]page[_ ]mismatch|page[_ ]instance[_ ]mismatch|target[_ ]mismatch|target不一致|ambiguous[_ ]target)/u)) return "target_mismatch";
  if (has(/(?:session[_ ]not[_ ]owned|foreign[_ ]owner|foreign[_ ]task|owner[_ ]mismatch|ownership[_ ]mismatch|not[_ ]owner)/u)) return "foreign_owner";
  if (has(/(?:capability[_ ](?:not[_ ]supported|missing|unavailable)|companion[_ ]capability[_ ]handshake[_ ]failed|identity[_ ]capability[_ ]unavailable|operation[_ ]not[_ ]supported|not[_ ](?:fully[_ ])?supported|unsupported|not[_ ]exposed|未対応|未サポート|extension\.reload[_ ]unavailable|backend[_ ](?:mismatch|unavailable)|chrome_profile2_preflight_backend_mismatch)/u)) return "capability_missing";
  if (has(/(?:active[_ ]reconciliation|reconciliation[_ ](?:required|pending|active))/u)) return "active_reconciliation";
  if (has(/(?:lightchain[_ ]permission[_ ]denied|権限がありません|permission[_ ]denied|access[_ ]denied|exceed[_ ]egress[_ ]quota|egress[_ ]quota|http[_ ]402|provider[_ ](?:quota|limit)|quota[_ ](?:exceeded|exhausted))/u)) return "external_service_limit";
  if (item?.userHelpRequired === true || has(/(?:human[_ ]auth(?:entication)?[_ ]required|otp|captcha|本人確認|認証コード)/u)) return "human_auth_required";
  return null;
}

/**
 * Return the one safe progress attempt for a task-level blocker.  The result
 * is a plan, not permission to adopt a foreign resource, replay an unknown
 * effect, or invent a missing capability.  A root callback may later attach
 * fresh proof and set `resumeAllowed=true`.
 */
export function buildBlockerProgressPlan(item = {}) {
  const reason = classifyOperationalBlocker(item);
  if (!BLOCKER_PROGRESS_REASONS.has(reason)) return null;
  const threadId = item?.threadId ?? item?.thread_id ?? null;
  const exactBlocker = item?.exactBlocker ?? item?.exact_blocker ?? reason;
  const plans = {
    unknown_effect: {
      progressAttemptNow: "one same-task signed source-of-truth reconciliation for the existing idempotency key",
      result: "unknown_effect remains quarantined; the original operation is not replayed",
      nextActionNow: "retain the operation capsule and use one fresh owner-scoped reconciliation readback",
      resumeTrigger: "known_no_effect or an explicit same-task reconciliation proof",
      fallbackOrIndependentWork: "continue unrelated owner-scoped tasks and read-only diagnostics",
    },
    send_result_unknown: {
      progressAttemptNow: "one same-target Codex task readback or bounded wait for the existing send idempotency key",
      result: "send outcome is classified without sending again; duplicate delivery is suppressed",
      nextActionNow: "read the same task and key once, then record sent, sent_unverified, or deferred",
      resumeTrigger: "same-target readback observes the message or a fresh bounded retry boundary is authorized",
      fallbackOrIndependentWork: "continue unrelated tasks; preserve the intent/receipt ledger entry",
    },
    thread_readback_unavailable: {
      progressAttemptNow: "one fresh same-target official-App task readback using the listed threadId and hostId",
      result: "the list/read inconsistency is retained as a task-local blocker; no task message or browser/provider effect is retried",
      nextActionNow: "on the next fresh scheduler boundary, re-read the same task once and classify the current status, turn, Goal, Plan, owner, and blocker",
      resumeTrigger: "same-target official-App readback returns an observed task state with matching identity",
      fallbackOrIndependentWork: "continue unrelated user-owned tasks and retain this task's exact readback failure evidence",
    },
    foreign_owner: {
      progressAttemptNow: "fresh owner-scoped task/session/tab readback; do not adopt, close, or clean the foreign resource",
      result: "foreign ownership is preserved as an exact task-local blocker",
      nextActionNow: "re-read the current owner and task binding; rebind only if the current task proves ownership",
      resumeTrigger: "fresh owner proof for the same task and target, or the owning task releases it",
      fallbackOrIndependentWork: "continue independent tasks and retain foreign resources as evidence-only",
    },
    target_mismatch: {
      progressAttemptNow: "fresh tabs/target identity readback with semantic and visual confirmation",
      result: "target is not guessed; an owner-scoped rebind candidate is recorded",
      nextActionNow: "rebind task/session/lease/pageInstance only after exact task, generation, origin, and target proof match",
      resumeTrigger: "fresh target identity matches the existing Goal/Plan and owner",
      fallbackOrIndependentWork: "continue independent tasks without touching the mismatched target",
    },
    capability_missing: {
      progressAttemptNow: "capture the current Companion capability/schema handshake and enter the matching adapter repair path",
      result: "the missing capability enters bounded implementation or current-runtime revalidation; it is not left as a passive candidate",
      nextActionNow: "if the current runtime already advertises it, verify that fact and resume the existing Goal; otherwise implement the matching adapter/schema, run focused checks and a read-only canary, then verify installed generation parity",
      resumeTrigger: "capability is advertised by the current generation and the matching canary/readback passes",
      fallbackOrIndependentWork: "prepare the Goal's next action and continue tasks that do not require the missing capability",
    },
    active_reconciliation: {
      progressAttemptNow: "one fresh reconciliation status/readback for the active task resource",
      result: "active reconciliation remains isolated from new work",
      nextActionNow: "complete or preserve the current reconciliation from the same owner; do not start another operation",
      resumeTrigger: "reconciliation is explicitly resolved and the current target is fresh",
      fallbackOrIndependentWork: "continue unrelated owner-scoped tasks",
    },
    external_service_limit: {
      progressAttemptNow: "one fresh provider/permission status readback for the same task and target",
      result: "the provider or permission limit remains an external gate; no bypass or duplicate operation is attempted",
      nextActionNow: "retain the Goal checkpoint and re-check the same provider/account state after the gate changes",
      resumeTrigger: "fresh same-task readback proves the provider/permission gate is cleared",
      fallbackOrIndependentWork: "continue independent local work and tasks that do not require the blocked provider state",
    },
    human_auth_required: {
      progressAttemptNow: "record the visible human-only gate and preserve the task checkpoint",
      result: "human authentication is not guessed or automated",
      nextActionNow: "wait for the specific human action, then perform a fresh task readback",
      resumeTrigger: "the human gate is completed and fresh status/readback proves the same task can continue",
      fallbackOrIndependentWork: "continue independent read-only work",
    },
  }[reason];
  return {
    schema: COMPANION_BLOCKER_PROGRESS_SCHEMA,
    threadId: threadId ? String(threadId) : null,
    reason,
    exactBlocker: String(exactBlocker || reason).slice(0, 400),
    taskDisposition: "deferred",
    stopClass: ["unknown_effect", "send_result_unknown", "foreign_owner", "target_mismatch", "active_reconciliation", "external_service_limit", "human_auth_required"].includes(reason)
      ? "must_stop"
      : "warn_and_continue",
    automaticActionAllowed: false,
    replayAllowed: false,
    requiresFreshProof: true,
    ...plans,
  };
}

// Blocker codes often join the method to an underscore, for example
// `companion_page_selectText_not_exposed...`; a word boundary would miss
// that form because `_` is itself a word character.
const CAPABILITY_METHOD_RE = /((?:extension|tabs|page|visual|clipboard))(?:\.|_)([A-Za-z][A-Za-z0-9]*)/gu;
const KNOWN_CAPABILITY_METHODS = Object.freeze([
  "extension.reload", "tabs.navigate", "tabs.back", "tabs.forward", "tabs.reload",
  "page.click", "page.doubleClick", "page.hover", "page.setChecked", "page.pressKey",
  "page.selectText", "page.scroll", "page.selectOption", "page.type", "page.upload",
  "page.uploadMultiple", "page.submit", "page.richText", "page.waitFor", "page.delay",
  "visual.pointerMove", "visual.click", "visual.doubleClick", "visual.drag", "visual.scroll",
  "visual.pressKey", "visual.keyDown", "visual.keyUp", "visual.typeText",
  "clipboard.write",
]);

function capabilityMethodFromItem(item) {
  for (const match of blockerText(item).matchAll(CAPABILITY_METHOD_RE)) {
    if (match[1] && match[2]) {
      const value = `${match[1]}.${match[2]}`;
      return KNOWN_CAPABILITY_METHODS.find((method) => method.toLowerCase() === value.toLowerCase()) ?? value;
    }
  }
  return null;
}

function companionContractAdvertises(root, method) {
  if (!root || !method) return false;
  const generatedJson = readJson(path.join(root, "extension", "operation-schema.generated.json"));
  if (Array.isArray(generatedJson?.capabilities) && generatedJson.capabilities.includes(method)) return true;
  if (Array.isArray(generatedJson?.authorizedTransactionMethods) && generatedJson.authorizedTransactionMethods.includes(method)) return true;
  const generatedModule = fileFingerprint(path.join(root, "extension", "operation-schema.generated.js"));
  if (generatedModule.exists) {
    try {
      const source = fs.readFileSync(path.join(root, "extension", "operation-schema.generated.js"), "utf8");
      if (source.includes(JSON.stringify(method))) return true;
    } catch { /* the runtime readback remains authoritative */ }
  }
  return false;
}

/**
 * Attach current runtime proof to a task-level capability blocker. A stale
 * task transcript must not keep a Goal blocked when the installed generation
 * already advertises the required operation. Conversely, a source/install
 * mismatch remains an implementation path and is never silently treated as
 * resolved.
 */
function enrichCapabilityBlocker(item, {
  companionSource,
  companionInstall,
  artifactComparison,
  liveCompanion,
} = {}) {
  if (!item || classifyOperationalBlocker(item) !== "capability_missing") return item;
  const method = capabilityMethodFromItem(item);
  if (!method) return item;
  const sourceAdvertised = companionContractAdvertises(companionSource, method);
  const installedAdvertised = companionContractAdvertises(companionInstall, method);
  const runtimeAdvertised = liveCompanion?.available === true
    && liveCompanion?.connected === true
    && liveCompanion?.availableCapabilities?.includes(method) === true;
  const sourceInstallParity = artifactComparison?.match === true;
  return {
    ...item,
    capabilityMethod: method,
    sourceCapabilityAdvertised: sourceAdvertised,
    installedCapabilityAdvertised: installedAdvertised,
    currentCapabilityAvailable: runtimeAdvertised,
    // This flag is only for a source/install drift that can be repaired by
    // the bounded local implementation path. It is not an authorization to
    // change a browser, provider, or foreign task.
    companionLocal: item.companionLocal === true || (sourceAdvertised && !installedAdvertised && sourceInstallParity),
    capabilityRepairReady: item.capabilityRepairReady === true
      || item.capability_repair_ready === true
      || (sourceAdvertised && !installedAdvertised && sourceInstallParity),
  };
}

/**
 * Convert a text-level candidate into a bounded, human-readable repair plan.
 * This is a plan, not permission to mutate a browser or source tree.
 */
export function buildRepairPlan(item, { artifactComparison = null } = {}) {
  if (!item) {
    return {
      disposition: "unknown",
      playbookId: null,
      automatic: false,
      nextAction: "fresh thread and Companion status readback",
      stopConditions: ["missing task identity"],
    };
  }
  if (item.completed && item.currentTaskReadback !== true) {
    return {
      disposition: "completed",
      playbookId: null,
      automatic: false,
      nextAction: "no resume; preserve completion evidence",
      stopConditions: [],
    };
  }
  if (item.interrupted && item.resumeEligibleAfterProof !== true) {
    return {
      disposition: "paused",
      playbookId: null,
      automatic: false,
      nextAction: "preserve the checkpoint and resume only after a new user request",
      stopConditions: ["the turn was explicitly interrupted; do not auto-resume it"],
    };
  }
  if (item.blocked) {
    const blockerProgress = buildBlockerProgressPlan(item);
    if (blockerProgress?.reason === "capability_missing" && item.currentCapabilityAvailable === true) {
      return {
        disposition: "capability_reflected_resume",
        playbookId: "capability_adapter_repair",
        automatic: false,
        nextAction: "freshly verify the current runtime capability on the same task, then resume the existing Goal without replaying the old blocked action",
        stopConditions: REPAIR_PLAYBOOKS.capability_adapter_repair.stopConditions,
        blockerProgress: {
          ...blockerProgress,
          result: "The current connected generation already advertises the required capability; the historical blocker is eligible for same-task revalidation.",
          runtimeCapabilityVerified: true,
        },
      };
    }
    const boundedRepairReady = Boolean(blockerProgress && item?.companionLocal === true
      && ((item?.capabilityRepairReady === true || item?.capability_repair_ready === true)
        || (blockerProgress?.reason === "target_mismatch"
          && (item?.targetRebindReady === true || item?.target_rebind_ready === true))));
    if (boundedRepairReady) {
      const playbook = blockerProgress.reason === "capability_missing"
        ? REPAIR_PLAYBOOKS.capability_adapter_repair
        : REPAIR_PLAYBOOKS.target_binding;
      return {
        disposition: playbook.id === "capability_adapter_repair" ? "companion_capability_repair" : "companion_target_rebind",
        playbookId: playbook.id,
        automatic: true,
        nextAction: blockerProgress.nextActionNow,
        stopConditions: playbook.stopConditions,
        blockerProgress,
      };
    }
    return {
      disposition: "blocked",
      playbookId: null,
      automatic: false,
      nextAction: blockerProgress?.nextActionNow || "preserve the blocked checkpoint; perform one fresh status/readback to identify the exact blocker before any continuation",
      stopConditions: ["the task or Goal is explicitly blocked; do not auto-resume or duplicate its external work"],
      blockerProgress,
    };
  }
  if (item.userHelpRequired) {
    return {
      disposition: "user_help_required",
      playbookId: null,
      automatic: false,
      nextAction: "retain the task/tab and request the specific human action",
      stopConditions: ["credential, OTP, CAPTCHA, identity, payment, or other human-only gate"],
    };
  }
  const blockerProgress = buildBlockerProgressPlan(item);
  if (artifactComparison?.exactBlocker && item.companionIssue) {
    const playbook = REPAIR_PLAYBOOKS.artifact_refresh;
    return {
      disposition: "artifact_refresh_deferred",
      playbookId: playbook.id,
      automatic: playbook.automatic,
      nextAction: playbook.action,
      stopConditions: playbook.stopConditions,
      blockerProgress,
    };
  }

  const proactive = buildProactiveRepairPlan(item);
  if (proactive) return proactive;

  if (blockerProgress?.reason === "capability_missing") {
    const playbook = REPAIR_PLAYBOOKS.capability_adapter_repair;
    if (item.currentCapabilityAvailable === true) {
      return {
        disposition: "capability_reflected_resume",
        playbookId: playbook.id,
        automatic: false,
        nextAction: "freshly verify the current runtime capability on the same task, then resume the existing Goal without replaying the old blocked action",
        stopConditions: playbook.stopConditions,
        blockerProgress: {
          ...blockerProgress,
          result: "The current connected generation already advertises the required capability; the historical blocker is eligible for same-task revalidation.",
          runtimeCapabilityVerified: true,
        },
      };
    }
    const repairReady = item?.capabilityRepairReady === true
      || item?.capability_repair_ready === true;
    return {
      disposition: repairReady ? "companion_capability_repair" : "capability_repair_deferred",
      playbookId: playbook.id,
      automatic: repairReady && item?.companionLocal === true,
      nextAction: playbook.action,
      stopConditions: playbook.stopConditions,
      blockerProgress,
    };
  }

  if (blockerProgress?.reason === "send_result_unknown") {
    const playbook = REPAIR_PLAYBOOKS.send_result_readback;
    return {
      disposition: "send_result_readback_deferred",
      playbookId: playbook.id,
      automatic: playbook.automatic,
      nextAction: playbook.action,
      stopConditions: playbook.stopConditions,
      blockerProgress,
    };
  }

  if (blockerProgress?.reason === "foreign_owner" || blockerProgress?.reason === "target_mismatch") {
    const playbook = REPAIR_PLAYBOOKS.target_binding;
    return {
      disposition: "target_binding_deferred",
      playbookId: playbook.id,
      automatic: blockerProgress.reason === "target_mismatch",
      nextAction: blockerProgress.nextActionNow,
      stopConditions: playbook.stopConditions,
      blockerProgress,
    };
  }

  if (blockerProgress?.reason === "unknown_effect" || blockerProgress?.reason === "active_reconciliation") {
    const playbook = REPAIR_PLAYBOOKS.signed_reconciliation;
    return {
      disposition: "reconciliation_deferred",
      playbookId: playbook.id,
      automatic: playbook.automatic,
      nextAction: `${blockerProgress.nextActionNow}; never replay the original mutation`,
      stopConditions: playbook.stopConditions,
      blockerProgress,
    };
  }

  const markers = markerSet(item);
  for (const playbookId of ["signed_reconciliation", "target_binding", "frame_or_locator_readback", "stale_connection_generation"]) {
    if (markerMatches(markers, PLAYBOOK_MARKERS[playbookId])) {
      const playbook = REPAIR_PLAYBOOKS[playbookId];
      return {
        disposition: "companion_local_repair",
        playbookId: playbook.id,
        // An owner mismatch is never an automatic claim/adopt operation. A
        // target mismatch may enter the bounded repair callback, but only
        // after that callback proves the exact current owner and target.
        automatic: blockerProgress?.reason === "foreign_owner" ? false : playbook.automatic,
        nextAction: playbook.action,
        stopConditions: playbook.stopConditions,
        blockerProgress,
      };
    }
  }
  if (item.companionIssue) {
    const playbook = REPAIR_PLAYBOOKS.companion_local_review;
    return {
      disposition: "companion_local_review",
      playbookId: playbook.id,
      automatic: playbook.automatic,
      nextAction: playbook.action,
      stopConditions: playbook.stopConditions,
      blockerProgress,
    };
  }
  return {
    disposition: "healthy_or_unclassified",
    playbookId: null,
    automatic: false,
    nextAction: "fresh owner/status readback now; if healthy, continue independent work without creating a new task",
    stopConditions: [],
  };
}

/**
 * Convert a text-level session observation into the same single resume reason
 * used by manual and scheduled resume requests.  This is read-only: it never
 * opens a browser, creates a session, or sends a continuation.
 */
export function buildResumeAssessment(item = {}) {
  if (item.interrupted === true) {
    return {
      schema: "aos.resume_assessment.v1",
      state: "paused",
      reason: "interrupted",
      priority: null,
      automaticActionAllowed: false,
      readOnly: true,
    };
  }
  if (item.blocked === true) {
    return {
      schema: "aos.resume_assessment.v1",
      state: "blocked",
      reason: "task_blocked",
      priority: null,
      automaticActionAllowed: false,
      readOnly: true,
    };
  }
  const markers = new Set((item.companionMarkers || []).map((value) => String(value).toLowerCase()));
  const summary = String(item.latestSummary || "").toLowerCase();
  const has = (...values) => values.some((value) => markers.has(String(value).toLowerCase()) || summary.includes(String(value).toLowerCase()));
  const status = {
    unknown_effect: has("operation_effect_unknown", "unknown effect", "effect_unknown"),
    foreign_owner: has("session_not_owned", "foreign owner", "target mismatch", "target不一致", "transaction_action_target_page_mismatch", "target_page_mismatch", "mcp_session_task_binding_missing", "page_instance_mismatch"),
    active_reconciliation: has("reconciliation_required", "reconciliation_pending"),
    human_auth_required: item.userHelpRequired === true,
    provider_inactive: has("provider_inactive", "exceed_egress_quota", "project is paused", "project paused"),
    handoff_gate_active: has("source_session_handoff_gate_active", "handoff gate active", "implementation_allowed=false"),
    stale_owner_recoverable: has("stale_generation", "timeout", "connected=false", "page_execution_timeout", "extension_operation_failed", "generation_mismatch"),
  };
  const selected = selectResumeBlocker({ status });
  return {
    schema: "aos.resume_assessment.v1",
    state: selected.reason === "ready" ? "ready" : "blocked",
    reason: selected.reason,
    priority: selected.priority,
    automaticActionAllowed: selected.reason === "ready" || selected.reason === "stale_owner_recoverable",
    readOnly: true,
  };
}

export const HOURLY_CONTROLLER_SCHEMA = "aos.companion_hourly_controller.v1";
export const HOURLY_EXECUTION_RECEIPT_SCHEMA = "aos.companion_hourly_execution_receipt.v1";
export const HOURLY_EXECUTION_STAGE_ORDER = Object.freeze([
  "thread_inventory",
  "lightweight_thread_inspection",
  "deep_read_selection",
  "fresh_status",
  "blocker_progress",
  "generalize_root_cause",
  "bounded_repair",
  "focused_verification",
  "idle_reconciled_check",
  "signed_refresh",
  "fresh_generation_readback",
  "same_run_real_e2e",
  "repair_again_on_distinct_failure",
  "one_continuation_per_eligible_task",
  "readback",
]);

function threadReadbackExactBlocker(inspection) {
  if (!inspection) return null;
  const lightweightRequested = finiteCount(inspection.lightweightInspectionCount);
  const lightweightRead = finiteCount(inspection.lightweightReadCount);
  // A single task-level timeout is a deferred item, not a reason to fail the
  // whole audit. Only a complete loss of lightweight readback makes the
  // inventory unusable enough to block the run globally.
  if (lightweightRequested > 0 && lightweightRead === 0) return "codex_app_thread_readback_all_failed";
  return null;
}

function threadReadbackDeferredCount(inspection) {
  if (!inspection || !Array.isArray(inspection.records)) return 0;
  return inspection.records.filter((record) => {
    const lightweightDeferred = record?.lightweight?.status !== "observed";
    const deepDeferred = record?.deepReadEligible === true && record?.deepRead?.status !== "observed";
    return lightweightDeferred || deepDeferred;
  }).length;
}

const HOURLY_HARD_STOP_REASONS = new Set([
  "unknown_effect",
  "foreign_owner",
  "active_reconciliation",
  "human_auth_required",
]);

// These are local coordination boundaries, not external-effect gates. An
// affected task remains deferred, but an unrelated ready task may still be
// delivered at its next message boundary in the same scheduler turn.
const INDEPENDENT_CONTINUATION_SAFE_BLOCKERS = new Set([
  "companion_disconnected",
  "unknown_effect",
  "foreign_owner",
  "active_reconciliation",
  "human_auth_required",
  "companion_idle_reconciled_boundary_required",
  "companion_refresh_callback_required",
  "companion_refresh_reflection_required",
  "companion_repair_callback_required",
  "companion_repair_verification_callback_required",
  "logical_sessions_active",
  "exact_tab_leases_active",
  "pending_operations_active",
  "profile_queue_active",
  "active_task_tabs_present",
  "timed_out_operations_active",
]);

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return undefined;
}

function controllerStatus(status = {}) {
  const source = status?.freshStatus ?? status?.fresh_status ?? status?.status ?? status;
  const reconciliation = source?.reconciliationGate ?? source?.reconciliation_gate ?? source?.reconciliation ?? {};
  // `status.get` is profile-scoped in the broker protocol: the top-level
  // object exposes `profiles[]` and the connected bit lives on each profile.
  // Session-derived audit fixtures sometimes provide a top-level boolean,
  // so accept both shapes without treating a missing field as connected.
  const profiles = Array.isArray(source?.profiles) ? source.profiles : [];
  const connectedProfiles = profiles.filter((profile) => profile?.connected === true || profile?.connected === "true");
  const connected = source?.connected === true
    || source?.connected === "true"
    || connectedProfiles.length > 0;
  // The resident Companion broker's canonical status field is
  // `exactTabLeaseCount`.  Older fixtures used `activeLeaseCount`/`leaseCount`,
  // so keep those as fallbacks, but never let a canonical non-zero lease count
  // disappear merely because the audit vocabulary is older than the broker.
  const activeLeaseCount = finiteCount(firstDefined(source, [
    "exactTabLeaseCount",
    "exact_tab_lease_count",
    "activeLeaseCount",
    "active_lease_count",
    "leaseCount",
    "lease_count",
  ]));
  const pendingCount = finiteCount(firstDefined(source, ["pendingCount", "pending_count", "pendingOperationCount", "pending_operation_count"]));
  const queueCount = finiteCount(firstDefined(source, ["queueCount", "queue_count", "queuedCount", "queued_count"]));
  const taskTabs = Array.isArray(source?.taskTabs) ? source.taskTabs : [];
  const logicalSessions = Array.isArray(source?.logicalSessions) ? source.logicalSessions : null;
  const exactTabLeases = Array.isArray(source?.exactTabLeases) ? source.exactTabLeases : null;
  const pendingOperations = Array.isArray(source?.pendingOperations) ? source.pendingOperations : null;
  const liveSessionIds = logicalSessions
    ? new Set(logicalSessions.map((session) => session?.sessionId).filter(Boolean))
    : null;
  const leaseKeys = exactTabLeases
    ? new Set(exactTabLeases.map((lease) => `${lease?.profileInstanceId ?? ""}:${lease?.tabId ?? ""}`))
    : null;
  const taskTabReferencesOperation = (tab, operation) => {
    if (!tab || !operation) return false;
    if (operation.operationId && tab.operationId === operation.operationId) return true;
    const taskId = operation.binding?.taskId ?? operation.taskTabContext?.taskId;
    const runId = operation.binding?.runId ?? operation.taskTabContext?.runId;
    return Boolean(taskId && runId && tab.taskId === taskId && tab.runId === runId);
  };
  const taskTabIsLive = (tab) => {
    // A status response with the broker's runtime collections is authoritative:
    // a retained tab whose session/lease disappeared is evidence-only and must
    // not keep the hourly controller in a global reconciliation wait.
    if (!liveSessionIds && !leaseKeys && !pendingOperations) return true;
    const tabKey = `${tab?.profileInstanceId ?? ""}:${tab?.tabId ?? ""}`;
    if (liveSessionIds?.has(tab?.sessionId)) return true;
    if (leaseKeys?.has(tabKey)) return true;
    if (!tab?.sessionId && liveSessionIds?.size > 0) return true;
    return pendingOperations?.some((operation) => taskTabReferencesOperation(tab, operation)) === true;
  };
  const liveTaskTabs = taskTabs.filter(taskTabIsLive);
  const taskTabReconciliationCount = liveTaskTabs.filter((tab) => tab?.userHelpRequired !== true
    && tab?.tabDisposition !== "ledger_only"
    && ["reconciliation_required", "operation_effect_unknown"].includes(tab?.lifecycleState)).length;
  const activeTaskTabFallback = liveTaskTabs.filter((tab) => tab?.userHelpRequired !== true
    && tab?.tabDisposition !== "ledger_only"
    && ["admitted", "target_bound", "pre_read", "executing", "post_read", "awaiting_user", "reconciliation_required", "operation_effect_unknown"].includes(tab?.lifecycleState)).length;
  const reportedActiveReconciliationCount = Math.max(
    finiteCount(firstDefined(source, ["reconciliationPendingActiveCount", "reconciliation_pending_active_count"])),
    finiteCount(firstDefined(reconciliation, ["activeCount", "active_count", "pendingCount", "pending_count"])),
    taskTabReconciliationCount,
  );
  // New brokers mark the scoped gate explicitly.  Older resident brokers may
  // expose a non-zero recovery count assembled from retained, ownerless tabs;
  // when the runtime collections are present, recompute from live references
  // instead of allowing that historical count to deadlock a fresh task.
  const scopedGate = reconciliation?.blocksOn === "active_profile_work_only";
  const hasRuntimeCollections = Boolean(logicalSessions || exactTabLeases || pendingOperations);
  const activeReconciliationCount = hasRuntimeCollections && !scopedGate
    ? taskTabReconciliationCount
    : reportedActiveReconciliationCount;
  const reportedActiveReconciliation = source?.activeReconciliation === true
    || source?.active_reconciliation === true
    || reconciliation?.active === true
    || reconciliation?.required === true
    || reportedActiveReconciliationCount > 0;
  const activeReconciliation = hasRuntimeCollections && !scopedGate
    ? activeReconciliationCount > 0
    : reportedActiveReconciliation || activeReconciliationCount > 0;
  const unknownEffect = source?.unknownEffect === true
    || source?.unknown_effect === true
    || source?.operationEffectUnknown === true
    || source?.operation_effect_unknown === true;
  const foreignOwner = source?.foreignOwner === true
    || source?.foreign_owner === true
    || source?.ownerMismatch === true
    || source?.owner_mismatch === true;
  const humanAuthRequired = source?.humanAuthRequired === true
    || source?.human_auth_required === true
    || source?.authRequired === true
    || source?.auth_required === true;
  return {
    connected,
    generation: source?.generation
      ?? source?.runtimeGeneration
      ?? source?.runtime_generation
      ?? (connectedProfiles.length === 1 ? connectedProfiles[0]?.generation ?? null : null),
    ownerVerified: source?.ownerVerified === true || source?.owner_verified === true || source?.owned === true,
    unknownEffect,
    foreignOwner,
    activeReconciliation,
    humanAuthRequired,
    activeLeaseCount,
    pendingCount,
    queueCount,
    activeReconciliationCount,
    activeTaskTabCount: hasRuntimeCollections
      ? activeTaskTabFallback
      : Math.max(
      finiteCount(firstDefined(source, ["activeTaskTabCount", "active_task_tab_count"])),
      activeTaskTabFallback,
      ),
    raw: source,
  };
}

/**
 * Read the resident Companion broker without starting a new broker or
 * touching browser state.  The hourly audit used to inspect only session
 * transcripts, which made a live reconciliation/tab backlog invisible.  A
 * failed read is represented as data so the scheduler can retry on the next
 * bounded tick instead of pretending the runtime is healthy.
 */
export async function readLiveCompanionStatus({
  sourceRoot = DEFAULT_COMPANION_SOURCE,
  env = process.env,
  timeoutMs = 5_000,
} = {}) {
  const clientPath = path.join(sourceRoot, "src", "client", "broker-client.mjs");
  if (!fs.existsSync(clientPath)) {
    return { available: false, exactBlocker: "companion_client_source_missing", sourceRoot };
  }
  let client = null;
  try {
    const { BrokerClient } = await import(pathToFileURL(clientPath).href);
    client = await BrokerClient.connect({ autoStart: false, env, issuer: "aos" });
    const status = await client.request("status.get", {}, { timeoutMs });
    return {
      available: true,
      source: "resident_companion_broker",
      status,
      connection: typeof client.connectionInfo === "function" ? client.connectionInfo() : null,
    };
  } catch (error) {
    return {
      available: false,
      source: "resident_companion_broker",
      exactBlocker: String(error?.code ?? "companion_status_read_failed"),
      error: String(error?.message ?? error).slice(0, 500),
    };
  } finally {
    try { client?.close(); } catch { /* best effort for a read-only audit */ }
  }
}

function normalizeLiveCompanionStatus(liveStatus) {
  if (liveStatus === null || liveStatus === undefined) {
    return { available: false, source: "not_supplied", exactBlocker: null, activeReconciliationCount: 0, activeTaskTabCount: 0 };
  }
  if (liveStatus?.available === false) {
    return {
      available: false,
      source: liveStatus.source ?? "resident_companion_broker",
      exactBlocker: liveStatus.exactBlocker ?? "companion_status_unavailable",
      error: liveStatus.error ?? null,
      activeReconciliationCount: 0,
      activeTaskTabCount: 0,
    };
  }
  const raw = liveStatus?.status ?? liveStatus;
  const snapshot = controllerStatus(raw);
  const source = snapshot.raw ?? {};
  const connectedProfiles = Array.isArray(source.profiles) ? source.profiles.filter((profile) => profile?.connected === true) : [];
  const availableCapabilities = [...new Set([
    ...(Array.isArray(source.capabilities) ? source.capabilities : []),
    ...(Array.isArray(source.runtimeAttestation?.capabilities) ? source.runtimeAttestation.capabilities : []),
    ...connectedProfiles.flatMap((profile) => Array.isArray(profile?.capabilities) ? profile.capabilities : []),
  ].filter((value) => typeof value === "string" && value.length > 0))].sort();
  const profileRegistrationFailures = Array.isArray(source.profileRegistrationFailures)
    ? source.profileRegistrationFailures.length
    : 0;
  const exactBlocker = !snapshot.connected
    ? "companion_disconnected"
    : snapshot.activeReconciliation
      ? "active_reconciliation"
      : profileRegistrationFailures > 0
        ? "companion_profile_registration_failed"
        : null;
  return {
    available: true,
    source: liveStatus?.source ?? "resident_companion_broker",
    connected: snapshot.connected,
    generation: snapshot.generation,
    ownerVerified: snapshot.ownerVerified,
    activeReconciliation: snapshot.activeReconciliation,
    activeReconciliationCount: snapshot.activeReconciliationCount,
    activeTaskTabCount: snapshot.activeTaskTabCount,
    activeLeaseCount: snapshot.activeLeaseCount,
    pendingCount: snapshot.pendingCount,
    queueCount: snapshot.queueCount,
    profileRegistrationFailureCount: profileRegistrationFailures,
    availableCapabilities,
    exactBlocker,
    raw: {
      fullyIdle: source.recovery?.fullyIdle ?? source.fullyIdle ?? null,
      executionIdle: source.recovery?.executionIdle ?? source.executionIdle ?? null,
      reconciliationGate: source.reconciliationGate ?? source.reconciliation_gate ?? null,
      taskTabCount: finiteCount(firstDefined(source, ["taskTabCount", "task_tab_count"])),
      ledgerOnlyTaskTabCount: finiteCount(firstDefined(source, ["ledgerOnlyTaskTabCount", "ledger_only_task_tab_count"])),
    },
  };
}

function idleReconciled(status) {
  const snapshot = controllerStatus(status);
  return snapshot.connected
    && !snapshot.unknownEffect
    && !snapshot.foreignOwner
    && !snapshot.humanAuthRequired
    && !snapshot.activeReconciliation
    && snapshot.activeLeaseCount === 0
    && snapshot.pendingCount === 0
    && snapshot.queueCount === 0;
}

function controllerError(value, fallback = "controller_callback_failed") {
  if (value instanceof Error) return String(value.message || fallback).slice(0, 500);
  if (value && typeof value === "object") return String(value.exact_blocker || value.exactBlocker || value.error || fallback).slice(0, 500);
  return fallback;
}

function actionFailed(value) {
  return value === false || value === null || (value && typeof value === "object" && (
    value.ok === false || value.success === false || value.status === "blocked" || value.status === "failed"
  ));
}

function executionStage(status = "not_run", details = null) {
  return details ? { status, ...details } : { status };
}

function observedExecutionStatus(value) {
  const status = String(value?.status ?? value?.resultStatus ?? "");
  if (actionFailed(value) || ["failed", "blocked"].includes(status)) return "failed";
  if (["deferred", "not_run", "unavailable", "pending", "unknown"].includes(status)) return "deferred";
  return value === true || value?.ok === true || value?.success === true
    || ["passed", "succeeded", "completed", "verified"].includes(status) ? "completed" : "deferred";
}

/**
 * Turn a controller result into a compact, machine-readable stage receipt.
 * This is intentionally derived from the returned result rather than from
 * prose in the automation prompt: a short heartbeat can no longer look like
 * a completed repair simply because it mentioned the expected steps.
 */
export function buildControllerExecutionReceipt(controller = {}) {
  const actions = new Set(Array.isArray(controller?.actions) ? controller.actions : []);
  const stages = Object.fromEntries(HOURLY_EXECUTION_STAGE_ORDER.map((stage) => [stage, executionStage()]));
  const inspection = controller?.threadInspection;
  if (inspection) {
    stages.thread_inventory = executionStage("completed", {
      listedCount: finiteCount(inspection.listedCount),
      eligibleTaskCount: finiteCount(inspection.eligibleTaskCount),
      skippedNonUserOwnedCount: finiteCount(inspection.skippedNonUserOwnedCount),
    });
    stages.lightweight_thread_inspection = executionStage("completed", {
      inspectedCount: finiteCount(inspection.lightweightInspectionCount),
      readbackCount: finiteCount(inspection.lightweightReadCount),
      mode: inspection.mode ?? null,
    });
    stages.deep_read_selection = executionStage("completed", {
      candidateCount: finiteCount(inspection.deepReadCandidateCount),
      attemptedCount: finiteCount(inspection.deepReadAttemptedCount),
      readCount: finiteCount(inspection.deepReadCount),
      truncated: inspection.deepReadTruncated === true,
    });
  }
  if (controller?.freshStatus) {
    stages.fresh_status = executionStage("completed", {
      generation: controller.freshStatus.generation ?? null,
      activeLeaseCount: finiteCount(controller.freshStatus.activeLeaseCount),
      pendingCount: finiteCount(controller.freshStatus.pendingCount),
      queueCount: finiteCount(controller.freshStatus.queueCount),
    });
  } else if (controller?.status === "heartbeat_only") {
    stages.fresh_status = executionStage("heartbeat");
  }
  if (controller?.blockerProgress) {
    const progress = controller.blockerProgress;
    stages.blocker_progress = executionStage(
      progress?.resumeAllowed === true || progress?.status === "reconciled" ? "completed" : "deferred",
      {
        reason: progress?.reason ?? null,
        attempted: progress?.attempted === true,
        exactBlocker: progress?.exact_blocker ?? progress?.exactBlocker ?? null,
        resultStatus: progress?.result?.status ?? null,
      },
    );
  }
  if (actions.has("repair") || controller?.repair?.attempted === true) {
    stages.bounded_repair = executionStage(observedExecutionStatus(controller.repair?.result ?? controller.repair), {
      playbookId: controller.repair?.playbookId ?? null,
    });
    stages.generalize_root_cause = executionStage("completed");
  }
  if (actions.has("verification") || controller?.verification) {
    stages.focused_verification = executionStage(observedExecutionStatus(controller.verification));
  }
  if (controller?.freshStatus || controller?.verification || controller?.repair) {
    const idleBlocked = controller?.exact_blocker === "companion_idle_reconciled_boundary_required"
      || controller?.exact_blocker === "companion_idle_reconciled_boundary_required_after_e2e"
      || controller?.exact_blocker === "companion_disconnected";
    const fresh = controller?.verification?.freshStatus ?? controller?.verification?.fresh_status ?? controller?.freshStatus;
    const observedIdle = fresh?.connected === true
      && ["activeLeaseCount", "pendingCount", "queueCount", "activeReconciliationCount"].every((field) => fresh[field] === 0)
      && fresh.unknownEffect !== true && fresh.foreignOwner !== true && fresh.humanAuthRequired !== true;
    const deferred = idleBlocked || !observedIdle;
    stages.idle_reconciled_check = executionStage(deferred ? "deferred" : "completed", {
      exactBlocker: deferred ? controller?.exact_blocker || "companion_idle_reconciled_boundary_unverified" : null,
      nextActionNow: deferred ? controller?.next_action_now ?? null : null,
      resumeTrigger: deferred ? controller?.resume_trigger ?? null : null,
    });
  }
  if (actions.has("refresh") || controller?.refresh) {
    const reflected = controller.refresh?.reflected === true
      || controller.refresh?.reflected === "true"
      || controller.refresh?.status === "reflected";
    stages.signed_refresh = executionStage(actionFailed(controller.refresh) ? "failed" : reflected ? "completed" : "deferred", {
      reflected,
      generation: controller.refresh?.generation ?? null,
    });
    stages.fresh_generation_readback = executionStage(reflected ? "completed" : "deferred");
  }
  const loop = controller?.sameRunRepairLoop;
  if (loop && Array.isArray(loop.cycles)) {
    const e2eResults = loop.cycles.map((cycle) => cycle?.e2e).filter(Boolean);
    if (e2eResults.length > 0) {
      const passed = e2eResults.some((value) => sameRunE2EPassed(value));
      stages.same_run_real_e2e = executionStage(passed ? "completed" : "failed", { attempts: e2eResults.length });
    }
    if (loop.cycles.length > 1) stages.repair_again_on_distinct_failure = executionStage("completed", { cycles: loop.cycles.length });
  }
  const allContinuations = [
    ...(Array.isArray(controller?.continuations) ? controller.continuations : []),
    ...(Array.isArray(controller?.independentContinuations) ? controller.independentContinuations : []),
  ];
  if (allContinuations.length > 0) {
    const failed = allContinuations.filter((entry) => actionFailed(entry?.result)).length;
    stages.one_continuation_per_eligible_task = executionStage(failed > 0 ? "failed" : "completed", {
      attempted: allContinuations.length,
      failed,
    });
  }
  const status = String(controller?.status || "not_run");
  stages.readback = executionStage(status === "completed" || status === "inspected" || status === "heartbeat_only" ? "completed" : "deferred", {
    exactBlocker: controller?.exact_blocker ?? null,
  });
  return {
    schema: HOURLY_EXECUTION_RECEIPT_SCHEMA,
    stageOrder: HOURLY_EXECUTION_STAGE_ORDER,
    status,
    complete: status === "completed",
    auditOnly: false,
    externalActionExecuted: controller?.external_action_executed === true || controller?.externalActionExecuted === true,
    exactBlocker: controller?.exact_blocker ?? null,
    nextActionNow: controller?.next_action_now ?? null,
    stageReceipts: stages,
    stages,
  };
}

/**
 * The candidate-index entrypoint is intentionally read-only.  It must still
 * emit an explicit execution receipt so a short heartbeat cannot be mistaken
 * for a repair/refresh/E2E run.  The registered root replaces this receipt
 * with buildControllerExecutionReceipt() after it actually executes the
 * bounded controller callbacks in the same scheduler turn.
 */
export function buildAuditExecutionReceipt({ summary = {}, runId = null, schedulerDecision = null } = {}) {
  const decision = schedulerDecision ?? summary?.controller?.schedulerDecision ?? null;
  const heartbeat = decision === "heartbeat_only";
  const repairCandidateCount = Array.isArray(summary?.repairCandidates)
    ? summary.repairCandidates.length
    : 0;
  const blockerCandidateCount = Array.isArray(summary?.threadReadbackBlockerCandidates)
    ? summary.threadReadbackBlockerCandidates.length
    : 0;
  const deepReadCandidateCount = Number(summary?.threadInspection?.deepReadCandidateCount || 0)
    + Number(summary?.softAnomalyDeepReadCandidateCount || 0);
  const taskOwnedContinuationCandidateCount = Number(summary?.taskOwnedContinuationCandidateCount || 0);
  const stalledTaskCount = Number(summary?.changeDetection?.stalledTaskCount || 0);
  // A repair candidate is not the only reason the current Root must act. A
  // blocked/readback candidate, a stalled task, or a bounded deep-read
  // candidate also requires the official App Root to perform the fresh
  // task-scoped inspection and either progress or terminalize the blocker.
  // Keeping this signal in the audit receipt prevents a projection-only run
  // from looking complete merely because the local repair planner produced
  // no automatic playbook.
  const rootActionRequired = !heartbeat && (
    repairCandidateCount > 0
    || blockerCandidateCount > 0
    || stalledTaskCount > 0
    || deepReadCandidateCount > 0
    || taskOwnedContinuationCandidateCount > 0
    || Number(summary?.officialAppOnlyContinuationCandidateCount || 0) > 0
  );
  const inspectionBlocker = threadReadbackExactBlocker(summary?.threadInspection);
  const exactBlocker = summary?.exactBlocker ?? inspectionBlocker;
  const stages = Object.fromEntries(HOURLY_EXECUTION_STAGE_ORDER.map((stage) => [stage, executionStage()]));
  const live = summary?.liveCompanion;
  const inspection = summary?.threadInspection;
  if (inspection) {
    stages.thread_inventory = executionStage("completed", {
      listedCount: finiteCount(inspection.listedCount),
      eligibleTaskCount: finiteCount(inspection.eligibleTaskCount),
      skippedNonUserOwnedCount: finiteCount(inspection.skippedNonUserOwnedCount),
    });
    stages.lightweight_thread_inspection = executionStage(inspectionBlocker ? "deferred" : "completed", {
      inspectedCount: finiteCount(inspection.lightweightInspectionCount),
      readbackCount: finiteCount(inspection.lightweightReadCount),
      deferredTaskCount: threadReadbackDeferredCount(inspection),
      mode: inspection.mode ?? null,
      exactBlocker: inspectionBlocker,
    });
    stages.deep_read_selection = executionStage(inspectionBlocker ? "deferred" : "completed", {
      candidateCount: finiteCount(inspection.deepReadCandidateCount),
      attemptedCount: finiteCount(inspection.deepReadAttemptedCount),
      readCount: finiteCount(inspection.deepReadCount),
      deferredTaskCount: threadReadbackDeferredCount(inspection),
      truncated: inspection.deepReadTruncated === true,
      exactBlocker: inspectionBlocker,
    });
  }
  if (live && live.available !== false) {
    stages.fresh_status = executionStage("completed", {
      generation: live.generation ?? null,
      connected: live.connected === true,
      activeLeaseCount: finiteCount(live.activeLeaseCount),
      pendingCount: finiteCount(live.pendingCount),
      queueCount: finiteCount(live.queueCount),
      activeReconciliationCount: typeof live.activeReconciliationCount === "number" ? live.activeReconciliationCount : null,
    });
    stages.readback = executionStage(exactBlocker ? "deferred" : "completed", { exactBlocker });
  } else if (heartbeat) {
    stages.fresh_status = executionStage("heartbeat");
    stages.readback = executionStage(exactBlocker ? "deferred" : "completed", { exactBlocker });
  }
  const status = heartbeat ? "heartbeat_only" : exactBlocker ? "blocked" : "inspected";
  return {
    schema: HOURLY_EXECUTION_RECEIPT_SCHEMA,
    runId,
    status,
    complete: false,
    auditOnly: true,
    externalActionExecuted: false,
    exactBlocker,
    nextActionNow: summary?.nextAction ?? null,
    rootActionRequired,
    rootAction: rootActionRequired
      ? {
          schema: "aos.companion_root_action_required.v1",
          mode: "official_codex_app_tools",
          candidateCount: repairCandidateCount,
          blockerCandidateCount,
          stalledTaskCount,
          deepReadCandidateCount,
          officialAppOnlyContinuationCandidateCount: Number(summary?.officialAppOnlyContinuationCandidateCount || 0),
          taskOwnedContinuationCandidateCount,
          sequence: [
            "fresh official list_threads/read_thread with real threadId and hostId",
            "same-task status/owner/effect readback",
            "bounded repair or reconciliation according to exact blocker",
            "deep-read every official-App-only continuation candidate before deciding whether to send",
            "relay Companion-dependent recovery only to an inactive target task whose own Root can run the callback",
            "send_message_to_thread exactly once only after resume proof",
            "same-task readback and STATE synchronization",
          ],
          aliasesAndLocalHistoryAreNotSendTargets: true,
          crossTaskCompanionOperationsForbidden: true,
        }
      : null,
    stageOrder: HOURLY_EXECUTION_STAGE_ORDER,
    stageReceipts: stages,
    stages,
  };
}

function controllerBase(summary, overrides = {}) {
  const result = {
    schema: HOURLY_CONTROLLER_SCHEMA,
    status: "audit_only",
    mode: "bounded_self_repair",
    auditFingerprint: summary?.auditFingerprint ?? null,
    threadInspection: summary?.threadInspection ?? null,
    external_action_executed: false,
    externalActionExecuted: false,
    actions: [],
    stalledTasks: [],
    repair: null,
    verification: null,
    reconciliationProbe: null,
    blockerProgress: null,
    refresh: null,
    continuations: [],
    independentContinuations: [],
    independentContinuationPlan: [],
    progress_attempt_now: "fresh Companion status/readback",
    result: "No mutation performed.",
    next_action_now: "Use one bounded action only after the exact blocker and owner state are fresh.",
    resume_trigger: "next hourly tick or a fresh owner/runtime signal",
    fallback_or_independent_work: "retain audit evidence and continue independent non-browser work",
    ...overrides,
  };
  result.executionReceipt = buildControllerExecutionReceipt(result);
  return result;
}

function eligibleContinuationTasks(summary, tasks, {
  allowRecoveredThreadIds = [],
  allowRecoveredReasons = ["stale_owner_recoverable"],
} = {}) {
  const source = Array.isArray(tasks) ? tasks : Array.isArray(summary?.eligibleTasks)
    ? summary.eligibleTasks
    : Array.isArray(summary?.liveCandidates) ? summary.liveCandidates : [];
  const recovered = new Set((allowRecoveredThreadIds || []).filter(Boolean).map(String));
  const recoveredReasons = new Set((allowRecoveredReasons || []).filter(Boolean).map(String));
  return source.filter((task) => {
    if (!task || !isLiveCandidate(task) || task.userHelpRequired === true || task.eligible === false) return false;
    const threadId = task.threadId ?? task.thread_id;
    const assessment = task.resumeAssessment || buildResumeAssessment(task);
    const safeInterruptedResume = task.interrupted === true
      && task.resumeEligibleAfterProof === true
      && String(assessment.reason || "") === "ready";
    const recoveredInThisRun = Boolean(threadId
      && recovered.has(String(threadId))
      && recoveredReasons.has(String(assessment.reason || "")));
    if ((task.blocked === true || (task.interrupted === true && !safeInterruptedResume)) && !recoveredInThisRun) return false;
    if (assessment.reason === "ready") return true;
    // A previously stalled task may keep its old session marker in the
    // inventory until the next App readback.  Only a task explicitly repaired
    // in this same controller turn may pass this narrow bridge, and only from
    // the recoverable Companion-local state.
    return recoveredInThisRun;
  });
}

/**
 * Project ordinary ready tasks that can be progressed entirely through the
 * official Codex App surface. These are not send approvals: the Root must
 * still fresh-read each real task and prove its owner/target/effect state
 * before sending. Keeping this list explicit prevents a Companion-local
 * callback boundary from hiding unrelated existing Goals.
 */
function officialAppOnlyContinuationCandidates(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (!task || !isLiveCandidate(task) || task.currentTaskReadback !== true) return false;
    if (task.owner !== "user" || task.userHelpRequired === true || task.completed === true || task.blocked === true) return false;
    if (task.companionIssue === true || (task.companionMarkers || []).length > 0) return false;
    const taskStatus = String(task.officialTaskStatus ?? task.status ?? "").toLowerCase();
    const turnStatus = String(task.officialLatestTurnStatus ?? task.latestTurnStatus ?? "").toLowerCase();
    // A Root must not send a continuation into an executing turn. An active
    // task is still eligible at its next message boundary; inactive tasks are
    // eligible when their latest turn is completed or separately proven
    // interrupted.
    if (!OFFICIAL_MESSAGE_BOUNDARY_TASK_STATUSES.has(taskStatus)) return false;
    if (!["completed", "interrupted"].includes(turnStatus)) return false;
    const assessment = task.resumeAssessment || buildResumeAssessment(task);
    return String(assessment.reason || "") === "ready";
  });
}

// A scheduler Root cannot invoke a task-bound Companion callback for another
// task. An inactive, user-owned task with a recoverable Companion signal can
// still make progress safely when its own Root is woken in the same thread:
// the destination task performs the Companion status/repair/readback itself.
// This is a continuation candidate, not send permission. Hard blockers,
// active turns, and pending/reconciliation signals remain excluded here.
const TASK_OWNED_RELAY_REASONS = new Set(["ready", "stale_owner_recoverable"]);
const TASK_OWNED_RELAY_TASK_STATUSES = new Set(["idle", "notloaded", "not_loaded"]);
const TASK_OWNED_RELAY_TURN_STATUSES = new Set(["completed"]);
const TASK_OWNED_RELAY_INTERRUPTED_TURN_STATUSES = new Set(["interrupted"]);
const TASK_OWNED_SAFE_REPAIR_BLOCKERS = new Set([
  "capability_missing",
  "current_task_companion_target_missing",
  "task_specific_safety_or_goal_plan_proof_missing",
]);
const TASK_OWNED_RELAY_BLOCKERS = new Set([
  "unknown_effect",
  "send_result_unknown",
  "foreign_owner",
  "target_mismatch",
  "active_reconciliation",
  "human_auth_required",
  "external_service_limit",
  "capability_missing",
]);

function taskOwnedContinuationCandidates(tasks, additionalCandidates = []) {
  const source = [...(Array.isArray(tasks) ? tasks : []), ...(Array.isArray(additionalCandidates) ? additionalCandidates : [])];
  const seen = new Set();
  return source
    .filter((task) => {
      if (!task || !isLiveCandidate(task) || task.currentTaskReadback !== true) return false;
      if (task.owner !== "user" || task.userHelpRequired === true || task.completed === true) return false;
      const taskStatusValue = String(task.officialTaskStatus ?? task.status ?? "").toLowerCase();
      const turnStatusValue = String(task.officialLatestTurnStatus ?? task.latestTurnStatus ?? "").toLowerCase();
      if (!TASK_OWNED_RELAY_TASK_STATUSES.has(taskStatusValue)) return false;
      const reason = String(task.resumeAssessment?.reason ?? "");
      const blockerReason = String(task.blockerProgress?.reason ?? "");
      const exactBlocker = String(task.officialExactBlocker ?? task.exactBlocker ?? task.exact_blocker ?? "");
      // A missing Companion capability is precisely the case that must be
      // handed to the destination Root: the scheduler Root cannot own that
      // task's Companion callback, but the awakened task can implement and
      // verify its own adapter.  Keep every effect/ownership/target/auth/
      // reconciliation blocker excluded from the relay.
      const safeRepairBlocker = [reason, blockerReason, exactBlocker].find((value) => TASK_OWNED_SAFE_REPAIR_BLOCKERS.has(value)) ?? "";
      const capabilityRelay = safeRepairBlocker === "capability_missing";
      const repairRelay = Boolean(safeRepairBlocker);
      const markers = Array.isArray(task.companionMarkers) ? task.companionMarkers : [];
      // A shallow App Server inventory legitimately reports an inactive task
      // as notLoaded/unknown before the post-audit Root performs the required
      // same-task read. Keep a safe Companion signal in the relay queue so
      // that post-audit fresh readback is actually reached; this is never
      // send approval and cannot include an unknown-effect blocker.
      const shallowTaskRelay = turnStatusValue === "unknown"
        && task.officialReadbackState === "task_present_state_not_loaded"
        && (repairRelay || task.companionIssue === true || markers.length > 0);
      const interruptedCapabilityRelay = task.interrupted === true
        && task.resumeEligibleAfterProof === true
        && TASK_OWNED_RELAY_INTERRUPTED_TURN_STATUSES.has(turnStatusValue)
        && repairRelay;
      if (!TASK_OWNED_RELAY_TURN_STATUSES.has(turnStatusValue) && !interruptedCapabilityRelay && !shallowTaskRelay) return false;
      if (task.blocked === true && !interruptedCapabilityRelay && !shallowTaskRelay) return false;
      if (task.interrupted === true && !interruptedCapabilityRelay && !shallowTaskRelay) return false;
      if (task.resumeEligibleAfterProof === true && !interruptedCapabilityRelay && !shallowTaskRelay) return false;
      if (!TASK_OWNED_RELAY_REASONS.has(reason) && !capabilityRelay) return false;
      if (exactBlocker && !repairRelay) return false;
      if (TASK_OWNED_RELAY_BLOCKERS.has(blockerReason) && blockerReason !== "capability_missing") return false;
      if (!(task.companionIssue === true || markers.length > 0 || repairRelay)) return false;
      const threadId = String(task.threadId ?? task.thread_id ?? "");
      if (!threadId || seen.has(threadId)) return false;
      seen.add(threadId);
      return true;
    })
    .sort((left, right) => String(left.threadId ?? left.thread_id ?? "").localeCompare(String(right.threadId ?? right.thread_id ?? "")));
}

function isTaskOwnedRelayCandidate(task) {
  return task?.requiresTaskOwnedCompanionCallback === true
    && task?.relayMode === "same_task_root_companion_repair_or_resume";
}

// The audit projection and the controller used to stop at different
// boundaries: the projection exposed task-owned relay candidates, but the
// controller only consumed `eligibleTasks`. Keep both queues in one bounded,
// deterministic path so an inactive task with a Companion issue is actually
// handed back to its own Root for fresh repair/readback.
function continuationQueue(summary, eligibleTasks, {
  allowRecoveredThreadIds = [],
  allowRecoveredReasons = ["stale_owner_recoverable"],
  maxContinuations = 50,
} = {}) {
  const ordinary = eligibleContinuationTasks(summary, eligibleTasks, {
    allowRecoveredThreadIds,
    allowRecoveredReasons,
  });
  const relay = (Array.isArray(summary?.taskOwnedContinuationCandidates)
    ? summary.taskOwnedContinuationCandidates
    : []).filter(isTaskOwnedRelayCandidate);
  const result = [];
  const seen = new Set();
  // Prefer the explicit relay lane when the same task appears in both lists;
  // it carries the task-owned Companion boundary and cannot be downgraded to
  // an ordinary scheduler continuation.
  for (const task of [...relay, ...ordinary]) {
    const threadId = String(task?.threadId ?? task?.thread_id ?? "");
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    result.push(task);
    if (result.length >= Math.max(0, Number(maxContinuations) || 0)) break;
  }
  return result;
}

function continuationContext(task, stage, freshStatus, summary) {
  const relay = isTaskOwnedRelayCandidate(task);
  return {
    stage,
    lane: relay ? "task_owned_companion_relay" : undefined,
    task,
    freshStatus,
    idempotencyKey: continuationKeyFor(summary, task, freshStatus),
    sourceThreadOnly: relay || task.taskType === "job" || task.task_type === "job",
    ...(relay ? {
      requiresTaskOwnedCompanionCallback: true,
      relayRequiresFreshOfficialReadback: task.relayRequiresFreshOfficialReadback === true,
      relayReason: task.relayReason ?? "companion_local_review",
    } : {}),
  };
}

function continuationKeyFor(summary, task, freshStatus) {
  try {
    return buildContinuationIdempotencyKey({
      task,
      auditFingerprint: summary?.auditFingerprint ?? null,
      generation: freshStatus?.generation ?? freshStatus?.runtimeGeneration ?? freshStatus?.runtime_generation ?? null,
      nextAction: task?.nextAction ?? task?.next_action ?? null,
    });
  } catch {
    return null;
  }
}

/**
 * A blocked Companion lane must not freeze unrelated work. This projection is
 * stricter than the normal continuation list: it excludes the task being
 * repaired and every task carrying a Companion signal, leaving only a ready,
 * independent task for a bounded message-boundary continuation.
 */
function eligibleIndependentContinuationTasks(summary, tasks, { excludeThreadIds = [] } = {}) {
  const excluded = new Set((excludeThreadIds || []).filter(Boolean).map(String));
  return eligibleContinuationTasks(summary, tasks).filter((task) => {
    const threadId = task?.threadId ?? task?.thread_id;
    if (threadId && excluded.has(String(threadId))) return false;
    if (task?.companionIssue === true || (task?.companionMarkers || []).length > 0) return false;
    return true;
  });
}

async function continueIndependentTasksAfterDeferred({
  result,
  summary,
  eligibleTasks,
  continueTask,
  freshStatus,
  maxContinuations,
  excludeThreadIds = [],
}) {
  const tasks = eligibleIndependentContinuationTasks(summary, eligibleTasks, { excludeThreadIds })
    .slice(0, Math.max(0, Number(maxContinuations) || 0));
  result.independentContinuationPlan = tasks.map((task) => ({
    threadId: task.threadId ?? task.thread_id ?? null,
    lane: "independent",
    sourceThreadOnly: task.taskType === "job" || task.task_type === "job",
  }));
  if (tasks.length === 0 || typeof continueTask !== "function") return result;
  for (const task of tasks) {
    let continuation;
    try {
      continuation = await continueTask({
        stage: "independent_continuation",
        lane: "independent",
        task,
        freshStatus,
        idempotencyKey: continuationKeyFor(summary, task, freshStatus),
        sourceThreadOnly: task.taskType === "job" || task.task_type === "job",
      });
    } catch (error) {
      continuation = { status: "failed", exact_blocker: controllerError(error), external_action_executed: false };
    }
    result.actions.push("independent_continuation");
    result.independentContinuations.push({
      threadId: task.threadId ?? task.thread_id ?? null,
      idempotencyKey: continuationKeyFor(summary, task, freshStatus),
      result: continuation ?? null,
    });
  }
  return result;
}

function taskProgressTimestamp(task) {
  for (const key of ["lastProgressAt", "last_progress_at", "updatedAt", "updated_at", "mtime"]) {
    const value = task?.[key];
    if (value === undefined || value === null) continue;
    const parsed = taskTimestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function stalledTasks(summary, {
  now = Date.now(),
  thresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
} = {}) {
  const source = Array.isArray(summary?.liveCandidates) ? summary.liveCandidates : [];
  const threshold = Math.max(1_000, Number(thresholdMs) || DEFAULT_STALLED_TASK_THRESHOLD_MS);
  return source
    .filter((task) => {
      if (!isLiveCandidate(task) || task.userHelpRequired === true || task.blocked === true) return false;
      const assessment = task.resumeAssessment || buildResumeAssessment(task);
      // Only an observed Companion/restart signal warrants a time-based
      // freshness probe.  Healthy or unclassified old sessions remain
      // resumable candidates on a changed signal, but do not wake the repair
      // controller solely because their log file is old.
      return task.companionIssue === true
        || (assessment.reason && assessment.reason !== "ready" && assessment.reason !== "interrupted");
    })
    .map((task) => ({ task, lastProgressAt: taskProgressTimestamp(task) }))
    .filter(({ lastProgressAt }) => lastProgressAt !== null && now - lastProgressAt >= threshold)
    .sort((left, right) => String(left.task.threadId ?? left.task.thread_id ?? "").localeCompare(String(right.task.threadId ?? right.task.thread_id ?? "")));
}

/**
 * Execute one bounded hourly controller cycle using explicitly injected,
 * owner-scoped callbacks.  The audit remains usable without callbacks: in
 * that mode this function records the exact next action but performs no
 * mutation.  A callback may never report an external effect for this
 * controller; browser/provider work belongs to the task-owned runtime.
 */
export async function runBoundedHourlyController({
  summary = {},
  freshStatus = null,
  readStatus = null,
  repair = null,
  verify = null,
  reconcileUnknown = null,
  progressBlocked = null,
  refresh = null,
  continueTask = null,
  eligibleTasks = null,
  previousController = null,
  refreshRequested = false,
  maxContinuations = 50,
  stalledTaskThresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
} = {}) {
  const heartbeatOnly = summary?.changeDetection?.heartbeatOnly === true || summary?.controller?.schedulerDecision === "heartbeat_only";
  const stalled = heartbeatOnly ? stalledTasks(summary, { thresholdMs: stalledTaskThresholdMs }) : [];
  const deepReadCandidates = Number(summary?.threadInspection?.deepReadCandidateCount || 0)
    + Number(summary?.softAnomalyDeepReadCandidateCount || 0);
  if (heartbeatOnly && stalled.length === 0 && deepReadCandidates === 0) {
    return controllerBase(summary, {
      status: "heartbeat_only",
      result: "Unchanged fingerprint; lightweight thread inspection completed, with no deep-read candidate, repair, refresh, continuation, or new task created.",
      next_action_now: "Keep the last exact blocker and wait for a changed signal, a confirmed candidate, or the fresh-status threshold.",
      progress_attempt_now: "lightweight thread inspection and heartbeat readback only",
    });
  }

  let status = freshStatus;
  if (!status && typeof readStatus === "function") {
    try { status = await readStatus({ stage: "fresh_status", auditFingerprint: summary?.auditFingerprint ?? null }); }
    catch (error) {
      return controllerBase(summary, {
        status: "deferred",
        result: "Fresh Companion status failed; no mutation was attempted.",
        exact_blocker: controllerError(error, "companion_fresh_status_failed"),
        next_action_now: "Retry one fresh status read on the next bounded cycle.",
        resume_trigger: "fresh Companion status succeeds",
      });
    }
  }
  if (!status) {
    return controllerBase(summary, {
      status: "deferred",
      result: "No fresh Companion status was supplied; no mutation was attempted.",
      exact_blocker: "companion_fresh_status_required",
      next_action_now: "Read the current owner, generation, lease, pending, queue, and reconciliation status.",
      resume_trigger: "fresh Companion status/readback",
    });
  }

  const fresh = controllerStatus(status);
  if (!fresh.connected) {
    return controllerBase(summary, {
      status: "deferred",
      freshStatus: fresh,
      exact_blocker: "companion_disconnected",
      result: "The Companion status is disconnected; no repair, refresh, continuation, or replay was attempted.",
      progress_attempt_now: "fresh Companion status/readback",
      next_action_now: "Restore the Profile 2 Companion hello, then take one fresh status readback before any repair or refresh.",
      resume_trigger: "connected=true with a fresh Companion generation",
      fallback_or_independent_work: "continue read-only diagnostics and unrelated owner-scoped tasks",
    });
  }
  const selected = selectResumeBlocker({ status: {
    unknown_effect: fresh.unknownEffect,
    foreign_owner: fresh.foreignOwner,
    active_reconciliation: fresh.activeReconciliation,
    human_auth_required: fresh.humanAuthRequired,
  } });
  const candidate = [...(summary?.repairCandidates || [])]
    .sort((left, right) => String(left?.threadId).localeCompare(String(right?.threadId)))[0] || null;
  const candidateProgressPlan = buildBlockerProgressPlan(candidate);
  let recoveredThreadIds = [];
  let recoveredReasons = ["stale_owner_recoverable"];
  let result = null;
  if (HOURLY_HARD_STOP_REASONS.has(selected.reason)) {
    // An unknown external effect remains protected from replay, but it should
    // not make the whole hourly controller passive.  If the caller supplies a
    // read-only, owner-scoped probe, run it once per audit fingerprint and
    // preserve its evidence.  The probe is never a mutation or a duplicate
    // dispatch; unrelated tasks remain eligible on the next stage/tick.
    const globalProgressPlan = buildBlockerProgressPlan({
      exactBlocker: selected.reason,
      companionMarkers: [selected.reason],
    });
    const previousProbeFingerprint = previousController?.blockerProgressFingerprint
      ?? previousController?.reconciliationFingerprint
      ?? null;
    const progressCallback = selected.reason === "unknown_effect" ? reconcileUnknown : progressBlocked;
    const progressFingerprint = `${summary?.auditFingerprint ?? "unknown"}:${candidate?.threadId ?? "global"}:${selected.reason}`;
    if (typeof progressCallback === "function" && previousProbeFingerprint !== progressFingerprint) {
      let probe;
      try {
        probe = await progressCallback({
          stage: selected.reason === "unknown_effect" ? "read_only_reconciliation_probe" : "blocked_progress",
          blocker: selected.reason,
          plan: globalProgressPlan,
          candidate,
          freshStatus: fresh.raw,
          auditFingerprint: summary?.auditFingerprint ?? null,
        });
      } catch (error) {
        probe = { status: "failed", exact_blocker: controllerError(error, "companion_blocker_progress_failed"), external_action_executed: false };
      }
      const probeEffect = probe?.external_action_executed === true || probe?.externalActionExecuted === true;
      const probeFailed = probeEffect || actionFailed(probe);
      const cleared = !probeFailed && blockerProgressCleared(globalProgressPlan, probe);
      const postProgressStatus = controllerStatus(probe?.freshStatus ?? probe?.fresh_status ?? probe?.statusReadback ?? fresh.raw);
      if (!cleared || !postProgressStatus.connected || selectResumeBlocker({ status: {
        unknown_effect: postProgressStatus.unknownEffect,
        foreign_owner: postProgressStatus.foreignOwner,
        active_reconciliation: postProgressStatus.activeReconciliation,
        human_auth_required: postProgressStatus.humanAuthRequired,
      } }).reason !== "ready") {
        return controllerBase(summary, {
          status: selected.reason === "unknown_effect" && !probeFailed ? "reconciliation_probe" : "deferred",
          exact_blocker: probeFailed ? controllerError(probe, "companion_blocker_progress_failed") : selected.reason,
          result: probeFailed
            ? "The blocker progress attempt failed; the affected task remains deferred and the original operation was not replayed."
            : selected.reason === "unknown_effect"
              ? "One read-only reconciliation probe was recorded; the unknown mutation remains quarantined and was not replayed."
              : "The blocker was read back but is not cleared with sufficient proof; no replay or forced resume was attempted.",
          blockerProgress: {
            ...(globalProgressPlan || {}),
            attempted: true,
            status: cleared ? "readback_unresolved" : "deferred",
            result: probe ?? null,
            exact_blocker: probeFailed ? controllerError(probe, "companion_blocker_progress_failed") : selected.reason,
          },
          reconciliationProbe: selected.reason === "unknown_effect" ? probe ?? null : null,
          blockerProgressFingerprint: progressFingerprint,
          reconciliationFingerprint: selected.reason === "unknown_effect" ? summary?.auditFingerprint ?? null : null,
          progress_attempt_now: globalProgressPlan?.progressAttemptNow || "one owner-scoped blocker progress readback",
          next_action_now: globalProgressPlan?.nextActionNow || "preserve the exact blocker and perform a fresh owner-scoped readback",
          resume_trigger: globalProgressPlan?.resumeTrigger || "fresh owner-scoped blocker proof",
          fallback_or_independent_work: globalProgressPlan?.fallbackOrIndependentWork || "continue unrelated owner-scoped tasks and read-only diagnostics",
        });
      }
      result = controllerBase(summary, {
        status: "inspected",
        freshStatus: postProgressStatus,
        blockerProgress: {
          ...(globalProgressPlan || {}),
          attempted: true,
          status: "reconciled",
          resumeAllowed: true,
          result: probe ?? null,
        },
        blockerProgressFingerprint: progressFingerprint,
        reconciliationFingerprint: selected.reason === "unknown_effect" ? summary?.auditFingerprint ?? null : null,
        progress_attempt_now: globalProgressPlan?.progressAttemptNow || "one owner-scoped blocker progress readback",
        result: globalProgressPlan?.result || "The blocker was reconciled with fresh proof; the existing task may continue its current Goal/Plan.",
        next_action_now: "Continue the existing Goal/Plan from its next planned step; do not create or fork a task.",
        resume_trigger: globalProgressPlan?.resumeTrigger || "fresh task readback remains consistent",
        fallback_or_independent_work: globalProgressPlan?.fallbackOrIndependentWork || "continue unrelated owner-scoped tasks",
      });
      if (candidate?.threadId) {
        recoveredThreadIds = [candidate.threadId];
        recoveredReasons = ["task_blocked", "unknown_effect", "foreign_owner", "target_mismatch", "send_result_unknown", "active_reconciliation", "ready", "stale_owner_recoverable"];
      }
    }
    if (!result) return controllerBase(summary, {
      status: "deferred",
      exact_blocker: selected.reason,
      blockerProgress: globalProgressPlan,
      result: `Hard safety boundary ${selected.reason}; the affected task remains deferred and no repair, refresh, continuation, or replay was attempted.`,
      progress_attempt_now: globalProgressPlan?.progressAttemptNow || "fresh owner-scoped blocker readback",
      next_action_now: globalProgressPlan?.nextActionNow || "Preserve the exact blocker and collect fresh owner/target/effect evidence.",
      resume_trigger: globalProgressPlan?.resumeTrigger || `${selected.reason} is cleared by a fresh owner-scoped readback`,
      fallback_or_independent_work: selected.reason === "unknown_effect"
        ? "continue read-only audit and unrelated owner-scoped tasks"
        : globalProgressPlan?.fallbackOrIndependentWork || "continue read-only audit and unrelated owner-scoped tasks",
    });
  }

  if (!result) result = controllerBase(summary, {
    status: "inspected",
    stalledTasks: stalled.map(({ task, lastProgressAt }) => ({
      threadId: task.threadId ?? task.thread_id ?? null,
      lastProgressAt: new Date(lastProgressAt).toISOString(),
      thresholdMs: Math.max(1_000, Number(stalledTaskThresholdMs) || DEFAULT_STALLED_TASK_THRESHOLD_MS),
    })),
    progress_attempt_now: stalled.length > 0
      ? "fresh status/readback for stalled task(s); continue unrelated work independently"
      : "fresh Companion status/readback",
    freshStatus: {
      connected: fresh.connected,
      generation: fresh.generation,
      ownerVerified: fresh.ownerVerified,
      activeLeaseCount: fresh.activeLeaseCount,
      pendingCount: fresh.pendingCount,
      queueCount: fresh.queueCount,
      activeReconciliationCount: fresh.activeReconciliationCount,
    },
  });
  const repairPlan = candidate?.repairPlan || null;
  const previousRepairFingerprint = previousController?.repairFingerprint ?? null;
  const sameRepairSignal = previousRepairFingerprint && previousRepairFingerprint === summary?.auditFingerprint;
  const needsRepair = Boolean(repairPlan?.automatic || selected.reason === "stale_owner_recoverable");

  // A task can remain Goal-blocked even while the profile-global Companion is
  // idle. Do not let that task disappear from the controller: perform one
  // task-scoped progress attempt for ownership/effect/capability uncertainty.
  // Target mismatch is handled by the matching target_binding repair callback;
  // the other reasons require an explicit readback callback before resume.
  const candidateNeedsProgress = Boolean(candidateProgressPlan
    && ["unknown_effect", "send_result_unknown", "foreign_owner", "capability_missing", "active_reconciliation", "external_service_limit", "thread_readback_unavailable"].includes(candidateProgressPlan.reason)
    && (candidateProgressPlan.reason !== "capability_missing" || repairPlan?.automatic !== true)
    && !(result?.blockerProgress?.reason === candidateProgressPlan.reason
      && result?.blockerProgress?.status === "reconciled"));
  if (candidateNeedsProgress && !sameRepairSignal) {
    const progressCallback = candidateProgressPlan.reason === "unknown_effect" ? reconcileUnknown : progressBlocked;
    const candidateProgressFingerprint = `${summary?.auditFingerprint ?? "unknown"}:${candidate?.threadId ?? "unknown"}:${candidateProgressPlan.reason}`;
    const previousProgressFingerprint = previousController?.blockerProgressFingerprint
      ?? previousController?.reconciliationFingerprint
      ?? null;
    if (typeof progressCallback !== "function") {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: candidateProgressPlan.reason,
        blockerProgress: candidateProgressPlan,
        blockerProgressFingerprint: candidateProgressFingerprint,
        result: "A task-level blocker was found; its required owner/effect/target/capability readback callback is unavailable, so the affected Goal remains deferred without replay or adoption.",
        progress_attempt_now: candidateProgressPlan.progressAttemptNow,
        next_action_now: candidateProgressPlan.nextActionNow,
        resume_trigger: candidateProgressPlan.resumeTrigger,
        fallback_or_independent_work: candidateProgressPlan.fallbackOrIndependentWork,
      });
    }
    if (previousProgressFingerprint !== candidateProgressFingerprint) {
      let progressResult;
      try {
        progressResult = await progressCallback({
          stage: candidateProgressPlan.reason === "unknown_effect" ? "read_only_reconciliation_probe" : "blocked_progress",
          blocker: candidateProgressPlan.reason,
          plan: candidateProgressPlan,
          candidate,
          freshStatus: fresh.raw,
          auditFingerprint: summary?.auditFingerprint ?? null,
        });
      } catch (error) {
        progressResult = { status: "failed", exact_blocker: controllerError(error, "companion_blocker_progress_failed"), external_action_executed: false };
      }
      const progressFailed = callbackReportedExternalEffect(progressResult) || actionFailed(progressResult);
      const cleared = !progressFailed && blockerProgressCleared(candidateProgressPlan, progressResult);
      const progressRecord = {
        ...candidateProgressPlan,
        attempted: true,
        status: cleared ? "reconciled" : "deferred",
        resumeAllowed: cleared,
        result: progressResult ?? null,
        exact_blocker: progressFailed ? controllerError(progressResult, "companion_blocker_progress_failed") : candidateProgressPlan.exactBlocker,
      };
      if (!cleared) {
        return controllerBase(summary, {
          ...result,
          status: "deferred",
          exact_blocker: progressFailed ? controllerError(progressResult, "companion_blocker_progress_failed") : candidateProgressPlan.reason,
          blockerProgress: progressRecord,
          blockerProgressFingerprint: candidateProgressFingerprint,
          result: "The task-level blocker progress attempt did not produce sufficient fresh proof; the Goal remains deferred and no replay, adoption, or forced resume was attempted.",
          progress_attempt_now: candidateProgressPlan.progressAttemptNow,
          next_action_now: candidateProgressPlan.nextActionNow,
          resume_trigger: candidateProgressPlan.resumeTrigger,
          fallback_or_independent_work: candidateProgressPlan.fallbackOrIndependentWork,
        });
      }
      result.blockerProgress = progressRecord;
      result.blockerProgressFingerprint = candidateProgressFingerprint;
      recoveredThreadIds = candidate?.threadId ? [candidate.threadId] : [];
      recoveredReasons = ["task_blocked", candidateProgressPlan.reason, "ready", "stale_owner_recoverable"];
    }
  }

  if (needsRepair && !sameRepairSignal) {
    if (typeof repair !== "function") {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: "companion_repair_callback_required",
        result: "A matching repair playbook was found, but no owner-scoped repair callback was supplied.",
        next_action_now: repairPlan?.nextAction || "Apply one matching Companion-local repair and read back its result.",
        repair: { attempted: false, playbookId: repairPlan?.playbookId ?? "stale_connection_generation" },
      });
    }
    let repairResult;
    try { repairResult = await repair({ stage: "bounded_repair", candidate, playbook: repairPlan, freshStatus: fresh.raw }); }
    catch (error) { repairResult = { status: "failed", exact_blocker: controllerError(error), external_action_executed: false }; }
    result.actions.push("repair");
    result.repair = {
      attempted: true,
      threadId: candidate?.threadId ?? candidate?.thread_id ?? null,
      playbookId: repairPlan?.playbookId ?? null,
      result: repairResult ?? null,
    };
    if (repairResult?.external_action_executed === true || repairResult?.externalActionExecuted === true) {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: "hourly_controller_external_effect_forbidden",
        result: "The repair callback reported an external effect; the controller stopped without continuing.",
      });
    }
    if (actionFailed(repairResult)) {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: controllerError(repairResult, "companion_repair_failed"),
        result: "The one bounded repair failed; the same fingerprint will not be replayed.",
        next_action_now: "Keep the repair receipt and use a distinct recovery path after a fresh signal.",
      });
    }
    if (typeof verify !== "function") {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: "companion_repair_verification_callback_required",
        result: "Repair completed without its focused verification; runtime reflection is deferred.",
        next_action_now: "Run schema/check/focused/representative verification before any refresh.",
      });
    }
    let verificationResult;
    try { verificationResult = await verify({ stage: "focused_verification", candidate, repair: repairResult, freshStatus: fresh.raw }); }
    catch (error) { verificationResult = { status: "failed", exact_blocker: controllerError(error), external_action_executed: false }; }
    result.actions.push("verification");
    result.verification = verificationResult ?? null;
    if (verificationResult?.external_action_executed === true || verificationResult?.externalActionExecuted === true || actionFailed(verificationResult)) {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: controllerError(verificationResult, "companion_repair_verification_failed"),
        result: "Focused verification did not pass; no refresh or continuation was attempted.",
      });
    }
  }

  const idleStatus = result.verification?.freshStatus || result.verification?.fresh_status || fresh.raw;
  const idle = idleReconciled(idleStatus);
  if (!idle) {
    return controllerBase(summary, {
      ...result,
      status: "deferred",
      exact_blocker: "companion_idle_reconciled_boundary_required",
      result: "The Companion is not at an idle, reconciled boundary; refresh and continuation were deferred.",
      next_action_now: "Perform one fresh owner/lease/pending/reconciliation readback; do not replay a mutation.",
      resume_trigger: "connected=true with zero active leases, pending operations, queue, and active reconciliation",
    });
  }

  const refreshNeeded = Boolean(refreshRequested || result.repair?.attempted);
  if (refreshNeeded) {
    if (typeof refresh !== "function") {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: "companion_refresh_callback_required",
        result: "A verified repair is ready, but the signed Extension refresh callback is unavailable.",
        next_action_now: "At the idle boundary, perform one supported refresh and require reflected=true with a changed generation.",
      });
    }
    let refreshResult;
    try { refreshResult = await refresh({ stage: "signed_refresh", freshStatus: idleStatus, repair: result.repair, verification: result.verification }); }
    catch (error) { refreshResult = { status: "failed", exact_blocker: controllerError(error), external_action_executed: false }; }
    result.actions.push("refresh");
    result.refresh = refreshResult ?? null;
    const reflected = refreshResult?.reflected === true || refreshResult?.reflected === "true" || refreshResult?.status === "reflected";
    if (refreshResult?.external_action_executed === true || refreshResult?.externalActionExecuted === true || actionFailed(refreshResult) || !reflected) {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: controllerError(refreshResult, reflected ? "companion_refresh_failed" : "companion_refresh_reflection_required"),
        result: "Refresh did not produce a reflected=true generation readback; continuation was not sent.",
        next_action_now: "Read back connected=true and a changed generation once; never reuse the old transaction.",
      });
    }
  }

  const canContinue = !refreshNeeded || Boolean(result.refresh?.reflected === true || result.refresh?.reflected === "true" || result.refresh?.status === "reflected") || result.verification?.continuationAllowed === true;
  if (canContinue) {
    const continuationRecoveredThreadIds = [...new Set([
      ...recoveredThreadIds,
      ...(result.repair?.attempted
        ? [result.repair.threadId ?? candidate?.threadId ?? candidate?.thread_id].filter(Boolean)
        : []),
    ])];
    const tasks = continuationQueue(summary, eligibleTasks, {
      allowRecoveredThreadIds: continuationRecoveredThreadIds,
      allowRecoveredReasons: recoveredReasons,
      maxContinuations,
    });
    if (tasks.length > 0 && typeof continueTask !== "function") {
      return controllerBase(summary, {
        ...result,
        status: "deferred",
        exact_blocker: "companion_continuation_callback_required",
        result: "Eligible source-owned tasks were found, but no continuation callback was supplied.",
        next_action_now: "Send or queue exactly one source-owned continuation per eligible task at its next message boundary.",
      });
    }
    for (const task of tasks) {
      let continuation;
      try {
        continuation = await continueTask(continuationContext(task, "continuation", idleStatus, summary));
      }
      catch (error) { continuation = { status: "failed", exact_blocker: controllerError(error), external_action_executed: false }; }
      result.actions.push("continuation");
      result.continuations.push({
        threadId: task.threadId ?? task.thread_id ?? null,
        idempotencyKey: continuationKeyFor(summary, task, idleStatus),
        result: continuation ?? null,
      });
    }
  }
  result.status = result.actions.length > 0 ? "completed" : "inspected";
  result.result = result.actions.length > 0
    ? "Bounded repair/verification/refresh/continuation cycle completed with external_action_executed=false."
    : "Fresh status was healthy; no repair or refresh was necessary.";
  result.next_action_now = result.status === "completed" ? "Read back each task and record business completion separately." : "Continue the normal task path from the fresh owner session.";
  result.repairFingerprint = needsRepair ? summary?.auditFingerprint ?? null : null;
  result.executionReceipt = buildControllerExecutionReceipt(result);
  return result;
}

/**
 * Run the complete Companion-local repair contract in one scheduler turn.
 *
 * `runBoundedHourlyController` is intentionally kept as the one-cycle
 * primitive for callers that only need a status/repair decision.  The
 * registered hourly automation uses this wrapper when it has an owner-scoped
 * repair callback: every repair (or supported runtime refresh) must be
 * followed by a fresh-generation E2E readback in the same turn.  A failed
 * E2E may lead to another *distinct* repair attempt, but never to a replay of
 * the same failure fingerprint, and the loop is capped at three cycles.
 *
 * The callbacks are deliberately injected.  This keeps browser/provider
 * authority in the task-owned runtime and makes the contract deterministic in
 * tests; the wrapper itself never invents a tab, claims a foreign owner, or
 * dispatches a business-side effect.
 */
export const SAME_RUN_REPAIR_LOOP_SCHEMA = "aos.companion_same_run_repair_loop.v1";
export const DEFAULT_MAX_REPAIR_CYCLES = 3;

function callbackReportedExternalEffect(value) {
  return value?.external_action_executed === true || value?.externalActionExecuted === true;
}

function boundedRepairCycles(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_MAX_REPAIR_CYCLES;
  return Math.min(DEFAULT_MAX_REPAIR_CYCLES, Math.max(1, Math.floor(requested)));
}

function sameRunE2EPassed(value) {
  if (!value || callbackReportedExternalEffect(value) || actionFailed(value)) return false;
  if (value.sameRunE2E === true || value.same_run_e2e === true
    || value.e2eVerified === true || value.e2e_verified === true
    || value.verified === true) return true;
  const state = String(value.status ?? value.result ?? "").toLowerCase();
  return ["passed", "verified", "verified_read_only", "success", "completed"].includes(state);
}

function sameRunE2EFailureFingerprint(value) {
  const candidate = value?.failureFingerprint
    ?? value?.failure_fingerprint
    ?? value?.fingerprint
    ?? value?.errorFingerprint
    ?? value?.error_fingerprint;
  return candidate === undefined || candidate === null || candidate === ""
    ? null
    : String(candidate).slice(0, 500);
}

function blockerProgressCleared(plan, value) {
  if (!plan || !value || callbackReportedExternalEffect(value) || actionFailed(value)) return false;
  if (value.resumeAllowed !== true && value.resume_allowed !== true) return false;
  if (plan.reason === "unknown_effect") {
    return ["known_no_effect"].includes(String(value.effect_state ?? value.effectState ?? "").toLowerCase());
  }
  if (plan.reason === "send_result_unknown") {
    const status = String(value.send_status ?? value.sendStatus ?? value.status ?? "").toLowerCase();
    return ["sent", "observed", "queued"].includes(status)
      && (value.readbackVerified === true || value.readback_verified === true || value.readback?.status === "observed");
  }
  if (plan.reason === "foreign_owner") {
    return (value.ownerVerified === true || value.owner_verified === true)
      && (value.targetVerified === true || value.target_verified === true || value.rebound === true);
  }
  if (plan.reason === "target_mismatch") {
    return (value.targetVerified === true || value.target_verified === true || value.rebound === true)
      && (value.ownerVerified === true || value.owner_verified === true);
  }
  if (plan.reason === "capability_missing") {
    return (value.capabilityVerified === true || value.capability_verified === true)
      && (value.schemaParity === true || value.schema_parity === true)
      && (value.canaryPassed === true || value.canary_passed === true)
      && (value.installedGenerationVerified === true || value.installed_generation_verified === true);
  }
  if (plan.reason === "thread_readback_unavailable") {
    const readbackStatus = String(value.readbackStatus ?? value.readback_status ?? value.status ?? "").toLowerCase();
    return (value.readbackVerified === true || value.readback_verified === true)
      && ["observed", "verified", "success", "completed"].includes(readbackStatus)
      && (value.sameTask === true || value.same_task === true || value.threadId === plan.threadId);
  }
  if (plan.reason === "active_reconciliation") return value.reconciled === true || value.reconciled === "true";
  return false;
}

function sameRunGeneralizedCause(value) {
  const candidate = value?.generalizedCause
    ?? value?.generalized_cause
    ?? value?.rootCause
    ?? value?.root_cause
    ?? value?.cause;
  return candidate === undefined || candidate === null || candidate === ""
    ? null
    : String(candidate).slice(0, 1_000);
}

function sameRunHardBlocker(value) {
  const snapshot = controllerStatus(value);
  const selected = selectResumeBlocker({
    status: {
      unknown_effect: snapshot.unknownEffect,
      foreign_owner: snapshot.foreignOwner,
      active_reconciliation: snapshot.activeReconciliation,
      human_auth_required: snapshot.humanAuthRequired,
    },
  });
  if (HOURLY_HARD_STOP_REASONS.has(selected.reason)) return selected.reason;
  const text = JSON.stringify(value ?? {}).toLowerCase();
  if (/(?:unknown[_ ]effect|operation[_ ]effect[_ ]unknown)/u.test(text)) return "unknown_effect";
  if (/(?:foreign[_ ]owner|session[_ ]not[_ ]owned|target[_ ]page[_ ]mismatch|page[_ ]instance[_ ]mismatch)/u.test(text)) return "foreign_owner";
  if (/(?:active[_ ]reconciliation|reconciliation[_ ]required)/u.test(text)) return "active_reconciliation";
  if (/(?:human[_ ]auth|required[_ ]auth|otp|captcha|本人確認|認証コード)/u.test(text)) return "human_auth_required";
  return null;
}

function mergeRepairCandidate(summary, candidate, nextRepairPlan) {
  if (!candidate || !nextRepairPlan) return summary;
  const candidates = Array.isArray(summary?.repairCandidates) ? summary.repairCandidates : [];
  return {
    ...summary,
    repairCandidates: candidates.map((entry) => entry?.threadId === candidate?.threadId
      ? { ...entry, repairPlan: nextRepairPlan }
      : entry),
  };
}

async function continueEligibleTasksAfterE2E({
  result,
  summary,
  eligibleTasks,
  continueTask,
  freshStatus,
  maxContinuations,
  recoveredThreadIds = [],
  recoveredReasons = ["stale_owner_recoverable"],
}) {
  const tasks = continuationQueue(summary, eligibleTasks, {
    allowRecoveredThreadIds: recoveredThreadIds,
    allowRecoveredReasons: recoveredReasons,
    maxContinuations,
  });
  if (tasks.length > 0 && typeof continueTask !== "function") {
    return {
      ...result,
      status: "deferred",
      exact_blocker: "companion_continuation_callback_required",
      result: "Same-run E2E passed, but no continuation callback was supplied for eligible source-owned tasks.",
      next_action_now: "Send or queue exactly one source-owned continuation per eligible task at its next message boundary.",
    };
  }
  for (const task of tasks) {
    let continuation;
    try {
      continuation = await continueTask(continuationContext(task, "continuation_after_same_run_e2e", freshStatus, summary));
    } catch (error) {
      continuation = { status: "failed", exact_blocker: controllerError(error), external_action_executed: false };
    }
    result.actions.push("continuation");
    result.continuations.push({
      threadId: task.threadId ?? task.thread_id ?? null,
      idempotencyKey: continuationKeyFor(summary, task, freshStatus),
      result: continuation ?? null,
    });
  }
  return result;
}

export async function runSameRunCompanionRepairLoop({
  summary = {},
  freshStatus = null,
  readStatus = null,
  repair = null,
  verify = null,
  reconcileUnknown = null,
  progressBlocked = null,
  refresh = null,
  e2e = null,
  continueTask = null,
  eligibleTasks = null,
  previousController = null,
  refreshRequested = false,
  maxContinuations = 50,
  maxRepairCycles = DEFAULT_MAX_REPAIR_CYCLES,
  stalledTaskThresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
  learningLedgerPath = null,
} = {}) {
  const cycleLimit = boundedRepairCycles(maxRepairCycles);
  const loop = {
    schema: SAME_RUN_REPAIR_LOOP_SCHEMA,
    required: true,
    maxRepairCycles: cycleLimit,
    e2eRequiredAfterRepair: true,
    sameRunVerification: true,
    cycles: [],
    failureFingerprints: [],
    passed: false,
    exhausted: false,
    externalActionExecuted: false,
  };
  const decorate = (value) => {
    const result = {
      ...(value || controllerBase(summary)),
      sameRunRepairLoop: loop,
    };
    if (learningLedgerPath) {
      const ledger = recordCompanionLearningOutcome(learningLedgerPath, { summary, controller: result });
      result.learning = summarizeLearningLedger(ledger);
    }
    result.executionReceipt = buildControllerExecutionReceipt(result);
    return result;
  };

  // An unchanged heartbeat should stay cheap and side-effect free.  The
  // normal one-cycle controller still provides the exact status contract.
  const heartbeatOnly = summary?.changeDetection?.heartbeatOnly === true
    || summary?.controller?.schedulerDecision === "heartbeat_only";
  const stalled = heartbeatOnly ? stalledTasks(summary, { thresholdMs: stalledTaskThresholdMs }) : [];
  const deepReadCandidates = Number(summary?.threadInspection?.deepReadCandidateCount || 0)
    + Number(summary?.softAnomalyDeepReadCandidateCount || 0);
  if (heartbeatOnly && stalled.length === 0 && deepReadCandidates === 0) {
    return decorate(await runBoundedHourlyController({
      summary,
      freshStatus,
      readStatus,
      repair: null,
      verify: null,
      reconcileUnknown,
      refresh: null,
      continueTask: null,
      eligibleTasks,
      previousController,
      refreshRequested: false,
      maxContinuations,
      stalledTaskThresholdMs,
    }));
  }

  let cycleSummary = summary;
  let cycleFreshStatus = freshStatus;
  let priorAttempt = null;
  let lastResult = null;
  let repairCallback = repair;

  for (let cycle = 1; cycle <= cycleLimit; cycle += 1) {
    if (!cycleFreshStatus && typeof readStatus === "function") {
      try {
        cycleFreshStatus = await readStatus({
          stage: "same_run_fresh_status",
          cycle,
          auditFingerprint: summary?.auditFingerprint ?? null,
        });
      } catch (error) {
        lastResult = controllerBase(summary, {
          status: "deferred",
          exact_blocker: controllerError(error, "companion_fresh_status_failed"),
          result: "Same-run repair loop could not obtain a fresh Companion status; no mutation was attempted.",
          next_action_now: "Read a fresh owner/generation/lease/pending/reconciliation status before another cycle.",
        });
        loop.cycles.push({ cycle, status: "deferred", exactBlocker: lastResult.exact_blocker });
        break;
      }
    }

    const cycleResult = await runBoundedHourlyController({
      summary: cycleSummary,
      freshStatus: cycleFreshStatus,
      readStatus: null,
      repair: repairCallback,
      verify,
      reconcileUnknown,
      progressBlocked,
      refresh,
      // Continuation is intentionally delayed until the E2E readback passes.
      continueTask: null,
      eligibleTasks: [],
      previousController: cycle === 1 ? previousController : null,
      refreshRequested: cycle === 1 ? refreshRequested : false,
      maxContinuations: 0,
      stalledTaskThresholdMs,
    });
    lastResult = cycleResult;
    const changedRuntime = cycleResult?.repair?.attempted === true
      || cycleResult?.refresh?.reflected === true
      || cycleResult?.refresh?.status === "reflected";
    const cycleRecord = {
      cycle,
      controllerStatus: cycleResult?.status ?? null,
      actions: [...(cycleResult?.actions || [])],
      repair: cycleResult?.repair ?? null,
      verification: cycleResult?.verification ?? null,
      refresh: cycleResult?.refresh ?? null,
      e2e: null,
    };
    loop.cycles.push(cycleRecord);

    if (cycleResult?.status === "deferred" || !changedRuntime) {
      // No source/runtime change occurred, so there is no new artifact to
      // verify. A healthy cycle may still resume eligible tasks. When the
      // affected Companion lane is merely waiting for a local callback or an
      // idle boundary, continue unrelated ready tasks without claiming that
      // the affected task was repaired.
      if (cycleResult?.status !== "deferred") {
        const continued = await continueEligibleTasksAfterE2E({
          result: cycleResult,
          summary: cycleSummary,
          eligibleTasks,
          continueTask,
          freshStatus: cycleResult?.freshStatus ?? cycleFreshStatus,
          maxContinuations,
          recoveredThreadIds: cycleResult?.blockerProgress?.resumeAllowed === true
            ? [cycleSummary?.repairCandidates?.[0]?.threadId].filter(Boolean)
            : [],
          recoveredReasons: cycleResult?.blockerProgress?.resumeAllowed === true
            ? ["task_blocked", cycleResult.blockerProgress.reason, "ready", "stale_owner_recoverable"]
            : ["stale_owner_recoverable"],
        });
        lastResult = continued;
      } else if (INDEPENDENT_CONTINUATION_SAFE_BLOCKERS.has(String(cycleResult?.exact_blocker || ""))) {
        const affected = cycleSummary?.repairCandidates
          ?.map((entry) => entry?.threadId ?? entry?.thread_id)
          .filter(Boolean) || [];
        lastResult = await continueIndependentTasksAfterDeferred({
          result: cycleResult,
          summary: cycleSummary,
          eligibleTasks,
          continueTask,
          freshStatus: cycleResult?.freshStatus ?? cycleFreshStatus,
          maxContinuations,
          excludeThreadIds: affected,
        });
      }
      break;
    }

    if (typeof e2e !== "function") {
      lastResult = controllerBase(summary, {
        ...cycleResult,
        status: "deferred",
        exact_blocker: "same_run_e2e_callback_required",
        result: "Repair/refresh completed, but same-run real E2E verification was not supplied; continuation was withheld.",
        next_action_now: "Run a fresh-generation Companion E2E canary in this same scheduler turn before continuing the task.",
      });
      break;
    }

    let e2eResult;
    try {
      e2eResult = await e2e({
        stage: "same_run_e2e",
        cycle,
        candidate: cycleSummary?.repairCandidates?.[0] ?? null,
        repair: cycleResult.repair,
        verification: cycleResult.verification,
        refresh: cycleResult.refresh,
        freshStatus: cycleResult.freshStatus ?? cycleFreshStatus,
        previousAttempt: priorAttempt,
      });
    } catch (error) {
      e2eResult = { status: "failed", exact_blocker: controllerError(error, "same_run_e2e_failed"), external_action_executed: false };
    }
    cycleRecord.e2e = e2eResult ?? null;
    if (callbackReportedExternalEffect(e2eResult)) {
      loop.externalActionExecuted = true;
      lastResult = controllerBase(summary, {
        ...cycleResult,
        status: "deferred",
        exact_blocker: "same_run_e2e_external_effect_forbidden",
        result: "The E2E callback reported an external effect; no retry or continuation was attempted.",
      });
      break;
    }
    if (sameRunE2EPassed(e2eResult)) {
      loop.passed = true;
      const e2eStatus = e2eResult?.freshStatus ?? e2eResult?.fresh_status ?? e2eResult?.statusReadback ?? cycleResult.freshStatus ?? cycleFreshStatus;
      let postE2EStatus = e2eStatus;
      if (typeof readStatus === "function") {
        try {
          postE2EStatus = await readStatus({ stage: "same_run_e2e_readback", cycle, auditFingerprint: summary?.auditFingerprint ?? null });
        } catch (error) {
          lastResult = controllerBase(summary, {
            ...cycleResult,
            status: "deferred",
            exact_blocker: controllerError(error, "same_run_e2e_readback_failed"),
            result: "Same-run E2E passed, but its fresh runtime readback failed; continuation was withheld.",
          });
          break;
        }
      }
      if (!idleReconciled(postE2EStatus)) {
        lastResult = controllerBase(summary, {
          ...cycleResult,
          status: "deferred",
          exact_blocker: "companion_idle_reconciled_boundary_required_after_e2e",
          result: "Same-run E2E passed, but the post-E2E runtime is not idle and reconciled; continuation was withheld.",
          next_action_now: "Read back owner/generation/lease/pending/queue/reconciliation before continuing.",
        });
        break;
      }
      const continued = await continueEligibleTasksAfterE2E({
        result: {
          ...cycleResult,
          status: cycleResult.actions.length > 0 ? "completed" : "inspected",
          sameRunE2E: e2eResult,
          e2e: e2eResult,
        },
        summary: cycleSummary,
        eligibleTasks,
        continueTask,
        freshStatus: postE2EStatus,
        maxContinuations,
        recoveredThreadIds: cycleResult?.repair?.attempted
          ? [cycleResult.repair.threadId ?? cycleSummary?.repairCandidates?.[0]?.threadId].filter(Boolean)
          : cycleResult?.blockerProgress?.resumeAllowed === true
            ? [cycleSummary?.repairCandidates?.[0]?.threadId].filter(Boolean)
            : [],
        recoveredReasons: cycleResult?.blockerProgress?.resumeAllowed === true
          ? ["task_blocked", cycleResult.blockerProgress.reason, "ready", "stale_owner_recoverable"]
          : ["stale_owner_recoverable"],
      });
      lastResult = continued;
      break;
    }

    const hardBlocker = sameRunHardBlocker(e2eResult);
    if (hardBlocker) {
      lastResult = controllerBase(summary, {
        ...cycleResult,
        status: "deferred",
        exact_blocker: hardBlocker,
        sameRunE2E: e2eResult,
        result: `Same-run E2E reached hard safety boundary ${hardBlocker}; no retry or continuation was attempted.`,
        next_action_now: "Preserve the E2E evidence and obtain the required owner/human/provider readback.",
      });
      break;
    }
    const failureFingerprint = sameRunE2EFailureFingerprint(e2eResult);
    const generalizedCause = sameRunGeneralizedCause(e2eResult);
    if (!failureFingerprint || !generalizedCause) {
      lastResult = controllerBase(summary, {
        ...cycleResult,
        status: "deferred",
        exact_blocker: "same_run_e2e_repair_contract_incomplete",
        sameRunE2E: e2eResult,
        result: "Same-run E2E failed without a distinct failure fingerprint and generalized cause; an unbounded retry was refused.",
        next_action_now: "Record the observed failure, generalize its cause, and provide a distinct bounded repair path.",
      });
      break;
    }
    if (loop.failureFingerprints.includes(failureFingerprint)) {
      lastResult = controllerBase(summary, {
        ...cycleResult,
        status: "deferred",
        exact_blocker: "same_run_e2e_duplicate_failure_fingerprint",
        sameRunE2E: e2eResult,
        result: "The same same-run E2E failure fingerprint recurred; the repair was not replayed.",
        next_action_now: "Keep the evidence and choose a genuinely different implementation path after a fresh signal.",
      });
      break;
    }
    loop.failureFingerprints.push(failureFingerprint);
    priorAttempt = {
      cycle,
      failureFingerprint,
      generalizedCause,
      e2e: e2eResult,
      repair: cycleResult.repair,
      verification: cycleResult.verification,
      refresh: cycleResult.refresh,
    };
    if (cycle >= cycleLimit) {
      loop.exhausted = true;
      lastResult = controllerBase(summary, {
        ...cycleResult,
        status: "deferred",
        exact_blocker: "same_run_e2e_failed_after_max_repair_cycles",
        sameRunE2E: e2eResult,
        result: `Same-run E2E failed after ${cycleLimit} bounded repair cycle(s); no further retry was attempted.`,
        next_action_now: "Preserve the failed E2E evidence and resume with a fresh distinct signal or manual review.",
      });
      break;
    }
    cycleFreshStatus = null;
    cycleSummary = mergeRepairCandidate(summary, cycleSummary?.repairCandidates?.[0] ?? null, e2eResult?.nextRepairPlan ?? e2eResult?.next_repair_plan ?? null);
    repairCallback = typeof repair === "function"
      ? (args) => repair({ ...args, cycle: cycle + 1, previousAttempt: priorAttempt, generalizedCause, failureFingerprint })
      : repair;
  }

  if (!lastResult) {
    lastResult = controllerBase(summary, {
      status: "deferred",
      exact_blocker: "same_run_repair_loop_no_result",
      result: "The same-run repair loop ended without a terminal controller result.",
    });
  }
  return decorate(lastResult);
}

function emptyLearningLedger() {
  return {
    schema: COMPANION_LEARNING_LEDGER_SCHEMA,
    protocol: {
      schema: COMPANION_LEARNING_PROTOCOL_SCHEMA,
      independentReproductionThreshold: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
      promotion: "proposal_only_human_approval_and_verified_canary_required",
      automaticActivation: false,
    },
    observations: {},
    events: [],
    runs: [],
    learningOutcomes: [],
    playbookProposals: [],
    softConfirmations: {},
    threadInspections: {},
    lastSoftAnomalyKeys: [],
    lastFingerprint: null,
    noChangeRuns: 0,
    lastChangedAt: null,
  };
}

function loadLearningLedger(file) {
  if (!file) return emptyLearningLedger();
  const existing = readJson(file);
  if (!existing || existing.schema !== COMPANION_LEARNING_LEDGER_SCHEMA) return emptyLearningLedger();
  return {
    schema: existing.schema,
    protocol: {
      schema: COMPANION_LEARNING_PROTOCOL_SCHEMA,
      independentReproductionThreshold: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
      promotion: "proposal_only_human_approval_and_verified_canary_required",
      automaticActivation: false,
    },
    observations: existing.observations && typeof existing.observations === "object" ? existing.observations : {},
    events: Array.isArray(existing.events) ? existing.events.slice(-5000) : [],
    runs: Array.isArray(existing.runs) ? existing.runs.slice(-23) : [],
    learningOutcomes: Array.isArray(existing.learningOutcomes) ? existing.learningOutcomes.slice(-MAX_LEARNING_OUTCOMES) : [],
    playbookProposals: Array.isArray(existing.playbookProposals) ? existing.playbookProposals.slice(-MAX_PLAYBOOK_PROPOSALS) : [],
    softConfirmations: existing.softConfirmations && typeof existing.softConfirmations === "object" ? existing.softConfirmations : {},
    threadInspections: existing.threadInspections && typeof existing.threadInspections === "object" ? existing.threadInspections : {},
    lastSoftAnomalyKeys: Array.isArray(existing.lastSoftAnomalyKeys) ? existing.lastSoftAnomalyKeys.slice(-MAX_SOFT_ANOMALY_FINDINGS) : [],
    lastFingerprint: typeof existing.lastFingerprint === "string" ? existing.lastFingerprint : null,
    noChangeRuns: Number.isFinite(Number(existing.noChangeRuns)) ? Number(existing.noChangeRuns) : 0,
    lastChangedAt: existing.lastChangedAt || null,
  };
}

function boundedLearningText(value, max = MAX_LEARNING_TEXT_CHARS) {
  return String(value ?? "")
    .replace(/[\u0000\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function learningDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function learningOutcomeKey(independentEvidenceKey, proposedPlaybookId) {
  return `outcome-${learningDigest({ independentEvidenceKey, proposedPlaybookId }).slice(0, 32)}`;
}

function learningVerificationStatus(controller) {
  const explicit = controller?.learningVerification ?? controller?.learning_verification;
  if (explicit && typeof explicit === "object") {
    const status = boundedLearningText(explicit.status, 40).toLowerCase();
    if (["passed", "failed", "not_run", "deferred"].includes(status)) {
      return {
        status,
        proofClass: boundedLearningText(explicit.proofClass ?? explicit.proof_class, 100) || "explicit_controller_receipt",
        sameRunE2E: explicit.sameRunE2E === true || explicit.same_run_e2e === true,
      };
    }
  }
  const loop = controller?.sameRunRepairLoop;
  if (loop?.passed === true && loop?.externalActionExecuted !== true) {
    return { status: "passed", proofClass: "same_run_e2e_and_fresh_readback", sameRunE2E: true };
  }
  if (Array.isArray(loop?.cycles) && loop.cycles.some((cycle) => cycle?.e2e)) {
    return { status: "failed", proofClass: "same_run_e2e_and_fresh_readback", sameRunE2E: true };
  }
  return { status: "not_run", proofClass: "observation_or_focused_verification_only", sameRunE2E: false };
}

function buildObservedLearningOutcome({ item = {}, marker, eventKey, summary = {}, plan = null } = {}) {
  const markerValue = boundedLearningText(marker, 120) || "unknown_signal";
  const concretePlaybook = plan?.playbookId
    && plan.playbookId !== "companion_local_review"
    && REPAIR_PLAYBOOKS[plan.playbookId]
    ? REPAIR_PLAYBOOKS[plan.playbookId]
    : null;
  const promotionEligible = item.companionIssue === true
    && item.userHelpRequired !== true
    && item.blocked !== true
    && !concretePlaybook;
  const proposalKey = promotionEligible
    ? `signal:${learningDigest({ marker: markerValue, diagnosis: "unclassified_companion_signal" }).slice(0, 32)}`
    : null;
  const proposedPlaybookId = concretePlaybook?.id || "candidate_local_review";
  return {
    schema: COMPANION_LEARNING_OUTCOME_SCHEMA,
    outcomeKey: learningOutcomeKey(eventKey, proposedPlaybookId),
    observedAt: summary.auditedAt ?? new Date().toISOString(),
    evidence: {
      independentKey: boundedLearningText(eventKey, 300),
      auditFingerprint: boundedLearningText(summary.auditFingerprint, 120) || null,
      sourceThreadId: boundedLearningText(item.threadId ?? item.thread_id, 200) || null,
    },
    signal: {
      marker: markerValue,
      class: promotionEligible ? "novel_companion_signal" : "known_or_non_promotable_signal",
    },
    diagnosis: {
      category: boundedLearningText(plan?.disposition, 100) || "unclassified_companion_signal",
      generalizedCause: concretePlaybook ? `known_playbook:${concretePlaybook.id}` : "unclassified_companion_signal",
    },
    repairProposal: {
      playbookId: proposedPlaybookId,
      action: concretePlaybook?.action || "root-owned fresh status/readback, then propose a narrow Companion-local adapter repair",
      automatic: concretePlaybook?.automatic === true,
      authorization: "root_owner_only",
    },
    verification: {
      status: "not_run",
      proofClass: "observation_only",
      focusedTest: "not_recorded",
      representativeCanary: "not_recorded",
      freshReadback: "thread_observation_only",
    },
    result: {
      status: item.userHelpRequired === true ? "human_gate_observed" : item.blocked === true ? "blocked_observed" : "observed",
      exactBlocker: null,
      externalActionExecuted: false,
    },
    successRate: {
      verifiedPasses: 0,
      verifiedAttempts: 0,
      value: null,
      basis: "verified controller outcomes only",
    },
    promotion: {
      eligible: promotionEligible,
      proposalKey,
      status: promotionEligible ? "tracking" : "not_eligible",
      independentReproductionCount: 1,
      threshold: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
      automaticActivation: false,
      activation: "human_approval_required",
    },
  };
}

function upsertLearningOutcome(ledger, outcome) {
  if (!outcome?.outcomeKey) return;
  const index = ledger.learningOutcomes.findIndex((entry) => entry?.outcomeKey === outcome.outcomeKey);
  if (index < 0) ledger.learningOutcomes.push(outcome);
  else {
    const existing = ledger.learningOutcomes[index];
    const keepVerification = existing?.verification?.status && existing.verification.status !== "not_run";
    ledger.learningOutcomes[index] = {
      ...existing,
      ...outcome,
      verification: keepVerification ? existing.verification : outcome.verification,
      result: keepVerification ? existing.result : outcome.result,
      successRate: existing.successRate ?? outcome.successRate,
    };
  }
}

function learningGroups(ledger) {
  const groups = new Map();
  for (const outcome of ledger.learningOutcomes || []) {
    const proposalKey = outcome?.promotion?.proposalKey;
    if (!outcome?.promotion?.eligible || !proposalKey) continue;
    if (!groups.has(proposalKey)) groups.set(proposalKey, []);
    groups.get(proposalKey).push(outcome);
  }
  return groups;
}

function updateLearningOutcomeRates(ledger) {
  const groups = learningGroups(ledger);
  for (const outcomes of groups.values()) {
    const uniqueEvidence = new Set(outcomes.map((outcome) => outcome?.evidence?.independentKey).filter(Boolean));
    const verified = outcomes.filter((outcome) => ["passed", "failed"].includes(outcome?.verification?.status));
    const passed = verified.filter((outcome) => outcome.verification.status === "passed").length;
    const rate = verified.length > 0 ? Number((passed / verified.length).toFixed(4)) : null;
    for (const outcome of outcomes) {
      outcome.successRate = {
        verifiedPasses: passed,
        verifiedAttempts: verified.length,
        value: rate,
        basis: "verified controller outcomes only",
      };
      outcome.promotion.independentReproductionCount = uniqueEvidence.size;
      outcome.promotion.status = uniqueEvidence.size >= MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL ? "proposed" : "tracking";
    }
  }
}

function refreshPlaybookProposals(ledger, observedAt) {
  updateLearningOutcomeRates(ledger);
  const previous = new Map((ledger.playbookProposals || []).map((proposal) => [proposal?.proposalKey, proposal]));
  const proposals = [];
  for (const [proposalKey, outcomes] of learningGroups(ledger)) {
    const evidenceKeys = [...new Set(outcomes.map((outcome) => outcome?.evidence?.independentKey).filter(Boolean))];
    if (evidenceKeys.length < MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL) continue;
    const first = outcomes[0];
    const proposalId = `proposal-${learningDigest({ proposalKey }).slice(0, 24)}`;
    const verified = outcomes.filter((outcome) => ["passed", "failed"].includes(outcome?.verification?.status));
    const passed = verified.filter((outcome) => outcome.verification.status === "passed").length;
    const prior = previous.get(proposalKey);
    proposals.push({
      schema: COMPANION_PLAYBOOK_PROPOSAL_SCHEMA,
      proposalId,
      proposalKey,
      status: "proposed",
      activationStatus: "human_approval_required",
      automatic: false,
      independentReproductionCount: evidenceKeys.length,
      minimumIndependentReproductions: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
      firstSeen: prior?.firstSeen || first.observedAt || observedAt,
      lastSeen: observedAt,
      signal: first.signal,
      diagnosis: first.diagnosis,
      repairSuggestion: {
        playbookId: `candidate-${proposalId.slice(-12)}`,
        action: first.repairProposal.action,
        authorization: "root_owner_only",
      },
      verificationGate: {
        required: ["matching_adapter", "focused_test", "representative_canary", "fresh_readback"],
        sameRunE2ERequired: true,
        externalEffectProof: false,
      },
      successRate: {
        verifiedPasses: passed,
        verifiedAttempts: verified.length,
        value: verified.length > 0 ? Number((passed / verified.length).toFixed(4)) : null,
        basis: "verified controller outcomes only",
      },
      evidenceDigest: learningDigest(evidenceKeys),
      nextAction: "Human review, then implement and verify the matching adapter before activation; do not auto-activate this proposal.",
    });
  }
  ledger.playbookProposals = proposals.slice(-MAX_PLAYBOOK_PROPOSALS);
}

function summarizeLearningLedger(ledger) {
  const outcomes = Array.isArray(ledger?.learningOutcomes) ? ledger.learningOutcomes : [];
  const verified = outcomes.filter((outcome) => ["passed", "failed"].includes(outcome?.verification?.status));
  return {
    schema: ledger?.schema || COMPANION_LEARNING_LEDGER_SCHEMA,
    protocol: ledger?.protocol || emptyLearningLedger().protocol,
    updatedAt: ledger?.updatedAt ?? null,
    observationCount: Object.keys(ledger?.observations || {}).length,
    outcomeCount: outcomes.length,
    verifiedOutcomeCount: verified.length,
    proposedPlaybookCount: Array.isArray(ledger?.playbookProposals) ? ledger.playbookProposals.length : 0,
    minimumIndependentReproductions: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
    proposedPlaybooks: (ledger?.playbookProposals || []).slice(-20),
  };
}

/**
 * Attach a verified controller result to the matching private learning
 * outcome.  This only stores bounded evidence; it never grants permission or
 * activates a playbook.
 */
export function recordCompanionLearningOutcome(file, { summary = {}, controller = {} } = {}) {
  const ledger = loadLearningLedger(file);
  if (!file || !controller || typeof controller !== "object") return ledger;
  const repair = controller.repair?.attempted === true ? controller.repair : null;
  const threadId = boundedLearningText(repair?.threadId ?? repair?.thread_id, 200);
  const playbookId = boundedLearningText(repair?.playbookId, 120);
  if (!threadId || !playbookId) return ledger;
  const auditFingerprint = boundedLearningText(summary.auditFingerprint, 120);
  const matching = ledger.learningOutcomes.filter((outcome) => outcome?.evidence?.sourceThreadId === threadId
    && outcome?.evidence?.auditFingerprint === auditFingerprint
    && outcome?.repairProposal?.playbookId === playbookId);
  const outcome = matching[matching.length - 1];
  if (!outcome) return ledger;
  const verification = learningVerificationStatus(controller);
  outcome.verification = {
    ...outcome.verification,
    status: verification.status,
    proofClass: verification.proofClass,
    sameRunE2E: verification.sameRunE2E,
    focusedTest: verification.status === "not_run" ? "not_recorded" : "controller_receipt",
    representativeCanary: verification.sameRunE2E ? "same_run_e2e" : "not_recorded",
    freshReadback: verification.sameRunE2E ? "required_and_recorded_by_controller" : "not_verified",
  };
  outcome.result = {
    ...outcome.result,
    status: verification.status === "passed" ? "verified_pass" : verification.status === "failed" ? "verified_fail" : "controller_deferred",
    externalActionExecuted: controller.external_action_executed === true || controller.externalActionExecuted === true,
  };
  refreshPlaybookProposals(ledger, summary.auditedAt ?? new Date().toISOString());
  ledger.updatedAt = summary.auditedAt ?? new Date().toISOString();
  writePrivateJson(file, ledger);
  return ledger;
}

/**
 * Build a stable signal for the hourly scheduler. The timestamp and prose
 * tails are intentionally excluded so an unchanged workspace does not look
 * like a new incident on every tick.
 */
export function buildAuditFingerprint(summary) {
  // The current Codex task writes this audit's own tool output to its session
  // log. Excluding that one session prevents the scheduler from treating its
  // own heartbeat as a new incident on every invocation.
  const currentThreadId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null;
  const sessions = (summary?.sessions || [])
    .filter((item) => isLiveCandidate(item))
    .filter((item) => !currentThreadId || item.threadId !== currentThreadId)
    .map((item) => ({
      threadId: item.threadId || null,
      companionMarkers: [...(item.companionMarkers || [])].sort(),
      userHelpMarkers: [...(item.userHelpMarkers || [])].sort(),
      softAnomalies: [...(item.softAnomalies || [])]
        .map((anomaly) => ({
          type: anomaly?.type ?? anomaly?.category ?? null,
          severity: anomaly?.severity ?? null,
          confidence: anomaly?.confidence ?? null,
          missingDimensions: [...(anomaly?.missingDimensions || [])].sort(),
        }))
        .sort((left, right) => String(left.type).localeCompare(String(right.type))),
      blocked: Boolean(item.blocked),
      completed: Boolean(item.completed),
    }))
    .sort((left, right) => String(left.threadId).localeCompare(String(right.threadId)));
  const signal = {
    source: summary?.source || null,
    installed: summary?.installed || null,
    companionArtifacts: summary?.companionArtifacts || null,
    liveCandidateSessionCount: Number(summary?.liveCandidateSessionCount || 0),
    companionIssueCount: Number(summary?.companionIssueCount || 0),
    userHelpRequiredCount: Number(summary?.userHelpRequiredCount || 0),
    blockedCount: Number(summary?.blockedCount || 0),
    liveCompanion: summary?.liveCompanion
      ? {
          available: summary.liveCompanion.available === true,
          connected: summary.liveCompanion.connected === true,
          generation: summary.liveCompanion.generation ?? null,
          exactBlocker: summary.liveCompanion.exactBlocker ?? null,
          activeReconciliationCount: Number(summary.liveCompanion.activeReconciliationCount || 0),
          activeTaskTabCount: Number(summary.liveCompanion.activeTaskTabCount || 0),
          activeLeaseCount: Number(summary.liveCompanion.activeLeaseCount || 0),
          pendingCount: Number(summary.liveCompanion.pendingCount || 0),
          queueCount: Number(summary.liveCompanion.queueCount || 0),
        }
      : null,
    sessions,
    threadInspection: (summary?.threadInspection?.records || [])
      .map((record) => ({
        threadId: record?.threadId ?? null,
        owner: record?.owner ?? null,
        status: record?.status ?? null,
        revision: record?.revision ?? null,
        updatedAt: record?.updatedAt ?? null,
        generation: record?.generation ?? null,
        latestTurnStatus: record?.latestTurnStatus ?? null,
        goalStatus: record?.goalStatus ?? null,
        planStatus: record?.planStatus ?? null,
        exactBlocker: record?.exactBlocker ?? null,
        owner: record?.owner ?? null,
        actionable: record?.actionable === true,
        softAnomalyTypes: [...(record?.softAnomalyTypes || [])].sort(),
      }))
      .sort((left, right) => String(left.threadId).localeCompare(String(right.threadId))),
  };
  return crypto.createHash("sha256").update(JSON.stringify(signal)).digest("hex");
}

/**
 * Produce a small, deterministic verifier input.  The full audit retains
 * history for operators, while the independent verifier receives only the
 * bounded signal it needs and can never be handed an accidentally truncated
 * tool transcript or base64 payload.
 */
export function buildVerifierProjection(summary, { maxBytes = MAX_VERIFIER_PROJECTION_BYTES } = {}) {
  const projection = {
    schema: "aos.hourly_companion_audit.verifier.v1",
    auditedAt: summary?.auditedAt ?? null,
    auditFingerprint: summary?.auditFingerprint ?? null,
    readOnly: summary?.readOnly === true,
    externalActionExecuted: summary?.externalActionExecuted === true,
    counts: {
      recentUserSessionCount: Number(summary?.recentUserSessionCount || 0),
      liveCandidateSessionCount: Number(summary?.liveCandidateSessionCount || 0),
      companionIssueCount: Number(summary?.companionIssueCount || 0),
      userHelpRequiredCount: Number(summary?.userHelpRequiredCount || 0),
      blockedCount: Number(summary?.blockedCount || 0),
      softAnomalyCount: Number(summary?.softAnomalyCount || (summary?.softAnomalies || summary?.softAnomalyFindings || []).length || 0),
      softAnomalyConfirmationCount: Number(summary?.softAnomalyConfirmationCount || 0),
      proactiveRepairCandidateCount: Number(summary?.controller?.proactiveRepairCandidateCount || 0),
      lightweightThreadInspectionCount: Number(summary?.threadInspection?.lightweightInspectionCount || 0),
      deepReadCandidateCount: Number(summary?.threadInspection?.deepReadCandidateCount || 0),
      deepReadCount: Number(summary?.threadInspection?.deepReadCount || 0),
    },
    exactBlocker: summary?.exactBlocker ?? null,
    nextAction: summary?.nextAction ?? null,
    interactionPolicy: summary?.controller?.interactionPolicy
      ? {
          schema: summary.controller.interactionPolicy.schema,
          operationMode: summary.controller.interactionPolicy.operationMode,
          cursor: summary.controller.interactionPolicy.cursor,
          cursorMovesOsPointer: summary.controller.interactionPolicy.cursorMovesOsPointer === true,
          inputMode: summary.controller.interactionPolicy.inputMode,
          futureCapabilityGate: [...(summary.controller.interactionPolicy.futureCapabilityGate || [])],
        }
      : null,
    liveCompanion: summary?.liveCompanion
      ? {
          available: summary.liveCompanion.available === true,
          connected: summary.liveCompanion.connected === true,
          generation: summary.liveCompanion.generation ?? null,
          exactBlocker: summary.liveCompanion.exactBlocker ?? null,
          activeReconciliationCount: Number(summary.liveCompanion.activeReconciliationCount || 0),
          activeTaskTabCount: Number(summary.liveCompanion.activeTaskTabCount || 0),
        }
      : null,
    threadInspection: {
      schema: THREAD_INSPECTION_SCHEMA,
      mode: summary?.threadInspection?.mode ?? "lightweight_all_then_deep_read_candidates",
      listedCount: Number(summary?.threadInspection?.listedCount || 0),
      eligibleTaskCount: Number(summary?.threadInspection?.eligibleTaskCount || 0),
      skippedNonUserOwnedCount: Number(summary?.threadInspection?.skippedNonUserOwnedCount || 0),
      lightweightInspectionCount: Number(summary?.threadInspection?.lightweightInspectionCount || 0),
      lightweightReadCount: Number(summary?.threadInspection?.lightweightReadCount || 0),
      deepReadCandidateCount: Number(summary?.threadInspection?.deepReadCandidateCount || 0),
      deepReadAttemptedCount: Number(summary?.threadInspection?.deepReadAttemptedCount || 0),
      deepReadCount: Number(summary?.threadInspection?.deepReadCount || 0),
      deepReadTruncated: summary?.threadInspection?.deepReadTruncated === true,
      records: [],
      truncated: false,
    },
    candidates: [],
    candidatesTruncated: false,
    blockerProgressCandidates: [],
    blockerProgressCandidatesTruncated: false,
    softAnomalies: [],
    softAnomaliesTruncated: false,
  };
  const candidates = [...(summary?.liveCandidates || [])]
    .sort((left, right) => String(left?.threadId).localeCompare(String(right?.threadId)))
    .map((item) => {
      const assessment = item?.resumeAssessment || buildResumeAssessment(item);
      return {
        threadId: item?.threadId ?? null,
        companionMarkers: [...(item?.companionMarkers || [])].sort(),
        userHelpMarkers: [...(item?.userHelpMarkers || [])].sort(),
        blocked: item?.blocked === true,
        completed: item?.completed === true,
        resumeAssessment: {
          state: assessment.state,
          reason: assessment.reason,
          priority: assessment.priority,
        },
        latestSummary: compactLatestSummary(item?.latestSummary || "").slice(-240),
      };
    });
  for (const candidate of candidates) {
    const next = { ...projection, candidates: [...projection.candidates, candidate] };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) {
      projection.candidatesTruncated = true;
      break;
    }
    projection.candidates.push(candidate);
  }
  const blockerProgressCandidates = [...(summary?.repairCandidates || [])]
    .filter((item) => item?.blockerProgress || buildBlockerProgressPlan(item))
    .sort((left, right) => String(left?.threadId).localeCompare(String(right?.threadId)))
    .map((item) => {
      const progress = item?.blockerProgress || buildBlockerProgressPlan(item);
      return {
        threadId: item?.threadId ?? null,
        reason: progress?.reason ?? null,
        exactBlocker: progress?.exactBlocker ?? null,
        taskDisposition: progress?.taskDisposition ?? "deferred",
        progressAttemptNow: progress?.progressAttemptNow ?? null,
        nextActionNow: progress?.nextActionNow ?? null,
        resumeTrigger: progress?.resumeTrigger ?? null,
        fallbackOrIndependentWork: progress?.fallbackOrIndependentWork ?? null,
        replayAllowed: progress?.replayAllowed === true,
      };
    });
  for (const candidate of blockerProgressCandidates) {
    const next = { ...projection, blockerProgressCandidates: [...projection.blockerProgressCandidates, candidate] };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) {
      projection.blockerProgressCandidatesTruncated = true;
      break;
    }
    projection.blockerProgressCandidates.push(candidate);
  }
  const threadRecords = [...(summary?.threadInspection?.records || [])]
    .sort((left, right) => String(left?.threadId).localeCompare(String(right?.threadId)))
    .map((record) => ({
      threadId: record?.threadId ?? null,
      owner: record?.owner ?? null,
      status: record?.status ?? null,
      revision: record?.revision ?? null,
      updatedAt: record?.updatedAt ?? null,
      generation: record?.generation ?? null,
      actionable: record?.actionable === true,
      stalled: record?.stalled === true,
      changed: record?.changed === true,
      deepReadEligible: record?.deepReadEligible === true,
      deepReadReasons: [...(record?.deepReadReasons || [])],
      lightweightStatus: record?.lightweight?.status ?? "not_run",
      deepReadStatus: record?.deepRead?.status ?? "not_run",
    }));
  for (const record of threadRecords) {
    const next = { ...projection, threadInspection: { ...projection.threadInspection, records: [...projection.threadInspection.records, record] } };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) {
      projection.threadInspection.truncated = true;
      break;
    }
    projection.threadInspection.records.push(record);
  }
  const softAnomalies = [...(summary?.softAnomalies || summary?.softAnomalyFindings || [])]
    .sort((left, right) => String(left?.threadId).localeCompare(String(right?.threadId))
      || String(left?.type ?? left?.category).localeCompare(String(right?.type ?? right?.category)))
    .map((anomaly) => ({
      threadId: anomaly?.threadId ?? null,
      type: anomaly?.type ?? anomaly?.category ?? null,
      severity: anomaly?.severity ?? null,
      confidence: anomaly?.confidence ?? null,
      confirmationCount: Number(anomaly?.confirmationCount || anomaly?.confirmation?.count || 0),
      confirmed: anomaly?.confirmed === true || anomaly?.confirmation?.confirmed === true,
      deepReadEligible: anomaly?.deepReadEligible === true,
      actionability: SOFT_ANOMALY_ACTIONABILITY,
      automaticRepairCandidate: false,
      disposition: "report_only",
      missingDimensions: [...(anomaly?.missingDimensions || [])],
      evidence: (Array.isArray(anomaly?.evidence) ? anomaly.evidence : [])
        .slice(0, MAX_SOFT_ANOMALY_EVIDENCE)
        .map((entry) => ({
          locator: entry?.locator ?? null,
          line: entry?.line ?? null,
        })),
    }));
  for (const anomaly of softAnomalies) {
    const next = { ...projection, softAnomalies: [...projection.softAnomalies, anomaly] };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) {
      projection.softAnomaliesTruncated = true;
      break;
    }
    projection.softAnomalies.push(anomaly);
  }
  return projection;
}

function updateLearningLedger(file, summary) {
  const ledger = loadLearningLedger(file);
  const fingerprint = summary.auditFingerprint || buildAuditFingerprint(summary);
  const previousFingerprint = ledger.lastFingerprint;
  const changedSincePreviousRun = previousFingerprint === null || previousFingerprint !== fingerprint;
  ledger.noChangeRuns = changedSincePreviousRun ? 0 : Number(ledger.noChangeRuns || 0) + 1;
  ledger.lastFingerprint = fingerprint;
  if (changedSincePreviousRun) ledger.lastChangedAt = summary.auditedAt;
  // Older ledgers counted every unchanged session on every tick. Start a
  // fresh event-indexed baseline rather than presenting those inflated counts
  // as recurrence evidence.
  if (ledger.events.length === 0 && Object.keys(ledger.observations).length > 0) ledger.observations = {};
  const observations = ledger.observations;
  const seenEvents = new Set(ledger.events);
  for (const item of summary.liveCandidates || (summary.sessions || []).filter((candidate) => isLiveCandidate(candidate))) {
    const markers = new Set([...(item.companionMarkers || []), ...(item.userHelpMarkers || [])]);
    if (item.companionIssue === true && markers.size === 0) markers.add("companion_local_review");
    const plan = item.repairPlan || buildRepairPlan(item, { artifactComparison: summary.companionArtifacts });
    let newEventObserved = false;
    for (const marker of markers) {
      const eventKey = `${item.threadId || "unknown"}:${item.mtime || "unknown"}:${String(marker).toLowerCase()}`;
      if (seenEvents.has(eventKey)) continue;
      seenEvents.add(eventKey);
      ledger.events.push(eventKey);
      newEventObserved = true;
      const key = `marker:${String(marker).toLowerCase()}`;
      const previous = observations[key] || { count: 0, firstSeen: summary.auditedAt, lastSeen: summary.auditedAt };
      observations[key] = {
        count: Number(previous.count || 0) + 1,
        firstSeen: previous.firstSeen || summary.auditedAt,
        lastSeen: summary.auditedAt,
      };
      upsertLearningOutcome(ledger, buildObservedLearningOutcome({ item, marker, eventKey, summary, plan }));
    }
    if (!newEventObserved) continue;
    if (plan?.playbookId) {
      const key = `playbook:${plan.playbookId}`;
      const previous = observations[key] || { count: 0, firstSeen: summary.auditedAt, lastSeen: summary.auditedAt };
      observations[key] = {
        count: Number(previous.count || 0) + 1,
        firstSeen: previous.firstSeen || summary.auditedAt,
        lastSeen: summary.auditedAt,
      };
    }
  }
  const currentSoftAnomalyKeys = [];
  for (const finding of summary.softAnomalyFindings || summary.softAnomalies || []) {
    const key = softAnomalyKey(finding);
    if (!key) continue;
    currentSoftAnomalyKeys.push(key);
    const previous = ledger.softConfirmations[key] || {};
    const confirmation = finding.confirmation || {};
    ledger.softConfirmations[key] = {
      count: Number(finding.confirmationCount || confirmation.count || previous.count || 1),
      firstSeen: previous.firstSeen || summary.auditedAt,
      lastSeen: summary.auditedAt,
      owner: finding.owner ?? previous.owner ?? null,
      generation: finding.generation ?? previous.generation ?? null,
      confirmed: finding.confirmed === true || confirmation.confirmed === true,
    };
  }
  ledger.lastSoftAnomalyKeys = [...new Set(currentSoftAnomalyKeys)].slice(0, MAX_SOFT_ANOMALY_FINDINGS);
  for (const record of summary.threadInspection?.records || []) {
    const threadId = record?.threadId ?? record?.thread_id;
    if (!threadId) continue;
    ledger.threadInspections[String(threadId)] = {
      threadId: String(threadId),
      owner: record.owner ?? null,
      status: record.status ?? null,
      revision: record.revision ?? null,
      updatedAt: record.updatedAt ?? null,
      generation: record.generation ?? null,
      actionable: record.actionable === true,
      stalled: record.stalled === true,
      softAnomalyTypes: [...(record.softAnomalyTypes || [])].sort(),
      softAnomalyConfirmed: record.softAnomalyConfirmed === true,
      lastSeenAt: summary.auditedAt,
    };
  }
  ledger.events = ledger.events.slice(-5000);
  ledger.updatedAt = summary.auditedAt;
  ledger.runs.push({
    auditedAt: summary.auditedAt,
    fingerprint,
    changedSincePreviousRun,
    recentUserSessionCount: summary.recentUserSessionCount,
    companionIssueCount: summary.companionIssueCount,
    userHelpRequiredCount: summary.userHelpRequiredCount,
    blockedCount: summary.blockedCount,
    exactBlocker: summary.exactBlocker,
    softAnomalyKeys: ledger.lastSoftAnomalyKeys,
    threadInspectionCount: Number(summary.threadInspection?.eligibleTaskCount || 0),
  });
  ledger.runs = ledger.runs.slice(-24);
  refreshPlaybookProposals(ledger, ledger.updatedAt);
  ledger.learningOutcomes = ledger.learningOutcomes.slice(-MAX_LEARNING_OUTCOMES);
  if (file) writePrivateJson(file, ledger);
  return ledger;
}

function sessionRecord(file, { cutoffMs = 0 } = {}) {
  const meta = readFirstLine(file);
  const payload = meta?.payload;
  // Registered automation/controller transcripts contain their own prompt,
  // runbook, and tool schema.  They are not user work and must never become
  // Companion repair candidates merely because that prose mentions timeout,
  // reconciliation, CAPTCHA, or other policy terms.
  if (payload?.thread_source === "automation") return null;
  const isUserThread = payload?.thread_source === "user"
    || (payload?.source === "vscode" && !payload?.parent_thread_id && !payload?.agent_role && !payload?.agent_nickname);
  if (meta?.type !== "session_meta" || !isUserThread) return null;
  const stat = fs.statSync(file);
  const startedAtMs = Date.parse(payload?.timestamp || meta?.timestamp || "");
  const activityMs = Math.max(stat.mtimeMs, Number.isFinite(startedAtMs) ? startedAtMs : 0);
  if (cutoffMs > 0 && activityMs < cutoffMs) return null;
  const tail = tailText(file);
  const classification = classifyThreadTail(tail);
  return {
    threadId: payload.session_id || payload.id || null,
    sessionId: payload.session_id || null,
    owner: "user",
    cwd: payload.cwd || null,
    startedAt: payload.timestamp || null,
    file,
    mtime: new Date(stat.mtimeMs).toISOString(),
    ...classification,
    resumeAssessment: buildResumeAssessment(classification),
  };
}

export function collectRecentUserSessions({ sessionRoot = DEFAULT_SESSION_ROOT, limit = MAX_SESSIONS, recentDays = DEFAULT_RECENT_DAYS } = {}) {
  if (!fs.existsSync(sessionRoot)) return [];
  const normalizedRecentDays = Number.isFinite(Number(recentDays)) ? Number(recentDays) : DEFAULT_RECENT_DAYS;
  const cutoffMs = normalizedRecentDays > 0 ? Date.now() - normalizedRecentDays * 24 * 60 * 60 * 1000 : 0;
  return walkJsonl(sessionRoot)
    .map((file) => {
      try { return sessionRecord(file, { cutoffMs }); } catch { return null; }
    })
    .filter((item) => item?.threadId)
    .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
    .slice(0, limit);
}

function buildLocalThreadInspection(sessions = [], {
  previousInspections = null,
  previousInspectionRunAt = null,
  now = Date.now(),
  stalledTaskThresholdMs = DEFAULT_STALLED_TASK_THRESHOLD_MS,
} = {}) {
  const tasks = (Array.isArray(sessions) ? sessions : []).map((session) => ({
    threadId: session.threadId,
    sessionId: session.sessionId,
    owner: "user",
    userOwned: true,
    status: session.completed ? "completed" : session.interrupted ? "interrupted" : session.blocked ? "blocked" : "active",
    revision: session.mtime,
    updatedAt: session.mtime,
    generation: session.generation ?? null,
    actionable: isLiveCandidate(session) && (session.companionIssue === true || session.userHelpRequired === true || session.blocked === true),
    stalled: isLiveCandidate(session) && session.companionIssue === true
      && taskProgressTimestamp(session) !== null
      && now - taskProgressTimestamp(session) >= Math.max(1_000, Number(stalledTaskThresholdMs) || DEFAULT_STALLED_TASK_THRESHOLD_MS),
    softAnomalyTypes: session.softAnomalies || [],
    softAnomalyConfirmed: (session.softAnomalies || []).some((anomaly) => anomaly?.confirmed === true),
  }));
  const plan = buildThreadInspectionPlan({
    tasks,
    previousInspections,
    previousInspectionRunAt,
    now,
    stalledTaskThresholdMs,
    source: "local_session_index",
  });
  return {
    ...plan,
    lightweightReadCount: 0,
    deepReadAttemptedCount: 0,
    deepReadCount: 0,
    records: plan.records.map((record) => ({
      ...record,
      lightweight: { status: "metadata_only", exactBlocker: "codex_app_thread_readback_not_supplied" },
      deepRead: record.deepReadEligible
        ? { status: "not_run", exactBlocker: "codex_app_thread_readback_not_supplied" }
        : { status: "not_run", exactBlocker: "not_a_deep_read_candidate" },
    })),
    externalActionExecuted: false,
  };
}

function threadInspectionBlockerCandidates(inspection) {
  const records = Array.isArray(inspection?.records) ? inspection.records : [];
  const officialSource = String(inspection?.source || "").startsWith("codex_app");
  return records
    .filter((record) => {
      if (String(record?.owner || "") !== "user") return false;
      if (record?.lightweight?.status === "observed") return true;
      // The official Root owns the list/read boundary. If one listed task
      // cannot be read, keep that task visible as a bounded blocker even when
      // other tasks were read successfully; otherwise a partial failure
      // becomes a silent no-op and the task can remain stalled indefinitely.
      return officialSource && record?.lightweight?.status !== "metadata_only";
    })
    .map((record) => {
      const taskStatusValue = String(record?.status || "unknown");
      const goalStatusValue = String(record?.goalStatus || "unknown");
      const planStatusValue = String(record?.planStatus || "unknown");
      const lightweightStatus = String(record?.lightweight?.status || "not_run");
      const deepStatus = String(record?.deepRead?.status || "not_run");
      const lightweightReadbackFailed = lightweightStatus !== "observed" && lightweightStatus !== "metadata_only";
      const deepReadbackFailed = record?.deepReadEligible === true && deepStatus !== "observed";
      const readbackUnavailable = officialSource && (lightweightReadbackFailed || deepReadbackFailed);
      const completed = ["completed", "complete", "done", "closed", "archived"].includes(taskStatusValue)
        || goalStatusValue === "complete";
      const interrupted = taskStatusValue === "interrupted";
      const blocked = !completed && !interrupted
        && (readbackUnavailable
          || ["blocked", "failed"].includes(taskStatusValue)
          || goalStatusValue === "blocked"
          || planStatusValue === "blocked");
      const exactBlocker = record?.exactBlocker
        ?? (lightweightReadbackFailed ? record?.lightweight?.exactBlocker : null)
        ?? (deepReadbackFailed ? record?.deepRead?.exactBlocker : null)
        ?? (readbackUnavailable ? "thread_readback_unavailable" : null);
      const companionMarkers = exactBlocker ? [String(exactBlocker)] : [];
      const item = {
        threadId: record?.threadId ?? null,
        hostId: record?.hostId ?? null,
        owner: "user",
        userOwned: true,
        status: taskStatusValue,
        latestTurnStatus: record?.latestTurnStatus ?? null,
        goalStatus: goalStatusValue,
        planStatus: planStatusValue,
        exactBlocker,
        revision: record?.revision ?? null,
        updatedAt: record?.updatedAt ?? null,
        generation: record?.generation ?? null,
        lightweightStatus,
        deepReadStatus: deepStatus,
        actionable: record?.actionable ?? null,
        stalled: record?.stalled ?? null,
        changed: record?.changed ?? null,
        companionMarkers,
        companionIssue: companionMarkers.length > 0,
        blocked,
        completed,
        interrupted,
        stateScope: completed ? "history" : interrupted ? "paused" : "live_candidate",
      };
      const blockerProgress = buildBlockerProgressPlan(item);
      return blockerProgress ? { ...item, blockerProgress } : null;
    })
    .filter(Boolean);
}

function fileFingerprint(file) {
  try {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(file));
    return { exists: true, sha256: hash.digest("hex"), bytes: fs.statSync(file).size };
  } catch {
    return { exists: false, sha256: null, bytes: 0 };
  }
}

function projectFingerprint(root) {
  const packagePath = path.join(root, "package.json");
  const packageJson = readJson(packagePath);
  return {
    root,
    packageVersion: typeof packageJson?.version === "string" ? packageJson.version : null,
    package: fileFingerprint(packagePath),
  };
}

function companionArtifactFingerprint(root) {
  return Object.fromEntries(COMPANION_ARTIFACTS.map((relativePath) => [
    relativePath,
    fileFingerprint(path.join(root, relativePath)),
  ]));
}

function compareCompanionArtifacts(source, installed) {
  const mismatches = COMPANION_ARTIFACTS.filter((relativePath) => {
    const left = source?.[relativePath];
    const right = installed?.[relativePath];
    return left?.exists !== right?.exists || left?.sha256 !== right?.sha256;
  });
  return {
    match: mismatches.length === 0,
    mismatches,
    exactBlocker: mismatches.length > 0 ? "companion_installed_artifact_drift" : null,
  };
}

function softAnomalySeverityRank(value) {
  return { low: 1, medium: 2, high: 3 }[String(value || "").toLowerCase()] || 0;
}

function softAnomalyConfidenceRank(value) {
  return { low: 1, medium: 2, high: 3 }[String(value || "").toLowerCase()] || 0;
}

export function collectSoftAnomalyFindings(sessions = []) {
  const findings = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const threadId = session?.threadId ?? session?.thread_id ?? null;
    if (!threadId) continue;
    for (const anomaly of Array.isArray(session?.softAnomalies) ? session.softAnomalies : []) {
      const type = anomaly?.type ?? anomaly?.category ?? null;
      if (!type) continue;
      const key = `${threadId}:${type}`;
      const evidence = (Array.isArray(anomaly.evidence) ? anomaly.evidence : [])
        .map((entry) => ({
          ...entry,
          locator: `thread:${threadId}:${entry?.locator || "tail"}`,
        }));
      const existing = findings.get(key);
      if (!existing) {
        findings.set(key, {
          ...anomaly,
          threadId,
          sessionId: session.sessionId ?? null,
          owner: session.owner ?? session.ownerKind ?? session.threadSource ?? session.thread_source ?? null,
          generation: session.generation ?? session.runtimeGeneration ?? session.runtime_generation ?? null,
          stateScope: session.stateScope ?? null,
          actionability: SOFT_ANOMALY_ACTIONABILITY,
          disposition: "report_only",
          automaticRepairCandidate: false,
          repairCandidate: false,
          evidence: evidence.slice(0, MAX_SOFT_ANOMALY_EVIDENCE),
        });
        continue;
      }
      const seenEvidence = new Set(existing.evidence.map((entry) => entry.locator));
      for (const entry of evidence) {
        if (seenEvidence.has(entry.locator) || existing.evidence.length >= MAX_SOFT_ANOMALY_EVIDENCE) continue;
        seenEvidence.add(entry.locator);
        existing.evidence.push(entry);
      }
      if (softAnomalySeverityRank(anomaly.severity) > softAnomalySeverityRank(existing.severity)) existing.severity = anomaly.severity;
      if (softAnomalyConfidenceRank(anomaly.confidence) > softAnomalyConfidenceRank(existing.confidence)) existing.confidence = anomaly.confidence;
      existing.missingDimensions = [...new Set([
        ...(existing.missingDimensions || []),
        ...(anomaly.missingDimensions || []),
      ])];
    }
  }
  return [...findings.values()]
    .sort((left, right) => String(left.threadId).localeCompare(String(right.threadId))
      || String(left.type).localeCompare(String(right.type)))
    .slice(0, MAX_SOFT_ANOMALY_FINDINGS);
}

function softAnomalyKey(finding) {
  const threadId = finding?.threadId ?? finding?.thread_id;
  const type = finding?.type ?? finding?.category;
  return threadId && type ? `${threadId}:${type}` : null;
}

/**
 * Add a durable, conservative confirmation state to soft findings.  A soft
 * signal never becomes a repair permission: after two adjacent observations
 * with the same task, explicit user owner, and known unchanged generation it
 * only becomes eligible for a deeper read.  Missing generation evidence,
 * owner changes, or an intervening run reset the counter.
 */
export function confirmSoftAnomalyFindings(findings = [], ledger = {}, {
  generation = null,
  owner = "user",
  now = null,
} = {}) {
  const previousRun = Array.isArray(ledger?.runs) ? ledger.runs[ledger.runs.length - 1] : null;
  const previousKeys = new Set(Array.isArray(previousRun?.softAnomalyKeys)
    ? previousRun.softAnomalyKeys
    : Array.isArray(ledger?.lastSoftAnomalyKeys) ? ledger.lastSoftAnomalyKeys : []);
  const previousConfirmations = ledger?.softConfirmations && typeof ledger.softConfirmations === "object"
    ? ledger.softConfirmations
    : {};
  return (Array.isArray(findings) ? findings : []).map((finding) => {
    const key = softAnomalyKey(finding);
    const findingOwner = finding?.owner ?? owner ?? null;
    const findingGeneration = finding?.generation ?? generation ?? null;
    const previous = key ? previousConfirmations[key] : null;
    const stable = Boolean(key
      && previousKeys.has(key)
      && previous
      && findingOwner
      && findingGeneration
      && String(previous.owner ?? "") === String(findingOwner)
      && String(previous.generation ?? "") === String(findingGeneration));
    const confirmationCount = stable ? Number(previous.count || 1) + 1 : 1;
    const confirmed = stable && confirmationCount >= SOFT_ANOMALY_CONFIRMATION_THRESHOLD;
    const confirmationReason = confirmed
      ? "same_task_owner_generation_consecutive_evidence"
      : !findingGeneration
        ? "generation_not_authoritatively_known"
        : !stable && previousKeys.has(key)
          ? "owner_or_generation_changed_or_evidence_not_consecutive"
          : "first_observation_report_only";
    return {
      ...finding,
      owner: findingOwner,
      generation: findingGeneration,
      confirmationCount,
      confirmed,
      deepReadEligible: confirmed,
      escalationAllowed: false,
      confirmation: {
        required: true,
        threshold: SOFT_ANOMALY_CONFIRMATION_THRESHOLD,
        count: confirmationCount,
        confirmed,
        reason: confirmationReason,
        observedAt: now ?? null,
      },
      actionability: SOFT_ANOMALY_ACTIONABILITY,
      disposition: "report_only",
      automaticRepairCandidate: false,
      repairCandidate: false,
    };
  });
}

function applySoftAnomalyConfirmations(summary, ledger) {
  const findings = confirmSoftAnomalyFindings(
    summary?.softAnomalyFindings || summary?.softAnomalies || [],
    ledger,
    {
      generation: summary?.liveCompanion?.generation ?? null,
      owner: "user",
      now: summary?.auditedAt ?? null,
    },
  );
  const confirmedByThread = new Set(findings.filter((finding) => finding.confirmed === true).map((finding) => String(finding.threadId)));
  const threadRecords = Array.isArray(summary?.threadInspection?.records)
    ? summary.threadInspection.records.map((record) => {
        if (!confirmedByThread.has(String(record?.threadId))) return record;
        return {
          ...record,
          softAnomalyConfirmed: true,
          deepReadEligible: true,
          deepReadReasons: [...new Set([...(record.deepReadReasons || []), "soft_anomaly_confirmed"])],
        };
      })
    : [];
  const deepReadCandidates = threadRecords.filter((record) => record.deepReadEligible === true);
  return {
    ...summary,
    softAnomalies: findings,
    softAnomalyFindings: findings,
    softAnomalyConfirmationCount: findings.filter((finding) => finding.confirmed === true).length,
    softAnomalyDeepReadCandidateCount: findings.filter((finding) => finding.deepReadEligible === true).length,
    threadInspection: summary?.threadInspection
      ? {
          ...summary.threadInspection,
          records: threadRecords,
          deepReadCandidateCount: deepReadCandidates.length,
          deepReadCandidates: deepReadCandidates.slice(0, Number(summary.threadInspection.deepReadLimit || MAX_DEEP_THREAD_READS)).map((record) => ({
            threadId: record.threadId,
            hostId: record.hostId ?? null,
            reasons: record.deepReadReasons,
          })),
          deepReadTruncated: deepReadCandidates.length > Number(summary.threadInspection.deepReadLimit || MAX_DEEP_THREAD_READS),
        }
      : summary?.threadInspection,
  };
}

function threadIdentityVariants(threadId) {
  const raw = String(threadId ?? "").trim();
  if (!raw) return [];
  const compact = raw.replaceAll("-", "").toLowerCase();
  return [...new Set([
    raw,
    raw.toLowerCase(),
    // The root projection uses a bounded, non-reversible-looking alias. The
    // current App task IDs are UUIDs, so the first 24 compact hex characters
    // are enough to join that alias back to the already-read local index.
    `t-${compact.slice(0, 24)}`,
    createThreadAlias(raw),
  ])];
}

function officialThreadReadbackMap({ recentTasks = null, threadInspection = null } = {}) {
  const map = new Map();
  const add = (key, value, source) => {
    if (!key || !value || typeof value !== "object") return;
    for (const variant of threadIdentityVariants(key)) {
      // Prefer the explicit App inspection record over the bridged task list,
      // because it contains the post-readback Goal/Plan/turn fields.
      if (!map.has(variant) || source === "inspection") map.set(variant, value);
    }
  };
  for (const task of Array.isArray(recentTasks) ? recentTasks : []) {
    const id = taskThreadId(task);
    if (id) add(id, task, "task_list");
  }
  for (const record of Array.isArray(threadInspection?.records) ? threadInspection.records : []) {
    const id = record?.threadId ?? record?.thread_id;
    if (id) add(id, record, "inspection");
  }
  return map;
}

function currentOfficialThreadReadback(session, map) {
  if (!session || !(map instanceof Map)) return null;
  for (const variant of threadIdentityVariants(session.threadId ?? session.thread_id)) {
    const record = map.get(variant);
    if (record) return record;
  }
  return null;
}

const OFFICIAL_MESSAGE_BOUNDARY_TASK_STATUSES = new Set(["active", "idle", "notloaded", "not_loaded"]);
const OFFICIAL_RESUMABLE_TURN_STATUSES = new Set(["interrupted"]);
const RESUME_BLOCKING_REASONS = new Set([
  "unknown_effect",
  "send_result_unknown",
  "foreign_owner",
  "target_mismatch",
  "active_reconciliation",
  "human_auth_required",
  "external_service_limit",
  "provider_inactive",
  "handoff_gate_active",
]);

/**
 * A fresh official App readback can turn an interrupted checkpoint into a
 * narrow existing-Goal continuation candidate.  This is deliberately
 * separate from local transcript classification: an old tail may contain a
 * paused or recoverable Companion signal, but it cannot override a current
 * foreign-owner, effect, auth, reconciliation, or explicit Goal/Plan gate.
 */
function officialInterruptedResumeProof(session, {
  status,
  latestTurnStatus,
  goalStatus,
  planStatus,
  exactBlocker,
  blocked,
  record,
} = {}) {
  const owner = String(
    record?.owner
      ?? (record?.userOwned === true ? "user" : record?.state?.owner ?? session?.owner ?? "unknown"),
  ).toLowerCase();
  if (owner !== "user") return false;
  if (!OFFICIAL_MESSAGE_BOUNDARY_TASK_STATUSES.has(status)) return false;
  if (!OFFICIAL_RESUMABLE_TURN_STATUSES.has(latestTurnStatus)) return false;
  // The local tail is historical. A fresh official interrupted-turn
  // readback is the stronger current-task signal and must be allowed to
  // reopen a stale local `completed` classification.
  if (session?.userHelpRequired === true) return false;
  if (goalStatus === "blocked" || planStatus === "blocked") return false;
  if (Boolean(exactBlocker)) return false;
  if (blocked !== true) return true;

  // Preserve the existing historical-capability recovery bridge, but do not
  // generalize it to unknown effects or ownership/reconciliation blockers.
  const localReason = String(session?.resumeAssessment?.reason || "");
  const localBlocker = classifyOperationalBlocker(session);
  const historicalRecoverable = [localReason, localBlocker]
    .some((reason) => ["capability_missing", "stale_owner_recoverable"].includes(reason));
  const localBlockerIsSafe = localBlocker === "capability_missing"
    || !RESUME_BLOCKING_REASONS.has(localBlocker);
  if (!historicalRecoverable) return false;
  if (RESUME_BLOCKING_REASONS.has(localReason)) return false;
  if (!localBlockerIsSafe) return false;
  return true;
}

function mergeOfficialThreadReadback(sessions, { recentTasks = null, threadInspection = null } = {}) {
  const officialSource = Array.isArray(recentTasks) || String(threadInspection?.source || "").startsWith("codex_app");
  if (!officialSource) return Array.isArray(sessions) ? sessions : [];
  const map = officialThreadReadbackMap({ recentTasks, threadInspection });
  return (Array.isArray(sessions) ? sessions : []).map((session) => {
    const record = currentOfficialThreadReadback(session, map);
    if (!record) return session;

    const status = String(record.status ?? record.threadStatus ?? record.state?.taskStatus ?? "unknown").toLowerCase();
    const latestTurnStatus = String(record.latestTurnStatus ?? record.state?.latestTurnStatus ?? "unknown").toLowerCase();
    const goalStatus = String(record.goalStatus ?? record.state?.goalStatus ?? "unknown").toLowerCase();
    const planStatus = String(record.planStatus ?? record.state?.planStatus ?? "unknown").toLowerCase();
    const exactBlocker = record.exactBlocker ?? record.exact_blocker ?? record.state?.exactBlocker ?? null;
    const lifecycleUnknown = status === "notloaded" || status === "not_loaded" || status === "unknown" || !status;
    const currentTaskReadback = true;
    const blocked = session.blocked === true
      || goalStatus === "blocked"
      || planStatus === "blocked"
      || Boolean(exactBlocker)
      || ["unknown_effect", "foreign_owner", "active_reconciliation", "provider_inactive", "handoff_gate_active", "human_auth_required", "capability_missing"].includes(String(session.resumeAssessment?.reason || ""));
    const interrupted = latestTurnStatus === "interrupted" || session.interrupted === true;
    const freshResumeAssessment = buildResumeAssessment({
      ...session,
      interrupted: false,
      blocked,
      stateScope: "live_candidate",
    });
    const resumeReason = String(freshResumeAssessment.reason || "");
    const officialResumeProof = officialInterruptedResumeProof(session, {
      status,
      latestTurnStatus,
      goalStatus,
      planStatus,
      exactBlocker,
      blocked,
      record,
    });
    const safeInterruptedResume = officialResumeProof && resumeReason === "ready";
    // An interrupted turn is normally a paused checkpoint. A fresh official
    // readback may prove the narrower standing-controller case: user-owned,
    // unblocked, and ready to continue the existing Goal. Keep current
    // unknown-effect, auth, ownership, provider, and reconciliation gates
    // closed; only the bounded historical capability bridge may pass.
    const resumeEligibleAfterProof = latestTurnStatus === "interrupted"
      && officialResumeProof;
    const currentRecoverySignal = session.completed !== true
      || session.blocked === true
      || session.companionIssue === true
      || session.userHelpRequired === true
      || interrupted
      || latestTurnStatus === "interrupted"
      || goalStatus === "blocked"
      || planStatus === "blocked"
      || Boolean(exactBlocker)
      || record.actionable === true
      || record.stalled === true
      || ["unknown_effect", "foreign_owner", "active_reconciliation", "provider_inactive", "handoff_gate_active", "human_auth_required", "capability_missing"].includes(resumeReason);
    // A current App inventory entry is not, by itself, evidence that an old
    // completed session must be reopened. Reopen only when the fresh task
    // readback carries an actionable/stalled/blocker/interrupted signal, or
    // the local record already says that recovery is required.
    const completed = session.completed === true
      && !currentRecoverySignal;

    return {
      ...session,
      hostId: record.hostId ?? record.host_id ?? session.hostId ?? session.host_id ?? null,
      currentTaskReadback,
      officialTaskStatus: status,
      officialLatestTurnStatus: latestTurnStatus,
      officialGoalStatus: goalStatus,
      officialPlanStatus: planStatus,
      officialExactBlocker: exactBlocker,
      officialResumeProof,
      officialReadbackState: lifecycleUnknown ? "task_present_state_not_loaded" : "task_state_observed",
      // A local session log is historical evidence. Once the same task is
      // present in the fresh App inventory, it must not keep an old
      // `completed=true` classification that hides a still-stalled Goal.
      completed,
      blocked,
      interrupted,
      resumeEligibleAfterProof,
      resumeAssessment: safeInterruptedResume ? freshResumeAssessment : session.resumeAssessment,
      stateScope: completed ? "history" : interrupted && !resumeEligibleAfterProof ? "paused" : "live_candidate",
    };
  });
}

export function buildAuditSummary({
  now = new Date().toISOString(),
  sessionRoot = DEFAULT_SESSION_ROOT,
  companionSource = DEFAULT_COMPANION_SOURCE,
  companionInstall = DEFAULT_COMPANION_INSTALL,
  recentDays = DEFAULT_RECENT_DAYS,
  artifactDir = process.env.AUTOMATION_KERNEL_ARTIFACT_DIR || path.join(process.cwd(), "work", "hourly-companion-audit"),
  learningLedgerPath = process.env.AOS_COMPANION_LEARNING_LEDGER || DEFAULT_LEARNING_LEDGER,
  liveStatus = null,
  recentTasks = null,
  threadInspection = null,
  threadReadbackProjection = null,
  proactiveRepairCandidates: proactiveRepairInputs = [],
  previousThreadInspections = null,
  previousInspectionRunAt = null,
} = {}) {
  // The scheduler's own Codex session contains the audit prompt and tool
  // output.  It is not a user task and must not count as a live Companion
  // incident or an OTP/CAPTCHA blocker.
  const currentThreadId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null;
  const collectedSessions = collectRecentUserSessions({ sessionRoot, recentDays });
  const indexedSessions = collectedSessions.filter((item) => !currentThreadId || item.threadId !== currentThreadId);
  const sourceArtifacts = companionArtifactFingerprint(companionSource);
  const installedArtifacts = companionArtifactFingerprint(companionInstall);
  const artifactComparison = compareCompanionArtifacts(sourceArtifacts, installedArtifacts);
  const liveCompanion = normalizeLiveCompanionStatus(liveStatus);
  const readbackProjection = threadReadbackProjection
    ? {
        schema: threadReadbackProjection.schema,
        version: threadReadbackProjection.version,
        automationId: threadReadbackProjection.automationId,
        rootRunId: threadReadbackProjection.rootRunId,
        childAuditId: threadReadbackProjection.childAuditId,
        producedAt: threadReadbackProjection.producedAt,
        projectionDigest: threadReadbackProjection.projectionDigest,
        counts: threadReadbackProjection.counts,
      }
    : null;
  const auditNowMs = Date.parse(now);
  const resolvedThreadInspection = threadInspection
    ?? (Array.isArray(recentTasks)
      ? buildThreadInspectionPlan({
          tasks: recentTasks,
          previousInspections: previousThreadInspections,
          previousInspectionRunAt,
          now: Number.isFinite(auditNowMs) ? auditNowMs : Date.now(),
          source: "codex_app_thread_list",
        })
      : buildLocalThreadInspection(indexedSessions, {
          previousInspections: previousThreadInspections,
          previousInspectionRunAt,
        now: Number.isFinite(auditNowMs) ? auditNowMs : Date.now(),
      }));
  const sessions = mergeOfficialThreadReadback(indexedSessions, {
    recentTasks,
    threadInspection: resolvedThreadInspection,
  });
  const liveCandidates = sessions.filter((item) => isLiveCandidate(item));
  const historicalSessions = sessions.filter((item) => item.stateScope === "history" || item.completed === true);
  const pausedSessions = sessions.filter((item) => item.stateScope === "paused" || (item.interrupted === true && item.resumeEligibleAfterProof !== true));
  const companionCandidates = liveCandidates.filter((item) => item.companionIssue && !item.userHelpRequired);
  // A current official task with a historical blocked Goal is a recovery
  // candidate even when the old transcript did not contain a Companion
  // marker. This is what lets provider limits and stale Goal checkpoints be
  // re-read and resumed instead of being silently treated as completed.
  const blockedCurrentTaskCandidates = liveCandidates.filter((item) => item.currentTaskReadback === true
    && item.blocked === true
    && !item.userHelpRequired);
  const interruptedReadyCandidates = liveCandidates.filter((item) => item.currentTaskReadback === true
    && item.interrupted === true
    && item.resumeEligibleAfterProof === true
    && item.blocked !== true
    && item.userHelpRequired !== true
    && String(item.resumeAssessment?.reason || "") === "ready");
  const officialAppOnlyContinuationCandidateItems = officialAppOnlyContinuationCandidates(liveCandidates);
  const proactiveRepairCandidates = (Array.isArray(proactiveRepairInputs) ? proactiveRepairInputs : [])
    .map(normalizeProactiveRepairCandidate)
    .filter(Boolean)
    .slice(0, MAX_PROACTIVE_REPAIR_CANDIDATES);
  const repairCandidateItems = [];
  const seenRepairThreadIds = new Set();
  for (const candidate of [...companionCandidates, ...blockedCurrentTaskCandidates, ...interruptedReadyCandidates, ...proactiveRepairCandidates]) {
    const threadId = String(candidate.threadId ?? candidate.thread_id ?? "");
    if (!threadId || seenRepairThreadIds.has(threadId)) continue;
    seenRepairThreadIds.add(threadId);
    repairCandidateItems.push(candidate);
  }
  const userHelp = liveCandidates.filter((item) => item.userHelpRequired);
  const softAnomalyFindings = collectSoftAnomalyFindings(sessions);
  const threadInspectionBlocker = threadReadbackExactBlocker(resolvedThreadInspection);
  const threadReadbackBlockerCandidates = threadInspectionBlockerCandidates(resolvedThreadInspection);
  for (const candidate of threadReadbackBlockerCandidates) {
    const threadId = String(candidate.threadId || "");
    if (!threadId || seenRepairThreadIds.has(threadId)) continue;
    seenRepairThreadIds.add(threadId);
    repairCandidateItems.push(candidate);
  }
  const liveCompanionIssue = liveCompanion.available === false
    ? liveCompanion.exactBlocker !== null && liveCompanion.exactBlocker !== "companion_status_not_supplied"
    : liveCompanion.exactBlocker !== null;
  // The official App readback candidates are appended above, so calculate
  // their plans only after that append. The previous order silently dropped
  // deep-read blockers from `repairPlans`, leaving a real task in a passive
  // candidate state even when the current Companion generation had already
  // recovered the capability.
  const plannedRepairCandidateItems = repairCandidateItems.map((item) => {
    const enriched = enrichCapabilityBlocker(item, {
      companionSource,
      companionInstall,
      artifactComparison,
      liveCompanion,
    });
    const blockerProgress = enriched.blockerProgress || buildBlockerProgressPlan(enriched);
    return {
      ...enriched,
      blockerProgress,
      repairPlan: enriched.repairPlan || buildRepairPlan(enriched, { artifactComparison }),
    };
  });
  // Include both the fresh live projection and the enriched repair records.
  // The latter preserves a safe task-local blocker (for example
  // capability_missing) even when the shallow task list did not expose the
  // latest turn.  The official Root still must perform the post-audit fresh
  // same-task read before sending; this list is only the bounded relay queue.
  const taskOwnedContinuationCandidateItems = taskOwnedContinuationCandidates(
    liveCandidates,
    plannedRepairCandidateItems,
  );
  const sessionIds = new Set(sessions.map((item) => String(item.threadId ?? item.thread_id ?? "")));
  const extraReadbackItems = plannedRepairCandidateItems.filter((item) => !sessionIds.has(String(item.threadId ?? item.thread_id ?? "")));
  const plannedByThreadId = new Map(plannedRepairCandidateItems
    .map((item) => [String(item.threadId ?? item.thread_id ?? ""), item])
    .filter(([threadId]) => threadId));
  const repairPlans = [...sessions, ...proactiveRepairCandidates, ...extraReadbackItems].map((item) => {
    const planned = plannedByThreadId.get(String(item.threadId ?? item.thread_id ?? ""));
    const plan = planned?.repairPlan || buildRepairPlan(item, { artifactComparison });
    return {
      threadId: item.threadId,
      resumeAssessment: item.resumeAssessment || buildResumeAssessment(item),
      ...plan,
    };
  });
  const autoRepairPlans = repairPlans.filter((plan) => plan.automatic);
  const deferredPlans = repairPlans.filter((plan) => plan.disposition.endsWith("deferred") || plan.disposition === "companion_local_review");
  const blockerProgressCandidates = plannedRepairCandidateItems
    .map((item) => item.blockerProgress || buildBlockerProgressPlan(item))
    .filter(Boolean);
  const summary = {
    schema: "aos.hourly_companion_audit.v1",
    auditedAt: now,
    readOnly: true,
    externalActionExecuted: false,
    threadReadbackProjection: readbackProjection,
    sessionRoot,
    recentDays,
    excludedCurrentThreadId: currentThreadId,
    recentUserSessionCount: sessions.length,
    companionIssueCount: plannedRepairCandidateItems.length + (liveCompanionIssue ? 1 : 0),
    userHelpRequiredCount: userHelp.length,
    blockedCount: liveCandidates.filter((item) => item.blocked).length,
    softAnomalyCount: softAnomalyFindings.length,
    softAnomalySessionCount: new Set(softAnomalyFindings.map((item) => item.threadId)).size,
    liveCandidateSessionCount: liveCandidates.length,
    historicalSessionCount: historicalSessions.length,
    pausedSessionCount: pausedSessions.length,
    historicalCompanionIssueCount: historicalSessions.filter((item) => item.companionIssue && !item.userHelpRequired).length,
    liveCompanion,
    threadInspection: resolvedThreadInspection,
    threadReadbackBlockerCandidates: threadReadbackBlockerCandidates.map((item) => ({
      threadId: item.threadId,
      owner: item.owner,
      status: item.status,
      blocked: item.blocked === true,
      goalStatus: item.goalStatus,
      planStatus: item.planStatus,
      exactBlocker: item.exactBlocker,
      lightweightStatus: item.lightweightStatus ?? null,
      deepReadStatus: item.deepReadStatus ?? null,
      blockerProgress: item.blockerProgress,
    })),
    proactiveRepairCandidates: proactiveRepairCandidates.map((item) => ({
      threadId: item.threadId,
      softAnomalyType: item.softAnomalyType ?? item.soft_anomaly_type ?? null,
      preventiveCheck: item.preventiveCheck === true || item.preventive_check === true,
      repairPlan: item.repairPlan,
    })),
    controller: {
      schema: "aos.companion_controller_plan.v1",
      mode: "bounded_self_repair",
      mutationPerformed: false,
      hourlyController: {
        schema: HOURLY_CONTROLLER_SCHEMA,
        entrypoint: "runSameRunCompanionRepairLoop",
        oneCyclePrimitive: "runBoundedHourlyController",
        stages: ["fresh_status", "generalize_root_cause", "bounded_repair", "focused_verification", "idle_reconciled_check", "signed_refresh", "fresh_generation_readback", "same_run_real_e2e", "repair_again_on_distinct_failure", "one_continuation_per_eligible_task", "readback"],
        maxRepairPerCycle: 1,
        maxRepairCyclesPerRun: DEFAULT_MAX_REPAIR_CYCLES,
        sameRunE2ERequiredAfterRepair: true,
        e2eFailureMustProvide: ["failureFingerprint", "generalizedCause"],
        maxContinuationPerTaskPerCycle: 1,
        callbackBoundary: "explicit_owner_scoped_callbacks_only",
        noCallbackBehavior: "audit_only_with_exact_blocker_and_resume_trigger",
        externalActionExecuted: false,
      },
      resumeController: {
        schema: "resume_current_task_receipt.v1",
        entrypoint: "resume_current_task",
        planEntrypoint: "node scripts/resume-current-task.mjs --input <fresh-readback.json>",
        implementationModule: "scripts/lib/resume-controller.mjs",
        planIsReadOnly: true,
        blockerPriority: [
          "unknown_effect",
          "foreign_owner",
          "active_reconciliation",
          "human_auth_required",
          "provider_inactive",
          "handoff_gate_active",
          "stale_owner_recoverable",
          "ready",
        ],
        sameThreadJobPolicy: "source_thread_only",
        jobApplicationLane: "direct_application",
        jobApplicationAuthority: "companion_local_owner_run",
        jobHandoffPolicy: "source_return_only",
        jobSourceResumeReceipt: "required_only_for_source_return",
        sideEffectOrder: ["cleanup_owner_only", "create_fresh_session", "send_thread_continuation"],
        oneContinuationPerIdempotencyKey: true,
        externalActionExecuted: false,
      },
      maxAutomaticActionsPerTask: 1,
      maxAutomaticActionsPerRun: 3,
      autoRepairCandidateCount: autoRepairPlans.length,
      proactiveRepairCandidateCount: proactiveRepairCandidates.length,
      blockerProgressCandidateCount: blockerProgressCandidates.length,
      taskOwnedContinuationCandidateCount: taskOwnedContinuationCandidateItems.length,
      deferredCandidateCount: deferredPlans.length,
      interactionPolicy: {
        schema: COMPANION_VISUAL_INTERACTION_POLICY_SCHEMA,
        operationMode: "visual_first_for_click_hover_scroll_controls",
        cursor: "in_page_blue_ai_cursor",
        cursorMovesOsPointer: false,
        inputMode: "preserve_semantic_native_input_path",
        requiredEvidence: [
          "fresh screenshot from the exact leased tab",
          "companion_inspect_visual_target or companion_inspect_visual_point",
          "single_use_visualProof",
          "one visual.* action",
          "same_target semantic plus screenshot readback",
        ],
        submitException: "visible submit remains one exact semantic page.click; never replay or switch methods after dispatch",
        dropdownException: "use signed inspect_dropdown visualProof plus one scoped selectOption; never guess coordinates",
        futureCapabilityGate: ["matching Companion adapter", "generated schema", "focused test", "read_only canary", "fresh installed generation readback"],
      },
      learningPolicy: {
        schema: COMPANION_LEARNING_PROTOCOL_SCHEMA,
        outcomeFields: ["signal", "diagnosis", "repairProposal", "verification", "result", "successRate"],
        minimumIndependentReproductionsForProposal: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
        independentEvidence: "distinct thread/mtime/marker event; unchanged heartbeat is not a new reproduction",
        promotion: "proposal_only_human_approval_and_verified_canary_required",
        automaticActivation: false,
        externalEffectProof: false,
      },
      schedulingPolicy: {
        cadence: "hourly",
        unchangedTick: "lightweight_thread_inspection_then_heartbeat",
        stalledTaskThresholdMs: DEFAULT_STALLED_TASK_THRESHOLD_MS,
        stalledTaskBehavior: "fresh_status_readback_then_bounded_progress; never_wait_only",
        lightweightInspection: "all recent authoritative user-owned tasks once per tick",
        deepInspectionRequires: ["active task within the bounded per-run cap", "audit fingerprint change", "new live runtime signal", "idle reconciliation boundary", "repeated soft anomaly confirmation"],
        maxNoChangeRunsBeforeFreshStatus: 24,
        noChangeMustNotCreateTask: true,
      },
      statusScope: {
        liveCandidate: "user session without terminal completion evidence; eligible for fresh status/readback and bounded repair planning",
        history: "user session with terminal completion evidence; retained for audit context but excluded from repair candidates, live fingerprint, and recurrence counts",
        paused: "user session whose turn was explicitly interrupted; retained as a checkpoint, with a narrow fresh user-owned ready readback bridge to existing-Goal continuation while blocker, auth, and ownership gates remain excluded",
        softAnomaly: "first observation is report-only; two consecutive same-owner/generation observations select deep read; only explicit fresh-root confirmation of a Companion-local cause may create a proactive repair candidate",
        historyOnlyIsNotProofOfCurrentBlocker: true,
      },
      implementationContract: {
        schema: "aos.companion_repair_contract.v1",
        discoveryIsNotTerminal: true,
        sourceRoot: companionSource,
        allowedSourceRoots: ["src/", "extension/", "scripts/generate-operation-schema.mjs"],
        captureCommand: "node scripts/aos-companion-repair-receipt.mjs capture",
        verificationCommand: "node scripts/aos-companion-repair-receipt.mjs verify",
        sameRunRepairLoop: {
          schema: SAME_RUN_REPAIR_LOOP_SCHEMA,
          entrypoint: "runSameRunCompanionRepairLoop",
          maxRepairCycles: DEFAULT_MAX_REPAIR_CYCLES,
          e2eRequiredAfterRepair: true,
          failureRetryRequiresDistinctFingerprint: true,
          failureRetryRequiresGeneralizedCause: true,
          e2eCommands: [
            "npm run canary:live",
            "npm run canary:real:readonly -- --url=<owned-http-url> --task-id=<owned-task-id>",
          ],
          e2ePolicy: "same_scheduler_turn; prefer installed Companion live canary; real-site path is read-only and requires an already-owned current-generation tab",
          noBusinessMutation: true,
          noNewThreadOrHandoff: true,
        },
        requiredChecks: [
          "npm run schema:check",
          "node --check for changed JavaScript modules",
          "nearest focused test",
          "representative normal-path canary",
          "npm run canary:parallel:readonly",
        ],
        runtimeReflection: "supported install/reload once at a fully idle and reconciled boundary, then same-run E2E before continuation",
        runtimeReflectionTool: "companion_refresh_extension",
        runtimeReflectionProof: ["result=reflected", "freshStatus.connected=true", "generation changed", "old sessions/leases discarded"],
        liveStatusRead: "readLiveCompanionStatus once per audit tick with autoStart=false; unavailable is recorded as an exact blocker",
        liveStatusFields: ["connected", "generation", "activeReconciliationCount", "activeTaskTabCount", "activeLeaseCount", "pendingCount", "queueCount"],
        operationEffectStates: ["no_dispatch", "known_no_effect", "known_effect", "unknown_effect"],
        resumePreparation: "signed task.prepare_resume read-only owner/target/effect projection before continuation",
        automaticSourceDriftSync: "LaunchAgent source/install hash comparison with deferred receipt retry at idle boundary",
        continuation: "one send-or-queue message per eligible user task (active or inactive) after fresh readback; record sent, queued, and deferred IDs with reasons",
        continuationAdapter: "scripts/lib/hourly-thread-dispatch.mjs",
        continuationReceipt: "aos.hourly_thread_dispatch.v1",
        continuationReadbackProof: "read_thread success alone is insufficient; require the matching continuation turn/message or explicit deliveryConfirmed=true; when official cross-task readback omits items, allow only an explicit same_task_new_turn_completed transport proof and keep Goal/Plan proof separate",
        continuationTransportProof: {
          schema: "aos.continuation_transport_delivery_proof.v1",
          kind: "same_task_new_turn_completed",
          requires: ["accepted official send result", "exact same target thread", "pre-send and post-send turn IDs differ", "post-send turn status completed", "no target/owner/effect ambiguity"],
          doesNotProve: ["continuation marker visibility", "Goal/Plan resumption", "business completion"],
          replayPolicy: "terminal for the exact ledger key; never resend an ambiguous effect",
        },
        continuationIdempotency: "sha256(threadId,targetIdentity,auditFingerprint,generation,nextAction); duplicate keys are suppressed",
        continuationLedger: "immutable intent/receipt ledger is global to the scheduler root so the same key is suppressed across hourly processes",
        continuationTargetIdentity: ["taskId", "sessionId", "leaseId", "generation", "pageInstanceId", "windowId", "frameId", "targetFingerprint"],
        activeTaskDelivery: "queue at the next message boundary; never interrupt an executing turn or browser operation",
        independentLane: "when a local Companion boundary defers one task, continue only ready tasks without Companion markers and exclude the affected thread IDs",
        noEffectUntilProof: true,
        blockerProgress: {
          schema: COMPANION_BLOCKER_PROGRESS_SCHEMA,
          supportedReasons: [...BLOCKER_PROGRESS_REASONS],
          foreignOwner: "readback_only; never adopt, close, or cleanup foreign resources",
          targetMismatch: "fresh semantic plus visual target identity, then owner-scoped rebind only on exact proof",
          capabilityMissing: "matching adapter/schema/focused-test/read-only-canary/installed-generation proof before activation",
          unknownEffect: "same-task signed reconciliation only; never replay",
          sendResultUnknown: "same-target readback or bounded wait once; never resend the same idempotency key",
          taskResume: "resume existing Goal/Plan only when callback returns explicit resumeAllowed=true with reason-specific proof",
        },
        verifierInput: "aos-hourly-companion-audit.verifier.v1.json",
        verifierInputMaxBytes: MAX_VERIFIER_PROJECTION_BYTES,
        verifierTruncationPolicy: "use_bounded_projection; reject_partial_handoff; never parse a truncated full transcript",
        parallelReadOnlyCanaryCommand: "npm run canary:parallel:readonly",
        parallelReadOnlyCanaryCwd: companionSource,
        parallelReadOnlyCanaryMode: "broker_fixture_no_browser_mutation",
        parallelReadOnlyCanarySafety: "temporary broker fixture only; no browser tabs, claims, page mutations, authentication, CAPTCHA, or provider effects",
        softAnomalyReporting: {
          schema: SOFT_ANOMALY_SCHEMA,
          source: "recent user thread tails",
          types: ["intent_drift", "recovered_near_miss", "unstable_behavior", "progress_verification_next_action_gap"],
          disposition: "report_only",
          actionability: SOFT_ANOMALY_ACTIONABILITY,
          automaticRepairCandidate: false,
          confirmationThreshold: SOFT_ANOMALY_CONFIRMATION_THRESHOLD,
          confirmedSignalMayOnly: "select_an_existing_task_for_deep_read; root must separately attest fresh Companion-local cause before a proactive repair candidate",
          maxFindings: MAX_SOFT_ANOMALY_FINDINGS,
          maxEvidencePerFinding: MAX_SOFT_ANOMALY_EVIDENCE,
        },
        proactiveRepair: {
          schema: COMPANION_PROACTIVE_REPAIR_SCHEMA,
          eligibleSoftAnomalyTypes: [...PROACTIVE_SOFT_ANOMALY_TYPES],
          requires: ["same-task consecutive confirmation", "fresh root-owned deep read", "explicit Companion-local cause", "known playbook"],
          automaticActions: "one bounded repair then focused verification, idle refresh if safe, fresh generation, same-run E2E",
          maxCandidates: MAX_PROACTIVE_REPAIR_CANDIDATES,
          automaticActivation: false,
          speculativeSourceChanges: false,
        },
      },
      artifactRefreshPlan: artifactComparison.exactBlocker
        ? buildRepairPlan({ companionIssue: true }, { artifactComparison })
        : null,
      playbooks: Object.values(REPAIR_PLAYBOOKS).map(({ id, automatic, action, stopConditions }) => ({ id, automatic, action, stopConditions })),
    },
    source: projectFingerprint(companionSource),
    installed: projectFingerprint(companionInstall),
    companionArtifacts: {
      source: sourceArtifacts,
      installed: installedArtifacts,
      ...artifactComparison,
    },
    sessions,
    liveCandidates,
    officialAppOnlyContinuationCandidateCount: officialAppOnlyContinuationCandidateItems.length,
    officialAppOnlyContinuationCandidates: officialAppOnlyContinuationCandidateItems.map((item) => ({
      threadId: item.threadId,
      threadAlias: candidateThreadAlias(item),
      hostId: item.hostId ?? item.host_id ?? null,
      cwd: item.cwd ?? null,
      owner: item.owner ?? null,
      currentTaskReadback: item.currentTaskReadback === true,
      officialTaskStatus: item.officialTaskStatus ?? null,
      officialLatestTurnStatus: item.officialLatestTurnStatus ?? null,
      officialGoalStatus: item.officialGoalStatus ?? null,
      officialPlanStatus: item.officialPlanStatus ?? null,
      officialExactBlocker: item.officialExactBlocker ?? null,
      resumeAssessment: item.resumeAssessment || buildResumeAssessment(item),
      stateScope: item.stateScope ?? null,
      nextAction: item.nextAction ?? null,
    })),
    taskOwnedContinuationCandidateCount: taskOwnedContinuationCandidateItems.length,
    taskOwnedContinuationCandidates: taskOwnedContinuationCandidateItems.map((item) => ({
      threadId: item.threadId,
      threadAlias: candidateThreadAlias(item),
      hostId: item.hostId ?? item.host_id ?? null,
      cwd: item.cwd ?? null,
      owner: item.owner ?? null,
      currentTaskReadback: item.currentTaskReadback === true,
      officialTaskStatus: item.officialTaskStatus ?? null,
      officialLatestTurnStatus: item.officialLatestTurnStatus ?? null,
      officialGoalStatus: item.officialGoalStatus ?? null,
      officialPlanStatus: item.officialPlanStatus ?? null,
      officialExactBlocker: item.officialExactBlocker ?? null,
      resumeAssessment: item.resumeAssessment || buildResumeAssessment(item),
      companionMarkers: item.companionMarkers ?? [],
      requiresTaskOwnedCompanionCallback: true,
      relayRequiresFreshOfficialReadback: String(item.officialLatestTurnStatus ?? item.latestTurnStatus ?? "").toLowerCase() === "unknown"
        || (item.officialReadbackState === "task_present_state_not_loaded"
          && ["notloaded", "not_loaded", "unknown", ""].includes(String(item.officialTaskStatus ?? "").toLowerCase())),
      relayMode: "same_task_root_companion_repair_or_resume",
      relayReason: [
        item.resumeAssessment?.reason,
        item.blockerProgress?.reason,
        item.officialExactBlocker,
        item.exactBlocker,
      ].find((value) => TASK_OWNED_SAFE_REPAIR_BLOCKERS.has(String(value)))
        ?? (item.companionIssue === true || (item.companionMarkers || []).length > 0 ? "companion_local_review" : "ready"),
      stateScope: item.stateScope ?? null,
      nextAction: item.nextAction ?? item.repairPlan?.nextAction ?? null,
    })),
    historicalSessions,
    pausedSessions,
    // Keep the two names during the additive rollout: per-session data uses
    // `softAnomalies`, while consumers that call them findings can use the
    // explicit alias. Both arrays are already deduplicated and bounded.
    softAnomalies: softAnomalyFindings,
    softAnomalyFindings,
    repairCandidates: plannedRepairCandidateItems.map((item) => ({
      threadId: item.threadId,
      threadAlias: candidateThreadAlias(item),
      hostId: item.hostId ?? item.host_id ?? null,
      cwd: item.cwd,
      currentTaskReadback: item.currentTaskReadback === true,
      officialTaskStatus: item.officialTaskStatus ?? null,
      officialLatestTurnStatus: item.officialLatestTurnStatus ?? null,
      officialReadbackState: item.officialReadbackState ?? null,
      resumeEligibleAfterProof: item.resumeEligibleAfterProof === true,
      markers: item.companionMarkers,
      blocked: item.blocked,
      proactive: item.proactiveRepairReady === true,
      softAnomalyType: item.softAnomalyType ?? item.soft_anomaly_type ?? null,
      capabilityMethod: item.capabilityMethod ?? null,
      currentCapabilityAvailable: item.currentCapabilityAvailable === true,
      sourceCapabilityAdvertised: item.sourceCapabilityAdvertised === true,
      installedCapabilityAdvertised: item.installedCapabilityAdvertised === true,
      resumeAssessment: item.resumeAssessment || buildResumeAssessment(item),
      blockerProgress: item.blockerProgress,
      repairPlan: item.repairPlan,
      nextAction: item.repairPlan.nextAction,
    })),
    blockerProgressCandidates: blockerProgressCandidates.map((progress) => ({
      schema: progress.schema,
      threadId: progress.threadId,
      threadAlias: candidateThreadAlias(progress),
      reason: progress.reason,
      exactBlocker: progress.exactBlocker,
      progressAttemptNow: progress.progressAttemptNow,
      result: progress.result,
      nextActionNow: progress.nextActionNow,
      resumeTrigger: progress.resumeTrigger,
      fallbackOrIndependentWork: progress.fallbackOrIndependentWork,
      replayAllowed: progress.replayAllowed,
    })),
    repairPlans,
    userHelp,
    exactBlocker: liveCompanion.exactBlocker
      ?? artifactComparison.exactBlocker
      ?? threadInspectionBlocker,
    nextAction: liveCompanion.exactBlocker
      ? liveCompanion.exactBlocker === "active_reconciliation"
        ? "Run one owner-scoped reconciliation readback; never replay the unknown operation, then detach only ownerless terminal tabs."
        : "Obtain one fresh Companion status/readback before any repair or refresh."
      : threadInspectionBlocker
        ? "Supply one bounded root-owned Codex App thread-readback projection for every inspected task; do not retry or substitute local session metadata."
      : threadReadbackDeferredCount(resolvedThreadInspection) > 0
        ? "Keep each task-level readback timeout or deep-read miss deferred with its exact blocker; continue only unaffected tasks and retry only on a fresh next tick."
      : plannedRepairCandidateItems.length
        ? "Codex root must execute the matching bounded repair or same-task revalidation for each selected task; leave a task deferred only for its exact unresolved safety or authority blocker."
      : artifactComparison.exactBlocker
        ? "Defer Extension refresh until no active lease/pending operation remains; then reload once and verify a fresh generation."
      : userHelp.length
        ? "Retain only user-help tabs and wait for the required human action."
        : softAnomalyFindings.length
        ? "Review the reported soft anomalies; after consecutive confirmation, perform a fresh deep read and execute the bounded repair path when the root proves a Companion-local cause."
        : "No Companion repair is currently required; perform one fresh owner/status readback now and continue independent work without a wait-only loop.",
    artifactDir,
    learningLedgerPath,
  };
  summary.auditFingerprint = buildAuditFingerprint(summary);
  return summary;
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * A read-only audit is an intermediate result when it asks the official App
 * Root to perform post-audit callbacks. Keep that obligation alive across a
 * no-change tick until the finalizer has written its immutable receipt.
 */
export function readPendingRootActionAudit(artifactDir) {
  const auditPath = path.join(String(artifactDir || ""), "aos-hourly-companion-audit.v1.json");
  try {
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    const receipt = audit?.executionReceipt;
    if (audit?.schema !== "aos.hourly_companion_audit.v1"
      || receipt?.rootActionRequired !== true
      || audit?.externalActionExecuted === true
      || receipt?.externalActionExecuted === true) {
      return { pending: false, path: auditPath };
    }
    const controllerReceiptPath = String(audit?.controllerReceiptPath || "").trim();
    const finalized = controllerReceiptPath.length > 0 && fs.existsSync(controllerReceiptPath);
    return {
      pending: !finalized,
      path: auditPath,
      priorRunId: audit?.runId ?? null,
      controllerReceiptPath: controllerReceiptPath || null,
    };
  } catch {
    return { pending: false, path: auditPath };
  }
}

function writePrivateJsonNoReplace(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return { path: file, created: false };
    throw error;
  }
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return { path: file, created: true };
}

function artifactRunId(auditedAt, fingerprint) {
  const stamp = String(auditedAt || new Date().toISOString())
    .replace(/[^0-9A-Za-z]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return `${stamp || "run"}-${String(fingerprint || "no-fingerprint").slice(0, 16)}`;
}

export function runHourlyAudit(options = {}) {
  const learningLedgerPath = options.learningLedgerPath
    ?? process.env.AOS_COMPANION_LEARNING_LEDGER
    ?? DEFAULT_LEARNING_LEDGER;
  const previousLedger = loadLearningLedger(learningLedgerPath);
  const summary = applySoftAnomalyConfirmations(
    buildAuditSummary({
      ...options,
      learningLedgerPath,
      previousThreadInspections: options.previousThreadInspections ?? previousLedger.threadInspections,
      previousInspectionRunAt: options.previousInspectionRunAt
        ?? previousLedger.runs[previousLedger.runs.length - 1]?.auditedAt
        ?? null,
    }),
    previousLedger,
  );
  const artifactDir = summary.artifactDir;
  const artifactPath = path.join(artifactDir, "aos-hourly-companion-audit.v1.json");
  const pendingRootActionAudit = readPendingRootActionAudit(artifactDir);
  let ledger = updateLearningLedger(summary.learningLedgerPath, summary);
  if (options.controllerOutcome) {
    ledger = recordCompanionLearningOutcome(summary.learningLedgerPath, {
      summary,
      controller: options.controllerOutcome,
    });
  }
  const previousFingerprint = ledger.runs.length > 1
    ? ledger.runs[ledger.runs.length - 2]?.fingerprint || null
    : null;
  const changedSincePreviousRun = previousFingerprint === null || previousFingerprint !== summary.auditFingerprint;
  const stalled = stalledTasks(summary);
  const deepReadCandidateCount = Number(summary.threadInspection?.deepReadCandidateCount || 0);
  const softAnomalyDeepReadCandidateCount = Number(summary.softAnomalyDeepReadCandidateCount || 0);
  const heartbeatOnly = !changedSincePreviousRun
    && Number(ledger.noChangeRuns || 0) < 24
    && pendingRootActionAudit.pending !== true
    && stalled.length === 0
    && deepReadCandidateCount === 0
    && softAnomalyDeepReadCandidateCount === 0;
  const verifierArtifactPath = path.join(artifactDir, "aos-hourly-companion-audit.verifier.v1.json");
  const runId = artifactRunId(summary.auditedAt, summary.auditFingerprint);
  const immutableRunDir = path.join(artifactDir, "runs");
  const immutableArtifactPath = path.join(immutableRunDir, `aos-hourly-companion-audit-${runId}.v1.json`);
  const immutableVerifierArtifactPath = path.join(immutableRunDir, `aos-hourly-companion-audit-${runId}.verifier.v1.json`);
  const result = {
    ...summary,
    runId,
    changeDetection: {
      schema: "aos.companion_change_detection.v1",
      fingerprint: summary.auditFingerprint,
      previousFingerprint,
      changedSincePreviousRun,
      noChangeRunCount: Number(ledger.noChangeRuns || 0),
      heartbeatOnly,
      pendingRootAction: pendingRootActionAudit.pending === true,
      stalledTaskCount: stalled.length,
      lightweightThreadInspectionCount: Number(summary.threadInspection?.lightweightInspectionCount || 0),
      deepReadCandidateCount,
      softAnomalyConfirmationCount: Number(summary.softAnomalyConfirmationCount || 0),
      softAnomalyDeepReadCandidateCount,
      escalationAllowed: !heartbeatOnly,
      softAnomalyEscalationAllowed: false,
    },
    controller: {
      ...summary.controller,
      schedulerDecision: heartbeatOnly ? "heartbeat_only" : "inspect_and_repair",
      schedulerReason: heartbeatOnly
        ? "No audit signal changed; lightweight inspection completed; do not launch a repair graph or create a task."
        : deepReadCandidateCount > 0 || softAnomalyDeepReadCandidateCount > 0
          ? "Lightweight inspection found a bounded deep-read candidate; inspect only those existing tasks before any repair decision."
        : stalled.length > 0
          ? "A live task exceeded the stalled threshold; perform one fresh status/readback before any bounded repair."
        : pendingRootActionAudit.pending === true
          ? "The previous audit still requires the official App post-audit callback/finalizer; keep the Root action queue open even without a new fingerprint."
        : changedSincePreviousRun
          ? "Audit signal changed; perform one bounded live status/readback before any repair."
          : "No-change heartbeat threshold reached; perform a fresh status/readback without replay.",
    },
    learning: {
      schema: ledger.schema,
      protocol: ledger.protocol,
      updatedAt: ledger.updatedAt,
      observationCount: Object.keys(ledger.observations || {}).length,
      outcomeCount: Array.isArray(ledger.learningOutcomes) ? ledger.learningOutcomes.length : 0,
      verifiedOutcomeCount: Array.isArray(ledger.learningOutcomes)
        ? ledger.learningOutcomes.filter((outcome) => ["passed", "failed"].includes(outcome?.verification?.status)).length
        : 0,
      proposedPlaybookCount: Array.isArray(ledger.playbookProposals) ? ledger.playbookProposals.length : 0,
      minimumIndependentReproductions: MIN_INDEPENDENT_REPRODUCTIONS_FOR_PLAYBOOK_PROPOSAL,
      proposedPlaybooks: (ledger.playbookProposals || []).slice(-20),
      recentRunCount: ledger.runs.length,
      softAnomalyConfirmationThreshold: SOFT_ANOMALY_CONFIRMATION_THRESHOLD,
      confirmedSoftAnomalyCount: Number(summary.softAnomalyConfirmationCount || 0),
      recurringSignals: Object.entries(ledger.observations || {})
        .filter(([, value]) => Number(value?.count || 0) >= 3)
        .sort(([, left], [, right]) => Number(right.count || 0) - Number(left.count || 0))
        .slice(0, 20)
        .map(([key, value]) => ({ key, count: value.count, lastSeen: value.lastSeen })),
    },
    artifactPath,
    verifierArtifactPath,
    immutableArtifactPath,
    immutableVerifierArtifactPath,
  };
  result.executionReceipt = buildAuditExecutionReceipt({
    summary,
    runId,
    schedulerDecision: result.controller.schedulerDecision,
  });
  const verifierProjection = buildVerifierProjection(result);
  result.verifierProjection = verifierProjection;
  writePrivateJson(verifierArtifactPath, verifierProjection);
  writePrivateJson(artifactPath, result);
  writePrivateJsonNoReplace(immutableVerifierArtifactPath, verifierProjection);
  writePrivateJsonNoReplace(immutableArtifactPath, result);
  return result;
}

/**
 * Production entrypoint: include one fresh read-only Companion status in the
 * normal audit without changing the synchronous test/helper API above.
 */
export async function runHourlyAuditLive(options = {}) {
  const liveStatus = options.liveStatus ?? await readLiveCompanionStatus({
    sourceRoot: options.companionSource ?? DEFAULT_COMPANION_SOURCE,
    env: options.env ?? process.env,
    timeoutMs: options.liveStatusTimeoutMs ?? 5_000,
  });
  let recentTasks = options.recentTasks ?? null;
  let inspectThread = options.inspectThread ?? null;
  let readThread = options.readThread ?? null;
  const suppliedProjection = options.threadReadbackProjection
    ?? (options.threadReadbackProjectionPath ? readThreadReadbackProjection(options.threadReadbackProjectionPath) : null);
  if (!suppliedProjection && options.threadReadbackProjectionPath) {
    throw new Error("thread_readback_projection_not_supplied");
  }
  if (suppliedProjection && !recentTasks && !options.threadInspection) {
    const bridged = projectionCallbacks(suppliedProjection);
    recentTasks = bridged.tasks;
    inspectThread = bridged.inspectThread;
    readThread = bridged.readThread;
  }
  let liveThreadInspection = options.threadInspection ?? null;
  if (!liveThreadInspection && Array.isArray(recentTasks)) {
    const learningLedgerPath = options.learningLedgerPath
      ?? process.env.AOS_COMPANION_LEARNING_LEDGER
      ?? DEFAULT_LEARNING_LEDGER;
    const previousLedger = loadLearningLedger(learningLedgerPath);
    liveThreadInspection = await inspectRecentUserThreads({
      tasks: recentTasks,
      inspectThread,
      readThread,
      previousInspections: options.previousThreadInspections ?? previousLedger.threadInspections,
      previousInspectionRunAt: options.previousInspectionRunAt
        ?? previousLedger.runs[previousLedger.runs.length - 1]?.auditedAt
        ?? null,
      now: options.now ? Date.parse(options.now) || Date.now() : Date.now(),
      stalledTaskThresholdMs: options.stalledTaskThresholdMs ?? DEFAULT_STALLED_TASK_THRESHOLD_MS,
      source: "codex_app_thread_list",
      maxTasks: options.maxThreadInspections ?? MAX_LIGHTWEIGHT_THREAD_INSPECTIONS,
      maxDeepReads: options.maxDeepThreadReads ?? suppliedProjection?.limits?.maxDeepReads ?? MAX_DEEP_THREAD_READS,
    });
  }
  return runHourlyAudit({ ...options, recentTasks, inspectThread, readThread, threadReadbackProjection: suppliedProjection, liveStatus, threadInspection: liveThreadInspection });
}

let isMainModule = false;
if (process.argv[1] && process.argv[1] !== "-") {
  try {
    isMainModule = fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    isMainModule = false;
  }
}
if (isMainModule) {
  let threadReadbackProjection = null;
  try {
    const projectionPath = process.env.AOS_COMPANION_THREAD_READBACK_PROJECTION_PATH || "";
    threadReadbackProjection = projectionPath ? readThreadReadbackProjection(projectionPath) : null;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: "aos.hourly_companion_audit.v1",
      readOnly: true,
      externalActionExecuted: false,
      exactBlocker: String(error?.exact_blocker ?? error?.message ?? "thread_readback_projection_invalid").slice(0, 500),
    })}\n`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) runHourlyAuditLive({ threadReadbackProjection }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // A read-only audit with actionable candidates is an intermediate result.
    // Make the registered Root continue into the official App callback phase;
    // otherwise the local runner sees exit 0 and incorrectly records a green
    // workflow even though repair/continuation was never attempted.
    if (result?.executionReceipt?.status === "blocked"
      || result?.executionReceipt?.status === "failed"
      || result?.executionReceipt?.rootActionRequired === true) process.exitCode = 2;
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schema: "aos.hourly_companion_audit.v1",
      readOnly: true,
      externalActionExecuted: false,
      exactBlocker: String(error?.code ?? "hourly_audit_failed"),
      error: String(error?.message ?? error).slice(0, 500),
    })}\n`);
    process.exitCode = 1;
  });
}
