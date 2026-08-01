const readTokenEnvNames = [
  "AUTOMATION_OS_READ_TOKEN",
  "AUTOMATION_OS_QA_READ_TOKEN",
  "AUTOMATION_OS_REPLAY_READ_TOKEN"
];

export function readProductionReadToken(env = process.env) {
  for (const envName of readTokenEnvNames) {
    const token = env[envName];
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return "";
}

export function buildReadbackHeaders(readToken) {
  const token = typeof readToken === "string" ? readToken.trim() : "";
  return token ? { "x-automation-os-token": token } : {};
}

export function buildReadbackContextOptions(readToken) {
  const headers = buildReadbackHeaders(readToken);
  return Object.keys(headers).length ? { extraHTTPHeaders: headers } : {};
}
