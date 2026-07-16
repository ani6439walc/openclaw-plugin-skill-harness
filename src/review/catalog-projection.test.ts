import { describe, expect, it } from "vitest";
import { projectIntentCatalog } from "./catalog-projection.js";
import type { ReviewSnapshot } from "./types.js";

type CatalogEntry = ReviewSnapshot["intentCatalog"][number];

function catalogEntry(
  id: string,
  domain: string,
  keywords: string[] = [],
): CatalogEntry {
  return {
    id,
    domain,
    triggers: [`trigger ${id}`],
    examples: [`example ${id}`],
    fastpath: { keywords },
  };
}

const projectionCatalog = [
  catalogEntry("omitted-z", "other"),
  catalogEntry("matched", " Development ", [" review "]),
  catalogEntry("same-domain", "development"),
  catalogEntry("cross-keyword", "operations", [" Ｒｅｖｉｅｗ "]),
  catalogEntry("observed-route", "Research"),
  catalogEntry("omitted-a", "other"),
  catalogEntry("omitted-m", "other"),
  catalogEntry("omitted-extra", "other"),
];

function snapshot(
  intentCatalog: CatalogEntry[] = projectionCatalog,
): ReviewSnapshot {
  return {
    sessionId: "session",
    eventId: "event",
    turnNumber: 2,
    current: {
      intent: {
        intent: "matched",
        domain: "development",
        confidence: 0.9,
        complexity: "medium",
        reason: "matched",
        keywords: ["Review"],
      },
    },
    recent: [
      {
        intent: {
          intent: "observed-route",
          domain: "research",
          confidence: 0.8,
          complexity: "medium",
          reason: "recent",
          keywords: ["review"],
        },
      },
    ],
    matchedIntent: {
      id: "matched",
      definition: {
        domain: "development",
        triggers: [],
        examples: [],
        fastpath: { keywords: [] },
        prompt: "matched body",
      },
    },
    intentCatalog,
  };
}

describe("projectIntentCatalog", () => {
  it.each(["missing-intent", "weak-intent"] as const)(
    "forces the complete catalog when a multi-trigger run contains %s",
    (trigger) => {
      const input = snapshot();
      const result = projectIntentCatalog(input, ["behavior-fix", trigger]);

      expect(result).toEqual({
        mode: "full",
        originalCount: projectionCatalog.length,
        includedCount: projectionCatalog.length,
        omittedCount: 0,
        fallbackReason: "trigger-requires-full-catalog",
        entries: projectionCatalog.map((entry) => ({ entry })),
      });
    },
  );

  it("builds a deterministic reason union and sorts projected entries by intent ID", () => {
    const result = projectIntentCatalog(snapshot(), ["behavior-fix"]);

    expect(result).toEqual({
      mode: "projected",
      originalCount: 8,
      includedCount: 4,
      omittedCount: 4,
      entries: [
        {
          entry: projectionCatalog[3],
          selectionReasons: ["exact-fastpath-keyword-overlap"],
        },
        {
          entry: projectionCatalog[1],
          selectionReasons: [
            "matched-intent",
            "observed-intent",
            "observed-domain",
            "exact-fastpath-keyword-overlap",
          ],
        },
        {
          entry: projectionCatalog[4],
          selectionReasons: ["observed-intent", "observed-domain"],
        },
        {
          entry: projectionCatalog[2],
          selectionReasons: ["observed-domain"],
        },
      ],
    });
  });

  it("is independent of catalog and Recent input order", () => {
    const forward = projectIntentCatalog(snapshot(), [
      "skill-candidate",
      "behavior-fix",
    ]);
    const reversedSnapshot = snapshot([...projectionCatalog].reverse());
    reversedSnapshot.recent = [...reversedSnapshot.recent].reverse();
    const reversed = projectIntentCatalog(reversedSnapshot, [
      "behavior-fix",
      "skill-candidate",
    ]);

    expect(reversed).toEqual(forward);
  });

  it("deduplicates projected candidates by intent ID independently of input order", () => {
    const duplicate = {
      ...projectionCatalog[2]!,
      triggers: ["z duplicate metadata"],
      fastpath: { keywords: ["review"] },
    };
    const forwardSnapshot = snapshot([...projectionCatalog, duplicate]);
    const reverseSnapshot = snapshot(
      [duplicate, ...projectionCatalog].reverse(),
    );

    const forward = projectIntentCatalog(forwardSnapshot, ["behavior-fix"]);
    const reversed = projectIntentCatalog(reverseSnapshot, ["behavior-fix"]);

    expect(forward.mode).toBe("projected");
    expect(forward.originalCount).toBe(9);
    expect(forward.includedCount).toBe(4);
    expect(forward.omittedCount).toBe(5);
    expect(
      forward.entries.filter((entry) => entry.entry.id === "same-domain"),
    ).toHaveLength(1);
    expect(
      forward.entries.find((entry) => entry.entry.id === "same-domain")
        ?.selectionReasons,
    ).toEqual(["observed-domain"]);
    expect(reversed).toEqual(forward);
  });

  it.each([
    {
      name: "matched intent is absent",
      mutate: (value: ReviewSnapshot) => {
        value.matchedIntent = undefined;
      },
      reason: "matched-intent-missing",
    },
    {
      name: "there is no additional same-domain neighbor",
      mutate: (value: ReviewSnapshot) => {
        value.intentCatalog = value.intentCatalog.filter(
          (entry) => !["same-domain", "observed-route"].includes(entry.id),
        );
      },
      reason: "same-domain-neighbor-missing",
    },
    {
      name: "there is no cross-domain exact-keyword neighbor",
      mutate: (value: ReviewSnapshot) => {
        value.intentCatalog = value.intentCatalog.map((entry) =>
          entry.id === "cross-keyword"
            ? { ...entry, fastpath: { keywords: ["different"] } }
            : entry,
        );
      },
      reason: "cross-domain-keyword-neighbor-missing",
    },
    {
      name: "fewer than three original entries would be omitted",
      mutate: (value: ReviewSnapshot) => {
        value.intentCatalog = value.intentCatalog.filter(
          (entry) => !["omitted-m", "omitted-extra"].includes(entry.id),
        );
      },
      reason: "omission-threshold-not-met",
    },
  ] as const)(
    "falls back to the full catalog when $name",
    ({ mutate, reason }) => {
      const input = snapshot();
      mutate(input);
      const result = projectIntentCatalog(input, ["satisfaction-check"]);

      expect(result.mode).toBe("full");
      expect(result.fallbackReason).toBe(reason);
      expect(result.entries).toEqual(
        input.intentCatalog.map((entry) => ({ entry })),
      );
      expect(result.includedCount).toBe(input.intentCatalog.length);
      expect(result.omittedCount).toBe(0);
      expect(
        result.entries.every((entry) => !("selectionReasons" in entry)),
      ).toBe(true);
    },
  );

  it("uses the full catalog without fallback metadata when projection is not requested", () => {
    const input = snapshot();

    expect(projectIntentCatalog(input, [])).toEqual({
      mode: "full",
      originalCount: projectionCatalog.length,
      includedCount: projectionCatalog.length,
      omittedCount: 0,
      entries: projectionCatalog.map((entry) => ({ entry })),
    });
  });
});
