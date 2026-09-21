"""Second source layout: pixel redaction and the online client's history panel.

The online source (BV12beJ69E8W) prints answer-bearing text inside a region the
rect cannot avoid enclosing, and its board is a client panel with filled vote
chips rather than coloured digits. Both behaviours are new, so both are pinned
here on synthetic pixels — no media, no network.
"""

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from vbench.captions import parse_label
from vbench.client_log import classify_chip, parse_client_log
from vbench.layout import apply_redactions, keep_first_ink_run, layout_from_doc, presence_map, public_crops

REDACT = {"mode": "keep_first_ink_run", "ink_v_max": 90, "gap_px": 10, "max_run_px": 120, "pad_px": 6}


def label_box(tokens: list[tuple[int, int]], w: int = 352, h: int = 56) -> np.ndarray:
    """White box with dark ink in the given (x0, x1) column ranges."""
    img = np.full((h, w, 3), 245, np.uint8)
    for x0, x1 in tokens:
        img[12:h - 12, x0:x1] = 20
    return img


def kept_window(out: np.ndarray) -> tuple[int, int] | None:
    """Columns the redaction left untouched (everything else is blanked to 0)."""
    cols = np.flatnonzero(out.reshape(out.shape[0], -1).any(axis=0).reshape(out.shape[1], -1).any(axis=1))
    return (int(cols[0]), int(cols[-1])) if cols.size else None


def holds_token(out: np.ndarray, tok: tuple[int, int]) -> bool:
    win = kept_window(out)
    return win is not None and win[0] <= tok[0] and win[1] >= tok[1] - 1


# ── redaction ──────────────────────────────────────────────────────────────


def test_redaction_keeps_the_seat_token_and_drops_nickname_and_role():
    # '9号' | '陈述句' | '派西维尔' — the layout this source actually shows.
    crop = label_box([(20, 60), (80, 180), (200, 330)])
    out = keep_first_ink_run(crop, REDACT)
    assert holds_token(out, (20, 60))
    assert out[:, 200:330].max() == 0 and out[:, 80:180].max() == 0


def test_redaction_follows_the_seat_token_when_the_text_is_centred():
    """A fixed sub-rect cannot do this: the seat slides with the total width."""
    short = keep_first_ink_run(label_box([(150, 190), (210, 280)]), REDACT)       # '7号 鲨鱼'
    long = keep_first_ink_run(label_box([(20, 60), (80, 180), (200, 330)]), REDACT)
    assert holds_token(short, (150, 190)) and short[:, 210:280].max() == 0
    assert holds_token(long, (20, 60)) and long[:, 80:].max() == 0


def test_redaction_keeps_a_single_token_label_whole():
    for tok in ((160, 230), (140, 250)):        # '系统' / '狼人盘刀' markers
        assert holds_token(keep_first_ink_run(label_box([tok]), REDACT), tok)


def test_an_empty_label_redacts_to_nothing_rather_than_guessing():
    assert keep_first_ink_run(np.full((56, 352, 3), 245, np.uint8), REDACT).max() == 0


def test_presence_is_measured_before_redaction_so_the_gate_still_sees_the_overlay():
    doc = {
        "schema": "vbench.layout/1", "layout_id": "t", "frame_size": [600, 200],
        "regions": [
            {"id": "subtitle", "kind": "caption", "visibility": "public", "rect": [300, 100, 200, 60],
             "presence": {"hsv_lo": [18, 90, 170], "hsv_hi": [38, 255, 255], "min_fraction": 0.8, "edge_band_px": 6}},
            {"id": "speaker_label", "kind": "speaker_label", "visibility": "public", "rect": [40, 100, 200, 60],
             "redact": dict(REDACT), "presence": {"hsv_lo": [0, 0, 200], "hsv_hi": [180, 40, 255],
                                                  "min_fraction": 0.8, "edge_band_px": 6, "requires": "subtitle"}},
        ],
    }
    layout = layout_from_doc(doc)
    frame = np.full((200, 600, 3), 120, np.uint8)
    frame[100:160, 300:500] = (0, 230, 250)          # yellow bar
    frame[100:160, 40:240] = 245                     # white label box
    frame[112:148, 60:100] = 20                      # '<n>号'
    frame[112:148, 130:220] = 20                     # nickname
    raw = public_crops(frame, layout, redact=False)
    assert presence_map(raw, layout)["speaker_label"] is True
    red = apply_redactions(raw, layout)
    # The gate passed on the untouched box, and the nickname is gone afterwards.
    assert red["speaker_label"][:, 90:].max() == 0
    assert presence_map(apply_redactions(raw, layout), layout)["subtitle"] is True


def test_redaction_is_part_of_the_region_cache_key():
    base = {"id": "speaker_label", "kind": "speaker_label", "visibility": "public", "rect": [0, 0, 100, 40]}
    doc = {"schema": "vbench.layout/1", "layout_id": "t", "frame_size": [200, 100], "regions": [base]}
    plain = layout_from_doc(json.loads(json.dumps(doc)))
    doc2 = json.loads(json.dumps(doc))
    doc2["regions"][0]["redact"] = dict(REDACT)
    redacted = layout_from_doc(doc2)
    assert plain.region_config_sha("speaker_label") != redacted.region_config_sha("speaker_label")


def test_a_seat_token_with_ocr_noise_around_it_still_parses():
    assert parse_label("電3号時", 10) == (3, None)
    assert parse_label("9号號號", 10)[0] == 9
    assert parse_label("系统", 10)[0] is None
    assert parse_label("電13号", 10)[0] is None          # out of range, not silently clamped
    assert parse_label("1Lucy", 10) == (1, "Lucy")       # the offline source still parses


# ── client log ─────────────────────────────────────────────────────────────


def box(text, x, y, w=60, h=16):
    return {"text": text, "box": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], "score": 0.99}


def chip_row(crop, y, colors, x0=36.5, dx=38.5):
    for i, c in enumerate(colors):
        cx = int(x0 + i * dx)
        fill = {"approve": (80, 160, 70), "reject": (40, 40, 180), "none": (252, 252, 252)}[c]
        cv2.rectangle(crop, (cx - 14, y - 14), (cx + 14, y + 14), fill, -1)


def panel(rows: list[tuple[str, list[str]]], size=(700, 470)) -> tuple[np.ndarray, list[dict]]:
    crop = np.full((size[0], size[1], 3), 250, np.uint8)
    boxes, y = [], 25
    for text, colors in rows:
        boxes.append(box(text, 18, y - 8, w=240))
        if colors:
            chip_row(crop, y + 33, colors)
            # OCR reads the digits on the pale chips; that row is what the
            # parser fits the cell geometry to.
            for i, c in enumerate(colors):
                if c == "none":
                    boxes.append(box(str(i + 1), int(36.5 + i * 38.5) - 5, y + 25, w=10, h=14))
        y += 76 if colors else 36
    return crop, boxes


ALL_REJECT_BUT5 = ["reject"] * 4 + ["approve"] + ["reject"] * 5


def test_client_log_reads_a_proposal_with_filled_vote_chips():
    crop, boxes = panel([("第1轮·需3人", None), ("6号队长提名→3·6·9✗否决组队1：9", ALL_REJECT_BUT5)])
    missions, warnings = parse_client_log(boxes, crop, 10)
    # Every chip is filled, so OCR reads no digit under the row and the parser
    # falls back to the measured default geometry — and says so.
    assert len(missions) == 1 and all("default cell geometry" in w for w in warnings)
    m = missions[0]
    assert (m["mission"], m["team_size"]) == (1, 3)
    p = m["proposals"][0]
    assert (p["leader_seat"], p["team_seats"], p["tally"], p["result_text"]) == (6, [3, 6, 9], [1, 9], "否决组队")
    assert [s for s, c in p["cells"].items() if c["color"] == "approve"] == ["5"]
    assert p["forced"] is False


def test_the_auto_passed_proposal_is_forced_and_carries_no_tally():
    crop, boxes = panel([("第1轮·需3人", None), ("8号队长提名→6·8·9自动通过", ["none"] * 10)])
    missions, _ = parse_client_log(boxes, crop, 10)
    p = missions[0]["proposals"][0]
    assert p["forced"] is True and p["tally"] is None and p["result_text"] is None
    assert {c["color"] for c in p["cells"].values()} == {"none"}


def test_a_vote_still_in_progress_produces_no_outcome_and_no_votes():
    crop, boxes = panel([("第1轮·需3人", None), ("7号队长提名→6·7·9投票中0/10", ["none"] * 10)])
    p = parse_client_log(boxes, crop, 10)[0][0]["proposals"][0]
    assert p["result_text"] is None and p["tally"] is None and p["forced"] is False


def test_mission_counts_do_not_swallow_the_member_chips_that_follow():
    """'任务投票: 成功 3 · 失败 0' runs into '6号✓8号✓9号✓' on one OCR line."""
    crop, boxes = panel([("第1轮·需3人", None), ("任务投票：成功3·失败06号√8号√9号√", None)])
    m = parse_client_log(boxes, crop, 10)[0][0]
    assert m["result"]["result"] == "success"
    assert m["result"]["card_texts"] == ["成功"] * 3


def test_a_failed_mission_reports_its_fail_cards():
    crop, boxes = panel([("第2轮·需4人", None), ("任务投票：成功3·失败1", None)])
    m = parse_client_log(boxes, crop, 10)[0][0]
    assert m["result"]["result"] == "fail"
    assert m["result"]["card_texts"].count("失败") == 1


@pytest.mark.parametrize("row", [
    "湖中仙女:5号查验了3号→莫德雷德的爪牙",
    "忠臣阵营获胜·刺客4号→10号刺杀失败",
    "匕首已出鞘·刺客锁定梅林中...",
    "MVP:6号",
])
def test_answer_bearing_panel_rows_are_dropped_not_parsed(row):
    crop, boxes = panel([("第3轮·需4人", None), (row, None)])
    missions, warnings = parse_client_log(boxes, crop, 10)
    assert missions[0]["proposals"] == [] and missions[0]["result"] is None
    assert any("answer-bearing" in w for w in warnings)
    blob = json.dumps(missions, ensure_ascii=False)
    for leak in ("莫德雷德", "刺客", "梅林", "获胜", "MVP"):
        assert leak not in blob


def test_chip_colours_separate_approve_reject_and_not_voted():
    crop = np.full((60, 200, 3), 250, np.uint8)
    cv2.rectangle(crop, (10, 16), (40, 44), (80, 160, 70), -1)     # green
    cv2.rectangle(crop, (60, 16), (90, 44), (40, 40, 180), -1)     # dark red
    assert classify_chip(crop, 25, 30)["color"] == "approve"
    assert classify_chip(crop, 75, 30)["color"] == "reject"
    assert classify_chip(crop, 150, 30)["color"] == "none"         # untouched white
