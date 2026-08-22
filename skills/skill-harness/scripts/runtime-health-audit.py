#!/usr/bin/env python3
"""Report-only Skill Harness runtime health and Review-change distribution audit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
RETENTION_DAYS = 14
STATS_DAILY_RETENTION_DAYS = 90
TOP_TARGETS = 10
LATENCY_BUCKETS = ("unknown", "0-99", "100-499", "500-999", "1000-4999", "5000+")


def default_data_root() -> Path:
    state_dir = Path(os.environ.get("OPENCLAW_STATE_DIR", Path.home() / ".openclaw"))
    return state_dir / "plugins" / "skill-harness"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=default_data_root())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()
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
    if value.get("schemaVersion") != 7:
        raise ValueError(f"{path} must be a current schema-v7 review log")
    for field in ("processedEvents", "reviewedSkillEpochs", "historicalKeywordAudits"):
        require_object(value, field, path)
    return value


def load_keyword_coverage_log(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if value.get("schemaVersion") != 1:
        raise ValueError(f"{path} must be a current schema-v1 keyword coverage log")
    keywords = require_object(value, "triggerKeywords", path)
    for field in ("successfulPattern", "behaviorFix", "entityContext"):
        if not isinstance(keywords.get(field), list) or not all(
            isinstance(keyword, str) for keyword in keywords[field]
        ):
            raise ValueError(f"{path} has invalid triggerKeywords.{field}")
    for field in ("processedKeywordEvents", "targets", "coverageEpochs"):
        require_object(value, field, path)
    return value


def load_stats(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if value.get("schemaVersion") not in (3, 4):
        raise ValueError(f"{path} must be a supported schema-v3 or schema-v4 stats log")
    for field in ("summary", "routing", "projection"):
        require_object(value, field, path)
    if value["schemaVersion"] == 4:
        attribution = require_object(value, "attribution", path)
        if not isinstance(attribution.get("startedAt"), str):
            raise ValueError(f"{path} has invalid attribution.startedAt")
    return value


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
    snapshot_root = qmd_root / "intents"
    snapshot_markdown_files = (
        sum(1 for _ in snapshot_root.rglob("*.md"))
        if snapshot_root.is_dir()
        else 0
    )
    database_path = qmd_root / "intent-routing.sqlite"
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
        with sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True) as database:
            integrity_check = database.execute("PRAGMA integrity_check").fetchone()[0]
            state = database.execute(
                """
                SELECT status, generation, lease_expires_at
                FROM embedding_index_state
                WHERE singleton = 1
                """
            ).fetchone()
            indexed_documents = database.execute(
                "SELECT COUNT(*) FROM documents WHERE active = 1"
            ).fetchone()[0]
            indexed_vectors = database.execute(
                "SELECT COUNT(*) FROM content_vectors"
            ).fetchone()[0]
    except sqlite3.Error:
        return unavailable

    status, generation, lease_expires_at = state if state else ("unknown", None, None)
    lease_active = (
        isinstance(lease_expires_at, (int, float))
        and lease_expires_at > time.time() * 1000
    )
    return {
        "databaseStatus": status,
        "integrityCheck": integrity_check,
        "generation": generation,
        "leaseActive": lease_active,
        "snapshotMarkdownFiles": snapshot_markdown_files,
        "indexedDocuments": indexed_documents,
        "indexedVectors": indexed_vectors,
        "documentsMatchVectors": indexed_documents == indexed_vectors,
        "snapshotMatchesIndexedDocuments": snapshot_markdown_files == indexed_documents,
    }


def iso_timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
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


def top_counts(counts: dict[str, Any], value_field: str) -> list[dict[str, Any]]:
    rows = [
        {"name": name, value_field: number(value)}
        for name, value in counts.items()
        if isinstance(name, str)
    ]
    return sorted(rows, key=lambda row: (-row[value_field], row["name"]))[:TOP_TARGETS]


def stats_attribution(stats: dict[str, Any]) -> dict[str, Any]:
    if stats["schemaVersion"] == 3:
        return {
            "status": "insufficient-historical-attribution",
            "reason": "schema-v3 does not record daily intent, skill, or tool attribution",
        }

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
        "status": "post-v4-window-only",
        "startedAt": started_at,
        "dailyBucketsBeforeAttribution": historical_days,
        "note": "The attribution start date can contain pre-v4 turns before startedAt.",
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
                    "recommendedTurns": number(skill.get("recommendedTurns")),
                    "adoptedTurns": number(skill.get("adoptedTurns")),
                    "adoptionRate": number(skill.get("adoptionRate")),
                    "lifecycle": lifecycle if isinstance(lifecycle, str) else "<invalid>",
                }
            )
    low_adoption.sort(key=lambda row: (-row["recommendedTurns"], row["skill"]))

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

    daily_cardinality = {
        "maxIntents": 0,
        "maxSkills": 0,
        "maxTools": 0,
        "maxProjectionFallbackReasons": 0,
        "maxIntentOutcomes": 0,
        "maxIntentRouting": 0,
        "maxSkillRouting": 0,
        "maxToolErrors": 0,
    }
    for bucket_value in daily.values():
        bucket = object_or_empty(bucket_value)
        projection_bucket = object_or_empty(bucket.get("projection"))
        for report_key, source in (
            ("maxIntents", bucket.get("intents")),
            ("maxSkills", bucket.get("skills")),
            ("maxTools", bucket.get("tools")),
            ("maxProjectionFallbackReasons", projection_bucket.get("fallbackReasons")),
            ("maxIntentOutcomes", bucket.get("intentOutcomes")),
            ("maxIntentRouting", bucket.get("intentRouting")),
            ("maxSkillRouting", bucket.get("skillRouting")),
            ("maxToolErrors", bucket.get("toolErrors")),
        ):
            daily_cardinality[report_key] = max(
                daily_cardinality[report_key], len(object_or_empty(source))
            )

    return {
        "schemaVersion": stats["schemaVersion"],
        "createdAt": stats.get("createdAt"),
        "updatedAt": stats.get("updatedAt"),
        "attribution": stats_attribution(stats),
        "summary": {
            key: summary.get(key)
            for key in (
                "turns",
                "completedTurns",
                "erroredTurns",
                "skillAssistedTurns",
                "toolAssistedTurns",
                "averageConfidence",
                "otherTurns",
                "otherRate",
                "curationAppliedCount",
            )
        },
        "curation": {
            "status": (
                "unavailable"
                if stats["schemaVersion"] == 3 and "curation" not in stats
                else "available"
            ),
            "appliedRevisions": number(
                object_or_empty(stats.get("curation")).get("appliedRevisions")
            ),
            "candidatesKept": number(
                object_or_empty(stats.get("curation")).get("candidatesKept")
            ),
            "candidatesAdded": number(
                object_or_empty(stats.get("curation")).get("candidatesAdded")
            ),
            "recommendedExperiencesSelected": number(
                object_or_empty(stats.get("curation")).get(
                    "recommendedExperiencesSelected"
                )
            ),
            "lastAppliedAt": object_or_empty(stats.get("curation")).get("lastAppliedAt"),
        },
        "routing": {
            key: routing.get(key)
            for key in (
                "recommendationTurns",
                "adoptedTurns",
                "turnAdoptionRate",
                "recommendedSkillOpportunities",
                "adoptedSkillOpportunities",
                "skillAdoptionRate",
            )
        },
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
        "routingEffectiveness": {
            key: routing.get(key)
            for key in (
                "recommendationTurns",
                "adoptedTurns",
                "turnAdoptionRate",
                "recommendedSkillOpportunities",
                "adoptedSkillOpportunities",
                "skillAdoptionRate",
            )
        },
        "projectionEfficiency": {
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
        },
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
                "status": (
                    "unavailable"
                    if stats["schemaVersion"] == 3
                    else "post-v4-window-only"
                ),
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
            "processedEventCount": len(processed_events),
            "dailyDynamicKeyCardinality": daily_cardinality,
        },
    }


def build_report(data_root: Path) -> dict[str, Any]:
    review_path = data_root / "review.json"
    coverage_path = data_root / "keyword-coverage.json"
    stats_path = data_root / "stats.json"
    for path in (review_path, coverage_path, stats_path):
        if not path.is_file():
            raise ValueError(f"missing required runtime state: {path}")

    before_hashes = {path.name: sha256(path) for path in (review_path, coverage_path, stats_path)}
    review = load_review_log(review_path)
    coverage = load_keyword_coverage_log(coverage_path)
    stats = load_stats(stats_path)
    after_hashes = {path.name: sha256(path) for path in (review_path, coverage_path, stats_path)}
    changed = sorted(name for name in before_hashes if before_hashes[name] != after_hashes[name])
    if changed:
        raise ValueError(f"runtime state changed while being read: {', '.join(changed)}")

    intent_paths = (
        sorted((data_root / "intents").glob("*.md"))
        if (data_root / "intents").is_dir()
        else []
    )
    intent_files = len(intent_paths)
    intent_bytes = sum(path.stat().st_size for path in intent_paths)
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
                "historicalKeywordAuditCount": len(review["historicalKeywordAudits"]),
                "reviewedSkillEpochCount": len(review["reviewedSkillEpochs"]),
            },
            "keywordCoverage": {
                "schemaVersion": coverage["schemaVersion"],
                "updatedAt": coverage.get("updatedAt"),
                "keywordCounts": {
                    field: len(keywords)
                    for field, keywords in coverage["triggerKeywords"].items()
                    if isinstance(keywords, list)
                },
                "processedKeywordEventCount": len(coverage["processedKeywordEvents"]),
                "coverageEpochCount": len(coverage["coverageEpochs"]),
                "targetCount": len(coverage["targets"]),
            },
            "stats": stats_summary(stats),
            "sessions": session_health(data_root / "sessions", data_root / "agents"),
            "intents": {"markdownFiles": intent_files, "bytes": intent_bytes},
            "qmd": qmd_health(data_root / "qmd"),
        },
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
        report = build_report(args.data_root)
    except ValueError as error:
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
