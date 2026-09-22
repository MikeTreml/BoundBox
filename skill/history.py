"""Inspect and restore BoundBox exchange-file journal entries."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from runtime import process_is_alive, read_journal, read_snapshot, reconcile, restore


def session_is_live(exchange_dir: Path) -> bool:
    try:
        pid = int(json.loads((exchange_dir / ".session.json").read_text(encoding="utf-8"))["pid"])
        return process_is_alive(pid)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="BoundBox exchange history")
    parser.add_argument("command", choices=("list", "show", "restore"))
    parser.add_argument("sequence", nargs="?", type=int)
    parser.add_argument("--dir", default="./boundbox", help="Exchange directory")
    args = parser.parse_args()
    exchange_dir = Path(args.dir).resolve()
    if not exchange_dir.exists():
        parser.error(f"exchange folder not found: {exchange_dir}")
    if args.command in {"list", "restore"} and session_is_live(exchange_dir):
        print("WARN: a live BoundBox session is serving this folder - avoid concurrent restores.", file=sys.stderr)
    if args.command == "list":
        reconcile(exchange_dir, reason="history-list")
        entries = read_journal(exchange_dir)
        if not entries:
            print("journal is empty")
            return 0
        print("seq    when                      direction    file             bytes  reason")
        for entry in entries:
            print(f"{entry['seq']:>4}   {entry['ts']:<25} {entry['direction']:<11}  {entry['file']:<16} {entry['bytes']:>6}  {entry['reason']}")
    elif args.command == "show":
        if args.sequence is None:
            parser.error("show requires a sequence")
        _entry, content = read_snapshot(exchange_dir, args.sequence)
        sys.stdout.buffer.write(content)
    else:
        if args.sequence is None:
            parser.error("restore requires a sequence")
        entry, preserved, journaled = restore(exchange_dir, args.sequence)
        if preserved:
            print("preserved unjournaled content first: " + ", ".join(f"seq {item['seq']} ({item['file']})" for item in preserved))
        print(f"restored {entry['file']} to seq {entry['seq']} ({entry['ts']}, {entry['bytes']} bytes).")
        print("restoration journaled as " + ", ".join(f"seq {item['seq']}" for item in journaled) if journaled else "live file already matched this version; no new journal entry needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
