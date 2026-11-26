import type { ReviewTrigger } from "./triggers.js";
import type { RelationType } from "../skills/relation-graph.js";

export type ReviewState = {
  input?: string;
  matchedSkills?: string[];
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
};

export type ReviewFinding = SkillRelationReviewFinding;

export type ReviewDomainOutcome = "applied" | "validation-failed" | "aborted";

export interface RelationReviewAssessment {
  existing: "changes-proposed" | "no-change" | "not-applicable";
  discovery: "changes-proposed" | "no-change" | "not-applicable";
}

export type ReviewSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
