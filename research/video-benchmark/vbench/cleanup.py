"""What a finished batch may delete, and everything it may not.

Disk pressure is a bad reason to lose evidence. Source video is the only thing
here that can be fetched again; a correction ledger, a private roster, a crop
that a label cites or a paid experiment's input cannot. So the rule is narrow:
deletion is opt-in, one file at a time, only for source media, only when that
media's own job is finished and archived, and only when no other job in any
batch still points at it.

`preview()` never deletes. `apply()` deletes only what `preview()` marked
deletable and only with an explicit authorisation token from the operator.
"""

from __future__ import annotations

from pathlib import Path

from .util import read_json

# Directories this module will not touch under any flag. Shared caches and
# models are used by other runs and other people on this machine; annotations,
# corrections, private rosters and past experiments are not reproducible.
PROTECTED = ("annotations", "models", "cache", "api_trials", "batches", "runs",
             "sources/verified", "evaluator", "variants")

AUTHORIZATION = "DELETE-SOURCE-MEDIA"


def _rel(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def is_protected(root: Path, path: Path) -> str | None:
    """The protected prefix a path falls under, or None."""
    try:
        rel = _rel(root, Path(path))
    except ValueError:
        return "数据目录之外"
    for prefix in PROTECTED:
        if rel == prefix or rel.startswith(prefix + "/"):
            return prefix
    return None


def _all_batch_states(root: Path) -> list[dict]:
    out = []
    for state in sorted((root / "batches").glob("*/state.json")):
        try:
            out.append(read_json(state))
        except Exception:  # noqa: BLE001 — an unreadable state means "assume it depends on everything"
            out.append({"unreadable": str(state), "jobs": []})
    return out


def _media_of(job: dict, root: Path) -> list[Path]:
    cfg = job.get("config") or {}
    src = cfg.get("source") or {}
    return [root / p for p in (src.get("video_file"), src.get("audio_file")) if p]


def preview(root: Path, batch_id: str | None = None) -> dict:
    """What could be deleted, what could not, and the reason for each.

    Reads every batch's state, not just this one: the same upload can be the
    input of a second batch, and a file another job still needs is not garbage.
    """
    root = Path(root).resolve()
    states = _all_batch_states(root)
    depended: dict[str, list[str]] = {}
    for state in states:
        for job in state.get("jobs", []):
            if job.get("stage") == "done":
                continue
            for media in _media_of(job, root):
                depended.setdefault(str(media), []).append(
                    f"{state.get('batch_id', '?')}/{job.get('run_id', '?')}:{job.get('stage')}")

    rows = []
    for state in states:
        if batch_id and state.get("batch_id") != batch_id:
            continue
        for job in state.get("jobs", []):
            for media in _media_of(job, root):
                blockers = []
                if job.get("stage") != "done":
                    blockers.append(f"该局尚未完成（stage={job.get('stage')}, status={job.get('status')}）")
                if not job.get("review_approval"):
                    blockers.append("缺少标注审核凭据")
                if not job.get("release"):
                    blockers.append("产物尚未发布归档")
                elif not (root / job["release"]).is_dir():
                    blockers.append("发布目录不存在")
                if not job.get("media"):
                    blockers.append("缺少媒体验证报告")
                others = [d for d in depended.get(str(media), [])]
                if others:
                    blockers.append("其他任务仍依赖：" + "、".join(sorted(set(others))))
                guarded = is_protected(root, media)
                if guarded:
                    blockers.append(f"位于受保护目录 {guarded}")
                if not media.is_file():
                    blockers.append("文件不存在")
                rows.append({
                    "path": str(media),
                    "relative": _rel(root, media) if media.exists() else None,
                    "bytes": media.stat().st_size if media.is_file() else 0,
                    "run_id": job.get("run_id"), "batch_id": state.get("batch_id"),
                    "deletable": not blockers, "blockers": blockers,
                    "media_sha256": (job.get("media") or {}).get("hashes", {}),
                })
    deletable = [r for r in rows if r["deletable"]]
    return {
        "root": str(root),
        "authorization_required": AUTHORIZATION,
        "protected_prefixes": list(PROTECTED),
        "candidates": rows,
        "deletable_count": len(deletable),
        "reclaimable_bytes": sum(r["bytes"] for r in deletable),
        "note": ("预览不删除任何东西。只有源视频/音频会进入候选；模型、缓存、标注、修正链、"
                 "私有名单和历史实验永远不在候选里。"),
    }


def apply(root: Path, paths: list[str], authorization: str, batch_id: str | None = None) -> dict:
    """Delete exactly the named source media, after re-checking every guard.

    The preview is re-computed here rather than trusted from the caller: the
    state on disk can move between looking and deleting, and this is the step
    that cannot be undone.
    """
    if authorization != AUTHORIZATION:
        raise PermissionError(
            f"未授权：删除源媒体需要显式授权串 {AUTHORIZATION!r}，当前收到 {authorization!r}")
    report = preview(root, batch_id)
    allowed = {r["path"]: r for r in report["candidates"] if r["deletable"]}
    deleted, refused = [], []
    for raw in paths:
        path = str(Path(raw).resolve())
        row = allowed.get(path)
        if row is None:
            match = next((r for r in report["candidates"] if r["path"] == path), None)
            refused.append({"path": path,
                            "reason": match["blockers"] if match else ["不在本次预览的候选里"]})
            continue
        size = Path(path).stat().st_size
        Path(path).unlink()
        deleted.append({"path": path, "bytes": size, "run_id": row["run_id"],
                        "media_sha256": row["media_sha256"]})
    return {"deleted": deleted, "refused": refused,
            "freed_bytes": sum(d["bytes"] for d in deleted),
            "note": "源媒体可以按 BVID 重新获取；被拒绝的项保持原样。"}
