import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validatePostgresUrl } from "./postgresUrlValidation.js";

const secretDir = process.env.AUTOMATION_OS_SECRET_DIR ?? resolve(process.cwd(), "data", "secrets");
const secretPath = join(secretDir, "secret_postgres_api_key.json");
const masterKeyPath = join(secretDir, ".master-key");

try {
  if (!existsSync(secretPath) || !existsSync(masterKeyPath)) process.exit(2);
  const payload = JSON.parse(readFileSync(secretPath, "utf8")) as {
    algorithm?: string;
    iv?: string;
    tag?: string;
    ciphertext?: string;
  };
  if (payload.algorithm !== "aes-256-gcm" || !payload.iv || !payload.tag || !payload.ciphertext) process.exit(2);
  const key = Buffer.from(readFileSync(masterKeyPath, "utf8").trim(), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const value = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
  const validation = validatePostgresUrl(value);
  if (!validation.ok) process.exit(2);
  process.stdout.write(validation.value);
} catch {
  process.exit(2);
}
