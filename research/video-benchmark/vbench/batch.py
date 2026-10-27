"""Serial, resumable local batch runner with explicit human gates and no paid calls.

Frozen configs and code fingerprints make resume fail closed after changes.
Approvals attest to the exact evidence bytes, not merely to a run name.
"""

from __future__ import annotations

import copy
import json
import platform
from importlib.metadata import PackageNotFoundError, version
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock
from jsonschema import validate

from .paths import PROJECT_ROOT, annotation_paths, data_root, run_paths
from .publish import immutable_directory, safe_name, tree_hashes
from .util import read_json, sha256_file, sha256_json, write_json

# Resource floors, checked against a reading taken at that moment.
#
# Measured 2026-09-21 on BV1dc8F6qE5K (37 min, 1080p HEVC) rather than guessed:
# a video+audio pair downloads to ~0.21 GiB; faster-whisper large-v3 on CUDA
# peaked at 3169 MiB host RSS and held ~3571 MiB of VRAM, transcribing at 2.1x
# realtime. The floors sit just above those, because OCR runs alongside.
DEFAULT_LIMITS = {
    "download_need_bytes": 3 * 2**30,
    "download_headroom_bytes": 5 * 2**30,
    "extract_memory_bytes": 7 * 2**29,   # 3.5 GiB; measured ASR peak was 3.10 GiB
    "extract_vram_mib": 4000,            # measured ASR usage was ~3571 MiB
    "backlog_max_items": 2,
    "backlog_max_bytes": 6 * 2**30,
}


def _limits(state_or_job: dict) -> dict:
    """Floors for this batch. Frozen at init so a run cannot lower them later."""
    return {**DEFAULT_LIMITS, **(state_or_job.get("limits") or {})}

LAYOUT_CHECKS = ("public_crops_safe", "seat_redaction", "full_board_extent", "vote_colors", "rules_basis")
REVIEW_CHECKS = ("speech_and_seats", "all_objective_events", "private_labels", "live_boundaries",
                 "cutoff_safety", "overlap_group")


def code_fingerprint() -> str:
    files = [p for folder in ("vbench", "scripts")
             for p in (PROJECT_ROOT / folder).rglob("*.py")]
    files += list((PROJECT_ROOT / "vbench/schemas").glob("*.json"))
    files += list(PROJECT_ROOT.glob("requirements*.txt"))
    return sha256_json({p.relative_to(PROJECT_ROOT).as_posix(): sha256_file(p) for p in sorted(files)})


def _root(root=None) -> Path:
    return Path(root or data_root()).resolve()


def runtime_info() -> dict:
    packages = {}
    for name in ("av", "numpy", "opencv-python", "rapidocr-onnxruntime", "onnxruntime",
                 "faster-whisper", "ctranslate2", "filelock", "jsonschema", "yt-dlp"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    return {"python": platform.python_version(), "system": platform.system(),
            "machine": platform.machine(), "packages": packages}


def _check_runtime(state: dict) -> None:
    if state["runtime"] != runtime_info():
        raise ValueError("运行环境已变化，请在当前环境新建批次")


def _state_path(batch_id: str, root: Path) -> Path:
    return root / "batches" / safe_name(batch_id) / "state.json"


def _lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    # One worker per data root prevents interleaving ledger/view updates across batches.
    return FileLock(str(root / ".batch-worker.lock"), timeout=0)


def _inside(root: Path, rel: str) -> Path:
    path = (root / rel).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError("数据路径必须位于数据目录内部")
    return path


def _save(state: dict, root: Path, event: str, run_id: str | None = None) -> None:
    state["history"].append({"at": datetime.now(timezone.utc).isoformat(), "event": event, "run_id": run_id})
    write_json(_state_path(state["batch_id"], root), state)


def init_batch(spec_path: Path, root=None) -> dict:
    from .pipeline import load_config, resolve_layout

    root = _root(root)
    spec_path = Path(spec_path).resolve()
    spec = read_json(spec_path)
    validate(spec, read_json(PROJECT_ROOT / "vbench/schemas/batch.schema.json"))
    state_path = _state_path(spec["batch_id"], root)
    with _lock(root):
        if state_path.exists():
            raise FileExistsError("批次已存在；使用 batch-run 恢复，不要重新初始化")
        state = {"schema": "vbench.batch_state/1", "batch_id": spec["batch_id"],
                 "code_sha256": code_fingerprint(), "runtime": runtime_info(),
                 "limits": {**DEFAULT_LIMITS, **(spec.get("limits") or {})},
                 "jobs": [], "history": []}
        seen = set()
        for entry in spec["jobs"]:
            run_id = safe_name(entry["run_id"])
            if run_id in seen or run_paths(run_id, root).root.exists():
                raise ValueError(f"run_id 重复或已有历史产物，请选新名称：{run_id}")
            for previous in (root / "batches").glob("*/state.json"):
                if any(j["run_id"] == run_id for j in read_json(previous)["jobs"]):
                    raise ValueError(f"run_id 已由另一批次保留：{run_id}")
            seen.add(run_id)
            cfg = load_config(spec_path.parent / entry["config"])
            cfg["run_id"] = run_id
            cfg["asr"].update(device=spec.get("device", "cpu"),
                              compute_type="int8" if spec.get("device", "cpu") == "cpu" else "float16")
            cfg["corrections"] = {"inherit_shared": False, "run_scoped": True}
            if cfg.get("timeline"):
                raise ValueError("批次使用标准 annotations 路径，不接受外部 timeline 路径覆盖")
            for key in ("video_file", "audio_file"):
                if cfg["source"].get(key):
                    _inside(root, cfg["source"][key])
            if cfg["interval"]["start"] >= cfg["interval"]["end"]:
                raise ValueError("抽取区间起止无效")
            layout = resolve_layout(cfg).doc
            state["jobs"].append({"run_id": run_id, "config": cfg, "layout": layout,
                                  "config_sha256": sha256_json([cfg, layout]), "stage": "media",
                                  "status": "pending", "attempts": 0})
        _save(state, root, "initialized")
        return state


def status(batch_id: str, root=None) -> dict:
    return read_json(_state_path(batch_id, _root(root)))


def _config(job: dict, root: Path, batch_id: str) -> dict:
    if sha256_json([job["config"], job["layout"]]) != job["config_sha256"]:
        raise ValueError("冻结配置被修改，请新建批次")
    directory = root / "batches" / batch_id / job["run_id"]
    layout_path = directory / "layout.json"
    write_json(layout_path, job["layout"])
    cfg = copy.deepcopy(job["config"])
    cfg["layout"] = str(layout_path)
    write_json(directory / "config.json", cfg)
    return cfg


def _media_paths(cfg: dict, root: Path):
    src = cfg["source"]
    return (_inside(root, src["video_file"]),
            _inside(root, src["audio_file"]) if src.get("audio_file") else None)


def _check_media(job: dict, cfg: dict, root: Path):
    from .media_gate import media_hashes

    if media_hashes(*_media_paths(cfg, root)) != job["media"]["hashes"]:
        raise ValueError("媒体哈希变化，旧审核失效；请新建批次")


def evidence_fingerprint(cfg: dict, source_id: str, root: Path) -> str:
    from .source import load_manifest

    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    files = [ann.run_corrections(cfg["run_id"]), ann.ledger(cfg["run_id"]), ann.root / "coverage.json",
             ann.root / f"turn_boundaries.{cfg['run_id']}.jsonl", ann.root / "private/roster_v2.json",
             ann.root / f"review_scope.{cfg['run_id']}.json"]
    games = [g for g in load_manifest(root)["games"] if g["source"]["source_id"] == source_id]
    return sha256_json({"public": tree_hashes(run.public), "evaluator_games": games, "annotations": {
        p.relative_to(root).as_posix(): sha256_file(p) if p.exists() else None for p in files}})


def review_gate(cfg: dict, source_id: str, root: Path) -> dict:
    from .agent_pairs import build_document, _load_public
    from .private_labels import load_roster_v2
    from .validate import record_errors
    from .views import build_views

    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    for path in (run.public / "utterances.jsonl", run.public / "events.jsonl", ann.root / "coverage.json",
                 ann.root / "private/roster_v2.json"):
        if not path.is_file():
            raise ValueError(f"缺少审核材料：{path}")
    coverage = read_json(ann.root / "coverage.json")
    errs = record_errors(coverage, "coverage")
    live = coverage.get("live_game_interval")
    if errs or not live or not (cfg["interval"]["start"] <= live[0] < live[1] <= cfg["interval"]["end"]):
        raise ValueError("必须提供经过审核且位于抽取区间内的 live_game_interval")
    roster = load_roster_v2(ann.root / "private/roster_v2.json")
    if (len(roster["seats"]) != cfg["rules"]["player_count"]
            or any(s["verification"] != "verified" for s in roster["seats"])):
        raise ValueError("发布前必须逐座位核实身份")
    report = build_views(cfg, source_id, root)
    if any(report[k] for k in ("stale", "conflicts", "invalid_after_apply")):
        raise ValueError("修正存在过期、冲突或无效项，须先处理")
    pub = _load_public(cfg, source_id, root)
    for rec in pub["utterances"] + pub["events"]:
        if rec.get("review_status") not in ("accepted", "rejected"):
            raise ValueError("仍有未处理的候选记录；需明确接受或拒绝")
        if rec.get("review_status") == "accepted" and (
                rec.get("sequence") is None or rec["availability"]["status"] != "anchored"):
            raise ValueError("接受的记录缺少公开时间锚点或序号，不可静默丢弃")
    built = build_document(pub, cfg, "accepted")
    if built["errors"] or not built["doc"]["blocks"] or not any(b["speech"] for b in built["doc"]["blocks"]):
        raise ValueError("公开记录为空或无法完整对账")
    if not any(b["audit"]["events"] for b in built["blocks"]):
        raise ValueError("没有客观事件，不可发布")
    return {"blocks": len(built["blocks"]), "coverage_status": "see_review_receipt"}


def approve(batch_id: str, run_id: str, kind: str, receipt_path: Path, root=None) -> dict:
    root = _root(root)
    if kind not in ("layout", "review"):
        raise ValueError("未知审核类型")
    receipt = read_json(receipt_path)
    checks = LAYOUT_CHECKS if kind == "layout" else REVIEW_CHECKS
    if not receipt.get("reviewer") or not receipt.get("note") or not all(receipt.get("checks", {}).get(k) is True for k in checks):
        raise ValueError(f"需真实审核人、说明及全部检查项：{checks}")
    with _lock(root):
        state = status(batch_id, root)
        _check_runtime(state)
        if state["code_sha256"] != code_fingerprint():
            raise ValueError("代码已变化；请新建批次")
        job = next(j for j in state["jobs"] if j["run_id"] == run_id)
        expected = "layout" if kind == "layout" else "review"
        if job["stage"] != expected and not (kind == "review" and job["stage"] == "publish"):
            raise ValueError(f"当前阶段不是 {expected}")
        cfg = _config(job, root, batch_id)
        _check_media(job, cfg, root)
        if receipt.get("config_sha256") != job["config_sha256"] or receipt.get("media_hashes") != job["media"]["hashes"]:
            raise ValueError("审核凭据不匹配冻结配置或媒体")
        if kind == "layout":
            times = receipt.get("checked_times", [])
            lo, hi = cfg["interval"]["start"], cfg["interval"]["end"]
            if (len(set(times)) < 3 or min(times) < lo or max(times) > hi
                    or min(times) > lo + (hi-lo)*0.25 or max(times) < lo + (hi-lo)*0.75):
                raise ValueError("布局至少核查三个时刻，覆盖抽取区间前后四分之一")
            job["stage"] = "extract"
        else:
            if receipt.get("coverage_status") not in ("edited_unknown", "known_gaps", "reviewed_complete"):
                raise ValueError("需明确视频过程完整性，不能以未检测到 gap 代替完整")
            if not isinstance(receipt.get("open_questions"), list) or not all(isinstance(q, str) for q in receipt["open_questions"]):
                raise ValueError("需明确 open_questions 列表")
            review_gate(cfg, job["source_id"], root)
            fingerprint = evidence_fingerprint(cfg, job["source_id"], root)
            if receipt.get("evidence_sha256") != fingerprint:
                raise ValueError("审核凭据已过期；先 batch-review-info 获取当前材料指纹")
            job["review_sha256"] = fingerprint
            job["stage"] = "publish"
        job[kind + "_approval"] = receipt
        job.pop("error", None)
        job["status"] = "pending"
        _save(state, root, f"{kind}_approved", run_id)
        return state


def review_info(batch_id: str, run_id: str, root=None) -> dict:
    root = _root(root)
    with _lock(root):
        state = status(batch_id, root)
        _check_runtime(state)
        if state["code_sha256"] != code_fingerprint():
            raise ValueError("代码已变化；请新建批次")
        job = next(j for j in state["jobs"] if j["run_id"] == run_id)
        if job["stage"] not in ("review", "publish"):
            raise ValueError("尚未进入标注审核阶段")
        cfg = _config(job, root, batch_id)
        _check_media(job, cfg, root)
        review_gate(cfg, job["source_id"], root)
        return {"config_sha256": job["config_sha256"], "media_hashes": job["media"]["hashes"],
                "evidence_sha256": evidence_fingerprint(cfg, job["source_id"], root),
                "required_checks": REVIEW_CHECKS}


def _pending_media(job: dict, root: Path) -> list[Path]:
    """Verified-but-unextracted media across every batch on this data root.

    Counted from state, not from a directory listing: a file that some other
    batch has already consumed is not backlog, and one this batch downloaded
    three stages ago still is.
    """
    out: list[Path] = []
    for state_path in sorted((root / "batches").glob("*/state.json")):
        try:
            state = read_json(state_path)
        except Exception:  # noqa: BLE001
            continue
        for other in state.get("jobs", []):
            if other.get("run_id") == job.get("run_id") or other.get("stage") in ("media", "done"):
                continue
            src = (other.get("config") or {}).get("source") or {}
            out += [root / f for f in (src.get("video_file"), src.get("audio_file")) if f]
    return out


def _extract_in_subprocess(cfg: dict, root: Path, job: dict) -> dict:
    """Reprocess one video in a child process so its models die with it.

    Failure here is this video's failure. The child is never killed by pid from
    outside — that is how a batch ends up stopping somebody else's work.
    """
    import subprocess
    import sys
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        cfg_path, out_path = Path(tmp) / "config.json", Path(tmp) / "result.json"
        write_json(cfg_path, cfg)
        cmd = [sys.executable, "-m", "vbench.extract_worker", str(cfg_path), str(out_path),
               "--root", str(root)]
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), capture_output=True)
        if not out_path.exists():
            tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
            raise ValueError(f"抽取子进程未产出结果（退出码 {proc.returncode}）：{' / '.join(tail)}")
        result = read_json(out_path)
    job.setdefault("resources", {})["extract"] = {
        "elapsed_s": result.get("elapsed_s"), "peak_rss_bytes": result.get("peak_rss_bytes"),
        "gpu_after": result.get("gpu_after"), "subprocess_exit_code": proc.returncode,
    }
    if not result.get("ok"):
        raise ValueError(f"抽取子进程失败：{result.get('error_type')}: {result.get('error')}")
    job["source_id"] = result["source_id"]
    return result["stats"]


# Which function reprocesses a video. Production is the child process; a test
# may swap it, and `test_batch_runguard.py` asserts what the default is.
EXTRACT_RUNNER = None  # set below, once _extract_in_subprocess exists


def _step(job: dict, cfg: dict, root: Path, allow_download: bool, limits: dict | None = None) -> None:
    limits = limits or DEFAULT_LIMITS
    from .media_gate import verify_media
    from .source import acquire, register_source

    if job["stage"] == "media":
        from .runguard import backlog, disk_report, require_backlog_capacity, require_disk

        video, audio = _media_paths(cfg, root)
        if allow_download and not video.is_file():
            # Both guards read the machine now. A batch can resume days later
            # onto a fuller disk, so a value frozen at init would not be a check.
            job.setdefault("resources", {})["disk_before_download"] = require_disk(
                root / "sources/raw", limits["download_need_bytes"], limits["download_headroom_bytes"])
            job["resources"]["backlog_before_download"] = require_backlog_capacity(
                backlog(_pending_media(job, root)), limits["backlog_max_items"],
                limits["backlog_max_bytes"])
            acquire(cfg, root)
        elif allow_download:
            job.setdefault("resources", {})["disk_before_download"] = dict(
                disk_report(root / "sources/raw"), skipped="媒体已在本地，未触发下载")
        job["media"] = verify_media(video, audio, root / "sources/verified")
        if cfg["interval"]["end"] > job["media"]["streams"]["video"]["duration_s"] + 0.1:
            raise ValueError("抽取范围超过媒体时长")
        job["source_id"] = register_source(cfg, root)["source_id"]
        job.update(stage="layout", status="needs_review")
        return
    _check_media(job, cfg, root)
    source = register_source(cfg, root)
    run = run_paths(cfg["run_id"], root)
    if job["stage"] == "extract":
        from .runguard import require_memory, resolve_device

        device = resolve_device(cfg["asr"].get("device", "cpu"))
        job.setdefault("resources", {})["device"] = device
        if device["changed"]:
            # Never silently fall back: the record has to say which backend ran.
            raise ValueError(f"请求 {device['requested']} 但不可用（{device.get('reason')}）；"
                             f"请改用 CPU 批次或修复驱动后新建批次，不在本次静默降级")
        job["resources"]["memory_before_extract"] = require_memory(limits["extract_memory_bytes"])
        if device["device"] == "cuda":
            vram = (device["gpu"].get("vram") or {}).get("free_mib")
            job["resources"]["vram_before_extract"] = device["gpu"].get("vram")
            if vram is not None and vram < limits["extract_vram_mib"]:
                raise ValueError(f"显存不足：可用 {vram} MiB，需要 {limits['extract_vram_mib']} MiB")
        stats = EXTRACT_RUNNER(cfg, root, job)
        if stats["validation_error_count"] or stats["decode"]["corrupt_packets"]:
            raise ValueError("抽取校验失败；保留诊断产物，不进入审核完成态")
        if not stats["outputs"]["utterances"] or not stats["outputs"]["board_events"]:
            raise ValueError("字幕或板面事件为空，请校准新布局并新建批次")
        if cfg["asr"]["backend"] != "none" and stats["asr"]["mode"] == "unavailable":
            raise ValueError("ASR 不可用；请先安装本地模型或检查设备")
        job.update(stage="review", status="needs_review")
    elif job["stage"] == "publish":
        if evidence_fingerprint(cfg, source["source_id"], root) != job["review_sha256"]:
            raise ValueError("审核后材料发生变化，拒绝发布；需重新审核")
        # Publish a release only after every requested cutoff and label passes.
        review_gate(cfg, source["source_id"], root)
        receipt = job["review_approval"]
        target = run.root / "release-v1"
        with immutable_directory(target) as staging:
            from .agent_pairs import _build_agent_pairs
            result = _build_agent_pairs(cfg, source, "accepted", root, "public_observer", None,
                                         receipt["open_questions"], "batch-v1", [], staging / "pairs")
            if result["skipped"] or len(result["pairs"]) != 1 + len(cfg["cutoffs"]):
                raise ValueError("截止点未全部生成，拒绝发布")
            if evidence_fingerprint(cfg, source["source_id"], root) != job["review_sha256"]:
                raise ValueError("发布期间证据发生变化，拒绝发布")
            write_json(staging / "quality.json", {"review": receipt, "media": job["media"],
                       "evidence_sha256": job["review_sha256"], "config_sha256": job["config_sha256"],
                       "code_sha256": code_fingerprint(), "not_independent_audio_verification": True})
        job.update(stage="done", status="published", release=str(target.relative_to(root)),
                   release_hashes=tree_hashes(target))


def run_batch(batch_id: str, root=None, allow_download=False, retry_failed=False) -> dict:
    root = _root(root)
    with _lock(root):
        state = status(batch_id, root)
        _check_runtime(state)
        if state["code_sha256"] != code_fingerprint():
            raise ValueError("代码与冻结批次不同；请新建批次，不静默复用旧审核")
        for job in state["jobs"]:
            if job["stage"] == "done":
                if tree_hashes(root / job["release"]) != job["release_hashes"]:
                    raise ValueError("已发布目录被修改或丢失")
                continue
            if job["stage"] in ("layout", "review") or (job["status"] == "failed" and not retry_failed):
                continue
            try:
                cfg = _config(job, root, batch_id)
                job["attempts"] += 1
                job["status"] = "running"
                _save(state, root, "stage_started", job["run_id"])
                _step(job, cfg, root, allow_download, _limits(state))
                job.pop("error", None)
                _save(state, root, "stage_finished", job["run_id"])
            except Exception as exc:
                job["status"] = "failed"
                # Download subprocess output may contain signed URLs; never persist it.
                job["error"] = {"type": type(exc).__name__, "message": str(exc) if isinstance(exc, (ValueError, FileNotFoundError, FileExistsError)) else "阶段失败；检查本地环境与诊断文件"}
                _save(state, root, "stage_failed", job["run_id"])
        return state


def cli(args) -> int:
    if args.cmd == "resources":
        from .runguard import disk_report, gpu_report, memory_report, resolve_device

        gpu = gpu_report(probe=not args.no_gpu_probe)
        result = {"limits": DEFAULT_LIMITS, "disk": disk_report(_root(None) / "sources/raw"),
                  "memory": memory_report(), "gpu": gpu,
                  "asr_device_if_cuda_requested": resolve_device("cuda", gpu),
                  "note": "全部为调用此刻的实测值；不复用任何历史快照。"}
    elif args.cmd == "cleanup-preview":
        from .cleanup import preview

        result = preview(_root(None), args.batch)
    elif args.cmd == "cleanup-apply":
        from .cleanup import apply as cleanup_apply

        result = cleanup_apply(_root(None), args.path, args.authorize, args.batch)
    elif args.cmd == "batch-init":
        result = init_batch(Path(args.file))
    elif args.cmd == "batch-status":
        result = status(args.batch)
    elif args.cmd == "batch-run":
        result = run_batch(args.batch, allow_download=args.download, retry_failed=args.retry_failed)
    elif args.cmd == "batch-review-info":
        result = review_info(args.batch, args.run_id)
    else:
        result = approve(args.batch, args.run_id, args.kind, Path(args.receipt))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(j["status"] == "failed" for j in result.get("jobs", [])) else 0


EXTRACT_RUNNER = _extract_in_subprocess
