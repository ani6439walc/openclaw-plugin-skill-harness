import type { IntentCatalogEntry } from "../types.js";

const SKILL_REF_RE = /\bskill:\s*([A-Za-z0-9_-]+)/gi;

export function extractReferencedSkillNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(SKILL_REF_RE)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function normalizeSkillNames(names: readonly unknown[] | undefined): string[] {
  if (!names) return [];
  const normalized = names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(normalized)];
}

function referencedSkillNamesForIntent(intent: IntentCatalogEntry): string[] {
  return [
    ...normalizeSkillNames(intent.definition.skills),
    ...extractReferencedSkillNames(intent.definition.prompt),
  ];
}

export function buildSkillDomainMap(
  intents: readonly IntentCatalogEntry[] | undefined,
): Map<string, string[]> {
  const domainsBySkill = new Map<string, Set<string>>();
  for (const intent of intents ?? []) {
    const domain = intent.definition.domain.trim();
    if (!domain) continue;
    for (const skillName of referencedSkillNamesForIntent(intent)) {
      const key = skillName.toLowerCase();
      const domains = domainsBySkill.get(key) ?? new Set<string>();
      domains.add(domain);
      domainsBySkill.set(key, domains);
    }
  }

  return new Map(
    [...domainsBySkill.entries()].map(([skillName, domains]) => [
      skillName,
      [...domains].sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

export function domainsForSkill(
  domainsBySkill: ReadonlyMap<string, readonly string[]>,
  skillName: string,
): string[] {
  return [...(domainsBySkill.get(skillName.trim().toLowerCase()) ?? [])];
}
