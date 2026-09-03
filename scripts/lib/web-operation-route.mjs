/**
 * Canonical AOS web-operation route selection.
 *
 * Every runner must derive the backend and browser surface from this module.
 * Keeping the fallback/default in one place prevents a long-lived worker from
 * admitting a Companion surface and then launching the Browser Use runner (or
 * the reverse) after an environment refresh.
 */
export const DEFAULT_WEB_OPERATION_BACKEND = "chrome_plugin";
export const CHROME_PLUGIN_BROWSER_SURFACE = "signed_chrome_extension_profile2";
export const AOS_CHROME_COMPANION_BROWSER_SURFACE = "aos_chrome_companion_profile_instance";

export function normalizeWebOperationBackend(environment = process.env, { defaultBackend = DEFAULT_WEB_OPERATION_BACKEND } = {}) {
  const raw = environment?.AOS_WEB_OPERATION_BACKEND
    ?? environment?.AUTOMATION_OS_BROWSER_DRIVER
    ?? defaultBackend;
  const value = String(raw || defaultBackend).trim().toLowerCase().replaceAll("-", "_");
  return value || defaultBackend;
}

export function webOperationBrowserSurface(environment = process.env, { defaultBackend = DEFAULT_WEB_OPERATION_BACKEND } = {}) {
  const backend = normalizeWebOperationBackend(environment, { defaultBackend });
  if (backend === "chrome_plugin") return String(environment?.AOS_CHROME_PROFILE_SURFACE || CHROME_PLUGIN_BROWSER_SURFACE).trim();
  if (backend === "aos_chrome_companion") return AOS_CHROME_COMPANION_BROWSER_SURFACE;
  return backend === "playwright" ? "playwright" : "browser_use_cli";
}

export function webOperationRouteSnapshot(environment = process.env) {
  const backend = normalizeWebOperationBackend(environment);
  const surface = webOperationBrowserSurface(environment);
  return Object.freeze({
    backend,
    browserSurface: surface,
    source: String(environment?.AOS_WEB_OPERATION_BACKEND_SOURCE || "environment").trim() || "environment",
    fallbackAllowed: String(environment?.AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED || "").trim().toLowerCase() === "true",
    revision: Number(String(environment?.AOS_WEB_OPERATION_BACKEND_REVISION || "").trim()) || null,
  });
}
