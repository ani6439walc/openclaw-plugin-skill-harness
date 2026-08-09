#!/usr/bin/env python3
"""Self-contained regression tests for runtime-health-audit.py."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("runtime-health-audit.py")


class RuntimeHealthAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "sessions").mkdir()
        (self.root / "agents" / "review" / "sessions").mkdir(parents=True)
        (self.root / "intents").mkdir()
        (self.root / "intents" / "example.md").write_text("---\ntriggers: [example]\n---\n", encoding="utf-8")
        (self.root / "review.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 6,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                    "updatedAt": "2026-08-01T00:00:00.000Z",
                    "processedEvents": {
                        "event-1": {
                            "processedAt": "2026-08-01T00:00:00.000Z",
                            "triggers": ["skill-candidate"],
                            "changeCount": 1,
                            "outcome": "applied",
                            "changes": [
                                {
                                    "trigger": "skill-candidate",
                                    "targetKind": "intent-markdown",
                                    "operation": "refine",
                                    "targetIntentIds": ["example"],
                                }
                            ],
                        },
                        "event-2": {
                            "processedAt": "2026-08-01T00:01:00.000Z",
                            "triggers": ["missing-intent"],
                            "changeCount": 0,
                            "outcome": "nofinding",
                            "noFindingReasonCounts": {"already-covered": 1},
                        },
                    },
                    "reviewedSkillEpochs": {},
                    "historicalKeywordAudits": {},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "keyword-coverage.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                    "updatedAt": "2026-08-01T00:00:00.000Z",
                    "triggerKeywords": {
                        "successfulPattern": ["done"],
                        "behaviorFix": ["wrong", "fix"],
                        "entityContext": ["context"],
                    },
                    "processedKeywordEvents": {},
                    "targets": {},
                    "coverageEpochs": {},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "stats.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 3,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                    "updatedAt": "2026-08-01T00:02:00.000Z",
                    "summary": {
                        "turns": 2,
                        "completedTurns": 1,
                        "erroredTurns": 1,
                        "skillAssistedTurns": 1,
                        "toolAssistedTurns": 1,
                        "skillUsageCount": 1,
                        "toolCallCount": 2,
                        "averageConfidence": 0.75,
                        "otherTurns": 0,
                        "otherRate": 0,
                    },
                    "intents": {
                        "example": {
                            "turns": 2,
                            "share": 1,
                            "lastSeenAt": "2026-08-01T00:02:00.000Z",
                            "last7Days": 2,
                            "averageConfidence": 0.75,
                            "lowConfidenceTurns": 1,
                            "complexity": {"low": 0, "medium": 2, "high": 0},
                            "skillAssistedTurns": 1,
                            "toolAssistedTurns": 1,
                            "erroredTurns": 1,
                        }
                    },
                    "skills": {
                        "example-skill": {
                            "usageTurns": 1,
                            "recommendedTurns": 2,
                            "adoptedTurns": 1,
                            "adoptionRate": 0.5,
                            "lastUsedAt": "2026-08-01T00:02:00.000Z",
                            "last7DaysUsage": 1,
                            "lifecycle": "active",
                            "needsReview": True,
                        }
                    },
                    "routing": {
                        "recommendationTurns": 2,
                        "adoptedTurns": 1,
                        "turnAdoptionRate": 0.5,
                        "recommendedSkillOpportunities": 2,
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
                        }
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
                                "recommendationTurns": 2,
                                "adoptedTurns": 1,
                                "recommendedSkillOpportunities": 2,
                                "adoptedSkillOpportunities": 1,
                            },
                            "projection": {
                                "eligibleTurns": 1,
                                "projectedTurns": 1,
                                "fullFallbackTurns": 0,
                                "fallbackReasons": {},
                            },
                        }
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
                "byTrigger": {"skill-candidate": 1},
                "byOperation": {"refine": 1},
                "topTargetIntents": [{"intent": "example", "changes": 1}],
            },
        )
        self.assertEqual(
            report["runtime"]["keywordCoverage"]["keywordCounts"],
            {"successfulPattern": 1, "behaviorFix": 2, "entityContext": 1},
        )
        self.assertEqual(report["runtime"]["sessions"]["sessionFiles"], 1)
        self.assertEqual(report["runtime"]["sessions"]["agentArtifactFiles"], 1)
        self.assertEqual(report["runtime"]["intents"]["markdownFiles"], 1)
        self.assertEqual(set(report["provenance"]["stateSha256"]), {"review.json", "keyword-coverage.json", "stats.json"})
        stats = report["runtime"]["stats"]
        self.assertEqual(stats["attribution"]["status"], "insufficient-historical-attribution")
        self.assertEqual(stats["routingEffectiveness"]["turnAdoptionRate"], 0.5)
        self.assertEqual(stats["routingEffectiveness"]["skillAdoptionRate"], 0.5)
        self.assertEqual(stats["projectionEfficiency"]["projectedRate"], 1)
        self.assertEqual(stats["intentPortfolio"]["trackedIntents"], 1)
        self.assertEqual(stats["intentPortfolio"]["erroredTurns"], 1)
        self.assertEqual(stats["skillLifecycle"]["needsReviewCount"], 1)
        self.assertEqual(stats["skillLifecycle"]["lowAdoptionCohort"], [{"skill": "example-skill", "recommendedTurns": 2, "adoptedTurns": 1, "adoptionRate": 0.5, "lifecycle": "active"}])
        self.assertEqual(stats["toolReliability"]["errorCalls"], 1)
        self.assertEqual(stats["toolReliability"]["errorRate"], 0.5)
        self.assertEqual(stats["toolReliability"]["latencyHistogram"]["status"], "unavailable")
        self.assertEqual(stats["dataHealth"]["dailyBucketCount"], 1)
        self.assertEqual(stats["dataHealth"]["statsUpdatedAt"], "2026-08-01T00:02:00.000Z")
        self.assertEqual(stats["dataHealth"]["dailyDynamicKeyCardinality"]["maxIntents"], 1)

    def test_reports_v4_attribution_boundary_and_bounded_daily_maps(self) -> None:
        stats_path = self.root / "stats.json"
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
        stats["schemaVersion"] = 4
        stats["attribution"] = {"startedAt": "2026-08-01T00:02:00.000Z"}
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
                "intentRouting": {"value:example": {"recommendationTurns": 2}},
                "skillRouting": {"value:example-skill": {"recommendedTurns": 2}},
                "toolErrors": {"value:exec": 1, "__other__": 2},
            }
        )
        stats_path.write_text(json.dumps(stats), encoding="utf-8")

        report = self.run_audit()
        runtime_stats = report["runtime"]["stats"]
        self.assertEqual(runtime_stats["attribution"]["status"], "post-v4-window-only")
        self.assertEqual(runtime_stats["attribution"]["startedAt"], "2026-08-01T00:02:00.000Z")
        self.assertEqual(runtime_stats["attribution"]["dailyBucketsBeforeAttribution"], 0)
        self.assertEqual(runtime_stats["toolReliability"]["latencyHistogram"], {
            "status": "post-v4-window-only",
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
        self.assertEqual(runtime_stats["dataHealth"]["dailyDynamicKeyCardinality"]["maxIntentOutcomes"], 1)
        self.assertEqual(runtime_stats["dataHealth"]["dailyDynamicKeyCardinality"]["maxIntentRouting"], 1)
        self.assertEqual(runtime_stats["dataHealth"]["dailyDynamicKeyCardinality"]["maxSkillRouting"], 1)
        self.assertEqual(runtime_stats["dataHealth"]["dailyDynamicKeyCardinality"]["maxToolErrors"], 2)

    def test_rejects_non_current_review_log(self) -> None:
        (self.root / "review.json").write_text(json.dumps({"schemaVersion": 5}), encoding="utf-8")
        result = subprocess.run(
            ["python3", str(SCRIPT), "--data-root", str(self.root), "--stdout"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("schema-v6", result.stderr)


if __name__ == "__main__":
    unittest.main()
