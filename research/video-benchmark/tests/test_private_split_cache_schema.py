"""Private label validation, split isolation, cache invalidation, schema files."""

import copy
import json
from pathlib import Path

import pytest
from synth import SOURCE, DecodingOcr, FrameSpec, frames, pilot_cfg, timeline, write_layout
from test_samples_leakage import _roles

from vbench.pipeline import run_extract
from vbench.private_labels import build_y
from vbench.source import register_source
from vbench.validate import SCHEMA_NAMES, _validator, private_roles_errors, record_errors, split_isolation_errors

ROOT = Path(__file__).resolve().parents[1]


def test_every_schema_is_valid_draft_2020_12_and_committed_configs_validate():
    for name in SCHEMA_NAMES:
        _validator(name)  # check_schema raises on an invalid schema
    for cfg in (ROOT / "configs").glob("*.json"):
        doc = json.loads(cfg.read_text(encoding="utf-8"))
        name = "layout" if doc["schema"] == "vbench.layout/1" else "pilot_config"
        assert not record_errors(doc, name), cfg.name


@pytest.mark.parametrize("mutate,needle", [
    (lambda d: d["seats"].__setitem__(1, dict(d["seats"][1], seat=1)), "duplicate seats"),
    (lambda d: d["seats"].__setitem__(0, dict(d["seats"][0], role="merlin")), "exceeds composition"),
    (lambda d: d["seats"].__setitem__(0, dict(d["seats"][0], role="unknown")), "unknown role must have verification=unknown"),
    (lambda d: d["seats"].__setitem__(0, dict(d["seats"][0], evidence=[])), "verified without evidence"),
    (lambda d: d["seats"].__setitem__(0, dict(d["seats"][0], verification="unknown")), "is a guess"),
    (lambda d: d["composition"].__setitem__("loyal", 5), "composition sums"),
])
def test_malformed_private_labels_are_rejected(mutate, needle):
    doc = _roles()
    assert not private_roles_errors(doc)
    mutate(doc)
    assert any(needle in e for e in private_roles_errors(doc)), private_roles_errors(doc)


def test_partial_roster_permits_partial_scoring_only_and_never_completes_by_elimination():
    doc = _roles()
    for s in doc["seats"]:
        if s["seat"] in (9, 10):
            s.update(role="unknown", verification="unknown", evidence=[])
    assert not private_roles_errors(doc)
    y = build_y(doc, "x-0000000000000000", "accepted")
    assert y["scoring_mode"] == "partial" and y["coverage"] == {"verified_seats": 8, "total_seats": 10}
    # The two remaining roles (mordred, assassin) are NOT filled in.
    assert y["targets"]["roles"]["9"]["role"] == "unknown" and y["targets"]["roles"]["10"]["role"] == "unknown"
    assert y["constraint_checks"] is None


def test_split_isolation_is_enforced_per_game_group():
    manifest = {
        "schema": "vbench.evaluator_manifest/1",
        "games": [
            {"game_id": "game-0000000001", "group_id": "g1", "split": "dev", "source": {"source_id": "src-000000000001", "video_sha256": "1" * 64}},
            {"game_id": "game-0000000002", "group_id": "g1", "split": "test", "source": {"source_id": "src-000000000002", "video_sha256": "2" * 64}},
        ],
        "samples": [{"sample_id": "x-1", "game_id": "game-0000000001", "group_id": "g1", "split": "test", "dataset": "accepted", "cutoff_sequence": 1, "cutoff_label": "a", "perspective": "public_observer", "x_sha256": "0" * 64, "y_sha256": "0" * 64}],
    }
    errs = split_isolation_errors(manifest)
    assert any("spans splits" in e for e in errs)
    assert any("differs from its game" in e for e in errs)


def test_registering_the_same_game_under_another_split_is_refused(tmp_path, isolated_data_root):
    (isolated_data_root / "sources").mkdir(parents=True)
    (isolated_data_root / "sources" / "v.mp4").write_bytes(b"not really a video")
    cfg = pilot_cfg(write_layout(tmp_path), source={"key": "k", "video_file": "sources/v.mp4", "audio_file": None})
    import vbench.media as media

    orig = media.probe
    media.probe = lambda p: {"stub": True}
    try:
        first = register_source(cfg)
        again = register_source(cfg)
        assert first["game_id"] == again["game_id"]
        with pytest.raises(ValueError, match="跨 split"):
            register_source(dict(cfg, split={"group_id": "grp-synth", "split": "test"}))
    finally:
        media.probe = orig


def test_ocr_cache_reuses_unchanged_crops_and_invalidates_on_crop_or_engine_change(tmp_path):
    layout_path = write_layout(tmp_path)
    cache = tmp_path / "cache"
    specs = timeline((40, FrameSpec(caption=1, label=5)), (40, FrameSpec(caption=2, label=3)), (5, FrameSpec()))
    caps = {1: "甲说的话", 2: "乙说的话"}
    labels = {3: "3 乙", 5: "5 甲"}

    def run(layout, engine):
        cfg = pilot_cfg(layout)
        stats = run_extract(cfg, SOURCE, frames=frames(specs), fps=30.0, engine=engine, cache_root=cache)
        return stats["counters"]

    e1 = DecodingOcr(caps, labels)
    first = run(layout_path, e1)
    assert first.get("ocr_calls", 0) > 0 and e1.calls == first["ocr_calls"]
    e2 = DecodingOcr(caps, labels)
    second = run(layout_path, e2)
    assert e2.calls == 0 and second.get("ocr_calls", 0) == 0
    assert second["ocr_cache_hits"] == first["ocr_calls"] + first.get("ocr_cache_hits", 0)

    moved = json.loads(layout_path.read_text(encoding="utf-8"))
    moved["regions"][0]["rect"] = [79, 150, 161, 20]  # one pixel wider subtitle crop
    moved_path = tmp_path / "moved.json"
    moved_path.write_text(json.dumps(moved), encoding="utf-8")
    e3 = DecodingOcr(caps, labels)
    third = run(moved_path, e3)
    assert third.get("ocr_calls", 0) > 0  # subtitle crops changed -> new OCR

    e4 = DecodingOcr(caps, labels, version="decoding-ocr-2")
    fourth = run(layout_path, e4)
    assert e4.calls == first["ocr_calls"]  # engine version is part of the key


def test_rerun_with_unchanged_inputs_produces_identical_public_artifacts(tmp_path):
    layout_path = write_layout(tmp_path)
    specs = timeline((40, FrameSpec(caption=1, label=5)), (10, FrameSpec()), (40, FrameSpec(caption=2, label=3)), (5, FrameSpec()))
    from vbench.paths import run_paths

    cfg = pilot_cfg(layout_path)
    outs = []
    for _ in range(2):
        run_extract(cfg, SOURCE, frames=frames(specs), fps=30.0, engine=DecodingOcr({1: "甲", 2: "乙"}, {3: "3 乙", 5: "5 甲"}), cache_root=None)
        pub = run_paths(cfg["run_id"]).public
        outs.append({p.name: p.read_bytes() for p in pub.glob("*.jsonl")})
    assert outs[0] == outs[1]
