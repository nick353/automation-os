import assert from "node:assert/strict";
import test from "node:test";

import { parseYouTubeTranscriptArgs } from "../cli/youtubeTranscriptArgs.js";

test("YouTube transcript CLI args keep equals signs inside inline values", () => {
  const args = parseYouTubeTranscriptArgs([
    "--url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s",
    "--source-title=A=B"
  ]);

  assert.equal(args.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s");
  assert.equal(args["source-title"], "A=B");
});

test("YouTube transcript CLI args accept separate values", () => {
  const args = parseYouTubeTranscriptArgs([
    "--url",
    "https://youtu.be/dQw4w9WgXcQ",
    "--captured-at",
    "2026-06-16T00:00:00.000Z"
  ]);

  assert.equal(args.url, "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(args["captured-at"], "2026-06-16T00:00:00.000Z");
});
