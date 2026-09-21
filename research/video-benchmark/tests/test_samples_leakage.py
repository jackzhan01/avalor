"""Cutoffs, availability, X/Y separation and non-interference."""

import ast
import json
from pathlib import Path

import numpy as np
import pytest
from synth import LAYOUT, SOURCE, FrameSpec, frames, pilot_cfg, render, timeline, write_layout

from vbench.changes import SamplingConfig, scan
from vbench.corrections import make_correction
from vbench.export import export_samples
from vbench.layout import layout_errors, load_layout, public_crops
from vbench.paths import annotation_paths, run_paths
from vbench.samples import CutoffError, UnsupportedPerspective, build_x, sample_id_for, x_bytes
from vbench.source import load_manifest, save_manifest
from vbench.util import array_sha256, write_json, write_jsonl
from vbench.validate import record_errors

from test_corrections_ledger import board_event, utt

RULES = pilot_cfg(Path("x"))["rules"]


def _seq(rec, n):
    rec = dict(rec, sequence=n, ordering={"status": "in_sequence"}, review_status="accepted")
    return rec


def _event(eid, etype, payload, public_at, n):
    e = board_event(eid, etype)
    e["payload"] = payload
    e["availability"] = {"status": "anchored", "public_at": public_at, "basis": "reveal", "evidence_refs": [{"kind": "video_moment", "id": "r", "video_time": public_at}]}
    return _seq(e, n)


def _history():
    u1 = _seq(utt("utt-0000000000000001", "我不是派西", 1.0, 2.0, seat=1), 1)
    u2 = _seq(utt("utt-0000000000000002", "我就发一个3 4 带上我自己", 3.0, 5.0, seat=10), 2)
    team = _event("evt-0000000000000001", "team_selection", {"mission": 1, "proposal_index": 1, "leader_seat": 10, "team_seats": [3, 4, 10], "forced": False}, 5.0, 3)
    # A sentence that starts before the vote reveal and ends after it.
    u3 = _seq(utt("utt-0000000000000003", "这个车我肯定下票因为", 5.5, 9.0, seat=2), 5)
    vote = _event("evt-0000000000000002", "vote_outcome", {"mission": 1, "proposal_index": 1, "result": "rejected", "tally_text": "0:10", "explicit": True}, 8.0, 4)
    return [u1, u2, u3], [team, vote]


def _x(utts, events, cutoff, dataset="accepted"):
    return build_x(utterances=utts, events=events, cutoff_sequence=cutoff, rules=RULES, sample_id=sample_id_for("game-0123456789", dataset, "public_observer", cutoff), dataset=dataset)


def test_cutoff_excludes_speech_spanning_the_cutoff_and_future_records():
    utts, events = _history()
    x = _x(utts, events, 4)
    kinds = [(h["sequence"], h["kind"]) for h in x["history"]]
    assert kinds == [(1, "utterance"), (2, "utterance"), (3, "event"), (4, "event")]
    assert not any(h.get("text") == "这个车我肯定下票因为" for h in x["history"])
    assert not record_errors(x, "sample_x")


def test_delayed_result_is_absent_until_its_availability_and_unanchored_never_appears():
    utts, events = _history()
    x = _x(utts, events, 3)
    assert [h["sequence"] for h in x["history"]] == [1, 2, 3]
    events[1]["availability"] = {"status": "unanchored", "public_at": None, "basis": "board"}
    x = _x(utts, events, 5)
    assert all(h.get("type") != "vote_outcome" for h in x["history"])


def test_future_suffix_changes_leave_x_byte_identical():
    utts, events = _history()
    a = x_bytes(_x(utts, events, 3))
    utts2, events2 = _history()
    utts2[2]["caption"]["text"] = "完全不同的未来发言"
    events2[1]["payload"]["tally_text"] = "4:6"
    events2.append(_event("evt-0000000000000009", "mission_outcome", {"mission": 1, "result": "fail", "fail_count": 1}, 30.0, 6))
    assert x_bytes(_x(utts2, events2, 3)) == a


def test_draft_and_accepted_datasets_differ_and_draft_is_marked():
    utts, events = _history()
    utts[1]["review_status"] = "needs_review"
    acc = _x(utts, events, 3, "accepted")
    dra = _x(utts, events, 3, "draft")
    assert acc["draft"] is False and dra["draft"] is True
    assert 2 not in [h["sequence"] for h in acc["history"]]
    assert 2 in [h["sequence"] for h in dra["history"]]
    with pytest.raises(CutoffError):
        utts[1]["review_status"] = "rejected"
        _x(utts, events, 2, "draft")


def test_unsupported_perspective_is_rejected_not_placeholdered():
    utts, events = _history()
    with pytest.raises(UnsupportedPerspective):
        build_x(utterances=utts, events=events, cutoff_sequence=3, rules=RULES, sample_id="x-0000000000000000", dataset="accepted", perspective="player:4")


def test_x_validator_catches_source_leaks_and_roles_but_allows_public_role_claims():
    utts, events = _history()
    x = _x(utts, events, 3)
    x["history"][0]["text"] = "看 BV19D7565EZg 的剪辑"
    errs = record_errors(x, "sample_x", forbidden_strings=["秘密标题"])
    assert any("forbidden value" in e for e in errs)
    x = _x(utts, events, 3)
    x["history"].append({"sequence": 3, "kind": "event", "type": "stance", "payload": {"role": "merlin"}})
    assert any("forbidden key" in e for e in record_errors(x, "sample_x"))
    x = _x(utts, events, 3)
    x["history"][-1] = {"sequence": 3, "kind": "event", "type": "role_claim", "payload": {"holder": {"kind": "speaker", "seat": 1}, "role": "percival", "claimed": False}}
    assert not [e for e in record_errors(x, "sample_x") if "forbidden" in e]


def _roles(role_for_4="percival", verified=True):
    comp = dict(RULES["role_composition"])
    assign = {1: "loyal", 2: "loyal", 3: "oberon", 4: role_for_4, 5: "loyal", 6: "merlin", 7: "loyal", 8: "morgana", 9: "mordred", 10: "assassin"}
    return {
        "schema": "vbench.private_roles/1", "game_id": SOURCE["game_id"], "player_count": 10, "composition": comp, "composition_basis": "test",
        "seats": [{"seat": s, "role": r, "verification": "verified" if verified else "candidate",
                   "evidence": [{"kind": "roster_crop", "video_time": 1.0, "crop_sha256": "0" * 64, "observed_text": r}]} for s, r in assign.items()],
    }


def _setup_views(cfg, utts, events, root):
    run = run_paths(cfg["run_id"], root)
    write_jsonl(run.views / "accepted" / "utterances.jsonl", utts)
    write_jsonl(run.views / "accepted" / "events.jsonl", events)
    save_manifest({"schema": "vbench.evaluator_manifest/1", "games": [{"game_id": SOURCE["game_id"], "group_id": "grp-synth", "split": "dev", "source": {"source_id": SOURCE["source_id"], "video_sha256": SOURCE["video_sha256"], "audio_sha256": None}}], "samples": []}, root)


def test_private_label_changes_leave_x_byte_identical_but_change_y(tmp_path, isolated_data_root):
    cfg = pilot_cfg(write_layout(tmp_path), cutoffs=[{"label": "after vote", "after": {"event": {"type": "vote_outcome", "mission": 1, "proposal_index": 1}}}])
    utts, events = _history()
    _setup_views(cfg, utts, events, isolated_data_root)
    ann = annotation_paths(SOURCE["source_id"], isolated_data_root)
    run = run_paths(cfg["run_id"], isolated_data_root)
    outs = []
    for roles in (_roles("percival"), _roles("percival", verified=False)):
        # Swap in a different private file (same composition, different verification).
        write_json(ann.private_roles, roles)
        res = export_samples(cfg, SOURCE, "accepted")
        sid = res[0]["sample_id"]
        outs.append(((run.samples / "accepted" / "X" / f"{sid}.json").read_bytes(), (run.samples / "accepted" / "Y" / f"{sid}.json").read_bytes()))
    assert outs[0][0] == outs[1][0]
    assert outs[0][1] != outs[1][1]
    y_partial = json.loads(outs[1][1])
    assert y_partial["scoring_mode"] == "none" and y_partial["coverage"]["verified_seats"] == 0
    assert b"BV1xx411c7mD" not in outs[0][0] and "秘密标题".encode() not in outs[0][0]


def test_export_refuses_unsupported_perspective(tmp_path, isolated_data_root):
    cfg = pilot_cfg(write_layout(tmp_path), cutoffs=[])
    with pytest.raises(UnsupportedPerspective):
        export_samples(cfg, SOURCE, "accepted", perspective="player:3")


def test_private_region_pixels_do_not_change_public_crops_or_segmentation(tmp_path):
    layout = load_layout(write_layout(tmp_path))
    a = render(FrameSpec(caption=1, label=5, roster=1, camera=1))
    b = render(FrameSpec(caption=1, label=5, roster=200, camera=77))
    assert not np.array_equal(a, b)
    ca, cb = public_crops(a, layout), public_crops(b, layout)
    assert set(ca) == {"subtitle", "speaker_label", "board"}
    assert all(array_sha256(ca[k]) == array_sha256(cb[k]) for k in ca)
    specs_a = timeline((30, FrameSpec(caption=1, label=5)), (30, FrameSpec(caption=2, label=3)))
    specs_b = [FrameSpec(s.caption, s.label, s.jitter, s.board, roster=i % 7, camera=i % 5) for i, s in enumerate(specs_a)]
    cfg = SamplingConfig.from_dict(pilot_cfg(tmp_path)["sampling"])
    sa, _ = scan(frames(specs_a), layout, cfg, 30.0)
    sb, _ = scan(frames(specs_b), layout, cfg, 30.0)
    bounds = lambda s: {k: [(x.start_index, x.end_index) for x in v] for k, v in s.items()}
    assert bounds(sa) == bounds(sb)


def test_layout_rejects_public_region_overlapping_private_region_without_mask():
    doc = json.loads(json.dumps(LAYOUT))
    doc["regions"][2]["rect"] = [250, 10, 60, 120]  # board now overlaps the roster
    assert any("overlaps private region roster" in e for e in layout_errors(doc))
    doc["regions"][2]["masks"] = [[250, 115, 60, 15]]
    assert not layout_errors(doc)


PUBLIC_MODULES = ["pipeline", "timeline", "timeline_build", "blocks", "block_text", "render", "changes", "captions", "board", "ocr", "asr", "utterances", "speech_events", "samples", "review", "views", "ledger", "corrections", "layout", "media", "dense", "report"]


def test_public_code_paths_never_import_the_private_layer():
    pkg = Path(__file__).resolve().parents[1] / "vbench"

    def imports(mod):
        tree = ast.parse((pkg / f"{mod}.py").read_text(encoding="utf-8"))
        out = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                out.add(node.module.split(".")[-1])
            elif isinstance(node, ast.Import):
                out |= {a.name.split(".")[-1] for a in node.names}
        return out

    seen, stack = set(), list(PUBLIC_MODULES)
    while stack:
        m = stack.pop()
        if m in seen or not (pkg / f"{m}.py").exists():
            continue
        seen.add(m)
        stack += list(imports(m))
    assert "private_labels" not in seen
    assert "export" not in seen
    for m in PUBLIC_MODULES:
        # No public module may even name the private answer file.
        assert "private_roles" not in (pkg / f"{m}.py").read_text(encoding="utf-8"), m
