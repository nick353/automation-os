# Skill Factory

Skill Factory turns successful runs into reusable `SKILL.md` drafts. It uses completed steps, proof receipts, lane rules, and resource-lock policy from a run.

MVP creates drafts in the database through:

`POST /api/skills/from-run/:runId`

Promotion to a real Codex skill remains manual in this MVP. That keeps generated drafts reviewable before they become durable workflow instructions.
