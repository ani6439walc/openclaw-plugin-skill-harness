#!/usr/bin/env python3
"""Report-only Skill Harness runtime health and Review-change distribution audit."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import stat
import sys
import tempfile
import time
from collections import Counter
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
RETENTION_DAYS = 14
STATS_DAILY_RETENTION_DAYS = 90
TOP_TARGETS = 10
LATENCY_BUCKETS = ("unknown", "0-99", "100-499", "500-999", "1000-4999", "5000+")
ROUTE_REASONS = ("qmd-keyword", "qmd-hybrid", "llm-classifier")


def default_data_root() -> Path:
    state_dir = Path(os.environ.get("OPENCLAW_STATE_DIR", Path.home() / ".openclaw"))
    return state_dir / "plugins" / "skill-harness"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=default_data_root())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stdout", action="store_true")
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    if not 1 <= args.days <= 90:
        parser.error("--days must be between 1 and 90")
    if args.stdout == (args.output is not None):
        parser.error("provide exactly one of --output or --stdout")
    return args


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read JSON: {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def require_object(value: dict[str, Any], field: str, path: Path) -> dict[str, Any]:
    field_value = value.get(field)
    if not isinstance(field_value, dict):
        raise ValueError(f"{path} has invalid {field}")
    return field_value


def load_review_log(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if value.get("schemaVersion") != 8:
        raise ValueError(f"{path} must be a current schema-v8 review log")
    for field in ("processedEvents", "reviewedSkillEpochs"):
        require_object(value, field, path)
    return value



def load_stats(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if value.get("schemaVersion") != 7:
        raise ValueError(f"{path} must be a current schema-v7 stats log")
    for field in ("summary", "routing", "projection", "skillDiscovery"):
        require_object(value, field, path)
    attribution = require_object(value, "attribution", path)
    if not isinstance(attribution.get("startedAt"), str):
        raise ValueError(f"{path} has invalid attribution.startedAt")
    validate_route_reason_stats(value, path)
    return value


def validate_route_reason_stats(value: dict[str, Any], path: Path) -> None:
    intents = value.get("intents")
    if not isinstance(intents, dict):
        return
    for intent_id, intent_value in intents.items():
        if not isinstance(intent_value, dict):
            raise ValueError(f"{path} has invalid intents.{intent_id}")
        intent = intent_value
        route_reasons = intent.get("routeReasons")
        if route_reasons is None:
            continue
        if not isinstance(route_reasons, dict) or set(route_reasons) != set(ROUTE_REASONS):
            raise ValueError(f"{path} has invalid routeReasons for {intent_id}")
        for reason in ROUTE_REASONS:
            route_value = route_reasons[reason]
            if not isinstance(route_value, dict):
                raise ValueError(f"{path} has invalid route score for {intent_id}.{reason}")
            route = route_value
            count = route.get("count")
            scores = [route.get("averageScore"), route.get("minScore"), route.get("maxScore")]
            if (
                not isinstance(count, int)
                or isinstance(count, bool)
                or count < 0
                or any(
                    not isinstance(score, (int, float))
                    or isinstance(score, bool)
                    or score < 0
                    or score > 1
                    for score in scores
                )
            ):
                raise ValueError(f"{path} has invalid route score for {intent_id}.{reason}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def count_files(root: Path) -> tuple[int, int]:
    if not root.is_dir():
        return 0, 0
    file_count = 0
    total_bytes = 0
    for path in root.rglob("*"):
        if path.is_file():
            file_count += 1
            total_bytes += path.stat().st_size
    return file_count, total_bytes


def qmd_health(qmd_root: Path) -> dict[str, Any]:
    experiences_root = qmd_root / "experiences"
    intents_root = qmd_root / "intents"
    if (experiences_root / "experience-routing.sqlite").is_file() or (
        experiences_root.is_dir() and not (intents_root / "intent-routing.sqlite").is_file()
    ):
        snapshot_root = experiences_root
        database_path = snapshot_root / "experience-routing.sqlite"
    else:
        snapshot_root = intents_root
        database_path = snapshot_root / "intent-routing.sqlite"

    return qmd_database_health(snapshot_root, database_path)


def qmd_database_health(snapshot_root: Path, database_path: Path) -> dict[str, Any]:
    snapshot_markdown_files = (
        sum(1 for _ in snapshot_root.rglob("*.md"))
        if snapshot_root.is_dir()
        else 0
    )
    unavailable = {
        "databaseStatus": "unavailable",
        "integrityCheck": None,
        "generation": None,
        "leaseActive": None,
        "snapshotMarkdownFiles": snapshot_markdown_files,
        "indexedDocuments": None,
        "indexedVectors": None,
        "documentsMatchVectors": None,
        "snapshotMatchesIndexedDocuments": None,
    }
    if not database_path.is_file():
        return unavailable

    try:
        with closing(sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)) as database:
            integrity_check = database.execute("PRAGMA integrity_check").fetchone()[0]
            try:
                state = database.execute(
                    """
                    SELECT status, generation, lease_expires_at
                    FROM embedding_index_state
                    WHERE singleton = 1
                    """
                ).fetchone()
            except sqlite3.Error:
                state = None
            try:
                indexed_documents = database.execute(
                    "SELECT COUNT(*) FROM documents WHERE active = 1"
                ).fetchone()[0]
            except sqlite3.Error:
                indexed_documents = None
            try:
                indexed_vectors = database.execute(
                    "SELECT COUNT(*) FROM content_vectors"
                ).fetchone()[0]
            except sqlite3.Error:
                indexed_vectors = None
    except sqlite3.Error:
        return unavailable

    status, generation, lease_expires_at = state if state else ("unknown", None, None)
    lease_active = (
        isinstance(lease_expires_at, (int, float))
        and lease_expires_at > time.time() * 1000
    )
    docs_match = (
        indexed_documents == indexed_vectors
        if indexed_documents is not None and indexed_vectors is not None
        else None
    )
    snap_match = (
        snapshot_markdown_files == indexed_documents
        if indexed_documents is not None
        else None
    )
    return {
        "databaseStatus": status,
        "integrityCheck": integrity_check,
        "generation": generation,
        "leaseActive": lease_active,
        "snapshotMarkdownFiles": snapshot_markdown_files,
        "indexedDocuments": indexed_documents,
        "indexedVectors": indexed_vectors,
        "documentsMatchVectors": docs_match,
        "snapshotMatchesIndexedDocuments": snap_match,
    }


def iso_timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def session_health(sessions_dir: Path, agents_dir: Path) -> dict[str, int]:
    cutoff = time.time() - RETENTION_DAYS * 24 * 60 * 60
    session_files = sorted(sessions_dir.glob("*.json")) if sessions_dir.is_dir() else []
    invalid = 0
    missing_current = 0
    invalid_history = 0
    stale_current_end = 0
    for path in session_files:
        try:
            session = load_json(path)
        except ValueError:
            invalid += 1
            continue
        if not isinstance(session.get("sessionId"), str) or not session["sessionId"].strip():
            invalid += 1
        current = session.get("current")
        if not isinstance(current, dict):
            missing_current += 1
            continue
        if "history" in session and not isinstance(session["history"], list):
            invalid_history += 1
        end = iso_timestamp(
            current.get("timestamps", {}).get("end")
            if isinstance(current.get("timestamps"), dict)
            else None
        )
        if end is not None and end < cutoff:
            stale_current_end += 1

    agent_files, agent_bytes = count_files(agents_dir)
    stale_agent_artifacts = 0
    if agents_dir.is_dir():
        for path in agents_dir.rglob("*"):
            if path.is_file() and path.stat().st_mtime < cutoff:
                stale_agent_artifacts += 1
    return {
        "retentionDays": RETENTION_DAYS,
        "sessionFiles": len(session_files),
        "invalidSessionFiles": invalid,
        "sessionsMissingCurrent": missing_current,
        "sessionsWithInvalidHistory": invalid_history,
        "sessionsOlderThanRetentionByCurrentEnd": stale_current_end,
        "agentArtifactFiles": agent_files,
        "agentArtifactBytes": agent_bytes,
        "agentArtifactsOlderThanRetentionByMtime": stale_agent_artifacts,
    }


def counter_dict(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items()))


def review_change_summary(events: dict[str, Any]) -> dict[str, Any]:
    outcomes: Counter[str] = Counter()
    changes_per_event: Counter[str] = Counter()
    changes_by_trigger: Counter[str] = Counter()
    operations: Counter[str] = Counter()
    target_intents: Counter[str] = Counter()
    target_experiences: Counter[str] = Counter()
    trigger_events: Counter[str] = Counter()
    nofinding_reasons: Counter[str] = Counter()
    schema_rejection_reasons: Counter[str] = Counter()
    invalid_records = 0

    for event in events.values():
        if not isinstance(event, dict):
            invalid_records += 1
            continue
        outcome = event.get("outcome")
        outcomes[outcome if isinstance(outcome, str) else "<non-string>"] += 1
        triggers = event.get("triggers")
        if isinstance(triggers, list):
            for trigger in triggers:
                if isinstance(trigger, str):
                    trigger_events[trigger] += 1
        changes = event.get("changes")
        if not isinstance(changes, list):
            changes = []
        changes_per_event[str(len(changes))] += 1
        for change in changes:
            if not isinstance(change, dict):
                invalid_records += 1
                continue
            trigger = change.get("trigger")
            if isinstance(trigger, str):
                changes_by_trigger[trigger] += 1
            operation = change.get("operation")
            if isinstance(operation, str):
                operations[operation] += 1
            target_ids = change.get("targetIntentIds")
            if isinstance(target_ids, list):
                for target_id in target_ids:
                    if isinstance(target_id, str):
                        target_intents[target_id] += 1
            exp_ids = change.get("targetExperienceIds")
            if isinstance(exp_ids, list):
                for exp_id in exp_ids:
                    if isinstance(exp_id, str):
                        target_experiences[exp_id] += 1
        for field, counter in (
            ("noFindingReasonCounts", nofinding_reasons),
            ("schemaRejectionReasonCounts", schema_rejection_reasons),
        ):
            reasons = event.get(field)
            if isinstance(reasons, dict):
                for reason, count in reasons.items():
                    if isinstance(reason, str) and isinstance(count, int):
                        counter[reason] += count

    event_count = sum(outcomes.values())
    total_changes = sum(changes_by_trigger.values())
    applied_events = outcomes["applied"]
    return {
        "eventCount": event_count,
        "invalidRecords": invalid_records,
        "outcomes": counter_dict(outcomes),
        "changes": {
            "appliedEvents": applied_events,
            "total": total_changes,
            "averagePerAppliedEvent": (
                round(total_changes / applied_events, 2) if applied_events else 0
            ),
            "eventsByChangeCount": counter_dict(changes_per_event),
            "byTrigger": counter_dict(changes_by_trigger),
            "byOperation": counter_dict(operations),
            "topTargetExperiences": [
                {"experience": exp, "changes": count}
                for exp, count in target_experiences.most_common(TOP_TARGETS)
            ],
            "topTargetIntents": [
                {"intent": intent, "changes": count}
                for intent, count in target_intents.most_common(TOP_TARGETS)
            ],
        },
        "triggerEvents": counter_dict(trigger_events),
        "noFindingReasons": counter_dict(nofinding_reasons),
        "schemaRejectionReasons": counter_dict(schema_rejection_reasons),
    }


def number(value: Any) -> int | float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def object_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def route_reason_summary(value: Any) -> dict[str, Any]:
    route_reasons = object_or_empty(value)
    by_reason: dict[str, dict[str, int | float | None]] = {}
    total_routes = 0
    weighted_score = 0.0
    observed_min: float | None = None
    observed_max: float | None = None
    for reason in ROUTE_REASONS:
        route = object_or_empty(route_reasons.get(reason))
        count = int(number(route.get("count")))
        average_score = number(route.get("averageScore"))
        min_score = number(route.get("minScore")) if count else None
        max_score = number(route.get("maxScore")) if count else None
        by_reason[reason] = {
            "count": count,
            "averageScore": average_score,
            "minScore": min_score,
            "maxScore": max_score,
        }
        total_routes += count
        weighted_score += count * average_score
        if min_score is not None:
            observed_min = min_score if observed_min is None else min(observed_min, min_score)
        if max_score is not None:
            observed_max = max_score if observed_max is None else max(observed_max, max_score)
    return {
        "totalRoutes": total_routes,
        "averageScore": round(weighted_score / total_routes, 4)
        if total_routes
        else 0,
        "minScore": observed_min,
        "maxScore": observed_max,
        "byReason": by_reason,
    }


def skill_inventory_summary(stats: dict[str, Any]) -> dict[str, Any]:
    inventory = object_or_empty(stats.get("skillInventory"))
    agents = object_or_empty(inventory.get("agents"))
    if not isinstance(inventory.get("startedAt"), str):
        return {
            "status": "unavailable",
            "agentCount": 0,
            "observedTurns": 0,
            "trackedSkillRecords": 0,
            "maxTrackedSkillRecordsPerAgent": 0,
        }

    tracked_counts = [
        len(object_or_empty(object_or_empty(agent).get("skills")))
        for agent in agents.values()
    ]
    return {
        "status": "available",
        "startedAt": inventory["startedAt"],
        "agentCount": len(agents),
        "observedTurns": sum(
            int(number(object_or_empty(agent).get("observedTurns")))
            for agent in agents.values()
        ),
        "trackedSkillRecords": sum(tracked_counts),
        "maxTrackedSkillRecordsPerAgent": max(tracked_counts, default=0),
    }


def stats_attribution(stats: dict[str, Any]) -> dict[str, Any]:
    attribution = object_or_empty(stats.get("attribution"))
    started_at = attribution.get("startedAt")
    started_date = started_at[:10] if isinstance(started_at, str) else None
    daily = object_or_empty(stats.get("daily"))
    historical_days = sum(
        1
        for date in daily
        if isinstance(date, str) and started_date is not None and date < started_date
    )
    return {
        "status": "fresh-v7-window",
        "startedAt": started_at,
        "dailyBucketsBeforeAttribution": historical_days,
        "note": "Schema v7 begins a fresh telemetry cohort at startedAt.",
    }


def skill_discovery_summary(stats: dict[str, Any]) -> dict[str, Any]:
    discovery = require_object(stats, "skillDiscovery", Path("stats.json"))
    return {
        "turns": number(discovery.get("turns")),
        "nameMatch": discovery.get("nameMatch"),
        "qmdSearch": discovery.get("qmdSearch"),
        "pool": discovery.get("pool"),
        "fallbackReasons": discovery.get("fallbackReasons"),
        "durationMs": discovery.get("durationMs"),
    }


def stats_summary(stats: dict[str, Any]) -> dict[str, Any]:
    summary = stats["summary"]
    routing = stats["routing"]
    projection = stats["projection"]
    intents = object_or_empty(stats.get("intents"))
    skills = object_or_empty(stats.get("skills"))
    tools = object_or_empty(stats.get("tools"))
    daily = object_or_empty(stats.get("daily"))
    processed_events = object_or_empty(stats.get("processedEvents"))

    intent_rows = []
    for intent_id, value in intents.items():
        intent = object_or_empty(value)
        intent_rows.append(
            {
                "intent": intent_id,
                "turns": number(intent.get("turns")),
                "share": number(intent.get("share")),
                "erroredTurns": number(intent.get("erroredTurns")),
                "lowConfidenceTurns": number(intent.get("lowConfidenceTurns")),
            }
        )
    intent_rows.sort(key=lambda row: (-row["turns"], row["intent"]))

    lifecycle_counts: Counter[str] = Counter()
    low_adoption = []
    for skill_name, value in skills.items():
        skill = object_or_empty(value)
        lifecycle = skill.get("lifecycle")
        if isinstance(lifecycle, str):
            lifecycle_counts[lifecycle] += 1
        if skill.get("needsReview") is True:
            low_adoption.append(
                {
                    "skill": skill_name,
                    "intentMatchedTurns": number(skill.get("intentMatchedTurns")),
                    "adoptedTurns": number(skill.get("adoptedTurns")),
                    "adoptionRate": number(skill.get("adoptionRate")),
                    "lifecycle": lifecycle if isinstance(lifecycle, str) else "<invalid>",
                }
            )
    low_adoption.sort(key=lambda row: (-row["intentMatchedTurns"], row["skill"]))

    tool_rows = []
    total_tool_calls = 0
    total_tool_errors = 0
    latency_histogram: Counter[str] = Counter()
    latency_histogram_tool_count = 0
    for tool_name, value in tools.items():
        tool = object_or_empty(value)
        calls = number(tool.get("calls"))
        errors = number(tool.get("errorCalls"))
        total_tool_calls += calls
        total_tool_errors += errors
        histogram = tool.get("latencyHistogram")
        if isinstance(histogram, dict):
            latency_histogram_tool_count += 1
            for bucket in LATENCY_BUCKETS:
                latency_histogram[bucket] += int(number(histogram.get(bucket)))
        tool_rows.append(
            {
                "tool": tool_name,
                "calls": calls,
                "errorCalls": errors,
                "errorRate": round(errors / calls, 4) if calls else 0,
                "averageDurationMs": number(tool.get("averageDurationMs")),
            }
        )
    tool_rows.sort(key=lambda row: (-row["errorCalls"], -row["calls"], row["tool"]))

    route_reasons_by_intent = {
        intent_id: route_reason_summary(object_or_empty(value).get("routeReasons"))
        for intent_id, value in intents.items()
    }

    return {
        "schemaVersion": stats["schemaVersion"],
        "createdAt": stats.get("createdAt"),
        "updatedAt": stats.get("updatedAt"),
        "attribution": stats_attribution(stats),
        "summary": {
            **{
                key: summary.get(key)
                for key in (
                    "turns",
                    "completedTurns",
                    "erroredTurns",
                    "skillAssistedTurns",
                    "toolAssistedTurns",
                    "averageConfidence",
                )
            },
            "unknownTurns": summary.get("unknownTurns", summary.get("otherTurns")),
            "unknownRate": summary.get("unknownRate", summary.get("otherRate")),
        },
        "routing": {
            key: routing.get(key)
            for key in (
                "intentMatchedTurns",
                "adoptedTurns",
                "turnAdoptionRate",
                "intentMatchedSkillOpportunities",
                "adoptedSkillOpportunities",
                "skillAdoptionRate",
            )
        },
        "skillDiscovery": skill_discovery_summary(stats),
        "projection": {
            key: projection.get(key)
            for key in (
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
            )
        },
        "intentPortfolio": {
            "trackedIntents": len(intents),
            "erroredTurns": sum(row["erroredTurns"] for row in intent_rows),
            "lowConfidenceTurns": sum(row["lowConfidenceTurns"] for row in intent_rows),
            "topByTurns": intent_rows[:TOP_TARGETS],
            "routeReasonAttribution": {
                "status": "available",
                "scoreMeaning": "selected route confidence; QMD routes use hit score",
                "byIntent": route_reasons_by_intent,
            },
        },
        "skillInventory": skill_inventory_summary(stats),
        "skillLifecycle": {
            "trackedSkills": len(skills),
            "byLifecycle": counter_dict(lifecycle_counts),
            "needsReviewCount": len(low_adoption),
            "lowAdoptionCohort": low_adoption[:TOP_TARGETS],
        },
        "toolReliability": {
            "trackedTools": len(tools),
            "calls": total_tool_calls,
            "errorCalls": total_tool_errors,
            "errorRate": round(total_tool_errors / total_tool_calls, 4)
            if total_tool_calls
            else 0,
            "topErrorTools": tool_rows[:TOP_TARGETS],
            "latencyHistogram": {
                "status": "fresh-v7-window",
                "toolCount": latency_histogram_tool_count,
                "buckets": {
                    bucket: latency_histogram[bucket] for bucket in LATENCY_BUCKETS
                },
            },
        },
        "dataHealth": {
            "statsUpdatedAt": stats.get("updatedAt"),
            "dailyRetentionDays": STATS_DAILY_RETENTION_DAYS,
            "dailyBucketCount": len(daily),
            "oldestDailyBucket": min(daily) if daily else None,
            "newestDailyBucket": max(daily) if daily else None,
            "retainedProcessedEventCount": len(processed_events),
        },
    }


def count_experiences(root: Path) -> dict[str, int]:
    if not root.is_dir():
        return {"count": 0, "markdownFiles": 0, "bytes": 0}
    dirs = [path for path in root.iterdir() if path.is_dir()]
    markdown_files = 0
    total_bytes = 0
    for path in root.rglob("*.md"):
        if path.is_file():
            markdown_files += 1
            total_bytes += path.stat().st_size
    return {
        "count": len(dirs),
        "markdownFiles": markdown_files,
        "bytes": total_bytes,
    }


def skill_qmd_health(indexes_root: Path) -> dict[str, Any]:
    roots = sorted(path for path in indexes_root.iterdir() if path.is_dir() and not path.is_symlink()) if indexes_root.is_dir() else []
    rows = [qmd_database_health(root / "docs", root / "skill-search.sqlite") for root in roots]
    return {
        "status": "available" if rows else "unavailable",
        "indexCount": len(rows),
        "byStatus": counter_dict(Counter(row["databaseStatus"] for row in rows)),
        "unavailableCount": sum(row["databaseStatus"] == "unavailable" for row in rows),
        "integrityFailureCount": sum(row["integrityCheck"] not in (None, "ok") for row in rows),
        "activeLeaseCount": sum(row["leaseActive"] is True for row in rows),
        "documentVectorMismatchCount": sum(row["documentsMatchVectors"] is False for row in rows),
        "unknownDocumentVectorCount": sum(row["documentsMatchVectors"] is None for row in rows),
        "snapshotMismatchCount": sum(row["snapshotMatchesIndexedDocuments"] is False for row in rows),
    }


def observed_number(value: Any) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return None


def ratio(numerator: int | float | None, denominator: int | float | None) -> dict[str, Any]:
    return {"numerator": numerator, "denominator": denominator,
            "rate": round(numerator / denominator, 4) if numerator is not None and denominator else None}


def nested(value: dict[str, Any], *keys: str) -> Any:
    result: Any = value
    for key in keys:
        result = object_or_empty(result).get(key)
    return result


def observed_sum(rows: list[dict[str, Any]], *keys: str) -> int | float | None:
    values = [observed_number(nested(row, *keys)) for row in rows]
    return sum(values) if rows and all(value is not None for value in values) else None


def numeric_summary(values: list[int | float]) -> dict[str, Any]:
    return {"count": len(values), "average": round(sum(values) / len(values), 4) if values else None,
            "min": min(values, default=None), "max": max(values, default=None)}


def merged_score(rows: list[dict[str, Any]], *keys: str) -> dict[str, Any]:
    count = 0
    weighted = 0.0
    minima: list[int | float] = []
    maxima: list[int | float] = []
    missing = 0
    for row in rows:
        score = object_or_empty(nested(row, *keys))
        n = observed_number(score.get("count"))
        average = observed_number(score.get("average"))
        low = observed_number(score.get("min"))
        high = observed_number(score.get("max"))
        if n is None or (n > 0 and None in (average, low, high)):
            missing += 1
        elif n:
            count += n
            weighted += n * average
            minima.append(low)
            maxima.append(high)
    return {"count": count, "average": round(weighted / count, 4) if count else None,
            "min": min(minima, default=None), "max": max(maxima, default=None), "missingBuckets": missing}


def merged_counts(rows: list[dict[str, Any]], *keys: str) -> dict[str, int | float]:
    counts: Counter[str] = Counter()
    for row in rows:
        for key, value in object_or_empty(nested(row, *keys)).items():
            n = observed_number(value)
            if n is not None:
                counts[key] += n
    return counter_dict(counts)


def discovery_analysis(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = observed_sum(rows, "turns")
    attempts = observed_sum(rows, "qmdSearch", "attemptedTurns")
    return {
        "turns": total,
        "nameMatch": {"hitTurns": ratio(observed_sum(rows, "nameMatch", "matchedTurns"), total),
                      "candidates": observed_sum(rows, "nameMatch", "candidates")},
        "qmdSearch": {"attemptedTurns": attempts,
                      "hitTurns": ratio(observed_sum(rows, "qmdSearch", "matchedTurns"), attempts),
                      "candidates": observed_sum(rows, "qmdSearch", "candidates"),
                      "semanticScore": merged_score(rows, "qmdSearch", "semanticScore"),
                      "collections": merged_counts(rows, "qmdSearch", "collections"),
                      "collectionBuckets": sum(isinstance(nested(row, "qmdSearch", "collections"), dict) for row in rows),
                      "injectedCollections": merged_counts(rows, "qmdSearch", "injectedCollections"),
                      "injectedCollectionBuckets": sum(isinstance(nested(row, "qmdSearch", "injectedCollections"), dict) for row in rows),
                      "injectedSkillCount": observed_sum(rows, "qmdSearch", "injectedSkills"),
                      "injectedCountMeaning": "includes experience-source skills; not pure skill-search conversion"},
        "pool": {"nonEmptyTurns": ratio(observed_sum(rows, "pool", "nonEmptyTurns"), total),
                 "skillInjectedTurns": ratio(observed_sum(rows, "pool", "injectedTurns"), total),
                 "candidates": observed_sum(rows, "pool", "candidates"),
                 "injectedSkills": observed_sum(rows, "pool", "injectedSkills")},
        "fallbackReasons": merged_counts(rows, "fallbackReasons"),
        "durationMs": merged_score(rows, "durationMs"),
    }


def skill_rows(stats: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for name, value in object_or_empty(stats.get("skills")).items():
        skill = object_or_empty(value)
        injected = observed_number(skill.get("intentMatchedTurns"))
        adopted = observed_number(skill.get("adoptedTurns"))
        rows.append({"skill": name, "usageTurns": observed_number(skill.get("usageTurns")),
                     "injectedTurns": injected, "adoptedTurns": adopted,
                     "unadoptedTurns": injected - adopted if injected is not None and adopted is not None and adopted <= injected else None,
                     "adoption": ratio(adopted, injected), "lowSample": injected is None or injected < 20,
                     "lastUsedAt": skill.get("lastUsedAt"), "last7DaysUsage": observed_number(skill.get("last7DaysUsage")),
                     "lifecycle": skill.get("lifecycle")})
    return rows


def ranked(rows: list[dict[str, Any]], metric: str) -> list[dict[str, Any]]:
    eligible = [row for row in rows if observed_number(row.get(metric)) is not None and row[metric] > 0]
    return sorted(eligible, key=lambda row: (-row[metric], row["skill"]))[:TOP_TARGETS]


def review_analysis(review: dict[str, Any] | None, start: float, end: float) -> dict[str, Any]:
    if review is None:
        return {"status": "unavailable"}
    events = object_or_empty(review.get("processedEvents"))
    selected = {key: value for key, value in events.items()
                if isinstance(value, dict) and (at := iso_timestamp(value.get("processedAt"))) is not None and start <= at < end}
    summarized = {key: {**value, "changes": value.get("changes", []) if value.get("outcome") == "applied" else []} for key, value in selected.items()}
    result = review_change_summary(summarized)
    result["status"] = "observed-completed-events"
    result["outcomeRates"] = {outcome: ratio(count, result["eventCount"]) for outcome, count in ((name, result["outcomes"].get(name, 0)) for name in ("applied", "nofinding", "schema-rejected", "parse-failed", "subagent-error", "validation-failed"))}
    result["lastCompletedAt"] = max((value["processedAt"] for value in selected.values()), key=lambda value: iso_timestamp(value), default=None)
    result["invalidTimestamps"] = sum(iso_timestamp(object_or_empty(value).get("processedAt")) is None for value in events.values())
    result["queueState"] = "unobserved"
    return result


def name_list(value: Any, records: bool = False) -> set[str] | None:
    if not isinstance(value, list):
        return None
    values = [object_or_empty(item).get("name") if records else item for item in value]
    if not all(isinstance(name, str) and name.strip() for name in values):
        return None
    return set(values)


def routing_observations(sessions_dir: Path) -> tuple[list[dict[str, Any]], dict[str, int]]:
    selected: dict[tuple[str, str], tuple[tuple[bool, bool], dict[str, Any]]] = {}
    health = {"invalidFiles": 0, "unidentifiedTurns": 0, "invalidTimestamps": 0, "duplicateTurns": 0}
    for path in sorted(sessions_dir.glob("*.json")):
        try:
            session = load_json(path)
        except ValueError:
            health["invalidFiles"] += 1
            continue
        session_id = session.get("sessionId")
        if not isinstance(session_id, str) or not session_id.strip():
            health["invalidFiles"] += 1
            continue
        history = session.get("history", [])
        if not isinstance(history, list):
            history = []
        for current, raw in [(False, row) for row in history] + [(True, session.get("current"))]:
            if not isinstance(raw, dict):
                continue
            timestamps = object_or_empty(raw.get("timestamps"))
            end = iso_timestamp(timestamps.get("end"))
            at = end if end is not None else iso_timestamp(timestamps.get("start"))
            identity = raw.get("turnKey") or timestamps.get("start")
            if not isinstance(identity, str) or not identity.strip():
                health["unidentifiedTurns"] += 1
                continue
            if at is None:
                health["invalidTimestamps"] += 1
                continue
            # Whitelist routing metadata. Never retain transcript or tool payload fields.
            discovery = object_or_empty(raw.get("inputSkillDiscovery"))
            record = {"at": at, "completed": end is not None,
                      "skills": name_list(raw.get("matchedSkills")),
                      "experiences": name_list(raw.get("matchedExperiences")),
                      "used": name_list(raw.get("skillsUsed"), records=True),
                      "confidence": observed_number(raw.get("confidence")),
                      "discovery": {key: discovery.get(key) for key in (
                          "candidateCount", "nameCandidates", "retrievalAttempted", "retrievalCandidates", "durationMs")},
                      "experienceRetrieval": discovery.get("experienceRetrieval")}
            key = (session_id, identity)
            priority = (end is not None, current)
            if key in selected:
                health["duplicateTurns"] += 1
            if key not in selected or priority > selected[key][0]:
                selected[key] = (priority, record)
    return [record for _, record in selected.values()], health


def session_analysis(records: list[dict[str, Any]], start: float, end: float) -> dict[str, Any]:
    rows = [row for row in records if start <= row["at"] < end]
    routed = [row for row in rows if row["skills"] is not None and row["experiences"] is not None]
    complete_usage = [row for row in routed if row["completed"] and row["used"] is not None]
    usage: dict[str, Counter[str]] = {}
    for row in complete_usage:
        for skill in row["skills"] | row["used"]:
            count = usage.setdefault(skill, Counter())
            count["usageTurns"] += skill in row["used"]
            count["injectedTurns"] += skill in row["skills"]
            count["adoptedTurns"] += skill in row["skills"] & row["used"]
            count["unadoptedTurns"] += skill in row["skills"] - row["used"]
            count["usedWithoutInjectionTurns"] += skill in row["used"] - row["skills"]
    skill_usage = [{"skill": skill, **dict(count), "adoption": ratio(count["adoptedTurns"], count["injectedTurns"]),
                    "lowSample": count["injectedTurns"] < 20} for skill, count in usage.items()]
    statuses: Counter[str] = Counter()
    scores: list[int | float] = []
    candidates = hits = selected = selected_count = 0
    candidate_rows = candidate_with_hits = score_rows = 0
    thresholds: Counter[str] = Counter()
    for row in routed:
        retrieval = object_or_empty(row["experienceRetrieval"])
        status = retrieval.get("status")
        statuses[status if status in ("completed", "disabled", "unavailable", "timeout", "error") else "unobserved"] += 1
        if status != "completed":
            continue
        n = observed_number(retrieval.get("candidateCount"))
        if n is not None:
            candidate_rows += 1
            candidates += n
            candidate_with_hits += n > 0
            if n > 0:
                selected += bool(row["experiences"])
                selected_count += len(row["experiences"])
        entries = retrieval.get("hits")
        if isinstance(entries, list):
            hits += len(entries)
            score_rows += 1
            scores.extend(n for hit in entries if (n := observed_number(object_or_empty(hit).get("semanticScore"))) is not None)
        threshold = observed_number(retrieval.get("minCandidateScore"))
        if threshold is not None:
            thresholds[str(threshold)] += 1
    pool_rows = []
    for row in routed:
        skill_candidates = observed_number(row["discovery"].get("candidateCount"))
        retrieval = object_or_empty(row["experienceRetrieval"])
        exp_candidates = observed_number(retrieval.get("candidateCount"))
        if skill_candidates is not None and exp_candidates is not None:
            pool_rows.append((row, skill_candidates + exp_candidates > 0))
    nonempty = [(row, present) for row, present in pool_rows if present]
    confidence = [row["confidence"] for row in routed if row["confidence"] is not None and row["confidence"] <= 1]
    durations = [value for row in routed if (value := observed_number(row["discovery"].get("durationMs"))) is not None]
    return {
        "status": "observed" if rows else "unavailable", "source": "retained-session-routing-fields",
        "turns": len(rows), "routedTurns": len(routed), "completeUsageTurns": len(complete_usage),
        "firstObservedAt": datetime.fromtimestamp(min((row["at"] for row in rows), default=start), timezone.utc).isoformat() if rows else None,
        "lastObservedAt": datetime.fromtimestamp(max((row["at"] for row in rows), default=start), timezone.utc).isoformat() if rows else None,
        "selection": {"poolObservedTurns": len(pool_rows), "emptyPoolTurns": len(pool_rows) - len(nonempty),
                      "nonEmptyWithoutInjection": ratio(sum(not row["skills"] and not row["experiences"] for row, _ in nonempty), len(nonempty)),
                      "skillInjectedTurns": sum(bool(row["skills"]) for row in routed),
                      "experienceInjectedTurns": sum(bool(row["experiences"]) for row in routed),
                      "injectedSkills": sum(len(row["skills"]) for row in routed),
                      "injectedExperiences": sum(len(row["experiences"]) for row in routed),
                      "confidence": numeric_summary(confidence), "discoveryDurationMs": numeric_summary(durations)},
        "experienceRetrieval": {"statuses": counter_dict(statuses), "statusDenominator": len(routed),
                                "candidateObservedTurns": candidate_rows, "hitTurns": ratio(candidate_with_hits, candidate_rows),
                                "candidateCount": candidates if candidate_rows else None, "hitCount": hits if score_rows else None,
                                "selectedFromNonEmpty": ratio(selected, candidate_with_hits),
                                "selectedExperiencesFromNonEmpty": selected_count if candidate_rows else None,
                                "semanticScore": numeric_summary(scores), "observedThresholds": counter_dict(thresholds)},
        "skills": {"topUsed": ranked(skill_usage, "usageTurns"), "topUnadopted": ranked(skill_usage, "unadoptedTurns"),
                   "topUsedWithoutInjection": ranked(skill_usage, "usedWithoutInjectionTurns")},
    }


def daily_skill_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names = {name for row in rows for name in object_or_empty(row.get("skills"))}
    names.update(key[6:] for row in rows for key in object_or_empty(row.get("skillRouting"))
                 if key.startswith("value:"))
    usage_complete = bool(rows) and all(isinstance(row.get("skills"), dict) for row in rows)
    routing_complete = bool(rows) and all(isinstance(row.get("skillRouting"), dict)
                                         and "__other__" not in row["skillRouting"] for row in rows)
    result = []
    for name in sorted(names):
        usage = observed_sum([{"n": row["skills"].get(name, 0)} for row in rows], "n") if usage_complete else None
        counts = []
        if routing_complete:
            for row in rows:
                entries = row["skillRouting"]
                counts.append(object_or_empty(entries["value:" + name]) if "value:" + name in entries
                              else {"intentMatchedTurns": 0, "adoptedTurns": 0})
        injected = observed_sum(counts, "intentMatchedTurns")
        adopted = observed_sum(counts, "adoptedTurns")
        result.append({
            "skill": name, "usageTurns": usage, "injectedTurns": injected, "adoptedTurns": adopted,
            "unadoptedTurns": injected - adopted if injected is not None and adopted is not None and adopted <= injected else None,
            "adoption": ratio(adopted, injected), "lowSample": injected is None or injected < 20,
        })
    return result


def decision_analysis(data_root: Path, stats: dict[str, Any] | None, review: dict[str, Any] | None,
                      days: int, now: datetime | None) -> dict[str, Any]:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    end = now.replace(hour=0, minute=0, second=0, microsecond=0)
    daily = object_or_empty((stats or {}).get("daily"))
    records, session_data = routing_observations(data_root / "sessions")
    cohort_start = iso_timestamp(nested(stats or {}, "attribution", "startedAt"))
    cohort_date = datetime.fromtimestamp(cohort_start, timezone.utc).date().isoformat() if cohort_start is not None else None
    windows = {}
    for label, window_end in (("recent", end), ("previous", end - timedelta(days=days))):
        start = window_end - timedelta(days=days)
        dates = [(start + timedelta(days=i)).date().isoformat() for i in range(days)]
        pre_cohort = [date for date in dates if cohort_date is not None and date < cohort_date and date in daily]
        rows = [daily[date] for date in dates if isinstance(daily.get(date), dict) and (cohort_date is None or date >= cohort_date)]
        cohort_partial = cohort_start is not None and start.timestamp() < cohort_start < window_end.timestamp()
        discovery = [row["skillDiscovery"] for row in rows if isinstance(row.get("skillDiscovery"), dict)]
        daily_skills = daily_skill_rows(rows)
        windows[label] = {
            "start": start.isoformat(), "endExclusive": window_end.isoformat(), "timezone": "UTC",
            "daily": {"status": "available" if stats is not None and len(rows) == days and not cohort_partial else "partial" if rows else "unavailable",
                      "source": "stats.daily", "expectedBuckets": days, "observedBuckets": len(rows),
                      "discoveryBuckets": len(discovery), "excludedPreCohortBuckets": len(pre_cohort),
                      "cohortStartedDuringWindow": cohort_partial, "turns": observed_sum(rows, "turns"),
                      "erroredTurns": ratio(observed_sum(rows, "erroredTurns"), observed_sum(rows, "turns")),
                      "skillDiscovery": discovery_analysis(discovery),
                      "adoption": ratio(observed_sum(rows, "routing", "adoptedSkillOpportunities"), observed_sum(rows, "routing", "intentMatchedSkillOpportunities")),
                      "toolCalls": sum(merged_counts(rows, "tools").values()) if rows and all(isinstance(row.get("tools"), dict) for row in rows) else None,
                      "toolErrors": sum(merged_counts(rows, "toolErrors").values()) if rows and all(isinstance(row.get("toolErrors"), dict) for row in rows) else None,
                      "topUsedSkills": ranked(daily_skills, "usageTurns"),
                      "topUnadoptedSkills": ranked(daily_skills, "unadoptedTurns"),
                      "skillRoutingOverflowBuckets": sum("__other__" in object_or_empty(row.get("skillRouting")) for row in rows)},
            "sessions": session_analysis(records, start.timestamp(), window_end.timestamp()),
            "review": review_analysis(review, start.timestamp(), window_end.timestamp()),
        }
        window = windows[label]
        window["daily"]["toolErrorRate"] = ratio(window["daily"]["toolErrors"], window["daily"]["toolCalls"])
        window["review"]["coverage"] = {"retentionDays": 90, "extendsBeforeRetention": start < now - timedelta(days=90)}
        window["sessions"]["retentionDays"] = RETENTION_DAYS
        window["sessions"]["extendsBeforeRetention"] = start < now - timedelta(days=RETENTION_DAYS)
        window["sessions"]["coverage"] = "retained-observations-only; completeness cannot be established"
    rows = skill_rows(stats or {})
    return {
        "generatedAt": now.isoformat(), "days": days, "windows": windows,
        "cumulative": {"source": "stats.json since attribution.startedAt; review retained completed events",
                       "statsStatus": "available" if stats is not None else "unavailable",
                       "startedAt": nested(stats or {}, "attribution", "startedAt"),
                       "statsUpdatedAt": (stats or {}).get("updatedAt"),
                       "skillDiscovery": discovery_analysis([stats["skillDiscovery"]]) if stats is not None else {"status": "unavailable"},
                       "skills": {"lowSampleInjectionThreshold": 20, "topUsed": ranked(rows, "usageTurns"),
                                  "topUnadopted": ranked(rows, "unadoptedTurns")},
                       "review": review_analysis(review, 0, now.timestamp())},
        "sessionDataQuality": session_data,
        "unobserved": ["Gateway plugin load", "Review enabled/queue/running state/duration/cost",
                       "selector failure cause and phase latency", "routing precision/recall", "configuration-change attribution"],
        "interpretation": ["Rates are observations, not accuracy or causal effects.",
                           "Name and QMD candidates overlap; never sum channel counts as a unique pool.",
                           "Daily skillRouting/toolErrors attribution keys are encoded and may overflow into __other__; daily usage names are raw.",
                           "Review triggers overlap; outcome rates use completed events, not trigger counts.",
                           "Repair index/data health before proposing threshold changes; low adoption alone does not justify deletion."],
    }


def build_report(data_root: Path, days: int = 7, now: datetime | None = None) -> dict[str, Any]:
    review_path = data_root / "review.json"
    stats_path = data_root / "stats.json"
    present = [path for path in (review_path, stats_path) if path.is_file()]
    before_hashes = {path.name: sha256(path) for path in present}
    review = load_review_log(review_path) if review_path in present else None
    stats = load_stats(stats_path) if stats_path in present else None
    after_hashes = {path.name: sha256(path) for path in present}
    if any(path.is_file() != (path in present) for path in (review_path, stats_path)):
        raise ValueError("runtime state availability changed while being read")
    changed = sorted(name for name in before_hashes if before_hashes[name] != after_hashes[name])
    if changed:
        raise ValueError(f"runtime state changed while being read: {', '.join(changed)}")

    experiences_info = count_experiences(data_root / "experiences")
    intent_paths = (
        sorted((data_root / "intents").glob("*.md"))
        if (data_root / "intents").is_dir()
        else []
    )
    intent_files = len(intent_paths)
    intent_bytes = sum(path.stat().st_size for path in intent_paths)
    analysis = decision_analysis(data_root, stats, review, days, now)
    qmd = qmd_health(data_root / "qmd")
    qmd["skills"] = skill_qmd_health(data_root / "qmd" / "skills" / "indexes")
    return {
        "schemaVersion": 1,
        "reportOnly": True,
        "dataRoot": str(data_root),
        "provenance": {
            "stateSha256": before_hashes,
            "scriptSha256": sha256(SCRIPT_PATH),
        },
        "runtime": {
            "review": {
                "schemaVersion": review["schemaVersion"],
                "updatedAt": review.get("updatedAt"),
                "processedEvents": review_change_summary(review["processedEvents"]),
                "reviewedSkillEpochCount": len(review["reviewedSkillEpochs"]),
            } if review is not None else {"status": "unavailable"},
            "stats": stats_summary(stats) if stats is not None else {"status": "unavailable"},
            "sessions": session_health(data_root / "sessions", data_root / "agents"),
            "experiences": experiences_info,
            "intents": {"markdownFiles": intent_files, "bytes": intent_bytes},
            "qmd": qmd,
        },
        "analysis": analysis,
        "privacy": {
            "sessionTextIncluded": False,
            "reviewSuggestionTextIncluded": False,
            "reviewEvidenceIncluded": False,
            "toolParamsOrResultsIncluded": False,
        },
    }


def write_report(path: Path, rendered: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as temporary:
        temporary.write(rendered)
        temporary_path = Path(temporary.name)
    try:
        temporary_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary_path, path)
    except OSError:
        temporary_path.unlink(missing_ok=True)
        raise


def main() -> int:
    args = parse_args()
    try:
        report = build_report(args.data_root, args.days)
    except (ValueError, OSError) as error:
        print(f"runtime health audit failed: {error}", file=sys.stderr)
        return 1
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.stdout:
        sys.stdout.write(rendered)
    else:
        write_report(args.output, rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
