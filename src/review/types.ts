import type { ReviewTrigger } from "./triggers.js";
import type { ReviewOperation } from "./log.js";
import type { SkillPlacementCandidate } from "../stats/aggregator.js";
import type {
  AvailableSkill,
  IntentCatalogEntry,
  IntentDefinition,
  IntentionResult,
  IntentTrigger,
} from "../types.js";

export interface ReviewRecommendationCandidate {
  name: string;
  provenance?: string;
}

export type CapabilityFitEvidence = {
  source: "tool-call-threshold" | "tool-failure-threshold" | "skill-placement";
  observedSkillNames: string[];
  turnHasToolErrors: boolean;
  recoveryVerified: boolean;
};

export type ReviewState = {
  input?: string;
  intent?: IntentionResult;
  routeProvenance?: { trigger: IntentTrigger };
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

export type SkillPlacementReviewCandidate = SkillPlacementCandidate & {
  currentlyReferencedIntentIds: string[];
};

export type SelectedPlacementSkill = Pick<
  AvailableSkill,
  "name" | "description"
> & {
  content: string;
  omittedCodePointCount?: number;
};

export type ReviewSnapshot = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  eventId: string;
  turnNumber: number;
  current: ReviewState;
  recent: ReviewState[];
  matchedIntent?: IntentCatalogEntry;
  availableSkills?: AvailableSkill[];
  skillPlacementCandidate?: SkillPlacementReviewCandidate;
  selectedPlacementSkill?: SelectedPlacementSkill;
  intentCatalog: Array<
    { id: string } & Pick<IntentDefinition, "triggers" | "examples"> &
      Partial<
        Pick<IntentDefinition, "domain" | "keywords" | "skills" | "guidance">
      >
  >;
};

type BaseReviewFinding = {
  trigger: ReviewTrigger;
  dedupeKey: string;
  summary: string;
  evidence: string[];
  correctionGoal: string;
  suggestedChange: string;
};

export type IntentMarkdownReviewFinding = BaseReviewFinding & {
  targetKind: "intent-markdown";
  operation: ReviewOperation;
  targetIntentIds: string[];
};

export type SkillExperienceReviewFinding = BaseReviewFinding & {
  targetKind: "skill-experience";
  targetExperienceIds: [string];
};

export type ReviewFinding =
  IntentMarkdownReviewFinding | SkillExperienceReviewFinding;

export type ReviewSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
