# Obsidian Autonomy Ops Memo

This memo is the short restart point for the current Obsidian x Codex automation state.

## What is now automatic

- `scripts/start-automation-os-server.sh` boots the Automation OS server with Obsidian auto export enabled, a 30 minute periodic export timer, and sqlite fallback when stored Postgres cannot be restored cleanly.
- `package.json` `start:server` uses the same defaults, so CLI start and login recovery behave the same way.
- `ops/launchd/com.nichikatanaka.automation-os.plist` restores the same startup path at login.
- The server now also does an immediate startup export, schedules automatic retry after export failure, and keeps a weekly diagnosis loop alive while the process stays up.
- `apps/server/src/obsidian/exporter.ts` generates `Obsidian x Codex Self Diagnosis.md` and `Obsidian x Codex Weekly Check.md` automatically on export.
- `00_Start Here/Resume Current Work.md`, `Weekly Review.md`, and `Today.md` now point at those pages so the weekly loop is visible immediately.
- Non-periodic production detached exports invoke `obsidian:maintain`; periodic exports reuse the redacted Codex session index and skip maintenance. When invoked, the maintenance body runs at most once per 30 minutes and refreshes project discovery, registry-backed Context Packs, Second Brain canary processing, and project audit readback.
- New durable project roots are discovered automatically but remain locator-only until their registry entry is intentionally promoted. The canonical Muscle AI and Heavy Chain roots are already registered.
- Export, handoff collection, Second Brain apply, and vault Git backup use one shared atomic lock. Second Brain also checks a preimage hash immediately before replacing a note.
- The global `obsidian-project-memory` Skill resolves cross-project requests and forces a fresh-read of project-owned truth before action.
- The existing Hermes LaunchAgent now runs the guarded private-vault Git sync. The wrapper can wake every 15 minutes, while the sync itself executes at most once per six hours and stops on privacy, secret, or divergence gates.
- The Hermes daily summary preserves the last useful summary when no sessions are found and writes a status readback instead of replacing it with a zero-session page.

## What this means operationally

- You do not need to hand-fill the Obsidian diagnostic pages.
- You do not need to manually restart the export loop after login if the LaunchAgent is installed.
- If stored Postgres cannot be restored, the server now falls back to local sqlite so the Obsidian loop can still keep running.
- If export fails transiently, the server schedules the next retry automatically instead of waiting for the next manual action.
- You do not need to register normal new projects by hand just to make them discoverable, run the handoff collector, process the opted-in Second Brain queue, or back up the private Vault.

## What still matters

- Postgres is still the preferred source of truth when its stored secret is valid again.
- Obsidian generated pages are locators and review surfaces, not execution proof.
- Automatic discovery never grants execution permission. Billing, payment, CAPTCHA/OTP, identity verification, and any project-specific risk gate remain outside this knowledge-maintenance loop.
- Check `data/obsidian-maintenance-status.json`, `data/second-brain-processor-status.json`, `data/project-audit-status.json`, and `data/obsidian-git-sync-status.json` when exact readback is needed.
- If you change the startup contract, re-run `npm run build:server`, the focused Obsidian tests, and `./scripts/install-automation-os-launch-agent.sh install`.

## References

- [Obsidian Export](./10-obsidian-export.md)
- [Codex App Parity](./11-codex-app-parity.md)
- [LaunchAgent](../ops/launchd/com.nichikatanaka.automation-os.plist)
- [Server startup](../scripts/start-automation-os-server.sh)
