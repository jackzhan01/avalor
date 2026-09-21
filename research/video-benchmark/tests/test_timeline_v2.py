"""Timeline revision: speech turns, objective events, readable transcript, X v2."""

import copy
import json
from pathlib import Path

import pytest
from synth import SOURCE, DecodingOcr, FrameSpec, frames, pilot_cfg, timeline, write_layout
from test_corrections_ledger import board_event, utt

from vbench.captions import CaptionConfig, OcrPart, build_captions
from vbench.corrections import apply_corrections, make_correction
from vbench.migrate import migrate_corrections
from vbench.render import render_markdown, speech_paragraphs
from vbench.samples import CutoffError, build_x_v2, x_bytes
from vbench.timeline import TurnConfig, assemble, build_game_record, segment_fingerprint, select_atoms
from vbench.timeline_build import check_render_consistency, make_boundary_correction, segment_accounting
from vbench.util import sha256_json, write_jsonl
from vbench.validate import record_errors

RULES = pilot_cfg(Path("x"))["rules"]
CFG = {"run_id": "t", "interval": {"start": 0, "end": 1000}, "rules": RULES, "turns": {"max_gap_s": 4.0, "review_pause_s": 1.5}}


class Seq:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


def seg(n, text, start, end, seat, status="accepted", **kw):
    u = utt(f"utt-{n:016x}", text, start, end, seat=seat)
    u.update(sequence=n, ordering={"status": "in_sequence"}, review_status=status, origin="machine", applied_corrections=[])
    u.update(kw)
    return u


def ev(n, etype, payload, public_at, key=None, status="accepted"):
    e = board_event(f"evt-{n:016x}", etype)
    e.update(payload=payload, sequence=n, ordering={"status": "in_sequence"}, review_status=status, stable_key=key or f"board:{n}:{etype}")
    e["availability"] = {"status": "anchored", "public_at": public_at, "basis": "reveal", "evidence_refs": [{"kind": "video_moment", "id": "r", "video_time": public_at}]}
    return e


def record(utts, events, coverage=None, decisions=(), dataset="accepted"):
    rec, rep = build_game_record(cfg=CFG, source_id="src-aaaaaaaaaaaa", dataset=dataset, utterances=utts, events=events, machine_utterances=utts,
                                 coverage=coverage, review_scope={"intervals": [[0, 1000]]}, boundary_decisions=list(decisions), audit={})
    errs = record_errors(rec, "game_record")
    assert not errs, errs[:5]
    return rec


def speech(rec):
    return [(it["seat"], it["text"], it["continues_turn"]) for it in rec["timeline"] if it["kind"] == "speech"]


def game():
    """Seat 10 talks and picks a team, votes reveal mid-sentence of seat 1, A-B-A later."""
    utts = [
        seg(1, "好那从这边发言", 0.0, 1.3, 10),
        seg(2, "我不是派西", 1.3, 2.2, 1),
        seg(3, "先过吧", 2.3, 3.0, 1),
        seg(4, "我就发一个3", 3.1, 4.0, 10),
        seg(5, "4带上我自己好吧", 4.0, 5.0, 10),
        seg(7, "是吧", 6.0, 6.5, 1),
        seg(9, "不是你也可以听发言", 6.5, 7.8, 1),
        seg(10, "我插一句", 7.8, 8.4, 2),
        seg(11, "你继续说", 8.4, 9.0, 1),
    ]
    events = [
        ev(6, "team_selection", {"mission": 1, "proposal_index": 1, "leader_seat": 10, "team_seats": [3, 4, 10], "forced": False}, 5.0),
        ev(8, "vote_outcome", {"mission": 1, "proposal_index": 1, "result": "rejected", "tally_text": "0:10", "explicit": True}, 6.5),
    ]
    return utts, events


def test_many_subtitle_cards_become_one_contribution_with_traceable_text():
    utts, events = game()
    rec = record(utts, events)
    first_1 = [it for it in rec["timeline"] if it["kind"] == "speech" and it["seat"] == 1][0]
    assert first_1["text"] == "我不是派西 先过吧"
    assert [s["segment_id"] for s in first_1["segments"]] == ["utt-0000000000000002", "utt-0000000000000003"]
    assert not segment_accounting(rec, utts, "accepted")


def test_a_b_a_stays_chronological_and_the_resumption_is_a_new_turn():
    utts, events = game()
    rec = record(utts, events)
    tail = speech(rec)[-3:]
    # '是吧' | vote reveal | '不是你也可以听发言' (part 2 of seat 1's turn) -> seat 2 -> seat 1 again
    assert [(s, t) for s, t, _ in tail] == [(1, "不是你也可以听发言"), (2, "我插一句"), (1, "你继续说")]
    turns = [it["turn_id"] for it in rec["timeline"] if it["kind"] == "speech"]
    assert turns[-1] != turns[-3]


def test_event_during_speech_splits_the_turn_into_parts_without_moving_or_duplicating_words():
    utts, events = game()
    rec = record(utts, events)
    kinds = [(it["kind"], it.get("type") or it.get("text")) for it in rec["timeline"]]
    i = kinds.index(("event", "vote_outcome"))
    assert kinds[i - 1] == ("speech", "是吧") and kinds[i + 1] == ("speech", "不是你也可以听发言")
    before, after = rec["timeline"][i - 1], rec["timeline"][i + 1]
    assert before["turn_id"] == after["turn_id"] and after["continues_turn"] and after["part_index"] == 1
    assert after["boundary_before"]["reasons"] == ["objective_event"]
    words = " ".join(it["text"] for it in rec["timeline"] if it["kind"] == "speech")
    assert words.count("是吧") == 1 and words.count("不是你也可以听发言") == 1
    # team selection lands right after the leader's announcement
    j = kinds.index(("event", "team_selection"))
    assert kinds[j - 1] == ("speech", "我就发一个3 4带上我自己好吧")


def test_missing_label_long_gap_overlap_and_same_seat_across_attempts_are_boundaries_or_flags():
    utts = [
        seg(1, "我先说", 0.0, 1.0, 3),
        seg(2, "谁在说话", 1.0, 1.5, None, eligibility="in_game_speech"),
        seg(3, "继续", 1.5, 2.0, 3),
        seg(4, "停了很久以后", 9.0, 10.0, 3),
        seg(5, "有人抢话", 10.0, 11.0, 3, flags=["caption_only", "overlap_suspected"]),
        seg(7, "下一次组队还是我", 12.0, 13.0, 3),
    ]
    utts[1]["speaker"]["attribution"] = "no_label"
    events = [ev(6, "vote_outcome", {"mission": 1, "proposal_index": 1, "result": "rejected", "tally_text": "3:7", "explicit": True}, 11.5)]
    rec = record(utts, events)
    parts = [it for it in rec["timeline"] if it["kind"] == "speech"]
    assert [p["text"] for p in parts] == ["我先说", "谁在说话", "继续", "停了很久以后 有人抢话", "下一次组队还是我"]
    assert "unknown_speaker" in parts[1]["boundary_before"]["reasons"] and "speaker_unknown" in parts[1]["flags"]
    assert "unknown_speaker" in parts[2]["boundary_before"]["reasons"]
    assert "long_gap" in parts[3]["boundary_before"]["reasons"]
    assert "overlap_suspected" in parts[3]["flags"]
    # same seat across an attempt boundary: a part of the same turn, never merged over the event
    assert parts[4]["continues_turn"] and parts[4]["context"]["attempt"] == 2
    assert parts[3]["context"]["mission"] is None  # no formal team selection seen: context stays unknown


def test_repeated_real_words_are_kept_and_persistent_display_is_not_duplicated():
    parts = [OcrPart("s1", 0.0, 1.0, "对", 0.9, "o1"), OcrPart("s2", 1.0, 1.2, "对", 0.9, "o2"), OcrPart("s3", 1.6, 2.4, "对", 0.9, "o3")]
    caps = build_captions(parts, CaptionConfig(merge_policy="short_part_v2"), "a" * 64, "subtitle", lambda t: 3)
    assert [c["text"] for c in caps] == ["对", "对"]  # s1+s2 is one display; s3 after a gap is a repetition
    utts = [seg(1, "对", 0.0, 1.2, 3), seg(2, "对", 1.6, 2.4, 3)]
    rec = record(utts, [])
    assert speech(rec) == [(3, "对 对", False)]


def test_v2_merge_policy_keeps_a_long_one_character_edit_separate():
    parts = [OcrPart("s1", 0.0, 2.0, "建议就在一这去开出去了", 0.9, "o1"), OcrPart("s2", 2.0, 3.6, "建议就在一这就开出去了", 0.9, "o2")]
    v1 = build_captions(parts, CaptionConfig(merge_policy="fuzzy_v1"), "a" * 64, "subtitle", lambda t: 9)
    v2 = build_captions(parts, CaptionConfig(merge_policy="short_part_v2"), "a" * 64, "subtitle", lambda t: 9)
    assert len(v1) == 1
    assert [c["text"] for c in v2] == ["建议就在一这去开出去了", "建议就在一这就开出去了"]
    assert all("similar_neighbor" in c["flags"] for c in v2)


def test_every_accepted_segment_once_and_excluded_speech_is_never_bridged():
    utts, events = game()
    utts[2]["review_status"] = "needs_review"  # '先过吧' unreviewed
    rec = record(utts, events)
    assert not segment_accounting(rec, utts, "accepted")
    texts = [t for _, t, _ in speech(rec)]
    assert "先过吧" not in " ".join(texts)
    draft = record(utts, events, dataset="draft")
    assert any("先过吧" in t for _, t, _ in speech(draft))
    assert not segment_accounting(draft, utts, "draft")


def test_rejected_forced_votes_missing_unknown_and_fail_counts_render_distinctly():
    utts = [seg(1, "发车", 0.0, 1.0, 1)]
    events = [
        ev(2, "team_selection", {"mission": 1, "proposal_index": 2, "leader_seat": 1, "team_seats": [1, 4, 7], "forced": False}, 1.0),
        ev(3, "vote_observation", {"mission": 1, "proposal_index": 2, "votes": {"1": "approve", "2": "unknown", "3": "reject"}}, 2.0),
        ev(4, "vote_outcome", {"mission": 1, "proposal_index": 2, "result": "rejected", "tally_text": None, "explicit": True}, 2.0),
        ev(5, "team_selection", {"mission": 1, "proposal_index": 3, "leader_seat": 2, "team_seats": [2, 4, 6], "forced": True}, 3.0),
        ev(6, "mission_outcome", {"mission": 1, "result": "success", "fail_count": None}, 4.0),
        ev(7, "mission_outcome", {"mission": 2, "result": "success", "fail_count": 0}, 5.0),
    ]
    rec = record(utts, events)
    md = render_markdown(rec)
    assert "上票 1；下票 3；看不清 2；未观测 4、5、6、7、8、9、10" in md
    assert "车被否（票数未显示）" in md
    assert "必做轮（不投票）" in md
    assert "失败牌数未知" in md and "失败牌 0 张" in md
    assert [it["type"] for it in rec["timeline"] if it["kind"] == "event"].count("vote_observation") == 1  # none invented for the forced team


def test_late_board_rows_and_missing_footage_never_reach_earlier_x():
    utts, events = game()
    utts.append(seg(14, "第二轮我先点个车", 20.0, 21.0, 3))
    events += [
        ev(12, "team_selection", {"mission": 1, "proposal_index": 3, "leader_seat": 2, "team_seats": [2, 4, 6], "forced": True}, 15.0, key="board:m1:p3:team_selection"),
        ev(13, "mission_outcome", {"mission": 1, "result": "success", "fail_count": 0}, 16.0, key="board:m1:mission_outcome"),
    ]
    coverage = {"schema": "vbench.coverage/1", "reviewer": "t", "status": "provisional_self_review", "gaps": [
        {"gap_id": "cut", "kind": "edit_cut", "start": 9.5, "end": 20.0, "description": "剪辑缺口", "omitted": ["第3次组队", "翻牌"],
         "late_reported_event_keys": ["board:m1:p3:team_selection", "board:m1:mission_outcome"], "evidence": []}]}
    x = build_x_v2(utterances=utts, events=events, coverage=coverage, boundary_decisions=[], turns_cfg=CFG["turns"], cutoff_sequence=11, rules=RULES, sample_id="x2-0000000000000000", dataset="accepted")
    assert all(i.get("type") != "mission_outcome" for i in x["timeline"])
    assert all(i["kind"] != "coverage_gap" for i in x["timeline"])
    x2 = build_x_v2(utterances=utts, events=events, coverage=coverage, boundary_decisions=[], turns_cfg=CFG["turns"], cutoff_sequence=13, rules=RULES, sample_id="x2-0000000000000000", dataset="accepted")
    kinds = [i["kind"] for i in x2["timeline"]]
    assert kinds[-3:] == ["coverage_gap", "event", "event"]
    assert x2["timeline"][-1]["reported_late"] is True
    assert "第3次组队" not in json.dumps(x2, ensure_ascii=False)  # archival gap description stays out of X
    rec = record(utts, events, coverage)
    gap_i = [i for i, it in enumerate(rec["timeline"]) if it["kind"] == "coverage_gap"][0]
    assert rec["timeline"][gap_i + 1]["reporting"] == {"status": "retrospective", "gap_id": "cut"}
    assert "coverage_gap" in rec["timeline"][-1]["boundary_before"]["reasons"]


def test_x_is_prefix_safe_when_the_same_speaker_keeps_talking():
    utts, events = game()
    base = build_x_v2(utterances=utts[:4], events=[], coverage=None, boundary_decisions=[], turns_cfg=CFG["turns"], cutoff_sequence=4, rules=RULES, sample_id="x2-0000000000000000", dataset="accepted")
    longer = build_x_v2(utterances=utts, events=events, coverage=None, boundary_decisions=[], turns_cfg=CFG["turns"], cutoff_sequence=4, rules=RULES, sample_id="x2-0000000000000000", dataset="accepted")
    assert x_bytes(base) == x_bytes(longer)
    last = longer["timeline"][-1]
    assert last["text"] == "我就发一个3" and last["open_at_cutoff"] is True  # '4带上我自己好吧' comes later
    full = record(utts, events)
    part = [it for it in full["timeline"] if it["kind"] == "speech" and it["text"].startswith("我就发一个3")][0]
    assert part["text"] == "我就发一个3 4带上我自己好吧"
    assert "t-" + sha256_json_turn(part["turn_id"]) == last["turn"]


def sha256_json_turn(turn_id):
    from vbench.util import sha256_bytes

    return sha256_bytes(turn_id.encode())[:12]


def test_semantic_events_never_enter_timeline_transcript_or_x():
    utts, events = game()
    stance = board_event("evt-00000000000000ff", "stance")
    stance.update(source="speech", type="stance", sequence=12, review_status="accepted", stable_key="speech:x:stance",
                  payload={"holder": {"kind": "speaker", "seat": 1}, "target_seat": 2, "polarity": "negative", "hedged": False, "negated": False, "cue": "踩2号", "utterance_id": "utt-0000000000000002"})
    stance["availability"] = {"status": "anchored", "public_at": 9.1, "basis": "x", "evidence_refs": []}
    rec = record(utts, events + [stance])
    assert rec["coverage"]["counts"]["selection"]["semantic_events_excluded"] == 1
    md = render_markdown(rec)
    for blob in (json.dumps(rec, ensure_ascii=False), md):
        assert "stance" not in blob and "polarity" not in blob
    with pytest.raises(CutoffError):  # a semantic record cannot even be a cutoff
        build_x_v2(utterances=utts, events=events + [stance], coverage=None, boundary_decisions=[], turns_cfg=CFG["turns"], cutoff_sequence=12, rules=RULES, sample_id="x2-0000000000000000", dataset="accepted")
    x = build_x_v2(utterances=utts, events=events + [stance], coverage=None, boundary_decisions=[], turns_cfg=CFG["turns"], cutoff_sequence=11, rules=RULES, sample_id="x2-0000000000000000", dataset="accepted")
    assert "stance" not in json.dumps(x) and not record_errors(x, "sample_x_v2")


def test_readable_transcript_and_json_carry_the_same_ordered_speech_and_facts():
    utts, events = game()
    utts[1]["caption"]["text"] = "我*不是_派西"  # markdown-significant characters survive the round trip
    rec = record(utts, events)
    md = render_markdown(rec)
    assert not check_render_consistency(rec, md)
    assert speech_paragraphs(md) == [it["text"] for it in rec["timeline"] if it["kind"] == "speech"]
    assert md.index("【发车】") < md.index("【投票结果】")


def test_turn_boundary_corrections_are_causal_validated_and_stale_aware():
    utts, events = game()
    brk = make_boundary_correction([], before=utts[1], after=utts[2], decision="break", reviewer="r", note="两句之间换了话题")
    rec = record(utts, events, decisions=[brk])
    assert [t for s, t, _ in speech(rec) if s == 1][:2] == ["我不是派西", "先过吧"]
    join_bad = make_boundary_correction([brk], before=utts[6], after=utts[7], decision="join", reviewer="r", note="")
    rec2, rep = build_game_record(cfg=CFG, source_id="src-aaaaaaaaaaaa", dataset="accepted", utterances=utts, events=events, machine_utterances=utts,
                                  coverage=None, review_scope=None, boundary_decisions=[brk, join_bad], audit={})
    assert any("join refused" in s["reason"] for s in rec2["coverage"]["counts"]["boundary_corrections_stale"])
    changed = copy.deepcopy(utts)
    changed[2]["caption"]["text"] = "先过"
    rec3, _ = build_game_record(cfg=CFG, source_id="src-aaaaaaaaaaaa", dataset="accepted", utterances=changed, events=events, machine_utterances=changed,
                                coverage=None, review_scope=None, boundary_decisions=[brk], audit={})
    assert any("stale" in s["reason"] for s in rec3["coverage"]["counts"]["boundary_corrections_stale"])


def test_private_roster_changes_leave_x2_bytes_identical_and_change_y2(tmp_path, isolated_data_root):
    import inspect

    from vbench.export import export_samples_v2
    from vbench.paths import annotation_paths, run_paths
    from vbench.source import save_manifest
    from vbench.util import write_json

    for fn in (build_game_record, build_x_v2, assemble, select_atoms):
        assert not set(inspect.signature(fn).parameters) & {"roles", "roster", "private", "labels"}
    utts, events = game()
    cfg = pilot_cfg(write_layout(tmp_path), cutoffs=[{"label": "after vote", "after": {"event": {"type": "vote_outcome", "mission": 1, "proposal_index": 1}}}])
    run = run_paths(cfg["run_id"])
    write_jsonl(run.views / "all" / "utterances.jsonl", utts)
    write_jsonl(run.views / "all" / "events.jsonl", events)
    save_manifest({"schema": "vbench.evaluator_manifest/1", "games": [{"game_id": SOURCE["game_id"], "group_id": "grp-synth", "split": "dev", "source": {"source_id": SOURCE["source_id"], "video_sha256": SOURCE["video_sha256"], "audio_sha256": None}}], "samples": []})
    roles = {1: "loyal", 2: "loyal", 3: "oberon", 4: "percival", 5: "loyal", 6: "merlin", 7: "loyal", 8: "morgana", 9: "mordred", 10: "assassin"}
    side = {"loyal": "good", "percival": "good", "merlin": "good"}
    outs = []
    for verified in (True, False):
        roster = {"schema": "vbench.private_roster/2", "game_id": SOURCE["game_id"], "player_count": 10, "composition": RULES["role_composition"],
                  "seats": [{"seat": s, "role": r, "side": side.get(r, "evil"), "verification": "verified" if verified else "candidate",
                             "sources": [{"kind": "roster_crop"}], "consistency": {"checked_times": [1.0], "agree": True}} for s, r in roles.items()],
                  "end_of_video_reveal": {"available": False, "note": "t"}, "notes": []}
        write_json(annotation_paths(SOURCE["source_id"]).root / "private" / "roster_v2.json", roster)
        res = export_samples_v2(cfg, SOURCE, "accepted")
        sid = res[0]["sample_id"]
        outs.append(((run.root / "samples_v2" / "accepted" / "X" / f"{sid}.json").read_bytes(), (run.root / "samples_v2" / "accepted" / "Y" / f"{sid}.json").read_bytes()))
    assert outs[0][0] == outs[1][0] and outs[0][1] != outs[1][1]
    assert b"BV1xx411c7mD" not in outs[0][0] and "秘密标题".encode() not in outs[0][0]


def test_migration_carries_only_identical_reviewed_fields_and_drops_semantic_labels(tmp_path, isolated_data_root):
    from vbench.paths import annotation_paths, run_paths

    old_cfg = dict(CFG, run_id="old", source=pilot_cfg(Path("x"))["source"])
    new_cfg = dict(CFG, run_id="new", source=pilot_cfg(Path("x"))["source"], corrections={"inherit_shared": False})
    u_same = utt("utt-00000000000000a1", "我不是派西", 1.0, 2.0, seat=1)
    u_text = utt("utt-00000000000000a2", "先过吧", 2.0, 3.0, seat=1)
    e_board = board_event("evt-00000000000000b1", "vote_outcome")
    e_sem = board_event("evt-00000000000000b2", "stance")
    e_sem.update(type="stance", source="speech", payload={"holder": {"kind": "speaker", "seat": 1}, "target_seat": 2, "polarity": "negative", "hedged": False, "negated": False, "cue": "x", "utterance_id": "utt-00000000000000a1"})
    old = run_paths("old").public
    write_jsonl(old / "utterances.jsonl", [u_same, u_text])
    write_jsonl(old / "events.jsonl", [e_board, e_sem])
    new_same = copy.deepcopy(u_same)
    new_same["asr"]["text"] = "不同的识别结果"  # content hash changes, reviewed fields do not
    new_text = copy.deepcopy(u_text)
    new_text["caption"]["text"] = "先过"
    new = run_paths("new").public
    write_jsonl(new / "utterances.jsonl", [new_same, new_text])
    new_board = copy.deepcopy(e_board)
    new_board["provenance"] = dict(new_board["provenance"], config_sha256="c" * 64)
    write_jsonl(new / "events.jsonl", [new_board])
    rows = []
    for kind, target, op in (("utterance", u_same, "accept"), ("utterance", u_text, "accept"), ("public_event", e_board, "accept"), ("public_event", e_sem, "reject")):
        rows.append(make_correction(rows, kind=kind, target=target, op=op, reviewer="r", note="orig"))
    ann = annotation_paths("src-aaaaaaaaaaaa")
    write_jsonl(ann.corrections, rows)
    rep = migrate_corrections(old_cfg, new_cfg, "src-aaaaaaaaaaaa", "migrator")
    assert rep["counts"]["migrated"] == 2 and rep["counts"]["not_migrated"] == 2
    reasons = " ".join(r["reason"] for r in rep["not_migrated"])
    assert "reviewed fields differ" in reasons and "semantic" in reasons
    from vbench.util import read_jsonl

    migrated = read_jsonl(ann.run_corrections("new"))
    views, arep = apply_corrections({"utterance": [new_same, new_text], "public_event": [new_board]}, migrated)
    assert not arep["stale"] and [u["review_status"] for u in views["utterance"]] == ["accepted", "machine_candidate"]
    assert all(any(r["kind"] == "correction" for r in c["evidence_refs"]) for c in migrated)
    # re-running migration does not duplicate
    rep2 = migrate_corrections(old_cfg, new_cfg, "src-aaaaaaaaaaaa", "migrator")
    assert rep2["counts"]["migrated"] == 0 and len(read_jsonl(ann.run_corrections("new"))) == 2


def test_empty_line_ocr_falls_back_to_detection_when_enabled(tmp_path):
    from vbench.paths import run_paths
    from vbench.pipeline import run_extract
    from vbench.util import read_jsonl

    class LineBlind(DecodingOcr):
        def run(self, crop, mode):
            out = super().run(crop, "line")
            if mode == "line" and out and out[0]["text"] == "呃":
                self.calls += 0
                return [{"text": "", "box": out[0]["box"], "score": 0.0}]
            return out

    specs = timeline((30, FrameSpec(caption=5, label=3)), (6, FrameSpec()))
    for enabled, expect in ((False, []), (True, ["呃"])):
        cfg = pilot_cfg(write_layout(tmp_path), run_id=f"fb{int(enabled)}", ocr={"engine": "fake", "empty_line_fallback": enabled})
        stats = run_extract(cfg, SOURCE, frames=frames(specs), fps=30.0, engine=LineBlind({5: "呃"}, {3: "3 乙"}), cache_root=None)
        caps = read_jsonl(run_paths(cfg["run_id"]).public / "caption_segments.jsonl")
        assert [c["text"] for c in caps] == expect
        assert stats["counters"].get("ocr_empty_line_fallbacks", 0) == (1 if enabled else 0)


def test_barless_plain_subtitles_are_detected_only_when_the_bar_is_absent():
    import numpy as np

    from vbench.layout import layout_from_doc, presence_map, public_crops

    doc = {
        "schema": "vbench.layout/1", "layout_id": "t", "frame_size": [320, 180],
        "regions": [
            {"id": "subtitle", "kind": "caption", "visibility": "public", "rect": [80, 150, 160, 20],
             "presence": {"hsv_lo": [18, 90, 170], "hsv_hi": [38, 255, 255], "min_fraction": 0.8, "edge_band_px": 3}},
            {"id": "subtitle_plain", "kind": "caption", "visibility": "public", "rect": [60, 150, 200, 20], "ocr_mode": "page",
             "presence": {"method": "outlined_text", "hsv_lo": [0, 0, 225], "hsv_hi": [180, 40, 255], "min_fraction": 0.01, "requires_absent": "subtitle"},
             "diff": {"signal": "outlined_text_mask"}},
        ],
    }
    layout = layout_from_doc(doc)
    white_table = np.full((180, 320, 3), 245, np.uint8)
    plain = white_table.copy()
    plain[150:170] = 120
    plain[154:166, 100:220] = 0          # dark outline
    plain[156:164, 102:218:4] = 255       # white strokes inside the outline
    bar = plain.copy()
    bar[150:170, 80:240] = (0, 230, 250)
    assert presence_map(public_crops(white_table, layout), layout)["subtitle_plain"] is False
    assert presence_map(public_crops(plain, layout), layout)["subtitle_plain"] is True
    got = presence_map(public_crops(bar, layout), layout)
    assert got["subtitle"] is True and got["subtitle_plain"] is False
