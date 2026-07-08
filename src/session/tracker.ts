import path from "node:path";
import * as fs from "node:fs";
import type {
  RecentTurn,
  IntentionResult,
  IntentTrigger,
  HistoricalIntentRecord,
} from "../types.js";
import type { ReviewSnapshot, ReviewState } from "../review/types.js";
import matter from "gray-matter";
import { logger } from "../../api.js";
import {
  pluginRoot,
  sessionsDirPath,
  sessionsPath,
  fileExists,
  readJsonFile,
  safeWriteJson,
} from "../file-utils.js";

const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MIGRATED_DOMAIN = "other";
const trackerCache = new Map<string, SessionTracker>();
const TOPIC_CHANGE_REASONS = new Set([
  "start",
  "marker",
  "shift",
  "change",
  "match",
]);

const LEGACY_TOPIC_CHANGE_REASONS = new Map<
  string,
  IntentionResult["topicChangeReason"]
>([
  ["initial", "start"],
  ["transition-marker", "marker"],
  ["keyword-delta", "shift"],
  ["explicit-change", "change"],
  ["keyword-match", "match"],
]);

function normalizeTopicChangeReason(
  reason: unknown,
): IntentionResult["topicChangeReason"] | undefined {
  if (typeof reason !== "string") return;
  if (TOPIC_CHANGE_REASONS.has(reason)) {
    return reason as IntentionResult["topicChangeReason"];
  }
  return LEGACY_TOPIC_CHANGE_REASONS.get(reason);
}

export interface SkillRecord {
  name: string;
  path: string;
  description?: string;
}

export interface IntentState {
  input?: RecentTurn[];
  trigger?: IntentTrigger;
  result?: IntentionResult;
  instructionText?: string;
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

const REVIEW_PARAM_MAX_CHARS = 500;

const SAFE_REVIEW_PARAM_KEYS = new Set([
  "command",
  "cwd",
  "filePath",
  "file_path",
  "limit",
  "name",
  "offset",
  "path",
  "pattern",
  "query",
  "skillName",
  "url",
  "urls",
  "workdir",
]);

const SENSITIVE_REVIEW_PARAM_KEY_PATTERN =
  /api[_-]?key|authorization|body|content|cookie|credential|headers|password|prompt|secret|text|token/i;

function stringifyReviewParamValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return;
  if (["string", "number", "boolean"].includes(typeof value)) {
    return truncate(String(value), REVIEW_PARAM_MAX_CHARS);
  }
  if (Array.isArray(value)) {
    return truncate(
      value
        .map((item) => stringifyReviewParamValue(item))
        .filter((item): item is string => Boolean(item))
        .join(", "),
      REVIEW_PARAM_MAX_CHARS,
    );
  }
  return;
}

function sanitizeToolParamsForReview(
  params: Record<string, unknown>,
): Record<string, string> | undefined {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_REVIEW_PARAM_KEY_PATTERN.test(key)) continue;
    if (!SAFE_REVIEW_PARAM_KEYS.has(key)) continue;
    const stringified = stringifyReviewParamValue(value);
    if (stringified) sanitized[key] = stringified;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function createReviewState(state: SessionState): ReviewState {
  return {
    input: truncate(state.input, 1000),
    intent: state.intent?.result ? { ...state.intent.result } : undefined,
    skillsUsed: state.skillsUsed?.map((skill) => ({ ...skill })),
    toolCalls: state.toolCalls?.map((call) => ({
      name: call.name,
      params: sanitizeToolParamsForReview(call.params),
      error: truncate(call.error, 500),
      durationMs: call.durationMs,
    })),
    result: truncate(state.result, 1500),
    error: truncate(state.error, 500),
    timestamps: state.timestamps ? { ...state.timestamps } : undefined,
  };
}

function migrateIntentionResult(result: IntentionResult): boolean {
  const record = result as IntentionResult & Record<string, unknown>;
  let changed = false;

  if (typeof record.domain !== "string" || !record.domain.trim()) {
    result.domain = DEFAULT_MIGRATED_DOMAIN;
    changed = true;
  }

  const legacyTopicChanged = record.topicChanged;
  const legacyReason = record.topicChangeReason as unknown;
  const normalizedReason = normalizeTopicChangeReason(legacyReason);
  if (legacyTopicChanged === false || legacyReason === "same-topic") {
    delete record.topicChanged;
    delete record.topicChangeReason;
    changed = true;
  } else if (legacyTopicChanged === true) {
    delete record.topicChanged;
    result.topicChangeReason = normalizedReason ?? "change";
    changed = true;
  } else if (record.topicChanged !== undefined) {
    delete record.topicChanged;
    changed = true;
  } else if (legacyReason !== undefined && normalizedReason !== legacyReason) {
    if (normalizedReason) {
      result.topicChangeReason = normalizedReason;
    } else {
      delete record.topicChangeReason;
    }
    changed = true;
  }

  return changed;
}

function migrateSessionData(sessionData: SessionData): boolean {
  let changed = false;
  for (const state of [sessionData.current, ...(sessionData.history ?? [])]) {
    const result = state.intent?.result;
    if (result && migrateIntentionResult(result)) changed = true;
  }
  return changed;
}

export function extractSkillInfo(
  toolName: string,
  toolParams: Record<string, unknown>,
  toolResult: unknown,
): SkillRecord | undefined {
  if (toolName === "exec") {
    return extractExecSkillInfo(toolParams, toolResult);
  }

  if (toolName !== "read") return;
  const filePath = toolParams.path;
  if (typeof filePath !== "string" || !filePath.endsWith("SKILL.md")) return;

  return extractSkillInfoFromMarkdown(filePath, toolResult);
}

function extractSkillInfoFromMarkdown(
  filePath: string,
  toolResult: unknown,
): SkillRecord | undefined {
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
      return {
        name: parsed.data.name,
        path: filePath,
        description:
          typeof parsed.data.description === "string"
            ? parsed.data.description
            : undefined,
      };
    }
  } catch (err) {
    logger.warn("not valid skill markdown with frontmatter", {
      error: err,
      path: filePath,
    });
  }
  return;
}

function extractExecSkillInfo(
  toolParams: Record<string, unknown>,
  toolResult: unknown,
): SkillRecord | undefined {
  const command = toolParams.command;
  if (typeof command !== "string") return;

  const filePath = extractTrailingSkillPath(command);
  if (!filePath) return;

  const parsed = extractSkillInfoFromMarkdown(filePath, toolResult);
  if (parsed) return parsed;

  const skillName = path.basename(path.dirname(filePath));
  if (!skillName || skillName === "." || skillName === path.sep) return;
  return { name: skillName, path: filePath };
}

function extractTrailingSkillPath(command: string): string | undefined {
  const trimmed = command.trim();
  const match = trimmed.match(/(?:^|\s)(["']?)(\S*SKILL\.md)\1$/);
  return match?.[2];
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
    const normalizedPluginRoot = path.resolve(pluginRoot);
    const existing = trackerCache.get(normalizedPluginRoot);
    if (existing) {
      existing.loadSessionsFromDisk();
      return existing;
    }

    const tracker = new SessionTracker(normalizedPluginRoot);
    tracker.loadSessionsFromDisk();
    trackerCache.set(normalizedPluginRoot, tracker);
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
        const migrated = migrateSessionData(sessionData);
        this.sessionData.set(sessionData.sessionId, sessionData);
        if (migrated) {
          safeWriteJson(
            filePath,
            sessionData,
            "failed to migrate session file",
          );
        }
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

  resolveCurrentSessionId(params: {
    sessionId?: string;
    sessionKey?: string;
  }): string | undefined {
    const sessionKey = params.sessionKey?.trim();
    if (sessionKey) {
      let bestMatch: { sessionId: string; startMs: number } | undefined;
      for (const [sessionId, session] of this.sessionData.entries()) {
        if (session.sessionKey !== sessionKey) continue;
        if (!session.current?.intent?.result) continue;
        const startMs = Date.parse(session.current.timestamps?.start ?? "");
        if (Number.isNaN(startMs)) continue;
        if (!bestMatch || startMs > bestMatch.startMs) {
          bestMatch = { sessionId, startMs };
        }
      }
      if (bestMatch) return bestMatch.sessionId;
    }

    if (params.sessionId && this.hasIntentData(params.sessionId)) {
      return params.sessionId;
    }
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
        domain: result.domain ?? DEFAULT_MIGRATED_DOMAIN,
        confidence: result.confidence,
        complexity: result.complexity,
      };
      if (result.keywords?.length) record.keywords = [...result.keywords];
      if (result.topic) record.topic = result.topic;
      if (result.topicChangeReason) {
        record.topicChangeReason = result.topicChangeReason;
      }
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
        if (data.current.intent.trigger !== undefined) {
          current.intent.trigger = data.current.intent.trigger;
        }
        if (data.current.intent.result !== undefined) {
          current.intent.result = data.current.intent.result;
        }
        if (data.current.intent.instructionText !== undefined) {
          current.intent.instructionText = data.current.intent.instructionText;
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
    if (!options.deleteFile) return;

    this.sessionData.delete(sessionId);

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
