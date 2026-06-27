export type TriggerKeywordTarget = "successful-pattern" | "behavior-fix";

export type EvolutionTriggerKeywords = {
  successfulPattern: string[];
  behaviorFix: string[];
};

export const DEFAULT_EVOLUTION_TRIGGER_KEYWORDS: EvolutionTriggerKeywords = {
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
};

export function normalizeKeywordList(
  values: unknown,
  fallback: string[],
): string[] {
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
  return normalized.length > 0 ? normalized : [...fallback];
}

export function normalizeEvolutionTriggerKeywords(
  value: unknown,
): EvolutionTriggerKeywords {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    behaviorFix: normalizeKeywordList(
      record.behaviorFix,
      DEFAULT_EVOLUTION_TRIGGER_KEYWORDS.behaviorFix,
    ),
    successfulPattern: normalizeKeywordList(
      record.successfulPattern,
      DEFAULT_EVOLUTION_TRIGGER_KEYWORDS.successfulPattern,
    ),
  };
}
