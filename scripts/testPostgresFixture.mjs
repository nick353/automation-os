import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_BINARIES = ["initdb", "pg_ctl"];
const SENSITIVE_ENV_NAMES = [
  "DATABASE_URL",
  "AUTOMATION_OS_DATABASE_URL",
  "AUTOMATION_OS_DB",
  "AUTOMATION_OS_WRITE_TOKEN",
  "AUTOMATION_OS_READ_TOKEN",
  "AUTOMATION_OS_QA_READ_TOKEN",
  "AUTOMATION_OS_REPLAY_READ_TOKEN",
];

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function hasExecutable(name) {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once("error", () => resolve({ code: 127, signal: null }));
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const missing = REQUIRED_BINARIES.filter((name) => !hasExecutable(name));
if (missing.length) {
  emit({
    status: "blocked",
    exact_blocker: "postgres_fixture_tools_missing",
    required: missing,
    external_effects: false,
  });
  process.exit(2);
}

const requestedCommand = process.argv.slice(2);
const testCommand = requestedCommand[0] === "--" ? requestedCommand.slice(1) : requestedCommand;
const command = testCommand.length ? testCommand[0] : "npm";
const commandArgs = testCommand.length ? testCommand.slice(1) : ["test"];
const fixtureRoot = mkdtempSync(join(tmpdir(), "automation-os-postgres-fixture-"));
const dataDir = join(fixtureRoot, "data");
const logPath = join(fixtureRoot, "postgres.log");
const port = await allocateLoopbackPort();
let serverStarted = false;
let cleaned = false;
let summary;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (serverStarted) {
    await runProcess("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const baseEnv = { ...process.env };
for (const name of SENSITIVE_ENV_NAMES) delete baseEnv[name];
baseEnv.AUTOMATION_OS_TEST_POSTGRES_URL = `postgresql://automation_test@127.0.0.1:${port}/postgres`;

try {
  const init = await runProcess("initdb", ["-D", dataDir, "-A", "trust", "-U", "automation_test"], { stdio: "ignore" });
  if (init.code !== 0) {
    summary = { status: "blocked", exact_blocker: "postgres_fixture_init_failed", external_effects: false };
    process.exitCode = 2;
  } else {
    // Treat a start attempt as owned so a partially started server is also
    // stopped before the temporary directory is removed.
    serverStarted = true;
    const start = await runProcess("pg_ctl", ["-D", dataDir, "-o", `-p ${port} -h 127.0.0.1`, "-l", logPath, "-w", "start"], { stdio: "ignore" });
    if (start.code !== 0) {
      summary = { status: "blocked", exact_blocker: "postgres_fixture_start_failed", external_effects: false };
      process.exitCode = 2;
    } else {
      const result = await runProcess(command, commandArgs, { stdio: "inherit", env: baseEnv });
      summary = {
        status: result.code === 0 ? "passed" : "failed",
        exact_blocker: result.code === 0 ? null : "postgres_fixture_test_command_failed",
        external_effects: false,
        exit_code: result.code,
        signal: result.signal,
      };
      process.exitCode = result.code;
    }
  }
} finally {
  await cleanup();
}

emit({ ...(summary ?? { status: "blocked", exact_blocker: "postgres_fixture_unknown_failure" }), cleanup: "complete" });
