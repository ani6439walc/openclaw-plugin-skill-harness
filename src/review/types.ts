import type { ReviewOperation } from "./log.js";
import type { ReviewTrigger } from "./triggers.js";
import type { AvailableSkill } from "../types.js";

export interface ReviewRecommendationCandidate {
  name: string;
  provenance?: string;
}

export type CapabilityFitEvidence = {
  source: "tool-call-threshold" | "tool-failure-threshold";
  observedSkillNames: string[];
  turnHasToolErrors: boolean;
  recoveryVerified: boolean;
};

export type ReviewState = {
  input?: string;
  confidence?: number;
  matchedSkills?: string[];
  matchedExperiences?: string[];
  capabilityFit?: CapabilityFitEvidence;
  recommendationCandidates?: ReviewRecommendationCandidate[];
  skillsUsed?: Array<{
    name: string;
    description?: string;
    path: string;
  }>;
  toolCalls?: Array<{
    name: string;
    params?: Record<string, string>;
    error?: string;
    success?: boolean;
    durationMs?: number;
  }>;
  result?: string;
  error?: string;
  timestamps?: { start?: string; end?: string };
};

export type ReviewSnapshot = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  eventId: string;
  turnNumber: number;
  current: ReviewState;
  recent: ReviewState[];
};

type BaseReviewFinding = {
  trigger: ReviewTrigger;
  dedupeKey: string;
  summary: string;
  evidence: string[];
  correctionGoal: string;
  suggestedChange: string;
};

export type SkillExperienceReviewFinding = BaseReviewFinding & {
  targetKind: "skill-experience";
  targetExperienceIds: string[];
} & (
    | { operation: Exclude<ReviewOperation, "merge"> }
    | {
        operation: "merge";
        sourceExperienceIds: string[];
        retainedExperienceId: string;
      }
  );

export type ReviewFinding = SkillExperienceReviewFinding;

export type ReviewSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
