#!/usr/bin/env node
/**
 * Backfills skill usage from skill-harness sessions and stats into openclaw.sqlite skill_usage table.
 * Idempotent: use_count uses max(existing, backfilled), and timestamps use min/max bounds.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function normalizeSkillIndexName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveCoreSkillTelemetrySource(source) {
  if (!source) return "unknown";
  if (
    source === "bundled" ||
    source === "openclaw-bundled" ||
    source === "openclaw-custodian"
  ) {
    return "bundled";
  }
  return "workspace";
}

function findSkillFiles(stateDir) {
  const checkRoots = [
    { root: path.join(stateDir, "workspace", "skills"), source: "workspace" },
    { root: path.join(stateDir, "skills"), source: "managed" },
    { root: path.join(stateDir, "external-skills"), source: "shared" },
    { root: path.join(stateDir, "plugin-skills"), source: "plugin" },
    { root: path.join(stateDir, "npm", "projects"), source: "plugin" },
    { root: "/home/wei/.npm-global/lib/node_modules/openclaw/skills", source: "bundled" },
    { root: "/home/wei/.npm-global/lib/node_modules/openclaw/dist/extensions", source: "bundled" },
  ];

  // Also include workshop roots per agent
  const agentsDir = path.join(stateDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const agentId of fs.readdirSync(agentsDir)) {
      const ws = path.join(agentsDir, agentId, "agent", "workshop-skills");
      if (fs.existsSync(ws)) {
        checkRoots.unshift({ root: ws, source: "workshop", agentId });
      }
    }
  }

  const map = new Map(); // key: sname.toLowerCase() -> { file, source, agentId }

  function walk(dir, source, agentId, depth = 0) {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if this dir has a SKILL.md
    const hasSkill = entries.some((e) => e.isFile() && e.name === "SKILL.md");
    if (hasSkill) {
      const skillPath = path.join(dir, "SKILL.md");
      let sname = path.basename(dir);
      try {
        const content = fs.readFileSync(skillPath, "utf-8");
        for (const line of content.split("\n").slice(0, 20)) {
          if (line.startsWith("name:")) {
            const cand = line.split(":", 2)[1].trim().replace(/^["']|["']$/g, "");
            if (cand) {
              sname = cand;
              break;
            }
          }
        }
      } catch {
        // ignore
      }

      const key = sname.trim().toLowerCase();
      // First root in checkRoots has precedence
      if (!map.has(key)) {
        map.set(key, {
          file: path.resolve(skillPath),
          source,
          agentId,
          name: sname,
        });
      }
      return; // Stop descending under an existing skill root
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        walk(path.join(dir, entry.name), source, agentId, depth + 1);
      }
    }
  }

  for (const { root, source, agentId } of checkRoots) {
    if (fs.existsSync(root)) {
      walk(root, source, agentId);
    }
  }

  return map;
}

export function runBackfill(options = {}) {
  const stateDir = options.stateDir ?? "/home/wei/.openclaw";
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  const sessionsDir = path.join(stateDir, "plugins", "skill-harness", "sessions");
  const statsFile = path.join(stateDir, "plugins", "skill-harness", "stats.json");

  console.log(`[Backfill] State dir: ${stateDir}`);
  console.log(`[Backfill] Database: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }

  // 1. Resolve skill file locations
  const skillMap = findSkillFiles(stateDir);
  console.log(`[Backfill] Discovered ${skillMap.size} available skills across roots.`);

  // 2. Extract historical views from sessions
  const usageByName = new Map(); // name.toLowerCase() -> { firstMs, lastMs, count, agentId, origName }

  if (fs.existsSync(sessionsDir)) {
    const sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    console.log(`[Backfill] Scanning ${sessionFiles.length} session files...`);

    for (const sf of sessionFiles) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(sessionsDir, sf), "utf-8"));
      } catch {
        continue;
      }
      const agentId = data.agentId || "main";
      const turns = (data.current ? [data.current] : []).concat(data.history || []);

      for (const turn of turns) {
        if (!turn) continue;
        const tsStr = turn.timestamps?.end || turn.timestamps?.start;
        if (!tsStr) continue;
        const tsMs = new Date(tsStr).getTime();
        if (Number.isNaN(tsMs)) continue;

        for (const tc of turn.toolCalls || []) {
          if (tc.name === "skill_view" && tc.success !== false) {
            const sname = tc.params?.name;
            if (!sname || typeof sname !== "string") continue;
            const key = sname.trim().toLowerCase();

            let entry = usageByName.get(key);
            if (!entry) {
              entry = {
                firstMs: tsMs,
                lastMs: tsMs,
                count: 0,
                agentId,
                origName: sname,
              };
              usageByName.set(key, entry);
            }
            entry.count += 1;
            if (tsMs < entry.firstMs) entry.firstMs = tsMs;
            if (tsMs >= entry.lastMs) {
              entry.lastMs = tsMs;
              entry.agentId = agentId;
            }
          }
        }
      }
    }
  }

  // 3. Incorporate stats.json for older records
  if (fs.existsSync(statsFile)) {
    try {
      const stats = JSON.parse(fs.readFileSync(statsFile, "utf-8"));
      const skills = stats.skills || {};
      for (const [sname, sdata] of Object.entries(skills)) {
        if (!sdata || typeof sdata !== "object") continue;
        const count = sdata.usageTurns || 0;
        const lastUsedStr = sdata.lastUsedAt;
        if (count <= 0 && !lastUsedStr) continue;

        const key = sname.trim().toLowerCase();
        let entry = usageByName.get(key);
        const lastUsedMs = lastUsedStr ? new Date(lastUsedStr).getTime() : NaN;

        if (!entry) {
          if (!Number.isNaN(lastUsedMs)) {
            entry = {
              firstMs: lastUsedMs,
              lastMs: lastUsedMs,
              count,
              agentId: "main",
              origName: sname,
            };
            usageByName.set(key, entry);
          }
        } else {
          if (!Number.isNaN(lastUsedMs)) {
            if (lastUsedMs < entry.firstMs) entry.firstMs = lastUsedMs;
            if (lastUsedMs > entry.lastMs) entry.lastMs = lastUsedMs;
          }
          if (count > entry.count) entry.count = count;
        }
      }
    } catch (err) {
      console.warn(`[Backfill] Failed to parse stats.json: ${err.message}`);
    }
  }

  console.log(`[Backfill] Found historical usage for ${usageByName.size} skills.`);

  // 4. Upsert into openclaw.sqlite
  const db = new DatabaseSync(dbPath);
  let upsertedCount = 0;
  let skippedNoFile = 0;

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

    for (const [key, usage] of usageByName.entries()) {
      const resolved = skillMap.get(key);
      if (!resolved || !fs.existsSync(resolved.file)) {
        skippedNoFile += 1;
        continue;
      }

      const skillKey = normalizeSkillIndexName(usage.origName);
      const skillSource = resolveCoreSkillTelemetrySource(resolved.source);

      stmt.run(
        resolved.file,
        skillKey,
        resolved.name || usage.origName,
        skillSource,
        usage.firstMs,
        usage.lastMs,
        usage.count,
        usage.agentId || resolved.agentId || "main",
      );
      upsertedCount += 1;
    }

    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    db.close();
  }

  console.log(`[Backfill] Successfully upserted: ${upsertedCount} skills (skipped ${skippedNoFile} without live file).`);
  return { upsertedCount, skippedNoFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  runBackfill();
}
