import type { ReviewTrigger } from "./triggers.js";
import type { ReviewSnapshot } from "./types.js";

type CatalogEntry = ReviewSnapshot["intentCatalog"][number];

export type CatalogSelectionReason =
  | "matched-intent"
  | "observed-intent"
  | "observed-domain"
  | "exact-fastpath-keyword-overlap";

export type CatalogProjectionFallbackReason =
  | "trigger-requires-full-catalog"
  | "matched-intent-missing"
  | "same-domain-neighbor-missing"
  | "cross-domain-keyword-neighbor-missing"
  | "omission-threshold-not-met";

export interface ProjectedCatalogEntry {
  entry: CatalogEntry;
  selectionReasons?: CatalogSelectionReason[];
}

export interface CatalogProjection {
  mode: "full" | "projected";
  originalCount: number;
  includedCount: number;
  omittedCount: number;
  fallbackReason?: CatalogProjectionFallbackReason;
  entries: ProjectedCatalogEntry[];
}

const FULL_CATALOG_TRIGGERS = new Set<ReviewTrigger>([
  "missing-intent",
  "weak-intent",
]);

const PROJECTED_CATALOG_TRIGGERS = new Set<ReviewTrigger>([
  "skill-candidate",
  "behavior-fix",
  "satisfaction-check",
]);

const SELECTION_REASON_ORDER: readonly CatalogSelectionReason[] = [
  "matched-intent",
  "observed-intent",
  "observed-domain",
  "exact-fastpath-keyword-overlap",
];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function catalogEntryTieBreakKey(entry: CatalogEntry): string {
  return JSON.stringify([
    entry.domain ?? null,
    entry.triggers ?? [],
    entry.examples ?? [],
    entry.fastpath?.keywords ?? [],
    entry.fastpath?.hint ?? null,
    entry.candidate?.scope ?? null,
    entry.candidate?.keywords ?? [],
  ]);
}

function compareCatalogEntries(
  left: CatalogEntry,
  right: CatalogEntry,
): number {
  return (
    compareStrings(left.id, right.id) ||
    compareStrings(
      catalogEntryTieBreakKey(left),
      catalogEntryTieBreakKey(right),
    )
  );
}

function normalizeDomain(value: string | undefined): string {
  return value?.normalize("NFKC").trim().toLowerCase() ?? "";
}

function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function fullCatalog(
  intentCatalog: readonly CatalogEntry[],
  fallbackReason?: CatalogProjectionFallbackReason,
): CatalogProjection {
  return {
    mode: "full",
    originalCount: intentCatalog.length,
    includedCount: intentCatalog.length,
    omittedCount: 0,
    ...(fallbackReason ? { fallbackReason } : {}),
    entries: intentCatalog.map((entry) => ({ entry })),
  };
}

function observedStates(snapshot: ReviewSnapshot) {
  return [snapshot.current, ...snapshot.recent];
}

export function projectIntentCatalog(
  snapshot: ReviewSnapshot,
  requestedTriggers: readonly ReviewTrigger[],
): CatalogProjection {
  const intentCatalog = snapshot.intentCatalog;
  if (requestedTriggers.some((trigger) => FULL_CATALOG_TRIGGERS.has(trigger))) {
    return fullCatalog(intentCatalog, "trigger-requires-full-catalog");
  }
  if (
    !requestedTriggers.some((trigger) =>
      PROJECTED_CATALOG_TRIGGERS.has(trigger),
    )
  ) {
    return fullCatalog(intentCatalog);
  }

  const observedIntentIds = new Set<string>();
  const observedDomains = new Set<string>();
  const observedKeywords = new Set<string>();
  for (const state of observedStates(snapshot)) {
    const intent = state.intent;
    if (!intent) continue;
    if (intent.intent) observedIntentIds.add(intent.intent);
    const domain = normalizeDomain(intent.domain);
    if (domain) observedDomains.add(domain);
    for (const keyword of intent.keywords ?? []) {
      const normalized = normalizeKeyword(keyword);
      if (normalized) observedKeywords.add(normalized);
    }
  }

  const matchedIntentId = snapshot.matchedIntent?.id;
  const uniqueCatalog = [...intentCatalog]
    .sort(compareCatalogEntries)
    .filter(
      (entry, index, entries) =>
        index === 0 || entries[index - 1]?.id !== entry.id,
    );
  const reasonsByIntentId = new Map<string, Set<CatalogSelectionReason>>();
  const addReason = (intentId: string, reason: CatalogSelectionReason) => {
    const reasons = reasonsByIntentId.get(intentId) ?? new Set();
    reasons.add(reason);
    reasonsByIntentId.set(intentId, reasons);
  };

  for (const entry of uniqueCatalog) {
    if (entry.id === matchedIntentId) addReason(entry.id, "matched-intent");
    if (observedIntentIds.has(entry.id)) addReason(entry.id, "observed-intent");

    const domain = normalizeDomain(entry.domain);
    if (domain && observedDomains.has(domain)) {
      addReason(entry.id, "observed-domain");
    }

    const hasExactKeywordOverlap = (entry.fastpath?.keywords ?? []).some(
      (keyword) => observedKeywords.has(normalizeKeyword(keyword)),
    );
    if (hasExactKeywordOverlap) {
      addReason(entry.id, "exact-fastpath-keyword-overlap");
    }
  }

  const selectedEntries = uniqueCatalog
    .filter((entry) => reasonsByIntentId.has(entry.id))
    .map((entry) => ({
      entry,
      selectionReasons: SELECTION_REASON_ORDER.filter((reason) =>
        reasonsByIntentId.get(entry.id)?.has(reason),
      ),
    }));

  if (
    !matchedIntentId ||
    !selectedEntries.some((candidate) => candidate.entry.id === matchedIntentId)
  ) {
    return fullCatalog(intentCatalog, "matched-intent-missing");
  }

  const hasSameDomainNeighbor = selectedEntries.some((candidate) => {
    const domain = normalizeDomain(candidate.entry.domain);
    return (
      candidate.entry.id !== matchedIntentId &&
      Boolean(domain) &&
      observedDomains.has(domain)
    );
  });
  if (!hasSameDomainNeighbor) {
    return fullCatalog(intentCatalog, "same-domain-neighbor-missing");
  }

  const hasCrossDomainKeywordNeighbor = selectedEntries.some((candidate) => {
    const domain = normalizeDomain(candidate.entry.domain);
    return (
      candidate.entry.id !== matchedIntentId &&
      Boolean(domain) &&
      !observedDomains.has(domain) &&
      candidate.selectionReasons.includes("exact-fastpath-keyword-overlap")
    );
  });
  if (!hasCrossDomainKeywordNeighbor) {
    return fullCatalog(intentCatalog, "cross-domain-keyword-neighbor-missing");
  }

  const omittedCount = intentCatalog.length - selectedEntries.length;
  if (omittedCount < 3) {
    return fullCatalog(intentCatalog, "omission-threshold-not-met");
  }

  return {
    mode: "projected",
    originalCount: intentCatalog.length,
    includedCount: selectedEntries.length,
    omittedCount,
    entries: selectedEntries,
  };
}
