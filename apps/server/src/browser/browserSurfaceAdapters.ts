import { browserKernelContract, type BrowserSurface } from "./browserKernel.js";

export type BrowserSurfaceAdapterV1 = {
  id: "canonical_browser_use_cli" | "codex_app_browser_bridge";
  surface: BrowserSurface;
  kernel_schema: typeof browserKernelContract.schema;
  command_transport: "canonical_cli_stage_adapter" | "codex_app_browser_capability_bridge";
  same_run_session_binding: true;
  semantic_resolution: true;
  coordinate_fallback: "last_resort_only";
  external_effect_approval: "kernel_only";
  receipt_source_sync_reconciliation_cleanup: true;
};

export const browserSurfaceAdapters: readonly BrowserSurfaceAdapterV1[] = Object.freeze([
  { id: "canonical_browser_use_cli", surface: "browser_use_cli", kernel_schema: browserKernelContract.schema, command_transport: "canonical_cli_stage_adapter", same_run_session_binding: true, semantic_resolution: true, coordinate_fallback: "last_resort_only", external_effect_approval: "kernel_only", receipt_source_sync_reconciliation_cleanup: true },
  { id: "codex_app_browser_bridge", surface: "codex_app_browser", kernel_schema: browserKernelContract.schema, command_transport: "codex_app_browser_capability_bridge", same_run_session_binding: true, semantic_resolution: true, coordinate_fallback: "last_resort_only", external_effect_approval: "kernel_only", receipt_source_sync_reconciliation_cleanup: true },
]);

export function browserSurfaceAdapter(surface: BrowserSurface): BrowserSurfaceAdapterV1 {
  const adapter = browserSurfaceAdapters.find((candidate) => candidate.surface === surface);
  if (!adapter) throw new Error("browser_surface_adapter_missing");
  return adapter;
}
