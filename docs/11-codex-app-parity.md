# Codex App Parity

Automation OS should expose Codex App capabilities without making the beginner UI noisy.

Current rule:

- Home and New Create stay simple: chat, start, status, and approval.
- The normal UI is a public-summary surface. It may show visible flow, schedule label, last run time, public status, and evidence counts, but raw metadata, provenance, source refs, proof boundaries, artifact paths, browser target/session/CDP/profile details, and child Codex prompt/result references stay in DB/API readbacks and artifacts.
- Home may show the short Obsidian sync status card under "次にやること"; internal vault paths stay collapsed.
- The Obsidian sync card may show `generatedFileCheck` as a small health line. This is file-generation health only; it is not proof of external execution.
- Data and advanced operations show system details: Codex skills, plugin cache, automations, detailed Obsidian status, and browser readiness.
- Browser and Chrome plugin actions are bridge-backed. The local app can report readiness, but direct in-app Browser or Chrome Extension execution still requires the Codex runtime/plugin bridge.
- `child_codex` is connected for local read-only child Codex execution. It can inspect, review, test-plan, and report results back into `child_runs`, `child_codex_result` / `child_codex_blocked` proofs, and Runs detail UI.
- The UI should explicitly preserve the boundary that the external executor is not connected. Obsidian sync, local receipts, and generated handoff notes must not be presented as completed protected external work.

Implemented local API:

- `GET /api/codex/capabilities` scans local Codex skills, agent skills, plugin cache, automations, and bridge-backed capabilities.
- `GET /api/browser/health` reports Playwright CLI readiness, Browser Use CLI readiness, and the Codex Browser bridge boundary.
- `POST /api/bridge/browser-check` is the Playwright CLI primary local UI check. It only accepts local URLs, opens the app, captures a DOM snapshot, screenshot, and console-error report, stores the result in `system_checks`, shows it in Data, and triggers Obsidian auto-export. For generic Automation OS local UI work, this Playwright-owned artifact bundle is the current completion proof.
- `POST /api/bridge/browser-use-check` remains available as a diagnostic recording path for local URLs: it can capture screenshot/state/log plus recording/Gemini metadata, and blocks when its recording-specific requirements are not met. Browser Use diagnostic proof strengthens or vetoes completion, but normal Automation OS local UI completion is based on Playwright-owned DOM/screenshot/console artifacts and their readback.
- `GET /api/bridge/actions` exposes the beginner-safe Trusted Bridge catalog.
- `POST /api/bridge/actions/:id/run` runs safe local bridge actions immediately and records protected actions as approval requests without executing external work.
- `POST /api/bridge/actions/:id/execute` checks for an approved Trusted Bridge approval, then records an executor ledger entry. Until a real trusted executor is connected, it returns `bridge_executor_not_connected` and does not perform external work.
- `GET /api/runs/:id` returns `children` from `child_runs` so the UI can show child Codex public status, summary, and blocker separately from receipt-only worker receipts; prompt/result URIs remain internal references.
- `POST /api/knowledge/refresh` refreshes reusable knowledge notes for Obsidian and the Data view.
- `POST /api/obsidian/export` manually refreshes the Obsidian LLM Wiki.
- `POST /api/planner/research-plan` stores a pre-start Research Planner contract. The Create view shows Web/X/Reddit/YouTube/MCP/API toggles and the visible arrow flow; source-of-truth, proof boundary, and approval boundary details are retained internally.
- `POST /api/planner/:planId/demo` is limited to a local Automation OS Browser Use check. It must not operate external sites; X/Reddit/YouTube research starts as visible read-only browser/CDP/profile work rather than paid API usage.
- `POST /api/planner/:planId/start` creates the real run through the existing worker path and attaches `research_plan_snapshot` to run metadata. That snapshot is planning evidence only, not completion proof.
- `POST /api/planner/:planId/regularize` registers a demoed Research Planner entry in `registered_workflows` as `research_plan_registered`. The server scheduler reads those entries on a one-minute interval and starts only due Research Planner registrations; fixed native workflows remain owned by their existing registered automation entrypoints.
- `ops/launchd/com.nichikatanaka.automation-os.plist` restores the existing Automation OS server at login through `scripts/start-automation-os-server.sh`. This is a recovery mechanism for the server-hosted Research Planner scheduler, not a second scheduler daemon and not completion proof; truth remains the live server process, SQLite `registered_workflows`, and workflow-owned artifacts/provenance.
- `POST /api/planner/:planId/capture/web-url` attaches a no-API-cost readable public Web URL capture to a started Research Planner run. On success it stores `readable_source_snapshot:web` proof and re-evaluates the Research Planner proof gate. It is a guarded server-side URL capture, not browser-visible DOM/screenshot proof.
- `POST /api/planner/:planId/capture/youtube-transcript` attaches a no-API-cost read-only YouTube transcript capture to a started Research Planner run. On success it stores `visible_source_snapshot:youtube` proof and re-evaluates the existing Research Planner proof gate. Blocked or rejected captures remain missing proof.
- State-changing APIs trigger best-effort Obsidian export automatically.
- Server startup begins a periodic best-effort Obsidian export unless `NODE_TEST_CONTEXT` is truthy. `AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT=1` explicitly enables it for tests. The interval defaults to 5 minutes, can be changed with `AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS`, and `0` disables the periodic timer.
- The Codex Stop hook runs `npm run obsidian:export -- --reason=codex_stop_hook`; Sources shows that reason as "Codex終了時の自動同期" while the raw value remains in details/status JSON.
- The same Stop hook also writes a compact Codex memory handoff note to `~/.codex/memories/extensions/ad_hoc/notes/`, so the next local Codex session can recover the Automation OS state without relying only on this chat transcript.
- `/api/obsidian/status` persists and restores `generatedFileCheck` after successful export. Markdown targets require `generated_by: automation-os` frontmatter, Bases targets require `# generated_by: automation-os`, and JSON targets such as `resume-contract.json` are existence/mtime only.

Obsidian Control Panel parity:

- `01_Control Panel/Automation Control Panel.md` uses the same read-only Codex capability inventory as `GET /api/codex/capabilities`.
- `01_Control Panel/Skill Registry.md` splits the same capability inventory's skills into `codex_skill` and `agent_skill`, with short beginner-readable counts, names, ids, statuses, and paths. Plugins and registered automations remain anchored in `Automation Control Panel.md`.
- `00_Start Here/Resume Current Work.md` is the read-first Codex resume brief. It combines the latest run, blocked/partial run, latest system check, latest bridge action/execution, latest knowledge note, and the latest current-project Codex session summary into a short next-session handoff. Unrelated global latest sessions are not promoted into this brief.
- QA, test-only, local-check, demo, and read-only receipt-only verification gaps remain in run history but are not promoted as the main resume candidate or action queue item. Real receipt-only work remains visible until completed or superseded.
- `00_Start Here/Project Memory Map.md` groups recent Codex sessions by cwd, adds registered automation paths as project candidates, and lightly attaches `MEMORY.md` cwd/scope hints when available. It is a locator only; `STATE.md`, artifacts, workflow Skills/docs, and DB receipts remain authoritative.
- `01_Control Panel/Active Sessions.md` lists only the 10 newest `~/.codex/sessions/**/*.jsonl` files with mtime, session id, cwd-like value, and short redacted last user/assistant snippets. It is a locator, not a transcript export.
- `01_Control Panel/Command Queue.md` is a handwritten intake note. The export reads its unchecked tasks, plus handwritten `09_Inbox` notes, and generates `01_Control Panel/Command Queue Intake.md` as the Codex planning queue.
- `07_Decisions/Decision Log.md` and `00_Start Here/Weekly Review.md` are generated from runs, bridge executions, proofs, and command intake so Codex can see recent decisions and repeated blockers before starting new work.
- `04_Proof Pointers/Proof Inbox.md` and `10_Dashboards/*.base` are generated by the same Obsidian export, so Bases dashboards stay current after state-changing Automation OS operations.
- `01_Control Panel/Automation Control Panel.md` includes recent Research Planner entries. These are planning locators; Codex must still verify run/proof/artifact/DB readback before treating a task as complete.
- The Control Panel is an inventory and orientation surface only. Registered automation prompts, workflow Skills/docs, `STATE.md`, queues, and artifacts remain the execution source of truth.
- `05_Projects`, `06_Research`, `07_Decisions`, `08_Runbooks`, and `09_Inbox` are Codex app work surfaces. Automation OS export refreshes their generated indexes, while handwritten notes remain editable and are not overwritten unless they carry `generated_by: automation-os`.

Trusted Bridge policy:

- Safe local actions can run now: Playwright CLI local screen checks as the primary local UI proof, Browser Use recording/Gemini diagnostics, Codex capability inventory, and Obsidian export.
- Protected actions create an approval first: signed-in Chrome work, Gmail/Drive/Calendar writes, Supabase/Shopify changes, send, submit, publish, delete, billing, and payment operations.
- The approval receipt must say that the external operation has not started.
- Approved protected actions still need the executor ledger to show a connected executor and a completed receipt. If the executor is not connected, Automation OS records that fact and stops safely.
- Child Codex is not that protected executor. It is local, read-only, and cannot convert an approved-but-not-connected bridge action into completed external work.
- Execution must not be hidden behind a beginner button. Home can show "外部実行Bridgeは未接続"; Data can show the executor ledger.

Codex App capability map from the current Codex manual:

- Projects and parallel threads across local projects or worktrees.
- Skills shared with CLI and IDE Extension.
- Automations and thread automations.
- Local, Worktree, and Cloud thread modes.
- Git diff, comments, staging, commit, push, and pull request operations.
- Integrated terminal.
- In-app Browser for unauthenticated local/file/public pages.
- Browser Use through the Browser plugin.
- Chrome Extension for signed-in browser/profile work.
- Computer Use for desktop apps.
- Record & Replay for demonstrated reusable GUI workflow skills when Computer Use is available.
- MCP support, web search, image generation, non-code artifact preview, and IDE sync.

Automation OS should treat this list as a product parity backlog. Capabilities that require Codex runtime tools should be represented honestly as approval-required bridge actions until the trusted executor exists. The current bridge verifies local app screens primarily through Playwright CLI DOM/screenshot/console artifacts, keeps Browser Use recording/Gemini as diagnostic and veto evidence, prepares approval records for protected work, and records approved-but-not-connected executor attempts; it does not silently perform signed-in external browser work or irreversible plugin actions.

Record & Replay / Computer Use standard:

- Record & Replay is for stable repeated GUI workflows that are easier to demonstrate than describe, such as Dashboard readback, Runs proof drawer inspection, Schedule row-to-run checks, and operator preference capture. The output must be refined into a skill before it becomes a standard workflow.
- Computer Use is for scoped desktop app or Codex app UI work when files, APIs, connectors, and Playwright cannot prove the state. It requires app permission plus macOS Screen Recording and Accessibility.
- Screenshots are supporting evidence. Completion still requires URL/DOM or accessibility text, API/DB readback, proof rows, artifact URI, exact blocker when incomplete, and cleanup/no-residual-process proof where applicable.

Browser Use can still run session-parallel diagnostic local checks and dedicated Browser Use registration workflows. Session-only checks must clean up their temporary Browser Use window with the same `--session`; cleanup status is part of the bridge receipt. Fully separated authenticated profiles require the CDP/profile lane (`--cdp-url http://127.0.0.1:<port>` plus `--profile`), and local checks must preserve that lane rather than closing it. Send/post/publish flows still require resource locks so commits are serialized.

YouTube transcript research starts with the visible YouTube transcript UI or public captions in a dedicated browser/profile. YouTube Data API `captions.download` requires authorization, so it is not the default no-cost research route.
The connected no-cost route uses `youtube_visible_transcript_cdp` on port `9337`, opens only YouTube watch/youtu.be video URLs, reveals only the official transcript panel, saves redacted transcript artifacts, and never treats the pre-start planner snapshot as completion proof.
