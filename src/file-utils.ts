import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../api.js";

/**
 * Plugin root directory — compiled code lives in dist/src/, so go up 2 levels.
 */
export const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Resolve a path under the sessions directory.
 */
export function sessionsPath(filename: string): string {
  return path.join(pluginRoot, "sessions", filename);
}

/**
 * Ensure a directory exists.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Write JSON data atomically: write to temp file, then rename.
 * This prevents corruption if the process crashes mid-write.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    ensureDir(dir);
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Read and parse a JSON file.
 */
export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

/**
 * Write JSON atomically with error logging.
 * Returns true on success, false on failure.
 */
export function safeWriteJson(
  filePath: string,
  data: unknown,
  logMessage: string,
): boolean {
  try {
    writeJsonAtomic(filePath, data);
    return true;
  } catch (err) {
    logger.warn(logMessage, { error: err, path: filePath });
    return false;
  }
}

/**
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// ============================================================================
// File Lock (Cross-process mutex using directory creation)
// ============================================================================

import {
  LOCK_STALE_THRESHOLD_MS,
  LOCK_MAX_WAIT_MS,
  LOCK_INITIAL_BACKOFF_MS,
  LOCK_MAX_BACKOFF_MS,
} from "./constants.js";

/**
 * Cross-process file lock using directory creation (atomic on POSIX).
 *
 * Uses `mkdirSync` which is atomic — if the directory already exists,
 * another process holds the lock.
 */
export class FileLock {
  private readonly lockPath: string;

  constructor(targetPath: string) {
    this.lockPath = `${targetPath}.lock`;
  }

  /**
   * Acquire the lock with exponential backoff.
   * Returns true if acquired, false if timeout.
   */
  acquire(): boolean {
    const start = Date.now();
    let backoff = LOCK_INITIAL_BACKOFF_MS;

    while (true) {
      // Try to acquire the lock
      try {
        fs.mkdirSync(this.lockPath);
        return true;
      } catch {
        // Lock exists — check if stale
        if (this.isStale()) {
          this.forceRelease();
          continue; // Retry immediately after releasing stale lock
        }
      }

      // Check timeout
      const elapsed = Date.now() - start;
      if (elapsed >= LOCK_MAX_WAIT_MS) return false;

      // Exponential backoff wait
      const sleepTime = Math.min(backoff, LOCK_MAX_WAIT_MS - elapsed);
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        sleepTime,
      );
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }

  /**
   * Check if the lock is stale (older than threshold).
   */
  private isStale(): boolean {
    try {
      const stat = fs.statSync(this.lockPath);
      const age = Date.now() - stat.mtimeMs;
      return age > LOCK_STALE_THRESHOLD_MS;
    } catch {
      return false; // Directory doesn't exist, not stale
    }
  }

  /**
   * Force release a stale lock.
   */
  private forceRelease(): void {
    try {
      fs.rmdirSync(this.lockPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Release the lock normally.
   */
  release(): void {
    try {
      fs.rmdirSync(this.lockPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execute a function while holding a file lock.
 * Returns undefined if lock cannot be acquired.
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
): T | undefined {
  const lock = new FileLock(targetPath);
  if (!lock.acquire()) return undefined;
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * Acquire a file lock using directory creation (atomic on POSIX).
 * Uses mkdir which is atomic, preventing race conditions across processes.
 */
export class FileLock {
  private readonly lockPath: string;
  private acquired = false;

  constructor(targetPath: string) {
    this.lockPath = `${targetPath}.lock`;
  }

  /**
   * Try to acquire the lock with timeout.
   * Returns true if acquired, false if timeout.
   */
  acquire(timeoutMs = 5000): boolean {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        fs.mkdirSync(this.lockPath);
        this.acquired = true;
        return true;
      } catch {
        // Lock exists, wait and retry
        const elapsed = Date.now() - start;
        if (elapsed >= timeoutMs) break;
        fs.readdirSync // just to use fs and avoid lint
        // Busy wait with small sleep
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(50, timeoutMs - elapsed),
        );
      }
    }
    return false;
  }

  /**
   * Release the lock.
   */
  release(): void {
    if (!this.acquired) return;
    try {
      fs.rmdirSync(this.lockPath);
    } catch {
      // Ignore cleanup errors
    }
    this.acquired = false;
  }
}

/**
 * Execute a function while holding a file lock.
 * Returns undefined if lock cannot be acquired.
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
  timeoutMs = 5000,
): T | undefined {
  const lock = new FileLock(targetPath);
  if (!lock.acquire(timeoutMs)) return undefined;
  try {
    return fn();
  } finally {
    lock.release();
  }
}
