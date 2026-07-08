#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "/Users/nichikatanaka/Documents/Codex/2026-06-03/playwight-mcp-playwirhgt-cli/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback = "") => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const runId = String(valueAfter("--run-id", `facebook-crosspost-readback-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  .replace(/[^0-9A-Za-z_.-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 96);
const outRoot = resolve(valueAfter("--out-root", join(process.cwd(), "data", "artifacts", "sns-multi-poster-ukiyoe")));
const runDir = join(outRoot, "artifacts", "runs", runId);
const cdpPort = Number(valueAfter("--cdp-port", process.env.SNS_MULTI_POSTER_CDP_PORT || "9339"));
const cdpUrl = valueAfter("--cdp-url", process.env.SNS_MULTI_POSTER_CDP_URL || `http://127.0.0.1:${cdpPort}`);
const profileDir = valueAfter(
  "--profile-dir",
  process.env.SNS_MULTI_POSTER_PROFILE_DIR || "/Users/nichikatanaka/.sns-multi-poster-ukiyoe-playwright-chrome"
);
const caption = valueAfter("--caption", process.env.SNS_MULTI_POSTER_CAPTION || "🌸");
const instagramUrl = valueAfter("--instagram-url", process.env.SNS_MULTI_POSTER_INSTAGRAM_URL || "");
const threadsUrl = valueAfter("--threads-url", process.env.SNS_MULTI_POSTER_THREADS_URL || "");
const facebookPageUrl = valueAfter(
  "--facebook-page-url",
  process.env.SNS_MULTI_POSTER_FACEBOOK_PAGE_URL || "https://www.facebook.com/profile.php?id=61588485021486"
);
const keepBrowser = process.env.SNS_MULTI_POSTER_KEEP_BROWSER === "true";
const chromeBin =
  process.env.AUTOMATION_OS_SNS_MULTI_POSTER_CHROME_BIN ||
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(runDir, { recursive: true });

const resultPath = join(runDir, "facebook-crosspost-readback.json");
const screenshotPath = join(runDir, "facebook-crosspost-readback.png");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpVersion() {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, version: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureChrome() {
  const before = await cdpVersion();
  if (before.ok) return { launched: false, pid: null, version: before.version };
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    chromeBin,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.facebook.com/",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  let after = await cdpVersion();
  for (let attempt = 0; attempt < 20 && !after.ok; attempt += 1) {
    await delay(1000);
    after = await cdpVersion();
  }
  return { launched: true, pid: child.pid || null, version: after.version || null, launch_ok: after.ok, launch_error: after.error || "" };
}

function cleanupChrome() {
  if (keepBrowser) return { skipped: true, reason: "SNS_MULTI_POSTER_KEEP_BROWSER=true" };
  const ps = spawnSync("ps", ["axww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
  const rows = String(ps.stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] };
    })
    .filter(Boolean)
    .filter((row) => row.command.includes(`--remote-debugging-port=${cdpPort}`) && row.command.includes(`--user-data-dir=${profileDir}`));
  const pgids = [...new Set(rows.map((row) => row.pgid).filter(Boolean))];
  for (const pgid of pgids) spawnSync("kill", ["-TERM", `-${pgid}`], { stdio: "ignore" });
  if (pgids.length) {
    spawnSync("sleep", ["1"], { stdio: "ignore" });
    for (const pgid of pgids) spawnSync("kill", ["-KILL", `-${pgid}`], { stdio: "ignore" });
  }
  const after = spawnSync("ps", ["axww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
  const remaining = String(after.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.includes(`--remote-debugging-port=${cdpPort}`) && line.includes(`--user-data-dir=${profileDir}`));
  return { terminated_pgids: pgids, remaining };
}

function classifyReadback(text) {
  const loggedIn = /Nichika Tanaka|Create a post|What's on your mind|Professional dashboard|NisenPrints|Unread Chats|Go to Feed|Number of unread notifications/i.test(text);
  const loginSurface = /Log in|Forgot password|Create new account|ログイン|メールアドレス/i.test(text) && !loggedIn;
  const unavailable = /This content isn't available right now|このコンテンツは利用できません|owner only shared it with a small group/i.test(text);
  const captionSeen = caption ? text.includes(caption) : false;
  const nisenSeen = /NisenPrints/i.test(text);
  const instagramHint = instagramUrl && text.includes(instagramUrl);
  const threadsHint = threadsUrl && text.includes(threadsUrl);
  return {
    logged_in: loggedIn,
    login_surface: loginSurface,
    nisenprints_seen: nisenSeen,
    caption_seen: captionSeen,
    instagram_url_seen: Boolean(instagramHint),
    threads_url_seen: Boolean(threadsHint),
    content_unavailable: unavailable,
    crosspost_verified: Boolean(loggedIn && nisenSeen && (captionSeen || instagramHint || threadsHint)),
  };
}

let browser;
let payload = {
  status: "blocked",
  run_id: runId,
  checked_at: new Date().toISOString(),
  cdp_url: cdpUrl,
  profile_dir: profileDir,
  caption,
  instagram_url: instagramUrl,
  threads_url: threadsUrl,
  external_action_executed: false,
};

try {
  payload.chrome = await ensureChrome();
  if (payload.chrome.launch_ok === false) throw new Error(`facebook_cdp_unavailable:${payload.chrome.launch_error || "unknown"}`);
  browser = await chromium.connectOverCDP(cdpUrl, { noDefaults: true });
  const context = browser.contexts()[0];
  if (!context) throw new Error("facebook_default_context_missing");
  const page = await context.newPage();
  await page.goto("https://www.facebook.com/NisenPrints", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(async () => {
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  });
  await page.waitForTimeout(4000);
  let text = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  let pageUrl = page.url();
  let title = await page.title().catch(() => "");
  let readback = classifyReadback(text);
  let fallbackHome = null;
  let shortcutPage = null;
  if (readback.logged_in && readback.content_unavailable) {
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const homeText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    fallbackHome = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      readback: classifyReadback(homeText),
      text_sample: homeText.slice(0, 1500),
    };
    if (fallbackHome.readback.nisenprints_seen && facebookPageUrl) {
      await page.goto(facebookPageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const shortcutText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
      shortcutPage = {
        url: page.url(),
        title: await page.title().catch(() => ""),
        readback: classifyReadback(shortcutText),
        text_sample: shortcutText.slice(0, 1800),
      };
      if (shortcutPage.readback.nisenprints_seen && !shortcutPage.readback.content_unavailable) {
        text = shortcutText;
        pageUrl = shortcutPage.url;
        title = shortcutPage.title;
        readback = shortcutPage.readback;
      }
    }
    pageUrl = pageUrl || fallbackHome.url;
    title = title || fallbackHome.title;
  }
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  payload = {
    ...payload,
    status: readback.crosspost_verified ? "success" : readback.logged_in ? "partial" : "blocked",
    exact_blocker: readback.crosspost_verified
      ? ""
      : readback.logged_in
        ? readback.content_unavailable
          ? "facebook_nisenprints_page_unavailable_or_not_public"
          : "facebook_crosspost_not_visible_in_readback"
        : "facebook_login_or_account_choice_surface_persists",
    url: pageUrl,
    title,
    readback,
    fallback_home: fallbackHome,
    shortcut_page: shortcutPage,
    text_sample: text.slice(0, 2500),
    screenshot: screenshotPath,
  };
  await page.close().catch(() => {});
} catch (error) {
  payload.exact_blocker = String(error?.message || error);
} finally {
  if (browser) await browser.close().catch(() => {});
  payload.cleanup = cleanupChrome();
  writeFileSync(resultPath, `${JSON.stringify({ ...payload, result_path: resultPath }, null, 2)}\n`);
  console.log(JSON.stringify({ ...payload, result_path: resultPath }));
  process.exit(payload.status === "blocked" ? 1 : 0);
}
