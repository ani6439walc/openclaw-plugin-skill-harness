import { resolveTurnEventId } from "../session/index.js";
import type {
  SessionData,
  SessionState,
  SessionTracker,
} from "../session/index.js";
import type { SkillExperienceCatalog } from "../experiences/index.js";
import type { AvailableSkill } from "../skills/types.js";
import type { CuratorProposal } from "./subagent.js";
import type {
  CurationScheduleReservation,
  CurationWriteResult,
  CuratedSkillCandidate,
  PendingCurationSchedule,
  SessionCurationRecord,
} from "./types.js";

export interface CurationScheduleCandidate {
  sessionId: string;
  turnKey: string;
  expectedTopicEpoch: number;
  expectedRevision: number;
}

function qualifyingTurns(
  curation: SessionCurationRecord,
  turns: readonly SessionState[],
): SessionState[] {
  return turns.filter((turn) => {
    const recommendation = turn.intent?.recommendationState;
    return (
      turn.timestamps?.end !== undefined &&
      turn.error === undefined &&
      recommendation?.topicEpoch === curation.topicEpoch
    );
  });
}

function matchingSchedule(
  turn: SessionState,
  curation: SessionCurationRecord,
): PendingCurationSchedule | undefined {
  const schedule = turn.intent?.recommendationState?.curationSchedule;
  if (!schedule) return;
  return schedule.schedulingTurnKey === turn.turnKey &&
    schedule.expectedTopicEpoch === curation.topicEpoch &&
    schedule.expectedRevision === curation.revision
    ? schedule
    : undefined;
}

export function evaluateCurationCadence(input: {
  curation: SessionCurationRecord;
  finalizedTurns: readonly SessionState[];
}): { eligible: boolean; schedulingTurnKey?: string } {
  const turns = qualifyingTurns(input.curation, input.finalizedTurns);
  const hasPending = turns.some(
    (turn) => matchingSchedule(turn, input.curation)?.status === "pending",
  );
  if (hasPending) return { eligible: false };

  for (
    let boundary = input.curation.completedTurnCursor + 3;
    boundary <= turns.length;
    boundary += 3
  ) {
    const turn = turns[boundary - 1];
    const recommendation = turn.intent?.recommendationState;
    if (
      !turn.turnKey ||
      recommendation?.curationRevision !== input.curation.revision
    ) {
      continue;
    }

    const existing = matchingSchedule(turn, input.curation);
    if (existing) continue;
    return { eligible: true, schedulingTurnKey: turn.turnKey };
  }

  return { eligible: false };
}

export function reconcileCurationSchedules(input: {
  sessions: readonly SessionData[];
  acceptedEventIds: ReadonlySet<string>;
}): readonly CurationScheduleCandidate[] {
  const candidates: CurationScheduleCandidate[] = [];

  for (const session of input.sessions) {
    if (!session.curation) continue;
    const allTurns = [...(session.history ?? []), session.current];
    const hasPendingForEpoch = allTurns.some((turn) => {
      const schedule = turn.intent?.recommendationState?.curationSchedule;
      return (
        schedule?.status === "pending" &&
        schedule.expectedTopicEpoch === session.curation?.topicEpoch
      );
    });
    if (hasPendingForEpoch) continue;
    const acceptedTurns = allTurns.filter((turn) => {
      const eventId = resolveTurnEventId(session.sessionId, turn);
      return eventId !== undefined && input.acceptedEventIds.has(eventId);
    });
    const cadence = evaluateCurationCadence({
      curation: session.curation,
      finalizedTurns: acceptedTurns,
    });
    if (!cadence.eligible || !cadence.schedulingTurnKey) continue;
    candidates.push({
      sessionId: session.sessionId,
      turnKey: cadence.schedulingTurnKey,
      expectedTopicEpoch: session.curation.topicEpoch,
      expectedRevision: session.curation.revision,
    });
  }

  return candidates;
}

function canonicalIdentity(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

function uniqueCanonicalStrings(
  values: unknown,
  limit: number,
): string[] | undefined {
  if (!Array.isArray(values) || values.length > limit) return;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return;
    const canonical = canonicalIdentity(value);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

type CommitCurationSchedule =
  typeof SessionTracker.prototype.commitCurationSchedule;
type FinishCurationSchedule =
  typeof SessionTracker.prototype.finishCurationSchedule;

export async function validateAndCommitCuration(params: {
  schedule: CurationScheduleReservation;
  expected: SessionCurationRecord;
  proposal: CuratorProposal;
  visibleSkills: readonly AvailableSkill[];
  directSkills: readonly AvailableSkill[];
  experienceCatalog: SkillExperienceCatalog;
  completedTurnCursor: number;
  finalizedTurns: readonly SessionState[];
  acceptedEventIds: ReadonlySet<string>;
  now: string;
  commit: CommitCurationSchedule;
  finish: FinishCurationSchedule;
}): Promise<CurationWriteResult> {
  const schedule = params.schedule.schedule;
  const finish = async (
    outcome: "failed" | "obsolete",
  ): Promise<CurationWriteResult> => {
    const result = await params.finish({
      sessionId: params.schedule.sessionId,
      turnKey: schedule.schedulingTurnKey,
      expectedTopicEpoch: schedule.expectedTopicEpoch,
      expectedRevision: schedule.expectedRevision,
      outcome,
      now: params.now,
    });
    return result === "retryable-failure"
      ? { status: "retryable-failure" }
      : { status: "stale", curation: params.expected };
  };

  if (
    schedule.status !== "pending" ||
    schedule.expectedTopicEpoch !== params.expected.topicEpoch ||
    schedule.expectedRevision !== params.expected.revision
  ) {
    return finish("obsolete");
  }

  const candidates = uniqueCanonicalStrings(params.proposal.candidates, 6);
  const recommendedExperienceRefs = uniqueCanonicalStrings(
    params.proposal.recommendedExperienceRefs,
    3,
  );
  const acceptedTurns = qualifyingTurns(
    params.expected,
    params.finalizedTurns,
  ).filter((turn) => {
    const eventId = resolveTurnEventId(params.schedule.sessionId, turn);
    return eventId !== undefined && params.acceptedEventIds.has(eventId);
  });
  const schedulingTurnIndex = acceptedTurns.findIndex(
    (turn) => turn.turnKey === schedule.schedulingTurnKey,
  );
  const verifiedCompletedTurnCursor = schedulingTurnIndex + 1;
  if (
    params.proposal.topicEpoch !== schedule.expectedTopicEpoch ||
    params.proposal.expectedRevision !== schedule.expectedRevision ||
    typeof params.proposal.reason !== "string" ||
    !params.proposal.reason.trim() ||
    Array.from(params.proposal.reason).length > 500 ||
    !Number.isInteger(params.completedTurnCursor) ||
    params.completedTurnCursor <= params.expected.completedTurnCursor ||
    params.completedTurnCursor % 3 !== 0 ||
    verifiedCompletedTurnCursor !== params.completedTurnCursor ||
    !candidates ||
    !recommendedExperienceRefs
  ) {
    return finish("failed");
  }

  const visibleByIdentity = new Map<string, AvailableSkill>();
  const ambiguousVisibleIdentities = new Set<string>();
  for (const skill of params.visibleSkills) {
    const canonical = canonicalIdentity(skill.name);
    if (!canonical) continue;
    if (visibleByIdentity.has(canonical))
      ambiguousVisibleIdentities.add(canonical);
    else visibleByIdentity.set(canonical, skill);
  }
  const directIdentities = new Set(
    params.directSkills.map((skill) => canonicalIdentity(skill.name)),
  );
  if (
    candidates.some(
      (candidate) =>
        !visibleByIdentity.has(candidate) ||
        ambiguousVisibleIdentities.has(candidate) ||
        !directIdentities.has(candidate),
    )
  ) {
    return finish("failed");
  }

  const previousCandidates = new Set(
    params.expected.candidates.map(({ name }) => canonicalIdentity(name)),
  );
  const finalCandidates: CuratedSkillCandidate[] = candidates.map(
    (candidate) => ({
      name: visibleByIdentity.get(candidate)!.name,
      provenance: previousCandidates.has(candidate)
        ? "curator-kept"
        : "curator-added",
    }),
  );
  const finalCandidateIdentities = new Set(candidates);
  const resolvedExperienceRefs: string[] = [];
  const resolvedExperienceIdentities = new Set<string>();
  for (const identity of recommendedExperienceRefs) {
    const entry = params.experienceCatalog.resolve(identity);
    if (
      !entry ||
      !finalCandidateIdentities.has(canonicalIdentity(entry.skill)) ||
      resolvedExperienceIdentities.has(entry.identity)
    ) {
      return finish("failed");
    }
    resolvedExperienceIdentities.add(entry.identity);
    resolvedExperienceRefs.push(entry.identity);
  }

  const result = await params.commit({
    sessionId: params.schedule.sessionId,
    schedulingTurnKey: schedule.schedulingTurnKey,
    expectedTopicEpoch: schedule.expectedTopicEpoch,
    expectedRevision: schedule.expectedRevision,
    expectedIntentId: params.expected.intentId,
    candidates: finalCandidates,
    recommendedExperienceRefs: resolvedExperienceRefs,
    completedTurnCursor: params.completedTurnCursor,
    now: params.now,
  });
  return result.status === "stale" ? finish("obsolete") : result;
}
