/**
 * Signal a worker child process and every descendant it owns.
 *
 * The stored-worker wrapper launches a short-lived proof/loop process that
 * can in turn spawn the PostgreSQL worker. Signalling only the wrapper leaves
 * that descendant orphaned when a timeout occurs. A detached child has its
 * own process group, so a negative PID targets only that owned group.
 */
export function signalWorkerProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
  try {
    process.kill(-(pid as number), signal);
    return true;
  } catch {
    return false;
  }
}
