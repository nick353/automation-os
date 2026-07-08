# Codex App Parity Ledger

Automation OS should track Codex app parity as a proof-bearing ledger, not as a vague feature wishlist. The ledger answers whether each Codex app capability is visible, executable, proofed, blocked by a trusted executor, or still a gap.

The generated Obsidian page is `01_Control Panel/Codex App Parity Ledger.md`. It is built from read-only local inventory and receipts:

- `getCodexCapabilities()` for skills, plugins, MCP-adjacent plugins, and registered automations.
- `system_checks` for local browser and Browser Use verification proof.
- `bridge_executions` for protected action executor status.
- Obsidian export status and generated frontmatter for the control surface itself.

The same ledger is also returned by `GET /api/dashboard` as `codexParityLedger` and shown in the Web app's Sources view as a read-only Codex App compatibility panel.

The ledger deliberately stays out of Home. Home should stay beginner-first and action-focused. Sources and Obsidian can show the detailed parity status: covered, covered-local, blocked-by-executor, or gap.

Current non-negotiable boundary: approval is not execution. A protected external action is not complete until the executor ledger shows a connected executor and a completed receipt. Local inventory is also not execution; skills, plugins, automations, Git, terminal, worktree, cloud threads, Computer Use, and IDE sync must first appear as read-only audit rows before any executor is added.

The Git / terminal / worktree / cloud threads / Computer Use / IDE sync row is intentionally a gap row. It means Automation OS can name the missing parity area and show it in Sources and Obsidian, but it does not connect those tools, grant write access, run shell commands, sync IDE state, operate Computer Use, or bridge to cloud execution. The next safe step is read-only audit metadata only; executor wiring requires a separate trusted executor contract and proof model.
