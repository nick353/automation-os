# Implementation Roadmap

1. MVP local control panel: SQLite state, read-only Codex import, Daily AI demo, approval/proof/lane gates.
2. Local worker protocol: command-run creation, worker receipt events, approval resume, and profile/CDP lane records.
3. Codex App comparison: imported assets vs registered automation DB state and session receipts.
4. VPS-ready server: move API and DB off Mac while keeping browser workers local.
5. Skill promotion: write reviewed Skill Factory drafts into the selected skill root.

Current checkpoint: workflow-specific real execution for read-only Codex tasks is enabled behind `AUTOMATION_OS_EXECUTE_CODEX=1`; mixed runs that still include receipt-only worker steps remain partial. The next step is to collect repeated live run proof before enabling real external commit actions.
