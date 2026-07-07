import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionTracker } from "./session-tracker.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("SessionTracker", () => {
  let tempDir: string;
  let tracker: SessionTracker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-tracker-test-"));
    tracker = SessionTracker.create(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("create", () => {
    it("should return a shared instance for the same plugin root", () => {
      const tracker1 = SessionTracker.create(tempDir);
      const tracker2 = SessionTracker.create(tempDir);

      expect(tracker1).toBeInstanceOf(SessionTracker);
      expect(tracker2).toBeInstanceOf(SessionTracker);
      expect(tracker1).toBe(tracker2);
    });

    it("should return different instances for different plugin roots", () => {
      const otherDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "session-tracker-other-"),
      );
      try {
        const tracker1 = SessionTracker.create(tempDir);
        const tracker2 = SessionTracker.create(otherDir);

        expect(tracker1).toBeInstanceOf(SessionTracker);
        expect(tracker2).toBeInstanceOf(SessionTracker);
        expect(tracker1).not.toBe(tracker2);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it("should share in-memory state across repeated creates for the same plugin root", () => {
      const tracker1 = SessionTracker.create(tempDir);
      const tracker2 = SessionTracker.create(tempDir);

      tracker1.record("shared-session", {
        sessionKey: "agent:main:direct:123",
        current: {
          input: "first turn",
          intent: {
            result: {
              intent: "chat",
              reason: "test",
              confidence: 0.9,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-07T11:00:00.000Z" },
        },
      });

      expect(
        tracker2.resolveCurrentSessionId({
          sessionKey: "agent:main:direct:123",
        }),
      ).toBe("shared-session");
    });

    it("should create tracker with correct plugin root", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });

      const customTracker = SessionTracker.create(customDir);
      expect(customTracker).toBeInstanceOf(SessionTracker);
    });

    it("should load existing session files from sessions folder", () => {
      // Create sessions directory with a test file
      const sessionsDir = path.join(tempDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });

      const testSession = {
        sessionId: "existing-session-123",
        current: {
          input: "existing test prompt",
          intent: { result: { intentions: [] } },
        },
      };
      fs.writeFileSync(
        path.join(sessionsDir, "existing-session-123.json"),
        JSON.stringify(testSession),
      );

      // Create new tracker - should load existing session
      const loadedTracker = SessionTracker.create(tempDir);
      expect(loadedTracker.hasIntentData("existing-session-123")).toBe(true);
    });

    it("migrates legacy topic metadata and missing domain on load", () => {
      const sessionsDir = path.join(tempDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const filePath = path.join(sessionsDir, "legacy-topic.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          sessionId: "legacy-topic",
          history: [
            {
              input: "same topic",
              intent: {
                result: {
                  intent: "chat",
                  reason: "same",
                  topicChanged: false,
                  topicChangeReason: "same-topic",
                  confidence: 0.8,
                  complexity: "low",
                },
              },
            },
          ],
          current: {
            input: "changed topic",
            intent: {
              result: {
                intent: "coding",
                reason: "changed",
                topicChanged: true,
                confidence: 0.9,
                complexity: "medium",
              },
            },
          },
        }),
      );

      const loadedTracker = SessionTracker.create(tempDir);
      const migrated = JSON.parse(fs.readFileSync(filePath, "utf-8"));

      expect(loadedTracker.getHistoricalIntentRecords("legacy-topic")).toEqual([
        expect.objectContaining({
          input: "same topic",
          intent: "chat",
          domain: "other",
        }),
        expect.objectContaining({
          input: "changed topic",
          intent: "coding",
          domain: "other",
          topicChangeReason: "change",
        }),
      ]);
      expect(migrated.history[0].intent.result).not.toHaveProperty(
        "topicChanged",
      );
      expect(migrated.history[0].intent.result).not.toHaveProperty(
        "topicChangeReason",
      );
      expect(migrated.current.intent.result).not.toHaveProperty("topicChanged");
      expect(migrated.current.intent.result).toMatchObject({
        domain: "other",
        topicChangeReason: "change",
      });
    });

    it("migrates legacy topic reason names to short names", () => {
      const sessionsDir = path.join(tempDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const filePath = path.join(sessionsDir, "legacy-reasons.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          sessionId: "legacy-reasons",
          current: {
            input: "changed topic",
            intent: {
              result: {
                intent: "coding",
                reason: "changed",
                domain: "coding",
                topicChangeReason: "keyword-delta",
                confidence: 0.9,
                complexity: "medium",
              },
            },
          },
        }),
      );

      const loadedTracker = SessionTracker.create(tempDir);
      const migrated = JSON.parse(fs.readFileSync(filePath, "utf-8"));

      expect(
        loadedTracker.getHistoricalIntentRecords("legacy-reasons"),
      ).toEqual([expect.objectContaining({ topicChangeReason: "shift" })]);
      expect(migrated.current.intent.result).toMatchObject({
        topicChangeReason: "shift",
      });
    });

    it("should skip corrupted JSON files and log warning", () => {
      const sessionsDir = path.join(tempDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Create valid file
      const validSession = {
        sessionId: "valid-session",
        current: { intent: {} },
      };
      fs.writeFileSync(
        path.join(sessionsDir, "valid-session.json"),
        JSON.stringify(validSession),
      );

      // Create corrupted file
      fs.writeFileSync(
        path.join(sessionsDir, "corrupted.json"),
        "this is not valid json {{{",
      );

      // Create new tracker - should load valid file, skip corrupted
      const loadedTracker = SessionTracker.create(tempDir);
      expect(loadedTracker.hasIntentData("valid-session")).toBe(false); // no intent result
    });

    it("should handle missing sessions folder gracefully", () => {
      // No sessions folder created
      const trackerNoSessions = SessionTracker.create(tempDir);
      expect(trackerNoSessions).toBeInstanceOf(SessionTracker);
    });

    it.each(["stats.json", "evolution.json"])(
      "treats legacy %s files in sessions as ordinary session JSON",
      (legacyFilename) => {
        const sessionsDir = path.join(tempDir, "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessionsDir, legacyFilename),
          JSON.stringify({
            sessionId: "legacy-session",
            current: { intent: { result: { intent: "fake" } } },
          }),
        );

        const loadedTracker = SessionTracker.create(tempDir);
        expect(loadedTracker.hasIntentData("legacy-session")).toBe(true);
      },
    );
  });

  describe("record", () => {
    it("should update session data with record()", () => {
      expect(() =>
        tracker.record("test-session-123", {
          agentId: "test-agent",
          current: { input: "test prompt", intent: {} },
        }),
      ).not.toThrow();
    });

    it("should skip recording when sessionId is empty", () => {
      expect(() =>
        tracker.record("", {
          current: { input: "test prompt", intent: {} },
        }),
      ).not.toThrow();
    });

    it("should skip recording when sessionId is undefined", () => {
      expect(() =>
        tracker.record(
          undefined as any,
          {
            current: { input: "test prompt", intent: {} },
          } as any,
        ),
      ).not.toThrow();
    });

    it("should append toolCalls to array (not overwrite)", () => {
      tracker.record("test-session-123", {
        current: {
          intent: {},
          toolCalls: [
            { name: "tool1", params: { key: "value1" }, durationMs: 100 },
          ],
        },
      });
      tracker.record("test-session-123", {
        current: {
          intent: {},
          toolCalls: [
            { name: "tool2", params: { key: "value2" }, durationMs: 200 },
          ],
        },
      });
      expect(() => tracker.write("test-session-123")).not.toThrow();
    });

    it("tracks distinct skills read through exec commands ending with SKILL.md", () => {
      tracker.record("test-session-123", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "exec",
              params: {
                command:
                  "sed -n '1,220p' /home/ani/.openclaw/skills/treemd/SKILL.md",
              },
              result: "---\nname: treemd\ndescription: Tree docs.\n---\n",
            },
            {
              name: "exec",
              params: {
                command: "treemd -l skills/gcp-cert-exam/SKILL.md",
              },
              result: "# gcp-cert-exam",
            },
            {
              name: "exec",
              params: {
                command: "treemd -l skills/gcp-cert-exam/SKILL.md",
              },
              result: "# gcp-cert-exam again",
            },
          ],
        },
      });

      tracker.write("test-session-123");

      const saved = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, "sessions", "test-session-123.json"),
          "utf-8",
        ),
      );
      expect(saved.current.skillsUsed).toEqual([
        {
          name: "treemd",
          path: "/home/ani/.openclaw/skills/treemd/SKILL.md",
          description: "Tree docs.",
        },
        {
          name: "gcp-cert-exam",
          path: "skills/gcp-cert-exam/SKILL.md",
        },
      ]);
    });

    it("should handle multiple record calls", () => {
      tracker.record("test-session-123", { agentId: "agent1" });
      tracker.record("test-session-123", { agentId: "agent2" });

      expect(() => tracker.write("test-session-123")).not.toThrow();
    });

    it("preserves prompt-build intent trigger metadata", () => {
      tracker.record("test-session-123", {
        current: {
          input: "read a skill",
          intent: {
            trigger: "classifier",
            result: {
              intent: "tool-reference",
              reason: "User wants to read a skill",
              domain: "agent-ops",
              confidence: 0.9,
              complexity: "low",
            },
            instructionText: "Use the requested skill.",
          },
        },
      });

      tracker.write("test-session-123");

      const saved = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, "sessions", "test-session-123.json"),
          "utf-8",
        ),
      );
      expect(saved.current.intent).toMatchObject({
        trigger: "classifier",
        instructionText: "Use the requested skill.",
        result: { intent: "tool-reference" },
      });
    });

    it("resolves the latest current session by session key", () => {
      tracker.record("old-session", {
        sessionKey: "agent:main:discord:channel:1490722656197152878",
        current: {
          intent: {
            result: {
              intent: "skill-lifecycle",
              reason: "test",
              domain: "agent-ops",
              confidence: 0.9,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-06T15:33:50.743Z" },
        },
      });
      tracker.record("new-session", {
        sessionKey: "agent:main:discord:channel:1490722656197152878",
        current: {
          intent: {
            result: {
              intent: "skill-lifecycle",
              reason: "test",
              domain: "agent-ops",
              confidence: 0.95,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-06T15:47:27.004Z" },
        },
      });

      expect(
        tracker.resolveCurrentSessionId({
          sessionKey: "agent:main:discord:channel:1490722656197152878",
        }),
      ).toBe("new-session");
    });

    it("prefers the latest session-key match over a stale event session id", () => {
      tracker.record("stale-event-session", {
        sessionKey: "agent:main:discord:channel:1490722656197152878",
        current: {
          intent: {
            result: {
              intent: "skill-lifecycle",
              reason: "test",
              domain: "agent-ops",
              confidence: 0.9,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-06T15:47:27.004Z" },
        },
      });
      tracker.record("latest-prompt-session", {
        sessionKey: "agent:main:discord:channel:1490722656197152878",
        current: {
          intent: {
            result: {
              intent: "skill-lifecycle",
              reason: "test",
              domain: "agent-ops",
              confidence: 0.95,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-06T16:14:33.056Z" },
        },
      });

      expect(
        tracker.resolveCurrentSessionId({
          sessionId: "stale-event-session",
          sessionKey: "agent:main:discord:channel:1490722656197152878",
        }),
      ).toBe("latest-prompt-session");
    });
  });

  describe("write", () => {
    it("should create JSON file with correct structure", () => {
      tracker.record("test-session-123", {
        agentId: "test-agent",
        current: { input: "test prompt", intent: {} },
      });
      tracker.write("test-session-123");

      const sessionsDir = path.join(tempDir, "sessions");
      expect(fs.existsSync(sessionsDir)).toBe(true);

      const files = fs.readdirSync(sessionsDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toBe("test-session-123.json");

      const filePath = path.join(sessionsDir, files[0]);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.sessionId).toBe("test-session-123");
      expect(parsed.agentId).toBe("test-agent");
      expect(parsed.current.input).toBe("test prompt");
    });

    it("should persist data to JSON file", () => {
      const startDate = new Date().toISOString();
      tracker.record("persist-test-456", {
        sessionKey: "test-key",
        agentId: "persist-agent",
        current: {
          input: "persist prompt",
          intent: {
            input: [{ role: "user", text: "hello" }],
            result: {
              reason: "test reasoning",
              intent: "test-intent",
              confidence: 0.9,
              complexity: "low",
            },
          },
          toolCalls: [
            {
              name: "testTool",
              params: { arg: "value" },
              result: "success",
              durationMs: 150,
            },
          ],
          result: "test response",
          timestamps: {
            start: startDate,
            end: new Date().toISOString(),
          },
        },
      });
      tracker.write("persist-test-456");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const filePath = path.join(sessionsDir, files[0]);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.sessionId).toBe("persist-test-456");
      expect(parsed.sessionKey).toBe("test-key");
      expect(parsed.agentId).toBe("persist-agent");
      expect(parsed.current.input).toBe("persist prompt");
      expect(parsed.current.intent.input).toEqual([
        { role: "user", text: "hello" },
      ]);
      expect(parsed.current.intent.result).toEqual({
        reason: "test reasoning",
        intent: "test-intent",
        confidence: 0.9,
        complexity: "low",
      });
      expect(parsed.current.toolCalls).toHaveLength(1);
      expect(parsed.current.toolCalls[0].name).toBe("testTool");
      expect(parsed.current.result).toBe("test response");
      expect(parsed.current.timestamps.start).toBe(startDate);
    });

    it("should handle write without prior record calls", () => {
      tracker.record("no-record", {});
      expect(() => tracker.write("no-record")).not.toThrow();
    });

    it("should overwrite file for same sessionId (not create new files)", () => {
      tracker.record("overwrite-test", {
        current: { input: "first prompt", intent: {} },
      });
      tracker.write("overwrite-test");

      tracker.record("overwrite-test", {
        current: { input: "second prompt", intent: {} },
      });
      tracker.write("overwrite-test");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      expect(files.length).toBe(1);
      expect(files[0]).toBe("overwrite-test.json");

      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.current.input).toBe("second prompt");
    });

    it("should create sessions directory if it does not exist", () => {
      tracker.record("test-789", {});

      const sessionsDir = path.join(tempDir, "sessions");
      expect(fs.existsSync(sessionsDir)).toBe(false);

      tracker.write("test-789");

      expect(fs.existsSync(sessionsDir)).toBe(true);
    });

    it.each(["stats", "evolution"])(
      "can write %s.json as ordinary session data",
      (sessionId) => {
        const sessionsDir = path.join(tempDir, "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionPath, "old");

        tracker.record(sessionId, { current: { input: "overwrite" } });
        tracker.write(sessionId);

        expect(JSON.parse(fs.readFileSync(sessionPath, "utf-8"))).toMatchObject(
          {
            sessionId,
            current: { input: "overwrite" },
          },
        );
      },
    );

    it("should handle toolCalls array persistence", () => {
      tracker.record("tool-persist-test", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "tool1",
              params: { key: "value1" },
              durationMs: 100,
            },
          ],
        },
      });
      tracker.write("tool-persist-test");

      let content = fs.readFileSync(
        path.join(tempDir, "sessions", "tool-persist-test.json"),
        "utf-8",
      );
      let parsed = JSON.parse(content);
      expect(parsed.current.toolCalls).toEqual([
        { name: "tool1", params: { key: "value1" }, durationMs: 100 },
      ]);

      tracker.record("tool-persist-test", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "tool2",
              params: { key: "value2" },
              durationMs: 200,
            },
          ],
        },
      });
      tracker.write("tool-persist-test");

      content = fs.readFileSync(
        path.join(tempDir, "sessions", "tool-persist-test.json"),
        "utf-8",
      );
      parsed = JSON.parse(content);
      expect(parsed.current.toolCalls).toEqual([
        { name: "tool1", params: { key: "value1" }, durationMs: 100 },
        { name: "tool2", params: { key: "value2" }, durationMs: 200 },
      ]);
    });

    it("should merge timestamps across multiple record calls", () => {
      const start = new Date().toISOString();
      tracker.record("timestamp-test", {
        current: {
          intent: {},
          timestamps: { start },
        },
      });

      const end = new Date().toISOString();
      tracker.record("timestamp-test", {
        current: {
          intent: {},
          timestamps: { end },
        },
      });
      tracker.write("timestamp-test");

      const content = fs.readFileSync(
        path.join(tempDir, "sessions", "timestamp-test.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.timestamps.start).toBe(start);
      expect(parsed.current.timestamps.end).toBe(end);
    });
  });

  describe("cleanup", () => {
    it("should remove session data and its persisted JSON file", () => {
      tracker.record("cleanup-test", {
        current: {
          intent: {
            result: {
              intent: "test",
              reason: "test reason",
              confidence: 0.9,
              complexity: "low",
            },
          },
        },
      });
      tracker.write("cleanup-test");

      tracker.cleanup("cleanup-test", { deleteFile: true });

      expect(tracker.hasIntentData("cleanup-test")).toBe(false);
      expect(
        fs.existsSync(path.join(tempDir, "sessions", "cleanup-test.json")),
      ).toBe(false);
    });

    it("should keep session data in memory when preserving its persisted JSON file", () => {
      tracker.record("preserve-test", {
        current: {
          intent: {
            result: {
              intent: "test",
              reason: "test reason",
              confidence: 0.9,
              complexity: "low",
            },
          },
        },
      });
      tracker.write("preserve-test");

      tracker.cleanup("preserve-test", { deleteFile: false });

      expect(tracker.hasIntentData("preserve-test")).toBe(true);
      expect(
        fs.existsSync(path.join(tempDir, "sessions", "preserve-test.json")),
      ).toBe(true);
    });

    it("should retain history across preserved session_end cleanup", () => {
      tracker.record("preserve-history-test", {
        current: {
          input: "first turn",
          intent: {
            result: {
              intent: "chat",
              reason: "first turn",
              confidence: 0.9,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-07T10:00:00.000Z" },
        },
      });
      tracker.write("preserve-history-test");

      tracker.cleanup("preserve-history-test", { deleteFile: false });
      tracker.rotate("preserve-history-test");
      tracker.record("preserve-history-test", {
        current: {
          input: "second turn",
          intent: {
            result: {
              intent: "chat",
              reason: "second turn",
              confidence: 0.9,
              complexity: "low",
            },
          },
          timestamps: { start: "2026-07-07T10:01:00.000Z" },
        },
      });
      tracker.write("preserve-history-test");

      const parsed = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, "sessions", "preserve-history-test.json"),
          "utf-8",
        ),
      );
      expect(parsed.history).toHaveLength(1);
      expect(parsed.history[0].input).toBe("first turn");
      expect(parsed.current.input).toBe("second turn");
    });

    it("should be idempotent when the session or file does not exist", () => {
      expect(() =>
        tracker.cleanup("missing-session", { deleteFile: true }),
      ).not.toThrow();
      expect(() =>
        tracker.cleanup("missing-session", { deleteFile: true }),
      ).not.toThrow();
    });

    it("should fail open when the persisted session path cannot be deleted", () => {
      const invalidSessionPath = path.join(
        tempDir,
        "sessions",
        "directory-session.json",
      );
      fs.mkdirSync(invalidSessionPath, { recursive: true });

      expect(() =>
        tracker.cleanup("directory-session", { deleteFile: true }),
      ).not.toThrow();
      expect(fs.existsSync(invalidSessionPath)).toBe(true);
    });

    it("should never delete files outside the sessions directory", () => {
      const outsideFile = path.join(tempDir, "outside.json");
      fs.writeFileSync(outsideFile, "keep");

      expect(() =>
        tracker.cleanup("../outside", { deleteFile: true }),
      ).not.toThrow();
      expect(fs.existsSync(outsideFile)).toBe(true);
    });

    it.each(["stats", "evolution"])(
      "can delete %s.json as ordinary session data",
      (sessionId) => {
        const sessionsDir = path.join(tempDir, "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionPath, "old");

        tracker.cleanup(sessionId, { deleteFile: true });

        expect(fs.existsSync(sessionPath)).toBe(false);
      },
    );

    it("should delete expired session JSON and memory only", () => {
      const nowMs = Date.UTC(2026, 5, 11);
      const dayMs = 24 * 60 * 60 * 1000;
      const sessionsDir = path.join(tempDir, "sessions");

      for (const sessionId of ["expired", "boundary", "fresh"]) {
        tracker.record(sessionId, {
          current: {
            intent: {
              result: {
                intent: sessionId,
                reason: "test",
                confidence: 1,
                complexity: "low",
              },
            },
          },
        });
        tracker.write(sessionId);
      }

      const expiredFile = path.join(sessionsDir, "expired.json");
      const boundaryFile = path.join(sessionsDir, "boundary.json");
      const freshFile = path.join(sessionsDir, "fresh.json");
      const ignoredFile = path.join(sessionsDir, "ignored.txt");
      const nestedDir = path.join(sessionsDir, "nested");
      const nestedFile = path.join(nestedDir, "expired.json");
      fs.writeFileSync(ignoredFile, "{}");
      fs.mkdirSync(nestedDir);
      fs.writeFileSync(nestedFile, "{}");

      fs.utimesSync(expiredFile, new Date(nowMs), new Date(nowMs - 15 * dayMs));
      fs.utimesSync(
        boundaryFile,
        new Date(nowMs),
        new Date(nowMs - 14 * dayMs),
      );
      fs.utimesSync(freshFile, new Date(nowMs), new Date(nowMs - dayMs));
      fs.utimesSync(ignoredFile, new Date(nowMs), new Date(nowMs - 15 * dayMs));
      fs.utimesSync(nestedFile, new Date(nowMs), new Date(nowMs - 15 * dayMs));

      expect(tracker.cleanupExpired(nowMs)).toBe(1);

      expect(fs.existsSync(expiredFile)).toBe(false);
      expect(tracker.hasIntentData("expired")).toBe(false);
      expect(fs.existsSync(boundaryFile)).toBe(true);
      expect(fs.existsSync(freshFile)).toBe(true);
      expect(fs.existsSync(ignoredFile)).toBe(true);
      expect(fs.existsSync(nestedFile)).toBe(true);
    });

    it("should safely sweep when the sessions directory is missing", () => {
      expect(tracker.cleanupExpired()).toBe(0);
    });

    it.each(["stats.json", "evolution.json"])(
      "removes expired legacy %s files left in sessions",
      (legacyFilename) => {
        const sessionsDir = path.join(tempDir, "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const legacyPath = path.join(sessionsDir, legacyFilename);
        fs.writeFileSync(legacyPath, "{}");
        fs.utimesSync(legacyPath, new Date(0), new Date(0));

        tracker.cleanupExpired(Date.now());

        expect(fs.existsSync(legacyPath)).toBe(false);
      },
    );
  });

  describe("edge cases", () => {
    it("should deduplicate skillsUsed across multiple toolCalls", () => {
      const tracker2 = SessionTracker.create(tempDir);
      tracker2.record("skill-dedup", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "read",
              params: { path: "/path/to/gemini/SKILL.md" },
              result:
                "---\nname: gemini\ndescription: Use Gemini for broad research.\n---\ncontent",
              durationMs: 100,
            },
            {
              name: "read",
              params: { path: "/path/to/gemini/SKILL.md" },
              result:
                "---\nname: gemini\ndescription: Use Gemini for broad research.\n---\ncontent",
              durationMs: 100,
            },
          ],
        },
      });
      tracker2.write("skill-dedup");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.skillsUsed).toEqual([
        {
          name: "gemini",
          path: "/path/to/gemini/SKILL.md",
          description: "Use Gemini for broad research.",
        },
      ]);
      expect(parsed.current.skillsUsed.length).toBe(1);
    });

    it("should track multiple unique skills", () => {
      const tracker3 = SessionTracker.create(tempDir);
      tracker3.record("multi-skills", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "read",
              params: { path: "/path/to/gemini/SKILL.md" },
              result:
                "---\nname: gemini\ndescription: Use Gemini for broad research.\n---\nc",
              durationMs: 100,
            },
            {
              name: "read",
              params: { path: "/path/to/frontend-ui-engineering/SKILL.md" },
              result:
                "---\nname: frontend-ui-engineering\ndescription: Build production-quality UI.\n---\nc",
              durationMs: 200,
            },
          ],
        },
      });
      tracker3.write("multi-skills");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.skillsUsed).toEqual([
        {
          name: "gemini",
          path: "/path/to/gemini/SKILL.md",
          description: "Use Gemini for broad research.",
        },
        {
          name: "frontend-ui-engineering",
          path: "/path/to/frontend-ui-engineering/SKILL.md",
          description: "Build production-quality UI.",
        },
      ]);
    });

    it("should ignore truncated SKILL.md frontmatter tool results", () => {
      const tracker5 = SessionTracker.create(tempDir);
      tracker5.record("truncated-skill-read", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "read",
              params: { path: "/path/to/skill-harness/SKILL.md" },
              result:
                '---\nname: skill-harness\ndescription: "Design, inventory, or evolve intent definitions for the skill-harness plugin. Use when creating/refining a single intent (design), bootstrapping or re-auditing \n',
              durationMs: 100,
            },
          ],
        },
      });
      tracker5.write("truncated-skill-read");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.skillsUsed).toBeUndefined();
    });

    it("should ignore non-SKILL.md read calls", () => {
      const tracker4 = SessionTracker.create(tempDir);
      tracker4.record("no-skill-read", {
        current: {
          intent: {},
          toolCalls: [
            {
              name: "read",
              params: { path: "/path/to/README.md" },
              result: "---\nname: test\n---\nc",
              durationMs: 100,
            },
          ],
        },
      });
      tracker4.write("no-skill-read");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.skillsUsed).toBeUndefined();
    });

    it("should handle session data with special characters", () => {
      tracker.record("special-chars-test", {
        current: {
          input: 'Hello "world" with \n newlines and \t tabs',
          intent: {},
          result: "Response with unicode: 你好世界 🌍",
        },
      });
      tracker.write("special-chars-test");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.input).toBe(
        'Hello "world" with \n newlines and \t tabs',
      );
      expect(parsed.current.result).toBe("Response with unicode: 你好世界 🌍");
    });

    it("should handle empty toolCalls array", () => {
      tracker.record("empty-tools-test", {
        current: { intent: {}, toolCalls: [] },
      });
      tracker.write("empty-tools-test");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.current.toolCalls).toEqual([]);
    });

    it("should handle undefined optional fields", () => {
      tracker.record("undefined-test", {});
      tracker.write("undefined-test");

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.sessionId).toBe("undefined-test");
    });
  });

  describe("hasIntentData guard", () => {
    it("should return false before any intentResult is recorded", () => {
      expect(tracker.hasIntentData("new-session")).toBe(false);
    });

    it("should return true after record with intentResult", () => {
      const tracker2 = SessionTracker.create(tempDir);
      tracker2.record("intent-session", {
        current: {
          intent: {
            result: {
              intent: "test",
              reason: "test reason",
              confidence: 0.9,
              complexity: "low",
            },
          },
        },
      });
      expect(tracker2.hasIntentData("intent-session")).toBe(true);
    });

    it("should return true for compact continuation records without intent input", () => {
      tracker.record("compact-session", {
        current: {
          input: "continue this",
          intent: {
            result: {
              intent: "coding",
              reason: "Topic unchanged; inherited previous intent",
              topicChanged: false,
              topicChangeReason: "same-topic",
              confidence: 0.8,
              complexity: "medium",
            },
          },
        },
      });

      expect(tracker.hasIntentData("compact-session")).toBe(true);
      expect(tracker.getCurrentState("compact-session")?.intent?.input).toBe(
        undefined,
      );
    });

    it("should return false after record without intentResult", () => {
      const tracker3 = SessionTracker.create(tempDir);
      tracker3.record("no-intent-session", {
        current: { input: "hello", intent: {} },
      });
      expect(tracker3.hasIntentData("no-intent-session")).toBe(false);
    });

    it("should return false for different sessionId", () => {
      const tracker4 = SessionTracker.create(tempDir);
      tracker4.record("session-a", {
        current: {
          intent: {
            result: {
              intent: "test",
              reason: "test reason",
              confidence: 0.9,
              complexity: "low",
            },
          },
        },
      });
      expect(tracker4.hasIntentData("session-a")).toBe(true);
      expect(tracker4.hasIntentData("session-b")).toBe(false);
    });
  });

  describe("getHistoricalIntentRecords", () => {
    it("should return history and current intent records in order", () => {
      tracker.record("intent-session", {
        history: [
          {
            input: "Plan the change",
            intent: {
              result: {
                intent: "PLANNING",
                reason: "test",
                keywords: ["plan", "change"],
                domain: "planning",
                topic: "plan / change",
                topicChangeReason: "shift",
                confidence: 0.8,
                complexity: "medium",
              },
            },
          },
          { input: "missing result", intent: {} },
          {
            intent: {
              result: {
                intent: "MISSING_INPUT",
                reason: "test",
                domain: "other",
                confidence: 0.8,
                complexity: "low",
              },
            },
          },
        ],
        current: {
          input: "Implement the change",
          intent: {
            result: {
              intent: "CODING",
              reason: "test",
              domain: "coding",
              confidence: 0.75,
              complexity: "medium",
            },
          },
        },
      });

      expect(tracker.getHistoricalIntentRecords("intent-session")).toEqual([
        {
          input: "Plan the change",
          intent: "PLANNING",
          domain: "planning",
          keywords: ["plan", "change"],
          topic: "plan / change",
          topicChangeReason: "shift",
          confidence: 0.8,
          complexity: "medium",
        },
        {
          input: "Implement the change",
          intent: "CODING",
          domain: "coding",
          confidence: 0.75,
          complexity: "medium",
        },
      ]);
    });

    it("should return an empty array when the session does not exist", () => {
      expect(tracker.getHistoricalIntentRecords("missing-session")).toEqual([]);
    });

    it("should preserve match topic change metadata", () => {
      tracker.record("match-session", {
        current: {
          input: "hi",
          intent: {
            result: {
              intent: "social-casual",
              reason: "Fast Path A1 keyword exact match: hi",
              keywords: ["hi"],
              domain: "chat",
              topic: "Fast-path exact match for social-casual.",
              topicChangeReason: "match",
              confidence: 1,
              complexity: "low",
            },
          },
        },
      });

      expect(tracker.getHistoricalIntentRecords("match-session")).toEqual([
        expect.objectContaining({
          input: "hi",
          intent: "social-casual",
          domain: "chat",
          keywords: ["hi"],
          topicChangeReason: "match",
        }),
      ]);
    });
  });

  describe("getCurrentState", () => {
    it("should return the current session state", () => {
      tracker.record("current-session", {
        current: {
          input: "hello",
          intent: {
            result: {
              intent: "CHAT",
              reason: "test",
              confidence: 0.9,
              complexity: "low",
            },
          },
        },
      });

      expect(tracker.getCurrentState("current-session")?.input).toBe("hello");
      expect(tracker.getCurrentState("missing-session")).toBeUndefined();
    });
  });

  describe("getReviewSnapshot", () => {
    it("returns a detached, truncated snapshot with a tracked turn number", () => {
      for (let index = 1; index <= 11; index += 1) {
        tracker.record("review-session", {
          agentId: "main",
          current: {
            input: `input-${index}-${"x".repeat(1200)}`,
            intent: {
              result: {
                intent: "CODE_REVIEW",
                reason: "test",
                confidence: 0.9,
                complexity: "medium",
              },
            },
            toolCalls: [
              {
                name: "exec",
                params: {
                  path: "/repo/src/review-subagent.ts",
                  command: `pnpm run test ${"x".repeat(600)}`,
                  urls: ["https://example.com/a", "https://example.com/b"],
                  secret: "do-not-copy",
                  content: "do-not-copy-content",
                },
                result: "do-not-copy",
                error: "e".repeat(600),
              },
            ],
            result: "r".repeat(2000),
            timestamps: {
              start: `2026-06-11T00:${String(index).padStart(2, "0")}:00.000Z`,
            },
          },
        });
        if (index < 11) tracker.rotate("review-session");
      }

      const snapshot = tracker.getReviewSnapshot("review-session");
      expect(snapshot).toMatchObject({
        sessionId: "review-session",
        agentId: "main",
        turnNumber: 11,
        eventId: "review-session:2026-06-11T00:11:00.000Z",
      });
      expect(snapshot?.recent).toHaveLength(9);
      expect(snapshot?.current.input).toHaveLength(1000);
      expect(snapshot?.current.result).toHaveLength(1500);
      expect(snapshot?.current.toolCalls?.[0]).toEqual({
        name: "exec",
        params: {
          path: "/repo/src/review-subagent.ts",
          command: `pnpm run test ${"x".repeat(486)}`,
          urls: "https://example.com/a, https://example.com/b",
        },
        error: "e".repeat(500),
      });
      expect(snapshot?.current.toolCalls?.[0].params).not.toHaveProperty(
        "secret",
      );
      expect(snapshot?.current.toolCalls?.[0].params).not.toHaveProperty(
        "content",
      );

      tracker.record("review-session", { current: { input: "changed" } });
      expect(snapshot?.current.input).not.toBe("changed");
    });

    it("skips incomplete current turns", () => {
      tracker.record("incomplete", { current: { input: "hello" } });
      expect(tracker.getReviewSnapshot("incomplete")).toBeUndefined();
    });
  });
});
