#!/usr/bin/env python3
"""Regression tests for the read-only experience CLI; run after pnpm run build."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("validate-experiences.mjs")


class ExperienceValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.experiences = self.root / "experiences"
        self.entry = self.experiences / "example"
        self.entry.mkdir(parents=True)
        for name, text in {"summary.md": "Reusable procedure.", "keywords.md": "procedure",
                           "body.md": "PRIVATE_BODY: perform and verify the procedure.",
                           "skills.md": "example-skill"}.items():
            (self.entry / name).write_text(text, encoding="utf-8")
        self.skills = self.root / "visible.json"
        self.skills.write_text(json.dumps({"main": [], "worker": ["example-skill"]}), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def validate(self, extra: list | None = None) -> tuple[int, dict]:
        before = {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        result = subprocess.run(["node", str(SCRIPT), "--experiences-dir", str(self.experiences),
                                 "--visible-skills-file", str(self.skills)] + (extra or []),
                                capture_output=True, text=True)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("PRIVATE_BODY", result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        after = {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        return result.returncode, json.loads(result.stdout)

    def test_valid_and_all_agent_visibility(self) -> None:
        code, result = self.validate()
        self.assertEqual(code, 0)
        self.assertEqual(result, {"valid": True, "entryCount": 1, "errors": []})

    def test_shape_limit_and_invisible_skill(self) -> None:
        (self.entry / "summary.md").write_text("x" * 241, encoding="utf-8")
        code, result = self.validate()
        self.assertEqual(code, 1)
        self.assertIn("240", json.dumps(result))
        (self.entry / "summary.md").write_text("Summary.", encoding="utf-8")
        self.skills.write_text('{"main": []}', encoding="utf-8")
        code, result = self.validate()
        self.assertEqual(code, 1)
        self.assertIn("not visible", json.dumps(result))

    def test_missing_directory_and_symlink(self) -> None:
        self.experiences.rename(self.root / "saved")
        code, result = self.validate()
        self.assertEqual(code, 1)
        self.experiences.symlink_to(self.root / "saved", target_is_directory=True)
        code, result = self.validate()
        self.assertEqual(code, 1)
        self.assertIn("symbolic link", json.dumps(result))
        self.experiences.unlink()
        (self.root / "saved").rename(self.experiences)
        (self.entry / "body.md").unlink()
        (self.entry / "body.md").symlink_to(self.skills)
        code, result = self.validate()
        self.assertEqual(code, 1)
        self.assertIn("symbolic links", json.dumps(result))

    def test_bad_arguments_and_visible_file(self) -> None:
        for content in ("not JSON", "[]", '{"main": "example-skill"}', '{"main": [1]}'):
            self.skills.write_text(content, encoding="utf-8")
            code, result = self.validate()
            self.assertEqual(code, 1)
            self.assertFalse(result["valid"])
        self.skills.unlink()
        code, result = self.validate()
        self.assertEqual(code, 1)
        code, result = self.validate(["--unknown"])
        self.assertEqual(code, 1)
        result = subprocess.run(["node", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Required", result.stdout)


if __name__ == "__main__":
    unittest.main()
