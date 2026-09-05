/**
 * Recover Chromium persistent-profile locks without asking agents to hunt PIDs.
 *
 * A dead owner is cleaned. A live owner is reported and left untouched.
 */

import { readFileSync } from 'node:fs';
import { lstat, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CHROMIUM_LOCK_BASENAMES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
] as const;

export type BrowserProfileLockStatus = 'none' | 'active' | 'stale' | 'unreadable';

export interface BrowserProfileLockOwner {
  pid?: number;
  hostname?: string;
  lockPath: string;
  target?: string;
}

export interface BrowserProfileRecovery {
  profileDir: string;
  status: BrowserProfileLockStatus;
  recovered: boolean;
  blocked: boolean;
  owner?: BrowserProfileLockOwner;
  removed: string[];
  message: string;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = status.lastIndexOf(')');
      const state = commandEnd >= 0 ? status.slice(commandEnd + 2).charAt(0) : '';
      if (state === 'Z' || state === 'X') return false;
    } catch {
      // Fall through to the portable signal probe.
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM: the process exists but we cannot signal it.
    return true;
  }
}

export interface BrowserProfileTermination {
  ownerPid?: number;
  terminated: boolean;
  recovery: BrowserProfileRecovery;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

/** Stop only the Chromium process that owns this exact persistent profile. */
export async function terminateChromiumProfileOwner(
  profileDir: string,
): Promise<BrowserProfileTermination> {
  const owner = await readChromiumLockOwner(profileDir);
  const ownerPid = owner?.pid;
  let terminated = false;
  if (typeof ownerPid === 'number' && ownerPid !== process.pid && isPidAlive(ownerPid)) {
    try {
      process.kill(ownerPid, 'SIGTERM');
      terminated = await waitForPidExit(ownerPid, 2_000);
      if (!terminated && isPidAlive(ownerPid)) {
        process.kill(ownerPid, 'SIGKILL');
        terminated = await waitForPidExit(ownerPid, 2_000);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      terminated = true;
    }
  } else if (typeof ownerPid === 'number' && !isPidAlive(ownerPid)) {
    terminated = true;
  }
  return {
    ownerPid,
    terminated,
    recovery: await recoverChromiumProfileLocks(profileDir),
  };
}

export function parseChromiumLockTarget(target: string): { hostname?: string; pid?: number } {
  const trimmed = target.trim();
  const dash = trimmed.lastIndexOf('-');
  if (dash <= 0 || dash === trimmed.length - 1) {
    const pidOnly = Number(trimmed);
    return Number.isInteger(pidOnly) ? { pid: pidOnly } : {};
  }
  const hostname = trimmed.slice(0, dash);
  const pid = Number(trimmed.slice(dash + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { hostname };
  return { hostname, pid };
}

export async function readChromiumLockOwner(profileDir: string): Promise<BrowserProfileLockOwner | undefined> {
  const lockPath = path.join(profileDir, 'SingletonLock');
  try {
    const stats = await lstat(lockPath);
    let target: string | undefined;
    if (stats.isSymbolicLink()) {
      target = await readlink(lockPath);
    } else if (stats.isFile()) {
      const { readFile } = await import('node:fs/promises');
      target = (await readFile(lockPath, 'utf8')).trim();
    } else {
      return { lockPath };
    }
    const parsed = parseChromiumLockTarget(target ?? '');
    return {
      lockPath,
      target,
      ...parsed,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { lockPath };
  }
}

function lockErrorMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /singleton|profile( directory)?.*(lock|in use)|processsingleton|browser.*already in use/i.test(message);
}

export function isChromiumProfileLockError(error: unknown): boolean {
  return lockErrorMessage(error);
}

async function removeLockFiles(profileDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of [...CHROMIUM_LOCK_BASENAMES, 'DevToolsActivePort']) {
    const target = path.join(profileDir, name);
    try {
      await lstat(target);
      await rm(target, { force: true });
      removed.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(target, { force: true });
        removed.push(name);
      }
    }
  }
  return removed;
}

export async function recoverChromiumProfileLocks(
  profileDir: string,
): Promise<BrowserProfileRecovery> {
  const owner = await readChromiumLockOwner(profileDir);
  if (!owner) {
    return {
      profileDir,
      status: 'none',
      recovered: false,
      blocked: false,
      removed: [],
      message: 'No Chromium profile lock is present.',
    };
  }

  if (typeof owner.pid === 'number' && isPidAlive(owner.pid)) {
    return {
      profileDir,
      status: 'active',
      recovered: false,
      blocked: true,
      owner,
      removed: [],
      message: `Browser profile is in use by live process ${owner.pid}. Wait for that CLI run to finish, or cancel it with npm run agent:cancel.`,
    };
  }

  const removed = await removeLockFiles(profileDir);
  const staleWithoutPid = typeof owner.pid !== 'number';
  return {
    profileDir,
    status: staleWithoutPid ? 'unreadable' : 'stale',
    recovered: true,
    blocked: false,
    owner,
    removed,
    message: staleWithoutPid
      ? 'Removed an unreadable Chromium profile lock left by a previous run.'
      : `Removed stale Chromium profile lock from dead process ${owner.pid}.`,
  };
}

/** Test helper: write a POSIX-style SingletonLock pointing at hostname-pid. */
export async function writeChromiumSingletonLock(
  profileDir: string,
  owner: { hostname?: string; pid: number },
): Promise<string> {
  const lockPath = path.join(profileDir, 'SingletonLock');
  const target = `${owner.hostname ?? 'localhost'}-${owner.pid}`;
  try {
    const { symlink } = await import('node:fs/promises');
    await symlink(target, lockPath);
  } catch {
    await writeFile(lockPath, target, 'utf8');
  }
  return lockPath;
}
