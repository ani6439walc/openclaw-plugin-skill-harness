import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../api.js";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveStateDirFromApi } from "../file-utils.js";

/**
 * Normalizes a skill name to standard skill_key index format (matching OpenClaw core).
 */
export function normalizeSkillIndexName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Maps skill source string to OpenClaw core's telemetry source value.
 * Core stores "bundled" or "workspace" (or "unknown").
 */
export function resolveCoreSkillTelemetrySource(
  source?: string,
): "bundled" | "workspace" | "unknown" {
  if (!source) return "unknown";
  if (
    source === "bundled" ||
    source === "openclaw-bundled" ||
    source === "openclaw-custodian"
  ) {
    return "bundled";
  }
  if (
    source === "workspace" ||
    source === "workshop" ||
    source === "managed" ||
    source === "shared" ||
    source === "project-agent" ||
    source === "personal-agent" ||
    source === "plugin" ||
    source.startsWith("openclaw-") ||
    source.startsWith("agents-skills-")
  ) {
    return "workspace";
  }
  return "unknown";
}

export interface RecordSkillUsageParams {
  api?: Partial<OpenClawPluginApi>;
  agentId?: string;
  skillFile: string;
  skillName: string;
  skillSource?: string;
  nowMs?: number;
  useCount?: number;
}

export interface BatchSkillUsageEntry {
  skillFile: string;
  skillName: string;
  skillSource?: string;
  firstUsedAtMs: number;
  lastUsedAtMs: number;
  useCount: number;
  lastAgentId?: string;
}

/**
 * Records or increments skill usage directly into OpenClaw state database's skill_usage table.
 * Fails open: any database error is logged as a warning and never propagates to the caller.
 */
export function recordSkillUsageToStateDb(
  params: RecordSkillUsageParams,
): void {
  try {
    const rawSkillFile = params.skillFile?.trim();
    if (!rawSkillFile || !path.isAbsolute(rawSkillFile)) return;

    const skillKey = normalizeSkillIndexName(params.skillName);
    if (!skillKey) return;

    const stateDir = resolveStateDirFromApi(params.api, process.env);
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    if (!fs.existsSync(dbPath)) return;

    const canonicalFile = path.resolve(rawSkillFile);
    const skillSource = resolveCoreSkillTelemetrySource(params.skillSource);
    const ts = params.nowMs ?? Date.now();
    const count = params.useCount ?? 1;
    const agentId = params.agentId ?? null;

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      const stmt = db.prepare(`
        INSERT INTO skill_usage (
          skill_file, skill_key, skill_name, skill_source,
          first_used_at_ms, last_used_at_ms, use_count, last_agent_id
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?
        ) ON CONFLICT(skill_file) DO UPDATE SET
          skill_key = excluded.skill_key,
          skill_name = excluded.skill_name,
          skill_source = excluded.skill_source,
          first_used_at_ms = min(skill_usage.first_used_at_ms, excluded.first_used_at_ms),
          last_used_at_ms = max(skill_usage.last_used_at_ms, excluded.last_used_at_ms),
          use_count = skill_usage.use_count + excluded.use_count,
          last_agent_id = CASE WHEN skill_usage.last_used_at_ms <= excluded.last_used_at_ms THEN excluded.last_agent_id ELSE skill_usage.last_agent_id END
      `);
      stmt.run(
        canonicalFile,
        skillKey,
        params.skillName,
        skillSource,
        ts,
        ts,
        count,
        agentId,
      );
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn("failed to record skill usage to state db", {
      error: error instanceof Error ? error.message : String(error),
      skillName: params.skillName,
    });
  }
}

/**
 * Idempotently backfills skill usage entries into the database.
 * Sets use_count = max(existing, backfill) and expands [first_used_at_ms, last_used_at_ms].
 */
export function batchUpsertSkillUsage(
  dbPath: string,
  entries: readonly BatchSkillUsageEntry[],
): { inserted: number; errors: number } {
  let inserted = 0;
  let errors = 0;
  if (!fs.existsSync(dbPath) || entries.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000;");
    const stmt = db.prepare(`
      INSERT INTO skill_usage (
        skill_file, skill_key, skill_name, skill_source,
        first_used_at_ms, last_used_at_ms, use_count, last_agent_id
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?
      ) ON CONFLICT(skill_file) DO UPDATE SET
        skill_key = excluded.skill_key,
        skill_name = excluded.skill_name,
        skill_source = excluded.skill_source,
        first_used_at_ms = min(skill_usage.first_used_at_ms, excluded.first_used_at_ms),
        last_used_at_ms = max(skill_usage.last_used_at_ms, excluded.last_used_at_ms),
        use_count = max(skill_usage.use_count, excluded.use_count),
        last_agent_id = CASE WHEN skill_usage.last_used_at_ms <= excluded.last_used_at_ms THEN excluded.last_agent_id ELSE skill_usage.last_agent_id END
    `);

    db.exec("BEGIN TRANSACTION;");
    for (const entry of entries) {
      try {
        const canonicalFile = path.resolve(entry.skillFile.trim());
        const skillKey = normalizeSkillIndexName(entry.skillName);
        if (!skillKey || !path.isAbsolute(canonicalFile)) continue;
        const skillSource = resolveCoreSkillTelemetrySource(entry.skillSource);
        stmt.run(
          canonicalFile,
          skillKey,
          entry.skillName,
          skillSource,
          entry.firstUsedAtMs,
          entry.lastUsedAtMs,
          entry.useCount,
          entry.lastAgentId ?? null,
        );
        inserted += 1;
      } catch (err) {
        errors += 1;
        logger.warn("failed to batch upsert skill usage entry", {
          skillName: entry.skillName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore rollback failure
    }
    logger.warn("batch upsert transaction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }

  return { inserted, errors };
}
