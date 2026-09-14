import assert from "node:assert/strict";
import test from "node:test";

const { buildLocalPlanner, createCodexAppServerPlannerResponse } = await import("../planner/createPlanner.js");
import type { CodexAppServerClient } from "../codex/appServerClient.js";

test("an explicit existing schedule change uses the latest request and never requires provider execution", async () => {
  const latest = "既存定期実行を調整してください。会社1の検証用下書き（automation_chat_test）だけを対象に、毎日06:15 Asia/Tokyoに設定してください。予定は停止中のまま保存し、有効化や今すぐ実行はしないでください。元のメール確認の予定は変更しないでください。";
  const messages = [
    { role: "user" as const, text: "Gmailを確認して。送信しない。" },
    { role: "user" as const, text: "自動化下書きを作ってください。まだ実行しないでください。" },
    { role: "user" as const, text: latest }
  ];
  const local = buildLocalPlanner(messages);
  assert.equal(local.operation, "manage_workflow");
  assert.equal(local.executionDecision, "ready_to_schedule");
  assert.equal(local.command, latest);
  assert.deepEqual(local.openQuestions, []);
  assert.equal(local.webOperationIntake, undefined);
  assert.match(local.backendChecks.join(" "), /Runを開始せず/);
  const client = { startOrResumeThread: async () => "schedule-thread", startTurn: async () => ({
    status: "completed", threadId: "schedule-thread", turnId: "schedule-turn", events: [], text: "", structured: {
      ...local, title: "古いGmailの状態確認", command: "古い依頼", operation: "answer_question",
      intent: "answer_question", executionDecision: "ask_more", openQuestions: ["再試行は何分後ですか？"]
    }
  }) } as unknown as CodexAppServerClient;
  const { result } = await createCodexAppServerPlannerResponse({ client, messages });
  assert.equal(result.operation, "manage_workflow");
  assert.equal(result.executionDecision, "ready_to_schedule");
  assert.equal(result.command, latest);
  assert.equal(result.title, local.title);
  assert.deepEqual(result.openQuestions, []);
  assert.equal(result.webOperationIntake, undefined);
});

test("schedule questions, protected targets and new creation are not forced into existing schedule saving", () => {
  for (const text of [
    "既存予定を毎日06:15に変更する方法だけを説明してください。変更しないでください。",
    "既存予定を毎日06:15に変更しないでください。現在状態を確認するだけです。",
    "既存予定を参考に新しい自動化を毎日06:15で作成して。"
  ]) assert.notEqual(buildLocalPlanner([{ role: "user", text }]).title, "選択した既存自動化の予定を調整する");
  for (const text of ["既存予定を手動のみに変更してください。", "Change the existing schedule to daily 06:15. Keep it paused."]) {
    const result = buildLocalPlanner([{ role: "user", text }]);
    assert.equal(result.operation, "manage_workflow");
    assert.equal(result.executionDecision, "ready_to_schedule");
    assert.deepEqual(result.openQuestions, []);
  }
});

test("a new no-execution draft after a question retains current intent, name, and save-only boundary", async () => {
  const latest = "会社1に自動化下書き「AOS受入テスト Gmail確認」を作ってください。Gmailの最新metadataを最大5件取得する案を提示。送信・既読変更はしません。定期実行は無効、まだ実行しないでください。";
  const messages = [
    { role: "user" as const, text: "会社1の登録済みPluginの現在状態を説明してください。回答だけで実行しないでください。" },
    { role: "assistant" as const, text: "5件が登録されています。" },
    { role: "user" as const, text: latest }
  ];
  const local = buildLocalPlanner(messages);
  assert.equal(local.operation, "create_automation");
  assert.equal(local.executionDecision, "save_plan");
  assert.equal(local.command, latest);
  assert.deepEqual(local.openQuestions, []);
  const client = { startOrResumeThread: async () => "draft-thread", startTurn: async () => ({
    status: "completed", threadId: "draft-thread", turnId: "draft-turn", events: [], text: "", structured: {
      ...local, source: undefined, title: "AOS受入テスト Gmail確認", reply: "指定名の下書き案です。保存後も実行しません。",
      visibleSteps: ["Gmail metadataを最大5件読む", "未送信の返信案をまとめる"],
      command: "old combined command", executionDecision: "ready_to_schedule", openQuestions: []
    }
  }) } as unknown as CodexAppServerClient;
  const { result } = await createCodexAppServerPlannerResponse({ client, messages });
  assert.equal(result.title, "AOS受入テスト Gmail確認");
  assert.equal(result.reply, "指定名の下書き案です。保存後も実行しません。");
  assert.equal(result.command, latest);
  assert.equal(result.operation, "create_automation");
  assert.equal(result.executionDecision, "save_plan");
  assert.deepEqual(result.openQuestions, []);
  assert.equal(result.webOperationIntake, undefined);
});

test("local planner does not treat an explicit no-submit boundary as submit intent", () => {
  const result = buildLocalPlanner([
    {
      role: "user",
      text: "毎日9時にAOSのDBに保存された状態を確認し、失敗時は1回だけ再試行する自動化を作って。外部投稿・送信・応募はしない。正本はAOS DB、完了は同一Runのreadbackとsource syncで確認する。"
    }
  ]);

  assert.equal(result.operation, "create_automation");
  assert.match(result.title, /定期実行/);
  assert.equal(result.visibleSteps.includes("読み取りと保存だけで安全に確認する"), true);
  assert.equal(result.visibleSteps.includes("応募・送信確定前に会社名、求人URL、入力内容、確認画面を証跡化して止める"), false);
});

test("local planner still detects a positive submit request", () => {
  const result = buildLocalPlanner([
    {
      role: "user",
      text: "求人に応募して。応募確定ボタンの直前で止めて、URLと入力内容を証跡化する。"
    }
  ]);

  assert.equal(result.visibleSteps.includes("応募・送信確定前に会社名、求人URL、入力内容、確認画面を証跡化して止める"), true);
});

test("read-only answers retain complete connector context and do not acquire workflow questions", async () => {
  const context = JSON.stringify({ history: "x".repeat(19000), toolPreference: { selected: { id: "gmail", status: "ready" } } });
  const client = { startOrResumeThread: async () => "test-thread", startTurn: async (input: { text: string }) => {
    assert.ok(input.text.includes(context));
    return { status: "completed", threadId: "test-thread", turnId: "test-turn", events: [], text: "", structured: {
      intent: "answer_question", operation: "answer_question", title: "Gmail接続", reply: "会社1のGmailは接続参照あり。",
      command: "会社1のGmailの接続状態を読み取り専用で短く説明してください。変更はしないでください。",
      visibleSteps: [], backendChecks: [], answered: [], openQuestions: [], nextAction: "確認完了", executionDecision: "ask_more", confidence: "high"
    } };
  } } as unknown as CodexAppServerClient;
  const r = await createCodexAppServerPlannerResponse({ client, context, messages: [{ role: "user", text: "会社1のGmailの接続状態を読み取り専用で短く説明してください。変更はしないでください。" }] });
  assert.equal(r.result.intent, "answer_question");
  assert.deepEqual(r.result.openQuestions, []);
  assert.equal(r.result.webOperationIntake, undefined);
});
