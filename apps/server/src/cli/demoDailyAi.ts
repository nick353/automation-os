import { initDb } from "../db/client.js";
import { seedDailyAiDemo } from "../seedDailyAiDemo.js";

initDb();
console.log(JSON.stringify(seedDailyAiDemo(), null, 2));
