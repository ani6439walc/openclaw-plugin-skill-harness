import type { IntentCatalogEntry } from "../types.js";
import { listAvailableSkills } from "./indexer.js";
import { relatedSkillsBySkillName } from "./related.js";
import { skillSourcePriority } from "./types.js";
import type {
  AvailableSkill,
  RelatedSkillResult,
  SkillResolutionParams,
  SkillSource,
  SkillUsageStats,
} from "./types.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_INTENT_FIELD_MATCHES = 3;

export interface SkillIntentReference {
  id: string;
  domain: string;
  triggers: string[];
  examples: string[];
  fastpathKeywords: string[];
}

export interface SkillSearchDocument {
  skill: AvailableSkill;
  relatedSkills: RelatedSkillResult[];
  intentReferences: SkillIntentReference[];
  usageTurns: number;
  usageStats?: SkillUsageStats;
}

export interface SkillSearchParams {
  query?: string;
  source?: SkillSource;
  domains?: string[];
  keywords?: string[];
  limit?: number;
  offset?: number;
  showStats?: boolean;
  showRelated?: boolean;
  showMatches?: boolean;
}

export interface SearchAvailableSkillsParams
  extends SkillResolutionParams, SkillSearchParams {}

export interface MatchedIntent {
  id: string;
  domain: string;
  triggers: string[];
  examples: string[];
  fastpath_keywords: string[];
}

export interface SkillSearchResultItem {
  name: string;
  description: string;
  source?: SkillSource;
  domains: string[];
  score: number;
  usage_stats?: SkillUsageStats;
  related_skills?: RelatedSkillResult[];
  matched_fields?: string[];
  matched_intents?: MatchedIntent[];
}

export type SkillSearchResult =
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      query: string;
      total: number;
      count: number;
      offset: number;
      limit: number;
      has_more: boolean;
      next_offset?: number;
      skills: SkillSearchResultItem[];
    };

interface SearchCriteria {
  phrase: string;
  tokens: string[];
  domains: string[];
  source?: SkillSource;
  hasText: boolean;
}

interface ScoredDocument {
  document: SkillSearchDocument;
  score: number;
  matchedFields: string[];
  matchedIntents: MatchedIntent[];
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function normalizedStrings(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeSearchText(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function searchTokens(query: string, keywords: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const value of [query, ...keywords]) {
    for (const token of value.split(" ")) {
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}

function buildSearchCriteria(
  params: SkillSearchParams,
): SearchCriteria | undefined {
  const phrase = normalizeSearchText(params.query ?? "");
  const keywords = normalizedStrings(params.keywords);
  const domains = normalizedStrings(params.domains);
  const tokens = searchTokens(phrase, keywords);
  const source = params.source;
  if (!phrase && tokens.length === 0 && domains.length === 0 && !source) {
    return;
  }
  return {
    phrase,
    tokens,
    domains,
    source,
    hasText: Boolean(phrase || tokens.length),
  };
}

function textMatches(
  value: string,
  phrase: string,
  tokens: readonly string[],
): boolean {
  const normalized = normalizeSearchText(value);
  return Boolean(
    (phrase && normalized.includes(phrase)) ||
    tokens.some((token) => normalized.includes(token)),
  );
}

function nameTokens(name: string): string[] {
  return normalizeSearchText(name).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function nameScore(
  name: string,
  phrase: string,
  tokens: readonly string[],
): number {
  const normalized = normalizeSearchText(name);
  const terms = [...new Set([phrase, ...tokens].filter(Boolean))];
  if (terms.some((term) => normalized === term)) return 100;
  if (terms.some((term) => normalized.startsWith(term))) return 70;
  const parts = new Set(nameTokens(normalized));
  if (terms.some((term) => parts.has(term))) return 45;
  return 0;
}

function matchingIntentReferences(
  references: readonly SkillIntentReference[],
  field: "triggers" | "examples" | "fastpathKeywords",
  phrase: string,
  tokens: readonly string[],
): SkillIntentReference[] {
  return [...references]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((reference) =>
      reference[field].some((value) => textMatches(value, phrase, tokens)),
    )
    .slice(0, MAX_INTENT_FIELD_MATCHES);
}

function matchedIntentOutput(
  references: readonly SkillIntentReference[],
): MatchedIntent[] {
  const unique = new Map<string, SkillIntentReference>();
  for (const reference of references) unique.set(reference.id, reference);
  return [...unique.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((reference) => ({
      id: reference.id,
      domain: reference.domain,
      triggers: reference.triggers,
      examples: reference.examples,
      fastpath_keywords: reference.fastpathKeywords,
    }));
}

function scoreDocument(
  document: SkillSearchDocument,
  criteria: SearchCriteria,
): ScoredDocument | undefined {
  const domains = normalizedStrings(document.skill.domains);
  if (
    criteria.domains.length > 0 &&
    !criteria.domains.some((domain) => domains.includes(domain))
  ) {
    return;
  }

  const matchedFields: string[] = [];
  let lexicalScore = 0;

  const skillNameScore = nameScore(
    document.skill.name,
    criteria.phrase,
    criteria.tokens,
  );
  if (skillNameScore > 0) {
    lexicalScore += skillNameScore;
    matchedFields.push("name");
  }

  const normalizedDescription = normalizeSearchText(document.skill.description);
  const descriptionPhraseMatch = Boolean(
    criteria.phrase && normalizedDescription.includes(criteria.phrase),
  );
  const descriptionTokenMatch = criteria.tokens.some((token) =>
    normalizedDescription.includes(token),
  );
  if (descriptionPhraseMatch || descriptionTokenMatch) {
    lexicalScore +=
      (descriptionPhraseMatch ? 30 : 0) + (descriptionTokenMatch ? 10 : 0);
    matchedFields.push("description");
  }

  const domainMatch = domains.some(
    (domain) =>
      (criteria.phrase && domain === criteria.phrase) ||
      criteria.tokens.includes(domain),
  );
  if (domainMatch) {
    lexicalScore += 35;
    matchedFields.push("domains");
  }

  const triggerMatches = matchingIntentReferences(
    document.intentReferences,
    "triggers",
    criteria.phrase,
    criteria.tokens,
  );
  if (triggerMatches.length > 0) {
    lexicalScore += triggerMatches.length * 25;
    matchedFields.push("intent.triggers");
  }

  const exampleMatches = matchingIntentReferences(
    document.intentReferences,
    "examples",
    criteria.phrase,
    criteria.tokens,
  );
  if (exampleMatches.length > 0) {
    lexicalScore += exampleMatches.length * 20;
    matchedFields.push("intent.examples");
  }

  const fastpathMatches = matchingIntentReferences(
    document.intentReferences,
    "fastpathKeywords",
    criteria.phrase,
    criteria.tokens,
  );
  if (fastpathMatches.length > 0) {
    lexicalScore += fastpathMatches.length * 25;
    matchedFields.push("intent.fastpath_keywords");
  }

  const relatedMatch = document.relatedSkills.some((related) =>
    textMatches(related.name, criteria.phrase, criteria.tokens),
  );
  if (relatedMatch) {
    lexicalScore += 15;
    matchedFields.push("related_skills");
  }

  if (criteria.hasText && lexicalScore === 0) return;

  const usageTurns = Math.max(0, document.usageTurns);
  const usageBoost = Math.min(10, Math.floor(Math.log2(usageTurns + 1)));
  return {
    document,
    score: lexicalScore + usageBoost,
    matchedFields,
    matchedIntents: matchedIntentOutput([
      ...triggerMatches,
      ...exampleMatches,
      ...fastpathMatches,
    ]),
  };
}

function resultItem(
  scored: ScoredDocument,
  params: SkillSearchParams,
): SkillSearchResultItem {
  const { document } = scored;
  const showMatches = params.showMatches !== false;
  return {
    name: document.skill.name,
    description: document.skill.description,
    source: document.skill.source,
    domains: document.skill.domains ?? [],
    score: scored.score,
    ...(params.showStats && document.usageStats
      ? { usage_stats: document.usageStats }
      : {}),
    ...(params.showRelated ? { related_skills: document.relatedSkills } : {}),
    ...(showMatches
      ? {
          matched_fields: scored.matchedFields,
          ...(scored.matchedIntents.length > 0
            ? { matched_intents: scored.matchedIntents }
            : {}),
        }
      : {}),
  };
}

export function searchSkillDocuments(
  documents: readonly SkillSearchDocument[],
  params: SkillSearchParams,
): SkillSearchResult {
  const criteria = buildSearchCriteria(params);
  if (!criteria) {
    return {
      success: false,
      error: "query or at least one filter is required",
    };
  }

  const scored = documents
    .filter(
      (document) =>
        !criteria.source || document.skill.source === criteria.source,
    )
    .map((document) => scoreDocument(document, criteria))
    .filter((result): result is ScoredDocument => result !== undefined)
    .sort((left, right) => {
      const scoreComparison = right.score - left.score;
      if (scoreComparison !== 0) return scoreComparison;
      const sourceComparison =
        skillSourcePriority(left.document.skill.source) -
        skillSourcePriority(right.document.skill.source);
      if (sourceComparison !== 0) return sourceComparison;
      const usageComparison =
        right.document.usageTurns - left.document.usageTurns;
      if (usageComparison !== 0) return usageComparison;
      return left.document.skill.name.localeCompare(right.document.skill.name);
    });

  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const requestedLimit = Math.trunc(params.limit ?? DEFAULT_SEARCH_LIMIT);
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, requestedLimit));
  const page = scored.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < scored.length;

  return {
    success: true,
    query: criteria.phrase,
    total: scored.length,
    count: page.length,
    offset,
    limit,
    has_more: hasMore,
    ...(hasMore ? { next_offset: nextOffset } : {}),
    skills: page.map((item) => resultItem(item, params)),
  };
}

function frontmatterSkillNames(intent: IntentCatalogEntry): string[] {
  return intent.definition.skills ?? [];
}

export function buildSkillIntentReferenceMap(
  intents: readonly IntentCatalogEntry[] | undefined,
): Map<string, SkillIntentReference[]> {
  const references = new Map<string, SkillIntentReference[]>();
  for (const intent of intents ?? []) {
    const reference: SkillIntentReference = {
      id: intent.id,
      domain: intent.definition.domain,
      triggers: intent.definition.triggers,
      examples: intent.definition.examples,
      fastpathKeywords: intent.definition.fastpath.keywords,
    };
    const names = new Set(
      frontmatterSkillNames(intent)
        .map((name) => normalizeSearchText(name))
        .filter(Boolean),
    );
    for (const name of names) {
      const existing = references.get(name) ?? [];
      existing.push(reference);
      references.set(name, existing);
    }
  }
  return references;
}

export async function searchAvailableSkills(
  params: SearchAvailableSkillsParams,
): Promise<SkillSearchResult> {
  const usageStats = await readSkillUsageStats(params);
  const skills = await listAvailableSkills({
    ...params,
    usageStats,
  });
  const relatedSkills = relatedSkillsBySkillName(skills);
  const intentReferences = buildSkillIntentReferenceMap(params.intents);
  const documents = skills.map((skill): SkillSearchDocument => {
    const stats = skillUsageStatsForName(usageStats, skill.name);
    return {
      skill,
      relatedSkills: relatedSkills.get(skill.name.toLowerCase()) ?? [],
      intentReferences:
        intentReferences.get(normalizeSearchText(skill.name)) ?? [],
      usageTurns: stats.usage_turns,
      usageStats: stats,
    };
  });
  return searchSkillDocuments(documents, params);
}
