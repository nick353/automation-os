import assert from "node:assert/strict";
import test from "node:test";

const { buildLocalPlanner } = await import("../planner/createPlanner.js");

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
