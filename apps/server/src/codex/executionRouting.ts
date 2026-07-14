import { createHash } from "node:crypto";
import { listTrustedBridgeActions } from "../bridge/trustedBridge.js";
import { buildCapabilityRouterSnapshot, type CapabilityRoute, type CapabilityRouteAuthority, type CapabilityRouteProof, type CapabilityRouteStatus } from "./capabilityRouter.js";
import { getCodexCapabilities, type CodexCapabilitiesSummary } from "./capabilities.js";

export type ExecutionRoutingSource = "manual" | "scheduler" | "create_view" | "research_plan" | "fast_path" | "unknown";
export type ExecutionRoutingController = "automation_os_api";
export type ExecutionRoutingSurface = "browser_lane" | "codex_cli" | "registered_runner" | "worker_loop";
export type ExecutionRoutingPhase = "route_decision" | "route_readback";
export type ExecutionRoutingExactBlocker = "chrome_extension_required" | "route_readback_mismatch" | "route_decision_missing" | null;

export type ExecutionRoutingSnapshot = {
  generatedAt: string;
  schema: "route_decision";
  phase: ExecutionRoutingPhase;
  source: ExecutionRoutingSource;
  command: string;
  intent: string;
  controller: {
    name: ExecutionRoutingController;
    status: "connected" | "readback" | "inventory_only";
    reason: string;
  };
  executionSurface: ExecutionRoutingSurface;
  surface: ExecutionRoutingSurface;
  selectedRouteId: string | null;
  selectedRouteLabel: string | null;
  routeAuthority: CapabilityRouteAuthority | "none";
  authority: CapabilityRouteAuthority | "none";
  routeProof: CapabilityRouteProof | "none";
  routeStatus: CapabilityRouteStatus | "none";
  selectedLane: string | null;
  plannedAdapters: string[];
  allowed: boolean;
  routerPrimaryAction: string;
  routerCounts: {
    ready: number;
    partial: number;
    missing: number;
    gaps: number;
  };
  fingerprint: string;
  decisionFingerprint: string | null;
  exactBlocker: ExecutionRoutingExactBlocker;
  evidence: string[];
  fallbackReason: string;
};

export function buildCanonicalExecutionRoutingMetadata(routeDecision: ExecutionRoutingSnapshot): {
  route_decision: ExecutionRoutingSnapshot;
  route_decision_fingerprint: string;
  route_readback: null;
  execution_routing: ExecutionRoutingSnapshot;
} {
  return {
    route_decision: routeDecision,
    route_decision_fingerprint: routeDecision.fingerprint,
    route_readback: null,
    execution_routing: routeDecision
  };
}

export function buildCanonicalExecutionRoutingMetadataForCommand(input: {
  command: string;
  source?: ExecutionRoutingSource;
  selectedAdapter?: string | null;
  capabilities?: CodexCapabilitiesSummary;
  capabilityRouter?: ReturnType<typeof buildCapabilityRouterSnapshot>;
}): {
  route_decision: ExecutionRoutingSnapshot;
  route_decision_fingerprint: string;
  route_readback: null;
  execution_routing: ExecutionRoutingSnapshot;
} {
  return buildCanonicalExecutionRoutingMetadata(
    buildExecutionRoutingSnapshot({
      command: input.command,
      source: input.source,
      selectedAdapter: input.selectedAdapter ?? null,
      capabilities: input.capabilities,
      capabilityRouter: input.capabilityRouter
    })
  );
}

type RoutingFingerprintFields = {
  schema: "route_decision";
  controllerName: ExecutionRoutingController;
  intent: string;
  surface: ExecutionRoutingSurface;
  plannedAdapters: string[];
  authority: CapabilityRouteAuthority | "none";
  source: ExecutionRoutingSource;
  selectedRouteId: string | null;
  selectedRouteLabel: string | null;
  selectedLane: string | null;
};

export function buildExecutionRoutingSnapshot(input: {
  command: string;
  source?: ExecutionRoutingSource;
  phase?: ExecutionRoutingPhase;
  decisionFingerprint?: string | null;
  selectedAdapter?: string | null;
  capabilities?: CodexCapabilitiesSummary;
  capabilityRouter?: ReturnType<typeof buildCapabilityRouterSnapshot>;
}): ExecutionRoutingSnapshot {
  const capabilities = input.capabilities ?? getCodexCapabilities();
  const capabilityRouter =
    input.capabilityRouter ??
    buildCapabilityRouterSnapshot({
      command: input.command,
      capabilities,
      bridgeActions: listTrustedBridgeActions()
    });
  const selectedRoute = capabilityRouter.recommendedRoutes[0];
  const phase = input.phase ?? "route_decision";
  const executionSurface = determineExecutionSurface(selectedRoute, input.command);
  const plannedAdapters = buildPlannedAdapters(executionSurface, selectedRoute);
  const exactBlocker = determineExactBlocker(
    selectedRoute,
    capabilities,
    input.source ?? "unknown",
    input.command,
    input.decisionFingerprint,
    phase,
    input.selectedAdapter ?? null
  );
  const controller = buildControllerState(phase, exactBlocker);
  const fingerprint = buildRoutingFingerprint({
    schema: "route_decision",
    controllerName: controller.name,
    intent: normalizeCommand(input.command),
    surface: executionSurface,
    plannedAdapters,
    authority: selectedRoute?.authority ?? "none",
    source: input.source ?? "unknown",
    selectedRouteId: selectedRoute?.id ?? null,
    selectedRouteLabel: selectedRoute?.label ?? null,
    selectedLane: selectedRoute?.lane ?? null
  });

  return {
    generatedAt: new Date().toISOString(),
    schema: "route_decision",
    phase,
    source: input.source ?? "unknown",
    command: input.command,
    intent: normalizeCommand(input.command),
    controller,
    executionSurface,
    surface: executionSurface,
    selectedRouteId: selectedRoute?.id ?? null,
    selectedRouteLabel: selectedRoute?.label ?? null,
    routeAuthority: selectedRoute?.authority ?? "none",
    authority: selectedRoute?.authority ?? "none",
    routeProof: selectedRoute?.proof ?? "none",
    routeStatus: selectedRoute?.status ?? "none",
    selectedLane: selectedRoute?.lane ?? null,
    plannedAdapters,
    allowed: exactBlocker === null,
    routerPrimaryAction: capabilityRouter.primaryAction,
    routerCounts: capabilityRouter.counts,
    fingerprint,
    decisionFingerprint: input.decisionFingerprint ?? null,
    exactBlocker,
    evidence: buildEvidence({
      controller,
      phase,
      executionSurface,
      selectedRoute,
      plannedAdapters,
      fingerprint,
      exactBlocker,
      selectedAdapter: input.selectedAdapter ?? null
    }),
    fallbackReason: buildFallbackReason(selectedRoute, executionSurface, exactBlocker)
  };
}

export function readCanonicalExecutionRoutingDecision(
  routeDecisionValue: unknown,
  routeDecisionFingerprintValue: unknown
): { routeDecision: ExecutionRoutingSnapshot | null; routeDecisionFingerprint: string | null } {
  if (!routeDecisionValue || typeof routeDecisionValue !== "object" || Array.isArray(routeDecisionValue)) {
    return { routeDecision: null, routeDecisionFingerprint: null };
  }
  const routeDecision = routeDecisionValue as Partial<ExecutionRoutingSnapshot> & {
    schema?: unknown;
    intent?: unknown;
    surface?: unknown;
    plannedAdapters?: unknown;
    authority?: unknown;
    allowed?: unknown;
    exactBlocker?: unknown;
    fingerprint?: unknown;
    controller?: { name?: unknown; status?: unknown; reason?: unknown };
  };
  if (!isRouteDecisionSchema(routeDecision.schema)) return { routeDecision: null, routeDecisionFingerprint: null };
  if (routeDecision.phase !== "route_decision") return { routeDecision: null, routeDecisionFingerprint: null };
  if (!isRouteDecisionController(routeDecision.controller)) return { routeDecision: null, routeDecisionFingerprint: null };
  if (typeof routeDecision.intent !== "string" || !routeDecision.intent.trim()) return { routeDecision: null, routeDecisionFingerprint: null };
  const surface = routeDecision.surface;
  if (!isExecutionRoutingSurface(surface)) return { routeDecision: null, routeDecisionFingerprint: null };
  if (!isCanonicalPlannedAdapters(routeDecision.plannedAdapters)) return { routeDecision: null, routeDecisionFingerprint: null };
  if (!isRouteDecisionAuthority(routeDecision.authority)) return { routeDecision: null, routeDecisionFingerprint: null };
  if (typeof routeDecision.allowed !== "boolean") return { routeDecision: null, routeDecisionFingerprint: null };
  if (!isExecutionRoutingExactBlocker(routeDecision.exactBlocker)) return { routeDecision: null, routeDecisionFingerprint: null };
  if (typeof routeDecision.fingerprint !== "string" || !routeDecision.fingerprint.trim()) {
    return { routeDecision: null, routeDecisionFingerprint: null };
  }
  if (typeof routeDecisionFingerprintValue !== "string" || !routeDecisionFingerprintValue.trim()) {
    return { routeDecision: null, routeDecisionFingerprint: null };
  }
  const canonicalFingerprint = buildRoutingFingerprint({
    schema: "route_decision",
    controllerName: routeDecision.controller.name,
    intent: routeDecision.intent,
    surface,
    plannedAdapters: routeDecision.plannedAdapters,
    authority: routeDecision.authority,
    source: routeDecision.source ?? "unknown",
    selectedRouteId: routeDecision.selectedRouteId ?? null,
    selectedRouteLabel: routeDecision.selectedRouteLabel ?? null,
    selectedLane: routeDecision.selectedLane ?? null
  });
  if (routeDecision.fingerprint !== canonicalFingerprint) return { routeDecision: null, routeDecisionFingerprint: null };
  if (routeDecisionFingerprintValue !== canonicalFingerprint) return { routeDecision: null, routeDecisionFingerprint: null };
  if (routeDecision.allowed !== (routeDecision.exactBlocker === null)) return { routeDecision: null, routeDecisionFingerprint: null };
  return {
    routeDecision: routeDecisionValue as ExecutionRoutingSnapshot,
    routeDecisionFingerprint: routeDecisionFingerprintValue
  };
}

export function inferExecutionRoutingSource(metadata: Record<string, unknown> | undefined): ExecutionRoutingSource {
  const registeredStart = readRecord(metadata?.registered_workflow_start);
  if (registeredStart.source === "scheduler") return "scheduler";
  if (registeredStart.source === "manual") return "manual";
  if (typeof metadata?.create_session_source === "string" && metadata.create_session_source === "create_view") return "create_view";
  if (readRecord(metadata?.research_plan_snapshot)) return "research_plan";
  return "manual";
}

function buildControllerState(
  phase: ExecutionRoutingPhase,
  exactBlocker: ExecutionRoutingExactBlocker
): ExecutionRoutingSnapshot["controller"] {
  if (phase === "route_readback") {
    return {
      name: "automation_os_api",
      status: exactBlocker ? "inventory_only" : "readback",
      reason: exactBlocker ? `blocked:${exactBlocker}` : "route_readback"
    };
  }
  return {
    name: "automation_os_api",
    status: exactBlocker ? "inventory_only" : "connected",
    reason: exactBlocker ? `blocked:${exactBlocker}` : "route_decision"
  };
}

function determineExecutionSurface(route: CapabilityRoute | undefined, command: string): ExecutionRoutingSurface {
  if (!route) return /codex|review|research|docs?/i.test(command) ? "codex_cli" : "worker_loop";
  const lowerRoute = `${route.id} ${route.label} ${route.lane}`.toLowerCase();
  if (/(browser|x_authenticated_capture|youtube_transcript_capture|web_url_capture)/.test(lowerRoute)) return "browser_lane";
  if (/(second_brain_process|skill_factory|pdf_skill|price_checker|video_frame_reader|web_to_image_prompts)/.test(lowerRoute)) return "codex_cli";
  if (/(registered|approval|publish|submit|send)/.test(lowerRoute)) return "registered_runner";
  if (/codex|review|research|docs?/.test(command.toLowerCase())) return "codex_cli";
  return "worker_loop";
}

function buildPlannedAdapters(executionSurface: ExecutionRoutingSurface, selectedRoute: CapabilityRoute | undefined): string[] {
  if (executionSurface === "browser_lane") return ["playwright_cli", "browser_use_cli"];
  if (executionSurface === "codex_cli") return ["codex_cli", "child_codex"];
  if (executionSurface === "registered_runner") return selectedRoute?.lane ? [selectedRoute.lane] : ["registered_runner"];
  return ["local_worker"];
}

function determineExactBlocker(
  route: CapabilityRoute | undefined,
  capabilities: CodexCapabilitiesSummary,
  source: ExecutionRoutingSource,
  command: string,
  decisionFingerprint: string | null | undefined,
  phase: ExecutionRoutingPhase,
  selectedAdapter: string | null
): ExecutionRoutingExactBlocker {
  if (phase === "route_readback" && !decisionFingerprint) {
    return "route_decision_missing";
  }
  if (phase === "route_readback" && decisionFingerprint) {
    const executionSurface = determineExecutionSurface(route, command);
    const currentFingerprint = buildRoutingFingerprint({
      schema: "route_decision",
      controllerName: "automation_os_api",
      intent: normalizeCommand(command),
      surface: executionSurface,
      plannedAdapters: buildPlannedAdapters(executionSurface, route),
      authority: route?.authority ?? "none",
      source,
      selectedRouteId: route?.id ?? null,
      selectedRouteLabel: route?.label ?? null,
      selectedLane: route?.lane ?? null
    });
    if (currentFingerprint !== decisionFingerprint) return "route_readback_mismatch";
  }
  if (selectedAdapter === "playwright_cli" || selectedAdapter === "browser_use_cli") {
    return "chrome_extension_required";
  }
  const chromeConnected = Boolean(capabilities.capabilities.chrome.state.connected);
  const browserLaneSelected = determineExecutionSurface(route, command) === "browser_lane";
  if (browserLaneSelected && !chromeConnected) return "chrome_extension_required";
  return null;
}

function buildFallbackReason(
  selectedRoute: CapabilityRoute | undefined,
  executionSurface: ExecutionRoutingSurface,
  exactBlocker: ExecutionRoutingExactBlocker
): string {
  if (exactBlocker) return `blocked:${exactBlocker}`;
  if (selectedRoute) return `route=${selectedRoute.id} surface=${executionSurface}`;
  return `no_route_selected surface=${executionSurface}`;
}

function buildEvidence(input: {
  controller: ExecutionRoutingSnapshot["controller"];
  phase: ExecutionRoutingPhase;
  executionSurface: ExecutionRoutingSurface;
  selectedRoute: CapabilityRoute | undefined;
  plannedAdapters: string[];
  fingerprint: string;
  exactBlocker: ExecutionRoutingExactBlocker;
  selectedAdapter: string | null;
}): string[] {
  const adapterPolicy = input.selectedAdapter === "playwright_cli" || input.selectedAdapter === "browser_use_cli" ? "chrome_extension_only" : "default";
  return [
    "schema=route_decision",
    `controller=${input.controller.name}`,
    `controller_status=${input.controller.status}`,
    `phase=${input.phase}`,
    `surface=${input.executionSurface}`,
    `intent=${normalizeCommand(input.fingerprint) ? "normalized_command" : "normalized_command"}`,
    `planned_adapters=${input.plannedAdapters.join(",")}`,
    `adapter=${input.selectedAdapter ?? "none"}`,
    `adapter_policy=${adapterPolicy}`,
    input.selectedRoute ? `route=${input.selectedRoute.id}` : "route=none",
    input.selectedRoute ? `authority=${input.selectedRoute.authority}` : "authority=none",
    input.selectedRoute ? `proof=${input.selectedRoute.proof}` : "proof=none",
    `fingerprint=${input.fingerprint}`,
    `exactBlocker=${input.exactBlocker ?? "none"}`
  ];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function buildRoutingFingerprint(input: RoutingFingerprintFields): string {
  return createHash("sha256").update(JSON.stringify({
    schema: input.schema,
    controllerName: input.controllerName,
    intent: normalizeCommand(input.intent),
    surface: input.surface,
    plannedAdapters: input.plannedAdapters,
    authority: input.authority,
    source: input.source,
    selectedRouteId: input.selectedRouteId,
    selectedRouteLabel: input.selectedRouteLabel,
    selectedLane: input.selectedLane
  })).digest("hex");
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function isRouteDecisionSchema(value: unknown): value is "route_decision" {
  return value === "route_decision";
}

function isExecutionRoutingSurface(value: unknown): value is ExecutionRoutingSurface {
  return value === "browser_lane" || value === "codex_cli" || value === "registered_runner" || value === "worker_loop";
}

function isRouteDecisionController(
  value: unknown
): value is { name: ExecutionRoutingController; status: "connected" | "readback" | "inventory_only"; reason: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).name === "automation_os_api" &&
    typeof (value as Record<string, unknown>).status === "string" &&
    typeof (value as Record<string, unknown>).reason === "string"
  );
}

function isCanonicalPlannedAdapters(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isRouteDecisionAuthority(value: unknown): value is CapabilityRouteAuthority | "none" {
  return value === "catalog" || value === "runtime" || value === "connected" || value === "none";
}

function isExecutionRoutingExactBlocker(value: unknown): value is ExecutionRoutingExactBlocker {
  return value === null || value === "chrome_extension_required" || value === "route_readback_mismatch" || value === "route_decision_missing";
}
