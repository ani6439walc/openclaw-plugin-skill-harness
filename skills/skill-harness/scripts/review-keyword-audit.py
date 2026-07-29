#!/usr/bin/env python3
"""Audit Skill Harness Review trigger-keyword coverage from runtime state.

This script is intentionally report-only. It never modifies review.json, session
snapshots, stats.json, or intent Markdown.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

TARGETS = ("successful-pattern", "behavior-fix", "entity-context")
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


def load_review_log(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if not isinstance(value, dict) or value.get("schemaVersion") != 5:
        raise ValueError(f"{path} must be a current schema-v5 review log")
    keywords = value.get("triggerKeywords")
    if not isinstance(keywords, dict):
        raise ValueError(f"{path} is missing triggerKeywords")
    for field in KEYWORD_FIELDS.values():
        if not isinstance(keywords.get(field), list) or not all(
            isinstance(item, str) for item in keywords[field]
        ):
            raise ValueError(f"{path} has an invalid triggerKeywords.{field}")
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
        ordered_states = value.get("history") if isinstance(value.get("history"), list) else []
        ordered_states = [*ordered_states, value.get("current")]
        turn = 0
        for state in ordered_states:
            if not isinstance(state, dict):
                continue
            turn += 1
            states.append(
                {
                    "ref": f"{path.name}#{turn}",
                    "state": state,
                }
            )
    return states, errors


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


def review_change_summary(log: dict[str, Any]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    additions: Counter[str] = Counter()
    removals: Counter[str] = Counter()
    events = log.get("processedEvents")
    if not isinstance(events, dict):
        return {"events": 0, "outcomes": {}, "keywordAdditions": {}, "keywordRemovals": {}}
    for event in events.values():
        if not isinstance(event, dict):
            continue
        outcome = event.get("outcome")
        if isinstance(outcome, str):
            counts[outcome] += 1
        changes = event.get("changes")
        if not isinstance(changes, list):
            continue
        for change in changes:
            if not isinstance(change, dict) or change.get("targetKind") != "trigger-keywords":
                continue
            target = change.get("targetTrigger")
            keyword_change = change.get("keywordChange")
            if not isinstance(target, str) or not isinstance(keyword_change, dict):
                continue
            for keyword in keyword_change.get("add", []):
                if isinstance(keyword, str):
                    additions[f"{target}:{keyword}"] += 1
            for keyword in keyword_change.get("remove", []):
                if isinstance(keyword, str):
                    removals[f"{target}:{keyword}"] += 1
    return {
        "events": len(events),
        "outcomes": dict(sorted(counts.items())),
        "keywordAdditions": dict(sorted(additions.items())),
        "keywordRemovals": dict(sorted(removals.items())),
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
        default=Path.home() / ".openclaw/plugins/skill-harness",
        help="Skill Harness runtime data root",
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
        default=5,
        help="Configured successful-pattern tool-call threshold",
    )
    parser.add_argument(
        "--include-snippets",
        action="store_true",
        help="Include private text snippets in the local report; off by default",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.min_docs < 1 or args.top < 1 or args.successful_tool_calls < 1:
        raise SystemExit("--min-docs, --top, and --successful-tool-calls must be positive")
    if args.include_snippets and args.stdout:
        raise SystemExit("--include-snippets requires --output; refusing private snippets on stdout")
    review_path = args.data_root / "review.json"
    sessions_dir = args.data_root / "sessions"
    if not review_path.is_file():
        raise SystemExit(f"missing current keyword source: {review_path}")
    if not sessions_dir.is_dir():
        raise SystemExit(f"missing session directory: {sessions_dir}")

    review_log = load_review_log(review_path)
    records, session_errors = load_states(sessions_dir)
    targets = TARGETS if args.target == "all" else (args.target,)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "reportOnly": True,
        "dataRoot": str(args.data_root),
        "privacy": {
            "snippetsIncluded": args.include_snippets,
            "warning": "Keep reports local; session content may be private.",
        },
        "inputs": {
            "reviewLog": str(review_path),
            "sessionsDirectory": str(sessions_dir),
            "sessionErrors": session_errors,
        },
        "runtimeStats": stats_summary(args.data_root / "stats.json", len(records)),
        "reviewHistory": review_change_summary(review_log),
        "targets": {},
    }
    keyword_root = review_log["triggerKeywords"]
    for target in targets:
        report["targets"][target] = analyze_target(
            records,
            target,
            keyword_root[KEYWORD_FIELDS[target]],
            args.successful_tool_calls,
            args.min_docs,
            args.top,
            args.include_snippets,
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
