export type PostgresUrlValidation = { ok: true; value: string } | { ok: false; reason: string };

export function validatePostgresUrl(value: string): PostgresUrlValidation {
  const trimmed = value.trim();
  const resolved = resolvePostgresTemplate(trimmed);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  try {
    const parsed = new URL(resolved.value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return { ok: false, reason: "scheme_must_be_postgres_or_postgresql" };
    }
    if (!parsed.hostname) {
      return { ok: false, reason: "hostname_missing" };
    }
    return { ok: true, value: resolved.value };
  } catch {
    return { ok: false, reason: "url_parse_failed" };
  }
}

function resolvePostgresTemplate(input: string): { ok: true; value: string } | { ok: false; reason: string } {
  const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
  const missingVariables: string[] = [];
  const resolved = input.replace(variablePattern, (_match, variableName: string) => {
    const envValue = process.env[variableName]?.trim();
    if (!envValue) {
      if (!missingVariables.includes(variableName)) missingVariables.push(variableName);
      return _match;
    }
    return envValue;
  });
  if (missingVariables.length > 0) {
    return { ok: false, reason: `template_reference_missing:${missingVariables.join(",")}` };
  }
  if (resolved === input) return { ok: true, value: input };
  return { ok: true, value: resolved };
}
