# Obsidian Export

Automation OS can export a small LLM Wiki into Obsidian.

Default vault:

`/Users/nichikatanaka/Documents/Obsidian Vault`

Output folder:

`02_Systems/automation-os`

Control Panel folder:

`01_Control Panel`

Codex app work folders:

`05_Projects`, `06_Research`, `07_Decisions`, `08_Runbooks`, `09_Inbox`

Command:

`npm run obsidian:export`

Inbox ingest command:

`npm run obsidian:ingest -- --source-type=article --source-url=https://example.com --source-title="Example" --text="capture text"`

If `--text` is omitted, the ingest CLI reads Markdown/plain text from stdin:

`printf '%s\n' "capture text" | npm run obsidian:ingest -- --source-type=note --source-title="Quick capture"`

URL capture command:

`npm run obsidian:url-capture -- --url=https://example.com --source-title="Example"`

Authenticated X/Twitter capture command:

`npm run obsidian:x-auth-capture -- --url=https://x.com/example/status/123`

The authenticated X/Twitter capture command is read-only and separate from URL capture. It requires the fixed `x_learning_authenticated_cdp` lane on CDP `9336` and refuses to use `9333`, `9334`, `9335`, or `9222`. It only accepts exact-host `x.com` or `twitter.com` status/thread read URLs such as `https://x.com/<handle>/status/<id>` and `https://x.com/i/web/status/<id>`, and rejects posting, DM, settings, notification, intent, compose, login-flow, home, search, explore, subdomain, and other non-status surfaces. It reads `document.title`, `location.href`, and allowlisted tweet/thread body containers through CDP: the primary candidate is `article [data-testid='tweetText']`, and only when that primary selector has zero non-empty candidates does it add `article.innerText:fallback` candidates from `article`. It writes redacted artifacts under `data/artifacts/authenticated-browser-captures/<captureId>/`, and ingests only that redacted tweet/thread text with `source_type: authenticated_browser_capture`. If extraction lands on a valid X/Twitter read URL but returns zero raw text candidates, capture retries the same bounded extraction up to three total attempts before saving the extract stage. URL drift, non-allowlisted candidates, empty allowlisted candidates, and Runtime.evaluate parser blockers stay fail-closed without retry. `stage-extract.json` and `manifest.json` record the final candidate stats plus `extractionAttemptCount` and redacted attempt summaries containing only current URL, candidate counts, and blocker classification. They do not store per-attempt body text. If no allowlisted body text is available, it records a specific exact blocker such as `x_auth_capture_no_text_candidates`, `x_auth_capture_empty_text_candidates`, or `x_auth_capture_non_allowlisted_text_candidates` plus candidate counts in the extract stage and manifest instead of saving sidebar, account, trends, nav, or full-page text. It never reads or stores `document.body.innerText`, `document.documentElement.innerText`, raw HTML/DOM, cookies, localStorage, or raw auth/session material. Screenshots are skipped unless DOM redaction for sidebars, accounts, and media is proven before saving; the skip reason is recorded as an exact stage blocker in `stage-extract.json`.

YouTube transcript capture command:

`npm run obsidian:youtube-transcript-capture -- --url=https://www.youtube.com/watch?v=VIDEO_ID`

The YouTube transcript capture command is read-only and separate from URL capture. It requires the fixed `youtube_visible_transcript_cdp` lane on CDP `9337` and refuses fallback to Daily AI, job, NisenPrints, X learning, or main Chrome lanes. It accepts only `https://www.youtube.com/watch?v=...`, `https://youtube.com/watch?v=...`, `https://m.youtube.com/watch?v=...`, or `https://youtu.be/...`. It rejects Studio, upload, Shorts, account, and non-video surfaces. The CDP expression may click only a visible official transcript control to reveal the panel, then reads only `ytd-transcript-segment-renderer` rows inside the official transcript panel. If that panel is not visible, capture blocks instead of saving page-like text. It does not read raw DOM, full-page body text, cookies, localStorage, comments, sidebar text, account menus, ads, or recommendations. It writes redacted artifacts under `data/artifacts/youtube-transcript-captures/<captureId>/` and ingests only the redacted transcript text with `source_type: youtube_transcript_capture`.

X capture review queue command:

`npm run x-capture:review`

The X capture review command reads only `09_Inbox/X-auth-capture-*.md`, classifies captured posts into local reuse categories, writes `data/x-capture-review/review-YYYYMMDD.json`, and generates `01_Control Panel/X Capture Review Queue.md`. It does not fetch URLs, move notes, post, publish, send, submit, delete, or change browser sessions. A custom vault can be passed with `--vault=/path/to/vault`, but that override is refused unless `AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT=1` is set.

Optional reason:

`npm run obsidian:export -- --reason=codex_stop_hook`

Second Brain processor command:

`npm run second-brain:process`

This processor defaults to dry-run. Use `npm run second-brain:process -- --apply` to update notes. A custom vault can be passed with `--vault=/path/to/vault`, but that override is refused unless `AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT=1` is set for a controlled maintenance run.
The core processor, CLI, Bridge, API, and ingest command share the same custom vault guard, and repeat Bridge/API apply runs are idempotent: already processed notes stay `unchanged`, keep their original `processed_at`, and do not create another backup.

Second Brain ingest captures caller-provided text only. It does not fetch URLs, post, send, submit, publish, apply, buy, delete, change browser sessions, or write outside the Obsidian vault. It writes one new Markdown file directly under `09_Inbox/` with `kind: inbox`, `needs_classification: yes`, `auto_process: obsidian_internal_only`, `processing_status: queued`, `suggested_destination: unknown`, source pointer metadata, and both external-action flags set to false. `generated_by` is deliberately omitted so the note remains a handwritten-style classification candidate. `09_Inbox` must be a real directory; symlinks and non-directories are blocked, and the final realpath must stay inside the vault. Filenames are sanitized from `sourceTitle` or `sourceType`, and collisions become `-2`, `-3`, and so on.

URL capture is a guarded wrapper around the same ingest path. It only accepts `http` and `https`, rejects localhost, private, link-local, and metadata IP targets before fetch, follows redirects manually, and blocks redirects that resolve to private targets. Fetches have a timeout and byte cap, and only HTML/plain text bodies are converted into readable text. A successful capture writes one `09_Inbox/` note with `source_type: url_capture`.

When URL capture cannot safely produce a readable note, it returns a blocked result instead of pretending success. X/Twitter, login walls, JavaScript-only pages, HTTP 401/403, unsupported or unextractable bodies, fetch timeout/failure, byte-limit failures, and private redirects are recorded with an `exactBlocker`. Blocked captures write `manifest.json`, `blocker.json`, `response.json`, and `content.txt` under `data/artifacts/url-captures/<captureId>/`, then create a `09_Inbox/` blocker note with `source_type: url_capture_blocked` and a pointer to that artifact directory. URLs, headers, and content snippets are redacted before they are written to artifacts or notes.

Authenticated browser captures write `manifest.json`, `stage-open.json`, `stage-extract.json`, `page-redacted.json`, `body-redacted.txt`, and `ingest.json` under `data/artifacts/authenticated-browser-captures/<captureId>/`. `stage-open.json` proves the fixed lane target open. `stage-extract.json` records the read-only extraction methods, bounded retry attempt summaries, and any screenshot skip blocker. `page-redacted.json` and `body-redacted.txt` contain only the final accepted redacted text, never raw DOM or per-attempt body text.

Research Planner URL captures record `readable_source_snapshot:web` proof on the started run after a successful guarded URL capture, then re-evaluate the Research Planner proof boundary. This is readable server-side URL evidence, not browser-visible DOM/screenshot proof.

YouTube transcript captures write `manifest.json`, `stage-open.json`, `stage-transcript.json`, `page-redacted.json`, `transcript-redacted.txt`, and `ingest.json` under `data/artifacts/youtube-transcript-captures/<captureId>/`. A successful Research Planner capture records `visible_source_snapshot:youtube` proof on the started run and then re-evaluates the Research Planner proof boundary. Blocked or rejected captures write blocker artifacts when possible but do not satisfy missing proof.

Automation OS also runs this export automatically after state-changing API operations such as starting a run, deciding an approval, importing Codex assets, ingesting research notes, or creating a skill draft. The automatic export is best-effort: if Obsidian export fails, the original API operation still succeeds and `/api/obsidian/status` records the export error.

While the server is listening, Automation OS also runs a periodic best-effort export. It is enabled by default and uses `AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS`, defaulting to 5 minutes. Set `AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS=0` to disable only the periodic timer. Manual, state-change, and periodic exports share one single-flight boundary; overlapping attempts are skipped and `/api/obsidian/status` records the skip reason. Any truthy `NODE_TEST_CONTEXT` disables auto export unless `AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT=1` explicitly enables it.

Server startup and the login recovery LaunchAgent now default to `AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT=1`, `AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS=300000`, and `AUTOMATION_OS_ALLOW_SQLITE_FALLBACK=1`. That means a normal login restore brings the server up, keeps periodic export on, and falls back to local sqlite if a stored Postgres secret exists but cannot be restored cleanly. The fallback is for recovery only; if you need Postgres again, fix the secret and restart rather than treating sqlite as a new source of truth.

The latest Obsidian export status is also persisted at `data/obsidian-export-status.json` by default, so `/api/obsidian/status` can recover the last export result after a server restart. Set `AUTOMATION_OS_OBSIDIAN_STATUS_FILE` only for isolated tests or controlled maintenance.

After a successful export, the persisted status includes `generatedFileCheck`. It verifies every generated Markdown, Bases, template, dashboard, and resume file that the exporter returned. Markdown must have `generated_by: automation-os` in frontmatter, Bases files must have `# generated_by: automation-os`, and JSON files such as `resume-contract.json` are checked for existence and mtime only with marker status `not_applicable`. The check records `ok`, `checkedAt`, `total`, `missing`, `nonGenerated`, and per-file `path`, `kind`, `exists`, `mtime`, `marker`, and `generated`.

The web app shows this same status in two places. Home shows a short beginner-facing Obsidian sync card directly under "次にやること". Sources shows the detailed card with manual refresh, last attempt/success, generated count, and a collapsed internal details section for vault/output paths. A `reason` value of `codex_stop_hook` means the export was started by the Codex Stop hook after a Codex session ended.

The Codex Stop hook also writes a short local memory handoff note under `~/.codex/memories/extensions/ad_hoc/notes/` after the export attempt. The note stores only a compact Automation OS snapshot: export status, latest run label/status, pending approval count, and the next action label. It avoids raw logs, secrets, cookies, tokens, and long browser artifacts. This keeps future local Codex sessions from needing the user to restate the current project state.

The same hook also runs `~/.codex/hooks/project-handoff-collector.mjs`. It writes a multi-project handoff note to `~/.codex/memories/extensions/ad_hoc/notes/` and refreshes `00_Start Here/Project Handoff Index.md` in the Obsidian vault. The current project set includes Daily AI / job automations, NisenPrints / Etsy, Automation OS, Apparel AI / Heavy Chain, prompt-transfer, and prompt-transfer-ukiyoe. The collector only records compact pointers: whether authority files exist, short redacted first-line summaries, and the newest artifact pointer. It does not copy raw artifacts or long logs. Project boundary rules for durable Obsidian-managed projects are defined in `docs/13-project-boundary-standard.md`; a project without project-owned `STATE.md` or an explicit current-state authority may appear as a locator, but must not be promoted to execution-ready status from generated pages alone.

Manual APIs:

`POST /api/obsidian/export`

`POST /api/obsidian/ingest`

`POST /api/obsidian/url-capture`

The ingest API accepts `sourceUrl`, `sourceTitle`, `sourceType`, `text`, `vaultPath`, and `capturedAt`. `text` is required; source fields are YAML/Markdown-quoted or fenced before writing. Ingest, URL capture, and YouTube transcript capture APIs do not accept request-provided `statusFile`, artifact paths, or other arbitrary file-write destinations. The normal API uses the configured default vault. Request-provided `vaultPath`, `outputSubdir`, or `docsDir` are blocked unless `AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT=1` is explicitly set for a controlled maintenance run. A successful ingest triggers best-effort Obsidian export with reason `obsidian-ingested`; successful URL capture returns `201` and blocked URL capture returns `202` after writing the blocker note. Validation or custom-vault refusal returns `400` or `403` and does not trigger export.

To use another vault:

`AUTOMATION_OS_OBSIDIAN_VAULT="/path/to/vault" npm run obsidian:export`

Generated files:

- `Automation OS Index.md`
- `Runs.md`
- `Proofs.md`
- `Knowledge.md`
- `Docs.md`

The export also writes `00_Start Here/Codex Daily Brief.md`, `00_Start Here/Resume Current Work.md`, and `01_Control Panel/Action Queue.md` as generated Mission Control surfaces for Codex App use. `Resume Current Work.md` is the short read-first resume brief: latest run, blocked/partial run, latest system check, latest bridge action/execution, latest knowledge note, and the latest current-project Codex session when one exists. It prefers sessions whose cwd is under `process.cwd()` or `/Users/nichikatanaka/Documents/Codex/automation-os`; unrelated global latest sessions stay out of the resume brief and remain only as locators. It writes `00_Start Here/Project Memory Map.md` as a cwd-grouped project locator from recent Codex sessions, registered automation paths, and optional `~/.codex/memories/MEMORY.md` hints. It writes `01_Control Panel/Command Queue Intake.md`, `01_Control Panel/Active Sessions.md`, `01_Control Panel/Skill Registry.md`, `07_Decisions/Decision Log.md`, and `00_Start Here/Weekly Review.md` so handwritten Obsidian requests, local skills, and recent Codex sessions can flow back into Codex planning without becoming an execution source of truth. `Active Sessions.md` reads only the 10 most recently modified jsonl files under `~/.codex/sessions`, stores mtime, session id, cwd-like value, and short redacted last user/assistant snippets, and avoids secrets, tokens, JWTs, URL credentials, cookies/session tokens, and high-entropy token strings. It writes `04_Proof Pointers/Proof Inbox.md` as the generated proof pointer inbox, and writes generated Bases dashboards in `10_Dashboards/*.base` for Automation, Action Queue, Proof, Decision, and Second Brain Review views. It writes `01_Control Panel/Automation Control Panel.md` as a read-only registered automation inventory. It refreshes generated orientation indexes in `05_Projects/Project Index.md`, `06_Research/Research Index.md`, `07_Decisions/Decision Index.md`, `08_Runbooks/Runbook Index.md`, and `09_Inbox/Inbox Index.md`. It also refreshes generated Codex work templates in `90_Templates/`. These files are separate from the five LLM Wiki files so API clients that rely on the existing file list keep the same contract.

`Resume Current Work.md`, `Codex Daily Brief.md`, `Weekly Review.md`, and `Action Queue.md` keep run history separate from current attention. Receipt-only partials that are clearly QA, test-only, local check, demo, or read-only verification gaps stay in `Runs.md`, but they are filtered out of the main resume candidate and action queue. Real receipt-only work remains visible until it is completed or explicitly superseded.

Second Brain v2 adds three generated surfaces outside the five-file LLM Wiki contract: `01_Control Panel/Second Brain Intake.md`, `01_Control Panel/Second Brain Auto Processor.md`, and `00_Start Here/Second Brain Weekly Digest.md`. `Second Brain Intake.md` reads only handwritten notes under `09_Inbox` with `kind: inbox` or `needs_classification` / `needsClassification: yes`; generated notes with `generated_by: automation-os`, regular `kind: research` notes, README-style notes, and generated indexes are not classification candidates. It preserves redacted `source_url` / `sourceUrl`, `capture_type` / `captureType` / `source_type` / `sourceType`, and redacted `source_of_truth` / `sourceOfTruth` when present, and otherwise uses conservative URL/destination inference. `suggested_destination` / `suggestedDestination` is normalized to the allowlist `05_Projects`, `06_Research`, `07_Decisions`, `08_Runbooks`, `09_Inbox`, or `unknown`; invalid raw values are not displayed and are kept as `unknown`. Weak matches stay as `unknown` or `09_Inbox` rather than being forced into Projects, Research, Decisions, or Runbooks.

`Second Brain Auto Processor.md` is the auto-approved internal boundary. Its frontmatter declares `kind: second-brain-auto-processor`, `auto_approval_boundary: obsidian_internal_only`, and `approval_mode: auto_obsidian_internal`. The pipeline is Capture -> Normalize -> Classify -> Distill -> Draft -> Link -> Review Digest. Auto-approved work is limited to Obsidian-internal knowledge processing: reading handwritten notes, redacting source pointers, normalizing metadata, classifying to the allowlist, drafting Obsidian-only summaries, linking notes, and exposing review metadata. External operations still require approval: publishing, sending, submitting, applying, buying, deleting, external service writes, workflow-owned state/queue/artifact/DB changes, credential or browser session changes, and destinations outside the Second Brain allowlist.

`second-brain:process` is the note-mutating implementation of that internal boundary. It only scans handwritten notes under `05_Projects`, `06_Research`, `07_Decisions`, `08_Runbooks`, and `09_Inbox`, and only updates notes that explicitly opt in with `auto_process: obsidian_internal_only` or `needs_classification: true` / `needsClassification: true`. Generated Automation OS notes, workflow-owned notes, and non-opt-in notes are skipped. Notes with `external_action_required: true` or `approval_required: true` are blocked and left unchanged. Invalid `suggested_destination` values are normalized to `unknown`.

When `suggested_destination` is missing or explicitly `unknown`, the processor builds conservative note signals from source/capture type, source title, title, body excerpts, frontmatter pointers, and observed content categories, then scores only the allowlist folders. Existing valid destinations are preserved, invalid raw destinations remain `unknown`, and weak matches fall back to `09_Inbox`. Once the processor has written `processing_status: review_ready`, `processed_by: automation-os-second-brain-processor`, and canonical `suggested_destination: unknown`, a later processor run preserves that canonical unknown only when processor-owned review metadata no longer contains placeholders. Legacy processed unknown notes that still have placeholder `progressive_summary`, `distillation`, `next_use`, `unresolved_question`, or `review_cycle` are re-inferred from observed note content, and placeholder metadata is regenerated.

The processor updates only Obsidian-internal frontmatter fields such as `processing_status`, `suggested_destination`, `progressive_summary`, `distillation`, `next_use`, `unresolved_question`, `review_cycle`, `processed_by`, and `processed_at`. It removes stale camelCase aliases for processor-owned fields (`suggestedDestination`, `nextUse`, `unresolvedQuestion`, `reviewCycle`, `externalActionRequired`, and `approvalRequired`) from the output frontmatter. If a note has `sourceUrl` or `sourceOfTruth` and the snake_case canonical key is missing, the processor writes `source_url` or `source_of_truth` and removes the camelCase alias so the source pointer remains queryable. Before an apply update, it may write a same-vault backup copy under `.backups/second-brain-processor/`; outside that backup exception, it does not move, rename, delete, publish, submit, send, or write outside the Obsidian note being processed. The note body is preserved; the processor is metadata normalization, not external execution permission.

`Second Brain Weekly Digest.md` summarizes handwritten notes in `05_Projects`, `06_Research`, `07_Decisions`, `08_Runbooks`, and `09_Inbox` by folder, kind, status, redacted source of truth, unclassified count, and next review moves. It is a review digest only; it does not canonicalize notes, move files, or make external writes. All Second Brain pages explicitly preserve redacted source pointers and keep external work behind approval. `10_Dashboards/Second Brain Review.base` shows `auto_process`, `processing_status`, `suggested_destination`, `progressive_summary`, `source_of_truth`, and `external_action_required` so the queue can be reviewed inside Obsidian without treating suggestions as external execution permission.

`/api/obsidian/status` exposes `secondBrainPolicy` with `autoApprovedScopes` and `approvalRequiredScopes` so UI clients and stop-hook summaries can show the same boundary that the generated Obsidian files use. The persisted status JSON also keeps `secondBrainReviewMetadata` defaults for `auto_process`, `processing_status`, `suggested_destination`, `progressive_summary`, `source_of_truth`, `external_action_required`, and `approval_required`, and normalizes older status files that predate those fields.

The export reads SQLite `runs`, `proofs`, recent `system_checks`, `bridge_actions`, `bridge_executions`, `knowledge_notes`, local `docs/*.md`, the read-only Codex capability inventory for registered automations, recent Codex session jsonl summaries, and frontmatter from handwritten notes in the Codex app work folders. It also reads `01_Control Panel/Command Queue.md` and handwritten `09_Inbox/*.md` notes for unchecked command candidates and Second Brain classification candidates. It writes Markdown with Obsidian wiki links such as `[[Runs]]`, `[[Proofs]]`, `[[Knowledge]]`, and `[[Docs]]`. Artifact bodies stay in their original locations; Obsidian stores durable pointers and summaries so an LLM can quickly understand current state, evidence, UI verification, saved credential reuse policy, Trusted Bridge boundaries, executor status, design rules, registered automation pointers, Codex daily brief, resume brief, active session locator, command queue intake, Second Brain intake, Second Brain auto processor, action queue, proof inbox, weekly review, Bases dashboards, project notes, research notes, decision records, runbooks, and inbox captures.

Knowledge refresh:

`POST /api/knowledge/refresh`

This creates reusable notes for the current operating snapshot, saved credential reuse policy, Trusted Bridge approval/executor boundary, and latest UI verification proof. The explicit refresh endpoint updates the local knowledge surface and returns without running the full Obsidian export inline, so the UI can reload the dashboard immediately. Use `POST /api/obsidian/export` when the vault files need to be written right away; other state-changing APIs can still refresh knowledge before their own best-effort export boundary.

The command is safe to rerun only for Automation OS generated files. Each generated Markdown file has `generated_by: automation-os` in frontmatter, and each generated Bases file has `# generated_by: automation-os`. `resume-contract.json` is JSON and does not use frontmatter. If a target Markdown or Bases file already exists without the appropriate marker, export refuses to overwrite it.

When a generated file is overwritten, the previous copy is saved under `.backups/<timestamp>/` in that file's output folder. The five LLM Wiki files are backed up under `02_Systems/automation-os/.backups/`; Mission Control and Control Panel files are backed up under their own folder `.backups/`; Codex app work indexes and generated templates are backed up under their own folder `.backups/`. New content is written to a temporary file first and then renamed into place.

Generated backup retention is automatic after each export. For each generated output folder's `.backups/`, Automation OS keeps the 10 newest generated timestamp directories by default and deletes older generated timestamp directories. Set `AUTOMATION_OS_OBSIDIAN_BACKUP_RETENTION_COUNT` to a positive integer to change the keep count; zero, negative, empty, or invalid values fall back to 10. Only timestamp directories whose contents are generated Markdown/Bases backups with `generated_by: automation-os` markers are pruned. Manual or processor backups are not pruned by this exporter: `.backups/manual-cleanup` and `.backups/second-brain-processor` are always skipped, and non-timestamp or non-generated backup directories are skipped. Export results and the persisted `/api/obsidian/status` JSON include optional `backupRetention: { keepCount, prunedDirs, skippedDirs }` so maintenance runs can see what was deleted or preserved.
