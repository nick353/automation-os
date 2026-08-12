import { lstatSync, readFileSync } from "node:fs";

const readTokenEnvNames = [
  "AUTOMATION_OS_READ_TOKEN",
  "AUTOMATION_OS_QA_READ_TOKEN",
  "AUTOMATION_OS_REPLAY_READ_TOKEN"
];

const readTokenFileEnvNames = [
  "AUTOMATION_OS_READ_TOKEN_FILE",
  "AUTOMATION_OS_QA_READ_TOKEN_FILE",
  "AUTOMATION_OS_REPLAY_READ_TOKEN_FILE"
];

function readTokenFile(pathValue) {
  const path = typeof pathValue === "string" ? pathValue.trim() : "";
  if (!path || !path.startsWith("/")) return { token: "", exactBlocker: "production_read_token_file_path_invalid" };
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { token: "", exactBlocker: "production_read_token_file_unreadable" };
  }
  const mode = stat.mode & 0o777;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) {
    return { token: "", exactBlocker: "production_read_token_file_permissions_invalid" };
  }
  try {
    const token = readFileSync(path, "utf8").trim();
    return token
      ? { token, exactBlocker: null }
      : { token: "", exactBlocker: "production_read_token_file_empty" };
  } catch {
    return { token: "", exactBlocker: "production_read_token_file_unreadable" };
  }
}

export function readProductionReadTokenStatus(env = process.env) {
  for (const envName of readTokenEnvNames) {
    const token = env[envName];
    if (typeof token === "string" && token.trim()) {
      return { available: true, source: "environment", exactBlocker: null };
    }
  }
  for (const envName of readTokenFileEnvNames) {
    const path = env[envName];
    if (typeof path === "string" && path.trim()) {
      const result = readTokenFile(path);
      return { available: Boolean(result.token), source: "file", exactBlocker: result.exactBlocker };
    }
  }
  return { available: false, source: "none", exactBlocker: "production_read_token_missing" };
}

export function readProductionReadToken(env = process.env) {
  for (const envName of readTokenEnvNames) {
    const token = env[envName];
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  for (const envName of readTokenFileEnvNames) {
    const path = env[envName];
    if (typeof path === "string" && path.trim()) return readTokenFile(path).token;
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
