# Control Panel

The MVP dashboard now opens with a beginner-first path:

- Next Actions
- NisenPrints Quick Start
- New Automation chat
- Current Run
- Running Tasks and Approval Queue

Parallel Lane Matrix, Evidence Receipts, Research Knowledge Cache, and Worker Events are advanced surfaces. They stay available through Advanced or their dedicated nav views, but they are not part of the first read. This keeps the first screen focused on "what can I safely start?" and "what is running now?"

The UI follows a quiet white operational console style: clear status marks, left navigation, and minimal decoration. Dense tables are reserved for dedicated views.

NisenPrints is shown as three beginner quick-start cards: Etsy Sync, Printify Recovery, and Full Publish. The cards only show the beginner label, Japanese visible steps, and short description; source-of-truth, allowed scope, forbidden actions, and proof names stay in the backend run contract.

The New Automation tab is a chat-first creation surface. It should feel like consulting with an AI while it turns the user's natural-language intent into a small visible plan. The visible plan only shows the user-facing flow and the start action. Backend checks, source-of-truth handling, lane selection, locks, proof gates, and lint-style validation stay collapsed or server-side.

When the user pastes an API key or token into the New Automation chat, the UI must not echo the raw value. The local server stores the secret for reuse, the chat shows only a saved-key confirmation, and later creation flows should say that the previous saved key will be used. The beginner-facing surface shows the label only; retrieval, validation, and actual secret use remain backend-only.

Run detail opens through `/api/runs/:id`, so the timeline, receipts, and worker events for a selected run are loaded from run-scoped queries instead of the small dashboard overview limits. If that detail request fails, the UI falls back to the existing dashboard snapshot.

When a run contract has missing internal proofs, the dashboard does not show proof names. It shows the remaining visible steps and the next visible step, so beginner users see "what remains" rather than backend proof identifiers.

Data and Sources can show the safe bridge catalog, recent bridge receipts, executor ledger, and knowledge notes. Home and New Automation should not expose raw bridge internals. For a beginner user, the visible wording is "次にやること", "画面を確認", "知識を更新", "承認準備", or "外部実行Bridgeは未接続"; the backend records whether the operation was safe, approval-required, approved-but-not-executed, or completed.

Primary commands:

`npm run dev`

Then open `http://127.0.0.1:5173`.

Maintenance commands:

`npm run clean:dev-data -- --dry-run`

Real cleanup is guarded:

`AUTOMATION_OS_ALLOW_CLEAN_DEV_DATA=1 npm run clean:dev-data -- --force`

`npm run obsidian:export`
