import process from "node:process";

function validPid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

function groupExists(pid) {
  if (process.platform === "win32") return null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
}

function signalGroup(pid, signal) {
  if (process.platform === "win32" || !validPid(pid)) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (_) {
    return false;
  }
}

function signalChild(child, signal) {
  try {
    return child.kill(signal);
  } catch (_) {
    return false;
  }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(value);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(exited(child)), Math.max(1, timeoutMs));
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function cleanupOwnedProcessGroup(child, graceMs = 5_000) {
  const supported = process.platform !== "win32";
  const pid = child.pid;
  if (!validPid(pid)) {
    const attempted = signalChild(child, "SIGTERM");
    await waitForExit(child, graceMs);
    const killSent = !exited(child) && signalChild(child, "SIGKILL");
    await waitForExit(child, Math.min(graceMs, 1_000));
    return { supported, attempted, termSent: attempted, killSent, verified: exited(child) };
  }

  const initialState = groupExists(pid);
  if (initialState === false) {
    return { supported, attempted: false, termSent: false, killSent: false, verified: exited(child) || groupExists(pid) === false };
  }

  const termSent = signalGroup(pid, "SIGTERM") || signalChild(child, "SIGTERM");
  await waitForExit(child, graceMs);
  if (groupExists(pid) === false) return { supported, attempted: true, termSent, killSent: false, verified: true };
  const killSent = signalGroup(pid, "SIGKILL") || (!exited(child) && signalChild(child, "SIGKILL"));
  await waitForExit(child, Math.min(graceMs, 1_000));
  return { supported, attempted: true, termSent, killSent, verified: exited(child) && groupExists(pid) === false };
}
