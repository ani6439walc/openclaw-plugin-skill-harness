#!/usr/bin/env node
/** Regression coverage for the report-only runtime health audit. */
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { buildReport, isoTimestamp, sha256 } from "./runtime-health-audit.mjs";

const SCRIPT = fileURLToPath(
  new URL("./runtime-health-audit.mjs", import.meta.url),
);
const REVIEW_SOURCE = {
  sessionId: "session-1",
  agentId: "main",
  turnStart: "2026-08-01T00:00:00.000Z",
};
const NO_FINDING_EVENT = {
  processedAt: REVIEW_SOURCE.turnStart,
  source: REVIEW_SOURCE,
  triggers: ["capability-fit"],
  changeCount: 0,
  outcome: "nofinding",
};
const SKIPPED_PREPARATION = {
  status: "skipped",
  reason: "no-seeds",
  requestedSeeds: 0,
  capturedSeeds: 0,
  capturedExtras: 0,
  existingNeighborAttempts: 0,
  discoveryAttempts: 0,
  skippedCaptureCount: 0,
};
const FIXTURE = {
  "stats.json": {
    schemaVersion: 7,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:02:00.000Z",
    attribution: {
      startedAt: "2026-08-01T00:00:00.000Z",
    },
    summary: {
      turns: 2,
      completedTurns: 1,
      erroredTurns: 1,
      skillAssistedTurns: 1,
      toolAssistedTurns: 1,
      skillUsageCount: 1,
      toolCallCount: 2,
      averageConfidence: 0.75,
      unknownTurns: 0,
      unknownRate: 0,
    },
    intents: {
      example: {
        turns: 2,
        share: 1,
        lastSeenAt: "2026-08-01T00:02:00.000Z",
        last7Days: 2,
        averageConfidence: 0.75,
        lowConfidenceTurns: 1,
        skillAssistedTurns: 1,
        toolAssistedTurns: 1,
        erroredTurns: 1,
        routeReasons: {
          "qmd-keyword": {
            count: 0,
            averageScore: 0,
            minScore: 1,
            maxScore: 0,
          },
          "qmd-hybrid": {
            count: 0,
            averageScore: 0,
            minScore: 1,
            maxScore: 0,
          },
          "llm-classifier": {
            count: 0,
            averageScore: 0,
            minScore: 1,
            maxScore: 0,
          },
        },
      },
    },
    skills: {
      "example-skill": {
        usageTurns: 1,
        intentMatchedTurns: 2,
        adoptedTurns: 1,
        adoptionRate: 0.5,
        lastUsedAt: "2026-08-01T00:02:00.000Z",
        last7DaysUsage: 1,
        lifecycle: "active",
        needsReview: true,
      },
    },
    routing: {
      intentMatchedTurns: 2,
      adoptedTurns: 1,
      turnAdoptionRate: 0.5,
      intentMatchedSkillOpportunities: 2,
      adoptedSkillOpportunities: 1,
      skillAdoptionRate: 0.5,
      byIntent: {},
    },
    tools: {
      exec: {
        calls: 2,
        turns: 1,
        errorCalls: 1,
        averageDurationMs: 200,
        lastUsedAt: "2026-08-01T00:02:00.000Z",
        last7DaysCalls: 2,
        latencyHistogram: {
          unknown: 0,
          "0-99": 0,
          "100-499": 2,
          "500-999": 0,
          "1000-4999": 0,
          "5000+": 0,
        },
      },
    },
    skillDiscovery: {
      turns: 2,
      nameMatch: {
        matchedTurns: 1,
        candidates: 1,
        injectedSkills: 1,
      },
      qmdSearch: {
        attemptedTurns: 2,
        matchedTurns: 1,
        candidates: 2,
        semanticScore: {
          count: 2,
          average: 0.8,
          min: 0.7,
          max: 0.9,
        },
        injectedSkills: 1,
      },
      pool: {
        nonEmptyTurns: 1,
        candidates: 2,
        injectedTurns: 1,
        injectedSkills: 2,
      },
      fallbackReasons: {
        "empty-pool": 1,
      },
      durationMs: {
        count: 2,
        average: 10,
        min: 8,
        max: 12,
      },
    },
    projection: {
      eligibleTurns: 1,
      projectedTurns: 1,
      fullFallbackTurns: 0,
      projectedRate: 1,
      fullFallbackRate: 0,
      averageOriginalIntentCount: 5,
      averageCandidateIntentCount: 2,
      catalogMeasurementTurns: 1,
      averageOriginalCatalogCodePoints: 1000,
      averageCandidateCatalogCodePoints: 400,
      averageDurationMs: 3,
      fallbackReasons: {},
    },
    daily: {
      "2026-08-01": {
        turns: 2,
        erroredTurns: 1,
        intents: {
          example: 2,
        },
        skills: {
          "example-skill": 1,
        },
        tools: {
          exec: 2,
        },
        routing: {
          intentMatchedTurns: 2,
          adoptedTurns: 1,
          intentMatchedSkillOpportunities: 2,
          adoptedSkillOpportunities: 1,
        },
        projection: {
          eligibleTurns: 1,
          projectedTurns: 1,
          fullFallbackTurns: 0,
          fallbackReasons: {},
        },
        intentOutcomes: {
          "value:example": {
            turns: 2,
          },
        },
        intentRouting: {
          "value:example": {
            intentMatchedTurns: 2,
          },
        },
        skillRouting: {
          "value:example-skill": {
            intentMatchedTurns: 2,
          },
        },
        toolErrors: {
          "value:exec": 1,
        },
      },
    },
    skillInventory: {
      startedAt: "2026-08-01T00:00:00.000Z",
      agents: {},
    },
    processedEvents: {
      event: "2026-08-01T00:02:00.000Z",
    },
  },
  "review.json": {
    schemaVersion: 9,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    processedEvents: {
      "event-1": {
        ...NO_FINDING_EVENT,
        changeCount: 1,
        outcome: "applied",
        changedRelationCount: 1,
        relationOutcome: "applied",
        relationBatchId: "batch-1",
        changes: [
          {
            trigger: "capability-fit",
            targetKind: "skill-relation",
            operation: "update",
            fromSkillId: "first",
            toSkillId: "second",
            relationType: "related",
            reason: "The procedures use the same inputs.",
            relationEvidence: ["first", "second"].map((skillId) => ({
              skillId,
              filePath: "SKILL.md",
              startLine: 1,
              endLine: 1,
              quote: "PRIVATE_EVIDENCE",
            })),
            dedupeKey: "update-example",
            summary: "PRIVATE_REVIEW",
            evidence: ["PRIVATE_EVIDENCE"],
            correctionGoal: "Update the relation.",
            suggestedChange: "PRIVATE_SUGGESTION",
          },
        ],
      },
      "event-2": {
        ...NO_FINDING_EVENT,
        processedAt: "2026-08-01T00:01:00.000Z",
        triggers: ["routing-uncertainty"],
        noFindingReasonCounts: {
          "already-covered": 1,
        },
      },
    },
    reviewedSkillEpochs: {},
  },
};
const NOW = new Date("2026-08-08T12:00:00Z");
let root;
function write(relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}
function update(relative, fn) {
  const value = read(relative);
  fn(value);
  write(relative, value);
}
function remove(relative) {
  fs.rmSync(path.join(root, relative), { recursive: true, force: true });
}
function report(days = 7, options) {
  return buildReport(root, days, NOW, options);
}
function database(relative, generation = 2, docs = 2) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec(`CREATE TABLE embedding_index_state (singleton INTEGER PRIMARY KEY, status TEXT NOT NULL, generation INTEGER NOT NULL, lease_expires_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE documents (active INTEGER NOT NULL);
CREATE TABLE content_vectors (id INTEGER PRIMARY KEY);
INSERT INTO embedding_index_state VALUES (1, 'ready', ${generation}, NULL, 1234567890);`);
  for (let i = 1; i <= docs; i++) {
    db.exec(
      `INSERT INTO documents VALUES (1); INSERT INTO content_vectors VALUES (${i});`,
    );
  }
  db.close();
}
function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, "--data-root", root, ...args], {
    encoding: "utf8",
  });
}
function runAudit() {
  const result = cli(["--output", path.join(root, "report.json")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(fs.statSync(path.join(root, "report.json")).mode & 0o777, 0o600);
  return read("report.json");
}
function turn(key = "turn", date = "2026-08-01", skills = [], used = []) {
  return {
    turnKey: key,
    timestamps: { start: date + "T00:01:00Z", end: date + "T00:02:00Z" },
    matchedSkills: skills,
    skillsUsed: used.map((name) => ({ name, path: "/private" })),
    confidence: 0.8,
    input: "SECRET_TRANSCRIPT",
    result: "SECRET_RESULT",
    toolCalls: [{ params: { secret: "SECRET_PAYLOAD" } }],
    inputSkillDiscovery: {
      candidateCount: 1,
      durationMs: 12,
    },
  };
}
function writeSession(current, history = []) {
  write("sessions/session.json", { sessionId: "session", current, history });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-harness-audit-"));
  for (const [name, value] of Object.entries(FIXTURE))
    write(name, structuredClone(value));
  write(
    "intents/example.md",
    "---\ntriggers:\n  - The test request matches the example intent.\nexamples:\n  - Use the example intent.\nkeywords:\n  - example\n---\nRoute the example request.\n",
  );
  write("qmd/intents/keywords/example.md", "# keyword\n");
  write("qmd/intents/examples/example.md", "# example\n");
  database("qmd/intents/intent-routing.sqlite");
  writeSession({ timestamps: { end: "2026-08-01T00:02:00.000Z" } });
  write("agents/review/sessions/agent.session.jsonl", "{}\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test("reports health without private runtime text and writes private atomic output", () => {
  const r = runAudit();
  assert.equal(r.reportOnly, true);
  assert.deepEqual(r.privacy, {
    sessionTextIncluded: false,
    reviewSuggestionTextIncluded: false,
    reviewEvidenceIncluded: false,
    toolParamsOrResultsIncluded: false,
  });
  const review = r.runtime.review.processedEvents;
  assert.equal(review.eventCount, 2);
  assert.deepEqual(review.outcomes, { applied: 1, nofinding: 1 });
  assert.deepEqual(review.changes, {
    appliedEvents: 1,
    total: 1,
    averagePerAppliedEvent: 1,
    eventsByChangeCount: { 0: 1, 1: 1 },
    byTrigger: { "capability-fit": 1 },
    byOperation: { update: 1 },
  });
  assert.equal(r.runtime.sessions.sessionFiles, 1);
  assert.equal(r.runtime.sessions.agentArtifactFiles, 1);
  assert.equal(r.runtime.intents.markdownFiles, 1);
  assert.deepEqual(Object.keys(r.runtime.qmd), ["skills"]);
  assert.deepEqual(Object.keys(r.provenance.stateSha256).sort(), [
    "review.json",
    "stats.json",
  ]);
  assert.equal(r.provenance.scriptSha256, sha256(SCRIPT));
  const stats = r.runtime.stats;
  assert.equal(stats.attribution.status, "fresh-v7-window");
  assert.equal(stats.routing.turnAdoptionRate, 0.5);
  assert.equal(stats.routing.skillAdoptionRate, 0.5);
  assert.equal(stats.projection.projectedRate, 1);
  assert.equal(stats.intentPortfolio.trackedIntents, 1);
  assert.equal(stats.intentPortfolio.erroredTurns, 1);
  assert.equal(
    stats.intentPortfolio.routeReasonAttribution.status,
    "available",
  );
  assert.equal(stats.skillInventory.status, "available");
  assert.deepEqual(stats.skillLifecycle.lowAdoptionCohort, [
    {
      skill: "example-skill",
      intentMatchedTurns: 2,
      adoptedTurns: 1,
      adoptionRate: 0.5,
      lifecycle: "active",
    },
  ]);
  assert.equal(stats.toolReliability.errorRate, 0.5);
  assert.equal(
    stats.toolReliability.latencyHistogram.status,
    "fresh-v7-window",
  );
  assert.equal(stats.dataHealth.dailyBucketCount, 1);
  assert.equal(stats.dataHealth.retainedProcessedEventCount, 1);
  assert.equal(stats.dataHealth.statsUpdatedAt, "2026-08-01T00:02:00.000Z");
  assert.equal("routingEffectiveness" in stats, false);
  assert.equal("projectionEfficiency" in stats, false);
});
test("missing skill indexes leave the report available", () => {
  assert.equal(runAudit().runtime.qmd.skills.indexCount, 0);
});
test("route scores are weighted and inventory remains aggregate", () => {
  update("stats.json", (s) => {
    s.attribution.startedAt = "2026-08-01T00:02:00.000Z";
    s.intents.example.routeReasons = {
      "qmd-keyword": {
        count: 2,
        averageScore: 0.8,
        minScore: 0.7,
        maxScore: 0.9,
      },
      "qmd-hybrid": {
        count: 1,
        averageScore: 0.85,
        minScore: 0.85,
        maxScore: 0.85,
      },
      "llm-classifier": {
        count: 1,
        averageScore: 0.6,
        minScore: 0.6,
        maxScore: 0.6,
      },
    };
    s.skillInventory = {
      startedAt: s.attribution.startedAt,
      agents: { main: { observedTurns: 3, skills: { one: {}, two: {} } } },
    };
    s.daily["2026-08-01"].toolErrors = { "value:exec": 1, __other__: 2 };
  });
  const stats = runAudit().runtime.stats;
  const reason = stats.intentPortfolio.routeReasonAttribution.byIntent.example;
  assert.equal(reason.totalRoutes, 4);
  assert.equal(reason.averageScore, 0.7625);
  assert.equal(reason.minScore, 0.6);
  assert.equal(reason.maxScore, 0.9);
  assert.equal(stats.attribution.dailyBucketsBeforeAttribution, 0);
  assert.deepEqual(stats.skillInventory, {
    status: "available",
    startedAt: "2026-08-01T00:02:00.000Z",
    agentCount: 1,
    observedTurns: 3,
    trackedSkillRecords: 2,
    maxTrackedSkillRecordsPerAgent: 2,
  });
  assert.equal(JSON.stringify(stats.skillInventory).includes("main"), false);
  assert.equal(stats.toolReliability.latencyHistogram.buckets["100-499"], 2);
  assert.equal("dailyDynamicKeyCardinality" in stats.dataHealth, false);
});
for (const [name, version, expected] of [
  ["review.json", 8, "schema-v9"],
  ["stats.json", 5, "schema-v7"],
]) {
  test(`rejects non-current ${name}`, () => {
    update(name, (v) => (v.schemaVersion = version));
    const r = cli(["--stdout"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(expected));
    assert.equal(r.stdout, "");
  });
}
test("windows distinguish missing metrics and do not claim accuracy", () => {
  const r = report();
  const recent = r.analysis.windows.recent;
  assert.equal(recent.start, "2026-08-01T00:00:00+00:00");
  assert.equal(recent.endExclusive, "2026-08-08T00:00:00+00:00");
  assert.equal(recent.daily.status, "partial");
  assert.equal(recent.daily.discoveryBuckets, 0);
  assert.equal(recent.daily.skillDiscovery.nameMatch.hitTurns.rate, null);
  assert.equal(recent.review.eventCount, 2);
  assert.equal(recent.review.outcomeRates.applied.rate, 0.5);
  assert.equal(recent.review.queueState, "unobserved");
  assert.equal(
    r.analysis.windows.previous.review.outcomeRates.applied.rate,
    null,
  );
  assert.equal(r.analysis.cumulative.skills.topUnadopted[0].lowSample, true);
  assert.equal(
    "conversionRate" in r.analysis.cumulative.skillDiscovery.qmdSearch,
    false,
  );
});
test("deduplicates mixed pre-retirement and skill-only sessions", () => {
  writeSession(turn("turn", undefined, [], ["manual"]), [
    {
      ...turn("turn", undefined, ["DISCARDED_SKILL"], ["DISCARDED_SKILL"]),
      matchedExperiences: ["private-id"],
    },
  ]);
  const r = report();
  const s = r.analysis.windows.recent.sessions;
  assert.equal(s.routedTurns, 1);
  assert.equal(s.selection.nonEmptyWithoutInjection.rate, 1);
  assert.equal(s.skills.topUsedWithoutInjection[0].skill, "manual");
  assert.equal(r.analysis.sessionDataQuality.duplicateTurns, 1);
  for (const secret of [
    "SECRET_TRANSCRIPT",
    "SECRET_RESULT",
    "SECRET_PAYLOAD",
    "/private",
    "private-id",
    "DISCARDED_SKILL",
  ])
    assert.equal(JSON.stringify(r.analysis).includes(secret), false);
});
test("completed history precedes incomplete current", () => {
  const pending = turn("turn", undefined, ["pending"]);
  delete pending.timestamps.end;
  writeSession(pending, [turn("turn", undefined, ["verified"], ["verified"])]);
  const s = report().analysis.windows.recent.sessions;
  assert.equal(s.skills.topUsed[0].skill, "verified");
  assert.equal(s.completeUsageTurns, 1);
});
test("empty and unknown pools retain separate denominators and invalid turn counts", () => {
  const empty = turn("empty");
  empty.inputSkillDiscovery.candidateCount = 0;
  const unknown = turn("unknown");
  delete unknown.inputSkillDiscovery.candidateCount;
  const invalid = turn("invalid");
  invalid.timestamps = { start: "invalid" };
  writeSession(empty, [
    turn("unselected"),
    unknown,
    invalid,
    { matchedSkills: [], matchedExperiences: [] },
  ]);
  const r = report();
  const s = r.analysis.windows.recent.sessions;
  assert.equal(s.selection.emptyPoolTurns, 1);
  assert.deepEqual(s.selection.nonEmptyWithoutInjection, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(r.analysis.sessionDataQuality.invalidTimestamps, 1);
  assert.equal(r.analysis.sessionDataQuality.unidentifiedTurns, 1);
});
test("relation-only selection is not QMD evidence", () => {
  update("stats.json", (s) => {
    s.skillDiscovery.qmdSearch = {
      attemptedTurns: 0,
      matchedTurns: 0,
      candidates: 0,
      injectedSkills: 0,
      semanticScore: { count: 0 },
      collections: {},
      injectedCollections: {},
    };
    s.skillDiscovery.pool = {
      nonEmptyTurns: 1,
      candidates: 2,
      injectedTurns: 1,
      injectedSkills: 1,
    };
  });
  const t = turn("turn", undefined, ["related-skill"], ["related-skill"]);
  Object.assign(t.inputSkillDiscovery, {
    relatedCandidates: 1,
    retrievalCandidates: 0,
    retrievalAttempted: false,
    injectedSkills: [{ name: "related-skill", sources: ["related-declared"] }],
  });
  writeSession(t);
  const d = report().analysis.cumulative.skillDiscovery;
  assert.equal(d.pool.injectedSkills, 1);
  assert.equal(d.qmdSearch.candidates, 0);
  assert.equal(d.qmdSearch.injectedSkillCount, 0);
  assert.equal(d.qmdSearch.semanticScore.count, 0);
  assert.deepEqual(d.qmdSearch.collections, {});
  assert.deepEqual(d.qmdSearch.injectedCollections, {});
});
test("daily windows exclude today and aggregate weighted scores without overflow attribution", () => {
  update("stats.json", (s) => {
    s.attribution.startedAt = "2026-07-31T00:00:00Z";
    const base = s.daily["2026-08-01"];
    base.skillDiscovery = s.skillDiscovery;
    base.skillRouting = {
      "value:example-skill": { intentMatchedTurns: 2, adoptedTurns: 1 },
    };
    s.daily["2026-08-02"] = structuredClone(base);
    s.daily["2026-08-02"].skillDiscovery.qmdSearch.semanticScore = {
      count: 1,
      average: 0.5,
      min: 0.5,
      max: 0.5,
    };
    s.daily["2026-07-31"] = structuredClone(base);
    s.daily["2026-08-08"] = structuredClone(base);
    s.daily["2026-08-08"].turns = 1000;
  });
  const w = report().analysis.windows;
  assert.equal(w.recent.daily.turns, 4);
  assert.equal(w.previous.daily.turns, 2);
  assert.equal(w.recent.daily.skillDiscovery.qmdSearch.semanticScore.count, 3);
  assert.equal(
    w.recent.daily.skillDiscovery.qmdSearch.semanticScore.average,
    0.7,
  );
  assert.equal(w.recent.daily.topUnadoptedSkills[0].unadoptedTurns, 2);
  update(
    "stats.json",
    (s) =>
      (s.daily["2026-08-02"].skillRouting.__other__ = {
        intentMatchedTurns: 1,
      }),
  );
  assert.deepEqual(
    report().analysis.windows.recent.daily.topUnadoptedSkills,
    [],
  );
});
test("missing logs remain unavailable and source hash changes reject reports", () => {
  remove("review.json");
  const r = report();
  assert.deepEqual(r.runtime.review, { status: "unavailable" });
  assert.deepEqual(Object.keys(r.provenance.stateSha256), ["stats.json"]);
  let call = 0;
  assert.throws(
    () => report(7, { hashFile: () => (++call === 1 ? "before" : "after") }),
    /changed while being read/,
  );
  remove("stats.json");
  const empty = report();
  assert.deepEqual(empty.runtime.stats, { status: "unavailable" });
  assert.equal(empty.analysis.cumulative.statsStatus, "unavailable");
});
test("review multi-trigger outcomes count committed changes only", () => {
  update("review.json", (r) => {
    r.processedEvents = Object.fromEntries(
      [
        "applied",
        "nofinding",
        "parse-failed",
        "schema-rejected",
        "validation-failed",
        "subagent-error",
      ].map((outcome) => [
        outcome,
        {
          ...(outcome === "applied"
            ? r.processedEvents["event-1"]
            : NO_FINDING_EVENT),
          outcome,
          triggers: ["capability-fit", "routing-uncertainty"],
          ...(outcome === "schema-rejected"
            ? { schemaRejectionReasonCounts: { "missing-target": 1 } }
            : {}),
        },
      ]),
    );
  });
  const r = report().analysis.windows.recent.review;
  assert.equal(r.eventCount, 6);
  assert.equal(r.triggerEvents["capability-fit"], 6);
  assert.equal(r.changes.total, 1);
  assert.deepEqual(r.schemaRejectionReasons, { "missing-target": 1 });
  assert.equal(JSON.stringify(r).includes("PRIVATE"), false);
});
test("relation inspection separates reported proposals from committed operations", () => {
  update("review.json", (r) => {
    r.processedEvents = {
      proposed: {
        ...NO_FINDING_EVENT,
        processedAt: "2026-08-01T00:00:00Z",
        outcome: "validation-failed",
        relationPreparation: {
          status: "ready",
          requestedSeeds: 2,
          capturedSeeds: 2,
          capturedExtras: 3,
          existingNeighborAttempts: 2,
          discoveryAttempts: 1,
          skippedCaptureCount: 0,
        },
        relationReview: {
          existing: "no-change",
          discovery: "changes-proposed",
        },
        relationSearchCount: 2,
      },
      skipped: {
        ...NO_FINDING_EVENT,
        processedAt: "2026-08-01T00:01:00Z",
        outcome: "skipped",
        relationPreparation: {
          ...SKIPPED_PREPARATION,
          reason: "no-eligible-seeds",
        },
      },
      historical: { ...NO_FINDING_EVENT, processedAt: "2026-08-01T00:02:00Z" },
    };
  });
  const r = report().runtime.review.processedEvents.relationInspection;
  assert.deepEqual(r, {
    preparation: { ready: 1, skipped: 1 },
    skipReasons: { "no-eligible-seeds": 1 },
    existingAssessments: { "no-change": 1 },
    discoveryAssessments: { "changes-proposed": 1 },
    searchCalls: 2,
    committedOperations: {},
    eventsWithoutPreparation: 1,
  });
});
test("a skipped preparation is counted separately from completed reviews", () => {
  update("review.json", (r) => {
    r.processedEvents = {
      completed: NO_FINDING_EVENT,
      skipped: {
        ...NO_FINDING_EVENT,
        processedAt: "2026-08-01T01:00:00Z",
        outcome: "skipped",
        relationPreparation: SKIPPED_PREPARATION,
      },
    };
  });
  const review = report().analysis.windows.recent.review;
  assert.equal(review.skippedPreparations, 1);
  assert.equal(review.eventCount, 1);
  assert.deepEqual(review.outcomeRates.nofinding, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(review.lastCompletedAt, NO_FINDING_EVENT.processedAt);
  update("review.json", (r) => delete r.processedEvents.completed);
  const skipOnly = report().analysis.windows.recent.review;
  assert.equal(skipOnly.skippedPreparations, 1);
  assert.equal(skipOnly.eventCount, 0);
  assert.equal(skipOnly.outcomeRates.nofinding.rate, null);
  assert.equal(skipOnly.lastCompletedAt, null);
});
test("rejects invalid v9 receipts even outside the reporting window without exposing private data", () => {
  const applied = FIXTURE["review.json"].processedEvents["event-1"];
  const malformed = [
    { ...applied, relationBatchId: undefined },
    { ...applied, changedRelationCount: 7 },
    { ...NO_FINDING_EVENT, relationPreparation: SKIPPED_PREPARATION },
    { ...NO_FINDING_EVENT, outcome: "skipped" },
    { ...NO_FINDING_EVENT, triggers: ["experience-health-check"] },
    { ...NO_FINDING_EVENT, PRIVATE_UNKNOWN_FIELD: "PRIVATE_VALUE" },
  ];
  for (const event of malformed) {
    update("review.json", (r) => {
      r.processedEvents.PRIVATE_EVENT_ID = {
        ...event,
        processedAt: "2026-01-01T00:00:00.000Z",
      };
    });
    assert.throws(() => report(), {
      message: "review.json must be a valid schema-v9 review log",
    });
  }
  const result = cli(["--stdout"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /schema-v9/);
  assert.doesNotMatch(result.stderr, /PRIVATE/);
});
test("multiple skill indexes aggregate failures without exposing names", () => {
  for (const name of ["secret-one", "secret-two", "missing", "corrupt"])
    fs.mkdirSync(path.join(root, "qmd/skills/indexes", name, "docs"), {
      recursive: true,
    });
  for (const name of ["secret-one", "secret-two"])
    fs.copyFileSync(
      path.join(root, "qmd/intents/intent-routing.sqlite"),
      path.join(root, "qmd/skills/indexes", name, "skill-search.sqlite"),
    );
  const db = new DatabaseSync(
    path.join(root, "qmd/skills/indexes/secret-two/skill-search.sqlite"),
  );
  db.exec(
    "DELETE FROM content_vectors WHERE id = 2; UPDATE embedding_index_state SET lease_expires_at = 1000000000000000",
  );
  db.close();
  write("qmd/skills/indexes/corrupt/skill-search.sqlite", "broken");
  const r = report().runtime.qmd.skills;
  assert.equal(r.indexCount, 4);
  assert.equal(r.unavailableCount, 2);
  assert.equal(r.activeLeaseCount, 1);
  assert.equal(r.documentVectorMismatchCount, 1);
  assert.equal(JSON.stringify(r).includes("secret"), false);
});
test("cohort boundary and retention coverage are explicit", () => {
  update(
    "stats.json",
    (s) => (s.attribution.startedAt = "2026-08-02T12:00:00Z"),
  );
  const d = report().analysis.windows.recent.daily;
  assert.equal(d.excludedPreCohortBuckets, 1);
  assert.equal(d.cohortStartedDuringWindow, true);
  assert.equal(d.turns, null);
  assert.equal(
    report(30).analysis.windows.recent.sessions.extendsBeforeRetention,
    true,
  );
  assert.equal(isoTimestamp("2026-08-01T12:00:00"), null);
});
test("CLI rejects invalid days and mutually exclusive outputs", () => {
  for (const days of ["0", "91", "invalid"]) {
    const r = cli(["--stdout", "--days", days]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  }
  for (const args of [
    [],
    ["--stdout", "--output", path.join(root, "out.json")],
  ])
    assert.notEqual(cli(args).status, 0);
  assert.equal(cli(["--help"]).status, 0);
});
test("nested symlink directories are not traversed and linked skill indexes are excluded", () => {
  fs.symlinkSync(
    path.join(root, "qmd/intents"),
    path.join(root, "qmd/intents/keywords/loop"),
  );
  fs.mkdirSync(path.join(root, "qmd/skills/indexes"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "qmd/intents"),
    path.join(root, "qmd/skills/indexes/link"),
  );
  const r = report();
  assert.equal(r.runtime.qmd.skills.indexCount, 0);
});
test("invalid calendar timestamps are rejected without normalizing into observations", () => {
  for (const timestamp of [
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "0000-01-01T00:00:00Z",
  ])
    assert.equal(isoTimestamp(timestamp), null, timestamp);
  assert.equal(
    isoTimestamp("2024-02-29T12:30:45.123+08:00"),
    Date.parse("2024-02-29T04:30:45.123Z") / 1000,
  );
  const invalid = turn();
  invalid.timestamps = {
    start: "2026-02-30T00:01:00Z",
    end: "2026-02-30T00:02:00Z",
  };
  writeSession(invalid);
  assert.equal(report().analysis.sessionDataQuality.invalidTimestamps, 1);
});
test("rate rounding preserves the original ties-to-even contract", () => {
  update("stats.json", (s) => {
    s.tools.exec.calls = 32;
    s.tools.exec.errorCalls = 1;
    s.daily["2026-08-01"].turns = 32;
    s.daily["2026-08-01"].erroredTurns = 1;
  });
  const r = report();
  assert.equal(r.runtime.stats.toolReliability.errorRate, 0.0312);
  assert.equal(r.analysis.windows.recent.daily.erroredTurns.rate, 0.0312);
});
test("malformed runtime JSON diagnostics do not leak rejected bytes", () => {
  for (const target of ["stats.json", "review.json"]) {
    const original = fs.readFileSync(path.join(root, target));
    write(target, "PRIVATE_SECRET_TEXT");
    const result = cli(["--stdout"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("PRIVATE"), false);
    assert.match(result.stderr, /cannot read JSON/);
    fs.writeFileSync(path.join(root, target), original);
  }
});
test("atomic report output remains mode 0600 under a restrictive umask", () => {
  const output = path.join(root, "restricted-report.json");
  write("umask.cjs", "process.umask(0o777);\n");
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      path.join(root, "umask.cjs"),
      SCRIPT,
      "--data-root",
      root,
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});
