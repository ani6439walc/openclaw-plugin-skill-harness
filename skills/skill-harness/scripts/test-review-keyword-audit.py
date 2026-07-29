#!/usr/bin/env python3
"""Self-contained regression tests for review-keyword-audit.py."""

from __future__ import annotations

import json
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
                    "schemaVersion": 5,
                    "createdAt": "2026-07-01T00:00:00.000Z",
                    "updatedAt": "2026-07-01T00:00:00.000Z",
                    "triggerKeywords": {
                        "successfulPattern": ["done"],
                        "behaviorFix": ["wrong"],
                        "entityContext": ["memory alias"],
                    },
                    "processedEvents": {},
                    "reviewedSkillEpochs": {},
                }
            ),
            encoding="utf-8",
        )
        states = [
            {
                "input": "ship release",
                "result": "verified workflow shipped cleanly",
                "toolCalls": [{"name": "exec", "params": {}}] * 5,
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

    def test_rejects_non_current_review_log(self) -> None:
        (self.root / "review.json").write_text(
            json.dumps({"schemaVersion": 4}), encoding="utf-8"
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
        self.assertIn("schema-v5", result.stderr)


if __name__ == "__main__":
    unittest.main()
