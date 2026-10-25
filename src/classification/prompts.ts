import { canonicalIdentity } from "../normalize.js";
import type { RelationDecision } from "../skills/related.js";
import {
  DEFAULT_RELATION_RELEVANCE_THRESHOLD,
  ROUTING_ADVISORY_SKILLS_ONLY_HEADER,
  ROUTING_ADVISORY_SKILLS_AND_EXPERIENCES_HEADER,
  ROUTING_ADVISORY_EXPERIENCES_ONLY_HEADER,
  SKILL_HARNESS_PLUGIN_TAG,
} from "../constants.js";
import { xmlBlock } from "../xml-format.js";
import type { SkillExperienceEntry } from "../experiences/types.js";
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

function formatExperienceXml(experience: SkillExperienceEntry): string {
  const attrs = [
    `id="${escapeXmlAttribute(experience.id)}"`,
    ...(experience.skills.length > 0
      ? [`skills="${escapeXmlAttribute(experience.skills.join(","))}"`]
      : []),
  ];
  return xmlBlock(
    "experience",
    escapeXmlText(experience.summary),
    ` ${attrs.join(" ")}`,
  );
}

export function formatMatchedExperiences(
  experiences: readonly SkillExperienceEntry[],
): string {
  if (experiences.length === 0) return "";
  const lines = experiences.map((exp) => formatExperienceXml(exp));
  return xmlBlock("matched_experiences", lines.join("\n"));
}

function formatSkillXml(
  skill: AvailableSkill,
  relations: readonly RelationDecision[] = [],
  experiences: readonly SkillExperienceEntry[] = [],
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
  lines.push(...experiences.map(formatExperienceXml));
  return xmlBlock(
    "skill",
    lines.join("\n"),
    ` name="${escapeXmlAttribute(skill.name)}"`,
  );
}

function formatSkillXmlBlock(
  tag: string,
  skills: AvailableSkill[] | undefined,
  attributes = "",
  relations: readonly RelationDecision[] = [],
  experiencesBySkill: ReadonlyMap<
    string,
    readonly SkillExperienceEntry[]
  > = new Map(),
  relationRelevanceThreshold = DEFAULT_RELATION_RELEVANCE_THRESHOLD,
): string {
  const body = skills
    ?.map((skill) =>
      formatSkillXml(
        skill,
        relations,
        experiencesBySkill.get(skill.name),
        relationRelevanceThreshold,
      ),
    )
    .join("\n");
  return xmlBlock(tag, body ?? "", attributes);
}

export function formatMatchedSkills(skills: readonly AvailableSkill[]): string {
  if (skills.length === 0) return "";
  return formatSkillXmlBlock("matched_skills", [...skills], "");
}

export function formatInputMatchedSkills(
  skills: readonly AvailableSkill[],
): string {
  if (skills.length === 0) return "";
  return formatSkillXmlBlock("matched_skills", [...skills], "");
}

function selectAdvisoryHeader(
  hasSkills: boolean,
  hasExperiences: boolean,
): string {
  if (hasSkills && hasExperiences)
    return ROUTING_ADVISORY_SKILLS_AND_EXPERIENCES_HEADER;
  if (hasExperiences) return ROUTING_ADVISORY_EXPERIENCES_ONLY_HEADER;
  return ROUTING_ADVISORY_SKILLS_ONLY_HEADER;
}

export function buildRoutingContext(params: {
  matchedSkills?: readonly AvailableSkill[];
  inputMatchedSkills?: readonly AvailableSkill[];
  experiences?: readonly SkillExperienceEntry[];
  relationDecisions?: readonly RelationDecision[];
  relationRelevanceThreshold?: number;
}): string {
  const matchedSkills: readonly AvailableSkill[] =
    params.matchedSkills ?? params.inputMatchedSkills ?? [];
  const experiences = [
    ...new Map(
      (params.experiences ?? []).map((experience) => [
        experience.id,
        experience,
      ]),
    ).values(),
  ];
  const experiencesBySkill = new Map<string, SkillExperienceEntry[]>();
  const standalone: SkillExperienceEntry[] = [];
  for (const experience of experiences) {
    // matchedSkills is in descending selector score order, with stable name ties.
    const anchor = matchedSkills.find((skill) =>
      experience.skills.some(
        (name) => canonicalIdentity(name) === canonicalIdentity(skill.name),
      ),
    );
    if (!anchor) {
      standalone.push(experience);
      continue;
    }
    const entries = experiencesBySkill.get(anchor.name) ?? [];
    entries.push(experience);
    experiencesBySkill.set(anchor.name, entries);
  }

  if (matchedSkills.length === 0 && experiences.length === 0) return "";

  const header = selectAdvisoryHeader(
    matchedSkills.length > 0,
    experiences.length > 0,
  );
  const blocks: string[] = [header];
  if (standalone.length > 0) {
    blocks.push(formatMatchedExperiences(standalone));
  }
  if (matchedSkills.length > 0) {
    blocks.push(
      formatSkillXmlBlock(
        "matched_skills",
        [...matchedSkills],
        "",
        params.relationDecisions,
        experiencesBySkill,
        params.relationRelevanceThreshold,
      ),
    );
  }

  return xmlBlock(SKILL_HARNESS_PLUGIN_TAG, blocks.join("\n"));
}

export function formatWorkingSetSkills(
  skills: AvailableSkill[] | undefined,
): string {
  if (!skills?.length) return "";
  const xml = formatSkillXmlBlock("working_set_skills", skills);
  return `### Working set skills\n\nWhen relevant, load with \`skill_view\` before proceeding:\n${xml}`;
}
