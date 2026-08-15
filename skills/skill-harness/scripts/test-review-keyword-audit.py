#!/usr/bin/env python3
"""Self-contained regression tests for review-keyword-audit.py."""

from __future__ import annotations

import json
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("review-keyword-audit.py")


class ReviewKeywordAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "sessions").mkdir()
        (self.root / "review.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 7,
                    "createdAt": "2026-07-01T00:00:00.000Z",
                    "updatedAt": "2026-07-01T00:00:00.000Z",
                    "processedEvents": {},
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
                    "createdAt": "2026-07-01T00:00:00.000Z",
                    "updatedAt": "2026-07-01T00:00:00.000Z",
                    "triggerKeywords": {
                        "successfulPattern": ["done"],
                        "behaviorFix": ["wrong"],
                        "entityContext": ["memory alias"],
                    },
                    "processedKeywordEvents": {},
                    "targets": {},
                    "coverageEpochs": {},
                }
            ),
            encoding="utf-8",
        )
        states = [
            {
                "input": "ship release",
                "result": "verified workflow shipped cleanly",
                "toolCalls": [{"name": "exec", "params": {}}] * 5,
                "timestamps": {
                    "start": "2026-07-01T01:00:00.000Z",
                    "end": "2026-07-01T01:01:00.000Z",
                },
            },
            {
                "input": "ship patch",
                "result": "verified workflow shipped cleanly",
                "skillsUsed": [{"name": "release"}],
            },
            {"input": "wrong command; preserve stable workflow"},
            {"input": "please preserve stable workflow"},
            {
                "input": "check memory alias",
                "toolCalls": [
                    {"name": "read_file", "params": {"path": "memory/project.md"}}
                ],
                "timestamps": {
                    "start": "2026-07-02T03:00:00.000Z",
                    "end": "2026-07-02T03:02:00.000Z",
                },
            },
        ]
        (self.root / "sessions" / "fixture.json").write_text(
            json.dumps(
                {
                    "sessionId": "fixture",
                    "history": states[:-1],
                    "current": states[-1],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_audit(self, *args: str) -> dict:
        report_path = self.root / "report.json"
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--data-root",
                str(self.root),
                "--min-docs",
                "1",
                "--output",
                str(report_path),
                *args,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout, "")
        self.assertEqual(report_path.stat().st_mode & 0o777, 0o600)
        return json.loads(report_path.read_text(encoding="utf-8"))

    def test_reports_hits_misses_candidates_and_no_snippets_by_default(self) -> None:
        report = self.run_audit()
        self.assertTrue(report["reportOnly"])
        self.assertFalse(report["privacy"]["snippetsIncluded"])
        self.assertEqual(
            report["provenance"]["reviewSha256"],
            hashlib.sha256((self.root / "review.json").read_bytes()).hexdigest(),
        )
        self.assertEqual(
            report["provenance"]["keywordCoverageSha256"],
            hashlib.sha256((self.root / "keyword-coverage.json").read_bytes()).hexdigest(),
        )
        self.assertEqual(report["provenance"]["scriptSha256"], hashlib.sha256(SCRIPT.read_bytes()).hexdigest())
        self.assertIn("sourceCommit", report["provenance"])
        self.assertEqual(
            report["keywordHistory"],
            {
                "events": 0,
                "outcomes": {},
                "keywordAdditions": {},
                "keywordRemovals": {},
                "coverageEpochs": 0,
            },
        )
        self.assertEqual(
            report["analysisWindow"],
            {
                "earliestStart": "2026-07-01T01:00:00.000Z",
                "latestEnd": "2026-07-02T03:02:00.000Z",
                "statesWithTimestamps": 2,
                "statesAnalyzed": 5,
            },
        )
        self.assertEqual(
            report["targets"]["successful-pattern"]["summary"],
            {
                "eligibleDocs": 2,
                "matchedDocs": 0,
                "unmatchedDocs": 2,
                "matchRate": 0.0,
            },
        )
        successful_phrases = {
            item["phrase"]
            for item in report["targets"]["successful-pattern"]["candidatePhrases"]
        }
        self.assertIn("verified workflow shipped", successful_phrases)
        behavior = report["targets"]["behavior-fix"]
        self.assertEqual(behavior["summary"]["matchedDocs"], 1)
        entity = report["targets"]["entity-context"]
        self.assertEqual(entity["summary"]["eligibleDocs"], 1)
        self.assertEqual(entity["summary"]["matchedDocs"], 1)
        self.assertFalse(
            any(
                "snippets" in item
                for target in report["targets"].values()
                for item in target["candidatePhrases"]
            )
        )

    def test_snippets_require_explicit_flag(self) -> None:
        report = self.run_audit("--target", "successful-pattern", "--include-snippets")
        self.assertTrue(report["privacy"]["snippetsIncluded"])
        self.assertTrue(
            any(
                item.get("snippets")
                for item in report["targets"]["successful-pattern"]["candidatePhrases"]
            )
        )

    def test_labeled_observations_produce_confusion_metrics(self) -> None:
        labels_path = self.root / "labels.json"
        labels_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "observations": [
                        {
                            "ref": "fixture.json#history:0",
                            "expectedTriggers": ["successful-pattern"],
                        },
                        {
                            "ref": "fixture.json#history:1",
                            "expectedTriggers": [
                                "successful-pattern",
                                "entity-context",
                            ],
                        },
                        {
                            "ref": "fixture.json#history:2",
                            "expectedTriggers": [],
                        },
                        {
                            "ref": "fixture.json#history:3",
                            "expectedTriggers": ["behavior-fix"],
                        },
                        {
                            "ref": "fixture.json#current:0",
                            "expectedTriggers": ["entity-context"],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

        report = self.run_audit("--labels", str(labels_path))
        metrics = report["labeledMetrics"]
        self.assertEqual(metrics["labeledObservations"], 5)
        self.assertEqual(metrics["unknownRefs"], [])
        self.assertEqual(
            metrics["targets"]["behavior-fix"],
            {
                "truePositive": 0,
                "falsePositive": 1,
                "falseNegative": 1,
                "trueNegative": 3,
                "structurallyBlockedPositive": 0,
                "precision": 0.0,
                "recall": 0.0,
            },
        )
        self.assertEqual(metrics["targets"]["successful-pattern"]["falseNegative"], 2)
        self.assertEqual(
            metrics["targets"]["entity-context"]["structurallyBlockedPositive"], 1
        )

    def test_reads_successful_pattern_threshold_from_openclaw_config(self) -> None:
        config_path = self.root / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {
                            "skill-harness": {
                                "config": {
                                    "review": {
                                        "triggers": {
                                            "successfulPattern": {"toolCalls": 6}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            ),
            encoding="utf-8",
        )

        report = self.run_audit("--config", str(config_path))
        self.assertEqual(report["configuration"]["successfulToolCalls"], 6)
        self.assertEqual(report["configuration"]["thresholdSource"], "openclaw-config")
        self.assertEqual(report["targets"]["successful-pattern"]["summary"]["eligibleDocs"], 1)

    def test_rejects_schema_v5_review_log(self) -> None:
        (self.root / "review.json").write_text(
            json.dumps({"schemaVersion": 5}), encoding="utf-8"
        )
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--data-root",
                str(self.root),
                "--stdout",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("schema-v7", result.stderr)


if __name__ == "__main__":
    unittest.main()
