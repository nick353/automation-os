import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("SPA index is never browser-cached while hashed assets remain static", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const start = source.indexOf("if (existsSync(webIndexPath))");
  const end = source.indexOf("\n}\n\napp.use((req, res, next) =>", start);
  assert.ok(start >= 0 && end > start, "web static serving boundary missing");
  const boundary = source.slice(start, end);

  assert.match(boundary, /express\.static\(webDistDir, \{\s*index: false/);
  assert.match(boundary, /resolvePath\(filePath\) !== resolvePath\(webIndexPath\)/);
  assert.match(boundary, /res\.setHeader\("Cache-Control", "no-store, no-cache, must-revalidate"\)/);
  assert.match(boundary, /res\.setHeader\("Pragma", "no-cache"\)/);
  assert.match(boundary, /res\.setHeader\("Expires", "0"\)/);
  assert.match(boundary, /res\.sendFile\(webIndexPath\)/);
  assert.match(boundary, /normalizedHostname === "127\.0\.0\.1" \|\| normalizedHostname === "::1"/);
  assert.match(boundary, /const isUiRequest = req\.method === "GET" \|\| req\.method === "HEAD"/);
  assert.match(boundary, /if \(!isLoopbackHostname \|\| !isUiRequest \|\| isApiRequest\)/);
  assert.match(boundary, /res\.redirect\(308, canonicalUrl\)/);
  assert.match(boundary, /http:\/\/localhost:\$\{port\}/);
});
