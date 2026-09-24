"""Launch the stable or on-demand BoundBox Streamlit shell and Python exchange API."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from runtime import BoundBoxServer, process_is_alive, reconcile


ROOT = Path(__file__).resolve().parent


def available_port(requested: int) -> int:
    if requested:
        with socket.socket() as probe:
            try:
                probe.bind(("0.0.0.0", requested))
                return int(probe.getsockname()[1])
            except OSError:
                print(f"WARN: port {requested} is in use; choosing another.", file=sys.stderr)
    with socket.socket() as probe:
        probe.bind(("0.0.0.0", 0))
        return int(probe.getsockname()[1])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch BoundBox's Python/Streamlit workspace")
    parser.add_argument("--dir", default="./boundbox", help="Exchange directory")
    parser.add_argument("--port", type=int, default=8620, help="Streamlit port (default: 8620)")
    parser.add_argument("--api-port", type=int, default=8621, help="Canvas exchange API port (default: 8621)")
    parser.add_argument("--address", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--idle-seconds", type=int, default=0, help="Stop after browser inactivity; 0 keeps the Tower service running")
    parser.add_argument("--on-demand", action="store_true", help="Use the traditional 30-minute idle shutdown (equivalent to --idle-seconds 1800)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.on_demand and args.idle_seconds == 0:
        args.idle_seconds = 1800
    exchange_dir = Path(args.dir).resolve()
    exchange_dir.mkdir(parents=True, exist_ok=True)
    gitignore = exchange_dir / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*\n", encoding="utf-8")
    reconcile(exchange_dir, reason="launch")

    session_path = exchange_dir / ".session.json"
    if session_path.exists():
        try:
            prior = json.loads(session_path.read_text(encoding="utf-8"))
            if process_is_alive(int(prior["pid"])):
                print(f"WARN: a BoundBox session is already serving this folder (pid {prior['pid']}).")
                print(f"URL: http://{socket.gethostname()}:{prior['port']}/")
                return 0
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass
        session_path.unlink(missing_ok=True)

    app_path = next((path for path in (ROOT / "app" / "boundbox.html", ROOT / "boundbox.html") if path.exists()), None)
    streamlit_app = ROOT / "app.py"
    if app_path is None or not streamlit_app.exists():
        print("BoundBox runtime is incomplete: app.py and boundbox.html are required.", file=sys.stderr)
        return 2

    streamlit_port = available_port(args.port)
    api_port = available_port(args.api_port)
    token = secrets.token_urlsafe(24)
    api = BoundBoxServer((args.address, api_port), exchange_dir, app_path, token, max(0, args.idle_seconds))
    api_thread = threading.Thread(target=api.serve_forever, name="boundbox-api", daemon=True)
    api_thread.start()

    env = os.environ.copy()
    env.update({"BOUNDBOX_EXCHANGE_DIR": str(exchange_dir), "BOUNDBOX_API_PORT": str(api_port), "BOUNDBOX_TOKEN": token, "BOUNDBOX_IDLE_SECONDS": str(max(0, args.idle_seconds))})
    command = [sys.executable, "-m", "streamlit", "run", str(streamlit_app), "--server.address", args.address, "--server.port", str(streamlit_port), "--server.headless", "true", "--browser.gatherUsageStats", "false"]
    try:
        child = subprocess.Popen(command, cwd=ROOT, env=env)
    except Exception:
        api.shutdown()
        raise
    session_path.write_text(json.dumps({"pid": os.getpid(), "streamlitPid": child.pid, "port": streamlit_port, "apiPort": api_port, "token": token, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, indent=2), encoding="utf-8")
    print(f"BoundBox exchange: {exchange_dir}")
    print(f"URL: http://{socket.gethostname()}:{streamlit_port}/")
    print(f"Canvas API: {api_port}; idle timeout: {args.idle_seconds}s. Ctrl+C to stop.")
    stopped_by_launcher = False
    try:
        while child.poll() is None:
            if args.idle_seconds > 0 and time.monotonic() - api.last_activity > args.idle_seconds:
                print("Idle timeout reached; shutting down.")
                stopped_by_launcher = True
                break
            time.sleep(1)
    except KeyboardInterrupt:
        stopped_by_launcher = True
    finally:
        session_path.unlink(missing_ok=True)
        api.shutdown()
        api.server_close()
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
    return 0 if stopped_by_launcher else child.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())
