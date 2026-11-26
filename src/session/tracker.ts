import { formatErrorDiagnostic } from "../error-diagnostics.js";
import { getOrCache } from "../singleton.js";
import path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { RecentTurn } from "../types.js";
import type { ReviewSnapshot, ReviewState } from "../review/types.js";
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
import { sanitizePromptInput } from "../classification/conversation.js";

export const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const EMBEDDED_AGENT_SESSION_SUFFIXES = [
  ".session.jsonl",
  ".session.trajectory.jsonl",
  ".session.trajectory-path.json",
];
const trackerCache = new Map<string, SessionTracker>();

export interface SkillRecord {
  name: string;
  path: string;
  description?: string;
}

export interface ToolResultFallback {
  /** Extracted from the complete tool result before its stored preview is truncated. */
  skillUsed?: SkillRecord;
  toolCallId: string;
  name: string;
  params: Record<string, unknown>;
  result?: string;
  error?: string;
  success?: boolean;
  durationMs?: number;
}

export type SkillCollectionKind = "meta" | "body" | "references";

export type InputSkillDiscovery = {
  relationDecisions?: import("../skills/related.js").RelationDecision[];
  relatedCandidates?: string[];
  nameCandidates: number;
  retrievalAttempted: boolean;
  retrievalCandidates: number;
  retrievalSemanticScores: number[];
  candidateCount: number;
  injectedSkills: Array<{
    name: string;
    sources?: string[];
    source:
      "name-match" | "direct-retrieval" | "intent-matched" | "related-declared";
    collections?: SkillCollectionKind[];
    topCollection?: SkillCollectionKind;
  }>;
  retrievalCollections?: Record<SkillCollectionKind, number>;
  injectedCollections?: Record<SkillCollectionKind, number>;
  fallbackReason?:
    | "name-channel-unavailable"
    | "retrieval-timeout"
    | "retrieval-unavailable"
    | "empty-pool";
  durationMs: number;
};

export interface IntentProjectionTelemetry {
  originalIntentCount?: number;
  candidateIntentCount?: number;
  durationMs?: number;
  decision?: "projected" | "full-fallback";
  originalCatalogCodePoints?: number;
  candidateCatalogCodePoints?: number;
  fallbackReason?: string;
  supportReasons?: string[];
  selectionReasons?: string[];
  [key: string]: unknown;
}

export interface IntentState {
  input?: RecentTurn[];
  trigger?: string;
  result?: {
    intent: string;
    confidence: number;
    reason?: string;
    keywords?: string[];
  };
  intentMatchedSkills?: string[];
  intentProjection?: IntentProjectionTelemetry;
  inputSkillDiscovery?: InputSkillDiscovery;
  [key: string]: unknown;
}

export interface SessionState {
  skillTurnNumber?: number;
  reviewAwaitingFinalization?: true;
  turnKey?: string;
  input?: string;
  matchedSkills?: string[];
  confidence?: number;
  inputSkillDiscovery?: InputSkillDiscovery;
  intent?: IntentState;
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
  skillTurnCount?: number;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  current: SessionState;
  history?: SessionState[];
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
  return truncate(sanitizePromptInput(value), 1000) || undefined;
}

const REVIEW_PARAM_MAX_CHARS = 500;

const SAFE_REVIEW_PARAM_KEYS = new Set([
  "command",
  "cwd",
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

const JSON_REVIEW_PARAM_KEYS = new Set(["keywords"]);

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

// Allocate once under the session file lock. Completion order can differ from
// prompt order when overlapping runs finish or a staged tool result lands late.
function recordSkillTurn(session: SessionData, turn: SessionState): boolean {
  if (turn.skillTurnNumber !== undefined || !turn.timestamps?.end) return false;
  const recommended = turn.matchedSkills ?? turn.intent?.intentMatchedSkills;
  const hasRecommendation =
    Array.isArray(recommended) &&
    recommended.some((name) => typeof name === "string" && name.trim());
  const hasLoad =
    Array.isArray(turn.skillsUsed) &&
    turn.skillsUsed.some(
      (skill) => typeof skill?.name === "string" && skill.name.trim(),
    );
  if (!hasRecommendation && !hasLoad) return false;
  session.skillTurnCount = (session.skillTurnCount ?? 0) + 1;
  turn.skillTurnNumber = session.skillTurnCount;
  return true;
}

function initializeSkillTurnCount(session: SessionData): void {
  if (session.skillTurnCount !== undefined) return;
  session.skillTurnCount = 0;
  const seen = new Set<string>();
  for (const turn of [...(session.history ?? []), session.current]) {
    const id = resolveTurnEventId(session.sessionId, turn);
    if (id && !seen.has(id) && recordSkillTurn(session, turn)) seen.add(id);
  }
}

function createReviewState(
  state: SessionState,
  options?: { preserveFullResult?: boolean },
): ReviewState {
  const matchedSkills =
    state.matchedSkills ?? state.intent?.intentMatchedSkills;
  return {
    input: sanitizeReviewInput(state.input),
    matchedSkills: matchedSkills ? [...matchedSkills] : undefined,
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

const RETIRED_INTENT_STATE_FIELDS = new Set([
  "instructionText",
  "recommendedSkills",
]);
const RETIRED_INTENTION_RESULT_FIELDS = new Set([
  "topic",
  "topicChanged",
  "topicChangeReason",
]);

function isCurrentSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.intent === undefined) return true;
  if (
    state.intent === null ||
    typeof state.intent !== "object" ||
    Array.isArray(state.intent)
  )
    return false;
  const intent = state.intent as Record<string, unknown>;
  if (
    Object.keys(intent).some((field) => RETIRED_INTENT_STATE_FIELDS.has(field))
  )
    return false;
  const result = intent.result;
  return !(
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.keys(result).some((field) =>
      RETIRED_INTENTION_RESULT_FIELDS.has(field),
    )
  );
}

function isCurrentSessionData(value: unknown): value is SessionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  if (typeof session.sessionId !== "string" || !session.sessionId) return false;
  if (!isCurrentSessionState(session.current)) return false;
  return (
    session.history === undefined ||
    (Array.isArray(session.history) &&
      session.history.every(isCurrentSessionState))
  );
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
      review_inspection?: unknown;
      success?: unknown;
      name?: unknown;
      path?: unknown;
      skill_dir?: unknown;
      content?: unknown;
      description?: unknown;
    };
    if (
      result.review_inspection === true ||
      result.success !== true ||
      typeof result.name !== "string" ||
      !result.name.trim()
    )
      return;
    if (typeof result.content !== "string" || !result.content.trim()) return;
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
    if (typeof parsed.data?.name === "string" && parsed.data.name.trim()) {
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
    logger.warn(
      formatErrorDiagnostic("not valid skill markdown with frontmatter", err),
    );
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

  return extractSkillInfoFromMarkdown(filePath, toolResult);
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
  toolCalls: readonly (NonNullable<SessionState["toolCalls"]>[number] & {
    skillUsed?: SkillRecord;
  })[],
): boolean {
  if (toolCalls.length === 0) {
    current.toolCalls = [];
    return false;
  }

  const existing = current.toolCalls ?? [];
  const seen = new Set(
    existing.flatMap((call) => (call.toolCallId ? [call.toolCallId] : [])),
  );
  const additions: NonNullable<SessionState["toolCalls"]> = [];
  const loads: SkillRecord[] = [];
  for (const { skillUsed, ...call } of toolCalls) {
    if (call.toolCallId) {
      if (seen.has(call.toolCallId)) continue;
      seen.add(call.toolCallId);
    }
    additions.push(call);
    if (call.success === false || call.error !== undefined) continue;
    const skill =
      (call.success === true ? skillUsed : undefined) ??
      extractSkillInfo(call.name, call.params, call.result);
    if (skill) loads.push(skill);
  }
  if (!additions.length) return false;
  current.toolCalls = [...existing, ...additions];
  if (loads.length)
    current.skillsUsed = mergeUniqueSkills(current.skillsUsed, loads);
  return true;
}

function mergeSessionState(
  current: SessionState,
  data: Partial<SessionState>,
): void {
  if (data.input !== undefined) current.input = data.input;
  if (data.matchedSkills !== undefined)
    current.matchedSkills = [...data.matchedSkills];
  if (data.confidence !== undefined) current.confidence = data.confidence;
  if (data.inputSkillDiscovery !== undefined)
    current.inputSkillDiscovery = data.inputSkillDiscovery;
  if (data.intent) {
    if (!current.intent) current.intent = {};
    if (data.intent.input !== undefined)
      current.intent.input = data.intent.input;
    if (data.intent.trigger !== undefined)
      current.intent.trigger = data.intent.trigger;
    if (data.intent.result !== undefined)
      current.intent.result = data.intent.result;
    if (data.intent.intentMatchedSkills !== undefined) {
      current.intent.intentMatchedSkills = [...data.intent.intentMatchedSkills];
    }
    if (data.intent.intentProjection !== undefined) {
      current.intent.intentProjection = data.intent.intentProjection;
    }
    if (data.intent.routingEvidence !== undefined) {
      current.intent.routingEvidence = data.intent.routingEvidence;
    }
    if (data.intent.inputSkillDiscovery !== undefined) {
      current.intent.inputSkillDiscovery = data.intent.inputSkillDiscovery;
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
        const sessionData = readJsonFile<unknown>(filePath);
        if (!isCurrentSessionData(sessionData)) continue;
        this.sessionData.set(sessionData.sessionId, sessionData);
      } catch (err) {
        logger.warn(formatErrorDiagnostic("failed to load session file", err));
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
        const persisted = fileExists(filePath)
          ? readJsonFile<unknown>(filePath)
          : this.sessionData.get(params.sessionId);
        const durable = isCurrentSessionData(persisted) ? persisted : undefined;
        const draft = durable
          ? structuredClone(durable)
          : ({
              sessionId: params.sessionId,
              current: { intent: {} },
            } satisfies SessionData);
        initializeSkillTurnCount(draft);
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
    forceNew?: boolean;
    input: string;
    startedAt: string;
    recentTurns?: readonly RecentTurn[];
    assertActive?: () => void;
  }): Promise<PromptTurnPrepareResult> {
    const requestedRunId = params.forceNew ? undefined : params.runId?.trim();
    try {
      const outcome =
        await this.mutateSession<PersistedPromptTurnPrepareResult>({
          sessionId: params.sessionId,
          maxWaitMs: 0,
          mutate: (session) => {
            params.assertActive?.();
            const current = session.current;
            let recovered = false;
            if (params.recentTurns?.length) {
              // Text is the only available association here. A repeated prompt in
              // either history cannot identify which exact turn the reply closed.
              const answers = new Map<string, string | undefined>();
              for (let i = 0; i < params.recentTurns.length; i++) {
                const turn = params.recentTurns[i];
                if (turn.role !== "user") continue;
                const input = turn.text.trim();
                const next = params.recentTurns[i + 1];
                answers.set(
                  input,
                  !answers.has(input) && next?.role === "assistant"
                    ? next.text.trim()
                    : undefined,
                );
              }
              const states = new Map<string, SessionState | undefined>();
              for (const state of [...(session.history ?? []), current]) {
                const input = state.input?.trim();
                if (input && answers.get(input)) {
                  states.set(input, states.has(input) ? undefined : state);
                }
              }
              for (const [input, state] of states) {
                if (!state || state.result) continue;
                state.result = answers.get(input)!;
                recovered = true;
                if (!state.timestamps?.end) {
                  state.timestamps = {
                    ...state.timestamps,
                    end: params.startedAt,
                  };
                  if (recordSkillTurn(session, state)) {
                    state.reviewAwaitingFinalization = true;
                  }
                }
              }
            }

            const reusableWithoutRunId =
              !params.forceNew &&
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
                changed: recovered,
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
      logger.warn(
        formatErrorDiagnostic("failed to prepare prompt turn", error),
      );
      return { status: "retryable-failure" };
    }
  }

  async mergeTurnAndPersist(params: {
    sessionId: string;
    expectedTurnKey: string;
    data: Partial<SessionState>;
    maxWaitMs?: number;
    assertActive?: () => void;
    currentTurnOnly?: boolean;
  }): Promise<"applied" | "stale" | "retryable-failure"> {
    try {
      const outcome = await this.mutateSession({
        sessionId: params.sessionId,
        maxWaitMs: params.maxWaitMs,
        mutate: (session) => {
          params.assertActive?.();
          if (
            params.currentTurnOnly &&
            session.current.turnKey !== params.expectedTurnKey
          ) {
            return { result: "stale" as const, changed: false };
          }
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
      logger.warn(formatErrorDiagnostic("failed to merge turn", error));
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
  }): Promise<
    | "applied"
    | "became-review-eligible"
    | "already-finalized"
    | "stale"
    | "retryable-failure"
  > {
    try {
      const outcome = await this.mutateSession<
        "applied" | "became-review-eligible" | "already-finalized" | "stale"
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
          }
          const fallbacks = params.stagedToolFallbacks;
          const addedToolCalls = Boolean(
            fallbacks?.length &&
            appendToolCalls(target, structuredClone(fallbacks)),
          );
          if (target.timestamps?.end) {
            let updated = addedToolCalls;
            if (!target.result && params.result) {
              target.result = params.result;
              updated = true;
            }
            if (!target.error && params.error) {
              target.error = params.error;
              updated = true;
            }
            if (
              recordSkillTurn(session, target) ||
              target.reviewAwaitingFinalization
            ) {
              delete target.reviewAwaitingFinalization;
              return {
                result: "became-review-eligible" as const,
                changed: true,
              };
            }
            return {
              result: "already-finalized" as const,
              changed: updated,
            };
          }

          if (params.result !== undefined) target.result = params.result;
          if (params.error !== undefined) target.error = params.error;
          target.timestamps = {
            ...(target.timestamps ?? {}),
            end: params.endedAt,
          };
          recordSkillTurn(session, target);
          return { result: "applied" as const, changed: true };
        },
      });
      return outcome.acquired ? outcome.result : "retryable-failure";
    } catch (error) {
      logger.warn(
        formatErrorDiagnostic("failed to finalize exact turn", error),
      );
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
          !session.current?.matchedSkills?.length &&
          !session.current?.intent?.result &&
          !session.current?.input
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
        state?.input ||
        state?.matchedSkills?.length
      ) {
        return params.sessionId;
      }
    }
  }

  getReviewSnapshotForTurn(
    sessionId: string,
    turnKey: string,
  ): ReviewSnapshot | undefined {
    const session = this.sessionData.get(sessionId);
    if (!session) return;
    initializeSkillTurnCount(session);
    const ordered = [...(session.history ?? []), session.current];
    const matches = ordered
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => state.turnKey === turnKey);
    if (matches.length !== 1) return;
    const { state: target, index: targetIndex } = matches[0];
    const eventId = resolveTurnEventId(sessionId, target);
    if (!target.timestamps?.end || !eventId || !target.skillTurnNumber) return;
    const previous = ordered
      .slice(0, targetIndex)
      .filter(
        (state) =>
          state.input ||
          state.matchedSkills?.length ||
          state.intent?.result ||
          state.skillsUsed?.length,
      );
    return {
      sessionId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      eventId,
      turnNumber: target.skillTurnNumber,
      current: createReviewState(target),
      recent: previous
        .slice(-9)
        .map((state) => createReviewState(state, { preserveFullResult: true })),
    };
  }

  cleanup(sessionId: string, options: { deleteFile: boolean }): void {
    if (!options.deleteFile) return;

    this.sessionData.delete(sessionId);

    const filename = `${sessionId}.json`;
    if (path.basename(filename) !== filename) {
      logger.warn(
        `refusing to delete invalid session file path ${JSON.stringify({ reason: "invalid-session-path" })}`,
      );
      return;
    }

    const filePath = sessionsPath(filename, this.pluginRoot);
    try {
      fs.rmSync(filePath, { force: true });
    } catch (err) {
      logger.warn(formatErrorDiagnostic("failed to delete session file", err));
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
            logger.warn(
              formatErrorDiagnostic(
                "failed to delete expired session file",
                err,
              ),
            );
          }
        }
      } catch (err) {
        logger.warn(
          formatErrorDiagnostic("failed to scan expired session files", err),
        );
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
                formatErrorDiagnostic(
                  "failed to delete expired embedded agent session file",
                  err,
                ),
              );
            }
          }
        } catch (err) {
          logger.warn(
            formatErrorDiagnostic(
              "failed to scan embedded agent session files",
              err,
            ),
          );
        }
      }
    } catch (err) {
      logger.warn(
        formatErrorDiagnostic("failed to scan embedded agent directories", err),
      );
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
