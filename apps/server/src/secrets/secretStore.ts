import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nowIso, querySql, sqlValue, upsert } from "../db/client.js";

const defaultSecretDir = resolve(process.cwd(), "data", "secrets");
const secretDir = process.env.AUTOMATION_OS_SECRET_DIR ?? defaultSecretDir;
const serviceName = "Automation OS";

export type StoredSecretSummary = {
  id: string;
  kind: string;
  label: string;
  maskedValue: string;
  updatedAt: string;
  state?: string;
  purpose?: string;
  accountLabel?: string;
  availableToRunner?: boolean;
};

export type SecretCandidate = {
  kind: string;
  label: string;
  value: string;
  start: number;
  end: number;
  purpose?: string;
  accountLabel?: string;
  state?: string;
};

export type SaveSecretsResult = {
  sanitizedText: string;
  stored: StoredSecretSummary[];
};

const providerLabels: Record<string, string> = {
  canva: "Canva APIキー",
  etsy: "Etsy APIキー",
  gemini: "Gemini APIキー",
  generic: "APIキー",
  google_service_account: "Google service account",
  openai: "OpenAI APIキー",
  pinterest: "Pinterest APIキー",
  postgres: "本番PostgreSQL接続",
  printify: "Printify APIキー",
  runway: "Runway APIキー",
  password: "パスワード",
  cookie: "Cookie",
  session: "Session token",
  recovery_code: "Recovery code"
};

export function listStoredSecrets(): StoredSecretSummary[] {
  return querySql<{
    id: string;
    kind: string;
    label: string;
    masked_value: string;
    updated_at: string;
    metadata_json: string;
  }>("SELECT id, kind, label, masked_value, updated_at, metadata_json FROM stored_secrets ORDER BY updated_at DESC").map((row) => {
    const metadata = parseSecretMetadata(row.metadata_json);
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      maskedValue: row.masked_value,
      updatedAt: row.updated_at,
      state: metadata.state,
      purpose: metadata.purpose,
      accountLabel: metadata.accountLabel,
      availableToRunner: metadata.availableToRunner
    };
  });
}

export function saveSecretsFromMessage(text: string): SaveSecretsResult {
  const candidates = dedupeCandidates(detectSecretsInText(text));
  const stored = candidates.map((candidate) => storeSecret(candidate));
  return {
    sanitizedText: redactSecrets(text, candidates),
    stored
  };
}

export function detectSecretsInText(text: string): SecretCandidate[] {
  const candidates: SecretCandidate[] = [];
  candidates.push(...detectGoogleServiceAccountJson(text));
  const patterns = [
    /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    /\b(?:api[_-]?key|token|secret|access[_-]?token)\s*[:=]\s*([A-Za-z0-9_.-]{32,})\b/gi,
    /(?:APIキー|apiキー|キー|トークン)\s*(?:[:=：]|は|が|を)?\s*([A-Za-z0-9_.-]{32,})\b/g,
    /\b(?:password|passwd|pwd)\s*[:=]\s*([^\s"'<>]{8,})/gi,
    /\b(?:cookie|session(?:[_-]?token)?|sessionid)\s*[:=]\s*([A-Za-z0-9_.=%:+/-]{16,})\b/gi,
    /\b(?:recovery[_-]?code|backup[_-]?code)\s*[:=]\s*([A-Za-z0-9 -]{8,})\b/gi,
    /(?:パスワード|暗証番号)\s*(?:[:=：]|は|が|を)?\s*([^\s"'<>]{8,})/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      const valueStart = match.index === undefined ? -1 : match.index + match[0].indexOf(value);
      const context = match[0];
      const kind = inferSecretKind(context, value);
      if (valueStart < 0 || !looksLikeSecretValue(value, kind)) continue;
      candidates.push({
        kind,
        label: providerLabels[kind] ?? providerLabels.generic,
        value,
        start: valueStart,
        end: valueStart + value.length,
        ...inferSecretRouting(context, kind)
      });
    }
  }

  return candidates;
}

export function redactSecrets(text: string, candidates: SecretCandidate[]): string {
  if (!candidates.length) return text;
  const ordered = dedupeCandidates(candidates).sort((a, b) => b.start - a.start);
  let redacted = text;
  for (const candidate of ordered) {
    redacted = `${redacted.slice(0, candidate.start)}[保存済み: ${candidate.label}]${redacted.slice(candidate.end)}`;
  }
  return redacted;
}

export function readStoredSecret(id: string): string | undefined {
  const row = querySql<{ storage_ref: string }>(`SELECT storage_ref FROM stored_secrets WHERE id=${sqlValue(id)} LIMIT 1`)[0];
  if (!row) return undefined;
  return decryptStoredSecret(row.storage_ref);
}

export function readStoredSecretByKind(kind: string): string | undefined {
  const id = `secret_${kind}_api_key`;
  return readStoredSecret(id);
}

export function isSecretStorageOnlyText(sanitizedText: string, stored: StoredSecretSummary[]): boolean {
  if (!stored.length) return false;
  const stripped = stored.reduce((text, secret) => {
    return text
      .split(`[保存済み: ${secret.label}]`).join("")
    .split(secret.label).join("");
  }, sanitizedText)
    .replace(/\b(?:api[_-]?key|token|secret|access[_-]?token|password|passwd|pwd|cookie|session|recovery[_-]?code)\b/giu, "")
    .replace(/GOOGLE_SERVICE_ACCOUNT_JSON|GOOGLE_APPLICATION_CREDENTIALS|OpenAI|ChatGPT|Google|service account|APIキー|apiキー|キー|トークン|パスワード|認証情報|保存|だけ|です|ます|は|が|を|これ|こちら|使って|ください/giu, "")
    .replace(/[{}[\]":,\\=._\-。！？!?\s]/gu, "")
    .trim();
  return stripped.length === 0;
}

function storeSecret(candidate: SecretCandidate): StoredSecretSummary {
  const id = `secret_${candidate.kind}_api_key`;
  const now = nowIso();
  const existing = querySql<{ created_at: string }>(`SELECT created_at FROM stored_secrets WHERE id=${sqlValue(id)} LIMIT 1`)[0];
  const storageRef = writeEncryptedSecret(id, candidate.value);
  const summary = {
    id,
    kind: candidate.kind,
    label: candidate.label,
    maskedValue: maskSecret(candidate.value),
    updatedAt: now,
    state: candidate.state ?? "stored",
    purpose: candidate.purpose ?? "general",
    accountLabel: candidate.accountLabel ?? "unknown",
    availableToRunner: true
  };
  upsert("stored_secrets", {
    id,
    kind: candidate.kind,
    label: candidate.label,
    storage_ref: storageRef,
    masked_value: summary.maskedValue,
    fingerprint: fingerprint(candidate.value),
    created_at: existing?.created_at ?? now,
    updated_at: now,
    metadata_json: {
      service: serviceName,
      storage: "local_encrypted_file",
      state: summary.state,
      purpose: summary.purpose,
      accountLabel: summary.accountLabel,
      availableToRunner: summary.availableToRunner,
      valueFormat: candidate.kind === "google_service_account" ? "json" : "opaque"
    }
  });
  return summary;
}

function dedupeCandidates(candidates: SecretCandidate[]): SecretCandidate[] {
  const withoutOverlaps = candidates
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .filter((candidate, index, sorted) => {
      return !sorted.slice(0, index).some((kept) => candidate.start >= kept.start && candidate.end <= kept.end);
    });
  const seen = new Set<string>();
  return withoutOverlaps.filter((candidate) => {
    const key = `${candidate.kind}:${fingerprint(candidate.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferSecretKind(context: string, value: string): string {
  const lower = context.toLowerCase();
  if (/google_service_account_json|service_account|private_key|client_email/.test(lower) && looksLikeServiceAccountJson(value)) return "google_service_account";
  if (/postgres|database_url|automation_os_database_url|postgres_uri|zeabur/.test(lower) || /^postgres(?:ql)?:\/\//i.test(value)) return "postgres";
  if (/cookie/.test(lower)) return "cookie";
  if (/session/.test(lower)) return "session";
  if (/recovery[_-]?code|backup[_-]?code/.test(lower)) return "recovery_code";
  if (/password|passwd|pwd|パスワード|暗証番号/.test(lower)) return "password";
  if (/printify/.test(lower) || value.startsWith("eyJ")) return "printify";
  if (/openai|chatgpt|gpt/.test(lower) || value.startsWith("sk-")) return "openai";
  if (/gemini|google\s*ai|google\s*gemini/.test(lower) || value.startsWith("AIza")) return "gemini";
  if (/etsy/.test(lower)) return "etsy";
  if (/pinterest/.test(lower)) return "pinterest";
  if (/canva/.test(lower)) return "canva";
  if (/runway/.test(lower)) return "runway";
  return "generic";
}

function inferSecretRouting(context: string, kind: string): Pick<SecretCandidate, "purpose" | "accountLabel" | "state"> {
  const lower = context.toLowerCase();
  const purpose = /prompt[-_\s]*transfer|google_service_account_json|sheets|sheet|b16:d16/.test(lower)
    ? "prompt-transfer-ukiyoe/google-service-account"
    : /sns|x|twitter|instagram|threads|facebook|pinterest/.test(lower)
      ? "sns/authenticated-browser"
      : /nisenprints|etsy|printify/.test(lower)
        ? "nisenprints/external-service"
        : `${kind}/general`;
  const accountLabel = /training|練習|practice/.test(lower)
    ? "training"
    : /production|本番/.test(lower)
      ? "production"
      : "unknown";
  return { purpose, accountLabel, state: "stored" };
}

function detectGoogleServiceAccountJson(text: string): SecretCandidate[] {
  const candidates: SecretCandidate[] = [];
  const markers = [...text.matchAll(/GOOGLE_SERVICE_ACCOUNT_JSON\s*[:=]\s*/gi)];
  for (const marker of markers) {
    if (marker.index === undefined) continue;
    const jsonStart = text.indexOf("{", marker.index + marker[0].length);
    if (jsonStart < 0) continue;
    const jsonEnd = findBalancedJsonEnd(text, jsonStart);
    if (jsonEnd <= jsonStart) continue;
    const value = text.slice(jsonStart, jsonEnd);
    if (!looksLikeServiceAccountJson(value)) continue;
    candidates.push({
      kind: "google_service_account",
      label: providerLabels.google_service_account,
      value,
      start: jsonStart,
      end: jsonEnd,
      purpose: "prompt-transfer-ukiyoe/google-service-account",
      accountLabel: "unknown",
      state: "stored"
    });
  }
  return candidates;
}

function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function looksLikeServiceAccountJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { type?: unknown; private_key?: unknown; client_email?: unknown };
    return parsed.type === "service_account"
      && typeof parsed.private_key === "string"
      && typeof parsed.client_email === "string";
  } catch {
    return false;
  }
}

function looksLikeSecretValue(value: string, kind = "generic"): boolean {
  if (/^postgres(?:ql)?:\/\/[^\s"'<>]+/i.test(value)) return true;
  if (looksLikeServiceAccountJson(value)) return true;
  if (["password", "cookie", "session", "recovery_code"].includes(kind)) return value.trim().length >= 8;
  if (value.length < 32) return false;
  if (/^(example|dummy|placeholder)$/i.test(value)) return false;
  return /[A-Za-z]/.test(value) && /[0-9._-]/.test(value);
}

function parseSecretMetadata(raw: string): { state?: string; purpose?: string; accountLabel?: string; availableToRunner?: boolean } {
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; purpose?: unknown; accountLabel?: unknown; availableToRunner?: unknown };
    return {
      state: typeof parsed.state === "string" ? parsed.state : undefined,
      purpose: typeof parsed.purpose === "string" ? parsed.purpose : undefined,
      accountLabel: typeof parsed.accountLabel === "string" ? parsed.accountLabel : undefined,
      availableToRunner: typeof parsed.availableToRunner === "boolean" ? parsed.availableToRunner : undefined
    };
  } catch {
    return {};
  }
}

function maskSecret(value: string): string {
  if (value.length <= 12) return "保存済み";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeEncryptedSecret(id: string, value: string): string {
  mkdirSync(secretDir, { recursive: true });
  const key = readOrCreateMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const payload = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  const path = join(secretDir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function decryptStoredSecret(path: string): string {
  const payload = JSON.parse(readFileSync(path, "utf8")) as { iv: string; tag: string; ciphertext: string };
  const decipher = createDecipheriv("aes-256-gcm", readOrCreateMasterKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function readOrCreateMasterKey(): Buffer {
  mkdirSync(secretDir, { recursive: true });
  const path = join(secretDir, ".master-key");
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}
