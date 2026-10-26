import type { ReviewOperation } from "./log.js";
import type { ReviewTrigger } from "./triggers.js";
import type { AvailableSkill } from "../types.js";
import type { RelationType } from "../skills/relation-graph.js";

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

export interface RelationEvidenceReference {
  skillId: string;
  filePath: "SKILL.md";
  startLine: number;
  endLine: number;
  quote: string;
}

export type SkillRelationReviewFinding = BaseReviewFinding & {
  targetKind: "skill-relation";
  operation: "create" | "update" | "delete";
  fromSkillId: string;
  toSkillId: string;
  relationType?: RelationType;
  reason?: string;
  relationEvidence: RelationEvidenceReference[];
  targetExperienceIds?: never;
  sourceExperienceIds?: never;
  retainedExperienceId?: never;
};

export type ReviewFinding =
  SkillExperienceReviewFinding | SkillRelationReviewFinding;

export type ReviewDomainOutcome =
  "applied" | "partial" | "validation-failed" | "aborted";

export type ReviewSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
