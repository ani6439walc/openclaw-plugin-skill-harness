#!/usr/bin/env python3
"""Self-contained regression tests for runtime-health-audit.py."""

from __future__ import annotations

import json
import importlib.util
import shutil
import sys
from datetime import datetime, timezone
from unittest.mock import patch
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("runtime-health-audit.py")
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("runtime_health_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class RuntimeHealthAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "sessions").mkdir()
        (self.root / "agents" / "review" / "sessions").mkdir(parents=True)
        (self.root / "intents").mkdir()
        (self.root / "intents" / "example.md").write_text(
            "---\n"
            "triggers:\n"
            "  - The test request matches the example intent.\n"
            "examples:\n"
            "  - Use the example intent.\n"
            "keywords:\n"
            "  - example\n"
            "---\n"
            "Route the example request.\n",
            encoding="utf-8",
        )
        qmd_root = self.root / "qmd"
        (qmd_root / "intents" / "keywords").mkdir(parents=True)
        (qmd_root / "intents" / "examples").mkdir()
        (qmd_root / "intents" / "keywords" / "example.md").write_text(
            "# keyword\n", encoding="utf-8"
        )
        (qmd_root / "intents" / "examples" / "example.md").write_text(
            "# example\n", encoding="utf-8"
        )
        qmd_database = sqlite3.connect(qmd_root / "intents" / "intent-routing.sqlite")
        qmd_database.executescript(
            """
            CREATE TABLE embedding_index_state (
              singleton INTEGER PRIMARY KEY,
              status TEXT NOT NULL,
              generation INTEGER NOT NULL,
              lease_expires_at INTEGER,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE documents (active INTEGER NOT NULL);
            CREATE TABLE content_vectors (id INTEGER PRIMARY KEY);
            INSERT INTO embedding_index_state VALUES (1, 'ready', 2, NULL, 1234567890);
            INSERT INTO documents VALUES (1), (1);
            INSERT INTO content_vectors VALUES (1), (2);
            """
        )
        qmd_database.close()
        (self.root / "experiences" / "example").mkdir(parents=True)
        (self.root / "experiences" / "example" / "summary.md").write_text("Example summary\n", encoding="utf-8")
        (self.root / "experiences" / "example" / "keywords.md").write_text("example\n", encoding="utf-8")
        (self.root / "experiences" / "example" / "body.md").write_text("Example body\n", encoding="utf-8")
        (self.root / "experiences" / "example" / "skills.md").write_text("example-skill\n", encoding="utf-8")
        (self.root / "review.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 8,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                    "updatedAt": "2026-08-01T00:00:00.000Z",
                    "processedEvents": {
                        "event-1": {
                            "processedAt": "2026-08-01T00:00:00.000Z",
                            "triggers": ["capability-fit"],
                            "changeCount": 1,
                            "outcome": "applied",
                            "changes": [
                                {
                                    "trigger": "capability-fit",
                                    "targetKind": "skill-experience",
                                    "operation": "refine",
                                    "targetExperienceIds": ["example"],
                                    "targetIntentIds": ["example"],
                                }
                            ],
                        },
                        "event-2": {
                            "processedAt": "2026-08-01T00:01:00.000Z",
                            "triggers": ["routing-uncertainty"],
                            "changeCount": 0,
                            "outcome": "nofinding",
                            "noFindingReasonCounts": {"already-covered": 1},
                        },
                    },
                    "reviewedSkillEpochs": {},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "stats.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 7,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                    "updatedAt": "2026-08-01T00:02:00.000Z",
                    "attribution": {"startedAt": "2026-08-01T00:00:00.000Z"},
                    "summary": {
                        "turns": 2,
                        "completedTurns": 1,
                        "erroredTurns": 1,
                        "skillAssistedTurns": 1,
                        "toolAssistedTurns": 1,
                        "skillUsageCount": 1,
                        "toolCallCount": 2,
                        "averageConfidence": 0.75,
                        "unknownTurns": 0,
                        "unknownRate": 0,
                    },
                    "intents": {
                        "example": {
                            "turns": 2,
                            "share": 1,
                            "lastSeenAt": "2026-08-01T00:02:00.000Z",
                            "last7Days": 2,
                            "averageConfidence": 0.75,
                            "lowConfidenceTurns": 1,
                            "skillAssistedTurns": 1,
                            "toolAssistedTurns": 1,
                            "erroredTurns": 1,
                            "routeReasons": {
                                reason: {
                                    "count": 0,
                                    "averageScore": 0,
                                    "minScore": 1,
                                    "maxScore": 0,
                                }
                                for reason in (
                                    "qmd-keyword",
                                    "qmd-hybrid",
                                    "llm-classifier",
                                )
                            },
                        }
                    },
                    "skills": {
                        "example-skill": {
                            "usageTurns": 1,
                            "intentMatchedTurns": 2,
                            "adoptedTurns": 1,
                            "adoptionRate": 0.5,
                            "lastUsedAt": "2026-08-01T00:02:00.000Z",
                            "last7DaysUsage": 1,
                            "lifecycle": "active",
                            "needsReview": True,
                        }
                    },
                    "routing": {
                        "intentMatchedTurns": 2,
                        "adoptedTurns": 1,
                        "turnAdoptionRate": 0.5,
                        "intentMatchedSkillOpportunities": 2,
                        "adoptedSkillOpportunities": 1,
                        "skillAdoptionRate": 0.5,
                        "byIntent": {},
                    },
                    "tools": {
                        "exec": {
                            "calls": 2,
                            "turns": 1,
                            "errorCalls": 1,
                            "averageDurationMs": 200,
                            "lastUsedAt": "2026-08-01T00:02:00.000Z",
                            "last7DaysCalls": 2,
                            "latencyHistogram": {
                                "unknown": 0,
                                "0-99": 0,
                                "100-499": 2,
                                "500-999": 0,
                                "1000-4999": 0,
                                "5000+": 0,
                            },
                        }
                    },
                    "skillDiscovery": {
                        "turns": 2,
                        "nameMatch": {"matchedTurns": 1, "candidates": 1, "injectedSkills": 1},
                        "qmdSearch": {
                            "attemptedTurns": 2,
                            "matchedTurns": 1,
                            "candidates": 2,
                            "semanticScore": {"count": 2, "average": 0.8, "min": 0.7, "max": 0.9},
                            "injectedSkills": 1,
                        },
                        "pool": {"nonEmptyTurns": 1, "candidates": 2, "injectedTurns": 1, "injectedSkills": 2},
                        "fallbackReasons": {"empty-pool": 1},
                        "durationMs": {"count": 2, "average": 10, "min": 8, "max": 12},
                    },
                    "projection": {
                        "eligibleTurns": 1,
                        "projectedTurns": 1,
                        "fullFallbackTurns": 0,
                        "projectedRate": 1,
                        "fullFallbackRate": 0,
                        "averageOriginalIntentCount": 5,
                        "averageCandidateIntentCount": 2,
                        "catalogMeasurementTurns": 1,
                        "averageOriginalCatalogCodePoints": 1000,
                        "averageCandidateCatalogCodePoints": 400,
                        "averageDurationMs": 3,
                        "fallbackReasons": {},
                    },
                    "daily": {
                        "2026-08-01": {
                            "turns": 2,
                            "erroredTurns": 1,
                            "intents": {"example": 2},
                            "skills": {"example-skill": 1},
                            "tools": {"exec": 2},
                            "routing": {
                                "intentMatchedTurns": 2,
                                "adoptedTurns": 1,
                                "intentMatchedSkillOpportunities": 2,
                                "adoptedSkillOpportunities": 1,
                            },
                            "projection": {
                                "eligibleTurns": 1,
                                "projectedTurns": 1,
                                "fullFallbackTurns": 0,
                                "fallbackReasons": {},
                            },
                            "intentOutcomes": {"value:example": {"turns": 2}},
                            "intentRouting": {
                                "value:example": {"intentMatchedTurns": 2}
                            },
                            "skillRouting": {
                                "value:example-skill": {"intentMatchedTurns": 2}
                            },
                            "toolErrors": {"value:exec": 1},
                        }
                    },
                    "skillInventory": {
                        "startedAt": "2026-08-01T00:00:00.000Z",
                        "agents": {},
                    },
                    "processedEvents": {"event": "2026-08-01T00:02:00.000Z"},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "sessions" / "session.json").write_text(
            json.dumps(
                {
                    "sessionId": "session",
                    "current": {"timestamps": {"end": "2026-08-01T00:02:00.000Z"}},
                    "history": [],
                }
            ),
            encoding="utf-8",
        )
        (self.root / "agents" / "review" / "sessions" / "agent.session.jsonl").write_text(
            "{}\n", encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_audit(self) -> dict:
        output = self.root / "report.json"
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--data-root",
                str(self.root),
                "--output",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout, "")
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        return json.loads(output.read_text(encoding="utf-8"))

    def test_reports_health_without_private_runtime_text(self) -> None:
        report = self.run_audit()
        self.assertTrue(report["reportOnly"])
        self.assertEqual(
            report["privacy"],
            {
                "sessionTextIncluded": False,
                "reviewSuggestionTextIncluded": False,
                "reviewEvidenceIncluded": False,
                "toolParamsOrResultsIncluded": False,
            },
        )
        review = report["runtime"]["review"]
        self.assertEqual(review["processedEvents"]["eventCount"], 2)
        self.assertEqual(review["processedEvents"]["outcomes"], {"applied": 1, "nofinding": 1})
        self.assertEqual(
            review["processedEvents"]["changes"],
            {
                "appliedEvents": 1,
                "total": 1,
                "averagePerAppliedEvent": 1.0,
                "eventsByChangeCount": {"0": 1, "1": 1},
                "byTrigger": {"capability-fit": 1},
                "byOperation": {"refine": 1},
                "topTargetExperiences": [{"experience": "example", "changes": 1}],
                "topTargetIntents": [{"intent": "example", "changes": 1}],
            },
        )
        self.assertEqual(report["runtime"]["sessions"]["sessionFiles"], 1)
        self.assertEqual(report["runtime"]["sessions"]["agentArtifactFiles"], 1)
        self.assertEqual(report["runtime"]["experiences"]["count"], 1)
        self.assertEqual(report["runtime"]["experiences"]["markdownFiles"], 4)
        self.assertEqual(report["runtime"]["intents"]["markdownFiles"], 1)
        self.assertEqual(
            {key: value for key, value in report["runtime"]["qmd"].items() if key != "skills"},
            {
                "databaseStatus": "ready",
                "integrityCheck": "ok",
                "generation": 2,
                "leaseActive": False,
                "snapshotMarkdownFiles": 2,
                "indexedDocuments": 2,
                "indexedVectors": 2,
                "documentsMatchVectors": True,
                "snapshotMatchesIndexedDocuments": True,
            },
        )
        self.assertEqual(set(report["provenance"]["stateSha256"]), {"review.json", "stats.json"})
        stats = report["runtime"]["stats"]
        self.assertEqual(stats["attribution"]["status"], "fresh-v7-window")
        self.assertNotIn("routingEffectiveness", stats)
        self.assertNotIn("projectionEfficiency", stats)
        self.assertEqual(stats["routing"]["turnAdoptionRate"], 0.5)
        self.assertEqual(stats["routing"]["skillAdoptionRate"], 0.5)
        self.assertEqual(stats["projection"]["projectedRate"], 1)
        self.assertEqual(stats["intentPortfolio"]["trackedIntents"], 1)
        self.assertEqual(stats["intentPortfolio"]["erroredTurns"], 1)
        self.assertEqual(
            stats["intentPortfolio"]["routeReasonAttribution"]["status"],
            "available",
        )
        self.assertEqual(stats["skillInventory"]["status"], "available")
        self.assertEqual(stats["skillLifecycle"]["needsReviewCount"], 1)
        self.assertEqual(stats["skillLifecycle"]["lowAdoptionCohort"], [{"skill": "example-skill", "intentMatchedTurns": 2, "adoptedTurns": 1, "adoptionRate": 0.5, "lifecycle": "active"}])
        self.assertEqual(stats["toolReliability"]["errorCalls"], 1)
        self.assertEqual(stats["toolReliability"]["errorRate"], 0.5)
        self.assertEqual(stats["toolReliability"]["latencyHistogram"]["status"], "fresh-v7-window")
        self.assertEqual(stats["dataHealth"]["dailyBucketCount"], 1)
        self.assertEqual(stats["dataHealth"]["statsUpdatedAt"], "2026-08-01T00:02:00.000Z")
        self.assertEqual(stats["dataHealth"]["retainedProcessedEventCount"], 1)

    def test_reports_unavailable_qmd_without_failing_the_audit(self) -> None:
        (self.root / "qmd" / "intents" / "intent-routing.sqlite").unlink()

        report = self.run_audit()

        self.assertEqual(
            {key: value for key, value in report["runtime"]["qmd"].items() if key != "skills"},
            {
                "databaseStatus": "unavailable",
                "integrityCheck": None,
                "generation": None,
                "leaseActive": None,
                "snapshotMarkdownFiles": 2,
                "indexedDocuments": None,
                "indexedVectors": None,
                "documentsMatchVectors": None,
                "snapshotMatchesIndexedDocuments": None,
            },
        )

    def test_reports_v6_route_scores_and_attribution_boundary(self) -> None:
        stats_path = self.root / "stats.json"
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
        stats["schemaVersion"] = 7
        stats["attribution"] = {"startedAt": "2026-08-01T00:02:00.000Z"}
        stats["intents"]["example"]["routeReasons"] = {
            "qmd-keyword": {
                "count": 2,
                "averageScore": 0.8,
                "minScore": 0.7,
                "maxScore": 0.9,
            },
            "qmd-hybrid": {
                "count": 1,
                "averageScore": 0.85,
                "minScore": 0.85,
                "maxScore": 0.85,
            },
            "llm-classifier": {
                "count": 1,
                "averageScore": 0.6,
                "minScore": 0.6,
                "maxScore": 0.6,
            },
        }
        stats["skillInventory"] = {
            "startedAt": "2026-08-01T00:02:00.000Z",
            "agents": {
                "main": {
                    "observedTurns": 3,
                    "skills": {"one": {}, "two": {}},
                }
            },
        }
        stats["tools"]["exec"]["latencyHistogram"] = {
            "unknown": 0,
            "0-99": 0,
            "100-499": 2,
            "500-999": 0,
            "1000-4999": 0,
            "5000+": 0,
        }
        stats["daily"]["2026-08-01"].update(
            {
                "intentOutcomes": {"value:example": {"turns": 2}},
                "intentRouting": {"value:example": {"intentMatchedTurns": 2}},
                "skillRouting": {"value:example-skill": {"intentMatchedTurns": 2}},
                "toolErrors": {"value:exec": 1, "__other__": 2},
            }
        )
        stats_path.write_text(json.dumps(stats), encoding="utf-8")

        report = self.run_audit()
        runtime_stats = report["runtime"]["stats"]
        self.assertEqual(runtime_stats["attribution"]["status"], "fresh-v7-window")
        self.assertEqual(runtime_stats["attribution"]["startedAt"], "2026-08-01T00:02:00.000Z")
        self.assertEqual(runtime_stats["attribution"]["dailyBucketsBeforeAttribution"], 0)
        self.assertEqual(
            runtime_stats["intentPortfolio"]["routeReasonAttribution"],
            {
                "status": "available",
                "scoreMeaning": "selected route confidence; QMD routes use hit score",
                "byIntent": {
                    "example": {
                        "totalRoutes": 4,
                        "averageScore": 0.7625,
                        "minScore": 0.6,
                        "maxScore": 0.9,
                        "byReason": {
                            "qmd-keyword": {
                                "count": 2,
                                "averageScore": 0.8,
                                "minScore": 0.7,
                                "maxScore": 0.9,
                            },
                            "qmd-hybrid": {
                                "count": 1,
                                "averageScore": 0.85,
                                "minScore": 0.85,
                                "maxScore": 0.85,
                            },
                            "llm-classifier": {
                                "count": 1,
                                "averageScore": 0.6,
                                "minScore": 0.6,
                                "maxScore": 0.6,
                            },
                        },
                    }
                },
            },
        )
        self.assertEqual(
            runtime_stats["skillInventory"],
            {
                "status": "available",
                "startedAt": "2026-08-01T00:02:00.000Z",
                "agentCount": 1,
                "observedTurns": 3,
                "trackedSkillRecords": 2,
                "maxTrackedSkillRecordsPerAgent": 2,
            },
        )
        self.assertEqual(runtime_stats["toolReliability"]["latencyHistogram"], {
            "status": "fresh-v7-window",
            "toolCount": 1,
            "buckets": {
                "unknown": 0,
                "0-99": 0,
                "100-499": 2,
                "500-999": 0,
                "1000-4999": 0,
                "5000+": 0,
            },
        })
        self.assertNotIn("dailyDynamicKeyCardinality", runtime_stats["dataHealth"])

    def test_rejects_non_current_review_log(self) -> None:
        (self.root / "review.json").write_text(json.dumps({"schemaVersion": 5}), encoding="utf-8")
        result = subprocess.run(
            ["python3", str(SCRIPT), "--data-root", str(self.root), "--stdout"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("schema-v8", result.stderr)

    def test_rejects_non_current_stats_log(self) -> None:
        stats_path = self.root / "stats.json"
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
        stats["schemaVersion"] = 5
        stats_path.write_text(json.dumps(stats), encoding="utf-8")

        result = subprocess.run(
            ["python3", str(SCRIPT), "--data-root", str(self.root), "--stdout"],
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("schema-v7", result.stderr)


    def test_reports_pure_experience_health(self) -> None:
        import shutil
        shutil.rmtree(self.root / "intents")
        shutil.rmtree(self.root / "qmd" / "intents")
        (self.root / "qmd" / "experiences").mkdir(parents=True)
        (self.root / "qmd" / "experiences" / "doc1.md").write_text("# Doc 1\n", encoding="utf-8")
        qmd_database = sqlite3.connect(self.root / "qmd" / "experiences" / "experience-routing.sqlite")
        qmd_database.executescript(
            """
            CREATE TABLE embedding_index_state (
              singleton INTEGER PRIMARY KEY,
              status TEXT NOT NULL,
              generation INTEGER NOT NULL,
              lease_expires_at INTEGER,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE documents (active INTEGER NOT NULL);
            CREATE TABLE content_vectors (id INTEGER PRIMARY KEY);
            INSERT INTO embedding_index_state VALUES (1, 'ready', 1, NULL, 1234567890);
            INSERT INTO documents VALUES (1);
            INSERT INTO content_vectors VALUES (1);
            """
        )
        qmd_database.close()

        report = self.run_audit()
        self.assertEqual(report["runtime"]["intents"]["markdownFiles"], 0)
        self.assertEqual(report["runtime"]["experiences"]["count"], 1)
        self.assertEqual(report["runtime"]["experiences"]["markdownFiles"], 4)
        self.assertEqual(
            {key: value for key, value in report["runtime"]["qmd"].items() if key != "skills"},
            {
                "databaseStatus": "ready",
                "integrityCheck": "ok",
                "generation": 1,
                "leaseActive": False,
                "snapshotMarkdownFiles": 1,
                "indexedDocuments": 1,
                "indexedVectors": 1,
                "documentsMatchVectors": True,
                "snapshotMatchesIndexedDocuments": True,
            },
        )


    def report_at(self, days: int = 7) -> dict:
        return audit.build_report(self.root, days, datetime(2026, 8, 8, 12, tzinfo=timezone.utc))

    def write_session(self, current: dict, history: list | None = None) -> None:
        (self.root / "sessions" / "session.json").write_text(json.dumps({
            "sessionId": "session", "current": current, "history": history or []}), encoding="utf-8")

    def turn(self, key: str = "turn", date: str = "2026-08-01", skills: list | None = None,
             experiences: list | None = None, used: list | None = None) -> dict:
        return {"turnKey": key, "timestamps": {"start": date + "T00:01:00Z", "end": date + "T00:02:00Z"},
                "matchedSkills": skills or [], "matchedExperiences": experiences or [],
                "skillsUsed": [{"name": name, "path": "/private"} for name in (used or [])],
                "confidence": 0.8, "input": "SECRET_TRANSCRIPT", "result": "SECRET_RESULT",
                "toolCalls": [{"params": {"secret": "SECRET_PAYLOAD"}}],
                "inputSkillDiscovery": {"candidateCount": 1, "durationMs": 12,
                    "experienceRetrieval": {"status": "completed", "candidateCount": 1,
                                            "minCandidateScore": 0.4, "hits": [{"id": "private-id", "semanticScore": 0.7}]}}}

    def test_windows_missing_metrics_and_no_false_accuracy(self) -> None:
        report = self.report_at()
        recent = report["analysis"]["windows"]["recent"]
        self.assertEqual(recent["start"], "2026-08-01T00:00:00+00:00")
        self.assertEqual(recent["endExclusive"], "2026-08-08T00:00:00+00:00")
        self.assertEqual(recent["daily"]["status"], "partial")
        self.assertEqual(recent["daily"]["discoveryBuckets"], 0)
        self.assertIsNone(recent["daily"]["skillDiscovery"]["nameMatch"]["hitTurns"]["rate"])
        self.assertEqual(recent["review"]["eventCount"], 2)
        self.assertEqual(recent["review"]["outcomeRates"]["applied"]["rate"], 0.5)
        self.assertEqual(recent["review"]["queueState"], "unobserved")
        previous = report["analysis"]["windows"]["previous"]
        self.assertIsNone(previous["review"]["outcomeRates"]["applied"]["rate"])
        cumulative = report["analysis"]["cumulative"]
        self.assertTrue(cumulative["skills"]["topUnadopted"][0]["lowSample"])
        self.assertNotIn("conversionRate", cumulative["skillDiscovery"]["qmdSearch"])

    def test_session_dedup_experience_only_and_privacy(self) -> None:
        old = self.turn(skills=["DISCARDED_SKILL"], used=["DISCARDED_SKILL"])
        current = self.turn(experiences=["private-id"], used=["manual"])
        self.write_session(current, [old])
        report = self.report_at()
        sessions = report["analysis"]["windows"]["recent"]["sessions"]
        self.assertEqual(sessions["routedTurns"], 1)
        self.assertEqual(sessions["selection"]["nonEmptyWithoutInjection"]["rate"], 0)
        self.assertEqual(sessions["experienceRetrieval"]["selectedFromNonEmpty"]["rate"], 1)
        self.assertEqual(sessions["skills"]["topUsedWithoutInjection"][0]["skill"], "manual")
        self.assertEqual(report["analysis"]["sessionDataQuality"]["duplicateTurns"], 1)
        for private in ("SECRET_TRANSCRIPT", "SECRET_RESULT", "SECRET_PAYLOAD", "/private", "private-id", "DISCARDED_SKILL"):
            self.assertNotIn(private, json.dumps(report["analysis"]))

    def test_completed_history_precedes_incomplete_current(self) -> None:
        complete = self.turn(skills=["verified"], used=["verified"])
        pending = self.turn(skills=["pending"])
        del pending["timestamps"]["end"]
        self.write_session(pending, [complete])
        sessions = self.report_at()["analysis"]["windows"]["recent"]["sessions"]
        self.assertEqual(sessions["skills"]["topUsed"][0]["skill"], "verified")
        self.assertEqual(sessions["completeUsageTurns"], 1)

    def test_empty_pool_unknown_pool_and_invalid_turns(self) -> None:
        empty = self.turn("empty")
        empty["inputSkillDiscovery"]["candidateCount"] = 0
        empty["inputSkillDiscovery"]["experienceRetrieval"]["candidateCount"] = 0
        unselected = self.turn("unselected")
        unknown = self.turn("unknown")
        del unknown["inputSkillDiscovery"]["candidateCount"]
        invalid = self.turn("invalid")
        invalid["timestamps"] = {"start": "invalid"}
        unidentified = {"matchedSkills": [], "matchedExperiences": []}
        self.write_session(empty, [unselected, unknown, invalid, unidentified])
        report = self.report_at()
        sessions = report["analysis"]["windows"]["recent"]["sessions"]
        self.assertEqual(sessions["selection"]["emptyPoolTurns"], 1)
        self.assertEqual(sessions["selection"]["nonEmptyWithoutInjection"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertEqual(report["analysis"]["sessionDataQuality"]["invalidTimestamps"], 1)
        self.assertEqual(report["analysis"]["sessionDataQuality"]["unidentifiedTurns"], 1)

    def test_experience_statuses_and_missing_scores(self) -> None:
        rows = []
        for status in ("completed", "disabled", "unavailable", "timeout", "error"):
            row = self.turn(status)
            row["inputSkillDiscovery"]["experienceRetrieval"] = {"status": status}
            rows.append(row)
        self.write_session(rows[0], rows[1:])
        result = self.report_at()["analysis"]["windows"]["recent"]["sessions"]["experienceRetrieval"]
        self.assertEqual(result["statuses"], {status: 1 for status in ("completed", "disabled", "unavailable", "timeout", "error")})
        self.assertIsNone(result["candidateCount"])
        self.assertIsNone(result["hitCount"])
        self.assertIsNone(result["hitTurns"]["rate"])

    def test_daily_comparison_excludes_today_and_uses_weighted_scores(self) -> None:
        stats_path = self.root / "stats.json"
        stats = json.loads(stats_path.read_text())
        stats["attribution"]["startedAt"] = "2026-07-31T00:00:00Z"
        base = stats["daily"]["2026-08-01"]
        base["skillDiscovery"] = stats["skillDiscovery"]
        base["skillRouting"] = {"value:example-skill": {"intentMatchedTurns": 2, "adoptedTurns": 1}}
        import copy
        stats["daily"]["2026-08-02"] = copy.deepcopy(base)
        stats["daily"]["2026-08-02"]["skillDiscovery"]["qmdSearch"]["semanticScore"] = {"count": 1, "average": 0.5, "min": 0.5, "max": 0.5}
        stats["daily"]["2026-07-31"] = copy.deepcopy(base)
        stats["daily"]["2026-08-08"] = copy.deepcopy(base)
        stats["daily"]["2026-08-08"]["turns"] = 1000
        stats_path.write_text(json.dumps(stats))
        windows = self.report_at()["analysis"]["windows"]
        self.assertEqual(windows["recent"]["daily"]["turns"], 4)
        self.assertEqual(windows["previous"]["daily"]["turns"], 2)
        scores = windows["recent"]["daily"]["skillDiscovery"]["qmdSearch"]["semanticScore"]
        self.assertEqual(scores["count"], 3)
        self.assertEqual(scores["average"], 0.7)
        self.assertEqual(windows["recent"]["daily"]["topUnadoptedSkills"][0]["unadoptedTurns"], 2)
        stats["daily"]["2026-08-02"]["skillRouting"]["__other__"] = {"intentMatchedTurns": 1}
        stats_path.write_text(json.dumps(stats))
        self.assertEqual(self.report_at()["analysis"]["windows"]["recent"]["daily"]["topUnadoptedSkills"], [])

    def test_missing_logs_and_read_race(self) -> None:
        (self.root / "review.json").unlink()
        report = self.report_at()
        self.assertEqual(report["runtime"]["review"], {"status": "unavailable"})
        self.assertEqual(set(report["provenance"]["stateSha256"]), {"stats.json"})
        with patch.object(audit, "sha256", side_effect=["before", "after"]):
            with self.assertRaisesRegex(ValueError, "changed while being read"):
                self.report_at()
        (self.root / "stats.json").unlink()
        report = self.report_at()
        self.assertEqual(report["runtime"]["stats"], {"status": "unavailable"})
        self.assertEqual(report["analysis"]["cumulative"]["statsStatus"], "unavailable")

    def test_review_outcomes_multi_trigger_and_applied_changes_only(self) -> None:
        review_path = self.root / "review.json"
        review = json.loads(review_path.read_text())
        outcomes = ("applied", "nofinding", "parse-failed", "schema-rejected", "validation-failed", "subagent-error")
        review["processedEvents"] = {name: {"processedAt": "2026-08-01T00:00:00Z", "outcome": name,
            "triggers": ["capability-fit", "routing-uncertainty"], "changes": [{"trigger": "capability-fit", "operation": "create"}],
            "summary": "PRIVATE_REVIEW", "evidence": ["PRIVATE_EVIDENCE"],
            "schemaRejectionReasonCounts": {"missing-target": 1} if name == "schema-rejected" else {}} for name in outcomes}
        review_path.write_text(json.dumps(review))
        result = self.report_at()["analysis"]["windows"]["recent"]["review"]
        self.assertEqual(result["eventCount"], 6)
        self.assertEqual(result["triggerEvents"]["capability-fit"], 6)
        self.assertEqual(result["changes"]["total"], 1)
        self.assertEqual(result["schemaRejectionReasons"], {"missing-target": 1})
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_multiple_skill_indexes_and_broken_database(self) -> None:
        root = self.root / "qmd" / "skills" / "indexes"
        for fingerprint in ("secret-one", "secret-two", "missing", "corrupt"):
            (root / fingerprint / "docs").mkdir(parents=True)
        source = self.root / "qmd" / "intents" / "intent-routing.sqlite"
        for fingerprint in ("secret-one", "secret-two"):
            shutil.copyfile(source, root / fingerprint / "skill-search.sqlite")
        database = sqlite3.connect(root / "secret-two" / "skill-search.sqlite")
        database.execute("DELETE FROM content_vectors WHERE id = 2")
        database.execute("UPDATE embedding_index_state SET lease_expires_at = ?", (10**15,))
        database.commit()
        database.close()
        (root / "corrupt" / "skill-search.sqlite").write_text("broken")
        result = self.report_at()["runtime"]["qmd"]["skills"]
        self.assertEqual(result["indexCount"], 4)
        self.assertEqual(result["unavailableCount"], 2)
        self.assertEqual(result["activeLeaseCount"], 1)
        self.assertEqual(result["documentVectorMismatchCount"], 1)
        self.assertNotIn("secret", json.dumps(result))

    def test_cohort_boundary_and_retention_coverage(self) -> None:
        stats_path = self.root / "stats.json"
        stats = json.loads(stats_path.read_text())
        stats["attribution"]["startedAt"] = "2026-08-02T12:00:00Z"
        stats_path.write_text(json.dumps(stats))
        daily = self.report_at()["analysis"]["windows"]["recent"]["daily"]
        self.assertEqual(daily["excludedPreCohortBuckets"], 1)
        self.assertTrue(daily["cohortStartedDuringWindow"])
        self.assertIsNone(daily["turns"])
        sessions = self.report_at(30)["analysis"]["windows"]["recent"]["sessions"]
        self.assertTrue(sessions["extendsBeforeRetention"])
        self.assertIsNone(audit.iso_timestamp("2026-08-01T12:00:00"))

    def test_cli_days_validation(self) -> None:
        for days in ("0", "91", "invalid"):
            result = subprocess.run(["python3", str(SCRIPT), "--data-root", str(self.root), "--stdout", "--days", days], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()

