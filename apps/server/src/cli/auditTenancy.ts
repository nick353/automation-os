import { auditTenancy } from "../companies/tenancyAudit.js";
import { initDb } from "../db/client.js";

initDb();
const result = auditTenancy();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
