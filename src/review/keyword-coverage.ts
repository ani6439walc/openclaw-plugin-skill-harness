import { createHash } from "node:crypto";
import type { ResolvedReviewConfig } from "../types.js";
import type { SessionData, SessionState } from "../session/tracker.js";
import type { TriggerKeywordTarget } from "./trigger-keywords.js";
import type { ReviewTriggerKeywords } from "./trigger-keywords.js";
import {
  evaluateKeywordTrigger,
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
  config: ResolvedReviewConfig["triggers"];
  triggerKeywords: ReviewTriggerKeywords;
}

export interface CoverageReplayResult {
  matches: CoverageCandidateDocument[];
}

const MAX_CANDIDATES_PER_TARGET = 8;

function generateRef(sessionId: string, stateIndex: number, target: TriggerKeywordTarget): string {
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

function extractToolSummary(state: SessionState): CoverageCandidateDocument["toolSummary"] {
  return (state.toolCalls ?? []).map((call) => ({
    name: call.name,
    success: call.success,
    error: call.error !== undefined,
  }));
}

function collectStatesFromSessions(
  sessions: SessionData[],
): Array<{ sessionId: string; state: SessionState; stateIndex: number }> {
  const collected: Array<{ sessionId: string; state: SessionState; stateIndex: number }> = [];

  for (const session of sessions) {
    const states: SessionState[] = [...(session.history ?? []), session.current];
    states.forEach((state, index) => {
      if (state.input || state.result) {
        collected.push({ sessionId: session.sessionId, state, stateIndex: index });
      }
    });
  }

  return collected;
}

function keywordProperty(target: TriggerKeywordTarget): keyof ReviewTriggerKeywords {
  switch (target) {
    case "successful-pattern": return "successfulPattern";
    case "behavior-fix": return "behaviorFix";
    case "entity-context": return "entityContext";
  }
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
  if (allStates.length === 0) {
    return { additions, removals, nextCursor };
  }

  const targets: TriggerKeywordTarget[] = ["successful-pattern", "behavior-fix", "entity-context"];

  for (const target of targets) {
    // Phase 1: Collect all eligible candidates with sessionId
    const candidatesWithSession: Array<{ candidate: CoverageCandidateDocument; sessionId: string }> = [];
    for (const { sessionId, state, stateIndex } of allStates) {
      const triggerState = sessionStateToTriggerState(state);
      
      // Check structural eligibility first
      const structural = checkStructuralEligibility(target, triggerState, config);
      if (!structural.eligible) continue;

      // Coverage candidate = structurally eligible AND NOT matching existing keywords
      const text = `${state.input ?? ""}\n${state.result ?? ""}`;
      const existingKeywords = triggerKeywords[keywordProperty(target)];
      const matchedKeywords = findMatchedKeywords(text, existingKeywords);

      if (matchedKeywords.length === 0) {
        const ref = generateRef(sessionId, stateIndex, target);
        candidatesWithSession.push({
          candidate: {
            ref,
            target,
            input: state.input ?? "",
            result: state.result,
            toolSummary: extractToolSummary(state),
          },
          sessionId,
        });
      }
    }

    // Phase 2: Sort by session uniqueness (distinct sessions first)
    const sessionOrder = new Map<string, number>();
    for (const { sessionId } of candidatesWithSession) {
      if (!sessionOrder.has(sessionId)) {
        sessionOrder.set(sessionId, sessionOrder.size);
      }
    }

    candidatesWithSession.sort((a, b) =>
      (sessionOrder.get(a.sessionId) ?? 0) - (sessionOrder.get(b.sessionId) ?? 0)
    );

    // Phase 3: Apply cursor offset and truncate
    const allCandidates = candidatesWithSession.map(c => c.candidate);
    const cursorStart = cursor[target];
    const rotatedCandidates = [
      ...allCandidates.slice(cursorStart),
      ...allCandidates.slice(0, cursorStart),
    ];

    additions[target] = rotatedCandidates.slice(0, MAX_CANDIDATES_PER_TARGET);
    nextCursor[target] = (cursorStart + additions[target].length) % Math.max(1, allCandidates.length);
  }

  return { additions, removals, nextCursor };
}

export function replayKeywordPhrase(input: CoverageReplayInput): CoverageReplayResult {
  const { phrase, documents } = input;
  const normalizedPhrase = phrase.toLocaleLowerCase();

  const matches = documents.filter((doc) => {
    const normalizedInput = (doc.input ?? "").toLocaleLowerCase();
    const normalizedResult = (doc.result ?? "").toLocaleLowerCase();
    return normalizedInput.includes(normalizedPhrase) || normalizedResult.includes(normalizedPhrase);
  });

  return { matches };
}
