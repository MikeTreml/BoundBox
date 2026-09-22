"""CLI coverage for history.py list / show / restore."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class HistoryCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.exchange = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ROOT / "history.py"), *args, "--dir", str(self.exchange)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )

    def test_list_show_restore(self) -> None:
        (self.exchange / "boxes.json").write_text('{"boxes":["a"]}', encoding="utf-8")
        listed = self._run("list")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertIn("boxes.json", listed.stdout)
        seq = int(listed.stdout.strip().splitlines()[-1].split()[0])
        shown = self._run("show", str(seq))
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(shown.stdout, '{"boxes":["a"]}')
        (self.exchange / "boxes.json").write_text('{"boxes":["b"]}', encoding="utf-8")
        restored = self._run("restore", str(seq))
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertIn("restored boxes.json", restored.stdout)
        self.assertEqual((self.exchange / "boxes.json").read_text(encoding="utf-8"), '{"boxes":["a"]}')

    def test_live_session_detects_a_running_pid(self) -> None:
        sys.path.insert(0, str(ROOT))
        from history import session_is_live
        (self.exchange / ".session.json").write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
        self.assertTrue(session_is_live(self.exchange))
        (self.exchange / ".session.json").write_text(json.dumps({"pid": -1}), encoding="utf-8")
        self.assertFalse(session_is_live(self.exchange))


if __name__ == "__main__":
    unittest.main()
