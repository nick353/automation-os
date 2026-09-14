import type { AutomationRecord, CompanyConnectionRefRecord } from "../automations/repository.js";
import { resolveGmailExecutionTarget } from "./gmailAccountBinding.js";
import type { PortableWorkflowInputBundle } from "./portableWorkflowEntrypoint.js";

/**
 * Copy the persisted, canonical Gmail execution target into a new Run's
 * input bundle. A caller-supplied target is never allowed to establish the
 * binding by itself; the automation row must already be explicitly bound.
 */
export function bindGmailExecutionTargetToRunInput(input: {
  automation: Pick<AutomationRecord, "companyId" | "builderSpec">;
  connectionRefs: readonly CompanyConnectionRefRecord[];
  inputBundle?: Record<string, unknown> | null;
}): PortableWorkflowInputBundle | null {
  const current = (input.inputBundle && typeof input.inputBundle === "object" && !Array.isArray(input.inputBundle)
    ? { ...input.inputBundle }
    : input.inputBundle ?? null) as PortableWorkflowInputBundle | null;
  const target = resolveGmailExecutionTarget(input.automation, input.connectionRefs);
  if (!target.required) return current;
  if (target.state !== "bound" || !target.connection_ref_id || !target.account_ref) {
    throw new Error(target.exact_blocker ?? "execution_target_unbound");
  }

  const requestedConnection = typeof current?.connection_ref_id === "string" ? current.connection_ref_id.trim() : "";
  const requestedAccount = typeof current?.account_ref === "string" ? current.account_ref.trim() : "";
  if (requestedConnection && requestedConnection !== target.connection_ref_id) {
    throw new Error("execution_target_run_connection_mismatch");
  }
  if (requestedAccount && requestedAccount !== target.account_ref) {
    throw new Error("execution_target_run_account_mismatch");
  }
  return {
    ...(current ?? {}),
    connection_ref_id: target.connection_ref_id,
    account_ref: target.account_ref
  } as PortableWorkflowInputBundle;
}

/**
 * Re-validate the immutable target carried by a Run against the current
 * Company connection inventory. This is used immediately before a provider
 * read so revocation, expiry, account replacement, or scope drift cannot
 * silently fall back to another verified mailbox.
 */
export function requireGmailRunConnectionRef(input: {
  companyId: string;
  inputBundle: unknown;
  connectionRefs: readonly CompanyConnectionRefRecord[];
}): CompanyConnectionRefRecord {
  const bundle = input.inputBundle && typeof input.inputBundle === "object" && !Array.isArray(input.inputBundle)
    ? input.inputBundle as Record<string, unknown>
    : {};
  const connectionRefId = typeof bundle.connection_ref_id === "string" ? bundle.connection_ref_id.trim() : "";
  const accountRef = typeof bundle.account_ref === "string" ? bundle.account_ref.trim() : "";
  if (!connectionRefId || !accountRef) throw new Error("execution_target_run_binding_missing");
  const target = resolveGmailExecutionTarget({
    companyId: input.companyId,
    builderSpec: {
      canonicalWorkflowId: "email-review-reply",
      execution_target: { connection_ref_id: connectionRefId, account_ref: accountRef }
    }
  }, input.connectionRefs);
  if (target.state !== "bound" || !target.connection_ref_id || !target.account_ref) {
    throw new Error(target.exact_blocker ?? "execution_target_run_binding_invalid");
  }
  return input.connectionRefs.find((ref) => ref.id === target.connection_ref_id)!;
}
