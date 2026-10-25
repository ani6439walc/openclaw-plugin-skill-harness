import { canonicalIdentity } from "../normalize.js";
import type { OpenClawPluginApi } from "../../api.js";
import {
  resolvePluginDataRoot,
  resolveStateDirFromApi,
} from "../file-utils.js";
import { resolveRelationGraph } from "./relation-graph.js";
import type { AvailableSkill, RelatedSkillResult } from "./types.js";

export function relatedSkillsBySkillName(
  skills: readonly AvailableSkill[],
  api: OpenClawPluginApi,
): Promise<Map<string, RelatedSkillResult[]>> {
  return resolveRelationGraph(
    resolvePluginDataRoot(
      resolveStateDirFromApi(api, process.env),
      "skill-harness",
    ),
    skills,
  );
}

export interface RelatedCandidateEvidence {
  name: string;
  from: string;
  relation_type: RelatedSkillResult["relation_type"];
  reason: string;
}

/** Author declarations are one-hop candidate evidence, never loading constraints. */
export function expandRelatedCandidates(
  candidates: readonly AvailableSkill[],
  visibleSkills: readonly AvailableSkill[],
  graph: ReadonlyMap<string, readonly RelatedSkillResult[]>,
): {
  candidateSkills: AvailableSkill[];
  added: string[];
  evidence: RelatedCandidateEvidence[];
} {
  const visible = new Map(
    visibleSkills.map((skill) => [canonicalIdentity(skill.name), skill]),
  );
  const seen = new Set(
    candidates.map((skill) => canonicalIdentity(skill.name)),
  );
  const candidateSkills = [...candidates];
  const added: string[] = [];
  const evidence: RelatedCandidateEvidence[] = [];
  const seeds = candidates.slice(0, 8).map((skill) => ({
    name: skill.name,
    added: 0,
    edges: [...(graph.get(canonicalIdentity(skill.name)) ?? [])]
      .filter(
        (edge) =>
          edge.direction === "current-to-related" &&
          edge.reason.trim() &&
          canonicalIdentity(edge.name) !== canonicalIdentity(skill.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
  // Each pass gives each seed at most one new target. Duplicate targets cost no quota.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const seed of seeds) {
      while (seed.edges.length) {
        const edge = seed.edges.shift()!;
        const target = visible.get(canonicalIdentity(edge.name));
        if (!target) continue;
        const key = canonicalIdentity(target.name);
        const isNew = !seen.has(key);
        if (isNew && (seed.added >= 2 || added.length >= 8)) continue;
        if (evidence.filter((item) => item.name === target.name).length < 2) {
          evidence.push({
            name: target.name,
            from: seed.name,
            relation_type: edge.relation_type,
            reason: Array.from(edge.reason).slice(0, 500).join(""),
          });
        }
        if (!isNew) continue;
        seen.add(key);
        candidateSkills.push(target);
        added.push(target.name);
        seed.added++;
        progressed = true;
        break;
      }
    }
  }
  return { candidateSkills, added, evidence };
}

/** Task relevance is independent of skill relevance and graph verification. */
export interface RelationEvidence {
  skill: string;
  from: string;
  to: string;
  from_description: string;
  to_description: string;
  relation_type: RelatedSkillResult["relation_type"];
  reason: string;
}

export interface RelationDecision extends RelationEvidence {
  score: number;
  injected: boolean;
}

/** Include visible non-candidate endpoints without adding skill questions. */
export function collectRelationEvidence(
  candidates: readonly AvailableSkill[],
  visibleSkills: readonly AvailableSkill[],
  graph: ReadonlyMap<string, readonly RelatedSkillResult[]>,
): RelationEvidence[] {
  const visible = new Map(
    visibleSkills.map((skill) => [canonicalIdentity(skill.name), skill]),
  );
  const result: RelationEvidence[] = [];
  const seen = new Set<string>();
  // Round robin prevents the first few candidates exhausting the evidence budget.
  const queues = candidates.map((candidate) => {
    const current = visible.get(canonicalIdentity(candidate.name));
    if (!current) return [];
    return [...(graph.get(canonicalIdentity(current.name)) ?? [])]
      .filter(
        (edge) =>
          edge.reason.trim() &&
          canonicalIdentity(edge.name) !== canonicalIdentity(current.name),
      )
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          a.direction.localeCompare(b.direction) ||
          a.relation_type.localeCompare(b.relation_type),
      )
      .flatMap((edge) => {
        const other = visible.get(canonicalIdentity(edge.name));
        if (!other) return [];
        const [from, to] =
          edge.direction === "current-to-related"
            ? [current, other]
            : [other, current];
        const key = JSON.stringify([
          current.name,
          from.name,
          edge.relation_type,
          to.name,
        ]);
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            skill: current.name,
            from: from.name,
            to: to.name,
            from_description: Array.from(from.description)
              .slice(0, 1000)
              .join(""),
            to_description: Array.from(to.description).slice(0, 1000).join(""),
            relation_type: edge.relation_type,
            reason: Array.from(edge.reason).slice(0, 500).join(""),
          },
        ];
      })
      .slice(0, 2);
  });
  for (let round = 0; round < 2; round++) {
    for (const queue of queues) {
      if (queue[round]) result.push(queue[round]);
      if (result.length >= 16) return result;
    }
  }
  return result;
}
