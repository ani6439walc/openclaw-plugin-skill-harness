import { canonicalIdentity } from "../normalize.js";
import type { AvailableSkill } from "./types.js";

export type SkillDiscoverySource = "name-match" | "direct-retrieval";

export type SkillDiscoveryCandidate = {
  skillName: string;
  score: number;
  source: SkillDiscoverySource;
};

export type CandidatePoolOptions = {
  maxPoolSize: number;
  maxInjectedSkills: number;
  minInjectionScore: number;
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
    params.visibleSkills.map((skill) => [canonicalIdentity(skill.name), skill] as const),
  );
  const deduped = new Map<string, SkillDiscoveryCandidate>();
  for (const candidate of params.candidates) {
    const identity = canonicalIdentity(candidate.skillName);
    if (!identity || !visible.has(identity) || !Number.isFinite(candidate.score)) continue;
    const existing = deduped.get(identity);
    if (!existing || candidate.score > existing.score) {
      deduped.set(identity, { ...candidate, skillName: visible.get(identity)!.name });
    }
  }
  const pool = [...deduped.values()]
    .sort((left, right) => right.score - left.score || canonicalIdentity(left.skillName).localeCompare(canonicalIdentity(right.skillName), "en"))
    .slice(0, params.options.maxPoolSize);
  const selectedSkills = pool
    .filter((candidate) => candidate.score >= params.options.minInjectionScore)
    .slice(0, params.options.maxInjectedSkills)
    .flatMap((candidate) => {
      const skill = visible.get(canonicalIdentity(candidate.skillName));
      return skill ? [skill] : [];
    });
  return { pool, selectedSkills };
}
