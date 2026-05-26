import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import type { RecentTurn, IntentionResult } from "./types.js";
import matter from "gray-matter";

export interface SkillRecord {
  name: string;
  path: string;
}

export interface SessionData {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  prompt?: string;
  intentInput?: RecentTurn[];
  intentResult?: IntentionResult;
  skillsUsed?: SkillRecord[];
  toolCalls?: Array<{
    toolName: string;
    params: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }>;
  finalResponse?: string;
  success?: boolean;
  error?: string;
  timestamps?: {
    start?: string;
    end?: string;
  };
}

function extractSkillInfo(
  toolName: string,
  toolParams: Record<string, unknown>,
  toolResult: unknown,
): { name: string; path: string } | undefined {
  if (toolName !== "read") return undefined;
  const filePath = toolParams.path;
  if (typeof filePath !== "string" || !filePath.endsWith("SKILL.md"))
    return undefined;
  const text = typeof toolResult === "string" ? toolResult : null;
  if (text === null) return undefined;

  try {
    const parsed = matter(text);
    if (parsed.data?.name && typeof parsed.data.name === "string") {
      return { name: parsed.data.name, path: filePath };
    }
  } catch {
    // not valid markdown with frontmatter
  }
  return undefined;
}

export class SessionTracker {
  private pluginRoot: string;
  private sessionData: Partial<SessionData> = {};
  private sessionsWithIntent: Set<string> = new Set();

  private constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  static create(pluginRoot: string): SessionTracker {
    return new SessionTracker(pluginRoot);
  }

  /**
   * Check if before_prompt_build has recorded intent data for this session.
   * If false, after_tool_call and agent_end should skip recording.
   */
  hasIntentData(sessionId: string): boolean {
    return this.sessionsWithIntent.has(sessionId);
  }

  record(data: Partial<SessionData>): void {
    if (!data.sessionId) {
      return;
    }

    if (
      this.sessionData.sessionId &&
      this.sessionData.sessionId !== data.sessionId
    ) {
      this.sessionData = {};
    }

    if (data.intentResult) {
      this.sessionsWithIntent.add(data.sessionId);
    }

    const processedData = { ...data };

    if (data.toolCalls && data.toolCalls.length > 0) {
      const existingToolCalls = this.sessionData.toolCalls || [];
      processedData.toolCalls = [...existingToolCalls, ...data.toolCalls];

      const existing = this.sessionData.skillsUsed || [];
      const seenNames = new Set(existing.map((s) => s.name));
      for (const tc of data.toolCalls) {
        const skill = extractSkillInfo(tc.toolName, tc.params, tc.result);
        if (skill && !seenNames.has(skill.name)) {
          seenNames.add(skill.name);
          existing.push(skill);
        }
      }
      if (existing.length > 0) {
        processedData.skillsUsed = [...existing];
      }
    }

    if (data.timestamps) {
      processedData.timestamps = {
        ...this.sessionData.timestamps,
        ...data.timestamps,
      };
    }

    this.sessionData = { ...this.sessionData, ...processedData };
  }

  write(): void {
    if (!this.sessionData.sessionId) {
      return;
    }

    const sessionsDir = path.join(this.pluginRoot, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const filename = `${this.sessionData.sessionId}.json`;
    const filePath = path.join(sessionsDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(this.sessionData, null, 2));
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(currentDir, "..", "..");

export const defaultTracker = SessionTracker.create(pluginRoot);
