import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const baseUrl = (process.env.AUTOMATION_OS_PRODUCTION_URL || process.argv[2] || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-").replace(/-$/u, "");
const outDir = resolve(process.env.AUTOMATION_OS_QA_OUTPUT_DIR || join("/tmp", `automation-os-production-qa-${stamp}`));
mkdirSync(outDir, { recursive: true });

const result = {
  baseUrl,
  outDir,
  generatedAt: new Date().toISOString(),
  api: [],
  endpointAliases: {},
  compatibilityMode: false,
  deployment: null,
  assets: null,
  screenshots: [],
  failures: []
};

await checkApi("/api/health", { required: true, routeType: "health" });

const dashboardReadback = await checkPreferredRoute([
  { route: "/api/dashboard", required: false },
  { route: "/api/mvp/state", required: false }
]);
await checkPreferredRoute([
  { route: "/api/registered-workflows", required: false },
  { route: "/api/mvp/registered-automations?project_id=project-a", required: false }
]);
await checkPreferredRoute([
  { route: "/api/browser/health", required: false },
  { route: "/api/mvp/feedback", required: false }
]);

if (dashboardReadback.foundRoute !== "/api/dashboard") {
  result.compatibilityMode = true;
}

await checkServedAssets();
captureScreenshot("desktop", "1440,1000");
captureScreenshot("mobile", "390,844");

writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.failures.length ? 1 : 0);

async function checkApi(route, options = {}) {
  const entry = await checkRoute(route, options);
  return entry;
}

async function checkPreferredRoute(candidates) {
  const routeEntries = [];
  const chosen = await getPreferredRoute(candidates);

  if (chosen.entry) {
    if (chosen.fallbackUsed) {
      result.compatibilityMode = true;
    }
    result.api.push(chosen.entry);
    if (chosen.fallbackUsed) {
      result.endpointAliases[chosen.fallbackUsed.alias] = {
        selected: chosen.entry.route,
        attempted: candidates.map((candidate) => candidate.route),
        fallbackUsed: true
      };
    }
    return chosen;
  }

  for (const candidate of candidates) {
    routeEntries.push(candidate.route);
    result.api.push(await checkRoute(candidate.route, { required: false, ...candidate }));
  }

  const allRoutes = routeEntries.join(", ");
  const anyRouteAttempted = candidates.length ? candidates[0].route : "unknown";
  result.failures.push(`${anyRouteAttempted}: all_candidate_routes_unreachable`);
  return { entries: routeEntries };
}

async function getPreferredRoute(candidates) {
  const attempted = [];
  for (const candidate of candidates) {
    attempted.push(candidate.route);
    const entry = await checkRoute(candidate.route, { required: false, ...candidate });
    if (!entry.failed && entry.json && (entry.status >= 200 && entry.status < 300)) {
      return {
        foundRoute: candidate.route,
        entry,
        fallbackUsed: candidate.route === candidates[0].route ? null : {
          alias: candidate.route
        }
      };
    }
  }
  return {
    foundRoute: null,
    attempted
  };
}

async function checkRoute(route, options = {}) {
  const { required = false, routeType = "" } = options;
  try {
    const response = await fetch(`${baseUrl}${route}`);
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    const entry = {
      route,
      requestedRouteType: routeType,
      status: response.status,
      contentType,
      json: Boolean(parsed),
      bodyHead: text.slice(0, 240),
      jsonPreview: summarizeRouteJson(route, parsed)
    };

    if (routeType === "health" && parsed && typeof parsed === "object") {
      result.deployment = sanitizeDeploymentReadback(parsed.deployment);
    }

    if (!response.ok) {
      entry.failed = true;
      entry.failureReason = `http_${response.status}`;
    }
    if (!contentType.includes("application/json")) {
      entry.failed = true;
      entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}non_json_content_type`;
    }
    if (!parsed || typeof parsed !== "object") {
      entry.failed = true;
      entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}invalid_json_body`;
    }

    if (route === "/api/dashboard") {
      if (!Array.isArray(parsed?.runs) || !Array.isArray(parsed?.registeredWorkflows)) {
        entry.failed = true;
        entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}missing_dashboard_fields`;
      }
    }

    if ((route === "/api/mvp/state") && parsed && typeof parsed === "object") {
      if (typeof parsed?.worker?.status !== "string" || !Array.isArray(parsed?.automations)) {
        entry.failed = true;
        entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}invalid_mvp_state_shape`;
      }
    }

    if ((route === "/api/registered-workflows") && parsed && typeof parsed === "object") {
      if (!Array.isArray(parsed?.workflows)) {
        entry.failed = true;
        entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}missing_registered_workflows`;
      }
    }

    if ((route === "/api/mvp/registered-automations") || route.startsWith("/api/mvp/registered-automations")) {
      if (!Array.isArray(parsed?.automations)) {
        entry.failed = true;
        entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}missing_mvp_registered_automations`;
      }
    }

    if (route === "/api/browser/health") {
      if (typeof parsed?.playwrightCli?.status !== "string" && typeof parsed?.playwrightCli?.available !== "boolean") {
        entry.failed = true;
        entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}invalid_browser_health_shape`;
      }
    }

    if (route === "/api/mvp/feedback") {
      if (typeof parsed?.count !== "number") {
        entry.failed = true;
        entry.failureReason = `${entry.failureReason ? `${entry.failureReason}; ` : ""}invalid_feedback_shape`;
      }
    }

    if (required && entry.failed) {
      result.failures.push(`${route}: ${entry.failureReason || "required_route_failed"}`);
    }

    if (!entry.failed) {
      entry.failed = false;
    }
    return entry;
  } catch (error) {
    const entry = {
      route,
      requestedRouteType: routeType,
      status: 0,
      contentType: "",
      json: false,
      bodyHead: "",
      jsonPreview: null,
      failed: true,
      failureReason: error instanceof Error ? error.message : "request_failed"
    };
    if (required) result.failures.push(`${route}: ${entry.failureReason}`);
    return entry;
  }
}

function summarizeRouteJson(route, body) {
  if (!body || typeof body !== "object") return null;
  if (route === "/api/health") {
    return {
      ok: body.ok === true,
      productionGuard: body.productionGuard,
      workerStatus: body.state?.worker?.status,
      persistence: body.persistence ? {
        adapter: body.persistence.adapter,
        requested_adapter: body.persistence.requested_adapter,
        exact_blocker: body.persistence.exact_blocker
      } : undefined
    };
  }
  if (route === "/api/dashboard") {
    return {
      runsCount: Array.isArray(body.runs) ? body.runs.length : 0,
      registeredWorkflowsCount: Array.isArray(body.registeredWorkflows) ? body.registeredWorkflows.length : 0
    };
  }
  if (route === "/api/mvp/state") {
    return {
      workerStatus: body.worker?.status,
      heartbeatFresh: body.worker?.heartbeat_fresh,
      exactBlocker: body.worker?.exact_blocker || body.worker?.exactBlocker || null,
      automationCount: Array.isArray(body.automations) ? body.automations.length : 0
    };
  }
  if (route === "/api/registered-workflows") {
    return {
      workflowsCount: Array.isArray(body.workflows) ? body.workflows.length : 0
    };
  }
  if (route.startsWith("/api/mvp/registered-automations")) {
    return {
      automationCount: typeof body.automation_count === "number" ? body.automation_count : Array.isArray(body.automations) ? body.automations.length : 0
    };
  }
  return body;
}

async function checkServedAssets() {
  try {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    writeFileSync(join(outDir, "index.html"), html);
    const js = html.match(/src="([^"]+index-[^"]+\.js)"/u)?.[1] || "";
    const css = html.match(/href="([^"]+index-[^"]+\.css)"/u)?.[1] || "";
    result.assets = {
      status: response.status,
      js: js ? new URL(js, `${baseUrl}/`).href : "",
      css: css ? new URL(css, `${baseUrl}/`).href : ""
    };
    if (!response.ok) result.failures.push(`/: http_${response.status}`);
    if (!js) result.failures.push("/: missing_js_asset");
    if (!css) result.failures.push("/: missing_css_asset");
  } catch (error) {
    result.failures.push(`/: ${error instanceof Error ? error.message : "request_failed"}`);
  }
}

function sanitizeDeploymentReadback(deployment) {
  if (!deployment || typeof deployment !== "object") return null;
  const assets = deployment.assets && typeof deployment.assets === "object" ? deployment.assets : {};
  return {
    commit: typeof deployment.commit === "string" ? deployment.commit : "",
    commitSource: typeof deployment.commitSource === "string" ? deployment.commitSource : "",
    version: typeof deployment.version === "string" ? deployment.version : "",
    plannerProvider: typeof deployment.plannerProvider === "string" ? deployment.plannerProvider : "",
    nodeEnv: typeof deployment.nodeEnv === "string" ? deployment.nodeEnv : "",
    assets: {
      indexFound: assets.indexFound === true,
      js: typeof assets.js === "string" ? assets.js : "",
      css: typeof assets.css === "string" ? assets.css : ""
    }
  };
}

function captureScreenshot(label, viewport) {
  const path = join(outDir, `${label}.png`);
  const harPath = join(outDir, `${label}.har`);
  const run = spawnSync(
    "npx",
    ["playwright", "screenshot", "--full-page", "--viewport-size", viewport, "--save-har", harPath, baseUrl, path],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const entry = {
    label,
    viewport,
    path,
    harPath,
    status: run.status,
    stdout: run.stdout.trim(),
    stderr: run.stderr.trim()
  };
  result.screenshots.push(entry);
  if (run.status !== 0) {
    result.failures.push(`screenshot_${label}: ${run.stderr.trim() || `exit_${run.status}`}`);
  }
}
