import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("jules_pr_review.py")
WORKFLOW = SCRIPT.parents[1] / "workflows" / "jules-pr-review.yml"

spec = importlib.util.spec_from_file_location("jules_pr_review", SCRIPT)
assert spec and spec.loader
jules_pr_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jules_pr_review)


class JulesPrReviewTest(unittest.TestCase):
    def test_workflow_grants_contents_write_for_temporary_diff_branch(self):
        self.assertIn("  contents: write\n", WORKFLOW.read_text(encoding="utf-8"))

    def test_push_failure_reports_sanitized_git_output(self):
        github_token = "github-token-secret"
        jules_api_key = "jules-api-key-secret"
        error = subprocess.CalledProcessError(
            128,
            ["git", "push", "origin", "temp/pr-57-diff-1"],
            output=f"remote: rejected {github_token}",
            stderr=f"fatal: denied {jules_api_key}",
        )

        with mock.patch.dict(
            os.environ,
            {"GITHUB_TOKEN": github_token, "JULES_API_KEY": jules_api_key},
        ):
            with mock.patch.object(
                jules_pr_review.subprocess, "run", side_effect=error
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Failed to push temporary diff branch"
                ) as raised:
                    jules_pr_review.push_diff_branch("temp/pr-57-diff-1")

        message = str(raised.exception)
        self.assertIn("stdout: remote: rejected [REDACTED]", message)
        self.assertIn("stderr: fatal: denied [REDACTED]", message)
        self.assertNotIn(github_token, message)
        self.assertNotIn(jules_api_key, message)


if __name__ == "__main__":
    unittest.main()