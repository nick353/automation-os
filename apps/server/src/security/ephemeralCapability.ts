import { createHmac, timingSafeEqual } from "node:crypto";

export const EPHEMERAL_CAPABILITY_SCHEMA_V1 = "automation_os_ephemeral_capability.v1" as const;
export type EphemeralCapabilityClaimsV1 = { schema: typeof EPHEMERAL_CAPABILITY_SCHEMA_V1; capability_id: string; task_id: string; target_digest: string; authority_digest: string; provider: string; expires_at: string; max_effects: 0 | 1; allowed_effects: readonly string[] };

const HASH = /^[a-f0-9]{64}$/u;
function sign(payload: string, secret: string): string { return createHmac("sha256", secret).update(payload).digest("hex"); }
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode(value: string): unknown { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }

export function issueEphemeralCapability(input: { capabilityId: string; taskId: string; targetDigest: string; authorityDigest: string; provider: string; expiresAt: string; maxEffects: 0 | 1; allowedEffects: readonly string[]; secretStoreMaterial: string }): string {
  if (!HASH.test(input.targetDigest) || !HASH.test(input.authorityDigest) || !input.secretStoreMaterial) throw new Error("ephemeral_capability_secret_or_binding_invalid");
  const claims: EphemeralCapabilityClaimsV1 = { schema: EPHEMERAL_CAPABILITY_SCHEMA_V1, capability_id: input.capabilityId, task_id: input.taskId, target_digest: input.targetDigest, authority_digest: input.authorityDigest, provider: input.provider, expires_at: new Date(input.expiresAt).toISOString(), max_effects: input.maxEffects, allowed_effects: [...new Set(input.allowedEffects)].sort() };
  const body = encode(claims);
  return `${body}.${sign(body, input.secretStoreMaterial)}`;
}

export function verifyEphemeralCapability(token: string, secretStoreMaterial: string, now = new Date()): EphemeralCapabilityClaimsV1 {
  if (!secretStoreMaterial || typeof token !== "string") throw new Error("ephemeral_capability_missing");
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("ephemeral_capability_format_invalid");
  const expected = sign(body, secretStoreMaterial);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("ephemeral_capability_signature_invalid");
  const claims = decode(body) as EphemeralCapabilityClaimsV1;
  if (claims.schema !== EPHEMERAL_CAPABILITY_SCHEMA_V1 || !HASH.test(claims.target_digest) || !HASH.test(claims.authority_digest) || Date.parse(claims.expires_at) <= now.getTime() || claims.max_effects > 1) throw new Error("ephemeral_capability_expired_or_invalid");
  return claims;
}
