import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../api.js";

/**
 * Package root directory. Source tests run from src/, compiled code from
 * dist/src/, so walk up until the plugin manifest is found.
 */
export function resolvePackageRoot(
  startDir = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir, "..", "..");
    dir = parent;
  }
}

export const packageRoot = resolvePackageRoot();

// Backward-compatible alias for existing tests and singleton defaults.
export const pluginRoot = packageRoot;

export function resolvePluginDataRoot(
  stateDir: string,
  pluginId: string,
): string {
  return path.join(stateDir, "plugins", pluginId);
}

export function intentsPath(dataRoot: string): string {
  return path.join(dataRoot, "intents");
}

export function sessionsDirPath(dataRoot: string): string {
  return path.join(dataRoot, "sessions");
}

export function statsPath(dataRoot: string): string {
  return path.join(dataRoot, "stats.json");
}

export function reviewLogPath(dataRoot: string): string {
  return path.join(dataRoot, "review.json");
}

export function legacyReviewLogPath(dataRoot: string): string {
  return path.join(dataRoot, "evolution.json");
}

/**
 * Resolve a path under the sessions directory.
 */
export function sessionsPath(filename: string, dataRoot = pluginRoot): string {
  return path.join(sessionsDirPath(dataRoot), filename);
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
 * Non-blocking sleep using setTimeout + Promise.
 * Avoids Atomics.wait which blocks the Node.js event loop.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
   * Acquire the lock with exponential backoff (async, non-blocking).
   * Returns true if acquired, false if timeout.
   */
  async acquire(): Promise<boolean> {
    const start = Date.now();
    let backoff = LOCK_INITIAL_BACKOFF_MS;

    // Ensure parent directory exists so mkdir for lock doesn't fail on missing parent
    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    } catch {
      // ignore
    }

    while (true) {
      // Try to acquire the lock
      try {
        fs.mkdirSync(this.lockPath);
        return true;
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") {
          // Non-EEXIST errors (EACCES, ENOENT, etc.) should fail fast
          logger.warn("failed to acquire file lock", {
            error: err,
            path: this.lockPath,
          });
          return false;
        }
        // EEXIST means lock already exists — check if stale.
        // Known limitation: TOCTOU race condition exists when multiple processes
        // detect staleness simultaneously and both steal the lock. In this plugin's
        // usage pattern (single-process Node.js plugin with occasional background tasks),
        // concurrent stale-lock stealing is extremely unlikely. If true cross-process
        // safety is required, consider using atomic rename or external lock libraries.
        if (this.isStale()) {
          this.forceRelease();
          // Fall through to sleep/timeout check — prevents infinite loop if rmdirSync fails silently
        }
      }

      // Check timeout
      const elapsed = Date.now() - start;
      if (elapsed >= LOCK_MAX_WAIT_MS) return false;

      // Non-blocking exponential backoff wait
      const sleepTime = Math.min(backoff, LOCK_MAX_WAIT_MS - elapsed);
      await sleep(sleepTime);
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
      // Use rmSync with recursive+force to handle stray files (e.g., .DS_Store)
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Release the lock normally.
   */
  release(): void {
    try {
      // Use rmSync with recursive+force to handle stray files (e.g., .DS_Store)
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execute an async function while holding a file lock.
 * Returns undefined if lock cannot be acquired.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const lock = new FileLock(targetPath);
  if (!(await lock.acquire())) return undefined;
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
