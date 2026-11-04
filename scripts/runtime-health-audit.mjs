#!/usr/bin/env node
/** Report-only Skill Harness runtime health and Review-change distribution audit. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const SCRIPT_PATH = fs.realpathSync(fileURLToPath(import.meta.url));
const RETENTION_DAYS = 14;
const STATS_DAILY_RETENTION_DAYS = 90;
const TOP_TARGETS = 10;
const DAY_MS = 86_400_000;
const LATENCY_BUCKETS = [
  "unknown",
  "0-99",
  "100-499",
  "500-999",
  "1000-4999",
  "5000+",
];
const ROUTE_REASONS = ["qmd-keyword", "qmd-hybrid", "llm-classifier"];
const OUTCOMES = [
  "applied",
  "partially-applied",
  "nofinding",
  "schema-rejected",
  "parse-failed",
  "subagent-error",
  "validation-failed",
];
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const objectOrEmpty = (value) => (isObject(value) ? value : {});
const entries = (value) => Object.entries(objectOrEmpty(value));
const values = (value) => Object.values(objectOrEmpty(value));
const size = (value) => Object.keys(objectOrEmpty(value)).length;
const number = (value) => (typeof value === "number" ? value : 0);
const observedNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const sum = (list) => list.reduce((total, value) => total + value, 0);
const minOrNull = (list) => (list.length ? Math.min(...list) : null);
const maxOrNull = (list) => (list.length ? Math.max(...list) : null);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Preserve Python's rounding of the exact IEEE-754 value, including half-even ties.
function round(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent ? (1n << 52n) | fraction : fraction;
  const power = (exponent || 1) - 1023 - 52;
  let numerator = mantissa * 10n ** BigInt(digits);
  const denominator = power < 0 ? 1n << BigInt(-power) : 1n;
  if (power > 0) numerator <<= BigInt(power);
  let rounded = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (
    twiceRemainder > denominator ||
    (twiceRemainder === denominator && rounded % 2n)
  )
    rounded++;
  return Number(`${value < 0 ? "-" : ""}${rounded}e-${digits}`);
}
const counter = () => new Map();
const increment = (counts, key, count = 1) =>
  counts.set(key, (counts.get(key) ?? 0) + count);
const counterDict = (counts) =>
  Object.fromEntries([...counts].sort(([a], [b]) => compare(a, b)));
const topCounts = (counts, field) =>
  [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TARGETS)
    .map(([name, count]) => ({ [field]: name, changes: count }));
const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
const nested = (value, ...keys) =>
  keys.reduce((current, key) => objectOrEmpty(current)[key], value);
const observedSum = (rows, ...keys) => {
  const numbers = rows.map((row) => observedNumber(nested(row, ...keys)));
  return rows.length && numbers.every((n) => n !== null) ? sum(numbers) : null;
};
const ratio = (numerator, denominator) => ({
  numerator,
  denominator,
  rate:
    numerator !== null && denominator ? round(numerator / denominator) : null,
});
const numericSummary = (numbers) => ({
  count: numbers.length,
  average: numbers.length ? round(sum(numbers) / numbers.length) : null,
  min: minOrNull(numbers),
  max: maxOrNull(numbers),
});
const stat = (target) => {
  try {
    return fs.statSync(target);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return null;
    throw error;
  }
};
const isFile = (target) => stat(target)?.isFile() ?? false;
const isDirectory = (target) => stat(target)?.isDirectory() ?? false;
const children = (root) =>
  isDirectory(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .sort((a, b) => compare(a.name, b.name))
    : [];
const directFiles = (root, suffix) =>
  children(root)
    .filter((entry) => entry.name.endsWith(suffix))
    .map((entry) => path.join(root, entry.name));
// Match pathlib traversal: count regular symlink targets but never recurse into nested directory links.
function walk(root) {
  const result = [];
  for (const entry of children(root)) {
    const target = path.join(root, entry.name);
    result.push(target);
    if (entry.isDirectory()) result.push(...walk(target));
  }
  return result;
}
export function sha256(target) {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}
function loadJson(target) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    // JSON.parse messages can contain rejected source bytes from private runtime state.
    throw new Error(`cannot read JSON: ${target}`);
  }
  if (!isObject(value))
    throw new Error(`JSON root must be an object: ${target}`);
  return value;
}
function requireObject(value, field, target) {
  if (!isObject(value[field]))
    throw new Error(`${target} has invalid ${field}`);
  return value[field];
}
function loadReviewLog(target) {
  const value = loadJson(target);
  if (value.schemaVersion !== 8)
    throw new Error(`${target} must be a current schema-v8 review log`);
  for (const field of ["processedEvents", "reviewedSkillEpochs"])
    requireObject(value, field, target);
  return value;
}
function loadStats(target) {
  const value = loadJson(target);
  if (value.schemaVersion !== 7)
    throw new Error(`${target} must be a current schema-v7 stats log`);
  for (const field of ["summary", "routing", "projection", "skillDiscovery"])
    requireObject(value, field, target);
  const attribution = requireObject(value, "attribution", target);
  if (typeof attribution.startedAt !== "string")
    throw new Error(`${target} has invalid attribution.startedAt`);
  for (const [intentId, intent] of entries(value.intents)) {
    if (!isObject(intent))
      throw new Error(`${target} has invalid intents.${intentId}`);
    const reasons = intent.routeReasons;
    if (reasons === undefined || reasons === null) continue;
    if (
      !isObject(reasons) ||
      Object.keys(reasons).sort().join("\0") !==
        [...ROUTE_REASONS].sort().join("\0")
    )
      throw new Error(`${target} has invalid routeReasons for ${intentId}`);
    for (const reason of ROUTE_REASONS) {
      const row = reasons[reason];
      if (
        !isObject(row) ||
        !Number.isInteger(row.count) ||
        row.count < 0 ||
        [row.averageScore, row.minScore, row.maxScore].some(
          (score) => typeof score !== "number" || score < 0 || score > 1,
        )
      )
        throw new Error(
          `${target} has invalid route score for ${intentId}.${reason}`,
        );
    }
  }
  return value;
}

export function isoTimestamp(value) {
  if (typeof value !== "string") return null;
  // Validate the calendar before Date.parse can normalize it into another day.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:?\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText ?? "0",
  ].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const parsed = Date.parse(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}
function isoDate(value) {
  const text = new Date(value).toISOString();
  return text.endsWith(".000Z")
    ? text.replace(".000Z", "+00:00")
    : text.replace(/(\.\d{3})Z$/, "$1000+00:00");
}
function countFiles(root) {
  const files = walk(root).filter(isFile);
  return [files.length, sum(files.map((target) => fs.statSync(target).size))];
}
function qmdDatabaseHealth(snapshotRoot, databasePath) {
  const snapshotMarkdownFiles = walk(snapshotRoot).filter((target) =>
    target.endsWith(".md"),
  ).length;
  const unavailable = {
    databaseStatus: "unavailable",
    integrityCheck: null,
    generation: null,
    leaseActive: null,
    snapshotMarkdownFiles,
    indexedDocuments: null,
    indexedVectors: null,
    documentsMatchVectors: null,
    snapshotMatchesIndexedDocuments: null,
  };
  if (!isFile(databasePath)) return unavailable;
  let db;
  let integrityCheck, state, indexedDocuments, indexedVectors;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    integrityCheck = Object.values(
      db.prepare("PRAGMA integrity_check").get(),
    )[0];
    const optional = (query) => {
      try {
        return db.prepare(query).get();
      } catch {
        return null;
      }
    };
    state = optional(
      "SELECT status, generation, lease_expires_at FROM embedding_index_state WHERE singleton = 1",
    );
    const docs = optional(
      "SELECT COUNT(*) AS count FROM documents WHERE active = 1",
    );
    const vectors = optional("SELECT COUNT(*) AS count FROM content_vectors");
    indexedDocuments = docs?.count ?? null;
    indexedVectors = vectors?.count ?? null;
  } catch {
    return unavailable;
  } finally {
    if (db) db.close();
  }
  return {
    databaseStatus: state?.status ?? "unknown",
    integrityCheck,
    generation: state?.generation ?? null,
    leaseActive:
      typeof state?.lease_expires_at === "number" &&
      state.lease_expires_at > Date.now(),
    snapshotMarkdownFiles,
    indexedDocuments,
    indexedVectors,
    documentsMatchVectors:
      indexedDocuments !== null && indexedVectors !== null
        ? indexedDocuments === indexedVectors
        : null,
    snapshotMatchesIndexedDocuments:
      indexedDocuments !== null
        ? snapshotMarkdownFiles === indexedDocuments
        : null,
  };
}
function qmdHealth(root) {
  const experiences = path.join(root, "experiences"),
    intents = path.join(root, "intents");
  const useExperiences =
    isFile(path.join(experiences, "experience-routing.sqlite")) ||
    (isDirectory(experiences) &&
      !isFile(path.join(intents, "intent-routing.sqlite")));
  const snapshot = useExperiences ? experiences : intents;
  return qmdDatabaseHealth(
    snapshot,
    path.join(
      snapshot,
      useExperiences ? "experience-routing.sqlite" : "intent-routing.sqlite",
    ),
  );
}
function skillQmdHealth(root) {
  const roots = children(root)
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name));
  const rows = roots.map((target) =>
    qmdDatabaseHealth(
      path.join(target, "docs"),
      path.join(target, "skill-search.sqlite"),
    ),
  );
  const statuses = counter();
  for (const row of rows) increment(statuses, row.databaseStatus);
  return {
    status: rows.length ? "available" : "unavailable",
    indexCount: rows.length,
    byStatus: counterDict(statuses),
    unavailableCount: rows.filter((r) => r.databaseStatus === "unavailable")
      .length,
    integrityFailureCount: rows.filter(
      (r) => r.integrityCheck !== null && r.integrityCheck !== "ok",
    ).length,
    activeLeaseCount: rows.filter((r) => r.leaseActive === true).length,
    documentVectorMismatchCount: rows.filter(
      (r) => r.documentsMatchVectors === false,
    ).length,
    unknownDocumentVectorCount: rows.filter(
      (r) => r.documentsMatchVectors === null,
    ).length,
    snapshotMismatchCount: rows.filter(
      (r) => r.snapshotMatchesIndexedDocuments === false,
    ).length,
  };
}
function sessionHealth(sessionsDir, agentsDir) {
  const cutoff = Date.now() / 1000 - RETENTION_DAYS * 86_400;
  const files = directFiles(sessionsDir, ".json");
  let invalid = 0,
    missingCurrent = 0,
    invalidHistory = 0,
    stale = 0;
  for (const target of files) {
    let session;
    try {
      session = loadJson(target);
    } catch {
      invalid++;
      continue;
    }
    if (typeof session.sessionId !== "string" || !session.sessionId.trim())
      invalid++;
    if (!isObject(session.current)) {
      missingCurrent++;
      continue;
    }
    if ("history" in session && !Array.isArray(session.history))
      invalidHistory++;
    const end = isoTimestamp(nested(session.current, "timestamps", "end"));
    if (end !== null && end < cutoff) stale++;
  }
  const [agentFiles, agentBytes] = countFiles(agentsDir);
  return {
    retentionDays: RETENTION_DAYS,
    sessionFiles: files.length,
    invalidSessionFiles: invalid,
    sessionsMissingCurrent: missingCurrent,
    sessionsWithInvalidHistory: invalidHistory,
    sessionsOlderThanRetentionByCurrentEnd: stale,
    agentArtifactFiles: agentFiles,
    agentArtifactBytes: agentBytes,
    agentArtifactsOlderThanRetentionByMtime: walk(agentsDir).filter(
      (target) => isFile(target) && fs.statSync(target).mtimeMs / 1000 < cutoff,
    ).length,
  };
}
function countExperiences(root) {
  const dirs = children(root).filter((entry) =>
    isDirectory(path.join(root, entry.name)),
  );
  const files = walk(root).filter(
    (target) => target.endsWith(".md") && isFile(target),
  );
  return {
    count: dirs.length,
    markdownFiles: files.length,
    bytes: sum(files.map((target) => fs.statSync(target).size)),
  };
}

function reviewChangeSummary(events) {
  const outcomes = counter(),
    changesPerEvent = counter(),
    changesByTrigger = counter(),
    operations = counter(),
    targetIntents = counter(),
    targetExperiences = counter(),
    triggerEvents = counter(),
    noFindingReasons = counter(),
    schemaRejectionReasons = counter(),
    preparation = counter(),
    skipReasons = counter(),
    existingAssessments = counter(),
    discoveryAssessments = counter(),
    committedOperations = counter();
  let searchCalls = 0,
    eventsWithoutPreparation = 0,
    invalidRecords = 0;
  for (const event of values(events)) {
    if (!isObject(event)) {
      invalidRecords++;
      continue;
    }
    const outcome = event.outcome;
    increment(outcomes, typeof outcome === "string" ? outcome : "<non-string>");
    const prep = event.relationPreparation;
    if (isObject(prep) && ["ready", "skipped"].includes(prep.status)) {
      increment(preparation, prep.status);
      if (
        [
          "no-seeds",
          "registry-unavailable",
          "no-eligible-seeds",
          "preparation-failed",
          "no-data-root",
        ].includes(prep.reason)
      )
        increment(skipReasons, prep.reason);
    } else eventsWithoutPreparation++;
    const assessment = objectOrEmpty(event.relationReview);
    for (const [field, counts] of [
      ["existing", existingAssessments],
      ["discovery", discoveryAssessments],
    ])
      if (
        ["changes-proposed", "no-change", "not-applicable"].includes(
          assessment[field],
        )
      )
        increment(counts, assessment[field]);
    if (
      Number.isInteger(event.relationSearchCount) &&
      event.relationSearchCount >= 0 &&
      event.relationSearchCount <= 4
    )
      searchCalls += event.relationSearchCount;
    for (const trigger of Array.isArray(event.triggers) ? event.triggers : [])
      if (typeof trigger === "string") increment(triggerEvents, trigger);
    const changes =
      ["applied", "partially-applied"].includes(outcome) &&
      Array.isArray(event.changes)
        ? event.changes
        : [];
    increment(changesPerEvent, String(changes.length));
    for (const change of changes) {
      if (!isObject(change)) {
        invalidRecords++;
        continue;
      }
      if (typeof change.trigger === "string")
        increment(changesByTrigger, change.trigger);
      if (typeof change.operation === "string") {
        increment(operations, change.operation);
        if (
          change.targetKind === "skill-relation" &&
          ["create", "update", "delete"].includes(change.operation)
        )
          increment(committedOperations, change.operation);
      }
      for (const [field, counts] of [
        ["targetIntentIds", targetIntents],
        ["targetExperienceIds", targetExperiences],
      ])
        for (const id of Array.isArray(change[field]) ? change[field] : [])
          if (typeof id === "string") increment(counts, id);
    }
    for (const [field, counts] of [
      ["noFindingReasonCounts", noFindingReasons],
      ["schemaRejectionReasonCounts", schemaRejectionReasons],
    ])
      for (const [reason, count] of entries(event[field]))
        if (Number.isInteger(count)) increment(counts, reason, count);
  }
  const eventCount = sum([...outcomes.values()]),
    total = sum([...changesByTrigger.values()]),
    appliedEvents =
      (outcomes.get("applied") ?? 0) + (outcomes.get("partially-applied") ?? 0);
  return {
    eventCount,
    invalidRecords,
    outcomes: counterDict(outcomes),
    changes: {
      appliedEvents,
      total,
      averagePerAppliedEvent: appliedEvents
        ? round(total / appliedEvents, 2)
        : 0,
      eventsByChangeCount: counterDict(changesPerEvent),
      byTrigger: counterDict(changesByTrigger),
      byOperation: counterDict(operations),
      topTargetExperiences: topCounts(targetExperiences, "experience"),
      topTargetIntents: topCounts(targetIntents, "intent"),
    },
    triggerEvents: counterDict(triggerEvents),
    noFindingReasons: counterDict(noFindingReasons),
    schemaRejectionReasons: counterDict(schemaRejectionReasons),
    relationInspection: {
      preparation: counterDict(preparation),
      skipReasons: counterDict(skipReasons),
      existingAssessments: counterDict(existingAssessments),
      discoveryAssessments: counterDict(discoveryAssessments),
      searchCalls,
      committedOperations: counterDict(committedOperations),
      eventsWithoutPreparation,
    },
  };
}
function routeReasonSummary(value) {
  const byReason = {};
  let totalRoutes = 0,
    weighted = 0;
  const minima = [],
    maxima = [];
  for (const reason of ROUTE_REASONS) {
    const row = objectOrEmpty(objectOrEmpty(value)[reason]);
    const count = Math.trunc(number(row.count));
    const averageScore = number(row.averageScore),
      minScore = count ? number(row.minScore) : null,
      maxScore = count ? number(row.maxScore) : null;
    byReason[reason] = { count, averageScore, minScore, maxScore };
    totalRoutes += count;
    weighted += count * averageScore;
    if (minScore !== null) minima.push(minScore);
    if (maxScore !== null) maxima.push(maxScore);
  }
  return {
    totalRoutes,
    averageScore: totalRoutes ? round(weighted / totalRoutes) : 0,
    minScore: minOrNull(minima),
    maxScore: maxOrNull(maxima),
    byReason,
  };
}
function skillInventorySummary(stats) {
  const inventory = objectOrEmpty(stats.skillInventory),
    agents = objectOrEmpty(inventory.agents);
  if (typeof inventory.startedAt !== "string")
    return {
      status: "unavailable",
      agentCount: 0,
      observedTurns: 0,
      trackedSkillRecords: 0,
      maxTrackedSkillRecordsPerAgent: 0,
    };
  const counts = values(agents).map((agent) => size(nested(agent, "skills")));
  return {
    status: "available",
    startedAt: inventory.startedAt,
    agentCount: size(agents),
    observedTurns: sum(
      values(agents).map((agent) =>
        Math.trunc(number(objectOrEmpty(agent).observedTurns)),
      ),
    ),
    trackedSkillRecords: sum(counts),
    maxTrackedSkillRecordsPerAgent: counts.length ? Math.max(...counts) : 0,
  };
}
function statsSummary(stats) {
  const summary = stats.summary,
    routing = stats.routing,
    projection = stats.projection,
    intents = objectOrEmpty(stats.intents),
    skills = objectOrEmpty(stats.skills),
    tools = objectOrEmpty(stats.tools),
    daily = objectOrEmpty(stats.daily);
  const attribution = objectOrEmpty(stats.attribution),
    startedAt = attribution.startedAt,
    startedDate = typeof startedAt === "string" ? startedAt.slice(0, 10) : null;
  const intentRows = entries(intents)
    .map(([intent, value]) => ({
      intent,
      turns: number(objectOrEmpty(value).turns),
      share: number(objectOrEmpty(value).share),
      erroredTurns: number(objectOrEmpty(value).erroredTurns),
      lowConfidenceTurns: number(objectOrEmpty(value).lowConfidenceTurns),
    }))
    .sort((a, b) => b.turns - a.turns || compare(a.intent, b.intent));
  const lifecycles = counter(),
    lowAdoption = [];
  for (const [skill, value] of entries(skills)) {
    const row = objectOrEmpty(value);
    if (typeof row.lifecycle === "string") increment(lifecycles, row.lifecycle);
    if (row.needsReview === true)
      lowAdoption.push({
        skill,
        intentMatchedTurns: number(row.intentMatchedTurns),
        adoptedTurns: number(row.adoptedTurns),
        adoptionRate: number(row.adoptionRate),
        lifecycle:
          typeof row.lifecycle === "string" ? row.lifecycle : "<invalid>",
      });
  }
  lowAdoption.sort(
    (a, b) =>
      b.intentMatchedTurns - a.intentMatchedTurns || compare(a.skill, b.skill),
  );
  const toolRows = [],
    histogram = Object.fromEntries(LATENCY_BUCKETS.map((key) => [key, 0]));
  let calls = 0,
    errors = 0,
    histogramToolCount = 0;
  for (const [tool, value] of entries(tools)) {
    const row = objectOrEmpty(value),
      n = number(row.calls),
      e = number(row.errorCalls);
    calls += n;
    errors += e;
    if (isObject(row.latencyHistogram)) {
      histogramToolCount++;
      for (const bucket of LATENCY_BUCKETS)
        histogram[bucket] += Math.trunc(number(row.latencyHistogram[bucket]));
    }
    toolRows.push({
      tool,
      calls: n,
      errorCalls: e,
      errorRate: n ? round(e / n) : 0,
      averageDurationMs: number(row.averageDurationMs),
    });
  }
  toolRows.sort(
    (a, b) =>
      b.errorCalls - a.errorCalls ||
      b.calls - a.calls ||
      compare(a.tool, b.tool),
  );
  return {
    schemaVersion: stats.schemaVersion,
    createdAt: stats.createdAt ?? null,
    updatedAt: stats.updatedAt ?? null,
    attribution: {
      status: "fresh-v7-window",
      startedAt,
      dailyBucketsBeforeAttribution: Object.keys(daily).filter(
        (date) => startedDate !== null && date < startedDate,
      ).length,
      note: "Schema v7 begins a fresh telemetry cohort at startedAt.",
    },
    summary: {
      ...pick(summary, [
        "turns",
        "completedTurns",
        "erroredTurns",
        "skillAssistedTurns",
        "toolAssistedTurns",
        "averageConfidence",
      ]),
      unknownTurns: summary.unknownTurns ?? summary.otherTurns ?? null,
      unknownRate: summary.unknownRate ?? summary.otherRate ?? null,
    },
    routing: pick(routing, [
      "intentMatchedTurns",
      "adoptedTurns",
      "turnAdoptionRate",
      "intentMatchedSkillOpportunities",
      "adoptedSkillOpportunities",
      "skillAdoptionRate",
    ]),
    skillDiscovery: {
      turns: number(stats.skillDiscovery.turns),
      ...pick(stats.skillDiscovery, [
        "nameMatch",
        "qmdSearch",
        "pool",
        "fallbackReasons",
        "durationMs",
      ]),
    },
    projection: pick(projection, [
      "eligibleTurns",
      "projectedTurns",
      "fullFallbackTurns",
      "projectedRate",
      "fullFallbackRate",
      "averageOriginalIntentCount",
      "averageCandidateIntentCount",
      "averageOriginalCatalogCodePoints",
      "averageCandidateCatalogCodePoints",
      "averageDurationMs",
      "fallbackReasons",
    ]),
    intentPortfolio: {
      trackedIntents: size(intents),
      erroredTurns: sum(intentRows.map((r) => r.erroredTurns)),
      lowConfidenceTurns: sum(intentRows.map((r) => r.lowConfidenceTurns)),
      topByTurns: intentRows.slice(0, TOP_TARGETS),
      routeReasonAttribution: {
        status: "available",
        scoreMeaning: "selected route confidence; QMD routes use hit score",
        byIntent: Object.fromEntries(
          entries(intents).map(([id, row]) => [
            id,
            routeReasonSummary(objectOrEmpty(row).routeReasons),
          ]),
        ),
      },
    },
    skillInventory: skillInventorySummary(stats),
    skillLifecycle: {
      trackedSkills: size(skills),
      byLifecycle: counterDict(lifecycles),
      needsReviewCount: lowAdoption.length,
      lowAdoptionCohort: lowAdoption.slice(0, TOP_TARGETS),
    },
    toolReliability: {
      trackedTools: size(tools),
      calls,
      errorCalls: errors,
      errorRate: calls ? round(errors / calls) : 0,
      topErrorTools: toolRows.slice(0, TOP_TARGETS),
      latencyHistogram: {
        status: "fresh-v7-window",
        toolCount: histogramToolCount,
        buckets: histogram,
      },
    },
    dataHealth: {
      statsUpdatedAt: stats.updatedAt ?? null,
      dailyRetentionDays: STATS_DAILY_RETENTION_DAYS,
      dailyBucketCount: size(daily),
      oldestDailyBucket: Object.keys(daily).sort()[0] ?? null,
      newestDailyBucket: Object.keys(daily).sort().at(-1) ?? null,
      retainedProcessedEventCount: size(stats.processedEvents),
    },
  };
}

function mergedScore(rows, ...keys) {
  let count = 0,
    weighted = 0,
    missingBuckets = 0;
  const minima = [],
    maxima = [];
  for (const row of rows) {
    const score = objectOrEmpty(nested(row, ...keys)),
      n = observedNumber(score.count),
      average = observedNumber(score.average),
      low = observedNumber(score.min),
      high = observedNumber(score.max);
    if (n === null || (n > 0 && [average, low, high].includes(null)))
      missingBuckets++;
    else if (n) {
      count += n;
      weighted += n * average;
      minima.push(low);
      maxima.push(high);
    }
  }
  return {
    count,
    average: count ? round(weighted / count) : null,
    min: minOrNull(minima),
    max: maxOrNull(maxima),
    missingBuckets,
  };
}
function mergedCounts(rows, ...keys) {
  const counts = counter();
  for (const row of rows)
    for (const [key, value] of entries(nested(row, ...keys))) {
      const n = observedNumber(value);
      if (n !== null) increment(counts, key, n);
    }
  return counterDict(counts);
}
function discoveryAnalysis(rows) {
  const turns = observedSum(rows, "turns"),
    attemptedTurns = observedSum(rows, "qmdSearch", "attemptedTurns");
  return {
    turns,
    nameMatch: {
      hitTurns: ratio(observedSum(rows, "nameMatch", "matchedTurns"), turns),
      candidates: observedSum(rows, "nameMatch", "candidates"),
    },
    qmdSearch: {
      attemptedTurns,
      hitTurns: ratio(
        observedSum(rows, "qmdSearch", "matchedTurns"),
        attemptedTurns,
      ),
      candidates: observedSum(rows, "qmdSearch", "candidates"),
      semanticScore: mergedScore(rows, "qmdSearch", "semanticScore"),
      collections: mergedCounts(rows, "qmdSearch", "collections"),
      collectionBuckets: rows.filter((row) =>
        isObject(nested(row, "qmdSearch", "collections")),
      ).length,
      injectedCollections: mergedCounts(
        rows,
        "qmdSearch",
        "injectedCollections",
      ),
      injectedCollectionBuckets: rows.filter((row) =>
        isObject(nested(row, "qmdSearch", "injectedCollections")),
      ).length,
      injectedSkillCount: observedSum(rows, "qmdSearch", "injectedSkills"),
      injectedCountMeaning:
        "includes experience-source skills; not pure skill-search conversion",
    },
    pool: {
      nonEmptyTurns: ratio(observedSum(rows, "pool", "nonEmptyTurns"), turns),
      skillInjectedTurns: ratio(
        observedSum(rows, "pool", "injectedTurns"),
        turns,
      ),
      candidates: observedSum(rows, "pool", "candidates"),
      injectedSkills: observedSum(rows, "pool", "injectedSkills"),
    },
    fallbackReasons: mergedCounts(rows, "fallbackReasons"),
    durationMs: mergedScore(rows, "durationMs"),
  };
}
function skillRows(stats) {
  return entries(stats.skills).map(([skill, value]) => {
    const row = objectOrEmpty(value),
      injectedTurns = observedNumber(row.intentMatchedTurns),
      adoptedTurns = observedNumber(row.adoptedTurns);
    return {
      skill,
      usageTurns: observedNumber(row.usageTurns),
      injectedTurns,
      adoptedTurns,
      unadoptedTurns:
        injectedTurns !== null &&
        adoptedTurns !== null &&
        adoptedTurns <= injectedTurns
          ? injectedTurns - adoptedTurns
          : null,
      adoption: ratio(adoptedTurns, injectedTurns),
      lowSample: injectedTurns === null || injectedTurns < 20,
      lastUsedAt: row.lastUsedAt ?? null,
      last7DaysUsage: observedNumber(row.last7DaysUsage),
      lifecycle: row.lifecycle ?? null,
    };
  });
}
function ranked(rows, metric) {
  return rows
    .filter((row) => observedNumber(row[metric]) !== null && row[metric] > 0)
    .sort((a, b) => b[metric] - a[metric] || compare(a.skill, b.skill))
    .slice(0, TOP_TARGETS);
}
function reviewAnalysis(review, start, end) {
  if (review === null) return { status: "unavailable" };
  const events = objectOrEmpty(review.processedEvents),
    selected = entries(events).filter(([, value]) => {
      const at = isoTimestamp(objectOrEmpty(value).processedAt);
      return isObject(value) && at !== null && start <= at && at < end;
    });
  const result = reviewChangeSummary(Object.fromEntries(selected));
  const completed = selected
    .map(([, value]) => value.processedAt)
    .sort((a, b) => isoTimestamp(b) - isoTimestamp(a));
  return {
    ...result,
    status: "observed-completed-events",
    outcomeRates: Object.fromEntries(
      OUTCOMES.map((outcome) => [
        outcome,
        ratio(result.outcomes[outcome] ?? 0, result.eventCount),
      ]),
    ),
    lastCompletedAt: completed[0] ?? null,
    invalidTimestamps: values(events).filter(
      (value) => isoTimestamp(objectOrEmpty(value).processedAt) === null,
    ).length,
    queueState: "unobserved",
  };
}
function nameList(value, records = false) {
  if (!Array.isArray(value)) return null;
  const names = records ? value.map((item) => objectOrEmpty(item).name) : value;
  return names.every((name) => typeof name === "string" && name.trim())
    ? new Set(names)
    : null;
}
function routingObservations(root) {
  const selected = new Map(),
    health = {
      invalidFiles: 0,
      unidentifiedTurns: 0,
      invalidTimestamps: 0,
      duplicateTurns: 0,
    };
  for (const target of directFiles(root, ".json")) {
    let session;
    try {
      session = loadJson(target);
    } catch {
      health.invalidFiles++;
      continue;
    }
    if (typeof session.sessionId !== "string" || !session.sessionId.trim()) {
      health.invalidFiles++;
      continue;
    }
    const history = Array.isArray(session.history) ? session.history : [];
    for (const [current, raw] of [
      ...history.map((row) => [false, row]),
      [true, session.current],
    ]) {
      if (!isObject(raw)) continue;
      const timestamps = objectOrEmpty(raw.timestamps),
        end = isoTimestamp(timestamps.end),
        at = end ?? isoTimestamp(timestamps.start),
        identity = raw.turnKey || timestamps.start;
      if (typeof identity !== "string" || !identity.trim()) {
        health.unidentifiedTurns++;
        continue;
      }
      if (at === null) {
        health.invalidTimestamps++;
        continue;
      }
      // Whitelist routing metadata; never retain transcript or tool payload fields.
      const discovery = objectOrEmpty(raw.inputSkillDiscovery);
      const record = {
        at,
        completed: end !== null,
        skills: nameList(raw.matchedSkills),
        experiences: nameList(raw.matchedExperiences),
        used: nameList(raw.skillsUsed, true),
        confidence: observedNumber(raw.confidence),
        discovery: pick(discovery, [
          "candidateCount",
          "nameCandidates",
          "retrievalAttempted",
          "retrievalCandidates",
          "durationMs",
        ]),
        experienceRetrieval: discovery.experienceRetrieval,
      };
      const key = JSON.stringify([session.sessionId, identity]),
        priority = Number(end !== null) * 2 + Number(current),
        prior = selected.get(key);
      if (prior) health.duplicateTurns++;
      if (!prior || priority > prior.priority)
        selected.set(key, { priority, record });
    }
  }
  return [[...selected.values()].map((value) => value.record), health];
}
function sessionAnalysis(records, start, end) {
  const rows = records.filter((row) => start <= row.at && row.at < end),
    routed = rows.filter(
      (row) => row.skills !== null && row.experiences !== null,
    ),
    completeUsage = routed.filter((row) => row.completed && row.used !== null),
    usage = new Map();
  for (const row of completeUsage)
    for (const skill of new Set([...row.skills, ...row.used])) {
      const count = usage.get(skill) ?? {
        skill,
        usageTurns: 0,
        injectedTurns: 0,
        adoptedTurns: 0,
        unadoptedTurns: 0,
        usedWithoutInjectionTurns: 0,
      };
      count.usageTurns += Number(row.used.has(skill));
      count.injectedTurns += Number(row.skills.has(skill));
      count.adoptedTurns += Number(
        row.skills.has(skill) && row.used.has(skill),
      );
      count.unadoptedTurns += Number(
        row.skills.has(skill) && !row.used.has(skill),
      );
      count.usedWithoutInjectionTurns += Number(
        row.used.has(skill) && !row.skills.has(skill),
      );
      usage.set(skill, count);
    }
  const skillUsage = [...usage.values()].map((count) => ({
    ...count,
    adoption: ratio(count.adoptedTurns, count.injectedTurns),
    lowSample: count.injectedTurns < 20,
  }));
  const statuses = counter(),
    thresholds = counter(),
    scores = [];
  let candidates = 0,
    hits = 0,
    selected = 0,
    selectedCount = 0,
    candidateRows = 0,
    candidateWithHits = 0,
    scoreRows = 0;
  for (const row of routed) {
    const retrieval = objectOrEmpty(row.experienceRetrieval),
      status = retrieval.status;
    increment(
      statuses,
      ["completed", "disabled", "unavailable", "timeout", "error"].includes(
        status,
      )
        ? status
        : "unobserved",
    );
    if (status !== "completed") continue;
    const n = observedNumber(retrieval.candidateCount);
    if (n !== null) {
      candidateRows++;
      candidates += n;
      candidateWithHits += Number(n > 0);
      if (n > 0) {
        selected += Number(row.experiences.size > 0);
        selectedCount += row.experiences.size;
      }
    }
    if (Array.isArray(retrieval.hits)) {
      hits += retrieval.hits.length;
      scoreRows++;
      for (const hit of retrieval.hits) {
        const score = observedNumber(objectOrEmpty(hit).semanticScore);
        if (score !== null) scores.push(score);
      }
    }
    const threshold = observedNumber(retrieval.minCandidateScore);
    if (threshold !== null) increment(thresholds, String(threshold));
  }
  const poolRows = routed.filter(
    (row) =>
      observedNumber(row.discovery.candidateCount) !== null &&
      observedNumber(objectOrEmpty(row.experienceRetrieval).candidateCount) !==
        null,
  );
  const nonempty = poolRows.filter(
    (row) =>
      row.discovery.candidateCount + row.experienceRetrieval.candidateCount > 0,
  );
  return {
    status: rows.length ? "observed" : "unavailable",
    source: "retained-session-routing-fields",
    turns: rows.length,
    routedTurns: routed.length,
    completeUsageTurns: completeUsage.length,
    firstObservedAt: rows.length
      ? isoDate(Math.min(...rows.map((row) => row.at)) * 1000)
      : null,
    lastObservedAt: rows.length
      ? isoDate(Math.max(...rows.map((row) => row.at)) * 1000)
      : null,
    selection: {
      poolObservedTurns: poolRows.length,
      emptyPoolTurns: poolRows.length - nonempty.length,
      nonEmptyWithoutInjection: ratio(
        nonempty.filter((row) => !row.skills.size && !row.experiences.size)
          .length,
        nonempty.length,
      ),
      skillInjectedTurns: routed.filter((row) => row.skills.size > 0).length,
      experienceInjectedTurns: routed.filter((row) => row.experiences.size > 0)
        .length,
      injectedSkills: sum(routed.map((row) => row.skills.size)),
      injectedExperiences: sum(routed.map((row) => row.experiences.size)),
      confidence: numericSummary(
        routed
          .map((row) => row.confidence)
          .filter((value) => value !== null && value <= 1),
      ),
      discoveryDurationMs: numericSummary(
        routed
          .map((row) => observedNumber(row.discovery.durationMs))
          .filter((value) => value !== null),
      ),
    },
    experienceRetrieval: {
      statuses: counterDict(statuses),
      statusDenominator: routed.length,
      candidateObservedTurns: candidateRows,
      hitTurns: ratio(candidateWithHits, candidateRows),
      candidateCount: candidateRows ? candidates : null,
      hitCount: scoreRows ? hits : null,
      selectedFromNonEmpty: ratio(selected, candidateWithHits),
      selectedExperiencesFromNonEmpty: candidateRows ? selectedCount : null,
      semanticScore: numericSummary(scores),
      observedThresholds: counterDict(thresholds),
    },
    skills: {
      topUsed: ranked(skillUsage, "usageTurns"),
      topUnadopted: ranked(skillUsage, "unadoptedTurns"),
      topUsedWithoutInjection: ranked(skillUsage, "usedWithoutInjectionTurns"),
    },
  };
}
function dailySkillRows(rows) {
  const names = new Set(
    rows.flatMap((row) => Object.keys(objectOrEmpty(row.skills))),
  );
  for (const row of rows)
    for (const key of Object.keys(objectOrEmpty(row.skillRouting)))
      if (key.startsWith("value:")) names.add(key.slice(6));
  const usageComplete =
      rows.length > 0 && rows.every((row) => isObject(row.skills)),
    routingComplete =
      rows.length > 0 &&
      rows.every(
        (row) =>
          isObject(row.skillRouting) && !("__other__" in row.skillRouting),
      );
  return [...names].sort(compare).map((skill) => {
    const usageTurns = usageComplete
      ? observedSum(
          rows.map((row) => ({ n: row.skills[skill] ?? 0 })),
          "n",
        )
      : null;
    const counts = routingComplete
      ? rows.map((row) =>
          "value:" + skill in row.skillRouting
            ? objectOrEmpty(row.skillRouting["value:" + skill])
            : { intentMatchedTurns: 0, adoptedTurns: 0 },
        )
      : [];
    const injectedTurns = observedSum(counts, "intentMatchedTurns"),
      adoptedTurns = observedSum(counts, "adoptedTurns");
    return {
      skill,
      usageTurns,
      injectedTurns,
      adoptedTurns,
      unadoptedTurns:
        injectedTurns !== null &&
        adoptedTurns !== null &&
        adoptedTurns <= injectedTurns
          ? injectedTurns - adoptedTurns
          : null,
      adoption: ratio(adoptedTurns, injectedTurns),
      lowSample: injectedTurns === null || injectedTurns < 20,
    };
  });
}
function decisionAnalysis(dataRoot, stats, review, days, now) {
  const end = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
    daily = objectOrEmpty(stats?.daily);
  const [records, sessionDataQuality] = routingObservations(
    path.join(dataRoot, "sessions"),
  );
  const cohortStart = isoTimestamp(nested(stats, "attribution", "startedAt")),
    cohortDate =
      cohortStart !== null
        ? new Date(cohortStart * 1000).toISOString().slice(0, 10)
        : null,
    windows = {};
  for (const [label, windowEnd] of [
    ["recent", end],
    ["previous", end - days * DAY_MS],
  ]) {
    const start = windowEnd - days * DAY_MS,
      dates = Array.from({ length: days }, (_, i) =>
        new Date(start + i * DAY_MS).toISOString().slice(0, 10),
      );
    const preCohort = dates.filter(
      (date) =>
        cohortDate !== null && date < cohortDate && Object.hasOwn(daily, date),
    );
    const rows = dates
      .filter(
        (date) =>
          isObject(daily[date]) && (cohortDate === null || date >= cohortDate),
      )
      .map((date) => daily[date]);
    const cohortPartial =
        cohortStart !== null &&
        start < cohortStart * 1000 &&
        cohortStart * 1000 < windowEnd,
      discovery = rows.map((row) => row.skillDiscovery).filter(isObject),
      dailySkills = dailySkillRows(rows);
    const toolCalls =
      rows.length && rows.every((row) => isObject(row.tools))
        ? sum(Object.values(mergedCounts(rows, "tools")))
        : null;
    const toolErrors =
      rows.length && rows.every((row) => isObject(row.toolErrors))
        ? sum(Object.values(mergedCounts(rows, "toolErrors")))
        : null;
    windows[label] = {
      start: isoDate(start),
      endExclusive: isoDate(windowEnd),
      timezone: "UTC",
      daily: {
        status:
          stats !== null && rows.length === days && !cohortPartial
            ? "available"
            : rows.length
              ? "partial"
              : "unavailable",
        source: "stats.daily",
        expectedBuckets: days,
        observedBuckets: rows.length,
        discoveryBuckets: discovery.length,
        excludedPreCohortBuckets: preCohort.length,
        cohortStartedDuringWindow: cohortPartial,
        turns: observedSum(rows, "turns"),
        erroredTurns: ratio(
          observedSum(rows, "erroredTurns"),
          observedSum(rows, "turns"),
        ),
        skillDiscovery: discoveryAnalysis(discovery),
        adoption: ratio(
          observedSum(rows, "routing", "adoptedSkillOpportunities"),
          observedSum(rows, "routing", "intentMatchedSkillOpportunities"),
        ),
        toolCalls,
        toolErrors,
        topUsedSkills: ranked(dailySkills, "usageTurns"),
        topUnadoptedSkills: ranked(dailySkills, "unadoptedTurns"),
        skillRoutingOverflowBuckets: rows.filter((row) =>
          Object.hasOwn(objectOrEmpty(row.skillRouting), "__other__"),
        ).length,
        toolErrorRate: ratio(toolErrors, toolCalls),
      },
      sessions: {
        ...sessionAnalysis(records, start / 1000, windowEnd / 1000),
        retentionDays: RETENTION_DAYS,
        extendsBeforeRetention: start < now.getTime() - RETENTION_DAYS * DAY_MS,
        coverage:
          "retained-observations-only; completeness cannot be established",
      },
      review: {
        ...reviewAnalysis(review, start / 1000, windowEnd / 1000),
        coverage: {
          retentionDays: 90,
          extendsBeforeRetention: start < now.getTime() - 90 * DAY_MS,
        },
      },
    };
  }
  const rows = skillRows(stats ?? {});
  return {
    generatedAt: isoDate(now.getTime()),
    days,
    windows,
    cumulative: {
      source:
        "stats.json since attribution.startedAt; review retained completed events",
      statsStatus: stats !== null ? "available" : "unavailable",
      startedAt: nested(stats, "attribution", "startedAt") ?? null,
      statsUpdatedAt: stats?.updatedAt ?? null,
      skillDiscovery:
        stats !== null
          ? discoveryAnalysis([stats.skillDiscovery])
          : { status: "unavailable" },
      skills: {
        lowSampleInjectionThreshold: 20,
        topUsed: ranked(rows, "usageTurns"),
        topUnadopted: ranked(rows, "unadoptedTurns"),
      },
      review: reviewAnalysis(review, 0, now.getTime() / 1000),
    },
    sessionDataQuality,
    unobserved: [
      "Gateway plugin load",
      "Review enabled/queue/running state/duration/cost",
      "selector failure cause and phase latency",
      "routing precision/recall",
      "configuration-change attribution",
    ],
    interpretation: [
      "Rates are observations, not accuracy or causal effects.",
      "Name and QMD candidates overlap; never sum channel counts as a unique pool.",
      "Daily skillRouting/toolErrors attribution keys are encoded and may overflow into __other__; daily usage names are raw.",
      "Review triggers overlap; outcome rates use completed events, not trigger counts.",
      "Repair index/data health before proposing threshold changes; low adoption alone does not justify deletion.",
    ],
  };
}

export function buildReport(
  dataRoot,
  days = 7,
  now = new Date(),
  { hashFile = sha256 } = {},
) {
  const reviewPath = path.join(dataRoot, "review.json"),
    statsPath = path.join(dataRoot, "stats.json"),
    paths = [reviewPath, statsPath],
    present = paths.filter(isFile);
  const beforeHashes = Object.fromEntries(
    present.map((target) => [path.basename(target), hashFile(target)]),
  );
  const review = present.includes(reviewPath)
      ? loadReviewLog(reviewPath)
      : null,
    stats = present.includes(statsPath) ? loadStats(statsPath) : null;
  const afterHashes = Object.fromEntries(
    present.map((target) => [path.basename(target), hashFile(target)]),
  );
  if (paths.some((target) => isFile(target) !== present.includes(target)))
    throw new Error("runtime state availability changed while being read");
  const changed = Object.keys(beforeHashes)
    .filter((name) => beforeHashes[name] !== afterHashes[name])
    .sort();
  if (changed.length)
    throw new Error(
      `runtime state changed while being read: ${changed.join(", ")}`,
    );
  const intentPaths = directFiles(path.join(dataRoot, "intents"), ".md"),
    qmd = qmdHealth(path.join(dataRoot, "qmd"));
  qmd.skills = skillQmdHealth(path.join(dataRoot, "qmd/skills/indexes"));
  return {
    schemaVersion: 1,
    reportOnly: true,
    dataRoot,
    provenance: {
      stateSha256: beforeHashes,
      scriptSha256: sha256(SCRIPT_PATH),
    },
    runtime: {
      review:
        review !== null
          ? {
              schemaVersion: review.schemaVersion,
              updatedAt: review.updatedAt ?? null,
              processedEvents: reviewChangeSummary(review.processedEvents),
              reviewedSkillEpochCount: size(review.reviewedSkillEpochs),
            }
          : { status: "unavailable" },
      stats: stats !== null ? statsSummary(stats) : { status: "unavailable" },
      sessions: sessionHealth(
        path.join(dataRoot, "sessions"),
        path.join(dataRoot, "agents"),
      ),
      experiences: countExperiences(path.join(dataRoot, "experiences")),
      intents: {
        markdownFiles: intentPaths.length,
        bytes: sum(intentPaths.map((target) => fs.statSync(target).size)),
      },
      qmd,
    },
    analysis: decisionAnalysis(dataRoot, stats, review, days, now),
    privacy: {
      sessionTextIncluded: false,
      reviewSuggestionTextIncluded: false,
      reviewEvidenceIncluded: false,
      toolParamsOrResultsIncluded: false,
    },
  };
}
function writeReport(target, rendered) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.runtime-health-${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, rendered, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function main() {
  const { values: args } = parseArgs({
    options: {
      "data-root": {
        type: "string",
        default: path.join(
          process.env.OPENCLAW_STATE_DIR ??
            path.join(os.homedir(), ".openclaw"),
          "plugins",
          "skill-harness",
        ),
      },
      output: { type: "string" },
      stdout: { type: "boolean", default: false },
      days: { type: "string", default: "7" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.help) {
    process.stdout.write(
      "Report-only Skill Harness runtime health and Review-change distribution audit.\nUsage: node scripts/runtime-health-audit.mjs [--data-root PATH] [--days 1..90] (--output PATH | --stdout)\n",
    );
    return;
  }
  if (
    !/^\d+$/.test(args.days) ||
    Number(args.days) < 1 ||
    Number(args.days) > 90
  )
    throw new Error("--days must be between 1 and 90");
  if (args.stdout === (args.output !== undefined))
    throw new Error("provide exactly one of --output or --stdout");
  const report = buildReport(args["data-root"], Number(args.days)),
    rendered = JSON.stringify(report, null, 2) + "\n";
  if (args.stdout) process.stdout.write(rendered);
  else writeReport(args.output, rendered);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`runtime health audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
