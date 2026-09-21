"""Where artifacts live. Everything heavy or answer-bearing sits under an ignored data root."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent  # research/video-benchmark
REPO_ROOT = PROJECT_ROOT.parent.parent
SCHEMA_DIR = PACKAGE_ROOT / "schemas"


def data_root() -> Path:
    env = os.environ.get("VBENCH_DATA")
    return Path(env).resolve() if env else (REPO_ROOT / "research" / "data" / "video-benchmark")


@dataclass(frozen=True)
class RunPaths:
    root: Path

    @property
    def public(self) -> Path:
        return self.root / "public"

    @property
    def private(self) -> Path:
        return self.root / "private"

    @property
    def views(self) -> Path:
        return self.root / "views"

    @property
    def samples(self) -> Path:
        return self.root / "samples"

    @property
    def reports(self) -> Path:
        return self.root / "reports"

    @property
    def review(self) -> Path:
        return self.root / "review"


@dataclass(frozen=True)
class AnnotationPaths:
    """Human-authored, persistent across re-extraction; never regenerated."""

    root: Path

    @property
    def corrections(self) -> Path:
        return self.root / "corrections.jsonl"

    def run_corrections(self, run_id: str) -> Path:
        # Run-scoped corrections: migrated or new review for one extraction run.
        return self.root / f"corrections.{run_id}.jsonl"

    def ledger(self, run_id: str) -> Path:
        # Record ids depend on the extraction run's segmentation, so numbering is per run.
        return self.root / "ledgers" / f"{run_id}.json"

    @property
    def reference(self) -> Path:
        return self.root / "reference" / "reference_review.json"

    @property
    def private_roles(self) -> Path:
        return self.root / "private" / "roles.json"


def run_paths(run_id: str, root: Path | None = None) -> RunPaths:
    return RunPaths((root or data_root()) / "runs" / run_id)


def annotation_paths(source_id: str, root: Path | None = None) -> AnnotationPaths:
    return AnnotationPaths((root or data_root()) / "annotations" / source_id)


def evaluator_dir(root: Path | None = None) -> Path:
    return (root or data_root()) / "evaluator"


def cache_dir(root: Path | None = None) -> Path:
    return (root or data_root()) / "cache"
