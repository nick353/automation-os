import { importCodexAssets } from "../ingest/codexAssets.js";

const result = await importCodexAssets();
console.log(JSON.stringify(result, null, 2));
