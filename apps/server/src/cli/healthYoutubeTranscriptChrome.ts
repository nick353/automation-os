import { getYouTubeTranscriptChromeHealth } from "../browser/youtubeTranscriptLane.js";

const result = await getYouTubeTranscriptChromeHealth();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
