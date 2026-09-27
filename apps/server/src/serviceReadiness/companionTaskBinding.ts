const COMPANION_TASK_ID_PATTERN = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const SCHEDULED_SOURCE_TRIGGERS = new Set([
  "automation_os_scheduler",
  "launchd",
  "github_actions",
]);

type Metadata = Record<string, unknown>;

function validTaskId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return COMPANION_TASK_ID_PATTERN.test(normalized) ? normalized : null;
}

function scheduledCompanionTaskId(runId: string): string | null {
  const normalized = runId.trim();
  if (!normalized) return null;
  const candidate = `aos-scheduled-${normalized}`;
  return COMPANION_TASK_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Resolve the owner id used by the AOS Chrome Companion surface.
 *
 * An explicitly bound task always wins.  A deterministic scheduled owner is
 * synthesized only for portable scheduler/launchd/GitHub runs.  Interactive
 * starts and the isolated reference canary must supply their own task id (or
 * remain blocked); they must never inherit a scheduled owner implicitly.
 */
export function resolveCompanionTaskId(input: {
  runId: string;
  backend: string | null | undefined;
  metadata?: Metadata | null;
}): string | null {
  if (input.backend !== "aos_chrome_companion") return null;
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const invocation = metadata.portable_workflow_invocation && typeof metadata.portable_workflow_invocation === "object"
    && !Array.isArray(metadata.portable_workflow_invocation)
    ? metadata.portable_workflow_invocation as Metadata
    : {};
  const explicit = validTaskId(metadata.companion_task_id)
    ?? validTaskId(invocation.companion_task_id)
    ?? validTaskId(invocation.task_id);
  if (explicit) return explicit;
  if (metadata.reference_workflow_canary === true) return null;
  const sourceTrigger = typeof invocation.source_trigger === "string"
    ? invocation.source_trigger.trim()
    : typeof metadata.source_trigger === "string"
      ? metadata.source_trigger.trim()
      : "";
  if (!SCHEDULED_SOURCE_TRIGGERS.has(sourceTrigger)) return null;
  return scheduledCompanionTaskId(input.runId);
}

export { COMPANION_TASK_ID_PATTERN };
