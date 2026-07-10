import type { AvailableSkill, RelatedSkillResult } from "./types.js";

export function relatedSkillsBySkillName(
  skills: readonly AvailableSkill[],
): Map<string, RelatedSkillResult[]> {
  const visibleSkills = new Map(
    skills.map((skill) => [skill.name.toLowerCase(), skill]),
  );
  const outgoingBySkill = new Map<string, RelatedSkillResult[]>();
  const incomingBySkill = new Map<string, RelatedSkillResult[]>();

  for (const skill of skills) {
    const skillName = skill.name.toLowerCase();
    for (const relation of skill.relatedSkills ?? []) {
      const target = visibleSkills.get(relation.name.toLowerCase());
      if (!target || target.name.toLowerCase() === skillName) continue;

      const outgoing = outgoingBySkill.get(skillName) ?? [];
      outgoing.push({
        name: target.name,
        reason: relation.reason,
        direction: "current-to-related",
      });
      outgoingBySkill.set(skillName, outgoing);

      const targetName = target.name.toLowerCase();
      const incoming = incomingBySkill.get(targetName) ?? [];
      incoming.push({
        name: skill.name,
        reason: relation.reason,
        direction: "related-to-current",
      });
      incomingBySkill.set(targetName, incoming);
    }
  }

  return new Map(
    skills.map((skill) => {
      const skillName = skill.name.toLowerCase();
      const incoming = incomingBySkill.get(skillName) ?? [];
      incoming.sort((left, right) => left.name.localeCompare(right.name));
      return [
        skillName,
        [...(outgoingBySkill.get(skillName) ?? []), ...incoming],
      ];
    }),
  );
}
