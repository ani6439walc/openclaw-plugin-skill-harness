import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionTracker, SessionData } from "./session-tracker.js";
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
    it("should return a new instance each time (not singleton)", () => {
      const tracker1 = SessionTracker.create(tempDir);
      const tracker2 = SessionTracker.create(tempDir);

      expect(tracker1).toBeInstanceOf(SessionTracker);
      expect(tracker2).toBeInstanceOf(SessionTracker);
      expect(tracker1).not.toBe(tracker2);
    });

    it("should create tracker with correct plugin root", () => {
      const customDir = path.join(tempDir, "custom");
      fs.mkdirSync(customDir, { recursive: true });

      const customTracker = SessionTracker.create(customDir);
      expect(customTracker).toBeInstanceOf(SessionTracker);
    });
  });

  describe("record", () => {
    it("should update session data with record()", () => {
      const sessionData: Partial<SessionData> = {
        sessionId: "test-session-123",
        agentId: "test-agent",
        prompt: "test prompt",
      };

      expect(() => tracker.record(sessionData)).not.toThrow();
    });

    it("should skip recording when sessionId is empty", () => {
      const sessionData: Partial<SessionData> = {
        sessionId: "",
        agentId: "test-agent",
        prompt: "test prompt",
      };

      expect(() => tracker.record(sessionData)).not.toThrow();
    });

    it("should skip recording when sessionId is undefined", () => {
      const sessionData: Partial<SessionData> = {
        agentId: "test-agent",
        prompt: "test prompt",
      };

      expect(() => tracker.record(sessionData)).not.toThrow();
    });

    it("should append toolCalls to array (not overwrite)", () => {
      const sessionData1: Partial<SessionData> = {
        sessionId: "test-session-123",
        toolCalls: [
          {
            toolName: "tool1",
            params: { key: "value1" },
            durationMs: 100,
          },
        ],
      };

      const sessionData2: Partial<SessionData> = {
        sessionId: "test-session-123",
        toolCalls: [
          {
            toolName: "tool2",
            params: { key: "value2" },
            durationMs: 200,
          },
        ],
      };

      tracker.record(sessionData1);
      tracker.record(sessionData2);
      expect(() => tracker.write()).not.toThrow();
    });

    it("should handle multiple record calls", () => {
      tracker.record({ sessionId: "test-session-123", agentId: "agent1" });
      tracker.record({ sessionId: "test-session-123", agentId: "agent2" });
      tracker.record({ sessionId: "test-session-123", success: true });

      expect(() => tracker.write()).not.toThrow();
    });
  });

  describe("write", () => {
    it("should create JSON file with correct structure", () => {
      const sessionData: Partial<SessionData> = {
        sessionId: "test-session-123",
        agentId: "test-agent",
        prompt: "test prompt",
        success: true,
      };

      tracker.record(sessionData);
      tracker.write();

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
      expect(parsed.prompt).toBe("test prompt");
      expect(parsed.success).toBe(true);
    });

    it("should persist data to JSON file", () => {
      const sessionData: Partial<SessionData> = {
        sessionId: "persist-test-456",
        sessionKey: "test-key",
        agentId: "persist-agent",
        prompt: "persist prompt",
        intentInput: [{ role: "user", text: "hello" }],
        intentResult: {
          reason: "test reasoning",
          intent: "test-intent",
          goal: "test goal",
          confidence: 0.9,
          complexity: "low",
        },
        toolCalls: [
          {
            toolName: "testTool",
            params: { arg: "value" },
            result: { success: true },
            durationMs: 150,
          },
        ],
        finalResponse: "test response",
        success: true,
        error: undefined,
        timestamps: {
          start: new Date().toISOString(),
          end: new Date().toISOString(),
        },
      };

      tracker.record(sessionData);
      tracker.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const filePath = path.join(sessionsDir, files[0]);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.sessionId).toBe("persist-test-456");
      expect(parsed.sessionKey).toBe("test-key");
      expect(parsed.agentId).toBe("persist-agent");
      expect(parsed.prompt).toBe("persist prompt");
      expect(parsed.intentInput).toEqual([{ role: "user", text: "hello" }]);
      expect(parsed.intentResult).toEqual({
        reason: "test reasoning",
        intent: "test-intent",
        goal: "test goal",
        confidence: 0.9,
        complexity: "low",
      });
      expect(parsed.toolCalls).toHaveLength(1);
      expect(parsed.toolCalls[0].toolName).toBe("testTool");
      expect(parsed.finalResponse).toBe("test response");
      expect(parsed.success).toBe(true);
      expect(parsed.timestamps).toBeDefined();
    });

    it("should handle write without prior record calls", () => {
      expect(() => tracker.write()).not.toThrow();
    });

    it("should overwrite file for same sessionId (not create new files)", () => {
      const tracker2 = SessionTracker.create(tempDir);

      tracker2.record({
        sessionId: "overwrite-test",
        prompt: "first prompt",
      });
      tracker2.write();

      tracker2.record({
        sessionId: "overwrite-test",
        prompt: "second prompt",
      });
      tracker2.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.startsWith("overwrite-test"));

      expect(files.length).toBe(1);
      expect(files[0]).toBe("overwrite-test.json");

      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.prompt).toBe("second prompt");
    });

    it("should create sessions directory if it does not exist", () => {
      const sessionsDir = path.join(tempDir, "sessions");
      expect(fs.existsSync(sessionsDir)).toBe(false);

      tracker.record({ sessionId: "test-789" });
      tracker.write();

      expect(fs.existsSync(sessionsDir)).toBe(true);
    });

    it("should handle toolCalls array persistence", () => {
      tracker.record({
        sessionId: "tool-test",
        toolCalls: [
          {
            toolName: "tool1",
            params: { a: 1 },
            durationMs: 100,
          },
        ],
      });

      tracker.record({
        sessionId: "tool-test",
        toolCalls: [
          {
            toolName: "tool2",
            params: { b: 2 },
            durationMs: 200,
          },
        ],
      });

      tracker.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const filePath = path.join(sessionsDir, files[0]);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.toolCalls).toBeDefined();
      expect(parsed.toolCalls.length).toBeGreaterThan(0);
    });

    it("should merge timestamps across multiple record calls", () => {
      const tracker2 = SessionTracker.create(tempDir);
      tracker2.record({
        sessionId: "timestamp-merge",
        timestamps: { start: "2026-05-26T10:00:00.000Z" },
      });
      tracker2.record({
        sessionId: "timestamp-merge",
        timestamps: { end: "2026-05-26T10:05:00.000Z" },
      });
      tracker2.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.timestamps).toEqual({
        start: "2026-05-26T10:00:00.000Z",
        end: "2026-05-26T10:05:00.000Z",
      });
    });
  });

  describe("edge cases", () => {
    it("should deduplicate skillsUsed across multiple toolCalls", () => {
      const tracker2 = SessionTracker.create(tempDir);
      tracker2.record({
        sessionId: "skill-dedup",
        toolCalls: [
          {
            toolName: "read",
            params: { path: "/path/to/gemini/SKILL.md" },
            result: "---\nname: gemini\n---\ncontent",
            durationMs: 100,
          },
          {
            toolName: "read",
            params: { path: "/path/to/gemini/SKILL.md" },
            result: "---\nname: gemini\n---\ncontent",
            durationMs: 100,
          },
        ],
      });
      tracker2.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.skillsUsed).toEqual([
        { name: "gemini", path: "/path/to/gemini/SKILL.md" },
      ]);
      expect(parsed.skillsUsed.length).toBe(1);
    });

    it("should track multiple unique skills", () => {
      const tracker3 = SessionTracker.create(tempDir);
      tracker3.record({
        sessionId: "multi-skills",
        toolCalls: [
          {
            toolName: "read",
            params: { path: "/path/to/gemini/SKILL.md" },
            result: "---\nname: gemini\n---\nc",
            durationMs: 100,
          },
          {
            toolName: "read",
            params: { path: "/path/to/frontend-ui-engineering/SKILL.md" },
            result: "---\nname: frontend-ui-engineering\n---\nc",
            durationMs: 200,
          },
        ],
      });
      tracker3.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.skillsUsed).toEqual([
        { name: "gemini", path: "/path/to/gemini/SKILL.md" },
        {
          name: "frontend-ui-engineering",
          path: "/path/to/frontend-ui-engineering/SKILL.md",
        },
      ]);
    });

    it("should ignore non-SKILL.md read calls", () => {
      const tracker4 = SessionTracker.create(tempDir);
      tracker4.record({
        sessionId: "no-skill-read",
        toolCalls: [
          {
            toolName: "read",
            params: { path: "/path/to/README.md" },
            result: "---\nname: test\n---\nc",
            durationMs: 100,
          },
        ],
      });
      tracker4.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.skillsUsed).toBeUndefined();
    });

    it("should ignore non-read tool calls", () => {
      const tracker5 = SessionTracker.create(tempDir);
      tracker5.record({
        sessionId: "no-skill-tool",
        toolCalls: [
          {
            toolName: "exec",
            params: { command: "echo test" },
            result: "test",
            durationMs: 100,
          },
        ],
      });
      tracker5.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.skillsUsed).toBeUndefined();
    });

    it("should handle special characters in session data", () => {
      tracker.record({
        sessionId: "special-chars-test",
        prompt: 'Hello "world" with \n newlines and \t tabs',
        finalResponse: "Response with unicode: 你好世界 🌍",
      });
      tracker.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.prompt).toBe('Hello "world" with \n newlines and \t tabs');
      expect(parsed.finalResponse).toBe("Response with unicode: 你好世界 🌍");
    });

    it("should handle empty toolCalls array", () => {
      tracker.record({
        sessionId: "empty-tools-test",
        toolCalls: [],
      });
      tracker.write();

      const sessionsDir = path.join(tempDir, "sessions");
      const files = fs.readdirSync(sessionsDir);
      const content = fs.readFileSync(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const parsed = JSON.parse(content);

      expect(parsed.toolCalls).toEqual([]);
    });

    it("should handle undefined optional fields", () => {
      tracker.record({
        sessionId: "undefined-test",
        agentId: undefined,
        prompt: undefined,
      });
      tracker.write();

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
      tracker2.record({
        sessionId: "intent-session",
        intentResult: {
          intent: "test",
          reason: "test reason",
          goal: "test goal",
          confidence: 0.9,
          complexity: "low",
        },
      });
      expect(tracker2.hasIntentData("intent-session")).toBe(true);
    });

    it("should return false after record without intentResult", () => {
      const tracker3 = SessionTracker.create(tempDir);
      tracker3.record({
        sessionId: "no-intent-session",
        prompt: "hello",
      });
      expect(tracker3.hasIntentData("no-intent-session")).toBe(false);
    });

    it("should return false for different sessionId", () => {
      const tracker4 = SessionTracker.create(tempDir);
      tracker4.record({
        sessionId: "session-a",
        intentResult: {
          intent: "test",
          reason: "test reason",
          goal: "test goal",
          confidence: 0.9,
          complexity: "low",
        },
      });
      expect(tracker4.hasIntentData("session-a")).toBe(true);
      expect(tracker4.hasIntentData("session-b")).toBe(false);
    });

    it("should persist across multiple record calls for same session", () => {
      const tracker5 = SessionTracker.create(tempDir);
      tracker5.record({
        sessionId: "multi-session",
        intentResult: {
          intent: "test",
          reason: "test reason",
          goal: "test goal",
          confidence: 0.9,
          complexity: "low",
        },
      });
      tracker5.record({
        sessionId: "multi-session",
        toolCalls: [
          {
            toolName: "testTool",
            params: { a: 1 },
            durationMs: 100,
          },
        ],
      });
      expect(tracker5.hasIntentData("multi-session")).toBe(true);
    });
  });
});
