export type TriggerKeywordTarget =
  "successful-pattern" | "behavior-fix" | "entity-context";

export type ReviewTriggerKeywords = {
  successfulPattern: string[];
  behaviorFix: string[];
  entityContext: string[];
};

export const DEFAULT_REVIEW_TRIGGER_KEYWORDS: ReviewTriggerKeywords = {
  behaviorFix: [
    "不對",
    "不是",
    "應該是",
    "你誤會了",
    "wrong",
    "incorrect",
    "should be",
    "you misunderstood",
  ],
  successfulPattern: [
    "完成",
    "解決",
    "修好",
    "通過",
    "驗證",
    "成功",
    "可以了",
    "completed",
    "fixed",
    "resolved",
    "passed",
    "verified",
    "done",
  ],
  entityContext: [
    "指的是",
    "代表的是",
    "其實是",
    "以後看到",
    "下次遇到",
    "先看",
    "先去看",
    "應該看",
    "記在",
    "記錄在",
    "memory 裡",
    "記憶裡",
    "experience 內",
    "refers to",
    "means",
    "alias",
    "look up",
    "check",
    "看看",
    "看一下",
    "看下",
  ],
};

export function normalizeKeywordList(
  values: unknown,
  fallback: string[],
): string[] {
  if (values === undefined || values === null) return [...fallback];
  if (!Array.isArray(values) && typeof values !== "string")
    return [...fallback];
  const rawValues = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? [values]
      : [];
  const normalized = [
    ...new Map(
      rawValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [value.toLocaleLowerCase(), value] as const),
    ).values(),
  ];
  return normalized;
}

export function normalizeReviewTriggerKeywords(
  value: unknown,
  fallback: ReviewTriggerKeywords = DEFAULT_REVIEW_TRIGGER_KEYWORDS,
): ReviewTriggerKeywords {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    behaviorFix: normalizeKeywordList(record.behaviorFix, fallback.behaviorFix),
    successfulPattern: normalizeKeywordList(
      record.successfulPattern,
      fallback.successfulPattern,
    ),
    entityContext: normalizeKeywordList(
      record.entityContext,
      fallback.entityContext,
    ),
  };
}

export function mergeReviewTriggerKeywordSeeds(
  base: ReviewTriggerKeywords,
  seed: unknown,
): ReviewTriggerKeywords {
  const seedRecord =
    seed && typeof seed === "object" ? (seed as Record<string, unknown>) : {};
  return normalizeReviewTriggerKeywords(
    {
      behaviorFix:
        seedRecord.behaviorFix === undefined
          ? base.behaviorFix
          : seedRecord.behaviorFix,
      successfulPattern:
        seedRecord.successfulPattern === undefined
          ? base.successfulPattern
          : seedRecord.successfulPattern,
      entityContext:
        seedRecord.entityContext === undefined
          ? base.entityContext
          : seedRecord.entityContext,
    },
    base,
  );
}
