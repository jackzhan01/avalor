"""Immutable directory publication; single-file atomic writes are not a transaction."""

from contextlib import contextmanager
from pathlib import Path
import re
import shutil
import tempfile

from filelock import FileLock

from .util import sha256_file


def safe_name(value: str) -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", value):
        raise ValueError("标识只能包含小写字母、数字、下划线与连字符")
    return value


def tree_hashes(path: Path) -> dict[str, str]:
    return {p.relative_to(path).as_posix(): sha256_file(p) for p in sorted(path.rglob("*")) if p.is_file()}


@contextmanager
def immutable_directory(target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(target.parent / ("." + target.name + ".publish.lock")), timeout=0):
        staging = Path(tempfile.mkdtemp(prefix=".publish-", dir=target.parent))
        try:
            yield staging
            if target.exists():
                if tree_hashes(target) != tree_hashes(staging):
                    raise FileExistsError(f"拒绝覆盖已有产物，请使用新 revision：{target}")
            else:
                staging.rename(target)
        finally:
            # Only our own mkdtemp directory is removed; published/history paths are untouched.
            if staging.exists():
                shutil.rmtree(staging)
