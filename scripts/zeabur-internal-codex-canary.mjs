import { getCodexAppServerConnectionReadback } from "../apps/server/dist/codex/appServerConnection.js";
import { runCodexAppServerThreadTurnCanary } from "../apps/server/dist/codex/appServerProbe.js";

const connection = getCodexAppServerConnectionReadback({}, process.env);
const canary = await runCodexAppServerThreadTurnCanary();

// Keep this artifact safe: no token, prompt, model output, cookie, or raw
// protocol body is printed. The ephemeral thread/turn is read-only and the
// dedicated server canary never starts Browser Use or a Mac worker.
const readback = {
  schema: "aos_zeabur_internal_codex_service_canary.v1",
  generated_at: new Date().toISOString(),
  route: "zeabur_aos_service_to_codex_app_server_private_network",
  connection: {
    mode: connection.mode,
    endpoint: connection.endpoint,
    network_boundary: connection.network_boundary,
    tls_required: connection.tls_required,
    auth_configured: connection.auth_configured,
    local_stdio_fallback: connection.local_stdio_fallback,
    exact_blocker: connection.exact_blocker,
    production_remote_cutover_allowed: connection.production_remote_cutover_allowed,
    production_promotion_blocker: connection.production_promotion_blocker
  },
  protocol: {
    initialize: canary.initialized,
    account_read: canary.accountRead,
    account_present: canary.accountPresent,
    requires_openai_auth: canary.requiresOpenaiAuth,
    ephemeral_thread_started: canary.threadStarted,
    read_only_turn_started: canary.turnStarted,
    turn_completion_observed: canary.turnCompletionObserved,
    turn_status: canary.turnStatus ?? null,
    error_notification_observed: canary.errorNotificationObserved,
    event_methods: canary.eventMethods
  },
  browser_use_started: false,
  mac_worker_used: false,
  external_action_executed: canary.externalActionExecuted,
  status: canary.ok ? "passed_read_only" : "blocked",
  exact_blocker: canary.exactBlocker,
  next_safe_action: canary.ok
    ? "Keep Browser Use dispatch on the Mac worker and retain local stdio fallback until the remote transport release gate is cleared."
    : "Resolve the recorded Zeabur internal Codex blocker without starting Web operations, then rerun one fresh canary.",
  restart_point: "AOS scheduler/durable queue -> Zeabur Codex inference -> Mac Browser Use queue dispatch"
};

console.log(JSON.stringify(readback));
process.exitCode = canary.ok ? 0 : 2;
