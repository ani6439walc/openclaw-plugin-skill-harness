import { createHash } from "node:crypto";
import type { ResolvedReviewConfig } from "../types.js";
import type { SessionData, SessionState } from "../session/tracker.js";
import type { TriggerKeywordTarget } from "./trigger-keywords.js";
import type { ReviewTriggerKeywords } from "./trigger-keywords.js";
import {
  checkStructuralEligibility,
  findMatchedKeywords,
  type TriggerState,
} from "./triggers.js";

export interface CoverageCandidateDocument {
  ref: string;
  target: TriggerKeywordTarget;
  input: string;
  result?: string;
  toolSummary: Array<{ name: string; success?: boolean; error?: boolean }>;
}

export interface CoverageDiscoveryInput {
  sessions: SessionData[];
  config: ResolvedReviewConfig["triggers"];
  triggerKeywords: ReviewTriggerKeywords;
  cursor: Record<TriggerKeywordTarget, number>;
}

export interface CoverageDiscoveryResult {
  additions: Record<TriggerKeywordTarget, CoverageCandidateDocument[]>;
  removals: Record<TriggerKeywordTarget, CoverageCandidateDocument[]>;
  nextCursor: Record<TriggerKeywordTarget, number>;
}

export interface CoverageReplayInput {
  phrase: string;
  target: TriggerKeywordTarget;
  documents: CoverageCandidateDocument[];
}

export interface CoverageReplayResult {
  matches: CoverageCandidateDocument[];
}

const MAX_CANDIDATES_PER_TARGET = 8;
const MAX_CANDIDATE_INPUT_CHARS = 1_000;
const MAX_CANDIDATE_RESULT_CHARS = 1_500;

type CandidateWithSession = {
  candidate: CoverageCandidateDocument;
  sessionId: string;
};

function truncateCandidateText(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  return value?.slice(0, maxChars);
}

function generateRef(
  sessionId: string,
  stateIndex: number,
  target: TriggerKeywordTarget,
): string {
  const content = `${sessionId}:${stateIndex}:${target}`;
  return createHash("sha256").update(content).digest("hex");
}

function sessionStateToTriggerState(state: SessionState): TriggerState {
  return {
    input: state.input,
    intent: state.intent?.result ? { result: state.intent.result } : undefined,
    skillsUsed: state.skillsUsed,
    toolCalls: state.toolCalls,
    result: state.result,
    error: state.error,
  };
}

function extractToolSummary(
  state: SessionState,
): CoverageCandidateDocument["toolSummary"] {
  return (state.toolCalls ?? []).map((call) => ({
    name: call.name,
    success: call.success,
    error: call.error !== undefined,
  }));
}

function collectStatesFromSessions(
  sessions: SessionData[],
): Array<{ sessionId: string; state: SessionState; stateIndex: number }> {
  const collected: Array<{
    sessionId: string;
    state: SessionState;
    stateIndex: number;
  }> = [];

  for (const session of sessions) {
    const states: SessionState[] = [
      ...(session.history ?? []),
      session.current,
    ];
    states.forEach((state, index) => {
      if (state.input || state.result) {
        collected.push({
          sessionId: session.sessionId,
          state,
          stateIndex: index,
        });
      }
    });
  }

  return collected;
}

function keywordProperty(
  target: TriggerKeywordTarget,
): keyof ReviewTriggerKeywords {
  switch (target) {
    case "successful-pattern":
      return "successfulPattern";
    case "behavior-fix":
      return "behaviorFix";
    case "entity-context":
      return "entityContext";
  }
}

function roundRobinCandidates(
  candidates: CandidateWithSession[],
): CoverageCandidateDocument[] {
  const bySession = new Map<string, CoverageCandidateDocument[]>();
  for (const { candidate, sessionId } of candidates) {
    const sessionCandidates = bySession.get(sessionId) ?? [];
    sessionCandidates.push(candidate);
    bySession.set(sessionId, sessionCandidates);
  }

  const ordered: CoverageCandidateDocument[] = [];
  for (let stateIndex = 0; bySession.size > 0; stateIndex += 1) {
    for (const [sessionId, sessionCandidates] of bySession) {
      const candidate = sessionCandidates[stateIndex];
      if (candidate) ordered.push(candidate);
      if (stateIndex + 1 >= sessionCandidates.length)
        bySession.delete(sessionId);
    }
  }
  return ordered;
}

export function discoverKeywordCoverageCandidates(
  input: CoverageDiscoveryInput,
): CoverageDiscoveryResult {
  const { sessions, config, triggerKeywords, cursor } = input;
  const additions: Record<TriggerKeywordTarget, CoverageCandidateDocument[]> = {
    "successful-pattern": [],
    "behavior-fix": [],
    "entity-context": [],
  };
  const removals: Record<TriggerKeywordTarget, CoverageCandidateDocument[]> = {
    "successful-pattern": [],
    "behavior-fix": [],
    "entity-context": [],
  };
  const nextCursor: Record<TriggerKeywordTarget, number> = { ...cursor };
  const allStates = collectStatesFromSessions(sessions);
  if (allStates.length === 0) return { additions, removals, nextCursor };

  const targets: TriggerKeywordTarget[] = [
    "successful-pattern",
    "behavior-fix",
    "entity-context",
  ];
  for (const target of targets) {
    const additionCandidates: CandidateWithSession[] = [];
    const removalCandidates = new Map<string, CandidateWithSession[]>();
    const existingKeywords = triggerKeywords[keywordProperty(target)];

    for (const { sessionId, state, stateIndex } of allStates) {
      if (
        !checkStructuralEligibility(
          target,
          sessionStateToTriggerState(state),
          config,
        ).eligible
      ) {
        continue;
      }
      const text = `${state.input ?? ""}\n${state.result ?? ""}`;
      const matchedKeywords = findMatchedKeywords(text, existingKeywords);
      const candidate: CoverageCandidateDocument = {
        ref: generateRef(sessionId, stateIndex, target),
        target,
        input:
          truncateCandidateText(state.input, MAX_CANDIDATE_INPUT_CHARS) ?? "",
        result: truncateCandidateText(state.result, MAX_CANDIDATE_RESULT_CHARS),
        toolSummary: extractToolSummary(state),
      };

      if (matchedKeywords.length === 0) {
        additionCandidates.push({ candidate, sessionId });
        continue;
      }
      for (const phrase of matchedKeywords) {
        const candidates = removalCandidates.get(phrase) ?? [];
        candidates.push({ candidate, sessionId });
        removalCandidates.set(phrase, candidates);
      }
    }

    const allCandidates = roundRobinCandidates(additionCandidates);
    const cursorStart = cursor[target];
    const rotatedCandidates = [
      ...allCandidates.slice(cursorStart),
      ...allCandidates.slice(0, cursorStart),
    ];
    additions[target] = rotatedCandidates.slice(0, MAX_CANDIDATES_PER_TARGET);
    nextCursor[target] =
      (cursorStart + additions[target].length) %
      Math.max(1, allCandidates.length);

    if (existingKeywords.length === 0) continue;
    const phrase = existingKeywords[cursorStart % existingKeywords.length]!;
    const hitSet = removalCandidates.get(phrase) ?? [];
    if (
      hitSet.length >= 2 &&
      hitSet.length <= MAX_CANDIDATES_PER_TARGET &&
      new Set(hitSet.map((entry) => entry.sessionId)).size >= 2
    ) {
      removals[target] = hitSet.map((entry) => entry.candidate);
    }
  }

  return { additions, removals, nextCursor };
}

export function replayKeywordPhrase(
  input: CoverageReplayInput,
): CoverageReplayResult {
  const { phrase, documents } = input;
  const normalizedPhrase = phrase.toLocaleLowerCase();
  const matches = documents.filter((doc) => {
    const normalizedInput = (doc.input ?? "").toLocaleLowerCase();
    const normalizedResult = (doc.result ?? "").toLocaleLowerCase();
    return (
      normalizedInput.includes(normalizedPhrase) ||
      normalizedResult.includes(normalizedPhrase)
    );
  });
  return { matches };
}
