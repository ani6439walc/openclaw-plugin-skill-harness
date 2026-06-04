import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import type { RecentTurn, IntentionResult, ContextWindow } from "./types.js";
import matter from "gray-matter";
import { logger } from "../api.js";

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
    const sessionsDir = path.join(this.pluginRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return;
    }

    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = path.join(sessionsDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const sessionData: SessionData = JSON.parse(content);
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

    const sessionsDir = path.join(this.pluginRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const filename = `${sessionId}.json`;
    const filePath = path.join(sessionsDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(currentDir, "..", "..");

export const defaultTracker = SessionTracker.create(pluginRoot);
