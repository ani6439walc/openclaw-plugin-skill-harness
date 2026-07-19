import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentProjectionSelectionReason,
  IntentProjectionSupportReason,
} from "../types.js";
import type { TopicSwitchResult } from "./prompts.js";

export type {
  IntentProjectionSelectionReason,
  IntentProjectionSupportReason,
} from "../types.js";

export type IntentProjectionFallbackReason =
  | "empty-catalog"
  | "missing-topic-context"
  | "unknown-domain"
  | "historical-intent-missing"
  | "historical-intent-unavailable"
  | "insufficient-evidence"
  | "empty-projection"
  | "no-reduction"
  | "selector-error";

export interface IntentProjection {
  decision: "projected" | "full-fallback";
  originalIntentCount: number;
  candidateIntentCount: number;
  effectiveIntents: IntentCatalogEntry[];
  candidateIntents: IntentCatalogEntry[];
  projected: boolean;
  supportReasons: IntentProjectionSupportReason[];
  selectionReasons: IntentProjectionSelectionReason[];
  candidateSelections: Array<{
    intentId: string;
    selectionReasons: IntentProjectionSelectionReason[];
    matchedKeywords: string[];
  }>;
  matchedKeywords: string[];
  fallbackReason?: IntentProjectionFallbackReason;
}

interface ProjectIntentCandidatesParams {
  intents: readonly IntentCatalogEntry[];
  latest: string;
  topicContext?: TopicSwitchResult;
  latestHistoricalIntent?: HistoricalIntentRecord;
}

const HIGH_OVERALL_CONFIDENCE = 0.8;
const SELECTION_REASON_ORDER: readonly IntentProjectionSelectionReason[] = [
  "cross-flow",
  "predicted-domain",
  "authorized-history",
  "candidate-keyword",
  "intent-id",
];

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveIntentId(value: string | undefined): string | undefined {
  return value?.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase();
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    value,
  );
}

function isWordCodePoint(value: string): boolean {
  return /[\p{L}\p{M}\p{N}]/u.test(value);
}

function isSymbolPhraseBoundary(value: string | undefined): boolean {
  return value === undefined || /[\s\p{P}]/u.test(value);
}

function latestContainsBoundaryPhrase(latest: string, phrase: string): boolean {
  const phraseCodePoints = Array.from(phrase);
  const firstPhraseCodePoint = phraseCodePoints[0]!;
  const lastPhraseCodePoint = phraseCodePoints.at(-1)!;
  let index = latest.indexOf(phrase);
  while (index >= 0) {
    const before = Array.from(latest.slice(0, index)).at(-1);
    const after = Array.from(latest.slice(index + phrase.length))[0];
    const leftBoundary = isWordCodePoint(firstPhraseCodePoint)
      ? before === undefined || !isWordCodePoint(before)
      : isSymbolPhraseBoundary(before);
    const rightBoundary = isWordCodePoint(lastPhraseCodePoint)
      ? after === undefined || !isWordCodePoint(after)
      : isSymbolPhraseBoundary(after);
    if (leftBoundary && rightBoundary) return true;
    index = latest.indexOf(phrase, index + 1);
  }
  return false;
}

function latestContainsPhrase(latest: string, phrase: string): boolean {
  const normalizedLatest = normalizePhrase(latest);
  const normalizedPhrase = normalizePhrase(phrase);
  if (!normalizedLatest || !normalizedPhrase) return false;
  if (Array.from(normalizedPhrase).length === 1) {
    return normalizedLatest === normalizedPhrase;
  }
  if (containsCjk(normalizedPhrase)) {
    return normalizedLatest.includes(normalizedPhrase);
  }
  return latestContainsBoundaryPhrase(normalizedLatest, normalizedPhrase);
}

function topicKeywordsContainPhrase(
  topicKeywords: readonly string[],
  phrase: string,
): boolean {
  const normalizedPhrase = normalizePhrase(phrase);
  return (
    normalizedPhrase.length > 0 &&
    topicKeywords.some(
      (topicKeyword) => normalizePhrase(topicKeyword) === normalizedPhrase,
    )
  );
}

function fullCatalogResult(
  intents: readonly IntentCatalogEntry[],
  fallbackReason: IntentProjectionFallbackReason,
  candidateIntents: Iterable<IntentCatalogEntry> = intents,
  selectionReasons: Iterable<IntentProjectionSelectionReason> = [],
  matchedKeywords: Iterable<string> = [],
  candidateSelections: IntentProjection["candidateSelections"] = [],
  supportReasons: Iterable<IntentProjectionSupportReason> = [],
): IntentProjection {
  const candidates = [...candidateIntents];
  return {
    decision: "full-fallback",
    originalIntentCount: intents.length,
    candidateIntentCount: candidates.length,
    effectiveIntents: [...intents],
    candidateIntents: candidates,
    projected: false,
    supportReasons: [...supportReasons],
    selectionReasons: [...selectionReasons],
    candidateSelections,
    matchedKeywords: [...matchedKeywords],
    fallbackReason,
  };
}

export function projectIntentCandidates(
  params: ProjectIntentCandidatesParams,
): IntentProjection {
  const intents = [...params.intents];
  if (intents.length === 0) return fullCatalogResult(intents, "empty-catalog");
  if (!params.topicContext) {
    return fullCatalogResult(intents, "missing-topic-context");
  }

  const validDomain = intents.some(
    (intent) => intent.definition.domain === params.topicContext?.domain,
  );
  if (!validDomain) return fullCatalogResult(intents, "unknown-domain");

  const reasonsByIntent = new Map<
    IntentCatalogEntry,
    Set<IntentProjectionSelectionReason>
  >();
  const matchedKeywords = new Set<string>();
  const matchedKeywordsByIntent = new Map<IntentCatalogEntry, string[]>();
  const topicKeywords = params.topicContext.keywords;

  function addReason(
    intent: IntentCatalogEntry,
    reason: IntentProjectionSelectionReason,
  ): void {
    const reasons = reasonsByIntent.get(intent) ?? new Set();
    reasons.add(reason);
    reasonsByIntent.set(intent, reasons);
  }

  for (const intent of intents) {
    if (intent.definition.candidate?.scope === "cross-flow") {
      addReason(intent, "cross-flow");
    }
    if (intent.definition.domain === params.topicContext.domain) {
      addReason(intent, "predicted-domain");
    }

    const normalizedCandidateKeywords = new Set<string>();
    for (const keyword of intent.definition.candidate?.keywords ?? []) {
      const normalizedKeyword = normalizePhrase(keyword);
      if (
        !normalizedKeyword ||
        normalizedCandidateKeywords.has(normalizedKeyword)
      ) {
        continue;
      }
      normalizedCandidateKeywords.add(normalizedKeyword);
      if (
        latestContainsPhrase(params.latest, keyword) ||
        topicKeywordsContainPhrase(topicKeywords, keyword)
      ) {
        addReason(intent, "candidate-keyword");
        matchedKeywords.add(keyword);
        const intentMatches = matchedKeywordsByIntent.get(intent) ?? [];
        intentMatches.push(keyword);
        matchedKeywordsByIntent.set(intent, intentMatches);
      }
    }

    if (
      latestContainsPhrase(params.latest, intent.id) ||
      topicKeywordsContainPhrase(topicKeywords, intent.id)
    ) {
      addReason(intent, "intent-id");
    }
  }

  const lowConfidenceSameTopic =
    params.topicContext.reason === "same-topic" &&
    params.topicContext.confidence < HIGH_OVERALL_CONFIDENCE;
  let historicalIntentAvailable = false;
  if (lowConfidenceSameTopic && params.latestHistoricalIntent) {
    const historicalIntentId = resolveIntentId(
      params.latestHistoricalIntent.intent,
    );
    const historicalIntent = intents.find(
      (intent) => intent.id.toLowerCase() === historicalIntentId,
    );
    if (historicalIntent) {
      historicalIntentAvailable = true;
      addReason(historicalIntent, "authorized-history");
    }
  }

  const candidateIntents = intents.filter((intent) =>
    reasonsByIntent.has(intent),
  );
  const selectionReasons = SELECTION_REASON_ORDER.filter((reason) =>
    [...reasonsByIntent.values()].some((reasons) => reasons.has(reason)),
  );
  const candidateSelections = candidateIntents.map((intent) => ({
    intentId: intent.id,
    selectionReasons: SELECTION_REASON_ORDER.filter((reason) =>
      reasonsByIntent.get(intent)?.has(reason),
    ),
    matchedKeywords: [...(matchedKeywordsByIntent.get(intent) ?? [])],
  }));
  const supportReasons: IntentProjectionSupportReason[] = [];
  if (params.topicContext.confidence >= HIGH_OVERALL_CONFIDENCE) {
    supportReasons.push("high-overall-confidence");
  }
  if (lowConfidenceSameTopic && historicalIntentAvailable) {
    supportReasons.push("authorized-history");
  }
  if (
    selectionReasons.includes("candidate-keyword") ||
    selectionReasons.includes("intent-id")
  ) {
    supportReasons.push("exact-evidence");
  }

  if (supportReasons.length === 0) {
    if (lowConfidenceSameTopic && !params.latestHistoricalIntent) {
      return fullCatalogResult(
        intents,
        "historical-intent-missing",
        candidateIntents,
        selectionReasons,
        matchedKeywords,
        candidateSelections,
      );
    }
    if (lowConfidenceSameTopic && !historicalIntentAvailable) {
      return fullCatalogResult(
        intents,
        "historical-intent-unavailable",
        candidateIntents,
        selectionReasons,
        matchedKeywords,
        candidateSelections,
      );
    }
    return fullCatalogResult(
      intents,
      "insufficient-evidence",
      candidateIntents,
      selectionReasons,
      matchedKeywords,
      candidateSelections,
    );
  }
  if (candidateIntents.length === 0) {
    return fullCatalogResult(intents, "empty-projection");
  }
  if (candidateIntents.length >= intents.length) {
    return fullCatalogResult(
      intents,
      "no-reduction",
      candidateIntents,
      selectionReasons,
      matchedKeywords,
      candidateSelections,
      supportReasons,
    );
  }

  return {
    decision: "projected",
    originalIntentCount: intents.length,
    candidateIntentCount: candidateIntents.length,
    effectiveIntents: candidateIntents,
    candidateIntents,
    projected: true,
    supportReasons,
    selectionReasons,
    candidateSelections,
    matchedKeywords: [...matchedKeywords],
  };
}
