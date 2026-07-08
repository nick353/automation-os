import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalRequest, decideApproval, requiresApproval } from "../runs/approvalGate.js";

test("requires approval only for billing, purchase, payment, or checkout hard stops", () => {
  assert.equal(requiresApproval({ action: "Publish to LinkedIn", resources: ["social_publish"], dangerousAction: true }), false);
  assert.equal(requiresApproval({ action: "Proceed to payment checkout", resources: ["commerce_publish"] }), true);
  assert.equal(requiresApproval({ action: "商品を購入", resources: ["commerce_publish"] }), true);
  assert.equal(requiresApproval({ action: "Read local receipts", resources: ["proofs"] }), false);
});

test("does not require approval for non-billing external actions", () => {
  const allowedActions = [
    { action: "Publish approved SNS post", resources: ["social_publish"], dangerousAction: true },
    { action: "Submit job application form", resources: ["job_submit"], dangerousAction: true },
    { action: "Send Gmail follow-up", resources: ["gmail_send"], dangerousAction: true },
    { action: "Save prompt transfer rows", resources: ["sheets_write"], dangerousAction: true },
    { action: "Delete duplicate local queue row with readback proof", resources: ["local_worker"], dangerousAction: true },
    { action: "Use authenticated browser session", resources: ["trusted_browser"], dangerousAction: true },
    { action: "Record CAPTCHA human-input evidence", resources: ["browser_evidence"], dangerousAction: true }
  ];

  for (const action of allowedActions) {
    assert.equal(requiresApproval(action), false, action.action);
  }
});

test("does not treat billing-only policy wording as a billing action", () => {
  assert.equal(requiresApproval({ action: "SNS Multi Poster registered workflow billing-only post publish" }), false);
  assert.equal(requiresApproval({ action: "課金停止 policy with post/send/submit allowed" }), false);
  assert.equal(requiresApproval({ action: "課金・購入・支払い・決済だけ停止して投稿する" }), false);
});

test("requires approval for paid subscription and invoice wording", () => {
  assert.equal(requiresApproval({ action: "Start paid subscription" }), true);
  assert.equal(requiresApproval({ action: "請求を確定する" }), true);
});

test("creates and decides approval requests", () => {
  const approval = createApprovalRequest({ title: "Post approval", resourceLocks: ["x_publish"] });
  assert.equal(approval.status, "pending");
  assert.deepEqual(approval.resourceLocks, ["x_publish"]);

  const approved = decideApproval(approval, "approved", "ok");
  assert.equal(approved.status, "approved");
  assert.equal(approved.decisionNote, "ok");
});

test("cancels pending approval requests without approving protected work", () => {
  const approval = createApprovalRequest({ title: "Post approval", resourceLocks: ["x_publish"] });
  const cancelled = decideApproval(approval, "cancelled", "user cancelled");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.decisionNote, "user cancelled");
});
