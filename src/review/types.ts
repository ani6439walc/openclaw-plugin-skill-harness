import type { ReviewTrigger } from "./triggers.js";
import type { ReviewOperation } from "./log.js";
import type { TriggerKeywordTarget } from "./trigger-keywords.js";
import type { SkillPlacementCandidate } from "../stats/aggregator.js";
import type { CuratedSkillCandidate } from "../curation/types.js";
import type {
  AvailableSkill,
  IntentCatalogEntry,
  IntentDefinition,
  IntentionResult,
} from "../types.js";

export type ReviewState = {
  input?: string;
  intent?: IntentionResult;
  recommendationCandidates?: CuratedSkillCandidate[];
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
        Pick<
          IntentDefinition,
          "domain" | "fastpath" | "candidate" | "skills" | "guidance"
        >
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

export type TriggerKeywordsReviewFinding = BaseReviewFinding & {
  targetKind: "trigger-keywords";
  targetTrigger: TriggerKeywordTarget;
  addKeywords: string[];
  removeKeywords: string[];
};

export type SkillExperienceReviewFinding = BaseReviewFinding & {
  targetKind: "skill-experience";
  targetExperienceIds: [string];
};

export type ReviewFinding =
  | IntentMarkdownReviewFinding
  | TriggerKeywordsReviewFinding
  | SkillExperienceReviewFinding;

export type ReviewSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
