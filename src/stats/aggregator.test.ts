import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractRecommendedSkillsFromInstruction,
  StatsAggregator,
} from "./aggregator.js";
import type { IntentCatalogEntry } from "../types.js";
import type { SessionState } from "../session/index.js";

describe("StatsAggregator", () => {
  let tempDir: string;
  let aggregator: StatsAggregator;

  const intent: IntentCatalogEntry = {
    id: "version-control",
    definition: {
      triggers: ["commit"],
      examples: [],
      skills: ["git-master", "dev-lifecycle"],
      prompt: "Follow the version-control workflow.",
    },
  };

  function createState(overrides: Partial<SessionState> = {}): SessionState {
    return {
      input: "commit this",
      intent: {
        result: {
          intent: "version-control",
          reason: "test",
          confidence: 0.75,
          complexity: "medium",
        },
        instructionText: [
          "MUST view skill: git-master",
          "REQUIRED skill: dev-lifecycle",
        ].join("\n"),
      },
      skillsUsed: [{ name: "git-master", path: "/skills/git-master/SKILL.md" }],
      toolCalls: [
        {
          name: "exec",
          params: {},
          durationMs: 100,
        },
        {
          name: "exec",
          params: {},
          error: "failed",
          durationMs: 300,
        },
      ],
      timestamps: {
        start: "2026-06-11T00:00:00.000Z",
        end: "2026-06-11T00:01:00.000Z",
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
    aggregator = StatsAggregator.create(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("returns a shared instance for the same plugin root", () => {
      const aggregator1 = StatsAggregator.create(tempDir);
      const aggregator2 = StatsAggregator.create(tempDir);

      expect(aggregator1).toBe(aggregator2);
    });

    it("returns different instances for different plugin roots", () => {
      const otherDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "stats-test-other-"),
      );
      try {
        const aggregator1 = StatsAggregator.create(tempDir);
        const aggregator2 = StatsAggregator.create(otherDir);

        expect(aggregator1).not.toBe(aggregator2);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });

  function readStats() {
    return JSON.parse(
      fs.readFileSync(path.join(tempDir, "stats.json"), "utf-8"),
    );
  }

  it("extracts only explicit instruction skill recommendations", () => {
    expect(
      extractRecommendedSkillsFromInstruction(
        [
          "MUST view skill: prompt-engineering-expert",
          "REQUIRED skill: test-driven-development",
          "強烈建議 read skill: treemd",
          "強烈建議 view skill: skill-viewer",
          "  skill: obsidian",
          "- skill: raw-candidate",
          "MUST read skill: prompt-engineering-expert at /duplicate/SKILL.md",
          "MUST view skill: prompt-engineering-expert",
          "MUST read skill: `github-pr-workflow`",
          "REQUIRED skill: test-driven-development.",
          "MUST read skill: code-review-and-quality at /skills/code-review-and-quality/SKILL.md - needed to assess bot feedback",
          "MUST view skill: code-review-and-quality - needed to assess bot feedback",
          "1. MUST read skill: numbered-skill at /skills/numbered-skill/SKILL.md",
          "2. MUST view skill: numbered-view-skill",
        ].join("\n"),
      ),
    ).toEqual([
      "prompt-engineering-expert",
      "test-driven-development",
      "treemd",
      "skill-viewer",
      "github-pr-workflow",
      "code-review-and-quality",
      "numbered-skill",
      "numbered-view-skill",
    ]);
  });

  it("creates stats.json without scanning existing session files", () => {
    const sessionsDir = path.join(tempDir, "sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(
      path.join(sessionsDir, "existing.json"),
      JSON.stringify({ sessionId: "existing" }),
    );

    expect(
      aggregator.record("new-session", createState(), intent, {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);

    const stats = readStats();
    expect(stats.summary.turns).toBe(1);
    expect(Object.keys(stats.processedEvents)).toEqual([
      "new-session:2026-06-11T00:00:00.000Z",
    ]);
  });

  it("aggregates summary, intent, skill routing, tools, and daily metrics", () => {
    aggregator.record(
      "session-1",
      createState({ error: "agent failed" }),
      intent,
      {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      },
    );

    const stats = readStats();
    expect(stats.summary).toMatchObject({
      turns: 1,
      completedTurns: 0,
      erroredTurns: 1,
      skillAssistedTurns: 1,
      toolAssistedTurns: 1,
      skillUsageCount: 1,
      toolCallCount: 2,
      averageConfidence: 0.75,
      otherTurns: 0,
      otherRate: 0,
    });
    expect(stats.summary).not.toHaveProperty("confidenceTotal");
    expect(stats.intents["version-control"]).toMatchObject({
      turns: 1,
      share: 1,
      averageConfidence: 0.75,
      lowConfidenceTurns: 1,
      complexity: { low: 0, medium: 1, high: 0 },
      skillAssistedTurns: 1,
      toolAssistedTurns: 1,
      erroredTurns: 1,
      last7Days: 1,
    });
    expect(stats.skills["git-master"]).toMatchObject({
      usageTurns: 1,
      recommendedTurns: 1,
      adoptedTurns: 1,
      adoptionRate: 1,
      last7DaysUsage: 1,
      lifecycle: "active",
      needsReview: false,
    });
    expect(stats.skills["dev-lifecycle"]).toMatchObject({
      usageTurns: 0,
      recommendedTurns: 1,
      adoptedTurns: 0,
      adoptionRate: 0,
      last7DaysUsage: 0,
      lifecycle: "never-used",
      needsReview: false,
    });
    expect(stats.routing).toMatchObject({
      recommendationTurns: 1,
      adoptedTurns: 1,
      turnAdoptionRate: 1,
      recommendedSkillOpportunities: 2,
      adoptedSkillOpportunities: 1,
      skillAdoptionRate: 0.5,
    });
    expect(stats.routing.byIntent["version-control"]).toMatchObject({
      recommendationTurns: 1,
      adoptedTurns: 1,
      recommendedSkillOpportunities: 2,
      adoptedSkillOpportunities: 1,
    });
    expect(stats.tools.exec).toMatchObject({
      calls: 2,
      turns: 1,
      errorCalls: 1,
      averageDurationMs: 200,
      last7DaysCalls: 2,
    });
    expect(stats.tools.exec).not.toHaveProperty("durationTotalMs");
    expect(stats.tools.exec).not.toHaveProperty("durationSamples");
    expect(stats.daily["2026-06-11"]).toMatchObject({
      turns: 1,
      erroredTurns: 1,
      intents: { "version-control": 1 },
      skills: { "git-master": 1 },
      tools: { exec: 2 },
      routing: {
        recommendationTurns: 1,
        adoptedTurns: 1,
        recommendedSkillOpportunities: 2,
        adoptedSkillOpportunities: 1,
      },
    });
  });

  it("aggregates projected and fallback telemetry with bounded daily counters", () => {
    aggregator.record(
      "projected-session",
      createState({
        intent: {
          result: {
            intent: "version-control",
            reason: "projected",
            confidence: 0.9,
            complexity: "medium",
          },
          intentProjection: {
            decision: "projected",
            effectiveInput: "projected",
            originalIntentCount: 60,
            candidateIntentCount: 8,
            originalCatalogCodePoints: 46_000,
            candidateCatalogCodePoints: 7_000,
            durationMs: 2,
            candidateIntentIds: ["version-control"],
            candidateSelections: [
              {
                intentId: "version-control",
                selectionReasons: ["predicted-domain"],
                matchedKeywords: [],
              },
            ],
            supportReasons: ["high-overall-confidence"],
            selectionReasons: ["predicted-domain", "cross-flow"],
            matchedKeywords: [],
          },
        },
      }),
      intent,
    );
    aggregator.record(
      "fallback-session",
      createState({
        intent: {
          result: {
            intent: "version-control",
            reason: "fallback",
            confidence: 0.7,
            complexity: "medium",
          },
          intentProjection: {
            decision: "full-fallback",
            effectiveInput: "full-fallback",
            fallbackReason: "insufficient-evidence",
            originalIntentCount: 60,
            candidateIntentCount: 6,
            originalCatalogCodePoints: 46_000,
            candidateCatalogCodePoints: 5_000,
            durationMs: 4,
            candidateIntentIds: ["version-control"],
            candidateSelections: [
              {
                intentId: "version-control",
                selectionReasons: ["predicted-domain"],
                matchedKeywords: [],
              },
            ],
            supportReasons: [],
            selectionReasons: ["predicted-domain"],
            matchedKeywords: [],
          },
        },
        timestamps: {
          start: "2026-06-11T00:02:00.000Z",
          end: "2026-06-11T00:03:00.000Z",
        },
      }),
      intent,
    );

    const stats = readStats();
    expect(stats.schemaVersion).toBe(2);
    expect(stats.projection).toMatchObject({
      eligibleTurns: 2,
      projectedTurns: 1,
      fullFallbackTurns: 1,
      projectedRate: 0.5,
      fullFallbackRate: 0.5,
      averageOriginalIntentCount: 60,
      averageCandidateIntentCount: 7,
      catalogMeasurementTurns: 2,
      averageOriginalCatalogCodePoints: 46_000,
      averageCandidateCatalogCodePoints: 6_000,
      averageDurationMs: 3,
      fallbackReasons: { "insufficient-evidence": 1 },
      supportReasons: { "high-overall-confidence": 1 },
      selectionReasons: { "predicted-domain": 2, "cross-flow": 1 },
    });
    expect(stats.daily["2026-06-11"].projection).toEqual({
      eligibleTurns: 2,
      projectedTurns: 1,
      fullFallbackTurns: 1,
      fallbackReasons: { "insufficient-evidence": 1 },
    });
  });

  it("counts projection-only classifier failures without inventing an intent turn", () => {
    expect(
      aggregator.record(
        "projection-only-session",
        createState({
          intent: {
            intentProjection: {
              decision: "full-fallback",
              effectiveInput: "full-fallback",
              fallbackReason: "missing-topic-context",
              originalIntentCount: 60,
              candidateIntentCount: 60,
              durationMs: 2,
              candidateIntentIds: [],
              candidateSelections: [],
              supportReasons: [],
              selectionReasons: [],
              matchedKeywords: [],
            },
          },
        }),
      ),
    ).toBe(true);

    const stats = readStats();
    expect(stats.summary.turns).toBe(0);
    expect(stats.intents).toEqual({});
    expect(stats.projection).toMatchObject({
      eligibleTurns: 1,
      projectedTurns: 0,
      fullFallbackTurns: 1,
      fallbackReasons: { "missing-topic-context": 1 },
    });
    expect(stats.daily["2026-06-11"]).toMatchObject({
      turns: 0,
      intents: {},
      projection: {
        eligibleTurns: 1,
        projectedTurns: 0,
        fullFallbackTurns: 1,
        fallbackReasons: { "missing-topic-context": 1 },
      },
    });
  });

  it("bounds projection fallback reason keys", () => {
    for (let index = 0; index < 34; index += 1) {
      aggregator.record(
        `reason-session-${index}`,
        createState({
          intent: {
            result: {
              intent: "version-control",
              reason: "fallback",
              confidence: 0.7,
              complexity: "medium",
            },
            intentProjection: {
              decision: "full-fallback",
              effectiveInput: "full-fallback",
              fallbackReason: `reason-${index}`,
              originalIntentCount: 60,
              candidateIntentCount: 6,
              durationMs: 1,
              candidateIntentIds: ["version-control"],
              candidateSelections: [
                {
                  intentId: "version-control",
                  selectionReasons: ["predicted-domain"],
                  matchedKeywords: [],
                },
              ],
              supportReasons: [],
              selectionReasons: ["predicted-domain"],
              matchedKeywords: [],
            },
          },
        }),
        intent,
      );
    }

    const reasons = readStats().projection.fallbackReasons;
    expect(Object.keys(reasons)).toHaveLength(32);
    expect(reasons.other).toBe(3);
  });

  it("migrates a valid v1 file without losing existing data", () => {
    aggregator.record("legacy-session", createState(), intent);
    const statsPath = path.join(tempDir, "stats.json");
    const legacy = readStats();
    legacy.schemaVersion = 1;
    delete legacy.projection;
    for (const bucket of Object.values(legacy.daily) as Array<
      Record<string, unknown>
    >) {
      delete bucket.projection;
    }
    fs.writeFileSync(statsPath, JSON.stringify(legacy));

    expect(
      aggregator.record(
        "new-session",
        createState({
          timestamps: {
            start: "2026-06-11T00:02:00.000Z",
            end: "2026-06-11T00:03:00.000Z",
          },
        }),
        intent,
      ),
    ).toBe(true);

    const migrated = readStats();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.createdAt).toBe(legacy.createdAt);
    expect(migrated.summary.turns).toBe(2);
    expect(migrated.intents["version-control"].turns).toBe(2);
    expect(migrated.processedEvents).toMatchObject(legacy.processedEvents);
    expect(migrated.projection.eligibleTurns).toBe(0);
    expect(migrated.daily["2026-06-11"].projection.eligibleTurns).toBe(0);
  });

  it.each([
    [
      "too many keys",
      Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`reason-${index}`, 1]),
      ),
    ],
    ["an overlong key", { ["x".repeat(81)]: 1 }],
  ])("preserves v2 stats with %s in a projection reason map", (_, reasons) => {
    aggregator.record("existing-session", createState(), intent);
    const statsPath = path.join(tempDir, "stats.json");
    const invalid = readStats();
    invalid.projection.fallbackReasons = reasons;
    const serialized = JSON.stringify(invalid);
    fs.writeFileSync(statsPath, serialized);

    expect(
      aggregator.record(
        "new-session",
        createState({
          timestamps: {
            start: "2026-06-11T00:02:00.000Z",
            end: "2026-06-11T00:03:00.000Z",
          },
        }),
        intent,
      ),
    ).toBe(false);
    expect(fs.readFileSync(statsPath, "utf-8")).toBe(serialized);
  });

  it.each([
    [
      "an invalid processed-event timestamp",
      (legacy: Record<string, unknown>) => {
        legacy.processedEvents = { event: "not-a-date" };
      },
    ],
    [
      "an invalid UTC daily key",
      (legacy: Record<string, unknown>) => {
        const daily = legacy.daily as Record<string, unknown>;
        legacy.daily = { garbage: daily["2026-06-11"] };
      },
    ],
  ])("preserves v1 stats containing %s", (_, mutate) => {
    aggregator.record("existing-session", createState(), intent);
    const statsPath = path.join(tempDir, "stats.json");
    const legacy = readStats() as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.projection;
    for (const bucket of Object.values(
      legacy.daily as Record<string, Record<string, unknown>>,
    )) {
      delete bucket.projection;
    }
    mutate(legacy);
    const serialized = JSON.stringify(legacy);
    fs.writeFileSync(statsPath, serialized);

    expect(
      aggregator.record(
        "new-session",
        createState({
          timestamps: {
            start: "2026-06-11T00:02:00.000Z",
            end: "2026-06-11T00:03:00.000Z",
          },
        }),
        intent,
      ),
    ).toBe(false);
    expect(fs.readFileSync(statsPath, "utf-8")).toBe(serialized);
  });

  it("counts actual instruction recommendations instead of catalog candidates", () => {
    const noisyIntent: IntentCatalogEntry = {
      id: "prompt-engineering",
      definition: {
        triggers: ["prompt"],
        examples: [],
        prompt: [
          "Candidate skills:",
          "  skill: prompt-engineering-expert",
          "  skill: interview-me",
          "  skill: grill-me",
          "  skill: treemd",
        ].join("\n"),
      },
    };

    aggregator.record(
      "session-1",
      createState({
        intent: {
          result: {
            intent: "prompt-engineering",
            reason: "test",
            confidence: 0.9,
            complexity: "medium",
          },
          instructionText:
            "MUST read skill: prompt-engineering-expert at /skills/prompt-engineering-expert/SKILL.md",
        },
        skillsUsed: [
          {
            name: "prompt-engineering-expert",
            path: "/skills/prompt-engineering-expert/SKILL.md",
          },
        ],
      }),
      noisyIntent,
    );

    const stats = readStats();
    expect(stats.routing).toMatchObject({
      recommendationTurns: 1,
      adoptedTurns: 1,
      recommendedSkillOpportunities: 1,
      adoptedSkillOpportunities: 1,
      skillAdoptionRate: 1,
    });
    expect(stats.skills["prompt-engineering-expert"]).toMatchObject({
      recommendedTurns: 1,
      adoptedTurns: 1,
      needsReview: false,
    });
    expect(stats.skills["interview-me"]).toBeUndefined();
    expect(stats.skills["grill-me"]).toBeUndefined();
    expect(stats.skills.treemd).toBeUndefined();
  });

  it("normalizes timestamps to UTC and counts present empty errors", () => {
    aggregator.record(
      "session-1",
      createState({
        error: "",
        toolCalls: [{ name: "exec", params: {}, error: "" }],
        timestamps: {
          start: "2026-06-11T08:00:00+08:00",
          end: "2026-06-11T08:01:00+08:00",
        },
      }),
      intent,
    );

    const stats = readStats();
    expect(stats.updatedAt).toBe("2026-06-11T00:01:00.000Z");
    expect(stats.summary.erroredTurns).toBe(1);
    expect(stats.tools.exec.errorCalls).toBe(1);
  });

  it("maintains confidence and tool duration averages without internal totals", () => {
    aggregator.record("session-1", createState(), intent);
    aggregator.record(
      "session-2",
      createState({
        intent: {
          result: {
            intent: "version-control",
            reason: "test",
            confidence: 0.25,
            complexity: "low",
          },
        },
        toolCalls: [{ name: "exec", params: {}, durationMs: 50 }],
        timestamps: {
          start: "2026-06-11T00:02:00.000Z",
          end: "2026-06-11T00:03:00.000Z",
        },
      }),
      intent,
    );

    const stats = readStats();
    expect(stats.summary.averageConfidence).toBe(0.5);
    expect(stats.intents["version-control"].averageConfidence).toBe(0.5);
    expect(stats.tools.exec.averageDurationMs).toBeCloseTo(150);
    expect(stats.summary).not.toHaveProperty("confidenceTotal");
    expect(stats.intents["version-control"]).not.toHaveProperty(
      "confidenceTotal",
    );
    expect(stats.tools.exec).not.toHaveProperty("durationTotalMs");
    expect(stats.tools.exec).not.toHaveProperty("durationSamples");
  });

  it("is idempotent and excludes intents without recommended skills from routing", () => {
    const noSkillsIntent: IntentCatalogEntry = {
      id: "chat",
      definition: { triggers: ["chat"], examples: [], prompt: "Just chat." },
    };
    const state = createState({
      intent: {
        result: {
          intent: "chat",
          reason: "test",
          confidence: 0.9,
          complexity: "low",
        },
      },
      skillsUsed: undefined,
      toolCalls: undefined,
    });

    expect(aggregator.record("session-1", state, noSkillsIntent)).toBe(true);
    expect(aggregator.record("session-1", state, noSkillsIntent)).toBe(false);

    const stats = readStats();
    expect(stats.summary.turns).toBe(1);
    expect(stats.routing.recommendationTurns).toBe(0);
  });

  it("prunes daily and processed events after 90 days while retaining all-time totals", () => {
    aggregator.record(
      "old-session",
      createState({
        timestamps: {
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-01-01T00:01:00.000Z",
        },
      }),
      intent,
      { nowMs: Date.parse("2026-01-01T00:01:00.000Z") },
    );
    aggregator.record(
      "new-session",
      createState({
        timestamps: {
          start: "2026-06-11T00:00:00.000Z",
          end: "2026-06-11T00:01:00.000Z",
        },
      }),
      intent,
      { nowMs: Date.parse("2026-06-11T00:01:00.000Z") },
    );

    const stats = readStats();
    expect(stats.summary.turns).toBe(2);
    expect(stats.daily["2026-01-01"]).toBeUndefined();
    expect(
      stats.processedEvents["old-session:2026-01-01T00:00:00.000Z"],
    ).toBeUndefined();
    expect(stats.daily["2026-06-11"]).toBeDefined();
  });

  it("marks low-adoption and unused skills with review and lifecycle status", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 5; index++) {
      aggregator.record(
        `session-${index}`,
        createState({
          skillsUsed: undefined,
          timestamps: {
            start: new Date(start + index * 1000).toISOString(),
            end: new Date(start + index * 1000 + 500).toISOString(),
          },
        }),
        intent,
        { nowMs: start + index * 1000 + 500 },
      );
    }
    aggregator.record(
      "refresh-lifecycle",
      createState({
        intent: {
          result: {
            intent: "other",
            reason: "test",
            confidence: 0.4,
            complexity: "low",
          },
        },
        skillsUsed: undefined,
        toolCalls: undefined,
        timestamps: {
          start: "2026-04-05T00:00:00.000Z",
          end: "2026-04-05T00:01:00.000Z",
        },
      }),
      undefined,
      { nowMs: Date.parse("2026-04-05T00:01:00.000Z") },
    );

    const stats = readStats();
    expect(stats.skills["git-master"]).toMatchObject({
      recommendedTurns: 5,
      adoptedTurns: 0,
      adoptionRate: 0,
      lifecycle: "never-used",
      needsReview: true,
    });
    expect(stats.summary.otherTurns).toBe(1);
    expect(stats.summary.otherRate).toBeCloseTo(1 / 6);
  });

  it("marks used skills stale after 30 days and archived after 90 days", () => {
    aggregator.record(
      "archive-session",
      createState({
        skillsUsed: [{ name: "archive-skill", path: "/archive/SKILL.md" }],
        timestamps: {
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-01-01T00:01:00.000Z",
        },
      }),
      undefined,
      { nowMs: Date.parse("2026-01-01T00:01:00.000Z") },
    );
    aggregator.record(
      "stale-session",
      createState({
        skillsUsed: [{ name: "stale-skill", path: "/stale/SKILL.md" }],
        timestamps: {
          start: "2026-03-01T00:00:00.000Z",
          end: "2026-03-01T00:01:00.000Z",
        },
      }),
      undefined,
      { nowMs: Date.parse("2026-03-01T00:01:00.000Z") },
    );
    aggregator.record(
      "refresh-lifecycle",
      createState({
        skillsUsed: undefined,
        timestamps: {
          start: "2026-04-05T00:00:00.000Z",
          end: "2026-04-05T00:01:00.000Z",
        },
      }),
      undefined,
      { nowMs: Date.parse("2026-04-05T00:01:00.000Z") },
    );

    const stats = readStats();
    expect(stats.skills["archive-skill"].lifecycle).toBe("archive");
    expect(stats.skills["stale-skill"].lifecycle).toBe("stale");
  });

  it("skips incomplete events and preserves corrupt or invalid stats files", () => {
    expect(aggregator.record("missing-intent", {})).toBe(false);
    expect(
      aggregator.record("missing-start", createState({ timestamps: {} })),
    ).toBe(false);

    fs.mkdirSync(path.join(tempDir, "sessions"), { recursive: true });
    const statsPath = path.join(tempDir, "stats.json");
    fs.writeFileSync(statsPath, "{ broken");

    expect(aggregator.record("session-1", createState(), intent)).toBe(false);
    expect(fs.readFileSync(statsPath, "utf-8")).toBe("{ broken");

    fs.writeFileSync(statsPath, "{}");
    expect(aggregator.record("session-2", createState(), intent)).toBe(false);
    expect(fs.readFileSync(statsPath, "utf-8")).toBe("{}");

    const malformedNestedStats = {
      schemaVersion: 1,
      summary: {},
      intents: {},
      skills: {},
      routing: {},
      tools: {},
      daily: {},
      processedEvents: {},
    };
    fs.writeFileSync(statsPath, JSON.stringify(malformedNestedStats));
    expect(aggregator.record("session-3", createState(), intent)).toBe(false);
    expect(JSON.parse(fs.readFileSync(statsPath, "utf-8"))).toEqual(
      malformedNestedStats,
    );

    const malformedV2Stats = {
      ...malformedNestedStats,
      schemaVersion: 2,
      projection: {},
    };
    fs.writeFileSync(statsPath, JSON.stringify(malformedV2Stats));
    expect(aggregator.record("session-4", createState(), intent)).toBe(false);
    expect(JSON.parse(fs.readFileSync(statsPath, "utf-8"))).toEqual(
      malformedV2Stats,
    );
  });
});
