#!/usr/bin/env node
/** Report-only Skill Harness runtime health and Review-change distribution audit. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  PROCESSED_EVENT_OUTCOMES,
  ReviewLogSchema,
} from "../dist/src/review/log.js";

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
const COMPLETED_OUTCOMES = PROCESSED_EVENT_OUTCOMES.filter(
  (value) => value !== "skipped",
);
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
  const parsed = ReviewLogSchema.safeParse(loadJson(target));
  // Zod issues can contain private event IDs, paths, and rejected values.
  if (!parsed.success)
    throw new Error("review.json must be a valid schema-v9 review log");
  return parsed.data;
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
const QMD_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "vendor",
  "dist",
  "build",
]);
const QMD_MAX_FILE_SIZE = 10 * 1024 * 1024;

function isNonBlankQmdFile(target, size) {
  if (size <= 0 || size > QMD_MAX_FILE_SIZE) return false;
  let fd;
  try {
    fd = fs.openSync(target, "r");
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (read <= 0) break;
      if (decoder.write(buffer.subarray(0, read)).trim().length > 0)
        return true;
      offset += read;
    }
    return decoder.end().trim().length > 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function countEligibleCollectionFiles(collectionRoot, matchesName) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(collectionRoot);
    if (!fs.statSync(rootReal).isDirectory()) return 0;
  } catch {
    return 0;
  }
  let count = 0;
  function visit(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.isSymbolicLink() ||
        QMD_EXCLUDE_DIRS.has(entry.name)
      )
        continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile()) {
        if (!matchesName(entry.name)) continue;
        const info = stat(target);
        if (!info?.isFile()) continue;
        if (isNonBlankQmdFile(target, info.size)) count++;
      }
    }
  }
  visit(rootReal);
  return count;
}

function countSkillSnapshotFiles(snapshotRoot) {
  const metaRoot = path.join(snapshotRoot, "meta");
  const bodyRoot = path.join(snapshotRoot, "body");
  const refsRoot = path.join(snapshotRoot, "references");
  if (
    !isDirectory(metaRoot) &&
    !isDirectory(bodyRoot) &&
    !isDirectory(refsRoot)
  ) {
    return walk(snapshotRoot).filter(
      (target) => isFile(target) && target.endsWith(".md"),
    ).length;
  }
  return (
    countEligibleCollectionFiles(metaRoot, (name) => name === "meta.md") +
    countEligibleCollectionFiles(bodyRoot, (name) => name === "SKILL.md") +
    countEligibleCollectionFiles(
      refsRoot,
      (name) =>
        !name.endsWith(".identity.json") && !name.endsWith(".identity.yml"),
    )
  );
}

function tableColumns(db, tableName) {
  try {
    return new Set(
      db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all()
        .map((row) => row.name),
    );
  } catch {
    return new Set();
  }
}

function qmdVecLayoutKind(db) {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vectors_vec', 'vectors_by_collection')",
    )
    .all();
  if (rows.some((row) => row.name === "vectors_vec")) return "legacy";
  if (rows.some((row) => row.name === "vectors_by_collection"))
    return "partitioned";
  return "none";
}

function evaluateQmdVectorCoverage(db, indexedDocuments, indexedVectors) {
  const docCols = tableColumns(db, "documents");
  const vecCols = tableColumns(db, "content_vectors");
  const stateCols = tableColumns(db, "embedding_index_state");
  const vecRowCols = tableColumns(db, "vector_rows");
  const colIdCols = tableColumns(db, "vector_collection_ids");
  if (!docCols.has("active") || vecCols.size === 0) return null;

  // Minimal synthetic fixtures without hash columns fall back to row counts.
  if (!docCols.has("hash") || !vecCols.has("hash")) {
    return indexedDocuments !== null && indexedVectors !== null
      ? indexedDocuments === indexedVectors
      : null;
  }

  // Schemas with hash columns but without chunk metadata check hash presence.
  if (!vecCols.has("total_chunks")) {
    const coverage = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM documents d
            WHERE d.active = 1
              AND NOT EXISTS (SELECT 1 FROM content_vectors v WHERE v.hash = d.hash)) AS missing,
          (SELECT COUNT(*) FROM content_vectors v
            WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.active = 1 AND d.hash = v.hash)) AS orphan`,
      )
      .get();
    return coverage.missing === 0 && coverage.orphan === 0;
  }

  // Full QMD schema: verify chunk completeness, stored embedding identity,
  // orphan cleanup, and active-layout partition parity.
  const layoutKind = qmdVecLayoutKind(db);
  const hasSeq = vecCols.has("seq");
  const hasIdentity =
    vecCols.has("model") &&
    vecCols.has("embed_fingerprint") &&
    stateCols.has("model") &&
    stateCols.has("fingerprint");
  const countPartitionRows = () =>
    vecRowCols.size > 0
      ? db.prepare("SELECT COUNT(*) AS count FROM vector_rows").get().count
      : 0;

  let identityFilter = "";
  let identityParams = [];
  let identityGroupCols = "hash";
  if (hasIdentity) {
    const stored = db
      .prepare(
        "SELECT model, fingerprint FROM embedding_index_state WHERE singleton = 1",
      )
      .get();
    if (
      !stored ||
      typeof stored.model !== "string" ||
      typeof stored.fingerprint !== "string"
    ) {
      const leftoverPartitionRows =
        layoutKind === "legacy" ? 0 : countPartitionRows();
      return (
        indexedDocuments === 0 &&
        indexedVectors === 0 &&
        leftoverPartitionRows === 0
      );
    }
    const wrongIdentity = db
      .prepare(
        "SELECT COUNT(*) AS count FROM content_vectors WHERE model != ? OR embed_fingerprint != ?",
      )
      .get(stored.model, stored.fingerprint).count;
    if (wrongIdentity > 0) return false;
    identityFilter = "WHERE model = ? AND embed_fingerprint = ?";
    identityParams = [stored.model, stored.fingerprint];
    identityGroupCols = "hash, model, embed_fingerprint";
  }

  const completeSeqClause = hasSeq
    ? "AND MIN(seq) = 0 AND MAX(seq) = MAX(total_chunks) - 1 AND COUNT(DISTINCT seq) = MAX(total_chunks)"
    : "";
  const incompleteSeqClause = hasSeq
    ? "OR MIN(seq) <> 0 OR MAX(seq) <> MAX(total_chunks) - 1 OR COUNT(DISTINCT seq) <> MAX(total_chunks)"
    : "";

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count
      FROM documents d
      LEFT JOIN (
        SELECT hash
        FROM content_vectors
        ${identityFilter}
        GROUP BY hash
        HAVING MAX(total_chunks) >= 1
          AND MIN(total_chunks) = MAX(total_chunks)
          AND COUNT(*) = MAX(total_chunks)
          ${completeSeqClause}
      ) complete ON complete.hash = d.hash
      WHERE d.active = 1 AND complete.hash IS NULL`,
    )
    .get(...identityParams).count;
  if (pending > 0) return false;

  const incomplete = db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
        SELECT hash
        FROM content_vectors
        GROUP BY ${identityGroupCols}
        HAVING MAX(total_chunks) < 1
          OR MIN(total_chunks) <> MAX(total_chunks)
          OR COUNT(*) <> MAX(total_chunks)
          ${incompleteSeqClause}
      )`,
    )
    .get().count;
  if (incomplete > 0) return false;

  const orphan = db
    .prepare(
      `SELECT COUNT(*) AS count
      FROM content_vectors v
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.active = 1 AND d.hash = v.hash
      )`,
    )
    .get().count;
  if (orphan > 0) return false;

  // Match QMD vecLayout precedence: legacy vectors_vec wins while present, so
  // empty staging rows in vector_rows must not be treated as missing vectors.
  if (layoutKind === "partitioned") {
    if (
      !hasSeq ||
      !docCols.has("collection") ||
      !vecRowCols.has("hash") ||
      !vecRowCols.has("seq") ||
      !vecRowCols.has("collection_id") ||
      !colIdCols.has("id") ||
      !colIdCols.has("name")
    ) {
      return false;
    }
    const missingPartition = db
      .prepare(
        `SELECT COUNT(*) AS count
        FROM content_vectors cv
        JOIN (SELECT DISTINCT hash, collection FROM documents WHERE active = 1) d
          ON d.hash = cv.hash
        LEFT JOIN vector_collection_ids ci ON ci.name = d.collection
        LEFT JOIN vector_rows vr
          ON vr.hash = cv.hash AND vr.seq = cv.seq AND vr.collection_id = ci.id
        WHERE vr.hash IS NULL`,
      )
      .get().count;
    if (missingPartition > 0) return false;
    const extraPartition = db
      .prepare(
        `SELECT COUNT(*) AS count
        FROM vector_rows vr
        LEFT JOIN vector_collection_ids ci ON ci.id = vr.collection_id
        WHERE NOT EXISTS (
          SELECT 1 FROM content_vectors cv
          WHERE cv.hash = vr.hash AND cv.seq = vr.seq
        )
        OR ci.name IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM documents d
          WHERE d.active = 1 AND d.hash = vr.hash AND d.collection = ci.name
        )`,
      )
      .get().count;
    if (extraPartition > 0) return false;
  } else if (layoutKind === "none" && vecRowCols.size > 0) {
    if (countPartitionRows() > 0 || (indexedVectors ?? 0) > 0) return false;
  }

  return true;
}

function qmdDatabaseHealth(snapshotRoot, databasePath) {
  const snapshotIndexedFiles = countSkillSnapshotFiles(snapshotRoot);
  const unavailable = {
    databaseStatus: "unavailable",
    integrityCheck: null,
    generation: null,
    leaseActive: null,
    snapshotIndexedFiles,
    indexedDocuments: null,
    indexedVectors: null,
    documentsMatchVectors: null,
    snapshotMatchesIndexedDocuments: null,
  };
  if (!isFile(databasePath)) return unavailable;
  let db;
  let integrityCheck,
    state,
    indexedDocuments,
    indexedVectors,
    documentsMatchVectors;
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
    documentsMatchVectors = evaluateQmdVectorCoverage(
      db,
      indexedDocuments,
      indexedVectors,
    );
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
    snapshotIndexedFiles,
    indexedDocuments,
    indexedVectors,
    documentsMatchVectors,
    snapshotMatchesIndexedDocuments:
      indexedDocuments !== null
        ? snapshotIndexedFiles === indexedDocuments
        : null,
  };
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

function reviewChangeSummary(events) {
  const outcomes = counter(),
    changesPerEvent = counter(),
    changesByTrigger = counter(),
    operations = counter(),
    triggerEvents = counter(),
    noFindingReasons = counter(),
    schemaRejectionReasons = counter(),
    preparation = counter(),
    skipReasons = counter(),
    existingAssessments = counter(),
    discoveryAssessments = counter();
  let searchCalls = 0,
    eventsWithoutPreparation = 0;
  for (const event of Object.values(events)) {
    const prep = event.relationPreparation;
    if (prep) {
      increment(preparation, prep.status);
      if (prep.reason) increment(skipReasons, prep.reason);
    } else eventsWithoutPreparation++;
    if (event.outcome === "skipped") continue;
    increment(outcomes, event.outcome);
    if (event.relationReview) {
      increment(existingAssessments, event.relationReview.existing);
      increment(discoveryAssessments, event.relationReview.discovery);
    }
    searchCalls += event.relationSearchCount ?? 0;
    for (const trigger of event.triggers) increment(triggerEvents, trigger);
    increment(changesPerEvent, String(event.changeCount));
    for (const change of event.changes ?? []) {
      increment(changesByTrigger, change.trigger);
      increment(operations, change.operation);
    }
    for (const [reason, count] of entries(event.noFindingReasonCounts))
      increment(noFindingReasons, reason, count);
    for (const [reason, count] of entries(event.schemaRejectionReasonCounts))
      increment(schemaRejectionReasons, reason, count);
  }
  const eventCount = sum([...outcomes.values()]),
    total = sum([...changesByTrigger.values()]),
    appliedEvents = outcomes.get("applied") ?? 0;
  return {
    eventCount,
    skippedPreparations: preparation.get("skipped") ?? 0,
    invalidRecords: 0,
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
      committedOperations: counterDict(operations),
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
        "schema-v7 QMD bucket, including historical routing sources; attribution is not a search conversion rate",
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
    .filter(([, event]) => event.outcome !== "skipped")
    .map(([, value]) => value.processedAt)
    .sort((a, b) => isoTimestamp(b) - isoTimestamp(a));
  return {
    ...result,
    status: "observed-completed-events",
    outcomeRates: Object.fromEntries(
      COMPLETED_OUTCOMES.map((outcome) => [
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
        used: nameList(raw.skillsUsed, true),
        confidence: observedNumber(raw.confidence),
        discovery: pick(discovery, [
          "candidateCount",
          "nameCandidates",
          "retrievalAttempted",
          "retrievalCandidates",
          "durationMs",
        ]),
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
    routed = rows.filter((row) => row.skills !== null),
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
  const poolRows = routed.filter(
    (row) => observedNumber(row.discovery.candidateCount) !== null,
  );
  const nonempty = poolRows.filter((row) => row.discovery.candidateCount > 0);
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
        nonempty.filter((row) => !row.skills.size).length,
        nonempty.length,
      ),
      skillInjectedTurns: routed.filter((row) => row.skills.size > 0).length,
      injectedSkills: sum(routed.map((row) => row.skills.size)),
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
      "Historical Review receipts can contain overlapping triggers; outcome rates use completed events.",
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
    qmd = { skills: skillQmdHealth(path.join(dataRoot, "qmd/skills/indexes")) };
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
