import { canonicalIdentity } from "../normalize.js";
import type { AvailableSkill } from "./types.js";
import type { SkillQmdEvidence } from "../qmd/skill-index.js";
import type { SkillCollectionKind } from "../session/tracker.js";
import type { SkillExperienceHit } from "../qmd/experience-index.js";

export type SkillDiscoverySource =
  "name-match" | "direct-retrieval" | "experience-qmd" | "intent-matched";

export type SkillDiscoveryCandidate = {
  skillName: string;
  score: number;
  source: SkillDiscoverySource;
  collections?: SkillCollectionKind[];
  topCollection?: SkillCollectionKind;
  evidence?: SkillQmdEvidence[];
  experienceHits?: readonly SkillExperienceHit[];
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
    const mergedHits = [
      ...(existing?.experienceHits ?? []),
      ...(candidate.experienceHits ?? []),
    ];
    if (!existing || candidate.score > existing.score) {
      deduped.set(identity, {
        ...candidate,
        skillName: visible.get(identity)!.name,
        ...(mergedHits.length > 0 ? { experienceHits: mergedHits } : {}),
      });
    } else if (mergedHits.length > 0) {
      deduped.set(identity, {
        ...existing,
        experienceHits: mergedHits,
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
  experienceCandidates?: readonly SkillDiscoveryCandidate[];
  intentMatchedSkillNames?: readonly string[];
  maxInjectedSkills?: number;
}): {
  pool: readonly SkillDiscoveryCandidate[];
  candidateSkills: readonly AvailableSkill[];
  experienceHitsBySkill: ReadonlyMap<string, readonly SkillExperienceHit[]>;
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
    ...(params.experienceCandidates ?? []),
    ...params.retrievalCandidates,
  ];
  const result = selectSkillCandidates({
    visibleSkills: params.visibleSkills,
    candidates: allCandidates,
    options: { maxInjectedSkills: params.maxInjectedSkills ?? 8 },
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

  const experienceHitsBySkill = new Map<
    string,
    readonly SkillExperienceHit[]
  >();
  for (const candidate of result.pool) {
    if (candidate.experienceHits && candidate.experienceHits.length > 0) {
      experienceHitsBySkill.set(
        canonicalIdentity(candidate.skillName),
        candidate.experienceHits,
      );
    }
  }

  return {
    pool: result.pool,
    candidateSkills,
    experienceHitsBySkill,
  };
}

/** Associations supply candidates, never scores or automatic selections. */
export function buildSkillCandidateSuperset(params: {
  originals: readonly AvailableSkill[];
  nameCandidates: readonly SkillDiscoveryCandidate[];
  retrievalCandidates: readonly SkillDiscoveryCandidate[];
  experiences: readonly import("../experiences/types.js").SkillExperienceEntry[];
  expanded: readonly AvailableSkill[];
  expandedNames: readonly string[];
  visibleSkills: readonly AvailableSkill[];
  enabled: boolean;
}): {
  candidateSkills: AvailableSkill[];
  candidateSources: Record<string, string[]>;
} {
  const candidateSkills: AvailableSkill[] = [];
  const candidateSources: Record<string, string[]> = Object.create(null);
  if (!params.enabled) return { candidateSkills, candidateSources };
  const visible = new Map(
    params.visibleSkills.map((skill) => [canonicalIdentity(skill.name), skill]),
  );
  const add = (name: string, source: string) => {
    const skill = visible.get(canonicalIdentity(name));
    if (!skill) return;
    if (!candidateSources[skill.name]) {
      candidateSources[skill.name] = [];
      candidateSkills.push(skill);
    }
    if (!candidateSources[skill.name].includes(source))
      candidateSources[skill.name].push(source);
  };
  for (const skill of params.originals) {
    if (
      params.nameCandidates.some(
        (candidate) =>
          canonicalIdentity(candidate.skillName) ===
          canonicalIdentity(skill.name),
      )
    )
      add(skill.name, "name-match");
    if (
      params.retrievalCandidates.some(
        (candidate) =>
          canonicalIdentity(candidate.skillName) ===
          canonicalIdentity(skill.name),
      )
    )
      add(skill.name, "direct-retrieval");
  }
  for (const experience of params.experiences) {
    for (const name of experience.skills) add(name, "experience-associated");
  }
  for (const skill of params.expanded) {
    if (params.expandedNames.includes(skill.name))
      add(skill.name, "related-declared");
  }
  return { candidateSkills, candidateSources };
}
