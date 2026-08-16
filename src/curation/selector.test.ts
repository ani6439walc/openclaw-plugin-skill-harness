import { describe, expect, it, vi } from "vitest";
import type { SessionData, SessionState } from "../session/tracker.js";
import type { AvailableSkill } from "../skills/types.js";
import {
  sampleWithoutReplacement,
  selectColdStartCandidates,
  selectExplorationCandidates,
} from "./selector.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function inventory(names: readonly string[]): AvailableSkill[] {
  return names.map((name) => ({
    name,
    location: `/skills/${name}`,
    description: `${name} description`,
  }));
}

function turn(params: {
  intent?: string;
  endedAt?: string;
  error?: string;
  skills?: string[];
}): SessionState {
  return {
    intent: params.intent
      ? {
          result: {
            intent: params.intent,
            reason: "test",
            confidence: 1,
            complexity: "low",
            domain: "coding",
          },
        }
      : undefined,
    skillsUsed: params.skills?.map((name) => ({
      name,
      path: `/skills/${name}`,
    })),
    error: params.error,
    timestamps: { end: params.endedAt },
  };
}

function session(params: {
  id: string;
  agentId?: string;
  current?: SessionState;
  history?: SessionState[];
}): SessionData {
  return {
    sessionId: params.id,
    agentId: params.agentId,
    current: params.current ?? {},
    history: params.history,
  };
}

describe("selectColdStartCandidates", () => {
  it("ranks retained distinct usage turns by count, recency, then declaration order", () => {
    const result = selectColdStartCandidates({
      agentId: "main",
      intentId: "Coding",
      declaredSkillNames: [
        "frequent-recent",
        "frequent-older",
        "declared-first",
        "declared-second",
      ],
      inventory: inventory([
        "frequent-recent",
        "frequent-older",
        "declared-first",
        "declared-second",
      ]),
      sessions: [
        session({
          id: "one",
          agentId: "main",
          current: turn({
            intent: " coding ",
            endedAt: "2026-08-12T10:00:00.000Z",
            skills: ["frequent-recent", "FREQUENT-RECENT", "frequent-older"],
          }),
          history: [
            turn({
              intent: "CODING (Coding Work)",
              endedAt: "2026-08-10T10:00:00.000Z",
              skills: ["frequent-recent"],
            }),
            turn({
              intent: "coding",
              endedAt: "2026-08-09T10:00:00.000Z",
              skills: ["frequent-older"],
            }),
          ],
        }),
      ],
      nowMs: NOW,
      retentionMs: RETENTION_MS,
      sampleWithoutReplacement: (values, count) => values.slice(0, count),
    });

    expect(result.ranked.map((candidate) => candidate.name)).toEqual([
      "frequent-recent",
      "frequent-older",
      "declared-first",
      "declared-second",
    ]);
    expect(
      result.ranked.every(
        (candidate) => candidate.provenance === "historical-top",
      ),
    ).toBe(true);
  });

  it("ignores turns outside the exact retained finalized agent-and-intent evidence boundary", () => {
    const qualifying = turn({
      intent: "coding",
      endedAt: "2026-08-12T11:00:00.000Z",
      skills: ["eligible"],
    });
    const sessions: SessionData[] = [
      session({ id: "eligible", agentId: "main", current: qualifying }),
      session({ id: "wrong-agent", agentId: "other", current: qualifying }),
      session({
        id: "wrong-intent",
        agentId: "main",
        current: turn({
          intent: "research",
          endedAt: "2026-08-12T11:30:00.000Z",
          skills: ["excluded"],
        }),
      }),
      session({
        id: "expired",
        agentId: "main",
        current: turn({
          intent: "coding",
          endedAt: new Date(NOW - RETENTION_MS).toISOString(),
          skills: ["excluded"],
        }),
      }),
      session({
        id: "errored",
        agentId: "main",
        current: turn({
          intent: "coding",
          endedAt: "2026-08-12T11:45:00.000Z",
          error: "failed",
          skills: ["excluded"],
        }),
      }),
      session({
        id: "unfinished",
        agentId: "main",
        current: turn({ intent: "coding", skills: ["excluded"] }),
      }),
      session({
        id: "malformed-end",
        agentId: "main",
        current: turn({
          intent: "coding",
          endedAt: "not-a-date",
          skills: ["excluded"],
        }),
      }),
      session({
        id: "outside-pool",
        agentId: "main",
        current: turn({
          intent: "coding",
          endedAt: "2026-08-12T11:50:00.000Z",
          skills: ["not-declared"],
        }),
      }),
    ];

    const result = selectColdStartCandidates({
      agentId: "main",
      intentId: "coding",
      declaredSkillNames: ["excluded", "eligible", "missing-from-inventory"],
      inventory: inventory(["eligible", "excluded", "not-declared"]),
      sessions,
      nowMs: NOW,
      retentionMs: RETENTION_MS,
      sampleWithoutReplacement: (values, count) => values.slice(0, count),
    });

    expect(result.ranked.map((candidate) => candidate.name)).toEqual([
      "eligible",
      "excluded",
    ]);
  });

  it.each([
    {
      currentIntent: "agent-dispatch (Agent Dispatch & Orchestration)",
      historicalIntent: "agent-dispatch",
    },
    {
      currentIntent: "agent-dispatch",
      historicalIntent: "agent-dispatch (Agent Dispatch & Orchestration)",
    },
  ])(
    "matches current intent $currentIntent to historical intent $historicalIntent by canonical ID",
    ({ currentIntent, historicalIntent }) => {
      const result = selectColdStartCandidates({
        agentId: "main",
        intentId: currentIntent,
        declaredSkillNames: ["unused", "used"],
        inventory: inventory(["unused", "used"]),
        sessions: [
          session({
            id: "historical-display-form",
            agentId: "main",
            current: turn({
              intent: historicalIntent,
              endedAt: "2026-08-12T11:00:00.000Z",
              skills: ["used"],
            }),
          }),
        ],
        nowMs: NOW,
        retentionMs: RETENTION_MS,
        sampleWithoutReplacement: (values, count) => values.slice(0, count),
      });

      expect(result.ranked.map((candidate) => candidate.name)).toEqual([
        "used",
        "unused",
      ]);
    },
  );

  it("deduplicates declared and inventory identities case-insensitively while preserving declaration order", () => {
    const result = selectColdStartCandidates({
      agentId: "main",
      intentId: "coding",
      declaredSkillNames: [" Alpha ", "ALPHA", "beta", "missing"],
      inventory: inventory(["alpha", "Beta", "beta"]),
      sessions: [],
      nowMs: NOW,
      retentionMs: RETENTION_MS,
      sampleWithoutReplacement: (values, count) => values.slice(0, count),
    });

    expect(result.ranked.map((candidate) => candidate.name)).toEqual([
      "alpha",
      "Beta",
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
    "keeps the top four fixed and explores without replacement for a pool of %i",
    (poolSize) => {
      const names = Array.from(
        { length: poolSize },
        (_, index) => `skill-${index}`,
      );
      const sampler = vi.fn(<T>(values: readonly T[], count: number): T[] =>
        [...values].reverse().slice(0, count),
      );

      const result = selectColdStartCandidates({
        agentId: "main",
        intentId: "coding",
        declaredSkillNames: names,
        inventory: inventory(names),
        sessions: [],
        nowMs: NOW,
        retentionMs: RETENTION_MS,
        sampleWithoutReplacement: sampler,
      });

      expect(
        result.selected.slice(0, 4).map((candidate) => candidate.name),
      ).toEqual(names.slice(0, 4));
      expect(result.selected).toHaveLength(Math.min(poolSize, 6));
      expect(
        new Set(result.selected.map((candidate) => candidate.name)).size,
      ).toBe(result.selected.length);
      expect(
        result.selected
          .slice(0, 4)
          .every((candidate) => candidate.provenance === "historical-top"),
      ).toBe(true);
      expect(
        result.selected
          .slice(4)
          .every((candidate) => candidate.provenance === "random-exploration"),
      ).toBe(true);

      const remainder = names.slice(4);
      if (remainder.length > 0) {
        expect(sampler).toHaveBeenCalledWith(
          remainder,
          Math.min(2, remainder.length),
        );
      } else {
        expect(sampler).not.toHaveBeenCalled();
      }
    },
  );

  it("ignores malformed retained session identities and skill records", () => {
    const malformed = [
      {
        sessionId: "malformed-agent",
        agentId: 42,
        current: {},
      },
      {
        sessionId: "malformed-skills",
        agentId: "main",
        current: {
          ...turn({
            intent: "coding",
            endedAt: "2026-08-10T10:00:00.000Z",
          }),
          skillsUsed: [null, { name: 7 }, { name: "alpha" }],
        },
      },
    ] as unknown as SessionData[];

    expect(() =>
      selectColdStartCandidates({
        agentId: "main",
        intentId: "coding",
        declaredSkillNames: ["alpha"],
        inventory: inventory(["alpha"]),
        sessions: malformed,
        nowMs: NOW,
      }),
    ).not.toThrow();
    expect(
      selectColdStartCandidates({
        agentId: "main",
        intentId: "coding",
        declaredSkillNames: ["alpha"],
        inventory: inventory(["alpha"]),
        sessions: malformed,
        nowMs: NOW,
      }).ranked,
    ).toEqual([{ name: "alpha", provenance: "historical-top" }]);
  });

  it("ignores malformed non-string final timestamps instead of coercing them", () => {
    const malformed = session({
      id: "malformed-end",
      agentId: "main",
      current: {
        ...turn({ intent: "coding", skills: ["used"] }),
        timestamps: { end: 42 as unknown as string },
      },
    });

    const result = selectColdStartCandidates({
      agentId: "main",
      intentId: "coding",
      declaredSkillNames: ["unused", "used"],
      inventory: inventory(["unused", "used"]),
      sessions: [malformed],
      nowMs: Date.parse("2041-12-31T00:00:00.000Z"),
      retentionMs: RETENTION_MS,
      sampleWithoutReplacement: (values, count) => values.slice(0, count),
    });

    expect(result.ranked.map((candidate) => candidate.name)).toEqual([
      "unused",
      "used",
    ]);
  });
});

describe("sampleWithoutReplacement", () => {
  it("returns a bounded sample with no duplicate indices without mutating the input", () => {
    const values = ["a", "b", "c", "d"];
    const result = sampleWithoutReplacement(values, 99);

    expect(values).toEqual(["a", "b", "c", "d"]);
    expect(result).toHaveLength(4);
    expect(new Set(result)).toEqual(new Set(values));
  });
});

describe("selectExplorationCandidates", () => {
  it("returns all items when item count is less than or equal to target", () => {
    const items = ["a", "b", "c"];
    expect(selectExplorationCandidates(items, 5)).toEqual(["a", "b", "c"]);
    expect(selectExplorationCandidates(items, 3)).toEqual(["a", "b", "c"]);
  });

  it("selects 2/3 top exploitation and 1/3 sampled exploration for target 15", () => {
    const items = Array.from({ length: 25 }, (_, i) => `item-${i + 1}`);
    const mockSampler = vi.fn((remainder: string[], count: number) =>
      remainder.slice(0, count).reverse(),
    );

    const result = selectExplorationCandidates(
      items,
      15,
      2 / 3,
      mockSampler as unknown as typeof sampleWithoutReplacement,
    );

    // Top 10 exploitation (item-1 .. item-10)
    expect(result.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => `item-${i + 1}`),
    );
    // Remainder passed to sampler
    expect(mockSampler).toHaveBeenCalledWith(items.slice(10), 5);
    // Sampled 5 items appended
    expect(result).toHaveLength(15);
  });

  it("selects 2/3 top exploitation and 1/3 sampled exploration for target 10", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i + 1}`);
    const mockSampler = vi.fn((remainder: string[], count: number) =>
      remainder.slice(0, count),
    );

    const result = selectExplorationCandidates(
      items,
      10,
      2 / 3,
      mockSampler as unknown as typeof sampleWithoutReplacement,
    );

    expect(result.slice(0, 7)).toEqual(
      Array.from({ length: 7 }, (_, i) => `item-${i + 1}`),
    );
    expect(mockSampler).toHaveBeenCalledWith(items.slice(7), 3);
    expect(result).toHaveLength(10);
  });
});
