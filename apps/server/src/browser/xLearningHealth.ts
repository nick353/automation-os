import { xLearningLane } from "./xLearningLane.js";

export type XLearningHealthResult =
  | {
      ok: true;
      laneName: typeof xLearningLane.name;
      port: typeof xLearningLane.port;
      profileDir: typeof xLearningLane.profileDir;
      endpoint: typeof xLearningLane.versionUrl;
      browser?: string;
      webSocketDebuggerUrl?: string;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      laneName: typeof xLearningLane.name;
      port: typeof xLearningLane.port;
      profileDir: typeof xLearningLane.profileDir;
      endpoint: typeof xLearningLane.versionUrl;
      exactBlocker: string;
      summary: string;
    };

export async function getXLearningChromeHealth(fetchImpl: typeof fetch = fetch): Promise<XLearningHealthResult> {
  try {
    const response = await fetchImpl(xLearningLane.versionUrl);
    if (!response.ok) {
      return blocked(`x_learning_cdp_http_${response.status}`, `CDP version endpoint returned HTTP ${response.status}`);
    }
    const raw = await response.json() as Record<string, unknown>;
    return {
      ok: true,
      laneName: xLearningLane.name,
      port: xLearningLane.port,
      profileDir: xLearningLane.profileDir,
      endpoint: xLearningLane.versionUrl,
      browser: typeof raw.Browser === "string" ? raw.Browser : undefined,
      webSocketDebuggerUrl: typeof raw.webSocketDebuggerUrl === "string" ? raw.webSocketDebuggerUrl : undefined,
      raw
    };
  } catch (error) {
    return blocked("x_learning_cdp_unavailable", error instanceof Error ? error.message : "CDP version endpoint is unavailable");
  }
}

function blocked(exactBlocker: string, summary: string): XLearningHealthResult {
  return {
    ok: false,
    laneName: xLearningLane.name,
    port: xLearningLane.port,
    profileDir: xLearningLane.profileDir,
    endpoint: xLearningLane.versionUrl,
    exactBlocker,
    summary
  };
}
