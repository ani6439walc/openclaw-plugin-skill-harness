import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  batchUpsertSkillUsage,
  normalizeSkillIndexName,
  recordSkillUsageToStateDb,
  resolveCoreSkillTelemetrySource,
} from "./state-usage.js";

function setupTestStateDb(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-usage-test-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "openclaw.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE skill_usage (
      skill_file TEXT NOT NULL PRIMARY KEY,
      skill_key TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_source TEXT NOT NULL,
      first_used_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER NOT NULL,
      use_count INTEGER NOT NULL,
      last_agent_id TEXT
    ) STRICT;
  `);
  db.close();

  return {
    dir,
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("state-usage", () => {
  describe("normalizeSkillIndexName", () => {
    it("normalizes mixed-case and symbols to hyphenated key", () => {
      expect(normalizeSkillIndexName("My_Skill Name/v1")).toBe("my-skill-name-v1");
      expect(normalizeSkillIndexName("  --test-- ")).toBe("test");
      expect(normalizeSkillIndexName("simple-skill")).toBe("simple-skill");
    });
  });

  describe("resolveCoreSkillTelemetrySource", () => {
    it("maps sources to core categories", () => {
      expect(resolveCoreSkillTelemetrySource("bundled")).toBe("bundled");
      expect(resolveCoreSkillTelemetrySource("openclaw-bundled")).toBe("bundled");
      expect(resolveCoreSkillTelemetrySource("workspace")).toBe("workspace");
      expect(resolveCoreSkillTelemetrySource("workshop")).toBe("workspace");
      expect(resolveCoreSkillTelemetrySource("managed")).toBe("workspace");
      expect(resolveCoreSkillTelemetrySource("plugin")).toBe("workspace");
      expect(resolveCoreSkillTelemetrySource("custom")).toBe("unknown");
      expect(resolveCoreSkillTelemetrySource(undefined)).toBe("unknown");
    });
  });

  describe("recordSkillUsageToStateDb", () => {
    it("inserts and increments skill usage safely in state db", () => {
      const { dir, dbPath, cleanup } = setupTestStateDb();
      try {
        const mockApi = {
          runtime: {
            state: {
              resolveStateDir: () => dir,
            },
          },
        } as any;

        const skillFile = path.join(dir, "workspace", "skills", "test-skill", "SKILL.md");

        recordSkillUsageToStateDb({
          api: mockApi,
          agentId: "main",
          skillFile,
          skillName: "Test Skill",
          skillSource: "workspace",
          nowMs: 1000,
        });

        const db = new DatabaseSync(dbPath);
        let rows = db.prepare("SELECT * FROM skill_usage").all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          skill_file: skillFile,
          skill_key: "test-skill",
          skill_name: "Test Skill",
          skill_source: "workspace",
          first_used_at_ms: 1000,
          last_used_at_ms: 1000,
          use_count: 1,
          last_agent_id: "main",
        });

        // Record a second time with later timestamp
        recordSkillUsageToStateDb({
          api: mockApi,
          agentId: "restricted",
          skillFile,
          skillName: "Test Skill",
          skillSource: "workspace",
          nowMs: 2500,
        });

        rows = db.prepare("SELECT * FROM skill_usage").all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          skill_file: skillFile,
          skill_key: "test-skill",
          first_used_at_ms: 1000,
          last_used_at_ms: 2500,
          use_count: 2,
          last_agent_id: "restricted",
        });
        db.close();
      } finally {
        cleanup();
      }
    });

    it("fails silently when database does not exist or paths are invalid", () => {
      expect(() => {
        recordSkillUsageToStateDb({
          skillFile: "",
          skillName: "",
        });
      }).not.toThrow();

      expect(() => {
        recordSkillUsageToStateDb({
          skillFile: "relative/path/SKILL.md",
          skillName: "test",
        });
      }).not.toThrow();
    });
  });

  describe("batchUpsertSkillUsage", () => {
    it("idempotently batch-upserts historical skill usage", () => {
      const { dir, dbPath, cleanup } = setupTestStateDb();
      try {
        const file1 = path.join(dir, "skills", "s1", "SKILL.md");
        const file2 = path.join(dir, "skills", "s2", "SKILL.md");

        const entries = [
          {
            skillFile: file1,
            skillName: "Skill One",
            skillSource: "workshop",
            firstUsedAtMs: 1000,
            lastUsedAtMs: 5000,
            useCount: 10,
            lastAgentId: "main",
          },
          {
            skillFile: file2,
            skillName: "Skill Two",
            skillSource: "workspace",
            firstUsedAtMs: 2000,
            lastUsedAtMs: 6000,
            useCount: 5,
            lastAgentId: "restricted",
          },
        ];

        const res1 = batchUpsertSkillUsage(dbPath, entries);
        expect(res1).toEqual({ inserted: 2, errors: 0 });

        const db = new DatabaseSync(dbPath);
        let rows = db.prepare("SELECT * FROM skill_usage ORDER BY skill_key ASC").all() as any[];
        expect(rows).toHaveLength(2);
        expect(rows[0].use_count).toBe(10);
        expect(rows[1].use_count).toBe(5);

        // Run again with smaller count - must stay max (idempotent)
        const res2 = batchUpsertSkillUsage(dbPath, [
          {
            skillFile: file1,
            skillName: "Skill One",
            skillSource: "workshop",
            firstUsedAtMs: 500,
            lastUsedAtMs: 7000,
            useCount: 3,
            lastAgentId: "main",
          },
        ]);
        expect(res2).toEqual({ inserted: 1, errors: 0 });

        rows = db.prepare("SELECT * FROM skill_usage WHERE skill_key = 'skill-one'").all() as any[];
        expect(rows[0].use_count).toBe(10); // remains 10 (max)
        expect(rows[0].first_used_at_ms).toBe(500); // expanded min
        expect(rows[0].last_used_at_ms).toBe(7000); // expanded max
        db.close();
      } finally {
        cleanup();
      }
    });
  });
});

