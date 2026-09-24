"""Python runtime for BoundBox's token-protected exchange service and journal."""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from typing import Any
from urllib.parse import parse_qs, urlsplit


TRACKED_FILES = {"source.wireloom": "ai-to-user", "boxes.json": "user-to-ai", "packet.json": "user-to-ai", "project.json": "user-to-ai"}
OUT_FILES = {"boxes": "boxes.json", "packet": "packet.json", "project": "project.json"}
SNAPSHOT_RE = re.compile(r"^(\d{5,})_([A-Za-z0-9._-]+)$")
MAX_BODY_BYTES = 25_000_000


def process_is_alive(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError, ValueError):
        return False


def host_is_allowed(host_header: str) -> bool:
    host = host_header.split(":", 1)[0].strip("[]").lower()
    allowed = {
        "localhost",
        "127.0.0.1",
        "::1",
        os.environ.get("COMPUTERNAME", "").lower(),
        socket.gethostname().lower(),
        socket.getfqdn().lower(),
    }
    if host in allowed:
        return True
    try:
        parts = [int(part) for part in host.split(".")]
    except ValueError:
        return False
    if len(parts) != 4 or any(part < 0 or part > 255 for part in parts):
        return False
    first, second = parts[0], parts[1]
    return first == 127 or first == 10 or (first == 192 and second == 168) or (first == 172 and 16 <= second <= 31)


def _history_dir(exchange_dir: Path) -> Path:
    return exchange_dir / "history"


def _journal_path(exchange_dir: Path) -> Path:
    return _history_dir(exchange_dir) / "journal.jsonl"


def read_journal(exchange_dir: Path) -> list[dict[str, Any]]:
    path = _journal_path(exchange_dir)
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            print(f"WARN: skipping corrupt journal line: {line[:80]}")
    return entries


def _max_seq(exchange_dir: Path, entries: list[dict[str, Any]]) -> int:
    highest = max((entry.get("seq", 0) for entry in entries if isinstance(entry.get("seq"), int)), default=0)
    history_dir = _history_dir(exchange_dir)
    if history_dir.exists():
        for path in history_dir.iterdir():
            match = SNAPSHOT_RE.fullmatch(path.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return highest


def snapshot_path_for(exchange_dir: Path, entry: dict[str, Any]) -> Path:
    filename = entry.get("file")
    if filename not in TRACKED_FILES:
        raise ValueError(f'journal entry {entry.get("seq")} references untracked file "{filename}" - refusing (possible tampering)')
    snapshot = str(entry.get("snapshot", ""))
    if not SNAPSHOT_RE.fullmatch(snapshot):
        raise ValueError(f'journal entry {entry.get("seq")} has invalid snapshot name "{snapshot}" - refusing (possible tampering)')
    history_dir = _history_dir(exchange_dir).resolve()
    path = (history_dir / snapshot).resolve()
    if path.parent != history_dir:
        raise ValueError(f'journal entry {entry.get("seq")} snapshot resolves outside history/ - refusing (possible tampering)')
    return path


def replace_with_retry(source: Path, destination: Path, attempts: int = 4) -> None:
    for attempt in range(attempts):
        try:
            os.replace(source, destination)
            return
        except OSError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.05 * (attempt + 1))


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(content)
    try:
        replace_with_retry(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def reconcile(exchange_dir: Path, reason: str = "reconcile") -> list[dict[str, Any]]:
    history_dir = _history_dir(exchange_dir)
    history_dir.mkdir(parents=True, exist_ok=True)
    entries = read_journal(exchange_dir)
    last_hashes = {entry.get("file"): entry.get("sha256") for entry in entries}
    sequence = _max_seq(exchange_dir, entries) + 1
    added: list[dict[str, Any]] = []
    for filename, direction in TRACKED_FILES.items():
        live_path = exchange_dir / filename
        if not live_path.exists():
            continue
        content = live_path.read_bytes()
        sha256 = hashlib.sha256(content).hexdigest()
        if last_hashes.get(filename) == sha256:
            continue
        while True:
            snapshot = f"{sequence:05d}_{filename}"
            try:
                with (history_dir / snapshot).open("xb") as stream:
                    stream.write(content)
                break
            except FileExistsError:
                sequence += 1
        entry = {"seq": sequence, "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "file": filename, "direction": direction, "bytes": len(content), "sha256": sha256, "snapshot": snapshot, "reason": reason}
        with _journal_path(exchange_dir).open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(entry, separators=(",", ":")) + "\n")
        last_hashes[filename] = sha256
        added.append(entry)
        sequence += 1
    return added


def find_entry(entries: list[dict[str, Any]], sequence: int | str) -> dict[str, Any]:
    wanted = int(sequence)
    matches = [entry for entry in entries if entry.get("seq") == wanted]
    if not matches:
        raise ValueError(f"no journal entry with seq {wanted}")
    if len(matches) > 1:
        raise ValueError(f"ambiguous seq {wanted} ({len(matches)} entries - concurrent journaling); inspect history/journal.jsonl")
    return matches[0]


def read_snapshot(exchange_dir: Path, sequence: int | str) -> tuple[dict[str, Any], bytes]:
    entry = find_entry(read_journal(exchange_dir), sequence)
    path = snapshot_path_for(exchange_dir, entry)
    if not path.exists():
        raise ValueError(f"snapshot file missing: {entry['snapshot']}")
    return entry, path.read_bytes()


def restore(exchange_dir: Path, sequence: int | str) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    entry, content = read_snapshot(exchange_dir, sequence)
    preserved = reconcile(exchange_dir, reason=f"pre-restore-of-{entry['seq']}")
    atomic_write(exchange_dir / entry["file"], content)
    journaled = reconcile(exchange_dir, reason=f"restore-of-{entry['seq']}")
    return entry, preserved, journaled


class BoundBoxServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], exchange_dir: Path, app_path: Path, token: str, idle_seconds: int):
        super().__init__(address, BoundBoxHandler)
        self.exchange_dir = exchange_dir
        self.app_path = app_path
        self.token = token
        self.idle_seconds = idle_seconds
        self.last_activity = time.monotonic()
        self.exchange_lock = RLock()

    def touch(self) -> None:
        self.last_activity = time.monotonic()


class BoundBoxHandler(BaseHTTPRequestHandler):
    server: BoundBoxServer

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _respond(self, status: int, body: Any = b"", content_type: str = "application/json; charset=utf-8", headers: dict[str, str] | None = None) -> None:
        if not isinstance(body, (bytes, bytearray)):
            body = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self) -> tuple[str | None, dict[str, list[str]]]:
        request = urlsplit(self.path)
        if request.path == "/":
            return "__root__", parse_qs(request.query)
        parts = request.path.strip("/").split("/")
        if not parts or parts[0] != self.server.token:
            return None, {}
        self.server.touch()
        return "/".join(parts[1:]), parse_qs(request.query)

    def _valid_host(self) -> bool:
        return host_is_allowed(self.headers.get("Host", ""))

    def _valid_write_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            return urlsplit(origin).netloc.lower() == self.headers.get("Host", "").lower()
        except ValueError:
            return False

    def do_GET(self) -> None:
        if not self._valid_host():
            self._respond(404, {"error": "not found"})
            return
        try:
            route, query = self._route()
            if route == "__root__":
                self._respond(302, b"", headers={"Location": f"/{self.server.token}/"})
            elif route is None:
                self._respond(404, {"error": "not found"})
            elif route == "":
                self._respond(200, self.server.app_path.read_bytes(), "text/html; charset=utf-8")
            elif route == "ping":
                self._respond(200, {"ok": True, "idleSeconds": self.server.idle_seconds})
            elif route == "source":
                with self.server.exchange_lock:
                    reconcile(self.server.exchange_dir, reason="source-read")
                    path = self.server.exchange_dir / "source.wireloom"
                    self._respond(200, path.read_bytes(), "text/plain; charset=utf-8") if path.exists() else self._respond(404, {"error": "no source.wireloom in exchange folder"})
            elif route == "project":
                with self.server.exchange_lock:
                    reconcile(self.server.exchange_dir, reason="project-read")
                    path = self.server.exchange_dir / "project.json"
                    if path.exists():
                        self._respond(200, path.read_bytes(), "application/json; charset=utf-8")
                    elif query.get("optional") == ["1"]:
                        self._respond(204, b"")
                    else:
                        self._respond(404, {"error": "no project.json in exchange folder"})
            elif route == "history":
                with self.server.exchange_lock:
                    reconcile(self.server.exchange_dir, reason="history-read")
                    self._respond(200, {"entries": read_journal(self.server.exchange_dir)})
            else:
                self._respond(404, {"error": "not found"})
        except Exception as exc:
            self._respond(500, {"error": f"request failed on the server: {exc}"})

    def do_POST(self) -> None:
        if not self._valid_host():
            self._respond(404, {"error": "not found"})
            return
        if not self._valid_write_origin():
            self._respond(403, {"error": "cross-origin writes are not allowed"})
            return
        route, _query = self._route()
        if route not in {"save", "restore"}:
            self._respond(404, {"error": "not found"})
            return
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            self._respond(415, {"error": "content-type must be application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._respond(400, {"error": "invalid content-length"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(413, {"error": f"request body must be between 1 and {MAX_BODY_BYTES} bytes"})
            return
        try:
            parsed = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            self._respond(400, {"error": f"invalid JSON body: {exc}"})
            return
        if route == "restore":
            seq = parsed.get("seq") if isinstance(parsed, dict) else None
            try:
                sequence = int(seq)
            except (TypeError, ValueError):
                self._respond(400, {"error": "seq must be a journal sequence number"})
                return
            try:
                with self.server.exchange_lock:
                    entry, preserved, journaled = restore(self.server.exchange_dir, sequence)
                self._respond(200, {"ok": True, "entry": entry, "preserved": preserved, "journaled": journaled})
            except ValueError as exc:
                self._respond(400, {"error": str(exc)})
            except Exception as exc:
                self._respond(500, {"error": f"restore failed on the server: {exc}"})
            return
        filename = OUT_FILES.get(parsed.get("kind")) if isinstance(parsed, dict) else None
        if not filename or "payload" not in parsed:
            self._respond(400, {"error": f"kind must be one of: {', '.join(OUT_FILES)} and payload is required"})
            return
        try:
            content = json.dumps(parsed["payload"], indent=2, ensure_ascii=False).encode("utf-8")
            with self.server.exchange_lock:
                reconcile(self.server.exchange_dir, reason="pre-save")
                atomic_write(self.server.exchange_dir / filename, content)
                reconcile(self.server.exchange_dir, reason="save")
            self._respond(200, {"ok": True, "file": filename})
        except Exception as exc:
            self._respond(500, {"error": f"save failed on the server: {exc}"})
