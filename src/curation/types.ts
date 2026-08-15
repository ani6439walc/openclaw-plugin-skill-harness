export type CandidateProvenance =
  "historical-top" | "random-exploration" | "curator-kept" | "curator-added";

export interface CuratedSkillCandidate {
  name: string;
  provenance: CandidateProvenance;
}

export interface SessionCurationRecord {
  topicEpoch: number;
  intentId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedByTurnKey: string;
  candidates: CuratedSkillCandidate[];
  recommendedExperienceRefs: string[];
  completedTurnCursor: number;
}

export interface PendingCurationSchedule {
  agentId: string;
  schedulingTurnKey: string;
  expectedTopicEpoch: number;
  expectedRevision: number;
  status: "pending" | "completed" | "failed" | "obsolete";
  reservedAt: string;
  finishedAt?: string;
}

export interface TurnRecommendationState {
  topicEpoch: number;
  curationRevision: number;
  candidates: CuratedSkillCandidate[];
  curationSchedule?: PendingCurationSchedule;
}

export interface CurationScheduleReservation {
  sessionId: string;
  schedule: PendingCurationSchedule;
}

export type CurationWriteResult =
  | { status: "applied"; curation: SessionCurationRecord }
  | { status: "reused"; curation: SessionCurationRecord }
  | { status: "stale"; curation?: SessionCurationRecord }
  | { status: "retryable-failure" };
