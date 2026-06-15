import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
