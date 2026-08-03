#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const appSourcePath = path.join(repoRoot, "apps/web/src/App.tsx");
const manifestSourcePath = path.join(repoRoot, "apps/web/src/controlManifest.ts");
const outputArgIndex = process.argv.findIndex((value) => value === "--output");
const outputPath = outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
  ? path.resolve(process.argv[outputArgIndex + 1])
  : path.join(repoRoot, "work/qa/all-page-button-static-preflight.json");

const VALID_DISPOSITIONS = new Set(["real_read", "real_action", "justified_human_gate", "remove"]);

function loadControlManifest() {
  const source = fs.readFileSync(manifestSourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    }
  }).outputText;
  const sandbox = { exports: {}, module: { exports: {} } };
  vm.runInNewContext(transpiled, sandbox, { filename: manifestSourcePath });
  const manifest = sandbox.module.exports.controlManifest ?? sandbox.exports.controlManifest;
  if (!Array.isArray(manifest)) throw new Error("control_manifest_export_missing");
  return manifest;
}

function collectControlIdsFromSource(sourceText) {
  const sourceFile = ts.createSourceFile(appSourcePath, sourceText, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
  const ids = [];
  const visit = (node) => {
    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
      if (name === "data-control-id" || name === "controlId") ids.push(...collectAttributeValues(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ids;
}

function collectAttributeValues(initializer) {
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) return [initializer.text];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  return collectPatternCandidates(initializer.expression);
}

function collectPatternCandidates(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) {
    return [
      expression.head.text,
      ...expression.templateSpans.map((span) => `${substitutionToPattern(span.expression)}${span.literal.text}`)
    ].join("").replace(/\s+/g, " ").trim() ? [
      [
        expression.head.text,
        ...expression.templateSpans.map((span) => `${substitutionToPattern(span.expression)}${span.literal.text}`)
      ].join("").replace(/\s+/g, " ").trim()
    ] : [];
  }
  if (ts.isConditionalExpression(expression)) return [...collectPatternCandidates(expression.whenTrue), ...collectPatternCandidates(expression.whenFalse)];
  if (ts.isBinaryExpression(expression)) return [...collectPatternCandidates(expression.left), ...collectPatternCandidates(expression.right)];
  if (ts.isParenthesizedExpression(expression)) return collectPatternCandidates(expression.expression);
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return collectPatternCandidates(expression.expression);
  if (ts.isCallExpression(expression)) return expression.arguments.flatMap((arg) => collectPatternCandidates(arg));
  return [];
}

function substitutionToPattern(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return "*";
}

function compatiblePattern(pattern, rendered) {
  const patternParts = pattern.split(".");
  const renderedParts = rendered.split(".");
  return patternParts.length === renderedParts.length
    && patternParts.every((part, index) => part === "*" || part === renderedParts[index]);
}

function unique(values) {
  return [...new Set(values)];
}

function sourceLine(sourceText, needle) {
  const index = sourceText.indexOf(needle);
  return index < 0 ? null : sourceText.slice(0, index).split("\n").length;
}

function collectRouteContract(sourceText) {
  const start = sourceText.indexOf("function renderPage(");
  const end = sourceText.indexOf("function ProjectDirectoryPage(", start);
  const renderSource = sourceText.slice(start, end < 0 ? undefined : end);
  const exact = unique([...renderSource.matchAll(/currentPath\s*===\s*["']([^"']+)["']/g)].map((match) => match[1]));
  const includes = unique([...renderSource.matchAll(/currentPath\.includes\(["']([^"']+)["']\)/g)].map((match) => match[1]));
  const components = unique([...renderSource.matchAll(/<([A-Za-z0-9_]+Page)\b/g)].map((match) => match[1]));
  return {
    source: "apps/web/src/App.tsx#renderPage",
    source_line: sourceLine(sourceText, "function renderPage("),
    exact_path_markers: exact,
    prefix_path_markers: includes,
    rendered_page_components: components
  };
}

const SCREEN_CASE_DEFINITIONS = [
  { case_id: "home", route_patterns: ["#/"], route_markers: [], components: ["HomePage"] },
  { case_id: "chat", route_patterns: ["#/chat"], route_markers: ["#/chat"], components: ["ChatPage"] },
  { case_id: "approvals", route_patterns: ["#/approvals"], route_markers: ["#/approvals"], components: ["ApprovalsPage"] },
  { case_id: "runs", route_patterns: ["#/runs"], route_markers: ["#/runs"], components: ["RunsPage"] },
  { case_id: "templates", route_patterns: ["#/templates"], route_markers: ["#/templates"], components: ["TemplatesPage"] },
  { case_id: "admin", route_patterns: ["#/admin"], route_markers: ["#/admin"], components: ["OwnerAdminPage"] },
  { case_id: "plugins", route_patterns: ["#/plugins"], route_markers: ["#/plugins"], components: ["TruthfulPluginsPage"] },
  { case_id: "production-status", route_patterns: ["#/production/status"], route_markers: ["#/production/status"], components: ["TruthfulProductionStatusPage", "ProjectUnavailablePage"] },
  { case_id: "pc-status", route_patterns: ["#/system/pc-status"], route_markers: ["#/system/pc-status"], components: ["PcStatusPage"] },
  { case_id: "project-directory", route_patterns: ["#/projects", "#/projects/"], route_markers: ["#/projects", "#/projects/"], components: ["ProjectDirectoryPage"] },
  { case_id: "project-home", route_patterns: ["/projects/:projectSlug"], route_markers: ["/projects/"], components: ["HomePage"] },
  { case_id: "project-unavailable", route_patterns: ["/projects/:projectSlug/*"], route_markers: ["/projects/"], components: ["ProjectUnavailablePage"] },
  { case_id: "project-performance", route_patterns: ["/projects/:projectSlug/performance"], route_markers: ["/projects/", "/performance"], components: ["TruthfulPerformancePage"] },
  { case_id: "project-builder", route_patterns: ["/projects/:projectSlug/automations/:automationId/edit"], route_markers: ["/projects/", "/automations/", "/edit"], components: ["BuilderPage"] },
  { case_id: "project-automations", route_patterns: ["/projects/:projectSlug/automations"], route_markers: ["/projects/", "/automations"], components: ["AutomationsPage"] },
  { case_id: "project-lanes", route_patterns: ["/projects/:projectSlug/lanes"], route_markers: ["/projects/", "/lanes"], components: ["TruthfulLanesPage"] },
  { case_id: "project-memory", route_patterns: ["/projects/:projectSlug/memory"], route_markers: ["/projects/", "/memory"], components: ["TruthfulMemoryPage"] },
  { case_id: "project-integrations", route_patterns: ["/projects/:projectSlug/integrations", "/projects/:projectSlug/security"], route_markers: ["/projects/", "/integrations", "/security"], components: ["TruthfulIntegrationsPage"] },
  { case_id: "project-artifacts", route_patterns: ["/projects/:projectSlug/artifacts"], route_markers: ["/projects/", "/artifacts"], components: ["TruthfulArtifactsPage"] },
  { case_id: "project-recovery", route_patterns: ["/projects/:projectSlug/recovery"], route_markers: ["/projects/", "/recovery"], components: ["TruthfulRecoveryPage"] },
  { case_id: "project-run-detail", route_patterns: ["/projects/:projectSlug/runs/:runId"], route_markers: ["/projects/", "/runs/"], components: ["TruthfulRunDetailPage"] }
];

function buildScreenCases(routeContract, manifest) {
  const routeMarkers = new Set([...routeContract.exact_path_markers, ...routeContract.prefix_path_markers]);
  const sharedControlIds = manifest
    .filter((entry) => /apps\/web\/src\/App\.tsx#(?:Sidebar|TopHeader|App)$/u.test(String(entry.source)))
    .map((entry) => entry.id);
  return SCREEN_CASE_DEFINITIONS.map((definition) => {
    const missingMarkers = definition.route_markers.filter((marker) => !routeMarkers.has(marker));
    const controlIds = unique([
      ...sharedControlIds,
      ...manifest
        .filter((entry) => definition.components.some((component) => String(entry.source).includes(`#${component}`)))
        .map((entry) => entry.id)
    ]);
    return {
      ...definition,
      static_validation: {
        route_markers_present: missingMarkers.length === 0,
        missing_route_markers: missingMarkers,
        rendered_components_present: definition.components.every((component) => routeContract.rendered_page_components.includes(component))
      },
      control_ids: controlIds,
      control_count: controlIds.length,
      runtime_qa: {
        status: "unverified",
        exact_blocker: "fresh_browser_use_authority_required_for_runtime_screen_qa",
        recording_required: true,
        lifecycle: ["record-start", "open route", "record-command per control", "same-session readback", "record-finalize"],
        external_effects: "none"
      }
    };
  });
}

function audit() {
  const appSource = fs.readFileSync(appSourcePath, "utf8");
  const manifestSource = fs.readFileSync(manifestSourcePath, "utf8");
  const manifest = loadControlManifest();
  const rendered = collectControlIdsFromSource(appSource);
  const manifestIds = manifest.map((entry) => entry.id);
  const duplicateManifestIds = unique(manifestIds.filter((id, index) => manifestIds.indexOf(id) !== index));
  const duplicateRenderedIds = unique(rendered.filter((id, index) => rendered.indexOf(id) !== index));
  const invalidEntries = manifest
    .filter((entry) => !VALID_DISPOSITIONS.has(entry.disposition)
      || !String(entry.source || "").trim()
      || !String(entry.mutation || "").trim()
      || !String(entry.readback || "").trim()
      || !String(entry.gate || "").trim())
    .map((entry) => entry.id);
  const unclassifiedRendered = unique(rendered).filter((id) => !manifest.some((entry) => compatiblePattern(entry.id, id)));
  const orphanManifest = unique(manifestIds).filter((id) => !rendered.some((renderedId) => compatiblePattern(id, renderedId)));
  const routeContract = collectRouteContract(appSource);
  const screenCases = buildScreenCases(routeContract, manifest);
  const manifestSources = unique(manifest.map((entry) => entry.source));
  const issues = [
    ...duplicateManifestIds.map((id) => `duplicate_manifest_id:${id}`),
    ...duplicateRenderedIds.map((id) => `duplicate_rendered_control_id:${id}`),
    ...invalidEntries.map((id) => `invalid_manifest_entry:${id}`),
    ...unclassifiedRendered.map((id) => `unclassified_rendered_control:${id}`),
    ...orphanManifest.map((id) => `orphan_manifest_entry:${id}`),
    ...screenCases.flatMap((screen) => [
      ...(screen.static_validation.route_markers_present ? [] : [`screen_route_marker_missing:${screen.case_id}`]),
      ...(screen.static_validation.rendered_components_present ? [] : [`screen_component_missing:${screen.case_id}`]),
      ...(screen.control_count > 0 ? [] : [`screen_controls_missing:${screen.case_id}`])
    ])
  ];
  return {
    schema: "automation-os-ui-qa-preflight.v1",
    status: issues.length ? "failed" : "passed",
    mode: "static_preflight",
    workflow: "automation-os-all-page-button-qa",
    generated_at: new Date().toISOString(),
    repository: {
      root: repoRoot,
      app_source: "apps/web/src/App.tsx",
      control_manifest: "apps/web/src/controlManifest.ts",
      entrypoint_is_tracked: true,
      worktree_runtime_dependency: false
    },
    browser_surface: "browser_use_cli",
    runtime_qa: {
      attempted: false,
      status: "unverified",
      exact_blocker: "fresh_browser_use_authority_required_for_runtime_screen_qa",
      recording_required: true,
      external_effects: "none",
      note: "This preflight classifies source ownership only; it does not claim that runtime controls were clicked."
    },
    control_manifest: {
      entries: manifest.length,
      rendered_patterns: unique(rendered).length,
      dispositions: Object.fromEntries([...VALID_DISPOSITIONS].map((disposition) => [disposition, manifest.filter((entry) => entry.disposition === disposition).length])),
      sources: manifestSources,
      duplicate_ids: duplicateManifestIds,
      unclassified_rendered: unclassifiedRendered,
      orphan_entries: orphanManifest
    },
    route_contract: routeContract,
    screen_cases: screenCases,
    issues
  };
}

const result = audit();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...result, output: outputPath }, null, 2));
if (result.status !== "passed") process.exitCode = 1;
