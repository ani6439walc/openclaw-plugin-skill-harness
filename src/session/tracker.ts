import { getOrCache } from "../singleton.js";
import path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  RecentTurn,
  IntentionResult,
  IntentTrigger,
  IntentProjectionTelemetry,
  HistoricalIntentRecord,
} from "../types.js";
import type { ReviewSnapshot, ReviewState } from "../review/types.js";
import type {
  CuratedSkillCandidate,
  CurationScheduleReservation,
  CurationWriteResult,
  SessionCurationRecord,
  TurnCurationResult,
  TurnRecommendationState,
} from "../curation/types.js";
import matter from "gray-matter";
import { logger } from "../../api.js";
import {
  agentSessionsPath,
  packageRoot,
  sessionsDirPath,
  sessionsPath,
  fileExists,
  readJsonFile,
  withFileLock,
  writeJsonAtomic,
} from "../file-utils.js";
import { isIntentComplexity } from "../constants.js";
import { sanitizeHistoricalIntentInput } from "../classification/conversation.js";

export const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const EMBEDDED_AGENT_SESSION_SUFFIXES = [
  ".session.jsonl",
  ".session.trajectory.jsonl",
  ".session.trajectory-path.json",
];
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

export interface ToolResultFallback {
  toolCallId: string;
  name: string;
  params: Record<string, unknown>;
  result?: string;
  error?: string;
  success?: boolean;
  durationMs?: number;
}

export interface IntentState {
  input?: RecentTurn[];
  trigger?: IntentTrigger;
  result?: IntentionResult;
  recommendedSkills?: string[];
  recommendationState?: TurnRecommendationState;
  intentProjection?: IntentProjectionTelemetry;
}

export interface SessionState {
  turnKey?: string;
  input?: string;
  intent?: IntentState;
  curationResult?: TurnCurationResult;
  skillsUsed?: SkillRecord[];
  toolCalls?: Array<{
    toolCallId?: string;
    name: string;
    params: Record<string, unknown>;
    result?: string;
    error?: string;
    success?: boolean;
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
  curation?: SessionCurationRecord;
}

export interface PromptTurnIdentity {
  turnKey: string;
  reused: boolean;
}

export type PromptTurnPrepareResult =
  | { status: "applied"; identity: PromptTurnIdentity }
  | { status: "reused"; identity: PromptTurnIdentity }
  | { status: "retryable-failure" };

type PersistedPromptTurnPrepareResult = Exclude<
  PromptTurnPrepareResult,
  { status: "retryable-failure" }
>;

export function resolveTurnEventId(
  sessionId: string,
  state: Pick<SessionState, "turnKey" | "timestamps">,
): string | undefined {
  const turnKey = state.turnKey?.trim();
  if (turnKey) return `${sessionId}:turn:${turnKey}`;
  const start = state.timestamps?.start;
  return start ? `${sessionId}:${start}` : undefined;
}

function truncate(value: string | undefined, maxChars: number) {
  return value?.slice(0, maxChars);
}

function sanitizeReviewInput(value: string | undefined): string | undefined {
  if (!value) return;
  return truncate(sanitizeHistoricalIntentInput(value), 1000) || undefined;
}

const REVIEW_PARAM_MAX_CHARS = 500;

const SAFE_REVIEW_PARAM_KEYS = new Set([
  "command",
  "cwd",
  "domains",
  "filePath",
  "file_path",
  "keywords",
  "limit",
  "name",
  "offset",
  "path",
  "pattern",
  "query",
  "show_evidence",
  "show_related",
  "show_stats",
  "skillName",
  "source",
  "url",
  "urls",
  "workdir",
]);

const JSON_REVIEW_PARAM_KEYS = new Set(["domains", "keywords"]);

const SENSITIVE_REVIEW_PARAM_KEY_PATTERN =
  /api[_-]?key|authorization|body|content|cookie|credential|headers|password|prompt|secret|text|token/i;

function stringifyReviewParamValue(
  value: unknown,
  key?: string,
): string | undefined {
  if (value === null || value === undefined) return;
  if (["string", "number", "boolean"].includes(typeof value)) {
    return truncate(String(value), REVIEW_PARAM_MAX_CHARS);
  }
  if (Array.isArray(value)) {
    if (key && JSON_REVIEW_PARAM_KEYS.has(key)) {
      const strings = value.filter(
        (item): item is string => typeof item === "string",
      );
      return truncate(JSON.stringify(strings), REVIEW_PARAM_MAX_CHARS);
    }
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
    const stringified = stringifyReviewParamValue(value, key);
    if (stringified) sanitized[key] = stringified;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function createReviewState(
  state: SessionState,
  options?: {
    preserveFullResult?: boolean;
    includeRecommendationCandidates?: boolean;
  },
): ReviewState {
  return {
    input: sanitizeReviewInput(state.input),
    intent: state.intent?.result ? { ...state.intent.result } : undefined,
    ...(options?.includeRecommendationCandidates
      ? {
          recommendationCandidates:
            state.intent?.recommendationState?.candidates.map((candidate) => ({
              name: candidate.name,
              provenance: candidate.provenance,
            })),
        }
      : {}),
    skillsUsed: state.skillsUsed?.map((skill) => ({ ...skill })),
    toolCalls: state.toolCalls?.map((call) => ({
      name: call.name,
      params: sanitizeToolParamsForReview(call.params),
      error: truncate(call.error, 500),
      success: typeof call.success === "boolean" ? call.success : undefined,
      durationMs: call.durationMs,
    })),
    result: options?.preserveFullResult
      ? state.result
      : truncate(state.result, 1500),
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

const PERSISTED_INTENT_STATE_FIELDS = new Set<keyof IntentState>([
  "input",
  "trigger",
  "result",
  "recommendedSkills",
  "recommendationState",
  "intentProjection",
]);

function stripUnknownIntentStateFields(state: SessionState): boolean {
  if (!state.intent) return false;

  const unknownFields = Object.keys(state.intent).filter(
    (field) => !PERSISTED_INTENT_STATE_FIELDS.has(field as keyof IntentState),
  );
  if (unknownFields.length === 0) return false;

  const record = state.intent as Record<string, unknown>;
  for (const field of unknownFields) {
    delete record[field];
  }
  return true;
}

function migrateSessionData(sessionData: SessionData): boolean {
  let changed = false;
  const curation = sessionData.curation as
    (SessionCurationRecord & Record<string, unknown>) | undefined;
  if (curation) {
    const legacyRefs = curation.experienceRefs;
    if (!Array.isArray(curation.recommendedExperienceRefs)) {
      curation.recommendedExperienceRefs = Array.isArray(legacyRefs)
        ? legacyRefs.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      changed = true;
    }
    if (Object.hasOwn(curation, "experienceRefs")) {
      delete curation.experienceRefs;
      changed = true;
    }
  }
  for (const state of [sessionData.current, ...(sessionData.history ?? [])]) {
    if (stripUnknownIntentStateFields(state)) changed = true;
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
  if (toolName === "skill_view") {
    return extractSkillViewInfo(toolResult);
  }

  if (toolName === "exec") {
    return extractExecSkillInfo(toolParams, toolResult);
  }

  if (toolName !== "read") return;
  const filePath = toolParams.path;
  if (typeof filePath !== "string" || !filePath.endsWith("SKILL.md")) return;

  return extractSkillInfoFromMarkdown(filePath, toolResult);
}

function extractSkillViewInfo(toolResult: unknown): SkillRecord | undefined {
  const text = typeof toolResult === "string" ? toolResult : null;
  if (text === null) return;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return;
    const result = parsed as {
      success?: unknown;
      name?: unknown;
      path?: unknown;
      skill_dir?: unknown;
      description?: unknown;
    };
    if (result.success !== true || typeof result.name !== "string") return;
    const skillPath =
      typeof result.path === "string"
        ? result.path
        : typeof result.skill_dir === "string"
          ? path.join(result.skill_dir, "SKILL.md")
          : undefined;
    if (!skillPath) return;
    return {
      name: result.name,
      path: skillPath,
      description:
        typeof result.description === "string" ? result.description : undefined,
    };
  } catch {
    return;
  }
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

  const existing = current.toolCalls || [];
  const existingIds = new Set(
    existing.flatMap((call) => (call.toolCallId ? [call.toolCallId] : [])),
  );
  const additions = toolCalls.filter(
    (call) => !call.toolCallId || !existingIds.has(call.toolCallId),
  );
  current.toolCalls = [...existing, ...additions];
  const skillsFromToolCalls = additions.map((toolCall) =>
    extractSkillInfo(toolCall.name, toolCall.params, toolCall.result),
  );
  const skillsUsed = mergeUniqueSkills(current.skillsUsed, skillsFromToolCalls);
  if (skillsUsed) {
    current.skillsUsed = skillsUsed;
  }
}

function mergeSessionState(
  current: SessionState,
  data: Partial<SessionState>,
): void {
  if (data.input !== undefined) current.input = data.input;
  if (data.intent) {
    if (!current.intent) current.intent = {};
    if (data.intent.input !== undefined)
      current.intent.input = data.intent.input;
    if (data.intent.trigger !== undefined)
      current.intent.trigger = data.intent.trigger;
    if (data.intent.result !== undefined)
      current.intent.result = data.intent.result;
    if (data.intent.recommendedSkills !== undefined) {
      current.intent.recommendedSkills = [...data.intent.recommendedSkills];
    }
    if (data.intent.recommendationState !== undefined) {
      current.intent.recommendationState = structuredClone(
        data.intent.recommendationState,
      );
    }
    if (data.intent.intentProjection !== undefined) {
      current.intent.intentProjection = data.intent.intentProjection;
    }
  }
  if (data.result !== undefined) current.result = data.result;
  if (data.error !== undefined) current.error = data.error;
  if (data.timestamps) {
    current.timestamps = { ...(current.timestamps ?? {}), ...data.timestamps };
  }
  if (data.toolCalls) appendToolCalls(current, data.toolCalls);
  if (data.skillsUsed) {
    current.skillsUsed = mergeUniqueSkills(current.skillsUsed, data.skillsUsed);
  }
  if (data.curationResult !== undefined) {
    current.curationResult = structuredClone(data.curationResult);
  }
}

export class SessionTracker {
  private pluginRoot: string;
  private sessionData: Map<string, SessionData> = new Map();

  private constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  static create(pluginRoot: string): SessionTracker {
    return getOrCache(
      trackerCache,
      pluginRoot,
      (normalizedRoot) => new SessionTracker(normalizedRoot),
      (tracker) => tracker.loadSessionsFromDisk(),
    );
  }

  private loadSessionsFromDisk(): void {
    const sessionsDir = sessionsDirPath(this.pluginRoot);
    if (!fileExists(sessionsDir)) {
      return;
    }
    const cutoffMs = Date.now() - SESSION_RETENTION_MS;

    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(sessionsDir, file);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoffMs) continue;
        const sessionData: SessionData = readJsonFile<SessionData>(filePath);
        migrateSessionData(sessionData);
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

  getTurnState(sessionId: string, turnKey: string): SessionState | undefined {
    const session = this.sessionData.get(sessionId);
    if (!session) return;
    const matches = [session.current, ...(session.history ?? [])].filter(
      (state) => state.turnKey === turnKey,
    );
    return matches.length === 1 ? structuredClone(matches[0]) : undefined;
  }

  getCuration(sessionId: string): SessionCurationRecord | undefined {
    const curation = this.sessionData.get(sessionId)?.curation;
    return curation ? structuredClone(curation) : undefined;
  }

  private async mutateSession<T>(params: {
    sessionId: string;
    maxWaitMs?: number;
    mutate: (session: SessionData) => { result: T; changed: boolean };
  }): Promise<{ acquired: false } | { acquired: true; result: T }> {
    const filename = `${params.sessionId}.json`;
    if (!params.sessionId || path.basename(filename) !== filename) {
      return { acquired: false };
    }
    const filePath = sessionsPath(filename, this.pluginRoot);
    const locked = await withFileLock(
      filePath,
      async () => {
        const durable = fileExists(filePath)
          ? readJsonFile<SessionData>(filePath)
          : this.sessionData.get(params.sessionId);
        const draft = durable
          ? structuredClone(durable)
          : ({
              sessionId: params.sessionId,
              current: { intent: {} },
            } satisfies SessionData);
        const mutation = params.mutate(draft);
        if (mutation.changed) writeJsonAtomic(filePath, draft);
        this.sessionData.set(params.sessionId, draft);
        return mutation.result;
      },
      { maxWaitMs: params.maxWaitMs },
    );
    return locked === undefined
      ? { acquired: false }
      : { acquired: true, result: locked };
  }

  async preparePromptTurn(params: {
    sessionId: string;
    sessionKey?: string;
    agentId: string;
    runId?: string;
    input: string;
    startedAt: string;
    recentTurns?: readonly RecentTurn[];
  }): Promise<PromptTurnPrepareResult> {
    const requestedRunId = params.runId?.trim();
    try {
      const outcome =
        await this.mutateSession<PersistedPromptTurnPrepareResult>({
          sessionId: params.sessionId,
          maxWaitMs: 0,
          mutate: (session) => {
            const current = session.current;
            if (params.recentTurns?.length) {
              const pairs: Array<{ user: string; assistant?: string }> = [];
              for (let i = 0; i < params.recentTurns.length; i++) {
                const turn = params.recentTurns[i];
                if (turn.role === "user") {
                  const next = params.recentTurns[i + 1];
                  const assistant =
                    next?.role === "assistant" ? next.text : undefined;
                  pairs.push({
                    user: turn.text.trim(),
                    assistant: assistant?.trim(),
                  });
                }
              }
              const history = session.history ?? [];
              for (const state of [...history, current]) {
                if (!state.result && state.input) {
                  const matched = pairs.find(
                    (p) =>
                      p.user === state.input?.trim() && Boolean(p.assistant),
                  );
                  if (matched?.assistant) {
                    state.result = matched.assistant;
                    if (!state.timestamps?.end) {
                      state.timestamps = {
                        ...(state.timestamps ?? {}),
                        end: params.startedAt,
                      };
                    }
                  }
                }
              }
            }

            const reusableWithoutRunId =
              !requestedRunId &&
              !current.timestamps?.end &&
              current.turnKey &&
              current.input?.trim() === params.input.trim();
            if (
              (requestedRunId && current.turnKey === requestedRunId) ||
              reusableWithoutRunId
            ) {
              return {
                result: {
                  status: "reused" as const,
                  identity: { turnKey: current.turnKey!, reused: true },
                },
                changed: false,
              };
            }

            if (
              current.turnKey ||
              current.input ||
              current.result ||
              current.error ||
              current.toolCalls?.length
            ) {
              session.history = [
                ...(session.history ?? []),
                structuredClone(current),
              ];
            }
            const turnKey = requestedRunId || randomUUID();
            session.sessionKey = params.sessionKey;
            session.agentId = params.agentId;
            session.current = {
              turnKey,
              input: params.input,
              intent: {},
              timestamps: { start: params.startedAt },
            };
            return {
              result: {
                status: "applied" as const,
                identity: { turnKey, reused: false },
              },
              changed: true,
            };
          },
        });
      return outcome.acquired
        ? outcome.result
        : { status: "retryable-failure" };
    } catch (error) {
      logger.warn("failed to prepare prompt turn", {
        error,
        sessionId: params.sessionId,
      });
      return { status: "retryable-failure" };
    }
  }

  async mergeTurnAndPersist(params: {
    sessionId: string;
    expectedTurnKey: string;
    data: Partial<SessionState>;
    maxWaitMs?: number;
  }): Promise<"applied" | "stale" | "retryable-failure"> {
    try {
      const outcome = await this.mutateSession({
        sessionId: params.sessionId,
        maxWaitMs: params.maxWaitMs,
        mutate: (session) => {
          const matches = [session.current, ...(session.history ?? [])].filter(
            (state) => state.turnKey === params.expectedTurnKey,
          );
          if (matches.length !== 1 || matches[0]?.timestamps?.end) {
            return { result: "stale" as const, changed: false };
          }
          mergeSessionState(matches[0], params.data);
          return { result: "applied" as const, changed: true };
        },
      });
      return outcome.acquired ? outcome.result : "retryable-failure";
    } catch (error) {
      logger.warn("failed to merge turn", {
        error,
        sessionId: params.sessionId,
      });
      return "retryable-failure";
    }
  }

  async finalizeTurnFromAgentEnd(params: {
    sessionId: string;
    expectedTurnKey: string;
    stagedToolFallbacks?: readonly ToolResultFallback[];
    result?: string;
    error?: string;
    endedAt: string;
    maxWaitMs?: number;
  }): Promise<"applied" | "already-finalized" | "stale" | "retryable-failure"> {
    try {
      const outcome = await this.mutateSession<
        "applied" | "already-finalized" | "stale"
      >({
        sessionId: params.sessionId,
        maxWaitMs: params.maxWaitMs,
        mutate: (session) => {
          const matches = [session.current, ...(session.history ?? [])].filter(
            (state) => state.turnKey === params.expectedTurnKey,
          );
          if (matches.length !== 1) {
            return { result: "stale" as const, changed: false };
          }
          const target = matches[0];
          if (target.timestamps?.end) {
            const resultConflict =
              target.result !== undefined &&
              params.result !== undefined &&
              target.result !== params.result;
            const errorConflict =
              target.error !== undefined &&
              params.error !== undefined &&
              target.error !== params.error;
            if (resultConflict || errorConflict) {
              return { result: "stale" as const, changed: false };
            }
            let updated = false;
            if (!target.result && params.result) {
              target.result = params.result;
              updated = true;
            }
            if (!target.error && params.error) {
              target.error = params.error;
              updated = true;
            }
            const missingFallbackIds = new Set<string>();
            const missingFallbacks = (params.stagedToolFallbacks ?? []).filter(
              (fallback) => {
                if (
                  missingFallbackIds.has(fallback.toolCallId) ||
                  target.toolCalls?.some(
                    (call) => call.toolCallId === fallback.toolCallId,
                  )
                ) {
                  return false;
                }
                missingFallbackIds.add(fallback.toolCallId);
                return true;
              },
            );
            if (missingFallbacks.length > 0) {
              appendToolCalls(target, structuredClone(missingFallbacks));
              updated = true;
            }
            return {
              result: "already-finalized" as const,
              changed: updated,
            };
          }

          const missingFallbackIds = new Set<string>();
          const missingFallbacks = (params.stagedToolFallbacks ?? []).filter(
            (fallback) => {
              if (
                missingFallbackIds.has(fallback.toolCallId) ||
                target.toolCalls?.some(
                  (call) => call.toolCallId === fallback.toolCallId,
                )
              ) {
                return false;
              }
              missingFallbackIds.add(fallback.toolCallId);
              return true;
            },
          );
          if (missingFallbacks.length > 0) {
            appendToolCalls(target, structuredClone(missingFallbacks));
          }
          if (params.result !== undefined) target.result = params.result;
          if (params.error !== undefined) target.error = params.error;
          target.timestamps = {
            ...(target.timestamps ?? {}),
            end: params.endedAt,
          };
          return { result: "applied" as const, changed: true };
        },
      });
      return outcome.acquired ? outcome.result : "retryable-failure";
    } catch (error) {
      logger.warn("failed to finalize exact turn", {
        error,
        sessionId: params.sessionId,
      });
      return "retryable-failure";
    }
  }

  async reserveCurationSchedule(params: {
    sessionId: string;
    turnKey: string;
    expectedTopicEpoch: number;
    expectedRevision: number;
    now: string;
  }): Promise<
    | "reserved"
    | "already-pending"
    | "already-finished"
    | "stale"
    | "retryable-failure"
  > {
    try {
      const outcome = await this.mutateSession<
        "reserved" | "already-pending" | "already-finished" | "stale"
      >({
        sessionId: params.sessionId,
        mutate: (session) => {
          const matches = [session.current, ...(session.history ?? [])].filter(
            (state) => state.turnKey === params.turnKey,
          );
          if (matches.length !== 1 || !session.agentId) {
            return { result: "stale" as const, changed: false };
          }
          const target = matches[0];
          const recommendation = target.intent?.recommendationState;
          if (
            target.error !== undefined ||
            recommendation?.topicEpoch !== params.expectedTopicEpoch ||
            recommendation.curationRevision !== params.expectedRevision
          ) {
            return { result: "stale" as const, changed: false };
          }
          const existing = recommendation.curationSchedule;
          if (existing) {
            return {
              result:
                existing.status === "pending"
                  ? ("already-pending" as const)
                  : ("already-finished" as const),
              changed: false,
            };
          }
          const anotherPending = [
            session.current,
            ...(session.history ?? []),
          ].some((state) => {
            const schedule =
              state.intent?.recommendationState?.curationSchedule;
            return (
              schedule?.status === "pending" &&
              schedule.expectedTopicEpoch === params.expectedTopicEpoch
            );
          });
          if (anotherPending) {
            return { result: "already-pending" as const, changed: false };
          }
          recommendation.curationSchedule = {
            agentId: session.agentId,
            schedulingTurnKey: params.turnKey,
            expectedTopicEpoch: params.expectedTopicEpoch,
            expectedRevision: params.expectedRevision,
            status: "pending",
            reservedAt: params.now,
          };
          return { result: "reserved" as const, changed: true };
        },
      });
      return outcome.acquired ? outcome.result : "retryable-failure";
    } catch (error) {
      logger.warn("failed to reserve curation schedule", {
        error,
        sessionId: params.sessionId,
      });
      return "retryable-failure";
    }
  }

  async listPendingCurationSchedules(): Promise<
    readonly CurationScheduleReservation[]
  > {
    const reservations: CurationScheduleReservation[] = [];
    for (const [sessionId, session] of this.sessionData) {
      for (const state of [session.current, ...(session.history ?? [])]) {
        const schedule = state.intent?.recommendationState?.curationSchedule;
        if (schedule?.status === "pending") {
          reservations.push({
            sessionId,
            schedule: structuredClone(schedule),
          });
        }
      }
    }
    return reservations;
  }

  async commitCurationSchedule(params: {
    sessionId: string;
    schedulingTurnKey: string;
    expectedTopicEpoch: number;
    expectedRevision: number;
    expectedIntentId: string;
    candidates: readonly CuratedSkillCandidate[];
    recommendedExperienceRefs: readonly string[];
    completedTurnCursor: number;
    reason?: string;
    now: string;
  }): Promise<CurationWriteResult> {
    try {
      const outcome = await this.mutateSession<
        Exclude<CurationWriteResult, { status: "retryable-failure" }>
      >({
        sessionId: params.sessionId,
        mutate: (session) => {
          const matches = [session.current, ...(session.history ?? [])].filter(
            (state) => state.turnKey === params.schedulingTurnKey,
          );
          const curation = session.curation;
          if (matches.length !== 1 || !curation) {
            return {
              result: {
                status: "stale" as const,
                curation: curation ? structuredClone(curation) : undefined,
              },
              changed: false,
            };
          }
          const schedule =
            matches[0].intent?.recommendationState?.curationSchedule;
          const scheduleMatches =
            schedule?.schedulingTurnKey === params.schedulingTurnKey &&
            schedule.expectedTopicEpoch === params.expectedTopicEpoch &&
            schedule.expectedRevision === params.expectedRevision;
          if (
            scheduleMatches &&
            schedule.status === "completed" &&
            curation.topicEpoch === params.expectedTopicEpoch &&
            curation.revision === params.expectedRevision + 1 &&
            curation.intentId === params.expectedIntentId.trim().toLowerCase()
          ) {
            return {
              result: {
                status: "reused" as const,
                curation: structuredClone(curation),
              },
              changed: false,
            };
          }
          if (
            !scheduleMatches ||
            schedule.status !== "pending" ||
            curation.topicEpoch !== params.expectedTopicEpoch ||
            curation.revision !== params.expectedRevision ||
            curation.intentId !==
              params.expectedIntentId.trim().toLowerCase() ||
            params.completedTurnCursor < curation.completedTurnCursor
          ) {
            return {
              result: {
                status: "stale" as const,
                curation: structuredClone(curation),
              },
              changed: false,
            };
          }

          curation.revision += 1;
          curation.updatedAt = params.now;
          curation.candidates = structuredClone([...params.candidates]);
          curation.recommendedExperienceRefs = [
            ...params.recommendedExperienceRefs,
          ];
          curation.completedTurnCursor = params.completedTurnCursor;
          schedule.status = "completed";
          schedule.finishedAt = params.now;
          matches[0].curationResult = {
            status: "applied",
            topicEpoch: curation.topicEpoch,
            revision: curation.revision,
            candidates: structuredClone([...params.candidates]),
            recommendedExperienceRefs: [...params.recommendedExperienceRefs],
            reason: params.reason ?? "",
            finishedAt: params.now,
          };
          return {
            result: {
              status: "applied" as const,
              curation: structuredClone(curation),
            },
            changed: true,
          };
        },
      });
      return outcome.acquired
        ? outcome.result
        : { status: "retryable-failure" };
    } catch (error) {
      logger.warn("failed to commit curation schedule", {
        error,
        sessionId: params.sessionId,
      });
      return { status: "retryable-failure" };
    }
  }

  async finishCurationSchedule(params: {
    sessionId: string;
    turnKey: string;
    expectedTopicEpoch: number;
    expectedRevision: number;
    outcome: "failed" | "obsolete";
    now: string;
  }): Promise<"applied" | "already-finished" | "stale" | "retryable-failure"> {
    try {
      const result = await this.mutateSession<
        "applied" | "already-finished" | "stale"
      >({
        sessionId: params.sessionId,
        mutate: (session) => {
          const matches = [session.current, ...(session.history ?? [])].filter(
            (state) => state.turnKey === params.turnKey,
          );
          if (matches.length !== 1) {
            return { result: "stale" as const, changed: false };
          }
          const schedule =
            matches[0].intent?.recommendationState?.curationSchedule;
          if (
            !schedule ||
            schedule.expectedTopicEpoch !== params.expectedTopicEpoch ||
            schedule.expectedRevision !== params.expectedRevision ||
            schedule.schedulingTurnKey !== params.turnKey
          ) {
            return { result: "stale" as const, changed: false };
          }
          if (schedule.status !== "pending") {
            return { result: "already-finished" as const, changed: false };
          }
          schedule.status = params.outcome;
          schedule.finishedAt = params.now;
          return { result: "applied" as const, changed: true };
        },
      });
      return result.acquired ? result.result : "retryable-failure";
    } catch (error) {
      logger.warn("failed to finish curation schedule", {
        error,
        sessionId: params.sessionId,
      });
      return "retryable-failure";
    }
  }

  async ensureColdStart(params: {
    sessionId: string;
    turnKey: string;
    intentId: string;
    topicChangeReason?: IntentionResult["topicChangeReason"];
    trustworthySameTopic: boolean;
    trustworthyTopicEvidence: boolean;
    draftCandidates: readonly CuratedSkillCandidate[];
    now: string;
  }): Promise<CurationWriteResult> {
    try {
      const outcome = await this.mutateSession<
        Exclude<CurationWriteResult, { status: "retryable-failure" }>
      >({
        sessionId: params.sessionId,
        maxWaitMs: 0,
        mutate: (session) => {
          const current = session.current;
          const existing = session.curation;
          const stale = () => ({
            result: {
              status: "stale" as const,
              curation: existing ? structuredClone(existing) : undefined,
            },
            changed: false,
          });
          if (current.turnKey !== params.turnKey || current.timestamps?.end) {
            return stale();
          }
          if (existing?.startedByTurnKey === params.turnKey) {
            return {
              result: {
                status: "reused" as const,
                curation: structuredClone(existing),
              },
              changed: false,
            };
          }

          const intentId = params.intentId.trim().toLowerCase();
          if (!intentId) return stale();
          const recognizedChange =
            params.topicChangeReason !== undefined &&
            TOPIC_CHANGE_REASONS.has(params.topicChangeReason);
          if (existing && existing.intentId === intentId && !recognizedChange) {
            return {
              result: {
                status: "reused" as const,
                curation: structuredClone(existing),
              },
              changed: false,
            };
          }

          const curation: SessionCurationRecord = {
            topicEpoch: existing ? existing.topicEpoch + 1 : 1,
            intentId,
            revision: 0,
            createdAt: params.now,
            updatedAt: params.now,
            startedByTurnKey: params.turnKey,
            candidates: structuredClone([...params.draftCandidates]),
            recommendedExperienceRefs: [],
            completedTurnCursor: 0,
          };
          session.curation = curation;
          return {
            result: {
              status: "applied" as const,
              curation: structuredClone(curation),
            },
            changed: true,
          };
        },
      });
      return outcome.acquired
        ? outcome.result
        : { status: "retryable-failure" };
    } catch (error) {
      logger.warn("failed to ensure cold-start curation", {
        error,
        sessionId: params.sessionId,
      });
      return { status: "retryable-failure" };
    }
  }

  async commitPromptRecommendation(params: {
    sessionId: string;
    turnKey: string;
    expectedTopicEpoch: number;
    expectedRevision: number;
    recommendedSkills: readonly string[];
    recommendationState: TurnRecommendationState;
  }): Promise<"applied" | "stale" | "retryable-failure"> {
    try {
      const outcome = await this.mutateSession<"applied" | "stale">({
        sessionId: params.sessionId,
        maxWaitMs: 0,
        mutate: (session) => {
          const current = session.current;
          const curation = session.curation;
          if (
            current.turnKey !== params.turnKey ||
            current.timestamps?.end ||
            curation?.topicEpoch !== params.expectedTopicEpoch ||
            curation.revision !== params.expectedRevision ||
            params.recommendationState.topicEpoch !==
              params.expectedTopicEpoch ||
            params.recommendationState.curationRevision !==
              params.expectedRevision
          ) {
            return { result: "stale" as const, changed: false };
          }
          current.intent ??= {};
          current.intent.recommendedSkills = [...params.recommendedSkills];
          current.intent.recommendationState = structuredClone(
            params.recommendationState,
          );
          return { result: "applied" as const, changed: true };
        },
      });
      return outcome.acquired ? outcome.result : "retryable-failure";
    } catch (error) {
      logger.warn("failed to commit prompt recommendation", {
        error,
        sessionId: params.sessionId,
      });
      return "retryable-failure";
    }
  }

  /** Snapshot of retained sessions currently loaded in memory (14-day retention). */
  listRetainedSessions(): SessionData[] {
    return [...this.sessionData.values()].map((session) =>
      structuredClone(session),
    );
  }

  getAgentId(sessionId: string): string | undefined {
    return this.sessionData.get(sessionId)?.agentId;
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
        if (
          !session.current?.intent?.result &&
          !session.current?.intent?.intentProjection
        ) {
          continue;
        }
        const startMs = Date.parse(session.current.timestamps?.start ?? "");
        if (Number.isNaN(startMs)) continue;
        if (!bestMatch || startMs > bestMatch.startMs) {
          bestMatch = { sessionId, startMs };
        }
      }
      if (bestMatch) return bestMatch.sessionId;
    }

    if (params.sessionId) {
      const state = this.sessionData.get(params.sessionId)?.current;
      if (
        this.hasIntentData(params.sessionId) ||
        state?.intent?.intentProjection
      ) {
        return params.sessionId;
      }
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
      current: createReviewState(session.current, {
        includeRecommendationCandidates: true,
      }),
      recent: completedStates
        .slice(-10, -1)
        .map((state) => createReviewState(state, { preserveFullResult: true })),
      intentCatalog: [],
    };
  }

  getReviewSnapshotForTurn(
    sessionId: string,
    turnKey: string,
  ): ReviewSnapshot | undefined {
    const session = this.sessionData.get(sessionId);
    if (!session) return;
    const ordered = [...(session.history ?? []), session.current];
    const matches = ordered
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => state.turnKey === turnKey);
    if (matches.length !== 1) return;
    const { state: target, index: targetIndex } = matches[0];
    const eventId = resolveTurnEventId(sessionId, target);
    if (!target.intent?.result || !target.timestamps?.end || !eventId) return;
    const throughTarget = ordered
      .slice(0, targetIndex + 1)
      .filter((state) => state.intent?.result);
    return {
      sessionId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      eventId,
      turnNumber: throughTarget.length,
      current: createReviewState(target, {
        includeRecommendationCandidates: true,
      }),
      recent: throughTarget
        .slice(-10, -1)
        .map((state) => createReviewState(state, { preserveFullResult: true })),
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
      };
      if (isIntentComplexity(result.complexity)) {
        record.complexity = result.complexity;
      }
      if (result.keywords?.length) record.keywords = [...result.keywords];
      if (result.topic) record.topic = result.topic;
      if (result.topicChangeReason) {
        record.topicChangeReason = result.topicChangeReason;
      }
      return [record];
    });
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
    const cutoffMs = nowMs - SESSION_RETENTION_MS;
    let deletedCount = 0;

    if (fileExists(sessionsDir)) {
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
    }

    return deletedCount + this.cleanupExpiredEmbeddedAgentSessions(cutoffMs);
  }

  private cleanupExpiredEmbeddedAgentSessions(cutoffMs: number): number {
    const agentsDir = path.join(this.pluginRoot, "agents");
    if (!fileExists(agentsDir)) return 0;

    let deletedCount = 0;
    try {
      for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;

        const sessionsDir = agentSessionsPath(this.pluginRoot, agent.name);
        if (!fileExists(sessionsDir)) continue;

        try {
          for (const entry of fs.readdirSync(sessionsDir, {
            withFileTypes: true,
          })) {
            if (
              !entry.isFile() ||
              !EMBEDDED_AGENT_SESSION_SUFFIXES.some((suffix) =>
                entry.name.endsWith(suffix),
              )
            ) {
              continue;
            }

            const filePath = path.join(sessionsDir, entry.name);
            try {
              if (fs.statSync(filePath).mtimeMs >= cutoffMs) continue;

              fs.rmSync(filePath, { force: true });
              deletedCount += 1;
            } catch (err) {
              logger.warn(
                "failed to delete expired embedded agent session file",
                {
                  error: err,
                  path: filePath,
                },
              );
            }
          }
        } catch (err) {
          logger.warn("failed to scan embedded agent session files", {
            error: err,
            path: sessionsDir,
          });
        }
      }
    } catch (err) {
      logger.warn("failed to scan embedded agent directories", {
        error: err,
        path: agentsDir,
      });
    }

    return deletedCount;
  }
}

type LegacyPublicMutation = Extract<
  keyof SessionTracker,
  "record" | "rotate" | "write"
>;
const legacyMutationsArePrivate: [LegacyPublicMutation] extends [never]
  ? true
  : false = true;
void legacyMutationsArePrivate;

export const defaultTracker = SessionTracker.create(packageRoot);
