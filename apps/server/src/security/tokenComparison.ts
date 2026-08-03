import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare operator/read tokens without exposing their length or value through
 * the equality operation. Hashing first gives timingSafeEqual fixed-size
 * inputs while keeping the raw token out of logs and diagnostics.
 */
export function secureTokenEqual(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
