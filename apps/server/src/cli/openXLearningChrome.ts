import { openXLearningChrome } from "../browser/xLearningLane.js";

try {
  const result = openXLearningChrome();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }, null, 2));
  process.exitCode = 1;
}
