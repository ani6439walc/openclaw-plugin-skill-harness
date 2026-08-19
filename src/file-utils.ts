import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir as resolveStateDirFallback } from "openclaw/plugin-sdk/state-paths";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";

/**
 * Safely resolves the OpenClaw state directory from a plugin API instance.
 * Falls back to OpenClaw state path resolution when `api.runtime.state` is unavailable
 * (e.g. during CLI metadata discovery or CLI registration).
 */
export function resolveStateDirFromApi(
  api?: Partial<OpenClawPluginApi>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (api?.runtime?.state?.resolveStateDir) {
    try {
      const dir = api.runtime.state.resolveStateDir(env);
      if (dir) return dir;
    } catch {
      // Ignore error and fall back below
    }
  }
  return resolveStateDirFallback(env);
}

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
// Backward-compatible alias for integrations that imported the previous name.
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

export function experiencesPath(dataRoot: string): string {
  return path.join(dataRoot, "experiences");
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

export function keywordCoverageLogPath(dataRoot: string): string {
  return path.join(dataRoot, "keyword-coverage.json");
}

export function agentWorkspacePath(dataRoot: string): string {
  return path.join(dataRoot, "workspace");
}

export function agentSessionsPath(dataRoot: string, agentName: string): string {
  return path.join(dataRoot, "agents", agentName, "sessions");
}

/**
 * Resolve a path under the sessions directory.
 */
export function sessionsPath(filename: string, dataRoot = packageRoot): string {
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

  tryAcquire(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      fs.mkdirSync(this.lockPath);
      return true;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "EEXIST") {
        logger.warn("failed to acquire file lock", {
          error,
          path: this.lockPath,
        });
      }
      return false;
    }
  }

  /**
   * Acquire the lock with exponential backoff (async, non-blocking).
   * Returns true if acquired, false if timeout.
   */
  async acquire(options: { maxWaitMs?: number } = {}): Promise<boolean> {
    const start = Date.now();
    const maxWaitMs = Math.max(0, options.maxWaitMs ?? LOCK_MAX_WAIT_MS);
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
      }

      // Check timeout
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) return false;

      // Non-blocking exponential backoff wait
      const sleepTime = Math.min(backoff, maxWaitMs - elapsed);
      await sleep(sleepTime);
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
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
  options: { maxWaitMs?: number } = {},
): Promise<T | undefined> {
  const lock = new FileLock(targetPath);
  if (!(await lock.acquire(options))) return undefined;
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
