import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentProjectionSelectionReason,
  IntentProjectionSupportReason,
} from "../types.js";
import type { QmdIntentHit } from "../qmd/intent-index.js";

export type {
  IntentProjectionSelectionReason,
  IntentProjectionSupportReason,
} from "../types.js";

export type IntentProjectionFallbackReason =
  | "empty-catalog"
  | "qmd-unavailable"
  | "qmd-no-trusted-recall"
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

const SELECTION_REASON_ORDER: readonly IntentProjectionSelectionReason[] = [
  "qmd-hit",
  "recent-history",
];

function resolveIntentId(value: string | undefined): string | undefined {
  return value?.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase();
}

function fullCatalogResult(
  intents: readonly IntentCatalogEntry[],
  fallbackReason: IntentProjectionFallbackReason,
  candidateIntents: Iterable<IntentCatalogEntry> = intents,
  selectionReasons: Iterable<IntentProjectionSelectionReason> = [],
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
    matchedKeywords: [],
    fallbackReason,
  };
}

export function getQmdCandidateLimits(intentCount: number): {
  smallK: number;
  largeK: number;
  rawLimit: number;
} {
  const baseK = Math.max(
    6,
    Math.min(12, Math.ceil(Math.log2(intentCount)) + 2),
  );
  const smallK = Math.min(intentCount, baseK);
  const largeK = Math.min(intentCount, Math.min(baseK * 2, 24));
  return { smallK, largeK, rawLimit: largeK * 2 };
}

export function projectQmdIntentCandidates(params: {
  intents: readonly IntentCatalogEntry[];
  qmdHits: readonly QmdIntentHit[] | undefined;
  histories: readonly HistoricalIntentRecord[];
  minCandidateScore: number;
  maxCandidates?: number;
}): IntentProjection {
  const intents = [...params.intents];
  if (intents.length === 0) return fullCatalogResult(intents, "empty-catalog");
  if (!params.qmdHits) return fullCatalogResult(intents, "qmd-unavailable");
  const trustedHits = params.qmdHits
    .filter((hit) => hit.score >= params.minCandidateScore)
    .sort((a, b) => b.score - a.score);
  if (trustedHits.length === 0) {
    return fullCatalogResult(intents, "qmd-no-trusted-recall");
  }

  const intentById = new Map(
    intents.map((intent) => [intent.id.toLowerCase(), intent]),
  );
  const reasonsById = new Map<string, Set<IntentProjectionSelectionReason>>();
  const add = (intentId: string, reason: IntentProjectionSelectionReason) => {
    const normalized = resolveIntentId(intentId);
    if (!normalized || !intentById.has(normalized)) return;
    const reasons = reasonsById.get(normalized) ?? new Set();
    reasons.add(reason);
    reasonsById.set(normalized, reasons);
  };

  const limit = params.maxCandidates ?? trustedHits.length;
  for (const hit of trustedHits.slice(0, limit)) {
    add(hit.intentId, "qmd-hit");
  }
  for (const historicalIntent of params.histories.slice(-2)) {
    add(historicalIntent.intent, "recent-history");
  }

  const candidateIntents = intents.filter((intent) =>
    reasonsById.has(intent.id.toLowerCase()),
  );
  const selectionReasons = SELECTION_REASON_ORDER.filter((reason) =>
    [...reasonsById.values()].some((reasons) => reasons.has(reason)),
  );
  const candidateSelections = candidateIntents.map((intent) => ({
    intentId: intent.id,
    selectionReasons: SELECTION_REASON_ORDER.filter((reason) =>
      reasonsById.get(intent.id.toLowerCase())?.has(reason),
    ),
    matchedKeywords: [],
  }));

  if (
    candidateIntents.length === 0 ||
    candidateIntents.length >= intents.length
  ) {
    return fullCatalogResult(
      intents,
      candidateIntents.length === 0 ? "empty-projection" : "no-reduction",
      candidateIntents,
      selectionReasons,
      candidateSelections,
      ["qmd-retrieval"],
    );
  }
  return {
    decision: "projected",
    originalIntentCount: intents.length,
    candidateIntentCount: candidateIntents.length,
    effectiveIntents: candidateIntents,
    candidateIntents,
    projected: true,
    supportReasons: ["qmd-retrieval"],
    selectionReasons,
    candidateSelections,
    matchedKeywords: [],
  };
}
