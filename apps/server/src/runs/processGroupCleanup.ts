import type { ChildProcess } from "node:child_process";

export type OwnedProcessGroupCleanup = {
  supported: boolean;
  attempted: boolean;
  termSent: boolean;
  killSent: boolean;
  verified: boolean;
};

function validPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

function processGroupExists(pid: number): boolean | null {
  if (process.platform === "win32") return null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return null;
  }
}

function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || !validPid(pid)) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(value);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), Math.max(1, timeoutMs));
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/**
 * Terminate only a detached child process-group owned by this invocation.
 * A leader-only kill is insufficient because Browser Use helpers can leave
 * descendants holding a profile, port, recording, or browser session.
 */
export async function cleanupOwnedProcessGroup(child: ChildProcess, graceMs = 5_000): Promise<OwnedProcessGroupCleanup> {
  const supported = process.platform !== "win32";
  const pid = child.pid;
  if (!validPid(pid)) {
    const attempted = signalChild(child, "SIGTERM");
    await waitForChildExit(child, graceMs);
    const killSent = !childExited(child) && signalChild(child, "SIGKILL");
    await waitForChildExit(child, Math.min(graceMs, 1_000));
    return { supported, attempted, termSent: attempted, killSent, verified: childExited(child) };
  }

  const initialGroupState = processGroupExists(pid);
  if (initialGroupState === false) {
    return { supported, attempted: false, termSent: false, killSent: false, verified: childExited(child) || processGroupExists(pid) === false };
  }

  const termSent = signalOwnedProcessGroup(pid, "SIGTERM") || signalChild(child, "SIGTERM");
  await waitForChildExit(child, graceMs);
  if (processGroupExists(pid) === false) {
    return { supported, attempted: true, termSent, killSent: false, verified: true };
  }

  const killSent = signalOwnedProcessGroup(pid, "SIGKILL") || (!childExited(child) && signalChild(child, "SIGKILL"));
  await waitForChildExit(child, Math.min(graceMs, 1_000));
  const finalGroupState = processGroupExists(pid);
  return {
    supported,
    attempted: true,
    termSent,
    killSent,
    verified: childExited(child) && finalGroupState === false
  };
}
