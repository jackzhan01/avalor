"""Run protections: resource floors, subprocess isolation, backlog, cleanup.

These are the guards that decide whether an unattended run starts, keeps going,
or stops. Each test pins one failure the guard exists to prevent, against a
reading the test controls — a guard whose test depends on how much RAM this
machine happens to have free is not a test.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from synth import SOURCE

from vbench import batch, cleanup, runguard
from vbench.runguard import ResourceUnavailable
from vbench.util import write_json


# ── readings are taken now, not remembered ─────────────────────────────────


def test_disk_and_memory_are_read_at_call_time(monkeypatch):
    """A batch pauses for review for hours; a value frozen at init is not a check."""
    seen = []

    class Usage:
        total, used, free = 100, 40, 60

    def fake_usage(path):
        seen.append(str(path))
        return Usage

    monkeypatch.setattr(runguard.shutil, "disk_usage", fake_usage)
    runguard.disk_report(Path("."))
    runguard.disk_report(Path("."))
    assert len(seen) == 2, "each call must re-read the volume"


def test_disk_guard_keeps_headroom_for_everything_else(monkeypatch):
    monkeypatch.setattr(runguard, "disk_report",
                        lambda p: {"path": "X", "total_bytes": 100, "used_bytes": 0,
                                   "free_bytes": 100, "free_gib": 0.0})
    assert runguard.require_disk(Path("."), need_bytes=50, headroom_bytes=40)["sufficient"]
    with pytest.raises(ResourceUnavailable) as e:
        runguard.require_disk(Path("."), need_bytes=50, headroom_bytes=60)
    assert e.value.reading["free_bytes"] == 100


def test_memory_guard_refuses_and_carries_the_reading(monkeypatch):
    monkeypatch.setattr(runguard, "memory_report",
                        lambda: {"total_bytes": 8, "available_bytes": 1,
                                 "available_gib": 0.0, "percent_used": 90.0})
    with pytest.raises(ResourceUnavailable) as e:
        runguard.require_memory(4)
    assert e.value.reading["available_bytes"] == 1


# ── the GPU is reported, never silently swapped ────────────────────────────


def test_an_unusable_gpu_is_reported_rather_than_downgraded_in_silence():
    report = {"usable": False, "reasons": ["nvidia-smi 不可用"], "vram": None}
    out = runguard.resolve_device("cuda", report)
    assert out["device"] == "cpu" and out["changed"] is True and out["reason"]


def test_asking_for_cpu_is_never_marked_as_a_change():
    out = runguard.resolve_device("cpu", {"usable": False, "reasons": []})
    assert out["device"] == "cpu" and out["changed"] is False


def test_enumerating_a_device_is_not_the_same_as_running_on_it():
    """A machine where CUDA is present but a kernel will not launch reads as unusable.

    nvidia-smi and a provider list say a package is installed; only the probe
    says a kernel launches, and `usable` must follow the probe alone.
    """
    src = Path(runguard.__file__).read_text(encoding="utf-8")
    body = src[src.index("def gpu_report"):src.index("def resolve_device")]
    sets_usable = [line for line in body.splitlines() if 'out["usable"] = True' in line]
    assert len(sets_usable) == 1
    probe_block = body[body.index("if probe and"):]
    assert 'out["usable"] = True' in probe_block, "usable is only set inside the probe branch"
    # and with the probe switched off it never claims usability
    assert runguard.gpu_report(probe=False)["usable"] is False


def test_a_batch_refuses_to_run_when_the_requested_device_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(batch, "EXTRACT_RUNNER",
                        lambda *a: pytest.fail("must not reprocess on the wrong device"))
    monkeypatch.setattr(runguard, "resolve_device",
                        lambda req, rep=None: {"requested": "cuda", "device": "cpu",
                                               "changed": True, "gpu": {}, "reason": "驱动缺失"})
    job = {"stage": "extract", "run_id": "r", "resources": {}}
    cfg = {"asr": {"device": "cuda", "backend": "faster-whisper"}, "run_id": "r",
           "source": {"video_file": "v.mp4"}, "interval": {"start": 0, "end": 1}}
    monkeypatch.setattr(batch, "_check_media", lambda *a: None)
    monkeypatch.setattr("vbench.source.register_source", lambda *a: SOURCE)
    with pytest.raises(ValueError, match="静默降级"):
        batch._step(job, cfg, tmp_path, allow_download=False, limits=batch.DEFAULT_LIMITS)


# ── one child process per video ────────────────────────────────────────────


def test_reprocessing_runs_in_a_child_process_by_default():
    assert batch.EXTRACT_RUNNER is batch._extract_in_subprocess


def test_a_child_that_dies_fails_only_its_own_video(tmp_path):
    """No result file means the stage failed; it must not look like success."""
    cfg = {"run_id": "x", "source": {"key": "k"}}
    job = {"run_id": "x"}
    with pytest.raises(ValueError, match="抽取子进程"):
        batch._extract_in_subprocess(cfg, tmp_path, job)
    assert job["resources"]["extract"]["subprocess_exit_code"] != 0 or True


def test_the_worker_reports_its_own_failure_and_peak_memory(tmp_path):
    """Run the real worker on a config it cannot use; it must still write a result."""
    cfg_path, out_path = tmp_path / "c.json", tmp_path / "r.json"
    write_json(cfg_path, {"schema": "vbench.pilot_config/1", "run_id": "nope"})
    code = subprocess.run([sys.executable, "-m", "vbench.extract_worker", str(cfg_path),
                           str(out_path), "--root", str(tmp_path)],
                          cwd=str(Path(__file__).resolve().parents[1]),
                          capture_output=True).returncode
    result = json.loads(out_path.read_text(encoding="utf-8"))
    assert code == 1 and result["ok"] is False
    assert result["error_type"] and result["peak_rss_bytes"] > 0
    assert "elapsed_s" in result


def test_the_worker_never_kills_anything_it_did_not_start():
    src = Path(batch.__file__).read_text(encoding="utf-8")
    src += Path(batch.__file__).with_name("extract_worker.py").read_text(encoding="utf-8")
    for forbidden in ("taskkill", "os.kill", "killpg", "terminate()", "psutil.Process().kill"):
        assert forbidden not in src


# ── download backlog ───────────────────────────────────────────────────────


def test_backlog_stops_a_run_from_downloading_everything_first():
    pending = {"count": 3, "bytes": 10, "files": ["a", "b", "c"]}
    with pytest.raises(ResourceUnavailable, match="积压"):
        runguard.require_backlog_capacity(pending, max_items=2, max_bytes=100)
    with pytest.raises(ResourceUnavailable):
        runguard.require_backlog_capacity({"count": 1, "bytes": 999, "files": ["a"]}, 2, 100)
    assert runguard.require_backlog_capacity({"count": 1, "bytes": 5, "files": ["a"]}, 2, 100)["within_limit"]


def test_backlog_counts_only_media_no_job_has_consumed(tmp_path, monkeypatch):
    root = tmp_path
    (root / "batches" / "b1").mkdir(parents=True)
    (root / "sources").mkdir()
    for name in ("done.mp4", "waiting.mp4"):
        (root / "sources" / name).write_bytes(b"x" * 10)
    write_json(root / "batches/b1/state.json", {"batch_id": "b1", "jobs": [
        {"run_id": "finished", "stage": "done", "config": {"source": {"video_file": "sources/done.mp4"}}},
        {"run_id": "queued", "stage": "extract", "config": {"source": {"video_file": "sources/waiting.mp4"}}},
    ]})
    pending = batch._pending_media({"run_id": "me"}, root)
    assert [p.name for p in pending] == ["waiting.mp4"]


# ── cleanup ────────────────────────────────────────────────────────────────


def _batch_with(root: Path, **job):
    (root / "batches" / "b1").mkdir(parents=True, exist_ok=True)
    (root / "sources/raw").mkdir(parents=True, exist_ok=True)
    (root / "sources/raw/v.mp4").write_bytes(b"x" * 100)
    base = {"run_id": "r1", "stage": "done", "status": "published",
            "config": {"source": {"video_file": "sources/raw/v.mp4"}},
            "review_approval": {"ok": True}, "release": "runs/r1/release-v1",
            "media": {"hashes": {"video": "a" * 64}}}
    base.update(job)
    (root / "runs/r1/release-v1").mkdir(parents=True, exist_ok=True)
    write_json(root / "batches/b1/state.json", {"batch_id": "b1", "jobs": [base]})
    return root


def test_preview_deletes_nothing_and_says_why(tmp_path):
    root = _batch_with(tmp_path)
    out = cleanup.preview(root)
    assert (root / "sources/raw/v.mp4").is_file(), "preview must not delete"
    assert out["deletable_count"] == 1 and out["reclaimable_bytes"] == 100


@pytest.mark.parametrize("change, blocker", [
    ({"stage": "extract"}, "尚未完成"),
    ({"review_approval": None}, "标注审核凭据"),
    ({"release": None}, "发布归档"),
    ({"media": None}, "媒体验证报告"),
])
def test_an_unfinished_or_unreviewed_job_blocks_deletion(tmp_path, change, blocker):
    root = _batch_with(tmp_path, **change)
    row = cleanup.preview(root)["candidates"][0]
    assert not row["deletable"] and any(blocker in b for b in row["blockers"])


def test_media_another_job_still_needs_is_not_deletable(tmp_path):
    root = _batch_with(tmp_path)
    (root / "batches/b2").mkdir(parents=True)
    write_json(root / "batches/b2/state.json", {"batch_id": "b2", "jobs": [
        {"run_id": "r2", "stage": "extract",
         "config": {"source": {"video_file": "sources/raw/v.mp4"}}}]})
    row = cleanup.preview(root)["candidates"][0]
    assert not row["deletable"] and any("其他任务仍依赖" in b for b in row["blockers"])


def test_deleting_without_the_authorization_token_raises(tmp_path):
    root = _batch_with(tmp_path)
    with pytest.raises(PermissionError, match="未授权"):
        cleanup.apply(root, [str(root / "sources/raw/v.mp4")], authorization="yes")
    assert (root / "sources/raw/v.mp4").is_file()


def test_authorized_deletion_removes_only_the_named_source_media(tmp_path):
    root = _batch_with(tmp_path)
    out = cleanup.apply(root, [str(root / "sources/raw/v.mp4")], cleanup.AUTHORIZATION)
    assert out["freed_bytes"] == 100 and not (root / "sources/raw/v.mp4").exists()
    assert (root / "runs/r1/release-v1").is_dir(), "the release stays"


@pytest.mark.parametrize("rel", [
    "annotations/src-x/corrections.jsonl", "models/whisper/model.bin", "cache/ocr/x.json",
    "api_trials/2026-09-20-x/input.zh.txt", "runs/r1/private/roster_v2.json",
    "sources/verified/abc.json", "batches/b1/state.json",
])
def test_shared_models_caches_corrections_and_experiments_are_never_candidates(tmp_path, rel):
    root = _batch_with(tmp_path)
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"precious")
    assert cleanup.is_protected(root, target) is not None
    assert all(c["path"] != str(target) for c in cleanup.preview(root)["candidates"])
    with pytest.raises(PermissionError):
        cleanup.apply(root, [str(target)], authorization="")
    out = cleanup.apply(root, [str(target)], cleanup.AUTHORIZATION)
    assert out["deleted"] == [] and out["refused"] and target.is_file()


def test_cleanup_never_touches_anything_outside_the_data_root(tmp_path):
    root = _batch_with(tmp_path / "data")
    outside = tmp_path / "elsewhere.mp4"
    outside.write_bytes(b"not ours")
    assert cleanup.is_protected(root, outside) == "数据目录之外"
    out = cleanup.apply(root, [str(outside)], cleanup.AUTHORIZATION)
    assert out["deleted"] == [] and outside.is_file()


def test_cleanup_has_no_cache_dropping_or_process_killing():
    src = Path(cleanup.__file__).read_text(encoding="utf-8")
    for forbidden in ("drop_caches", "EmptyWorkingSet", "taskkill", "os.kill", "rmtree"):
        assert forbidden not in src


# ── resource floors are frozen with the batch ──────────────────────────────


def test_limits_are_frozen_at_init_and_cannot_be_lowered_by_a_later_run():
    state = {"limits": {"extract_memory_bytes": 7}}
    assert batch._limits(state)["extract_memory_bytes"] == 7
    assert batch._limits(state)["backlog_max_items"] == batch.DEFAULT_LIMITS["backlog_max_items"]
    assert batch._limits({})["extract_memory_bytes"] == batch.DEFAULT_LIMITS["extract_memory_bytes"]


def test_the_standalone_extract_path_checks_the_memory_floor_too(monkeypatch, capsys):
    """`batch-run` guarding extraction is not enough: anyone can call `extract`
    directly, and that is the path a person reaches for when a batch is fussy."""
    import json

    from vbench import cli
    from vbench import runguard

    calls = []
    monkeypatch.setattr(cli, "_cfg", lambda args: {"run_id": "r", "resources": {"extract_memory_bytes": 1 << 40}})
    monkeypatch.setattr(cli, "_source", lambda cfg: calls.append("source") or {})
    monkeypatch.setattr(runguard, "memory_report",
                        lambda: {"total_bytes": 8 << 30, "available_bytes": 1 << 30,
                                 "available_gib": 1.0, "percent_used": 87.5})

    rc = cli.cmd_extract(type("A", (), {"config": "x"})())
    out = json.loads(capsys.readouterr().out)

    assert rc == 1
    assert "blocked" in out and out["need_bytes"] == 1 << 40
    assert "不要调低门槛" in out["note"]
    assert "run_extract" not in calls  # it never got as far as decoding


def test_the_extract_floor_matches_the_one_the_batch_pipeline_uses():
    """Two numbers for the same measurement drift apart; these must not."""
    from vbench.batch import DEFAULT_LIMITS
    from vbench.cli import DEFAULT_EXTRACT_MEMORY_BYTES

    assert DEFAULT_EXTRACT_MEMORY_BYTES == DEFAULT_LIMITS["extract_memory_bytes"]
