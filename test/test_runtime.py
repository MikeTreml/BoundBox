"""Journal, restore, and token-protected exchange API tests."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime import (  # noqa: E402
    BoundBoxServer,
    TRACKED_FILES,
    host_is_allowed,
    process_is_alive,
    reconcile,
    restore,
    snapshot_path_for,
)


class JournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.exchange = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_reconcile_journals_each_file_once_and_skips_identical_content(self) -> None:
        (self.exchange / "boxes.json").write_text('{"boxes":[]}', encoding="utf-8")
        (self.exchange / "source.wireloom").write_text('window "A":\n', encoding="utf-8")
        first = reconcile(self.exchange, reason="launch")
        self.assertEqual({entry["file"] for entry in first}, {"boxes.json", "source.wireloom"})
        self.assertEqual([entry["reason"] for entry in first], ["launch", "launch"])
        self.assertEqual(reconcile(self.exchange, reason="launch"), [])
        (self.exchange / "boxes.json").write_text('{"boxes":[1]}', encoding="utf-8")
        second = reconcile(self.exchange, reason="save")
        self.assertEqual([entry["file"] for entry in second], ["boxes.json"])
        self.assertGreater(second[0]["seq"], first[-1]["seq"])
        snap = self.exchange / "history" / second[0]["snapshot"]
        self.assertEqual(snap.read_text(encoding="utf-8"), '{"boxes":[1]}')

    def test_restore_preserves_unjournaled_live_bytes_then_journals_the_restored_version(self) -> None:
        live = self.exchange / "packet.json"
        live.write_text("one", encoding="utf-8")
        first = reconcile(self.exchange, reason="save")[0]
        live.write_text("two", encoding="utf-8")
        entry, preserved, journaled = restore(self.exchange, first["seq"])
        self.assertEqual(entry["seq"], first["seq"])
        self.assertEqual(live.read_text(encoding="utf-8"), "one")
        self.assertEqual([item["file"] for item in preserved], ["packet.json"])
        self.assertEqual(preserved[0]["reason"], f"pre-restore-of-{first['seq']}")
        self.assertEqual(journaled[0]["reason"], f"restore-of-{first['seq']}")
        self.assertEqual((self.exchange / "history" / preserved[0]["snapshot"]).read_text(encoding="utf-8"), "two")

    def test_snapshot_path_rejects_untracked_files_and_path_escape(self) -> None:
        with self.assertRaisesRegex(ValueError, "untracked"):
            snapshot_path_for(self.exchange, {"seq": 1, "file": "secret.txt", "snapshot": "00001_secret.txt"})
        with self.assertRaisesRegex(ValueError, "invalid snapshot"):
            snapshot_path_for(self.exchange, {"seq": 1, "file": "boxes.json", "snapshot": "../boxes.json"})

    def test_process_is_alive_accepts_this_pid_and_rejects_invalid_pids(self) -> None:
        self.assertTrue(process_is_alive(os.getpid()))
        self.assertFalse(process_is_alive(-1))
        self.assertFalse(process_is_alive(0))

    def test_host_allows_loopback_and_private_lan_but_not_public_ipv4(self) -> None:
        self.assertTrue(host_is_allowed("127.0.0.1:8621"))
        self.assertTrue(host_is_allowed("localhost"))
        self.assertTrue(host_is_allowed("10.0.0.4"))
        self.assertTrue(host_is_allowed("192.168.1.20"))
        self.assertTrue(host_is_allowed("172.16.0.2"))
        self.assertFalse(host_is_allowed("8.8.8.8"))
        self.assertFalse(host_is_allowed("evil.example"))


class ExchangeApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.exchange = root / "ex"
        self.exchange.mkdir()
        app = root / "boundbox.html"
        app.write_text("<html>ok</html>", encoding="utf-8")
        self.token = "test-token"
        self.server = BoundBoxServer(("127.0.0.1", 0), self.exchange, app, self.token, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, name="boundbox-test-api", daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> tuple[int, bytes]:
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": "127.0.0.1"}
        if content_type:
            headers["Content-Type"] = content_type
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        return response.status, payload

    def test_unknown_token_is_404_and_save_round_trips_through_the_journal(self) -> None:
        status, _ = self._request("GET", "/wrong/history")
        self.assertEqual(status, 404)
        payload = json.dumps({"kind": "boxes", "payload": {"boundbox": "1", "boxes": []}}).encode("utf-8")
        status, body = self._request("POST", f"/{self.token}/save", payload, "application/json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["file"], "boxes.json")
        status, body = self._request("GET", f"/{self.token}/history")
        self.assertEqual(status, 200)
        entries = json.loads(body)["entries"]
        self.assertTrue(any(entry["file"] == "boxes.json" for entry in entries))
        self.assertTrue((self.exchange / "boxes.json").exists())

    def test_restore_endpoint_rewinds_a_journaled_file(self) -> None:
        (self.exchange / "project.json").write_text('{"v":1}', encoding="utf-8")
        seq = reconcile(self.exchange, reason="save")[0]["seq"]
        (self.exchange / "project.json").write_text('{"v":2}', encoding="utf-8")
        reconcile(self.exchange, reason="save")
        status, body = self._request(
            "POST",
            f"/{self.token}/restore",
            json.dumps({"seq": seq}).encode("utf-8"),
            "application/json",
        )
        self.assertEqual(status, 200)
        parsed = json.loads(body)
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["entry"]["file"], "project.json")
        self.assertEqual((self.exchange / "project.json").read_text(encoding="utf-8"), '{"v":1}')

    def test_save_rejects_unknown_kind(self) -> None:
        status, _ = self._request(
            "POST",
            f"/{self.token}/save",
            json.dumps({"kind": "journal", "payload": {}}).encode("utf-8"),
            "application/json",
        )
        self.assertEqual(status, 400)
        self.assertEqual(set(TRACKED_FILES), {"source.wireloom", "boxes.json", "packet.json", "project.json"})


if __name__ == "__main__":
    unittest.main()
