"""Hashing, canonical JSON and file helpers shared by every stage."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable, Iterator

import numpy as np


def canonical_json(obj: Any) -> str:
    # Sorted keys + fixed separators so identical content always hashes and
    # serializes to identical bytes; the X non-interference tests rely on it.
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(obj: Any) -> str:
    return sha256_bytes(canonical_json(obj).encode("utf-8"))


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def array_sha256(arr: np.ndarray) -> str:
    # Hash raw pixels plus geometry, not an encoded PNG: encoder versions can
    # change PNG bytes without changing what OCR sees.
    h = hashlib.sha256()
    h.update(f"{arr.shape}|{arr.dtype}".encode())
    h.update(np.ascontiguousarray(arr).tobytes())
    return h.hexdigest()


def short_id(prefix: str, *parts: Any, n: int = 16) -> str:
    return f"{prefix}-{sha256_json(list(parts))[:n]}"


def write_json(path: str | Path, obj: Any, *, pretty: bool = True) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (
        json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty
        else canonical_json(obj)
    )
    _atomic_write(path, (text + "\n").encode("utf-8"))


def write_bytes(path: str | Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, data)


def _atomic_write(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_json(path: str | Path) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_jsonl(path: str | Path, rows: Iterable[Any]) -> int:
    lines = [canonical_json(r) for r in rows]
    write_bytes(path, ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8"))
    return len(lines)


def read_jsonl(path: str | Path) -> list[Any]:
    path = Path(path)
    if not path.exists():
        return []
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def iter_jsonl(path: str | Path) -> Iterator[Any]:
    yield from read_jsonl(path)


def append_jsonl(path: str | Path, rows: Iterable[Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(canonical_json(r) + "\n")


def fmt_tc(seconds: float | None) -> str:
    if seconds is None:
        return "--:--.---"
    m, s = divmod(max(0.0, seconds), 60.0)
    return f"{int(m):02d}:{s:06.3f}"
