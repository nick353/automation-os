# Current Codex App Audit

The MVP imports these local assets read-only:

- `/Users/nichikatanaka/.codex/automations`
- `/Users/nichikatanaka/.codex/sessions`
- `/Users/nichikatanaka/.codex/skills`
- `/Users/nichikatanaka/.agents/skills`
- `/Users/nichikatanaka/.codex/plugins/cache`

Import stores inventory metadata in SQLite and does not mutate Codex App files. The dashboard surfaces source type, path, kind, size, and import truncation metadata when a root is too large.

Known failure pattern: registered prompt, local docs, app DB state, session receipts, and actual browser lanes can drift. Automation OS treats inventory as evidence, not authority to rewrite Codex App state.
