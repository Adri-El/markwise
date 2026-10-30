"""Offline tests for worker.cli path building. No API calls."""

import unittest
from pathlib import Path

from worker.cli import _rubric_run_dir


class RunDirTests(unittest.TestCase):
    def test_rubric_run_dir(self):
        run_dir = _rubric_run_dir(
            Path("worker") / "runs", "bio101-test1", "20250101_120000")
        self.assertIsInstance(run_dir, Path)
        self.assertEqual(run_dir.parent, Path("worker") / "runs")
        self.assertEqual(run_dir.name, "bio101-test1_rubric_20250101_120000")


if __name__ == "__main__":
    unittest.main()
