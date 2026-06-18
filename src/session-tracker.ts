import path from "node:path";
import * as fs from "node:fs";
import type {
  RecentTurn,
  IntentionResult,
  HistoricalIntentRecord,
} from "./types.js";
import type { ReviewSnapshot, ReviewState } from "./evolution-types.js";
import matter from "gray-matter";
import { logger } from "../api.js";
import {
  pluginRoot,
  sessionsDirPath,
  sessionsPath,
  fileExists,
  readJsonFile,
  safeWriteJson,
} from "./file-utils.js";

const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface SkillRecord {
  name: string;
  path: string;
}

export interface IntentState {
  input?: RecentTurn[];
  result?: IntentionResult;
}

export interface SessionState {
  input?: string;
  intent?: IntentState;
  skillsUsed?: SkillRecord[];
  toolCalls?: Array<{
    name: string;
    params: Record<string, unknown>;
    result?: string;
    error?: string;
    durationMs?: number;
  }>;
  result?: string;
  error?: string;
  timestamps?: {
    start?: string;
    end?: string;
  };
}

export interface SessionData {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  current: SessionState;
  history?: SessionState[];
}

function truncate(value: string | undefined, maxChars: number) {
  return value?.slice(0, maxChars);
}

function createReviewState(state: SessionState): ReviewState {
  return {
    input: truncate(state.input, 1000),
    intent: state.intent?.result ? { ...state.intent.result } : undefined,
    skillsUsed: state.skillsUsed?.map((skill) => skill.name),
    toolCalls: state.toolCalls?.map((call) => ({
      name: call.name,
      error: truncate(call.error, 500),
      durationMs: call.durationMs,
    })),
    result: truncate(state.result, 1500),
    error: truncate(state.error, 500),
    timestamps: state.timestamps ? { ...state.timestamps } : undefined,
  };
}

function extractSkillInfo(
  toolName: string,
  toolParams: Record<string, unknown>,
  toolResult: unknown,
): { name: string; path: string } | undefined {
  if (toolName !== "read") return;
  const filePath = toolParams.path;
  if (typeof filePath !== "string" || !filePath.endsWith("SKILL.md")) return;
  const text = typeof toolResult === "string" ? toolResult : null;
  if (text === null) return;

  // Tool results may be truncated before the closing frontmatter delimiter.
  // gray-matter treats that as malformed YAML and logs a noisy warning even
  // though the underlying SKILL.md file is valid. Only parse complete
  // frontmatter captured in the tool result.
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) return;

  try {
    const parsed = matter(text);
    if (parsed.data?.name && typeof parsed.data.name === "string") {
      return { name: parsed.data.name, path: filePath };
    }
  } catch (err) {
    logger.warn("not valid skill markdown with frontmatter", {
      error: err,
      path: filePath,
    });
  }
  return;
}

function mergeUniqueSkills(
  existing: SkillRecord[] | undefined,
  additions: Iterable<SkillRecord | undefined>,
): SkillRecord[] | undefined {
  const merged = existing ? [...existing] : [];
  const seenNames = new Set(merged.map((skill) => skill.name));

  for (const skill of additions) {
    if (!skill || seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    merged.push(skill);
  }

  return merged.length > 0 ? merged : undefined;
}

function appendToolCalls(
  current: SessionState,
  toolCalls: NonNullable<SessionState["toolCalls"]>,
): void {
  if (toolCalls.length === 0) {
    current.toolCalls = [];
    return;
  }

  current.toolCalls = [...(current.toolCalls || []), ...toolCalls];
  const skillsFromToolCalls = toolCalls.map((toolCall) =>
    extractSkillInfo(toolCall.name, toolCall.params, toolCall.result),
  );
  const skillsUsed = mergeUniqueSkills(current.skillsUsed, skillsFromToolCalls);
  if (skillsUsed) {
    current.skillsUsed = skillsUsed;
  }
}

export class SessionTracker {
  private pluginRoot: string;
  private sessionData: Map<string, SessionData> = new Map();

  private constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  static create(pluginRoot: string): SessionTracker {
    const tracker = new SessionTracker(pluginRoot);
    tracker.loadSessionsFromDisk();
    return tracker;
  }

  private loadSessionsFromDisk(): void {
    const sessionsDir = sessionsDirPath(this.pluginRoot);
    if (!fileExists(sessionsDir)) {
      return;
    }

    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(sessionsDir, file);
      try {
        const sessionData: SessionData = readJsonFile<SessionData>(filePath);
        this.sessionData.set(sessionData.sessionId, sessionData);
      } catch (err) {
        logger.warn("failed to load session file", {
          error: err,
          path: filePath,
        });
      }
    }
  }

  hasIntentData(sessionId: string): boolean {
    const session = this.sessionData.get(sessionId);
    return !!session?.current?.intent?.result;
  }

  getCurrentState(sessionId: string): SessionState | undefined {
    return this.sessionData.get(sessionId)?.current;
  }

  getReviewSnapshot(sessionId: string): ReviewSnapshot | undefined {
    const session = this.sessionData.get(sessionId);
    const start = session?.current.timestamps?.start;
    if (!session || !start || !session.current.intent?.result) return;

    const completedStates = [
      ...(session.history ?? []),
      session.current,
    ].filter((state) => state.intent?.result);
    return {
      sessionId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      eventId: `${sessionId}:${start}`,
      turnNumber: completedStates.length,
      current: createReviewState(session.current),
      recent: completedStates.slice(-10, -1).map(createReviewState),
      intentCatalog: [],
    };
  }

  getHistoricalIntentRecords(sessionId: string): HistoricalIntentRecord[] {
    const session = this.sessionData.get(sessionId);
    if (!session) return [];

    return [...(session.history ?? []), session.current].flatMap((state) => {
      const result = state.intent?.result;
      if (!state.input || !result) return [];
      const record: HistoricalIntentRecord = {
        input: state.input,
        intent: result.intent,
        confidence: result.confidence,
        complexity: result.complexity,
      };
      if (result.keywords?.length) record.keywords = [...result.keywords];
      if (result.topic) record.topic = result.topic;
      return [record];
    });
  }

  rotate(sessionId: string): void {
    const session = this.sessionData.get(sessionId);
    if (!session) return;
    const snapshot = session.current;
    if (
      !snapshot.input &&
      !snapshot.result &&
      !snapshot.error &&
      !snapshot.toolCalls?.length
    ) {
      return;
    }

    if (!session.history) {
      session.history = [];
    }
    session.history.push({ ...snapshot });
    session.current = { intent: {} };
  }

  record(sessionId: string, data: Partial<SessionData>): void {
    if (!sessionId) {
      return;
    }

    let session = this.sessionData.get(sessionId);
    if (!session) {
      session = { sessionId: sessionId, current: { intent: {} } };
      this.sessionData.set(sessionId, session);
    }

    if (data.sessionKey !== undefined) {
      session.sessionKey = data.sessionKey;
    }
    if (data.agentId !== undefined) {
      session.agentId = data.agentId;
    }

    const current = session.current;

    if (data.current) {
      if (data.current.input !== undefined) {
        current.input = data.current.input;
      }
      if (data.current.intent) {
        if (!current.intent) current.intent = {};
        if (data.current.intent.input !== undefined) {
          current.intent.input = data.current.intent.input;
        }
        if (data.current.intent.result !== undefined) {
          current.intent.result = data.current.intent.result;
        }
      }
      if (data.current.result !== undefined) {
        current.result = data.current.result;
      }
      if (data.current.error !== undefined) {
        current.error = data.current.error;
      }
      if (data.current.timestamps) {
        current.timestamps = {
          ...(current.timestamps || {}),
          ...(data.current.timestamps || {}),
        };
      }

      if (data.current.toolCalls) {
        appendToolCalls(current, data.current.toolCalls);
      }
      if (data.current.skillsUsed) {
        current.skillsUsed = mergeUniqueSkills(
          current.skillsUsed,
          data.current.skillsUsed,
        );
      }
    }

    if (data.history) {
      session.history = data.history;
    }
  }

  write(sessionId: string): void {
    const session = this.sessionData.get(sessionId);
    if (!session) return;

    const filename = `${sessionId}.json`;
    const filePath = sessionsPath(filename, this.pluginRoot);

    safeWriteJson(filePath, session, "failed to write session file");
  }

  cleanup(sessionId: string, options: { deleteFile: boolean }): void {
    this.sessionData.delete(sessionId);
    if (!options.deleteFile) return;

    const filename = `${sessionId}.json`;
    if (path.basename(filename) !== filename) {
      logger.warn("refusing to delete invalid session file path", {
        sessionId,
      });
      return;
    }

    const filePath = sessionsPath(filename, this.pluginRoot);
    try {
      fs.rmSync(filePath, { force: true });
    } catch (err) {
      logger.warn("failed to delete session file", {
        error: err,
        path: filePath,
      });
    }
  }

  cleanupExpired(nowMs = Date.now()): number {
    const sessionsDir = sessionsDirPath(this.pluginRoot);
    if (!fileExists(sessionsDir)) return 0;

    const cutoffMs = nowMs - SESSION_RETENTION_MS;
    let deletedCount = 0;

    try {
      for (const entry of fs.readdirSync(sessionsDir, {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const filePath = path.join(sessionsDir, entry.name);
        try {
          if (fs.statSync(filePath).mtimeMs >= cutoffMs) continue;

          const sessionId = entry.name.slice(0, -".json".length);
          this.sessionData.delete(sessionId);
          fs.rmSync(filePath, { force: true });
          deletedCount += 1;
        } catch (err) {
          logger.warn("failed to delete expired session file", {
            error: err,
            path: filePath,
          });
        }
      }
    } catch (err) {
      logger.warn("failed to scan expired session files", {
        error: err,
        path: sessionsDir,
      });
    }

    return deletedCount;
  }
}

export const defaultTracker = SessionTracker.create(pluginRoot);
