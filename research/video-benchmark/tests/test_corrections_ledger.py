"""Append-only corrections, stale targets, no silent overwrite, sequence ledger."""

import copy

import pytest

from vbench.corrections import append_corrections, apply_corrections, content_sha, make_correction
from vbench.ledger import allocate, attach, empty_ledger
from vbench.util import read_jsonl
from vbench.validate import ValidationFailed

PROV = {"stage": "utterances", "stage_version": "1", "tool": "t"}


def utt(uid, text, start, end, seat=3):
    return {
        "schema": "vbench.utterance/1", "utterance_id": uid,
        "caption": {"caption_segment_id": "cap-" + uid[4:], "text": text, "alternatives": [], "display_start": start, "display_end": end,
                    "timing": {"method": "t", "start_precision_s": 0.033, "end_precision_s": 0.033}},
        "speaker": {"seat": seat, "label_text": f"{seat} x", "attribution": "label_stable", "evidence_refs": []},
        "asr": {"mode": "unavailable", "text": None, "audio_start": None, "audio_end": None, "segment_refs": []},
        "alignment": {"status": "asr_unavailable", "cer": None, "reasons": []},
        "verbatim": None, "flags": ["caption_only"], "eligibility": "in_game_speech",
        "availability": {"status": "anchored", "public_at": end, "basis": "caption end"},
        "review_status": "machine_candidate", "provenance": PROV,
    }


def board_event(eid, etype="vote_outcome"):
    return {
        "schema": "vbench.public_event/1", "event_id": eid, "stable_key": f"board:m1:p1:{etype}", "type": etype, "source": "board",
        "payload": {"mission": 1, "proposal_index": 1, "result": "rejected", "tally_text": "0:10", "explicit": True},
        "observation": {"video_start": 5.0, "video_end": 9.0, "evidence_refs": []},
        "availability": {"status": "unanchored", "public_at": None, "basis": "board"},
        "interpretations": [], "flags": [], "review_status": "needs_review", "provenance": PROV,
    }


U1 = "utt-0000000000000001"
U2 = "utt-0000000000000002"
E1 = "evt-0000000000000001"


def machine():
    return {"utterance": [utt(U1, "我觉得5号可能干净一点呢", 1.0, 2.0), utt(U2, "过了", 2.5, 3.0)], "public_event": [board_event(E1)]}


def test_corrections_never_mutate_machine_records_and_keep_old_text():
    m = machine()
    before = copy.deepcopy(m)
    c = make_correction([], kind="utterance", target=m["utterance"][0], op="set", path="caption.text", value="我觉得5号可能干净一点啊", reviewer="r", note="呢->啊")
    views, rep = apply_corrections(m, [c])
    assert m == before
    v = [u for u in views["utterance"] if u["utterance_id"] == U1][0]
    assert v["caption"]["text"] == "我觉得5号可能干净一点啊"
    assert "我觉得5号可能干净一点呢" in v["caption"]["alternatives"]
    assert v["applied_corrections"] == [c["correction_id"]]
    assert rep["applied"] == [c["correction_id"]]


def test_corrections_persist_in_an_append_only_file(tmp_path):
    m = machine()
    path = tmp_path / "corrections.jsonl"
    c1 = make_correction([], kind="utterance", target=m["utterance"][0], op="accept", reviewer="r", note="")
    append_corrections(path, [c1])
    c2 = make_correction(read_jsonl(path), kind="public_event", target=m["public_event"][0], op="anchor", value={"public_at": 9.0, "basis": "reveal", "evidence_refs": [{"kind": "video_moment", "id": "reveal", "video_time": 9.0}]}, reviewer="r", note="")
    append_corrections(path, [c2])
    rows = read_jsonl(path)
    assert [r["revision"] for r in rows] == [1, 2]
    with pytest.raises(ValidationFailed):
        append_corrections(path, [dict(c1, correction_id="cor-ffffffffffffffff")])  # revision 1 again
    views, _ = apply_corrections(machine(), rows)
    assert [u["review_status"] for u in views["utterance"]] == ["accepted", "machine_candidate"]
    assert views["public_event"][0]["availability"]["public_at"] == 9.0


def test_stale_corrections_are_detected_after_reextraction():
    m = machine()
    c_text = make_correction([], kind="utterance", target=m["utterance"][0], op="accept", reviewer="r", note="")
    c_gone = make_correction([c_text], kind="utterance", target=m["utterance"][1], op="accept", reviewer="r", note="")
    re_extracted = machine()
    re_extracted["utterance"][0]["caption"]["text"] = "我觉得3号可能干净一点呢"  # a crop change altered OCR
    re_extracted["utterance"] = re_extracted["utterance"][:1]  # and U2 no longer exists
    views, rep = apply_corrections(re_extracted, [c_text, c_gone])
    reasons = {s["correction_id"]: s["reason"] for s in rep["stale"]}
    assert reasons == {c_text["correction_id"]: "stale:content_changed", c_gone["correction_id"]: "stale:missing_target"}
    assert views["utterance"][0]["review_status"] == "machine_candidate"


def test_accepted_correction_is_never_silently_overwritten():
    m = machine()
    first = make_correction([], kind="utterance", target=m["utterance"][0], op="set", path="caption.text", value="A", reviewer="r1", note="")
    second = make_correction([first], kind="utterance", target=m["utterance"][0], op="set", path="caption.text", value="B", reviewer="r2", note="")
    views, rep = apply_corrections(m, [first, second])
    assert views["utterance"][0]["caption"]["text"] == "A"
    assert rep["conflicts"] and rep["conflicts"][0]["correction_id"] == second["correction_id"]
    third = make_correction([first, second], kind="utterance", target=m["utterance"][0], op="set", path="caption.text", value="C", reviewer="r2", note="", supersedes=first["correction_id"])
    views, rep = apply_corrections(m, [first, second, third])
    assert views["utterance"][0]["caption"]["text"] == "C"


def test_unsettable_paths_are_refused():
    m = machine()
    bad = make_correction([], kind="utterance", target=m["utterance"][0], op="set", path="availability.public_at", value=0.1, reviewer="r", note="")
    with pytest.raises(ValidationFailed):
        append_corrections(__import__("pathlib").Path(__import__("tempfile").mkdtemp()) / "c.jsonl", [bad])


def _records(views):
    return [("utterance", u) for u in views["utterance"]] + [("public_event", e) for e in views["public_event"]]


def test_sequences_are_append_only_with_holes_and_late_records_marked_out_of_sequence():
    m = machine()
    ledger = allocate(empty_ledger(), _records(apply_corrections(m, [])[0]))
    seq = {e["record_id"]: e["sequence"] for e in ledger["entries"]}
    assert seq == {U1: 1, U2: 2}  # unanchored board event gets no number yet
    # Reviewer rejects U2 and anchors the board event at t=2.5 (after U1 ends at 2.0, before U2 ends at 3.0).
    c_rej = make_correction([], kind="utterance", target=m["utterance"][1], op="reject", reviewer="r", note="")
    c_anchor = make_correction([c_rej], kind="public_event", target=m["public_event"][0], op="anchor", value={"public_at": 2.5, "basis": "reveal", "evidence_refs": [{"kind": "video_moment", "id": "x", "video_time": 2.5}]}, reviewer="r", note="")
    views, _ = apply_corrections(m, [c_rej, c_anchor])
    allocate(ledger, _records(views))
    entries = {e["record_id"]: e for e in ledger["entries"]}
    assert entries[U1]["sequence"] == 1 and entries[U2]["sequence"] == 2  # never renumbered
    assert entries[E1]["sequence"] == 3
    assert entries[E1]["ordering"] == {"status": "out_of_sequence", "belongs_before_sequence": 2}
    attached = attach(ledger, "utterance", views["utterance"])
    assert [u["sequence"] for u in attached] == [1, 2]  # the rejected record keeps its hole


def test_identical_public_time_and_rank_is_an_explicit_unresolved_tie():
    a = utt("utt-00000000000000aa", "甲", 1.0, 2.0)
    b = utt("utt-00000000000000bb", "乙", 1.5, 2.0)
    ledger = allocate(empty_ledger(), [("utterance", a), ("utterance", b)])
    assert ledger["entries"][1]["ordering"]["status"] == "unresolved"
    assert ledger["entries"][1]["ordering"]["tied_with"] == ["utt-00000000000000aa"]
