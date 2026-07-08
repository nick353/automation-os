# Parallel Lane Design

All tasks are modeled as parallel-capable by default. Each Playwright CLI task receives its own profile directory, CDP port, and workdir. Playwright CLI is the primary browser/UI verification lane for Automation OS local checks.

Browser Use follows the same lane boundary when authentication or saved profile state matters: session-only Browser Use checks may run in parallel, and each one must run `open/state/screenshot/close` on the same unique `--session` so temporary windows do not remain. Authenticated profile separation must use a lane-specific `--cdp-url http://127.0.0.1:<port>` and `--profile <profileDir>`; local checks must not issue `browser-use close` against that CDP/profile lane. Post, send, publish, submit, and similar commits stay serialized by resource locks unless an explicit collision override is approved.

X/Twitter learning capture has its own authenticated read-only lane:

- Lane name: `x_learning_authenticated_cdp`
- CDP port: `9336`
- Profile dir: `/Users/nichikatanaka/.x-learning-playwright-chrome`

This lane is opened with `npm run chrome:open:x-learning`, which starts Chrome with `--remote-debugging-port=9336`, `--user-data-dir=/Users/nichikatanaka/.x-learning-playwright-chrome`, `--profile-directory=Default`, and `https://x.com/home`. Health is checked only with `npm run chrome:health:x-learning` against `http://127.0.0.1:9336/json/version`. It must not fall back to Daily AI `9333`, job research `9334`, NisenPrints `9335`, or the main Chrome/Profile2 `9222` lane.

YouTube transcript capture has its own visible read-only lane:

- Lane name: `youtube_visible_transcript_cdp`
- CDP port: `9337`
- Profile dir: `/Users/nichikatanaka/.youtube-transcript-playwright-chrome`

This lane is opened with `npm run chrome:open:youtube-transcript`, which starts Chrome with `--remote-debugging-port=9337`, `--user-data-dir=/Users/nichikatanaka/.youtube-transcript-playwright-chrome`, `--profile-directory=Default`, and `https://www.youtube.com/`. Health is checked only with `npm run chrome:health:youtube-transcript` against `http://127.0.0.1:9337/json/version`. It must not fall back to Daily AI `9333`, job research `9334`, NisenPrints `9335`, X learning `9336`, or the main Chrome/Profile2 `9222` lane. The capture is read-only except for revealing the official transcript panel; it must not post, comment, like, subscribe, save, share, upload, download, or touch account/studio surfaces.

Cleanup is proof-bearing. Browser Use local checks record `metadata.cleanup.attempted`, `status`, `reason`, and `command` in the system check and bridge receipt. A failed unique-session cleanup blocks the check even when state and screenshot artifacts exist; skipped cleanup is only valid for CDP/profile lanes or a missing Browser Use CLI.

Recording QA is auxiliary proof for Playwright-led UI verification and remains a strict gate only for explicit recording diagnostic endpoints. CDP/profile lanes may use the configured or built-in CDP screencast sidecar; a Gemini mismatch vetoes a claimed completion, but missing recording/Gemini proof does not replace or relax the primary Playwright DOM/screenshot/console proof gate.

Dangerous operations such as Post, Send, Publish, Submit, Save, Sheets, Calendar, Etsy, and similar commits require approval. If the user explicitly approves all-parallel execution, shared commit resources are recorded as `collision:<resource>` approval locks and may run in parallel after that approval.

Collision handling is visible:

- `approval_group_id` groups related commit decisions.
- `resource_locks` identifies shared resources.
- lane health shows collisions before execution commits, and collision overrides stay visible in the approval resources.

The MVP demo uses Daily AI ports from `9333` upward to match the local lane policy.
