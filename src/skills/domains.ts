import type { IntentCatalogEntry } from "../types.js";

function normalizeSkillNames(names: readonly unknown[] | undefined): string[] {
  if (!names) return [];
  const normalized = names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(normalized)];
}

function frontmatterSkillNamesForIntent(intent: IntentCatalogEntry): string[] {
  return normalizeSkillNames(intent.definition.skills);
}

export function buildSkillDomainMap(
  intents: readonly IntentCatalogEntry[] | undefined,
): Map<string, string[]> {
  const domainsBySkill = new Map<string, Set<string>>();
  for (const intent of intents ?? []) {
    const domain = intent.definition.domain.trim();
    if (!domain) continue;
    for (const skillName of frontmatterSkillNamesForIntent(intent)) {
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
