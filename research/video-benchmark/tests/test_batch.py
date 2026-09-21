"""Batch safety tests; fixtures are synthetic, never promoted as pilot evidence."""

import av
import numpy as np
import pytest
from filelock import Timeout
from synth import SOURCE, pilot_cfg, write_layout
from test_agent_blocks import _run_pairs, game, seg, ts

from vbench import batch, media_gate
from vbench.paths import annotation_paths, data_root, run_paths
from vbench.publish import immutable_directory
from vbench.timeline import select_atoms
from vbench.util import read_json, sha256_file, write_bytes, write_json, write_jsonl


def setup_batch(tmp_path, monkeypatch, missing_cutoff=False):
    cfg = pilot_cfg(write_layout(tmp_path))
    cfg["rules"]["mission_team_sizes"][2] = 5
    cfg["cutoffs"] = [
        {"label": "first vote", "after": {"event": {"type": "vote_outcome", "mission": 1, "proposal_index": 1}}},
        {"label": "mission result", "after": {"event": {"type": "mission_outcome", "mission": 5 if missing_cutoff else 1}}},
    ]
    cfg_path = tmp_path / "pilot.json"
    write_json(cfg_path, cfg)
    spec = {"schema": "vbench.batch/1", "batch_id": "test-batch", "jobs": [
        {"config": "pilot.json", "run_id": "batch-test"}]}
    spec_path = tmp_path / "batch.json"
    write_json(spec_path, spec)
    state = batch.init_batch(spec_path)
    write_bytes(data_root() / "synthetic.mp4", b"mock video")
    report = {"version": 1, "hashes": media_gate.media_hashes(data_root() / "synthetic.mp4", None),
              "streams": {"video": {"duration_s": 100}}, "verdict": "ok"}
    monkeypatch.setattr(media_gate, "verify_media", lambda *a: report)
    monkeypatch.setattr("vbench.source.register_source", lambda *a: SOURCE)
    return state, cfg_path, spec_path


def receipt(tmp_path, state, kind, **extra):
    job = state["jobs"][0]
    doc = {"reviewer": "synthetic test", "note": "not real review evidence",
           "config_sha256": job["config_sha256"], "media_hashes": job["media"]["hashes"],
           "checks": dict.fromkeys(batch.LAYOUT_CHECKS if kind == "layout" else batch.REVIEW_CHECKS, True),
           "checked_times": [0, 50, 99], "coverage_status": "edited_unknown", "open_questions": []}
    doc.update(extra)
    path = tmp_path / f"{kind}.json"
    write_json(path, doc)
    return path


def seeded_review(tmp_path, monkeypatch, missing_cutoff=False):
    state, _, _ = setup_batch(tmp_path, monkeypatch, missing_cutoff)
    state = batch.run_batch("test-batch")
    batch.approve("test-batch", "batch-test", "layout", receipt(tmp_path, state, "layout"))

    def extract(cfg, source, root):
        # Reuse validated test roster/manifest, not any real player identities.
        _run_pairs(tmp_path / "fixture", 0)
        utts, events = game()
        run = run_paths(cfg["run_id"], root)
        write_jsonl(run.public / "utterances.jsonl", utts)
        write_jsonl(run.public / "events.jsonl", events)
        write_jsonl(run.public / "speaker_segments.jsonl", [])
        write_json(annotation_paths(source["source_id"], root).root / "coverage.json", {
            "schema": "vbench.coverage/1", "reviewer": "fixture", "status": "provisional_self_review",
            "gaps": [], "live_game_interval": [0, 100]})
        return {"validation_error_count": 0, "decode": {"corrupt_packets": 0},
                "outputs": {"utterances": len(utts), "board_events": len(events)}, "asr": {"mode": "none"}}

    monkeypatch.setattr("vbench.pipeline.run_extract", extract)
    monkeypatch.setattr("vbench.review.build_review_queue", lambda *a: None)
    state = batch.run_batch("test-batch")
    assert state["jobs"][0]["stage"] == "review", state
    return state


def test_boundary_filters_intro_outro_and_crossing_cards():
    utts = [seg(1, "intro", 1, 3, 1), seg(2, "cross start", 9, 11, 1),
            seg(3, "public", 10, 20, 1), seg(4, "cross end", 19, 21, 1),
            seg(5, "outro", 20, 22, 1)]
    events = [ts(6, 1, 1, 1, [1, 2, 3], 9), ts(7, 1, 1, 1, [1, 2, 3], 10),
              ts(8, 1, 1, 1, [1, 2, 3], 20)]
    atoms, _ = select_atoms(utts, events, "accepted", live_start=10, live_end=20)
    assert [a["seq"] for a in atoms] == [3, 7]


def test_immutable_publish_idempotent_and_refuses_overwrite(tmp_path):
    target = tmp_path / "release"
    for _ in range(2):
        with immutable_directory(target) as stage:
            write_bytes(stage / "input", b"original")
    with pytest.raises(FileExistsError):
        with immutable_directory(target) as stage:
            write_bytes(stage / "input", b"changed")
    assert (target / "input").read_bytes() == b"original"


def test_interrupted_publish_leaves_no_partial_release(tmp_path):
    target = tmp_path / "release"
    with pytest.raises(RuntimeError):
        with immutable_directory(target) as stage:
            write_bytes(stage / "input", b"incomplete")
            raise RuntimeError("interrupted")
    assert not target.exists()
    assert not list(tmp_path.glob(".publish-*"))


@pytest.mark.parametrize("payload", [b"", b"not a media file"])
def test_invalid_existing_media_is_not_success(tmp_path, payload):
    from vbench.source import acquire
    path = data_root() / "broken.mp4"
    write_bytes(path, payload)
    with pytest.raises((ValueError, av.error.InvalidDataError)):
        acquire({"source": {"video_file": "broken.mp4", "audio_file": None}})


def test_real_decode_and_content_bound_cache(tmp_path, monkeypatch):
    path = tmp_path / "tiny.mp4"
    with av.open(str(path), "w") as out:
        stream = out.add_stream("mpeg4", rate=10)
        stream.width = stream.height = 32
        stream.pix_fmt = "yuv420p"
        for i in range(30):
            frame = av.VideoFrame.from_ndarray(np.full((32, 32, 3), i, dtype=np.uint8), format="rgb24")
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    report = media_gate.verify_media(path, None, tmp_path / "reports")
    assert report["streams"]["video"]["frames"] == 30
    monkeypatch.setattr(media_gate, "decode_stream", lambda *a: pytest.fail("cache was not reused"))
    assert media_gate.verify_media(path, None, tmp_path / "reports") == report
    write_bytes(path, b"changed")
    with pytest.raises(pytest.fail.Exception):
        media_gate.verify_media(path, None, tmp_path / "reports")


def test_audio_duration_mismatch_blocks(tmp_path, monkeypatch):
    video, audio = tmp_path / "v", tmp_path / "a"
    write_bytes(video, b"v")
    write_bytes(audio, b"a")
    monkeypatch.setattr(media_gate, "decode_stream", lambda p, kind: {"duration_s": 10 if kind == "video" else 7})
    with pytest.raises(ValueError, match="时长差"):
        media_gate.verify_media(video, audio, tmp_path / "reports")


def test_missing_overlap_evidence_is_not_different_games():
    from scripts.check_overlap import run_fingerprint
    with pytest.raises(ValueError, match="缺少"):
        run_fingerprint("missing")
    run = run_paths("empty")
    write_jsonl(run.public / "utterances.jsonl", [])
    write_jsonl(run.public / "events.jsonl", [])
    with pytest.raises(ValueError, match="不足"):
        run_fingerprint("empty")


def test_init_cpu_freezes_without_changing_config(tmp_path, monkeypatch):
    state, cfg_path, spec_path = setup_batch(tmp_path, monkeypatch)
    assert state["jobs"][0]["config"]["asr"]["compute_type"] == "int8"
    assert read_json(cfg_path)["asr"] == {"backend": "none"}
    with pytest.raises(FileExistsError):
        batch.init_batch(spec_path)
    spec = read_json(spec_path)
    spec["batch_id"] = "another"
    write_json(spec_path, spec)
    with pytest.raises(ValueError, match="保留"):
        batch.init_batch(spec_path)


@pytest.mark.parametrize("bad_path", ["../outside.mp4", "../data"])
def test_media_cannot_escape_data_root(tmp_path, monkeypatch, bad_path):
    _, cfg_path, spec_path = setup_batch(tmp_path, monkeypatch)
    cfg = read_json(cfg_path)
    cfg["source"]["video_file"] = bad_path
    write_json(cfg_path, cfg)
    spec = read_json(spec_path)
    spec.update(batch_id="another", jobs=[{"config": "pilot.json", "run_id": "new-run"}])
    write_json(spec_path, spec)
    with pytest.raises(ValueError, match="目录内部"):
        batch.init_batch(spec_path)


def test_media_stops_at_layout_no_download_by_default(tmp_path, monkeypatch):
    setup_batch(tmp_path, monkeypatch)
    monkeypatch.setattr("vbench.source.acquire", lambda *a: pytest.fail("unexpected download"))
    state = batch.run_batch("test-batch")
    assert state["jobs"][0]["stage"] == "layout"
    assert batch.run_batch("test-batch") == state


def test_worker_lock_excludes_second_worker(tmp_path, monkeypatch):
    setup_batch(tmp_path, monkeypatch)
    with batch._lock(data_root()):
        with pytest.raises(Timeout):
            batch.run_batch("test-batch")


def test_changed_code_blocks_resume(tmp_path, monkeypatch):
    setup_batch(tmp_path, monkeypatch)
    monkeypatch.setattr(batch, "code_fingerprint", lambda: "changed")
    with pytest.raises(ValueError, match="代码"):
        batch.run_batch("test-batch")


def test_changed_runtime_blocks_resume(tmp_path, monkeypatch):
    setup_batch(tmp_path, monkeypatch)
    monkeypatch.setattr(batch, "runtime_info", lambda: {"changed": True})
    with pytest.raises(ValueError, match="运行环境"):
        batch.run_batch("test-batch")


def test_download_verified_before_final_name(tmp_path, monkeypatch):
    from vbench.source import acquire
    root = data_root()
    cfg = {"source": {"video_file": "download.mp4", "download_formats": {"video": "test"}, "url": "synthetic"}}
    def download(url, fmt, target, **kw):
        assert target.name == "download.mp4.download"
        write_bytes(target, b"new stream")
        return {"returncode": 0, "stalled_no_growth": False, "hit_max_seconds": False}
    monkeypatch.setattr("scripts.fetch_media.attempt", download)
    def reject(*a):
        raise ValueError("bad decode")
    monkeypatch.setattr(media_gate, "verify_media", reject)
    with pytest.raises(ValueError, match="bad decode"):
        acquire(cfg)
    assert not (root / "download.mp4").exists()
    assert (root / "download.mp4.download").exists()
    monkeypatch.setattr(media_gate, "verify_media", lambda *a: {"verdict": "ok"})
    acquire(cfg)
    assert (root / "download.mp4").read_bytes() == b"new stream"


def test_normal_asr_never_fetches_missing_weights(tmp_path, monkeypatch):
    from vbench.asr import AsrConfig, transcribe_interval
    from vbench.cache import StageCache
    import faster_whisper
    monkeypatch.setattr("vbench.media.load_audio_mono16k", lambda *a: np.zeros(16000))
    def missing(*a, **kw):
        assert kw["local_files_only"] is True
        raise FileNotFoundError("weights not installed")
    monkeypatch.setattr(faster_whisper, "WhisperModel", missing)
    with pytest.raises(FileNotFoundError, match="weights"):
        transcribe_interval(tmp_path / "a", "a" * 64, 0, 1, AsrConfig(), tmp_path, StageCache(tmp_path / "cache"))


def test_retry_is_explicit(tmp_path, monkeypatch):
    setup_batch(tmp_path, monkeypatch)
    valid = media_gate.verify_media
    def fail(*a):
        raise RuntimeError("signed-secret-url-must-not-be-saved")
    monkeypatch.setattr(media_gate, "verify_media", fail)
    failed = batch.run_batch("test-batch")
    assert failed["jobs"][0]["status"] == "failed"
    assert "signed-secret" not in str(failed)
    monkeypatch.setattr(media_gate, "verify_media", valid)
    assert batch.run_batch("test-batch") == failed
    assert batch.run_batch("test-batch", retry_failed=True)["jobs"][0]["stage"] == "layout"


@pytest.mark.parametrize("override", [{"checked_times": [50]}, {"config_sha256": "wrong"}, {"checks": {}}])
def test_layout_requires_bound_complete_receipt(tmp_path, monkeypatch, override):
    setup_batch(tmp_path, monkeypatch)
    state = batch.run_batch("test-batch")
    with pytest.raises(ValueError):
        batch.approve("test-batch", "batch-test", "layout", receipt(tmp_path, state, "layout", **override))


def test_changed_media_invalidates_approval(tmp_path, monkeypatch):
    setup_batch(tmp_path, monkeypatch)
    state = batch.run_batch("test-batch")
    write_bytes(data_root() / "synthetic.mp4", b"different")
    with pytest.raises(ValueError, match="媒体哈希"):
        batch.approve("test-batch", "batch-test", "layout", receipt(tmp_path, state, "layout"))


def test_real_review_export_resume_and_tamper_detection(tmp_path, monkeypatch):
    state = seeded_review(tmp_path, monkeypatch)
    info = batch.review_info("test-batch", "batch-test")
    batch.approve("test-batch", "batch-test", "review", receipt(tmp_path, state, "review", evidence_sha256=info["evidence_sha256"]))
    state = batch.run_batch("test-batch")
    job = state["jobs"][0]
    assert job["status"] == "published", job.get("error")
    target = data_root() / job["release"]
    assert len(read_json(target / "pairs/manifest.json")["pairs"]) == 3
    label = read_json(target / "pairs/full/label.json")
    assert label["input_sha256"] == sha256_file(target / "pairs/full/input.zh.txt")
    assert batch.run_batch("test-batch") == state
    write_bytes(target / "pairs/full/input.zh.txt", b"tampered")
    with pytest.raises(ValueError, match="已发布"):
        batch.run_batch("test-batch")


def test_missing_requested_cutoff_prevents_entire_release(tmp_path, monkeypatch):
    state = seeded_review(tmp_path, monkeypatch, missing_cutoff=True)
    info = batch.review_info("test-batch", "batch-test")
    batch.approve("test-batch", "batch-test", "review", receipt(tmp_path, state, "review", evidence_sha256=info["evidence_sha256"]))
    job = batch.run_batch("test-batch")["jobs"][0]
    assert job["status"] == "failed"
    assert "截止点" in job["error"]["message"]
    assert not (run_paths("batch-test").root / "release-v1").exists()


def test_review_change_blocks_publication_and_can_be_reapproved(tmp_path, monkeypatch):
    state = seeded_review(tmp_path, monkeypatch)
    info = batch.review_info("test-batch", "batch-test")
    batch.approve("test-batch", "batch-test", "review", receipt(tmp_path, state, "review", evidence_sha256=info["evidence_sha256"]))
    coverage_path = annotation_paths(SOURCE["source_id"]).root / "coverage.json"
    cov = read_json(coverage_path)
    cov["reviewer"] = "updated review"
    write_json(coverage_path, cov)
    failed = batch.run_batch("test-batch")
    assert failed["jobs"][0]["status"] == "failed"
    assert not (run_paths("batch-test").root / "release-v1").exists()
    info = batch.review_info("test-batch", "batch-test")
    batch.approve("test-batch", "batch-test", "review", receipt(tmp_path, failed, "review", evidence_sha256=info["evidence_sha256"]))
    assert batch.run_batch("test-batch")["jobs"][0]["status"] == "published"


@pytest.mark.parametrize("failure", ["empty", "unreviewed", "unanchored", "roster"])
def test_review_rejects_incomplete_evidence(tmp_path, monkeypatch, failure):
    state = seeded_review(tmp_path, monkeypatch)
    utts, events = game()
    if failure == "empty":
        utts = []
    elif failure == "unreviewed":
        utts[0]["review_status"] = "needs_review"
    elif failure == "unanchored":
        utts[0]["availability"].update(status="unanchored", public_at=None)
    else:
        path = annotation_paths(SOURCE["source_id"]).root / "private/roster_v2.json"
        roster = read_json(path)
        roster["seats"][0]["verification"] = "unverified"
        write_json(path, roster)
    write_jsonl(run_paths("batch-test").public / "utterances.jsonl", utts)
    with pytest.raises(Exception):
        batch.review_info("test-batch", "batch-test")
