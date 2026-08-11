import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("Zeabur app-server entrypoint uses a mounted token file and never exposes the token", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-codex-entrypoint-"));
  const fakeBin = join(root, "bin");
  const capturePath = join(root, "token-env.txt");
  const argsPath = join(root, "args.txt");
  const tokenPath = join(root, "token");
  const fakeCodex = join(fakeBin, "codex");
  const token = "unit-test-high-entropy-token";
  try {
    mkdirSync(fakeBin, { mode: 0o700 });
    writeFileSync(
      fakeCodex,
      "#!/bin/sh\nprintf '%s' \"${CODEX_APP_SERVER_TOKEN-unset}\" > \"$CAPTURE_FILE\"\nprintf '%s\\n' \"$@\" > \"$ARGS_FILE\"\n",
      { mode: 0o700 }
    );
    chmodSync(fakeCodex, 0o700);
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });

    const env = { ...process.env };
    delete env.CODEX_APP_SERVER_TOKEN;
    env.PATH = `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`;
    env.CODEX_APP_SERVER_TOKEN_FILE = tokenPath;
    env.CAPTURE_FILE = capturePath;
    env.ARGS_FILE = argsPath;
    env.CODEX_APP_SERVER_PORT = "4500";
    env.CODEX_HOME = join(root, "codex");

    execFileSync("sh", [join(process.cwd(), "ops/zeabur/start-codex-app-server.sh")], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    assert.equal(readFileSync(capturePath, "utf8"), "unset");
    const args = readFileSync(argsPath, "utf8");
    assert.match(args, /--ws-token-file\n/u);
    assert.match(args, new RegExp(`${tokenPath}\\n`, "u"));
    assert.doesNotMatch(args, new RegExp(token, "u"));
    assert.match(args, /--listen\nws:\/\/127\.0\.0\.1:4500\n/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Zeabur app-server entrypoint rejects an unapproved non-loopback listener", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-codex-entrypoint-bind-"));
  const fakeBin = join(root, "bin");
  const tokenPath = join(root, "token");
  const fakeCodex = join(fakeBin, "codex");
  try {
    mkdirSync(fakeBin, { mode: 0o700 });
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    writeFileSync(tokenPath, "unit-test-token\n", { mode: 0o600 });
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      CODEX_APP_SERVER_TOKEN_FILE: tokenPath,
      CODEX_APP_SERVER_BIND_HOST: "0.0.0.0",
      CODEX_APP_SERVER_NON_LOOPBACK_APPROVED: "0",
      CODEX_APP_SERVER_TLS_TERMINATED: "0"
    };
    assert.throws(
      () => execFileSync("sh", [join(process.cwd(), "ops/zeabur/start-codex-app-server.sh")], { cwd: process.cwd(), env, stdio: "pipe" }),
      /explicit private-ingress and TLS approval/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Zeabur app-server image provides the documented remote cwd", () => {
  const dockerfile = readFileSync(join(process.cwd(), "ops/zeabur/Dockerfile.codex-app-server"), "utf8");
  assert.match(dockerfile, /^WORKDIR \/app$/mu);
  assert.match(readFileSync(join(process.cwd(), "ops/zeabur/codex-app-server.env.example"), "utf8"), /AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_CWD=\/app/u);
});
