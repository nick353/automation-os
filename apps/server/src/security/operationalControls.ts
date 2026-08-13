export const SCOPED_LEASE_SCHEMA_V1 = "automation_os_scoped_lease.v1" as const;
export const ADAPTER_SANDBOX_SCHEMA_V1 = "automation_os_adapter_sandbox.v1" as const;
export const KILL_SWITCH_SCHEMA_V1 = "automation_os_kill_switch.v1" as const;
export type ScopedLeaseV1 = { schema: typeof SCOPED_LEASE_SCHEMA_V1; lease_id: string; task_id: string; target_digest: string; scope: string; expires_at: string; revoked: boolean };
export function scopedLease(input: Omit<ScopedLeaseV1, "schema" | "revoked">): ScopedLeaseV1 { return { schema: SCOPED_LEASE_SCHEMA_V1, ...input, revoked: false }; }
export function revokeLease(lease: ScopedLeaseV1): ScopedLeaseV1 { return { ...lease, revoked: true }; }
export type AdapterSandboxV1 = { schema: typeof ADAPTER_SANDBOX_SCHEMA_V1; adapter_id: string; allowed_secrets: readonly string[]; allowed_filesystem: readonly string[]; allowed_origins: readonly string[]; allowed_workflows: readonly string[]; isolated: true };
export function adapterSandbox(adapterId: string, allowedOrigins: readonly string[], workflowId: string): AdapterSandboxV1 { return { schema: ADAPTER_SANDBOX_SCHEMA_V1, adapter_id: adapterId, allowed_secrets: [], allowed_filesystem: [], allowed_origins: allowedOrigins, allowed_workflows: [workflowId], isolated: true }; }
export type KillSwitchScope = "provider" | "account" | "workflow" | "global";
export type KillSwitchV1 = { schema: typeof KILL_SWITCH_SCHEMA_V1; scope: KillSwitchScope; key: string; active: boolean; reason: string; changed_at: string };
export function killSwitch(scope: KillSwitchScope, key: string, reason: string, active = true): KillSwitchV1 { return { schema: KILL_SWITCH_SCHEMA_V1, scope, key, active, reason, changed_at: new Date().toISOString() }; }
export function isKilled(switches: readonly KillSwitchV1[], input: { provider?: string; account?: string; workflow?: string }): boolean { return switches.some((item) => item.active && (item.scope === "global" || (item.scope === "provider" && item.key === input.provider) || (item.scope === "account" && item.key === input.account) || (item.scope === "workflow" && item.key === input.workflow))); }
