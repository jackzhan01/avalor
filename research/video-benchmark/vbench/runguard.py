"""Resource checks for an unattended local run, measured when they are asked.

Every reading here is taken at call time. A batch can sit paused for review for
hours and resume onto a machine whose disk filled up or whose GPU is now busy
with someone else's job, so a snapshot recorded when the batch was frozen is
worse than no reading at all: it looks like a check and isn't one.

Nothing in here frees anything. Dropping caches or killing processes to make a
number look better would take resources away from whatever else is running on
this machine, including other agents; a run that does not fit should stop and
say so.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class ResourceUnavailable(RuntimeError):
    """Not enough of something to start. Carries the reading that decided it."""

    def __init__(self, message: str, reading: dict):
        super().__init__(message)
        self.reading = reading


def disk_report(path: Path) -> dict:
    """Free space on the volume that holds `path`, right now."""
    target = Path(path)
    while not target.exists() and target != target.parent:
        target = target.parent
    usage = shutil.disk_usage(target)
    return {"path": str(target), "total_bytes": usage.total, "used_bytes": usage.used,
            "free_bytes": usage.free, "free_gib": round(usage.free / 2**30, 2)}


def require_disk(path: Path, need_bytes: int, headroom_bytes: int = 5 * 2**30) -> dict:
    """Refuse to start a download that would leave the volume with no headroom.

    `headroom_bytes` is what stays free *after* the download: a disk filled to
    the last byte breaks every other writer on the machine, not just this batch.
    """
    report = disk_report(path)
    report.update(need_bytes=need_bytes, headroom_bytes=headroom_bytes)
    report["sufficient"] = report["free_bytes"] >= need_bytes + headroom_bytes
    if not report["sufficient"]:
        raise ResourceUnavailable(
            f"磁盘空间不足：{report['path']} 可用 {report['free_gib']} GiB，"
            f"本次需要 {need_bytes / 2**30:.2f} GiB 并保留 {headroom_bytes / 2**30:.2f} GiB 余量", report)
    return report


def memory_report() -> dict:
    """Host memory right now. `available` is what can be had without swapping."""
    import psutil

    vm = psutil.virtual_memory()
    return {"total_bytes": vm.total, "available_bytes": vm.available,
            "available_gib": round(vm.available / 2**30, 2), "percent_used": vm.percent}


def require_memory(need_bytes: int) -> dict:
    report = memory_report()
    report.update(need_bytes=need_bytes)
    report["sufficient"] = report["available_bytes"] >= need_bytes
    if not report["sufficient"]:
        raise ResourceUnavailable(
            f"可用内存不足：现有 {report['available_gib']} GiB，"
            f"本阶段需要 {need_bytes / 2**30:.2f} GiB", report)
    return report


def gpu_report(probe: bool = True) -> dict:
    """What the GPU stack can actually do, not what is merely installed.

    `probe` runs a real tiny computation on the device. Enumerating a provider
    proves a package is importable; it does not prove a kernel will launch, and
    the difference is exactly the case that matters — a machine where CUDA is
    present but unusable would otherwise be reported as GPU-capable.
    """
    out: dict = {"nvidia_smi": None, "vram": None, "ctranslate2_cuda_devices": None,
                 "onnxruntime_providers": None, "probe": None, "usable": False,
                 "reasons": []}
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,memory.free",
             "--format=csv,noheader,nounits"], capture_output=True, timeout=20)
        if res.returncode == 0 and res.stdout.strip():
            name, total, used, free = [x.strip() for x in res.stdout.decode().splitlines()[0].split(",")]
            out["nvidia_smi"] = name
            out["vram"] = {"total_mib": int(total), "used_mib": int(used), "free_mib": int(free)}
        else:
            out["reasons"].append("nvidia-smi 无输出或返回非零")
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        out["reasons"].append(f"nvidia-smi 不可用：{type(e).__name__}")

    try:
        import ctranslate2

        out["ctranslate2_cuda_devices"] = ctranslate2.get_cuda_device_count()
    except Exception as e:  # noqa: BLE001
        out["reasons"].append(f"ctranslate2 查询失败：{type(e).__name__}")

    try:
        import onnxruntime

        out["onnxruntime_providers"] = list(onnxruntime.get_available_providers())
    except Exception as e:  # noqa: BLE001
        out["reasons"].append(f"onnxruntime 查询失败：{type(e).__name__}")

    if probe and (out["ctranslate2_cuda_devices"] or 0) > 0:
        try:
            import numpy as np

            from ctranslate2 import StorageView
            StorageView.from_array(np.zeros((2, 2), dtype=np.float32)).to_device(  # type: ignore[attr-defined]
                __import__("ctranslate2").Device.cuda)
            out["probe"] = "ctranslate2 cuda storage ok"
            out["usable"] = True
        except Exception as e:  # noqa: BLE001
            out["probe"] = f"failed: {type(e).__name__}: {e}"
            out["reasons"].append("CUDA 设备可枚举但实际分配失败")
    elif probe:
        out["probe"] = "skipped: no cuda device reported"
    return out


def resolve_device(requested: str, report: dict | None = None) -> dict:
    """Decide the device to use, and say so out loud when it is not the one asked for.

    Never silently downgrades: a caller that asked for cuda and gets cpu has to
    read `changed=True` and the reason out of this result, so the run record
    shows which backend actually produced the data.
    """
    report = gpu_report() if report is None else report
    if requested != "cuda":
        return {"requested": requested, "device": requested, "changed": False, "gpu": report}
    if report["usable"]:
        return {"requested": "cuda", "device": "cuda", "changed": False, "gpu": report}
    return {"requested": "cuda", "device": "cpu", "changed": True, "gpu": report,
            "reason": "；".join(report["reasons"]) or "GPU 探测未通过"}


def peak_rss_bytes() -> int:
    """Peak resident memory of this process, for the run record."""
    import psutil

    info = psutil.Process().memory_info()
    return int(getattr(info, "peak_wset", None) or getattr(info, "rss", 0))


def backlog(paths: list[Path]) -> dict:
    """Media that is downloaded but not yet consumed, with its size on disk."""
    present = [p for p in paths if Path(p).is_file()]
    return {"count": len(present), "bytes": sum(Path(p).stat().st_size for p in present),
            "files": [str(p) for p in present]}


def require_backlog_capacity(pending: dict, max_items: int, max_bytes: int) -> dict:
    """Stop downloading when unprocessed media has piled up.

    Downloading the whole list first and processing later turns one failed
    stage into a disk full of files nobody has looked at.
    """
    report = dict(pending, max_items=max_items, max_bytes=max_bytes)
    report["within_limit"] = pending["count"] <= max_items and pending["bytes"] <= max_bytes
    if not report["within_limit"]:
        raise ResourceUnavailable(
            f"待处理媒体积压超限：{pending['count']} 个 / {pending['bytes'] / 2**30:.2f} GiB，"
            f"上限 {max_items} 个 / {max_bytes / 2**30:.2f} GiB；先处理完再下载", report)
    return report
