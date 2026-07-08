# Architecture

MVP runs on one Mac:

- `apps/web`: React + Vite control panel.
- `apps/server`: Express + TypeScript API.
- `data/automation-os.sqlite`: SQLite database accessed through the `sqlite3` CLI.
- local worker protocol: represented in lane config and proof receipts, ready to split from the server later.

The future VPS split keeps the server API stable while workers continue to own local browser profiles, CDP ports, workdirs, and resource locks.

AI adapters are explicit: Codex CLI, Codex App, and ChatGPT subscription are primary. `openaiApi.optional.ts` documents the optional path without making `OPENAI_API_KEY` part of MVP boot.
