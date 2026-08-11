import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildWebOperationIntake } from "../runs/webOperationIntake.js";

test("common web intake resolves a read request from semantic fields without an external effect", () => {
  const intake = buildWebOperationIntake([
    "目的: read",
    "サイトまたはURL: https://example.com/settings?from=chat",
    "会社とアカウント: example / operations",
    "対象（意味で指定。例: 公開、保存、応募、削除）: アカウント設定",
    "内容（本文・画像・ファイル・応募内容など）:",
    "公開先・送信先・対象範囲: 自社アカウント"
  ].join("\n"));
  assert.equal(intake.applicable, true);
  assert.equal(intake.status, "ready_for_read");
  assert.equal(intake.site_or_url, "https://example.com");
  assert.equal(intake.semantic_target, "アカウント設定");
  assert.equal(intake.external_action_executed, false);
  assert.equal(intake.web_operation_contract.adaptive_layer.no_fixed_css_selector_authority, true);
});

test("effectful common web intake asks for missing payload and scope and never grants approval", () => {
  const intake = buildWebOperationIntake([
    "目的: publish",
    "サイトまたはURL: https://social.example",
    "会社とアカウント: example / brand"
  ].join("\n"));
  assert.equal(intake.status, "needs_input");
  assert.deepEqual(intake.missing_fields, ["semantic_target", "payload", "scope"]);
  assert.equal(intake.next_stage, "clarify");
  assert.equal(intake.external_action_executed, false);
  assert.equal(intake.payload_hash, null);
});

test("first-use natural fields accept an unlabeled URL and common account, payload, and audience labels", () => {
  const intake = buildWebOperationIntake([
    "目的: publish",
    "操作先は https://social.example/compose?draft=1 です",
    "利用アカウント: example / brand",
    "操作対象: ブランドアカウントの新規投稿",
    "投稿文: 新商品の紹介文。画像は商品画像Aを使う",
    "audience: ブランド公式アカウントのフォロワー"
  ].join("\n"));
  assert.equal(intake.status, "approval_required");
  assert.equal(intake.site_or_url, "https://social.example");
  assert.equal(intake.account_ref, "example / brand");
  assert.equal(intake.semantic_target, "ブランドアカウントの新規投稿");
  assert.equal(intake.payload_present, true);
  assert.equal(intake.scope, "ブランド公式アカウントのフォロワー");
  assert.deepEqual(intake.missing_fields, []);
  assert.equal(intake.external_action_executed, false);
});

test("ambiguous natural instructions ask for an explicit operation instead of guessing", () => {
  const intake = buildWebOperationIntake([
    "目的: 投稿内容を確認してから公開",
    "サイトまたはURL: https://social.example",
    "会社とアカウント: example / brand",
    "対象: ブランドアカウントの新規投稿",
    "内容: 新商品の紹介文",
    "公開先: ブランド公式アカウント"
  ].join("\n"));
  assert.equal(intake.status, "needs_input");
  assert.equal(intake.operation, null);
  assert.deepEqual(intake.missing_fields, ["operation"]);
  assert.equal(intake.external_action_executed, false);
});

test("first-use markdown fields preserve multiline payloads and common aliases", () => {
  const payload = ["新商品の紹介文です。", "二行目も投稿本文として扱います。"].join("\n");
  const intake = buildWebOperationIntake([
    "- **目的**: publish",
    "- **操作先**: https://social.example/compose",
    "- **利用アカウント**: example / brand",
    "- **操作対象**: ブランド公式アカウントの新規投稿",
    `- **投稿文**: ${payload}`,
    "- **宛先**: ブランド公式アカウントのフォロワー"
  ].join("\n"));
  assert.equal(intake.status, "approval_required");
  assert.deepEqual(intake.missing_fields, []);
  assert.equal(intake.site_or_url, "https://social.example");
  assert.equal(intake.payload_hash, createHash("sha256").update(payload).digest("hex"));
  assert.equal(intake.external_action_executed, false);
});

test("fixed selector or click-order instructions fail closed", () => {
  const intake = buildWebOperationIntake([
    "目的: publish",
    "サイトまたはURL: https://social.example",
    "会社とアカウント: example / brand",
    "対象: 公開ボタンのCSS selector=button.publish:nth-child(2)",
    "内容: redacted draft",
    "公開先・送信先・対象範囲: ブランドアカウント"
  ].join("\n"));
  assert.equal(intake.status, "blocked");
  assert.equal(intake.exact_blocker, "web_operation_fixed_locator_rejected");
  assert.equal(intake.external_action_executed, false);
});

test("ordinary automation chat is not forced into the web-operation intake", () => {
  const intake = buildWebOperationIntake("毎日、社内の売上CSVを集計して下書きを作る自動化を作って");
  assert.equal(intake.applicable, false);
  assert.equal(intake.status, "not_applicable");
});
