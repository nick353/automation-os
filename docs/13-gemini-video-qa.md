# Gemini Video QA Contract

Gemini video QA is a shared visual auditor for registered automations. It reviews stage videos, screen recordings, or screenshot sequences after a runner has produced normal workflow artifacts. It does not replace the registered entrypoint, workflow source of truth, stage observation ledger, exact blocker, or strict completion gate.

## Contract

- Browser/UI verification for Automation OS local checks and registered automation stages uses Playwright CLI as the primary local verification lane. Completion proof must come from workflow-owned artifacts such as target URL, DOM/snapshot, screenshot, console readback, exact blocker, and cleanup/readback evidence where applicable.
- Recording and Gemini video QA are auxiliary proof and completion-veto surfaces. A matching audit can strengthen the evidence, and a QA mismatch against a claimed completion becomes a completion veto. Missing recording/Gemini proof does not by itself fail generic Playwright CLI checks and must not fill missing workflow-required proofs.
- Runners may attach `gemini_video_qa`, `visual_audit`, or `stage_visual_audits` to their registered summary JSON. Each audit should include `stage`, `status`, `verdict`, `completion_gate_alignment`, `artifact_uri`, `video_artifact_uri`, `exact_blocker`, and `repair_owner` when known.
- Automation OS records matching audits as `gemini_video_qa` proofs. These proofs are auxiliary and are not required for completion by default for generic Playwright CLI checks or non-browser registered runners.
- If a registered summary claims completion and Gemini video QA reports `failed`, `blocked`, `mismatch`, `conflict`, `completion_gate_matches=false`, or an explicit contradictory blocker, Automation OS blocks the completion with `gemini_video_qa_completion_alignment`.

## Normalized Stage Ledger

Each accepted audit is normalized into `metadata.gemini_video_qa.stage_ledger[]` and copied to proof metadata as `normalized_stage_ledger`. The ledger fields are: `source_key`, `stage`, `status`, `verdict`, `completion_gate_alignment`, `completion_gate_matches`, `artifact_uri`, `video_artifact_uri`, `exact_blocker`, `repair_owner`, `auxiliary_proof`, `completion_claimed`, and `contradicts_completion`.

`auxiliary_proof` is always `true` for Gemini video QA. `completion_claimed` mirrors the workflow-owned completion gate, and `contradicts_completion` is the veto signal used only when completion was claimed. A matching Gemini audit may become present proof, but it must not fill missing workflow-required proofs.

## Registered Codex Summary Sidecar

Generic registered Codex automations receive `AUTOMATION_OS_REGISTERED_SUMMARY_PATH`. If the child runner has a registered summary or visual audit, it should write JSON to that path. Automation OS ingests that sidecar after the child exits and applies the same auxiliary proof plus completion veto contract used by dedicated runners.

The sidecar is an ingestion contract only. It does not call Gemini, upload video, or make visual QA required. Visual audit entries must reference already-redacted `artifact_uri` / `video_artifact_uri` evidence and should only be written when `allowed_external_analysis` and `redaction_status` are satisfied by the workflow-owned runner.

## Recording Sidecar

Automation OS diagnostic recording checks call a recording sidecar through `AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR` when set, otherwise the built-in CDP screencast recorder is used in built server runs. The sidecar is invoked only for a CDP/profile lane and receives `--manifest`, `--recording`, `--gemini-qa`, `--target-url`, `--session`, `--cdp-url`, and optional `--profile` arguments. Extra static arguments can be supplied with `AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR_ARGS`.

The sidecar must write the tab/window recording to the provided `recording.mp4` path and the Gemini QA JSON to the provided `gemini-video-qa.json` path in the same artifact directory. The built-in sidecar records frames through CDP `Page.startScreencast`, encodes MP4 with `ffmpeg`, then calls `AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNER` with `--video`, `--output`, `--manifest`, and `--target-url`. If that Gemini runner is missing or fails, the recording remains on disk and the diagnostic recording check stays blocked instead of inventing a successful QA result.

## Source-Of-Truth Boundary

The visual auditor can explain UI behavior that code receipts miss: stalled clicks, repeated navigation, wrong target surfaces, wasted retries, or a visible success/failure difference. It can only strengthen the gate. It must not convert a partial run into complete, skip workflow proofs, or override workflow-owned artifacts.

The repair owner should point to the durable layer that must change next: runner code, Skill/docs, registered `automation.toml`, stage observation capture, or workflow-specific verifier.
