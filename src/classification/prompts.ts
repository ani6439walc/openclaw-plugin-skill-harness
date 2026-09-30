import {
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

function formatSkillXml(skill: AvailableSkill): string {
  const lines: string[] = [];
  if (skill.description) {
    lines.push(escapeXmlText(skill.description));
  }
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
): string {
  const body = skills?.map((skill) => formatSkillXml(skill)).join("\n");
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
}): string {
  const matchedSkills: readonly AvailableSkill[] =
    params.matchedSkills ?? params.inputMatchedSkills ?? [];
  const experiences = params.experiences ?? [];

  if (matchedSkills.length === 0 && experiences.length === 0) return "";

  const blocks: string[] = [];
  if (experiences.length > 0) {
    blocks.push(formatMatchedExperiences(experiences));
  }
  if (matchedSkills.length > 0) {
    blocks.push(formatInputMatchedSkills(matchedSkills));
  }

  const taggedContent = xmlBlock(SKILL_HARNESS_PLUGIN_TAG, blocks.join("\n"));
  const header = selectAdvisoryHeader(
    matchedSkills.length > 0,
    experiences.length > 0,
  );
  return `${header}\n${taggedContent}`;
}

export function formatWorkingSetSkills(
  skills: AvailableSkill[] | undefined,
): string {
  if (!skills?.length) return "";
  const xml = formatSkillXmlBlock("working_set_skills", skills);
  return `### Working set skills\n\nWhen relevant, load with \`skill_view\` before proceeding:\n${xml}`;
}
