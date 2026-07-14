# Project Boundary Standard

Automation OS and Obsidian use generated pages as a read-first control surface. They do not replace project-owned source-of-truth files.

## Required Project State Fields

Every durable project that should appear in Obsidian as execution-ready should keep a project-owned `STATE.md` with these fields. A project can temporarily use an equivalent authority file as a locator, but it must not be treated as durable execution-ready until the current-state fields below are explicit.

- `current_state`: what is true now, in the project's own terms.
- `next_action`: the next safe action and the files/artifacts to read first.
- `blocker`: the current exact blocker, or `none`.
- `risk_gate`: operations that require explicit approval or stronger proof.
- `maturity_candidate`: a compact lifecycle/status label for generated surfaces.
- `source_of_truth`: the project-owned files, DB rows, queues, Skills, and artifacts that prove state.
- `proof_locator`: the latest artifacts/readbacks to inspect before acting.
- `related_projects`: adjacent projects and the boundary that keeps them from being treated as the same state.

## Read Order

For resume or cross-project work, use this order:

1. `data/resume-contract.json`.
2. Obsidian `Project Handoff Index.md`, `Resume Current Work.md`, and `Project Memory Map.md`.
3. The target project's generated Context Pack.
4. The target project's `STATE.md` / `AGENTS.md` / `automation.toml` / Skill / queue / latest artifacts.
5. DB or live readback only when the project requires it.

Generated Obsidian files are locators. A locator can tell Codex where to look, but it cannot prove execution completion, approve an external action, or override a project-owned state file.

Codex server connectivity is a reachability layer, not a boundary override. It may expand which configured surfaces are reachable in the current environment, but it does not replace project-owned state, proof, or approval requirements.

## Durable Managed Status

A project without project-owned `STATE.md` or an explicit current-state authority may appear in generated Obsidian pages as a locator only. Do not promote it to execution-ready or durable managed status until `current_state`, `next_action`, `blocker`, `risk_gate`, `source_of_truth`, and `proof_locator` are present and fresh-read from the project itself.

## Project Registry And Auditor

`data/project-registry.json` is the machine-readable registry for project governance. It declares each managed project's root, owner layer, required authority files, artifact roots, source-of-truth paths, related projects, allowed safe automation, approval-required operations, and human-only operations.

`npm run project:audit` reads that registry and writes `data/project-audit-status.json`. The auditor checks whether each registered root and `STATE.md` exists, whether required authority files are present, whether the generated Context Pack still carries the locator-not-proof boundary, and whether approval/human-only boundaries are declared.

`npm run project:register -- --id=<project-id> --label="<Project Label>" --root=/absolute/path` previews a new registry entry and `STATE.md` template without writing by default. Add `--write` to create the project root when needed, scaffold `STATE.md` only if it is missing, and append the entry to `data/project-registry.json`. Add `--update` only when intentionally replacing an existing registry entry. After registration, run `npm run project:audit` and `npm run obsidian:export`.

Obsidian export includes the auditor output as generated locator surfaces:

- `10_Dashboards/Project Health.md`
- `01_Control Panel/Project Action Queue.md`
- `01_Control Panel/Approval Ledger.md`
- `02_Systems/automation-os/Run Ledger.md`

These generated files are not execution proof. They are read-first dashboards that point back to the registry, project-owned `STATE.md`, DB rows, artifacts, and live/readback proof.

Automation classes:

- `safe_auto_fix`: local/generated-file/status maintenance such as Obsidian export, generated markdown refresh, state template scaffolding, link existence audit, proof pointer readback, and local status JSON writes.
- `approval_required_fix`: external API writes, Google Sheets writes, social post/publish, job submit, Etsy publish, GitHub push, deploy, delete, external service settings changes, and secret changes.
- `human_only`: billing, purchase, payment, checkout, paid subscription, invoice, CAPTCHA, OTP/security-code, and identity verification.

## Boundary Rules

- Local Codex uses `/Users/nichikatanaka/.codex/STATE.md`, `/Users/nichikatanaka/.codex/AGENTS.md`, `/Users/nichikatanaka/AGENTS.md`, Skills, automations, hooks, memories, and sessions as the operator-layer source of truth. It can locate work, but it must fresh-read each target project's own state before acting.
- Automation OS is the control plane for registered workflows and Obsidian export; it is not the source of truth for Daily AI content, Jobs ledgers, NisenPrints publishing state, or Apparel AI production state.
- Daily AI / Jobs live under `/Users/nichikatanaka/Documents/New project`, but Daily AI publish, Job Submit, and Job Follow-up are separate lanes with separate completion proof.
- NisenPrints / Etsy uses `/Users/nichikatanaka/Documents/Etsy/STATE.md` and its own manifests/artifacts.
- Apparel AI / Heavy Chain uses `/Users/nichikatanaka/Desktop/アパレル１/STATE.md` and its own production/readback gates. `/Users/nichikatanaka/Desktop/アパレル１/heavy-chain` is locator-only unless its local `STATE.md` points back to the root state and the root state says it is current.
- Future projects should add their own `STATE.md` before being treated as durable Obsidian-managed projects.
