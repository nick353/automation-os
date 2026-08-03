import { evaluateServerStartupPolicy } from "./serverStartupPolicy.js";

const policy = evaluateServerStartupPolicy();
if (!policy.ok) {
  // Keep this pre-bind diagnostic classification-only. Never print the
  // candidate URL, template expansion, secret-store output, or an exception.
  const diagnostic = {
    ok: false,
    status: "blocked",
    exactBlocker: policy.exactBlocker,
    ...(policy.reason ? { reason: policy.reason } : {})
  };
  console.error(JSON.stringify(diagnostic));
  process.exit(2);
}
