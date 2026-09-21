"""Content-addressed stage cache.

A key is the hash of everything that can change a stage's output: input
content hashes, the stage's own version, the relevant config subset and tool
or model versions. Changing a crop rectangle changes crop pixels, hence the
crop hash, hence every downstream key — no manual invalidation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .util import read_json, sha256_json, write_json


@dataclass
class CacheStats:
    hits: dict[str, int] = field(default_factory=dict)
    misses: dict[str, int] = field(default_factory=dict)

    def hit(self, stage: str) -> None:
        self.hits[stage] = self.hits.get(stage, 0) + 1

    def miss(self, stage: str) -> None:
        self.misses[stage] = self.misses.get(stage, 0) + 1

    def as_dict(self) -> dict:
        stages = sorted(set(self.hits) | set(self.misses))
        return {s: {"hits": self.hits.get(s, 0), "misses": self.misses.get(s, 0)} for s in stages}


class StageCache:
    def __init__(self, root: Path | None, stats: CacheStats | None = None):
        # root=None disables persistence (tests that want to count real work).
        self.root = root
        self.stats = stats or CacheStats()

    @staticmethod
    def key(stage: str, stage_version: str, **parts: Any) -> str:
        return sha256_json({"stage": stage, "v": stage_version, **parts})

    def _path(self, stage: str, key: str) -> Path:
        assert self.root is not None
        return self.root / stage / key[:2] / f"{key}.json"

    def get_or_compute(self, stage: str, key: str, compute: Callable[[], Any]) -> tuple[Any, bool]:
        if self.root is not None:
            p = self._path(stage, key)
            if p.exists():
                self.stats.hit(stage)
                return read_json(p)["value"], True
        value = compute()
        self.stats.miss(stage)
        if self.root is not None:
            write_json(self._path(stage, key), {"key": key, "stage": stage, "value": value}, pretty=False)
        return value, False
