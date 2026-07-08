import { runYouTubeTranscriptCapture } from "../obsidian/youtubeTranscriptCapture.js";
import { parseYouTubeTranscriptArgs } from "./youtubeTranscriptArgs.js";

const args = parseYouTubeTranscriptArgs(process.argv.slice(2));
const result = await runYouTubeTranscriptCapture({
  url: args.url ?? args["source-url"],
  sourceTitle: args["source-title"],
  capturedAt: args["captured-at"],
  artifactRoot: args["artifact-root"]
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = result.status === "rejected" ? 2 : 1;
