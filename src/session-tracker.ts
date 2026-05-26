import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import type { RecentTurn, IntentionResult } from "./types.js";

export interface SessionData {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  prompt?: string;
  intentInput?: RecentTurn[];
  intentResult?: IntentionResult;
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

    const timestamp = Date.now();
    const filename = `${this.sessionData.sessionId}-${timestamp}.json`;
    const filePath = path.join(sessionsDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(this.sessionData, null, 2));
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(currentDir, "..", "..");

export const defaultTracker = SessionTracker.create(pluginRoot);
