import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const AUTOMATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export type RegisteredAutomationSourceEntry = {
  id: string;
  name: string | null;
  status: string | null;
  rrule: string | null;
  company_id: string | null;
  automation_id: string | null;
  source_kind: "codex_app_registered_automation";
  provenance: "codex_app_registered_automation_toml_readonly_readback";
};

export type RegisteredAutomationSourceReadback = {
  root: string;
  count: number;
  entries: RegisteredAutomationSourceEntry[];
};

function readTomlString(source: string, fieldName: string): string | null {
  const line = source.split(/\r?\n/u).find((candidate) => new RegExp(`^${fieldName}\\s*=\\s*`, "u").test(candidate));
  if (!line) return null;
  const raw = line.replace(new RegExp(`^${fieldName}\\s*=\\s*`, "u"), "").trim();
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

function safeId(value: string | null, pattern: RegExp): string | null {
  return value && pattern.test(value) ? value : null;
}

function promptReference(source: string, flag: "company" | "automation", pattern: RegExp): string | null {
  const value = source.match(new RegExp(`--${flag}\\s+([A-Za-z0-9._:-]+)`, "u"))?.[1] ?? null;
  return safeId(value, pattern);
}

/**
 * Read only the non-sensitive metadata needed to reconcile Codex registered
 * triggers with an AOS company snapshot. Prompt bodies are intentionally
 * never returned, even though the company/automation references are parsed
 * from their command line markers.
 */
export function readRegisteredAutomationSources(options: { root?: string } = {}): RegisteredAutomationSourceReadback {
  const root = resolve(options.root ?? process.env.CODEX_AUTOMATIONS_ROOT ?? join(homedir(), ".codex", "automations"));
  if (!existsSync(root)) return { root, count: 0, entries: [] };

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry): RegisteredAutomationSourceEntry | null => {
      const path = join(root, entry.name, "automation.toml");
      if (!existsSync(path)) return null;
      const source = readFileSync(path, "utf8");
      const id = safeId(readTomlString(source, "id") ?? entry.name, AUTOMATION_ID);
      if (!id) return null;
      return {
        id,
        name: readTomlString(source, "name"),
        status: readTomlString(source, "status"),
        rrule: readTomlString(source, "rrule"),
        company_id: promptReference(source, "company", COMPANY_ID),
        automation_id: promptReference(source, "automation", AUTOMATION_ID),
        source_kind: "codex_app_registered_automation",
        provenance: "codex_app_registered_automation_toml_readonly_readback"
      };
    })
    .filter((entry): entry is RegisteredAutomationSourceEntry => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  return { root, count: entries.length, entries };
}
