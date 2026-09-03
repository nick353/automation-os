# Connector execution boundary

This is the adopted Automation OS execution boundary for provider connectors.

## Ownership

Automation OS is the control plane. It owns:

- schedules and durable dispatch;
- approval records and effect policy;
- Run, step, idempotency, and target binding;
- redacted provider receipts;
- source synchronization, reconciliation, and task-owned cleanup.

Automation OS does not implement Google OAuth for provider connectors and does
not copy provider OAuth tokens, cookies, connector storage state, or raw
authorization payloads into its database, artifacts, prompts, or ordinary
readbacks.

## Connector execution

Connector execution is delegated to the configured Codex App Server / MCP
plugin gateway. The initial provider mapping is:

| Provider | Executor | AOS responsibility |
| --- | --- | --- |
| Gmail | Codex Gmail connector/plugin | intake target, approval, Run binding, receipt, reconciliation |
| Google Drive | Codex Drive connector/plugin | file target, approval, Run binding, receipt, reconciliation |
| Google Calendar | Codex Calendar connector/plugin | event target, approval, Run binding, receipt, reconciliation |
| Supabase | Supabase MCP/plugin | project/query target, approval, Run binding, receipt, reconciliation |

The connector session is provider-scoped. Connector login is not AOS Owner
authentication, private-ingress proof, or Chrome Profile 2 identity.

Every connector call must carry the current `workflow_id`, `run_id`,
`step_id`, idempotency key, target digest, and approval reference. The
connector result must be reduced to a redacted receipt and same-Run readback;
missing or ambiguous provider evidence remains blocked.

## Browser execution

Browser operations use the signed Chrome Extension / Chrome Plugin Profile 2
surface selected by the current AOS backend setting. There is no implicit
fallback to Browser Use CLI, In-App Browser, Playwright, direct CDP, or a raw
browser process. Legacy `browser_use_cli` adapters remain compatibility code
until their workflow-specific migration is complete; their presence is not
permission to select them implicitly.

## Promotion rule

Codex App Server reachability, MCP tool visibility, or a successful connector
login is capability evidence only. It is not business completion. Promotion to
an external effect requires the existing AOS admission, approval, provider
receipt, source sync, reconciliation, and cleanup gates in the same Run.
