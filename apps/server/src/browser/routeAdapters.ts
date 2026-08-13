import type { BrowserSurface } from "./browserKernel.js";

export const BROWSER_ROUTE_ADAPTER_SCHEMA_V1 = "automation_os_browser_route_adapter.v1" as const;

export type BrowserRouteAdapterSdkV1 = {
  discover: "semantic_observe_then_route_resolution";
  fill: "kernel_fill_command";
  upload: "kernel_upload_command";
  submit: "kernel_submit_command";
  confirm: "visible_provider_confirmation_and_source_readback";
};

export type BrowserRouteAdapterV1 = {
  schema: typeof BROWSER_ROUTE_ADAPTER_SCHEMA_V1;
  id: "linkedin" | "greenhouse" | "lever" | "workable" | "ashby" | "hrmos" | "smartrecruiters" | "workday" | "company_form" | "codex_app_surface";
  provider: string;
  surface: BrowserSurface | "any";
  match: readonly string[];
  capabilities: readonly ["observe", "locate", "scroll", "click", "fill", "select", "upload", "wait", "extract", "submit", "verify"];
  selector_authority: "semantic_only";
  effect_admission: "kernel";
  unknown_required_fact: "fail_closed";
  sdk: BrowserRouteAdapterSdkV1;
};

const CAPABILITIES = ["observe", "locate", "scroll", "click", "fill", "select", "upload", "wait", "extract", "submit", "verify"] as const;

export const browserRouteAdapters: readonly BrowserRouteAdapterV1[] = Object.freeze([
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "linkedin", provider: "linkedin", surface: "any", match: ["linkedin.com"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "greenhouse", provider: "greenhouse", surface: "any", match: ["greenhouse.io", "boards.greenhouse"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "lever", provider: "lever", surface: "any", match: ["lever.co", "jobs.lever"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "workable", provider: "workable", surface: "any", match: ["workable.com"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "ashby", provider: "ashby", surface: "any", match: ["ashbyhq.com", "jobs.ashbyhq"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "hrmos", provider: "hrmos", surface: "any", match: ["hrmos.co", "hrmos.jp"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "smartrecruiters", provider: "smartrecruiters", surface: "any", match: ["smartrecruiters.com"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "workday", provider: "workday", surface: "any", match: ["myworkdayjobs.com", "workday.com"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "company_form", provider: "company_form", surface: "any", match: ["form", "application", "careers", "jobs"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
  { schema: BROWSER_ROUTE_ADAPTER_SCHEMA_V1, id: "codex_app_surface", provider: "codex_app_browser", surface: "codex_app_browser", match: ["codex_app_browser"], capabilities: CAPABILITIES, selector_authority: "semantic_only", effect_admission: "kernel", unknown_required_fact: "fail_closed", sdk: { discover: "semantic_observe_then_route_resolution", fill: "kernel_fill_command", upload: "kernel_upload_command", submit: "kernel_submit_command", confirm: "visible_provider_confirmation_and_source_readback" } },
]);

export function resolveBrowserRouteAdapter(input: { origin?: string; title?: string; visibleText?: string; surface?: BrowserSurface }): BrowserRouteAdapterV1 | null {
  const haystack = [input.origin, input.title, input.visibleText, input.surface].filter(Boolean).join(" ").toLocaleLowerCase();
  const exactSurface = browserRouteAdapters.find((adapter) => adapter.surface !== "any" && adapter.surface === input.surface);
  if (exactSurface) return exactSurface;
  return browserRouteAdapters.find((adapter) => adapter.match.some((signal) => haystack.includes(signal))) ?? null;
}
