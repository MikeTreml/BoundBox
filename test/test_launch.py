"""Launcher port-binding tests."""

from __future__ import annotations

import socket
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from launch import available_port  # noqa: E402


class AvailablePortTests(unittest.TestCase):
    def test_falls_back_when_the_requested_port_is_taken(self) -> None:
        with socket.socket() as occupied:
            occupied.bind(("0.0.0.0", 0))
            taken = int(occupied.getsockname()[1])
            chosen = available_port(taken)
        self.assertNotEqual(chosen, taken)
        self.assertGreater(chosen, 0)


if __name__ == "__main__":
    unittest.main()
