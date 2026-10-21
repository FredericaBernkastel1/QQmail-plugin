import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";

export type LockOwnerState = "alive" | "dead" | "unknown";
export interface OwnedFileLock { release(): Promise<void> }
export class LocalLockError extends Error {
  constructor(readonly code: "LOCK_BUSY" | "LOCK_UNVERIFIABLE" | "LOCK_CHANGED" | "LOCK_RECOVERY_BUSY") {
    super(code === "LOCK_UNVERIFIABLE" ? "The lock has no verifiable owner. Stop all plugin processes and inspect the lock; it was not removed."
      : code === "LOCK_RECOVERY_BUSY" ? "Lock recovery is active or was interrupted. Stop all plugin processes before inspecting the .recovery marker."
      : code === "LOCK_CHANGED" ? "The lock changed during recovery; it was not reclaimed."
      : "The lock owner is alive or cannot be verified. Retry after that process exits.");
    this.name = "LocalLockError";
  }
}
function ownerState(pid: number): LockOwnerState {
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}
async function contents(file: string): Promise<string> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new LocalLockError("LOCK_UNVERIFIABLE");
  return readFile(file, "utf8");
}
function ownerPid(raw: string): number {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join() !== "createdAt,pid,token,version" || record.version !== 1 ||
        !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || typeof record.createdAt !== "string" ||
        typeof record.token !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.token)) throw Error();
    return record.pid as number;
  } catch { throw new LocalLockError("LOCK_UNVERIFIABLE"); }
}

/** Private owner metadata is the protocol; age alone never permits recovery.
 * Callers own directory creation/ACL. A PID reused by a living process blocks
 * recovery conservatively. Unknown liveness and ownerless old locks fail closed.
 */
export async function acquireOwnedFileLock(lockPath: string, options: {
  ownerState?: (pid: number) => LockOwnerState;
} = {}): Promise<OwnedFileLock> {
  const probe = options.ownerState ?? ownerState;
  const recoveryPath = lockPath + ".recovery";
  const recovery = await lstat(recoveryPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
  });
  if (recovery) throw new LocalLockError("LOCK_RECOVERY_BUSY");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let guard;
    try { guard = await open(recoveryPath, "wx", 0o600); }
    catch { throw new LocalLockError("LOCK_RECOVERY_BUSY"); }
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
      const original = await contents(lockPath);
      const pid = ownerPid(original);
      if (probe(pid) !== "dead") throw new LocalLockError("LOCK_BUSY");
      if (await contents(lockPath) !== original || probe(pid) !== "dead") throw new LocalLockError("LOCK_CHANGED");
      await rm(lockPath);
      // The guard prevents a second recovering process from deleting our new
      // lock. A previously queued normal wx may win; never replace its file.
      lock = await open(lockPath, "wx", 0o600);
    } finally { await guard.close(); await rm(recoveryPath, { force: true }); }
  }
  const owner = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() });
  try { await lock.writeFile(owner); await lock.sync(); }
  catch (error) { await lock.close(); throw error; }
  let released = false;
  return { async release() {
    if (released) return;
    released = true;
    await lock.close();
    if (await contents(lockPath).catch(() => undefined) !== owner) throw new LocalLockError("LOCK_CHANGED");
    await rm(lockPath);
  } };
}
