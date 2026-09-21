import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture(autouse=True)
def isolated_data_root(tmp_path, monkeypatch):
    # Never touch the real pilot data root from tests.
    monkeypatch.setenv("VBENCH_DATA", str(tmp_path / "data"))
    return tmp_path / "data"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def guard(*args, **kwargs):
        raise RuntimeError("offline test attempted a network connection")

    monkeypatch.setattr(socket.socket, "connect", guard)
    monkeypatch.setattr(socket, "create_connection", guard)
