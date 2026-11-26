import type { RelationDecision } from "../skills/related.js";
import {
  DEFAULT_RELATION_RELEVANCE_THRESHOLD,
  ROUTING_ADVISORY_SKILLS_ONLY_HEADER,
  SKILL_HARNESS_PLUGIN_TAG,
} from "../constants.js";
import { xmlBlock } from "../xml-format.js";
import type { AvailableSkill } from "../types.js";

export function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const keyword = item.trim().toLowerCase().replace(/\s+/g, " ");
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length === 8) break;
  }
  return keywords;
}

function escapeXmlText(value: string | null | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\r", "&#xD;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\t", "&#x9;");
}

function formatSkillXml(
  skill: AvailableSkill,
  relations: readonly RelationDecision[] = [],
  relationRelevanceThreshold = DEFAULT_RELATION_RELEVANCE_THRESHOLD,
): string {
  const lines: string[] = [];
  if (skill.description) {
    lines.push(escapeXmlText(skill.description));
  }
  for (const relation of relations) {
    if (
      !relation.injected ||
      relation.score < relationRelevanceThreshold ||
      relation.skill !== skill.name
    )
      continue;
    lines.push(
      xmlBlock(
        "relation",
        escapeXmlText(relation.reason),
        ` from="${escapeXmlAttribute(relation.from)}" to="${escapeXmlAttribute(relation.to)}" type="${escapeXmlAttribute(relation.relation_type)}"`,
      ),
    );
  }
  return xmlBlock(
    "skill",
    lines.join("\n"),
    ` name="${escapeXmlAttribute(skill.name)}"`,
  );
}

function formatSkillXmlBlock(
  tag: string,
  skills: readonly AvailableSkill[] | undefined,
  relations: readonly RelationDecision[] = [],
  relationRelevanceThreshold = DEFAULT_RELATION_RELEVANCE_THRESHOLD,
): string {
  const body = skills
    ?.map((skill) =>
      formatSkillXml(skill, relations, relationRelevanceThreshold),
    )
    .join("\n");
  return xmlBlock(tag, body ?? "");
}

export function formatMatchedSkills(skills: readonly AvailableSkill[]): string {
  if (skills.length === 0) return "";
  return formatSkillXmlBlock("matched_skills", skills);
}

export function formatInputMatchedSkills(
  skills: readonly AvailableSkill[],
): string {
  if (skills.length === 0) return "";
  return formatSkillXmlBlock("matched_skills", skills);
}

export function buildRoutingContext(params: {
  matchedSkills?: readonly AvailableSkill[];
  inputMatchedSkills?: readonly AvailableSkill[];
  relationDecisions?: readonly RelationDecision[];
  relationRelevanceThreshold?: number;
}): string {
  const matchedSkills: readonly AvailableSkill[] =
    params.matchedSkills ?? params.inputMatchedSkills ?? [];
  if (!matchedSkills.length) return "";
  const skills = formatSkillXmlBlock(
    "matched_skills",
    matchedSkills,
    params.relationDecisions,
    params.relationRelevanceThreshold,
  );
  return xmlBlock(
    SKILL_HARNESS_PLUGIN_TAG,
    `${ROUTING_ADVISORY_SKILLS_ONLY_HEADER}\n${skills}`,
  );
}

export function formatWorkingSetSkills(
  skills: AvailableSkill[] | undefined,
): string {
  if (!skills?.length) return "";
  const xml = formatSkillXmlBlock("working_set_skills", skills);
  return `### Working set skills\n\nWhen relevant, load with \`skill_view\` before proceeding:\n${xml}`;
}
