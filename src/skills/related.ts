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
  verification_status: "unverified";
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
    visibleSkills.map((skill) => [skill.name.toLowerCase(), skill]),
  );
  const seen = new Set(candidates.map((skill) => skill.name.toLowerCase()));
  const candidateSkills = [...candidates];
  const added: string[] = [];
  const evidence: RelatedCandidateEvidence[] = [];
  const seeds = candidates.slice(0, 8).map((skill) => ({
    name: skill.name,
    added: 0,
    edges: [...(graph.get(skill.name.toLowerCase()) ?? [])]
      .filter(
        (edge) =>
          edge.direction === "current-to-related" &&
          edge.reason.trim() &&
          edge.name.toLowerCase() !== skill.name.toLowerCase(),
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
        const target = visible.get(edge.name.toLowerCase());
        if (!target) continue;
        const key = target.name.toLowerCase();
        const isNew = !seen.has(key);
        if (isNew && (seed.added >= 2 || added.length >= 8)) continue;
        if (evidence.filter((item) => item.name === target.name).length < 2) {
          evidence.push({
            name: target.name,
            from: seed.name,
            relation_type: edge.relation_type,
            verification_status: "unverified",
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
