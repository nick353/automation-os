import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const selectors = await import("../runs/selectors.js");

test("filterSupersededResumeRuns uses updated_at before created_at for later complete runs", () => {
  const runs = [
    {
      id: "run_newer_partial",
      name: "Codexでdocs/09-local-worker.md存在確認のみ",
      status: "partial",
      objective: "Codexでdocs/09-local-worker.md存在確認のみ",
      created_at: "2026-06-12T13:00:00.000Z",
      updated_at: "2026-06-12T13:00:00.000Z"
    },
    {
      id: "run_older_created_later_completed",
      name: "Codexでread-only確認: docs/09-local-worker.mdの存在だけを確認し、1文で終了。新しいcodex execは禁止。ファイル変更禁止。",
      status: "complete",
      objective: "Codexでread-only確認: docs/09-local-worker.mdの存在だけを確認し、1文で終了。新しいcodex execは禁止。ファイル変更禁止。",
      created_at: "2026-06-12T12:00:00.000Z",
      updated_at: "2026-06-12T13:30:00.000Z"
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_older_created_later_completed"]
  );
});

test("filterSupersededResumeRuns keeps genuinely different docs work visible", () => {
  const runs = [
    {
      id: "run_partial_real_work",
      name: "Codexでdocs/09-local-worker.mdを修正",
      status: "partial",
      objective: "Codexでdocs/09-local-worker.mdを修正",
      created_at: "2026-06-12T13:00:00.000Z",
      updated_at: "2026-06-12T13:00:00.000Z"
    },
    {
      id: "run_complete_existence",
      name: "Codexでdocs/09-local-worker.md存在確認のみ",
      status: "complete",
      objective: "Codexでdocs/09-local-worker.md存在確認のみ",
      created_at: "2026-06-12T13:10:00.000Z",
      updated_at: "2026-06-12T13:10:00.000Z"
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_partial_real_work", "run_complete_existence"]
  );
});

test("filterSupersededResumeRuns hides readonly docs checks superseded by existence complete runs", () => {
  const runs = [
    {
      id: "run_readonly_blocked",
      name: "CodexでAutomation OS docs/09-local-worker.mdをread-only確認",
      status: "blocked",
      objective: "CodexでAutomation OS docs/09-local-worker.mdをread-only確認",
      created_at: "2026-06-12T09:26:00.000Z",
      updated_at: "2026-06-12T09:28:05.000Z"
    },
    {
      id: "run_complete_existence",
      name: "Codexでdocs/09-local-worker.md存在確認のみ",
      status: "complete",
      objective: "Codexでdocs/09-local-worker.md存在確認のみ",
      created_at: "2026-06-12T09:31:23.000Z",
      updated_at: "2026-06-12T09:31:49.000Z"
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_complete_existence"]
  );
});

test("filterSupersededResumeRuns hides historical receipt-only Codex demo runs from current surfaces", () => {
  const runs = [
    {
      id: "run_demo_partial",
      name: "Codex read-only demo 3: Automation OS local worker receipt proofを確認",
      status: "partial",
      objective: "Codex read-only demo 3: Automation OS local worker receipt proofを確認",
      created_at: "2026-06-12T08:58:15.000Z",
      updated_at: "2026-06-12T08:58:15.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] }
      })
    },
    {
      id: "run_real_receipt_partial",
      name: "Real receipt-only work",
      status: "partial",
      objective: "Real receipt-only work",
      created_at: "2026-06-12T09:00:00.000Z",
      updated_at: "2026-06-12T09:00:00.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] }
      })
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_real_receipt_partial"]
  );
});

test("receipt-only QA verification gaps do not become resume or action queue candidates", () => {
  const runs = [
    {
      id: "run_qa_receipt_gap",
      name: "QA unique create command 1781574418874",
      status: "partial",
      objective: "QA unique create command 1781574418874",
      created_at: "2026-06-16T01:47:10.000Z",
      updated_at: "2026-06-16T01:47:10.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
        proof_summary: "partial: worker receipts captured, actual execution is not verified"
      })
    },
    {
      id: "run_real_receipt_partial",
      name: "Real receipt-only work",
      status: "partial",
      objective: "Real receipt-only work",
      created_at: "2026-06-16T01:40:00.000Z",
      updated_at: "2026-06-16T01:40:00.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] }
      })
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_real_receipt_partial"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_real_receipt_partial");
  assert.deepEqual(
    selectors.selectAttentionRuns(runs).map((run) => run.id),
    ["run_real_receipt_partial"]
  );
});

test("resume-suppressed blocked partial and waiting approval runs stay out of resume surfaces", () => {
  const runs = [
    {
      id: "run_suppressed_blocked",
      name: "Suppressed blocked work",
      status: "blocked",
      objective: "Suppressed blocked work",
      created_at: "2026-06-16T02:00:00.000Z",
      updated_at: "2026-06-16T02:00:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: true })
    },
    {
      id: "run_suppressed_partial",
      name: "Suppressed partial work",
      status: "partial",
      objective: "Suppressed partial work",
      created_at: "2026-06-16T02:01:00.000Z",
      updated_at: "2026-06-16T02:01:00.000Z",
      metadata_json: { resume_suppressed: true }
    },
    {
      id: "run_suppressed_waiting",
      name: "Suppressed approval work",
      status: "waiting_approval",
      objective: "Suppressed approval work",
      created_at: "2026-06-16T02:02:00.000Z",
      updated_at: "2026-06-16T02:02:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: true })
    },
    {
      id: "run_suppressed_complete",
      name: "Suppressed complete history",
      status: "complete",
      objective: "Suppressed complete history",
      created_at: "2026-06-16T02:03:00.000Z",
      updated_at: "2026-06-16T02:03:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: true })
    },
    {
      id: "run_active_partial",
      name: "Active partial work",
      status: "partial",
      objective: "Active partial work",
      created_at: "2026-06-16T02:04:00.000Z",
      updated_at: "2026-06-16T02:04:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: false })
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_suppressed_complete", "run_active_partial"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_active_partial");
  assert.deepEqual(
    selectors.selectAttentionRuns(runs).map((run) => run.id),
    ["run_active_partial"]
  );
});

test("older YouTube transcript capture partial runs stay out of current action surfaces", () => {
  const runs = [
    {
      id: "run_old_youtube_capture",
      name: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      status: "partial",
      objective: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      created_at: "2026-06-20T10:42:37.000Z",
      updated_at: "2026-06-20T10:42:37.000Z",
      metadata_json: JSON.stringify({
        youtube_capture: {
          status: "blocked",
          requestedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          exactBlocker: "youtube_transcript_official_panel_not_visible"
        }
      })
    },
    {
      id: "run_latest_youtube_capture",
      name: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      status: "partial",
      objective: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      created_at: "2026-06-20T11:02:53.000Z",
      updated_at: "2026-06-20T11:02:53.000Z",
      metadata_json: JSON.stringify({
        youtube_capture: {
          status: "blocked",
          requestedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          exactBlocker: "youtube_transcript_official_panel_not_visible"
        }
      })
    },
    {
      id: "run_other_youtube_capture",
      name: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=aircAruvnKk",
      status: "partial",
      objective: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=aircAruvnKk",
      created_at: "2026-06-20T11:09:38.000Z",
      updated_at: "2026-06-20T11:09:38.000Z",
      metadata_json: JSON.stringify({
        youtube_capture: {
          status: "blocked",
          requestedUrl: "https://www.youtube.com/watch?v=aircAruvnKk",
          exactBlocker: "youtube_transcript_official_panel_not_visible"
        }
      })
    }
  ];

  assert.deepEqual(
    selectors.selectActionQueueRuns(runs).map((run) => run.id),
    ["run_latest_youtube_capture", "run_other_youtube_capture"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_latest_youtube_capture");
});

test("YouTube URL tasks are not aggregated unless they are transcript capture proof runs", () => {
  const runs = [
    {
      id: "run_youtube_summary",
      name: "https://www.youtube.com/watch?v=dQw4w9WgXcQ の説明文からタイトル案を作る",
      status: "partial",
      objective: "https://www.youtube.com/watch?v=dQw4w9WgXcQ の説明文からタイトル案を作る",
      created_at: "2026-06-20T10:00:00.000Z",
      updated_at: "2026-06-20T10:00:00.000Z",
      metadata_json: JSON.stringify({ worker_mode: "receipt_only" })
    },
    {
      id: "run_youtube_transcript_capture",
      name: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      status: "partial",
      objective: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      created_at: "2026-06-20T11:00:00.000Z",
      updated_at: "2026-06-20T11:00:00.000Z",
      metadata_json: JSON.stringify({
        research_plan_missing_proofs: ["visible_source_snapshot:youtube"]
      })
    }
  ];

  assert.deepEqual(
    selectors.selectActionQueueRuns(runs).map((run) => run.id),
    ["run_youtube_summary", "run_youtube_transcript_capture"]
  );
});

test("resume-suppressed metadata accepts common truthy encodings", () => {
  const runs = [
    {
      id: "run_suppressed_number",
      name: "Suppressed number",
      status: "blocked",
      objective: "Suppressed number",
      created_at: "2026-06-16T02:00:00.000Z",
      updated_at: "2026-06-16T02:00:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: 1 })
    },
    {
      id: "run_suppressed_string_number",
      name: "Suppressed string number",
      status: "partial",
      objective: "Suppressed string number",
      created_at: "2026-06-16T02:01:00.000Z",
      updated_at: "2026-06-16T02:01:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: "1" })
    },
    {
      id: "run_suppressed_yes",
      name: "Suppressed yes",
      status: "waiting_approval",
      objective: "Suppressed yes",
      created_at: "2026-06-16T02:02:00.000Z",
      updated_at: "2026-06-16T02:02:00.000Z",
      metadata_json: { resume_suppressed: "yes" }
    },
    {
      id: "run_active_approval_required",
      name: "Active approval required",
      status: "approval_required",
      objective: "Active approval required",
      created_at: "2026-06-16T02:03:00.000Z",
      updated_at: "2026-06-16T02:03:00.000Z",
      metadata_json: JSON.stringify({ resume_suppressed: "no" })
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_active_approval_required"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_active_approval_required");
  assert.deepEqual(
    selectors.selectActionQueueRuns(runs).map((run) => run.id),
    ["run_active_approval_required"]
  );
});

test("current NisenPrints STATE suppresses stale blocked registered run for the same slug", () => {
  const previousStatePath = process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-nisen-state-"));
  const statePath = join(tempRoot, "STATE.md");
  writeFileSync(
    statePath,
    [
      "# NisenPrints Current State",
      "",
      "- latest active run: `2026-06-17-170503-3a7e-fuji-magnolia-snow-onsen-silver-white-cat`",
      "- final_status: `canva_artifacts_present`",
      "- resume_stage: `printify_product_copy`",
      "- blocker: ``"
    ].join("\n"),
    "utf8"
  );
  process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH = statePath;
  try {
    const runs = [
      {
        id: "run_mqhvcsb1_kon3o6",
        name: "NisenPrints registered workflow billing-only proof gate full publish resume",
        status: "blocked",
        objective:
          "NisenPrints registered workflow billing-only proof gate full publish resume run_id=2026-06-17-170503-3a7e-fuji-magnolia-snow-onsen-silver-white-cat browser_use_registered_runner",
        created_at: "2026-06-17T09:29:00.493Z",
        updated_at: "2026-06-17T09:30:02.567Z",
        metadata_json: JSON.stringify({
          executor: "execute_nisenprints_registered",
          run_slug: "2026-06-17-170503-3a7e-fuji-magnolia-snow-onsen-silver-white-cat",
          final_status: "canva_export_blocked",
          resume_stage: "canva_commit_export",
          blocker: "canva_browser_use_download_export_not_implemented",
          stop_reason: "canva_browser_use_download_export_not_implemented"
        })
      },
      {
        id: "run_other_blocked",
        name: "Other blocked",
        status: "blocked",
        objective: "Other blocked",
        created_at: "2026-06-17T09:31:00.000Z",
        updated_at: "2026-06-17T09:31:00.000Z"
      }
    ];

    assert.deepEqual(
      selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
      ["run_other_blocked"]
    );
    assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_other_blocked");
    assert.deepEqual(
      selectors.selectAttentionRuns(runs).map((run) => run.id),
      ["run_other_blocked"]
    );
  } finally {
    if (previousStatePath === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH;
    else process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH = previousStatePath;
  }
});

test("receipt-only local read-only checks with verification gaps stay out of current attention", () => {
  const runs = [
    {
      id: "run_local_check_gap",
      name: "Browser Use local QA 画面確認",
      status: "partial",
      objective: "test-only local check: Browser Useで画面確認",
      created_at: "2026-06-16T01:47:10.000Z",
      updated_at: "2026-06-16T01:47:10.000Z",
      metadata_json: JSON.stringify({
        execution_mode: "receipt_only",
        receipt_only: true,
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification:step_1"], present: ["worker_receipt"] }
      })
    }
  ];

  assert.deepEqual(selectors.filterSupersededResumeRuns(runs), []);
  assert.equal(selectors.selectResumeCandidateRun(runs), undefined);
  assert.deepEqual(selectors.selectAttentionRuns(runs), []);
});

test("receipt-only local worker plan gaps stay visible without explicit noise or suppression", () => {
  const runs = [
    {
      id: "run_local_worker_gap",
      name: "毎日の作業を相談しながら自動化したい",
      status: "partial",
      objective: "毎日の作業を相談しながら自動化したい",
      created_at: "2026-06-15T13:21:46.515Z",
      updated_at: "2026-06-15T13:21:47.897Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        plan: {
          tasks: [{ adapter: "local_worker", resources: ["local_worker"] }],
          lanes: [{ role: "Local Worker", resourceLocks: ["local_worker"] }]
        },
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] }
      })
    },
    {
      id: "run_real_receipt_partial",
      name: "Real receipt-only work",
      status: "partial",
      objective: "Real receipt-only work",
      created_at: "2026-06-15T13:10:00.000Z",
      updated_at: "2026-06-15T13:10:00.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] }
      })
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_local_worker_gap", "run_real_receipt_partial"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_local_worker_gap");
  assert.deepEqual(
    selectors.selectAttentionRuns(runs).map((run) => run.id),
    ["run_local_worker_gap", "run_real_receipt_partial"]
  );
});

test("receipt-only local worker and codex cli summary gaps stay visible without explicit noise or suppression", () => {
  const runs = [
    {
      id: "run_local_worker_summary_gap",
      name: "毎日の作業を相談しながら自動化したい",
      status: "partial",
      objective: "毎日の作業を相談しながら自動化したい",
      created_at: "2026-06-16T03:00:00.000Z",
      updated_at: "2026-06-16T03:00:00.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        plan: {
          tasks: [{ adapter: "local_worker", resources: ["local_worker"] }]
        },
        proof_summary: "partial: worker receipts captured, actual execution is not verified"
      })
    },
    {
      id: "run_codex_cli_summary_gap",
      name: "Codex CLI receipt-only task",
      status: "blocked",
      objective: "Codex CLI receipt-only task",
      created_at: "2026-06-16T03:01:00.000Z",
      updated_at: "2026-06-16T03:01:00.000Z",
      metadata_json: JSON.stringify({
        receipt_only: true,
        plan: {
          tasks: [{ adapter: "codex_cli", resources: ["codex_cli"] }],
          lanes: [{ role: "Codex CLI", resourceLocks: ["codex_cli"] }]
        },
        proof_summary: "partial: worker receipts captured, actual execution is not verified"
      })
    },
    {
      id: "run_real_receipt_partial",
      name: "Real receipt-only work",
      status: "partial",
      objective: "Real receipt-only work",
      created_at: "2026-06-16T02:58:00.000Z",
      updated_at: "2026-06-16T02:58:00.000Z",
      metadata_json: JSON.stringify({
        worker_mode: "receipt_only",
        proof_summary: "partial: worker receipts captured, actual execution is not verified"
      })
    }
  ];

  assert.deepEqual(
    selectors.filterSupersededResumeRuns(runs).map((run) => run.id),
    ["run_local_worker_summary_gap", "run_codex_cli_summary_gap", "run_real_receipt_partial"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_local_worker_summary_gap");
  assert.deepEqual(
    selectors.selectAttentionRuns(runs).map((run) => run.id),
    ["run_local_worker_summary_gap", "run_codex_cli_summary_gap", "run_real_receipt_partial"]
  );
});

test("selectActionQueueRuns returns only current resume and approval statuses", () => {
  const runs = [
    {
      id: "run_queued_qa_history",
      name: "Queued QA history",
      status: "queued",
      objective: "Queued QA history",
      created_at: "2026-06-16T04:00:00.000Z",
      updated_at: "2026-06-16T04:00:00.000Z"
    },
    {
      id: "run_cancelled_nisenprints_history",
      name: "Cancelled NisenPrints history",
      status: "cancelled",
      objective: "Cancelled NisenPrints history",
      created_at: "2026-06-16T04:01:00.000Z",
      updated_at: "2026-06-16T04:01:00.000Z"
    },
    {
      id: "run_complete_history",
      name: "Complete history",
      status: "complete",
      objective: "Complete history",
      created_at: "2026-06-16T04:02:00.000Z",
      updated_at: "2026-06-16T04:02:00.000Z"
    },
    {
      id: "run_blocked_action",
      name: "Blocked action",
      status: "blocked",
      objective: "Blocked action",
      created_at: "2026-06-16T04:03:00.000Z",
      updated_at: "2026-06-16T04:03:00.000Z"
    },
    {
      id: "run_partial_action",
      name: "Partial action",
      status: "partial",
      objective: "Partial action",
      created_at: "2026-06-16T04:04:00.000Z",
      updated_at: "2026-06-16T04:04:00.000Z"
    },
    {
      id: "run_waiting_approval_action",
      name: "Waiting approval action",
      status: "waiting_approval",
      objective: "Waiting approval action",
      created_at: "2026-06-16T04:05:00.000Z",
      updated_at: "2026-06-16T04:05:00.000Z"
    }
  ];

  assert.deepEqual(
    selectors.selectActionQueueRuns(runs).map((run) => run.id),
    ["run_blocked_action", "run_partial_action", "run_waiting_approval_action"]
  );
});

test("legacy non-billing approval-gate runs stay out of action queue", () => {
  const runs = [
    {
      id: "run_legacy_sns_approval_gate",
      name: "SNS Multi Poster Ukiyoe registered workflow billing-only post publish",
      status: "blocked",
      objective: "SNS Multi Poster Ukiyoe registered workflow billing-only post publish",
      created_at: "2026-06-20T15:32:42.000Z",
      updated_at: "2026-06-20T15:32:42.000Z",
      metadata_json: JSON.stringify({
        externalActionBoundary: "billing_purchase_payment_checkout_hard_stop",
        defaultHardStops: ["billing", "purchase", "payment", "checkout"],
        plan: {
          approvalRequired: true,
          tasks: [
            {
              adapter: "sns_multi_poster_registered",
              dangerousAction: true,
              requiresApproval: true,
              resources: ["social_publish"]
            }
          ]
        }
      })
    },
    {
      id: "run_payment_hard_stop",
      name: "Proceed to payment checkout",
      status: "waiting_approval",
      objective: "Proceed to payment checkout",
      created_at: "2026-06-20T15:33:00.000Z",
      updated_at: "2026-06-20T15:33:00.000Z",
      metadata_json: JSON.stringify({
        plan: {
          approvalRequired: true,
          tasks: [{ requiresApproval: true, resources: ["payment"] }]
        }
      })
    }
  ];

  assert.deepEqual(
    selectors.selectActionQueueRuns(runs).map((run) => run.id),
    ["run_payment_hard_stop"]
  );
});

test("registered workflow latest runs hide older actionable duplicates", () => {
  const runs = [
    {
      id: "run_daily_closeout_partial",
      name: "Daily AI external publish closeout import",
      status: "partial",
      objective: "Daily AI external publish closeout import",
      created_at: "2026-06-19T02:00:00.000Z",
      updated_at: "2026-06-19T02:10:00.000Z",
      metadata_json: JSON.stringify({
        registeredWorkflowId: "daily-ai-research-publish-run",
        proof_gate: {
          ok: false,
          present: ["preflight_clearance", "daily_ai_publish", "daily_ai_cleanup"],
          missing: ["engagement_platform_missing:x"]
        }
      })
    },
    {
      id: "run_sns_latest_blocked",
      name: "SNS registered workflow boundary",
      status: "blocked",
      objective: "SNS registered workflow boundary",
      created_at: "2026-06-19T01:40:00.000Z",
      updated_at: "2026-06-19T01:45:00.000Z",
      metadata_json: JSON.stringify({
        plan: { tasks: [{ adapter: "sns_multi_poster_registered" }] },
        proof_gate: {
          ok: false,
          present: ["sns_multi_poster_human_input_required_with_evidence"],
          missing: ["sns_multi_poster_external_post_not_executed"]
        }
      })
    },
    {
      id: "run_job_manager_latest_blocked",
      name: "Job Application Manager registered workflow billing-only inbox readback and submit",
      status: "blocked",
      objective: "Job Application Manager registered workflow billing-only inbox readback and submit",
      created_at: "2026-06-19T01:20:00.000Z",
      updated_at: "2026-06-19T01:25:00.000Z",
      metadata_json: JSON.stringify({
        registeredWorkflowId: "job-application-manager",
        plan: { tasks: [{ adapter: "job_submit_registered" }] }
      })
    },
    {
      id: "run_job_followup_legacy_blocked",
      name: "Job Application Post-Application Manager registered workflow billing-only send follow-up",
      status: "blocked",
      objective: "Job Application Post-Application Manager registered workflow billing-only send follow-up",
      created_at: "2026-06-18T22:30:00.000Z",
      updated_at: "2026-06-18T22:35:00.000Z",
      metadata_json: JSON.stringify({
        registered_workflow_id: "job-application-follow-up-inbox-2",
        plan: { tasks: [{ adapter: "job_followup_registered" }] }
      })
    },
    {
      id: "run_job_submit_legacy_blocked",
      name: "Job Application Daily Submit Queue registered workflow billing-only submit",
      status: "blocked",
      objective: "Job Application Daily Submit Queue registered workflow billing-only submit",
      created_at: "2026-06-18T22:20:00.000Z",
      updated_at: "2026-06-18T22:25:00.000Z",
      metadata_json: JSON.stringify({
        registeredWorkflowId: "job-application-daily-submit-queue",
        plan: { tasks: [{ adapter: "job_submit_registered" }] }
      })
    },
    {
      id: "run_daily_old_blocked",
      name: "Daily AI registered workflow run full flow",
      status: "blocked",
      objective: "Daily AI registered workflow run full flow",
      created_at: "2026-06-18T22:00:00.000Z",
      updated_at: "2026-06-18T22:05:00.000Z",
      metadata_json: JSON.stringify({
        registered_workflow_id: "daily-ai-research-publish-run",
        proof_gate: {
          ok: false,
          missing: ["daily_ai_runner_exit_nonzero"],
          present: ["daily_ai_runner_started"]
        }
      })
    },
    {
      id: "run_sns_old_blocked",
      name: "SNS registered workflow old boundary",
      status: "blocked",
      objective: "SNS registered workflow old boundary",
      created_at: "2026-06-18T21:00:00.000Z",
      updated_at: "2026-06-18T21:05:00.000Z",
      metadata_json: JSON.stringify({
        plan: { tasks: [{ adapter: "sns_multi_poster_registered" }] },
        proof_gate: {
          ok: false,
          present: ["sns_multi_poster_human_input_required_with_evidence"],
          missing: ["sns_multi_poster_external_post_not_executed"]
        }
      })
    }
  ];

  assert.deepEqual(
    selectors.aggregateLatestRegisteredWorkflowRuns(runs).map((run) => run.id),
    ["run_daily_closeout_partial", "run_sns_latest_blocked", "run_job_manager_latest_blocked"]
  );
  assert.equal(selectors.selectResumeCandidateRun(runs)?.id, "run_daily_closeout_partial");
  assert.deepEqual(
    selectors.selectActionQueueRuns(runs).map((run) => run.id),
    ["run_daily_closeout_partial", "run_sns_latest_blocked", "run_job_manager_latest_blocked"]
  );
  assert.deepEqual(
    selectors.selectAttentionRuns(runs).map((run) => run.id),
    ["run_daily_closeout_partial", "run_sns_latest_blocked", "run_job_manager_latest_blocked"]
  );
});
