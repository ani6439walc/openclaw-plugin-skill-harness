#!/usr/bin/env python3
"""Audit Skill Harness Review trigger-keyword coverage from runtime state.

This script is intentionally report-only. It never modifies review.json, session
snapshots, stats.json, or intent Markdown.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

TARGETS = ("successful-pattern", "behavior-fix", "entity-context")
DEFAULT_SUCCESSFUL_TOOL_CALLS = 5
SCRIPT_PATH = Path(__file__).resolve()
KEYWORD_FIELDS = {
    "successful-pattern": "successfulPattern",
    "behavior-fix": "behaviorFix",
    "entity-context": "entityContext",
}
QUOTED_CONTENT_MARKERS = (
    "dream diary",
    "memory fragments",
    "from these memory fragments",
    "ingest prompt",
    "ingest payload",
)
ENTITY_CONTEXT_SOURCE_FILES = ("tools.md", "memory.md")
ENTITY_CONTEXT_READ_TOOLS = {"read", "read_file", "search_files"}
LATIN_STOPWORDS = {
    "and",
    "are",
    "for",
    "from",
    "has",
    "have",
    "not",
    "that",
    "the",
    "this",
    "was",
    "were",
    "with",
    "you",
    "your",
}
CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
LATIN_TOKEN = re.compile(r"[a-z0-9][a-z0-9._/+:-]*")


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).lower().split())


def string_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(string_value(item) for item in value)
    return ""


def includes_any(text: str, keywords: Iterable[str]) -> bool:
    normalized = normalize(text)
    return any(normalize(keyword) in normalized for keyword in keywords if keyword.strip())


def is_quoted_content_prompt(value: str) -> bool:
    normalized = normalize(value)
    return any(marker in normalized for marker in QUOTED_CONTENT_MARKERS)


def has_entity_source_text(value: str) -> bool:
    normalized = normalize(value)
    return (
        any(source in normalized for source in ENTITY_CONTEXT_SOURCE_FILES)
        or "/memory" in normalized
        or "memory/" in normalized
        or "\\memory" in normalized
        or "memory\\" in normalized
    )


def has_entity_source_param(value: str) -> bool:
    normalized = normalize(value)
    return has_entity_source_text(normalized) or "memory" in normalized


def tool_calls_read_entity_source(tool_calls: list[dict[str, Any]]) -> bool:
    for call in tool_calls:
        if call.get("name") not in ENTITY_CONTEXT_READ_TOOLS:
            continue
        params = call.get("params")
        if not isinstance(params, dict):
            continue
        for value in params.values():
            if has_entity_source_param(string_value(value)):
                return True
    return False


def state_text(state: dict[str, Any], target: str) -> str:
    input_text = state.get("input") if isinstance(state.get("input"), str) else ""
    result_text = state.get("result") if isinstance(state.get("result"), str) else ""
    if target == "behavior-fix":
        return input_text
    return f"{input_text}\n{result_text}"


def is_eligible(
    state: dict[str, Any], target: str, successful_tool_calls: int
) -> bool:
    tool_calls = state.get("toolCalls")
    if not isinstance(tool_calls, list):
        tool_calls = []
    safe_calls = [call for call in tool_calls if isinstance(call, dict)]
    if target == "successful-pattern":
        skills_used = state.get("skillsUsed")
        skill_count = len(skills_used) if isinstance(skills_used, list) else 0
        return (
            not state.get("error")
            and (len(safe_calls) >= successful_tool_calls or skill_count > 0)
        )
    if target == "behavior-fix":
        input_text = state.get("input")
        return isinstance(input_text, str) and bool(input_text) and not is_quoted_content_prompt(
            input_text
        )
    text = state_text(state, target)
    return has_entity_source_text(text) or tool_calls_read_entity_source(safe_calls)


def phrase_candidates(text: str) -> set[str]:
    normalized = normalize(text)
    phrases: set[str] = set()
    for run in CJK_RUN.findall(normalized):
        for width in range(2, min(6, len(run)) + 1):
            phrases.update(run[index : index + width] for index in range(len(run) - width + 1))
    tokens = [token for token in LATIN_TOKEN.findall(normalized) if token not in LATIN_STOPWORDS]
    for width in range(1, 4):
        for index in range(len(tokens) - width + 1):
            phrase = " ".join(tokens[index : index + width])
            if len(phrase) >= 3:
                phrases.add(phrase)
    return phrases


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_commit() -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(SCRIPT_PATH.parents[3]), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    commit = result.stdout.strip()
    return commit or None


def load_review_log(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if not isinstance(value, dict) or value.get("schemaVersion") != 6:
        raise ValueError(f"{path} must be a current schema-v6 review log")
    for field in ("processedEvents", "historicalKeywordAudits"):
        if not isinstance(value.get(field), dict):
            raise ValueError(f"{path} has an invalid {field}")
    return value


def load_keyword_coverage_log(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError(f"{path} must be a current schema-v1 keyword coverage log")
    keywords = value.get("triggerKeywords")
    if not isinstance(keywords, dict):
        raise ValueError(f"{path} is missing triggerKeywords")
    for field in KEYWORD_FIELDS.values():
        if not isinstance(keywords.get(field), list) or not all(
            isinstance(item, str) for item in keywords[field]
        ):
            raise ValueError(f"{path} has an invalid triggerKeywords.{field}")
    for field in ("processedKeywordEvents", "coverageEpochs"):
        if not isinstance(value.get(field), dict):
            raise ValueError(f"{path} has an invalid {field}")
    return value


def load_states(sessions_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    states: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in sorted(sessions_dir.glob("*.json")):
        try:
            value = load_json(path)
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"{path.name}: {error.__class__.__name__}")
            continue
        if not isinstance(value, dict):
            errors.append(f"{path.name}: root is not an object")
            continue
        history = value.get("history") if isinstance(value.get("history"), list) else []
        for index, state in enumerate(history):
            if not isinstance(state, dict):
                continue
            states.append(
                {
                    "ref": f"{path.name}#history:{index}",
                    "state": state,
                }
            )
        current = value.get("current")
        if isinstance(current, dict):
            states.append(
                {
                    "ref": f"{path.name}#current:0",
                    "state": current,
                }
            )
    return states, errors


def analysis_window(records: list[dict[str, Any]]) -> dict[str, Any]:
    starts: list[str] = []
    ends: list[str] = []
    timestamped = 0
    for record in records:
        state = record.get("state")
        timestamps = state.get("timestamps") if isinstance(state, dict) else None
        if not isinstance(timestamps, dict):
            continue
        start = timestamps.get("start")
        end = timestamps.get("end")
        if not isinstance(start, str) and not isinstance(end, str):
            continue
        timestamped += 1
        if isinstance(start, str) and start:
            starts.append(start)
        if isinstance(end, str) and end:
            ends.append(end)
    return {
        "earliestStart": min(starts) if starts else None,
        "latestEnd": max(ends) if ends else None,
        "statesWithTimestamps": timestamped,
        "statesAnalyzed": len(records),
    }


def load_labels(path: Path) -> list[dict[str, Any]]:
    value = load_json(path)
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError(f"{path} must be a schema-v1 label fixture")
    observations = value.get("observations")
    if not isinstance(observations, list):
        raise ValueError(f"{path} is missing observations")
    labels: list[dict[str, Any]] = []
    seen_refs: set[str] = set()
    for index, observation in enumerate(observations):
        if not isinstance(observation, dict):
            raise ValueError(f"{path} observations[{index}] must be an object")
        ref = observation.get("ref")
        expected = observation.get("expectedTriggers")
        if not isinstance(ref, str) or not ref or ref in seen_refs:
            raise ValueError(f"{path} observations[{index}] has an invalid or duplicate ref")
        if not isinstance(expected, list) or not all(
            isinstance(target, str) and target in TARGETS for target in expected
        ):
            raise ValueError(f"{path} observations[{index}] has invalid expectedTriggers")
        if len(set(expected)) != len(expected):
            raise ValueError(f"{path} observations[{index}] repeats an expected trigger")
        seen_refs.add(ref)
        labels.append({"ref": ref, "expectedTriggers": set(expected)})
    return labels


def default_state_dir() -> Path:
    configured = os.environ.get("OPENCLAW_STATE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".openclaw"


def resolve_successful_tool_calls(
    config_path: Path, override: int | None
) -> tuple[int, str]:
    if override is not None:
        return override, "cli-override"
    if not config_path.is_file():
        return DEFAULT_SUCCESSFUL_TOOL_CALLS, "default"
    try:
        value = load_json(config_path)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{config_path} is unreadable: {error.__class__.__name__}") from error
    try:
        configured = value["plugins"]["entries"]["skill-harness"]["config"]["review"][
            "triggers"
        ]["successfulPattern"]["toolCalls"]
    except (KeyError, TypeError):
        return DEFAULT_SUCCESSFUL_TOOL_CALLS, "default"
    if isinstance(configured, bool) or not isinstance(configured, int) or not 1 <= configured <= 100:
        return DEFAULT_SUCCESSFUL_TOOL_CALLS, "default-invalid-config"
    return configured, "openclaw-config"


def stats_summary(path: Path, analyzed_states: int) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = load_json(path)
    except (OSError, json.JSONDecodeError):
        return {"error": "stats.json is unreadable", "sessionStatesAnalyzed": analyzed_states}
    summary = value.get("summary") if isinstance(value, dict) else None
    aggregate_turns = summary.get("turns") if isinstance(summary, dict) else None
    return {
        "schemaVersion": value.get("schemaVersion") if isinstance(value, dict) else None,
        "aggregateTurns": aggregate_turns,
        "sessionStatesAnalyzed": analyzed_states,
        "note": "Session retention may make analyzed states lower than aggregate turns.",
    }


def review_history_summary(log: dict[str, Any]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    ordinary_events = log["processedEvents"]
    historical_keyword_audits = log["historicalKeywordAudits"]
    for event in historical_keyword_audits.values():
        if not isinstance(event, dict):
            continue
        outcome = event.get("outcome")
        if isinstance(outcome, str):
            counts[outcome] += 1
    return {
        "ordinaryEvents": len(ordinary_events),
        "historicalKeywordAudits": len(historical_keyword_audits),
        "historicalKeywordAuditOutcomes": dict(sorted(counts.items())),
        "keywordAttributionAvailable": False,
        "note": (
            "Historical keyword audits do not preserve the matched keyword or keyword-set version; "
            "do not replay them against the current list."
        ),
    }


def keyword_change_summary(log: dict[str, Any]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    additions: Counter[str] = Counter()
    removals: Counter[str] = Counter()
    events = log["processedKeywordEvents"]
    for event in events.values():
        if not isinstance(event, dict):
            continue
        outcome = event.get("outcome")
        if isinstance(outcome, str):
            counts[outcome] += 1
        mutations = event.get("mutations")
        if not isinstance(mutations, list):
            continue
        for mutation in mutations:
            if not isinstance(mutation, dict) or not isinstance(mutation.get("target"), str):
                continue
            target = mutation["target"]
            for keyword in mutation.get("add", []):
                if isinstance(keyword, str):
                    additions[f"{target}:{keyword}"] += 1
            for keyword in mutation.get("remove", []):
                if isinstance(keyword, str):
                    removals[f"{target}:{keyword}"] += 1
    return {
        "events": len(events),
        "outcomes": dict(sorted(counts.items())),
        "keywordAdditions": dict(sorted(additions.items())),
        "keywordRemovals": dict(sorted(removals.items())),
        "coverageEpochs": len(log["coverageEpochs"]),
    }


def labeled_metrics(
    records: list[dict[str, Any]],
    labels: list[dict[str, Any]],
    keyword_root: dict[str, Any],
    targets: tuple[str, ...],
    successful_tool_calls: int,
) -> dict[str, Any]:
    records_by_ref = {record["ref"]: record for record in records}
    counts = {
        target: Counter(
            {
                "truePositive": 0,
                "falsePositive": 0,
                "falseNegative": 0,
                "trueNegative": 0,
                "structurallyBlockedPositive": 0,
            }
        )
        for target in targets
    }
    unknown_refs: list[str] = []
    multi_trigger_predictions = 0
    for label in labels:
        record = records_by_ref.get(label["ref"])
        if record is None:
            unknown_refs.append(label["ref"])
            continue
        state = record["state"]
        predicted: set[str] = set()
        eligibility: dict[str, bool] = {}
        for target in targets:
            eligible = is_eligible(state, target, successful_tool_calls)
            eligibility[target] = eligible
            keywords = keyword_root[KEYWORD_FIELDS[target]]
            if eligible and includes_any(state_text(state, target), keywords):
                predicted.add(target)
        if len(predicted) > 1:
            multi_trigger_predictions += 1
        expected = label["expectedTriggers"]
        for target in targets:
            expected_target = target in expected
            predicted_target = target in predicted
            if expected_target and predicted_target:
                counts[target]["truePositive"] += 1
            elif expected_target:
                counts[target]["falseNegative"] += 1
                if not eligibility[target]:
                    counts[target]["structurallyBlockedPositive"] += 1
            elif predicted_target:
                counts[target]["falsePositive"] += 1
            else:
                counts[target]["trueNegative"] += 1

    target_metrics: dict[str, Any] = {}
    for target, target_counts in counts.items():
        true_positive = target_counts["truePositive"]
        false_positive = target_counts["falsePositive"]
        false_negative = target_counts["falseNegative"]
        precision_denominator = true_positive + false_positive
        recall_denominator = true_positive + false_negative
        target_metrics[target] = {
            **dict(target_counts),
            "precision": (
                round(true_positive / precision_denominator, 4)
                if precision_denominator
                else None
            ),
            "recall": (
                round(true_positive / recall_denominator, 4) if recall_denominator else None
            ),
        }
    return {
        "labeledObservations": len(labels),
        "evaluatedObservations": len(labels) - len(unknown_refs),
        "unknownRefs": sorted(unknown_refs),
        "multiTriggerPredictions": multi_trigger_predictions,
        "targets": target_metrics,
    }


def analyze_target(
    records: list[dict[str, Any]],
    target: str,
    keywords: list[str],
    successful_tool_calls: int,
    min_docs: int,
    top: int,
    include_snippets: bool,
) -> dict[str, Any]:
    eligible: list[dict[str, Any]] = []
    other_target_texts: dict[str, set[str]] = defaultdict(set)
    for record in records:
        state = record["state"]
        for other in TARGETS:
            if other != target and is_eligible(state, other, successful_tool_calls):
                other_target_texts[record["ref"]].add(other)
        if is_eligible(state, target, successful_tool_calls):
            text = state_text(state, target)
            eligible.append({**record, "text": text, "matched": includes_any(text, keywords)})

    existing_stats = []
    for keyword in keywords:
        refs = [record["ref"] for record in eligible if includes_any(record["text"], [keyword])]
        existing_stats.append({"keyword": keyword, "eligibleDocs": len(refs), "refs": refs[:10]})

    phrase_refs: dict[str, set[str]] = defaultdict(set)
    phrase_matched_refs: dict[str, set[str]] = defaultdict(set)
    phrase_other_targets: dict[str, set[str]] = defaultdict(set)
    phrase_snippets: dict[str, list[str]] = defaultdict(list)
    existing_normalized = {normalize(keyword) for keyword in keywords}
    for record in eligible:
        for phrase in phrase_candidates(record["text"]):
            if phrase in existing_normalized:
                continue
            phrase_refs[phrase].add(record["ref"])
            if record["matched"]:
                phrase_matched_refs[phrase].add(record["ref"])
            for other in other_target_texts.get(record["ref"], set()):
                phrase_other_targets[phrase].add(other)
            if include_snippets and len(phrase_snippets[phrase]) < 3:
                snippet = " ".join(record["text"].split())[:240]
                phrase_snippets[phrase].append(snippet)

    candidates = []
    for phrase, refs in phrase_refs.items():
        unmatched_refs = refs - phrase_matched_refs[phrase]
        if len(unmatched_refs) < min_docs:
            continue
        item: dict[str, Any] = {
            "phrase": phrase,
            "unmatchedEligibleDocs": len(unmatched_refs),
            "allEligibleDocs": len(refs),
            "alreadyMatchedDocs": len(phrase_matched_refs[phrase]),
            "otherEligibleTargets": sorted(phrase_other_targets[phrase]),
            "refs": sorted(unmatched_refs)[:10],
        }
        if include_snippets:
            item["snippets"] = phrase_snippets[phrase]
        candidates.append(item)
    candidates.sort(
        key=lambda item: (
            -item["unmatchedEligibleDocs"],
            len(item["otherEligibleTargets"]),
            -len(item["phrase"]),
            item["phrase"],
        )
    )
    matched_count = sum(1 for record in eligible if record["matched"])
    return {
        "existingKeywords": existing_stats,
        "measurement": (
            "Structural eligibility plus current-keyword substring matching only; "
            "these counts are not semantic TP/FP/FN without --labels."
        ),
        "summary": {
            "eligibleDocs": len(eligible),
            "matchedDocs": matched_count,
            "unmatchedDocs": len(eligible) - matched_count,
            "matchRate": round(matched_count / len(eligible), 4) if eligible else None,
        },
        "candidatePhrases": candidates[:top],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a read-only evidence report for Skill Harness Review trigger keywords."
    )
    parser.add_argument(
        "--data-root",
        type=Path,
        default=default_state_dir() / "plugins/skill-harness",
        help="Skill Harness runtime data root",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="OpenClaw config path; defaults to OPENCLAW_CONFIG_PATH or <state-dir>/openclaw.json",
    )
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument(
        "--output", type=Path, help="Atomically write a mode-0600 JSON report"
    )
    destination.add_argument(
        "--stdout",
        action="store_true",
        help="Explicitly print the report; private candidate phrases may be exposed",
    )
    parser.add_argument(
        "--target", choices=("all", *TARGETS), default="all", help="Trigger target to audit"
    )
    parser.add_argument("--min-docs", type=int, default=2, help="Minimum unmatched eligible documents")
    parser.add_argument("--top", type=int, default=50, help="Maximum candidate phrases per target")
    parser.add_argument(
        "--successful-tool-calls",
        type=int,
        default=None,
        help="Override successful-pattern tool-call threshold instead of reading OpenClaw config",
    )
    parser.add_argument(
        "--include-snippets",
        action="store_true",
        help="Include private text snippets in the local report; off by default",
    )
    parser.add_argument(
        "--labels",
        type=Path,
        help="Optional schema-v1 ref/expectedTriggers fixture for semantic TP/FP/FN metrics",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.min_docs < 1 or args.top < 1:
        raise SystemExit("--min-docs and --top must be positive")
    if args.successful_tool_calls is not None and not 1 <= args.successful_tool_calls <= 100:
        raise SystemExit("--successful-tool-calls must be between 1 and 100")
    if args.include_snippets and args.stdout:
        raise SystemExit("--include-snippets requires --output; refusing private snippets on stdout")
    review_path = args.data_root / "review.json"
    keyword_coverage_path = args.data_root / "keyword-coverage.json"
    sessions_dir = args.data_root / "sessions"
    if not review_path.is_file():
        raise SystemExit(f"missing current review log: {review_path}")
    if not keyword_coverage_path.is_file():
        raise SystemExit(f"missing current keyword coverage log: {keyword_coverage_path}")
    if not sessions_dir.is_dir():
        raise SystemExit(f"missing session directory: {sessions_dir}")

    inferred_state_dir = args.data_root.parent.parent
    config_path = args.config or Path(
        os.environ.get("OPENCLAW_CONFIG_PATH", inferred_state_dir / "openclaw.json")
    ).expanduser()
    successful_tool_calls, threshold_source = resolve_successful_tool_calls(
        config_path, args.successful_tool_calls
    )
    review_sha256 = sha256_file(review_path)
    keyword_coverage_sha256 = sha256_file(keyword_coverage_path)
    review_log = load_review_log(review_path)
    keyword_coverage_log = load_keyword_coverage_log(keyword_coverage_path)
    if sha256_file(review_path) != review_sha256:
        raise SystemExit(f"review log changed while being read: {review_path}")
    if sha256_file(keyword_coverage_path) != keyword_coverage_sha256:
        raise SystemExit(
            f"keyword coverage log changed while being read: {keyword_coverage_path}"
        )
    records, session_errors = load_states(sessions_dir)
    targets = TARGETS if args.target == "all" else (args.target,)
    labels = load_labels(args.labels) if args.labels else None
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "reportOnly": True,
        "dataRoot": str(args.data_root),
        "provenance": {
            "reviewSha256": review_sha256,
            "keywordCoverageSha256": keyword_coverage_sha256,
            "scriptSha256": sha256_file(SCRIPT_PATH),
            "sourceCommit": source_commit(),
        },
        "analysisWindow": analysis_window(records),
        "privacy": {
            "snippetsIncluded": args.include_snippets,
            "warning": "Keep reports local; session content may be private.",
        },
        "configuration": {
            "configPath": str(config_path),
            "successfulToolCalls": successful_tool_calls,
            "thresholdSource": threshold_source,
        },
        "inputs": {
            "reviewLog": str(review_path),
            "keywordCoverageLog": str(keyword_coverage_path),
            "sessionsDirectory": str(sessions_dir),
            "labels": str(args.labels) if args.labels else None,
            "sessionErrors": session_errors,
        },
        "runtimeStats": stats_summary(args.data_root / "stats.json", len(records)),
        "reviewHistory": review_history_summary(review_log),
        "keywordHistory": keyword_change_summary(keyword_coverage_log),
        "targets": {},
    }
    keyword_root = keyword_coverage_log["triggerKeywords"]
    for target in targets:
        report["targets"][target] = analyze_target(
            records,
            target,
            keyword_root[KEYWORD_FIELDS[target]],
            successful_tool_calls,
            args.min_docs,
            args.top,
            args.include_snippets,
        )
    report["labeledMetrics"] = (
        labeled_metrics(
            records,
            labels,
            keyword_root,
            targets,
            successful_tool_calls,
        )
        if labels is not None
        else None
    )

    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.stdout:
        sys.stdout.write(rendered)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=args.output.parent,
            prefix=f".{args.output.name}.",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, args.output)
        args.output.chmod(0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
