# Local Worker

The command bar posts to `/api/runs/start`.

The server now creates a real run record from the command:

- decomposed tasks
- isolated lane records with CDP port, profile dir, and workdir
- grouped approval request for dangerous operations
- worker events
- worker receipt or execution proofs under `data/artifacts/<run-id>/`

For NisenPrints commands, the worker resolves a backend run contract and stores `run_contract` plus `contract_version` in `runs.metadata_json`. This contract is the durable boundary for source-of-truth, allowed scope, forbidden actions, and required proofs; the dashboard only shows the beginner mode and short progress.

Worker receipts use Codex CLI, ChatGPT subscription, and Playwright CLI as primary local UI lanes. Browser Use recording/Gemini checks are auxiliary diagnostic and veto surfaces unless a dedicated workflow contract explicitly requires them. `OPENAI_API_KEY` is not required.

`npm run worker:once` processes queued or approved runs from SQLite. The default worker mode is `receipt_only`: it records the exact Codex CLI, Browser Use CLI, or legacy diagnostic command and proof artifact without sending real external posts. For code, QA, review, fix, investigation, and read-only verification tasks, the planner routes the step to `child_codex`. This is a connected local read-only child Codex executor: the worker writes `data/artifacts/<run-id>/<step-id>-child-prompt.txt`, runs `codex exec --sandbox read-only --cd <cwd> <prompt>` using `AUTOMATION_OS_CHILD_CODEX_BIN` or `codex`, bounds it with `AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS`, and stores stdout/stderr tails plus exit/timeout state in `<step-id>-child-result.json` and `child_runs`.

`npm run worker:loop:stored` is the local Mac bridge for production control-plane use. Save the same production PostgreSQL `DATABASE_URL` used by Zeabur into Automation OS once, keep the Codex CLI logged in with the ChatGPT subscription, and run the loop on the Mac instead of putting `~/.codex/auth.json` on Zeabur. The loop calls `runWorkerOnce()` repeatedly, prints JSON cycle receipts, and uses `AUTOMATION_OS_CHILD_CODEX_BIN` / `AUTOMATION_OS_CODEX_BIN` or `codex`. It does not require `OPENAI_API_KEY`; if API keys are present, the startup receipt says so.

Production Replay QA treats this split as a hard operating boundary. Zeabur is the control plane for UI, API, PostgreSQL state, write guard, and readback. Subscription-backed planning, local Playwright/browser automation, CDP lanes, screenshots, cleanup, and external-service proof capture stay on the Mac worker. Do not describe Zeabur as a standalone hosted AI planner or hosted browser runner unless a separate hosted planner/browser lane is explicitly configured and verified.

For production, the preferred safe path is to store the PostgreSQL connection in the local Automation OS secret store, then use the stored-secret wrappers:

- Paste `DATABASE_URL=postgresql://...` into Create/top bar once. Automation OS stores it as `本番PostgreSQL接続` and redacts the value from UI and notes.
- Run `npm run worker:production-proof:stored` to create a safe proof run in production PostgreSQL and prove the Mac worker can pick it up.
- Run `npm run worker:loop:stored` for continuous pickup without printing the database URL.

The LaunchAgent template `ops/launchd/com.nichikatanaka.automation-os-worker.plist` runs `scripts/start-automation-os-worker.sh`, which calls `npm run worker:loop:stored`. It intentionally contains no database URL or token. Only install or kickstart it after `worker:production-proof:stored` passes.

Successful child runs record `child_codex_result`, `run_steps.metadata_json.execution_mode='child_codex'`, and `runs.metadata_json.worker_mode='execute_child_codex'`. Nonzero exit, spawn errors, and timeout record `child_codex_blocked` and keep the run blocked. If a run mixes `child_codex` with non-executed receipt-only steps, the run remains `partial` until every receipt-only step has actual execution proof or manual verification. Missing receipt proof is still recorded as `actual_execution_or_manual_verification:<step-id>`; child Codex results do not satisfy external/browser/publish proof gaps.

`POST /api/codex/app-server/probe` is a separate read-only inventory probe. It is default-off, bounded by `AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND`, `AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TIMEOUT_MS`, and `AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TTL_MS`, and it only refreshes capability readback. A successful initialize response still does not become authority, external action proof, or completion proof.

When `AUTOMATION_OS_EXECUTE_CODEX=1` and a legacy step adapter is `codex_cli`, the worker can still run `codex exec --sandbox read-only` and stores the result as `mode=execute_codex_readonly` in `data/artifacts/<run-id>/<step-id>.json`. Tests can set `AUTOMATION_OS_CODEX_BIN` or `AUTOMATION_OS_CHILD_CODEX_BIN` to fake executables; command display remains the normal Codex CLI shape. When shared commit resources collide, the approval request includes `collision:<resource>` so approved all-parallel execution is explicit. Real irreversible browser actions should be enabled per workflow after the approval and proof gates are locked for that workflow.

`npm run clean:dev-data -- --dry-run` reports what would be cleared without deleting anything. Real cleanup is treated as dangerous: it only runs with both `--force` and `AUTOMATION_OS_ALLOW_CLEAN_DEV_DATA=1`. Before deletion, Automation OS copies the SQLite database files and writes an artifacts manifest under `data/backups/clean-dev-data-<timestamp>/`, then resets SQLite rows and removes `data/artifacts/`.

`npm run obsidian:export` generates an Obsidian-friendly LLM Wiki under `02_Systems/automation-os` in the configured vault. Set `AUTOMATION_OS_OBSIDIAN_VAULT` to override the default vault path. The exporter only overwrites Markdown files that have `generated_by: automation-os` in frontmatter. Existing generated files are backed up and replaced through a temporary file rename; non-generated notes are refused.

Daily AI remains the first registered workflow executor. Current registered Daily AI execution is Playwright CLI primary through the workflow-owned runner, summary, queue readback, and artifact proof. Browser Use recording/Gemini outputs are auxiliary diagnostic/veto evidence unless a dedicated Daily AI registration contract explicitly names a Browser Use-native runner. Historical Browser Use migration notes and Browser Use-only runners are not the current generic local UI completion contract. The spawn has a bounded timeout from `AUTOMATION_OS_DAILY_AI_TIMEOUT_MS`, defaulting to 30 minutes.

Daily AI can only become `complete` when the registered summary has `full_flow_completion.ok === true`, all required registered stages, cleanup proof, and workflow-owned source-of-truth readbacks. Recording/Gemini evidence can strengthen the run and must veto a contradictory completion claim, but it does not replace the Playwright CLI registered summary or queue/artifact proof. A complete run records `daily_ai_publish`, `daily_ai_feed_study`, `daily_ai_engagement`, `daily_ai_sync`, `daily_ai_buffer`, `daily_ai_cleanup`, and `daily_ai_registered_summary` proofs. Partial/blocked runs record only the stages that actually exist; missing workflow-owned proofs stay in `proof_gate.missing`.

NisenPrints and other registered workflows use their workflow-owned registered runner contracts. Browser Use-native runners remain valid only for workflows whose Skill/runner contract explicitly says so, such as historical or dedicated Browser Use registration paths. Generic Automation OS local UI completion remains Playwright CLI primary. Other registered runners may attach Gemini video QA as auxiliary visual audit evidence. Matching audits can appear as `gemini_video_qa` proof and contradictory audits can block a claimed completion, but Gemini QA does not replace workflow-owned proofs such as `pinterest_pin_url_verified` or `etsy_visit_site_match_verified`.

Job and other generic registered Codex automations receive `AUTOMATION_OS_REGISTERED_SUMMARY_PATH` for an optional registered summary sidecar. When that sidecar contains `gemini_video_qa`, `visual_audit`, or `stage_visual_audits`, the worker ingests it as auxiliary visual evidence. A contradiction can veto an otherwise successful Codex exit, while a matching audit cannot turn a failed Codex run into completion.
