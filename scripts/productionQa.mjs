import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildReadbackHeaders, readProductionReadToken } from "./productionReadbackAuth.mjs";

const baseUrl = (process.env.AUTOMATION_OS_PRODUCTION_URL || process.argv[2] || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-").replace(/-$/u, "");
const outDir = resolve(process.env.AUTOMATION_OS_QA_OUTPUT_DIR || join("/tmp", `automation-os-production-qa-${stamp}`));
const readToken = readProductionReadToken();
mkdirSync(outDir, { recursive: true });

const result = {
  baseUrl,
  outDir,
  generatedAt: new Date().toISOString(),
  readTokenAvailable: Boolean(readToken),
  api: [],
  endpointAliases: {},
  compatibilityMode: false,
  deployment: null,
  assets: null,
  screenshots: [],
  failures: []
};

await checkApi("/api/health", { required: true, routeType: "health", includeReadToken: false });

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
await captureScreenshot("desktop", "1440,1000");
await captureScreenshot("mobile", "390,844");

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
  const { required = false, routeType = "", includeReadToken = route !== "/api/health" } = options;
  try {
    const headers = includeReadToken ? buildReadbackHeaders(readToken) : {};
    const response = await fetch(`${baseUrl}${route}`, Object.keys(headers).length ? { headers } : undefined);
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
    const headers = buildReadbackHeaders(readToken);
    const response = await fetch(`${baseUrl}/`, Object.keys(headers).length ? { headers } : undefined);
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

async function captureScreenshot(label, viewport) {
  const path = join(outDir, `${label}.png`);
  const harPath = join(outDir, `${label}.har`);
  if (!readToken) {
    result.screenshots.push({ label, viewport, path, harPath, status: null, exactBlocker: "production_read_token_missing" });
    result.failures.push(`screenshot_${label}: production_read_token_missing`);
    return;
  }
  const [width, height] = viewport.split(",").map((value) => Number(value));
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    recordHar: { path: harPath, content: "embed" }
  });
  const page = await context.newPage();
  await installScopedReadbackRoute(page, baseUrl, readToken);
  const consoleErrors = [];
  const protectedApiFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("response", (response) => {
    try {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith("/api/") && [401, 403, 423].includes(response.status())) {
        protectedApiFailures.push(`${response.status()}:${pathname}`);
      }
    } catch {
      // Ignore non-URL response observations; navigation status remains authoritative.
    }
  });
  let status = 0;
  let error = "";
  try {
    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    status = response?.status() ?? 0;
    await page.screenshot({ path, fullPage: true });
    if (status < 200 || status >= 400) error = `http_${status}`;
    if (protectedApiFailures.length) error = error || "protected_api_auth_failed";
    if (consoleErrors.length) error = error || "console_errors";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await context.close();
    await browser.close();
    redactHarFile(harPath, readToken);
  }
  result.screenshots.push({ label, viewport, path, harPath, status, consoleErrors, protectedApiFailures, error });
  if (error) {
    result.failures.push(`screenshot_${label}: ${error}`);
  }
}

async function installScopedReadbackRoute(page, targetUrl, readToken) {
  const targetOrigin = new URL(targetUrl).origin;
  const readbackHeaders = buildReadbackHeaders(readToken);
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== targetOrigin || !requestUrl.pathname.startsWith("/api/") || !Object.keys(readbackHeaders).length) {
      await route.continue();
      return;
    }
    await route.continue({ headers: { ...route.request().headers(), ...readbackHeaders } });
  });
}

function redactHarFile(path, readToken) {
  if (!readToken || !existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    redactHarNode(parsed, readToken);
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    // A missing/non-JSON HAR remains an artifact failure for the caller to inspect.
  }
}

function redactHarNode(value, readToken, key = "") {
  if (Array.isArray(value)) {
    if (key.toLowerCase().includes("header")) {
      for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          redactHarNode(item, readToken, key);
          continue;
        }
        const headerName = String(item.name ?? "").toLowerCase();
        const headerValue = typeof item.value === "string" ? item.value : "";
        if (headerName.includes("authorization") || headerName.includes("token") || headerValue.includes(readToken)) {
          if (typeof item.value === "string") item.value = "[redacted]";
        } else {
          redactHarNode(item, readToken, key);
        }
      }
      return;
    }
    for (const item of value) redactHarNode(item, readToken, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    const normalizedKey = childKey.toLowerCase();
    if (normalizedKey.includes("authorization") || normalizedKey.includes("token")) {
      if (typeof childValue === "string") value[childKey] = "[redacted]";
      else redactHarNode(childValue, readToken, childKey);
      continue;
    }
    if (typeof childValue === "string") {
      value[childKey] = childValue.split(readToken).join("[redacted]");
    } else {
      redactHarNode(childValue, readToken, childKey);
    }
  }
}

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire("playwright");
  } catch (localError) {
    const bundledModuleRoot = process.env.AUTOMATION_OS_PLAYWRIGHT_NODE_MODULES
      || join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
    const bundledPackage = join(bundledModuleRoot, "playwright", "package.json");
    if (existsSync(bundledPackage)) return createRequire(bundledPackage)("playwright");
    throw localError;
  }
}
