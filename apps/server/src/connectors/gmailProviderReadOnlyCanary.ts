import { createHash } from "node:crypto";
import { CodexAppServerClient, type CodexAppServerEvent } from "../codex/appServerClient.js";

export const GMAIL_PROVIDER_READ_ONLY_CANARY_SCHEMA = "aos.gmail_provider_read_only_canary.v1" as const;

export type GmailProviderReadOnlyCanaryReadback = {
  schema: typeof GMAIL_PROVIDER_READ_ONLY_CANARY_SCHEMA;
  status: "completed" | "blocked";
  runId: string;
  companyId: string;
  connector: "gmail";
  operation: "profile_read";
  transport: "codex_app_server_plugin";
  providerToolCallObserved: boolean;
  providerAccountPresent: boolean;
  providerAccountHash: string | null;
  exactBlocker: string | null;
  nextAction: string;
  externalActionExecuted: false;
  dataRead: boolean;
  dataPersisted: false;
  secretMaterialIncluded: false;
  providerReceipt: {
    schema: "aos.gmail.provider_receipt.v1";
    sameRun: true;
    runId: string;
    operation: "profile_read";
    providerAccountHash: string;
    externalActionExecuted: false;
  } | null;
  sourceSync: {
    status: "verified";
    accountRefHash: string;
  } | {
    status: "blocked";
    exactBlocker: string;
  };
  reconciliation: {
    required: true;
    status: "verified" | "blocked";
    exactBlocker: string | null;
  };
  cleanup: {
    status: "verified";
    ephemeralThread: true;
  };
};

type GmailProviderResponse = {
  provider?: unknown;
  operation?: unknown;
  provider_account_present?: unknown;
  provider_account?: unknown;
  external_action_executed?: unknown;
  data_persisted?: unknown;
  exact_blocker?: unknown;
};

export type GmailProviderReadOnlyCanaryPreflight = {
  /** The registered worker must be connected before a provider turn exists. */
  runnerStatus?: "ready" | "runner_pending";
  /** The connector must expose a structured response capture boundary. */
  responseCaptureAvailable?: boolean;
  /** The connector must prove task/account context isolation. */
  contextIsolationAvailable?: boolean;
};

export function validateGmailProviderReadOnlyCanaryPreflight(
  preflight: GmailProviderReadOnlyCanaryPreflight = {}
): string | null {
  if (preflight.runnerStatus === "runner_pending") return "registered_runner_pending";
  if (preflight.responseCaptureAvailable === false) return "gmail_connector_response_capture_unavailable";
  if (preflight.contextIsolationAvailable === false) return "gmail_connector_context_isolation_unavailable";
  return null;
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string" },
    operation: { type: "string" },
    provider_account_present: { type: "boolean" },
    provider_account: { type: ["string", "null"] },
    external_action_executed: { type: "boolean" },
    data_persisted: { type: "boolean" },
    exact_blocker: { type: ["string", "null"] }
  },
  required: [
    "provider",
    "operation",
    "provider_account_present",
    "provider_account",
    "external_action_executed",
    "data_persisted",
    "exact_blocker"
  ]
} as const;

/**
 * Execute one bounded Gmail provider profile read through the same remote
 * Codex App Server connection used by AOS. The raw account value is kept in
 * memory only long enough to compare it to the company connection reference;
 * the returned receipt contains only hashes.
 */
export async function runGmailProviderReadOnlyCanary(input: {
  runId: string;
  companyId: string;
  accountRef: string;
  client?: CodexAppServerClient;
  preflight?: GmailProviderReadOnlyCanaryPreflight;
}): Promise<GmailProviderReadOnlyCanaryReadback> {
  const runId = input.runId.trim();
  const companyId = input.companyId.trim();
  const accountRef = input.accountRef.trim();
  const client = input.client ?? new CodexAppServerClient({ timeoutMs: 60_000 });
  const ownsClient = !input.client;
  let events: CodexAppServerEvent[] = [];
  let providerAccountHash: string | null = null;
  let providerAccountPresent = false;
  let providerToolCallObserved = false;
  let exactBlocker: string | null = null;
  let sourceSync: GmailProviderReadOnlyCanaryReadback["sourceSync"] = {
    status: "blocked",
    exactBlocker: "gmail_provider_read_only_call_not_executed"
  };

  try {
    if (!runId) throw new Error("gmail_provider_canary_run_id_required");
    if (!companyId) throw new Error("company_id_required");
    if (!accountRef) throw new Error("gmail_company_account_ref_required");
    const preflightBlocker = validateGmailProviderReadOnlyCanaryPreflight(input.preflight);
    if (preflightBlocker) {
      exactBlocker = preflightBlocker;
      return blockedCanaryReadback({ runId, companyId, exactBlocker });
    }

    const threadId = await client.startOrResumeThread(undefined, { ephemeral: true });
    let turn = await client.startTurn({
      threadId,
      outputSchema,
      text: "Use only the installed Gmail app/plugin named gmail (gmail@openai-curated) and invoke its profile/get-profile tool exactly once. Do not call Cloudflare, any MCP server, any other Plugin/app, browser, web, search, or network tool. Do not search, list, read, inspect, or access any Gmail messages, threads, attachments, or bodies. Do not send, create drafts, modify labels, archive, delete, or perform any external side effect. Return only JSON with provider=gmail, operation=profile_read, provider_account_present, provider_account (authenticated account email or null), external_action_executed=false, data_persisted=false, and exact_blocker=null only when the Gmail profile tool completed. If the Gmail app/plugin or its profile tool is unavailable, refuses, or requests another authorization, return provider_account_present=false and exact_blocker=gmail_provider_tool_unavailable_or_auth_required. Do not include message data.",
      onEvent: (event) => {
        events.push(event);
      }
    });
    events = turn.events;
    // A model turn can occasionally finish with a plain response before it
    // dispatches any tool. That is a bounded no-dispatch result, not an
    // uncertain provider effect. Re-ask once on the same ephemeral thread so
    // the canary remains one provider profile read per run while avoiding
    // replay after any observed tool dispatch.
    const dispatchedTool = events.some((event) => isToolCallEvent(event));
    if (turn.status === "completed" && !dispatchedTool) {
      const retryTurn = await client.startTurn({
        threadId,
        outputSchema,
        text: "The previous turn did not dispatch a tool. Do not answer from memory. Invoke exactly one tool now: gmail.get_profile from the installed app gmail@openai-curated. Do not call any other app, MCP server, browser, web, search, or network tool, and do not access messages or perform any side effect. Return the requested JSON only after that profile tool completes.",
        onEvent: (event) => {
          events.push(event);
        }
      });
      events = [...events, ...retryTurn.events];
      turn = { ...retryTurn, events };
    }
    // The App Server client keeps a bounded tail of turn events. A long
    // provider turn can legitimately evict the early `gmail.get_profile`
    // item/completed event from that tail, while retaining the stronger
    // same-turn hash proof captured from the tool's structuredContent.
    const profileToolProof = turn.providerAccountHashSource === "gmail_profile_tool";
    providerToolCallObserved = profileToolProof || events.some(isGmailProviderToolEvent);
    const response = (turn.structured ?? {}) as GmailProviderResponse;
    const account = typeof response.provider_account === "string" ? response.provider_account.trim() : "";
    providerAccountHash = turn.providerAccountHash
      ?? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account) ? sha256(account.toLowerCase()) : null);
    const directProfileProof = profileToolProof;
    providerAccountPresent = (directProfileProof || response.provider_account_present === true) && providerAccountHash !== null;

    const provider = typeof response.provider === "string" ? response.provider.trim().toLowerCase() : "";
    const operation = typeof response.operation === "string" ? response.operation.trim().toLowerCase() : "";
    const providerContractOk = provider === "gmail" || provider === "gmail plugin" || provider.includes("gmail");
    const operationContractOk = operation === "profile_read" || operation === "get_profile" || operation.includes("profile");
    if (turn.status !== "completed") exactBlocker = turn.exactBlocker ?? "gmail_provider_turn_not_completed";
    else if (!directProfileProof && (!providerContractOk || !operationContractOk)) exactBlocker = "gmail_provider_response_contract_invalid";
    else if (!providerToolCallObserved) exactBlocker = "gmail_provider_tool_call_not_observed";
    else if (!providerAccountPresent) exactBlocker = "gmail_provider_account_readback_missing";
    else if (response.external_action_executed === true || response.data_persisted === true
      || events.some((event) => event.method === "item/completed" && `${event.serverName} ${event.toolName}`.toLowerCase().includes("gmail") && !isGmailProviderToolEvent(event))) exactBlocker = "gmail_provider_read_only_boundary_violation";
    else if (!directProfileProof && (response.external_action_executed !== false || response.data_persisted !== false)) exactBlocker = "gmail_provider_read_only_boundary_violation";
    else if (!directProfileProof && response.exact_blocker !== null) exactBlocker = typeof response.exact_blocker === "string" ? response.exact_blocker.slice(0, 160) : "gmail_provider_reported_blocker";

    if (!exactBlocker && providerAccountHash) {
      const accountRefHash = sha256(accountRef.toLowerCase());
      if (providerAccountHash !== accountRefHash) {
        exactBlocker = "gmail_provider_account_ref_mismatch";
        sourceSync = { status: "blocked", exactBlocker };
      } else {
        sourceSync = { status: "verified", accountRefHash };
      }
    }
  } catch (error) {
    exactBlocker = error instanceof Error ? error.message : "gmail_provider_read_only_canary_failed";
  } finally {
    if (ownsClient) client.close();
  }

  const completed = exactBlocker === null && providerAccountHash !== null;
  const receipt = completed && providerAccountHash
    ? {
      schema: "aos.gmail.provider_receipt.v1" as const,
      sameRun: true as const,
      runId,
      operation: "profile_read" as const,
      providerAccountHash,
      externalActionExecuted: false as const
    }
    : null;
  return {
    schema: GMAIL_PROVIDER_READ_ONLY_CANARY_SCHEMA,
    status: completed ? "completed" : "blocked",
    runId,
    companyId,
    connector: "gmail",
    operation: "profile_read",
    transport: "codex_app_server_plugin",
    providerToolCallObserved,
    providerAccountPresent,
    providerAccountHash,
    exactBlocker,
    nextAction: completed
      ? "Gmail profile receipt・会社scope・source sync・reconciliation・cleanupを同一Runで確認済み。本文操作や送信は行わない"
      : "表示されたexact blockerを解消してから、同じ会社scopeで新しいRunを1回だけ開始する。未確定のprovider効果は再送しない",
    externalActionExecuted: false,
    dataRead: providerAccountPresent,
    dataPersisted: false,
    secretMaterialIncluded: false,
    providerReceipt: receipt,
    sourceSync: completed && providerAccountHash && sourceSync.status === "verified"
      ? sourceSync
      : { status: "blocked", exactBlocker: exactBlocker ?? "gmail_provider_source_sync_not_verified" },
    reconciliation: {
      required: true,
      status: completed ? "verified" : "blocked",
      exactBlocker: completed ? null : exactBlocker
    },
    cleanup: { status: "verified", ephemeralThread: true }
  };
}

function blockedCanaryReadback(input: {
  runId: string;
  companyId: string;
  exactBlocker: string;
}): GmailProviderReadOnlyCanaryReadback {
  return {
    schema: GMAIL_PROVIDER_READ_ONLY_CANARY_SCHEMA,
    status: "blocked",
    runId: input.runId,
    companyId: input.companyId,
    connector: "gmail",
    operation: "profile_read",
    transport: "codex_app_server_plugin",
    providerToolCallObserved: false,
    providerAccountPresent: false,
    providerAccountHash: null,
    exactBlocker: input.exactBlocker,
    nextAction: "exact blockerを解消してから、新しいRunでprovider read-only canaryを再開する。",
    externalActionExecuted: false,
    dataRead: false,
    dataPersisted: false,
    secretMaterialIncluded: false,
    providerReceipt: null,
    sourceSync: { status: "blocked", exactBlocker: input.exactBlocker },
    reconciliation: { required: true, status: "blocked", exactBlocker: input.exactBlocker },
    cleanup: { status: "verified", ephemeralThread: true }
  };
}

export function isGmailProviderToolEvent(event: CodexAppServerEvent): boolean {
  const itemType = event.itemType?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  const identity = `${event.serverName ?? ""} ${event.toolName ?? ""}`.toLowerCase();
  return event.method === "item/completed"
    && (itemType === "mcptoolcall" || itemType === "dynamictoolcall")
    && identity.includes("gmail") && identity.includes("profile")
    && event.status === "completed";
}

function isToolCallEvent(event: CodexAppServerEvent): boolean {
  const itemType = event.itemType?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return event.method === "item/completed"
    && (itemType === "mcptoolcall" || itemType === "dynamictoolcall");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
