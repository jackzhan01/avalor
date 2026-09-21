"""Board snapshots: incremental updates, partial votes, explicit outcomes, conflicts."""

import cv2
import numpy as np

from vbench.board import events_from_snapshots, parse_board
from vbench.validate import record_errors

PROV = {"stage": "board", "stage_version": "1", "tool": "rule-parser"}
RULES = {"player_count": 10, "mission_team_sizes": [3, 4, 4, 5, 5], "fails_required": [1, 1, 1, 2, 1]}


def _cells(approve=(), reject=(), unclear=(), outlined=()):
    out = {}
    for s in range(1, 11):
        color = "approve" if s in approve else "reject" if s in reject else "unclear" if s in unclear else "none"
        out[str(s)] = {"color": color, "outlined": s in outlined, "hue": None, "saturation": None}
    return out


def _proposal(row, idx, leader, team, tally=None, result=None, forced=False, cells=None):
    return {
        "row_order": row, "proposal_index": idx, "proposal_limit": 3, "leader_seat": leader, "team_seats": team,
        "tally": tally, "result_text": result, "forced": forced, "cells": cells or _cells(), "raw_text": "",
    }


def _snap(sid, start, end, proposals, result=None):
    return {
        "schema": "vbench.board_snapshot/1", "snapshot_id": sid, "start": start, "end": end, "ocr_refs": [],
        "crop_sha256": "0" * 64, "missions": [{"mission": 1, "team_size": 3, "proposals": proposals, "result": result}], "warnings": [],
    }


def _by_key(events):
    return {e["stable_key"]: e for e in events}


def test_incremental_updates_create_each_event_once_at_first_appearance():
    s1 = _snap("brd-0000000000000001", 231.0, 239.3, [_proposal(1, 1, 10, [3, 4, 10], result=None)])
    s2 = _snap("brd-0000000000000002", 239.3, 564.8, [_proposal(1, 1, 10, [3, 4, 10], tally=[0, 10], result="否决组队", cells=_cells(reject=range(1, 11)))])
    s3 = _snap("brd-0000000000000003", 564.8, 579.4, [
        _proposal(1, 1, 10, [3, 4, 10], tally=[0, 10], result="否决组队", cells=_cells(reject=range(1, 11))),
        _proposal(2, 2, 1, [1, 4, 7]),
    ])
    evs = _by_key(events_from_snapshots([s1, s2, s3], "a" * 64, 10, PROV))
    assert set(evs) == {"board:m1:p1:team_selection", "board:m1:p1:vote_observation", "board:m1:p1:vote_outcome", "board:m1:p2:team_selection"}
    assert evs["board:m1:p1:team_selection"]["observation"]["video_start"] == 231.0
    assert evs["board:m1:p1:vote_outcome"]["observation"]["video_start"] == 239.3
    assert evs["board:m1:p2:team_selection"]["observation"]["video_start"] == 564.8
    for e in evs.values():
        assert e["availability"] == {"status": "unanchored", "public_at": None, "basis": e["availability"]["basis"]}
        assert not record_errors(e, "public_event", rules=RULES)


def test_partial_vector_keeps_missing_seats_absent_and_never_infers_outcome():
    cells = _cells(approve=[1, 4], reject=[2, 3, 5], unclear=[9])
    evs = _by_key(events_from_snapshots([_snap("brd-0000000000000004", 1.0, 2.0, [_proposal(1, 2, 1, [1, 4, 7], cells=cells)])], "a" * 64, 10, PROV))
    votes = evs["board:m1:p2:vote_observation"]["payload"]["votes"]
    assert votes == {"1": "approve", "4": "approve", "2": "reject", "3": "reject", "5": "reject", "9": "unknown"}
    assert "6" not in votes  # not observed != unknown
    assert "partial_votes" in evs["board:m1:p2:vote_observation"]["flags"]
    assert "board:m1:p2:vote_outcome" not in evs  # no explicit result text -> no outcome


def test_complete_vector_without_result_text_still_yields_no_outcome():
    cells = _cells(approve=range(1, 7), reject=range(7, 11))
    evs = _by_key(events_from_snapshots([_snap("brd-0000000000000005", 1.0, 2.0, [_proposal(1, 1, 3, [3, 4, 5], cells=cells)])], "a" * 64, 10, PROV))
    assert "board:m1:p1:vote_observation" in evs
    assert "board:m1:p1:vote_outcome" not in evs


def test_tally_conflicting_with_complete_vector_keeps_both_and_honours_explicit_outcome():
    cells = _cells(approve=[1, 4, 9, 10], reject=[2, 3, 5, 6, 7, 8])
    evs = _by_key(events_from_snapshots([_snap("brd-0000000000000006", 1.0, 2.0, [_proposal(1, 2, 1, [1, 4, 7], tally=[3, 7], result="否决组队", cells=cells)])], "a" * 64, 10, PROV))
    assert "tally_vector_conflict" in evs["board:m1:p2:vote_observation"]["flags"]
    out = evs["board:m1:p2:vote_outcome"]
    assert out["payload"]["result"] == "rejected" and out["payload"]["explicit"] is True
    assert "tally_vector_conflict" in out["flags"]


def test_conflicting_later_snapshot_is_an_interpretation_not_an_overwrite():
    s1 = _snap("brd-0000000000000007", 1.0, 2.0, [_proposal(1, 2, 1, [1, 4, 7])])
    s2 = _snap("brd-0000000000000008", 2.0, 3.0, [_proposal(1, 2, 1, [1, 4, 8])])
    ev = _by_key(events_from_snapshots([s1, s2], "a" * 64, 10, PROV))["board:m1:p2:team_selection"]
    assert ev["payload"]["team_seats"] == [1, 4, 7]
    assert ev["interpretations"][0]["payload"]["team_seats"] == [1, 4, 8]
    assert "board_conflict" in ev["flags"]


def test_forced_proposal_has_no_vote_events_and_mission_success_has_no_identity_claims():
    s = _snap("brd-0000000000000009", 579.4, 600.0, [_proposal(3, None, 2, [2, 4, 6], result="必做轮", forced=True)],
              result={"result": "success", "card_texts": ["成功", "成功", "成功"], "raw_text": "任务成功"})
    evs = _by_key(events_from_snapshots([s], "a" * 64, 10, PROV))
    assert evs["board:m1:p3:team_selection"]["payload"]["forced"] is True
    assert not any(k.endswith("vote_observation") or k.endswith("vote_outcome") for k in evs)
    mo = evs["board:m1:mission_outcome"]["payload"]
    assert mo == {"mission": 1, "result": "success", "fail_count": 0}
    assert not any(k in mo for k in ("good_seats", "evil_seats", "roles"))


def test_anchoring_a_board_event_requires_reveal_evidence():
    s = _snap("brd-000000000000000a", 1.0, 2.0, [_proposal(1, 1, 10, [3, 4, 10], tally=[0, 10], result="否决组队", cells=_cells(reject=range(1, 11)))])
    ev = _by_key(events_from_snapshots([s], "a" * 64, 10, PROV))["board:m1:p1:vote_outcome"]
    ev["availability"] = {"status": "anchored", "public_at": 239.3, "basis": "board", "evidence_refs": []}
    assert any("without evidence" in m for m in record_errors(ev, "public_event"))
    ev["availability"]["evidence_refs"] = [{"kind": "video_moment", "id": "reveal", "video_time": 239.3}]
    assert not record_errors(ev, "public_event")


def test_parse_board_reads_text_rows_and_cell_colours():
    crop = np.full((120, 390, 3), 25, np.uint8)
    green = tuple(int(c) for c in cv2.cvtColor(np.uint8([[[60, 110, 130]]]), cv2.COLOR_HSV2BGR)[0, 0])
    red = tuple(int(c) for c in cv2.cvtColor(np.uint8([[[9, 140, 130]]]), cv2.COLOR_HSV2BGR)[0, 0])
    boxes = [
        {"text": "第1轮任务·需要3名队员", "box": [[119, 6], [260, 6], [260, 18], [119, 18]], "score": 0.9},
        {"text": "1号队长→1.4.7第2/3次组队", "box": [[16, 28], [176, 28], [176, 43], [16, 43]], "score": 0.9},
        {"text": "3:7→否决组队", "box": [[278, 28], [366, 28], [366, 43], [278, 43]], "score": 0.9},
    ]
    cy = 57
    for seat in range(1, 11):
        cx = 35.3 + (seat - 1) * 35.6
        color = green if seat in (1, 4, 9) else red
        crop[cy - 5 : cy + 6, int(cx - 5) : int(cx + 6)] = color
        boxes.append({"text": str(seat), "box": [[cx - 5, cy - 6], [cx + 5, cy - 6], [cx + 5, cy + 6], [cx - 5, cy + 6]], "score": 0.99})
    missions, warnings = parse_board(boxes, crop, 10)
    p = missions[0]["proposals"][0]
    assert (p["leader_seat"], p["team_seats"], p["proposal_index"], p["proposal_limit"], p["tally"], p["result_text"]) == (1, [1, 4, 7], 2, 3, [3, 7], "否决组队")
    assert sorted(int(s) for s, c in p["cells"].items() if c["color"] == "approve") == [1, 4, 9]
    assert sum(c["color"] == "reject" for c in p["cells"].values()) == 7


# ── scrolled boards: the earliest round's header can be gone ────────────────


def _board_boxes(rows):
    """One OCR box per row, stacked; no vote strips."""
    return [{"text": t, "box": [[10, 20 + 40 * i], [400, 20 + 40 * i], [400, 36 + 40 * i], [10, 36 + 40 * i]],
             "score": 0.99} for i, t in enumerate(rows)]


def test_rows_above_the_first_round_header_are_attributed_to_the_round_before_it():
    """BV1kr876AEE1's board scrolls: round 1's header is gone while its rows show."""
    import numpy as np

    from vbench.board import parse_board

    crop = np.full((400, 460, 3), 30, np.uint8)
    rows = [
        "2号队长→7·8·9第1/3次组队3:7→否决组队",
        "任务成功3号7号9号成功成功成功",
        "◆第2轮任务·需要4名队员·任务成功◆",
        "4号队长→4·6·7·9第1/3次组队2:8→否决组队",
    ]
    missions, warnings = parse_board(_board_boxes(rows), crop, 10)
    assert [m["mission"] for m in missions] == [1, 2]
    assert missions[0]["team_size"] is None          # never stated, not invented
    assert missions[0]["proposals"][0]["leader_seat"] == 2
    assert missions[0]["result"]["result"] == "success"
    assert missions[1]["team_size"] == 4
    assert any("scrolled board" in w for w in warnings)


def test_headerless_rows_stay_unparsed_when_nothing_can_be_inferred():
    """No later header means no basis for a round number, so the rows are dropped."""
    import numpy as np

    from vbench.board import parse_board

    crop = np.full((200, 460, 3), 30, np.uint8)
    missions, warnings = parse_board(_board_boxes(["2号队长→7·8·9第1/3次组队3:7→否决组队"]), crop, 10)
    assert missions == []
    assert any("before any mission header" in w for w in warnings)


def test_a_first_round_header_does_not_invent_a_round_zero():
    import numpy as np

    from vbench.board import parse_board

    crop = np.full((200, 460, 3), 30, np.uint8)
    rows = ["◆第1轮任务·需要3名队员◆", "2号队长→7·8·9第1/3次组队3:7→否决组队"]
    missions, warnings = parse_board(_board_boxes(rows), crop, 10)
    assert [m["mission"] for m in missions] == [1]
    assert not any("scrolled board" in w for w in warnings)


# ── per-board cell calibration (BV1kr876AEE1 encodes votes in the cell background)


GOLD_CELLS = {"method": "cell_background", "seat1_x": 43.97, "cell_dx": 36.76, "strip_dy": 23.8,
              "approve_hue": [20, 45], "reject_sat_min": 115}


def _tint(crop, cy, cal, colors):
    """Paint each seat cell's background with an HSV colour, as this board does."""
    for seat, hsv in colors.items():
        cx = cal["seat1_x"] + (seat - 1) * cal["cell_dx"]
        patch = np.full((1, 1, 3), hsv, np.uint8)
        crop[int(cy - 9) : int(cy + 10), int(cx - 14) : int(cx + 15)] = cv2.cvtColor(patch, cv2.COLOR_HSV2BGR)[0, 0]


# measured on the real board: reject bg H 9-13 S 130-148 V 55-58,
# approve bg H 27-34 S 64-80 V 47-49, no vote H 3-7 S 59-68
REJECT_BG, APPROVE_BG, NOVOTE_BG = (11, 139, 57), (30, 72, 48), (5, 65, 52)


def test_cell_background_method_reads_votes_this_board_encodes_in_the_panel_tint():
    from vbench.board import classify_cell

    crop = np.full((120, 460, 3), 20, np.uint8)
    cy = 60
    _tint(crop, cy, GOLD_CELLS, {s: APPROVE_BG for s in (2, 8, 10)})
    _tint(crop, cy, GOLD_CELLS, {s: REJECT_BG for s in (1, 3, 4, 5, 6, 7, 9)})
    got = {s: classify_cell(crop, GOLD_CELLS["seat1_x"] + (s - 1) * GOLD_CELLS["cell_dx"], cy, GOLD_CELLS)["color"]
           for s in range(1, 11)}
    assert sorted(s for s, c in got.items() if c == "approve") == [2, 8, 10]
    assert sorted(s for s, c in got.items() if c == "reject") == [1, 3, 4, 5, 6, 7, 9]


def test_a_forced_round_reads_as_no_vote_rather_than_as_unclear():
    """Neutral grey means nobody voted; calling it 'unclear' would invent a vote to doubt."""
    from vbench.board import classify_cell

    crop = np.full((120, 460, 3), 20, np.uint8)
    cy = 60
    _tint(crop, cy, GOLD_CELLS, {s: NOVOTE_BG for s in range(1, 11)})
    got = {classify_cell(crop, GOLD_CELLS["seat1_x"] + (s - 1) * GOLD_CELLS["cell_dx"], cy, GOLD_CELLS)["color"]
           for s in range(1, 11)}
    assert got == {"none"}


def test_the_digit_ink_method_is_untouched_by_the_new_one():
    """Game 1 and 2 must read exactly as before: their calibration is the default."""
    from vbench.board import classify_cell

    crop = np.full((80, 200, 3), 20, np.uint8)
    green = cv2.cvtColor(np.full((1, 1, 3), (58, 65, 200), np.uint8), cv2.COLOR_HSV2BGR)[0, 0]
    crop[25:36, 30:41] = green
    assert classify_cell(crop, 35.3, 30)["color"] == "approve"
    assert classify_cell(crop, 35.3, 30, None)["color"] == "approve"


def test_a_missing_digit_strip_falls_back_to_this_boards_pitch_not_another_boards():
    """The bug this fixes: an unreadable strip reached for the pilot's 35.6 px pitch
    and read the same row three different ways across snapshots."""
    from vbench.board import _fit_cells

    assert _fit_cells([], 10, GOLD_CELLS) == (GOLD_CELLS["seat1_x"], GOLD_CELLS["cell_dx"])
    assert _fit_cells([], 10) == (35.3, 35.6)


def test_the_mission_row_records_who_actually_ran_the_mission():
    crop = np.full((200, 460, 3), 30, np.uint8)
    rows = ["◆第1轮任务·需要3名队员◆", "2号队长→7·8·9第1/3次组队3:7→否决组队", "任务成功3号7号9号"]
    boxes = _board_boxes(rows)
    # real OCR returns each mission card as its own box on the same line
    y = 20 + 40 * 2
    for i in range(3):
        boxes.append({"text": "成功", "box": [[300 + 30 * i, y], [325 + 30 * i, y],
                                          [325 + 30 * i, y + 16], [300 + 30 * i, y + 16]], "score": 0.99})
    missions, _ = parse_board(boxes, crop, 10)
    assert missions[0]["result"]["team_seats"] == [3, 7, 9]
    assert missions[0]["result"]["card_texts"] == ["成功", "成功", "成功"]
    assert missions[0]["result"]["result"] == "success"


def test_a_team_the_overlay_covered_is_taken_from_its_own_mission_row():
    """The bilibili watermark sits on one proposal row for the whole upload, so the
    team is only ever legible where the board states it again."""
    crop = np.full((260, 460, 3), 30, np.uint8)
    rows = ["◆第1轮任务·需要3名队员◆",
            "2号队长→7·8·9第1/3次组队3:7→否决组队",
            "3号队长圆桌谜局通过",
            "任务成功3号7号9号成功成功成功"]
    missions, warnings = parse_board(_board_boxes(rows), crop, 10)
    ran = missions[0]["proposals"][1]
    assert ran["team_seats"] == [3, 7, 9] and ran["team_from_mission_row"] is True
    assert ran["result_text"] == "通过组队"          # bare 通过 still counts as the board saying it
    assert any("filled from the mission result row" in w for w in warnings)


def test_the_overlay_fill_refuses_when_the_seat_count_contradicts_the_round():
    crop = np.full((260, 460, 3), 30, np.uint8)
    rows = ["◆第2轮任务·需要4名队员◆",
            "3号队长圆桌谜局通过",
            "任务成功3号7号9号成功成功成功"]
    missions, warnings = parse_board(_board_boxes(rows), crop, 10)
    assert missions[0]["proposals"][0]["team_seats"] == []
    assert any("occluded team left empty" in w for w in warnings)


def test_the_overlay_fill_refuses_when_two_proposals_could_have_run():
    crop = np.full((300, 460, 3), 30, np.uint8)
    rows = ["◆第1轮任务·需要3名队员◆",
            "2号队长圆桌谜局通过",
            "3号队长圆桌谜局通过",
            "任务成功3号7号9号成功成功成功"]
    missions, _ = parse_board(_board_boxes(rows), crop, 10)
    assert [p["team_seats"] for p in missions[0]["proposals"]] == [[], []]


def test_an_unreadable_proposal_number_comes_from_board_row_order():
    crop = np.full((300, 460, 3), 30, np.uint8)
    rows = ["◆第2轮任务·需要4名队员◆",
            "4号队长→4·6·7·9第1/3次组队2:8→否决组队",
            "5号队长→3·5·7·9第2/3次组队4:6→否决组队",
            "6号队长→6·7·8·9必做轮组队必做轮"]
    missions, warnings = parse_board(_board_boxes(rows), crop, 10)
    assert [p["proposal_index"] for p in missions[0]["proposals"]] == [1, 2, 3]
    assert missions[0]["proposals"][2]["index_from_row_order"] is True
    assert missions[0]["proposals"][2]["forced"] is True
    assert any("taken from board row order as 3" in w for w in warnings)


def test_proposal_numbers_stay_null_when_the_stated_ones_contradict_row_order():
    """Numbers disagreeing with positions means rows are missing, so position proves nothing."""
    crop = np.full((300, 460, 3), 30, np.uint8)
    rows = ["◆第2轮任务·需要4名队员◆",
            "4号队长→4·6·7·9第2/3次组队2:8→否决组队",
            "6号队长→6·7·8·9必做轮组队必做轮"]
    missions, warnings = parse_board(_board_boxes(rows), crop, 10)
    assert [p["proposal_index"] for p in missions[0]["proposals"]] == [2, None]
    assert any("do not match row order" in w for w in warnings)


def test_recalibrating_the_cells_changes_the_region_cache_key():
    """Otherwise a cached crop would be re-served with the old readings."""
    from vbench.layout import layout_from_doc

    base = {"schema": "vbench.layout/1", "layout_id": "t", "frame_size": [1920, 1080],
            "regions": [{"id": "board", "kind": "board", "visibility": "public", "rect": [0, 0, 100, 100],
                         "why": "t"}]}
    plain = layout_from_doc(base).region_config_sha("board")
    doc = {**base, "regions": [{**base["regions"][0], "cells": GOLD_CELLS}]}
    assert layout_from_doc(doc).region_config_sha("board") != plain


# ── roster consistency: a fuzzy nickname match that fits two seats proves nothing


def test_two_nicknames_one_edit_apart_do_not_confirm_each_others_roles(tmp_path, monkeypatch):
    """BV1kr876AEE1's roster has both 'Jerry' (莫甘娜) and 'Jeremy' (忠臣).

    The consistency check matched seat 9's 'Jeremy' against seat 6's 'Jerry' at
    every snapshot and reported seat 9 as contradicting its own roster entry.
    An ambiguous match is not evidence either way, so it is skipped.
    """
    from vbench import private_labels as pl

    ev = [{"video_time": 10.0, "crop_sha256": "0" * 64, "ocr_boxes": []}]
    monkeypatch.setattr(pl, "roster_evidence", lambda *a, **k: ev)
    monkeypatch.setattr(pl, "_pair_roster", lambda boxes: [("Jerry", "莫甘娜"), ("Jeremy", "忠臣")])
    roles = {"game_id": "game-0123456789", "player_count": 10, "composition": {"loyal": 1, "morgana": 1},
             "seats": [
                 {"seat": 6, "role": "morgana", "verification": "verified",
                  "evidence": [{"kind": "roster_crop", "observed_text": "badge 6 / Jerry / 莫甘娜", "video_time": 10.0}]},
                 {"seat": 9, "role": "loyal", "verification": "verified",
                  "evidence": [{"kind": "roster_crop", "observed_text": "badge 9 / Jeremy / 忠臣", "video_time": 10.0}]},
             ]}
    doc = pl.build_roster_v2(roles, tmp_path / "v.mp4", None, [10.0], tmp_path, None, 20.0)
    by_seat = {s["seat"]: s for s in doc["seats"]}
    assert by_seat[9]["verification"] == "verified"
    assert by_seat[9]["consistency"]["disagreements"] == []
    assert by_seat[6]["verification"] == "verified"


def test_the_end_of_video_reveal_note_is_not_baked_in_from_another_source():
    """It used to state, for every source, that the video stopped on mission 3's forced round."""
    import inspect

    from vbench.private_labels import build_roster_v2

    src = inspect.getsource(build_roster_v2)
    assert "第3轮第3次组队" not in src
    assert "reveal_note" in inspect.signature(build_roster_v2).parameters
