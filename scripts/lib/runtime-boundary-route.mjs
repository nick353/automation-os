import { existsSync, readFileSync } from "node:fs";

function selectorRoute(selectorPath) {
  if (!selectorPath || !existsSync(selectorPath)) {
    return { backend: null, surface: null };
  }
  try {
    const selector = JSON.parse(readFileSync(selectorPath, "utf8"));
    const chromeProfile = selector?.chrome_profile && typeof selector.chrome_profile === "object"
      ? selector.chrome_profile
      : {};
    return {
      backend: typeof selector?.backend === "string" ? selector.backend : null,
      surface: typeof selector?.surface === "string"
        ? selector.surface
        : typeof chromeProfile.surface === "string" ? chromeProfile.surface : null
    };
  } catch {
    return { backend: null, surface: null };
  }
}

export function runtimeBoundaryNextAction(selectorPath) {
  const route = selectorRoute(selectorPath);
  if (route.backend === "chrome_plugin") {
    return "Use the official Chrome Plugin/Profile 2 route; retain the same-run get/openTabs proof, owner lineage, receipt/readback, and task-owned cleanup.";
  }
  if (route.backend === "aos_chrome_companion") {
    return "Use the AOS Chrome Companion route; retain its frozen route decision, same-run receipt/readback, and task-owned cleanup.";
  }
  return "Use the selected browser route; retain its frozen route decision, same-run receipt/readback, and task-owned cleanup.";
}
