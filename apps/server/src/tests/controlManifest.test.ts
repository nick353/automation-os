import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

type ControlManifestEntry = {
  id: string;
  label: string;
  disposition: "real_read" | "real_action" | "justified_human_gate" | "remove";
  source: string;
  mutation: string;
  readback: string;
  gate: string;
};

const repoRoot = path.resolve(process.cwd());
const appSourcePath = path.join(repoRoot, "apps/web/src/App.tsx");
const manifestSourcePath = path.join(repoRoot, "apps/web/src/controlManifest.ts");

function loadControlManifest(): readonly ControlManifestEntry[] {
  const source = fs.readFileSync(manifestSourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    }
  }).outputText;
  const sandbox: { exports: Record<string, unknown>; module: { exports: Record<string, unknown> } } = {
    exports: {},
    module: { exports: {} }
  };
  vm.runInNewContext(transpiled, sandbox, { filename: manifestSourcePath });
  const exported = sandbox.module.exports.controlManifest ?? sandbox.exports.controlManifest;
  assert.ok(Array.isArray(exported), "controlManifest export missing");
  return exported as readonly ControlManifestEntry[];
}

function collectControlIdsFromSource(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(appSourcePath, sourceText, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
  const ids: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
      if (name === "data-control-id" || name === "controlId") {
        const values = collectAttributeValues(node.initializer);
        ids.push(...values);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ids;
}

function collectAttributeValues(initializer: ts.JsxAttribute["initializer"]): string[] {
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) return [initializer.text];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  return collectPatternCandidates(initializer.expression);
}

function collectPatternCandidates(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) return [templateExpressionToPattern(expression)];
  if (ts.isConditionalExpression(expression)) {
    return [
      ...collectPatternCandidates(expression.whenTrue),
      ...collectPatternCandidates(expression.whenFalse)
    ];
  }
  if (ts.isBinaryExpression(expression)) {
    return [...collectPatternCandidates(expression.left), ...collectPatternCandidates(expression.right)];
  }
  if (ts.isParenthesizedExpression(expression)) return collectPatternCandidates(expression.expression);
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return collectPatternCandidates(expression.expression);
  if (ts.isCallExpression(expression)) return expression.arguments.flatMap((arg) => collectPatternCandidates(arg));
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || ts.isIdentifier(expression) || ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) return [];
  return [];
}

function templateExpressionToPattern(expression: ts.TemplateExpression) {
  return [
    expression.head.text,
    ...expression.templateSpans.map((span) => `${substitutionToPattern(span.expression)}${span.literal.text}`)
  ].join("").replace(/\s+/g, " ").trim();
}

function substitutionToPattern(expression: ts.Expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isIdentifier(expression)) return "*";
  if (ts.isConditionalExpression(expression)) return "*";
  if (ts.isBinaryExpression(expression)) return "*";
  return "*";
}

function compatiblePattern(a: string, b: string) {
  const aParts = a.split(".");
  const bParts = b.split(".");
  if (aParts.length !== bParts.length) return false;
  return aParts.every((part, index) => part === "*" || bParts[index] === "*" || part === bParts[index]);
}

test("control manifest matches rendered ownership and evidence", () => {
  const manifest = loadControlManifest();
  const sourceText = fs.readFileSync(appSourcePath, "utf8");
  const renderedIds = collectControlIdsFromSource(sourceText);

  const manifestIds = manifest.map((entry) => entry.id);
  const duplicateManifestIds = manifestIds.filter((id, index) => manifestIds.indexOf(id) !== index);
  assert.equal(duplicateManifestIds.length, 0, `duplicate manifest ids: ${duplicateManifestIds.join(", ")}`);
  const duplicateRenderedIds = renderedIds.filter((id, index) => renderedIds.indexOf(id) !== index);
  assert.equal(duplicateRenderedIds.length, 0, `duplicate rendered owners: ${duplicateRenderedIds.join(", ")}`);

  for (const entry of manifest) {
    assert.ok(Object.values({
      real_read: "real_read",
      real_action: "real_action",
      justified_human_gate: "justified_human_gate",
      remove: "remove"
    }).includes(entry.disposition), `invalid disposition: ${entry.id}`);
    assert.ok(entry.source.trim(), `missing source: ${entry.id}`);
    assert.ok(entry.mutation.trim(), `missing mutation: ${entry.id}`);
    assert.ok(entry.readback.trim(), `missing readback: ${entry.id}`);
    assert.ok(entry.gate.trim(), `missing gate: ${entry.id}`);
  }

  for (const renderedId of renderedIds) {
    assert.ok(manifest.some((entry) => compatiblePattern(entry.id, renderedId)), `missing manifest entry for rendered control: ${renderedId}`);
  }

  for (const entry of manifest) {
    assert.ok(renderedIds.some((renderedId) => compatiblePattern(entry.id, renderedId)), `orphan manifest entry: ${entry.id}`);
  }
});

test("control manifest references the truthful route pages instead of legacy rollups", () => {
  const sourceText = fs.readFileSync(manifestSourcePath, "utf8");

  assert.match(sourceText, /OwnerAdminPage/);
  assert.match(sourceText, /TruthfulPerformancePage/);
  assert.match(sourceText, /TruthfulLanesPage/);
  assert.match(sourceText, /TruthfulArtifactsPage/);
  assert.match(sourceText, /TruthfulRunDetailPage/);
  assert.match(sourceText, /TruthfulMemoryPage/);
  assert.match(sourceText, /TruthfulIntegrationsPage/);
  assert.doesNotMatch(
    sourceText,
    /\b(ProductionStatusPage|RecoveryPage|LanesPage|ArtifactsPage|PluginsPage|DashboardView|CreateView|RunsView|SourcesView)\b/
  );
});
