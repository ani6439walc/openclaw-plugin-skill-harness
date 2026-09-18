import { canonicalIdentity } from "../normalize.js";
import type { AvailableSkill } from "./types.js";
import type { SkillQmdEvidence } from "../qmd/skill-index.js";
import type { SkillCollectionKind } from "../session/tracker.js";

export type SkillDiscoverySource =
  "name-match" | "direct-retrieval" | "intent-matched";

export type SkillDiscoveryCandidate = {
  skillName: string;
  score: number;
  source: SkillDiscoverySource;
  collections?: SkillCollectionKind[];
  topCollection?: SkillCollectionKind;
  evidence?: SkillQmdEvidence[];
};

export type CandidatePoolOptions = {
  maxInjectedSkills: number;
};

export type CandidatePoolResult = {
  pool: readonly SkillDiscoveryCandidate[];
  selectedSkills: readonly AvailableSkill[];
};

export function selectSkillCandidates(params: {
  visibleSkills: readonly AvailableSkill[];
  candidates: readonly SkillDiscoveryCandidate[];
  options: CandidatePoolOptions;
}): CandidatePoolResult {
  const visible = new Map(
    params.visibleSkills.map(
      (skill) => [canonicalIdentity(skill.name), skill] as const,
    ),
  );
  const deduped = new Map<string, SkillDiscoveryCandidate>();
  for (const candidate of params.candidates) {
    const identity = canonicalIdentity(candidate.skillName);
    if (
      !identity ||
      !visible.has(identity) ||
      !Number.isFinite(candidate.score)
    )
      continue;
    const existing = deduped.get(identity);
    if (!existing || candidate.score > existing.score) {
      deduped.set(identity, {
        ...candidate,
        skillName: visible.get(identity)!.name,
      });
    }
  }
  const pool = [...deduped.entries()]
    .sort(
      ([leftIdentity, left], [rightIdentity, right]) =>
        right.score - left.score ||
        leftIdentity.localeCompare(rightIdentity, "en"),
    )
    .map(([, candidate]) => candidate);
  const selectedSkills = pool
    .slice(0, params.options.maxInjectedSkills)
    .flatMap((candidate) => {
      const skill = visible.get(canonicalIdentity(candidate.skillName));
      return skill ? [skill] : [];
    });
  return { pool, selectedSkills };
}

export function buildCandidateSkillsUnionPool(params: {
  visibleSkills: readonly AvailableSkill[];
  nameCandidates: readonly SkillDiscoveryCandidate[];
  retrievalCandidates: readonly SkillDiscoveryCandidate[];
  intentMatchedSkillNames?: readonly string[];
  maxInjectedSkills?: number;
}): {
  pool: readonly SkillDiscoveryCandidate[];
  candidateSkills: readonly AvailableSkill[];
} {
  const intentCandidates: SkillDiscoveryCandidate[] = (
    params.intentMatchedSkillNames ?? []
  ).map((name) => ({
    skillName: name,
    score: 0.95,
    source: "intent-matched" as const,
  }));
  const allCandidates = [
    ...params.nameCandidates,
    ...intentCandidates,
    ...params.retrievalCandidates,
  ];
  const result = selectSkillCandidates({
    visibleSkills: params.visibleSkills,
    candidates: allCandidates,
    options: { maxInjectedSkills: params.maxInjectedSkills ?? 4 },
  });
  const visibleMap = new Map(
    params.visibleSkills.map(
      (skill) => [canonicalIdentity(skill.name), skill] as const,
    ),
  );
  const candidateSkills = result.pool.flatMap((c) => {
    const skill = visibleMap.get(canonicalIdentity(c.skillName));
    return skill ? [skill] : [];
  });
  return {
    pool: result.pool,
    candidateSkills,
  };
}
