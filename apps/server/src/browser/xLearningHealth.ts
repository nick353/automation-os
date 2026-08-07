import { xLearningLane } from "./xLearningLane.js";
import { getBrowserHealth } from "./health.js";

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
  void fetchImpl;
  const browserUse = getBrowserHealth().browserUseCli;
  return blocked(
    browserUse.available ? "browser_use_authority_required" : "browser_use_cli_missing",
    browserUse.available
      ? "Browser Use CLIはfresh authority/profile/portとsame-session readbackが必要です。"
      : "Canonical Browser Use CLI helper is unavailable."
  );
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
