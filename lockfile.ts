import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, stat, sleep } from './lockutils.js';

interface LockOption {
  waitTimeMS?: number;
  retryCount?: number;
  deadlockTimeMS?: number;
  name?: string;
}

interface NormalizedLockOption {
  waitTimeMS: number;
  retryCount: number;
  deadlockTimeMS: number;
  name: string;
}

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
}

const OWNER_FILE = '.lockfile-light-owner';
const REAPER_FILE = '.lockfile-light-reaper';

/** Execute a callback while holding an exclusive directory lock. */
export async function lock(
  dirPath: string,
  options: LockOption,
  callback: () => unknown | Promise<unknown>,
): Promise<string> {
  const lockOptions = normalizeOptions(options);
  fs.mkdirSync(path.dirname(path.resolve(dirPath)), { recursive: true, mode: 0o777 });

  for (let retry = 0; ; retry++) {
    const owner = createOwner();
    let acquired = false;
    try {
      // A non-recursive mkdir is the atomic lock acquisition operation.
      fs.mkdirSync(dirPath, { mode: 0o777 });
      acquired = true;
    } catch (err: unknown) {
      if (!isNodeError(err, 'EEXIST')) {
        throw new Error(`Could not get lock: ${errorMessage(err)}`, { cause: err });
      }
    }
    if (acquired) {
      return await executeTask(dirPath, lockOptions, owner, callback);
    }

    if (await removeStaleLock(dirPath, lockOptions.deadlockTimeMS)) {
      continue;
    }
    if (retry >= lockOptions.retryCount) {
      throw new Error(`Could not get lock: path=${dirPath}`);
    }
    await sleep(lockOptions.waitTimeMS);
  }
}

async function executeTask(
  dirPath: string,
  options: NormalizedLockOption,
  owner: LockOwner,
  callback: () => unknown | Promise<unknown>,
): Promise<string> {
  const ownerPath = path.join(dirPath, OWNER_FILE);
  try {
    fs.writeFileSync(ownerPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (err: unknown) {
    tryRemoveEmptyDirectory(dirPath);
    throw new Error(`Could not initialize lock: ${errorMessage(err)}`, { cause: err });
  }

  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    try {
      const currentOwner = readOwner(ownerPath);
      if (currentOwner?.token !== owner.token) {
        throw new Error('Lock ownership was lost');
      }
      const now = new Date();
      fs.utimesSync(ownerPath, now, now);
    } catch (err: unknown) {
      heartbeatError = err;
    }
  }, heartbeatInterval(options.deadlockTimeMS));
  heartbeat.unref();

  let callbackError: unknown;
  try {
    await callback();
  } catch (err: unknown) {
    callbackError = err;
  } finally {
    clearInterval(heartbeat);
  }

  let releaseError: unknown;
  try {
    if (heartbeatError !== undefined) {
      throw heartbeatError;
    }
    await releaseLock(dirPath, owner);
  } catch (err: unknown) {
    releaseError = err;
  }

  if (callbackError !== undefined && releaseError !== undefined) {
    throw new AggregateError([callbackError, releaseError], 'Task and lock release both failed');
  }
  if (callbackError !== undefined) {
    throw callbackError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return options.name;
}

async function releaseLock(dirPath: string, owner: LockOwner): Promise<void> {
  const ownerPath = path.join(dirPath, OWNER_FILE);
  const currentOwner = readOwner(ownerPath);
  if (currentOwner?.token !== owner.token) {
    throw new Error(`Could not release lock: ownership was lost for path=${dirPath}`);
  }

  fs.unlinkSync(ownerPath);
  for (let retry = 0; retry <= 10; retry++) {
    try {
      fs.rmdirSync(dirPath);
      return;
    } catch (err: unknown) {
      if (isNodeError(err, 'ENOENT')) {
        return;
      }
      if (retry === 10) {
        throw new Error(`Could not release lock: ${errorMessage(err)}`, { cause: err });
      }
      await sleep(10);
    }
  }
}

async function removeStaleLock(dirPath: string, deadlockTimeMS: number): Promise<boolean> {
  const lockStats = safeLstat(dirPath);
  if (lockStats === undefined) {
    return true;
  }
  if (!lockStats.isDirectory()) {
    throw new Error(`Could not get lock: lock path is not a directory: ${dirPath}`);
  }

  const ownerPath = path.join(dirPath, OWNER_FILE);
  const owner = readOwner(ownerPath);
  const timestamp = safeStat(ownerPath)?.mtimeMs ?? lockStats.mtimeMs;
  if (Date.now() - timestamp <= deadlockTimeMS || isRunningLocalOwner(owner)) {
    return false;
  }

  const reaperPath = path.join(dirPath, REAPER_FILE);
  const reaperToken = crypto.randomUUID();
  try {
    fs.writeFileSync(reaperPath, reaperToken, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (err: unknown) {
    if (isNodeError(err, 'EEXIST', 'ENOENT')) {
      return false;
    }
    throw new Error(`Could not inspect stale lock: ${errorMessage(err)}`, { cause: err });
  }

  try {
    const latestOwner = readOwner(ownerPath);
    // Creating the reaper marker changes the directory mtime, so a legacy
    // empty lock must continue to use the timestamp captured before claiming.
    const latestStats = latestOwner === undefined ? lockStats : safeStat(ownerPath);
    if (
      latestStats === undefined ||
      Date.now() - latestStats.mtimeMs <= deadlockTimeMS ||
      isRunningLocalOwner(latestOwner)
    ) {
      return false;
    }

    const entries = fs.readdirSync(dirPath);
    const knownEntries = new Set([OWNER_FILE, REAPER_FILE]);
    if (entries.some((entry) => !knownEntries.has(entry))) {
      throw new Error(`Refusing to remove non-empty lock directory: path=${dirPath}`);
    }
    if (entries.includes(OWNER_FILE) && latestOwner === undefined) {
      throw new Error(`Refusing to remove lock with invalid owner metadata: path=${dirPath}`);
    }

    if (latestOwner !== undefined) {
      fs.unlinkSync(ownerPath);
    }
    removeOwnedReaper(reaperPath, reaperToken);
    fs.rmdirSync(dirPath);
    return true;
  } finally {
    removeOwnedReaper(reaperPath, reaperToken);
  }
}

function normalizeOptions(options: LockOption): NormalizedLockOption {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  return {
    waitTimeMS: positiveFiniteNumber(options.waitTimeMS, 300, 'waitTimeMS'),
    retryCount: nonNegativeInteger(options.retryCount, 10, 'retryCount'),
    deadlockTimeMS: positiveFiniteNumber(options.deadlockTimeMS, 30_000, 'deadlockTimeMS'),
    name: options.name ?? '?',
  };
}

function positiveFiniteNumber(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return result;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return result;
}

function createOwner(): LockOwner {
  return { version: 1, token: crypto.randomUUID(), pid: process.pid, hostname: os.hostname() };
}

function readOwner(ownerPath: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (
      typeof value === 'object' && value !== null &&
      (value as LockOwner).version === 1 &&
      typeof (value as LockOwner).token === 'string' &&
      Number.isInteger((value as LockOwner).pid) &&
      typeof (value as LockOwner).hostname === 'string'
    ) {
      return value as LockOwner;
    }
  } catch {
    // Missing or partially-written metadata is handled using the directory age.
  }
  return undefined;
}

function isRunningLocalOwner(owner: LockOwner | undefined): boolean {
  if (owner === undefined || owner.hostname !== os.hostname()) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err: unknown) {
    return isNodeError(err, 'EPERM');
  }
}

function removeOwnedReaper(reaperPath: string, token: string): void {
  try {
    if (fs.readFileSync(reaperPath, 'utf8') === token) {
      fs.unlinkSync(reaperPath);
    }
  } catch {
    // Another process may already have removed the stale lock directory.
  }
}

function tryRemoveEmptyDirectory(dirPath: string): void {
  try {
    fs.rmdirSync(dirPath);
  } catch {
    // Preserve unexpected contents for inspection.
  }
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch (err: unknown) {
    if (isNodeError(err, 'ENOENT')) return undefined;
    throw err;
  }
}

function safeLstat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (err: unknown) {
    if (isNodeError(err, 'ENOENT')) return undefined;
    throw err;
  }
}

function heartbeatInterval(deadlockTimeMS: number): number {
  return Math.max(1, Math.floor(deadlockTimeMS / 3));
}

function isNodeError(err: unknown, ...codes: string[]): err is NodeJS.ErrnoException {
  return err instanceof Error && codes.includes((err as NodeJS.ErrnoException).code ?? '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { sleep, exists, stat };
