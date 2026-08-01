import { syncDiscoveredProjects } from "../projects/projectDiscovery.js";

const write = process.argv.includes("--write");
const result = syncDiscoveredProjects({ write });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
