# Obsidian Autonomy Ops Memo

This memo is the short restart point for the current Obsidian x Codex automation state.

## What is now automatic

- `scripts/start-automation-os-server.sh` boots the Automation OS server with Obsidian auto export enabled, a 5 minute periodic export timer, and sqlite fallback when stored Postgres cannot be restored cleanly.
- `package.json` `start:server` uses the same defaults, so CLI start and login recovery behave the same way.
- `ops/launchd/com.nichikatanaka.automation-os.plist` restores the same startup path at login.
- The server now also does an immediate startup export, schedules automatic retry after export failure, and keeps a weekly diagnosis loop alive while the process stays up.
- `apps/server/src/obsidian/exporter.ts` generates `Obsidian x Codex Self Diagnosis.md` and `Obsidian x Codex Weekly Check.md` automatically on export.
- `00_Start Here/Resume Current Work.md`, `Weekly Review.md`, and `Today.md` now point at those pages so the weekly loop is visible immediately.

## What this means operationally

- You do not need to hand-fill the Obsidian diagnostic pages.
- You do not need to manually restart the export loop after login if the LaunchAgent is installed.
- If stored Postgres cannot be restored, the server now falls back to local sqlite so the Obsidian loop can still keep running.
- If export fails transiently, the server schedules the next retry automatically instead of waiting for the next manual action.

## What still matters

- Postgres is still the preferred source of truth when its stored secret is valid again.
- Obsidian generated pages are locators and review surfaces, not execution proof.
- If you change the startup contract, re-run `npm run build:server`, the focused Obsidian tests, and `./scripts/install-automation-os-launch-agent.sh install`.

## References

- [Obsidian Export](./10-obsidian-export.md)
- [Codex App Parity](./11-codex-app-parity.md)
- [LaunchAgent](../ops/launchd/com.nichikatanaka.automation-os.plist)
- [Server startup](../scripts/start-automation-os-server.sh)
