import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { buildReadbackHeaders, readProductionReadToken, readProductionReadTokenStatus } from "./productionReadbackAuth.mjs";

const baseUrl = (process.env.AUTOMATION_OS_PRODUCTION_URL || process.argv[2] || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-").replace(/-$/u, "");
const outDir = resolve(process.env.AUTOMATION_OS_QA_OUTPUT_DIR || join("/tmp", `automation-os-production-qa-${stamp}`));
const localWebDist = resolve(process.env.AUTOMATION_OS_LOCAL_WEB_DIST || join(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd(), "dist"));
const readToken = readProductionReadToken();
const readTokenStatus = readProductionReadTokenStatus();
mkdirSync(outDir, { recursive: true });

const result = {
  baseUrl,
  outDir,
  generatedAt: new Date().toISOString(),
  readTokenAvailable: Boolean(readToken),
  readTokenSource: readTokenStatus.source,
  readTokenExactBlocker: readTokenStatus.exactBlocker,
  api: [],
  endpointAliases: {},
  compatibilityMode: false,
  deployment: null,
  assets: null,
  screenshots: [],
  failures: []
};

// installScopedReadbackRoute is deliberately not implemented here: UI
// navigation and screenshots belong exclusively to the canonical Browser Use
// CLI session, never to a Playwright or direct browser fallback.

result.api.push(await checkApi("/api/health", { required: true, routeType: "health", includeReadToken: false }));

if (readToken) {
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
} else {
  result.protectedReadback = {
    status: "blocked",
    attempted: false,
    exact_blocker: readTokenStatus.exactBlocker,
    routes: [
      "/api/dashboard",
      "/api/mvp/state",
      "/api/registered-workflows",
      "/api/mvp/registered-automations?project_id=project-a",
      "/api/browser/health",
      "/api/mvp/feedback"
    ]
  };
  result.failures.push(`protected_readback:${readTokenStatus.exactBlocker}`);
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

    // The public health route intentionally omits deployment metadata. The
    // protected dashboard is the authoritative production read-only source
    // for commit/runtime-asset parity, so retain only the sanitized fields
    // when that route is selected.
    if (route === "/api/dashboard" && parsed && typeof parsed === "object") {
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
      css: css ? new URL(css, `${baseUrl}/`).href : "",
      publicReadback: {},
      localParity: {
        status: "pending",
        checks: {}
      }
    };
    if (!response.ok) result.failures.push(`/: http_${response.status}`);
    if (!js) result.failures.push("/: missing_js_asset");
    if (!css) result.failures.push("/: missing_css_asset");

    const assetSpecs = [
      { kind: "js", href: js },
      { kind: "css", href: css }
    ];
    for (const asset of assetSpecs) {
      if (!asset.href) continue;
      const assetUrl = new URL(asset.href, `${baseUrl}/`);
      const publicReadback = await readServedAsset(assetUrl, headers);
      result.assets.publicReadback[asset.kind] = publicReadback;
      const localParity = compareLocalAsset(assetUrl, publicReadback);
      result.assets.localParity.checks[asset.kind] = localParity;
      if (localParity.status === "mismatch") {
        result.failures.push(`public_local_asset_parity_mismatch:${asset.kind}`);
      } else if (localParity.status === "blocked") {
        result.failures.push(`${localParity.exactBlocker}:${asset.kind}`);
      }
    }
    const parityStatuses = Object.values(result.assets.localParity.checks).map((entry) => entry.status);
    result.assets.localParity.status = parityStatuses.length === 0
      ? "blocked"
      : parityStatuses.every((status) => status === "match")
        ? "verified"
        : parityStatuses.includes("mismatch")
          ? "mismatch"
          : "blocked";
  } catch (error) {
    result.failures.push(`/: ${error instanceof Error ? error.message : "request_failed"}`);
  }
}

async function readServedAsset(assetUrl, headers) {
  try {
    const response = await fetch(assetUrl, Object.keys(headers).length ? { headers } : undefined);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      ok: response.ok,
      sha256: sha256(bytes),
      bytes: bytes.byteLength
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      sha256: "",
      bytes: 0,
      exactBlocker: error instanceof Error ? error.message : "public_asset_readback_failed"
    };
  }
}

function compareLocalAsset(assetUrl, publicReadback) {
  const fileName = basename(assetUrl.pathname);
  if (!/^index-[A-Za-z0-9._-]+\.(?:js|css)$/u.test(fileName)) {
    return { status: "blocked", exactBlocker: "public_asset_filename_untrusted" };
  }
  if (!publicReadback.ok || !publicReadback.sha256) {
    return { status: "blocked", exactBlocker: "public_asset_readback_failed" };
  }
  const localAssetsRoot = resolve(localWebDist, "assets");
  const localPath = resolve(localAssetsRoot, fileName);
  if (!localPath.startsWith(`${localAssetsRoot}${sep}`)) {
    return { status: "blocked", exactBlocker: "local_asset_path_invalid" };
  }
  if (!existsSync(localPath)) {
    const candidates = existsSync(localAssetsRoot)
      ? readdirSync(localAssetsRoot).filter((entry) => new RegExp(`^index-[A-Za-z0-9._-]+\\.${assetExtension(fileName)}$`, "u").test(entry))
      : [];
    if (candidates.length === 1) {
      const localFileName = candidates[0];
      const localBytes = readFileSync(resolve(localAssetsRoot, localFileName));
      const localSha256 = sha256(localBytes);
      return {
        status: localSha256 === publicReadback.sha256 ? "match" : "mismatch",
        fileName,
        localFileName,
        publicSha256: publicReadback.sha256,
        localSha256,
        publicBytes: publicReadback.bytes,
        localBytes: localBytes.byteLength
      };
    }
    return {
      status: "blocked",
      exactBlocker: candidates.length > 1 ? "local_web_asset_name_not_unique" : "local_web_asset_missing",
      fileName,
      candidateFileNames: candidates
    };
  }
  const localBytes = readFileSync(localPath);
  const localSha256 = sha256(localBytes);
  return {
    status: localSha256 === publicReadback.sha256 ? "match" : "mismatch",
    fileName,
    publicSha256: publicReadback.sha256,
    localSha256,
    publicBytes: publicReadback.bytes,
    localBytes: localBytes.byteLength
  };
}

function assetExtension(fileName) {
  return fileName.endsWith(".css") ? "css" : "js";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeDeploymentReadback(deployment) {
  if (!deployment || typeof deployment !== "object") return null;
  const assets = deployment.assets && typeof deployment.assets === "object" ? deployment.assets : {};
  const runtimeParity = deployment.runtimeParity && typeof deployment.runtimeParity === "object" ? deployment.runtimeParity : {};
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
    },
    runtimeParity: {
      status: typeof runtimeParity.status === "string" ? runtimeParity.status : "",
      schema: typeof runtimeParity.schema === "string" ? runtimeParity.schema : "",
      artifactHash: typeof runtimeParity.artifactHash === "string" ? runtimeParity.artifactHash : "",
      fileCount: typeof runtimeParity.fileCount === "number" ? runtimeParity.fileCount : 0,
      generatedAt: typeof runtimeParity.generatedAt === "string" ? runtimeParity.generatedAt : "",
      exactBlocker: typeof runtimeParity.exactBlocker === "string" ? runtimeParity.exactBlocker : null
    }
  };
}

async function captureScreenshot(label, viewport) {
  const path = join(outDir, `${label}.png`);
  const harPath = join(outDir, `${label}.har`);
  const redactedHar = redactHarFile(harPath);
  if (!readToken) {
    result.screenshots.push({ label, viewport, path: null, ...redactedHar, status: null, exactBlocker: "production_read_token_missing" });
    result.failures.push(`screenshot_${label}: production_read_token_missing`);
    return;
  }
  result.screenshots.push({
    label,
    viewport,
    path: null,
    ...redactedHar,
    status: null,
    exactBlocker: "browser_use_cli_runtime_required",
    detail: "Production UI screenshots require a fresh same-run Browser Use CLI authority/profile/port and recording proof."
  });
  result.failures.push(`screenshot_${label}: browser_use_cli_runtime_required`);
}

function redactHarFile(_harPath) {
  // HAR capture remains disabled here. Browser Use CLI owns authenticated UI
  // recording and any resulting artifact redaction in its same-run receipt.
  return { harPath: null, harStatus: "browser_use_cli_runtime_required" };
}
