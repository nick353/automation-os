export function redactSensitiveText(value: string): string {
  let redacted = redactUrlLikeSecrets(value);
  redacted = redactDelimitedParams(redacted);
  redacted = redacted.replace(/\b(?:sample|token|secret|password|apikey)[-_][A-Za-z0-9._-]{4,}\b/giu, "[redacted-token]");
  redacted = redacted.replace(/\b(?:[A-Za-z0-9]+_)?(?:jwt|token|secret|key)_[A-Za-z0-9._-]{4,}\b/giu, "[redacted-token]");
  redacted = redacted.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gu, "$1[redacted-token]");
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[redacted-token]");
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, "[redacted-token]");
  redacted = redacted.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "[redacted-token]");
  redacted = redacted.replace(/\bA[KS]IA[0-9A-Z]{16}\b/gu, "[redacted-token]");
  redacted = redacted.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[redacted-token]");
  redacted = redacted.replace(/\b(secret|token|session|password)-[A-Za-z0-9_-]{4,}\b/giu, "[redacted-token]");
  redacted = redacted.replace(/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SESSION)[A-Za-z_]*=)[^\s,;]+/gu, "$1[redacted]");
  redacted = redacted.replace(/\b(GOOGLE_SERVICE_ACCOUNT_JSON\s*[:=]\s*)\{[^\n]*(?:private_key|client_email)[^\n]*\}/gu, "$1[redacted-json]");
  redacted = redacted.replace(/("private_key"\s*:\s*")[^"]+(")/gu, "$1[redacted-private-key]$2");
  redacted = redacted.replace(/\b((?:password|passwd|pwd|cookie|session(?:[_-]?token)?|recovery[_-]?code|backup[_-]?code)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]");
  redacted = redacted.replace(/((?:パスワード|暗証番号)\s*(?:[:=：]|は|が|を)?\s*)[^\s"'<>]{4,}/gu, "$1[redacted]");
  redacted = redacted.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[redacted-email]");
  return redacted;
}

function redactUrlLikeSecrets(value: string): string {
  return value.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`\\]+/gu, (candidate) => redactUrlCandidate(candidate));
}

function redactUrlCandidate(candidate: string): string {
  const { core, suffix } = splitTrailingUrlPunctuation(candidate);
  try {
    const url = new URL(core);
    const auth = url.username || url.password ? "[redacted-auth]@" : "";
    return `${url.protocol}//${auth}${url.host}${url.pathname}${redactDelimitedParams(url.search)}${redactDelimitedParams(url.hash)}${suffix}`;
  } catch {
    return `${redactDelimitedParams(core)}${suffix}`;
  }
}

function splitTrailingUrlPunctuation(value: string): { core: string; suffix: string } {
  let core = value;
  let suffix = "";
  while (/[),.;!?]$/u.test(core)) {
    suffix = `${core.at(-1)}${suffix}`;
    core = core.slice(0, -1);
  }
  return { core, suffix };
}

function redactDelimitedParams(value: string): string {
  return value.replace(/([?&#;])([^=&#;\s]+)=([^&#;\s]*)/gu, (match, delimiter: string, rawName: string) => {
    return isSensitiveParamName(rawName) ? `${delimiter}${rawName}=[redacted]` : match;
  });
}

function isSensitiveParamName(rawName: string): boolean {
  const decoded = decodeURIComponentSafe(rawName).toLowerCase();
  return /^(access[_-]?token|id[_-]?token|refresh[_-]?token|token|code|api[_-]?key|key|secret|client[_-]?secret|password|passwd|pwd|session|auth|authorization|signature|sig)$/iu.test(decoded)
    || /(^|[_-])(token|code|key|secret|password|passwd|pwd|session|auth|signature|sig)([_-]|$)/iu.test(decoded);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
}
