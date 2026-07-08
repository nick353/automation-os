import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:server"], { stdio: "inherit", shell: true }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit", shell: true })
];

const stop = (signal) => {
  for (const child of children) child.kill(signal);
};

process.on("SIGINT", () => {
  stop("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  stop("SIGTERM");
  process.exit(0);
});

children.forEach((child) => {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      stop("SIGTERM");
      process.exit(code);
    }
  });
});
