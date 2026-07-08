import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-secrets-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(tempRoot, "secrets");

const db = await import("../db/client.js");
const secrets = await import("../secrets/secretStore.js");

test("detects, stores, and redacts API keys from chat messages", () => {
  db.initDb();
  const token = "openai_sample_value_1234567890ABCDEF";
  const result = secrets.saveSecretsFromMessage(`OpenAI APIキーは ${token} です`);

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0].kind, "openai");
  assert.equal(result.sanitizedText, "OpenAI APIキーは [保存済み: OpenAI APIキー] です");
  assert.doesNotMatch(result.sanitizedText, /abcdefghijklmnopqrstuvwxyzABCD/);
  assert.equal(secrets.readStoredSecret("secret_openai_api_key"), token);
  assert.equal(secrets.listStoredSecrets()[0].label, "OpenAI APIキー");
});

test("stores secret values outside the database payload", () => {
  db.initDb();
  const token = "printify_sample_value_1234567890ABCDEF";
  secrets.saveSecretsFromMessage(`Printify token=${token}`);

  const rows = db.querySql<{ storage_ref: string; masked_value: string; fingerprint: string }>(
    "SELECT storage_ref, masked_value, fingerprint FROM stored_secrets WHERE id='secret_printify_api_key' LIMIT 1"
  );

  assert.equal(rows.length, 1);
  assert.ok(existsSync(rows[0].storage_ref));
  assert.doesNotMatch(JSON.stringify(rows[0]), /abcdefghijklmnopqrstuvwxyz/);
  assert.match(rows[0].masked_value, /^prin\.\.\./);
});

test("detects Japanese API key labels from beginner chat text", () => {
  db.initDb();
  const token = "printify_japanese_sample_value_1234567890ABCDEF";
  const result = secrets.saveSecretsFromMessage(`Printify APIキー: ${token} を使って`);

  assert.equal(result.stored[0].kind, "printify");
  assert.equal(result.sanitizedText, "Printify APIキー: [保存済み: Printify APIキー] を使って");
  assert.doesNotMatch(result.sanitizedText, /abcdefghijklmnopqrstuvwxyz/);
});

test("detects natural Japanese key phrasing without a colon", () => {
  db.initDb();
  const token = "etsy_sample_value_1234567890ABCDEF";
  const result = secrets.saveSecretsFromMessage(`Etsy APIキーは ${token} です`);

  assert.equal(result.stored[0].kind, "etsy");
  assert.equal(result.sanitizedText, "Etsy APIキーは [保存済み: Etsy APIキー] です");
  assert.doesNotMatch(result.sanitizedText, /abcdefghijklmnopqrstuvwxyz/);
});

test("detects Gemini API keys and reads them by kind", () => {
  db.initDb();
  const token = "gemini_sample_value_1234567890ABCDEF";
  const result = secrets.saveSecretsFromMessage(`Gemini APIキーは ${token} です`);

  assert.equal(result.stored[0].kind, "gemini");
  assert.equal(result.sanitizedText, "Gemini APIキーは [保存済み: Gemini APIキー] です");
  assert.equal(secrets.readStoredSecretByKind("gemini"), token);
  assert.doesNotMatch(result.sanitizedText, /GeminiSecret/);
});

test("detects PostgreSQL connection strings as hidden production database secrets", () => {
  db.initDb();
  const url = "postgresql://automation_user:secret-password@example.zeabur.internal:5432/automation_db?sslmode=require";
  const result = secrets.saveSecretsFromMessage(`DATABASE_URL=${url}`);

  assert.equal(result.stored[0].kind, "postgres");
  assert.equal(result.stored[0].label, "本番PostgreSQL接続");
  assert.equal(result.sanitizedText, "DATABASE_URL=[保存済み: 本番PostgreSQL接続]");
  assert.equal(secrets.readStoredSecretByKind("postgres"), url);
  assert.doesNotMatch(JSON.stringify(result), /secret-password|zeabur\.internal/);
});

test("stores multiline Google service account JSON with routing metadata and redacted chat text", () => {
  db.initDb();
  const serviceAccount = JSON.stringify({
    type: "service_account",
    project_id: "automation-test",
    private_key_id: "abc123",
    private_key: "-----BEGIN PRIVATE KEY-----\\nline-one\\nline-two\\n-----END PRIVATE KEY-----\\n",
    client_email: "automation@example.iam.gserviceaccount.com"
  }, null, 2);
  const result = secrets.saveSecretsFromMessage(`GOOGLE_SERVICE_ACCOUNT_JSON=${serviceAccount}\n保存だけ。転記はまだやらないで`);

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0].kind, "google_service_account");
  assert.equal(result.stored[0].purpose, "prompt-transfer-ukiyoe/google-service-account");
  assert.equal(result.stored[0].state, "stored");
  assert.equal(result.stored[0].availableToRunner, true);
  assert.equal(secrets.readStoredSecretByKind("google_service_account"), serviceAccount);
  assert.match(result.sanitizedText, /\[保存済み: Google service account\]/);
  assert.doesNotMatch(result.sanitizedText, /PRIVATE KEY|automation@example/);
});

test("detects password cookie session and recovery code secrets without leaking values", () => {
  db.initDb();
  const result = secrets.saveSecretsFromMessage([
    "password=correct-horse-battery-staple",
    "cookie=sessionid_abcdefghijklmnopqrstuvwxyz123456",
    "recovery_code=1111-2222-3333"
  ].join("\n"));

  assert.equal(result.stored.length, 3);
  assert.deepEqual(result.stored.map((secret) => secret.kind).sort(), ["cookie", "password", "recovery_code"]);
  assert.doesNotMatch(result.sanitizedText, /correct-horse|sessionid_|1111-2222/);
});

test("recognizes secret-only text after storage so callers can avoid starting runs", () => {
  db.initDb();
  const token = "sk-secretOnly1234567890abcdefghijklmnopqrstuvwxyz";
  const result = secrets.saveSecretsFromMessage(`OpenAI APIキーは ${token} です。保存だけ`);

  assert.equal(secrets.isSecretStorageOnlyText(result.sanitizedText, result.stored), true);
  assert.equal(secrets.isSecretStorageOnlyText(`${result.sanitizedText} Daily AIを毎朝8時にして`, result.stored), false);
});
